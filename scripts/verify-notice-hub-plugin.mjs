/**
 * notice-hub 插件验证：归一化 / ICS 解析 / 缓存 / HTTP 客户端 / 端到端（mock 群务台）/ 许可证合规。
 * Notice-hub plugin verification: normalization, ICS fallback parsing, cache, HTTP client,
 * end-to-end sync against an in-process mock notice-hub service, and license compliance.
 *
 * 契约：docs/notice-hub-插件化与日程适配方案.md §5（5.1–5.6 数据映射）、§6（插件包行为与降级）、
 * §7（token 安全）、§10.2 / §10.6（验收）。
 *
 * 自包含：不依赖 /tmp/notice-hub-src（合规比对在缺少上游目录时打印 SKIP），
 * 所有夹具内联；mock 服务用 node 内置 http 起在 127.0.0.1 临时端口。
 *
 * Run: node scripts/verify-notice-hub-plugin.mjs（在仓库根目录执行）
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const rootDir = process.cwd();
const pluginDir = rootDir; // 本仓库根目录即插件包（plugin.json 在顶层）

const normalize = require(path.join(pluginDir, 'lib', 'normalize.js'));
const icsLib = require(path.join(pluginDir, 'lib', 'ics.js'));
const cacheLib = require(path.join(pluginDir, 'lib', 'cache.js'));
const clientLib = require(path.join(pluginDir, 'lib', 'client.js'));
const configLib = require(path.join(pluginDir, 'lib', 'config.js'));
const noticeHub = require(path.join(pluginDir, 'main.js'));

// ── 测试骨架：逐项 PASS/FAIL，末尾 ALL PASS，失败非零退出 ─────────────────────

const failures = [];
let passCount = 0;

function section(title) {
  console.log(`\n== ${title}`);
}

async function check(name, fn) {
  try {
    await fn();
    passCount += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name} — ${error && error.message ? error.message : error}`);
  }
}

async function waitFor(probe, { timeoutMs = 8000, intervalMs = 5, what = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try {
      value = probe();
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待${what}超时（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ── 公共夹具 ─────────────────────────────────────────────────────────────────

const TOKEN = 'nh-secret-token-XYZ'; // 全程用于验证 token 不落日志/缓存/状态/URL
const CFG = { categoryName: '群务台', reminderOffsetsMinutes: [1440, 0] };

function baseTask(overrides = {}) {
  return {
    id: 1,
    task_key: 'manual:base',
    summary: '基线任务',
    action: '',
    category: 'info',
    importance: 3,
    deadline: null,
    groups: [],
    sender: '',
    evidence: '',
    status: 'open',
    done: false,
    pinned: false,
    snooze_until: null,
    effective_urgent: false,
    overdue: false,
    updated_at: '2026-03-01T10:00:00',
    done_at: null,
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. 归一化（normalize.js）—— 契约 §5.1–§5.5
// ════════════════════════════════════════════════════════════════════════════

section('归一化 §5.1 任务字段映射');

await check('§5.1 externalId = "nh-task:" + task_key', () => {
  const item = normalize.mapTaskToItem(baseTask({ task_key: 'manual:ab12' }), CFG);
  assert.equal(item.externalId, 'nh-task:manual:ab12');
});

await check('§5.1 task_key 缺省时用 id 生成 externalId', () => {
  const item = normalize.mapTaskToItem(baseTask({ task_key: '', id: 77 }), CFG);
  assert.equal(item.externalId, 'nh-task:77');
});

await check('§5.1 task_key 与 id 均缺失 → 返回 null（调用方计 skipped）', () => {
  assert.equal(normalize.mapTaskToItem(baseTask({ task_key: '', id: '' }), CFG), null);
});

await check('§5.1 title 取 summary 并截断 200 字符', () => {
  const long = '群'.repeat(230);
  const item = normalize.mapTaskToItem(baseTask({ summary: long }), CFG);
  assert.equal(item.title.length, 200);
  assert.equal(item.title, long.slice(0, 200));
});

await check('§5.1 description 多行拼装（行动/来源群/发送者/原文/稍后提醒至）', () => {
  const item = normalize.mapTaskToItem(
    baseTask({
      action: '提交高数作业',
      groups: ['2024级学习群', '家长群'],
      sender: '张老师',
      evidence: '请在周四前提交第三章习题',
      snooze_until: '2026-03-04 21:00',
    }),
    CFG,
  );
  assert.equal(
    item.description,
    '行动：提交高数作业\n来源群：2024级学习群、家长群\n发送者：张老师\n原文：请在周四前提交第三章习题\n稍后提醒至：2026-03-04 21:00',
  );
});

await check('§5.1 description 空字段省略（只剩行动一行）', () => {
  const item = normalize.mapTaskToItem(baseTask({ action: '只看一眼', groups: [], sender: '', evidence: '', snooze_until: '' }), CFG);
  assert.equal(item.description, '行动：只看一眼');
});

await check('§5.1 description 全部字段为空 → null', () => {
  const item = normalize.mapTaskToItem(baseTask({ action: '', groups: [], sender: '', evidence: '', snooze_until: '' }), CFG);
  assert.equal(item.description, null);
});

await check('§5.1 description 截断 4000 字符', () => {
  const item = normalize.mapTaskToItem(baseTask({ evidence: '文'.repeat(5000) }), CFG);
  assert.equal(item.description.length, 4000);
});

await check('§5.1 tags：群名 + "notice-hub"（candidate 加"待确认"、pinned 加"置顶"）', () => {
  const plain = normalize.mapTaskToItem(baseTask({ groups: ['2024级学习群', '家长群'] }), CFG);
  assert.deepEqual(plain.tags, ['2024级学习群', '家长群', 'notice-hub']);
  const candidate = normalize.mapTaskToItem(baseTask({ groups: ['社团群'], status: 'candidate' }), CFG);
  assert.deepEqual(candidate.tags, ['社团群', 'notice-hub', '待确认']);
  const pinned = normalize.mapTaskToItem(baseTask({ groups: ['班委群'], pinned: true }), CFG);
  assert.deepEqual(pinned.tags, ['班委群', 'notice-hub', '置顶']);
  const both = normalize.mapTaskToItem(baseTask({ groups: [], status: 'candidate', pinned: true }), CFG);
  assert.deepEqual(both.tags, ['notice-hub', '待确认', '置顶']);
});

await check('§5.1 category 使用配置 categoryName', () => {
  const item = normalize.mapTaskToItem(baseTask(), { ...CFG, categoryName: '群通知' });
  assert.equal(item.category, '群通知');
  const fallback = normalize.mapTaskToItem(baseTask(), { categoryName: '' });
  assert.equal(fallback.category, '群务台');
});

await check('§5.1 completedAt 仅 status=done 时写入（取 done_at）', () => {
  const done = normalize.mapTaskToItem(baseTask({ status: 'done', done_at: '2026-03-02 18:00' }), CFG);
  assert.equal(done.completedAt, '2026-03-02T18:00:00');
  const open = normalize.mapTaskToItem(baseTask({ status: 'open', done_at: '2026-03-02 18:00' }), CFG);
  assert.equal(open.completedAt, null);
});

await check('§5.1 固定字段：kind=todo，color/recurrence/course 为 null，libraryPath/notePath 为 null', () => {
  const item = normalize.mapTaskToItem(baseTask(), CFG);
  assert.equal(item.kind, 'todo');
  assert.equal(item.color, null);
  assert.deepEqual(item.recurrence, null);
  assert.equal(item.course, null);
  assert.equal(item.libraryPath, null);
  assert.equal(item.notePath, null);
});

section('归一化 §5.2 时间映射');

await check('§5.2 带时刻 → startAt 秒补 :00、endAt +1h、allDay=false、dueAt=startAt', () => {
  const item = normalize.mapTaskToItem(baseTask({ deadline: '2026-03-05 09:30' }), CFG);
  assert.equal(item.startAt, '2026-03-05T09:30:00');
  assert.equal(item.endAt, '2026-03-05T10:30:00');
  assert.equal(item.allDay, false);
  assert.equal(item.dueAt, item.startAt);
});

await check('§5.2 带秒时刻保留秒（YYYY-MM-DD HH:MM:SS 形态）', () => {
  const item = normalize.mapTaskToItem(baseTask({ deadline: '2026-03-05 09:30:15' }), CFG);
  assert.equal(item.startAt, '2026-03-05T09:30:15');
  assert.equal(item.endAt, '2026-03-05T10:30:15');
});

await check('§5.2 纯日期 → allDay=true、startAt/dueAt=YYYY-MM-DD、endAt=null', () => {
  const item = normalize.mapTaskToItem(baseTask({ deadline: '2026-03-10' }), CFG);
  assert.equal(item.allDay, true);
  assert.equal(item.startAt, '2026-03-10');
  assert.equal(item.endAt, null);
  assert.equal(item.dueAt, '2026-03-10');
});

await check('§5.2 无 deadline → 全部时间字段 null、allDay=false', () => {
  const item = normalize.mapTaskToItem(baseTask({ deadline: null }), CFG);
  assert.equal(item.startAt, null);
  assert.equal(item.endAt, null);
  assert.equal(item.dueAt, null);
  assert.equal(item.allDay, false);
});

await check('§5.2 reminders 仅对有 deadline 的条目生成，offsetMinutes 来自配置', () => {
  const withDeadline = normalize.mapTaskToItem(baseTask({ deadline: '2026-03-05 09:30' }), CFG);
  assert.deepEqual(withDeadline.reminders, [
    { offsetMinutes: 1440, delivery: 'both', enabled: true },
    { offsetMinutes: 0, delivery: 'both', enabled: true },
  ]);
  const custom = normalize.mapTaskToItem(baseTask({ deadline: '2026-03-05' }), {
    ...CFG,
    reminderOffsetsMinutes: [30, 10],
  });
  assert.deepEqual(custom.reminders.map((r) => r.offsetMinutes), [30, 10]);
  assert.deepEqual(custom.reminders.map((r) => r.delivery), ['both', 'both']);
  const noDeadline = normalize.mapTaskToItem(baseTask({ deadline: null }), CFG);
  assert.deepEqual(noDeadline.reminders, []);
});

await check('§5.2 时间映射默认值与契约一致（[1440, 0] 提前 1 天 + 到点）', () => {
  assert.deepEqual([...configLib.DEFAULTS.reminderOffsetsMinutes], [1440, 0]);
  assert.equal(configLib.DEFAULTS.categoryName, '群务台');
  assert.equal(configLib.DEFAULTS.syncIntervalMinutes, 15);
  assert.equal(configLib.DEFAULTS.includeNotices, false);
  assert.equal(configLib.DEFAULTS.pruneMissing, false);
});

section('归一化 §5.3 状态映射（全 5 种）');

for (const [remote, todoStatus, status] of [
  ['open', 'pending', 'confirmed'],
  ['candidate', 'pending', 'tentative'],
  ['done', 'done', 'confirmed'],
  ['dismissed', 'cancelled', 'cancelled'],
  ['expired', 'cancelled', 'cancelled'],
]) {
  await check(`§5.3 status=${remote} → todoStatus=${todoStatus} / status=${status}`, () => {
    const item = normalize.mapTaskToItem(baseTask({ status: remote }), CFG);
    assert.equal(item.todoStatus, todoStatus);
    assert.equal(item.status, status);
  });
}

section('归一化 §5.4 优先级映射与冲突规则');

for (const [label, task, priority] of [
  ['category=urgent → urgent', { category: 'urgent' }, 'urgent'],
  ['category=action → high', { category: 'action' }, 'high'],
  ['category=academic → normal', { category: 'academic' }, 'normal'],
  ['category=info → low', { category: 'info' }, 'low'],
  ['effective_urgent → urgent', { category: 'info', effective_urgent: true }, 'urgent'],
  ['urgent_override → urgent', { category: 'info', urgent_override: true }, 'urgent'],
  ['pinned + info 升为 high', { category: 'info', pinned: true }, 'high'],
  ['pinned + academic 升为 high', { category: 'academic', pinned: true }, 'high'],
  ['pinned + action 保持 high', { category: 'action', pinned: true }, 'high'],
  ['pinned + urgent 保持 urgent', { category: 'urgent', pinned: true }, 'urgent'],
]) {
  await check(`§5.4 ${label}`, () => {
    assert.equal(normalize.mapPriority(baseTask(task)), priority);
    assert.equal(normalize.mapTaskToItem(baseTask(task), CFG).priority, priority);
  });
}

await check('§5.4 冲突规则：本地 done + 远端 pending → 跳过状态字段并计 skipped', () => {
  const item = normalize.mapTaskToItem(baseTask({ status: 'open' }), CFG);
  item.completedAt = '2026-03-02T18:00:00';
  const guarded = normalize.applyLocalStatusPriority(item, 'done');
  assert.equal(guarded.skipped, true);
  assert.equal('todoStatus' in guarded.item, false);
  assert.equal('status' in guarded.item, false);
  assert.equal('completedAt' in guarded.item, false);
  assert.equal(guarded.item.title, item.title, '其余字段照常更新');
  assert.equal(guarded.item.externalId, item.externalId);
});

await check('§5.4 冲突规则：本地 cancelled + 远端 candidate → 跳过状态字段并计 skipped', () => {
  const item = normalize.mapTaskToItem(baseTask({ status: 'candidate' }), CFG);
  const guarded = normalize.applyLocalStatusPriority(item, 'cancelled');
  assert.equal(guarded.skipped, true);
  assert.equal('todoStatus' in guarded.item, false);
  assert.equal('status' in guarded.item, false);
});

await check('§5.4 冲突规则：远端状态变化（done/dismissed）正常写入不跳过', () => {
  const remoteDone = normalize.mapTaskToItem(baseTask({ status: 'done', done_at: '2026-03-02 18:00' }), CFG);
  assert.equal(normalize.applyLocalStatusPriority(remoteDone, 'done').skipped, false);
  assert.equal(normalize.applyLocalStatusPriority(remoteDone, 'cancelled').skipped, false);
  const remoteDismissed = normalize.mapTaskToItem(baseTask({ status: 'dismissed' }), CFG);
  assert.equal(normalize.applyLocalStatusPriority(remoteDismissed, 'done').skipped, false);
});

await check('§5.4 冲突规则：本地 pending / 未知状态不触发跳过', () => {
  const item = normalize.mapTaskToItem(baseTask({ status: 'open' }), CFG);
  assert.equal(normalize.applyLocalStatusPriority(item, 'pending').skipped, false);
  assert.equal(normalize.applyLocalStatusPriority(item, null).skipped, false);
  assert.equal(normalize.applyLocalStatusPriority(item, undefined).skipped, false);
});

section('归一化 §5.5 公告映射');

await check('§5.5 公告 → externalId "nh-task:" → "nh-notice:"、"公告 · "前缀、全天事件', () => {
  const item = normalize.mapNoticeToItem(
    { id: 'n-1', kind: 'announcement', created_at: '2026-03-01T08:00:00', summary: '期中考试安排', body: '考试时间见附表' },
    CFG,
  );
  assert.equal(item.externalId, 'nh-notice:n-1');
  assert.equal(item.title, '公告 · 期中考试安排');
  assert.equal(item.description, '考试时间见附表');
  assert.equal(item.kind, 'event');
  assert.equal(item.allDay, true);
  assert.equal(item.startAt, '2026-03-01');
  assert.equal(item.endAt, null);
  assert.equal(item.dueAt, null);
  assert.equal(item.status, 'confirmed');
  assert.deepEqual(item.tags, ['notice-hub', '公告']);
  assert.equal(item.category, '群务台');
  assert.deepEqual(item.reminders, []);
});

await check('§5.5 公告缺 id 或 created_at 不可解析 → null（计 skipped）', () => {
  assert.equal(normalize.mapNoticeToItem({ id: '', created_at: '2026-03-01T08:00:00' }, CFG), null);
  assert.equal(normalize.mapNoticeToItem({ id: 'n-2', created_at: 'not-a-date' }, CFG), null);
});

await check('§5.5 公告 title 截断 200、description 截断 4000', () => {
  const item = normalize.mapNoticeToItem(
    { id: 'n-3', created_at: '2026-03-01', summary: '题'.repeat(300), body: '文'.repeat(5000) },
    CFG,
  );
  assert.equal(item.title.length, 200);
  assert.equal(item.description.length, 4000);
});

await check('collectTaskItems 六分组合并、按 externalId 去重、坏条目计 skipped 不中断', () => {
  const payload = {
    candidates: [baseTask({ id: 1, task_key: 'k1' })],
    today: [baseTask({ id: 1, task_key: 'k1' }), baseTask({ id: 2, task_key: 'k2' })],
    week: [baseTask({ id: 3, task_key: '' })],
    later: [{ summary: '缺 id 的坏条目' }],
    done: [],
    pinned: [baseTask({ id: 2, task_key: 'k2' })],
    stats: { total: 3 },
  };
  const collected = normalize.collectTaskItems(payload, CFG);
  assert.deepEqual(collected.items.map((i) => i.externalId).sort(), ['nh-task:3', 'nh-task:k1', 'nh-task:k2']);
  assert.equal(collected.skipped, 1);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. ICS 解析（ics.js）—— 契约 §5.6
// ════════════════════════════════════════════════════════════════════════════

section('ICS 兜底解析 §5.6');

const icsFixture = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//notice-hub//qq-live-digest//CN',
  'BEGIN:VEVENT',
  'UID:task-201@qq-live-digest',
  'SUMMARY:线性代数期中测',
  ' 验安排',
  'DESCRIPTION:请携带学生证\\n考场在教三楼',
  'DTSTART;TZID=Asia/Shanghai:20260305T093000',
  'DURATION:PT1H',
  'STATUS:CONFIRMED',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:task-202@qq-live-digest',
  'SUMMARY:班会',
  'DTSTART;VALUE=DATE:20260306',
  'DTEND;VALUE=DATE:20260307',
  'STATUS:CANCELLED',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:缺 UID 的坏事件',
  'DTSTART:20260307T100000',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:task-203@qq-live-digest',
  'SUMMARY:缺 DTSTART 的坏事件',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:task-204@qq-live-digest',
  'SUMMARY:未闭合的坏事件',
  'DTSTART:20260308T100000',
  'END:VCALENDAR',
].join('\r\n');

const parsedIcs = icsLib.parseIcs(icsFixture);

await check('§5.6 行折叠还原（SUMMARY 续行拼接）', () => {
  assert.equal(parsedIcs.events[0].summary, '线性代数期中测验安排');
});

await check('§5.6 TZID 参数形态 DTSTART;TZID=Asia/Shanghai → wall-clock dateTime', () => {
  assert.deepEqual(parsedIcs.events[0].start, { allDay: false, dateTime: '2026-03-05T09:30:00' });
});

await check('§5.6 VALUE=DATE 形态 → allDay 日期', () => {
  assert.deepEqual(parsedIcs.events[1].start, { allDay: true, date: '2026-03-06' });
  assert.deepEqual(parsedIcs.events[1].end, { allDay: true, date: '2026-03-07' });
});

await check('§5.6 DURATION:PT1H → durationMinutes=60；STATUS 透传', () => {
  assert.equal(parsedIcs.events[0].durationMinutes, 60);
  assert.equal(parsedIcs.events[0].status, 'CONFIRMED');
  assert.equal(parsedIcs.events[1].status, 'CANCELLED');
});

await check('§5.6 DESCRIPTION 反转义（\\\\n → 换行）', () => {
  assert.equal(parsedIcs.events[0].description, '请携带学生证\n考场在教三楼');
});

await check('§5.6 坏事件跳过并计数、不中断（缺 UID / 缺 DTSTART / 未闭合）', () => {
  assert.equal(parsedIcs.events.length, 2, '两个好事件保留');
  assert.equal(parsedIcs.skipped, 3, '三个坏事件计数');
  assert.equal(parsedIcs.errors.length, 3);
});

await check('§5.6 UID 去 task- 前缀与 @qq-live-digest 后缀 → externalId "nh-task:"+id', () => {
  assert.equal(normalize.extractIcsId('task-201@qq-live-digest'), '201');
  assert.equal(normalize.extractIcsId('task-9'), '9');
  assert.equal(normalize.extractIcsId('42@qq-live-digest'), '42');
  const item = normalize.mapIcsEventToItem(parsedIcs.events[0], CFG);
  assert.equal(item.externalId, 'nh-task:201');
});

await check('§5.6 ICS 事件映射：DURATION:PT1H → endAt=+1h，dueAt=startAt，priority=normal', () => {
  const item = normalize.mapIcsEventToItem(parsedIcs.events[0], CFG);
  assert.equal(item.startAt, '2026-03-05T09:30:00');
  assert.equal(item.endAt, '2026-03-05T10:30:00');
  assert.equal(item.dueAt, '2026-03-05T09:30:00');
  assert.equal(item.allDay, false);
  assert.equal(item.priority, 'normal', 'ICS 无 category/importance → priority=normal');
  assert.equal(item.todoStatus, 'pending');
  assert.equal(item.status, 'confirmed');
  assert.equal(item.title, '线性代数期中测验安排');
  assert.equal(item.description, '请携带学生证\n考场在教三楼');
  assert.deepEqual(item.tags, ['notice-hub']);
  assert.equal(item.category, '群务台');
  assert.deepEqual(item.reminders, [
    { offsetMinutes: 1440, delivery: 'both', enabled: true },
    { offsetMinutes: 0, delivery: 'both', enabled: true },
  ]);
});

await check('§5.6 STATUS:CANCELLED → todoStatus=cancelled / status=cancelled', () => {
  const item = normalize.mapIcsEventToItem(parsedIcs.events[1], CFG);
  assert.equal(item.todoStatus, 'cancelled');
  assert.equal(item.status, 'cancelled');
  assert.equal(item.allDay, true);
  assert.equal(item.startAt, '2026-03-06');
  assert.equal(item.endAt, null, '全天事件无 endAt');
  assert.equal(item.dueAt, '2026-03-06');
});

await check('§5.6 collectIcsItems：坏事件映射失败计 skipped 不中断', () => {
  const collected = normalize.collectIcsItems([...parsedIcs.events, { uid: '', start: null }, null], CFG);
  assert.equal(collected.items.length, 2);
  assert.equal(collected.skipped, 2);
});

await check('§5.6 parseDuration / parseIcsDate 附属形态（P1D、UTC Z 格式合法）', () => {
  assert.equal(icsLib.parseDuration('P1D'), 1440);
  assert.equal(icsLib.parseDuration('PT1H30M'), 90);
  const utc = icsLib.parseIcsDate('20260305T013000Z', {});
  assert.equal(utc.allDay, false);
  assert.match(utc.dateTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, 'UTC → 本地 wall-clock（随运行机器时区，仅校验格式）');
});

// ════════════════════════════════════════════════════════════════════════════
// 3. 缓存（cache.js）—— 契约 §6 / §7（token 不落盘）
// ════════════════════════════════════════════════════════════════════════════

section('缓存快照 cache.js');

function memFiles() {
  const store = new Map();
  return {
    store,
    async readFile(name) {
      if (!store.has(name)) throw new Error(`ENOENT: ${name}`);
      return new Uint8Array(store.get(name));
    },
    async writeFile(name, data) {
      store.set(name, Buffer.from(data));
    },
  };
}

await check('缓存 写/读快照往返一致（tasks/notices/counts/externalIds）', async () => {
  const files = memFiles();
  const tasks = [{ externalId: 'nh-task:1', title: 't' }];
  const notices = [{ externalId: 'nh-notice:n1', title: 'n' }];
  await cacheLib.saveCache(files, { tasks, notices, counts: { todos: 1, notices: 1, skipped: 0 }, source: 'api' });
  const doc = await cacheLib.loadCache(files);
  assert.equal(doc.version, cacheLib.CACHE_VERSION);
  assert.deepEqual(doc.tasks, tasks);
  assert.deepEqual(doc.notices, notices);
  assert.deepEqual(doc.externalIds, ['nh-task:1', 'nh-notice:n1']);
  assert.equal(doc.source, 'api');
  assert.deepEqual(doc.counts, { todos: 1, notices: 1, skipped: 0 });
});

await check('缓存序列化结果不含 token（写入前 scrub 疑似凭据键）', async () => {
  const files = memFiles();
  await cacheLib.saveCache(files, {
    tasks: [{ externalId: 'nh-task:1', token: 'LEAK-TOKEN-VALUE', nested: { apiKey: 'LEAK-API-VALUE' } }],
    notices: [],
    counts: {},
    source: 'api',
    token: 'LEAK-TOP-VALUE',
    authorization: 'LEAK-AUTH-VALUE',
  });
  const text = files.store.get(cacheLib.CACHE_FILE).toString('utf8');
  for (const leak of ['LEAK-TOKEN-VALUE', 'LEAK-API-VALUE', 'LEAK-TOP-VALUE', 'LEAK-AUTH-VALUE']) {
    assert.equal(text.includes(leak), false, `缓存文件不得包含 ${leak}`);
  }
  assert.deepEqual(cacheLib.findSecretKeys(JSON.parse(text)), [], '终检：无凭据键名残留');
});

await check('scrubSecrets / findSecretKeys 递归剔除 token/secret/password/api_key 键', () => {
  const scrubbed = cacheLib.scrubSecrets({ a: 1, token: 'x', deep: [{ api_key: 'y', ok: 2 }], keep: { password: 'z' } });
  assert.deepEqual(scrubbed, { a: 1, deep: [{ ok: 2 }], keep: {} });
  assert.deepEqual(cacheLib.findSecretKeys({ token: 'v', list: [{ api_key: 'w' }] }), ['token', 'list[0].api_key']);
});

await check('损坏 JSON 容错：loadCache 返回 null 不抛错', async () => {
  const files = memFiles();
  files.store.set(cacheLib.CACHE_FILE, Buffer.from('这不是 JSON {{{'));
  assert.equal(await cacheLib.loadCache(files), null);
  files.store.set(cacheLib.CACHE_FILE, Buffer.from('{"version":999,"tasks":[]}'));
  assert.equal(await cacheLib.loadCache(files), null, '版本不符也返回 null');
  const empty = memFiles();
  assert.equal(await cacheLib.loadCache(empty), null, '文件缺失返回 null');
});

await check('clearCache 写空快照；saveCache 拒绝写入含凭据键的文档', async () => {
  const files = memFiles();
  const doc = await cacheLib.clearCache(files);
  assert.deepEqual(doc.tasks, []);
  assert.deepEqual(doc.notices, []);
  const loaded = await cacheLib.loadCache(files);
  assert.deepEqual(loaded.tasks, []);
  // findSecretKeys 终检存在（防御性）：构造直写 doc 的情形由 saveCache 内部把关
  const raw = { version: 1, savedAt: 'x', source: 'x', counts: {}, tasks: [], notices: [], externalIds: [] };
  assert.deepEqual(cacheLib.findSecretKeys(raw), []);
});

// ════════════════════════════════════════════════════════════════════════════
// 4. 客户端（client.js）—— 契约 §6（token 注入 / 重试退避 / 错误分类）
// ════════════════════════════════════════════════════════════════════════════

section('HTTP 客户端 client.js');

function jsonResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function recorder() {
  const calls = [];
  const sleeps = [];
  return { calls, sleeps, sleep: async (ms) => { sleeps.push(ms); } };
}

await check('token 仅经 X-Token 头注入，URL 不含 token；token 为空不发该头', async () => {
  const r = recorder();
  const client = clientLib.createClient({
    baseUrl: 'http://127.0.0.1:8766/',
    token: TOKEN,
    fetchImpl: async (url, init) => {
      r.calls.push({ url, init });
      return jsonResponse({ candidates: [] });
    },
    sleep: r.sleep,
  });
  await client.fetchTasks();
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].init.headers['X-Token'], TOKEN);
  assert.equal(r.calls[0].url, 'http://127.0.0.1:8766/api/tasks', '尾部斜杠归一');
  assert.equal(r.calls[0].url.includes(TOKEN), false, 'URL 不得含 token');
  assert.equal(r.calls[0].init.redirect, 'manual');

  const r2 = recorder();
  const anonymous = clientLib.createClient({
    baseUrl: 'http://127.0.0.1:8766',
    token: '',
    fetchImpl: async (url, init) => {
      r2.calls.push({ url, init });
      return jsonResponse({ items: [] });
    },
    sleep: r2.sleep,
  });
  await anonymous.fetchNotices();
  assert.equal('X-Token' in r2.calls[0].init.headers, false, '空 token 不发 X-Token 头');
});

await check('重试退避：3 次重试、2s/4s/8s 序列（注入 sleep 不真等）', async () => {
  const r = recorder();
  const client = clientLib.createClient({
    baseUrl: 'http://127.0.0.1:8766',
    token: TOKEN,
    fetchImpl: async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    },
    sleep: r.sleep,
  });
  await assert.rejects(() => client.fetchTasks(), (error) => {
    assert.equal(error.code, 'unreachable');
    return true;
  });
  assert.equal(r.sleeps.length, 3, '退避 3 次');
  assert.deepEqual(r.sleeps, [2000, 4000, 8000], '退避序列 2s/4s/8s');
});

await check('超时：AbortSignal.timeout 生效并分类为 timeout（不真等退避）', async () => {
  const r = recorder();
  let attempts = 0;
  const client = clientLib.createClient({
    baseUrl: 'http://127.0.0.1:8766',
    token: TOKEN,
    timeoutMs: 30,
    fetchImpl: async (url, init) => {
      attempts += 1;
      return new Promise((resolve, reject) => {
        // AbortSignal.timeout 的定时器是 unref 的：加一个保底 ref'd 定时器防事件循环提前排空。
        const keepAlive = setTimeout(() => reject(Object.assign(new Error('fallback timeout'), { name: 'TimeoutError' })), 2000);
        init.signal.addEventListener('abort', () => {
          clearTimeout(keepAlive);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    },
    sleep: r.sleep,
  });
  const started = Date.now();
  await assert.rejects(() => client.fetchTasks(), (error) => {
    assert.equal(error.code, 'timeout');
    assert.match(error.message, /超时/);
    return true;
  });
  assert.equal(attempts, 4, '1 次原始 + 3 次重试');
  assert.deepEqual(r.sleeps, [2000, 4000, 8000]);
  assert.ok(Date.now() - started < 5000, '注入 sleep 后不应真等 14 秒');
});

await check('错误分类 4xx/5xx：401/403=auth、404=not-found、500=server（重试 3 次）、400=http（不重试）', async () => {
  const cases = [
    { status: 401, code: 'auth', retries: 0, pattern: /鉴权失败/ },
    { status: 403, code: 'auth', retries: 0, pattern: /鉴权失败/ },
    { status: 404, code: 'not-found', retries: 0, pattern: /接口不存在/ },
    { status: 500, code: 'server', retries: 3, pattern: /服务异常/ },
    { status: 400, code: 'http', retries: 0, pattern: /请求失败/ },
  ];
  for (const c of cases) {
    const r = recorder();
    let attempts = 0;
    const client = clientLib.createClient({
      baseUrl: 'http://127.0.0.1:8766',
      token: TOKEN,
      fetchImpl: async () => {
        attempts += 1;
        return jsonResponse('err', c.status);
      },
      sleep: r.sleep,
    });
    await assert.rejects(() => client.fetchTasks(), (error) => {
      assert.equal(error.code, c.code, `HTTP ${c.status} → ${c.code}`);
      assert.match(error.message, c.pattern, `HTTP ${c.status} 中文文案`);
      return true;
    });
    assert.equal(attempts, 1 + c.retries, `HTTP ${c.status} 尝试次数`);
    assert.equal(r.sleeps.length, c.retries, `HTTP ${c.status} 退避次数`);
  }
});

await check('错误分类：200 非 JSON → bad-json（不重试、提示 .ics 兜底）', async () => {
  const r = recorder();
  let attempts = 0;
  const client = clientLib.createClient({
    baseUrl: 'http://127.0.0.1:8766',
    token: TOKEN,
    fetchImpl: async () => {
      attempts += 1;
      return jsonResponse('<html>oops</html>', 200);
    },
    sleep: r.sleep,
  });
  await assert.rejects(() => client.fetchTasks(), (error) => {
    assert.equal(error.code, 'bad-json');
    assert.match(error.message, /无法解析为 JSON/);
    assert.match(error.message, /兜底/);
    return true;
  });
  assert.equal(attempts, 1, 'bad-json 不重试');
  assert.deepEqual(r.sleeps, []);
});

await check('baseUrl 不可达 → 中文可操作错误（含地址与修复动作），且不含 token', async () => {
  const r = recorder();
  const client = clientLib.createClient({
    baseUrl: 'http://127.0.0.1:8766',
    token: TOKEN,
    fetchImpl: async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8766'), { code: 'ECONNREFUSED' });
    },
    sleep: r.sleep,
  });
  await assert.rejects(() => client.fetchTasks(), (error) => {
    assert.equal(error.code, 'unreachable');
    assert.equal(error.retryable, true);
    assert.match(error.message, /无法连接群务台/);
    assert.match(error.message, /http:\/\/127\.0\.0\.1:8766/, '错误文案含 baseUrl');
    assert.match(error.message, /请确认群务台已启动/, '可操作修复动作');
    assert.equal(error.message.includes(TOKEN), false, '错误文案不得含 token');
    return true;
  });
});

await check('所有错误分类文案均不含 token', async () => {
  const tokenErrors = [];
  const capture = (fn) => fn().catch((error) => tokenErrors.push(error));
  const failing = (status) =>
    clientLib.createClient({
      baseUrl: 'http://127.0.0.1:8766',
      token: TOKEN,
      fetchImpl: async () => jsonResponse('err', status),
      sleep: async () => {},
    });
  await capture(() => failing(401).fetchTasks());
  await capture(() => failing(404).fetchTasks());
  await capture(() => failing(500).fetchTasks());
  await capture(() => failing(400).fetchTasks());
  await capture(() =>
    clientLib.createClient({
      baseUrl: 'http://127.0.0.1:8766',
      token: TOKEN,
      fetchImpl: async () => jsonResponse('<x>', 200),
      sleep: async () => {},
    }).fetchTasks(),
  );
  await capture(() =>
    clientLib.createClient({
      baseUrl: 'http://127.0.0.1:8766',
      token: TOKEN,
      fetchImpl: async () => {
        throw new Error('boom');
      },
      sleep: async () => {},
    }).fetchTasks(),
  );
  assert.equal(tokenErrors.length, 6, '六类错误均已收集');
  for (const error of tokenErrors) {
    assert.equal(String(error.message).includes(TOKEN), false, `错误文案泄露 token：${error.message}`);
    assert.equal(JSON.stringify({ ...error, cause: undefined }).includes(TOKEN), false);
  }
});

await check('fetchIcs 返回文本（text 模式）；fetchNotices 正常 JSON', async () => {
  const r = recorder();
  const client = clientLib.createClient({
    baseUrl: 'http://127.0.0.1:8766',
    token: '',
    fetchImpl: async (url) => (url.endsWith('.ics') ? jsonResponse('BEGIN:VCALENDAR\r\nEND:VCALENDAR', 200) : jsonResponse({ items: [{ id: 'n1' }] })),
    sleep: r.sleep,
  });
  assert.equal(await client.fetchIcs(), 'BEGIN:VCALENDAR\r\nEND:VCALENDAR');
  assert.deepEqual(await client.fetchNotices(), { items: [{ id: 'n1' }] });
});

await check('config.js：非法配置回退并给中文警告；configSummary 不含 token', () => {
  const { config, warnings } = configLib.normalizeConfig(
    { baseUrl: 'ftp://bad', token: TOKEN, syncIntervalMinutes: 9999, categoryName: '  ', reminderOffsetsMinutes: 'x' },
    configLib.DEFAULTS,
  );
  assert.equal(config.baseUrl, 'http://127.0.0.1:8766');
  assert.equal(config.token, TOKEN, 'token 保留（但不外显）');
  assert.equal(config.syncIntervalMinutes, 240);
  assert.equal(config.categoryName, '群务台');
  assert.ok(warnings.length >= 3, '给出中文警告');
  for (const w of warnings) assert.match(w, /[一-龥]/, '警告为中文');
  const summary = JSON.stringify(configLib.configSummary(config));
  assert.equal(summary.includes(TOKEN), false, 'configSummary 不含 token');
  assert.equal(JSON.stringify(configLib.configSummary(config)).includes('"tokenSet":true'), true);
});

// ════════════════════════════════════════════════════════════════════════════
// 5. 端到端：mock 群务台 + main.js + fake PluginContext
// ════════════════════════════════════════════════════════════════════════════

section('端到端（mock 服务 + main.js）');

// —— mock 群务台（node 内置 http，127.0.0.1 临时端口；X-Token / ?token= 鉴权）——

function manyTasksPayload(total = 620) {
  const tasks = [];
  for (let i = 0; i < total; i += 1) {
    tasks.push(
      baseTask({
        id: 1000 + i,
        task_key: `bulk:${i}`,
        summary: `批量任务 ${i}`,
        category: i % 2 === 0 ? 'info' : 'academic',
        deadline: `2026-03-${String((i % 28) + 1).padStart(2, '0')} 10:00`,
        groups: ['批量群'],
      }),
    );
  }
  return {
    candidates: [],
    today: tasks.slice(0, 200),
    week: tasks.slice(200, 400),
    later: tasks.slice(400),
    done: [],
    pinned: [],
    stats: { total },
  };
}

function curatedTasksPayload() {
  return {
    candidates: [
      baseTask({
        id: 106,
        task_key: 'auto:99',
        summary: '报名志愿服务',
        action: '在群里接龙报名',
        category: 'academic',
        deadline: '2026-03-09 08:00',
        groups: ['班委群'],
        status: 'candidate',
      }),
    ],
    today: [
      baseTask({
        id: 101,
        task_key: 'manual:ab12',
        summary: '提交高数作业第三章',
        action: '提交高数作业',
        category: 'urgent',
        importance: 5,
        deadline: '2026-03-05 09:30',
        groups: ['2024级学习群', '家长群'],
        sender: '张老师',
        evidence: '请在周四前提交第三章习题',
        status: 'open',
        pinned: true,
        effective_urgent: true,
      }),
      baseTask({
        id: 102,
        task_key: 'auto:9f3',
        summary: '报名参加讲座',
        action: '报名参加讲座',
        category: 'info',
        deadline: '2026-03-06',
        groups: ['社团群'],
        sender: '李同学',
        snooze_until: '2026-03-04 21:00',
        status: 'candidate',
      }),
    ],
    week: [
      baseTask({
        id: 104,
        task_key: 'auto:77',
        summary: '已撤销的社团活动',
        category: 'academic',
        deadline: '2026-03-08 23:59',
        status: 'dismissed',
      }),
    ],
    later: [
      baseTask({
        id: 105,
        task_key: 'auto:88',
        summary: '查看教务通知',
        category: 'info',
        deadline: '2026-03-10',
        status: 'open',
      }),
      baseTask({
        id: 107,
        task_key: 'auto:89',
        summary: '无截止的长期任务',
        category: 'academic',
        deadline: null,
        status: 'open',
      }),
    ],
    done: [
      baseTask({
        id: 103,
        task_key: 'manual:done1',
        summary: '交实验报告',
        action: '上传实验报告',
        category: 'action',
        deadline: '2026-03-02 12:00',
        status: 'done',
        done_at: '2026-03-02 18:00',
      }),
    ],
    pinned: [
      baseTask({
        id: 101,
        task_key: 'manual:ab12',
        summary: '提交高数作业第三章',
        action: '提交高数作业',
        category: 'urgent',
        deadline: '2026-03-05 09:30',
        groups: ['2024级学习群', '家长群'],
        status: 'open',
        pinned: true,
        effective_urgent: true,
      }),
    ],
    stats: { candidates: 1, today: 2, week: 1, later: 2, done: 1, pinned: 1 },
  };
}

const curatedNotices = [
  { id: 'n-1', kind: 'announcement', created_at: '2026-03-01T08:00:00', summary: '期中考试安排', body: '考试时间见附表' },
];

const e2eIcsText = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//notice-hub//qq-live-digest//CN',
  'BEGIN:VEVENT',
  'UID:task-201@qq-live-digest',
  'SUMMARY:实验课调课通知',
  'DTSTART;TZID=Asia/Shanghai:20260312T140000',
  'DURATION:PT1H',
  'STATUS:CONFIRMED',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:task-202@qq-live-digest',
  'SUMMARY:班会改期',
  'DTSTART;VALUE=DATE:20260315',
  'STATUS:CANCELLED',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function startMockServer(state) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    state.requests.push({ path: url.pathname, search: url.search, tokenHeader: req.headers['x-token'] ?? null });
    const authorized = !state.token || req.headers['x-token'] === state.token || url.searchParams.get('token') === state.token;
    const send = (status, body, type = 'text/plain') => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(body);
    };
    if (!authorized) return send(401, 'unauthorized');
    const mode = state.mode;
    if (url.pathname === '/api/tasks') {
      if (mode === 'server-error') return send(500, 'boom');
      if (mode === 'bad-json-ok-ics' || mode === 'all-bad') return send(200, '<html>not json</html>', 'text/html');
      if (mode === 'many') return send(200, JSON.stringify(manyTasksPayload()), 'application/json');
      return send(200, JSON.stringify(state.tasks), 'application/json');
    }
    if (url.pathname === '/api/notices') {
      if (mode === 'server-error') return send(500, 'boom');
      return send(200, JSON.stringify({ items: state.notices }), 'application/json');
    }
    if (url.pathname === '/calendar.ics') {
      if (mode === 'server-error' || mode === 'all-bad') return send(500, 'boom');
      return send(200, state.icsText, 'text/calendar');
    }
    return send(404, 'nope');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state }));
  });
}

// —— fake PluginContext ——

function createFakeEvents() {
  const handlers = new Map();
  const history = [];
  return {
    history,
    on(event, handler) {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const current = handlers.get(event) || [];
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
      };
    },
    emit(event, payload) {
      history.push({ event, payload });
      for (const handler of handlers.get(event) || []) handler(payload);
    },
  };
}

function createFakeSchedule() {
  const store = new Map();
  const calls = { upserts: [], removes: [] };
  return {
    store,
    calls,
    async upsertItems(source, items) {
      if (items.length > 500) throw new Error('upsertItems 单次调用上限 500 条');
      const map = store.get(source) || new Map();
      store.set(source, map);
      const upsertedIds = [];
      for (const item of items) {
        const existing = map.get(item.externalId) || { externalId: item.externalId, itemId: `item-${map.size + 1}`, updatedAt: '' };
        Object.assign(existing, item, { updatedAt: new Date().toISOString() });
        map.set(item.externalId, existing);
        upsertedIds.push(existing.itemId);
      }
      calls.upserts.push({ source, count: items.length, items });
      return { upsertedIds };
    },
    async removeItems(source, externalIds) {
      const map = store.get(source) || new Map();
      const removedIds = [];
      for (const externalId of externalIds) {
        const record = map.get(externalId);
        if (record) {
          removedIds.push(record.itemId);
          map.delete(externalId);
        }
      }
      calls.removes.push({ source, externalIds: [...externalIds] });
      return { removedIds };
    },
    async listSource(source) {
      return [...(store.get(source) || new Map()).values()];
    },
  };
}

function createFsFiles(dir) {
  return {
    async readFile(name) {
      return new Uint8Array(readFileSync(path.join(dir, name)));
    },
    async writeFile(name, data) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, name), Buffer.from(data));
    },
  };
}

const allLogLines = [];
const allStatusPayloads = [];
const allCacheTexts = [];

function createFakeContext(storageDir) {
  const events = createFakeEvents();
  const schedule = createFakeSchedule();
  const commands = new Map();
  const logLines = [];
  const log = {
    info: (m) => logLines.push(`[info] ${m}`),
    warn: (m) => logLines.push(`[warn] ${m}`),
    error: (m) => logLines.push(`[error] ${m}`),
  };
  const statusPayloads = [];
  events.on('plugin:notice-hub:status', (payload) => {
    statusPayloads.push(payload);
    allStatusPayloads.push(payload);
  });
  return {
    events,
    schedule,
    commands,
    logLines,
    statusPayloads,
    context: {
      manifest: { id: 'com.expertkt.notice-hub', name: '群务台 · notice-hub 同步', version: '1.0.0' },
      events,
      schedule,
      log,
      files: createFsFiles(storageDir),
      ui: { registerCommand: (command) => commands.set(command.id, command) },
      network: { fetch: (url, init) => fetch(url, init) },
    },
  };
}

// —— 快速定时器：把真等 2s/4s/8s 的退避压到毫秒级（重试时序由单测覆盖） ——

const realSetTimeout = globalThis.setTimeout;
function installFastTimers() {
  globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, typeof ms === 'number' && ms > 50 ? 10 : ms, ...args);
}
function restoreTimers() {
  globalThis.setTimeout = realSetTimeout;
}

async function waitTerminal(statusPayloads, from = 0) {
  return waitFor(
    () => {
      for (let i = from; i < statusPayloads.length; i += 1) {
        const payload = statusPayloads[i];
        if (payload.state === 'ok' || payload.state === 'error') return payload;
      }
      return null;
    },
    { what: '同步终态', timeoutMs: 10000 },
  );
}

installFastTimers();

let mock = null;
const scenarioResults = {};
try {
  // ── 场景 A：正常同步（映射抽查 / 状态流 / 冲突规则 / pruneMissing=true / 令牌安全） ──
  mock = await startMockServer({
    mode: 'ok',
    token: TOKEN,
    tasks: curatedTasksPayload(),
    notices: curatedNotices,
    icsText: e2eIcsText,
    requests: [],
  });
  const baseUrl = `http://127.0.0.1:${mock.port}`;

  {
    const storageDir = mkdtempSync(path.join(os.tmpdir(), 'nh-storage-a-'));
    const fake = createFakeContext(storageDir);
    // 预置：stale 条目（pruneMissing=true 应清理）+ 已有条目 102 本地 done（冲突规则应跳过状态）
    fake.schedule.store.set('notice-hub', new Map([
      ['nh-task:stale-9', { externalId: 'nh-task:stale-9', itemId: 'item-stale', updatedAt: '2026-03-01T00:00:00Z' }],
      ['nh-task:auto:9f3', { externalId: 'nh-task:auto:9f3', itemId: 'item-102', updatedAt: '2026-03-01T00:00:00Z', todoStatus: 'done' }],
    ]));
    noticeHub.activate(fake.context);
    fake.events.emit('host:notice-hub:config', {
      enabled: true,
      baseUrl,
      token: TOKEN,
      includeTodos: true,
      includeNotices: true,
      pruneMissing: true,
      categoryName: '群务台',
      reminderOffsetsMinutes: [1440, 0],
      syncIntervalMinutes: 15,
    });
    const terminal1 = await waitTerminal(fake.statusPayloads);
    scenarioResults.a = { fake, storageDir, terminal1 };

    await check('e2e A：status 状态流 syncing → ok（§10.2）', () => {
      const states = fake.statusPayloads.map((p) => p.state);
      const syncingIndex = states.indexOf('syncing');
      assert.ok(syncingIndex >= 0, `状态流含 syncing：${states.join('→')}`);
      assert.ok(states.includes('ok'), `状态流含 ok：${states.join('→')}`);
      assert.ok(states.indexOf('ok') > syncingIndex, 'ok 出现在 syncing 之后');
      const pairIndex = states.findIndex((s, i) => s === 'syncing' && states[i + 1] === 'ok');
      assert.ok(pairIndex >= 0, `存在 syncing→ok 相邻转移：${states.join('→')}`);
    });

    await check('e2e A：status 载荷形状符合 §4.3 NoticeHubStatus', () => {
      const payload = scenarioResults.a.terminal1;
      assert.deepEqual(
        Object.keys(payload).sort(),
        ['counts', 'lastError', 'lastSuccessAt', 'lastSyncAt', 'nextSyncAt', 'serviceReachable', 'state'],
      );
      assert.deepEqual(Object.keys(payload.counts).sort(), ['notices', 'skipped', 'todos']);
      assert.equal(payload.state, 'ok');
      assert.equal(payload.serviceReachable, true);
      assert.equal(typeof payload.lastSyncAt, 'string');
      assert.equal(typeof payload.lastSuccessAt, 'string');
    });

    await check('e2e A：upsertItems 收到的条目符合 §5 映射（抽查字段）', () => {
      const upserts = fake.schedule.calls.upserts;
      assert.equal(upserts.length, 1, '一次批量调用（8 条 ≤ 500）');
      assert.equal(upserts[0].source, 'notice-hub');
      const byId = new Map(upserts[0].items.map((item) => [item.externalId, item]));

      const t1 = byId.get('nh-task:manual:ab12');
      assert.ok(t1, 'nh-task:manual:ab12 已写入');
      assert.equal(t1.title, '提交高数作业第三章');
      assert.equal(t1.kind, 'todo');
      assert.equal(t1.startAt, '2026-03-05T09:30:00');
      assert.equal(t1.endAt, '2026-03-05T10:30:00');
      assert.equal(t1.dueAt, '2026-03-05T09:30:00');
      assert.equal(t1.allDay, false);
      assert.equal(t1.priority, 'urgent');
      assert.equal(t1.status, 'confirmed');
      assert.equal(t1.todoStatus, 'pending');
      assert.deepEqual(t1.tags, ['2024级学习群', '家长群', 'notice-hub', '置顶']);
      assert.equal(t1.category, '群务台');
      assert.equal(t1.description, '行动：提交高数作业\n来源群：2024级学习群、家长群\n发送者：张老师\n原文：请在周四前提交第三章习题');
      assert.deepEqual(t1.reminders, [
        { offsetMinutes: 1440, delivery: 'both', enabled: true },
        { offsetMinutes: 0, delivery: 'both', enabled: true },
      ]);

      const t2 = byId.get('nh-task:auto:9f3');
      assert.ok(t2, 'nh-task:auto:9f3 已写入');
      assert.equal('todoStatus' in t2, false, '§5.4 冲突规则：本地 done 优先，跳过状态字段');
      assert.equal('status' in t2, false);
      assert.equal(t2.priority, 'low');
      assert.equal(t2.allDay, true);
      assert.equal(t2.startAt, '2026-03-06');
      assert.equal(t2.endAt, null);
      assert.equal(t2.dueAt, '2026-03-06');
      assert.deepEqual(t2.tags, ['社团群', 'notice-hub', '待确认']);
      assert.equal(t2.description, '行动：报名参加讲座\n来源群：社团群\n发送者：李同学\n稍后提醒至：2026-03-04 21:00');

      const t3 = byId.get('nh-task:auto:77');
      assert.equal(t3.todoStatus, 'cancelled');
      assert.equal(t3.status, 'cancelled');
      assert.equal(t3.priority, 'normal');

      const t4 = byId.get('nh-task:auto:88');
      assert.equal(t4.allDay, true);
      assert.equal(t4.startAt, '2026-03-10');
      assert.equal(t4.dueAt, '2026-03-10');
      assert.deepEqual(t4.reminders, [
        { offsetMinutes: 1440, delivery: 'both', enabled: true },
        { offsetMinutes: 0, delivery: 'both', enabled: true },
      ], '纯日期 deadline 也有提醒');
      assert.deepEqual(t4.tags, ['notice-hub']);
      assert.equal(t4.priority, 'low');

      const t5 = byId.get('nh-task:auto:89');
      assert.equal(t5.startAt, null);
      assert.equal(t5.endAt, null);
      assert.equal(t5.dueAt, null);
      assert.equal(t5.allDay, false);
      assert.deepEqual(t5.reminders, [], '无 deadline 不生成提醒');
      assert.equal(t5.description, null, '空字段全部省略 → null');

      const tDone = byId.get('nh-task:manual:done1');
      assert.equal(tDone.todoStatus, 'done');
      assert.equal(tDone.status, 'confirmed');
      assert.equal(tDone.completedAt, '2026-03-02T18:00:00');
      assert.equal(tDone.priority, 'high');

      const tCandidate = byId.get('nh-task:auto:99');
      assert.equal(tCandidate.todoStatus, 'pending');
      assert.equal(tCandidate.status, 'tentative');
      assert.deepEqual(tCandidate.tags, ['班委群', 'notice-hub', '待确认']);

      const notice = byId.get('nh-notice:n-1');
      assert.ok(notice, '公告已写入');
      assert.equal(notice.title, '公告 · 期中考试安排');
      assert.equal(notice.kind, 'event');
      assert.equal(notice.allDay, true);
      assert.equal(notice.startAt, '2026-03-01');
      assert.deepEqual(notice.tags, ['notice-hub', '公告']);
      assert.equal(notice.status, 'confirmed');

      assert.equal(byId.size, 8, '7 个任务（today+pinned 去重）+ 1 个公告');
    });

    await check('e2e A：counts（todos=7, notices=1, skipped=1 冲突跳过）', () => {
      const counts = scenarioResults.a.terminal1.counts;
      assert.equal(counts.todos, 7);
      assert.equal(counts.notices, 1);
      assert.equal(counts.skipped, 1);
    });

    await check('e2e A：pruneMissing=true 清理远端已消失的 stale 条目', () => {
      assert.equal(fake.schedule.calls.removes.length, 1);
      assert.deepEqual(fake.schedule.calls.removes[0].externalIds, ['nh-task:stale-9']);
      assert.equal(fake.schedule.store.get('notice-hub').has('nh-task:stale-9'), false);
    });

    await check('e2e A：ui.registerCommand 注册 §4.5 两条命令', () => {
      assert.deepEqual([...fake.commands.keys()].sort(), ['notice-hub:reset-cache', 'notice-hub:sync-now']);
      assert.equal(typeof fake.commands.get('notice-hub:sync-now').execute, 'function');
      assert.equal(typeof fake.commands.get('notice-hub:reset-cache').execute, 'function');
    });

    await check('e2e A：token 只经 X-Token 头到达服务端，不出现在 URL', () => {
      const requests = mock.state.requests;
      assert.ok(requests.length > 0, 'mock 收到请求');
      for (const request of requests) {
        assert.equal(request.tokenHeader, TOKEN, `X-Token 注入：${request.path}`);
        assert.equal(request.search.includes(TOKEN), false, `URL 不含 token：${request.path}${request.search}`);
      }
    });

    // 第二轮：host:notice-hub:sync-now 事件触发（§4.4）—— 验证远端状态变化正常写入
    const statusCountBefore = fake.statusPayloads.length;
    fake.events.emit('host:notice-hub:sync-now', null);
    await waitTerminal(fake.statusPayloads, statusCountBefore);
    scenarioResults.a.round2Count = fake.statusPayloads.length;

    await check('e2e A：host:notice-hub:sync-now 触发第二轮同步（syncing→ok）', () => {
      const states = fake.statusPayloads.slice(statusCountBefore).map((p) => p.state);
      assert.ok(states.includes('syncing') && states.includes('ok'), `第二轮状态流：${states.join('→')}`);
    });

    await check('e2e A：第二轮冲突规则与远端状态写入（102 仍跳过、done 仍写入）', () => {
      const upserts = fake.schedule.calls.upserts;
      assert.equal(upserts.length, 2, '第二轮再一次批量调用');
      const byId = new Map(upserts[1].items.map((item) => [item.externalId, item]));
      assert.equal('todoStatus' in byId.get('nh-task:auto:9f3'), false, '本地 done 优先持续生效');
      assert.equal(byId.get('nh-task:manual:done1').todoStatus, 'done', '远端 done 正常写入');
      assert.equal(byId.get('nh-task:auto:77').todoStatus, 'cancelled', '远端 dismissed 正常写入');
    });

    await check('e2e A：缓存快照落盘（source=api、无 token）', () => {
      const cachePath = path.join(storageDir, cacheLib.CACHE_FILE);
      const text = readFileSync(cachePath, 'utf8');
      allCacheTexts.push(text);
      const doc = JSON.parse(text);
      assert.equal(doc.source, 'api');
      assert.deepEqual(doc.counts, { todos: 7, notices: 1, skipped: 1 });
      assert.equal(doc.externalIds.length, 8);
      assert.equal(text.includes(TOKEN), false, '缓存文件不含 token');
    });

    await check('e2e A：reset-cache 命令清缓存后全量重同步', async () => {
      const before = fake.statusPayloads.length;
      await fake.commands.get('notice-hub:reset-cache').execute();
      const terminal = await waitTerminal(fake.statusPayloads, before);
      assert.equal(terminal.state, 'ok');
      assert.ok(fake.logLines.some((line) => line.includes('缓存已清空')), '日志记录缓存清空');
    });

    noticeHub.deactivate();
    rmSync(storageDir, { recursive: true, force: true });
  }

  // ── 场景 B：pruneMissing=false 不删远端消失条目 ──
  {
    const storageDir = mkdtempSync(path.join(os.tmpdir(), 'nh-storage-b-'));
    const fake = createFakeContext(storageDir);
    fake.schedule.store.set('notice-hub', new Map([
      ['nh-task:stale-9', { externalId: 'nh-task:stale-9', itemId: 'item-stale', updatedAt: '2026-03-01T00:00:00Z' }],
    ]));
    noticeHub.activate(fake.context);
    fake.events.emit('host:notice-hub:config', {
      enabled: true,
      baseUrl,
      token: TOKEN,
      includeTodos: true,
      includeNotices: false,
      pruneMissing: false,
    });
    const terminal = await waitTerminal(fake.statusPayloads);
    scenarioResults.b = { fake, terminal };

    await check('e2e B：pruneMissing=false 不调用 removeItems、stale 条目保留', () => {
      assert.equal(terminal.state, 'ok');
      assert.equal(fake.schedule.calls.removes.length, 0);
      assert.equal(fake.schedule.store.get('notice-hub').has('nh-task:stale-9'), true);
    });

    await check('e2e B：includeNotices=false 不同步公告', () => {
      const items = fake.schedule.calls.upserts.flatMap((call) => call.items);
      assert.equal(items.filter((item) => item.externalId.startsWith('nh-notice:')).length, 0);
      assert.equal(items.length, 7);
    });

    noticeHub.deactivate();
    rmSync(storageDir, { recursive: true, force: true });
  }

  // ── 场景 C：mock 返回 500（tasks 与 .ics 全挂）→ state=error、缓存降级不删不写 ──
  mock.server.close();
  mock = await startMockServer({ mode: 'server-error', token: TOKEN, tasks: curatedTasksPayload(), notices: curatedNotices, icsText: e2eIcsText, requests: [] });
  {
    const storageDir = mkdtempSync(path.join(os.tmpdir(), 'nh-storage-c-'));
    const fake = createFakeContext(storageDir);
    fake.schedule.store.set('notice-hub', new Map([
      ['nh-task:keep-1', { externalId: 'nh-task:keep-1', itemId: 'item-keep', updatedAt: '2026-03-01T00:00:00Z' }],
    ]));
    noticeHub.activate(fake.context);
    fake.events.emit('host:notice-hub:config', { enabled: true, baseUrl: `http://127.0.0.1:${mock.port}`, token: TOKEN, includeTodos: true, includeNotices: false, pruneMissing: true });
    const terminal = await waitTerminal(fake.statusPayloads);
    scenarioResults.c = { fake, terminal };

    await check('e2e C：500 → state=error、中文可操作文案、缓存降级不删条目不写库', () => {
      assert.equal(terminal.state, 'error');
      assert.match(terminal.lastError, /[一-龥]/, '中文文案');
      assert.match(terminal.lastError, /群务台/, '指向服务');
      assert.match(terminal.lastError, /请/, '可操作');
      assert.equal(terminal.lastError.includes(TOKEN), false);
      assert.equal(fake.schedule.calls.upserts.length, 0, '不写库');
      assert.equal(fake.schedule.calls.removes.length, 0, '不删条目（缓存降级）');
      assert.equal(fake.schedule.store.get('notice-hub').has('nh-task:keep-1'), true, '已有条目保留');
    });

    noticeHub.deactivate();
    rmSync(storageDir, { recursive: true, force: true });
  }

  // ── 场景 D：断连（baseUrl 不可达）→ state=error、serviceReachable=false ──
  {
    const storageDir = mkdtempSync(path.join(os.tmpdir(), 'nh-storage-d-'));
    const fake = createFakeContext(storageDir);
    fake.schedule.store.set('notice-hub', new Map([
      ['nh-task:keep-2', { externalId: 'nh-task:keep-2', itemId: 'item-keep2', updatedAt: '2026-03-01T00:00:00Z' }],
    ]));
    const deadUrl = 'http://127.0.0.1:9';
    noticeHub.activate(fake.context);
    fake.events.emit('host:notice-hub:config', { enabled: true, baseUrl: deadUrl, token: TOKEN, includeTodos: true, includeNotices: false, pruneMissing: true });
    const terminal = await waitTerminal(fake.statusPayloads);
    scenarioResults.d = { fake, terminal };

    await check('e2e D：断连 → state=error、serviceReachable=false、文案含地址与修复动作', () => {
      assert.equal(terminal.state, 'error');
      assert.equal(terminal.serviceReachable, false);
      assert.match(terminal.lastError, /无法连接群务台/);
      assert.match(terminal.lastError, /http:\/\/127\.0\.0\.1:9/);
      assert.match(terminal.lastError, /请确认群务台已启动/);
      assert.equal(terminal.lastError.includes(TOKEN), false, '错误文案不含 token');
    });

    await check('e2e D：断连降级不删条目不写库', () => {
      assert.equal(fake.schedule.calls.upserts.length, 0);
      assert.equal(fake.schedule.calls.removes.length, 0);
      assert.equal(fake.schedule.store.get('notice-hub').has('nh-task:keep-2'), true);
    });

    noticeHub.deactivate();
    rmSync(storageDir, { recursive: true, force: true });
  }

  // ── 场景 E：JSON 不可解析但 ICS 可用 → 走 .ics 兜底 ──
  mock.server.close();
  mock = await startMockServer({ mode: 'bad-json-ok-ics', token: TOKEN, tasks: curatedTasksPayload(), notices: curatedNotices, icsText: e2eIcsText, requests: [] });
  {
    const storageDir = mkdtempSync(path.join(os.tmpdir(), 'nh-storage-e-'));
    const fake = createFakeContext(storageDir);
    noticeHub.activate(fake.context);
    fake.events.emit('host:notice-hub:config', {
      enabled: true,
      baseUrl: `http://127.0.0.1:${mock.port}`,
      token: TOKEN,
      includeTodos: true,
      includeNotices: false,
      pruneMissing: true,
    });
    const terminal = await waitTerminal(fake.statusPayloads);
    scenarioResults.e = { fake, terminal, storageDir };

    await check('e2e E：/api/tasks 非 JSON 时走 ICS 兜底（UID 映射 nh-task:<id>）', () => {
      assert.equal(terminal.state, 'ok');
      const items = fake.schedule.calls.upserts.flatMap((call) => call.items);
      const ids = items.map((item) => item.externalId).sort();
      assert.deepEqual(ids, ['nh-task:201', 'nh-task:202']);
      const byId = new Map(items.map((item) => [item.externalId, item]));
      assert.equal(byId.get('nh-task:201').title, '实验课调课通知');
      assert.equal(byId.get('nh-task:201').startAt, '2026-03-12T14:00:00');
      assert.equal(byId.get('nh-task:201').endAt, '2026-03-12T15:00:00', 'DURATION:PT1H');
      assert.equal(byId.get('nh-task:202').todoStatus, 'cancelled');
      assert.equal(byId.get('nh-task:202').allDay, true);
      assert.equal(terminal.counts.todos, 2);
    });

    await check('e2e E：兜底模式写缓存（source=ics、无 token）', () => {
      const text = readFileSync(path.join(storageDir, cacheLib.CACHE_FILE), 'utf8');
      allCacheTexts.push(text);
      const doc = JSON.parse(text);
      assert.equal(doc.source, 'ics');
      assert.equal(text.includes(TOKEN), false);
    });

    noticeHub.deactivate();
    rmSync(storageDir, { recursive: true, force: true });
  }

  // ── 场景 F：JSON 不可解析且 ICS 也失败 → 报错不写库 ──
  mock.server.close();
  mock = await startMockServer({ mode: 'all-bad', token: TOKEN, tasks: curatedTasksPayload(), notices: curatedNotices, icsText: e2eIcsText, requests: [] });
  {
    const storageDir = mkdtempSync(path.join(os.tmpdir(), 'nh-storage-f-'));
    const fake = createFakeContext(storageDir);
    noticeHub.activate(fake.context);
    fake.events.emit('host:notice-hub:config', {
      enabled: true,
      baseUrl: `http://127.0.0.1:${mock.port}`,
      token: TOKEN,
      includeTodos: true,
      includeNotices: false,
      pruneMissing: true,
    });
    const terminal = await waitTerminal(fake.statusPayloads);
    scenarioResults.f = { fake, terminal };

    await check('e2e F：JSON 与 ICS 皆失败 → state=error、报错不写库', () => {
      assert.equal(terminal.state, 'error');
      assert.match(terminal.lastError, /[一-龥]/);
      assert.match(terminal.lastError, /群务台/);
      assert.equal(terminal.lastError.includes(TOKEN), false);
      assert.equal(fake.schedule.calls.upserts.length, 0);
      assert.equal(fake.schedule.calls.removes.length, 0);
    });

    noticeHub.deactivate();
    rmSync(storageDir, { recursive: true, force: true });
  }

  // ── 场景 G：批量上限 500（620 条 → 500 + 120 两批） ──
  mock.server.close();
  mock = await startMockServer({ mode: 'many', token: TOKEN, tasks: curatedTasksPayload(), notices: curatedNotices, icsText: e2eIcsText, requests: [] });
  {
    const storageDir = mkdtempSync(path.join(os.tmpdir(), 'nh-storage-g-'));
    const fake = createFakeContext(storageDir);
    noticeHub.activate(fake.context);
    fake.events.emit('host:notice-hub:config', {
      enabled: true,
      baseUrl: `http://127.0.0.1:${mock.port}`,
      token: TOKEN,
      includeTodos: true,
      includeNotices: false,
      pruneMissing: false,
    });
    const terminal = await waitTerminal(fake.statusPayloads);
    scenarioResults.g = { fake, terminal };

    await check('e2e G：620 条按 500 上限分批（500 + 120），状态 ok', () => {
      assert.equal(terminal.state, 'ok');
      const batches = fake.schedule.calls.upserts.map((call) => call.count);
      assert.deepEqual(batches, [500, 120]);
      for (const count of batches) assert.ok(count <= 500, `单批 ${count} ≤ 500`);
      assert.equal(terminal.counts.todos, 620);
    });

    noticeHub.deactivate();
    rmSync(storageDir, { recursive: true, force: true });
  }
} finally {
  restoreTimers();
  if (mock && mock.server) mock.server.close();
}

// ── 令牌安全总检（契约 §6/§7） ──

section('令牌安全总检');

await check('全测试日志串不含 token', () => {
  const text = allLogLines.concat(...Object.values(scenarioResults).map((r) => (r.fake ? r.fake.logLines : []))).join('\n');
  assert.ok(text.length > 0, '日志非空');
  assert.equal(text.includes(TOKEN), false, '日志泄露 token');
});

await check('全部 status 载荷序列化不含 token', () => {
  const text = JSON.stringify(allStatusPayloads);
  assert.ok(allStatusPayloads.length > 0, 'status 载荷非空');
  assert.equal(text.includes(TOKEN), false, 'status 载荷泄露 token');
});

await check('全部缓存文件不含 token', () => {
  assert.ok(allCacheTexts.length > 0, '缓存文件非空');
  for (const text of allCacheTexts) assert.equal(text.includes(TOKEN), false);
});

// ════════════════════════════════════════════════════════════════════════════
// 6. 合规断言（§10.6）—— 上游源码目录缺失时降级 SKIP
// ════════════════════════════════════════════════════════════════════════════

section('合规核验（§10.6）');

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

const upstreamDir = process.env.NOTICE_HUB_SRC || '/tmp/notice-hub-src';

await check('LICENSE / LICENSE-UPSTREAM / NOTICE 与上游逐字一致（sha256）', () => {
  if (!existsSync(upstreamDir)) {
    console.log(`  SKIP 上游源码目录不存在（${upstreamDir}；可设 NOTICE_HUB_SRC 指定），跳过 sha256 比对`);
    return;
  }
  let compared = 0;
  for (const name of ['LICENSE', 'LICENSE-UPSTREAM', 'NOTICE']) {
    const localPath = path.join(pluginDir, name);
    const upstreamPath = path.join(upstreamDir, name);
    if (!existsSync(upstreamPath)) {
      console.log(`  SKIP 上游缺少 ${name}，跳过该项比对`);
      continue;
    }
    assert.ok(existsSync(localPath), `插件包缺少 ${name}`);
    const localHash = sha256File(localPath);
    const upstreamHash = sha256File(upstreamPath);
    assert.equal(localHash, upstreamHash, `${name} 与上游 sha256 不一致（${localHash} ≠ ${upstreamHash}）`);
    compared += 1;
  }
  if (compared === 0) console.log('  SKIP 上游目录存在但无可比文件');
});

await check('README.md 存在且含署名 / 许可证 / 商用需授权提示', () => {
  const readmePath = path.join(pluginDir, 'README.md');
  assert.ok(existsSync(readmePath), 'README.md 缺失');
  const text = readFileSync(readmePath, 'utf8');
  assert.match(text, /署名/, 'README 缺少「署名」');
  assert.match(text, /许可证|许可/, 'README 缺少「许可证」');
  assert.match(text, /商用|商业/, 'README 缺少商用提示');
  assert.match(text, /授权/, 'README 缺少「授权」提示');
});

await check('插件包目录齐全（plugin.json / main.js / lib 五模块）', () => {
  for (const rel of ['plugin.json', 'main.js', 'lib/client.js', 'lib/normalize.js', 'lib/ics.js', 'lib/cache.js', 'lib/config.js']) {
    assert.ok(existsSync(path.join(pluginDir, rel)), `缺少 ${rel}`);
  }
  const manifest = JSON.parse(readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'));
  assert.equal(manifest.id, 'com.expertkt.notice-hub');
  assert.deepEqual(manifest.permissions, ['ui:command', 'schedule:write', 'system:network', 'system:file']);
  assert.deepEqual(
    manifest.contributes.uiCommands.map((c) => c.id).sort(),
    ['notice-hub:reset-cache', 'notice-hub:sync-now'],
  );
});

// ── 汇总 ─────────────────────────────────────────────────────────────────────

console.log(`\n结果：${passCount} 通过，${failures.length} 失败`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.log(`  FAIL ${failure.name}`);
    if (failure.error && failure.error.stack) console.log(`       ${failure.error.stack.split('\n').slice(0, 3).join('\n       ')}`);
  }
  process.exitCode = 1;
} else {
  console.log('verify-notice-hub-plugin: ALL PASS');
}
