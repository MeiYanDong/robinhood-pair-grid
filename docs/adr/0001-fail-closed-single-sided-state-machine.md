# ADR 0001: Fail-closed single-sided state machine

Status: Accepted

Date: 2026-09-04

## Context

Two simultaneously funded NFTs would resemble a traditional grid but increase capital fragmentation, Gas and
state ambiguity. A transaction can also succeed on chain while the local process dies before persisting the
receipt.

## Decision

Fund only one direction at a time. Rotate only after full conversion. Persist intent before removal, maintain
a durable HALTED sentinel, serialize all live commands with one lock and reconcile only audited canonical
transactions.

## Consequences

The strategy may sit idle while price is outside the active interval. Recovery requires an explicit operator
step and is intentionally slower than blind retry. The benefit is bounded transaction authority and an
auditable one-leg invariant.
