# PAIR price-path stress matrix

Run the real Keeper against offline synthetic RPC, market, receipt and signing adapters. The adapter never produces a valid signature or contacts a live endpoint. These tests verify application state transitions; they do not execute an EVM fork or forecast prices, fees or profit.

```sh
node --experimental-vm-modules scripts/stress/run-price-matrix.mjs /path/to/sanitized-production-seed.json
```

The seed must contain the active policy, positions, accounting and persisted transaction state with credentials removed. Each scenario starts independently from that seed. The current-balance and funded-model profiles use 0.003815642979008 and 0.01 ETH respectively; these are explicit modeled balances, not live queries or transfers. Keep the seed and result files outside Git.

The matrix contains 20 deterministic price paths: slow/fast rise, breakout and pullback, consolidation, threshold chop, wide/narrow oscillation, slow decline, flash crash, V/inverted V, double bottom/top, staircase rise/fall, gap whipsaw, near-zero recovery and three seeded random paths. Each path runs 60 observations across three UTC days under current balance, modeled funded balance and funded balance with transient faults. Faults include RPC outage, stale market, broadcast outage, burn/approval receipt timeout, secondary RPC outage and a Gas-price spike. A fault scheduled when no transaction is eligible does not prove that transaction recovery ran; the separate targeted recovery suite forces those conditions.

Every cycle checks nonce attribution, nonnegative balances, minimum ETH reserve, owner/liquidity agreement, BUY floor and daily transaction/rotation/Gas limits. Final status passes the production monitor validator. A safe wait is reported separately from a completed rotation. No top-ups occur during a run.

For independent profile runs, append `current-balance`, `funded-model` or `faults-funded-model`; each writes a separate JSON result. The legacy regression suite deliberately retains its 6/18/0.002 budget fixture and is not a statement of current production limits.

## Approval receipt recovery

When an approval is mined but its receipt read times out, allowance can already equal the target while the ledger still carries the old nonce. Before checking or skipping allowance, resume any persisted reset/exact approval using its original request. Only canonical receipt reconciliation permits the next transaction. This also applies when a reset has already made allowance zero. Tests force both cases, check unique mined hashes/nonces and validate the final monitor report.

## Synthetic mint accounting

Mint debits calculated token amounts, not maximum input allowances. Residual allowances therefore remain and subsequent rotations may need a fourth transaction to reset approval. The adapter also rejects insufficient execution Gas limits or ETH before mutating simulated chain state. These checks avoid optimistic capacity results caused by always clearing allowances in the mock.
