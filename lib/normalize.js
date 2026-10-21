/**
 * lib/normalize.js —— notice-hub 数据 → Trellora 日程项（纯函数）。
 *
 * 契约：docs/notice-hub-插件化与日程适配方案.md §5 映射表：
 *   §5.1 任务字段映射 · §5.2 时间映射 · §5.3 状态映射 · §5.4 优先级与冲突规则
 *   §5.5 公告映射 · §5.6 ICS 兜底事件映射
 *
 * 全部为纯函数：不访问网络、文件、日志；可在单测中直接调用。
 */

'use strict';

/** 外部数据源名（PluginScheduleApi 的 source）。 */
const SOURCE = 'notice-hub';

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 4000;

// ── 小工具 ───────────────────────────────────────────────────────────────────

function str(value) {
  return value === null || value === undefined ? '' : String(value);
}

function truncate(text, max) {
  const s = str(text);
  return s.length > max ? s.slice(0, max) : s;
}

function truthy(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

/** 解析 notice-hub 的时间文本："YYYY-MM-DD HH:MM[:SS]" / "YYYY-MM-DDTHH:MM[:SS]" / "YYYY-MM-DD"。 */
function parseDeadline(raw) {
  const text = str(raw).trim();
  if (!text) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m) return { allDay: true, date: `${m[1]}-${m[2]}-${m[3]}` };
  m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (m) {
    const seconds = m[6] ? m[6] : '00';
    return { allDay: false, dateTime: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${seconds}` };
  }
  return null;
}

/** wall-clock 加 1 小时（对齐 ICS DURATION:PT1H），不涉及时区换算。 */
function addOneHour(dateTime) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(dateTime);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((v) => Number.parseInt(v, 10));
  const base = Date.UTC(y, mo - 1, d, h, mi, s) + 60 * 60 * 1000;
  const dt = new Date(base);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
}

/** 时间戳字段（done_at 等）→ "YYYY-MM-DDTHH:mm:ss"；不可解析返回 null。 */
function normalizeTimestamp(raw) {
  const parsed = parseDeadline(raw);
  if (!parsed) return null;
  return parsed.allDay ? `${parsed.date}T00:00:00` : parsed.dateTime;
}

/** 取 "YYYY-MM-DD"（created_at 的日期部分）。 */
function datePart(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(raw).trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// ── §5.3 状态映射 ────────────────────────────────────────────────────────────

/**
 * notice-hub status → { todoStatus, status }。
 * open→pending/confirmed；candidate→pending/tentative；done→done/confirmed；
 * dismissed/expired→cancelled/cancelled。未知状态按 open 处理（容错）。
 */
function mapStatus(status) {
  switch (str(status)) {
    case 'candidate':
      return { todoStatus: 'pending', status: 'tentative' };
    case 'done':
      return { todoStatus: 'done', status: 'confirmed' };
    case 'dismissed':
    case 'expired':
      return { todoStatus: 'cancelled', status: 'cancelled' };
    case 'open':
    default:
      return { todoStatus: 'pending', status: 'confirmed' };
  }
}

// ── §5.4 优先级映射 ──────────────────────────────────────────────────────────

/**
 * category + effective_urgent/urgent_override + importance + pinned → priority。
 * effective_urgent 为真（含 urgent_override）或 category==='urgent' → urgent；
 * action→high；academic→normal；info→low；未知→normal；
 * pinned 且上述低于 high → 升为 high。
 */
function mapPriority(task) {
  const category = str(task && task.category);
  const urgent = truthy(task && task.effective_urgent) || truthy(task && task.urgent_override) || category === 'urgent';
  let priority;
  if (urgent) priority = 'urgent';
  else if (category === 'action') priority = 'high';
  else if (category === 'academic') priority = 'normal';
  else if (category === 'info') priority = 'low';
  else priority = 'normal';
  if (truthy(task && task.pinned) && priority !== 'urgent' && priority !== 'high') priority = 'high';
  return priority;
}

// ── §5.1 描述与标签 ──────────────────────────────────────────────────────────

/** 行动 / 来源群 / 发送者 / 原文 / 稍后提醒至（空字段省略）。 */
function buildDescription(task) {
  const lines = [];
  const action = str(task && task.action).trim();
  const groups = Array.isArray(task && task.groups) ? task.groups.map((g) => str(g).trim()).filter(Boolean) : [];
  const sender = str(task && task.sender).trim();
  const evidence = str(task && task.evidence).trim();
  const snooze = str(task && task.snooze_until).trim();
  if (action) lines.push(`行动：${action}`);
  if (groups.length > 0) lines.push(`来源群：${groups.join('、')}`);
  if (sender) lines.push(`发送者：${sender}`);
  if (evidence) lines.push(`原文：${evidence}`);
  if (snooze) lines.push(`稍后提醒至：${snooze}`);
  return truncate(lines.join('\n'), DESCRIPTION_MAX);
}

/** groups[] 群名 + "notice-hub" +（candidate）"待确认" +（pinned）"置顶"。 */
function buildTags(task) {
  const tags = [];
  const groups = Array.isArray(task && task.groups) ? task.groups : [];
  for (const group of groups) {
    const name = str(group).trim();
    if (name && !tags.includes(name)) tags.push(name);
  }
  tags.push('notice-hub');
  if (str(task && task.status) === 'candidate' && !tags.includes('待确认')) tags.push('待确认');
  if (truthy(task && task.pinned) && !tags.includes('置顶')) tags.push('置顶');
  return tags.map((tag) => truncate(tag, 64));
}

/** config.reminderOffsetsMinutes → reminders（仅对有 deadline 的条目生成）。 */
function buildReminders(config) {
  const offsets = Array.isArray(config && config.reminderOffsetsMinutes) ? config.reminderOffsetsMinutes : [];
  return offsets.map((offsetMinutes) => ({ offsetMinutes, delivery: 'both', enabled: true }));
}

// ── §5.1/§5.2 任务 → 日程项 ─────────────────────────────────────────────────

/**
 * 任务条目 → PluginScheduleUpsertItem。
 * @param {object} task /api/tasks 条目
 * @param {object} config 插件配置（categoryName / reminderOffsetsMinutes）
 * @returns {object|null} 无法定位 id 时返回 null（调用方计 skipped）
 */
function mapTaskToItem(task, config) {
  if (!task || typeof task !== 'object') return null;
  const taskId = str(task.task_key).trim() || str(task.id).trim();
  if (!taskId) return null;

  const parsed = parseDeadline(task.deadline);
  const mapped = mapStatus(task.status);
  const title = truncate(str(task.summary).trim() || str(task.action).trim() || `群务台任务 #${taskId}`, TITLE_MAX);

  const item = {
    externalId: `nh-task:${taskId}`,
    kind: 'todo',
    title,
    description: buildDescription(task) || null,
    location: null,
    startAt: parsed ? (parsed.allDay ? parsed.date : parsed.dateTime) : null,
    endAt: parsed && !parsed.allDay ? addOneHour(parsed.dateTime) : null,
    allDay: Boolean(parsed && parsed.allDay),
    status: mapped.status,
    todoStatus: mapped.todoStatus,
    dueAt: parsed ? (parsed.allDay ? parsed.date : parsed.dateTime) : null,
    priority: mapPriority(task),
    completedAt: str(task.status) === 'done' ? normalizeTimestamp(task.done_at) : null,
    libraryPath: null,
    libraryName: null,
    notePath: null,
    category: str((config && config.categoryName) || '群务台'),
    tags: buildTags(task),
    color: null,
    recurrence: null,
    course: null,
    reminders: parsed ? buildReminders(config) : [], // §5.2：仅对有 deadline 的条目生成提醒
  };
  return item;
}

// ── §5.5 公告 → 日程项 ──────────────────────────────────────────────────────

/**
 * 公告条目 → PluginScheduleUpsertItem（kind='event' 全天）。
 * @returns {object|null} 缺 id 或 created_at 日期不可解析时返回 null
 */
function mapNoticeToItem(notice, config) {
  if (!notice || typeof notice !== 'object') return null;
  const id = str(notice.id).trim();
  const day = datePart(notice.created_at);
  if (!id || !day) return null;

  return {
    externalId: `nh-notice:${id}`,
    kind: 'event',
    title: truncate(`公告 · ${str(notice.summary).trim()}`, TITLE_MAX),
    description: truncate(str(notice.body), DESCRIPTION_MAX) || null,
    location: null,
    startAt: day,
    endAt: null,
    allDay: true,
    status: 'confirmed',
    todoStatus: null,
    dueAt: null,
    priority: null,
    completedAt: null,
    libraryPath: null,
    libraryName: null,
    notePath: null,
    category: str((config && config.categoryName) || '群务台'),
    tags: ['notice-hub', '公告'],
    color: null,
    recurrence: null,
    course: null,
    reminders: [],
  };
}

// ── §5.4 冲突规则（本地完成态优先） ─────────────────────────────────────────

/**
 * 同步更新已有条目时：若本地 todoStatus ∈ {done, cancelled} 而远端仍为 open/candidate，
 * 跳过该条目的状态字段（其余字段照常更新），调用方计 counts.skipped。
 * @param {object} item 待写入的日程项
 * @param {string|null|undefined} localTodoStatus 本地已有条目的 todoStatus（未知传 null）
 * @returns {{ item: object, skipped: boolean }}
 */
function applyLocalStatusPriority(item, localTodoStatus) {
  const local = str(localTodoStatus);
  const remotePending = item && item.todoStatus === 'pending';
  if ((local === 'done' || local === 'cancelled') && remotePending) {
    const patched = { ...item };
    delete patched.status;
    delete patched.todoStatus;
    delete patched.completedAt;
    return { item: patched, skipped: true };
  }
  return { item, skipped: false };
}

// ── §5.6 ICS 兜底事件 → 日程项 ──────────────────────────────────────────────

/** UID "task-123@qq-live-digest" → "123"（去前缀 task-、去后缀 @qq-live-digest）。 */
function extractIcsId(uid) {
  let id = str(uid).trim();
  if (!id) return '';
  if (id.startsWith('task-')) id = id.slice('task-'.length);
  if (id.endsWith('@qq-live-digest')) id = id.slice(0, -'@qq-live-digest'.length);
  return id;
}

/**
 * ICS VEVENT（lib/ics.js 解析产物）→ PluginScheduleUpsertItem。映射同 §5.1–§5.4，
 * 但 ICS 无 category/importance → priority='normal'；STATUS:CANCELLED → cancelled。
 * @returns {object|null} UID/时间缺失时返回 null（调用方计 skipped）
 */
function mapIcsEventToItem(event, config) {
  if (!event || typeof event !== 'object') return null;
  const id = extractIcsId(event.uid);
  const start = event.start;
  if (!id || !start || (!start.date && !start.dateTime)) return null;

  const allDay = Boolean(start.date);
  const startAt = allDay ? start.date : start.dateTime;
  let endAt = null;
  if (!allDay) {
    const end = event.end;
    if (end && end.dateTime) endAt = end.dateTime;
    else if (Number.isFinite(event.durationMinutes) && event.durationMinutes > 0) {
      const base = Date.parse(`${startAt}Z`);
      if (Number.isFinite(base)) {
        const dt = new Date(base + event.durationMinutes * 60 * 1000);
        const pad = (n) => String(n).padStart(2, '0');
        endAt = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
      }
    } else {
      endAt = addOneHour(startAt);
    }
  }

  const icsStatus = str(event.status).toUpperCase();
  let mapped;
  if (icsStatus === 'CANCELLED') mapped = { todoStatus: 'cancelled', status: 'cancelled' };
  else if (icsStatus === 'TENTATIVE') mapped = { todoStatus: 'pending', status: 'tentative' };
  else mapped = { todoStatus: 'pending', status: 'confirmed' };

  return {
    externalId: `nh-task:${id}`,
    kind: 'todo',
    title: truncate(str(event.summary).trim() || `群务台任务 #${id}`, TITLE_MAX),
    description: truncate(str(event.description), DESCRIPTION_MAX) || null,
    location: null,
    startAt,
    endAt,
    allDay,
    status: mapped.status,
    todoStatus: mapped.todoStatus,
    dueAt: startAt,
    priority: 'normal',
    completedAt: null,
    libraryPath: null,
    libraryName: null,
    notePath: null,
    category: str((config && config.categoryName) || '群务台'),
    tags: ['notice-hub'],
    color: null,
    recurrence: null,
    course: null,
    reminders: buildReminders(config),
  };
}

// ── 批量收集（含去重与容错计数） ─────────────────────────────────────────────

const TASK_GROUPS = ['candidates', 'today', 'week', 'later', 'done', 'pinned'];

/**
 * 从 /api/tasks 载荷收集全部任务条目（六个分组合并，按 externalId 去重）。
 * @returns {{ items: object[], skipped: number, errors: string[] }}
 */
function collectTaskItems(payload, config) {
  const items = [];
  const seen = new Set();
  let skipped = 0;
  const errors = [];
  if (!payload || typeof payload !== 'object') return { items, skipped, errors };
  for (const group of TASK_GROUPS) {
    const list = Array.isArray(payload[group]) ? payload[group] : [];
    for (const task of list) {
      let item = null;
      try {
        item = mapTaskToItem(task, config);
      } catch (error) {
        errors.push(`任务条目映射失败：${error && error.message ? error.message : error}`);
      }
      if (!item) {
        skipped += 1;
        continue;
      }
      if (seen.has(item.externalId)) continue;
      seen.add(item.externalId);
      items.push(item);
    }
  }
  return { items, skipped, errors };
}

/**
 * 从 /api/notices 载荷收集公告条目。
 * @returns {{ items: object[], skipped: number, errors: string[] }}
 */
function collectNoticeItems(payload, config) {
  const items = [];
  const seen = new Set();
  let skipped = 0;
  const errors = [];
  const list = payload && Array.isArray(payload.items) ? payload.items : [];
  for (const notice of list) {
    let item = null;
    try {
      item = mapNoticeToItem(notice, config);
    } catch (error) {
      errors.push(`公告条目映射失败：${error && error.message ? error.message : error}`);
    }
    if (!item) {
      skipped += 1;
      continue;
    }
    if (seen.has(item.externalId)) continue;
    seen.add(item.externalId);
    items.push(item);
  }
  return { items, skipped, errors };
}

/**
 * 从 ICS 事件列表收集条目（§5.6：解析失败的事件跳过并计数，不中断整体同步）。
 * @returns {{ items: object[], skipped: number, errors: string[] }}
 */
function collectIcsItems(events, config) {
  const items = [];
  const seen = new Set();
  let skipped = 0;
  const errors = [];
  const list = Array.isArray(events) ? events : [];
  for (const event of list) {
    let item = null;
    try {
      item = mapIcsEventToItem(event, config);
    } catch (error) {
      errors.push(`ICS 事件映射失败：${error && error.message ? error.message : error}`);
    }
    if (!item) {
      skipped += 1;
      continue;
    }
    if (seen.has(item.externalId)) continue;
    seen.add(item.externalId);
    items.push(item);
  }
  return { items, skipped, errors };
}

module.exports = {
  SOURCE,
  TITLE_MAX,
  DESCRIPTION_MAX,
  parseDeadline,
  addOneHour,
  normalizeTimestamp,
  datePart,
  mapStatus,
  mapPriority,
  buildDescription,
  buildTags,
  mapTaskToItem,
  mapNoticeToItem,
  mapIcsEventToItem,
  extractIcsId,
  applyLocalStatusPriority,
  collectTaskItems,
  collectNoticeItems,
  collectIcsItems,
};
