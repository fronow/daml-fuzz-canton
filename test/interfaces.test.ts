// Interface + multi-package tests, on a compact synthetic pair of dumps
// shaped exactly like the Canton Network Token Standard DARs: an "api"
// package that defines an interface (with `non-consuming` choices and
// cross-package record refs) and a "main" package whose template implements
// it via `interface instance ... for ...`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { executePlan, resolveValue } from "../src/executor.ts";
import type { Plan } from "../src/generator.ts";
import { generatePlan } from "../src/generator.ts";
import { buildActionSpace, type ActionSpace } from "../src/introspect.ts";
import { parseInspectDump, parseType } from "../src/lfparse.ts";
import type { ActiveContract, LedgerApi, LedgerCommand, SubmitResult } from "../src/ledger.ts";

const API_PKG = "aaaa000000000000000000000000000000000000000000000000000000000000";
const MAIN_PKG = "bbbb000000000000000000000000000000000000000000000000000000000000";
const STDLIB_PKG = "9e70a8b3510d617f8a136213f33d6a903a10ca0eeec76bb06ba55d1ed9680f69";

const API_DUMP = `package ${API_PKG}
daml-lf 2.1
metadata fake-api-1.0.0

module Api.TokenV1 where
record @serializable Transfer =
  {sender : Party;
   receiver : Party;
   amount : Numeric 10;
   inputCids : List (ContractId Api.TokenV1:IHolding);
   meta : TextMap Text;
   tags : GenMap Party Text}
record @serializable Factory_Move =
  {expectedAdmin : Party; transfer : Api.TokenV1:Transfer}
interface IHolding this where
  viewtype Api.TokenV1:Transfer
  consuming choice Archive (self : ContractId Api.TokenV1:IHolding) (arg : ${STDLIB_PKG}:DA.Internal.Template:Archive) : Unit
    controller x
    do y
interface IFactory this where
  viewtype Api.TokenV1:Transfer
  method factory_moveImpl : Unit
  consuming choice Archive (self : ContractId Api.TokenV1:IFactory) (arg : ${STDLIB_PKG}:DA.Internal.Template:Archive) : Unit
    controller x
    do y
  non-consuming choice Factory_Move (self : ContractId Api.TokenV1:IFactory) (arg : Api.TokenV1:Factory_Move) : Unit
    controller x
    do y
`;

const MAIN_DUMP = `package ${MAIN_PKG}
daml-lf 2.1
metadata fake-main-1.0.0

module Main where
record @serializable Hold = {issuer : Party; owner : Party; amount : Numeric 10}
record @serializable Fac = {admin : Party}
template Hold this where
  signatory Main:$sig this
  interface instance ${API_PKG}:Api.TokenV1:IHolding for Main:Hold
  consuming choice Archive (self : ContractId Main:Hold) (arg : ${STDLIB_PKG}:DA.Internal.Template:Archive) : Unit
    controller x
    do y
template Fac this where
  signatory Main:$sig2 this
  interface instance ${API_PKG}:Api.TokenV1:IFactory for Main:Fac
    factory_moveImpl = Main:$impl this
  consuming choice Archive (self : ContractId Main:Fac) (arg : ${STDLIB_PKG}:DA.Internal.Template:Archive) : Unit
    controller x
    do y
`;

const models = () => [parseInspectDump(MAIN_DUMP), parseInspectDump(API_DUMP)];

test("parser: interface blocks, non-consuming choices, instance refs", () => {
  const api = parseInspectDump(API_DUMP);
  assert.deepEqual([...api.interfaces.keys()].sort(), ["Api.TokenV1:IFactory", "Api.TokenV1:IHolding"]);
  const fac = api.interfaces.get("Api.TokenV1:IFactory")!;
  assert.deepEqual(fac.choices.map((c) => [c.name, c.consuming]), [
    ["Archive", true],
    ["Factory_Move", false],
  ]);

  const main = parseInspectDump(MAIN_DUMP);
  assert.deepEqual(main.templates.map((t) => t.implements), [
    [`${API_PKG}:Api.TokenV1:IHolding`],
    [`${API_PKG}:Api.TokenV1:IFactory`],
  ]);
});

test("parser: map types are their own kinds, not unsupported", () => {
  assert.deepEqual(parseType("TextMap Text"), { kind: "textmap" });
  assert.deepEqual(parseType("GenMap Party Text"), { kind: "genmap" });
});

test("action space: interface choices land on implementing templates, canonicalized", () => {
  const space = buildActionSpace(models());
  assert.equal(space.packageId, MAIN_PKG);

  const fac = space.templates.find((t) => t.name === "Fac")!;
  assert.equal(fac.packageId, MAIN_PKG);
  // Own Archive + interface Archive both filtered; Factory_Move remains.
  assert.deepEqual(fac.choices.map((c) => c.name), ["Factory_Move"]);
  const move = fac.choices[0];
  assert.equal(move.interfaceId, `${API_PKG}:Api.TokenV1:IFactory`);
  assert.equal(move.argType, `${API_PKG}:Api.TokenV1:Factory_Move`);
  // Args resolved from the API package's records, refs canonicalized.
  assert.deepEqual(move.args!.map((f) => f.name), ["expectedAdmin", "transfer"]);
  assert.deepEqual(move.args![1].type, {
    kind: "record",
    ref: `${API_PKG}:Api.TokenV1:Transfer`,
  });

  // The records table carries the nested Transfer with canonical cid ref.
  const transfer = space.records![`${API_PKG}:Api.TokenV1:Transfer`]!;
  assert.deepEqual(transfer.find((f) => f.name === "inputCids")!.type, {
    kind: "list",
    of: { kind: "contractId", of: `${API_PKG}:Api.TokenV1:IHolding` },
  });
  assert.ok(space.interfaces!.includes(`${API_PKG}:Api.TokenV1:IHolding`));
});

test("generator: nested records, maps, and cids come out symbolic and supported", () => {
  const space = buildActionSpace(models());
  const plan = generatePlan(space, { seed: 7n, steps: 40, actorCount: 3, createPercent: 30 });
  const move = plan.steps.find((s) => s.kind === "exercise" && s.choice === "Factory_Move");
  assert.ok(move, "plan should exercise Factory_Move");
  assert.equal(JSON.stringify(plan).includes("unsupported"), false);
});

// ------------------------------------------------------- live resolution ----

class FakeLedger implements LedgerApi {
  submissions: Array<{ commands: LedgerCommand[] }> = [];
  acs = new Map<string, ActiveContract[]>();
  interfaceQueries: string[] = [];
  async allocateParty(hint: string): Promise<string> {
    return `${hint}::fake`;
  }
  async activeContracts(
    _parties: string[],
    id: string,
    kind: "template" | "interface" = "template",
  ): Promise<ActiveContract[]> {
    if (kind === "interface") this.interfaceQueries.push(id);
    return [...(this.acs.get(id) ?? [])].sort((a, b) => (a.contractId < b.contractId ? -1 : 1));
  }
  async submitAndWait(req: { commands: LedgerCommand[] }): Promise<SubmitResult> {
    this.submissions.push(req);
    return { ok: true, updateId: `u${this.submissions.length}` };
  }
}

test("executor: interface exercise uses the interface id; cid args resolve from the interface ACS", async () => {
  const space = buildActionSpace(models());
  const fake = new FakeLedger();
  fake.acs.set(`${MAIN_PKG}:Main:Fac`, [
    { contractId: "fac1", templateId: `${MAIN_PKG}:Main:Fac`, payload: { admin: "a::fake" } },
  ]);
  fake.acs.set(`${API_PKG}:Api.TokenV1:IHolding`, [
    { contractId: "h1", templateId: `${MAIN_PKG}:Main:Hold`, payload: {} },
    { contractId: "h2", templateId: `${MAIN_PKG}:Main:Hold`, payload: {} },
  ]);

  const plan: Plan = {
    seed: "1",
    actorCount: 2,
    package: "fake-main-1.0.0",
    steps: [
      {
        kind: "exercise",
        template: "Main:Fac",
        choice: "Factory_Move",
        contractRef: 0,
        args: {
          expectedAdmin: { partyRef: 0 },
          transfer: {
            record: {
              sender: { partyRef: 0 },
              receiver: { partyRef: 1 },
              amount: { abs: "5.0" },
              inputCids: { list: [{ contractRef: 3 }] }, // 3 % 2 → h2
              meta: { emptyMap: true },
              tags: { emptyMap: true },
            },
          },
        },
      },
    ],
  };

  const report = await executePlan(fake, space, plan, { runId: "ifc" });
  assert.equal(report.accepted, 1);
  assert.deepEqual(fake.interfaceQueries, [`${API_PKG}:Api.TokenV1:IHolding`]);

  const cmd = fake.submissions[0].commands[0] as { ExerciseCommand: Record<string, unknown> };
  assert.equal(cmd.ExerciseCommand.templateId, `${API_PKG}:Api.TokenV1:IFactory`);
  assert.equal(cmd.ExerciseCommand.contractId, "fac1");
  assert.deepEqual(cmd.ExerciseCommand.choiceArgument, {
    expectedAdmin: "fuzz-ifc-a0::fake",
    transfer: {
      sender: "fuzz-ifc-a0::fake",
      receiver: "fuzz-ifc-a1::fake",
      amount: "5.0",
      inputCids: ["h2"],
      meta: {},   // TextMap → object
      tags: [],   // GenMap → list of pairs
    },
  });
});

test("executor: cid arg with an empty ACS is a skip with a reason", async () => {
  const space = buildActionSpace(models());
  const fake = new FakeLedger();
  fake.acs.set(`${MAIN_PKG}:Main:Fac`, [
    { contractId: "fac1", templateId: `${MAIN_PKG}:Main:Fac`, payload: { admin: "a::fake" } },
  ]);
  const plan: Plan = {
    seed: "1",
    actorCount: 2,
    package: "fake-main-1.0.0",
    steps: [
      {
        kind: "exercise",
        template: "Main:Fac",
        choice: "Factory_Move",
        contractRef: 0,
        args: {
          expectedAdmin: { partyRef: 0 },
          transfer: {
            record: {
              sender: { partyRef: 0 },
              receiver: { partyRef: 1 },
              amount: { abs: "5.0" },
              inputCids: { list: [{ contractRef: 0 }] },
              meta: { emptyMap: true },
              tags: { emptyMap: true },
            },
          },
        },
      },
    ],
  };
  const report = await executePlan(fake, space, plan, { runId: "ifc2" });
  assert.equal(report.skipped, 1);
  assert.match(report.results[0].detail, /no live .*IHolding contracts/);
});

test("resolveValue: record value against a non-record type is a skip", () => {
  const env = {
    records: {},
    cid: () => ({ contractId: "c", templateId: "t", payload: {} }),
    holderOf: () => null,
  };
  assert.throws(() => resolveValue({ kind: "party" }, { record: {} }, ["p"], null, env));
});

test("payload-aware: targetParty reads the exercised contract, ownerOf follows the cid pick", async () => {
  const space = buildActionSpace(models());
  const fake = new FakeLedger();
  fake.acs.set(`${MAIN_PKG}:Main:Fac`, [
    { contractId: "fac1", templateId: `${MAIN_PKG}:Main:Fac`, payload: { admin: "admin::fake" } },
  ]);
  // Hold's partyFields are [issuer, owner] → holder = LAST party field.
  fake.acs.set(`${API_PKG}:Api.TokenV1:IHolding`, [
    {
      contractId: "h1",
      templateId: `${MAIN_PKG}:Main:Hold`,
      payload: { issuer: "admin::fake", owner: "carol::fake", amount: "7.0" },
    },
  ]);

  const plan: Plan = {
    seed: "1",
    actorCount: 2,
    package: "fake-main-1.0.0",
    steps: [
      {
        kind: "exercise",
        template: "Main:Fac",
        choice: "Factory_Move",
        contractRef: 0,
        args: {
          expectedAdmin: { targetParty: "admin" },
          transfer: {
            record: {
              sender: { ownerOf: "inputCids" }, // listed BEFORE the cids: two-pass
              receiver: { partyRef: 1 },
              amount: { abs: "5.0" },
              inputCids: { list: [{ contractRef: 0 }] },
              meta: { emptyMap: true },
              tags: { emptyMap: true },
            },
          },
        },
      },
    ],
  };

  const report = await executePlan(fake, space, plan, { runId: "pa" });
  assert.equal(report.accepted, 1);
  const cmd = fake.submissions[0].commands[0] as { ExerciseCommand: Record<string, unknown> };
  const arg = cmd.ExerciseCommand.choiceArgument as Record<string, Record<string, unknown>>;
  assert.equal(arg.expectedAdmin, "admin::fake"); // from fac1's payload, not an actor
  assert.equal(arg.transfer.sender, "carol::fake"); // owner of the picked h1
  assert.deepEqual(arg.transfer.inputCids, ["h1"]);
});

test("payload-aware skips carry reasons: missing target field / empty pick", async () => {
  const space = buildActionSpace(models());
  const fake = new FakeLedger();
  fake.acs.set(`${MAIN_PKG}:Main:Fac`, [
    { contractId: "fac1", templateId: `${MAIN_PKG}:Main:Fac`, payload: { admin: "admin::fake" } },
  ]);
  const mkStep = (transfer: Record<string, unknown>): Plan["steps"][0] => ({
    kind: "exercise",
    template: "Main:Fac",
    choice: "Factory_Move",
    contractRef: 0,
    args: {
      expectedAdmin: { partyRef: 0 },
      transfer: { record: transfer } as never,
    },
  });
  const plan: Plan = {
    seed: "1",
    actorCount: 2,
    package: "fake-main-1.0.0",
    steps: [
      // targetParty naming a field the target payload doesn't have:
      {
        ...mkStep({}),
        args: { expectedAdmin: { targetParty: "nope" }, transfer: { record: {} } },
      } as never,
      // ownerOf over an empty cid list (nothing picked):
      mkStep({
        sender: { ownerOf: "inputCids" },
        receiver: { partyRef: 1 },
        amount: { abs: "5.0" },
        inputCids: { list: [] },
        meta: { emptyMap: true },
        tags: { emptyMap: true },
      }),
    ],
  };
  const report = await executePlan(fake, space, plan, { runId: "pa2" });
  assert.equal(report.skipped, 2);
  assert.match(report.results[0].detail, /targetParty\(nope\)/);
  assert.match(report.results[1].detail, /ownerOf\(inputCids\): no contract was picked/);
});
