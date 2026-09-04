import assert from 'node:assert/strict'
import test from 'node:test'
import {
  alignTickDown,
  alignTickUp,
  buyRangeFromAnchorTick,
  humanPairPriceFromTick,
  legCompletion,
  rangeFromHumanPrices,
  sellRangeFromBasis,
  tickFromHumanPairPrice,
} from '../lib/ranges.mjs'

test('tick alignment works for positive and negative ticks', () => {
  assert.equal(alignTickDown(119_087, 200), 119_000)
  assert.equal(alignTickUp(119_087, 200), 119_200)
  assert.equal(alignTickDown(-101, 200), -200)
  assert.equal(alignTickUp(-101, 200), 0)
})

test('human price and tick round-trip', () => {
  const tick = 118_987
  const price = humanPairPriceFromTick(tick)
  assert.ok(Math.abs(tickFromHumanPairPrice(price) - tick) < 1e-8)
})

test('buy leg sits below market and is SPY-only at entry', () => {
  const currentTick = 118_987
  const range = buyRangeFromAnchorTick(currentTick)
  assert.equal(range.tickLower % 200, 0)
  assert.equal(range.tickUpper % 200, 0)
  assert.ok(range.tickLower > currentTick)
  assert.ok(range.actualLowPrice < range.actualHighPrice)
  assert.ok(range.actualHighPrice < range.anchorPrice)
  assert.equal(legCompletion('BUY', currentTick, range.tickLower, range.tickUpper), false)
  assert.equal(legCompletion('BUY', range.tickUpper, range.tickLower, range.tickUpper), true)
})

test('sell leg sits above post-buy market and is PAIR-only at entry', () => {
  const basis = 0.00000575
  const currentTick = Math.ceil(tickFromHumanPairPrice(0.0000053))
  const range = sellRangeFromBasis(basis, currentTick)
  assert.ok(range.tickUpper <= currentTick)
  assert.ok(range.actualLowPrice > humanPairPriceFromTick(currentTick))
  assert.equal(legCompletion('SELL', currentTick, range.tickLower, range.tickUpper), false)
  assert.equal(legCompletion('SELL', range.tickLower - 1, range.tickLower, range.tickUpper), true)
})

test('price range inversion preserves human low/high ordering', () => {
  const range = rangeFromHumanPrices({ lowPrice: 0.000005, highPrice: 0.000006, tickSpacing: 200 })
  assert.ok(range.tickLower < range.tickUpper)
  assert.ok(range.actualLowPrice <= 0.000005)
  assert.ok(range.actualHighPrice >= 0.000006)
})
