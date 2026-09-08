# PAIR/USDG hard-floor rebase evidence

## Scope

- Production release: `a40ee41099a3aa1c0063a916bf9db86d6c5e9b7d`
- Strategy wallet: `0x014E58cF3568641684a8278B50003F19fC87218B`
- Goal: preserve B1, move B2-B5 above the `0.01 USDG/PAIR` BUY floor, and keep wallet fees and reserve outside migrated principal.
- RPC policy: Chainstack primary read plus independent official Robinhood public read; both must agree on the safe block hash, wallet nonce, and PAIR/USDG pool state before each new signature.

No RPC endpoint, API key, private key, signed raw transaction, or credential material is recorded here.

## Canonical transactions

| Operation                    | Transaction                                                          | Result            |
| ---------------------------- | -------------------------------------------------------------------- | ----------------- |
| Burn B2 NFT #2183930         | `0x24e5e0a598de0027c5d04094ccbc8cf556066fa0bb4069a718fda93de363f49a` | canonical success |
| Burn B3 NFT #2183931         | `0x5dd987c69e7e897fbb29ad9f7ade775984224ec8f4ff58ed6a4e01d1a2e93695` | canonical success |
| Burn B4 NFT #2183932         | `0xb622126fdb708531fd3be36c4ea75aaf6c5881744e9b5aacbc8670d18235da9e` | canonical success |
| Burn B5 NFT #2183933         | `0x6315dc177a72b680ca95856a4843b7bcef30b0e96a5355ddf070e9d344306b71` | canonical success |
| Exact USDG Permit2 allowance | `0x68d1eb18aace6cb02cb4208419ade224e99629701da9644b6452fde43ea50666` | canonical success |
| Batch mint B2-B5             | `0xc1c082df46ea6f1fabed46185b48f2b424a52c4b39203de48f29c7baacab8e74` | canonical success |

The six migration transactions consumed `0.00030016344721 ETH`. Wallet nonce advanced continuously from 10 to 16.

## Verified post-state

Observed at block `57971421`:

| Band |     NFT | Leg  | Tick range         | PAIR price range (USDG)       | Chain composition             |
| ---- | ------: | ---- | ------------------ | ----------------------------- | ----------------------------- |
| B1   | 2193494 | SELL | `[318100, 319300]` | `$0.0136041214-$0.0153385120` | `600.152281971096492644 PAIR` |
| B2   | 2219534 | BUY  | `[320200, 320800]` | `$0.0117092636-$0.0124332867` | `10.561431 USDG`              |
| B3   | 2219535 | BUY  | `[320800, 321300]` | `$0.0111382239-$0.0117092636` | `14.081909 USDG`              |
| B4   | 2219536 | BUY  | `[321300, 321800]` | `$0.0105950328-$0.0111382239` | `17.602387 USDG`              |
| B5   | 2219537 | BUY  | `[321800, 322300]` | `$0.0100783321-$0.0105950328` | `21.122867 USDG`              |

All five positions returned matching owner, non-zero matching liquidity, expected pool key and ticks. B1's NFT and liquidity were unchanged. B2-B5 were fully USDG-only at readback.

Wallet balances at the same readback were `0.00426933625586 ETH`, `7.874711 USDG`, `2.663580443639894156 PAIR`, no SPY, and five NFTs. The residual tokens remain outside migrated principal.

## Runtime verification

- Independent post-migration RPC consensus: two read providers agreed at common safe block `57971084`; latest nonce was 16 and pool tick was 320053.
- Ledger-to-chain reconciliation: `CONSISTENT` at safe block `57970703`.
- Manual Keeper canary: `NO_ACTION / NO_SAFE_95_PERCENT_CONVERSION`.
- Automatic Keeper: two observed 30-second cycles completed with the same healthy `NO_ACTION` result.
- Independent monitor: `MONITOR_OK`, with healthy readback and heartbeat.
- Keeper and monitor timers: both active and enabled.
- Public dashboard: automatically indexed the five current NFTs and reported strategy status `VERIFIED`; no manual position list update was required.

These observations prove the stated deployment and post-state at the recorded blocks. They do not guarantee future price, fee income, provider availability, or profitability.
