# Story set 0001: Production baseline

## Story 1 - Close signing guard gaps

Acceptance: every write validates runtime identity; keeper validates pending nonce, owner and liquidity before
`NO_ACTION`; unsafe failures do not sign and persist HALTED.

## Story 2 - Recover interrupted receipts

Acceptance: one process owns state; initial swap/mint, rotation removal/mint and exit receipt windows have
canonical recovery tests; unhalt remains manual.

## Story 3 - Establish merge gates

Acceptance: one command runs format, lint, type checking and coverage; pull requests run the same checks plus
secret scanning; the protected branch requires the successful CI check.

## Story 4 - Deploy unarmed

Acceptance: Linux reads an encrypted systemd credential; deployed code and state are read back; the service
passes credential and read-only chain checks; the timer and live arm remain disabled.

Current activation blocker: [ADR 0003](../adr/0003-upstream-sdk-dependency-risk.md).
