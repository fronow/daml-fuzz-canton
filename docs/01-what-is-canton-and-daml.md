# 01 · What is Canton and Daml? (the gentle version)

You do not need any blockchain background. Here is everything you need, in plain
language.

## Canton — a blockchain for serious money

Most blockchains (Bitcoin, Ethereum) are public: everyone sees everything.
Banks cannot use that — they are not allowed to leak who traded what with whom.

**Canton** is a blockchain designed for **regulated institutions** (banks, asset
managers, exchanges). Its special trick is **privacy**: a transaction is only
visible to the parties actually involved in it. JPMorgan, BlackRock, Goldman,
DTCC and others are building on it. Real assets — tokenized cash, treasury
bonds, money-market funds — already live there.

The key consequence for us: **a bug in a Canton contract is not a toy problem.
It can mean a failed settlement or lost funds at a bank.** That is why a tool
that hunts for those bugs is valuable.

## Daml — the language contracts are written in

A **smart contract** is just a program that runs on the blockchain and enforces
rules automatically. On Canton, you write these programs in a language called
**Daml**.

Daml is built around a few ideas. Learn these five words and the code will make
sense:

- **Party** — an actor on the ledger: a person, a bank, an account. In our code
  the parties are named `Issuer`, `Alice`, `Bob`, and `Eve`.
- **Template** — a *blueprint* for a contract. Like a class in normal
  programming. Our blueprint is called `Token`.
- **Contract** — an actual filled-in instance of a template living on the
  ledger. E.g. "a `Token` worth 100, owned by Alice."
- **Signatory** — the party whose authority the contract exists under. Nothing
  about the contract is valid without their consent.
- **Choice** — an action someone is allowed to take on a contract (e.g.
  `Transfer` it, or `Split` it). Each choice says **who** is allowed to run it
  (the **controller**).

### A tiny mental model

Think of a contract as a piece of paper with:

- some **facts** on it (issuer, owner, amount),
- a list of **signatures** required for it to be real (signatories),
- and a set of **buttons** anyone-allowed can press (choices), where each
  button has a rule about **who may press it** (controller).

Pressing a button (exercising a choice) usually **archives** the old paper and
**creates** new paper. For example, `Transfer` archives "Token owned by Alice"
and creates "Token owned by Bob".

## Why contracts are dangerous (and why fuzzing helps)

The nasty bugs are not usually in a single button press. They appear in
**combinations**: many parties, many steps, in an order nobody wrote a test
for. Examples:

- Split a token, transfer one piece, split that again, merge two pieces back...
  does the total value still add up?
- Can a party who is *not* the owner find some sequence that lets them act
  anyway?

A human writes maybe a dozen tests. A **fuzzer** fires *thousands* of random
sequences and checks, after every single step, that your rules still hold. That
is what this project does. Guide 04 explains exactly how.

## How Daml runs (so guide 02 makes sense)

- You write `.daml` files (we have several in the `daml/` folder).
- The **Daml SDK** is the toolbox that compiles and runs them. The main command
  we use is **`daml test`**, which runs every test script in the project.
- A test script in Daml is written with **Daml Script** — a way to simulate a
  ledger, allocate parties, and submit transactions, all in code. Our fuzzer is
  *itself* a Daml Script. That is why it needs no servers or accounts: it runs
  entirely inside `daml test`.

Next: **guide 02** — install the SDK and run it for real.
