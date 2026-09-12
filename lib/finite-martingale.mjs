import { mintAmounts, singleSidedPosition, sqrtRatioAtTick } from './uniswap-v4-position.mjs'

const LOG_TICK_BASE = Math.log(1.0001)
const USDG_SCALE_RATIO = 1e12
const Q192 = 1n << 192n

export const DEFAULT_FINITE_MARTINGALE_POLICY = Object.freeze({
  poolId: '0x97f48c8d9639b7940874b6c6a43b3d606d070a694920b545acff9c35926593a6',
  feePips: 10_000,
  tickSpacing: 100,
  deployBps: 9_000,
  reserveBps: 1_000,
  fiveBandWeightsBps: Object.freeze([1_000, 1_500, 2_000, 2_500, 3_000]),
  threeBandWeightsBps: Object.freeze([2_000, 3_000, 5_000]),
  minimumEntryGapTicks: 200,
  minimumBandWidthTicks: 800,
  maximumBandWidthTicks: 1_400,
  minimumBuyPriceUsdg: 0.01,
  maximumMarketAgeMs: 480_000,
  maximumTickDivergence: 200,
  minimumOneHourSwaps: 3,
  minimumSixHourSwaps: 20,
  minimumConversionBps: 9_500,
  minimumNetProfitBps: 500,
  minimumSellMarkupBps: 800,
  sellRangeWidthBps: 1_200,
  executionSlippageBps: 100,
})

function assertFinitePositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} 必须是有限正数`)
}

function alignTickUp(tick, spacing) {
  return Math.ceil(tick / spacing) * spacing
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

/** Human USDG per PAIR for a pool whose raw currency0/currency1 is USDG/PAIR. */
export function directPairPriceAtTick(tick) {
  if (!Number.isInteger(tick)) throw new Error('tick 必须是整数')
  return USDG_SCALE_RATIO / Math.pow(1.0001, tick)
}

export function directPairTickAtPrice(price) {
  assertFinitePositive(price, 'PAIR/USDG 价格')
  return Math.log(USDG_SCALE_RATIO / price) / LOG_TICK_BASE
}

/** @param {number} minimumBuyPriceUsdg @param {number} [tickSpacing] */
export function maximumAlignedBuyTickForPriceFloor(
  minimumBuyPriceUsdg,
  tickSpacing = DEFAULT_FINITE_MARTINGALE_POLICY.tickSpacing,
) {
  assertFinitePositive(minimumBuyPriceUsdg, 'PAIR 最低买入价格')
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) throw new Error('tickSpacing 必须是正整数')
  return Math.floor(directPairTickAtPrice(minimumBuyPriceUsdg) / tickSpacing) * tickSpacing
}

/**
 * @param {{tickLower:number,tickUpper:number,currentTick:number,
 * minimumBuyPriceUsdg?:number,tickSpacing?:number}} input
 */
export function assertBuyRangeRespectsPriceFloor({
  tickLower,
  tickUpper,
  currentTick,
  minimumBuyPriceUsdg = DEFAULT_FINITE_MARTINGALE_POLICY.minimumBuyPriceUsdg,
  tickSpacing = DEFAULT_FINITE_MARTINGALE_POLICY.tickSpacing,
}) {
  if (![tickLower, tickUpper, currentTick].every(Number.isInteger)) throw new Error('BUY 区间 tick 无效')
  if (tickLower >= tickUpper || tickLower % tickSpacing !== 0 || tickUpper % tickSpacing !== 0) {
    throw new Error('BUY 区间未正确对齐')
  }
  const maximumBuyTick = maximumAlignedBuyTickForPriceFloor(minimumBuyPriceUsdg, tickSpacing)
  if (tickUpper > maximumBuyTick) {
    throw new Error(
      `WAIT: BUY 区间下沿 ${directPairPriceAtTick(tickUpper)} 低于硬底价 ${minimumBuyPriceUsdg}`,
    )
  }
  if (currentTick >= tickLower) throw new Error('WAIT: 硬底价 BUY 区间当前不再是 USDG-only')
  return {
    minimumBuyPriceUsdg,
    maximumBuyTick,
    priceLowUsdg: directPairPriceAtTick(tickUpper),
    priceHighUsdg: directPairPriceAtTick(tickLower),
  }
}

/**
 * Build a caller-sized, adjacent USDG-only ladder that never buys below the
 * configured PAIR price floor. This is intentionally separate from the live
 * volume-based planner: it is used for an explicit capital-preserving rebase,
 * while later automatic cycles still require fresh market evidence.
 *
 * @param {{bands:Array<{id:string,index:number,weightBps:number,allocationUsdgAtomic:bigint|string}>,
 * currentTick:number,sqrtPriceX96:bigint,firstTickLower:number,widthTicks:readonly number[],
 * minimumBuyPriceUsdg?:number,tickSpacing?:number}} input
 */
export function planHardFloorBuyLadder({
  bands,
  currentTick,
  sqrtPriceX96,
  firstTickLower,
  widthTicks,
  minimumBuyPriceUsdg = DEFAULT_FINITE_MARTINGALE_POLICY.minimumBuyPriceUsdg,
  tickSpacing = DEFAULT_FINITE_MARTINGALE_POLICY.tickSpacing,
}) {
  if (!Array.isArray(bands) || bands.length === 0) throw new Error('硬底价阶梯缺少档位')
  if (!Array.isArray(widthTicks) || widthTicks.length !== bands.length) {
    throw new Error('硬底价阶梯宽度与档位数不一致')
  }
  if (!Number.isInteger(firstTickLower) || firstTickLower % tickSpacing !== 0) {
    throw new Error('硬底价阶梯起始 tick 未对齐')
  }
  if (currentTick >= firstTickLower) throw new Error('WAIT: 当前价格已进入硬底价阶梯，不能单边 USDG 建仓')

  let tickLower = firstTickLower
  const plannedBands = bands.map((band, offset) => {
    const width = Number(widthTicks[offset])
    const amount = BigInt(band.allocationUsdgAtomic)
    if (!Number.isInteger(width) || width <= 0 || width % tickSpacing !== 0) {
      throw new Error(`${band.id} 宽度 tick 无效`)
    }
    if (amount <= 0n) throw new Error(`${band.id} 分配本金无效`)
    const tickUpper = tickLower + width
    const floor = assertBuyRangeRespectsPriceFloor({
      tickLower,
      tickUpper,
      currentTick,
      minimumBuyPriceUsdg,
      tickSpacing,
    })
    const position = singleSidedPosition({
      leg: 'BUY',
      sqrtPriceX96,
      tickLower,
      tickUpper,
      tickSpacing,
      amount,
    })
    const desired = mintAmounts(position)
    if (desired.amount0 <= 0n || desired.amount0 > amount || desired.amount1 !== 0n) {
      throw new Error(`${band.id} 不是受本金约束的 USDG-only 头寸`)
    }
    const planned = {
      id: String(band.id),
      index: Number(band.index),
      weightBps: Number(band.weightBps),
      allocationUsdgAtomic: amount,
      amount0Max: desired.amount0,
      amount1Max: 0n,
      liquidity: position.liquidity,
      tickLower,
      tickUpper,
      widthTicks: width,
      priceLowUsdg: floor.priceLowUsdg,
      priceHighUsdg: floor.priceHighUsdg,
      theoreticalBuyBasisUsdg: theoreticalBuyBasisUsdg(position, desired.amount0),
    }
    tickLower = tickUpper
    return planned
  })
  const plannedSpend = plannedBands.reduce((sum, band) => sum + band.amount0Max, 0n)
  const allocated = plannedBands.reduce((sum, band) => sum + band.allocationUsdgAtomic, 0n)
  return {
    method: 'explicit adjacent USDG-only rebase bounded by a hard PAIR buy-price floor',
    bandCount: plannedBands.length,
    principalUsdgAtomic: allocated,
    deployableUsdgAtomic: allocated,
    plannedSpendUsdgAtomic: plannedSpend,
    reserveUsdgAtomic: allocated - plannedSpend,
    currentTick,
    currentPairPriceUsdg: directPairPriceAtTick(currentTick),
    minimumBuyPriceUsdg,
    maximumBuyTick: maximumAlignedBuyTickForPriceFloor(minimumBuyPriceUsdg, tickSpacing),
    selected: { bands: plannedBands, metrics: null },
  }
}

/**
 * Place an explicit BUY ladder below the live price while consuming all usable
 * aligned space down to the configured hard floor. Extra tick steps are given
 * to the outer bands first, keeping the nearest-price and floor bands slightly
 * wider when the span is not evenly divisible.
 *
 * @param {{bands:Array<{id:string,index:number,weightBps:number,allocationUsdgAtomic:bigint|string}>,
 * currentTick:number,sqrtPriceX96:bigint,minimumBuyPriceUsdg?:number,tickSpacing?:number,
 * minimumEntryGapTicks?:number,minimumBandWidthTicks?:number}} input
 */
export function planAdaptiveHardFloorBuyLadder({
  bands,
  currentTick,
  sqrtPriceX96,
  minimumBuyPriceUsdg = DEFAULT_FINITE_MARTINGALE_POLICY.minimumBuyPriceUsdg,
  tickSpacing = DEFAULT_FINITE_MARTINGALE_POLICY.tickSpacing,
  minimumEntryGapTicks = DEFAULT_FINITE_MARTINGALE_POLICY.minimumEntryGapTicks,
  minimumBandWidthTicks = 300,
}) {
  if (!Array.isArray(bands) || bands.length === 0) throw new Error('自适应硬底价阶梯缺少档位')
  if (!Number.isInteger(currentTick)) throw new Error('当前 tick 无效')
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) throw new Error('tickSpacing 必须是正整数')
  const alignedValues = /** @type {Array<[number, string]>} */ ([
    [minimumEntryGapTicks, '最小入场间隔'],
    [minimumBandWidthTicks, '最小档位宽度'],
  ])
  for (const [value, label] of alignedValues) {
    if (!Number.isInteger(value) || value <= 0 || value % tickSpacing !== 0) {
      throw new Error(`${label} 必须是 tickSpacing 的正整数倍`)
    }
  }

  const maximumBuyTick = maximumAlignedBuyTickForPriceFloor(minimumBuyPriceUsdg, tickSpacing)
  const firstTickLower = alignTickUp(currentTick + minimumEntryGapTicks, tickSpacing)
  const usableTickSpan = maximumBuyTick - firstTickLower
  const minimumRequiredSpan = bands.length * minimumBandWidthTicks
  if (usableTickSpan < minimumRequiredSpan) {
    throw new Error('WAIT: 当前价格与硬底价之间不足以安全容纳全部 BUY 档位')
  }

  const totalSteps = usableTickSpan / tickSpacing
  const baseSteps = Math.floor(totalSteps / bands.length)
  let remainingSteps = totalSteps - baseSteps * bands.length
  const widthTicks = Array.from({ length: bands.length }, () => baseSteps * tickSpacing)
  const expansionOrder = []
  for (let left = 0, right = bands.length - 1; left <= right; left += 1, right -= 1) {
    expansionOrder.push(left)
    if (right !== left) expansionOrder.push(right)
  }
  for (const index of expansionOrder) {
    if (remainingSteps === 0) break
    widthTicks[index] += tickSpacing
    remainingSteps -= 1
  }

  const plan = planHardFloorBuyLadder({
    bands,
    currentTick,
    sqrtPriceX96,
    firstTickLower,
    widthTicks,
    minimumBuyPriceUsdg,
    tickSpacing,
  })
  return {
    ...plan,
    method: 'adaptive adjacent USDG-only rebase below live price and above hard PAIR floor',
    rangeSelection: {
      firstTickLower,
      maximumBuyTick,
      minimumEntryGapTicks,
      minimumBandWidthTicks,
      usableTickSpan,
      widthTicks,
    },
  }
}

/** Convert PAIR wei into USDG atomic units at the raw V4 sqrt price. */
export function pairValueUsdgAtomic(pairWei, sqrtPriceX96) {
  if (typeof pairWei !== 'bigint' || pairWei < 0n) throw new Error('PAIR 数量必须是非负 bigint')
  if (typeof sqrtPriceX96 !== 'bigint' || sqrtPriceX96 <= 0n) throw new Error('sqrtPriceX96 无效')
  return (pairWei * Q192) / (sqrtPriceX96 * sqrtPriceX96)
}

/**
 * Value-weighted conversion progress for one single-sided leg. BUY means the
 * original USDG has converted to PAIR; SELL means PAIR has converted to USDG.
 */
export function positionConversionBps({ leg, amount0UsdgAtomic, amount1PairWei, sqrtPriceX96 }) {
  if (typeof amount0UsdgAtomic !== 'bigint' || amount0UsdgAtomic < 0n) {
    throw new Error('USDG 成分必须是非负 bigint')
  }
  const pairValue = pairValueUsdgAtomic(amount1PairWei, sqrtPriceX96)
  const total = amount0UsdgAtomic + pairValue
  if (total <= 0n) throw new Error('头寸价值为零')
  const converted = leg === 'BUY' ? pairValue : leg === 'SELL' ? amount0UsdgAtomic : null
  if (converted === null) throw new Error(`不支持的腿类型：${leg}`)
  return Number((converted * 10_000n) / total)
}

export function buyFillAccounting({ spentUsdgAtomic, returnedUsdgAtomic, receivedPairWei }) {
  if (typeof spentUsdgAtomic !== 'bigint' || spentUsdgAtomic <= 0n) throw new Error('买入支出无效')
  if (typeof returnedUsdgAtomic !== 'bigint' || returnedUsdgAtomic < 0n) throw new Error('返还 USDG 无效')
  if (typeof receivedPairWei !== 'bigint' || receivedPairWei <= 0n) throw new Error('收到 PAIR 无效')
  const netCostUsdgAtomic = spentUsdgAtomic > returnedUsdgAtomic ? spentUsdgAtomic - returnedUsdgAtomic : 0n
  return {
    spentUsdgAtomic,
    returnedUsdgAtomic,
    receivedPairWei,
    netCostUsdgAtomic,
    effectiveBuyPriceUsdg: (Number(netCostUsdgAtomic) * USDG_SCALE_RATIO) / Number(receivedPairWei),
  }
}

export function sellFillAccounting({ spentPairWei, returnedPairWei, receivedUsdgAtomic }) {
  if (typeof spentPairWei !== 'bigint' || spentPairWei <= 0n) throw new Error('卖出 PAIR 支出无效')
  if (typeof returnedPairWei !== 'bigint' || returnedPairWei < 0n) throw new Error('返还 PAIR 无效')
  if (typeof receivedUsdgAtomic !== 'bigint' || receivedUsdgAtomic <= 0n) throw new Error('收到 USDG 无效')
  const netPairSoldWei = spentPairWei > returnedPairWei ? spentPairWei - returnedPairWei : 0n
  if (netPairSoldWei <= 0n) throw new Error('净卖出 PAIR 为零')
  return {
    spentPairWei,
    returnedPairWei,
    receivedUsdgAtomic,
    netPairSoldWei,
    effectiveSellPriceUsdg: (Number(receivedUsdgAtomic) * USDG_SCALE_RATIO) / Number(netPairSoldWei),
  }
}

function snapshotBlockHash(snapshot) {
  const snapshotId = String(snapshot.runtime?.snapshotId || '')
  const parts = snapshotId.split(':')
  return /^0x[0-9a-f]{64}$/iu.test(parts.at(-1) || '') ? parts.at(-1) : null
}

/**
 * Convert the public dashboard snapshot into bounded market-planning evidence.
 * Execution must separately confirm its block hash and current pool tick on RPC.
 *
 * @param {any} snapshot
 * @param {{nowMs?: number, policy?: typeof DEFAULT_FINITE_MARTINGALE_POLICY}} [options]
 */
export function parseMarketEvidence(snapshot, options = {}) {
  const policy = options.policy || DEFAULT_FINITE_MARTINGALE_POLICY
  const nowMs = options.nowMs ?? Date.now()
  if (!snapshot || snapshot.status !== 'LIVE') {
    throw new Error('市场面板不是 LIVE')
  }
  const generatedAtMs = Date.parse(snapshot.generatedAt)
  if (
    !Number.isFinite(generatedAtMs) ||
    nowMs - generatedAtMs < 0 ||
    nowMs - generatedAtMs > policy.maximumMarketAgeMs
  ) {
    throw new Error('市场面板快照过期或时间无效')
  }
  const row = snapshot.comparison?.rows?.find((candidate) => candidate.id === 'pair-usdg-1')
  if (!row || String(row.poolId).toLowerCase() !== policy.poolId.toLowerCase()) {
    throw new Error('快照缺少目标 PAIR/USDG 1% 池')
  }
  if (
    Number(row.feePips) !== policy.feePips ||
    Number(row.tickSpacing) !== policy.tickSpacing ||
    String(row.hooks).toLowerCase() !== '0x0000000000000000000000000000000000000000'
  ) {
    throw new Error('目标池 fee/tickSpacing/hooks 身份不匹配')
  }
  const oneHour = row.windows?.['1h']
  const sixHour = row.windows?.['6h']
  if (
    !oneHour ||
    !sixHour ||
    oneHour.partialBeforeAnchor ||
    sixHour.partialBeforeAnchor ||
    Number(oneHour.swapEvents) < policy.minimumOneHourSwaps ||
    Number(sixHour.swapEvents) < policy.minimumSixHourSwaps
  ) {
    throw new Error('1h/6h 交易量证据不完整')
  }
  const hotBand = row.rangeAnalysis?.hotBand6hUsdg
  const quantiles = [hotBand?.p10, hotBand?.p50, hotBand?.p90].map(Number)
  if (
    !quantiles.every((value) => Number.isFinite(value) && value > 0) ||
    !(quantiles[0] <= quantiles[1] && quantiles[1] <= quantiles[2])
  ) {
    throw new Error('6h 成交量分位价格无效')
  }
  const topVolumeBins = row.rangeAnalysis?.topVolumeBins6h || []
  if (topVolumeBins.length < 3) throw new Error('6h 成交量/市场流动性样本不足')
  for (const bin of topVolumeBins) {
    if (
      !Number.isInteger(Number(bin.tickLower)) ||
      !Number.isFinite(Number(bin.volumeUsdg)) ||
      Number(bin.volumeUsdg) < 0 ||
      BigInt(bin.marketLiquidity) < 0n
    ) {
      throw new Error('6h 成交量 bin 数据无效')
    }
  }
  const blockHash = snapshotBlockHash(snapshot)
  if (!blockHash || String(snapshot.comparison.asOfBlock) !== String(snapshot.runtime.blockNumber)) {
    throw new Error('市场快照缺少可核验的安全区块身份')
  }
  assertFinitePositive(Number(row.pairUsdg), 'PAIR/USDG 现价')
  if (!Number.isInteger(Number(row.currentTick)) || BigInt(row.currentActiveLiquidity) <= 0n) {
    throw new Error('目标池 tick/liquidity 无效')
  }
  return {
    generatedAt: snapshot.generatedAt,
    asOfBlock: String(snapshot.comparison.asOfBlock),
    asOfBlockHash: blockHash,
    poolId: row.poolId,
    currentTick: Number(row.currentTick),
    pairUsdg: Number(row.pairUsdg),
    currentActiveLiquidity: BigInt(row.currentActiveLiquidity),
    oneHour: {
      swapEvents: Number(oneHour.swapEvents),
      volumeUsdg: Number(oneHour.volumeUsdg),
    },
    sixHour: {
      swapEvents: Number(sixHour.swapEvents),
      volumeUsdg: Number(sixHour.volumeUsdg),
    },
    hotBand6hUsdg: { p10: quantiles[0], p50: quantiles[1], p90: quantiles[2] },
    topVolumeBins6h: topVolumeBins.map((bin) => ({
      tickLower: Number(bin.tickLower),
      tickUpper: Number(bin.tickUpper),
      volumeUsdg: Number(bin.volumeUsdg),
      marketLiquidity: BigInt(bin.marketLiquidity),
    })),
  }
}

function allocationProfile(principal, bandCount, policy) {
  if (typeof principal !== 'bigint' || principal <= 0n) throw new Error('USDG 本金必须是正 bigint')
  const weights =
    bandCount === 5 ? policy.fiveBandWeightsBps : bandCount === 3 ? policy.threeBandWeightsBps : null
  if (!weights || weights.reduce((sum, value) => sum + value, 0) !== 10_000) {
    throw new Error('只支持 5 档或降级后的 3 档权重')
  }
  if (policy.deployBps + policy.reserveBps !== 10_000) throw new Error('部署与储备比例之和必须为 100%')
  const deployable = (principal * BigInt(policy.deployBps)) / 10_000n
  const allocations = weights.map((weight) => (deployable * BigInt(weight)) / 10_000n)
  allocations[allocations.length - 1] += deployable - allocations.reduce((sum, value) => sum + value, 0n)
  return { deployable, reserve: principal - deployable, weights, allocations }
}

function theoreticalBuyBasisUsdg(position, amount0) {
  const completed = mintAmounts({ ...position, sqrtPriceX96: sqrtRatioAtTick(position.tickUpper) })
  if (completed.amount1 <= 0n) throw new Error('无法计算买入档理论 PAIR 数量')
  return (Number(amount0) * USDG_SCALE_RATIO) / Number(completed.amount1)
}

function scoreCandidate(bands, market, targetWidthTicks, startTick) {
  const totalTopVolume = market.topVolumeBins6h.reduce((sum, bin) => sum + bin.volumeUsdg, 0)
  let coveredVolume = 0
  let modeledFee = 0
  let shareVolumeNumerator = 0
  for (const bin of market.topVolumeBins6h) {
    const band = bands.find(
      (candidate) => bin.tickLower >= candidate.tickLower && bin.tickLower < candidate.tickUpper,
    )
    if (!band) continue
    const liquidity = Number(band.liquidity)
    const marketLiquidity = Math.max(0, Number(bin.marketLiquidity))
    const share = liquidity / (marketLiquidity + liquidity)
    coveredVolume += bin.volumeUsdg
    modeledFee += bin.volumeUsdg * 0.01 * share
    shareVolumeNumerator += bin.volumeUsdg * share
  }
  const coverage = totalTopVolume > 0 ? coveredVolume / totalTopVolume : 0
  const potentialShare = coveredVolume > 0 ? shareVolumeNumerator / coveredVolume : 0
  const widthAdherence = 1 - Math.min(1, Math.abs(bands[0].widthTicks - targetWidthTicks) / targetWidthTicks)
  const startDistance = Math.max(0, startTick - market.currentTick)
  const proximity = 1 / (1 + startDistance / 1_000)
  return {
    score: modeledFee + coverage * 0.2 + potentialShare * 0.2 + widthAdherence * 0.1 + proximity * 0.05,
    topVolumeCoveragePct: coverage * 100,
    modeledSixHourFeeUsdgTopBinsOnly: modeledFee,
    modeledVolumeWeightedSharePct: potentialShare * 100,
  }
}

/**
 * Build an adjacent USDG-only BUY ladder. Candidate placement is anchored to
 * the 6h volume median, width is derived from the p10-to-p50 dispersion, and
 * scoring uses observed top-bin volume plus projected liquidity share.
 *
 * @param {{principalUsdgAtomic: bigint, currentTick: number, sqrtPriceX96: bigint,
 * market: ReturnType<typeof parseMarketEvidence>, bandCount?: 3|5,
 * policy?: Record<string, any>}} input
 */
export function planInitialBuyLadder({
  principalUsdgAtomic,
  currentTick,
  sqrtPriceX96,
  market,
  bandCount = 5,
  policy = DEFAULT_FINITE_MARTINGALE_POLICY,
}) {
  if (!Number.isInteger(currentTick)) throw new Error('链上 currentTick 无效')
  if (Math.abs(currentTick - market.currentTick) > policy.maximumTickDivergence) {
    throw new Error(
      `链上 tick 与市场快照偏离 ${Math.abs(currentTick - market.currentTick)}，禁止用旧分布建仓`,
    )
  }
  const allocation = allocationProfile(principalUsdgAtomic, bandCount, policy)
  const spacing = policy.tickSpacing
  const p50Tick = directPairTickAtPrice(market.hotBand6hUsdg.p50)
  const p10Tick = directPairTickAtPrice(market.hotBand6hUsdg.p10)
  const observedWidth = Math.max(spacing, p10Tick - p50Tick)
  const targetWidthTicks = alignTickUp(
    clamp(observedWidth, policy.minimumBandWidthTicks, policy.maximumBandWidthTicks),
    spacing,
  )
  const minimumStart = alignTickUp(currentTick + policy.minimumEntryGapTicks, spacing)
  const volumeStart = alignTickUp(p50Tick, spacing)
  const starts = [...new Set([minimumStart, Math.max(minimumStart, volumeStart)])]
  const widths = [
    ...new Set([
      alignTickUp(
        clamp(targetWidthTicks - 200, policy.minimumBandWidthTicks, policy.maximumBandWidthTicks),
        spacing,
      ),
      targetWidthTicks,
      alignTickUp(
        clamp(targetWidthTicks + 200, policy.minimumBandWidthTicks, policy.maximumBandWidthTicks),
        spacing,
      ),
    ]),
  ]
  const candidates = []
  for (const startTick of starts) {
    for (const widthTicks of widths) {
      const bands = allocation.allocations.map((amount, index) => {
        const tickLower = startTick + index * widthTicks
        const tickUpper = tickLower + widthTicks
        const position = singleSidedPosition({
          leg: 'BUY',
          sqrtPriceX96,
          tickLower,
          tickUpper,
          tickSpacing: spacing,
          amount,
        })
        const desired = mintAmounts(position)
        if (desired.amount0 <= 0n || desired.amount0 > amount || desired.amount1 !== 0n) {
          throw new Error(`第 ${index + 1} 档不是受本金约束的 USDG-only 头寸`)
        }
        return {
          id: `B${index + 1}`,
          index,
          weightBps: allocation.weights[index],
          allocationUsdgAtomic: amount,
          amount0Max: desired.amount0,
          amount1Max: 0n,
          liquidity: position.liquidity,
          tickLower,
          tickUpper,
          widthTicks,
          priceLowUsdg: directPairPriceAtTick(tickUpper),
          priceHighUsdg: directPairPriceAtTick(tickLower),
          theoreticalBuyBasisUsdg: theoreticalBuyBasisUsdg(position, desired.amount0),
        }
      })
      const metrics = scoreCandidate(bands, market, targetWidthTicks, startTick)
      candidates.push({ startTick, widthTicks, bands, metrics })
    }
  }
  candidates.sort((left, right) => right.metrics.score - left.metrics.score)
  const selected = candidates[0]
  if (!selected) throw new Error('没有符合安全边界的买入阶梯')
  const plannedSpend = selected.bands.reduce((sum, band) => sum + band.amount0Max, 0n)
  if (plannedSpend > allocation.deployable) throw new Error('阶梯计划超过 90% 可部署本金')
  return {
    method: '6h volume p10/p50 width plus top-bin volume and projected market-share scoring',
    bandCount,
    principalUsdgAtomic,
    deployableUsdgAtomic: allocation.deployable,
    plannedSpendUsdgAtomic: plannedSpend,
    reserveUsdgAtomic: principalUsdgAtomic - plannedSpend,
    currentTick,
    currentPairPriceUsdg: directPairPriceAtTick(currentTick),
    observedVolumeAcceleration:
      market.sixHour.volumeUsdg > 0 ? market.oneHour.volumeUsdg / (market.sixHour.volumeUsdg / 6) : null,
    hotBand6hUsdg: market.hotBand6hUsdg,
    selected,
    alternatives: candidates.slice(1, 4).map(({ startTick, widthTicks, metrics }) => ({
      startTick,
      widthTicks,
      metrics,
    })),
    evidence: {
      generatedAt: market.generatedAt,
      asOfBlock: market.asOfBlock,
      asOfBlockHash: market.asOfBlockHash,
      dashboardTick: market.currentTick,
      oneHour: market.oneHour,
      sixHour: market.sixHour,
      topVolumeBinCount: market.topVolumeBins6h.length,
    },
  }
}

/**
 * Select a PAIR-only SELL range whose lower boundary clears both modeled gas
 * and the configured minimum net profit. The result remains subject to a fresh
 * single-sided tick check immediately before mint.
 */
export function planSellRange({
  basisPriceUsdg,
  principalUsdg,
  modeledRoundTripGasUsdg,
  currentPairPriceUsdg = 0,
  tickSpacing = DEFAULT_FINITE_MARTINGALE_POLICY.tickSpacing,
  policy = DEFAULT_FINITE_MARTINGALE_POLICY,
}) {
  assertFinitePositive(basisPriceUsdg, '买入成本')
  assertFinitePositive(principalUsdg, '档位本金')
  if (!Number.isFinite(modeledRoundTripGasUsdg) || modeledRoundTripGasUsdg < 0) {
    throw new Error('预计换腿 Gas 必须是有限非负数')
  }
  if (!Number.isFinite(currentPairPriceUsdg) || currentPairPriceUsdg < 0) {
    throw new Error('当前 PAIR 价格必须是有限非负数')
  }
  const gasRecoveryBps = Math.ceil((modeledRoundTripGasUsdg / principalUsdg) * 10_000)
  const requiredMarkupBps = Math.max(
    policy.minimumSellMarkupBps,
    policy.minimumNetProfitBps + gasRecoveryBps + policy.executionSlippageBps,
  )
  const profitFloor = basisPriceUsdg * (1 + requiredMarkupBps / 10_000)
  const singleSidedFloor = currentPairPriceUsdg * Math.pow(1.0001, policy.minimumEntryGapTicks)
  const requestedLow = Math.max(profitFloor, singleSidedFloor)
  const requestedHigh = requestedLow * (1 + policy.sellRangeWidthBps / 10_000)
  const tickLower = Math.floor(directPairTickAtPrice(requestedHigh) / tickSpacing) * tickSpacing
  const tickUpper = Math.ceil(directPairTickAtPrice(requestedLow) / tickSpacing) * tickSpacing
  if (tickLower >= tickUpper) throw new Error('卖出区间对齐后无效')
  return {
    basisPriceUsdg,
    principalUsdg,
    modeledRoundTripGasUsdg,
    gasRecoveryBps,
    minimumNetProfitBps: policy.minimumNetProfitBps,
    requiredMarkupBps,
    profitFloorUsdg: profitFloor,
    tickLower,
    tickUpper,
    priceLowUsdg: directPairPriceAtTick(tickUpper),
    priceHighUsdg: directPairPriceAtTick(tickLower),
    theoreticalAverageSellPriceUsdg: Math.sqrt(
      directPairPriceAtTick(tickUpper) * directPairPriceAtTick(tickLower),
    ),
  }
}

/**
 * Choose at most one band using two independently read chain states. SELL
 * completions are handled first so recovered USDG cannot be stranded behind a
 * lower-priority buy conversion.
 *
 * @param {{bands: Array<{id:string,index:number,phase:string}>, pendingRotation?:unknown}} state
 * @param {Record<string,{headConversionBps:number,safeConversionBps:number}>} observations
 * @param {number} minimumConversionBps
 */
export function decideNextVerifiedBandAction(
  state,
  observations,
  minimumConversionBps = DEFAULT_FINITE_MARTINGALE_POLICY.minimumConversionBps,
) {
  if (state.pendingRotation) throw new Error('存在未完成换腿，必须先恢复')
  if (
    !Number.isInteger(minimumConversionBps) ||
    minimumConversionBps < 9_000 ||
    minimumConversionBps > 10_000
  ) {
    throw new Error('minimumConversionBps 无效')
  }
  const completed = state.bands
    .filter((band) => {
      if (!['BUY_ACTIVE', 'SELL_ACTIVE'].includes(band.phase)) return false
      const observation = observations[band.id]
      return Boolean(
        observation &&
        observation.headConversionBps >= minimumConversionBps &&
        observation.safeConversionBps >= minimumConversionBps,
      )
    })
    .sort((left, right) => {
      const leftPriority = left.phase === 'SELL_ACTIVE' ? 0 : 1
      const rightPriority = right.phase === 'SELL_ACTIVE' ? 0 : 1
      return leftPriority - rightPriority || left.index - right.index
    })
  const band = completed[0]
  if (!band) return { action: 'NO_ACTION', reason: 'NO_SAFE_95_PERCENT_CONVERSION' }
  return {
    action: band.phase === 'BUY_ACTIVE' ? 'ROTATE_BUY_TO_SELL' : 'ROTATE_SELL_TO_BUY',
    bandId: band.id,
    reason: 'HEAD_AND_SAFE_CONVERSION_CONFIRMED',
  }
}

/**
 * Pick at most one completed band. SELL completions return stablecoin and take
 * priority; ties are deterministic by band index.
 *
 * @param {{bands: Array<{id: string, index: number, phase: string,
 * activePosition?: {tickLower: number, tickUpper: number}}>, pending?: unknown}} state
 * @param {number} currentTick
 */
export function decideNextBandAction(state, currentTick) {
  if (state.pending) throw new Error('存在未完成交易意图，必须先 reconcile')
  const completed = state.bands
    .filter((band) => {
      const position = band.activePosition
      if (!position) return false
      if (band.phase === 'BUY_ACTIVE') return currentTick >= position.tickUpper
      if (band.phase === 'SELL_ACTIVE') return currentTick < position.tickLower
      return false
    })
    .sort((left, right) => {
      const leftPriority = left.phase === 'SELL_ACTIVE' ? 0 : 1
      const rightPriority = right.phase === 'SELL_ACTIVE' ? 0 : 1
      return leftPriority - rightPriority || left.index - right.index
    })
  const band = completed[0]
  if (!band) return { action: 'NO_ACTION', reason: 'NO_FULLY_CROSSED_BAND' }
  return {
    action: band.phase === 'BUY_ACTIVE' ? 'ROTATE_BUY_TO_SELL' : 'ROTATE_SELL_TO_BUY',
    bandId: band.id,
    reason: 'TICK_BOUNDARY_FULLY_CROSSED',
  }
}
