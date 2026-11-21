// Active contracts come back in CREATION order, not contract-id order.
// Contract ids are hashes that change on every replay; ordering by them made
// { contractRef } pick a different contract per replay, so shrinking saw
// flaky reproductions (a 40-step plan once got stuck at 36).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { LedgerClient } from "../src/ledger.ts";

const ev = (contractId: string, offset?: number, nodeId?: number) => ({
  contractEntry: {
    JsActiveContract: {
      createdEvent: {
        contractId,
        templateId: "pkg:M:T",
        createArgument: { id: contractId },
        ...(offset === undefined ? {} : { offset }),
        ...(nodeId === undefined ? {} : { nodeId }),
      },
    },
  },
});

async function withLedger(acs: unknown[], fn: (c: LedgerClient) => Promise<void>) {
  const srv = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v2/state/ledger-end") return res.end(JSON.stringify({ offset: 99 }));
    req.resume();
    req.on("end", () => res.end(JSON.stringify(acs)));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    await fn(new LedgerClient(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`));
  } finally {
    srv.close();
  }
}

test("orders by creation offset, then node id, regardless of contract id", async () => {
  await withLedger([ev("aa", 9, 0), ev("ff", 3, 1), ev("00", 3, 0), ev("bb", 5, 0)], async (c) => {
    const ids = (await c.activeContracts(["p"], "pkg:M:T")).map((x) => x.contractId);
    assert.deepEqual(ids, ["00", "ff", "bb", "aa"]);
  });
});

test("same creation history, different hashes → same pick by index", async () => {
  const pick = async (acs: unknown[]) => {
    let out = "";
    await withLedger(acs, async (c) => {
      out = String((await c.activeContracts(["p"], "pkg:M:T"))[1].payload.id);
    });
    return out;
  };
  // Replay 1 and replay 2 created the same contracts at the same offsets,
  // but the hashes sort the opposite way.
  assert.equal(await pick([ev("zz-first", 1), ev("aa-second", 2)]), "aa-second");
  assert.equal(await pick([ev("aa-first", 1), ev("zz-second", 2)]), "zz-second");
});

test("falls back to contract id when the ledger omits offsets", async () => {
  await withLedger([ev("c"), ev("a"), ev("b")], async (c) => {
    const ids = (await c.activeContracts(["p"], "pkg:M:T")).map((x) => x.contractId);
    assert.deepEqual(ids, ["a", "b", "c"]);
  });
});
