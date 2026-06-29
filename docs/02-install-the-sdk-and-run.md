# 02 · Install the Daml SDK and run the fuzzer

This is the most important hands-on guide. The goal: get the command
**`daml test`** to run and print green results.

> ✅ **DONE on this machine.** Daml SDK **3.4.11** (the Canton Network line) is
> installed, and `daml test` already passes 6/6. You can skip to
> **"Step 3 — run the tests"**. The install steps below are kept for reference /
> a fresh machine. Why 3.4.11 and not 2.x: see
> `09-daml-version-decision.md`.

> You only need to do the install once.

## Step 0 — what you need

- **Java** — already installed on this machine (we checked). Daml needs it.
- **The Daml SDK** — NOT yet installed. That is what Step 1 fixes.

## Step 1 — install the Daml SDK

### On Windows (this machine)

The official installer is the simplest path. Open **PowerShell** and run:

```powershell
# Downloads and runs the official Daml installer.
# (If your org blocks script downloads, see the manual option below.)
Invoke-WebRequest https://get.daml.com -OutFile $env:TEMP\get-daml.ps1
powershell -ExecutionPolicy Bypass -File $env:TEMP\get-daml.ps1
```

If that is blocked, use the **manual** route:

1. Go to <https://github.com/digital-asset/daml/releases>.
2. Download a Daml **2.x** SDK release for Windows (e.g. 2.9.x or 2.10.x).
3. Follow the install instructions on
   <https://docs.daml.com/getting-started/installation.html>.

After installing, **close and reopen** your terminal so the new `PATH` is
picked up.

### Verify the install

```powershell
daml version
```

You should see a version number (for example `2.9.4` or `2.10.x`). Note the
**first line / default version** — you need it for Step 2.

## Step 2 — point the project at your installed version

Open `daml.yaml` (in the project root) and set `sdk-version` to **exactly** the
version `daml version` printed:

```yaml
sdk-version: 2.9.4   # <-- replace with YOUR `daml version` output
```

This matters: if the version here does not match an installed SDK, Daml will try
to download it and may fail behind a firewall.

## Step 3 — run the tests

From the project root (`E:\canton-daml`):

```powershell
daml test
```

`daml test` finds and runs **every** `Script` in the project. With this PoC that
means:

- `Fuzz.daml` → `fuzzStateClean`, `fuzzAuthClean`, `fuzzPrivacyClean`  (correct contract; Tiers 1, 2, 4)
- `Mutants/B1Inflation.daml` → `fuzzB1`            (planted inflation bug)
- `Mutants/B2NoPositivity.daml` → `fuzzB2`         (planted negative-balance bug)
- `Mutants/B8PrivacyLeak.daml` → `fuzzB8`          (planted privacy/disclosure leak)

> Note (Daml 3.x): you'll see a one-line "assistant deprecated, use dpm" warning.
> It's harmless; the scripts pass `--no-legacy-assistant-warning` to silence it.

### What success looks like

Every scenario is written so that **"the fuzzer behaved correctly" = "the test
passes."** So a fully green run means:

- the fuzzer raised **no false alarms** on the correct contract, **and**
- it **caught every planted bug**.

You will also see `debug` lines such as:

```
BUG B1 CAUGHT (as expected):
CONSERVATION OF VALUE violated: expected the amounts to total 100.0 but they total 130.0
Recipe to reproduce:
step 1: Split 100.0 by 30.0
```

That message — a broken rule plus the exact steps to reproduce it — is the
product. That is what daml-fuzz sells.

## Step 4 — run the scorecard (optional, nicer output)

```powershell
./scripts/scorecard.ps1
```

This runs `daml test` and prints a tidy bug-zoo table.

## Troubleshooting

**`daml: command not found` / not recognized**
The SDK is not on your `PATH`. Reopen the terminal; if still failing, re-run the
installer and check its final message for the install location.

**It tries to download an SDK version and hangs/fails**
The `sdk-version` in `daml.yaml` does not match what you installed. Fix Step 2.

**A compile error like "parse error" or "variable not in scope"**
Expected possibility — this code was written without a compiler available, so
1–3 small fixes may be needed. The error names the file and line. Common ones:
- a record-access dot (`t.amount`) — fine on modern SDKs; if your SDK complains,
  tell me your `daml version` and I'll adjust.
- `submitMustFail` / `query` signatures — these are stable, but versions differ
  slightly. Paste the exact error and we fix it together.

**A CLEAN test failed (e.g. `fuzzStateClean`)**
That would be a *false positive* — the fuzzer wrongly flagged correct code. Send
me the output; it usually means a property or a generated value needs tightening.

**A MUTANT test failed (e.g. `fuzzB1`)**
That means the fuzzer *missed* a planted bug. Also send the output.

## When it's green

Congratulations — the PoC is real. Now you may:
1. Record a short demo (see `STATUS.md`).
2. Move on to the bug zoo (guide 05) to add more planted bugs.
3. Start the grant process (guide 06).

Next: **guide 03** — understand the contract the fuzzer attacks.
