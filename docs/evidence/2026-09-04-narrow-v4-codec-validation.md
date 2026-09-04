# Narrow v4 codec validation evidence

Date: 2026-09-04

Status: Local implementation and pull-request CI validated; deployment pending

## Scope

Replace `@uniswap/v4-sdk` and `@uniswap/sdk-core` as production dependencies without changing strategy
parameters, wallet state or transaction bytes. No signing, broadcast, server deployment or timer change is in
scope for this validation stage.

## Current upstream boundary

At the observation time, npm reported `2.3.3` as the latest `@uniswap/v4-sdk` release and `7.19.2` as the
latest `@uniswap/sdk-core` release. The v4 package still declared ethers v5 and the v3 SDK dependency chain
that installed Hardhat and its tooling in production. `npm audit fix --force` proposed an older major SDK and
was not used.

## Deterministic compatibility evidence

The committed test vectors generated from `@uniswap/v4-sdk@2.3.3` cover:

- TickMath and the deployed PAIR/SPY pool id;
- BUY and SELL single-sided liquidity and mint bounds;
- position composition below, inside and above the configured range;
- full-removal slippage minimums;
- exact byte lengths and keccak256 hashes for mint, increase and remove calldata.

A separate one-time differential probe installed the old SDK only in a temporary `/tmp` directory and compared
420 deterministic numerical cases plus 120 complete calldata cases. It returned `PARITY_OK` for all 540
comparisons. The temporary SDK was not added to the repository dependency graph.

## Local gates

After a clean install with the old packages absent from `node_modules`:

```text
npm run verify: PASS
tests: 33 passed, 0 failed
line coverage: 92.35%
branch coverage: 68.85%
function coverage: 97.26%
uniswap-v4-position.mjs line coverage: 97.45%
```

`npm ls --omit=dev --all` showed `viem@2.56.3` as the only direct production dependency. The first complete
pull-request audit correctly found one high-severity advisory in the hoisted `ws@8.18.0` peer dependency. The
lockfile was deduplicated so both `viem` and `isows` now resolve to the patched `ws@8.21.0`; a clean install then
contained 87 total packages and 15 production packages.

The final pull-request gates passed on commit `44bf13cd3edf9e457864a32851eb865dc25c7761`:

- [CI run 33852780277](https://github.com/MeiYanDong/robinhood-pair-grid/actions/runs/33852780277): `verify`
  passed in 3m22s, including formatting, lint, shell syntax, type checking, 33 tests, coverage thresholds,
  systemd verification and the production audit;
- the online audit's first request timed out, then its bounded second attempt returned a structurally complete
  result with 0 total, high or critical vulnerabilities across 87 dependencies;
- [dependency-review run 33852780238](https://github.com/MeiYanDong/robinhood-pair-grid/actions/runs/33852780238):
  passed at the high-severity threshold;
- `secret-scan`: passed.

The retry wrapper only accepts a structurally complete npm vulnerability result, still fails immediately on a
real high/critical result, and fails after exhausted transport retries. CI and release installation also disable
npm's duplicate install-time audit; the explicit fail-closed audit remains the single security gate.

## Canonical-chain no-broadcast evidence

The migrated executable completed a normal `status` read at block `54091372`: local state remained
`BUY_ACTIVE`; NFT `1715883` owner, liquidity and nonce matched the durable state; no HALTED sentinel was
present.

At block `54091713`, an `eth_call` from the configured wallet to the deployed PositionManager accepted the new
full-removal calldata for NFT `1715883`:

```text
status: ETH_CALL_SUCCESS_NO_BROADCAST
calldata bytes: 676
calldata hash: 0x34ab28a5e9393079a1b72eadeb9b9a46f243e3d9ce0056dd487092cc444bce5b
return data: 0x
amount0Min: 15874161618478582
amount1Min: 0
```

This proves EVM acceptance at the observed state only. It is not a transaction receipt or authorization to
deploy or enable the keeper.
