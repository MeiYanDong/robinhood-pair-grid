# Operator runbook

## Routine readback

```bash
npm run halt-status
npm run status
```

`status` is read-only and does not require a credential. Confirm chain ID, `latest === pending === expected`,
NFT owner, liquidity and local status.

## HALTED recovery

1. Keep the systemd timer disabled.
2. Run `npm run halt-status` and preserve the reason.
3. Run `npm run reconcile` without `PAIR_GRID_LIVE_ARM=1`.
4. Review the canonical transaction hashes and post-state readback.
5. Only when state is consistent, run:

```bash
PAIR_GRID_UNHALT_CONFIRM=I_UNDERSTAND npm run clear-halt
```

6. Run `npm run status` again before considering activation.

Never delete state, the lock or HALTED files to force progress. Never retry a hash with unknown receipt.

## Live activation

Activation is separate from deployment. Set `PAIR_GRID_LIVE_ARM=1` in the root-owned runtime environment,
then run one manual `keeper-once` while observing logs. Enable the timer only after that command returns a
healthy `NO_ACTION` or a fully evidenced rotation.

## Emergency exit

Disable the timer first. `npm run exit` removes liquidity and retains the resulting tokens; it does not market
sell them. An exit failure follows the same HALTED and reconcile process.
