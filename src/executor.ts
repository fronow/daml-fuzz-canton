// The executor: symbolic plan in, live ledger effects + step report out.
//
// This is where the symbolic references become concrete, at the last
// possible moment (the property that makes shrinking and replay work):
//   * partyRef  → the run's actor list (parties allocated with RUN-UNIQUE
//                 hints — parties persist on a real participant, so reusing
//                 hints across runs collides).
//   * contractRef → index modulo the LIVE contracts of the step's template,
//                 read from the ACS at submission time.
//   * { frac }  → frac × the target contract's first numeric/int field
//                 (valid-shaped splits and off-by-one magnets); formatted to
//                 the argument's own scale.
//   * { abs }   → passed through (Daml-JSON numerics are strings already).
//
// Submissions actAs ALL run actors by default: any controller among the
// actors authorizes, so rejections are contract-logic verdicts
// (ensure/assert), which is the signal the oracle will consume. In
// AUTH-FUZZ mode a step carries its own actor subset (step.actAs, indexes),
// the ledger's authorization checks go live, and rejections are classified —
// an oracle violation found this way is exploitable by that subset alone.
//
// A step that cannot be made concrete (no live contract, unsupported type)
// is reported as skipped — never silently dropped — so coverage stays honest.

import type { ArgValue, Plan, PlanStep } from "./generator.ts";
import type {
  ActionSpace,
  ActionSpaceField,
  ActionSpaceTemplate,
} from "./introspect.ts";
import type { ActiveContract, LedgerApi, LedgerCommand } from "./ledger.ts";
import type { TypeDesc } from "./lfparse.ts";
import {
  holdingAdapter,
  parseQuantity,
  runPack,
  snapshotHoldings,
  type Property,
  type Violation,
} from "./oracle.ts";
import { classifyRejection, type RejectionClass } from "./coverage.ts";

export interface StepResult {
  index: number;
  step: PlanStep;
  status: "accepted" | "rejected" | "skipped";
  /** updateId when accepted, ledger cause when rejected, reason when skipped. */
  detail: string;
  /** Set on rejections: authorization / visibility / contract-logic / other. */
  rejectionClass?: RejectionClass;
  /** Set when the oracle pack flagged this step (run stops here). */
  violation?: Violation;
}

export interface RunReport {
  runId: string;
  seed: string;
  package: string;
  parties: string[];
  results: StepResult[];
  accepted: number;
  rejected: number;
  skipped: number;
  /** First oracle violation; the run stops on it. `template` is part of the
   * failure signature for shrinking — same property on a different template
   * is a different bug, not a smaller reproduction. */
  violation?: Violation & { stepIndex: number; template: string };
}

export interface ExecOptions {
  /** Uniquifies party hints and command ids; defaults to a time-based tag. */
  runId?: string;
  /** Called after each step — progress reporting. */
  onStep?: (r: StepResult) => void;
  /** Oracle property pack. When set, the executor tracks expected supply per
   * template (accepted creates add their quantity; exercises must conserve),
   * checks the stepped template after every ACCEPTED step, and stops at the
   * first violation — that prefix is what the shrinker minimizes. */
  pack?: Property[];
  /** Privacy sweep. When true the executor allocates one extra "outsider"
   * party that generation never uses, and after every accepted step checks
   * that this uninvolved party can observe NO contract. Any contract visible
   * to it is an over-disclosure. Sound (a party that took no part must see
   * nothing on a correct contract); catches broad disclosure leaks. */
  privacy?: boolean;
}

/** Thrown during resolution when a step can't be made concrete. */
class Skip extends Error {}

/** What nested/reference values resolve against: the action space's records
 * table, a per-step contract lookup (ref = canonical template/interface id,
 * prefetched from the ACS before resolution), and the exercised contract's
 * payload for { targetParty } args. */
export interface ResolveEnv {
  records: Record<string, ActionSpaceField[]>;
  cid: (ref: string, index: number) => ActiveContract;
  /** Payload of the exercised contract; absent on create steps. */
  target?: Record<string, unknown>;
  /** Best-effort holder of a picked contract: the last party field when its
   * template is in the action space, else a payload/view `owner`. */
  holderOf: (c: ActiveContract) => string | null;
}

/** Contract picks per field name at ONE record level — what { ownerOf }
 * references (sender ↔ inputHoldingCids live in the same record). */
type PickScope = { picks: Map<string, ActiveContract[]>; field: string };

const MAX_NUMERIC_SCALE = 10;

function formatNumeric(x: number, scale: number): string {
  return x.toFixed(Math.min(Math.max(scale, 0), MAX_NUMERIC_SCALE));
}

/** First numeric/int field of the template = the frac base (the same
 * "first amount-like field" convention the Daml prototypes used). */
function fracBaseOf(t: ActionSpaceTemplate, payload: Record<string, unknown>): number | null {
  for (const f of t.fields) {
    if (f.type.kind !== "numeric" && f.type.kind !== "int") continue;
    const v = payload[f.name];
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function resolveValue(
  type: TypeDesc,
  v: ArgValue,
  parties: string[],
  fracBase: number | null,
  env?: ResolveEnv,
  scope?: PickScope,
): unknown {
  if ("partyRef" in v) return parties[v.partyRef % parties.length];
  if ("abs" in v) return v.abs;
  if ("frac" in v) {
    if (fracBase === null) throw new Skip("frac arg but target has no numeric field");
    const x = fracBase * v.frac;
    if (type.kind === "int") return String(Math.floor(x));
    return formatNumeric(x, type.kind === "numeric" ? type.scale : MAX_NUMERIC_SCALE);
  }
  if ("text" in v) return v.text;
  if ("bool" in v) return v.bool;
  if ("targetParty" in v) {
    if (type.kind !== "party") throw new Skip(`targetParty for ${type.kind} field`);
    const p = env?.target?.[v.targetParty];
    if (typeof p !== "string")
      throw new Skip(`targetParty(${v.targetParty}) is not a party on the target payload`);
    return p;
  }
  if ("optional" in v) {
    if (type.kind !== "optional") throw new Skip(`optional value for ${type.kind} field`);
    return v.optional === null
      ? null
      : resolveValue(type.of, v.optional, parties, fracBase, env, scope);
  }
  if ("list" in v) {
    if (type.kind !== "list") throw new Skip(`list value for ${type.kind} field`);
    return v.list.map((x) => resolveValue(type.of, x, parties, fracBase, env, scope));
  }
  if ("record" in v) {
    if (type.kind !== "record") throw new Skip(`record value for ${type.kind} field`);
    const fields = env?.records[type.ref];
    if (!fields) throw new Skip(`no record definition for ${type.ref}`);
    return resolveArgs(fields, v.record, parties, fracBase, env);
  }
  // Daml-JSON: TextMap is an object, GenMap is a list of [key, value] pairs.
  if ("emptyMap" in v) {
    if (type.kind === "textmap") return {};
    if (type.kind === "genmap") return [];
    throw new Skip(`emptyMap value for ${type.kind} field`);
  }
  if ("contractRef" in v) {
    if (type.kind !== "contractId") throw new Skip(`contractRef for ${type.kind} field`);
    if (!env) throw new Skip("contractRef arg but no contract lookup available");
    const c = env.cid(type.of, v.contractRef);
    if (scope) {
      const list = scope.picks.get(scope.field) ?? [];
      list.push(c);
      scope.picks.set(scope.field, list);
    }
    return c.contractId;
  }
  throw new Skip(`unsupported argument type: ${(v as { unsupported: string }).unsupported}`);
}

/** Resolve one record level (top-level choice/create args or a nested
 * record) in two passes: everything else first — recording which contracts
 * the level's contractRef fields picked — then { ownerOf } parties, which
 * read those picks. */
function resolveArgs(
  fields: ActionSpaceField[],
  args: Record<string, ArgValue>,
  parties: string[],
  fracBase: number | null,
  env?: ResolveEnv,
): Record<string, unknown> {
  const picks = new Map<string, ActiveContract[]>();
  const out: Record<string, unknown> = {};
  const deferred: Array<[string, { ownerOf: string }]> = [];

  for (const [name, v] of Object.entries(args)) {
    const field = fields.find((f) => f.name === name);
    if (!field) throw new Skip(`plan arg ${name} not in action space (space/plan mismatch?)`);
    if (typeof v === "object" && v !== null && "ownerOf" in v) {
      if (field.type.kind !== "party") throw new Skip(`ownerOf for ${field.type.kind} field`);
      deferred.push([name, v]);
      continue;
    }
    out[name] = resolveValue(field.type, v, parties, fracBase, env, { picks, field: name });
  }

  for (const [name, v] of deferred) {
    const picked = picks.get(v.ownerOf);
    if (!picked || picked.length === 0)
      throw new Skip(`ownerOf(${v.ownerOf}): no contract was picked for that field`);
    const holder = env?.holderOf(picked[0]);
    if (!holder) throw new Skip(`ownerOf(${v.ownerOf}): cannot determine the holder`);
    out[name] = holder;
  }
  return out;
}

/** Canonical ids of every template/interface a step's contractRef arguments
 * point at — these need an ACS snapshot before resolution can run. */
function collectCidRefs(
  fields: ActionSpaceField[],
  args: Record<string, ArgValue>,
  records: Record<string, ActionSpaceField[]>,
  out = new Set<string>(),
): Set<string> {
  const walk = (type: TypeDesc, v: ArgValue): void => {
    if ("contractRef" in v && type.kind === "contractId") out.add(type.of);
    else if ("optional" in v && type.kind === "optional" && v.optional)
      walk(type.of, v.optional);
    else if ("list" in v && type.kind === "list") v.list.forEach((x) => walk(type.of, x));
    else if ("record" in v && type.kind === "record") {
      const fs = records[type.ref];
      if (fs) collectCidRefs(fs, v.record, records, out);
    }
  };
  for (const [name, v] of Object.entries(args)) {
    const f = fields.find((x) => x.name === name);
    if (f) walk(f.type, v);
  }
  return out;
}

export async function executePlan(
  api: LedgerApi,
  space: ActionSpace,
  plan: Plan,
  opts: ExecOptions = {},
): Promise<RunReport> {
  const runId = opts.runId ?? Date.now().toString(36);
  const byName = new Map(space.templates.map((t) => [`${t.module}:${t.name}`, t]));
  // Templates carry their own packageId since multi-package DARs; older
  // action-space JSONs only have the space-level one.
  const qualified = (t: ActionSpaceTemplate) =>
    `${t.packageId ?? space.packageId}:${t.module}:${t.name}`;
  const interfaceIds = new Set(space.interfaces ?? []);
  const records = space.records ?? {};

  // Holder of a picked contract, for { ownerOf } args: the last party field
  // (the oracle's holder convention) when the contract's template is in the
  // action space; otherwise a payload/interface-view `owner` if present.
  const lastPartyField = new Map<string, string>();
  for (const tt of space.templates)
    if (tt.partyFields.length > 0)
      lastPartyField.set(qualified(tt), tt.partyFields[tt.partyFields.length - 1]);
  const holderOf = (c: ActiveContract): string | null => {
    const p = c.payload[lastPartyField.get(c.templateId) ?? "owner"];
    return typeof p === "string" ? p : null;
  };

  /** ACS snapshots for the current step's contractRef arguments. */
  const makeEnv = async (
    parties: string[],
    refs: Set<string>,
    target?: Record<string, unknown>,
  ): Promise<ResolveEnv> => {
    const snapshots = new Map<string, ActiveContract[]>();
    for (const ref of refs)
      snapshots.set(
        ref,
        await api.activeContracts(parties, ref, interfaceIds.has(ref) ? "interface" : "template"),
      );
    return {
      records,
      target,
      holderOf,
      cid: (ref, index) => {
        const live = snapshots.get(ref);
        if (!live || live.length === 0)
          throw new Skip(`no live ${ref} contracts for a contract-id argument`);
        return live[index % live.length];
      },
    };
  };

  const parties: string[] = [];
  for (let i = 0; i < plan.actorCount; i++)
    parties.push(await api.allocateParty(`fuzz-${runId}-a${i}`));

  // Privacy sweep: an extra party generation NEVER uses (it is not in the
  // partyRef space [0, actorCount)). On correct contracts it is a stakeholder
  // of nothing and must see nothing; anything it can observe is a leak.
  const outsider = opts.privacy ? await api.allocateParty(`fuzz-${runId}-obs`) : null;

  const results: StepResult[] = [];
  const push = (r: StepResult) => {
    results.push(r);
    opts.onStep?.(r);
  };

  // Oracle state: expected total quantity per template ("Module:Name").
  const supplies = new Map<string, bigint>();
  let violation: RunReport["violation"];

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const t = byName.get(step.template);
    if (!t) {
      push({ index: i, step, status: "skipped", detail: `unknown template ${step.template}` });
      continue;
    }

    let command: LedgerCommand;
    try {
      if (step.kind === "create") {
        const env = await makeEnv(parties, collectCidRefs(t.fields, step.args, records));
        command = {
          CreateCommand: {
            templateId: qualified(t),
            createArguments: resolveArgs(t.fields, step.args, parties, null, env),
          },
        };
      } else {
        const live = await api.activeContracts(parties, qualified(t));
        if (live.length === 0) throw new Skip(`no live ${step.template} contracts`);
        const target = live[step.contractRef % live.length];
        const choice = t.choices.find((c) => c.name === step.choice);
        if (!choice) throw new Skip(`unknown choice ${step.choice}`);
        // choice.args === null (arg record in another package): submit the
        // plan's empty record and let the ledger judge — a rejection there
        // is data, a silent skip would hide the action-space gap.
        const env = choice.args
          ? await makeEnv(parties, collectCidRefs(choice.args, step.args, records), target.payload)
          : undefined;
        const choiceArgument = choice.args
          ? resolveArgs(choice.args, step.args, parties, fracBaseOf(t, target.payload), env)
          : {};
        command = {
          ExerciseCommand: {
            // An interface choice is exercised with the INTERFACE as the
            // templateId — the contract id still comes from the template ACS.
            templateId: choice.interfaceId ?? qualified(t),
            contractId: target.contractId,
            choice: step.choice,
            choiceArgument,
          },
        };
      }
    } catch (e) {
      if (e instanceof Skip) {
        push({ index: i, step, status: "skipped", detail: e.message });
        continue;
      }
      throw e;
    }

    // Auth-fuzz: the step's own submitter subset (actor indexes, wrapped
    // like partyRef, deduped). Classic steps submit as all actors.
    const actAs = step.actAs
      ? [...new Set(step.actAs.map((a) => parties[a % parties.length]))]
      : parties;
    const res = await api.submitAndWait({
      commands: [command],
      commandId: `fuzz-${runId}-${i}`,
      actAs,
    });
    if (!res.ok) {
      push({
        index: i,
        step,
        status: "rejected",
        detail: res.error,
        rejectionClass: classifyRejection(res.error),
      });
      continue;
    }
    const result: StepResult = { index: i, step, status: "accepted", detail: res.updateId };

    if (opts.pack) {
      const adapter = holdingAdapter(t);
      if (adapter && "CreateCommand" in command) {
        const q = (command.CreateCommand.createArguments as Record<string, unknown>)[
          adapter.quantityField
        ];
        supplies.set(
          step.template,
          (supplies.get(step.template) ?? 0n) + parseQuantity(String(q)),
        );
      }
      // Check EVERY measurable template, not just the stepped one: an
      // interface choice on a factory moves value in holdings of a
      // DIFFERENT template (the token-standard shape).
      for (const tt of space.templates) {
        const ad = holdingAdapter(tt);
        if (!ad) continue;
        const key = `${tt.module}:${tt.name}`;
        const live = await api.activeContracts(parties, qualified(tt));
        const v = runPack(opts.pack, supplies.get(key) ?? 0n, snapshotHoldings(ad, live));
        if (v) {
          result.violation = v;
          // `template` = the template whose invariant broke (the failure
          // signature for shrinking), not necessarily the stepped one.
          violation = { ...v, stepIndex: i, template: key };
          break;
        }
      }
    }

    // Privacy: the uninvolved outsider must observe nothing.
    if (outsider && !result.violation) {
      for (const tt of space.templates) {
        const key = `${tt.module}:${tt.name}`;
        const seen = await api.activeContracts([outsider], qualified(tt));
        if (seen.length > 0) {
          const v = {
            property: "privacy-disclosure",
            why: `a party that took no part can observe ${seen.length} ${key} contract(s)`,
          };
          result.violation = v;
          violation = { ...v, stepIndex: i, template: key };
          break;
        }
      }
    }

    push(result);
    if (violation) break;
  }

  const count = (s: StepResult["status"]) => results.filter((r) => r.status === s).length;
  return {
    runId,
    seed: plan.seed,
    package: plan.package,
    parties,
    results,
    accepted: count("accepted"),
    rejected: count("rejected"),
    skipped: count("skipped"),
    ...(violation ? { violation } : {}),
  };
}
