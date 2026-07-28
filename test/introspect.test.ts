// Tests for the introspection front-end, against a checked-in fixture: the
// `daml damlc inspect` dump of next2/m1-dsl (4 templates, known choices).
// Hermetic — no SDK invocation; the CLI's --from-dump path uses the same code.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildActionSpace } from "../src/introspect.ts";
import { parseInspectDump, parseType } from "../src/lfparse.ts";

const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/m1-dsl.lf.txt", import.meta.url)),
  "utf8",
);

test("header: package id, LF version, package name", () => {
  const m = parseInspectDump(fixture);
  assert.equal(m.packageId, "2151541acc2a93f3660bd7ba033d2bbab2802cf171a3d85d25e6afa157ce8bf5");
  assert.equal(m.lfVersion, "2.2");
  assert.equal(m.packageName, "daml-fuzz-next2-m1-dsl-0.1.0");
});

test("all four templates are found", () => {
  const m = parseInspectDump(fixture);
  const names = m.templates.map((t) => `${t.module}:${t.name}`).sort();
  assert.deepEqual(names, [
    "Dsl:TokenA",
    "Dsl:TokenABug",
    "Dsl:VoucherB",
    "Dsl:VoucherBBug",
  ]);
});

test("template payload fields and party detection", () => {
  const space = buildActionSpace(parseInspectDump(fixture));
  const tokenA = space.templates.find((t) => t.name === "TokenA")!;
  assert.deepEqual(
    tokenA.fields.map((f) => [f.name, f.type.kind]),
    [["issuer", "party"], ["owner", "party"], ["amount", "numeric"]],
  );
  assert.deepEqual(tokenA.partyFields, ["issuer", "owner"]);
});

test("choices resolve their argument records; Archive excluded by default", () => {
  const space = buildActionSpace(parseInspectDump(fixture));
  const tokenA = space.templates.find((t) => t.name === "TokenA")!;
  assert.deepEqual(tokenA.choices.map((c) => c.name).sort(), ["SplitA", "TransferA"]);

  const transfer = tokenA.choices.find((c) => c.name === "TransferA")!;
  assert.equal(transfer.consuming, true);
  assert.deepEqual(transfer.args, [{ name: "newOwner", type: { kind: "party" } }]);

  const split = tokenA.choices.find((c) => c.name === "SplitA")!;
  assert.deepEqual(split.args, [
    { name: "splitAmount", type: { kind: "numeric", scale: 10 } },
  ]);
});

test("Int fields map to int (VoucherB.SplitB.n)", () => {
  const space = buildActionSpace(parseInspectDump(fixture));
  const voucher = space.templates.find((t) => t.name === "VoucherB")!;
  const split = voucher.choices.find((c) => c.name === "SplitB")!;
  assert.deepEqual(split.args, [{ name: "n", type: { kind: "int" } }]);
});

test("--include-archive brings Archive back with empty args", () => {
  const space = buildActionSpace(parseInspectDump(fixture), { includeArchive: true });
  const tokenA = space.templates.find((t) => t.name === "TokenA")!;
  const archive = tokenA.choices.find((c) => c.name === "Archive")!;
  // Argument record lives in another package: unresolved (null), not [].
  assert.equal(archive.args, null);
  assert.equal(archive.consuming, true);
});

test("type parser corner cases", () => {
  assert.deepEqual(parseType("List Party"), { kind: "list", of: { kind: "party" } });
  assert.deepEqual(parseType("Option (ContractId Dsl:TokenA)"), {
    kind: "optional",
    of: { kind: "contractId", of: "Dsl:TokenA" },
  });
  assert.deepEqual(parseType("Numeric 10"), { kind: "numeric", scale: 10 });
  assert.deepEqual(parseType("Dsl:TransferA"), { kind: "record", ref: "Dsl:TransferA" });
  assert.equal(parseType("Int64 -> Script Int64").kind, "unsupported");
});
