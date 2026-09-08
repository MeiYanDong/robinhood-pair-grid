# Operator runbook

## Routine readback

```bash
npm run halt-status
npm run status
```

`status` is read-only and does not require a credential. Confirm chain ID, `latest === pending === expected`,
NFT owner, liquidity and local status.

For the isolated PAIR/USDG strategy:

```bash
npm run martingale-status
npm run martingale-reconcile
```

Normal output has five active NFTs, matching latest/pending/expected nonce, no SPY and no pending rotation. The
systemd timer invokes `martingale-keeper-once` every 30 seconds and does not require an interactive signature.

## External alerts

Legacy PAIR/SPY monitoring runs every five minutes. The isolated PAIR/USDG monitor runs every minute and also
requires a successful Keeper heartbeat no older than 120 seconds. They route:

- every Keeper systemd failure immediately;
- a durable `HALTED` sentinel immediately and again after six hours while it remains unresolved;
- chain readback after three consecutive failures and again after six hours while failures continue.
- an absent or stale PAIR/USDG Keeper success heartbeat immediately and again after six hours.

The Feishu credential is separate from the wallet credential. Provider acceptance is logged only as
`EXTERNAL_ALERT_ACKNOWLEDGED` with an event ID, `providerCode: 0` and timestamp; webhook and signing secret must
never appear in the journal.

For a synthetic test:

```bash
sudo systemctl start robinhood-pair-grid-alert-test.service
sudo journalctl -u robinhood-pair-grid-alert-test.service --no-pager -n 30
```

Confirm both the Feishu message and provider acknowledgement. The synthetic unit cannot load the wallet key and
does not invoke any strategy command.

Escalation:

1. For `service-failure`, keep the trading timer disabled and inspect both the keeper and alert journals.
2. For `persistent-halted`, follow the HALTED recovery below; never clear the sentinel just to silence alerts.
3. For `repeated-readback-failure`, verify network, DNS, RPC and canonical chain state before trusting local
   state or taking any write action.
4. If alert delivery itself fails, use the alert unit journal and Alibaba Cloud control plane as the fallback;
   rotate the Feishu webhook and signing secret if either may have leaked, then repeat the synthetic proof.

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

The isolated strategy uses `PAIR_MARTINGALE_LIVE_ARM=I_AUTHORIZE_FINITE_MARTINGALE`. This is a persistent
machine guard, not a prompt. After the dedicated key check, status readback and one-shot keeper all pass, enable
`robinhood-pair-usdg-martingale.timer`. Do not enable the legacy timer as a side effect.

If the martingale reports `WAITING_NO_ACTION`, inspect gas balance or UTC limits and leave the state intact. If
it persists a hard halt, disable only its timer, preserve the signed-intent ledger, run reconciliation against
canonical receipts, and never delete the pending state to force a retry.

The martingale status report includes only RPC endpoint counts, never endpoint URLs. `reads.failoverAvailable`
is true only after at least two read endpoints are configured. Broadcast fanout defaults to the configured read
endpoints plus the official Robinhood Sequencer; a successful broadcast is still not completion until the exact
hash has a canonical receipt and post-state readback.

## PAIR hard-floor rebase

Keep the Keeper timer stopped for the whole migration. First inspect the exact source NFTs and target plan:

```bash
npm run martingale-rpc-consensus-check
npm run martingale-rebase-floor-plan
```

The approved migration keeps B1 unchanged, derives four adjacent B2-B5 ranges from the live tick with a
200-tick entry gap and a `0.01` hard floor, burns the source NFTs one at a time with canonical receipt gates,
grants only the exact aggregate USDG allowance, then batch-mints the four USDG-only targets. If the live price
leaves too little useful space above the floor, planning returns `WAIT` before any source NFT is removed. Start
or resume it with:

```bash
npm run martingale-rebase-floor
npm run martingale-resume-rebase-floor
```

On the production host, run the signing path through the dedicated hardened unit so it receives only the
isolated martingale credential:

```bash
sudo systemctl start robinhood-pair-usdg-martingale-rebase-floor.service
sudo journalctl -u robinhood-pair-usdg-martingale-rebase-floor.service --since today
```

The unit is intentionally manual-only, conflicts with the normal Keeper service, and resumes from the persisted
`pendingRebase` record after an interruption.

Do not delete `pendingRebase` after an interruption. A price move into the target range returns `WAIT` and leaves
the already removed capital in USDG. Resume only through the persisted command. After completion, require five
owned NFTs, matching owner/liquidity/ticks, exact nonce agreement, a healthy one-shot `NO_ACTION`, and only then
restart the timer.

## Emergency exit

Disable the timer first. `npm run exit` removes liquidity and retains the resulting tokens; it does not market
sell them. An exit failure follows the same HALTED and reconcile process.
