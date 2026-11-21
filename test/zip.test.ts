import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { readZip, MAX_ENTRY_BYTES } from "../src/zip.ts";

/** A one-entry zip. `claimedSize` lets a test lie about the unpacked size. */
function zipOf(name: string, data: Buffer, opts: { claimedSize?: number } = {}): Buffer {
  const comp = deflateRawSync(data);
  const n = Buffer.from(name, "utf8");
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(8, 8);
  lfh.writeUInt32LE(comp.length, 18);
  lfh.writeUInt32LE(opts.claimedSize ?? data.length, 22);
  lfh.writeUInt16LE(n.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(comp.length, 20);
  cd.writeUInt32LE(opts.claimedSize ?? data.length, 24);
  cd.writeUInt16LE(n.length, 28);
  cd.writeUInt32LE(0, 42);
  const body = Buffer.concat([lfh, n, comp]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + n.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cd, n, eocd]);
}

test("zip: normal entry round-trips", () => {
  const data = Buffer.from("hello dalf ".repeat(1000));
  const [e] = readZip(zipOf("a.dalf", data));
  assert.equal(e.name, "a.dalf");
  assert.deepEqual(e.read(), data);
});

test("zip: entry whose header claims more than the cap is refused", () => {
  const z = zipOf("big.dalf", Buffer.from("x"), { claimedSize: MAX_ENTRY_BYTES + 1 });
  assert.throws(() => readZip(z)[0].read(), /refusing to unpack/);
});

test("zip: zip bomb that lies about its size is stopped by the inflater cap", () => {
  // ~257 MiB of zeros compresses to ~250 KiB; the header claims 10 bytes.
  const bomb = zipOf("bomb.dalf", Buffer.alloc(MAX_ENTRY_BYTES + 1024 * 1024), { claimedSize: 10 });
  assert.ok(bomb.length < 2 * 1024 * 1024);
  assert.throws(() => readZip(bomb)[0].read(), /zip bomb/);
});

test("zip: truncated entry is refused instead of read short", () => {
  const z = zipOf("a.dalf", Buffer.from("hello ".repeat(500)));
  const cut = Buffer.concat([z.subarray(0, 40), z.subarray(z.length - 22 - 46 - 6)]);
  assert.throws(() => readZip(cut)[0]?.read());
});
