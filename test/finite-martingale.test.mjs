import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buyFillAccounting,
  decideNextBandAction,
  decideNextVerifiedBandAction,
  directPairPriceAtTick,
  pairValueUsdgAtomic,
  parseMarketEvidence,
  planInitialBuyLadder,
  planSellRange,
  positionConversionBps,
  sellFillAccounting,
} from '../lib/finite-martingale.mjs'
import { sqrtRatioAtTick } from '../lib/uniswap-v4-position.mjs'

const POOL_ID = '0x97f48c8d9639b7940874b6c6a43b3d606d070a694920b545acff9c35926593a6'
const BLOCK_HASH = `0x${'12'.repeat(32)}`
const NOW = Date.parse('2026-09-08T12:00:00.000Z')

function marketSnapshot() {
  return {
    status: 'LIVE',
    generatedAt: '2026-09-08T11:59:30.000Z',
    runtime: {
      ready: true,
      blockNumber: '57650000',
      snapshotId: `4663:57650000:${BLOCK_HASH}`,
    },
    comparison: {
      asOfBlock: '57650000',
      rows: [
        {
          id: 'pair-usdg-1',
          poolId: POOL_ID,
          feePips: 10_000,
          tickSpacing: 100,
          hooks: '0x0000000000000000000000000000000000000000',
          currentTick: 319_500,
          pairUsdg: directPairPriceAtTick(319_500),
          currentActiveLiquidity: '5800000000000000000',
          windows: {
            '1h': { partialBeforeAnchor: false, swapEvents: 40, volumeUsdg: 30_000 },
            '6h': { partialBeforeAnchor: false, swapEvents: 800, volumeUsdg: 600_000 },
          },
          rangeAnalysis: {
            hotBand6hUsdg: { p10: 0.0118, p50: 0.013, p90: 0.0141 },
            topVolumeBins6h: [
              {
                tickLower: 319_800,
                tickUpper: 319_900,
                volumeUsdg: 60_000,
                marketLiquidity: '5800000000000000000',
              },
              {
                tickLower: 320_100,
                tickUpper: 320_200,
                volumeUsdg: 45_000,
                marketLiquidity: '5600000000000000000',
              },
              {
                tickLower: 320_300,
                tickUpper: 320_400,
                volumeUsdg: 35_000,
                marketLiquidity: '5500000000000000000',
              },
              {
                tickLower: 319_200,
                tickUpper: 319_300,
                volumeUsdg: 30_000,
                marketLiquidity: '4900000000000000000',
              },
            ],
          },
        },
      ],
    },
  }
}

test('market evidence requires a fresh, complete and identified USDG/PAIR snapshot', () => {
  const evidence = parseMarketEvidence(marketSnapshot(), { nowMs: NOW })
  assert.equal(evidence.poolId, POOL_ID)
  assert.equal(evidence.asOfBlockHash, BLOCK_HASH)
  assert.equal(evidence.oneHour.swapEvents, 40)

  const stale = marketSnapshot()
  stale.generatedAt = '2026-09-08T11:50:00.000Z'
  assert.throws(() => parseMarketEvidence(stale, { nowMs: NOW }), /快照过期/u)

  const incomplete = marketSnapshot()
  incomplete.comparison.rows[0].windows['6h'].partialBeforeAnchor = true
  assert.throws(() => parseMarketEvidence(incomplete, { nowMs: NOW }), /证据不完整/u)
})

test('five-band plan keeps 10% reserve and increases allocation at lower prices', () => {
  const market = parseMarketEvidence(marketSnapshot(), { nowMs: NOW })
  const plan = planInitialBuyLadder({
    principalUsdgAtomic: 80_000_000n,
    currentTick: 319_500,
    sqrtPriceX96: sqrtRatioAtTick(319_500),
    market,
  })
  assert.equal(plan.bandCount, 5)
  assert.equal(plan.deployableUsdgAtomic, 72_000_000n)
  assert.ok(plan.reserveUsdgAtomic >= 8_000_000n)
  assert.equal(plan.selected.bands.length, 5)
  assert.deepEqual(
    plan.selected.bands.map((band) => band.allocationUsdgAtomic),
    [7_200_000n, 10_800_000n, 14_400_000n, 18_000_000n, 21_600_000n],
  )
  for (const [index, band] of plan.selected.bands.entries()) {
    assert.ok(band.tickLower > plan.currentTick)
    assert.equal(band.amount1Max, 0n)
    assert.ok(band.amount0Max <= band.allocationUsdgAtomic)
    assert.ok(band.theoreticalBuyBasisUsdg > band.priceLowUsdg)
    assert.ok(band.theoreticalBuyBasisUsdg < band.priceHighUsdg)
    if (index > 0) assert.equal(plan.selected.bands[index - 1].tickUpper, band.tickLower)
  }
  assert.ok(plan.selected.metrics.topVolumeCoveragePct > 0)
})

test('three-band degradation preserves the same total deployed principal', () => {
  const market = parseMarketEvidence(marketSnapshot(), { nowMs: NOW })
  const plan = planInitialBuyLadder({
    principalUsdgAtomic: 80_000_000n,
    currentTick: 319_500,
    sqrtPriceX96: sqrtRatioAtTick(319_500),
    market,
    bandCount: 3,
  })
  assert.deepEqual(
    plan.selected.bands.map((band) => band.allocationUsdgAtomic),
    [14_400_000n, 21_600_000n, 36_000_000n],
  )
  assert.equal(plan.deployableUsdgAtomic, 72_000_000n)
})

test('sell floor expands when modeled gas is material to a small band', () => {
  const cheap = planSellRange({ basisPriceUsdg: 0.01, principalUsdg: 20, modeledRoundTripGasUsdg: 0.1 })
  const costly = planSellRange({ basisPriceUsdg: 0.01, principalUsdg: 7, modeledRoundTripGasUsdg: 0.7 })
  assert.equal(cheap.requiredMarkupBps, 800)
  assert.ok(costly.requiredMarkupBps > cheap.requiredMarkupBps)
  assert.ok(costly.priceLowUsdg > cheap.priceLowUsdg)
  assert.ok(costly.theoreticalAverageSellPriceUsdg > costly.priceLowUsdg)
})

test('sell range stays single-sided above a fast-moving current price', () => {
  const range = planSellRange({
    basisPriceUsdg: 0.01,
    principalUsdg: 20,
    modeledRoundTripGasUsdg: 0.1,
    currentPairPriceUsdg: 0.02,
  })
  assert.ok(range.priceLowUsdg > 0.02)
  assert.ok(range.priceLowUsdg >= range.profitFloorUsdg)
})

test('value-weighted conversion and realized fill accounting preserve token decimals', () => {
  const sqrt = sqrtRatioAtTick(322_377)
  const onePair = 10n ** 18n
  const pairValue = pairValueUsdgAtomic(onePair, sqrt)
  assert.ok(pairValue > 9_000n && pairValue < 11_000n)
  assert.equal(
    positionConversionBps({
      leg: 'BUY',
      amount0UsdgAtomic: 0n,
      amount1PairWei: onePair,
      sqrtPriceX96: sqrt,
    }),
    10_000,
  )
  assert.equal(
    positionConversionBps({
      leg: 'SELL',
      amount0UsdgAtomic: pairValue,
      amount1PairWei: 0n,
      sqrtPriceX96: sqrt,
    }),
    10_000,
  )

  const buy = buyFillAccounting({
    spentUsdgAtomic: 10_000_000n,
    returnedUsdgAtomic: 500_000n,
    receivedPairWei: 1_000n * 10n ** 18n,
  })
  assert.equal(buy.netCostUsdgAtomic, 9_500_000n)
  assert.equal(buy.effectiveBuyPriceUsdg, 0.0095)
  const sell = sellFillAccounting({
    spentPairWei: 1_000n * 10n ** 18n,
    returnedPairWei: 10n * 10n ** 18n,
    receivedUsdgAtomic: 11_000_000n,
  })
  assert.equal(sell.netPairSoldWei, 990n * 10n ** 18n)
  assert.ok(sell.effectiveSellPriceUsdg > 0.0111 && sell.effectiveSellPriceUsdg < 0.0112)
})

test('keeper chooses one deterministic completed band and prioritizes stablecoin return', () => {
  const state = {
    bands: [
      { id: 'B1', index: 0, phase: 'BUY_ACTIVE', activePosition: { tickLower: 100, tickUpper: 200 } },
      { id: 'B2', index: 1, phase: 'SELL_ACTIVE', activePosition: { tickLower: 250, tickUpper: 300 } },
    ],
  }
  assert.deepEqual(decideNextBandAction(state, 260), {
    action: 'ROTATE_BUY_TO_SELL',
    bandId: 'B1',
    reason: 'TICK_BOUNDARY_FULLY_CROSSED',
  })
  assert.deepEqual(decideNextBandAction(state, 240), {
    action: 'ROTATE_SELL_TO_BUY',
    bandId: 'B2',
    reason: 'TICK_BOUNDARY_FULLY_CROSSED',
  })
  assert.throws(() => decideNextBandAction({ ...state, pending: { id: 'tx' } }, 240), /reconcile/u)
})

test('verified keeper requires both head and safe conversion and prioritizes SELL', () => {
  const state = {
    bands: [
      { id: 'B1', index: 0, phase: 'BUY_ACTIVE' },
      { id: 'B2', index: 1, phase: 'SELL_ACTIVE' },
      { id: 'B3', index: 2, phase: 'BUY_ACTIVE' },
    ],
  }
  const observations = {
    B1: { headConversionBps: 10_000, safeConversionBps: 9_499 },
    B2: { headConversionBps: 9_800, safeConversionBps: 9_700 },
    B3: { headConversionBps: 10_000, safeConversionBps: 10_000 },
  }
  assert.deepEqual(decideNextVerifiedBandAction(state, observations), {
    action: 'ROTATE_SELL_TO_BUY',
    bandId: 'B2',
    reason: 'HEAD_AND_SAFE_CONVERSION_CONFIRMED',
  })
  assert.throws(
    () => decideNextVerifiedBandAction({ ...state, pendingRotation: { id: 'x' } }, observations),
    /恢复/u,
  )
})
