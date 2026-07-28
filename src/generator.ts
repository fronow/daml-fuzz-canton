// The generator: action-space JSON in, deterministic symbolic action plan out.
//
// A plan step never contains a party id or contract id — only INDEX-BASED
// references (partyRef, contractRef) and symbolic values, resolved by the
// executor against live ledger state at submission time. This is the same
// design the Daml prototypes proved: index-based recipes survive shrinking,
// are environment-independent, and make replay reports byte-stable.
//
// Argument values follow the PoC's boundary-value discipline:
//   * party      → on create: { partyRef } (index into the run's actor list).
//                  On exercise, PAYLOAD-AWARE: also { targetParty } (a party
//                  field NAME of the exercised contract — how expectedAdmin
//                  meets the factory's admin) and { ownerOf } (the holder of
//                  the contract picked for a sibling contract-id field — how
//                  a sender comes to own the holdings it spends). Random
//                  actors keep ~a third of the mass: the adversarial cases
//                  (Eve transfers, spoofed admins) must never disappear.
//   * numeric    → on exercise: { frac } — the executor multiplies by the
//                  target contract's first numeric field (valid-shaped splits
//                  etc.); on create: { abs } from a boundary pool.
//   * int        → same shape as numeric ({ frac } / { abs }).
//   * text/bool  → small pools; timestamp/date → boundary instants.
//   * optional   → null | wrapped value; list → 0–2 elements.
//   * genmap     → always empty (also keeps variant-valued maps like the
//                  token standard's `GenMap Text AnyValue` generatable).
//   * record     → recurse into the action space's records table (nested
//                  numerics use the abs pool: the frac base belongs to the
//                  exercised contract, not to nested payloads).
//   * contractId → { contractRef } — the executor resolves it against the
//                  live contracts of the referenced template/interface.
//   * unresolved records / exotic types → step is still emitted with
//     { unsupported } so the executor can skip it (and coverage can report
//     the gap) rather than silently narrowing the action space.

import { next, roll, seedOf, type Seed } from "./prng.ts";
import type {
  ActionSpace,
  ActionSpaceChoice,
  ActionSpaceField,
  ActionSpaceTemplate,
} from "./introspect.ts";
import type { TypeDesc } from "./lfparse.ts";

export type ArgValue =
  | { partyRef: number }
  | { abs: string }
  | { frac: number }
  | { text: string }
  | { bool: boolean }
  | { optional: ArgValue | null }
  | { list: ArgValue[] }
  | { record: Record<string, ArgValue> }
  | { emptyMap: true }
  | { contractRef: number }
  /** A party field NAME of the exercised contract; the executor reads the
   * party from the target's payload at submission time. */
  | { targetParty: string }
  /** A sibling contract-id field NAME (same record level); resolves to the
   * holder of the first contract picked for that field. */
  | { ownerOf: string }
  | { unsupported: string };

export interface CreateStep {
  kind: "create";
  template: string; // "Module:Name"
  args: Record<string, ArgValue>;
  /** Auth-fuzz mode: actor INDEXES this step submits as (instead of all
   * actors). Absent = classic mode, actAs everyone. */
  actAs?: number[];
}

export interface ExerciseStep {
  kind: "exercise";
  template: string;
  choice: string;
  /** Raw index; executor resolves modulo the live contracts of `template`. */
  contractRef: number;
  args: Record<string, ArgValue>;
  /** Auth-fuzz mode: actor INDEXES this step submits as. */
  actAs?: number[];
}

export type PlanStep = CreateStep | ExerciseStep;

export interface Plan {
  seed: string; // decimal string of the initial seed (BigInt-safe in JSON)
  actorCount: number;
  package: string;
  /** Set when the plan was generated with per-step actAs subsets. */
  authFuzz?: true;
  steps: PlanStep[];
}

export interface GenOptions {
  seed: number | bigint;
  steps: number;
  actorCount: number;
  /** Ratio of create steps, in percent (default 20). */
  createPercent?: number;
  /** Authorization fuzzing: each step submits as a random 1–2 actor subset
   * instead of all actors, so the ledger's authorization checks are LIVE.
   * Any oracle violation found in this mode is exploitable by that subset
   * alone; DAML_AUTHORIZATION_ERROR rejections map the auth surface. */
  authFuzz?: boolean;
}

// Boundary pools — the values that historically find bugs (zeros, ones,
// dust-scale, off-by-one magnets, oversized).
const FRAC_POOL = [0.1, 0.3, 0.5, 0.7, 0.9] as const;
const NUMERIC_ABS_POOL = ["100.0", "1.0", "0.0000000001", "13.37"] as const;
const INT_ABS_POOL = ["100", "1", "2", "7"] as const;
const TEXT_POOL = ["", "fuzz", "0", "😈"] as const;
// Daml-JSON instants. Past/epoch/far-future: deadline logic magnets.
const TIMESTAMP_POOL = [
  "2030-01-01T00:00:00Z",
  "2026-06-01T12:00:00Z",
  "1970-01-01T00:00:00Z",
  "9999-12-30T23:59:59Z",
] as const;
const DATE_POOL = ["2030-01-01", "2026-06-01", "1970-01-01"] as const;
const CONTRACT_REF_SPACE = 97; // prime, same spirit as the Daml prototypes
/** Nested-record recursion cap — recursive types (linked lists etc.) must
 * terminate in { unsupported }, not a stack overflow. */
const MAX_RECORD_DEPTH = 4;

interface Ctx {
  s: Seed;
  actorCount: number;
  /** Canonical ref → fields, from the action space (absent in old spaces). */
  records: Record<string, ActionSpaceField[]>;
  /** Party fields of the template the CURRENT step exercises; null while
   * generating a create step (there is no target contract to reference). */
  targetPartyFields: string[] | null;
}

const step = (ctx: Ctx): Seed => (ctx.s = next(ctx.s));

/** Sibling fields (one record level) whose values are contract ids — the
 * candidates an { ownerOf } party can reference. */
const cidFieldsOf = (fields: ActionSpaceField[]): string[] =>
  fields
    .filter((f) => {
      const t = f.type.kind === "list" || f.type.kind === "optional" ? f.type.of : f.type;
      return t.kind === "contractId";
    })
    .map((f) => f.name);

function genParty(ctx: Ctx, cidSiblings: string[]): ArgValue {
  const targets = ctx.targetPartyFields;
  if (targets !== null) {
    // d10: 0–3 target's own parties, 4–6 holder of a sibling cid pick,
    // 7–9 random actor; unavailable classes fall through to the actor.
    const d = roll(step(ctx), 10);
    if (d < 4 && targets.length > 0)
      return { targetParty: targets[roll(step(ctx), targets.length)] };
    if (d < 7 && cidSiblings.length > 0)
      return { ownerOf: cidSiblings[roll(step(ctx), cidSiblings.length)] };
  }
  return { partyRef: roll(step(ctx), ctx.actorCount) };
}

function genValue(
  ctx: Ctx,
  type: TypeDesc,
  mode: "create" | "exercise",
  depth = 0,
  cidSiblings: string[] = [],
): ArgValue {
  switch (type.kind) {
    case "party":
      return genParty(ctx, cidSiblings);
    case "numeric":
      return mode === "exercise"
        ? { frac: FRAC_POOL[roll(step(ctx), FRAC_POOL.length)] }
        : { abs: NUMERIC_ABS_POOL[roll(step(ctx), NUMERIC_ABS_POOL.length)] };
    case "int":
      return mode === "exercise"
        ? { frac: FRAC_POOL[roll(step(ctx), FRAC_POOL.length)] }
        : { abs: INT_ABS_POOL[roll(step(ctx), INT_ABS_POOL.length)] };
    case "text":
      return { text: TEXT_POOL[roll(step(ctx), TEXT_POOL.length)] };
    case "bool":
      return { bool: roll(step(ctx), 2) === 1 };
    case "timestamp":
      return { abs: TIMESTAMP_POOL[roll(step(ctx), TIMESTAMP_POOL.length)] };
    case "date":
      return { abs: DATE_POOL[roll(step(ctx), DATE_POOL.length)] };
    case "genmap":
    case "textmap":
      return { emptyMap: true };
    case "contractId":
      return { contractRef: roll(step(ctx), CONTRACT_REF_SPACE) };
    case "optional":
      return roll(step(ctx), 2) === 0
        ? { optional: null }
        : { optional: genValue(ctx, type.of, mode, depth, cidSiblings) };
    case "list": {
      // Contract-id lists are never empty: a zero-input transfer is a wasted
      // step (instant reject / nothing for ownerOf to reference), and the
      // empty-list case is still probed by every non-cid list.
      const n =
        type.of.kind === "contractId" ? 1 + roll(step(ctx), 2) : roll(step(ctx), 3);
      return {
        list: Array.from({ length: n }, () => genValue(ctx, type.of, mode, depth, cidSiblings)),
      };
    }
    case "record": {
      const fields = ctx.records[type.ref];
      if (!fields || depth >= MAX_RECORD_DEPTH)
        return { unsupported: JSON.stringify(type) };
      // Nested numerics use the abs pool ("create" mode): the frac base is
      // the exercised contract's amount, which nested payloads don't have.
      return { record: genArgs(ctx, fields, "create", depth + 1) };
    }
    default:
      return { unsupported: JSON.stringify(type) };
  }
}

/** Auth-fuzz submitter subset: one random actor, with a 1-in-4 chance of a
 * second distinct one (pairs probe two-signatory flows without drowning the
 * single-submitter signal). */
function genActAs(ctx: Ctx): number[] {
  const first = roll(step(ctx), ctx.actorCount);
  if (ctx.actorCount > 1 && roll(step(ctx), 4) === 3) {
    const second = (first + 1 + roll(step(ctx), ctx.actorCount - 1)) % ctx.actorCount;
    return [first, second];
  }
  return [first];
}

const genArgs = (
  ctx: Ctx,
  fields: ActionSpaceField[],
  mode: "create" | "exercise",
  depth = 0,
): Record<string, ArgValue> => {
  const cidSiblings = cidFieldsOf(fields);
  const out: Record<string, ArgValue> = {};
  for (const f of fields) out[f.name] = genValue(ctx, f.type, mode, depth, cidSiblings);
  return out;
};

interface ExerciseTarget {
  template: ActionSpaceTemplate;
  choice: ActionSpaceChoice;
}

export function generatePlan(space: ActionSpace, opts: GenOptions): Plan {
  const createPercent = opts.createPercent ?? 20;
  const templates = space.templates;
  const exercises: ExerciseTarget[] = templates.flatMap((t) =>
    t.choices.map((choice) => ({ template: t, choice })),
  );
  if (templates.length === 0) throw new Error("action space has no templates");

  const ctx: Ctx = {
    s: seedOf(opts.seed),
    actorCount: opts.actorCount,
    records: space.records ?? {}, // pre-multi-package spaces have no table
    targetPartyFields: null,
  };
  const steps: PlanStep[] = [];

  for (let i = 0; i < opts.steps; i++) {
    const wantCreate =
      exercises.length === 0 || roll(step(ctx), 100) < createPercent;
    if (wantCreate) {
      const t = templates[roll(step(ctx), templates.length)];
      ctx.targetPartyFields = null;
      steps.push({
        kind: "create",
        template: `${t.module}:${t.name}`,
        args: genArgs(ctx, t.fields, "create"),
        // actAs is rolled AFTER the args so classic mode (no flag) consumes
        // an identical PRNG stream — old seeds keep reproducing old plans.
        ...(opts.authFuzz ? { actAs: genActAs(ctx) } : {}),
      });
    } else {
      const { template, choice } = exercises[roll(step(ctx), exercises.length)];
      ctx.targetPartyFields = template.partyFields;
      steps.push({
        kind: "exercise",
        template: `${template.module}:${template.name}`,
        choice: choice.name,
        contractRef: roll(step(ctx), CONTRACT_REF_SPACE),
        args: choice.args ? genArgs(ctx, choice.args, "exercise") : {},
        ...(opts.authFuzz ? { actAs: genActAs(ctx) } : {}),
      });
    }
  }

  return {
    seed: seedOf(opts.seed).toString(),
    actorCount: opts.actorCount,
    package: space.package,
    ...(opts.authFuzz ? { authFuzz: true as const } : {}),
    steps,
  };
}
