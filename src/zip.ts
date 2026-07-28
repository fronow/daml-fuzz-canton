// Minimal ZIP reader — enough to list and extract a DAR's entries (a DAR is
// a plain zip of .dalf files + META-INF). node:zlib inflates; no deps.
//
// Supports what DARs actually use: STORED (0) and DEFLATE (8) entries,
// read via the central directory (the only authoritative index).

import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  /** Extract this entry's bytes. */
  read(): Buffer;
}

const EOCD_SIG = 0x06054b50;
const CDFH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

export function readZip(buf: Buffer): ZipEntry[] {
  // EOCD is at the end, possibly preceded by a comment (≤ 64 KiB).
  let eocd = -1;
  const scanFrom = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= scanFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: end-of-central-directory not found");

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16); // central directory offset

  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== CDFH_SIG)
      throw new Error(`bad central directory entry at ${off}`);
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");

    entries.push({
      name,
      read: () => {
        if (buf.readUInt32LE(localOff) !== LFH_SIG)
          throw new Error(`bad local header for ${name}`);
        // Local name/extra lengths can differ from the central ones.
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const dataStart = localOff + 30 + lNameLen + lExtraLen;
        const raw = buf.subarray(dataStart, dataStart + compressedSize);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return inflateRawSync(raw);
        throw new Error(`${name}: unsupported compression method ${method}`);
      },
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
