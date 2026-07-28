// The oracle: the property DSL ported from next2/m1-dsl's Dsl.daml.
//
// Same three mechanisms the prototype proved:
//   1. A UNIFORM SNAPSHOT (`Holding`) — who holds how much. The adapter is
//      now DERIVED from introspection (the prototype wrote it by hand):
//      quantity = the template's first numeric/int field, holder = its last
//      party field (the owner/holder convention: signatory first, holder
//      last — true of every contract in the zoo and of the token standard).
//   2. PROPERTIES AS DATA — a name plus a check over (expected supply,
//      holdings). The starter pack: conservation-of-value, non-negativity.
//   3. The generic loop lives in the executor: it tracks expected supply
//      (accepted creates add their quantity; exercises must conserve) and
//      runs the pack against the stepped template after every accepted step.
//
// Quantities are scale-10 fixed-point BigInt — Daml Decimals compared
// EXACTLY, the way the prototype's Decimal arithmetic did. Summing floats
// would manufacture 1e-16 conservation "violations" out of thin air.

import type { ActionSpaceTemplate } from "./introspect.ts";
import type { ActiveContract } from "./ledger.ts";

export const QUANTITY_SCALE = 10;
const UNIT = 10n ** BigInt(QUANTITY_SCALE);

/** Parse a Daml-JSON numeric/int string to scale-10 fixed point. */
export function parseQuantity(s: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`not a numeric literal: ${JSON.stringify(s)}`);
  const [, sign, whole, frac = ""] = m;
  const fracPadded = (frac + "0".repeat(QUANTITY_SCALE)).slice(0, QUANTITY_SCALE);
  const q = BigInt(whole) * UNIT + BigInt(fracPadded);
  return sign === "-" ? -q : q;
}

export function formatQuantity(q: bigint): string {
  const sign = q < 0n ? "-" : "";
  const abs = q < 0n ? -q : q;
  const frac = (abs % UNIT).toString().padStart(QUANTITY_SCALE, "0").replace(/0+$/, "");
  return `${sign}${abs / UNIT}${frac ? "." + frac : ".0"}`;
}

export interface Holding {
  holder: string;
  quantity: bigint;
}

export interface Property {
  name: string;
  /** Expected total supply + current holdings → violation reason, or null. */
  check(supply: bigint, holdings: Holding[]): string | null;
}

export const conservation: Property = {
  name: "conservation-of-value",
  check: (supply, hs) => {
    const total = hs.reduce((acc, h) => acc + h.quantity, 0n);
    return total === supply
      ? null
      : `expected the holdings to total ${formatQuantity(supply)} but they total ${formatQuantity(total)}`;
  },
};

export const nonNegativity: Property = {
  name: "non-negativity",
  check: (_supply, hs) =>
    hs.some((h) => h.quantity < 0n) ? "at least one holding is negative" : null,
};

export const starterPack: Property[] = [conservation, nonNegativity];

export interface Violation {
  property: string;
  why: string;
}

/** First violated property in the pack, if any (prototype's runPack). */
export function runPack(
  pack: Property[],
  supply: bigint,
  holdings: Holding[],
): Violation | null {
  for (const p of pack) {
    const why = p.check(supply, holdings);
    if (why !== null) return { property: p.name, why };
  }
  return null;
}

export interface HoldingAdapter {
  quantityField: string;
  /** null when the template has no party field (holder is then ""). */
  holderField: string | null;
}

/** Derive the snapshot adapter from introspection; null when the template
 * has no numeric/int field (nothing for the starter pack to measure). */
export function holdingAdapter(t: ActionSpaceTemplate): HoldingAdapter | null {
  const quantityField =
    t.fields.find((f) => f.type.kind === "numeric" || f.type.kind === "int")?.name ?? null;
  if (quantityField === null) return null;
  const holderField = t.partyFields.length
    ? t.partyFields[t.partyFields.length - 1]
    : null;
  return { quantityField, holderField };
}

export function snapshotHoldings(
  adapter: HoldingAdapter,
  contracts: ActiveContract[],
): Holding[] {
  return contracts.map((c) => {
    const q = c.payload[adapter.quantityField];
    return {
      holder: adapter.holderField ? String(c.payload[adapter.holderField] ?? "") : "",
      quantity: parseQuantity(typeof q === "number" ? String(q) : String(q ?? "0")),
    };
  });
}
