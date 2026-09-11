# Isolated USDG/PAIR withdrawal

This command withdraws exactly the five ledger positions to the isolated strategy wallet. It does not swap, transfer assets externally or mint replacement positions.

Pause the dedicated Keeper and monitor timers before maintenance. Run `npm run martingale-withdraw-all-plan` first: identity, owner/liquidity, nonce, pending-intent, RPC consensus, simulation and the complete five-burn Gas budget must pass. `npm run martingale-withdraw-all` additionally requires the existing live arm and `PAIR_MARTINGALE_EXIT_CONFIRM=I_AUTHORIZE_WITHDRAW_ALL_FIVE`.

Each burn uses the existing persisted-transaction executor and canonical receipt verification. A timeout resumes the original intent by rerunning the same command. After each verified burn, mark only its source position withdrawn. On completion, require zero NFTs, matching latest/pending/expected nonce and exact token balance deltas attributable to receipts. Historical cost/profit records remain; withdrawal receipts record recovered tokens separately. The final state is WITHDRAWN with automaticSigning=false. A regular Keeper invocation cannot resume or remint during/after this withdrawal.

Keep the timers paused until a separately reviewed replacement strategy has been installed. Withdrawal cannot guarantee that any new range is appropriate. A lower SELL range can realize a loss against historic acquisition cost, and lower BUY ranges change the old floor policy.
