// Tests for coverage observation: rejection classification, per-action
// accept/reject/skip counting, the never-accepted gap list, and the summary.
// All hermetic — StepResults are hand-built, no ledger involved.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyRejection,
  coverageOf,
  coverageSummary,
} from "../src/coverage.ts";
import type { StepResult } from "../src/executor.ts";
import type { PlanStep } from "../src/generator.ts";
import type { ActionSpace } from "../src/introspect.ts";

// ------------------------------------------------ classifyRejection ----

test("classifyRejection maps the Canton error surface to four classes", () => {
  assert.equal(classifyRejection("DAML_AUTHORIZATION_ERROR: requires authorizers"), "authorization");
  assert.equal(classifyRejection("missing authorization from 'Bob'"), "authorization");
  assert.equal(classifyRejection("CONTRACT_NOT_FOUND: #0:0 not visible to 'Eve'"), "visibility");
  assert.equal(classifyRejection("UNHANDLED_EXCEPTION: Assertion failed"), "contract-logic");
  assert.equal(classifyRejection("Template precondition violated"), "contract-logic");
  assert.equal(classifyRejection("something we have never seen before"), "other");
});

// ------------------------------------------------------- coverageOf ----

const space: ActionSpace = {
  package: "cov",
  packageId: "deadbeef",
  lfVersion: "2.2",
  templates: [
    {
      module: "M",
      name: "A",
      fields: [{ name: "owner", type: { kind: "party" } }],
      partyFields: ["owner"],
      choices: [
        { name: "Foo", consuming: true, args: [], argType: "M:Foo", returns: "Unit" },
      ],
    },
    {
      module: "M",
      name: "B",
      fields: [{ name: "owner", type: { kind: "party" } }],
      partyFields: ["owner"],
      choices: [],
    },
  ],
};

const createA: PlanStep = { kind: "create", template: "M:A", args: {} };
const fooA: PlanStep = { kind: "exercise", template: "M:A", choice: "Foo", contractRef: 0, args: {} };
const createB: PlanStep = { kind: "create", template: "M:B", args: {} };

const sr = (
  index: number,
  step: PlanStep,
  status: StepResult["status"],
  detail = "",
  rejectionClass?: StepResult["rejectionClass"],
): StepResult => ({ index, step, status, detail, rejectionClass });

test("coverageOf counts accept/reject/skip per action and lists the space denominator", () => {
  const cov = coverageOf(space, [
    sr(0, createA, "accepted", "update-1"),
    sr(1, createA, "accepted", "update-2"),
    sr(2, fooA, "rejected", "DAML_AUTHORIZATION_ERROR: requires authorizers", "authorization"),
    sr(3, createB, "skipped", "no live parent"),
  ]);

  // Every action in the space is present, zeros included.
  assert.deepEqual(Object.keys(cov.actions), ["create M:A", "exercise M:A Foo", "create M:B"]);
  assert.deepEqual(cov.actions["create M:A"], { accepted: 2, rejected: 0, skipped: 0 });
  assert.deepEqual(cov.actions["exercise M:A Foo"], { accepted: 0, rejected: 1, skipped: 0 });
  assert.deepEqual(cov.actions["create M:B"], { accepted: 0, rejected: 0, skipped: 1 });

  // Never-accepted gap list, in space order.
  assert.deepEqual(cov.neverAccepted, ["exercise M:A Foo", "create M:B"]);
  assert.deepEqual(cov.rejectionClasses, { authorization: 1 });
});

test("coverageOf classifies rejections from detail when rejectionClass is absent", () => {
  const cov = coverageOf(space, [
    sr(0, fooA, "rejected", "CONTRACT_NOT_FOUND: not visible to 'Eve'"),
    sr(1, fooA, "rejected", "Assertion failed"),
    sr(2, fooA, "rejected", "totally unknown payload"),
  ]);
  assert.deepEqual(cov.rejectionClasses, { visibility: 1, "contract-logic": 1, other: 1 });
});

// --------------------------------------------------- coverageSummary ----

test("coverageSummary reports reached/total, the gap, and rejection classes", () => {
  const cov = coverageOf(space, [
    sr(0, createA, "accepted", "update-1"),
    sr(1, fooA, "rejected", "", "authorization"),
  ]);
  const summary = coverageSummary(cov);
  assert.match(summary, /1\/3 action\(s\) accepted at least once/);
  assert.match(summary, /never accepted: exercise M:A Foo, create M:B/);
  assert.match(summary, /rejections: authorization 1/);
});

test("coverageSummary omits the gap line when everything was accepted", () => {
  const cov = coverageOf(space, [
    sr(0, createA, "accepted", ""),
    sr(1, fooA, "accepted", ""),
    sr(2, createB, "accepted", ""),
  ]);
  const summary = coverageSummary(cov);
  assert.match(summary, /3\/3 action\(s\) accepted/);
  assert.doesNotMatch(summary, /never accepted/);
});
