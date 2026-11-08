import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Asar } from '../lib/asar.mjs';
import { nativePlan, safeTarget } from '../lib/config.mjs';
import { ROOT } from '../repair.mjs';
const [appDir, outputRoot] = process.argv.slice(2);
if (!appDir || !outputRoot) throw new Error('Usage: node tests/native-integration.mjs <installed-app> <qa-output-root>');
const fixture = safeTarget(outputRoot, 'native-fixture-' + Date.now());
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'payload/manifest.json')));
const installed = new Asar(path.join(appDir, 'resources/app.asar'));
assert.equal(installed.json('package.json').version, '0.3.1');
fs.mkdirSync(path.join(fixture, 'resources'), { recursive: true });
const copiedAsar = path.join(fixture, 'resources/app.asar');
fs.copyFileSync(installed.filename, copiedAsar);
for (const relative of Object.keys(manifest.nativeFiles)) {
  const target = safeTarget(copiedAsar + '.unpacked', relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(safeTarget(path.join(ROOT, 'payload/native'), relative), target);
}
function probe() {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_OPTIONS;
  const result = spawnSync(path.join(appDir, 'DS Bot.exe'), [path.join(ROOT, 'repair.mjs'), '_probe-computer', '--app-dir', fixture],
    { env, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  const line = result.stdout?.split(/\r?\n/).findLast(x => x.startsWith('DSBOT_PROBE:'));
  if (!line) throw new Error(result.error?.message || result.stderr || 'No probe result');
  return JSON.parse(line.slice(12));
}
const before = probe();
assert.equal(before.ok, false, 'Pristine loader should reproduce the ASAR native-path failure');
const archive = new Asar(copiedAsar), plan = nativePlan(archive, path.join(ROOT, 'payload/native'), manifest);
assert.equal(plan.problems.length, 0); assert.equal(plan.actions.length, 1);
for (const action of plan.actions) fs.copyFileSync(action.source, action.target);
const after = probe();
assert.equal(after.ok, true); assert.equal(after.listApps, 'ok'); assert.ok(after.toolCount > 0);
assert.equal(nativePlan(archive, path.join(ROOT, 'payload/native'), manifest).actions.length, 0);
const report = { pristine: before, repaired: after, plannedChanges: plan.actions.length, idempotent: true, fixture };
fs.writeFileSync(path.join(outputRoot, 'native-integration.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
