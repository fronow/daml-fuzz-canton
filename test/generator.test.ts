// Tests for the PRNG port (bit-identity with the Daml prototype's LCG) and
// the plan generator (determinism, boundary discipline, reference shapes).
//
// The PRNG reference values below were computed independently (Python,
// arbitrary-precision ints), NOT by running prng.ts — so they catch a port
// that diverges from the Daml Int64 semantics, e.g. by using Number math.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  generatePlan,
  type ArgValue,
  type CreateStep,
  type ExerciseStep,
} from "../src/generator.ts";
import { buildActionSpace, type ActionSpace } from "../src/introspect.ts";
import { parseInspectDump } from "../src/lfparse.ts";
import { next, pick, Prng, roll, seedOf } from "../src/prng.ts";

const space = buildActionSpace(
  parseInspectDump(
    readFileSync(
      fileURLToPath(new URL("./fixtures/m1-dsl.lf.txt", import.meta.url)),
      "utf8",
    ),
  ),
);

// ---------------------------------------------------------------- PRNG ----

// s_{k+1} = (s_k * 1103515245 + 12345) mod 2^31, starting from 42.
const REF_SEEDS = [
  1250496027n,
  1116302264n,
  1000676753n,
  1668674806n,
  908095735n,
  71666532n,
];

test("next: bit-identical LCG sequence from seed 42", () => {
  let s = seedOf(42);
  for (const expected of REF_SEEDS) {
    s = next(s);
    assert.equal(s, expected);
  }
});

test("roll uses the HIGH bits: (s / 65536) % n", () => {
  assert.deepEqual(
    REF_SEEDS.map((s) => roll(s, 97)),
    [69, 58, 40, 47, 82, 26],
  );
  assert.deepEqual(
    REF_SEEDS.map((s) => roll(s, 2)),
    [1, 1, 1, 1, 0, 1],
  );
});

test("low bits would be degenerate — the reason roll divides first", () => {
  // The LCG's lowest bit strictly alternates; naive `s % 2` would too.
  assert.deepEqual(
    REF_SEEDS.map((s) => Number(s % 2n)),
    [1, 0, 1, 0, 1, 0],
  );
  // The high-bit rolls above ([1,1,1,1,0,1]) do not alternate.
});

test("seedOf normalizes into [0, 2^31)", () => {
  assert.equal(seedOf(42), 42n);
  assert.equal(seedOf(-1), 2147483647n);
  assert.equal(seedOf(2n ** 31n), 0n);
  assert.equal(seedOf(2n ** 31n + 5n), 5n);
});

test("roll and pick reject degenerate inputs", () => {
  assert.throws(() => roll(42n, 0), RangeError);
  assert.throws(() => roll(42n, -3), RangeError);
  assert.throws(() => pick(42n, []), RangeError);
});

test("pick indexes by roll", () => {
  // roll(REF_SEEDS[0], 2) === 1
  assert.equal(pick(REF_SEEDS[0], ["a", "b"]), "b");
});

test("Prng wrapper advances before each draw, matching the pure functions", () => {
  const p = new Prng(42);
  assert.deepEqual(
    [p.roll(97), p.roll(97), p.roll(97)],
    [69, 58, 40],
  );
  assert.equal(p.seed, REF_SEEDS[2]);
});

// ----------------------------------------------------------- generator ----

const OPTS = { seed: 42, steps: 40, actorCount: 3 };

test("same seed, same plan — byte-stable through JSON", () => {
  const a = generatePlan(space, OPTS);
  const b = generatePlan(space, OPTS);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("different seeds diverge", () => {
  const a = generatePlan(space, OPTS);
  const b = generatePlan(space, { ...OPTS, seed: 43 });
  assert.notEqual(JSON.stringify(a.steps), JSON.stringify(b.steps));
});

test("plan header: seed as decimal string, package, counts", () => {
  const plan = generatePlan(space, OPTS);
  assert.equal(plan.seed, "42");
  assert.equal(plan.actorCount, 3);
  assert.equal(plan.package, space.package);
  assert.equal(plan.steps.length, 40);
});

// The boundary pools the generator promises to draw from (kept in sync with
// generator.ts by these assertions failing if the pools drift).
const FRAC_POOL = [0.1, 0.3, 0.5, 0.7, 0.9];
const NUMERIC_ABS_POOL = ["100.0", "1.0", "0.0000000001", "13.37"];
const INT_ABS_POOL = ["100", "1", "2", "7"];
const TEXT_POOL = ["", "fuzz", "0", "😈"];

function checkValue(v: ArgValue, mode: "create" | "exercise"): void {
  if ("partyRef" in v) {
    assert.ok(v.partyRef >= 0 && v.partyRef < OPTS.actorCount);
  } else if ("targetParty" in v) {
    // Payload-aware party: a FIELD NAME of the exercised template, never an id.
    assert.equal(mode, "exercise");
    assert.ok(
      space.templates.some((t) => t.partyFields.includes(v.targetParty)),
      v.targetParty,
    );
  } else if ("ownerOf" in v) {
    assert.equal(mode, "exercise");
    assert.equal(typeof v.ownerOf, "string");
  } else if ("contractRef" in v) {
    assert.ok(v.contractRef >= 0 && v.contractRef < 97);
  } else if ("frac" in v) {
    assert.equal(mode, "exercise");
    assert.ok(FRAC_POOL.includes(v.frac));
  } else if ("abs" in v) {
    assert.equal(mode, "create");
    assert.ok(NUMERIC_ABS_POOL.includes(v.abs) || INT_ABS_POOL.includes(v.abs));
  } else if ("text" in v) {
    assert.ok(TEXT_POOL.includes(v.text));
  } else if ("bool" in v) {
    assert.equal(typeof v.bool, "boolean");
  } else if ("optional" in v) {
    if (v.optional !== null) checkValue(v.optional, mode);
  } else if ("list" in v) {
    assert.ok(v.list.length <= 2);
    for (const x of v.list) checkValue(x, mode);
  } else if ("record" in v) {
    // Nested records draw numerics from the abs pool by design.
    for (const x of Object.values(v.record)) checkValue(x, "create");
  } else if ("emptyMap" in v) {
    assert.equal(v.emptyMap, true);
  } else {
    assert.ok("unsupported" in v);
  }
}

test("every step keeps the boundary discipline and index-based refs", () => {
  const plan = generatePlan(space, { ...OPTS, steps: 200 });
  const known = new Set(
    space.templates.map((t) => `${t.module}:${t.name}`),
  );
  for (const s of plan.steps) {
    assert.ok(known.has(s.template));
    if (s.kind === "exercise") {
      assert.ok(s.contractRef >= 0 && s.contractRef < 97);
      for (const v of Object.values(s.args)) checkValue(v, "exercise");
    } else {
      for (const v of Object.values(s.args)) checkValue(v, "create");
    }
  }
});

test("plans are symbolic: no party or contract ids anywhere", () => {
  const json = JSON.stringify(generatePlan(space, { ...OPTS, steps: 200 }));
  assert.ok(!/party::|contractId|"cid"/i.test(json));
});

test("createPercent 100 → all creates; 0 → all exercises", () => {
  const all = generatePlan(space, { ...OPTS, createPercent: 100 });
  assert.ok(all.steps.every((s): s is CreateStep => s.kind === "create"));
  const none = generatePlan(space, { ...OPTS, createPercent: 0 });
  assert.ok(none.steps.every((s): s is ExerciseStep => s.kind === "exercise"));
});

test("a mixed run actually mixes (default 20% creates)", () => {
  const plan = generatePlan(space, { ...OPTS, steps: 200 });
  const creates = plan.steps.filter((s) => s.kind === "create").length;
  assert.ok(creates > 0 && creates < 200, `creates=${creates}`);
});

// A hand-built space exercising the shapes the fixture doesn't cover:
// contractId fields (→ symbolic contractRef), optional, list, and a
// template with no choices (generator must fall back to creates).
const tinySpace: ActionSpace = {
  package: "tiny",
  packageId: "deadbeef",
  lfVersion: "2.2",
  templates: [
    {
      module: "T",
      name: "Odd",
      fields: [
        { name: "owner", type: { kind: "party" } },
        { name: "ref", type: { kind: "contractId", of: "T:Odd" } },
        { name: "note", type: { kind: "optional", of: { kind: "text" } } },
        { name: "tags", type: { kind: "list", of: { kind: "int" } } },
        { name: "ok", type: { kind: "bool" } },
      ],
      partyFields: ["owner"],
      choices: [],
    },
  ],
};

test("no choices → all creates; contractId fields become symbolic contractRefs", () => {
  const plan = generatePlan(tinySpace, { ...OPTS, steps: 25, createPercent: 0 });
  assert.ok(plan.steps.every((s) => s.kind === "create"));
  for (const s of plan.steps as CreateStep[]) {
    assert.deepEqual(Object.keys(s.args), ["owner", "ref", "note", "tags", "ok"]);
    assert.ok("contractRef" in s.args.ref);
    assert.ok("partyRef" in s.args.owner);
    assert.ok("optional" in s.args.note);
    assert.ok("list" in s.args.tags);
  }
});

test("empty action space is an error, not an empty plan", () => {
  assert.throws(
    () => generatePlan({ ...tinySpace, templates: [] }, OPTS),
    /no templates/,
  );
});

// --------------------------------------------------------- auth-fuzz ----
// In auth-fuzz mode every step carries an actAs subset of actor INDEXES, so
// the ledger's own authorization checks are live during execution.

test("classic mode: no actAs on any step, no authFuzz flag on the plan", () => {
  const plan = generatePlan(space, { ...OPTS, steps: 100 });
  assert.equal(plan.authFuzz, undefined);
  assert.ok(plan.steps.every((s) => s.actAs === undefined));
});

test("auth-fuzz mode: plan flagged, every step carries a 1–2 actor-index subset", () => {
  const plan = generatePlan(space, { ...OPTS, steps: 200, authFuzz: true });
  assert.equal(plan.authFuzz, true);
  for (const s of plan.steps) {
    assert.ok(Array.isArray(s.actAs), "every step has actAs in auth-fuzz mode");
    const actAs = s.actAs!;
    assert.ok(actAs.length === 1 || actAs.length === 2, `subset size ${actAs.length}`);
    assert.equal(new Set(actAs).size, actAs.length, "no duplicate submitters");
    for (const idx of actAs)
      assert.ok(
        idx >= 0 && idx < OPTS.actorCount && Number.isInteger(idx),
        `actor index ${idx} in range`,
      );
  }
});

test("auth-fuzz is deterministic and does actually use pairs sometimes", () => {
  const a = generatePlan(space, { ...OPTS, steps: 200, authFuzz: true });
  const b = generatePlan(space, { ...OPTS, steps: 200, authFuzz: true });
  assert.equal(JSON.stringify(a.steps), JSON.stringify(b.steps));
  const pairs = a.steps.filter((s) => s.actAs!.length === 2).length;
  assert.ok(pairs > 0 && pairs < a.steps.length, `pairs=${pairs} (expected a minority)`);
});

test("single actor: auth-fuzz subsets are always [0] (no distinct pair possible)", () => {
  const plan = generatePlan(space, { seed: 42, steps: 50, actorCount: 1, authFuzz: true });
  assert.ok(plan.steps.every((s) => s.actAs!.length === 1 && s.actAs![0] === 0));
});
