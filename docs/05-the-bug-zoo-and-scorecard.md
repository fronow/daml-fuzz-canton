# 05 · The bug zoo and the scorecard

How do you prove a bug-finder actually finds bugs? You give it a pile of code
with **known** bugs planted in it and count how many it catches. This is called
**mutation testing**, and the pile of broken contracts is our **bug zoo**.

## The idea

1. Take the correct contract (`daml/Token.daml`).
2. Make copies, each with **exactly one** deliberate bug ("mutants").
3. Run the fuzzer against every mutant.
4. **Scorecard** = how many planted bugs were caught (and how fast).

This number — "caught X of N planted bugs" — is:
- the headline of the demo,
- the metric in every grant milestone report,
- an objective, repeatable measure (no hand-waving).

**The golden rule:** one mutant = one bug. And every new property you add to the
fuzzer must ship with a matching mutant that proves it works. A property with no
mutant is an unproven claim.

## What's in the zoo today

| ID | File | Planted bug | Property that catches it | Status |
|----|------|-------------|--------------------------|--------|
| B1 | `daml/Mutants/B1Inflation.daml` | `Split` forgets to subtract → pieces total *more* than the original | Conservation of value (Tier 1) | ✅ implemented |
| B2 | `daml/Mutants/B2NoPositivity.daml` | `Split` accepts a negative amount → negative balance | Non-negativity (Tier 1) | ✅ implemented |
| B3 | `daml/Mutants/B3AuthHole.daml` | Wrong controller → a party can take a token they don't own | Authorization (Tier 2) | ✅ implemented |
| B4 | `daml/Mutants/B4MergeInflation.daml` | `Merge` forgets to archive its other input → inflation | Conservation (Tier 1) | ✅ implemented |
| B5 | `daml/Mutants/B5ValueVanish.daml` | Archive without payout → value vanishes | Conservation (Tier 1) | ✅ implemented |
| B6 | `daml/Mutants/B6DoubleAccept.daml` | A `nonconsuming` proposal can be accepted twice → double-spend | Workflow (Tier 3) | ✅ implemented |
| B7 | `daml/Mutants/B7ExpiredOffer.daml` | An expired offer still executes (no clock check) | Workflow (Tier 3) | ✅ implemented |
| B8 | `daml/Mutants/B8PrivacyLeak.daml` | An accidental extra observer → Eve sees a token | Privacy (Tier 4) | ✅ implemented |
| B9 | _(planned)_ | Supply cap not enforced | Conservation/cap | ⬜ planned |
| B10 | _(planned)_ | Wrong party paid in a multi-leg settlement | Conservation/auth | ⬜ planned |

> All four property tiers are now exercised by the bug zoo: Tier 1 (B1, B2, B4,
> B5), Tier 2 (B3), Tier 3 (B6, B7), Tier 4 (B8). B9–B10 remain on the roadmap.

## How B1 catches its bug (read the file alongside)

`B1Inflation.daml` is `Token.daml` with one line changed:

```daml
second <- create this with amount = amount   -- BUG: should be `amount - splitAmount`
```

The same 200-round random loop from `Fuzz.daml` runs against it. The first time
it performs a split, the total jumps above 100, `checkState` returns a
conservation violation, and the test passes **because it caught the bug**. The
`debug` output prints the recipe.

## How B2 catches its bug

`B2NoPositivity.daml` deletes one guard:

```daml
-- BUG B2: the "splitAmount must be positive" guard has been deleted.
assertMsg "splitAmount must be smaller than amount" (splitAmount < amount)
```

This bug only shows up with an *illegal* input, so the test does it directly:
split by `-50`, then check — a negative balance now exists, non-negativity
fails, the bug is caught.

## Recipe: how to add the next mutant (B3 — an authorization hole)

This is the most valuable property class for institutions, so it's the natural
next one. Create `daml/Mutants/B3AuthHole.daml`:

```daml
module Mutants.B3AuthHole where

import Daml.Script

initialSupply : Decimal
initialSupply = 100.0

template TokenB3
  with
    issuer : Party
    owner  : Party
    amount : Decimal
  where
    signatory issuer
    observer owner

    -- BUG B3: the controller is `issuer`, not `owner`. The issuer can move
    -- anyone's token without the owner's consent. The authorization rule names
    -- the WRONG party. (Real-world variants: a public observer made a
    -- controller, or the `controller` line omitted/too broad.)
    choice Seize : ContractId TokenB3
      with newOwner : Party
      controller issuer            -- should be `owner`
      do create this with owner = newOwner

fuzzB3 : Script ()
fuzzB3 = do
  issuer <- allocateParty "Issuer"
  alice  <- allocateParty "Alice"
  eve    <- allocateParty "Eve"

  cid <- submit issuer do
    createCmd TokenB3 with issuer, owner = alice, amount = initialSupply

  -- The attack: the issuer seizes Alice's token and hands it to Eve, with no
  -- consent from Alice. On a CORRECT contract (controller owner) this submit
  -- would fail. Here it succeeds -> the authorization hole is caught.
  _ <- submit issuer do exerciseCmd cid Seize with newOwner = eve

  toks <- query @TokenB3 issuer
  let stolen = any (\(_, t) -> t.owner == eve) toks
  if stolen
    then debug "BUG B3 CAUGHT (as expected): a non-owner reassigned ownership.\nRecipe: step 1: Issuer Seize -> Eve"
    else assertMsg "FUZZER MISSED bug B3 (authorization hole)" False
```

Then add a row for B3 to `scripts/scorecard.ps1` (copy an existing row), run
`daml test`, and confirm it's caught. **Verify it compiles before moving on** —
that's the golden rule in action.

> The correct contract's defense against this exact class is already tested in
> `Fuzz.daml` → `fuzzAuthClean`, where Eve (a true outsider) is confirmed
> blocked. B3 is the matching mutant that proves the Tier-2 check has teeth.

## Adding B4 and beyond

The pattern is always the same:
1. Copy the correct template, rename it (`TokenB4`, …) and its choices.
2. Introduce **one** bug.
3. Write a small `Script` that proves the fuzzer catches it (passes when caught).
4. Add a scorecard row. Run `daml test`. Keep it green.

Some (B4, B5, B9) need a new **Merge** or **Archive/Redeem** choice on the
template first; B6–B7 need a propose/accept workflow (Tier 3); B8 needs a
privacy property that queries the ledger *as Eve* and asserts she sees nothing
she shouldn't (Tier 4). These belong to the grant milestones, not the PoC.

Next: **guide 06** — turning this into a funded project.
