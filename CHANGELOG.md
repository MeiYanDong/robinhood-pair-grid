# Changelog

All notable changes are documented here. This project follows semantic versioning while it remains an
operator-managed service.

## [0.3.0] - 2026-09-04

### Added

- a signed Feishu custom-bot alert transport and an independent monitor for service failures, persistent
  `HALTED` state and repeated canonical readback failures.

### Changed

- alert and wallet credentials are isolated in different systemd units;
- release installation preserves a previously enabled alert monitor but always disables the trading timer.

## [0.2.0] - 2026-09-04

### Added

- fail-closed keeper guards for pending nonce and NFT owner/liquidity mismatches;
- persistent `HALTED` state, explicit unhalt acknowledgement and single-process locking;
- canonical receipt based recovery for swap, mint, rotation and exit crash windows;
- macOS Keychain and Linux systemd credential loaders;
- format, lint, JavaScript type checking, coverage thresholds and GitHub CI;
- public-repository hygiene, technical specification, ADRs, runbook and SWAS deployment templates.
- a fail-closed current-tree GitHub Advisory Database gate for high and critical production findings;
- a reviewed SSH hardening fragment and an evidence record for the unarmed SWAS deployment.
- immutable SHA pins for GitHub Actions and independent verify, secret-scan and dependency-review gates.
- a narrow Uniswap v4 position math and calldata codec with fixed SDK vectors and differential parity evidence.

### Changed

- wallet identity is runtime configuration and is no longer embedded in public source;
- every write transaction revalidates chain and contract identity;
- deployment is manual-gated and does not arm live signing automatically;
- the broad Uniswap SDK, Hardhat and ethers v5 production dependency tree was removed, and the remaining
  `viem` tree resolves to a patched `ws` version.
