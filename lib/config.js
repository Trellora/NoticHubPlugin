/**
 * lib/config.js —— notice-hub 插件配置：默认值、host 下发配置合并、字段校验。
 *
 * 契约：docs/notice-hub-插件化与日程适配方案.md §4.3（NoticeHubConfig）。
 * 纯函数 + 无副作用；不接触 token 之外的任何凭据，且永不输出 token。
 */

'use strict';

/** 默认配置（契约 §4.3）。 */
const DEFAULTS = Object.freeze({
  enabled: false, // 默认 false：装完先配置再启用
  baseUrl: 'http://127.0.0.1:8766', // 仅环回 http / 公共 https（由宿主 network.fetch 守卫）
  token: '', // QQ_DIGEST_WEB_TOKEN；可空（空 token 仅环回可用）
  syncIntervalMinutes: 15, // 5–240
  includeTodos: true,
  includeNotices: false, // 公告进日历易打扰，默认关
  pruneMissing: false, // 远端消失的条目默认不自动清理
  categoryName: '群务台',
  reminderOffsetsMinutes: [1440, 0], // 提前 1 天 + 到点
});

const INTERVAL_MIN = 5;
const INTERVAL_MAX = 240;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? Math.round(value) : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 归一化 baseUrl：去尾部斜杠；仅接受 http(s)。非法时返回 null。 */
function normalizeBaseUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null; // 禁止带凭据 URL
  return trimmed;
}

/**
 * 校验并归一化一份配置。
 * @param {unknown} raw 任意来源（默认值 + host:notice-hub:config 的部分覆盖）
 * @param {object} [base] 基准配置（默认取 DEFAULTS）
 * @returns {{ config: typeof DEFAULTS, warnings: string[] }} 无效字段回退基准值并给出中文警告
 */
function normalizeConfig(raw, base = DEFAULTS) {
  const warnings = [];
  const input = isPlainObject(raw) ? raw : {};
  const config = { ...DEFAULTS, ...base };

  if ('enabled' in input) config.enabled = toBool(input.enabled, config.enabled);

  if ('baseUrl' in input) {
    const url = normalizeBaseUrl(input.baseUrl);
    if (url) config.baseUrl = url;
    else warnings.push(`服务地址无效（${String(input.baseUrl)}），已保留原值 ${config.baseUrl}；地址须为 http(s):// 形式且不含账号密码。`);
  }

  if ('token' in input) {
    // token 允许为空字符串；只接受字符串。任何情况下不回显、不记录。
    config.token = typeof input.token === 'string' ? input.token : config.token;
    if (typeof input.token !== 'string') warnings.push('访问令牌必须是字符串，已保留原值。');
  }

  if ('syncIntervalMinutes' in input) {
    const rawInterval = input.syncIntervalMinutes;
    const n = typeof rawInterval === 'number' ? Math.round(rawInterval) : Number.parseInt(String(rawInterval ?? ''), 10);
    if (!Number.isFinite(n)) warnings.push(`同步间隔无效（${String(rawInterval)}），已使用默认值 ${config.syncIntervalMinutes} 分钟。`);
    else if (n < INTERVAL_MIN || n > INTERVAL_MAX) {
      warnings.push(`同步间隔 ${n} 分钟超出 ${INTERVAL_MIN}–${INTERVAL_MAX} 范围，已收敛到边界值。`);
    }
    config.syncIntervalMinutes = clampInt(rawInterval, INTERVAL_MIN, INTERVAL_MAX, config.syncIntervalMinutes);
  }

  if ('includeTodos' in input) config.includeTodos = toBool(input.includeTodos, config.includeTodos);
  if ('includeNotices' in input) config.includeNotices = toBool(input.includeNotices, config.includeNotices);
  if ('pruneMissing' in input) config.pruneMissing = toBool(input.pruneMissing, config.pruneMissing);

  if ('categoryName' in input) {
    const name = typeof input.categoryName === 'string' ? input.categoryName.trim() : '';
    if (name) config.categoryName = name.slice(0, 64);
    else warnings.push('分类名称不能为空，已保留原值。');
  }

  if ('reminderOffsetsMinutes' in input) {
    const list = input.reminderOffsetsMinutes;
    if (Array.isArray(list)) {
      const offsets = list
        .map((v) => (Number.isFinite(v) ? Math.round(v) : Number.parseInt(String(v ?? ''), 10)))
        .filter((v) => Number.isFinite(v))
        .slice(0, 8);
      if (offsets.length > 0) config.reminderOffsetsMinutes = offsets;
      else warnings.push('提醒提前量列表为空或无效，已保留原值。');
    } else {
      warnings.push('提醒提前量必须是分钟数数组，已保留原值。');
    }
  }

  return { config, warnings };
}

/**
 * 供日志/状态/缓存安全输出的配置摘要：**绝不包含 token**。
 * @param {typeof DEFAULTS} config
 */
function configSummary(config) {
  return {
    enabled: config.enabled,
    baseUrl: config.baseUrl,
    tokenSet: Boolean(config.token),
    syncIntervalMinutes: config.syncIntervalMinutes,
    includeTodos: config.includeTodos,
    includeNotices: config.includeNotices,
    pruneMissing: config.pruneMissing,
    categoryName: config.categoryName,
    reminderOffsetsMinutes: [...config.reminderOffsetsMinutes],
  };
}

module.exports = {
  DEFAULTS,
  INTERVAL_MIN,
  INTERVAL_MAX,
  normalizeBaseUrl,
  normalizeConfig,
  configSummary,
};
