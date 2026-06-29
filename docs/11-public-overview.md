# 11 · Project overview

## What daml-fuzz is

daml-fuzz is an open-source property-based **fuzzer for Daml smart contracts on
Canton**. You declare the rules your contract must never break; it generates
many randomized, multi-party transaction sequences and reports any sequence that
breaks a rule — with a reproduction recipe.

It targets the risks that are specific to Canton — **conservation of value,
multi-party authorization, and privacy/disclosure** — rather than EVM-style
risks. To our knowledge it is the first tool doing adversarial input generation
for Daml.

## What's built today (proof of concept)

- A working fuzzer (pure Daml Script) with four property classes:
  **value invariants** (conservation and non-negativity), **authorization** (an
  adversary who must always be rejected), **multi-step workflow** (a one-shot
  action can't be replayed; an expired offer can't execute), and
  **privacy/disclosure** (a party must never observe data it shouldn't).
- A **mutation-tested bug zoo** of 8 planted bugs spanning all four tiers, used
  to measure how many the fuzzer catches. Current score: **8 of 8 caught, with
  zero false positives** on the correct contract.
- A self-contained **HTML assurance report**.

## What's proven

We pointed it at **real, production Canton code** (a public CIP-56 token
implementation): the core value-conservation, authorization, and transfer-path
properties **held** under hundreds of randomized rounds. That's the difference
between a demo and a tool — it runs on real contracts. (A detailed findings
report is shared with affected maintainers under responsible disclosure before
any public release.)

## Where it's going (outcomes, not recipes)

- **Fuzz any contract with no manual setup** — point it at a compiled package
  and it figures out what to test.
- **Smarter exploration** — guided generation that reaches deep, rare states
  instead of only shallow random ones.
- **Minimal reproductions** — automatically shrink a failing sequence to the
  smallest steps that still break the rule.
- **CI-native** — a one-line GitHub Action that fuzzes every pull request.
- **Privacy depth** — the disclosure properties that no EVM tool can express.

## How a result looks

For each issue the report gives: the **property that broke**, the **contract /
choice involved**, a **severity**, and a **deterministic reproduction recipe**
(the exact steps). Re-running with the same seed reproduces it exactly.

## License & status

Apache-2.0. Proof-of-concept stage; the capabilities above marked "where it's
going" are roadmap, not yet shipped.

---

### Note on what we keep private (and why it's fine)

The tool will be open-source, so the *code* is public by design. What we don't
publish ahead of time is the **detailed technical playbook** (the exact
generation strategy and privacy-fuzzing internals) and the **business/strategy**
material. Our durable advantage isn't a secret algorithm — it's **being first,
the depth of Canton-specific expertise, and a track record of real findings that
earns trust**. Those can't be copied from a README.
