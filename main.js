// Trellora 插件：com.expertkt.notice-hub（群务台 · notice-hub 同步）
//
// 把 notice-hub（群务台）的待办/公告/截止时间同步进 Trellora 日程。
// 设计契约：docs/notice-hub-插件化与日程适配方案.md（§4.3/§4.4 配置与事件总线、
// §5 数据映射、§6 插件包设计、§7 安全要求）。
//
// 入口约定：导出 { activate, deactivate }（CommonJS）。
//
// 安全：访问令牌只经 `X-Token` 请求头传输；日志、缓存、状态载荷一律不含 token。

'use strict';

const { DEFAULTS, normalizeConfig, configSummary } = require('./lib/config');
const { createClient } = require('./lib/client');
const normalize = require('./lib/normalize');
const { parseIcs } = require('./lib/ics');
const cacheApi = require('./lib/cache');

const SOURCE = normalize.SOURCE; // 'notice-hub'
const EVENT_CONFIG = 'host:notice-hub:config';
const EVENT_SYNC_NOW = 'host:notice-hub:sync-now';
const EVENT_STATUS = 'plugin:notice-hub:status';
const UPSERT_BATCH_LIMIT = 500; // 契约 §4.1：单次调用上限 500 条

// ── 模块状态 ────────────────────────────────────────────────────────────────

let ctx = null;
let config = { ...DEFAULTS };
let timer = null;
let syncing = false;
let pendingTrigger = null; // 串行互斥：同步中再触发则合并排队（只排一次）
const unsubscribers = [];

const status = {
  state: 'disabled',
  lastSyncAt: null,
  lastSuccessAt: null,
  lastError: null,
  counts: { todos: 0, notices: 0, skipped: 0 },
  serviceReachable: null,
  nextSyncAt: null,
};

function nowIso() {
  return new Date().toISOString();
}

/** 发布状态到事件总线（plugin:notice-hub:status）。载荷不含 token。 */
function publishStatus(patch = {}) {
  Object.assign(status, patch);
  if (patch.counts) status.counts = { ...patch.counts };
  const payload = {
    state: status.state,
    lastSyncAt: status.lastSyncAt,
    lastSuccessAt: status.lastSuccessAt,
    lastError: status.lastError,
    counts: { ...status.counts },
    serviceReachable: status.serviceReachable,
    nextSyncAt: status.nextSyncAt,
  };
  if (ctx && ctx.events) ctx.events.emit(EVENT_STATUS, payload);
  return payload;
}

function logInfo(message) {
  if (ctx && ctx.log) ctx.log.info(message);
}
function logWarn(message) {
  if (ctx && ctx.log) ctx.log.warn(message);
}
function logError(message) {
  if (ctx && ctx.log) ctx.log.error(message);
}

// ── 定时器（deactivate 必须清理） ───────────────────────────────────────────

function clearTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function restartTimer() {
  clearTimer();
  if (!config.enabled) {
    status.nextSyncAt = null;
    return;
  }
  const intervalMs = config.syncIntervalMinutes * 60 * 1000;
  timer = setInterval(() => {
    requestSync('timer');
  }, intervalMs);
  // 等价 unref 语义：定时器不阻止宿主退出。
  if (timer && typeof timer.unref === 'function') timer.unref();
  status.nextSyncAt = new Date(Date.now() + intervalMs).toISOString();
}

// ── 配置合并（默认值 + host:notice-hub:config） ─────────────────────────────

function applyConfig(raw) {
  const { config: merged, warnings } = normalizeConfig(raw, config);
  config = merged;
  for (const warning of warnings) logWarn(`[配置] ${warning}`);
  logInfo(`配置已更新：${JSON.stringify(configSummary(config))}`);
  restartTimer();
  if (config.enabled) {
    if (status.state === 'disabled' || status.state === 'error') publishStatus({ state: 'idle', nextSyncAt: status.nextSyncAt });
    requestSync('config');
  } else {
    publishStatus({ state: 'disabled', nextSyncAt: null });
  }
}

// ── 同步编排（串行互斥 + 合并排队） ─────────────────────────────────────────

function requestSync(trigger) {
  if (syncing) {
    pendingTrigger = trigger; // 合并排队：只保留一次排队执行
    return Promise.resolve();
  }
  return runSync(trigger);
}

/** 分批 upsert（契约 §4.1 上限 500/批）。返回宿主回报的 skipped 数（未回报则 null）。 */
async function upsertBatched(items) {
  let hostReported = null;
  for (let i = 0; i < items.length; i += UPSERT_BATCH_LIMIT) {
    const result = await ctx.schedule.upsertItems(SOURCE, items.slice(i, i + UPSERT_BATCH_LIMIT));
    if (result && typeof result.skipped === 'number') {
      hostReported = (hostReported ?? 0) + result.skipped;
    }
  }
  return hostReported;
}

/**
 * 执行一次同步。
 * 降级语义（契约 §6）：网络失败→沿用缓存数据不删条目，state='error'；
 * JSON 解析失败/接口不可用→尝试 ICS 兜底；两者都失败→报错不写库。
 */
async function runSync(trigger) {
  syncing = true;
  publishStatus({ state: 'syncing', lastSyncAt: nowIso(), serviceReachable: null });
  logInfo(`开始同步（触发：${trigger}）`);

  const counts = { todos: 0, notices: 0, skipped: 0 };
  const warnings = [];

  try {
    const client = createClient({
      baseUrl: config.baseUrl,
      token: config.token,
      fetchImpl: (url, init) => ctx.network.fetch(url, init),
    });

    /** @type {object[]} */
    const taskItems = [];
    const noticeItems = [];
    let mode = 'api';

    if (config.includeTodos) {
      let tasksPayload = null;
      try {
        tasksPayload = await client.fetchTasks();
      } catch (error) {
        const code = error && error.code;
        if (code === 'bad-json' || code === 'not-found' || code === 'server') {
          // ICS 兜底（契约 §5.6）：仅当 /api/tasks 不可用时。
          logWarn(`任务接口不可用（${code}），改用日历订阅（.ics）兜底解析。`);
          const icsText = await client.fetchIcs();
          const parsed = parseIcs(icsText);
          const collected = normalize.collectIcsItems(parsed.events, config);
          taskItems.push(...collected.items);
          counts.skipped += collected.skipped + parsed.skipped;
          warnings.push(...parsed.errors, ...collected.errors);
          mode = 'ics';
          tasksPayload = null;
        } else {
          throw error; // unreachable / timeout / auth：缓存降级，不写库
        }
      }
      if (tasksPayload) {
        const collected = normalize.collectTaskItems(tasksPayload, config);
        taskItems.push(...collected.items);
        counts.skipped += collected.skipped;
        warnings.push(...collected.errors);
      }
    }

    if (config.includeNotices) {
      try {
        const noticesPayload = await client.fetchNotices();
        const collected = normalize.collectNoticeItems(noticesPayload, config);
        noticeItems.push(...collected.items);
        counts.skipped += collected.skipped;
        warnings.push(...collected.errors);
      } catch (error) {
        // 公告失败不阻断任务同步。
        warnings.push(`公告拉取失败：${error && error.message ? error.message : error}`);
      }
    }

    counts.todos = taskItems.length;
    counts.notices = noticeItems.length;

    // §5.4 冲突规则：本地完成态优先，跳过状态字段（其余字段照常更新）。
    let existing = [];
    try {
      existing = (await ctx.schedule.listSource(SOURCE)) || [];
    } catch (error) {
      warnings.push(`读取已有同步条目失败：${error && error.message ? error.message : error}`);
    }
    const existingById = new Map();
    for (const record of existing) {
      if (record && record.externalId) existingById.set(record.externalId, record);
    }

    const finalItems = [];
    let guardedSkipped = 0;
    for (const item of [...taskItems, ...noticeItems]) {
      const record = existingById.get(item.externalId);
      const localStatus = record ? (record.todoStatus ?? record.status ?? null) : null;
      const guarded = normalize.applyLocalStatusPriority(item, localStatus);
      if (guarded.skipped) {
        guardedSkipped += 1;
        logInfo(`本地完成态优先：跳过 ${item.externalId} 的状态字段`);
      }
      finalItems.push(guarded.item);
    }

    // counts.skipped 的状态冲突部分以宿主 upsertExternalItems 回报的 skipped 为权威
    // （宿主持有本地 todoStatus 真值）；宿主 API 未回报时回退插件侧计数，避免漏记/重记。
    const hostSkipped = await upsertBatched(finalItems);
    counts.skipped += hostSkipped ?? guardedSkipped;

    // pruneMissing（默认关）：远端消失的自有条目从映射表删除。
    if (config.pruneMissing) {
      const currentIds = new Set([...taskItems, ...noticeItems].map((item) => item.externalId));
      const staleIds = existing.map((record) => record && record.externalId).filter((id) => id && !currentIds.has(id));
      if (staleIds.length > 0) {
        await ctx.schedule.removeItems(SOURCE, staleIds);
        logInfo(`pruneMissing：清理远端已消失条目 ${staleIds.length} 条`);
      }
    }

    // 写缓存快照（scrub 后不含任何凭据）。
    await cacheApi.saveCache(ctx.files, {
      tasks: taskItems,
      notices: noticeItems,
      counts,
      source: mode,
    });

    const warningText = warnings.length > 0 ? warnings.slice(0, 3).join('；') : null;
    publishStatus({
      state: 'ok',
      lastSuccessAt: nowIso(),
      lastError: warningText,
      counts,
      serviceReachable: true,
      nextSyncAt: status.nextSyncAt,
    });
    logInfo(`同步完成：待办 ${counts.todos} 条、公告 ${counts.notices} 条、跳过 ${counts.skipped} 条`);
    if (warningText) logWarn(`同步完成但有警告：${warningText}`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const code = error && error.code;
    const reachable = code === 'unreachable' || code === 'timeout' ? false : null;
    // 缓存降级：不删条目、不写库；错误文案面向用户且可操作（lib/client.js 分类）。
    publishStatus({ state: 'error', lastError: message, serviceReachable: reachable });
    logError(`同步失败：${message}`);
  } finally {
    syncing = false;
    if (pendingTrigger) {
      const next = pendingTrigger;
      pendingTrigger = null;
      setImmediate(() => {
        requestSync(next);
      });
    }
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────────

module.exports = {
  activate(context) {
    ctx = context;
    config = { ...DEFAULTS };

    logInfo(`activating ${context.manifest.id}（默认配置已载入，等待 host:notice-hub:config）`);

    // 读缓存（失败静默，不影响激活）。
    cacheApi.loadCache(context.files).then((doc) => {
      if (doc) logInfo(`已载入缓存快照：${doc.savedAt}`);
    }).catch(() => {});

    // 注册 UI 命令（契约 §4.5）。
    context.ui.registerCommand({
      id: 'notice-hub:sync-now',
      title: '同步群务台',
      panel: 'sidebar',
      execute: () => {
        // 失败不抛异常，状态进 NoticeHubStatus。
        requestSync('manual');
      },
    });

    context.ui.registerCommand({
      id: 'notice-hub:reset-cache',
      title: '重置群务台缓存',
      panel: 'sidebar',
      execute: async () => {
        try {
          await cacheApi.clearCache(context.files);
          logInfo('缓存已清空，开始全量重同步。');
        } catch (error) {
          logWarn(`清空缓存失败：${error && error.message ? error.message : error}`);
        }
        requestSync('reset');
      },
    });

    // 事件订阅（契约 §4.4）。
    unsubscribers.push(context.events.on(EVENT_CONFIG, (payload) => {
      applyConfig(payload);
    }));
    unsubscribers.push(context.events.on(EVENT_SYNC_NOW, () => {
      requestSync('manual');
    }));

    // 按 syncIntervalMinutes 起定时器（当前为默认配置，config 事件到达后重启）。
    restartTimer();
    publishStatus({ state: config.enabled ? 'idle' : 'disabled', nextSyncAt: status.nextSyncAt });
  },

  deactivate() {
    clearTimer();
    while (unsubscribers.length > 0) {
      const off = unsubscribers.pop();
      try {
        if (typeof off === 'function') off();
      } catch {
        // 忽略退订异常
      }
    }
    pendingTrigger = null;
    ctx = null;
  },
};
