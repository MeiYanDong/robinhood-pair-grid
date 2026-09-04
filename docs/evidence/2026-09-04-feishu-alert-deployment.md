# Feishu external alert deployment evidence

Date: 2026-09-04

Status: Live delivery and recurring read-only monitoring verified; automatic trading remains disabled

Scope: dedicated Ubuntu 24.04 SWAS host in `us-west-1`. Public evidence omits the server address, instance ID,
wallet address, bot webhook, signing secret, provider event identifiers and transaction identifiers.

## Repository and release gates

- [Pull request 15](https://github.com/MeiYanDong/robinhood-pair-grid/pull/15) introduced the isolated
  signed Feishu transport, failure route, durable monitor, synthetic unit, runbook and tests. It merged as
  `c5a8e9f5b052b5c3f53fe86f9c150cd7cc9e7db2` after `verify`, `secret-scan` and `dependency-review` passed.
- Live unarmed verification caught two defects before the monitor was left enabled. The monitor expected a
  nonexistent status field, and the first timer form could become active without a future trigger after being
  re-enabled. Both timers were disabled immediately after the failed runtime checks; neither defect reached the
  three-failure alert threshold.
- [Pull request 16](https://github.com/MeiYanDong/robinhood-pair-grid/pull/16) aligned validation with the real
  canonical readback contract and added production-shaped regression coverage. It merged as
  `154d7be830c8951bf1dfb14f207e94660135d0f1`.
- [Pull request 17](https://github.com/MeiYanDong/robinhood-pair-grid/pull/17) replaced the stale monotonic timer
  basis with an explicit five-minute calendar schedule and added unit-file assertions. It merged as the final
  deployed commit `14b18ea8293e28dd5be594ec58f66c13e82b0a78`.
- [Main CI run 33873983275](https://github.com/MeiYanDong/robinhood-pair-grid/actions/runs/33873983275)
  passed the locked install, formatting, lint, shell syntax, type checking, 53 tests, coverage thresholds,
  high/critical production advisory gate, Linux systemd verification and full-history secret scan.
- [Release run 33874031517](https://github.com/MeiYanDong/robinhood-pair-grid/actions/runs/33874031517)
  accepted only the exact full `main` commit and rebuilt all gates before packaging. The artifact passed its
  embedded checksum, was byte-identical to a local `git archive`, matched its remote upload, and had SHA256
  `163efec930e2d6278a532439b3296aa7516e87eff8bc197601ed235a0e4e3253`.
- The server installer completed a production-only install of 14 package versions and all 53 tests. A
  current-tree server audit reported zero high and zero critical advisories.

## Credential handling and isolation

- A dedicated private Feishu group and custom bot were created, and signature verification was enabled.
- The webhook and signing secret were stored as separate macOS Keychain generic-password items and each value
  matched an immediate Keychain readback. Splitting the values avoided the interactive `security` command's
  line-length limit; the incomplete combined item from the first write attempt was deleted.
- The runtime JSON was assembled only in process memory and sent over encrypted SSH standard input to
  `systemd-creds encrypt`. Neither value entered a local plaintext file, command argument, environment variable,
  GitHub secret, Cloud Assistant command or repository history.
- `/etc/credstore.encrypted/pair-grid-alert` read back as root-owned mode `0600`. The alert and monitor units load
  only `pair-grid-alert`; they do not load the wallet credential. The monitor state is service-owned mode `0600`
  under a mode `0700` state directory.

## External delivery proof

- The final deployed synthetic unit completed with systemd result `success`, exit status `0`, one delivery
  attempt and a redacted `EXTERNAL_ALERT_ACKNOWLEDGED` record whose Feishu `providerCode` was `0`.
- The corresponding `PAIR 网格外部告警链路测试` message was independently visible in the selected Feishu
  group. This proves provider acceptance and UI delivery, not that a human read the message.
- The synthetic unit cannot load the wallet credential and did not invoke a strategy command.

## Monitor and runtime readback

- A manual monitor run and two timer-triggered runs completed with `MONITOR_OK`, `halted: false`,
  `readbackOk: true`, zero consecutive failures and zero alerts.
- At `20:45:12 CST`, the recurring timer recorded a trigger and scheduled the next finite execution for
  `20:50:06 CST`. This replaced the earlier invalid `infinity` schedule and proves that the timer is recurring,
  not merely marked active.
- The independent key check returned `CREDENTIAL_OK` from `SYSTEMD_CREDENTIAL` with
  `privateKeyPrinted: false`. The status service returned
  `CANONICAL_CHAIN_READBACK_WITH_LOCAL_STATE_COMPARISON` and local state `BUY_ACTIVE`.
- Final safety readback: the monitor timer was `enabled` and `active`; the trading timer was `disabled` and
  `inactive`; the write-capable keeper was `inactive`; `PAIR_GRID_LIVE_ARM=0`.
- No transaction was signed or broadcast during bot creation, credential installation, synthetic delivery,
  monitor validation or deployment.

## Acceptance and remaining hardening

[Issue 8](https://github.com/MeiYanDong/robinhood-pair-grid/issues/8) is satisfied: credentials are outside Git
and argv, service failure/HALTED/repeated-readback routes are installed, provider and UI delivery were observed,
and escalation is documented in the runbook.

The Feishu IP allowlist is not yet configured and remains tracked as
[Issue 18](https://github.com/MeiYanDong/robinhood-pair-grid/issues/18). Stable SSH allowlisting and stronger
signer protection remain open in [Issue 9](https://github.com/MeiYanDong/robinhood-pair-grid/issues/9) and
[Issue 10](https://github.com/MeiYanDong/robinhood-pair-grid/issues/10). These gaps do not negate the external
alert proof, but unattended trading remains unauthorized and unarmed.
