# Proposal: daml-fuzz — Property-Based Fuzzing for Daml Contracts

> DRAFT. Bracketed values `[like this]` must be filled in with your champion
> before opening the PR. Do not submit until `daml test` passes locally and a
> champion in the Daml Language & Developer Tooling SIG (or the new Security
> SIG) has expressed interest. Target SIG label: `daml-tooling`.

## Abstract

daml-fuzz is an open-source (Apache-2.0) **property-based fuzzing framework** for
Daml smart contracts on the Canton Network. Developers declare invariants their
contracts must never break (e.g. "total supply is conserved", "only the owner
can act"); daml-fuzz generates thousands of randomized, multi-party transaction
sequences against a local Canton ledger and reports any violation as a minimal,
reproducible recipe. It fills a verified gap: the ecosystem has coverage
analysis (DamlCov, #323) and formal verification (B-Method, #12), but **no tool
that generates adversarial inputs** to find combinatorial, multi-party bugs.

## Specification

### Objective and scope

Deliver a CLI and CI tool that, given a compiled Daml package (`.dar`) and a set
of user-declared properties, automatically fuzzes the contracts and reports
violations with deterministic reproduction recipes. Scope covers state
invariants, authorization properties, stateful multi-party workflows, and
(uniquely to Canton) privacy/disclosure properties.

### Implementation mechanics

Four components around a local Canton ledger:
1. **DAR introspection** — read a compiled `.dar`, enumerate templates, choices,
   and argument types to form the fuzzing action space with zero manual config.
2. **Generator** — randomized, valid-shaped transaction sequences with boundary
   values, random parties, and random ordering; later coverage-guided mutation.
3. **Executor** — connect to a local Canton (sandbox / Localnet / dpm devkit) as
   multiple parties via the gRPC Ledger API; submit and record outcomes.
4. **Property checker + shrinker** — evaluate user invariants after each
   sequence; on violation, shrink to a minimal reproduction and emit a
   deterministic replay report and a self-contained `report.html`.

A working proof of concept already exists (pure Daml Script): it fuzzes a token
contract across hundreds of randomized rounds, checks conservation,
non-negativity, and authorization (an adversary party "Eve"), and is validated
by a **mutation-testing bug zoo** with a scorecard. See the public repo.

### Architectural alignment

Targets the **Daml 3.x / Canton Network** line and its **dpm** toolchain. The
proof of concept was verified to compile and pass identically on both Daml
2.10.4 and 3.4.11 (zero code changes), and is pinned to 3.4.11. The funded tool
builds on standard Daml/Canton interfaces — the `.dar` format and the gRPC
Ledger API against **LocalNet** — so it works with any Canton deployment, and
packages via **dpm**, consuming (not duplicating) the approved dpm devkit work
(#18). It complements DamlCov (#323, coverage) and B-Method (#12, formal
methods) by occupying the distinct "adversarial input generation" niche.

### Backward compatibility

Additive only: a developer testing tool. It introduces no protocol changes and
has no on-ledger footprint beyond ephemeral local-ledger contracts created
during a fuzzing run.

## Milestones and deliverables

**M1 — Core loop + property DSL + CLI** (~2 months)
- Generic fuzzing engine over an introspected DAR; starter invariant pack;
  command-line interface.
- *Metric:* mutation-testing score ≥ [9]/10 on the planted-bug zoo, median
  time-to-catch < [50] rounds.

**M2 — Stateful multi-party + shrinking** (~2 months)
- Stateful multi-party sequence generation; automatic shrinking to minimal
  reproductions; deterministic replay reports.
- *Metric:* run on ≥ 2 real codebases (incl. the CIP-0056 token standard
  reference) with disclosed findings.

**M3 — Coverage-guided + GitHub Action + docs** (~2 months)
- Coverage-guided mutation; a GitHub Action for per-PR fuzzing; full docs.
- *Metric:* ≥ 3 ecosystem teams running daml-fuzz in CI.

## Acceptance criteria

- Public Apache-2.0 repository with tagged releases.
- Each milestone's metric demonstrably met, with a reproducible scorecard.
- Documentation sufficient for a new team to add daml-fuzz to CI unaided.

## Funding request and milestone breakdown

Total: **[TBD] CC**, milestone-based:
- M1: [TBD] CC
- M2: [TBD] CC
- M3: [TBD] CC

(Benchmark against comparable merged daml-tooling grants; confirm exact figures
with the champion before submission.)

## Volatility stipulation

If the timeline exceeds 6 months, milestone amounts may be renegotiated per the
fund's CC-volatility clause.

## Co-marketing

Happy to co-author a blog post / demo for the Canton developer channels on
finding real bugs in ecosystem contracts.

## Motivation

Canton hosts tokenized deposits, treasuries, and collateral. The dangerous bugs
are combinatorial — multi-party, multi-step interactions no example test
enumerates. The ecosystem lacks adversarial-input tooling. daml-fuzz closes that
gap and raises the security floor for the whole network.

## Rationale

Mutation testing gives an objective, repeatable measure of effectiveness, ideal
for milestone verification. Building in pure Daml for the PoC and graduating to
TypeScript bindings for the funded tool follows ecosystem norms (official JS
bindings, npm distribution, GitHub Action) and maximizes adoption.
