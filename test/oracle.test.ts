// Oracle tests: exact fixed-point quantity parsing, the starter pack
// (ported from next2/m1-dsl Dsl.daml), and the introspection-derived
// holding adapter.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionSpaceTemplate } from "../src/introspect.ts";
import type { ActiveContract } from "../src/ledger.ts";
import {
  conservation,
  formatQuantity,
  holdingAdapter,
  nonNegativity,
  parseQuantity,
  runPack,
  snapshotHoldings,
  starterPack,
  type Holding,
} from "../src/oracle.ts";

const U = 10n ** 10n; // one unit at scale 10

test("parseQuantity: exact scale-10 fixed point", () => {
  assert.equal(parseQuantity("100.0"), 100n * U);
  assert.equal(parseQuantity("100"), 100n * U); // Int64 payloads
  assert.equal(parseQuantity("0.0000000001"), 1n); // dust survives exactly
  assert.equal(parseQuantity("13.37"), 1337n * U / 100n);
  assert.equal(parseQuantity("-5.0"), -5n * U);
  assert.equal(parseQuantity("100.0000000000"), 100n * U); // ledger echo form
  assert.throws(() => parseQuantity("1e5"));
  assert.throws(() => parseQuantity(""));
});

test("formatQuantity round-trips", () => {
  for (const s of ["100.0", "0.0000000001", "-5.0", "13.37", "0.0"]) {
    assert.equal(parseQuantity(formatQuantity(parseQuantity(s))), parseQuantity(s));
  }
});

const h = (holder: string, q: string): Holding => ({ holder, quantity: parseQuantity(q) });

test("conservation: exact totals, no float drift", () => {
  // 0.1 + 0.2-style sums that break Number arithmetic must stay exact.
  const hs = [h("a", "0.1"), h("a", "0.2"), h("b", "99.7")];
  assert.equal(conservation.check(parseQuantity("100.0"), hs), null);
  assert.match(
    conservation.check(parseQuantity("100.0"), [...hs, h("b", "50.0")])!,
    /total 100\.0 but they total 150\.0/,
  );
});

test("non-negativity", () => {
  assert.equal(nonNegativity.check(0n, [h("a", "0.0")]), null);
  assert.match(nonNegativity.check(0n, [h("a", "-0.0000000001")])!, /negative/);
});

test("runPack reports the FIRST violated property (prototype order)", () => {
  // Inflated AND negative: conservation is first in the pack.
  const v = runPack(starterPack, parseQuantity("100.0"), [h("a", "-1.0"), h("b", "200.0")]);
  assert.equal(v!.property, "conservation-of-value");
  const v2 = runPack(starterPack, parseQuantity("-1.0"), [h("a", "-1.0")]);
  assert.equal(v2!.property, "non-negativity");
  assert.equal(runPack(starterPack, parseQuantity("5.0"), [h("a", "5.0")]), null);
});

const TOK: ActionSpaceTemplate = {
  module: "Dsl",
  name: "TokenA",
  fields: [
    { name: "issuer", type: { kind: "party" } },
    { name: "owner", type: { kind: "party" } },
    { name: "amount", type: { kind: "numeric", scale: 10 } },
  ],
  partyFields: ["issuer", "owner"],
  choices: [],
};

test("holdingAdapter: quantity = first numeric/int field, holder = last party field", () => {
  assert.deepEqual(holdingAdapter(TOK), { quantityField: "amount", holderField: "owner" });
  const noAmount: ActionSpaceTemplate = { ...TOK, fields: TOK.fields.slice(0, 2) };
  assert.equal(holdingAdapter(noAmount), null); // nothing to measure
});

test("snapshotHoldings maps ACS payloads through the adapter", () => {
  const acs: ActiveContract[] = [
    {
      contractId: "c1",
      templateId: "pkg:Dsl:TokenA",
      payload: { issuer: "i::x", owner: "a::x", amount: "60.0000000000" },
    },
    {
      contractId: "c2",
      templateId: "pkg:Dsl:TokenA",
      payload: { issuer: "i::x", owner: "b::x", amount: "40.0000000000" },
    },
  ];
  const hs = snapshotHoldings(holdingAdapter(TOK)!, acs);
  assert.deepEqual(hs, [
    { holder: "a::x", quantity: parseQuantity("60.0") },
    { holder: "b::x", quantity: parseQuantity("40.0") },
  ]);
  assert.equal(conservation.check(parseQuantity("100.0"), hs), null);
});
