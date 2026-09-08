# ADR 0008: PAIR hard BUY floor and paid/public RPC consensus

Status: Accepted

Date: 2026-09-09

## Context

The isolated PAIR/USDG experiment originally placed B2-B5 below the operator's now-confirmed economic floor.
The runtime also used one official read RPC, so a single stale or unavailable provider could delay a decision or
provide no independent pre-write check. The wallet already owns five live NFTs, which rules out replacing state
or retrying a migration from scratch.

## Decision

Keep B1 unchanged. Preserve each B2-B5 principal allocation and migrate those four NFTs to adjacent USDG-only
ranges ending at tick `322300`, whose decoded lower price is approximately `0.010078 USDG/PAIR`. Collected fees
and wallet reserve are not compounded by this migration. Source NFTs are burned sequentially through the
already-audited codec; one existing audited batch-mint primitive creates the four targets. Every transaction is
persisted before broadcast and receipt-gated, so interruption resumes rather than duplicates.

Configure a dedicated Chainstack Global node first in the ordered read list and the official Robinhood RPC
second. Before every new signed intent, both must agree on chain ID, a common 128-confirmation block hash,
latest/pending wallet nonce, and pool state. Broadcast the same signed raw bytes to both plus the official
sequencer. A disagreement stops before signing. The Chainstack platform API key never goes to production.

## Consequences

- PAIR is never automatically bought below the configured `0.01` floor; invalid re-entry waits in USDG.
- A mid-migration price move can leave B2-B5 temporarily in USDG, but cannot force a mixed or below-floor mint.
- Sequential burns cost more transactions than a novel multi-burn codec, but reuse a production-verified
  primitive and sharply reduce one-time migration implementation risk.
- Chainstack and the official endpoint improve path resilience but do not constitute independent L1 consensus;
  canonical receipts and post-state remain the completion evidence.
