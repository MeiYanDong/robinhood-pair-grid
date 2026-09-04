# Unarmed SWAS deployment evidence

Date: 2026-09-04

Scope: dedicated Ubuntu 24.04 host in `us-west-1`. Public evidence omits the server address, instance ID,
wallet address, transaction hashes and provider request identifiers.

## Immutable release

- Deployed commit: `b8d99be96efe952aa538c0e6ce65170130ce2371`.
- Deployment artifact SHA256: `d4a9c8191b5ee49a4363e37b53e060902b1a66d0039658daeb2a40a37505c01c`.
- Active symlink resolved to the release directory named by that exact commit.
- Runtime: Node.js `v22.23.2`, npm `10.9.8`.
- The Node.js archive matched the official SHA256 entry before extraction.
- The release installer completed all 26 Node tests and syntax checks before switching the active symlink.
- The installed production tree resolved every `@openzeppelin/contracts` path to the patched
  `3.4.2-solc-0.7` build.

## Runtime readback

- The dedicated systemd credential check succeeded and the key-derived address matched the configured public
  wallet. The private key was not printed, placed in argv or environment, or sent through Cloud Assistant.
- The read-only status service succeeded against canonical chain state.
- Local state was `BUY_ACTIVE` with one active BUY NFT. Owner and liquidity matched the local ledger; the NFT
  was not fully converted.
- Latest, pending and expected nonce were all `4` at the observed readback.
- State and audit files were owned by the service account with mode `0600`; the state directory was `0700`.
- `PAIR_GRID_LIVE_ARM=0`, the timer was `disabled` and `inactive`, and no persistent HALTED file existed.
- The write-capable keeper service was not started. This deployment did not sign or broadcast a transaction.

## Host and network controls

- Password and keyboard-interactive SSH authentication are disabled. Administration uses a dedicated Ed25519
  key; maximum authentication attempts are three, and forwarding, tunnels and X11 are disabled.
- The cloud firewall's unused HTTP and HTTPS rules were removed. The host has no process listening on ports 80
  or 443.
- Port 22 remains open at the cloud layer because the current administration path has rotating egress IPs.
  A trial single-address allowlist was rolled back after live evidence showed a different SSH egress address.
  The host firewall remains inactive to preserve recovery. A stable VPN/bastion allowlist is still required to
  close this gap.

## Repository and delivery controls

- The source is public at [MeiYanDong/robinhood-pair-grid](https://github.com/MeiYanDong/robinhood-pair-grid).
- The protected `main` branch requires an up-to-date pull request with successful `verify`, `secret-scan` and
  `dependency-review` checks. The rule applies to administrators, requires linear history and resolved
  conversations, and rejects force pushes and branch deletion.
- [Main CI run 33845407734](https://github.com/MeiYanDong/robinhood-pair-grid/actions/runs/33845407734)
  passed formatting, lint, shell syntax, type checking, 26 tests with coverage gates, the production critical
  audit, systemd validation and secret scanning.
- [Manual CI run 33844699214](https://github.com/MeiYanDong/robinhood-pair-grid/actions/runs/33844699214)
  passed a full-history gitleaks scan as a separate job as well as the complete verify job.
- [Pull request 11](https://github.com/MeiYanDong/robinhood-pair-grid/pull/11) passed independent verify,
  secret-scan and dependency-review jobs for the CI split and critical transitive dependency patch.
- [Release run 33845828473](https://github.com/MeiYanDong/robinhood-pair-grid/actions/runs/33845828473)
  accepted the exact deployed commit only after verifying that it belongs to `main`. Its downloaded artifact
  passed its embedded checksum, and its SHA256 exactly matched the artifact already deployed on the server.
- Private vulnerability reporting, Dependabot alerts and automated security fixes are enabled.

## Open production blockers

- Production dependencies report 16 low, 4 moderate, 10 high and 0 critical advisories. See
  [ADR 0003](../adr/0003-upstream-sdk-dependency-risk.md).
- The systemd credential is host-bound but the host has no usable TPM and the root filesystem is not encrypted;
  root or full-disk compromise remains able to reach signing material.
- Failure handling writes high-priority journald entries, but no external notification channel is configured.
- Port 22 still needs a stable VPN or bastion egress before it can be safely allowlisted.

Therefore this is a verified **unarmed deployment**, not an activated or production-safe trading service.
