import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { digest, patchBrowser, restoreBrowser, browserValues, patchComputer, restoreComputer,
  nativePlan, safeTarget } from '../lib/config.mjs';
import { Asar } from '../lib/asar.mjs';
import { patchNativeRuntime, RUNTIME_PATH } from '../lib/native-patch.mjs';
const require = createRequire(import.meta.url), YAML = require('../vendor/yaml/dist/index.js');
const url = pathToFileURL('C:/Example User/驱动/playwright/index.mjs').href;

test('browser repair preserves unknown tags, other providers, comments, and other config fields', () => {
  const text = `# user settings\n- id: models\n  config:\n    model: custom-model\n    secret: $SECRET_REFERENCE\n- id: sample\n  disabled: !!js process.platform !== 'win32'\n- id: bot\n  name: ds-bot\n  config:\n    home: custom-home\n    mainName: My Bot\n`;
  const result = patchBrowser(text, url), parsed = YAML.parse(result.text);
  assert.match(result.text, /# user settings/); assert.match(result.text, /!!js/);
  assert.equal(parsed[0].config.model, 'custom-model');
  assert.equal(parsed[0].config.secret, '$SECRET_REFERENCE');
  assert.equal(parsed[2].config.home, 'custom-home'); assert.equal(parsed[2].config.mainName, 'My Bot');
  assert.equal(parsed[2].config.browserPlugin, 'refs'); assert.equal(parsed[2].config.playwrightUrl, url);
  assert.equal(patchBrowser(result.text, url).text, result.text);
});
test('browser repair handles no override and the last complete config replacement', () => {
  const empty = patchBrowser('[]\n', url); assert.equal(browserValues(empty.text).browserPlugin.value, 'refs');
  const text = '- id: bot\n  config:\n    old: discarded\n- id: bot\n  config:\n    browserPlugin: task\n    custom: retained\n';
  const result = patchBrowser(text, url), rows = YAML.parse(result.text);
  assert.equal(rows[0].config.old, 'discarded'); assert.equal(rows[1].config.custom, 'retained');
  assert.equal(rows[1].config.browserPlugin, 'task'); assert.equal(rows[1].config.playwrightUrl, url);
});
test('browser rollback retains unrelated later edits and refuses conflicting browser edits', () => {
  const before = '- id: bot\n  config:\n    mainName: Chief\n- id: web\n  config:\n    searchProvider: old\n';
  const fixed = patchBrowser(before, url);
  const after = fixed.text.replace('searchProvider: old', 'searchProvider: newer');
  const restored = restoreBrowser(after, fixed.before, fixed.after), parsed = YAML.parse(restored);
  assert.equal(parsed[1].config.searchProvider, 'newer'); assert.equal(parsed[0].config.mainName, 'Chief');
  assert.equal(browserValues(restored).browserPlugin.present, false);
  assert.throws(() => restoreBrowser(fixed.text.replace('browserPlugin: refs', 'browserPlugin: script'), fixed.before, fixed.after), /拒绝覆盖/);
});
test('unrecognized YAML, custom plugin APIs, disabled plugins, and ID conflicts are refused', () => {
  for (const text of ['x: y', '- id: bot\n  name: other', '- id: bot\n  disabled: true',
    '- id: bot\n  config: !!js custom()', '- id: bot\n  config:\n    browserPlugin: unknown',
    '- id: bot\n  config:\n    browserPluginApi: injected']) assert.throws(() => patchBrowser(text, url));
});
test('computer repair and rollback preserve all Bot levels, app grants, messages, and later settings', () => {
  const original = { bots: { a: { computer: { level: 'off', apps: { app: { decision: 'deny' } } } } },
    computer: { enabled: false, custom: 'keep' }, revision: 7, rooms: { saved: true }, preferences: { x: 1 } };
  const result = patchComputer(JSON.stringify(original), true), fixed = JSON.parse(result.text);
  assert.deepEqual(fixed.bots, original.bots); assert.deepEqual(fixed.rooms, original.rooms);
  assert.equal(fixed.computer.custom, 'keep'); assert.equal(fixed.computer.enabled, true);
  assert.equal(patchComputer(result.text, true).changed, false);
  fixed.preferences.x = 2;
  const restored = JSON.parse(restoreComputer(JSON.stringify(fixed), result.before));
  assert.equal(restored.preferences.x, 2); assert.deepEqual(restored.bots, original.bots);
  assert.equal(restored.computer.enabled, false); assert.equal(restored.computer.custom, 'keep');
  const absent = patchComputer('{"bots":{}}', true);
  assert.equal(Object.hasOwn(JSON.parse(restoreComputer(absent.text, absent.before)), 'computer'), false);
});
test('native loader patch is limited to known source and idempotent', () => {
  const source = 'import { resolveLibPath } from "@ubjs/node/typescript/dist/resolve-lib.js";\nconst sdkLibrary = resolveLibPath({\n});\n';
  const patched = patchNativeRuntime(source);
  assert.match(patched, /existsSync\(unpackedPath\)/);
  assert.match(patched, /if \(!process\.versions\.electron\) return libraryPath/);
  assert.equal(patchNativeRuntime(patched), patched);
  assert.throws(() => patchNativeRuntime('new incompatible upstream source'), /拒绝/);
});
test('native recovery requires the application recorded hash and refuses unknown source edits', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsbot-repair-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = path.join(root, 'payload', 'native'), asarFile = path.join(root, 'app.asar');
  const relative = 'node_modules/@trycua/cua-driver-win32-x64-msvc/cua_driver_sdk.dll';
  const source = Buffer.from('fixture native'), sha = digest(source);
  fs.mkdirSync(path.dirname(path.join(payload, relative)), { recursive: true }); fs.writeFileSync(path.join(payload, relative), source);
  const archive = { filename: asarFile, *files() { yield { path: relative, unpacked: true, size: source.length, integrity: { algorithm: 'SHA256', hash: sha } }; } };
  const manifest = { nativeFiles: { [relative]: sha } };
  assert.equal(nativePlan(archive, payload, manifest).actions.length, 1);
  const target = path.join(asarFile + '.unpacked', relative);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, source);
  assert.equal(nativePlan(archive, payload, manifest).actions.length, 0);
  fs.writeFileSync(target, 'corrupt binary'); assert.equal(nativePlan(archive, payload, manifest).actions.length, 1);
  manifest.nativeFiles[relative] = 'wrong version'; assert.equal(nativePlan(archive, payload, manifest).problems.length, 1);
  fs.writeFileSync(path.join(payload, relative), 'tampered payload'); manifest.nativeFiles[relative] = sha;
  assert.equal(nativePlan(archive, payload, manifest).problems.length, 1);
});
test('bundled native runtime patch maps exactly to the original package hash', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsbot-repair-patch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const toolRoot = path.resolve(import.meta.dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(toolRoot, 'payload/manifest.json')));
  const metadata = manifest.nativePatches[RUNTIME_PATH];
  const source = fs.readFileSync(path.join(toolRoot, 'payload/native', RUNTIME_PATH));
  assert.equal(digest(source), metadata.original);
  const patched = fs.readFileSync(path.join(toolRoot, 'payload', metadata.file));
  assert.equal(digest(patched), metadata.patched);
  assert.equal(patchNativeRuntime(source.toString()), patched.toString());
  const archive = { filename: path.join(root, 'app.asar'), *files() { yield { path: RUNTIME_PATH, unpacked: true, size: source.length, integrity: { algorithm: 'SHA256', hash: metadata.original } }; } };
  const target = path.join(archive.filename + '.unpacked', RUNTIME_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, source);
  assert.equal(nativePlan(archive, path.join(toolRoot, 'payload/native'), manifest).actions.length, 1);
  fs.writeFileSync(target, patched);
  assert.equal(nativePlan(archive, path.join(toolRoot, 'payload/native'), manifest).actions.length, 0);
  fs.writeFileSync(target, 'local unknown patch');
  assert.match(nativePlan(archive, path.join(toolRoot, 'payload/native'), manifest).problems[0], /未知本地改动/);
});
test('path traversal and linked target paths are rejected', t => {
  assert.throws(() => safeTarget('C:/safe', '../outside'), /Unsafe/);
  assert.throws(() => safeTarget('C:/safe', 'C:/outside'), /Unsafe/);
});
test('ASAR byte reader supports Chinese text and rejects a malformed header', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsbot-asar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = Buffer.from('中文 payload'), header = Buffer.from(JSON.stringify({ files: { 'text.txt': { size: data.length, offset: '0' } } }));
  const prefix = Buffer.alloc(16); prefix.writeUInt32LE(header.length + 8, 4); prefix.writeUInt32LE(header.length, 12);
  const file = path.join(root, 'test.asar'); fs.writeFileSync(file, Buffer.concat([prefix, header, data]));
  assert.equal(new Asar(file).text('text.txt'), '中文 payload');
  fs.writeFileSync(file, 'bad'); assert.throws(() => new Asar(file), /truncated/);
});
