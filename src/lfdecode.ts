// Decode a DALF (a Daml-LF `DamlLf.Archive` protobuf) directly into a
// package's STRUCTURE — modules, templates, choices, and record data types
// with their field names — using only the wire reader in protobuf.ts. No
// `damlc inspect`, no text parsing, no dependency.
//
// WHY THIS EXISTS
//   The shipped path (introspect.ts → runDamlcInspect → lfparse.ts) shells out
//   to `damlc` and parses its pretty-printed text. This module removes that
//   dependency by reading the binary directly.
//
// HOW THE FIELD NUMBERS WERE OBTAINED
//   Not from memory: every constant below was reverse-engineered against real
//   LF 2.x DALFs and is pinned by test/lfdecode.test.ts, which decodes the
//   bundled m1-dsl.dalf and checks the result against the same fixture the
//   text parser is tested on. Observed envelope:
//     Archive         #3 payload (bytes)          #4 hash (string)
//     ArchivePayload  #3 minor version (string)   #4 Package
//     Package         #1 modules   #2 internedStrings   #3 internedDottedNames
//                     #5 internedTypes
//     Module          #2 featureFlags   #4 dataTypes   #6 templates
//                     (module name = dotted-name index, default 0)
//     DefDataType     #2 name(dotted idx)   #4 serializable(bool)   #5 record
//       Record        #1 repeated FieldWithType
//       FieldWithType #2 type(Type)   #3 name(string idx)
//     Template        #1 tycon(dotted idx)   #6 repeated TemplateChoice
//       TemplateChoice #2 name(string idx)   #3 consuming(bool)
//                      #6 argBinder   #8 retType
//     Type            #8 interned-type index (into Package internedTypes)
//
// STATUS
//   Structural decode (module/template/choice/record/field NAMES + consuming
//   flags) is complete and fixture-verified. TYPE resolution — turning a
//   field's interned Type index into a TypeDesc (Party/Int64/Numeric scale/
//   ContractId/List/Optional/record ref) — is the remaining step: it means
//   walking Package internedTypes (a builtin node is #3{#1=BuiltinType enum};
//   a con node resolves to a dotted name; Numeric carries a Nat arg). Because
//   a wrong type would silently corrupt the fuzzer's action space, that layer
//   is intentionally NOT guessed here, and this module does not yet replace
//   lfparse.ts. Each decoded field/choice keeps its raw type index so the
//   resolver can be added without re-decoding.

import { ProtoReader, each } from "./protobuf.ts";
import { readZip } from "./zip.ts";
import type { TypeDesc } from "./lfparse.ts";

// ---- verified field numbers ------------------------------------------------
const ARCHIVE_PAYLOAD = 3;
const PAYLOAD_PACKAGE = 4;
const PAYLOAD_MINOR = 3;
const PKG_MODULE = 1;
const PKG_INTERNED_STR = 2;
const PKG_INTERNED_DNAME = 3;
const PKG_INTERNED_TYPE = 5;
const MOD_NAME = 1; // dotted-name index; absent ⇒ 0
const MOD_DATATYPE = 4;
const MOD_TEMPLATE = 6;
const DT_NAME = 2; // dotted-name index
const DT_SERIALIZABLE = 4;
const DT_RECORD = 5;
const REC_FIELD = 1; // repeated FieldWithType
const FWT_TYPE = 2;
const FWT_NAME = 3; // string index
const TPL_TYCON = 1; // dotted-name index
const TPL_CHOICE = 6; // repeated
const CH_NAME = 2; // string index
const CH_CONSUMING = 3; // bool
const CH_RET_TYPE = 8;
const TYPE_INTERNED = 8; // Type.interned: index into Package internedTypes

// A resolved entry in the interned-types table is one of:
//   builtin/prim node : #3 { #1 = BuiltinType enum }
//   nat node          : #6 = zigzag(scale)         (only as a Numeric arg)
//   con node          : #2 { #1 = ModuleRef, #2 = name dotted idx }
//   app node          : #9 { #1 = fun (Type), #2 = arg (Type) }
const T_PRIM = 3;
const T_PRIM_ENUM = 1;
const T_NAT = 6;
const T_CON = 2;
const CON_TYCON = 1; // Type.con wraps a TypeConName at #1
const TYCON_MODREF = 1; // TypeConName.module (ModuleRef)
const TYCON_NAME = 2; // TypeConName.name (dotted idx)
const MODREF_NAME = 2; // ModuleRef.module_name (dotted idx); absent ⇒ 0
const T_APP = 9;
const APP_FUN = 1;
const APP_ARG = 2;

// BuiltinType enum. CONFIRMED against the m1-dsl fixture: BOOL=1, INT64=2,
// NUMERIC=5, PARTY=6, TEXT=7, CONTRACT_ID=8. UNIT/DATE/TIMESTAMP/OPTIONAL follow
// the standard LF2 ordering. Any enum NOT listed here resolves to `unsupported`
// — deliberately: a wrong guess would silently corrupt the fuzzer's action
// space, whereas `unsupported` is safely skipped by the generator. LIST/TEXTMAP/
// GENMAP are intentionally left unmapped until validated against a DAR that uses
// them (see LF-DECODER.md).
const BT_UNIT = 0;
const BT_BOOL = 1;
const BT_INT64 = 2;
const BT_DATE = 3;
const BT_TIMESTAMP = 4;
const BT_NUMERIC = 5;
const BT_PARTY = 6;
const BT_TEXT = 7;
const BT_CONTRACT_ID = 8;
const BT_OPTIONAL = 9;

/** The implicit lifecycle choice every template gets; the text parser (and
 * buildActionSpace) exclude it by default, so we do too. */
const ARCHIVE_CHOICE = "Archive";

export interface DecodedField {
  name: string;
  /** Index into the package's interned-types table. */
  typeIndex: number | null;
  /** Resolved type (`unsupported` for shapes not yet mapped). */
  type: TypeDesc;
}

export interface DecodedRecord {
  name: string;
  serializable: boolean;
  fields: DecodedField[];
}

export interface DecodedChoice {
  name: string;
  consuming: boolean;
  /** Interned-type index of the return type (resolve later). */
  returnTypeIndex: number | null;
  /** The choice-argument record, as "Module:Name", or null if not a record. */
  argRecordRef: string | null;
}

export interface DecodedTemplate {
  name: string;
  choices: DecodedChoice[];
}

export interface DecodedModule {
  name: string;
  templates: DecodedTemplate[];
  records: DecodedRecord[];
}

export interface DecodedPackage {
  minorVersion: string;
  /** interned string table, position = index */
  strings: string[];
  /** interned dotted-name table, position = index (dot-joined) */
  dottedNames: string[];
  modules: DecodedModule[];
}

// ---- small field helpers ---------------------------------------------------

/** All values of one field number, as sub-readers (wire 2) — repeated fields. */
function repeated(buf: Buffer, field: number): Buffer[] {
  const out: Buffer[] = [];
  each(new ProtoReader(buf), (tag, r) => {
    if (tag.field === field && tag.wire === 2) out.push(r.bytes());
    else r.skip(tag.wire);
  });
  return out;
}

/** First varint value of a field, or `undefined` if absent (proto3 default). */
function varint(buf: Buffer, field: number): number | undefined {
  let found: number | undefined;
  each(new ProtoReader(buf), (tag, r) => {
    if (found === undefined && tag.field === field && tag.wire === 0) found = r.uint();
    else r.skip(tag.wire);
  });
  return found;
}

/** First length-delimited value of a field, or `undefined`. */
function bytes(buf: Buffer, field: number): Buffer | undefined {
  let found: Buffer | undefined;
  each(new ProtoReader(buf), (tag, r) => {
    if (found === undefined && tag.field === field && tag.wire === 2) found = r.bytes();
    else r.skip(tag.wire);
  });
  return found;
}

/** The single length-delimited value carrying the most bytes for `field`
 * (used where the schema has one dominant sub-message, e.g. the Package). */
function largest(buf: Buffer, field: number): Buffer | undefined {
  return repeated(buf, field).sort((a, b) => b.length - a.length)[0];
}

// ---- decode ----------------------------------------------------------------

/** A Daml-LF `Type` here is (in the DALFs we target) an interned reference:
 * field #8 is an index into the package's interned-types table. Returns that
 * index, or null for the shapes we do not yet resolve. */
function typeIndex(typeBuf: Buffer): number | null {
  const idx = varint(typeBuf, TYPE_INTERNED);
  return idx === undefined ? null : idx;
}

const zigzag = (n: number): number => (n >>> 1) ^ -(n & 1);

const UNSUPPORTED = (raw: string): TypeDesc => ({ kind: "unsupported", raw });

/** Resolve one interned-types entry (by index) into a `TypeDesc`. `internedTypes`
 * is the package table; `D` resolves dotted-name indices. Bounded recursion for
 * the parameterised forms (Numeric/ContractId/Optional). */
function resolveType(
  index: number | null,
  internedTypes: Buffer[],
  D: (i: number) => string,
  depth = 0,
): TypeDesc {
  if (index === null || index < 0 || index >= internedTypes.length || depth > 8)
    return UNSUPPORTED(`idx ${index}`);
  const entry = internedTypes[index];

  // builtin / prim node: { #1 = enum }
  const prim = bytes(entry, T_PRIM);
  if (prim) {
    switch (varint(prim, T_PRIM_ENUM)) {
      case BT_UNIT: return { kind: "unit" };
      case BT_BOOL: return { kind: "bool" };
      case BT_INT64: return { kind: "int" };
      case BT_DATE: return { kind: "date" };
      case BT_TIMESTAMP: return { kind: "timestamp" };
      case BT_PARTY: return { kind: "party" };
      case BT_TEXT: return { kind: "text" };
      // NUMERIC/CONTRACT_ID/OPTIONAL only carry meaning when applied (see app).
      default: return UNSUPPORTED(`builtin ${varint(prim, T_PRIM_ENUM)}`);
    }
  }

  // con node → record ref "Module:Name"
  const con = bytes(entry, T_CON);
  if (con) return { kind: "record", ref: conRef(con, D) };

  // app node: { #1 = fun, #2 = arg }
  const app = bytes(entry, T_APP);
  if (app) {
    const funBuf = bytes(app, APP_FUN);
    const argBuf = bytes(app, APP_ARG);
    const funIdx = funBuf ? typeIndex(funBuf) : null;
    const argIdx = argBuf ? typeIndex(argBuf) : null;
    const funPrim = funIdx !== null ? bytes(internedTypes[funIdx] ?? Buffer.alloc(0), T_PRIM) : undefined;
    const funEnum = funPrim ? varint(funPrim, T_PRIM_ENUM) : undefined;
    switch (funEnum) {
      case BT_NUMERIC: {
        const natEntry = argIdx !== null ? internedTypes[argIdx] : undefined;
        const raw = natEntry ? varint(natEntry, T_NAT) : undefined;
        return raw === undefined ? UNSUPPORTED("numeric?") : { kind: "numeric", scale: zigzag(raw) };
      }
      case BT_CONTRACT_ID: {
        const of = resolveType(argIdx, internedTypes, D, depth + 1);
        return { kind: "contractId", of: of.kind === "record" ? of.ref : "?" };
      }
      case BT_OPTIONAL:
        return { kind: "optional", of: resolveType(argIdx, internedTypes, D, depth + 1) };
      default:
        // ARROW (function), tuples, LIST/maps (not yet mapped) → unsupported.
        return UNSUPPORTED(`app builtin ${funEnum}`);
    }
  }

  return UNSUPPORTED(`type idx ${index}`);
}

/** A con node → "Module:Name". `Type.con` wraps a TypeConName at #1, whose #2
 * is the type name (dotted idx) and #1 is the ModuleRef; the module name is the
 * ModuleRef's #2 (dotted idx), default 0. */
function conRef(con: Buffer, D: (i: number) => string): string {
  const tycon = bytes(con, CON_TYCON) ?? con;
  const name = D(varint(tycon, TYCON_NAME) ?? 0);
  const modRef = bytes(tycon, TYCON_MODREF);
  const moduleName = modRef ? D(varint(modRef, MODREF_NAME) ?? 0) : "?";
  return `${moduleName}:${name}`;
}

interface Resolve {
  S: (i: number) => string;
  D: (i: number) => string;
  /** Resolve a `Type` buffer (an interned reference) to a TypeDesc. */
  type: (typeBuf: Buffer | undefined) => TypeDesc;
  /** The record ref "Module:Name" a `Type` buffer points at, or null. */
  conRefOf: (typeBuf: Buffer | undefined) => string | null;
}

function decodeRecord(dtBuf: Buffer, R: Resolve): DecodedRecord {
  const name = R.D(varint(dtBuf, DT_NAME) ?? 0);
  const serializable = varint(dtBuf, DT_SERIALIZABLE) === 1;
  const recBuf = bytes(dtBuf, DT_RECORD);
  const fields: DecodedField[] = [];
  if (recBuf) {
    for (const fwt of repeated(recBuf, REC_FIELD)) {
      const tBuf = bytes(fwt, FWT_TYPE);
      fields.push({
        name: R.S(varint(fwt, FWT_NAME) ?? -1),
        typeIndex: tBuf ? typeIndex(tBuf) : null,
        type: R.type(tBuf),
      });
    }
  }
  return { name, serializable, fields };
}

const CH_ARG_BINDER = 6; // VarWithType { #1 var(str), #2 type(Type) }
const VWT_TYPE = 2;

function decodeTemplate(tplBuf: Buffer, R: Resolve): DecodedTemplate {
  const name = R.D(varint(tplBuf, TPL_TYCON) ?? 0);
  const choices: DecodedChoice[] = [];
  for (const ch of repeated(tplBuf, TPL_CHOICE)) {
    const chName = R.S(varint(ch, CH_NAME) ?? -1);
    if (chName === ARCHIVE_CHOICE) continue; // implicit lifecycle choice
    const retBuf = bytes(ch, CH_RET_TYPE);
    const argBinder = bytes(ch, CH_ARG_BINDER);
    const argType = argBinder ? bytes(argBinder, VWT_TYPE) : undefined;
    choices.push({
      name: chName,
      consuming: varint(ch, CH_CONSUMING) === 1,
      returnTypeIndex: retBuf ? typeIndex(retBuf) : null,
      argRecordRef: R.conRefOf(argType),
    });
  }
  return { name, choices };
}

/** Decode a DALF (`DamlLf.Archive` bytes) into its package structure. */
export function decodeArchive(dalf: Buffer): DecodedPackage {
  const payload = largest(dalf, ARCHIVE_PAYLOAD);
  if (!payload) throw new Error("lfdecode: no Archive payload (field #3)");

  const minorVersion = bytes(payload, PAYLOAD_MINOR)?.toString("utf8") ?? "";
  const pkg = largest(payload, PAYLOAD_PACKAGE);
  if (!pkg) throw new Error("lfdecode: no Package in ArchivePayload (field #4)");

  const strings = repeated(pkg, PKG_INTERNED_STR).map((b) => b.toString("utf8"));
  const dottedNames = repeated(pkg, PKG_INTERNED_DNAME).map((dn) => {
    const parts: number[] = [];
    each(new ProtoReader(dn), (tag, r) => {
      if (tag.wire === 0) parts.push(r.uint());
      else if (tag.wire === 2) {
        // packed repeated varint
        const rr = new ProtoReader(r.bytes());
        while (!rr.done) parts.push(rr.uint());
      } else r.skip(tag.wire);
    });
    return parts.map((i) => strings[i] ?? `?${i}`).join(".");
  });

  const internedTypes = repeated(pkg, PKG_INTERNED_TYPE);
  const D = (i: number): string => dottedNames[i] ?? `?dn${i}`;
  const resolve: Resolve = {
    S: (i) => strings[i] ?? `?str${i}`,
    D,
    type: (typeBuf) => (typeBuf ? resolveType(typeIndex(typeBuf), internedTypes, D) : UNSUPPORTED("no type")),
    conRefOf: (typeBuf) => {
      if (!typeBuf) return null;
      const t = resolveType(typeIndex(typeBuf), internedTypes, D);
      return t.kind === "record" ? t.ref : null;
    },
  };

  const modules: DecodedModule[] = repeated(pkg, PKG_MODULE).map((modBuf) => ({
    name: resolve.D(varint(modBuf, MOD_NAME) ?? 0),
    records: repeated(modBuf, MOD_DATATYPE).map((dt) => decodeRecord(dt, resolve)),
    templates: repeated(modBuf, MOD_TEMPLATE).map((t) => decodeTemplate(t, resolve)),
  }));

  return { minorVersion, strings, dottedNames, modules };
}

/** Pull the "main" DALF out of a DAR (skips the stdlib/prim/script packages),
 * ready for `decodeArchive`. */
export function mainDalfOfDar(dar: Buffer): Buffer {
  const entry = readZip(dar).find(
    (e) => e.name.endsWith(".dalf") && !/daml-prim|daml-stdlib|daml-script/.test(e.name),
  );
  if (!entry) throw new Error("lfdecode: no main dalf in DAR");
  return entry.read();
}
