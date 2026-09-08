# ADR 0006: Unattended isolated PAIR/USDG wallet

Status: Accepted

Date: 2026-09-08

## Context

The existing PAIR/SPY wallet and its historical LP accounting must not be mixed with a fee-funded martingale
experiment. Interactive macOS Keychain prompts also cannot support a 7x24 server daemon.

## Decision

Run the PAIR/USDG finite-martingale strategy from a dedicated EOA and give only its systemd keeper access to the
host-encrypted signing credential. The owner has granted persistent authority within this wallet, chain, pool,
principal and state-machine boundary; no per-transaction confirmation is required. Existing PAIR/SPY positions
and all other wallets remain out of scope.

The repository stores only public configuration templates. Private key material, the production wallet value,
bootstrap ledger, live state and host locator stay outside Git. The service signs automatically only when the
root-owned arm value is present and the canonical guards in the technical specification pass.

## Consequences

The strategy can rotate while the user is away from a computer. Compromise of the dedicated server may expose
the dedicated wallet, so its blast radius is limited to the isolated balance and LP NFTs. A host-bound systemd
credential is defense in depth rather than a hardware security module. Hard evidence ambiguity still halts the
daemon; unattended authority does not authorize unsafe guessing.
