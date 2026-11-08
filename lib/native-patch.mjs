export const RUNTIME_PATH = 'node_modules/@trycua/cua-driver/dist/native/node-runtime.js';
const originalImport = 'import { resolveLibPath } from "@ubjs/node/typescript/dist/resolve-lib.js";';
const patchedImport = `import { existsSync } from "node:fs";
import { resolveLibPath as resolveOriginalLibPath } from "@ubjs/node/typescript/dist/resolve-lib.js";
// DS Bot local fix: native FFI loaders need a real path outside Electron ASAR.
function resolveLibPath(options) {
    const libraryPath = resolveOriginalLibPath(options);
    if (!process.versions.electron) return libraryPath;
    const unpackedPath = libraryPath.replace(/\\.asar([\\\\/])/u, ".asar.unpacked$1");
    return unpackedPath !== libraryPath && existsSync(unpackedPath)
        ? unpackedPath : libraryPath;
}`;
export function patchNativeRuntime(text) {
  if (text.includes(patchedImport)) return text;
  if (text.split(originalImport).length !== 2 || !text.includes('const sdkLibrary = resolveLibPath({')) throw new Error('电脑驱动加载器格式不匹配，拒绝套用补丁');
  return text.replace(originalImport, patchedImport);
}
export function unpatchNativeRuntime(text) { return text.replace(patchedImport, originalImport); }
