import test from 'node:test'
import assert from 'node:assert/strict'
import { keccak256, size } from 'viem'
import {
  burnAmountsWithSlippage,
  encodeAddLiquidity,
  encodeRemoveLiquidity,
  mintAmounts,
  mintAmountsWithSlippage,
  poolId,
  positionAmounts,
  singleSidedPosition,
  sqrtRatioAtTick,
  UNISWAP_V4_MATH_LIMITS,
} from '../lib/uniswap-v4-position.mjs'

const SPY = '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C'
const PAIR = '0x6b1d42927B1a84eC28Fa88d4fC6FA7AF404966be'
const HOOK = '0x16D1560630Ce74af4478d9b8AD46548A092A2000'
const WALLET = '0x5F87869a8c63F3e8f065d999390e56fB25344041'
const POSITION_MANAGER = '0x58daec3116aae6D93017bAAea7749052E8a04fA7'
const POOL_KEY = { currency0: SPY, currency1: PAIR, fee: 10_000, tickSpacing: 200, hooks: HOOK }
const SIGNATURE = /** @type {import('viem').Hex} */ (`0x${'11'.repeat(65)}`)

/** @param {bigint} amount0 @param {bigint} amount1 @param {bigint} nonce */
function permit(amount0, amount1, nonce = 7n) {
  const details = []
  if (amount0 > 0n) {
    details.push({ token: SPY, amount: amount0, expiration: 2_000_000_000n, nonce })
  }
  if (amount1 > 0n) {
    details.push({ token: PAIR, amount: amount1, expiration: 2_000_000_000n, nonce: nonce + 1n })
  }
  return {
    owner: WALLET,
    permitBatch: { details, spender: POSITION_MANAGER, sigDeadline: 1_999_990_000n },
    signature: SIGNATURE,
  }
}

function assertCalldata(calldata, expectedBytes, expectedHash) {
  assert.equal(size(calldata), expectedBytes)
  assert.equal(keccak256(calldata), expectedHash)
}

test('TickMath and the deployed pool id match audited Uniswap SDK vectors', () => {
  assert.equal(sqrtRatioAtTick(0), UNISWAP_V4_MATH_LIMITS.Q96)
  assert.equal(sqrtRatioAtTick(-887272), 4295128739n)
  assert.equal(sqrtRatioAtTick(887272), 1461446703485210103287273052203988822378723970342n)
  assert.equal(sqrtRatioAtTick(114960), 24835874568316494895982144807879n)
  assert.equal(poolId(POOL_KEY), '0xf224a070c8626c890a085b258cf562ee4bf052b6d1d59104b3b44d722640c001')
})

test('BUY single-sided liquidity and mint bounds match SDK 2.3.3 exactly', () => {
  const position = singleSidedPosition({
    leg: 'BUY',
    sqrtPriceX96: 24835874568316494895982144807879n,
    tickLower: 117600,
    tickUpper: 118800,
    tickSpacing: 200,
    amount: 15556678386109011n,
  })
  assert.equal(position.liquidity, 95559586901254498430n)
  assert.deepEqual(mintAmounts(position), { amount0: 15556678386109011n, amount1: 0n })
  assert.deepEqual(positionAmounts(position), { amount0: 15556678386109010n, amount1: 0n })
  assert.deepEqual(mintAmountsWithSlippage(position, 50n), {
    amount0: 15556678386109011n,
    amount1: 0n,
  })
})

test('SELL single-sided liquidity and mint bounds match SDK 2.3.3 exactly', () => {
  const position = singleSidedPosition({
    leg: 'SELL',
    sqrtPriceX96: 36027068703021068924596730737313n,
    tickLower: 118000,
    tickUpper: 120000,
    tickSpacing: 200,
    amount: 4900000000000000000000n,
  })
  assert.equal(position.liquidity, 127677361032610657534n)
  assert.deepEqual(mintAmounts(position), { amount0: 0n, amount1: 4899999999999999999988n })
  assert.deepEqual(positionAmounts(position), { amount0: 0n, amount1: 4899999999999999999987n })
  assert.deepEqual(mintAmountsWithSlippage(position, 50n), {
    amount0: 0n,
    amount1: 4899999999999999999988n,
  })
})

test('position composition across both boundaries matches SDK 2.3.3 exactly', () => {
  const expected = new Map([
    [114960, [15874161618478582n, 0n]],
    [117600, [15874161618478582n, 0n]],
    [118200, [7818039476587813n, 1062189451591725343246n]],
    [118799, [12835922601205n, 2154874066497573760120n]],
    [118800, [0n, 2156725746205790644644n]],
    [122400, [0n, 2156725746205790644644n]],
  ])
  for (const [tick, [amount0, amount1]] of expected) {
    const actual = positionAmounts({
      sqrtPriceX96: sqrtRatioAtTick(tick),
      liquidity: 97509782552300510733n,
      tickLower: 117600,
      tickUpper: 118800,
      tickSpacing: 200,
    })
    assert.deepEqual(actual, { amount0, amount1 }, `tick ${tick}`)
  }
})

test('full-removal minimums match SDK 2.3.3 exactly', () => {
  const position = {
    sqrtPriceX96: 29203280931553866779873355698343n,
    liquidity: 97509782552300510733n,
    tickLower: 117600,
    tickUpper: 118800,
    tickSpacing: 200,
  }
  assert.deepEqual(burnAmountsWithSlippage(position, 200n), {
    amount0: 5211641831868576n,
    amount1: 700955807415015260655n,
  })
})

test('mint, increase and remove calldata remain byte-identical to SDK 2.3.3', () => {
  const buyPosition = singleSidedPosition({
    leg: 'BUY',
    sqrtPriceX96: 24835874568316494895982144807879n,
    tickLower: 117600,
    tickUpper: 118800,
    tickSpacing: 200,
    amount: 15556678386109011n,
  })
  const buyMaximums = mintAmountsWithSlippage(buyPosition, 50n)
  const commonBuy = {
    poolKey: POOL_KEY,
    tickLower: buyPosition.tickLower,
    tickUpper: buyPosition.tickUpper,
    liquidity: buyPosition.liquidity,
    amount0Max: buyMaximums.amount0,
    amount1Max: buyMaximums.amount1,
    batchPermit: permit(buyMaximums.amount0, buyMaximums.amount1),
    deadline: 2_000_000_100n,
  }
  assertCalldata(
    encodeAddLiquidity({ ...commonBuy, recipient: WALLET }),
    1604,
    '0x53ef6d1bbdcd2752e631ae21894d766567c4657d7dfd01a9c084ce2d7b577a67',
  )
  assertCalldata(
    encodeAddLiquidity({ ...commonBuy, tokenId: 1715883n }),
    1444,
    '0x64337a31a521d9fb9cef9cf9e776efbcbe8ffe05fea374a35871f92091b8f685',
  )

  const sellPosition = singleSidedPosition({
    leg: 'SELL',
    sqrtPriceX96: 36027068703021068924596730737313n,
    tickLower: 118000,
    tickUpper: 120000,
    tickSpacing: 200,
    amount: 4900000000000000000000n,
  })
  const sellMaximums = mintAmountsWithSlippage(sellPosition, 50n)
  assertCalldata(
    encodeAddLiquidity({
      poolKey: POOL_KEY,
      tickLower: sellPosition.tickLower,
      tickUpper: sellPosition.tickUpper,
      liquidity: sellPosition.liquidity,
      amount0Max: sellMaximums.amount0,
      amount1Max: sellMaximums.amount1,
      recipient: WALLET,
      batchPermit: permit(sellMaximums.amount0, sellMaximums.amount1),
      deadline: 2_000_000_100n,
    }),
    1604,
    '0x46ce0de2d47d1bcf0661bedce71aac9d875e61966a24a24af5f142f7db3513ff',
  )

  assertCalldata(
    encodeRemoveLiquidity({
      poolKey: POOL_KEY,
      tokenId: 1715883n,
      liquidity: 97509782552300510733n,
      amount0Min: 5211641831868576n,
      amount1Min: 700955807415015260655n,
      deadline: 2_000_000_100n,
    }),
    676,
    '0xe94508d3e6a43e94d5361b4283924619f1ec7e81f0516e4748f6f0d450f8ccf6',
  )
})

test('invalid ranges and ambiguous add modes fail closed', () => {
  assert.throws(() => sqrtRatioAtTick(887273), /tick/)
  assert.throws(
    () =>
      singleSidedPosition({
        leg: 'BUY',
        sqrtPriceX96: sqrtRatioAtTick(118200),
        tickLower: 117600,
        tickUpper: 118800,
        tickSpacing: 200,
        amount: 1n,
      }),
    /区间下方/,
  )
  assert.throws(
    () =>
      encodeAddLiquidity({
        poolKey: POOL_KEY,
        tickLower: 117600,
        tickUpper: 118800,
        liquidity: 1n,
        amount0Max: 1n,
        amount1Max: 0n,
        recipient: WALLET,
        tokenId: 1n,
        batchPermit: permit(1n, 0n),
        deadline: 2_000_000_100n,
      }),
    /二选一/,
  )
})
