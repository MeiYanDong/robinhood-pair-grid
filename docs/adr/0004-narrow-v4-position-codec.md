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

## Decision

- Keep `viem` as the only direct production dependency.
- Maintain the small required v4 position implementation in `lib/uniswap-v4-position.mjs`.
- Attribute the Uniswap MIT-derived TickMath constants and encoding structures in
  `THIRD_PARTY_NOTICES.md`.
- Lock behavior with fixed vectors generated from `@uniswap/v4-sdk@2.3.3`: pool id, BUY and SELL liquidity,
  boundary composition, burn minimums and byte-identical mint/increase/remove calldata hashes.
- Require a canonical-chain `eth_call` of the current full-removal calldata before deploying this migration.
- Raise `npm audit --omit=dev` and GitHub Dependency Review to fail on high or critical advisories.
- Retry transient npm audit transport failures a bounded number of times, but accept only a complete
  vulnerability result; exhausted retries remain a failed gate.
- Keep deployment manual and unarmed; this dependency decision does not authorize signing or timer enablement.

## Consequences

The production install no longer carries the unrelated Hardhat/ethers v5 toolchain. The project now owns a
small amount of protocol math and ABI encoding, so protocol upgrades or PositionManager changes require new
compatibility vectors and simulation evidence. Golden tests prevent unnoticed output drift but are not a
substitute for chain simulation and post-deployment readback.
