/**
 * lib/cache.js —— storageDir/notice-hub-cache.json 快照缓存（经 context.files API）。
 *
 * 契约：docs/notice-hub-插件化与日程适配方案.md §6（lib/cache.js）与 §7（安全）：
 *   - 只经 `context.files`（权限 system:file）读写，路径限定插件 storageDir；
 *   - **缓存严禁出现 token**：写入前 scrub 一切疑似凭据键，写入后可再校验。
 */

'use strict';

const CACHE_FILE = 'notice-hub-cache.json';
const CACHE_VERSION = 1;

const SECRET_KEY_RE = /token|secret|password|authorization|api[-_]?key/i;

/** 递归剔除疑似凭据键（token/secret/password/…），返回新对象。 */
function scrubSecrets(value) {
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key)) continue;
      out[key] = scrubSecrets(item);
    }
    return out;
  }
  return value;
}

/** 构造缓存文档（只存数据快照，不含任何配置凭据）。 */
function buildCacheDocument({ tasks = [], notices = [], counts = {}, source = 'api' } = {}) {
  return scrubSecrets({
    version: CACHE_VERSION,
    savedAt: new Date().toISOString(),
    source,
    counts,
    tasks,
    notices,
    externalIds: [...tasks, ...notices].map((item) => item && item.externalId).filter(Boolean),
  });
}

/**
 * 读取缓存。文件缺失/损坏/版本不符 → null（不抛错）。
 * @param {{ readFile: (p: string) => Promise<Uint8Array> }} files context.files
 */
async function loadCache(files) {
  try {
    const bytes = await files.readFile(CACHE_FILE);
    const text = new TextDecoder().decode(bytes);
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== 'object' || doc.version !== CACHE_VERSION) return null;
    return scrubSecrets(doc);
  } catch {
    return null;
  }
}

/** 扫描对象键名（不看值），返回疑似凭据键路径列表（供校验脚本断言缓存无凭据）。 */
function findSecretKeys(value, prefix = '') {
  const hits = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => hits.push(...findSecretKeys(item, `${prefix}[${i}]`)));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (SECRET_KEY_RE.test(key)) hits.push(path);
      else hits.push(...findSecretKeys(item, path));
    }
  }
  return hits;
}

/**
 * 写入缓存（写入前 scrub 凭据，写入前再按**键名**终检一次）。
 * @param {{ writeFile: (p: string, data: Uint8Array) => Promise<void> }} files context.files
 */
async function saveCache(files, payload) {
  const doc = buildCacheDocument(payload);
  const hits = findSecretKeys(doc);
  if (hits.length > 0) {
    throw new Error(`缓存内容疑似包含凭据字段（${hits.join(', ')}），已拒绝写入。`);
  }
  await files.writeFile(CACHE_FILE, new TextEncoder().encode(JSON.stringify(doc, null, 2)));
  return doc;
}

/**
 * 清空缓存（files API 无删除接口，写入空快照即视为清空）。
 * @param {{ writeFile: (p: string, data: Uint8Array) => Promise<void> }} files context.files
 */
async function clearCache(files) {
  const doc = {
    version: CACHE_VERSION,
    savedAt: new Date().toISOString(),
    source: 'cleared',
    counts: {},
    tasks: [],
    notices: [],
    externalIds: [],
  };
  await files.writeFile(CACHE_FILE, new TextEncoder().encode(JSON.stringify(doc, null, 2)));
  return doc;
}

module.exports = { CACHE_FILE, CACHE_VERSION, scrubSecrets, findSecretKeys, buildCacheDocument, loadCache, saveCache, clearCache };
