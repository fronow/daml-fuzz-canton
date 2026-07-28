# Contributing to daml-fuzz

Thanks for your interest in improving daml-fuzz.

## Development setup

- **Node.js ≥ 23.6** — the sources are TypeScript run directly (native type
  stripping, no build step). There are no runtime dependencies.
- **Daml SDK 3.x** (`daml`, `damlc`) on your `PATH` for anything that touches a
  DAR or a ledger.
- **An OpenJDK** (e.g. Temurin 21) for running a local Canton sandbox — note
  that **Oracle JDK does not work** with Canton.

```
npm install       # dev-only deps (@types/node, typescript) for the editor
npm test          # hermetic test suite — no ledger required
npm run typecheck # tsc --noEmit
```

## Before opening a pull request

- `npm test` passes and `npm run typecheck` is clean. CI runs both.
- New behaviour is covered by a **hermetic** test (see `test/` — the existing
  tests hand-build inputs and need no ledger or SDK). Tests that require a live
  ledger are not run in CI; keep the core logic testable without one.
- Match the surrounding style. This is plain, dependency-free TypeScript; please
  keep it that way (no runtime dependencies).
- One Node quirk to know: strip-only TypeScript mode rejects constructor
  parameter properties — declare class fields explicitly.

## Reporting a security finding in someone else's contract

daml-fuzz is a tool for finding bugs. If you use it to find a real
vulnerability in a third party's Daml code, **disclose it privately to that
project's maintainers first**, with a reasonable window, before publishing.
Responsible disclosure is expected.

## License

By contributing, you agree that your contributions are licensed under the
Apache License 2.0, the same license as the project.
