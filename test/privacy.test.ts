// Hermetic tests for the privacy sweep (--privacy): after each accepted step
// the executor queries the ACS as an uninvolved "outsider" party and flags any
// contract it can observe as an over-disclosure. Both directions are checked
// with a fake ledger that answers differently for the outsider.

import assert from "node:assert/strict";
import { test } from "node:test";
import { executePlan } from "../src/executor.ts";
import type { Plan } from "../src/generator.ts";
import type { ActionSpace } from "../src/introspect.ts";
import type { ActiveContract, LedgerApi, SubmitResult } from "../src/ledger.ts";

const SPACE: ActionSpace = {
  package: "priv-pkg-1.0.0",
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
      choices: [],
    },
  ],
};

const createPlan: Plan = {
  seed: "42",
  actorCount: 2,
  package: "priv-pkg-1.0.0",
  steps: [
    {
      kind: "create",
      template: "M:Tok",
      args: { issuer: { partyRef: 0 }, owner: { partyRef: 1 }, amount: { abs: "100.0" } },
    },
  ],
};

const leaked: ActiveContract = {
  contractId: "c1",
  templateId: "pkg:M:Tok",
  payload: { issuer: "i", owner: "o", amount: "100.0" },
};

/** A fake ledger whose ACS answer depends on WHO asks: the outsider party
 * (hint contains "-obs") sees `outsiderSees`, everyone else sees nothing. */
class PrivacyFake implements LedgerApi {
  private outsiderSees: ActiveContract[];
  constructor(outsiderSees: ActiveContract[]) {
    this.outsiderSees = outsiderSees;
  }
  async allocateParty(hint: string): Promise<string> {
    return `${hint}::fake`;
  }
  async activeContracts(parties: string[], _templateId: string): Promise<ActiveContract[]> {
    const outsider = parties.some((p) => p.includes("-obs"));
    return outsider ? this.outsiderSees : [];
  }
  async submitAndWait(): Promise<SubmitResult> {
    return { ok: true, updateId: "u1" };
  }
}

test("privacy: the outsider observing a contract is flagged as a disclosure leak", async () => {
  const report = await executePlan(new PrivacyFake([leaked]), SPACE, createPlan, {
    runId: "p1",
    privacy: true,
  });
  assert.ok(report.violation, "a violation is reported");
  assert.equal(report.violation!.property, "privacy-disclosure");
  assert.match(report.violation!.why, /can observe 1 M:Tok/);
});

test("privacy: clean when the outsider observes nothing", async () => {
  const report = await executePlan(new PrivacyFake([]), SPACE, createPlan, {
    runId: "p2",
    privacy: true,
  });
  assert.equal(report.violation, undefined);
  assert.equal(report.accepted, 1);
});

test("privacy: OFF by default — no outsider party is allocated, no sweep", async () => {
  // Even if some party could see a contract, without --privacy there is no
  // outsider and no privacy violation.
  const report = await executePlan(new PrivacyFake([leaked]), SPACE, createPlan, {
    runId: "p3",
  });
  assert.equal(report.violation, undefined);
});
