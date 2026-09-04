# Narrow-codec unarmed SWAS deployment evidence

Date: 2026-09-04

Status: Deployed and independently read back; automatic trading remains disabled

Scope: dedicated Ubuntu 24.04 SWAS host in `us-west-1`. Public evidence omits the server address, instance ID,
wallet address, transaction hashes and provider request identifiers.

## Repository and security gates

- [Pull request 13](https://github.com/MeiYanDong/robinhood-pair-grid/pull/13) passed `verify`, `secret-scan`
  and high-severity `dependency-review`, then squash-merged as
  `877ea256f5c4c43684dc50d184953441401c6e1e`.
- [Main CI run 33854392516](https://github.com/MeiYanDong/robinhood-pair-grid/actions/runs/33854392516)
  independently passed the locked install, formatting, lint, shell syntax, type checking, 39 tests, coverage
  thresholds, high/critical production advisory scan, systemd verification and full-history secret scan.
- The production dependency blocker was closed by the merge. A post-merge Dependabot API read returned zero
  open alerts for the default branch.
- The public calldata fixtures use a synthetic wallet and NFT id. Their four updated hashes were independently
  regenerated with `@uniswap/v4-sdk@2.3.3` before this evidence update; no runtime code changed.

## Immutable release

- [Release run 33854497872](https://github.com/MeiYanDong/robinhood-pair-grid/actions/runs/33854497872)
  accepted the exact full commit SHA only after confirming it belongs to `main`, reran all gates and built the
  source artifact.
- Artifact SHA256:
  `38fc4a256155374b52e4c871dd32f425cf643fe9c0eab7fb87385b75d54930d5`.
- The downloaded artifact passed its embedded checksum and was byte-identical to a local `git archive` of the
  same commit. The remote upload matched the same SHA256 before installation.

## Server installation

- The pre-deploy active release was `b8d99be96efe952aa538c0e6ce65170130ce2371`; the timer was disabled and
  inactive, the keeper was inactive and `PAIR_GRID_LIVE_ARM=0`.
- The installer completed a production-only install of 14 packages, ran all 39 tests and switched the active
  symlink to `/opt/robinhood-pair-grid/releases/877ea256f5c4c43684dc50d184953441401c6e1e`.
- The release directory remained root-owned with group `pair-grid` and mode `0750`. The encrypted credential and
  runtime environment remained root-owned with mode `0600`; the installer reported that no credential changed.
- The installed dependency tree has `viem@2.56.3` as its only direct production dependency and resolves both
  `viem` and `isows` to `ws@8.21.0`. The server-side current-tree advisory scan returned 14 package versions,
  zero high findings and zero critical findings.

## Runtime and canonical-chain readback

- The systemd credential service returned `CREDENTIAL_OK`; the derived address matched the configured public
  wallet and `privateKeyPrinted` was false.
- The read-only status service completed successfully at block `54131011`. Local state remained `BUY_ACTIVE`
  with one BUY NFT; owner and liquidity matched the durable state; latest, pending and expected nonce were all
  `4`; the position was outside its range and not fully converted.
- After both checks, `PAIR_GRID_LIVE_ARM=0`, the timer remained `disabled` and `inactive`, and the write-capable
  keeper service remained `inactive`.
- Deployment executed only installation, credential verification, advisory lookup and canonical readback. It
  did not sign or broadcast a transaction and did not enable any schedule.

## Remaining production blockers

- [Issue 8](https://github.com/MeiYanDong/robinhood-pair-grid/issues/8): no externally delivered keeper failure
  alert channel is configured.
- [Issue 9](https://github.com/MeiYanDong/robinhood-pair-grid/issues/9): SSH administration is not yet behind a
  stable allowlisted VPN or bastion egress.
- [Issue 10](https://github.com/MeiYanDong/robinhood-pair-grid/issues/10): the host-bound credential is not a
  hardware-backed signer; the host has no usable TPM and its root filesystem is not encrypted.

Therefore this is a verified **unarmed deployment**, not authorization to activate unattended trading and not
evidence of future economic performance.
