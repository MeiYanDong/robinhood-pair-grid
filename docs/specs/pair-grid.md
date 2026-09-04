# PAIR grid technical specification

Status: Accepted for canary operation

Version: 0.2.0

Date: 2026-09-04

## Goal

Operate one single-sided PAIR/SPY Uniswap v4 position at a time, rotating only after the active position has
fully converted. Minimize operator transactions while preserving strict signing, accounting and recovery
boundaries.

## Non-goals

- market making with two simultaneously funded positions;
- leverage, borrowing or derivatives;
- automatic range optimization;
- automatic retry after an unknown receipt;
- automatic production deployment or activation on merge.

## Invariants

1. The runtime chain, token metadata, contract bytecode and pool identity match the compiled configuration.
2. The credential-derived signer equals `PAIR_GRID_WALLET`.
3. `latestNonce === pendingNonce === expectedNextNonce` before a new strategy transaction.
4. The active NFT is owned by the signer and its liquidity equals the local ledger.
5. At most one leg has non-zero liquidity.
6. Rotation requires both tick-boundary completion and single-sided composition completion.
7. Any ambiguous state persists `HALTED`; only canonical audit plus receipt evidence may reconcile it.
8. A live transaction requires both the process lock and `PAIR_GRID_LIVE_ARM=1`.

## State machine

```text
BUY_FUNDING_PENDING -> BUY_FUNDED -> BUY_ACTIVE
BUY_ACTIVE          -> ROTATION_FUNDED -> SELL_ACTIVE
SELL_ACTIVE         -> ROTATION_FUNDED -> BUY_ACTIVE
BUY_ACTIVE/SELL_ACTIVE -> EXITED

any live-command failure -> HALTED sentinel
HALTED -> reconcile -> explicit clear-halt -> previous strategy state
```

The `HALTED` sentinel is separate from strategy state so canonical reconciliation can preserve and repair the
last known lifecycle phase without erasing the failure record.

## Recovery evidence

For every nonce between local `expectedNextNonce` and chain `latestNonce`, recovery requires exactly one
locally audited broadcast hash. Each hash is then checked against chain transaction sender, nonce and success
receipt. Missing, duplicate, external or pending transactions are not auto-classified.

## Acceptance tests

- healthy incomplete positions return `NO_ACTION`;
- pending nonce, unexpected nonce, owner mismatch, liquidity mismatch and unfinished intent fail before signing;
- process locks reject concurrent keepers;
- `HALTED` survives process restarts and requires an exact acknowledgement;
- every identified receipt/state crash window has a deterministic recovery transition;
- public source contains no production wallet, server locator, state file or signing credential.
