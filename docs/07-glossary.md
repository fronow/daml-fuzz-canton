# 07 · Glossary

Plain-language definitions. Keep this open while reading the other guides.

## Blockchain / Canton terms

- **Canton** — a privacy-focused blockchain for regulated financial
  institutions. Transactions are only visible to the parties involved.
- **Canton Network** — the live network of Canton participants.
- **Canton Coin (CC)** — the network's token; grants are paid in it.
- **Canton Foundation** — the body that governs the network and runs the
  Development Fund (the grant program).
- **Development Fund** — the grant pool that pays for public-good tooling,
  security, and R&D. Our funding target.
- **Ledger** — the shared record of all contracts and who can see them.
- **Validator / Super Validator** — operators that run the network.
- **CIP-0056** — the Canton token-standard proposal; a good first "real"
  contract to fuzz once the tool is generalized.

## Daml terms

- **Daml** — the programming language for Canton smart contracts.
- **Daml SDK** — the toolkit that compiles and runs Daml. Provides the `daml`
  command.
- **`daml test`** — the command that runs every test script in a project.
- **Daml Script** — a way to write ledger interactions (allocate parties, submit
  transactions) as code. Our fuzzer is a Daml Script.
- **DAR** — a compiled Daml package (a `.dar` file). The funded tool will read
  these to auto-discover what to fuzz.
- **dpm** — the Digital Asset Package Manager; the Daml 3.x toolchain that
  replaces the classic `daml` assistant (removed in Daml 3.5). Optional for the
  PoC; planned for the funded tool.
- **LocalNet** — a full Canton network running on your own machine (synchronizer
  + participant node). You deploy a DAR onto it and run live transactions over
  the gRPC Ledger API. Needed for the funded tool, **not** the PoC.
- **Canton Network Quickstart** — a starter kit that sets up LocalNet + build
  tooling + a sample app for you (`make setup && make build && make start`). The
  convenient on-ramp to LocalNet. Not needed for the PoC.

## Contract building blocks

- **Template** — a blueprint for a contract (like a class). Ours is `Token`.
- **Contract** — a live instance of a template on the ledger.
- **Party** — an actor: a person, bank, or account (`Issuer`, `Alice`, `Bob`,
  `Eve`).
- **Field** — a stored value on a contract (`issuer`, `owner`, `amount`).
- **Signatory** — the party whose authority a contract exists under.
- **Observer** — a party allowed to *see* a contract.
- **Choice** — an action that can be taken on a contract (`Transfer`, `Split`).
- **Controller** — the party allowed to run a particular choice. The
  authorization rule.
- **`ContractId`** — a reference/pointer to a specific contract on the ledger.
- **`submit` / `submitMustFail`** — run a transaction as a party. `submit`
  expects success; `submitMustFail` expects (and requires) failure — used to
  prove an attacker is blocked.
- **`query`** — read the contracts a party can see.
- **`assertMsg`** — reject an action if a condition is false; the contract's
  guard rails.
- **`Decimal`** — a number with decimal places (used for amounts).

## Fuzzing / testing terms

- **Fuzzing** — automatically firing many random inputs at a program to find
  failures.
- **Property-based testing** — instead of checking specific outputs, you state a
  *rule* that must always hold, and the tool searches for any input that breaks
  it.
- **Property / Invariant** — a rule that must always hold (e.g. "value is
  conserved"). See `Properties.daml`.
- **PRNG / seed** — pseudo-random number generator and its starting value. Same
  seed → same sequence → reproducible bugs.
- **Mutation testing** — proving a bug-finder works by planting known bugs and
  counting how many it catches.
- **Mutant** — a copy of a correct contract with exactly one planted bug.
- **Bug zoo** — the whole collection of mutants.
- **Scorecard** — the result: how many planted bugs were caught.
- **Reproduction recipe** — the exact sequence of steps that triggers a found
  bug.
- **Shrinking** — automatically reducing a failing sequence to the smallest one
  that still fails (a grant-milestone feature, not in the PoC).
- **False positive** — the tool reports a bug that isn't real. We test against
  the correct contract specifically to prove we have none.

## Grant terms

- **Champion** — a SIG member who sponsors and shepherds your proposal. Required.
- **SIG (Special Interest Group)** — a topic-focused group of community members
  who review proposals. Ours: "Daml Language & Developer Tooling".
- **`needs-champion` / `needs-sig-label`** — labels meaning a proposal is
  missing those things; until resolved it won't progress.
- **Tech & Ops Committee** — the body that votes on proposals.
- **Milestone** — a funded, measurable chunk of deliverables.
