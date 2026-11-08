import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { Asar } from './lib/asar.mjs';
import { digest, exists, safeTarget, atomicWrite, browserValues, patchBrowser, restoreBrowser,
  patchComputer, restoreComputer, nativePlan } from './lib/config.mjs';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = value => console.log(value);
function options(argv) {
  const result = { action: argv[0] ?? 'detect' };
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`无法识别参数 ${key}`);
    result[key.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return result;
}
function locations(opts) {
  const appDir = path.resolve(opts['app-dir'] || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DS Bot'));
  const home = path.resolve(opts.home || path.join(os.homedir(), '.ds-bot'));
  return { appDir, home, exe: path.join(appDir, 'DS Bot.exe'),
    asar: path.join(appDir, 'resources', 'app.asar'),
    profile: safeTarget(home, 'profiles/ds-bot/cordis.patch.yml'),
    state: safeTarget(home, 'bot/state.json'), managed: safeTarget(home, 'capability-repair') };
}
function verifyApp(loc) {
  if (!exists(loc.exe) || !exists(loc.asar)) throw new Error('所选目录不是 DS Bot 安装目录（找不到 DS Bot.exe / resources/app.asar）');
  const archive = new Asar(loc.asar), pkg = archive.json('package.json');
  if (pkg.productName !== 'DS Bot' || pkg.name !== 'dsbot') throw new Error('安装包身份不匹配');
  const browser = archive.text('node_modules/ds-bot/src/host/browser-plugins.js');
  const computer = archive.text('node_modules/ds-bot/src/host/computer/index.js');
  const driver = archive.json('node_modules/@trycua/cua-driver/package.json');
  return { archive, pkg, driver, supported: pkg.version === '0.3.1' && driver.version === '0.28.0'
    && browser.includes('rt.config.browserPlugin') && browser.includes("optionalString(rt.config, 'playwrightUrl')")
    && computer.includes('state.computer?.enabled === true') };
}
function powershell(script, env = {}) {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, ...env }, windowsHide: true, encoding: 'utf8', timeout: 25000, maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr.trim() || '进程管理失败');
  return result.stdout.trim();
}
export function appProcesses(loc) {
  if (process.platform !== 'win32') return [];
  const data = powershell(`$ErrorActionPreference='Stop'; $rows=@(Get-Process -Name 'DS Bot' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:DSBOT_REPAIR_EXE -and $_.Id -ne [int]$env:DSBOT_REPAIR_PID } | ForEach-Object { @{id=$_.Id} }); ConvertTo-Json -InputObject $rows -Compress`, { DSBOT_REPAIR_EXE: loc.exe, DSBOT_REPAIR_PID: String(process.pid) });
  return JSON.parse(data || '[]');
}
async function stopApp(loc, authorized) {
  if (!appProcesses(loc).length) return false;
  if (!authorized) throw new Error('DS Bot 正在运行。请退出托盘，或使用“修复并重启”按钮。');
  log('完整停止 DS Bot，正在执行的任务会停止……');
  powershell(`$ErrorActionPreference='Stop'; Get-Process -Name 'DS Bot' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:DSBOT_REPAIR_EXE -and $_.Id -ne [int]$env:DSBOT_REPAIR_PID } | Stop-Process -Force`, { DSBOT_REPAIR_EXE: loc.exe, DSBOT_REPAIR_PID: String(process.pid) });
  for (let i = 0; i < 20; i++) { if (!appProcesses(loc).length) return true; await sleep(500); }
  throw new Error('DS Bot 未完全停止，未修改配置');
}
function startApp(loc) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = spawn(loc.exe, [], { cwd: loc.appDir, env, detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', error => log('启动 DS Bot 失败：' + error.message)); child.unref();
}
function probe(loc, type, extra = []) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_OPTIONS;
  const result = spawnSync(loc.exe, [path.join(ROOT, 'repair.mjs'), '_probe-' + type, '--app-dir', loc.appDir, ...extra], {
    env, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  });
  const line = result.stdout?.split(/\r?\n/).findLast(x => x.startsWith('DSBOT_PROBE:'));
  if (!line) return { ok: false, error: result.error?.message || result.stderr?.slice(-700) || `检测进程退出 ${result.status}` };
  try { return JSON.parse(line.slice('DSBOT_PROBE:'.length)); }
  catch { return { ok: false, error: '检测进程返回无效结果' }; }
}
async function runProbe(opts, loc) {
  let driver;
  try {
    if (opts.action === '_probe-browser') {
      const url = opts.entry;
      if (!url || !url.startsWith('file:')) throw new Error('playwrightUrl 必须是本地 file:/// 地址');
      const module = await import(url), chromium = module.chromium ?? module.default?.chromium;
      if (typeof chromium?.connectOverCDP !== 'function') throw new Error('驱动没有 chromium.connectOverCDP');
      return { ok: true, chromium: typeof chromium, connectOverCDP: typeof chromium.connectOverCDP };
    }
    // Exercise the same SDK constructor and catalog call as DS Bot's provider.
    // No screenshots, clicks, input, or app names are collected.
    const archive = new Asar(loc.asar);
    const pkg = archive.json('node_modules/@trycua/cua-driver/package.json');
    const entry = pkg.exports?.['.']?.import ?? pkg.main;
    if (typeof entry !== 'string' || !entry.startsWith('./') || entry.includes('..')) throw new Error('电脑驱动入口不受支持');
    const resolved = path.join(loc.asar, 'node_modules', '@trycua', 'cua-driver', entry);
    const { CuaDriver } = await import(pathToFileURL(resolved).href);
    driver = CuaDriver.create(undefined);
    const catalog = JSON.parse(await driver.listToolsJson());
    if (!Array.isArray(catalog.tools) || !catalog.tools.some(t => t.name === 'list_apps')) throw new Error('电脑驱动工具目录无效');
    const listing = JSON.parse((await driver.callTool('list_apps', '{}')).rawJson);
    if (listing.isError) throw new Error('list_apps 返回错误');
    return { ok: true, toolCount: catalog.tools.length, listApps: 'ok' };
  } catch (error) { return { ok: false, error: String(error.message || error).slice(0, 1000), detail: error.stack?.slice(0, 2000) }; }
  finally { if (driver) { try { await driver.shutdown(); driver.uniffiDestroy(); } catch {} } }
}
function loadManifest() { return JSON.parse(fs.readFileSync(path.join(ROOT, 'payload', 'manifest.json'), 'utf8')); }
function verifyPayload(manifest) {
  for (const [relative, sha] of Object.entries(manifest.playwrightFiles)) {
    const file = safeTarget(path.join(ROOT, 'payload', 'playwright-core'), relative);
    if (!exists(file) || digest(fs.readFileSync(file)) !== sha) throw new Error('离线浏览器驱动校验失败：' + relative);
  }
}
function installBrowserDriver(loc, manifest) {
  verifyPayload(manifest);
  const root = safeTarget(loc.managed, 'drivers/playwright-core-' + manifest.playwrightVersion);
  for (const [relative, sha] of Object.entries(manifest.playwrightFiles)) {
    const target = safeTarget(root, relative);
    if (exists(target) && digest(fs.readFileSync(target)) === sha) continue;
    atomicWrite(target, fs.readFileSync(safeTarget(path.join(ROOT, 'payload', 'playwright-core'), relative)));
  }
  return pathToFileURL(path.join(root, 'index.mjs')).href;
}
export function inspect(loc, { runtime = true } = {}) {
  const { archive, pkg, driver, supported } = verifyApp(loc), manifest = loadManifest();
  const native = nativePlan(archive, path.join(ROOT, 'payload', 'native'), manifest);
  const report = { toolVersion: '1.0.0', time: new Date().toISOString(), appVersion: pkg.version,
    supported, appDir: loc.appDir, home: loc.home, browser: {}, computer: {}, needsRestart: false };
  if (exists(loc.profile)) {
    const values = browserValues(fs.readFileSync(loc.profile, 'utf8'));
    report.browser = { plugin: values.browserPlugin.value, driverUrl: values.playwrightUrl.value };
    report.browser.configured = ['refs', 'script', 'task'].includes(report.browser.plugin) && typeof report.browser.driverUrl === 'string';
    if (runtime && report.browser.configured) report.browser.probe = probe(loc, 'browser', ['--entry', report.browser.driverUrl]);
  } else report.browser.error = '找不到 DS Bot profile，请先启动 DS Bot 完成初始化，或选择正确数据目录';
  report.computer.nativeVersion = driver.version;
  report.computer.filesToRepair = native.actions.map(a => ({ file: a.relative, reason: a.reason ?? '恢复原生驱动文件' }));
  report.computer.fileProblems = native.problems;
  if (exists(loc.state)) {
    const state = JSON.parse(fs.readFileSync(loc.state, 'utf8'));
    report.computer.enabled = state.computer?.enabled === true;
    report.computer.bots = { total: Object.keys(state.bots ?? {}).length,
      off: Object.values(state.bots ?? {}).filter(b => b.computer?.level === 'off').length };
  } else report.computer.error = '找不到 Bot 状态，请先启动 DS Bot 完成初始化，或选择正确数据目录';
  if (runtime && native.actions.length === 0 && native.problems.length === 0) report.computer.probe = probe(loc, 'computer');
  report.processCount = appProcesses(loc).length;
  report.needsRestart = report.processCount > 0;
  return report;
}
function targetOf(loc, change) {
  if (change.kind === 'browser') return loc.profile;
  if (change.kind === 'computer') return loc.state;
  if (change.kind === 'native') return safeTarget(loc.asar + '.unpacked', change.relative);
  throw new Error('备份中包含未知目标');
}
function recordChange(loc, backupDir, transaction, change, data) {
  const target = targetOf(loc, change), old = exists(target) ? fs.readFileSync(target) : null;
  const item = { ...change, existed: old !== null, oldHash: old === null ? null : digest(old), newHash: digest(data), backup: `file-${transaction.changes.length}.bin` };
  if (old !== null) atomicWrite(safeTarget(backupDir, item.backup), old);
  transaction.changes.push(item);
  // Journal first: interruption during a write remains recoverable.
  atomicWrite(path.join(backupDir, 'transaction.json'), JSON.stringify(transaction, null, 2));
  atomicWrite(target, data);
}
async function waitStartup(loc) {
  // Processes existing proves only launch; the report does not claim Bot tool execution.
  for (let i = 0; i < 20; i++) { await sleep(500); if (appProcesses(loc).length) return true; }
  return false;
}
export async function repair(loc, opts) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('此离线版仅支持 Windows x64');
  const check = verifyApp(loc);
  if (!check.supported) throw new Error('此版本未经验证，工具只自动修复 DS Bot 0.3.1 / Cua Driver 0.28.0；未修改配置');
  const components = new Set(String(opts.components ?? 'browser,computer').split(','));
  if (![...components].length || [...components].some(c => !['browser', 'computer'].includes(c))) throw new Error('请选择 browser / computer');
  if (!exists(loc.profile) || !exists(loc.state)) throw new Error('DS Bot 数据尚未初始化，或数据目录选错');
  const manifest = loadManifest(), native = components.has('computer') ? nativePlan(check.archive, path.join(ROOT, 'payload', 'native'), manifest) : { actions: [], problems: [] };
  if (native.problems.length) throw new Error(native.problems.join('\n'));
  let driverUrl;
  if (components.has('browser')) {
    const current = browserValues(fs.readFileSync(loc.profile, 'utf8'));
    driverUrl = current.playwrightUrl.value;
    if (typeof driverUrl !== 'string' || !probe(loc, 'browser', ['--entry', driverUrl]).ok) {
      log('准备离线浏览器驱动（无需下载 Chromium）……');
      driverUrl = installBrowserDriver(loc, manifest);
      const tested = probe(loc, 'browser', ['--entry', driverUrl]);
      if (!tested.ok) throw new Error('离线浏览器驱动无法加载：' + tested.error);
    }
    patchBrowser(fs.readFileSync(loc.profile, 'utf8'), driverUrl); // validate before stopping the app
  }
  patchComputer(fs.readFileSync(loc.state, 'utf8'), true); // validate before stopping
  const stopped = await stopApp(loc, opts.restart === true);
  const backupDir = safeTarget(loc.managed, 'backups/' + stamp());
  fs.mkdirSync(backupDir, { recursive: true });
  const transaction = { format: 1, appVersion: check.pkg.version, appDir: loc.appDir, home: loc.home,
    created: new Date().toISOString(), phase: 'applying', changes: [] };
  atomicWrite(path.join(backupDir, 'transaction.json'), JSON.stringify(transaction, null, 2));
  try {
    if (components.has('browser')) {
      const previous = fs.readFileSync(loc.profile, 'utf8'), patched = patchBrowser(previous, driverUrl);
      if (patched.text !== previous) recordChange(loc, backupDir, transaction, { kind: 'browser', before: patched.before, after: patched.after }, Buffer.from(patched.text));
    }
    for (const item of native.actions) {
      log(item.reason ?? '恢复电脑驱动：' + item.relative);
      // Verify bytes again immediately before committing.
      const data = fs.readFileSync(item.source);
      if (digest(data) !== item.hash) throw new Error('电脑离线驱动文件发生变化');
      recordChange(loc, backupDir, transaction, { kind: 'native', relative: item.relative }, data);
    }
    if (components.has('computer')) {
      const previous = fs.readFileSync(loc.state, 'utf8'), patched = patchComputer(previous, true);
      if (patched.changed) recordChange(loc, backupDir, transaction, { kind: 'computer', before: patched.before }, Buffer.from(patched.text));
      const tested = probe(loc, 'computer');
      if (!tested.ok) throw new Error('电脑驱动实测失败：' + tested.error);
      log(`电脑驱动实测通过：${tested.toolCount} 个工具，list_apps 成功。`);
    }
    transaction.phase = 'committed';
    atomicWrite(path.join(backupDir, 'transaction.json'), JSON.stringify(transaction, null, 2));
  } catch (error) {
    log('修复失败，恢复本次写入前的内容……');
    for (const change of [...transaction.changes].reverse()) {
      const target = targetOf(loc, change);
      if (change.existed) atomicWrite(target, fs.readFileSync(safeTarget(backupDir, change.backup)));
      else if (exists(target) && digest(fs.readFileSync(target)) === change.newHash) fs.unlinkSync(target);
    }
    transaction.phase = 'failed-restored'; transaction.error = error.message;
    atomicWrite(path.join(backupDir, 'transaction.json'), JSON.stringify(transaction, null, 2));
    if (stopped && opts.restart) startApp(loc);
    throw error;
  }
  if (opts.restart) { log('重新启动 DS Bot……'); startApp(loc); if (!await waitStartup(loc)) throw new Error('配置已保存，但 DS Bot 未启动，请手动启动；备份位于 ' + backupDir); }
  const report = inspect(loc);
  report.backup = backupDir; report.changedFiles = transaction.changes.length;
  report.result = '配置和驱动检测完成；完整功能请按使用说明在 Bot 内验收';
  return report;
}
export function findBackup(loc) {
  const root = safeTarget(loc.managed, 'backups');
  if (!exists(root)) throw new Error('没有本工具创建的备份');
  for (const entry of fs.readdirSync(root).sort().reverse()) {
    const dir = safeTarget(root, entry), file = path.join(dir, 'transaction.json');
    if (!exists(file)) continue;
    const transaction = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (['committed', 'applying'].includes(transaction.phase) && transaction.changes.length) return { dir, transaction };
  }
  throw new Error('没有可以回滚的修复记录');
}
export async function rollback(loc, opts) {
  verifyApp(loc);
  const { dir, transaction } = findBackup(loc);
  if (path.resolve(transaction.appDir).toLowerCase() !== loc.appDir.toLowerCase() || path.resolve(transaction.home).toLowerCase() !== loc.home.toLowerCase()) throw new Error('备份所属安装目录或数据目录不匹配');
  // Preflight every key and hash, before writing anything or stopping a running app.
  function prepare() {
    return [...transaction.changes].reverse().map(change => {
      const target = targetOf(loc, change);
      if ((change.existed && exists(target) && digest(fs.readFileSync(target)) === change.oldHash) || (!change.existed && !exists(target))) return null;
      let data = null;
      if (change.kind === 'browser') data = Buffer.from(restoreBrowser(fs.readFileSync(target, 'utf8'), change.before, change.after));
      else if (change.kind === 'computer') data = Buffer.from(restoreComputer(fs.readFileSync(target, 'utf8'), change.before));
      else {
        if (!exists(target) || digest(fs.readFileSync(target)) !== change.newHash) throw new Error('驱动文件已被其他程序修改，拒绝覆盖：' + target);
        if (change.existed) {
          data = fs.readFileSync(safeTarget(dir, change.backup));
          if (digest(data) !== change.oldHash) throw new Error('原生文件备份校验失败');
        }
      }
      return { target, data };
    }).filter(Boolean);
  }
  prepare();
  const stopped = await stopApp(loc, opts.restart === true);
  try {
    const prepared = prepare();
    // Also retain the latest live files before a rollback, for recovery from IO errors.
    const rollbackDir = safeTarget(loc.managed, 'rollback-snapshots/' + stamp());
    fs.mkdirSync(rollbackDir, { recursive: true });
    const originals = prepared.map((p, i) => {
      const data = fs.readFileSync(p.target); atomicWrite(path.join(rollbackDir, i + '.bin'), data); return { ...p, original: data };
    });
    try { for (const p of prepared) { if (p.data !== null) atomicWrite(p.target, p.data); else fs.unlinkSync(p.target); } }
    catch (error) { for (const p of originals) atomicWrite(p.target, p.original); throw error; }
    transaction.phase = 'rolled-back'; transaction.rolledBack = new Date().toISOString();
    atomicWrite(path.join(dir, 'transaction.json'), JSON.stringify(transaction, null, 2));
  } finally { if ((stopped || opts.restart) && opts.restart) startApp(loc); }
  return { result: '已回滚最近一次修复的字段和驱动文件，其他设置与聊天保留', backup: dir, time: new Date().toISOString() };
}
function show(report) {
  if (report.appVersion) log(`DS Bot ${report.appVersion}，自动修复兼容：${report.supported ? '是' : '否'}`);
  if (report.browser) log(`浏览器：插件 ${report.browser.plugin ?? '未启用'}；驱动 ${report.browser.probe?.ok ? '加载成功' : report.browser.probe?.error ?? '未配置/未测试'}`);
  if (report.computer) {
    log(`电脑：总开关 ${report.computer.enabled ? '开' : '关'}；加载器/原生文件待修复 ${report.computer.filesToRepair.length} 项`);
    log(`电脑驱动：${report.computer.probe?.ok ? `实测通过，${report.computer.probe.toolCount} 个工具` : report.computer.probe?.error ?? '修复文件后再实测'}`);
    for (const problem of report.computer.fileProblems ?? []) log('需处理：' + problem);
    if (report.computer.bots?.off) log(`${report.computer.bots.off} 个 Bot 单独设为关闭；工具保留该选择。`);
  }
  if (report.result) log(report.result);
  if (report.backup) log('备份：' + report.backup);
}
export async function main(argv) {
  const opts = options(argv), loc = locations(opts);
  if (opts.action.startsWith('_probe-')) {
    const result = await runProbe(opts, loc); log('DSBOT_PROBE:' + JSON.stringify(result)); return result.ok ? 0 : 1;
  }
  let report;
  if (opts.action === 'detect') report = inspect(loc);
  else if (['repair', 'rollback'].includes(opts.action)) {
    const lock = safeTarget(loc.managed, 'operation.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    if (exists(lock)) {
      const previous = JSON.parse(fs.readFileSync(lock, 'utf8'));
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('另一个修复/回滚正在运行，请等待完成');
      fs.unlinkSync(lock);
    }
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }), { flag: 'wx' });
    try { report = opts.action === 'repair' ? await repair(loc, opts) : await rollback(loc, opts); }
    finally { fs.unlinkSync(lock); }
  } else throw new Error('操作必须是 detect、repair 或 rollback');
  show(report);
  const reportFile = opts.report || path.join(ROOT, 'reports', stamp() + '.json');
  atomicWrite(reportFile, JSON.stringify(report, null, 2) + '\n');
  log('报告：' + reportFile);
  log('DSBOT_RESULT:' + JSON.stringify({ ok: true, report: reportFile }));
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error('失败：' + (error.message || error));
    console.error('DSBOT_RESULT:' + JSON.stringify({ ok: false, error: String(error.message || error) })); process.exitCode = 1;
  });
}
