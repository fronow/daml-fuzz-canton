# 12 · The 2-minute demo script

A tight screen-recording plan. Goal: a champion/committee instantly "gets it."
Record at 1080p, terminal + editor + browser. Keep it under ~2.5 minutes.
Practice once — especially the live-break move in Beat 1.

> Tooling note: in your terminal `daml` is on PATH. Each command is shown with
> what to **say** while it runs.

---

## Beat 0 — one-line hook (10s, on camera or as a title card)

> "This is daml-fuzz. You tell it the rules your Canton contract must never
> break — and it finds the transaction sequence that breaks one, with the exact
> steps to reproduce it."

## Beat 1 — break the contract live, watch it get caught (45s)

The money shot. Open `daml/Token.daml` at the `Split` choice:

> "Here's a token contract. Watch what happens if I make the classic
> copy-paste mistake — forgetting to subtract the split amount."

Change `amount = amount - splitAmount` to `amount = amount`, save, run:
```bash
daml test --files daml/Fuzz.daml
```
> "I haven't told the fuzzer anything about this bug. It only knows the rule:
> total value must stay constant. …There it is — conservation violated, and
> the exact random sequence that exposed it. Same seed, same discovery, every
> time."

Restore the line, re-run, point at the green:
> "Fix it, run again — green. Five hundred random rounds, no false alarms."

## Beat 2 — the bug zoo and the scorecard (30s)

```bash
./scripts/scorecard.ps1
```
> "One catch could be luck, so there's a bug zoo: eight contracts, each with
> exactly one planted defect — inflation, negative balances, an authorization
> hole, a double-accept, an expired offer, a privacy leak. The fuzzer is never
> told the exploits — it discovers all eight from randomized generation.
> Eight out of eight, zero false positives. That's the mutation score we'd
> report at every milestone."

## Beat 3 — the assurance report UI (20s)

```bash
./scripts/report.ps1
start report.html
```
> "Every run produces a self-contained HTML report — the same artifact a bank's
> risk team would file. Pass/fail, each finding, and a reproduction recipe."

## Beat 4 — where it goes (20s)

> "Today this runs inside Daml's test engine — great for proving the idea,
> but it caps the depth. The funded version drives a real local Canton ledger
> over the network API: point it at any compiled contract — including tokens
> built on the Canton Network Token Standard — with zero hand-written glue,
> smarter exploration, and a per-PR GitHub Action."

## Beat 5 — close (15s)

> "It's the security layer Canton doesn't have yet — nobody generates
> adversarial inputs for Daml, and nothing else can test privacy and
> multi-party authorization. Built on Daml 3.x, Apache-2.0."

---

## Capture checklist
- [ ] Terminal font large enough to read on a phone.
- [ ] Pre-build once before recording (so the test runs are fast on camera).
- [ ] Rehearse the Beat-1 edit → catch → undo → green cycle once off-camera.
- [ ] Have `report.html` ready to open (`report.sample.html` if you want to
      show example recipe cards).
- [ ] Trim dead air; total ≤ 2.5 min.
- [ ] Export as MP4 and a GIF of Beat 1 for the README.
