#!/usr/bin/env node
// daml-fuzz CLI — M1 skeleton.
//
//   daml-fuzz introspect <dar> [--out <file>] [--include-archive]
//                              [--from-dump <txt>] [--damlc <cmd>]
//   daml-fuzz gen <actionspace.json> --seed <n> [--steps <n>] [--actors <n>]
//                              [--create-percent <n>] [--auth-fuzz] [--out <file>]
//   daml-fuzz exec <plan.json> --space <actionspace.json> [--api <url>]
//                              [--run-id <id>] [--report <file>]
//   daml-fuzz run <dar|actionspace.json> --seed <n> [--steps <n>] [--actors <n>]
//                              [--create-percent <n>] [--auth-fuzz] [--rounds <n>]
//                              [--api <url>] [--report <file>]
//                              [--sandbox] [--java-home <dir>]
//                              [--ledger-port <n>] [--json-port <n>]
//
// `introspect` prints the action space as JSON (stdout, or --out file) and a
// one-line-per-template summary on stderr. `--from-dump` skips invoking the
// SDK and parses a saved `daml damlc inspect` dump instead (offline/CI use).
// `gen` turns an action space into a deterministic symbolic action plan.
// `exec` replays a plan against a live participant's JSON Ledger API v2
// (e.g. `daml sandbox --json-api-port 7575`).
// `run` is the whole pipeline: introspect → generate → execute under the
// starter property pack → on violation, shrink to the minimal reproduction
// and verify it — emitting the deterministic replay report. With `--sandbox`
// it also owns the sandbox lifecycle: spawn, wait for readiness (DAR upload
// included), fuzz, tear down — one command from a cold start.

import { readFileSync, writeFileSync } from "node:fs";
import { coverageOf, coverageSummary } from "./coverage.ts";
import { executePlan, type RunReport, type StepResult } from "./executor.ts";
import { generatePlan, type Plan } from "./generator.ts";
import { buildActionSpace, introspectDar, type ActionSpace } from "./introspect.ts";
import { LedgerClient } from "./ledger.ts";
import { parseInspectDump } from "./lfparse.ts";
import { starterPack } from "./oracle.ts";
import { renderReport, type ReplayReport } from "./render.ts";
import { seedOf } from "./prng.ts";
import { startSandbox, type SandboxHandle } from "./sandbox.ts";
import { shrinkPlan } from "./shrink.ts";

const USAGE = `usage: daml-fuzz introspect <dar> [--out <file>] [--include-archive] [--from-dump <txt>] [--damlc <cmd>]
       daml-fuzz gen <actionspace.json> --seed <n> [--steps <n>] [--actors <n>] [--create-percent <n>] [--auth-fuzz] [--out <file>]
       daml-fuzz exec <plan.json> --space <actionspace.json> [--api <url>] [--run-id <id>] [--report <file>] [--privacy]
       daml-fuzz run <dar|actionspace.json> --seed <n> [--steps <n>] [--actors <n>] [--create-percent <n>] [--auth-fuzz] [--privacy] [--rounds <n>] [--api <url>] [--report <file>] [--sandbox] [--java-home <dir>] [--ledger-port <n>] [--json-port <n>]
       daml-fuzz report <replay-report.json> [--out <file.html>]`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function summarize(space: ActionSpace): string {
  const lines = [
    `package ${space.package} (${space.packageId.slice(0, 8)}…, LF ${space.lfVersion})`,
    `${space.templates.length} template(s):`,
  ];
  for (const t of space.templates) {
    const argCount = (n: number | null) => (n === null ? "?" : String(n));
    const choices = t.choices
      .map(
        (c) =>
          `${c.name}(${argCount(c.args ? c.args.length : null)})` +
          (c.interfaceId ? `@${c.interfaceId.split(":").pop()}` : ""),
      )
      .join(", ");
    lines.push(
      `  ${t.module}:${t.name} — ${t.fields.length} field(s), parties [${t.partyFields.join(", ")}], choices: ${choices || "(none)"}`,
    );
  }
  return lines.join("\n");
}

function summarizePlan(plan: Plan): string {
  const creates = plan.steps.filter((s) => s.kind === "create").length;
  return (
    `plan: seed ${plan.seed}, ${plan.steps.length} step(s) ` +
    `(${creates} create / ${plan.steps.length - creates} exercise), ` +
    `${plan.actorCount} actor(s), package ${plan.package}`
  );
}

function genMain(rest: string[]): void {
  let spaceFile: string | null = null;
  let out: string | null = null;
  let seed: bigint | null = null;
  let steps = 20;
  let actors = 3;
  let createPercent = 20;
  let authFuzz = false;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out") out = rest[++i] ?? fail("--out needs a file");
    else if (a === "--seed") seed = BigInt(rest[++i] ?? fail("--seed needs a number"));
    else if (a === "--steps") steps = Number(rest[++i] ?? fail("--steps needs a number"));
    else if (a === "--actors") actors = Number(rest[++i] ?? fail("--actors needs a number"));
    else if (a === "--create-percent")
      createPercent = Number(rest[++i] ?? fail("--create-percent needs a number"));
    else if (a === "--auth-fuzz") authFuzz = true;
    else if (a.startsWith("--")) fail(`unknown option ${a}\n${USAGE}`);
    else if (spaceFile === null) spaceFile = a;
    else fail(USAGE);
  }
  if (spaceFile === null) fail(USAGE);
  if (seed === null) fail("gen requires --seed (determinism is the contract)");

  const space = JSON.parse(readFileSync(spaceFile, "utf8")) as ActionSpace;
  const plan = generatePlan(space, { seed, steps, actorCount: actors, createPercent, authFuzz });
  const json = JSON.stringify(plan, null, 2);
  if (out) {
    writeFileSync(out, json + "\n");
    console.error(`plan written to ${out}`);
  } else {
    console.log(json);
  }
  console.error(summarizePlan(plan));
}

/** One progress line per step, on stderr. */
function stepPrinter(plan: Plan): (r: StepResult) => void {
  const pad = String(plan.steps.length - 1).length;
  return (r) => {
    const what =
      r.step.kind === "create"
        ? `create ${r.step.template}`
        : `exercise ${r.step.template} ${r.step.choice} #${r.step.contractRef}`;
    const tail =
      r.status === "accepted"
        ? r.violation
          ? ` — VIOLATION ${r.violation.property}: ${r.violation.why}`
          : ""
        : ` — ${r.detail.split("\n")[0]}`;
    console.error(`[${String(r.index).padStart(pad)}] ${r.status.padEnd(8)} ${what}${tail}`);
  };
}

async function execMain(rest: string[]): Promise<void> {
  let planFile: string | null = null;
  let spaceFile: string | null = null;
  let api = "http://localhost:7575";
  let runId: string | undefined;
  let report: string | null = null;
  let privacy = false;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--space") spaceFile = rest[++i] ?? fail("--space needs a file");
    else if (a === "--api") api = rest[++i] ?? fail("--api needs a url");
    else if (a === "--run-id") runId = rest[++i] ?? fail("--run-id needs a value");
    else if (a === "--report") report = rest[++i] ?? fail("--report needs a file");
    else if (a === "--privacy") privacy = true;
    else if (a.startsWith("--")) fail(`unknown option ${a}\n${USAGE}`);
    else if (planFile === null) planFile = a;
    else fail(USAGE);
  }
  if (planFile === null || spaceFile === null)
    fail("exec requires a plan file and --space");

  const plan = JSON.parse(readFileSync(planFile, "utf8")) as Plan;
  const space = JSON.parse(readFileSync(spaceFile, "utf8")) as ActionSpace;
  const client = new LedgerClient(api);

  const result = await executePlan(client, space, plan, {
    runId,
    privacy,
    onStep: stepPrinter(plan),
  });

  if (report) {
    writeFileSync(report, JSON.stringify(result, null, 2) + "\n");
    console.error(`report written to ${report}`);
  }
  console.error(
    `run ${result.runId}: ${result.accepted} accepted / ${result.rejected} rejected / ` +
      `${result.skipped} skipped (seed ${result.seed}, ${result.parties.length} parties)`,
  );
  console.error(coverageSummary(coverageOf(space, result.results)));
  if (result.violation) process.exitCode = 1;
}

async function runMain(rest: string[]): Promise<void> {
  let target: string | null = null;
  let seed: bigint | null = null;
  let steps = 30;
  let actors = 3;
  let createPercent = 20;
  let authFuzz = false;
  let privacy = false;
  let rounds = 10;
  let api = "http://localhost:7575";
  let report: string | null = null;
  let useSandbox = false;
  let javaHome: string | undefined;
  let ledgerPort = 6865;
  let jsonPort = 7575;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--seed") seed = BigInt(rest[++i] ?? fail("--seed needs a number"));
    else if (a === "--steps") steps = Number(rest[++i] ?? fail("--steps needs a number"));
    else if (a === "--actors") actors = Number(rest[++i] ?? fail("--actors needs a number"));
    else if (a === "--create-percent")
      createPercent = Number(rest[++i] ?? fail("--create-percent needs a number"));
    else if (a === "--auth-fuzz") authFuzz = true;
    else if (a === "--privacy") privacy = true;
    else if (a === "--rounds") rounds = Number(rest[++i] ?? fail("--rounds needs a number"));
    else if (a === "--api") api = rest[++i] ?? fail("--api needs a url");
    else if (a === "--report") report = rest[++i] ?? fail("--report needs a file");
    else if (a === "--sandbox") useSandbox = true;
    else if (a === "--java-home") javaHome = rest[++i] ?? fail("--java-home needs a dir");
    else if (a === "--ledger-port")
      ledgerPort = Number(rest[++i] ?? fail("--ledger-port needs a number"));
    else if (a === "--json-port")
      jsonPort = Number(rest[++i] ?? fail("--json-port needs a number"));
    else if (a.startsWith("--")) fail(`unknown option ${a}\n${USAGE}`);
    else if (target === null) target = a;
    else fail(USAGE);
  }
  if (target === null) fail(USAGE);
  if (seed === null) fail("run requires --seed (determinism is the contract)");
  if (useSandbox && target.endsWith(".json"))
    fail("--sandbox needs a DAR target (it uploads the DAR at startup)");

  let sandbox: SandboxHandle | null = null;
  let space: ActionSpace;
  if (useSandbox) {
    console.error(`starting sandbox (ledger ${ledgerPort}, json-api ${jsonPort})…`);
    // Boot and introspect in parallel: the JVM warms up while damlc runs.
    const booting = startSandbox({ dar: target, ledgerPort, jsonPort, javaHome });
    try {
      space = introspectDar(target, {});
      sandbox = await booting;
    } catch (e) {
      await booting.then((s) => s.stop()).catch(() => {});
      throw e;
    }
    api = sandbox.apiUrl;
    console.error(`sandbox ready at ${api} (DAR uploaded)`);
  } else {
    space = target.endsWith(".json")
      ? (JSON.parse(readFileSync(target, "utf8")) as ActionSpace)
      : introspectDar(target, {});
  }
  console.error(
    `package ${space.package}: ${space.templates.length} template(s) under the starter pack`,
  );
  const client = new LedgerClient(api);

  let violationFound = false;
  try {
    violationFound = await runRounds(client, space, {
      seed, steps, actors, createPercent, authFuzz, privacy, rounds, report,
    });
  } finally {
    if (sandbox) {
      console.error("stopping sandbox…");
      await sandbox.stop();
    }
  }
  // Non-zero exit on a finding so daml-fuzz can gate a CI job.
  if (violationFound) process.exitCode = 1;
}

async function runRounds(
  client: LedgerClient,
  space: ActionSpace,
  o: {
    seed: bigint;
    steps: number;
    actors: number;
    createPercent: number;
    authFuzz: boolean;
    privacy: boolean;
    rounds: number;
    report: string | null;
  },
): Promise<boolean> {
  const { seed, steps, actors, createPercent, authFuzz, privacy, rounds, report } = o;
  let replays = 0;
  // Coverage is aggregated over the ROUND runs only (shrink/verify replays
  // re-execute prefixes of a known plan and would double-count).
  const roundResults: StepResult[] = [];
  const exec = (plan: Plan, tag: string, quiet = false): Promise<RunReport> =>
    executePlan(client, space, plan, {
      pack: starterPack,
      privacy,
      runId: `${Date.now().toString(36)}-${tag}-${replays++}`,
      onStep: quiet ? undefined : stepPrinter(plan),
    });

  for (let round = 1; round <= rounds; round++) {
    // The round schedule walks the seed space deterministically from the
    // base seed (same spirit as the prototype's k * 7919 probe).
    const roundSeed = seedOf(seed + BigInt(round - 1) * 7919n);
    const plan = generatePlan(space, {
      seed: roundSeed,
      steps,
      actorCount: actors,
      createPercent,
      authFuzz,
    });
    console.error(`\n— round ${round}/${rounds}: seed ${plan.seed}, ${steps} steps`);
    const found = await exec(plan, `r${round}`);
    roundResults.push(...found.results);
    if (!found.violation) {
      console.error(
        `  clean: ${found.accepted} accepted / ${found.rejected} rejected / ${found.skipped} skipped`,
      );
      continue;
    }

    const { property, why, stepIndex, template } = found.violation;
    console.error(
      `\nFOUND at round ${round}, step ${stepIndex} (${template}): '${property}' — ${why}`,
    );
    console.error(`shrinking ${plan.steps.length} steps (greedy delta-debug to fixpoint)…`);

    // Failure signature = property + template: same property on a different
    // template is a different bug, not a smaller reproduction.
    const shrunk = await shrinkPlan(plan, async (candidate) => {
      const r = await exec(candidate, `r${round}s`, true);
      return r.violation?.property === property && r.violation.template === template;
    });
    console.error(
      `shrink: ${shrunk.originalSteps} → ${shrunk.minimal.steps.length} step(s) in ${shrunk.attempts} replays`,
    );

    console.error(`\nverifying the minimal reproduction:`);
    const verification = await exec(shrunk.minimal, `r${round}v`);
    if (verification.violation?.property !== property || verification.violation.template !== template)
      fail("shrunk plan no longer fails — shrinker is broken (please report this)");

    const replayReport = {
      tool: "daml-fuzz",
      kind: "replay-report",
      package: space.package,
      packageId: space.packageId,
      baseSeed: seed.toString(),
      round,
      roundSeed: plan.seed,
      finding: { round, ...found.violation },
      shrink: {
        originalSteps: shrunk.originalSteps,
        minimalSteps: shrunk.minimal.steps.length,
        replays: shrunk.attempts,
      },
      minimalPlan: shrunk.minimal,
      verification,
      originalRun: found,
    };
    if (report) {
      writeFileSync(report, JSON.stringify(replayReport, null, 2) + "\n");
      console.error(`replay report written to ${report}`);
    }
    console.error(
      `\nRESULT: '${property}' violated — minimal reproduction is ${shrunk.minimal.steps.length} step(s) ` +
        `(from ${shrunk.originalSteps}); replay with: daml-fuzz exec <minimalPlan from report> --space <space>`,
    );
    console.error(coverageSummary(coverageOf(space, roundResults)));
    return true;
  }

  console.error(`\nRESULT: clean — no property violated in ${rounds} round(s) of ${steps} steps`);
  console.error(coverageSummary(coverageOf(space, roundResults)));
  if (report) {
    writeFileSync(
      report,
      JSON.stringify(
        {
          tool: "daml-fuzz",
          kind: "replay-report",
          package: space.package,
          packageId: space.packageId,
          baseSeed: seed.toString(),
          clean: true,
          rounds,
          steps,
        },
        null,
        2,
      ) + "\n",
    );
    console.error(`report written to ${report}`);
  }
  return false;
}

/** JSON replay report in, one self-contained HTML page out. The JSON is the
 * source of truth (`run --report`); this is a pure, offline transform — no
 * ledger, no SDK — so the evidence page can be regenerated anywhere. */
function reportMain(rest: string[]): void {
  let jsonFile: string | null = null;
  let out: string | null = null;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out") out = rest[++i] ?? fail("--out needs a file");
    else if (a.startsWith("--")) fail(`unknown option ${a}\n${USAGE}`);
    else if (jsonFile === null) jsonFile = a;
    else fail(USAGE);
  }
  if (jsonFile === null) fail("report requires a replay-report JSON file");

  const report = JSON.parse(readFileSync(jsonFile, "utf8")) as ReplayReport;
  const html = renderReport(report);
  if (out) {
    writeFileSync(out, html);
    console.error(`HTML report written to ${out}`);
  } else {
    console.log(html);
  }
}

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  if (command === "gen") return genMain(rest);
  if (command === "report") return reportMain(rest);
  if (command === "exec") {
    execMain(rest).catch((e) => fail(String(e instanceof Error ? e.message : e)));
    return;
  }
  if (command === "run") {
    runMain(rest).catch((e) => fail(String(e instanceof Error ? e.message : e)));
    return;
  }
  if (command !== "introspect") fail(USAGE);

  let dar: string | null = null;
  let out: string | null = null;
  let fromDump: string | null = null;
  let damlCmd = "daml";
  let includeArchive = false;

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--out") out = rest[++i] ?? fail("--out needs a file");
    else if (a === "--from-dump") fromDump = rest[++i] ?? fail("--from-dump needs a file");
    else if (a === "--damlc") damlCmd = rest[++i] ?? fail("--damlc needs a command");
    else if (a === "--include-archive") includeArchive = true;
    else if (a.startsWith("--")) fail(`unknown option ${a}\n${USAGE}`);
    else if (dar === null) dar = a;
    else fail(USAGE);
  }
  if (dar === null && fromDump === null) fail(USAGE);

  const space = fromDump
    ? buildActionSpace(parseInspectDump(readFileSync(fromDump, "utf8")), { includeArchive })
    : introspectDar(dar!, { includeArchive, damlCmd });

  const json = JSON.stringify(space, null, 2);
  if (out) {
    writeFileSync(out, json + "\n");
    console.error(`action space written to ${out}`);
  } else {
    console.log(json);
  }
  console.error(summarize(space));
}

main(process.argv.slice(2));
