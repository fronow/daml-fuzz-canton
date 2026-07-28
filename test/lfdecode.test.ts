// Validation: decode the bundled m1-dsl.dalf with the from-scratch protobuf
// decoder and check its STRUCTURE against the same package parsed from the
// `damlc inspect` text (the oracle the text parser is already tested on). If
// the reverse-engineered LF field numbers are wrong, these diverge.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decodeArchive, type DecodedField, type DecodedModule } from "../src/lfdecode.ts";
import { parseInspectDump } from "../src/lfparse.ts";

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

const decoded = decodeArchive(readFileSync(here("./fixtures/m1-dsl.dalf")));
const oracle = parseInspectDump(readFileSync(here("./fixtures/m1-dsl.lf.txt"), "utf8"));

// The main package has exactly one user module ("Dsl"); find it.
const dsl: DecodedModule = decoded.modules.find((m) => m.templates.length > 0)!;

test("decodes the archive envelope: LF 2.x, non-empty intern tables", () => {
  assert.equal(decoded.minorVersion, "2");
  assert.ok(decoded.strings.length > 0, "interned strings present");
  assert.ok(decoded.dottedNames.length > 0, "interned dotted names present");
  assert.equal(dsl.name, "Dsl");
});

test("template names match the text-parsed oracle", () => {
  const got = dsl.templates.map((t) => t.name).sort();
  const want = oracle.templates.map((t) => t.name).sort();
  assert.deepEqual(got, want);
});

test("per-template choice names (Archive excluded) match the oracle", () => {
  for (const t of oracle.templates) {
    const mine = dsl.templates.find((x) => x.name === t.name)!;
    const got = mine.choices.map((c) => c.name).sort();
    const want = t.choices.map((c) => c.name).filter((n) => n !== "Archive").sort();
    assert.deepEqual(got, want, `choices of ${t.name}`);
  }
});

test("choice consuming flags match the oracle (validates the #3 mapping)", () => {
  for (const t of oracle.templates) {
    const mine = dsl.templates.find((x) => x.name === t.name)!;
    for (const oc of t.choices) {
      if (oc.name === "Archive") continue;
      const mc = mine.choices.find((c) => c.name === oc.name)!;
      assert.equal(mc.consuming, oc.consuming, `${t.name}.${oc.name} consuming`);
    }
  }
});

test("record names and field names match the oracle", () => {
  // The oracle keys records "Module:Name"; compare within the Dsl module.
  const oracleRecords = new Map(
    [...oracle.records.values()]
      .filter((r) => r.module === "Dsl")
      .map((r) => [r.name, r.fields.map((f) => f.name)]),
  );
  for (const [name, fieldNames] of oracleRecords) {
    const mine = dsl.records.find((r) => r.name === name);
    assert.ok(mine, `decoded record ${name} exists`);
    assert.deepEqual(mine!.fields.map((f) => f.name), fieldNames, `fields of ${name}`);
  }
});

test("every decoded field carries an interned type index (the resolver's hook)", () => {
  const withFields = dsl.records.filter((r) => r.fields.length > 0);
  assert.ok(withFields.length > 0);
  for (const r of withFields)
    for (const f of r.fields)
      assert.equal(typeof f.typeIndex, "number", `${r.name}.${f.name} has a type index`);
});

test("resolved field TYPES match the oracle (party / int / numeric scale / text)", () => {
  const oracleRecords = new Map(
    [...oracle.records.values()].filter((r) => r.module === "Dsl").map((r) => [r.name, r]),
  );
  let checked = 0;
  for (const [name, orec] of oracleRecords) {
    const mine = dsl.records.find((r) => r.name === name);
    if (!mine || mine.fields.length === 0) continue;
    for (const ofld of orec.fields) {
      const mf: DecodedField = mine.fields.find((f) => f.name === ofld.name)!;
      // Function/higher-kinded fields are `unsupported` on both sides (the
      // text parser can't render them either); a kind match is enough there.
      // Value types (party/int/numeric/text/…) must match exactly.
      if (mf.type.kind === "unsupported" && ofld.type.kind === "unsupported") {
        checked++;
        continue;
      }
      assert.deepEqual(mf.type, ofld.type, `${name}.${ofld.name} type`);
      checked++;
    }
  }
  // m1-dsl exercises Party, Int64, Numeric 10, Text — make sure we saw them.
  assert.ok(checked >= 10, `checked ${checked} field types`);
});

test("Numeric scale is decoded correctly (zigzag nat = 10, not the raw 20)", () => {
  const tokenA = dsl.records.find((r) => r.name === "TokenA")!;
  const amount = tokenA.fields.find((f) => f.name === "amount")!;
  assert.deepEqual(amount.type, { kind: "numeric", scale: 10 });
});

test("choice argument records resolve to real records (TCon → Module:Name)", () => {
  for (const t of dsl.templates) {
    for (const c of t.choices) {
      assert.ok(c.argRecordRef, `${t.name}.${c.name} has an arg record ref`);
      const shortName = c.argRecordRef!.split(":").pop()!;
      assert.ok(
        dsl.records.some((r) => r.name === shortName),
        `arg record ${c.argRecordRef} of ${t.name}.${c.name} exists`,
      );
    }
  }
});
