# Operator runbook

## Routine readback

```bash
npm run halt-status
npm run status
```

`status` is read-only and does not require a credential. Confirm chain ID, `latest === pending === expected`,
NFT owner, liquidity and local status.

## External alerts

The independent monitor runs every five minutes after its own timer is enabled. It routes:

- every Keeper systemd failure immediately;
- a durable `HALTED` sentinel immediately and again after six hours while it remains unresolved;
- chain readback after three consecutive failures and again after six hours while failures continue.

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

## Emergency exit

Disable the timer first. `npm run exit` removes liquidity and retains the resulting tokens; it does not market
sell them. An exit failure follows the same HALTED and reconcile process.
