// Replay-report rendering: the JSON report in, one self-contained HTML page
// out. No scripts, no external assets — the page is evidence, and evidence
// must open anywhere, offline, ten years from now.
//
// The design is the one prototyped 2026-07-04 (artifact d4a06880): a
// violation banner, run tiles, the shrink strip (every original step as a
// cell — kept / accepted-but-dropped / rejected / skipped / never-reached),
// the verified minimal reproduction as step cards, the original trace as a
// table, and the replay recipe. Light and dark via prefers-color-scheme
// with data-theme overrides.

import type { ArgValue, Plan, PlanStep } from "./generator.ts";
import type { RunReport, StepResult } from "./executor.ts";
import type { Coverage } from "./coverage.ts";

/** The JSON `run` writes (violation shape or clean shape). */
export interface ReplayReport {
  tool: string;
  kind: string;
  package: string;
  packageId: string;
  baseSeed: string;
  /** Optional human context: what the target package is, in one paragraph. */
  about?: string;
  /** Optional glossary: template/choice/property name → plain-language meaning. */
  glossary?: Record<string, string>;
  clean?: boolean;
  rounds?: number;
  steps?: number;
  round?: number;
  roundSeed?: string;
  finding?: { round: number; property: string; why: string; stepIndex: number; template: string };
  shrink?: { originalSteps: number; minimalSteps: number; replays: number };
  minimalPlan?: Plan;
  verification?: RunReport;
  originalRun?: RunReport;
  coverage?: Coverage;
}

const esc = (s: unknown): string =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const shortId = (s: string): string => (s.length > 10 ? `${s.slice(0, 8)}…` : s);

// ------------------------------------------------ symbolic arg formatting --

function fmtArg(v: ArgValue): string {
  if ("partyRef" in v) return `party#${v.partyRef}`;
  if ("abs" in v) return v.abs;
  if ("frac" in v) return `${v.frac} × base`;
  if ("text" in v) return JSON.stringify(v.text);
  if ("bool" in v) return String(v.bool);
  if ("optional" in v) return v.optional === null ? "none" : `some ${fmtArg(v.optional)}`;
  if ("list" in v) return `[${v.list.map(fmtArg).join(", ")}]`;
  if ("record" in v) return fmtArgs(v.record);
  if ("emptyMap" in v) return "{}";
  if ("contractRef" in v) return `contract#${v.contractRef} % live`;
  if ("targetParty" in v) return `target.${v.targetParty}`;
  if ("ownerOf" in v) return `ownerOf(${v.ownerOf})`;
  return "⟨unsupported⟩";
}

function fmtArgs(args: Record<string, ArgValue>): string {
  const inner = Object.entries(args)
    .map(([k, v]) => `${k}: ${fmtArg(v)}`)
    .join(", ");
  return `{ ${inner} }`;
}

const stepAction = (step: PlanStep): string =>
  step.kind === "create"
    ? `create ${step.template}`
    : `exercise ${step.template} ${step.choice} #${step.contractRef}`;

const stepActAs = (step: PlanStep): string =>
  step.actAs ? ` ⊢ actAs [${step.actAs.map((i) => `party#${i}`).join(", ")}]` : "";

// ----------------------------------------------------------------- pieces --

function detailOf(r: StepResult): string {
  if (r.status === "accepted")
    return r.violation
      ? `${r.violation.property}: ${r.violation.why}`
      : `tx ${shortId(r.detail)}`;
  return r.detail.split("\n")[0];
}

function pill(r: StepResult): string {
  if (r.violation) return `<span class="pill viol">violation</span>`;
  const cls = { accepted: "acc", rejected: "rej", skipped: "skip" }[r.status];
  return `<span class="pill ${cls}">${r.status}</span>`;
}

/** Original-plan indexes whose steps survived into the minimal plan (the
 * minimal plan is an in-order subsequence of the original). */
function keptIndexes(original: StepResult[], minimal: PlanStep[]): Set<number> {
  const kept = new Set<number>();
  let from = 0;
  for (const m of minimal) {
    const want = JSON.stringify(m);
    for (let i = from; i < original.length; i++) {
      if (JSON.stringify(original[i].step) === want) {
        kept.add(original[i].index);
        from = i + 1;
        break;
      }
    }
  }
  return kept;
}

function aboutSection(r: ReplayReport): string {
  if (!r.about && !r.glossary) return "";
  const rows = Object.entries(r.glossary ?? {})
    .map(
      ([term, meaning]) => `
      <tr><td class="act">${esc(term)}</td><td class="def">${esc(meaning)}</td></tr>`,
    )
    .join("");
  return `
  <section>
    <h2>About the target</h2>
    ${r.about ? `<p>${esc(r.about)}</p>` : ""}
    ${rows ? `<div class="tablewrap"><table><tbody>${rows}</tbody></table></div>` : ""}
  </section>`;
}

/** Explains the symbolic notation used in step cards and the trace. */
function notationNote(): string {
  return `
    <div class="legend notation">
      <span><code>party#0</code> the run's first freshly allocated party</span>
      <span><code>contract#13 % live</code> pick 13 modulo the contracts live at that step</span>
      <span><code>target.admin</code> the party in the <code>admin</code> field of the exercised contract</span>
      <span><code>ownerOf(f)</code> the owner of the holding chosen for field <code>f</code></span>
    </div>`;
}

function shrinkStrip(r: ReplayReport): string {
  const results = r.originalRun!.results;
  const total = r.shrink!.originalSteps;
  const kept = keptIndexes(results, r.minimalPlan!.steps);
  const byIndex = new Map(results.map((x) => [x.index, x]));
  const cells: string[] = [];
  for (let i = 0; i < total; i++) {
    const res = byIndex.get(i);
    let cls: string;
    let title: string;
    if (!res) {
      cls = "unreached";
      title = `${i} never reached`;
    } else if (kept.has(i)) {
      cls = "kept";
      title = `${i} ${res.status} — KEPT: ${stepAction(res.step)}`;
    } else {
      cls = { accepted: "acc", rejected: "rej", skipped: "skip" }[res.status];
      title = `${i} ${res.status}`;
    }
    cells.push(`<div class="cell ${cls}" title="${esc(title)}"></div>`);
  }
  return `
  <section>
    <h2>Shrink — ${total} steps → ${r.shrink!.minimalSteps}</h2>
    <p class="note">Greedy delta-debugging over the symbolic plan: drop a step, replay
    from scratch with fresh parties, keep the drop if the same property still fails on
    the same template. ${r.shrink!.minimalSteps} step(s) survived ${r.shrink!.replays} replays.</p>
    <div class="strip">${cells.join("")}</div>
    <div class="legend">
      <span><i style="background: var(--crit);"></i> survived shrinking (the reproduction)</span>
      <span><i style="background: var(--ok); opacity:.45;"></i> accepted, dropped as noise</span>
      <span><i style="background: var(--crit); opacity:.35;"></i> rejected by the ledger</span>
      <span><i style="background: var(--mute-cell);"></i> skipped (no live target)</span>
      <span><i style="border: 1px dashed var(--line);"></i> after the violation — never ran</span>
    </div>
  </section>`;
}

function minimalSection(r: ReplayReport): string {
  const verification = r.verification!;
  const cards = verification.results
    .map((res) => {
      const step = res.step;
      const viol = res.violation;
      return `
      <div class="stepcard${viol ? " viol" : ""}">
        <span class="idx">[${res.index}]</span> <span class="kind">${esc(step.kind)}</span> ${esc(
          step.kind === "create"
            ? step.template
            : `${step.template} ${step.choice} — contract#${step.contractRef} % live`,
        )}
        ${esc(fmtArgs(step.args))}${esc(stepActAs(step))}${
          viol
            ? `<span class="flag">✕ ${esc(viol.property)}: ${esc(viol.why)}</span>`
            : ""
        }
      </div>`;
    })
    .join("");
  const pills = verification.results.map(pill).join(" ");
  return `
  <section>
    <h2>Minimal reproduction — verified by live replay</h2>
    <div class="steps">${cards}</div>
    ${notationNote()}
    <p class="note">All ${verification.results.length} step(s) re-executed against the
    ledger with fresh parties after shrinking: ${pills} — identical cause.</p>
  </section>`;
}

function traceSection(r: ReplayReport): string {
  const run = r.originalRun!;
  const rows = run.results
    .map(
      (res) => `
      <tr${res.violation ? ` class="violrow"` : ""}>
        <td class="n">${res.index}</td>
        <td>${pill(res)}</td>
        <td class="act">${esc(stepAction(res.step))}${esc(stepActAs(res.step))}</td>
        <td class="det" title="${esc(res.detail.split("\n")[0])}">${esc(detailOf(res))}</td>
      </tr>`,
    )
    .join("");
  const total = r.shrink!.originalSteps;
  const executed = run.results.length;
  const unrun =
    executed < total
      ? `Steps ${executed}–${total - 1} never ran: the run stops at the first violation. `
      : "";
  return `
  <section>
    <h2>Original trace — round ${r.round}, seed ${esc(r.roundSeed ?? "")}</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>#</th><th>Status</th><th>Action</th><th>Detail</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="note">${unrun}${run.accepted} accepted · ${run.rejected} rejected · ${run.skipped} skipped.</p>
  </section>`;
}

function coverageSection(cov: Coverage): string {
  const rows = Object.entries(cov.actions)
    .map(([key, c]) => {
      const never = c.accepted === 0;
      return `
      <tr${never ? ` class="neverrow"` : ""}>
        <td class="act">${esc(key)}</td>
        <td class="n">${c.accepted}</td>
        <td class="n">${c.rejected}</td>
        <td class="n">${c.skipped}</td>
      </tr>`;
    })
    .join("");
  const reached = Object.keys(cov.actions).length - cov.neverAccepted.length;
  const rej = Object.entries(cov.rejectionClasses)
    .map(([k, n]) => `${esc(k)} ${n}`)
    .join(" · ");
  return `
  <section>
    <h2>Coverage — ${reached}/${Object.keys(cov.actions).length} actions accepted</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>Action</th><th>Accepted</th><th>Rejected</th><th>Skipped</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${
      cov.neverAccepted.length > 0
        ? `<p class="note">Dimmed rows were never accepted — action-space gaps, not verdicts.</p>`
        : ""
    }
    ${rej ? `<p class="note">Rejections by class: ${rej}.</p>` : ""}
  </section>`;
}

function replaySection(r: ReplayReport): string {
  return `
  <section>
    <h2>Replay</h2>
    <pre><span class="comment"># deterministic: fresh parties per run mean the same plan gives the
# same statuses and the same violation, even on a dirty ledger</span>
daml sandbox --dar ${esc(r.package)}.dar --json-api-port 7575
daml-fuzz exec minimal-plan.json --space space.json</pre>
    <p class="note">The minimal plan is embedded in this report's JSON
    (<span class="mono">minimalPlan</span>) — ${r.minimalPlan?.steps.length ?? 0} symbolic
    step(s), no party or contract ids, portable to any participant with the package.</p>
  </section>`;
}

// ------------------------------------------------------------------- page --

const CSS = `
  :root {
    --paper: #f4f6f8; --card: #ffffff; --ink: #22262e; --ink-2: #5a6272;
    --line: #d9dee6; --accent: #4056c9; --accent-soft: #e6eaf9;
    --crit: #b4232a; --crit-soft: #f9e9e9; --ok: #1f7a3d; --ok-soft: #e5f2e9;
    --mute-cell: #c9d0da;
    --mono: "Cascadia Code", "SF Mono", "JetBrains Mono", Consolas, "Liberation Mono", monospace;
    --body: "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #16191f; --card: #1e222b; --ink: #e8ebf0; --ink-2: #98a1b3;
      --line: #333a47; --accent: #93a5ff; --accent-soft: #232c4d;
      --crit: #ff7a72; --crit-soft: #3d2325; --ok: #5fce82; --ok-soft: #1e3327;
      --mute-cell: #3a4250;
    }
  }
  :root[data-theme="light"] {
    --paper: #f4f6f8; --card: #ffffff; --ink: #22262e; --ink-2: #5a6272;
    --line: #d9dee6; --accent: #4056c9; --accent-soft: #e6eaf9;
    --crit: #b4232a; --crit-soft: #f9e9e9; --ok: #1f7a3d; --ok-soft: #e5f2e9;
    --mute-cell: #c9d0da;
  }
  :root[data-theme="dark"] {
    --paper: #16191f; --card: #1e222b; --ink: #e8ebf0; --ink-2: #98a1b3;
    --line: #333a47; --accent: #93a5ff; --accent-soft: #232c4d;
    --crit: #ff7a72; --crit-soft: #3d2325; --ok: #5fce82; --ok-soft: #1e3327;
    --mute-cell: #3a4250;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink);
    font-family: var(--body); font-size: 15px; line-height: 1.55; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 40px 24px 72px; }
  .eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: 0.14em;
    text-transform: uppercase; color: var(--ink-2); }
  header .eyebrow { color: var(--accent); }
  h1 { font-size: 26px; font-weight: 650; margin: 6px 0 2px; text-wrap: balance;
    letter-spacing: -0.01em; }
  .sub { color: var(--ink-2); margin: 0; }
  .sub code, .mono { font-family: var(--mono); font-size: 13px; }
  section { margin-top: 36px; }
  h2 { font-family: var(--mono); font-size: 12px; font-weight: 600;
    letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-2); margin: 0 0 12px; }
  .banner { margin-top: 28px; background: var(--card); border: 1px solid var(--line);
    border-left: 4px solid var(--crit); border-radius: 6px; padding: 18px 20px; }
  .banner.ok { border-left-color: var(--ok); }
  .banner .prop { font-family: var(--mono); font-weight: 700; font-size: 17px; color: var(--crit); }
  .banner.ok .prop { color: var(--ok); }
  .banner p { margin: 6px 0 0; }
  .banner .where { color: var(--ink-2); font-size: 13.5px; margin-top: 10px; }
  .banner .where code { font-family: var(--mono); color: var(--ink); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .tile { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 14px 16px; }
  .tile .k { font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--ink-2); }
  .tile .v { font-size: 24px; font-weight: 650; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .tile .v small { font-size: 14px; font-weight: 500; color: var(--ink-2); }
  .strip { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .cell { width: 20px; height: 20px; border-radius: 4px; background: var(--mute-cell); }
  .cell.acc { background: var(--ok); opacity: .45; }
  .cell.rej { background: var(--crit); opacity: .35; }
  .cell.skip { background: var(--mute-cell); }
  .cell.unreached { background: transparent; border: 1px dashed var(--line); }
  .cell.kept { background: var(--crit); opacity: 1; outline: 2px solid var(--crit); outline-offset: 1px; }
  .legend { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 12px;
    font-size: 12.5px; color: var(--ink-2); }
  .legend span { display: inline-flex; align-items: center; gap: 6px; }
  .legend i { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
  .legend.notation { margin-top: 14px; }
  .legend.notation code { font-family: var(--mono); font-size: 12px; color: var(--ink);
    background: var(--accent-soft); padding: 0 5px; border-radius: 4px; }
  .steps { display: flex; flex-direction: column; gap: 12px; }
  .stepcard { background: var(--card); border: 1px solid var(--line); border-radius: 6px;
    padding: 14px 18px; font-family: var(--mono); font-size: 13.5px; overflow-wrap: anywhere; }
  .stepcard.viol { border-color: var(--crit); background: var(--crit-soft); }
  .stepcard .idx { color: var(--ink-2); }
  .stepcard .kind { color: var(--accent); font-weight: 700; }
  .stepcard .flag { color: var(--crit); font-weight: 700; margin-top: 8px; display: block; }
  .pill { display: inline-block; font-family: var(--mono); font-size: 11px;
    padding: 1px 8px; border-radius: 999px; letter-spacing: .04em; }
  .pill.acc { background: var(--ok-soft); color: var(--ok); }
  .pill.rej { background: var(--crit-soft); color: var(--crit); }
  .pill.skip { background: var(--accent-soft); color: var(--ink-2); }
  .pill.viol { background: var(--crit-soft); color: var(--crit); font-weight: 700; }
  .tablewrap { overflow-x: auto; background: var(--card); border: 1px solid var(--line); border-radius: 6px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th { font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: .1em;
    color: var(--ink-2); text-align: left; font-weight: 600; padding: 10px 14px;
    border-bottom: 1px solid var(--line); }
  td { padding: 7px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  td.n { font-variant-numeric: tabular-nums; color: var(--ink-2); width: 1%; }
  td.act { font-family: var(--mono); white-space: nowrap; }
  td.det { color: var(--ink-2); min-width: 260px; overflow-wrap: anywhere; }
  td.def { color: var(--ink-2); overflow-wrap: anywhere; }
  tr.violrow td { background: var(--crit-soft); }
  tr.neverrow td { color: var(--ink-2); opacity: .6; }
  pre { background: var(--card); border: 1px solid var(--line); border-radius: 6px;
    padding: 14px 18px; overflow-x: auto; font-family: var(--mono); font-size: 13px;
    line-height: 1.6; margin: 0; }
  .comment { color: var(--ink-2); }
  p.note { color: var(--ink-2); font-size: 13.5px; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>
`;
}

export function renderReport(r: ReplayReport): string {
  if (r.kind !== "replay-report")
    throw new Error(`not a replay report (kind: ${JSON.stringify(r.kind)})`);

  const sub = `package <code>${esc(r.package)}</code> · package id <code>${esc(
    shortId(r.packageId),
  )}</code> · base seed ${esc(r.baseSeed)}`;

  if (r.clean) {
    const body = `
  <header>
    <div class="eyebrow">daml-fuzz · replay report</div>
    <h1>clean — no property violated</h1>
    <p class="sub">${sub}</p>
  </header>
  <div class="banner ok">
    <div class="prop">clean</div>
    <p>No property in the starter pack was violated in ${r.rounds} round(s) of
    ${r.steps} steps. A clean verdict means the properties held over everything
    the run REACHED — check the coverage below before celebrating.</p>
  </div>
  ${aboutSection(r)}
  ${r.coverage ? coverageSection(r.coverage) : ""}`;
    return page(`daml-fuzz — clean — ${r.package}`, body);
  }

  if (!r.finding || !r.shrink || !r.minimalPlan || !r.verification || !r.originalRun)
    throw new Error("replay report is missing finding/shrink/minimalPlan/verification/originalRun");

  const f = r.finding;
  const caughtStep = r.originalRun.results.find((x) => x.index === f.stepIndex);
  const body = `
  <header>
    <div class="eyebrow">daml-fuzz · replay report</div>
    <h1>${esc(f.property)} violated in ${esc(f.template)}</h1>
    <p class="sub">${sub} · round ${r.round}</p>
  </header>

  <div class="banner">
    <div class="prop">${esc(f.property)}</div>
    <p>${esc(f.why)}.</p>
    <p class="where">Caught at round ${f.round}, step ${f.stepIndex} —
    <code>${esc(caughtStep ? stepAction(caughtStep.step) : "(step not in trace)")}</code>,
    checked against the active contract set immediately after the transaction committed.</p>
  </div>
  ${aboutSection(r)}
  <section>
    <h2>Run</h2>
    <div class="tiles">
      <div class="tile"><div class="k">Seed</div><div class="v">${esc(r.roundSeed ?? r.baseSeed)}</div></div>
      <div class="tile"><div class="k">Plan</div><div class="v">${r.shrink.originalSteps} <small>steps</small></div></div>
      <div class="tile"><div class="k">Minimal repro</div><div class="v">${r.shrink.minimalSteps} <small>steps</small></div></div>
      <div class="tile"><div class="k">Shrink replays</div><div class="v">${r.shrink.replays}</div></div>
    </div>
  </section>
  ${shrinkStrip(r)}
  ${minimalSection(r)}
  ${traceSection(r)}
  ${r.coverage ? coverageSection(r.coverage) : ""}
  ${replaySection(r)}`;
  return page(`daml-fuzz — ${f.property} — ${r.package}`, body);
}
