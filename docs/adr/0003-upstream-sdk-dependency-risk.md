# ADR 0003: Upstream Uniswap SDK dependency risk

Status: Open; blocks unattended live activation

Date: 2026-09-04

## Observation

`npm audit --omit=dev` on the deployed production dependency tree reported 30 advisories: 16 low, 4 moderate,
10 high and 0 critical. The direct package is the current npm release of `@uniswap/v4-sdk` (`2.3.3`). Most
high-severity paths enter through either its ethers v5 dependency or this chain:

```text
@uniswap/v4-sdk
  -> @uniswap/v3-sdk
  -> @uniswap/swap-router-contracts
  -> hardhat-watcher
  -> hardhat
```

Several affected packages are tooling dependencies pulled into the production tree by upstream package
metadata rather than code intentionally invoked by this keeper. That reduces likely reachability but does not
make the advisories disappear.

After GitHub Dependabot alerts were enabled, it additionally classified the transitive
`@openzeppelin/contracts@3.4.1-solc-0.7-2` package as critical under `GHSA-fg47-3c2x-m2wr`. The keeper does not
deploy or call the affected `TimelockController`, but a runtime-scoped critical dependency still requires an
explicit patch. The lockfile therefore overrides all OpenZeppelin Contracts paths to the vendor-published
fixed build `3.4.2-solc-0.7`.

## Decision

- Do not run `npm audit fix --force`; npm proposes a semver-major downgrade and that would change calldata
  behavior without adequate evidence.
- CI blocks any critical production advisory and records high advisories visibly.
- Pull requests run GitHub Dependency Review and block newly introduced critical advisories that npm may
  classify differently.
- Keep the production timer disabled while this ADR is open.
- Use exact lockfile versions and `--ignore-scripts` for production installation.
- Before unattended activation, either document tested non-reachability for the installed bundle or remove the
  broad SDK dependency in favor of a narrowly reviewed transaction encoder.

## Consequences

The code, encrypted credential and read-only checks may be deployed, but this repository must not claim the
dependency risk is resolved or the strategy is ready for unattended signing.
