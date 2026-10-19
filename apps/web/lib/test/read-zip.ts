import { inflateRawSync } from 'node:zlib';
import { crc32 } from '@/lib/developer-skill/zip';

/** General purpose bit 11: the entry name is UTF-8. The writer always sets it. */
const UTF8_FLAG = 0x0800;

/**
 * Read a ZIP archive back for tests: walk the central directory (the way real
 * unzip tools do, rather than trusting local headers), then hold each local
 * header to its directory entry, field by field, because a tool that streams
 * the archive reads only the local headers. Inflate each entry and check its
 * CRC and size. Throws on anything malformed.
 */
export function readZip(archive: Uint8Array): Map<string, string> {
  const buf = Buffer.from(archive);
  const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('no end of central directory record');
  const count = buf.readUInt16LE(endAt + 10);
  const dirSize = buf.readUInt32LE(endAt + 12);
  const dirOffset = buf.readUInt32LE(endAt + 16);
  if (dirOffset + dirSize !== endAt) throw new Error('central directory does not end where the end record starts');

  const files = new Map<string, string>();
  let at = dirOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad central header at ${at}`);
    const central = {
      version: buf.readUInt16LE(at + 6),
      flags: buf.readUInt16LE(at + 8),
      method: buf.readUInt16LE(at + 10),
      time: buf.readUInt16LE(at + 12),
      date: buf.readUInt16LE(at + 14),
      crc: buf.readUInt32LE(at + 16),
      compressed: buf.readUInt32LE(at + 20),
      size: buf.readUInt32LE(at + 24),
    };
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const nameBytes = buf.subarray(at + 46, at + 46 + nameLen);
    const name = nameBytes.toString('utf8');
    if (!(central.flags & UTF8_FLAG)) throw new Error(`no UTF-8 flag on ${name}`);

    if (buf.readUInt32LE(localAt) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const local = {
      version: buf.readUInt16LE(localAt + 4),
      flags: buf.readUInt16LE(localAt + 6),
      method: buf.readUInt16LE(localAt + 8),
      time: buf.readUInt16LE(localAt + 10),
      date: buf.readUInt16LE(localAt + 12),
      crc: buf.readUInt32LE(localAt + 14),
      compressed: buf.readUInt32LE(localAt + 18),
      size: buf.readUInt32LE(localAt + 22),
    };
    for (const field of Object.keys(central) as Array<keyof typeof central>) {
      if (local[field] !== central[field]) {
        throw new Error(`local ${field} ${local[field]} differs from the directory's ${central[field]} for ${name}`);
      }
    }
    const localNameLen = buf.readUInt16LE(localAt + 26);
    const localExtraLen = buf.readUInt16LE(localAt + 28);
    if (!buf.subarray(localAt + 30, localAt + 30 + localNameLen).equals(nameBytes)) {
      throw new Error(`local name differs from the directory's for ${name}`);
    }

    const dataAt = localAt + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(dataAt, dataAt + central.compressed);
    const raw = central.method === 8 ? inflateRawSync(data) : central.method === 0 ? data : null;
    if (!raw) throw new Error(`unsupported method ${central.method} for ${name}`);
    if (raw.length !== central.size) throw new Error(`size mismatch for ${name}`);
    if (crc32(raw) !== central.crc) throw new Error(`crc mismatch for ${name}`);
    if (files.has(name)) throw new Error(`duplicate entry ${name}`);
    files.set(name, raw.toString('utf8'));

    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
