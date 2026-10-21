/**
 * lib/ics.js —— /calendar.ics 兜底解析（RFC 5545 子集，纯函数）。
 *
 * 契约：docs/notice-hub-插件化与日程适配方案.md §5.6：
 *   行折叠还原、BEGIN:VEVENT…END:VEVENT、UID/SUMMARY/DESCRIPTION/
 *   DTSTART/DTEND/DURATION/STATUS（含 ;VALUE=DATE、;TZID=Asia/Shanghai 参数形态）；
 *   解析失败的事件跳过并计数，不中断整体同步。
 */

'use strict';

/** 行折叠还原（RFC 5545 3.1：下一行以空格或制表符开头则续接上一行）。 */
function unfoldLines(text) {
  const rawLines = String(text || '').split(/\r\n|\n|\r/);
  const lines = [];
  for (const line of rawLines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines;
}

/** 拆 "NAME;PARAM=V;TZID=X:value" → { name, params, value }（第一个未被引号包裹的 ':' 处切分）。 */
function parseContentLine(line) {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = left.split(';');
  const name = parts.shift().trim().toUpperCase();
  const params = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq > 0) params[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim().replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

/** 反转义 TEXT 值：\\n → 换行，\\, \\; \\\\。 */
function unescapeText(value) {
  return String(value || '')
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .replace(/\\([,;\\])/g, '$1');
}

/**
 * 解析日期时间值。
 * 形态：YYYYMMDD（VALUE=DATE）、YYYYMMDDTHHMMSS、YYYYMMDDTHHMMSSZ。
 * @returns {{ allDay: boolean, date?: string, dateTime?: string }|null}
 */
function parseIcsDate(value, params) {
  const text = String(value || '').trim();
  const isDateParam = String(params.VALUE || '').toUpperCase() === 'DATE';
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (m && (isDateParam || !text.includes('T'))) {
    return { allDay: true, date: `${m[1]}-${m[2]}-${m[3]}` };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z === 'Z') {
    // UTC → 本地 wall-clock（与 shared/schedule.ts 的无时区约定对齐）。
    const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    const local = new Date(utc);
    const pad = (n) => String(n).padStart(2, '0');
    return {
      allDay: false,
      dateTime: `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`,
    };
  }
  return { allDay: false, dateTime: `${y}-${mo}-${d}T${h}:${mi}:${s}` };
}

/** DURATION（子集）→ 分钟数。支持 PnD / PTnH / PTnM / PTnS / 组合。 */
function parseDuration(value) {
  const text = String(value || '').trim().toUpperCase();
  const m = /^([+-])?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(text);
  if (!m || text === 'P' || text === 'PT') return null;
  const sign = m[1] === '-' ? -1 : 1;
  const days = Number(m[2] || 0);
  const hours = Number(m[3] || 0);
  const minutes = Number(m[4] || 0);
  const seconds = Number(m[5] || 0);
  const total = sign * (days * 24 * 60 + hours * 60 + minutes + seconds / 60);
  return Number.isFinite(total) ? total : null;
}

/**
 * 解析 ICS 文本 → VEVENT 列表。
 * @param {string} text /calendar.ics 响应体
 * @returns {{ events: Array<object>, skipped: number, errors: string[] }}
 *   event: { uid, summary, description, start, end, durationMinutes, status }
 */
function parseIcs(text) {
  const events = [];
  const errors = [];
  let skipped = 0;

  const lines = unfoldLines(text);
  let current = null;
  for (const line of lines) {
    const parsed = parseContentLine(line);
    if (!parsed) continue;
    if (parsed.name === 'BEGIN' && parsed.value.trim().toUpperCase() === 'VEVENT') {
      current = { uid: '', summary: '', description: '', start: null, end: null, durationMinutes: null, status: '' };
      continue;
    }
    if (parsed.name === 'END' && parsed.value.trim().toUpperCase() === 'VEVENT') {
      if (current) {
        if (!current.uid || (!current.start || (!current.start.date && !current.start.dateTime))) {
          skipped += 1;
          errors.push('跳过缺少 UID 或 DTSTART 的 VEVENT');
        } else {
          events.push(current);
        }
      }
      current = null;
      continue;
    }
    if (!current) continue;
    switch (parsed.name) {
      case 'UID':
        current.uid = parsed.value.trim();
        break;
      case 'SUMMARY':
        current.summary = unescapeText(parsed.value);
        break;
      case 'DESCRIPTION':
        current.description = unescapeText(parsed.value);
        break;
      case 'DTSTART':
        current.start = parseIcsDate(parsed.value, parsed.params);
        break;
      case 'DTEND':
        current.end = parseIcsDate(parsed.value, parsed.params);
        break;
      case 'DURATION':
        current.durationMinutes = parseDuration(parsed.value);
        break;
      case 'STATUS':
        current.status = parsed.value.trim().toUpperCase();
        break;
      default:
        break;
    }
  }

  if (current) {
    // BEGIN:VEVENT 没有配对的 END：整条丢弃并计数。
    skipped += 1;
    errors.push('跳过未闭合的 VEVENT');
  }

  return { events, skipped, errors };
}

module.exports = { unfoldLines, parseContentLine, unescapeText, parseIcsDate, parseDuration, parseIcs };
