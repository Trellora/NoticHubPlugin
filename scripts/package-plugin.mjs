#!/usr/bin/env node
/**
 * package-notice-hub-plugin —— 打包 notice-hub 插件发布 zip（发布材料）。
 * Package the notice-hub plugin release zip (release artifact).
 *
 * 产物：dist/notice-hub-<version>.zip + 同名 .sha256 清单。
 * 确定性输出：条目按路径排序、固定时间戳（2026-01-01T00:00:00Z），
 * 同一输入在任何机器上得到相同 sha256，便于发布校验与复现。
 *
 * 包内容（白名单，契约 §6 插件包设计）：
 *   plugin.json、main.js、README.md、lib/**、
 *   LICENSE、LICENSE-UPSTREAM、NOTICE（上游逐字拷贝，必须随包分发）。
 * 不包含：.storage/（运行期缓存）、.DS_Store、__pycache__、*.pyc。
 *
 * 打包前执行合规门（失败即非零退出）：
 *   1. plugin.json 清单校验（复用 scripts/validate-plugin-manifest.mjs）；
 *   2. LICENSE / LICENSE-UPSTREAM / NOTICE 三份文件存在；
 *   3. README.md 含署名与许可提示关键词（MIT / PolyForm / 商用授权联系方式）。
 *
 * 用法：
 *   node scripts/package-plugin.mjs [--out <dir>]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..'); // 本仓库根目录（scripts/package-plugin.mjs）
const pluginDir = repoRoot; // 本仓库根目录即插件包

/** 固定条目时间戳（DOS 时间），保证可复现。 */
const FIXED_DATE = new Date('2026-01-01T00:00:00Z');

/** 必须随包分发的上游许可证/声明文件（契约 §7：不得修改、不得缺失）。 */
const REQUIRED_LEGAL_FILES = ['LICENSE', 'LICENSE-UPSTREAM', 'NOTICE'];

/** README 合规关键词：署名与许可说明缺一不可。 */
const README_COMPLIANCE_KEYWORDS = ['MIT', 'PolyForm', 'wc985732-lang', 'jkl2755908073@qq.com'];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

// ── CRC32（zip 规范所需） ────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Date → DOS date/time（本地语义按 UTC 固定值即可，保证确定性）。 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
  const dosDate = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { dosTime, dosDate };
}

// ── 极简确定性 ZIP 写入（仅 store / deflate，UTF-8 条目名） ───────────────
/**
 * @param {Array<{ name: string, data: Buffer }>} entries 条目（name 用 / 分隔，不含前导 /）
 * @returns {Buffer} zip 文件内容
 */
function buildZip(entries) {
  const { dosTime, dosDate } = dosDateTime(FIXED_DATE);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // 小文件或已压缩内容：deflate 无收益时回退 store，仍保持确定性。
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: regular file 644
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// ── 收集白名单条目 ──────────────────────────────────────────────────────
function collectEntries() {
  const entries = [];
  const pushFile = (relPath) => {
    const abs = path.join(pluginDir, relPath);
    if (!fs.existsSync(abs)) fail(`缺少必需文件：${relPath}`);
    entries.push({ name: relPath.split(path.sep).join('/'), data: fs.readFileSync(abs) });
  };

  // 顶层固定文件
  for (const name of ['plugin.json', 'main.js', 'README.md', ...REQUIRED_LEGAL_FILES]) pushFile(name);

  // lib/**（递归，过滤运行期与系统噪音）
  const libDir = path.join(pluginDir, 'lib');
  if (!fs.existsSync(libDir)) fail('缺少 lib/ 目录');
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, item.name);
      const rel = path.relative(pluginDir, abs);
      if (item.isDirectory()) {
        if (item.name === '__pycache__' || item.name === '.storage') continue;
        walk(abs);
      } else if (
        item.isFile() &&
        item.name !== '.DS_Store' &&
        !item.name.endsWith('.pyc') &&
        !item.name.endsWith('.map')
      ) {
        pushFile(rel);
      }
    }
  };
  walk(libDir);

  // 白名单外不得有可执行入口遗漏：确认 main.js 引用的 lib 文件都在包里
  const mainSource = fs.readFileSync(path.join(pluginDir, 'main.js'), 'utf8');
  for (const match of mainSource.matchAll(/require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)) {
    const rel = path.normalize(match[1]).replace(/^\.\//, '');
    if (!rel.endsWith('.js')) continue;
    const relWithExt = rel.endsWith('.js') ? rel : `${rel}.js`;
    if (!entries.some((e) => e.name === relWithExt)) fail(`main.js 引用的模块未入包：${relWithExt}`);
  }

  // 排序保证确定性
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  return entries;
}

// ── 合规门 ──────────────────────────────────────────────────────────────
function complianceGate() {
  // 1. 清单校验（复用仓库校验器）
  const validator = path.join(repoRoot, 'scripts', 'validate-plugin-manifest.mjs');
  try {
    const out = execFileSync(process.execPath, [validator, pluginDir], { encoding: 'utf8' });
    console.log(out.trim());
  } catch (error) {
    fail(`plugin.json 清单校验未通过：${error.stdout || error.message}`);
  }

  // 2. 许可证三件套存在（内容与上游逐字一致的比对由 verify-notice-hub-plugin.mjs 负责）
  for (const name of REQUIRED_LEGAL_FILES) {
    if (!fs.existsSync(path.join(pluginDir, name))) fail(`缺少许可证/声明文件：${name}`);
  }

  // 3. README 署名与许可提示
  const readme = fs.readFileSync(path.join(pluginDir, 'README.md'), 'utf8');
  for (const keyword of README_COMPLIANCE_KEYWORDS) {
    if (!readme.includes(keyword)) fail(`README.md 缺少合规关键词：${keyword}`);
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────
function main() {
  const outIdx = process.argv.indexOf('--out');
  const outDir = outIdx >= 0 ? path.resolve(process.argv[outIdx + 1]) : path.join(repoRoot, 'dist');

  if (!fs.existsSync(pluginDir)) fail(`插件目录不存在：${pluginDir}`);

  complianceGate();

  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'));
  const version = String(manifest.version ?? '0.0.0');
  const entries = collectEntries();
  const zipBuf = buildZip(entries);

  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, `notice-hub-${version}.zip`);
  fs.writeFileSync(zipPath, zipBuf);

  // sha256 清单
  const hash = createHash('sha256').update(zipBuf).digest('hex');
  fs.writeFileSync(`${zipPath}.sha256`, `${hash}  ${path.basename(zipPath)}\n`);

  console.log(`PACKAGED: ${zipPath}`);
  console.log(`  entries: ${entries.length}`);
  for (const e of entries) console.log(`    ${e.name} (${e.data.length} B)`);
  console.log(`  sha256: ${hash}`);
}

main();
