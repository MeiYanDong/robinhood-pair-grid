import { encodeAbiParameters, encodeFunctionData, getAddress, keccak256 } from 'viem'

// Uniswap-derived MIT material is attributed in ../THIRD_PARTY_NOTICES.md.

/**
 * @typedef {object} PositionSnapshot
 * @property {bigint} sqrtPriceX96
 * @property {bigint} liquidity
 * @property {number} tickLower
 * @property {number} tickUpper
 * @property {number} [tickSpacing]
 */

/**
 * @typedef {object} PoolKeyInput
 * @property {string} currency0
 * @property {string} currency1
 * @property {number} fee
 * @property {number} tickSpacing
 * @property {string} hooks
 */

/**
 * @typedef {object} PermitDetail
 * @property {string} token
 * @property {bigint} amount
 * @property {bigint} expiration
 * @property {bigint} nonce
 */

/**
 * @typedef {object} BatchPermit
 * @property {string} owner
 * @property {{details: PermitDetail[], spender: string, sigDeadline: bigint}} permitBatch
 * @property {import('viem').Hex} signature
 */

const Q32 = 1n << 32n
const Q96 = 1n << 96n
const Q128 = 1n << 128n
const MAX_UINT128 = (1n << 128n) - 1n
const MAX_UINT256 = (1n << 256n) - 1n
const MIN_TICK = -887272
const MAX_TICK = 887272
const MIN_SQRT_RATIO = 4295128739n
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n
const MSG_SENDER = '0x0000000000000000000000000000000000000001'

const ACTION = Object.freeze({
  INCREASE_LIQUIDITY: 0x00,
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  SETTLE_PAIR: 0x0d,
  TAKE_PAIR: 0x11,
  CLOSE_CURRENCY: 0x12,
})

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
]

const POSITION_MANAGER_ABI = [
  {
    type: 'function',
    name: 'modifyLiquidities',
    stateMutability: 'payable',
    inputs: [
      { name: 'unlockData', type: 'bytes' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'multicall',
    stateMutability: 'payable',
    inputs: [{ name: 'data', type: 'bytes[]' }],
    outputs: [{ name: 'results', type: 'bytes[]' }],
  },
  {
    type: 'function',
    name: 'permitBatch',
    stateMutability: 'payable',
    inputs: [
      { name: 'owner', type: 'address' },
      {
        name: 'permitBatch',
        type: 'tuple',
        components: [
          {
            name: 'details',
            type: 'tuple[]',
            components: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint160' },
              { name: 'expiration', type: 'uint48' },
              { name: 'nonce', type: 'uint48' },
            ],
          },
          { name: 'spender', type: 'address' },
          { name: 'sigDeadline', type: 'uint256' },
        ],
      },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [{ name: 'err', type: 'bytes' }],
  },
]

const MINT_PARAMETERS = [
  { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS },
  { name: 'tickLower', type: 'int24' },
  { name: 'tickUpper', type: 'int24' },
  { name: 'liquidity', type: 'uint256' },
  { name: 'amount0Max', type: 'uint128' },
  { name: 'amount1Max', type: 'uint128' },
  { name: 'owner', type: 'address' },
  { name: 'hookData', type: 'bytes' },
]

const INCREASE_PARAMETERS = [
  { name: 'tokenId', type: 'uint256' },
  { name: 'liquidity', type: 'uint256' },
  { name: 'amount0Max', type: 'uint128' },
  { name: 'amount1Max', type: 'uint128' },
  { name: 'hookData', type: 'bytes' },
]

const DECREASE_PARAMETERS = [
  { name: 'tokenId', type: 'uint256' },
  { name: 'liquidity', type: 'uint256' },
  { name: 'amount0Min', type: 'uint128' },
  { name: 'amount1Min', type: 'uint128' },
  { name: 'hookData', type: 'bytes' },
]

const SETTLE_PAIR_PARAMETERS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
]

const CLOSE_CURRENCY_PARAMETERS = [{ name: 'currency', type: 'address' }]

const TAKE_PAIR_PARAMETERS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'recipient', type: 'address' },
]

/**
 * @param {string} name
 * @param {bigint} value
 * @param {{positive?: boolean, max?: bigint}} [options]
 */
function assertBigInt(name, value, { positive = false, max } = {}) {
  if (typeof value !== 'bigint') throw new TypeError(`${name} 必须是 bigint`)
  if (positive ? value <= 0n : value < 0n) throw new RangeError(`${name} 超出允许范围`)
  if (max !== undefined && value > max) throw new RangeError(`${name} 超出允许范围`)
}

/** @param {number} tick */
function assertTick(tick) {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new RangeError(`tick 超出 Uniswap 范围: ${tick}`)
  }
}

/** @param {PositionSnapshot} position */
function assertPosition(position) {
  assertTick(position.tickLower)
  assertTick(position.tickUpper)
  if (position.tickLower >= position.tickUpper) throw new RangeError('tickLower 必须小于 tickUpper')
  if (position.tickSpacing !== undefined) {
    if (!Number.isInteger(position.tickSpacing) || position.tickSpacing <= 0) {
      throw new RangeError('tickSpacing 必须是正整数')
    }
    if (position.tickLower % position.tickSpacing !== 0 || position.tickUpper % position.tickSpacing !== 0) {
      throw new RangeError('区间 tick 必须对齐 tickSpacing')
    }
  }
  assertBigInt('sqrtPriceX96', position.sqrtPriceX96, { positive: true })
  if (position.sqrtPriceX96 < MIN_SQRT_RATIO || position.sqrtPriceX96 >= MAX_SQRT_RATIO) {
    throw new RangeError('sqrtPriceX96 超出 Uniswap 范围')
  }
  assertBigInt('liquidity', position.liquidity, { positive: true })
}

/** @param {bigint} numerator @param {bigint} denominator */
function divRoundingUp(numerator, denominator) {
  if (denominator <= 0n) throw new RangeError('分母必须为正')
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n)
}

/** @param {bigint} value @param {bigint} multiplier */
function mulShift128(value, multiplier) {
  return (value * multiplier) >> 128n
}

// TickMath constants and rounding follow the MIT-licensed Uniswap v3 implementation.
/** @param {number} tick */
export function sqrtRatioAtTick(tick) {
  assertTick(tick)
  const absoluteTick = Math.abs(tick)
  let ratio = absoluteTick & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n
  if (absoluteTick & 0x2) ratio = mulShift128(ratio, 0xfff97272373d413259a46990580e213an)
  if (absoluteTick & 0x4) ratio = mulShift128(ratio, 0xfff2e50f5f656932ef12357cf3c7fdccn)
  if (absoluteTick & 0x8) ratio = mulShift128(ratio, 0xffe5caca7e10e4e61c3624eaa0941cd0n)
  if (absoluteTick & 0x10) ratio = mulShift128(ratio, 0xffcb9843d60f6159c9db58835c926644n)
  if (absoluteTick & 0x20) ratio = mulShift128(ratio, 0xff973b41fa98c081472e6896dfb254c0n)
  if (absoluteTick & 0x40) ratio = mulShift128(ratio, 0xff2ea16466c96a3843ec78b326b52861n)
  if (absoluteTick & 0x80) ratio = mulShift128(ratio, 0xfe5dee046a99a2a811c461f1969c3053n)
  if (absoluteTick & 0x100) ratio = mulShift128(ratio, 0xfcbe86c7900a88aedcffc83b479aa3a4n)
  if (absoluteTick & 0x200) ratio = mulShift128(ratio, 0xf987a7253ac413176f2b074cf7815e54n)
  if (absoluteTick & 0x400) ratio = mulShift128(ratio, 0xf3392b0822b70005940c7a398e4b70f3n)
  if (absoluteTick & 0x800) ratio = mulShift128(ratio, 0xe7159475a2c29b7443b29c7fa6e889d9n)
  if (absoluteTick & 0x1000) ratio = mulShift128(ratio, 0xd097f3bdfd2022b8845ad8f792aa5825n)
  if (absoluteTick & 0x2000) ratio = mulShift128(ratio, 0xa9f746462d870fdf8a65dc1f90e061e5n)
  if (absoluteTick & 0x4000) ratio = mulShift128(ratio, 0x70d869a156d2a1b890bb3df62baf32f7n)
  if (absoluteTick & 0x8000) ratio = mulShift128(ratio, 0x31be135f97d08fd981231505542fcfa6n)
  if (absoluteTick & 0x10000) ratio = mulShift128(ratio, 0x9aa508b5b7a84e1c677de54f3e99bc9n)
  if (absoluteTick & 0x20000) ratio = mulShift128(ratio, 0x5d6af8dedb81196699c329225ee604n)
  if (absoluteTick & 0x40000) ratio = mulShift128(ratio, 0x2216e584f5fa1ea926041bedfe98n)
  if (absoluteTick & 0x80000) ratio = mulShift128(ratio, 0x48a170391f7dc42444e8fa2n)
  if (tick > 0) ratio = MAX_UINT256 / ratio
  return ratio / Q32 + (ratio % Q32 === 0n ? 0n : 1n)
}

/**
 * @param {bigint} sqrtRatioAX96
 * @param {bigint} sqrtRatioBX96
 * @param {bigint} liquidity
 * @param {boolean} roundUp
 */
function amount0Delta(sqrtRatioAX96, sqrtRatioBX96, liquidity, roundUp) {
  const lower = sqrtRatioAX96 < sqrtRatioBX96 ? sqrtRatioAX96 : sqrtRatioBX96
  const upper = sqrtRatioAX96 < sqrtRatioBX96 ? sqrtRatioBX96 : sqrtRatioAX96
  const numerator1 = liquidity << 96n
  const numerator2 = upper - lower
  if (!roundUp) return (numerator1 * numerator2) / upper / lower
  return divRoundingUp(divRoundingUp(numerator1 * numerator2, upper), lower)
}

/**
 * @param {bigint} sqrtRatioAX96
 * @param {bigint} sqrtRatioBX96
 * @param {bigint} liquidity
 * @param {boolean} roundUp
 */
function amount1Delta(sqrtRatioAX96, sqrtRatioBX96, liquidity, roundUp) {
  const lower = sqrtRatioAX96 < sqrtRatioBX96 ? sqrtRatioAX96 : sqrtRatioBX96
  const upper = sqrtRatioAX96 < sqrtRatioBX96 ? sqrtRatioBX96 : sqrtRatioAX96
  const numerator = liquidity * (upper - lower)
  return roundUp ? divRoundingUp(numerator, Q96) : numerator / Q96
}

/**
 * @param {PositionSnapshot} position
 * @param {bigint} sqrtPriceX96
 * @param {boolean} roundUp
 */
function amountsAtSqrtRatio(position, sqrtPriceX96, roundUp) {
  assertPosition(position)
  assertBigInt('目标 sqrtPriceX96', sqrtPriceX96, { positive: true })
  const sqrtLower = sqrtRatioAtTick(position.tickLower)
  const sqrtUpper = sqrtRatioAtTick(position.tickUpper)
  if (sqrtPriceX96 <= sqrtLower) {
    return {
      amount0: amount0Delta(sqrtLower, sqrtUpper, position.liquidity, roundUp),
      amount1: 0n,
    }
  }
  if (sqrtPriceX96 < sqrtUpper) {
    return {
      amount0: amount0Delta(sqrtPriceX96, sqrtUpper, position.liquidity, roundUp),
      amount1: amount1Delta(sqrtLower, sqrtPriceX96, position.liquidity, roundUp),
    }
  }
  return {
    amount0: 0n,
    amount1: amount1Delta(sqrtLower, sqrtUpper, position.liquidity, roundUp),
  }
}

/** @param {PositionSnapshot} position */
export function positionAmounts(position) {
  return amountsAtSqrtRatio(position, position.sqrtPriceX96, false)
}

/** @param {PositionSnapshot} position */
export function mintAmounts(position) {
  return amountsAtSqrtRatio(position, position.sqrtPriceX96, true)
}

/** @param {bigint} value */
function integerSquareRoot(value) {
  assertBigInt('平方根输入', value)
  if (value < 2n) return value
  let previous = value
  let current = (previous + 1n) >> 1n
  while (current < previous) {
    previous = current
    current = (current + value / current) >> 1n
  }
  return previous
}

/**
 * @param {bigint} sqrtPriceX96
 * @param {bigint} slippageBps
 * @param {'lower'|'upper'} direction
 */
function slippedSqrtRatio(sqrtPriceX96, slippageBps, direction) {
  assertBigInt('slippageBps', slippageBps)
  if (slippageBps >= 10_000n) throw new RangeError('slippageBps 必须小于 10000')
  const factor = direction === 'lower' ? 10_000n - slippageBps : 10_000n + slippageBps
  const ratio = integerSquareRoot((sqrtPriceX96 * sqrtPriceX96 * factor) / 10_000n)
  if (ratio <= MIN_SQRT_RATIO) return MIN_SQRT_RATIO + 1n
  if (ratio >= MAX_SQRT_RATIO) return MAX_SQRT_RATIO - 1n
  return ratio
}

/** @param {PositionSnapshot} position @param {bigint} slippageBps */
export function mintAmountsWithSlippage(position, slippageBps) {
  assertPosition(position)
  const lowerSqrt = slippedSqrtRatio(position.sqrtPriceX96, slippageBps, 'lower')
  const upperSqrt = slippedSqrtRatio(position.sqrtPriceX96, slippageBps, 'upper')
  return {
    amount0: amountsAtSqrtRatio(position, lowerSqrt, true).amount0,
    amount1: amountsAtSqrtRatio(position, upperSqrt, true).amount1,
  }
}

/** @param {PositionSnapshot} position @param {bigint} slippageBps */
export function burnAmountsWithSlippage(position, slippageBps) {
  assertPosition(position)
  const lowerSqrt = slippedSqrtRatio(position.sqrtPriceX96, slippageBps, 'lower')
  const upperSqrt = slippedSqrtRatio(position.sqrtPriceX96, slippageBps, 'upper')
  return {
    amount0: amountsAtSqrtRatio(position, upperSqrt, false).amount0,
    amount1: amountsAtSqrtRatio(position, lowerSqrt, false).amount1,
  }
}

/**
 * @param {{leg: 'BUY'|'SELL', sqrtPriceX96: bigint, tickLower: number, tickUpper: number, tickSpacing: number, amount: bigint}} input
 * @returns {PositionSnapshot}
 */
export function singleSidedPosition({ leg, sqrtPriceX96, tickLower, tickUpper, tickSpacing, amount }) {
  assertBigInt('amount', amount, { positive: true })
  const candidate = { sqrtPriceX96, liquidity: 1n, tickLower, tickUpper, tickSpacing }
  assertPosition(candidate)
  const sqrtLower = sqrtRatioAtTick(tickLower)
  const sqrtUpper = sqrtRatioAtTick(tickUpper)
  let liquidity
  if (leg === 'BUY') {
    if (sqrtPriceX96 > sqrtLower) throw new Error('BUY 头寸创建时必须位于区间下方')
    liquidity = (amount * sqrtLower * sqrtUpper) / (Q96 * (sqrtUpper - sqrtLower))
  } else if (leg === 'SELL') {
    if (sqrtPriceX96 < sqrtUpper) throw new Error('SELL 头寸创建时必须位于区间上方')
    liquidity = (amount * Q96) / (sqrtUpper - sqrtLower)
  } else {
    throw new Error(`不支持的单边类型: ${leg}`)
  }
  if (liquidity <= 0n || liquidity > MAX_UINT128) throw new RangeError('可铸造流动性超出 uint128')
  return { sqrtPriceX96, liquidity, tickLower, tickUpper, tickSpacing }
}

/** @param {PoolKeyInput} poolKey */
export function poolId(poolKey) {
  const normalized = normalizePoolKey(poolKey)
  return keccak256(
    encodeParameters([{ name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS }], [normalized]),
  )
}

/** @param {PoolKeyInput} poolKey */
function normalizePoolKey(poolKey) {
  const currency0 = getAddress(poolKey.currency0)
  const currency1 = getAddress(poolKey.currency1)
  if (BigInt(currency0) >= BigInt(currency1)) throw new Error('poolKey 代币地址顺序错误')
  if (!Number.isInteger(poolKey.fee) || poolKey.fee < 0 || poolKey.fee >= 1_000_000) {
    throw new RangeError('poolKey fee 超出 uint24 LP fee 范围')
  }
  if (!Number.isInteger(poolKey.tickSpacing) || poolKey.tickSpacing <= 0) {
    throw new RangeError('poolKey tickSpacing 必须为正整数')
  }
  return {
    currency0,
    currency1,
    fee: poolKey.fee,
    tickSpacing: poolKey.tickSpacing,
    hooks: getAddress(poolKey.hooks),
  }
}

/** @param {readonly unknown[]} parameters @param {readonly unknown[]} values */
function encodeParameters(parameters, values) {
  return encodeAbiParameters(/** @type {any} */ (parameters), /** @type {any} */ (values))
}

/** @param {number[]} actions @param {import('viem').Hex[]} params */
function encodeActions(actions, params) {
  if (actions.length !== params.length || actions.length === 0) {
    throw new Error('PositionManager actions 与 params 数量不一致')
  }
  const actionBytes = /** @type {import('viem').Hex} */ (
    `0x${actions.map((action) => action.toString(16).padStart(2, '0')).join('')}`
  )
  return encodeParameters(
    [
      { name: 'actions', type: 'bytes' },
      { name: 'params', type: 'bytes[]' },
    ],
    [actionBytes, params],
  )
}

/** @param {number[]} actions @param {import('viem').Hex[]} params @param {bigint} deadline */
function encodeModifyLiquidities(actions, params, deadline) {
  assertBigInt('deadline', deadline, { positive: true })
  return encodeFunctionData({
    abi: POSITION_MANAGER_ABI,
    functionName: 'modifyLiquidities',
    args: [encodeActions(actions, params), deadline],
  })
}

/** @param {BatchPermit} batchPermit */
function encodeBatchPermit(batchPermit) {
  if (!batchPermit?.permitBatch?.details?.length) throw new Error('缺少 Permit2 batch permit')
  for (const detail of batchPermit.permitBatch.details) {
    assertBigInt('Permit2 amount', detail.amount, { positive: true, max: (1n << 160n) - 1n })
    assertBigInt('Permit2 expiration', detail.expiration, { positive: true, max: (1n << 48n) - 1n })
    assertBigInt('Permit2 nonce', detail.nonce, { max: (1n << 48n) - 1n })
  }
  return encodeFunctionData({
    abi: POSITION_MANAGER_ABI,
    functionName: 'permitBatch',
    args: [getAddress(batchPermit.owner), batchPermit.permitBatch, batchPermit.signature],
  })
}

/** @param {import('viem').Hex} modifyCalldata @param {BatchPermit} batchPermit */
function withBatchPermit(modifyCalldata, batchPermit) {
  const permitCalldata = encodeBatchPermit(batchPermit)
  return encodeFunctionData({
    abi: POSITION_MANAGER_ABI,
    functionName: 'multicall',
    args: [[permitCalldata, modifyCalldata]],
  })
}

/**
 * @param {{poolKey: PoolKeyInput, tickLower: number, tickUpper: number, liquidity: bigint,
 * amount0Max: bigint, amount1Max: bigint, recipient?: string|null, tokenId?: bigint|null,
 * batchPermit: BatchPermit, deadline: bigint, hookData?: import('viem').Hex}} input
 */
export function encodeAddLiquidity({
  poolKey,
  tickLower,
  tickUpper,
  liquidity,
  amount0Max,
  amount1Max,
  recipient = null,
  tokenId = null,
  batchPermit,
  deadline,
  hookData = '0x',
}) {
  const normalizedPoolKey = normalizePoolKey(poolKey)
  assertBigInt('liquidity', liquidity, { positive: true })
  assertBigInt('amount0Max', amount0Max, { max: MAX_UINT128 })
  assertBigInt('amount1Max', amount1Max, { max: MAX_UINT128 })
  if ((recipient === null) === (tokenId === null)) {
    throw new Error('新建仓必须提供 recipient；复用仓必须提供 tokenId，且两者只能二选一')
  }
  let actions
  let params
  if (recipient !== null) {
    actions = [ACTION.MINT_POSITION, ACTION.SETTLE_PAIR]
    params = [
      encodeParameters(MINT_PARAMETERS, [
        normalizedPoolKey,
        tickLower,
        tickUpper,
        liquidity,
        amount0Max,
        amount1Max,
        getAddress(recipient),
        hookData,
      ]),
      encodeParameters(SETTLE_PAIR_PARAMETERS, [normalizedPoolKey.currency0, normalizedPoolKey.currency1]),
    ]
  } else {
    assertBigInt('tokenId', tokenId)
    actions = [ACTION.INCREASE_LIQUIDITY, ACTION.CLOSE_CURRENCY, ACTION.CLOSE_CURRENCY]
    params = [
      encodeParameters(INCREASE_PARAMETERS, [tokenId, liquidity, amount0Max, amount1Max, hookData]),
      encodeParameters(CLOSE_CURRENCY_PARAMETERS, [normalizedPoolKey.currency0]),
      encodeParameters(CLOSE_CURRENCY_PARAMETERS, [normalizedPoolKey.currency1]),
    ]
  }
  return withBatchPermit(encodeModifyLiquidities(actions, params, deadline), batchPermit)
}

/**
 * @param {{poolKey: PoolKeyInput, tokenId: bigint, liquidity: bigint, amount0Min: bigint,
 * amount1Min: bigint, deadline: bigint, hookData?: import('viem').Hex}} input
 */
export function encodeRemoveLiquidity({
  poolKey,
  tokenId,
  liquidity,
  amount0Min,
  amount1Min,
  deadline,
  hookData = '0x',
}) {
  const normalizedPoolKey = normalizePoolKey(poolKey)
  assertBigInt('tokenId', tokenId)
  assertBigInt('liquidity', liquidity, { positive: true })
  assertBigInt('amount0Min', amount0Min, { max: MAX_UINT128 })
  assertBigInt('amount1Min', amount1Min, { max: MAX_UINT128 })
  return encodeModifyLiquidities(
    [ACTION.DECREASE_LIQUIDITY, ACTION.TAKE_PAIR],
    [
      encodeParameters(DECREASE_PARAMETERS, [tokenId, liquidity, amount0Min, amount1Min, hookData]),
      encodeParameters(TAKE_PAIR_PARAMETERS, [
        normalizedPoolKey.currency0,
        normalizedPoolKey.currency1,
        MSG_SENDER,
      ]),
    ],
    deadline,
  )
}

export const UNISWAP_V4_MATH_LIMITS = Object.freeze({
  MIN_TICK,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MAX_SQRT_RATIO,
  Q96,
  Q128,
})
