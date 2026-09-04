const LOG_TICK_BASE = Math.log(1.0001)

function assertFinitePositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} 必须是有限正数`)
}

export function alignTickDown(tick, spacing) {
  if (!Number.isInteger(tick) || !Number.isInteger(spacing) || spacing <= 0) {
    throw new Error('tick 必须是整数，spacing 必须是正整数')
  }
  const aligned = Math.floor(tick / spacing) * spacing
  return Object.is(aligned, -0) ? 0 : aligned
}

export function alignTickUp(tick, spacing) {
  if (!Number.isInteger(tick) || !Number.isInteger(spacing) || spacing <= 0) {
    throw new Error('tick 必须是整数，spacing 必须是正整数')
  }
  const aligned = Math.ceil(tick / spacing) * spacing
  return Object.is(aligned, -0) ? 0 : aligned
}

// Pool raw price is PAIR per SPY. Strategy price is the inverse: SPY per PAIR.
export function humanPairPriceFromTick(tick) {
  if (!Number.isInteger(tick)) throw new Error('tick 必须是整数')
  return Math.exp(-tick * LOG_TICK_BASE)
}

export function tickFromHumanPairPrice(price) {
  assertFinitePositive(price, 'PAIR 价格')
  return Math.log(1 / price) / LOG_TICK_BASE
}

export function rangeFromHumanPrices({ lowPrice, highPrice, tickSpacing = 200 }) {
  assertFinitePositive(lowPrice, '低价')
  assertFinitePositive(highPrice, '高价')
  if (lowPrice >= highPrice) throw new Error('低价必须小于高价')
  const tickLower = alignTickDown(Math.floor(tickFromHumanPairPrice(highPrice)), tickSpacing)
  const tickUpper = alignTickUp(Math.ceil(tickFromHumanPairPrice(lowPrice)), tickSpacing)
  if (tickLower >= tickUpper) throw new Error('对齐后区间无效')
  return {
    tickLower,
    tickUpper,
    actualLowPrice: humanPairPriceFromTick(tickUpper),
    actualHighPrice: humanPairPriceFromTick(tickLower),
  }
}

export function buyRangeFromAnchorTick(
  currentTick,
  { lowMultiplier = 0.8, highMultiplier = 0.9, tickSpacing = 200 } = {},
) {
  if (!(lowMultiplier > 0 && lowMultiplier < highMultiplier && highMultiplier < 1)) {
    throw new Error('买入乘数必须满足 0 < low < high < 1')
  }
  const anchorPrice = humanPairPriceFromTick(currentTick)
  const range = rangeFromHumanPrices({
    lowPrice: anchorPrice * lowMultiplier,
    highPrice: anchorPrice * highMultiplier,
    tickSpacing,
  })
  if (range.tickLower <= currentTick) throw new Error('买入区间未完全位于当前价格下方')
  return { anchorTick: currentTick, anchorPrice, lowMultiplier, highMultiplier, ...range }
}

export function sellRangeFromBasis(
  basisPrice,
  currentTick,
  { lowMultiplier = 1.12, highMultiplier = 1.25, tickSpacing = 200 } = {},
) {
  assertFinitePositive(basisPrice, '实际买入成本')
  if (!(1 < lowMultiplier && lowMultiplier < highMultiplier)) {
    throw new Error('卖出乘数必须满足 1 < low < high')
  }
  const range = rangeFromHumanPrices({
    lowPrice: basisPrice * lowMultiplier,
    highPrice: basisPrice * highMultiplier,
    tickSpacing,
  })
  if (range.tickUpper > currentTick) throw new Error('卖出区间未完全位于当前价格上方')
  return { basisPrice, lowMultiplier, highMultiplier, ...range }
}

export function legCompletion(leg, currentTick, tickLower, tickUpper) {
  if (leg === 'BUY') return currentTick >= tickUpper
  if (leg === 'SELL') return currentTick < tickLower
  throw new Error(`未知方向: ${leg}`)
}
