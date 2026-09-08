# Story 0004: Isolated unattended PAIR/USDG finite martingale

As the strategy owner, I want fee-derived USDG to run five independently accounted BUY/SELL LP bands from a
dedicated wallet so range conversions continue without interactive wallet prompts.

## Acceptance criteria

- A canonical bootstrap ledger proves the strategy principal and excludes gas.
- Initial entry creates five USDG-only NFTs in one batch with a 10% wallet reserve.
- Keeper decisions use both head and 128-confirmation composition and handle only one band per invocation.
- BUY removal records actual USDG returned, PAIR received and effective net basis before creating a profitable
  PAIR-only SELL range.
- SELL removal records actual PAIR returned, USDG received and realized profit; the next BUY cannot exceed the
  original band allocation.
- Every signed intent is durable before broadcast and every transition has canonical receipt plus post-state
  evidence.
- A dedicated 30-second systemd timer loads only the isolated wallet credential and runs without per-transaction
  human input.
- A separate one-minute monitor loads only the alert credential, validates all five positions and exact nonce
  isolation from a single numbered block, and alerts when the Keeper success heartbeat is older than 120 seconds.
- Ordered read RPC failover and byte-identical fanout to multiple broadcast endpoints do not expose endpoint
  URLs or delegate nonce construction to a provider.
- The public repository and release artifact contain no credential or live state.
