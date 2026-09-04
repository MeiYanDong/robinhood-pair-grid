# Unarmed SWAS deployment evidence

Date: 2026-09-04

Scope: dedicated Ubuntu 24.04 host in `us-west-1`. Public evidence omits the server address, instance ID,
wallet address, transaction hashes and provider request identifiers.

## Immutable release

- Deployed commit: `8ee56deb718a9ffbc412a50a4960c124a8389463`.
- Deployment artifact SHA256: `31a87585bd9ac53174a5a07297d1fc6273c87502118e6c4ccf7f9a5b6ef3f36e`.
- Active symlink resolved to the release directory named by that exact commit.
- Runtime: Node.js `v22.23.2`, npm `10.9.8`.
- The Node.js archive matched the official SHA256 entry before extraction.
- The release installer completed all 26 Node tests and syntax checks before switching the active symlink.

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

## Open production blockers

- Production dependencies report 16 low, 4 moderate, 10 high and 0 critical advisories. See
  [ADR 0003](../adr/0003-upstream-sdk-dependency-risk.md).
- The systemd credential is host-bound but the host has no usable TPM and the root filesystem is not encrypted;
  root or full-disk compromise remains able to reach signing material.
- Failure handling writes high-priority journald entries, but no external notification channel is configured.
- GitHub Actions and protected-branch evidence must be captured after the public repository exists.

Therefore this is a verified **unarmed deployment**, not an activated or production-safe trading service.
