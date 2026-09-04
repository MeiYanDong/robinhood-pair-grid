# Security policy

## Reporting

Do not open a public issue for a vulnerability that could expose signing credentials, bypass fail-closed
guards or cause an unintended transaction. Use GitHub private vulnerability reporting:

<https://github.com/MeiYanDong/robinhood-pair-grid/security/advisories/new>

Never include private keys, credential files, authenticated RPC URLs, server addresses or live state files in
a report. Transaction hashes and public contract addresses are acceptable when required for evidence.

## Supported version

Only the current `main` branch is maintained. No release is considered production-safe unless its CI checks,
deployed commit readback and runtime verification are all independently successful.

## Threat model

The primary protected assets are the wallet signing key, nonce ownership, LP NFT ownership, strategy state
and the ability to enable the timer. Expected failure modes include RPC compromise, chain mismatch, external
wallet use, concurrent keepers, process death between receipt and state persistence, leaked deployment
credentials and malicious dependency changes.
