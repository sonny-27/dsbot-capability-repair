import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const YAML = require('../vendor/yaml/dist/index.js');
export const digest = data => crypto.createHash('sha256').update(data).digest('hex');
export const exists = p => fs.existsSync(p);
export function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export function safeTarget(root, relative) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(x => x === '..' || !x)) throw new Error('Unsafe relative path');
  const result = path.resolve(root, relative);
  if (!within(root, result)) throw new Error('Path escaped target root');
  // Reparse points could redirect a write outside the selected home/application.
  for (let current = result; within(root, current); current = path.dirname(current)) {
    if (exists(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`拒绝写入链接目录：${current}`);
    if (current === path.resolve(root)) break;
  }
  return result;
}
export function atomicWrite(filename, data) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const tmp = filename + `.repair-${process.pid}-${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, data, { flag: 'wx' }); fs.renameSync(tmp, filename); }
  finally { if (exists(tmp)) fs.unlinkSync(tmp); }
}
function parse(text) {
  const doc = YAML.parseDocument(text, { prettyErrors: true });
  if (doc.errors.length) throw new Error('配置 YAML 无效：' + doc.errors.map(x => x.message).join('; '));
  if (!YAML.isSeq(doc.contents)) throw new Error('cordis.patch.yml 必须是条目数组，停止修改');
  return doc;
}
function botRows(doc) {
  const rows = doc.contents.items.filter(x => YAML.isMap(x) && x.get('id') === 'bot' && !x.has('insert'));
  for (const row of rows) if (row.has('name') && row.get('name') !== 'ds-bot') throw new Error('bot ID 被其他插件占用，停止修改');
  if (rows.some(x => x.get('disabled') === true)) throw new Error('bot 插件被显式禁用，请先确认其用途');
  return rows;
}
function effectiveConfig(doc) {
  return botRows(doc).filter(x => x.has('config')).at(-1);
}
export function browserValues(text) {
  const doc = parse(text), row = effectiveConfig(doc);
  const node = row?.get('config', true);
  if (node && !YAML.isMap(node)) throw new Error('bot.config 不是普通映射，无法安全修改');
  return Object.fromEntries(['browserPlugin', 'playwrightUrl'].map(key => [key, {
    present: node?.has(key) ?? false, value: node?.get(key) ?? null,
  }]));
}
export function patchBrowser(text, driverUrl) {
  const doc = parse(text), before = browserValues(text);
  let row = effectiveConfig(doc);
  if (!row) {
    row = doc.createNode({ id: 'bot', name: 'ds-bot', config: {} });
    doc.contents.add(row);
  }
  let config = row.get('config', true);
  if (!YAML.isMap(config)) throw new Error('bot.config 不是普通映射');
  const plugin = config.get('browserPlugin');
  if (plugin != null && !['refs', 'script', 'task'].includes(plugin)) throw new Error(`未知 browserPlugin：${plugin}`);
  if (config.has('browserPluginApi')) throw new Error('存在自定义 browserPluginApi，请人工检查');
  config.set('browserPlugin', plugin ?? 'refs');
  config.set('playwrightUrl', driverUrl);
  const changed = before.browserPlugin.value !== config.get('browserPlugin') || before.playwrightUrl.value !== driverUrl;
  return { text: changed ? doc.toString({ lineWidth: 0 }) : text, before, after: browserValues(doc.toString()) };
}
export function restoreBrowser(text, before, after) {
  const current = browserValues(text);
  // Roll back only our two keys, never an entire profile that may have changed later.
  if (JSON.stringify(current) !== JSON.stringify(after)) throw new Error('浏览器配置在修复后又被修改，拒绝覆盖；请查看备份');
  const doc = parse(text), config = effectiveConfig(doc)?.get('config', true);
  if (!YAML.isMap(config)) throw new Error('找不到待回滚的浏览器配置');
  for (const [key, value] of Object.entries(before)) {
    if (value.present) config.set(key, value.value); else config.delete(key);
  }
  return doc.toString({ lineWidth: 0 });
}
export function patchComputer(text, enabled) {
  const state = JSON.parse(text);
  if (!state || Array.isArray(state) || typeof state !== 'object' || !state.bots || typeof state.bots !== 'object') throw new Error('state.json 格式不受支持');
  if (state.computer != null && (typeof state.computer !== 'object' || Array.isArray(state.computer))) throw new Error('computer 状态格式不受支持');
  const before = { present: Object.hasOwn(state.computer ?? {}, 'enabled'), value: state.computer?.enabled ?? null, parentPresent: Object.hasOwn(state, 'computer') };
  if (enabled === state.computer?.enabled) return { text, before, changed: false };
  state.computer ??= {};
  state.computer.enabled = enabled;
  if (Number.isSafeInteger(state.revision)) state.revision++;
  return { text: JSON.stringify(state, null, 2) + '\n', before, changed: true };
}
export function restoreComputer(text, before) {
  const state = JSON.parse(text);
  if (state.computer?.enabled !== true) throw new Error('电脑总开关在修复后又被修改，拒绝覆盖');
  if (before.present) state.computer.enabled = before.value;
  else delete state.computer.enabled;
  if (!before.parentPresent && Object.keys(state.computer).length === 0) delete state.computer;
  if (Number.isSafeInteger(state.revision)) state.revision++;
  return JSON.stringify(state, null, 2) + '\n';
}
export function nativePlan(archive, payloadRoot, manifest) {
  const actions = [], problems = [];
  for (const entry of archive.files()) {
    if (!entry.unpacked || !/^node_modules\/(?:@trycua\/cua-driver(?:-win32-x64-msvc)?\/|@ubjs\/(?:core|node)\/)/.test(entry.path)) continue;
    const target = safeTarget(archive.filename + '.unpacked', entry.path);
    const expected = entry.integrity?.algorithm === 'SHA256' ? entry.integrity.hash : null;
    const patch = manifest.nativePatches?.[entry.path];
    const currentHash = exists(target) ? digest(fs.readFileSync(target)) : null;
    if (patch && expected === patch.original) {
      if (currentHash === patch.patched) continue;
      if (currentHash !== null && currentHash !== expected) {
        problems.push(`电脑驱动加载器存在未知本地改动：${entry.path}`); continue;
      }
      const source = safeTarget(path.dirname(payloadRoot), patch.file);
      if (!exists(source) || digest(fs.readFileSync(source)) !== patch.patched) {
        problems.push('电脑路径补丁离线文件校验失败'); continue;
      }
      actions.push({ source, target, hash: patch.patched, relative: entry.path, reason: '修复 Electron ASAR 原生 DLL 路径' });
      continue;
    }
    if (currentHash && expected && currentHash === expected) continue;
    if (exists(target) && !expected && fs.statSync(target).size === entry.size) continue;
    const source = safeTarget(payloadRoot, entry.path);
    const payloadHash = manifest.nativeFiles?.[entry.path];
    if (!expected || !payloadHash || payloadHash !== expected || !exists(source) || digest(fs.readFileSync(source)) !== expected) {
      problems.push(`缺失或损坏且无匹配版本离线文件：${entry.path}`);
      continue;
    }
    actions.push({ source, target, hash: expected, relative: entry.path });
  }
  return { actions, problems };
}
