import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../repair.mjs';
import { digest, browserValues } from '../lib/config.mjs';
const [appDir, fixture, qaRoot] = process.argv.slice(2);
if (!appDir || !fixture || !qaRoot) throw new Error('Expected app directory, native test fixture, and QA directory');
// Copy only the installed Electron runtime files, never user state.
for (const entry of fs.readdirSync(appDir, { withFileTypes: true })) {
  if (!entry.isFile() || /uninstall/i.test(entry.name)) continue;
  fs.copyFileSync(path.join(appDir, entry.name), path.join(fixture, entry.name));
}
const home = path.join(qaRoot, 'synthetic-home-' + Date.now());
fs.mkdirSync(path.join(home, 'profiles/ds-bot'), { recursive: true });
fs.mkdirSync(path.join(home, 'bot'), { recursive: true });
const configFile = path.join(home, 'profiles/ds-bot/cordis.patch.yml'), stateFile = path.join(home, 'bot/state.json');
fs.writeFileSync(configFile, '# synthetic profile\n- id: models\n  config:\n    model: preserved-model\n- id: platform\n  disabled: !!js process.platform !== "win32"\n');
const state = { bots: { a: { name: 'synthetic', computer: { level: 'off', apps: { demo: { decision: 'deny' } } } } }, computer: { enabled: false }, revision: 2, prefs: { later: 1 } };
fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
// Return the copied installation to the verified original loader before repair.
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'payload/manifest.json')));
const runtimeRelative = Object.keys(manifest.nativePatches)[0];
const loaderFile = path.join(fixture, 'resources/app.asar.unpacked', runtimeRelative);
fs.copyFileSync(path.join(ROOT, 'payload/native', runtimeRelative), loaderFile);
function run(action) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'repair.mjs'), action, '--app-dir', fixture, '--home', home],
    { encoding: 'utf8', timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.error?.message || result.stdout + result.stderr);
  const line = result.stdout.split(/\r?\n/).findLast(x => x.startsWith('DSBOT_RESULT:'));
  const meta = JSON.parse(line.slice(13));
  return JSON.parse(fs.readFileSync(meta.report));
}
const first = run('repair');
assert.equal(first.changedFiles, 3);
assert.equal(first.browser.probe.ok, true); assert.equal(first.computer.probe.ok, true);
assert.equal(JSON.parse(fs.readFileSync(stateFile)).computer.enabled, true);
assert.deepEqual(JSON.parse(fs.readFileSync(stateFile)).bots, state.bots);
const second = run('repair'); assert.equal(second.changedFiles, 0);
const later = JSON.parse(fs.readFileSync(stateFile)); later.prefs.later = 99; fs.writeFileSync(stateFile, JSON.stringify(later));
fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8').replace('model: preserved-model', 'model: later-model'));
const rolledBack = run('rollback');
assert.equal(browserValues(fs.readFileSync(configFile, 'utf8')).browserPlugin.present, false);
assert.match(fs.readFileSync(configFile, 'utf8'), /later-model/);
const restoredState = JSON.parse(fs.readFileSync(stateFile));
assert.equal(restoredState.computer.enabled, false); assert.equal(restoredState.prefs.later, 99);
assert.deepEqual(restoredState.bots, state.bots);
assert.equal(digest(fs.readFileSync(loaderFile)), manifest.nativePatches[runtimeRelative].original);
const summary = { firstRepairChanges: first.changedFiles, secondRepairChanges: second.changedFiles,
  nativeProbe: first.computer.probe, browserProbe: first.browser.probe, rollbackPreservedLaterSettings: true,
  botGrantsPreserved: true, rollbackResult: rolledBack.result, syntheticHome: home };
fs.writeFileSync(path.join(qaRoot, 'transaction-integration.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
