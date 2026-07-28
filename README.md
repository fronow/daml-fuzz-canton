# daml-fuzz

**Property-based fuzzing for Daml smart contracts on Canton.**

Point daml-fuzz at a compiled Daml package (`.dar`). It discovers the templates,
choices and argument types automatically, fires randomized multi-party
transaction sequences at a real Canton ledger, and reports any sequence that
violates a declared invariant — together with a **minimal, deterministic recipe
to reproduce it** and a self-contained HTML report.

No manual configuration is required to get started: the core value properties
are checked out of the box on any token-like contract.

- Runs on **Node ≥ 23.6** (TypeScript executed directly — no build step) with
  **zero runtime dependencies**.
- Talks to Canton over the **JSON Ledger API v2**.
- Apache-2.0.

---

## Why

The expensive bugs in Daml are rarely in a single choice — they emerge from
combinations of parties, steps and orderings that no hand-written test
enumerates. daml-fuzz generates those adversarial sequences and checks, after
every step, the properties that must always hold:

- **Conservation of value** — value is never created from nothing or lost.
- **Non-negativity** — no holding ever goes negative.
- **Authorization** (`--auth-fuzz`) — each step is submitted as a random subset
  of parties, surfacing actions a party subset should not be able to perform.
- **Privacy / disclosure** (`--privacy`) — an uninvolved party must be able to
  observe nothing; any contract it can see is an over-disclosure. (This class of
  property is specific to a privacy-preserving ledger like Canton.)

On a violation, the failing sequence is automatically **shrunk** to the smallest
sequence that still reproduces it.

## Requirements

- **Daml SDK 3.x** on `PATH` (`daml`, `damlc`).
- **An OpenJDK** (e.g. Temurin 21) for a local sandbox. Note: **Oracle JDK does
  not work** with Canton (`JCE cannot authenticate the provider BC`); pass
  `--java-home` pointing at an OpenJDK if your default `java` is Oracle's.
- **Node.js ≥ 23.6**.

## Quickstart

Build the bundled sample (a correct token plus a value-inflating buggy variant):

```
cd examples/sample-token && daml build && cd ../..
```

Fuzz it — one cold-start command that boots a sandbox, uploads the DAR, fuzzes,
shrinks any failure, writes a report and shuts the sandbox down:

```
node src/cli.ts run examples/sample-token/.daml/dist/daml-fuzz-sample-0.1.0.dar \
  --seed 42 --sandbox --report report.json
```

Turn the JSON report into a self-contained HTML page (no ledger or SDK needed):

```
node src/cli.ts report report.json --out report.html
```

### What a catch looks like

```
— round 3/8: seed 15880, 25 steps
[15] accepted create   SampleToken:TokenBug
[18] accepted exercise SampleToken:TokenBug SplitBug — VIOLATION conservation-of-value:
       expected the holdings to total 13.37 but they total 25.403
FOUND at round 3, step 18: 'conservation-of-value'
shrinking 25 steps (greedy delta-debug to fixpoint)…
shrink: 25 → 2 step(s) in 27 replays
RESULT: 'conservation-of-value' violated — minimal reproduction is 2 step(s)
coverage: 6/6 action(s) accepted at least once
```

On a correct contract the run stays clean — no false positives.

## How it works

Five stages, all driven by the one compiled `.dar`:

1. **Introspect** — read the DAR, enumerate every template, its Party-typed
   fields (candidate actors), its choices and their argument records/types.
   Multi-package DARs and interface choices are handled.
2. **Generate** — build randomized, valid-shaped, multi-party transaction
   sequences from a deterministic seed. Plans are symbolic (index-based party
   and contract references), so a seed reproduces the same plan anywhere.
3. **Execute** — replay the plan against a live participant over the JSON Ledger
   API, submitting as multiple parties and recording each step's outcome.
4. **Check** — after every accepted step, evaluate the invariants (conservation,
   non-negativity, and optionally privacy) against a uniform holdings snapshot
   whose quantity/holder fields are derived from introspection.
5. **Shrink** — on a violation, greedily reduce the sequence to a minimal
   reproduction, verify it and emit the replay report.

## Commands

```
daml-fuzz introspect <dar> [--out space.json]
    Discover the action space of a DAR (templates, choices, types).

daml-fuzz gen <space.json> --seed <n> [--steps n] [--actors n]
              [--create-percent n] [--auth-fuzz] [--out plan.json]
    Generate a deterministic, symbolic transaction plan.

daml-fuzz exec <plan.json> --space <space.json> [--api <url>]
              [--privacy] [--report r.json]
    Replay a plan against a running participant.

daml-fuzz run <dar> --seed <n> [--steps n] [--actors n] [--rounds n]
              [--create-percent n] [--auth-fuzz] [--privacy] [--sandbox]
              [--java-home <dir>] [--api <url>] [--report r.json]
    The whole pipeline: introspect → generate → execute → check → shrink →
    report. With --sandbox it manages a local Canton sandbox for you. Exits
    non-zero on a finding, so it can gate a CI job.

daml-fuzz report <report.json> [--out report.html]
    Render a JSON replay report as a self-contained HTML page.
```

Run `node src/cli.ts` with no arguments for the full usage summary.

## Continuous integration

- `.github/workflows/ci.yml` — type-check + the hermetic test suite on push/PR.
- `.github/workflows/fuzz.yml` — a per-PR fuzzing gate: builds a DAR, fuzzes it,
  uploads the HTML report as an artifact, and **fails the job on a violation**.

## Scope and limitations

- Out-of-the-box properties are conservation-of-value, non-negativity,
  authorization and privacy. User-defined custom invariants are planned.
- Best suited to **token / holding-style contracts** (a numeric quantity held by
  a party); it runs on any DAR, but the built-in value properties apply where a
  holding can be identified.
- Introspection currently reads `damlc inspect` output. A native, dependency-free
  `daml_lf` protobuf decoder is included (`src/protobuf.ts`, `src/lfdecode.ts`)
  and covers the package structure and type system; wiring it in as the default
  introspection path is in progress.
- Variant/enum choice-argument fields are not yet generated.

## Development

```
npm install         # dev-only deps (@types/node, typescript) for the editor
npm test            # hermetic test suite (no ledger needed)
npm run typecheck   # tsc --noEmit
```

Contributions welcome — see `CONTRIBUTING.md`. This is plain, dependency-free
TypeScript; please keep it that way.

## License

Apache-2.0. See `LICENSE`.
