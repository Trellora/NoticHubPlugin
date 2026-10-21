/**
 * plugin.json manifest validator.
 * plugin.json 清单校验器。
 *
 * Usage: node scripts/validate-plugin-manifest.mjs <plugin-dir-or-plugin.json>
 * Exit 0 = valid; exit 1 = invalid (detailed errors printed).
 *
 * 用法：node scripts/validate-plugin-manifest.mjs <插件目录或 plugin.json 路径>
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(scriptDir, 'plugin.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

// ── Minimal JSON Schema (draft-07 subset) validator ──────────────────────────
// Covers: type, enum, pattern, required, additionalProperties, items,
// uniqueItems, properties, minLength, maxLength.

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validate(node, data, path, errors) {
  const t = typeOf(data);
  if (node.type) {
    const expected = Array.isArray(node.type) ? node.type : [node.type];
    if (!expected.includes(t)) {
      errors.push(`${path}: expected ${expected.join('|')}, got ${t}`);
      return;
    }
  }
  if (node.enum && !node.enum.includes(data)) {
    errors.push(`${path}: value ${JSON.stringify(data)} not in enum [${node.enum.join(', ')}]`);
  }
  if (typeof data === 'string') {
    if (node.pattern && !new RegExp(node.pattern, 'u').test(data)) {
      errors.push(`${path}: ${JSON.stringify(data)} does not match pattern ${node.pattern}`);
    }
    if (node.minLength !== undefined && data.length < node.minLength) {
      errors.push(`${path}: string shorter than minLength ${node.minLength}`);
    }
    if (node.maxLength !== undefined && data.length > node.maxLength) {
      errors.push(`${path}: string longer than maxLength ${node.maxLength}`);
    }
  }
  if (t === 'object') {
    if (node.required) {
      for (const key of node.required) {
        if (!(key in data)) errors.push(`${path}: missing required property "${key}"`);
      }
    }
    if (node.additionalProperties === false && node.properties) {
      for (const key of Object.keys(data)) {
        if (!(key in node.properties)) errors.push(`${path}: unknown property "${key}"`);
      }
    }
    if (node.properties) {
      for (const [key, sub] of Object.entries(node.properties)) {
        if (key in data) validate(sub, data[key], `${path}.${key}`, errors);
      }
    }
  }
  if (t === 'array') {
    if (node.uniqueItems) {
      const seen = new Set(data.map((v) => JSON.stringify(v)));
      if (seen.size !== data.length) errors.push(`${path}: array items must be unique`);
    }
    if (node.items) {
      data.forEach((item, i) => validate(node.items, item, `${path}[${i}]`, errors));
    }
  }
}

// ── Entry ────────────────────────────────────────────────────────────────────

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node scripts/validate-plugin-manifest.mjs <plugin-dir-or-plugin.json>');
  process.exit(2);
}

let manifestPath = resolve(arg);
try {
  if (statSync(manifestPath).isDirectory()) manifestPath = join(manifestPath, 'plugin.json');
} catch {
  console.error(`Not a directory or file: ${arg}`);
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  console.error(`Failed to read/parse ${manifestPath}: ${err.message}`);
  process.exit(1);
}

const errors = [];
validate(schema, manifest, '$', errors);

// Extra cross-field checks beyond the schema.
if (Array.isArray(manifest.permissions)) {
  const needsL2 = manifest.permissions.filter((p) => p.startsWith('system:'));
  if (needsL2.length > 0 && !manifest.permissions.includes('system:file') && !manifest.permissions.includes('system:network') && !manifest.permissions.includes('system:subprocess')) {
    errors.push('$.permissions: L2 system permissions must be explicitly declared');
  }
}

if (errors.length > 0) {
  console.error(`INVALID: ${manifestPath}`);
  for (const e of errors) console.error('  -', e);
  process.exit(1);
}

console.log(`VALID: ${manifestPath} (id=${manifest.id}, v=${manifest.version})`);
