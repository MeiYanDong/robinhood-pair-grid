# ADR 0004: Replace the broad Uniswap runtime SDK with a narrow v4 position codec

Status: Accepted

Date: 2026-09-04

## Context

The current npm release of `@uniswap/v4-sdk` (`2.3.3`) brings ethers v5 and a v3 SDK chain that installs
Hardhat, solc, Mocha and other tooling in production. The deployed keeper only used five SDK concepts:
TickMath and liquidity arithmetic, position composition, mint/remove slippage bounds, pool-id derivation and
PositionManager calldata encoding. No current upstream version removes the broad runtime dependency tree.

`npm audit fix --force` proposed installing an older major SDK version. That would be a transaction-encoding
change without evidence and was rejected.

During pull-request validation, npm's Bulk Advisory request repeatedly fell back to the retired Quick Audit
endpoint and timed out. npm documents that fallback behavior, and the failure was reproduced on both the local
machine and GitHub-hosted runners. A security gate whose transport is known to be unavailable cannot provide a
reliable merge decision.

## Decision

- Keep `viem` as the only direct production dependency.
- Maintain the small required v4 position implementation in `lib/uniswap-v4-position.mjs`.
- Attribute the Uniswap MIT-derived TickMath constants and encoding structures in
  `THIRD_PARTY_NOTICES.md`.
- Lock behavior with fixed vectors generated from `@uniswap/v4-sdk@2.3.3`: pool id, BUY and SELL liquidity,
  boundary composition, burn minimums and byte-identical mint/increase/remove calldata hashes.
- Require a canonical-chain `eth_call` of the current full-removal calldata before deploying this migration.
- Enumerate the exact non-dev package versions from `package-lock.json`, including production peer entries, and
  query the official GitHub Advisory Database `affects=package@version` API separately for high and critical
  reviewed advisories.
- Validate every response shape, paginate boundedly and retry transport failures boundedly. A high or critical
  finding, malformed response, exhausted retry or pagination overflow fails the gate.
- Keep GitHub Dependency Review at the high-severity threshold as an independent pull-request check.
- Keep deployment manual and unarmed; this dependency decision does not authorize signing or timer enablement.

## Consequences

The production install no longer carries the unrelated Hardhat/ethers v5 toolchain. The project now owns a
small amount of protocol math and ABI encoding, so protocol upgrades or PositionManager changes require new
compatibility vectors and simulation evidence. Golden tests prevent unnoticed output drift but are not a
substitute for chain simulation and post-deployment readback. The current-tree vulnerability gate now depends
on GitHub's public Advisory API instead of npm's audit transport; API unavailability remains fail-closed.
