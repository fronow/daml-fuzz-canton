// Hermetic tests for the protobuf wire reader. All buffers are hand-encoded
// from the wire spec (protobuf.dev/programming-guides/encoding) so the test
// pins the decoder to the spec, not to any particular producer.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ProtoReader, each, collect } from "../src/protobuf.ts";

test("varint: single byte, multi-byte, and the canonical 300 = 0xAC 0x02", () => {
  assert.equal(new ProtoReader(Buffer.from([0x01])).varint(), 1n);
  assert.equal(new ProtoReader(Buffer.from([0x00])).varint(), 0n);
  assert.equal(new ProtoReader(Buffer.from([0xac, 0x02])).varint(), 300n);
  assert.equal(new ProtoReader(Buffer.from([0x96, 0x01])).varint(), 150n);
});

test("tag splits into field number and wire type", () => {
  // 0x0A = field 1, wire 2 ; 0x10 = field 2, wire 0 ; 0x40 = field 8, wire 0
  assert.deepEqual(new ProtoReader(Buffer.from([0x0a])).tag(), { field: 1, wire: 2 });
  assert.deepEqual(new ProtoReader(Buffer.from([0x10])).tag(), { field: 2, wire: 0 });
  assert.deepEqual(new ProtoReader(Buffer.from([0x40])).tag(), { field: 8, wire: 0 });
});

test("field number 0 is rejected as illegal", () => {
  assert.throws(() => new ProtoReader(Buffer.from([0x00])).tag(), /field number 0/);
});

test("length-delimited bytes and utf8 string", () => {
  // 0x02 length, then "hi"
  const r = new ProtoReader(Buffer.from([0x02, 0x68, 0x69]));
  assert.equal(r.string(), "hi");
});

test("each: walk a message; the visitor consumes or skips, never desyncs", () => {
  // field 1 (string "hi") = 0A 02 68 69 ; field 2 (varint 5) = 10 05 ;
  // field 3 (string "yo") = 1A 02 79 6F
  const buf = Buffer.from([0x0a, 0x02, 0x68, 0x69, 0x10, 0x05, 0x1a, 0x02, 0x79, 0x6f]);
  const seen: Array<[number, string | number]> = [];
  each(new ProtoReader(buf), (tag, r) => {
    if (tag.field === 2) seen.push([tag.field, Number(r.varint())]);
    else if (tag.wire === 2) seen.push([tag.field, r.string()]);
    else r.skip(tag.wire);
  });
  assert.deepEqual(seen, [
    [1, "hi"],
    [2, 5],
    [3, "yo"],
  ]);
});

test("skip advances past unwanted fields of every wire type", () => {
  // field 1 varint 5 (10 05) ; field 2 fixed64 (11 + 8 bytes) ;
  // field 3 bytes "ok" (1A 02 6F 6B) ; field 4 fixed32 (25 + 4 bytes)
  const buf = Buffer.from([
    0x08, 0x05,
    0x11, 1, 2, 3, 4, 5, 6, 7, 8,
    0x1a, 0x02, 0x6f, 0x6b,
    0x25, 9, 9, 9, 9,
  ]);
  let text: string | null = null;
  each(new ProtoReader(buf), (tag, r) => {
    if (tag.field === 3) text = r.string();
    else r.skip(tag.wire);
  });
  assert.equal(text, "ok");
});

test("collect groups repeated fields by number (varints as bigint, bytes as Buffer)", () => {
  // field 2 = "a", field 2 = "bb", field 5 = varint 7
  const buf = Buffer.from([0x12, 0x01, 0x61, 0x12, 0x02, 0x62, 0x62, 0x28, 0x07]);
  const m = collect(new ProtoReader(buf));
  const f2 = m.get(2) as Buffer[];
  assert.deepEqual(f2.map((b) => b.toString("utf8")), ["a", "bb"]);
  assert.deepEqual(m.get(5), [7n]);
});

test("message() reads a nested sub-message as its own reader", () => {
  // outer field 1 = sub-message { field 1 = varint 9 }
  const buf = Buffer.from([0x0a, 0x02, 0x08, 0x09]);
  const outer = new ProtoReader(buf);
  assert.deepEqual(outer.tag(), { field: 1, wire: 2 });
  const inner = outer.message();
  assert.deepEqual(inner.tag(), { field: 1, wire: 0 });
  assert.equal(inner.varint(), 9n);
  assert.ok(inner.done);
});

test("varint past end of buffer is an error, not silent truncation", () => {
  assert.throws(() => new ProtoReader(Buffer.from([0x80])).varint(), /past end/);
});
