# Story set 0001: Production baseline

## Story 1 - Close signing guard gaps

Acceptance: every write validates runtime identity; keeper validates pending nonce, owner and liquidity before
`NO_ACTION`; unsafe failures do not sign and persist HALTED.

## Story 2 - Recover interrupted receipts

Acceptance: one process owns state; initial swap/mint, rotation removal/mint and exit receipt windows have
canonical recovery tests; unhalt remains manual.

## Story 3 - Establish merge gates

Acceptance: one command runs format, lint, type checking and coverage; pull requests run the same checks plus
secret scanning and critical dependency review; the protected branch requires all three successful checks.

## Story 4 - Deploy unarmed

Acceptance: Linux reads an encrypted systemd credential; deployed code and state are read back; the service
passes credential and read-only chain checks; the timer and live arm remain disabled.

The original SDK dependency blocker was resolved by
[ADR 0004](../adr/0004-narrow-v4-position-codec.md). Unattended activation remains a separate operational
decision and is not implied by resolving that dependency tree.

## Story 5 - Harden and prove the unarmed host

Acceptance: password authentication and SSH forwarding are disabled; unused public web rules are removed;
the exact release, credential identity, chain state, timer state and live arm are read back. Any missing stable
SSH allowlist, hardware-backed credential protection or external alert delivery remains an explicit open gap.
