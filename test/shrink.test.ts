// Shrinker tests — pure and fast: the "ledger" is a predicate over plans.
// The mechanism (greedy delta-debug to fixpoint) is the port of
// next/m2-shrink Shrink.daml, which proved 12 random steps → 1 on-ledger.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Plan, PlanStep } from "../src/generator.ts";
import { shrinkPlan } from "../src/shrink.ts";

const create = (template: string): PlanStep => ({ kind: "create", template, args: {} });
const plan = (steps: PlanStep[]): Plan => ({
  seed: "1",
  actorCount: 2,
  package: "p",
  steps,
});

const contains = (p: Plan, t: string) => p.steps.some((s) => s.template === t);

test("12 steps with one culprit shrink to exactly 1", async () => {
  const noise = Array.from({ length: 11 }, (_, i) => create(`M:Noise${i}`));
  const full = plan([...noise.slice(0, 7), create("M:Bad"), ...noise.slice(7)]);
  const r = await shrinkPlan(full, async (c) => contains(c, "M:Bad"));
  assert.equal(r.originalSteps, 12);
  assert.deepEqual(r.minimal.steps, [create("M:Bad")]);
  assert.ok(r.attempts >= 12, `expected at least one replay per position, got ${r.attempts}`);
});

test("two load-bearing steps both survive, in order", async () => {
  const full = plan([
    create("M:N1"),
    create("M:Setup"),
    create("M:N2"),
    create("M:N3"),
    create("M:Trigger"),
    create("M:N4"),
  ]);
  const r = await shrinkPlan(
    full,
    async (c) => contains(c, "M:Setup") && contains(c, "M:Trigger"),
  );
  assert.deepEqual(
    r.minimal.steps.map((s) => s.template),
    ["M:Setup", "M:Trigger"],
  );
});

test("already-minimal plan is untouched after one probing pass", async () => {
  const full = plan([create("M:Bad")]);
  const r = await shrinkPlan(full, async (c) => contains(c, "M:Bad"));
  assert.deepEqual(r.minimal.steps, [create("M:Bad")]);
  assert.equal(r.attempts, 1); // dropping the only step un-fails: keep, fixpoint
});

test("every candidate gets a fresh replay (no caching assumptions)", async () => {
  let calls = 0;
  const full = plan([create("M:A"), create("M:Bad"), create("M:B")]);
  const r = await shrinkPlan(full, async (c) => {
    calls++;
    return contains(c, "M:Bad");
  });
  assert.equal(r.attempts, calls);
  assert.equal(r.minimal.steps.length, 1);
});
