import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Asar } from './lib/asar.mjs';
import { RUNTIME_PATH, patchNativeRuntime, unpatchNativeRuntime } from './lib/native-patch.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const [appDir, playwrightDir] = process.argv.slice(2);
if (!appDir || !playwrightDir) throw new Error('Usage: node build-payload.mjs <DS Bot directory> <playwright-core directory>');
const archive = new Asar(path.join(appDir, 'resources', 'app.asar'));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const manifest = { format: 1, sourceAppVersion: archive.json('package.json').version,
  playwrightVersion: JSON.parse(fs.readFileSync(path.join(playwrightDir, 'package.json'))).version,
  nativeFiles: {}, nativePatches: {}, playwrightFiles: {} };
for (const entry of archive.files()) {
  const yaml = entry.path.startsWith('node_modules/yaml/');
  const native = entry.unpacked && /^node_modules\/(?:@trycua\/cua-driver(?:-win32-x64-msvc)?\/|@ubjs\/(?:core|node)\/)/.test(entry.path);
  if (!yaml && !native) continue;
  const relative = yaml ? path.join('vendor', entry.path.slice('node_modules/'.length)) : path.join('payload', 'native', entry.path);
  const target = path.join(root, relative);
  let data = archive.read(entry.path);
  if (entry.path === RUNTIME_PATH && hash(data) !== entry.integrity?.hash) data = Buffer.from(unpatchNativeRuntime(data.toString()));
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data);
  if (native) {
    const sha = hash(data);
    if (entry.integrity?.hash && entry.integrity.hash !== sha) throw new Error('Installed native file hash mismatch: ' + entry.path);
    manifest.nativeFiles[entry.path] = sha;
    if (entry.path === RUNTIME_PATH) {
      const patched = Buffer.from(patchNativeRuntime(data.toString()));
      const patchedFile = path.join(root, 'payload', 'patches', 'node-runtime.js');
      fs.mkdirSync(path.dirname(patchedFile), { recursive: true }); fs.writeFileSync(patchedFile, patched);
      manifest.nativePatches[entry.path] = { original: sha, patched: hash(patched), file: 'patches/node-runtime.js' };
    }
  }
}
const destination = path.join(root, 'payload', 'playwright-core');
fs.cpSync(playwrightDir, destination, { recursive: true, dereference: false });
function walk(dir, prefix = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Payload contains link');
    if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
    else manifest.playwrightFiles[relative] = hash(fs.readFileSync(path.join(dir, entry.name)));
  }
}
walk(destination);
fs.writeFileSync(path.join(root, 'payload', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ appVersion: manifest.sourceAppVersion, playwright: manifest.playwrightVersion,
  nativeFiles: Object.keys(manifest.nativeFiles).length, playwrightFiles: Object.keys(manifest.playwrightFiles).length }));
