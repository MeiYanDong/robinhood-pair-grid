# Sell withdrawn PAIR inventory to USDG

`martingale-liquidate-pair-plan` reads the isolated withdrawn wallet, requires zero NFTs and completed prior intents, checks dual RPC nonce/pool consensus, quotes the existing 1% PAIR/USDG v4 pool and reserves a maximum four-transaction workflow. No signing occurs in the plan command.

`martingale-liquidate-pair` additionally requires the existing live arm and `PAIR_MARTINGALE_LIQUIDATE_CONFIRM=I_AUTHORIZE_SELL_ALL_PAIR`. Use the dedicated isolated credential and keep trading timers disabled. The input is the entire observed PAIR balance; no unrelated wallet is accessed.

Reuse exact ERC20 approval with receipt recovery, then exact one-hour Permit2 Router allowance, then an exact-input swap with 1% slippage. A quote below 97% of the same pool's spot reference is rejected. Before the swap, refresh the quote and simulate the full Router call; never lower the minimum below the original plan's bound. Existing signed swap requests resume by their original hash.

After canonical confirmation, require the receipt to spend exactly the planned PAIR amount, return at least the persisted minimum USDG and reconcile precisely with final wallet balances. PAIR and NFT balances must be zero and latest/pending/expected nonce must agree. Final status is LIQUIDATED, automatic signing stays false and regular Keeper invocations cannot reinvest. The operation records proceeds and Gas separately; proceeds are not profit and historical cost records are retained.

Calldata follows the already used LP normalization route: Universal Router command 0x10, v4 actions 0x060b0e, false zeroForOne, settle PAIR from the wallet and take USDG to the same wallet. Tests cover full-amount input, minimum output, recipient/pool, receipt recovery for approvals and swap, quote rejection, and no duplicate sale or reinvestment.
