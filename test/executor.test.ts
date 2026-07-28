// Hermetic executor tests: a fake in-memory LedgerApi stands in for the
// sandbox, so these verify RESOLUTION (symbolic → concrete) and reporting —
// the live-transport shapes are verified against a real sandbox separately.

import assert from "node:assert/strict";
import { test } from "node:test";
import { executePlan, resolveValue } from "../src/executor.ts";
import type { Plan } from "../src/generator.ts";
import type { ActionSpace } from "../src/introspect.ts";
import type { ActiveContract, LedgerApi, LedgerCommand, SubmitResult } from "../src/ledger.ts";
import { starterPack } from "../src/oracle.ts";

// ---------------------------------------------------------- resolveValue ----

const PARTIES = ["alice::ns", "bob::ns", "carol::ns"];

test("partyRef resolves into the actor list (modulo for safety)", () => {
  assert.equal(resolveValue({ kind: "party" }, { partyRef: 1 }, PARTIES, null), "bob::ns");
  assert.equal(resolveValue({ kind: "party" }, { partyRef: 4 }, PARTIES, null), "bob::ns");
});

test("abs passes through as the Daml-JSON string", () => {
  assert.equal(
    resolveValue({ kind: "numeric", scale: 10 }, { abs: "0.0000000001" }, PARTIES, null),
    "0.0000000001",
  );
  assert.equal(resolveValue({ kind: "int" }, { abs: "7" }, PARTIES, null), "7");
});

test("frac × base, formatted to the argument's own scale", () => {
  assert.equal(
    resolveValue({ kind: "numeric", scale: 10 }, { frac: 0.5 }, PARTIES, 100),
    "50.0000000000",
  );
  assert.equal(resolveValue({ kind: "numeric", scale: 2 }, { frac: 0.3 }, PARTIES, 10), "3.00");
  // Int args floor — this is how the boundary discipline reaches 0 and
  // trips "must be positive" asserts on the live ledger.
  assert.equal(resolveValue({ kind: "int" }, { frac: 0.9 }, PARTIES, 1), "0");
  assert.equal(resolveValue({ kind: "int" }, { frac: 0.5 }, PARTIES, 7), "3");
});

test("frac without a numeric base on the target is a skip, not a guess", () => {
  assert.throws(() => resolveValue({ kind: "numeric", scale: 10 }, { frac: 0.5 }, PARTIES, null));
});

test("optional, list, text, bool resolve structurally", () => {
  const optParty = { kind: "optional", of: { kind: "party" } } as const;
  assert.equal(resolveValue(optParty, { optional: null }, PARTIES, null), null);
  assert.equal(
    resolveValue(optParty, { optional: { partyRef: 0 } }, PARTIES, null),
    "alice::ns",
  );
  assert.deepEqual(
    resolveValue(
      { kind: "list", of: { kind: "int" } },
      { list: [{ abs: "1" }, { abs: "2" }] },
      PARTIES,
      null,
    ),
    ["1", "2"],
  );
  assert.equal(resolveValue({ kind: "text" }, { text: "😈" }, PARTIES, null), "😈");
  assert.equal(resolveValue({ kind: "bool" }, { bool: true }, PARTIES, null), true);
});

test("unsupported values throw (executor reports the step as skipped)", () => {
  assert.throws(() =>
    resolveValue({ kind: "record", ref: "X:Y" }, { unsupported: "X:Y" }, PARTIES, null),
  );
});

// ----------------------------------------------------------- executePlan ----

const SPACE: ActionSpace = {
  package: "fake-pkg-1.0.0",
  packageId: "pkg",
  lfVersion: "2.2",
  templates: [
    {
      module: "M",
      name: "Tok",
      fields: [
        { name: "issuer", type: { kind: "party" } },
        { name: "owner", type: { kind: "party" } },
        { name: "amount", type: { kind: "numeric", scale: 10 } },
      ],
      partyFields: ["issuer", "owner"],
      choices: [
        {
          name: "Split",
          consuming: true,
          args: [{ name: "splitAmount", type: { kind: "numeric", scale: 10 } }],
          argType: "M:Split",
          returns: "()",
        },
        {
          name: "Take",
          consuming: true,
          args: [{ name: "n", type: { kind: "int" } }],
          argType: "M:Take",
          returns: "()",
        },
      ],
    },
    {
      module: "M",
      name: "Empty",
      fields: [{ name: "p", type: { kind: "party" } }],
      partyFields: ["p"],
      choices: [
        { name: "Go", consuming: true, args: [], argType: "M:Go", returns: "()" },
      ],
    },
  ],
};

class FakeLedger implements LedgerApi {
  submissions: Array<{ commands: LedgerCommand[]; commandId: string; actAs: string[] }> = [];
  allocated: string[] = [];
  acs = new Map<string, ActiveContract[]>();
  /** commandIds that should be rejected. */
  reject = new Set<string>();

  async allocateParty(hint: string): Promise<string> {
    this.allocated.push(hint);
    return `${hint}::fake`;
  }
  async activeContracts(_parties: string[], templateId: string): Promise<ActiveContract[]> {
    return [...(this.acs.get(templateId) ?? [])].sort((a, b) =>
      a.contractId < b.contractId ? -1 : 1,
    );
  }
  async submitAndWait(req: {
    commands: LedgerCommand[];
    commandId: string;
    actAs: string[];
  }): Promise<SubmitResult> {
    this.submissions.push(req);
    return this.reject.has(req.commandId)
      ? { ok: false, error: "UNHANDLED_EXCEPTION: boom" }
      : { ok: true, updateId: `u${this.submissions.length}` };
  }
}

const tok = (cid: string, amount: string): ActiveContract => ({
  contractId: cid,
  templateId: "pkg:M:Tok",
  payload: { issuer: "i::fake", owner: "o::fake", amount },
});

const plan = (steps: Plan["steps"]): Plan => ({
  seed: "42",
  actorCount: 3,
  package: "fake-pkg-1.0.0",
  steps,
});

test("create: resolved args, qualified templateId, run-unique hints, actAs all", async () => {
  const fake = new FakeLedger();
  const report = await executePlan(
    fake,
    SPACE,
    plan([
      {
        kind: "create",
        template: "M:Tok",
        args: { issuer: { partyRef: 0 }, owner: { partyRef: 2 }, amount: { abs: "100.0" } },
      },
    ]),
    { runId: "t1" },
  );

  assert.deepEqual(fake.allocated, ["fuzz-t1-a0", "fuzz-t1-a1", "fuzz-t1-a2"]);
  assert.deepEqual(report.parties, ["fuzz-t1-a0::fake", "fuzz-t1-a1::fake", "fuzz-t1-a2::fake"]);

  const sub = fake.submissions[0];
  assert.equal(sub.commandId, "fuzz-t1-0");
  assert.deepEqual(sub.actAs, report.parties);
  assert.deepEqual(sub.commands, [
    {
      CreateCommand: {
        templateId: "pkg:M:Tok",
        createArguments: {
          issuer: "fuzz-t1-a0::fake",
          owner: "fuzz-t1-a2::fake",
          amount: "100.0",
        },
      },
    },
  ]);
  assert.equal(report.accepted, 1);
  assert.equal(report.results[0].status, "accepted");
});

test("exercise: contractRef modulo sorted ACS, frac from the target's amount", async () => {
  const fake = new FakeLedger();
  // Inserted out of order; sorted ACS is c1, c2, c3 — ref 5 % 3 = 2 → c3.
  fake.acs.set("pkg:M:Tok", [tok("c3", "80.0"), tok("c1", "100.0"), tok("c2", "40.0")]);

  const report = await executePlan(
    fake,
    SPACE,
    plan([
      {
        kind: "exercise",
        template: "M:Tok",
        choice: "Split",
        contractRef: 5,
        args: { splitAmount: { frac: 0.5 } },
      },
      { kind: "exercise", template: "M:Tok", choice: "Take", contractRef: 1, args: { n: { frac: 0.5 } } },
    ]),
    { runId: "t2" },
  );

  const [split, take] = fake.submissions.map(
    (s) => (s.commands[0] as { ExerciseCommand: Record<string, unknown> }).ExerciseCommand,
  );
  assert.equal(split.contractId, "c3");
  assert.deepEqual(split.choiceArgument, { splitAmount: "40.0000000000" }); // 0.5 × 80
  assert.equal(take.contractId, "c2");
  assert.deepEqual(take.choiceArgument, { n: "20" }); // floor(0.5 × 40)
  assert.equal(report.accepted, 2);
});

test("no live contracts / unsupported args → skipped with a reason, never submitted", async () => {
  const fake = new FakeLedger();
  const report = await executePlan(
    fake,
    SPACE,
    plan([
      { kind: "exercise", template: "M:Empty", choice: "Go", contractRef: 0, args: {} },
      {
        kind: "create",
        template: "M:Tok",
        args: {
          issuer: { partyRef: 0 },
          owner: { partyRef: 1 },
          amount: { unsupported: "weird" },
        },
      },
      { kind: "create", template: "M:Gone", args: {} },
    ]),
    { runId: "t3" },
  );

  assert.equal(fake.submissions.length, 0);
  assert.equal(report.skipped, 3);
  assert.match(report.results[0].detail, /no live M:Empty contracts/);
  assert.match(report.results[1].detail, /unsupported/);
  assert.match(report.results[2].detail, /unknown template/);
});

// A stateful fake: creates land in the ACS, and Split behaves like the
// planted B1 bug — the "change" contract keeps the FULL amount (inflation).
class BuggySplitLedger extends FakeLedger {
  private nextCid = 1;
  override async submitAndWait(req: {
    commands: LedgerCommand[];
    commandId: string;
    actAs: string[];
  }): Promise<SubmitResult> {
    const res = await super.submitAndWait(req);
    if (!res.ok) return res;
    const cmd = req.commands[0];
    if ("CreateCommand" in cmd) {
      const { templateId, createArguments } = cmd.CreateCommand;
      const list = this.acs.get(templateId) ?? [];
      list.push({
        contractId: `c${this.nextCid++}`,
        templateId,
        payload: createArguments as Record<string, unknown>,
      });
      this.acs.set(templateId, list);
    } else {
      const { templateId, contractId, choiceArgument } = cmd.ExerciseCommand;
      const list = this.acs.get(templateId) ?? [];
      const target = list.find((c) => c.contractId === contractId)!;
      const split = (choiceArgument as { splitAmount: string }).splitAmount;
      this.acs.set(templateId, [
        ...list.filter((c) => c.contractId !== contractId),
        { ...target, contractId: `c${this.nextCid++}`, payload: { ...target.payload, amount: split } },
        // BUG (B1 class): the change keeps the full amount.
        { ...target, contractId: `c${this.nextCid++}`, payload: { ...target.payload } },
      ]);
    }
    return res;
  }
}

test("oracle pack: buggy split trips conservation, run stops at the violation", async () => {
  const fake = new BuggySplitLedger();
  const report = await executePlan(
    fake,
    SPACE,
    plan([
      {
        kind: "create",
        template: "M:Tok",
        args: { issuer: { partyRef: 0 }, owner: { partyRef: 1 }, amount: { abs: "100.0" } },
      },
      {
        kind: "exercise",
        template: "M:Tok",
        choice: "Split",
        contractRef: 0,
        args: { splitAmount: { frac: 0.5 } },
      },
      // Never reached: the run stops at the violation above.
      {
        kind: "create",
        template: "M:Tok",
        args: { issuer: { partyRef: 0 }, owner: { partyRef: 0 }, amount: { abs: "1.0" } },
      },
    ]),
    { runId: "t5", pack: starterPack },
  );

  assert.equal(report.results.length, 2); // third step never ran
  assert.equal(report.results[0].violation, undefined); // create is clean
  assert.deepEqual(report.violation, {
    stepIndex: 1,
    template: "M:Tok",
    property: "conservation-of-value",
    why: "expected the holdings to total 100.0 but they total 150.0",
  });
  assert.equal(report.results[1].violation?.property, "conservation-of-value");
});

test("oracle pack: correct behavior stays clean (no false positives)", async () => {
  // Same ledger but a CORRECT split: patch the fake to subtract properly.
  class CorrectSplitLedger extends BuggySplitLedger {
    override async submitAndWait(req: {
      commands: LedgerCommand[];
      commandId: string;
      actAs: string[];
    }): Promise<SubmitResult> {
      const cmd = req.commands[0];
      if ("ExerciseCommand" in cmd) {
        // Recompute what the buggy parent will do, then fix the change
        // contract afterwards: simpler to just run parent and repair.
        const { templateId, contractId, choiceArgument } = cmd.ExerciseCommand;
        const before = (this.acs.get(templateId) ?? []).find(
          (c) => c.contractId === contractId,
        )!;
        const res = await super.submitAndWait(req);
        const list = this.acs.get(templateId)!;
        const change = list[list.length - 1];
        const split = Number((choiceArgument as { splitAmount: string }).splitAmount);
        change.payload = {
          ...change.payload,
          amount: (Number(before.payload.amount) - split).toFixed(1),
        };
        return res;
      }
      return super.submitAndWait(req);
    }
  }
  const fake = new CorrectSplitLedger();
  const report = await executePlan(
    fake,
    SPACE,
    plan([
      {
        kind: "create",
        template: "M:Tok",
        args: { issuer: { partyRef: 0 }, owner: { partyRef: 1 }, amount: { abs: "100.0" } },
      },
      {
        kind: "exercise",
        template: "M:Tok",
        choice: "Split",
        contractRef: 0,
        args: { splitAmount: { frac: 0.5 } },
      },
    ]),
    { runId: "t6", pack: starterPack },
  );
  assert.equal(report.violation, undefined);
  assert.equal(report.accepted, 2);
});

test("ledger rejections are recorded as data, and the run continues", async () => {
  const fake = new FakeLedger();
  fake.acs.set("pkg:M:Tok", [tok("c1", "100.0")]);
  fake.reject.add("fuzz-t4-0");

  const report = await executePlan(
    fake,
    SPACE,
    plan([
      {
        kind: "exercise",
        template: "M:Tok",
        choice: "Split",
        contractRef: 0,
        args: { splitAmount: { frac: 0.1 } },
      },
      {
        kind: "create",
        template: "M:Tok",
        args: { issuer: { partyRef: 0 }, owner: { partyRef: 0 }, amount: { abs: "1.0" } },
      },
    ]),
    { runId: "t4" },
  );

  assert.equal(report.rejected, 1);
  assert.equal(report.accepted, 1);
  assert.match(report.results[0].detail, /UNHANDLED_EXCEPTION: boom/);
  assert.equal(report.results[1].status, "accepted");
});
