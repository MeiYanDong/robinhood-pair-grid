# ADR 0002: Manual-gated production deployment

Status: Accepted

Date: 2026-09-04

## Context

A public CI runner must never possess the wallet key or be able to enable a production signer. At the same
time, releases need reproducible source, test evidence and exact version readback.

## Decision

CI verifies the source. A manually dispatched release workflow emits a source artifact and SHA256 checksum.
An operator installs the immutable commit on the dedicated SWAS host. The encrypted systemd credential and
runtime state remain on the host. The timer is installed disabled and may be enabled only after read-only
runtime verification.

## Consequences

There is no push-to-production deployment. This is intentional separation of merge, release, deployment and
live activation. External alert delivery requires an operator-selected channel and remains independent of the
public repository.
