# 09 · Daml version decision (2.x vs 3.x) — and the result

A record of why the project targets **Daml 3.4.11**, and the evidence behind it.

## The question

Daml has two lines:
- **2.10.4** — the LTS / "legacy" 2.x line.
- **3.4.11** — the **Canton Network** line. The whole 3.x workflow shifts to a
  new tool, **dpm** (Digital Asset Package Manager), with the Canton Network
  Quickstart / LocalNet, and docs at `docs.digitalasset.com` (2.x docs stay at
  `docs.daml.com`). The classic `daml` assistant is **deprecated and removed in
  Daml 3.5**.

So: should a *new* Canton project build on 2.x or 3.x?

## What we actually tested (not guessed)

We installed **both** SDKs side by side (`daml install 3.4.11` alongside
2.10.4 — they coexist) and ran the PoC under each:

| | Daml 2.10.4 | Daml 3.4.11 |
|---|---|---|
| `daml build` | ✅ compiles | ✅ compiles (zero code changes) |
| `daml test` (in-memory) | ✅ 11/11 scenarios pass | ✅ 11/11 scenarios pass (identical) |

**Result: the fuzzer code is version-portable.** Same templates, choices,
signatory/observer/controller, and Daml Script `submit`/`query` work on both. The
only differences are *toolchain*, not *language*:
- flag rename: `--project-root` → `--package-root`
- the `daml` assistant is deprecated → future path is **dpm**
- a style warning (keep tests in a separate package from templates)

## The decision

**Target Daml 3.4.11** (set in `daml.yaml`). Reasons:
1. It's the **Canton Network line** — where the real corpus (Splice/Amulet, the
   CIP-0056 token standard) lives and where the grant's priorities point.
2. It works **identically** to 2.x for our code, so adoption cost is ~zero.
3. Better optics with the grant committee than pinning to "legacy" 2.x.

We keep the in-memory `daml test` flow for the PoC (cheapest way to prove the
concept). The *funded* tool's M1 is where the deeper 3.x integration lands:
**dpm** packaging + **LocalNet** + the **gRPC Ledger API**. That's a feature of
the roadmap, not a migration cost we pay now.

## Planned follow-up (not blocking the PoC)

- **Migrate to dpm** before Daml 3.5 removes the `daml` assistant. This is a
  code-free toolchain step; it also aligns us with the approved dpm devkit work
  (dev-fund PR #18) — a point worth making in the proposal.
- When fuzzing real Canton packages, run against **LocalNet** over the gRPC
  Ledger API instead of the in-memory `daml test` ledger.

## Practical notes for running today

- The SDK is installed at `C:\Users\<you>\AppData\Roaming\daml\bin`.
- `daml.yaml` pins `sdk-version: 3.4.11`; `daml version` shows it as the package
  version. (If a `DAML_SDK_VERSION` environment variable is ever set, it
  overrides `daml.yaml` — keep it unset.)
- You'll see a one-line "assistant deprecated / use dpm" warning. Harmless for
  now; silence it with `--no-legacy-assistant-warning`.
