// Minimal protobuf wire-format reader — enough to decode a Daml-LF archive
// without a generated stub or any dependency. Wire format only (varints,
// length-delimited, fixed 32/64); the LF *schema* (which field number means
// what) lives in lfdecode.ts.
//
// Reference: https://protobuf.dev/programming-guides/encoding/
//   wire 0 = varint      1 = 64-bit       2 = length-delimited      5 = 32-bit
// (wire 3/4 = deprecated groups; DALFs never use them.)

export type WireType = 0 | 1 | 2 | 5;

export interface Tag {
  field: number;
  wire: WireType;
}

/** A cursor over a protobuf message body. Sub-messages are read by handing a
 * subarray to a new reader (see `message()`), so positions never interleave. */
export class ProtoReader {
  private p = 0;
  private readonly buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }

  get done(): boolean {
    return this.p >= this.buf.length;
  }

  /** A base-128 varint as a BigInt (LF indices fit in 2^53, but the wire is
   * defined on up to 64 bits, so decode exactly then narrow deliberately). */
  varint(): bigint {
    let shift = 0n;
    let result = 0n;
    for (;;) {
      if (this.p >= this.buf.length) throw new Error("protobuf: varint runs past end");
      const byte = this.buf[this.p++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new Error("protobuf: varint too long");
    }
  }

  /** A varint that is known to index/count small — narrowed to a JS number. */
  uint(): number {
    return Number(this.varint());
  }

  bool(): boolean {
    return this.varint() !== 0n;
  }

  tag(): Tag {
    const key = this.uint();
    const wire = (key & 7) as WireType;
    const field = key >>> 3;
    if (field === 0) throw new Error("protobuf: field number 0 is illegal");
    return { field, wire };
  }

  /** A length-delimited chunk (wire 2): the raw bytes. */
  bytes(): Buffer {
    const len = this.uint();
    const end = this.p + len;
    if (end > this.buf.length) throw new Error("protobuf: length-delimited runs past end");
    const out = this.buf.subarray(this.p, end);
    this.p = end;
    return out;
  }

  string(): string {
    return this.bytes().toString("utf8");
  }

  /** A length-delimited chunk as its own reader (a nested message). */
  message(): ProtoReader {
    return new ProtoReader(this.bytes());
  }

  /** Advance past a field whose value we don't want, given its wire type. */
  skip(wire: WireType): void {
    switch (wire) {
      case 0:
        this.varint();
        return;
      case 1:
        this.p += 8;
        return;
      case 2: {
        // Read the length into a local FIRST: `this.p += this.uint()` would
        // read this.p before uint() advances it, discarding the advance.
        const len = this.uint();
        this.p += len;
        return;
      }
      case 5:
        this.p += 4;
        return;
      default:
        throw new Error(`protobuf: unskippable wire type ${wire}`);
    }
  }
}

/** Walk every top-level field of a message, calling `visit` with the tag and
 * the shared reader positioned at the value. The callback MUST consume the
 * value (read it or `skip`); `each` does not skip for you, so a decoder that
 * reads exactly the fields it knows and skips the rest cannot desync. */
export function each(reader: ProtoReader, visit: (tag: Tag, r: ProtoReader) => void): void {
  while (!reader.done) {
    const tag = reader.tag();
    visit(tag, reader);
  }
}

/** Collect one message's fields as field-number → array of raw values, each
 * value decoded only to the extent its wire type allows (varints as bigint,
 * length-delimited as Buffer). Handy for exploration and for fields whose
 * cardinality (single vs repeated) you want to inspect. */
export function collect(reader: ProtoReader): Map<number, Array<bigint | Buffer>> {
  const out = new Map<number, Array<bigint | Buffer>>();
  each(reader, (tag, r) => {
    // Only varints and length-delimited fields carry LF structure; fixed
    // 32/64 never appear in the messages we walk, so skip them.
    if (tag.wire === 0) {
      const arr = out.get(tag.field) ?? [];
      arr.push(r.varint());
      out.set(tag.field, arr);
    } else if (tag.wire === 2) {
      const arr = out.get(tag.field) ?? [];
      arr.push(r.bytes());
      out.set(tag.field, arr);
    } else {
      r.skip(tag.wire);
    }
  });
  return out;
}
