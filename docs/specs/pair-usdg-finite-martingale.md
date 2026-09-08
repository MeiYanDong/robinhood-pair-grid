# PAIR/USDG finite-martingale LP specification

Status: Accepted for isolated live operation

Version: 1.1.0

Date: 2026-09-08

## Goal

Operate five independently accounted PAIR/USDG 1% single-sided bands from one dedicated wallet. Each band
cycles from USDG-only BUY liquidity to PAIR-only SELL liquidity and back to BUY without per-transaction human
approval. Range selection uses current 1h/6h volume, active liquidity and projected share; execution remains
bounded by the finite initial principal.

## Capital boundary

- The initial principal is the canonically proven USDG output of one fee-relocation and normalization ledger.
- Ninety percent is split 10/15/20/25/30 across five bands; ten percent stays in the wallet as strategy reserve.
- Gas is funded separately and excluded from principal accounting.
- A completed SELL can fund the next BUY only up to that band's original allocation. Realized profit is not
  compounded automatically.
- SPY, leverage, borrowing, unlimited approvals and external token top-ups are outside the strategy.

## State machine

```text
BUY_ACTIVE
  -> SOURCE_BURN_PLANNED
  -> SOURCE_BURNED
  -> TARGET_READY
  -> SELL_ACTIVE

SELL_ACTIVE
  -> SOURCE_BURN_PLANNED
  -> SOURCE_BURNED
  -> TARGET_READY
  -> BUY_ACTIVE (next cycle)
```

Every completed source NFT is fully removed and burned. Every target is a new NFT, so the wallet should always
own exactly one active NFT per band outside the brief canonical removal/mint interval.

## Trigger and range rules

1. The wallet nonce, NFT count, owner, liquidity, ticks and pool key must match the local ledger.
2. Dashboard evidence must be fresh, identify the configured pool at a canonical safe block, and stay within
   200 ticks of the current RPC read.
3. A rotation is eligible only when the position's value-weighted conversion is at least 95% both at head and
   at the 128-confirmation safe block.
4. SELL completions have priority over BUY completions; one keeper invocation may rotate at most one band.
5. A SELL lower bound must clear the realized net BUY basis, modeled rotation gas, 1% execution allowance and
   at least 5% net profit. The normal minimum markup is 8%; the range is raised if current price already exceeds
   that floor.
6. A returning BUY range is regenerated from the current 1h/6h volume distribution, active liquidity and
   projected share. It remains USDG-only at mint time.
7. The configured hard BUY floor is `0.01 USDG/PAIR`. A dynamically regenerated BUY whose lower boundary falls
   below that floor is not minted; recovered capital remains USDG until a valid single-sided range exists.
8. The approved floor migration leaves B1 unchanged and rebases B2-B5 without compounding wallet fees. At
   execution time it leaves at least a 200-tick gap below the live price, divides the usable aligned span into
   four adjacent bands, and caps the last tick at the `0.01` hard floor. If four useful bands cannot fit, it
   waits without removing any position.

## Signing and recovery

- Linux accepts the private key only through a host-encrypted systemd credential. The credential is never read
  from Git, argv or an environment variable.
- The persistent arm value is a deployment guard, not an interactive authorization prompt. Once the dedicated
  timer is enabled, the daemon signs eligible operations without asking a person for each transaction.
- ERC-20 approvals are exact and bounded. Permit2 signatures expire; the runtime never grants unlimited token
  allowances.
- The exact signed legacy transaction is fsynced before broadcast. A restart re-signs byte-identical calldata
  and resumes the same hash. Unknown nonce movement, a non-canonical receipt or a post-state mismatch is a hard
  halt, never a blind retry.
- Temporary market-data failure or insufficient gas creates no new transaction and is retried on a later timer
  invocation.
- Production requires a paid Chainstack read path and the official Robinhood public RPC to agree on chain ID,
  a common 128-confirmation block hash, wallet latest/pending nonce, and PAIR/USDG pool state before each new
  signed intent. The same raw signed bytes fan out to both read endpoints plus the official sequencer.
- Platform API keys remain on the operator machine. The server receives only the dedicated node endpoint via
  its root-owned runtime environment.

## Runtime limits

- Timer interval: 30 seconds.
- Maximum completed rotations per UTC day: 6.
- Maximum strategy transactions per UTC day: 18.
- Maximum canonical gas per UTC day: 0.002 ETH.
- Maximum modeled gas per transaction: 0.00075 ETH.
- Minimum wallet gas remaining before a new transaction: 0.001 ETH.

These are machine risk limits, not profitability claims. They can be changed only in the root-owned runtime
configuration and are always constrained by the available gas balance.

## Acceptance

- Uniswap v4 mint/remove/burn calldata matches independent SDK 2.3.3 vectors.
- Five-band allocation, market evidence, 95% dual-block trigger, price-decimal accounting and SELL floors have
  deterministic unit tests.
- A live cycle is complete only after canonical receipts and owner/liquidity/pool/tick/balance post-state
  readback.
- The one-time B2-B5 floor migration is resumable after each canonical source burn and after its batch mint.
  B1, reserve USDG, and collected fee tokens are excluded from the target principal.
- Production activation additionally requires a key-derived address check, state transfer readback, one healthy
  `NO_ACTION` keeper invocation, enabled/active timer readback and journal inspection.
