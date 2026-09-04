# Changelog

All notable changes are documented here. This project follows semantic versioning while it remains an
operator-managed service.

## [0.2.0] - 2026-09-04

### Added

- fail-closed keeper guards for pending nonce and NFT owner/liquidity mismatches;
- persistent `HALTED` state, explicit unhalt acknowledgement and single-process locking;
- canonical receipt based recovery for swap, mint, rotation and exit crash windows;
- macOS Keychain and Linux systemd credential loaders;
- format, lint, JavaScript type checking, coverage thresholds and GitHub CI;
- public-repository hygiene, technical specification, ADRs, runbook and SWAS deployment templates.

### Changed

- wallet identity is runtime configuration and is no longer embedded in public source;
- every write transaction revalidates chain and contract identity;
- deployment is manual-gated and does not arm live signing automatically.
