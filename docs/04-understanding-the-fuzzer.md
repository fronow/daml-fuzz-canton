# 04 · Understanding the fuzzer (`daml/Fuzz.daml` and friends)

Now the interesting part: how do we attack a contract automatically? This guide
explains the fuzzer's design and the four small files that make it up.

## The four pieces

| File | Job |
|------|-----|
| `daml/Prng.daml` | Makes random-looking numbers (deterministically). |
| `daml/Properties.daml` | The *rules* the contract must never break. |
| `daml/Token.daml` | The contract under attack (covered in guide 03). |
| `daml/Fuzz.daml` | The engine: fires random actions and checks the rules. |

Keeping them separate is intentional: the same rules (`Properties`) and the same
randomness (`Prng`) are reused by every bug-zoo mutant, which makes the
scorecard fair.

## Piece 1 — randomness you can replay (`Prng.daml`)

A fuzzer needs randomness. But if a bug only showed up with "truly" random
inputs, you could never reproduce it. So we use a **pseudo**-random generator: a
formula that produces a random-LOOKING sequence that is actually 100%
determined by a starting number called the **seed**.

```daml
next : Int -> Int
next s = (s * 1103515245 + 12345) % 2147483648
```

Give it a seed, it gives you the next number; feed that back in for the one
after, and so on. Same seed → same sequence → **same bugs, every time.** That is
why our failure messages can print an exact "recipe to reproduce".

`pick s xs` just uses a seed to choose one item from a list (a token, a party, a
split fraction).

## Piece 2 — the rules (`Properties.daml`)

> "A property-based fuzzer is only as good as the properties you give it."

A **property** (or **invariant**) is a rule that must hold *no matter what*.
`checkState` checks two:

- **P1 Conservation of value** — all the token amounts must still add up to the
  original supply (100). Nothing created from thin air; nothing lost.
- **P2 Non-negativity** — no token may hold a negative amount.

`checkState` returns either `None` ("all good") or `Some reason` ("this rule
broke, and here's why in plain English"). It never crashes — the engine decides
what to do with a violation.

## Piece 3 — the engine (`Fuzz.daml`)

The engine runs across **four property tiers** — different kinds of attack. The
two core ones are explained in detail below (random state fuzzing and the
adversary); Tier 3 (multi-step workflow) and Tier 4 (privacy/disclosure) follow
the same pattern and are exercised by the bug zoo (guide 05).

### Tier 1 — random state fuzzing (`fuzzStateClean`)

The loop, in words:

1. Look at all the tokens that currently exist.
2. **Check the rules** (`checkState`). If a rule is broken, stop and report it
   with the full history of steps taken (the recipe).
3. Otherwise, fire **one random valid action**: either transfer a random token
   to a random party, or split it by a random fraction.
4. Repeat, 200 times.

Run against the **correct** contract, it should complete all 200 rounds with **no
violation** — proving the fuzzer does not raise false alarms. Run against a
**buggy** contract (the mutants), the same loop trips the rule and reports it.

> Why only "valid" actions in Tier 1? Because we are testing *state* over legal
> histories. If we submitted illegal actions, the correct contract would
> rightly reject them and the script would error for the wrong reason.
> Attacking the *guards* with illegal inputs is what Tier 2 (and mutant B2) do.

### Tier 2 — adversary / authorization fuzzing (`fuzzAuthClean`)

This is the part that makes daml-fuzz a *security* tool, not just a maths
checker. We introduce **Eve**, an attacker who owns nothing and is authorized
for nothing. A correct contract must reject *everything* she tries.

```daml
submitMustFail eve do exerciseCmd cid Transfer with newOwner = eve
```

`submitMustFail` is an assertion that the action **fails**. So this line passes
only if Eve is correctly blocked. We also confirm the contract rejects
nonsensical splits (negative, or bigger than the token).

If Eve ever *succeeds*, that is an **authorization hole** — the Daml equivalent
of a missing "only the owner can do this" check. That is exactly the bug planted
in mutant B3.

## How a test "passes"

This is the clever bit that makes the whole suite read as simple green/red:

- **Correct-contract scripts** (`fuzzStateClean`, `fuzzAuthClean`) pass when the
  fuzzer finds **nothing** wrong.
- **Mutant scripts** (`fuzzB1`, `fuzzB2`) pass when the fuzzer **does** find the
  planted bug.

So "all green in `daml test`" means one clean sentence: *the fuzzer raised no
false alarms and caught every planted bug.* That is the demo, and it is the
headline metric for every grant milestone.

## The reproduction recipe

When Tier 1 finds a violation it prints something like:

```
CONSERVATION OF VALUE violated: expected the amounts to total 100.0 but they total 130.0
Recipe to reproduce:
step 1: Split 100.0 by 30.0
```

A developer can replay those exact steps and watch the bug happen. Turning a
scary "something is wrong somewhere" into a precise, replayable recipe is the
core value of the tool.

Next: **guide 05** — how we prove the fuzzer works, and how to add more bugs.
