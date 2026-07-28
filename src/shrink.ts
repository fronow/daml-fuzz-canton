// The shrinker: greedy delta-debugging to a fixpoint — the mechanism proven
// in next/m2-shrink's Shrink.daml (12 random steps → 1), ported unchanged:
//
//   one pass: for each position, drop the step and replay; if the SAME
//   property still breaks, the step was noise — keep the drop and retry the
//   same position. If the violation disappears, the step is load-bearing.
//   Repeat passes until a pass removes nothing.
//
// Replays work at all because plans are symbolic (index-based refs resolve
// against whatever state the shorter plan produces) and each replay runs
// with FRESH parties — fresh parties = fresh world, even on a dirty ledger.
// The failure signature is the violated property's NAME: a shrunk plan that
// fails a different property is a different bug, not a smaller reproduction.

import type { Plan } from "./generator.ts";

export interface ShrinkResult {
  minimal: Plan;
  /** Replays performed (each is a full plan execution). */
  attempts: number;
  originalSteps: number;
}

const dropAt = (plan: Plan, i: number): Plan => ({
  ...plan,
  steps: [...plan.steps.slice(0, i), ...plan.steps.slice(i + 1)],
});

/**
 * @param stillFails replay `candidate` from scratch and report whether the
 *   original property is violated again (fresh runId per call!).
 */
export async function shrinkPlan(
  plan: Plan,
  stillFails: (candidate: Plan) => Promise<boolean>,
  onAttempt?: (attempt: number, keptSteps: number) => void,
): Promise<ShrinkResult> {
  let current = plan;
  let attempts = 0;
  for (;;) {
    const before = current.steps.length;
    let i = 0;
    while (i < current.steps.length) {
      const candidate = dropAt(current, i);
      attempts++;
      if (await stillFails(candidate)) {
        current = candidate; // step i was noise: drop it, retry same position
      } else {
        i++; // step i is load-bearing: keep it
      }
      onAttempt?.(attempts, current.steps.length);
    }
    if (current.steps.length === before) break; // fixpoint
  }
  return { minimal: current, attempts, originalSteps: plan.steps.length };
}
