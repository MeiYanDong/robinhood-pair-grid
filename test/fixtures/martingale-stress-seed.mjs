import { singleSidedPosition, sqrtRatioAtTick, positionAmounts } from '../../lib/uniswap-v4-position.mjs'

// Synthetic identity and positions for CI; no private operational state.
export function stressSeed() {
  const allocations = [7040955n, 10561432n, 14081910n, 17602388n, 21122868n]
  const pairAmounts = [600n, 885n, 1257n, 1650n, 2141n]
  const lowers = [318100, 318200, 319100, 319700, 320800]
  return {
    schemaVersion: 2,
    strategyId: 'pair-usdg-finite-martingale-live-1',
    status: 'MARTINGALE_ACTIVE',
    wallet: '0x1111111111111111111111111111111111111111',
    control: { expectedNextNonce: 29 },
    principal: { initialUsdgAtomic: '78232837', reinvestmentEnabled: false },
    policy: { minimumConversionBps: 9500, minimumBuyPriceUsdg: 0.01, minimumNetProfitBps: 500 },
    plan: { bandCount: 5 },
    accounting: { walletUsdgAtomic: '8967110', walletPairWei: '2663580443641102516' },
    bands: allocations.map((allocation, index) => {
      const position = singleSidedPosition({
        leg: 'SELL',
        tickLower: lowers[index],
        tickUpper: lowers[index] + 1200,
        tickSpacing: 100,
        sqrtPriceX96: sqrtRatioAtTick(322790),
        amount: pairAmounts[index] * 10n ** 18n,
      })
      const amounts = positionAmounts(position)
      return {
        id: `B${index + 1}`,
        index,
        phase: 'SELL_ACTIVE',
        cycleNumber: 1,
        allocationUsdgAtomic: String(allocation),
        cycleAccounting: { netCostUsdgAtomic: String(allocation) },
        history: [],
        activePosition: {
          tokenId: String(index + 1),
          leg: 'SELL',
          tickLower: position.tickLower,
          tickUpper: position.tickUpper,
          liquidity: String(position.liquidity),
          inputToken: 'PAIR',
          inputAmountAtomic: String(amounts.amount1),
          mintBlock: '59000000',
        },
        positions: { sellTokenId: String(index + 1), buyTokenId: null },
      }
    }),
    transactions: Object.fromEntries(
      Array.from({ length: 6 }, (_, i) => [
        `prior${i}`,
        { status: 'CANONICAL_SUCCESS', confirmedAt: '2026-09-09T00:00:00Z', gasCostWei: '38900000000000' },
      ]),
    ),
    history: Array.from({ length: 2 }, () => ({
      kind: 'ROTATION',
      phase: 'COMPLETE',
      completedAt: '2026-09-09T00:00:00Z',
    })),
  }
}
