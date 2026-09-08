# ADR 0007: Martingale runtime resilience without broadening signing authority

## Status

Accepted for implementation. Production activation and runtime evidence remain separate.

## Context

The isolated PAIR/USDG Keeper runs every 30 seconds from one EOA and initially depended on one rate-limited
public RPC. A real one-shot invocation failed with an RPC transport error and recovered on the next timer run.
The existing monitor watched only the legacy PAIR/SPY state directory, so it could not prove that the isolated
strategy was healthy. A rotation also remains a receipt-gated two-transaction burn then mint sequence; replacing
it with an atomic codec would change accounting and recovery semantics and has not yet been proven by a live
cycle or a fork vector.

## Decision

1. Add an isolated read-only monitor with its own state, one-minute timer and successful-Keeper heartbeat.
2. Validate the five-band report at one explicit block: active strategy state, pool identity fields, unique NFT
   IDs, nonzero local liquidity, owner/liquidity readback, wallet NFT count and exact latest/pending/expected
   nonce equality. During an already-persisted burn-to-mint gap, exactly four readable NFTs are allowed.
3. Support an ordered list of independent read RPCs. Keep transaction construction and nonce selection local.
4. Broadcast byte-identical signed transactions to every configured broadcast endpoint. By default this is the
   read set plus Robinhood's official direct Sequencer. A provider response never replaces canonical receipt and
   post-state verification.
5. Keep the current five NFTs, allocations, conversion threshold and no-compounding policy unchanged.
6. Do not activate an atomic burn-and-mint codec until it has SDK-compatible calldata, fork simulation,
   crash-recovery tests and accounting attribution for both token directions.

## Consequences

- A silent Keeper or isolated-state mismatch becomes externally visible without exposing the wallet credential.
- Broadcast availability improves immediately even with one read provider, but read redundancy remains partial
  until a second production provider is provisioned.
- The public RPC is no longer represented as production-grade infrastructure merely because retry code exists.
- The two-transaction rotation gap remains a known, bounded risk; preserving proven accounting and recovery is
  preferred to deploying an unverified atomic path.
