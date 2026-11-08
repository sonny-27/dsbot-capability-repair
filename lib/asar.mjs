import nodeFs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const fs = process.versions.electron ? createRequire(import.meta.url)('original-fs') : nodeFs;

// Read only: the repair tool never rewrites app.asar.
export class Asar {
  constructor(filename) {
    this.filename = path.resolve(filename);
    const fd = fs.openSync(this.filename, 'r');
    try {
      const lead = Buffer.alloc(16);
      if (fs.readSync(fd, lead, 0, 16, 0) !== 16) throw new Error('ASAR header truncated');
      const size = lead.readUInt32LE(4), length = lead.readUInt32LE(12);
      if (size < 8 || size > 64 * 1024 * 1024 || length > size - 8) throw new Error('Invalid ASAR header');
      const header = Buffer.alloc(length);
      if (fs.readSync(fd, header, 0, length, 16) !== length) throw new Error('ASAR header truncated');
      this.header = JSON.parse(header.toString('utf8'));
      this.dataOffset = 8 + size;
    } finally { fs.closeSync(fd); }
  }
  entry(name) {
    const parts = name.split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || p.includes('\\'))) throw new Error('Unsafe ASAR path');
    let entry = this.header;
    for (const part of parts) entry = entry?.files?.[part];
    if (entry?.link) throw new Error('ASAR links are unsupported');
    return entry;
  }
  read(name) {
    const entry = this.entry(name);
    if (!entry || entry.files) throw new Error(`安装包缺少 ${name}`);
    if (entry.unpacked) return fs.readFileSync(path.join(this.filename + '.unpacked', ...name.split('/')));
    const offset = Number(entry.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(entry.size)) throw new Error('Invalid ASAR entry');
    const fd = fs.openSync(this.filename, 'r');
    try {
      const data = Buffer.alloc(entry.size);
      if (fs.readSync(fd, data, 0, data.length, this.dataOffset + offset) !== data.length) throw new Error('ASAR entry truncated');
      return data;
    } finally { fs.closeSync(fd); }
  }
  text(name) { return this.read(name).toString('utf8'); }
  json(name) { return JSON.parse(this.text(name)); }
  *files(node = this.header, prefix = '') {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (entry.files) yield* this.files(entry, p);
      else yield { path: p, ...entry };
    }
  }
}
