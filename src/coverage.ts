// Coverage observation: what the fuzzer actually reached, from the step
// results it already produces — no extra ledger calls.
//
// Two questions a run must answer honestly:
//   1. Which actions (create per template, exercise per choice) were ever
//      ACCEPTED? A choice that never got through is an action-space gap the
//      generator has to close — a clean verdict over unreached code is not
//      a verdict at all.
//   2. What did the ledger say no to? Rejections are classified so the
//      report separates authorization refusals (the auth-fuzz signal) from
//      contract-logic verdicts (the oracle's home turf) and visibility
//      failures (the submitter subset cannot see the target).
//
// Coverage is computed over the ROUND runs only — shrink replays re-execute
// prefixes of a known plan and would double-count.

import type { StepResult } from "./executor.ts";
import type { ActionSpace } from "./introspect.ts";
import type { PlanStep } from "./generator.ts";

export type RejectionClass =
  | "authorization"
  | "visibility"
  | "contract-logic"
  | "other";

/** Classify a ledger rejection by its Canton error payload. The error codes
 * are stable self-service codes (they lead the `cause` string); message
 * fragments are the fallback for older payload shapes. */
export function classifyRejection(detail: string): RejectionClass {
  if (/DAML_AUTHORIZATION_ERROR|requires authorizers|missing authorization/i.test(detail))
    return "authorization";
  if (/CONTRACT_NOT_FOUND|CONTRACT_KEY_NOT_FOUND|not visible to|could not be found/i.test(detail))
    return "visibility";
  if (
    /UNHANDLED_EXCEPTION|DAML_FAILURE|DAML_INTERPRETATION_ERROR|Assertion failed|Template precondition violated|failed due to|INVALID_ARGUMENT/i.test(
      detail,
    )
  )
    return "contract-logic";
  return "other";
}

export interface ActionCount {
  accepted: number;
  rejected: number;
  skipped: number;
}

export interface Coverage {
  /** "create Module:Name" / "exercise Module:Name Choice" → counts. Every
   * action in the space is present, zeros included — absence would hide the
   * gap this exists to expose. */
  actions: Record<string, ActionCount>;
  /** Actions never accepted, in action-space order. */
  neverAccepted: string[];
  /** Rejection classes across all counted results. */
  rejectionClasses: Partial<Record<RejectionClass, number>>;
}

export const actionKey = (step: PlanStep): string =>
  step.kind === "create"
    ? `create ${step.template}`
    : `exercise ${step.template} ${step.choice}`;

/** All actions the space offers, in space order (the coverage denominator). */
export function actionKeys(space: ActionSpace): string[] {
  const keys: string[] = [];
  for (const t of space.templates) {
    keys.push(`create ${t.module}:${t.name}`);
    for (const c of t.choices) keys.push(`exercise ${t.module}:${t.name} ${c.name}`);
  }
  return keys;
}

/** Coverage of one or more runs' step results against an action space. */
export function coverageOf(space: ActionSpace, results: StepResult[]): Coverage {
  const actions: Record<string, ActionCount> = {};
  for (const key of actionKeys(space))
    actions[key] = { accepted: 0, rejected: 0, skipped: 0 };

  const rejectionClasses: Partial<Record<RejectionClass, number>> = {};
  for (const r of results) {
    // Plans can reference actions an older space no longer has; count them
    // anyway rather than dropping data.
    const key = actionKey(r.step);
    const c = (actions[key] ??= { accepted: 0, rejected: 0, skipped: 0 });
    c[r.status]++;
    if (r.status === "rejected") {
      const klass = r.rejectionClass ?? classifyRejection(r.detail);
      rejectionClasses[klass] = (rejectionClasses[klass] ?? 0) + 1;
    }
  }

  return {
    actions,
    neverAccepted: Object.keys(actions).filter((k) => actions[k].accepted === 0),
    rejectionClasses,
  };
}

/** One-paragraph stderr summary. */
export function coverageSummary(cov: Coverage): string {
  const keys = Object.keys(cov.actions);
  const reached = keys.length - cov.neverAccepted.length;
  const lines = [`coverage: ${reached}/${keys.length} action(s) accepted at least once`];
  if (cov.neverAccepted.length > 0)
    lines.push(`  never accepted: ${cov.neverAccepted.join(", ")}`);
  const rej = Object.entries(cov.rejectionClasses);
  if (rej.length > 0)
    lines.push(`  rejections: ${rej.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  return lines.join("\n");
}
