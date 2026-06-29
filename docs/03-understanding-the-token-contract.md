# 03 · Understanding the token contract (`daml/Token.daml`)

This guide walks through a real Daml contract line by line. Once you understand
this one small file, you understand the shape of *every* Daml contract.

Open `daml/Token.daml` alongside this guide.

## The whole thing in one sentence

`Token.daml` defines a digital token that has an issuer, an owner, and an
amount, and that can be **transferred** to someone else or **split** into two.

## Line by line

```daml
module Token where
```
Every Daml file starts by naming its **module**. The name must match the file
path under `daml/`. This file is `daml/Token.daml`, so the module is `Token`.

```daml
template Token
  with
    issuer : Party
    owner  : Party
    amount : Decimal
  where
```
This declares a **template** (a contract blueprint) named `Token`. The `with`
block lists its **fields** (the facts stored on the contract):
- `issuer : Party` — who created/guarantees it,
- `owner : Party` — who currently holds it,
- `amount : Decimal` — its value (`Decimal` = a number with decimals).

```daml
    signatory issuer
    observer owner
```
- **`signatory issuer`**: the token only exists under the issuer's authority.
  Signatories are the "required signatures" on our piece-of-paper analogy.
- **`observer owner`**: the owner is allowed to *see* the contract. (Privacy is
  the default on Canton — if you are not a stakeholder, you cannot see it.)

```daml
    choice Transfer : ContractId Token
      with
        newOwner : Party
      controller owner
      do create this with owner = newOwner
```
A **choice** is an action. Reading it piece by piece:
- `choice Transfer : ContractId Token` — an action named `Transfer` that returns
  a reference (`ContractId`) to a new `Token`.
- `with newOwner : Party` — it takes one input: who to transfer to.
- `controller owner` — **only the current owner may run this.** This is the
  authorization rule. It is the single most security-critical line.
- `do create this with owner = newOwner` — the body: create a copy of this
  token (`this`) but with the owner changed. (Running a choice archives the old
  contract; here we create the replacement.)

```daml
    choice Split : (ContractId Token, ContractId Token)
      with
        splitAmount : Decimal
      controller owner
      do
        assertMsg "splitAmount must be positive"            (splitAmount > 0.0)
        assertMsg "splitAmount must be smaller than amount" (splitAmount < amount)
        first  <- create this with amount = splitAmount
        second <- create this with amount = amount - splitAmount
        pure (first, second)
```
The `Split` choice turns one token into two. Important bits:
- it returns **two** contract references (a tuple).
- **`assertMsg "..." (condition)`** — a guard. If the condition is false, the
  whole action is rejected and nothing happens. These two guards say: the split
  amount must be positive, and smaller than what you have.
- it then creates two new tokens: one worth `splitAmount`, one worth
  `amount - splitAmount`. **The two pieces add up to the original.** That is the
  whole point — value is conserved.
- `pure (first, second)` — return the two new references.

## Why this file matters for the fuzzer

This is the **correct** contract — our baseline of "good behavior". The fuzzer
fires hundreds of random transfers and splits at it and confirms the value
always adds up and never goes negative.

The **bugs** live in copies of this file under `daml/Mutants/`, where exactly
one thing is broken on purpose:
- `B1Inflation.daml` keeps the guards but changes the maths so the pieces add up
  to *more* than the original (value created from nothing).
- `B2NoPositivity.daml` deletes the "must be positive" guard, so a malicious
  split by `-50` is wrongly accepted.

Compare `Token.daml` with those two files side by side — spotting the single
changed line in each is the best way to learn what these bugs are.

Next: **guide 04** — how the fuzzer actually drives this contract.
