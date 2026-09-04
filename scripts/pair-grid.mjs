import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  encodePacked,
  formatEther,
  formatUnits,
  getAddress,
  http,
  keccak256,
  padHex,
  parseAbi,
  parseEther,
  toHex,
} from 'viem'
import {
  buyRangeFromAnchorTick,
  humanPairPriceFromTick,
  legCompletion,
  sellRangeFromBasis,
} from '../lib/ranges.mjs'
import {
  burnAmountsWithSlippage,
  encodeAddLiquidity,
  encodeRemoveLiquidity,
  mintAmounts,
  mintAmountsWithSlippage,
  poolId,
  positionAmounts,
  singleSidedPosition,
} from '../lib/uniswap-v4-position.mjs'
import { loadSignerAccount } from '../lib/account-loader.mjs'
import { assertLiveArm, decideKeeperAction, redactSensitiveText } from '../lib/runtime-guards.mjs'
import { StateStore } from '../lib/state-store.mjs'
import {
  recoverExit,
  recoverInitialFunding,
  recoverInitialMint,
  recoverRotationMint,
  recoverRotationRemoval,
} from '../lib/recovery.mjs'

const CHAIN_ID = 4663
const RPC_URL = process.env.RH_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
const FORK_TEST = process.env.PAIR_GRID_FORK_TEST === '1'
const EXPLORER_TX = 'https://robinhoodchain.blockscout.com/tx/'
const KEYCHAIN_SERVICE = process.env.PAIR_GRID_KEYCHAIN_SERVICE || 'codex-rh-pair-grid'

if (!process.env.PAIR_GRID_WALLET) {
  throw new Error('缺少 PAIR_GRID_WALLET；公开仓库不内置实盘钱包地址')
}
const WALLET = getAddress(process.env.PAIR_GRID_WALLET)
const WETH = getAddress('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73')
const USDG = getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168')
const SPY = getAddress('0x117cc2133c37B721F49dE2A7a74833232B3B4C0C')
const PAIR = getAddress('0x6b1d42927B1a84eC28Fa88d4fC6FA7AF404966be')
const PERMIT2 = getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3')
const V3_QUOTER = getAddress('0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7')
const V3_ROUTER = getAddress('0xcaf681a66d020601342297493863e78c959e5cb2')
const V4_STATE_VIEW = getAddress('0xF3334192D15450CdD385c8B70e03f9A6bD9E673b')
const POSITION_MANAGER = getAddress('0x58daec3116aae6D93017bAAea7749052E8a04fA7')
const HOOK = getAddress('0x16D1560630Ce74af4478d9b8AD46548A092A2000')
const POOL_ID = '0xf224a070c8626c890a085b258cf562ee4bf052b6d1d59104b3b44d722640c001'

const TICK_SPACING = 200
const POOL_FEE = 10_000
const CANARY_ETH = parseEther(process.env.PAIR_GRID_CANARY_ETH || '0.005')
const MAX_CANARY_ETH = parseEther('0.01')
const MIN_GAS_RESERVE = parseEther('0.005')
const MAX_INITIAL_GAS_BUDGET = parseEther(FORK_TEST ? '0.02' : '0.005')
// Fork readback at block 53,942,564 used 340,983 gas for the mint. These
// ceilings leave material headroom while still reflecting executable evidence.
const CONSERVATIVE_APPROVAL_GAS = 120_000n
const CONSERVATIVE_MINT_GAS = 500_000n
const CONSERVATIVE_ROTATION_MINT_GAS = 600_000n
const SWAP_SLIPPAGE_BPS = 100n
const ADD_SLIPPAGE_BPS = 50n
const REMOVE_SLIPPAGE_BPS = 200n
const TOKEN_USE_BPS = 9_800n
const FEE_TIERS = [10_000, 3_000, 500, 100]
const UINT160_MAX = (1n << 160n) - 1n
const Q128 = 1n << 128n
const UINT256_MODULUS = 1n << 256n

if (CANARY_ETH <= 0n || CANARY_ETH > MAX_CANARY_ETH) {
  throw new Error(`PAIR_GRID_CANARY_ETH 必须在 (0, ${formatEther(MAX_CANARY_ETH)}] ETH`)
}
if (FORK_TEST && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(RPC_URL)) {
  throw new Error('PAIR_GRID_FORK_TEST=1 只能与 localhost RPC 一起使用')
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUN_DIR = process.env.PAIR_GRID_RUN_DIR
  ? path.resolve(process.env.PAIR_GRID_RUN_DIR)
  : path.join(ROOT, 'runs')
const stateStore = new StateStore(RUN_DIR)
stateStore.ensureDirectory()

const chain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Robinhood Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
})

/** @type {any} viem's custom-chain generics are isolated at this RPC adapter boundary. */
const publicClient = createPublicClient({
  chain,
  transport: http(undefined, { timeout: 30_000, retryCount: 1 }),
})

const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
])

const V3_QUOTER_ABI = parseAbi([
  'function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)',
])

const V3_ROUTER_ABI = [
  {
    type: 'function',
    name: 'exactInput',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'path', type: 'bytes' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
]

const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
  'function getPositionInfo(bytes32 poolId,bytes32 positionId) view returns (uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128)',
  'function getFeeGrowthInside(bytes32 poolId,int24 tickLower,int24 tickUpper) view returns (uint256 feeGrowthInside0X128,uint256 feeGrowthInside1X128)',
])

const PERMIT2_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  },
]

const POSITION_NFT_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
  'event Transfer(address indexed from,address indexed to,uint256 indexed id)',
])

const poolKey = {
  currency0: SPY,
  currency1: PAIR,
  fee: POOL_FEE,
  tickSpacing: TICK_SPACING,
  hooks: HOOK,
}

const COMPUTED_POOL_ID = poolId(poolKey)
if (COMPUTED_POOL_ID.toLowerCase() !== POOL_ID.toLowerCase()) {
  throw new Error(`本地 PoolId 编码不匹配: ${COMPUTED_POOL_ID}`)
}

function nowSeconds() {
  return Math.floor(Date.now() / 1_000)
}

function bpsFloor(value, bps) {
  return (value * (10_000n - bps)) / 10_000n
}

function stringify(value) {
  return JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item), 2)
}

function errorMessage(error) {
  return redactSensitiveText(error?.shortMessage || error?.message || String(error))
}

function appendAudit(event, details = {}) {
  stateStore.appendAudit(event, details)
}

function readState() {
  return stateStore.readState()
}

function writeState(state) {
  stateStore.writeState(state)
}

function loadAccountWithMetadata() {
  return loadSignerAccount({ expectedWallet: WALLET, keychainService: KEYCHAIN_SERVICE })
}

function loadAccount() {
  return loadAccountWithMetadata().account
}

async function assertNonceClear() {
  const [latest, pending] = await Promise.all([
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  if (latest !== pending) throw new Error(`存在 pending nonce：latest=${latest}, pending=${pending}`)
  return { latest, pending }
}

async function assertContracts() {
  const expected = [
    WETH,
    USDG,
    SPY,
    PAIR,
    PERMIT2,
    V3_QUOTER,
    V3_ROUTER,
    V4_STATE_VIEW,
    POSITION_MANAGER,
    HOOK,
  ]
  const codes = await Promise.all(expected.map((address) => publicClient.getCode({ address })))
  const missing = expected.filter((_, index) => !codes[index] || codes[index] === '0x')
  if (missing.length) throw new Error(`目标合约无 bytecode: ${missing.join(', ')}`)
  const [spySymbol, spyDecimals, pairSymbol, pairDecimals] = await Promise.all([
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'symbol' }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'decimals' }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'symbol' }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'decimals' }),
  ])
  if (spySymbol !== 'SPY' || spyDecimals !== 18 || pairSymbol !== 'PAIR' || pairDecimals !== 18) {
    throw new Error(`代币元数据不匹配: SPY=${spySymbol}/${spyDecimals}, PAIR=${pairSymbol}/${pairDecimals}`)
  }
}

async function assertRuntimeIdentity() {
  const chainId = await publicClient.getChainId()
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}，预期 ${CHAIN_ID}`)
  await assertContracts()
  return chainId
}

async function getPoolState() {
  const [[sqrtPriceX96, tick, protocolFee, lpFee], liquidity] = await Promise.all([
    publicClient.readContract({
      address: V4_STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getSlot0',
      args: [POOL_ID],
    }),
    publicClient.readContract({
      address: V4_STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getLiquidity',
      args: [POOL_ID],
    }),
  ])
  if (sqrtPriceX96 === 0n || liquidity === 0n || lpFee !== POOL_FEE) {
    throw new Error(`官方池状态异常: sqrt=${sqrtPriceX96}, liquidity=${liquidity}, lpFee=${lpFee}`)
  }
  return { sqrtPriceX96, tick, protocolFee, lpFee, liquidity }
}

function v3Path(tokens, fees) {
  const types = ['address']
  const values = [tokens[0]]
  for (let index = 0; index < fees.length; index += 1) {
    types.push('uint24', 'address')
    values.push(fees[index], tokens[index + 1])
  }
  return encodePacked(types, values)
}

async function quoteBestEthToSpy(amountIn) {
  const candidates = []
  for (const fee of FEE_TIERS) candidates.push({ fees: [fee], path: v3Path([WETH, SPY], [fee]) })
  for (const first of FEE_TIERS) {
    for (const second of FEE_TIERS) {
      candidates.push({ fees: [first, second], path: v3Path([WETH, USDG, SPY], [first, second]) })
    }
  }
  const results = []
  for (const candidate of candidates) {
    try {
      const { result } = await publicClient.simulateContract({
        address: V3_QUOTER,
        abi: V3_QUOTER_ABI,
        functionName: 'quoteExactInput',
        args: [candidate.path, amountIn],
        account: WALLET,
      })
      if (result[0] > 0n) results.push({ ...candidate, amountOut: result[0], quoterGas: result[3] })
    } catch {
      // Missing routes are expected on this young chain.
    }
  }
  results.sort((left, right) =>
    left.amountOut > right.amountOut ? -1 : left.amountOut < right.amountOut ? 1 : 0,
  )
  if (!results.length) throw new Error('没有可执行的 ETH→SPY V3 路径')
  return results[0]
}

function buildV3SwapData(pathBytes, amountIn, amountOutMinimum) {
  return encodeFunctionData({
    abi: V3_ROUTER_ABI,
    functionName: 'exactInput',
    args: [{ path: pathBytes, recipient: WALLET, amountIn, amountOutMinimum }],
  })
}

async function walletSnapshot() {
  const [ethWei, spyWei, pairWei, nftBalance, nonceLatest, noncePending] = await Promise.all([
    publicClient.getBalance({ address: WALLET }),
    publicClient.readContract({ address: SPY, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({ address: PAIR, abi: ERC20_ABI, functionName: 'balanceOf', args: [WALLET] }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'balanceOf',
      args: [WALLET],
    }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  return { ethWei, spyWei, pairWei, nftBalance, nonceLatest, noncePending }
}

async function transactionBudget(to, data, value = 0n) {
  await publicClient.call({ account: WALLET, to, data, value })
  const [estimatedGas, gasPrice] = await Promise.all([
    publicClient.estimateGas({ account: WALLET, to, data, value }),
    publicClient.getGasPrice(),
  ])
  const gasLimit = (estimatedGas * 120n) / 100n + 10_000n
  const budget = (gasLimit * gasPrice * 125n) / 100n
  return { estimatedGas, gasLimit, gasPrice, budget }
}

async function sendChecked(
  walletClient,
  { label, to, data, value = 0n, minimumBalanceAfter = MIN_GAS_RESERVE },
) {
  assertLiveArm()
  await assertRuntimeIdentity()
  await assertNonceClear()
  const budget = await transactionBudget(to, data, value)
  const balance = await publicClient.getBalance({ address: WALLET })
  const required = value + budget.budget + minimumBalanceAfter
  if (balance < required) {
    throw new Error(
      `${label} 资金保护触发：余额 ${formatEther(balance)} ETH，至少需要 ${formatEther(required)} ETH`,
    )
  }
  const nonce = await publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' })
  appendAudit('transaction_prepared', {
    label,
    nonce,
    valueWei: value,
    gasEstimate: budget.estimatedGas,
    gasLimit: budget.gasLimit,
    gasPriceWei: budget.gasPrice,
    maxGasBudgetWei: budget.budget,
    minimumBalanceAfterWei: minimumBalanceAfter,
  })
  let hash
  try {
    hash = await walletClient.sendTransaction({
      account: walletClient.account,
      to,
      data,
      value,
      gas: budget.gasLimit,
    })
  } catch (error) {
    appendAudit('broadcast_failed_before_hash', { label, message: errorMessage(error) })
    throw error
  }
  appendAudit('broadcast', { label, hash, nonce })
  let receipt
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 })
  } catch (error) {
    appendAudit('receipt_unknown', { label, hash, message: errorMessage(error) })
    throw new Error(`${label} 已广播但回执未知，禁止自动重试。交易：${hash}`)
  }
  if (receipt.status !== 'success') {
    appendAudit('receipt_reverted', { label, hash, blockNumber: receipt.blockNumber })
    throw new Error(`${label} 链上回执失败：${hash}`)
  }
  const gasCost = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)
  appendAudit('receipt_success', {
    label,
    hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    gasCostWei: gasCost,
  })
  console.log(`${label}: ${hash} (${EXPLORER_TX}${hash})`)
  return { hash, receipt, gasCost }
}

async function setErc20AllowanceExact(walletClient, token, required, label, futureGasReserve) {
  if (required <= 0n) return []
  const current = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [WALLET, PERMIT2],
  })
  if (current === required) return []
  const results = []
  if (current > 0n) {
    const zeroData = encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2, 0n] })
    results.push(
      await sendChecked(walletClient, {
        label: `${label}：先清零旧限额`,
        to: token,
        data: zeroData,
        minimumBalanceAfter: futureGasReserve,
      }),
    )
  }
  const exactData = encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2, required] })
  results.push(
    await sendChecked(walletClient, {
      label: `${label}：设置本次精确上限`,
      to: token,
      data: exactData,
      minimumBalanceAfter: futureGasReserve,
    }),
  )
  const readback = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [WALLET, PERMIT2],
  })
  if (readback !== required) throw new Error(`ERC-20 授权回读不匹配：chain=${readback}, required=${required}`)
  return results
}

async function signPermit(account, tokenAmounts) {
  const nonZero = tokenAmounts.filter((item) => item.amount > 0n)
  if (!nonZero.length) throw new Error('Permit2 授权金额为 0')
  const details = []
  for (const item of nonZero) {
    if (item.amount > UINT160_MAX) throw new Error('Permit2 授权金额超过 uint160')
    const [, , nonce] = await publicClient.readContract({
      address: PERMIT2,
      abi: PERMIT2_ABI,
      functionName: 'allowance',
      args: [WALLET, item.token, POSITION_MANAGER],
    })
    details.push({
      token: item.token,
      amount: item.amount,
      expiration: BigInt(nowSeconds() + 20 * 60),
      nonce,
    })
  }
  const permitBatch = {
    details,
    spender: POSITION_MANAGER,
    sigDeadline: BigInt(nowSeconds() + 5 * 60),
  }
  const signature = await account.signTypedData({
    domain: { name: 'Permit2', chainId: CHAIN_ID, verifyingContract: PERMIT2 },
    types: {
      PermitDetails: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ],
      PermitBatch: [
        { name: 'details', type: 'PermitDetails[]' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
      ],
    },
    primaryType: 'PermitBatch',
    message: permitBatch,
  })
  return { owner: WALLET, permitBatch, signature }
}

function assertLegIsSingleSided(leg, poolState, tickLower, tickUpper) {
  if (leg === 'BUY' && poolState.tick >= tickLower) {
    throw new Error(`买入腿建仓时不是 SPY-only：current=${poolState.tick}, lower=${tickLower}`)
  }
  if (leg === 'SELL' && poolState.tick < tickUpper) {
    throw new Error(`卖出腿建仓时不是 PAIR-only：current=${poolState.tick}, upper=${tickUpper}`)
  }
}

async function buildLegAdd(account, { leg, tickLower, tickUpper, availableWei, tokenId = null }) {
  if (availableWei <= 0n) throw new Error(`${leg} 腿可用金额为 0`)
  const poolState = await getPoolState()
  assertLegIsSingleSided(leg, poolState, tickLower, tickUpper)
  const usableWei = (availableWei * TOKEN_USE_BPS) / 10_000n
  const position = singleSidedPosition({
    leg,
    sqrtPriceX96: poolState.sqrtPriceX96,
    tickLower,
    tickUpper,
    tickSpacing: TICK_SPACING,
    amount: usableWei,
  })
  const desired = mintAmounts(position)
  const maximums = mintAmountsWithSlippage(position, ADD_SLIPPAGE_BPS)
  const amount0Desired = desired.amount0
  const amount1Desired = desired.amount1
  const amount0Max = maximums.amount0
  const amount1Max = maximums.amount1
  if (position.liquidity <= 0n) throw new Error(`${leg} 腿可铸造流动性为 0`)
  if (leg === 'BUY') {
    if (amount0Desired <= 0n || amount1Desired !== 0n || amount1Max !== 0n) {
      throw new Error(
        `买入腿不是纯 SPY：desired0=${amount0Desired}, desired1=${amount1Desired}, max1=${amount1Max}`,
      )
    }
    if (amount0Max > availableWei) throw new Error('买入腿滑点上限超过可用 SPY')
  } else {
    if (amount1Desired <= 0n || amount0Desired !== 0n || amount0Max !== 0n) {
      throw new Error(
        `卖出腿不是纯 PAIR：desired0=${amount0Desired}, desired1=${amount1Desired}, max0=${amount0Max}`,
      )
    }
    if (amount1Max > availableWei) throw new Error('卖出腿滑点上限超过可用 PAIR')
  }
  const batchPermit = await signPermit(account, [
    { token: SPY, amount: amount0Max },
    { token: PAIR, amount: amount1Max },
  ])
  const common = {
    poolKey,
    tickLower,
    tickUpper,
    liquidity: position.liquidity,
    amount0Max,
    amount1Max,
    deadline: BigInt(nowSeconds() + 5 * 60),
    batchPermit,
  }
  const data = encodeAddLiquidity(
    tokenId === null ? { ...common, recipient: WALLET } : { ...common, tokenId: BigInt(tokenId) },
  )
  return {
    leg,
    poolState,
    position,
    liquidity: position.liquidity,
    usableWei,
    amount0Desired,
    amount1Desired,
    amount0Max,
    amount1Max,
    data,
  }
}

function buildFullRemove(positionRecord, liquidity, poolState) {
  const position = {
    sqrtPriceX96: poolState.sqrtPriceX96,
    liquidity,
    tickLower: positionRecord.tickLower,
    tickUpper: positionRecord.tickUpper,
    tickSpacing: TICK_SPACING,
  }
  const principal = positionAmounts(position)
  const minimums = burnAmountsWithSlippage(position, REMOVE_SLIPPAGE_BPS)
  const data = encodeRemoveLiquidity({
    poolKey,
    tokenId: BigInt(positionRecord.tokenId),
    liquidity,
    amount0Min: minimums.amount0,
    amount1Min: minimums.amount1,
    deadline: BigInt(nowSeconds() + 5 * 60),
  })
  return {
    position,
    amount0Principal: principal.amount0,
    amount1Principal: principal.amount1,
    data,
  }
}

function parseMintTokenId(receipt) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== POSITION_MANAGER.toLowerCase()) continue
    try {
      const parsed = /** @type {any} */ (
        decodeEventLog({ abi: POSITION_NFT_ABI, data: log.data, topics: log.topics })
      )
      if (
        parsed.eventName === 'Transfer' &&
        parsed.args.from === '0x0000000000000000000000000000000000000000' &&
        parsed.args.to.toLowerCase() === WALLET.toLowerCase()
      )
        return parsed.args.id
    } catch {
      // Ignore unrelated logs.
    }
  }
  return null
}

function tokenNetFromReceipt(receipt, token) {
  let net = 0n
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue
    try {
      const parsed = /** @type {any} */ (
        decodeEventLog({ abi: ERC20_ABI, data: log.data, topics: log.topics })
      )
      if (parsed.eventName !== 'Transfer') continue
      if (parsed.args.to.toLowerCase() === WALLET.toLowerCase()) net += parsed.args.value
      if (parsed.args.from.toLowerCase() === WALLET.toLowerCase()) net -= parsed.args.value
    } catch {
      // Ignore unrelated logs.
    }
  }
  return net
}

/** @param {{ gasCost: bigint }[]} results */
function receiptGasTotal(results) {
  return results.filter(Boolean).reduce((sum, result) => sum + result.gasCost, 0n)
}

function positionStateId(tokenId, tickLower, tickUpper) {
  const salt = padHex(toHex(tokenId), { size: 32 })
  return keccak256(
    encodePacked(['address', 'int24', 'int24', 'bytes32'], [POSITION_MANAGER, tickLower, tickUpper, salt]),
  )
}

/** @param {bigint} left @param {bigint} right */
function wrappingSub(left, right) {
  return (left - right + UINT256_MODULUS) % UINT256_MODULUS
}

async function getAccruedFees(positionRecord) {
  const id = positionStateId(
    BigInt(positionRecord.tokenId),
    positionRecord.tickLower,
    positionRecord.tickUpper,
  )
  const [[liquidity, last0, last1], [inside0, inside1]] = await Promise.all([
    publicClient.readContract({
      address: V4_STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getPositionInfo',
      args: [POOL_ID, id],
    }),
    publicClient.readContract({
      address: V4_STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getFeeGrowthInside',
      args: [POOL_ID, positionRecord.tickLower, positionRecord.tickUpper],
    }),
  ])
  return {
    liquidity,
    spyWei: (liquidity * wrappingSub(inside0, last0)) / Q128,
    pairWei: (liquidity * wrappingSub(inside1, last1)) / Q128,
  }
}

async function keyCheck() {
  const { account, source } = loadAccountWithMetadata()
  console.log(
    stringify({
      status: 'CREDENTIAL_OK',
      source,
      keychainService: source === 'MACOS_KEYCHAIN' ? KEYCHAIN_SERVICE : null,
      expectedWallet: WALLET,
      derivedWallet: account.address,
      privateKeyPrinted: false,
    }),
  )
}

async function inspect() {
  const chainId = await assertRuntimeIdentity()
  const [blockNumber, block, poolState, wallet, spyToPermit2, pairToPermit2, spyPermit, pairPermit] =
    await Promise.all([
      publicClient.getBlockNumber(),
      publicClient.getBlock(),
      getPoolState(),
      walletSnapshot(),
      publicClient.readContract({
        address: SPY,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [WALLET, PERMIT2],
      }),
      publicClient.readContract({
        address: PAIR,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [WALLET, PERMIT2],
      }),
      publicClient.readContract({
        address: PERMIT2,
        abi: PERMIT2_ABI,
        functionName: 'allowance',
        args: [WALLET, SPY, POSITION_MANAGER],
      }),
      publicClient.readContract({
        address: PERMIT2,
        abi: PERMIT2_ABI,
        functionName: 'allowance',
        args: [WALLET, PAIR, POSITION_MANAGER],
      }),
    ])
  const report = {
    status: 'OBSERVED_READ_ONLY',
    observedAt: new Date().toISOString(),
    chainId,
    blockNumber,
    blockTimestamp: new Date(Number(block.timestamp) * 1_000).toISOString(),
    wallet: WALLET,
    balances: {
      eth: formatEther(wallet.ethWei),
      spy: formatUnits(wallet.spyWei, 18),
      pair: formatUnits(wallet.pairWei, 18),
      positionNfts: wallet.nftBalance.toString(),
    },
    nonce: { latest: wallet.nonceLatest, pending: wallet.noncePending },
    pool: {
      poolId: POOL_ID,
      tick: poolState.tick,
      pairPriceSpy: humanPairPriceFromTick(poolState.tick).toPrecision(12),
      liquidity: poolState.liquidity.toString(),
      lpFee: poolState.lpFee,
      protocolFee: poolState.protocolFee,
    },
    approvals: {
      erc20ToPermit2: { spyWei: spyToPermit2, pairWei: pairToPermit2 },
      permit2ToPositionManager: {
        spy: { amountWei: spyPermit[0], expiration: spyPermit[1], nonce: spyPermit[2] },
        pair: { amountWei: pairPermit[0], expiration: pairPermit[1], nonce: pairPermit[2] },
      },
    },
    localState: readState(),
  }
  console.log(stringify(report))
  return report
}

async function initialPreflight({ requireFunding = false, print = true } = {}) {
  const existing = readState()
  if (existing && !['EXITED', 'ABORTED'].includes(existing.status)) {
    throw new Error(`已有未结束状态 ${existing.status}，禁止重复开仓`)
  }
  const chainId = await publicClient.getChainId()
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}，预期 ${CHAIN_ID}`)
  await assertContracts()
  const account = loadAccount()
  const [blockNumber, wallet, gasPrice, poolState, route] = await Promise.all([
    publicClient.getBlockNumber(),
    walletSnapshot(),
    publicClient.getGasPrice(),
    getPoolState(),
    quoteBestEthToSpy(CANARY_ETH),
  ])
  if (wallet.nonceLatest !== wallet.noncePending) {
    throw new Error(`存在 pending nonce：latest=${wallet.nonceLatest}, pending=${wallet.noncePending}`)
  }
  if (wallet.spyWei !== 0n || wallet.pairWei !== 0n || wallet.nftBalance !== 0n) {
    throw new Error(
      `新钱包并非空白：SPY=${wallet.spyWei}, PAIR=${wallet.pairWei}, NFT=${wallet.nftBalance}，禁止自动归因`,
    )
  }
  const range = buyRangeFromAnchorTick(poolState.tick, { tickSpacing: TICK_SPACING })
  const spyMinimum = bpsFloor(route.amountOut, SWAP_SLIPPAGE_BPS)
  const swapData = buildV3SwapData(route.path, CANARY_ETH, spyMinimum)
  const projectedAdd = await buildLegAdd(account, {
    leg: 'BUY',
    tickLower: range.tickLower,
    tickUpper: range.tickUpper,
    availableWei: spyMinimum,
  })
  const approveData = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [PERMIT2, projectedAdd.amount0Max],
  })
  const [swapBudget, approveBudget] = await Promise.all([
    transactionBudget(V3_ROUTER, swapData, CANARY_ETH),
    transactionBudget(SPY, approveData),
  ])
  const conservativeMintBudget = (CONSERVATIVE_MINT_GAS * gasPrice * 125n) / 100n
  const totalGasBudget = swapBudget.budget + approveBudget.budget + conservativeMintBudget
  const requiredBalance = CANARY_ETH + totalGasBudget + MIN_GAS_RESERVE
  const ready = totalGasBudget <= MAX_INITIAL_GAS_BUDGET && wallet.ethWei >= requiredBalance
  const report = {
    status: ready ? 'READY' : 'NOT_READY',
    evidenceClass: 'SIMULATED_AND_BUDGETED_NOT_BROADCAST',
    observedAt: new Date().toISOString(),
    blockNumber,
    wallet: WALLET,
    derivedSigner: account.address,
    balanceEth: formatEther(wallet.ethWei),
    canaryEth: formatEther(CANARY_ETH),
    requiredBalanceEth: formatEther(requiredBalance),
    minimumRetainedGasEth: formatEther(MIN_GAS_RESERVE),
    topUpNeededEth: formatEther(wallet.ethWei >= requiredBalance ? 0n : requiredBalance - wallet.ethWei),
    nonce: { latest: wallet.nonceLatest, pending: wallet.noncePending },
    pool: {
      tick: poolState.tick,
      pairPriceSpy: range.anchorPrice.toPrecision(12),
      liquidity: poolState.liquidity.toString(),
      feePips: poolState.lpFee,
    },
    buyRange: {
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      pairPriceLowSpy: range.actualLowPrice.toPrecision(12),
      pairPriceHighSpy: range.actualHighPrice.toPrecision(12),
      relativeToAnchor: ['-20%', '-10%'],
      entryComposition: '100% SPY',
      earnsFeesBeforeEntry: false,
    },
    route: {
      fees: route.fees,
      expectedSpy: formatUnits(route.amountOut, 18),
      minimumSpy: formatUnits(spyMinimum, 18),
      slippageBps: Number(SWAP_SLIPPAGE_BPS),
    },
    projectedMint: {
      liquidity: projectedAdd.liquidity,
      spyDesired: formatUnits(projectedAdd.amount0Desired, 18),
      spyMaximum: formatUnits(projectedAdd.amount0Max, 18),
      pairDesired: formatUnits(projectedAdd.amount1Desired, 18),
      calldataBytes: (projectedAdd.data.length - 2) / 2,
    },
    gas: {
      gasPriceWei: gasPrice,
      swapEstimate: swapBudget.estimatedGas,
      swapMaxBudgetEth: formatEther(swapBudget.budget),
      approvalEstimate: approveBudget.estimatedGas,
      approvalMaxBudgetEth: formatEther(approveBudget.budget),
      conservativeMintGas: CONSERVATIVE_MINT_GAS,
      conservativeMintBudgetEth: formatEther(conservativeMintBudget),
      totalInitialGasBudgetEth: formatEther(totalGasBudget),
      hardInitialGasBudgetEth: formatEther(MAX_INITIAL_GAS_BUDGET),
    },
  }
  appendAudit('initial_preflight', report)
  if (print) console.log(stringify(report))
  if (requireFunding && !ready) {
    if (totalGasBudget > MAX_INITIAL_GAS_BUDGET) {
      throw new Error(
        `首次生命周期 Gas 预算 ${formatEther(totalGasBudget)} ETH 超过硬上限 ${formatEther(MAX_INITIAL_GAS_BUDGET)} ETH`,
      )
    }
    throw new Error(
      `安全资金不足：余额 ${formatEther(wallet.ethWei)} ETH，需要 ${formatEther(requiredBalance)} ETH`,
    )
  }
  return {
    report,
    account,
    wallet,
    poolState,
    range,
    route,
    spyMinimum,
    swapData,
    swapBudget,
    approveBudget,
    conservativeMintBudget,
  }
}

function newInitialState(check) {
  return {
    schemaVersion: 1,
    name: 'PAIR 单边区间网格',
    status: 'BUY_FUNDING_PENDING',
    wallet: WALLET,
    chainId: CHAIN_ID,
    pool: { poolId: POOL_ID, ...poolKey },
    policy: {
      canaryEthWei: CANARY_ETH.toString(),
      minimumGasReserveWei: MIN_GAS_RESERVE.toString(),
      maxInitialGasBudgetWei: MAX_INITIAL_GAS_BUDGET.toString(),
      buyRangeMultipliers: [0.8, 0.9],
      sellRangeMultipliers: [1.12, 1.25],
      swapSlippageBps: Number(SWAP_SLIPPAGE_BPS),
      addSlippageBps: 50,
      removeSlippageBps: 200,
      onlyRotateWhenFullyConverted: true,
      oneFundedLegAtATime: true,
      fixedTwoNftsAfterFirstCycle: true,
    },
    positions: {},
    cycleNumber: 1,
    history: [],
    control: {
      expectedNextNonce: check.wallet.nonceLatest,
      signerIsolationRequired: true,
      lastStrategyTransaction: null,
    },
    pending: {
      kind: 'INITIAL_BUY',
      phase: 'FUNDING_PLANNED',
      createdAt: new Date().toISOString(),
      anchorBlock: check.report.blockNumber.toString(),
      anchorTick: check.poolState.tick,
      anchorPairPriceSpy: check.range.anchorPrice.toPrecision(16),
      tickLower: check.range.tickLower,
      tickUpper: check.range.tickUpper,
      canaryEthWei: CANARY_ETH.toString(),
      expectedSpyWei: check.route.amountOut.toString(),
      minimumSpyWei: check.spyMinimum.toString(),
    },
  }
}

async function enterBuy() {
  const existing = readState()
  if (existing?.status === 'BUY_ACTIVE') {
    console.log(
      stringify({ status: 'ALREADY_ACTIVE', leg: 'BUY', tokenId: existing.positions?.buy?.tokenId }),
    )
    return
  }
  if (existing?.status === 'BUY_FUNDED') return resumeBuy()
  if (existing && !['EXITED', 'ABORTED'].includes(existing.status)) {
    throw new Error(`已有未结束状态 ${existing.status}`)
  }
  const check = await initialPreflight({ requireFunding: true, print: true })
  const state = newInitialState(check)
  writeState(state)
  appendAudit('initial_plan_persisted', state.pending)

  try {
    const freshWallet = await walletSnapshot()
    const freshPool = await getPoolState()
    if (freshWallet.nonceLatest !== freshWallet.noncePending) throw new Error('广播前出现 pending nonce')
    if (freshWallet.spyWei !== 0n || freshWallet.pairWei !== 0n || freshWallet.nftBalance !== 0n) {
      throw new Error('广播前钱包资产发生变化')
    }
    assertLegIsSingleSided('BUY', freshPool, check.range.tickLower, check.range.tickUpper)
    const freshRoute = await quoteBestEthToSpy(CANARY_ETH)
    const freshMinimum = bpsFloor(freshRoute.amountOut, SWAP_SLIPPAGE_BPS)
    const freshSwapData = buildV3SwapData(freshRoute.path, CANARY_ETH, freshMinimum)
    const gasPrice = await publicClient.getGasPrice()
    const futureReserve =
      MIN_GAS_RESERVE + ((CONSERVATIVE_APPROVAL_GAS + CONSERVATIVE_MINT_GAS) * gasPrice * 125n) / 100n
    const walletClient = createWalletClient({
      account: check.account,
      chain,
      transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
    })
    const funding = await sendChecked(walletClient, {
      label: `初始买入腿 1/3：${formatEther(CANARY_ETH)} ETH 换 SPY`,
      to: V3_ROUTER,
      data: freshSwapData,
      value: CANARY_ETH,
      minimumBalanceAfter: futureReserve,
    })
    const after = await walletSnapshot()
    if (after.spyWei < freshMinimum || after.pairWei !== 0n || after.nftBalance !== 0n) {
      throw new Error(`ETH→SPY 回读异常：SPY=${after.spyWei}, PAIR=${after.pairWei}, NFT=${after.nftBalance}`)
    }
    state.status = 'BUY_FUNDED'
    state.pending.phase = 'SPY_FUNDED'
    state.pending.fundingTransaction = funding.hash
    state.pending.fundingBlock = funding.receipt.blockNumber.toString()
    state.pending.actualSpyWei = after.spyWei.toString()
    state.pending.fundingGasWei = funding.gasCost.toString()
    state.pending.routeFees = freshRoute.fees
    state.pending.swapMinimumSpyWei = freshMinimum.toString()
    state.control.expectedNextNonce = after.nonceLatest
    state.control.lastStrategyTransaction = funding.hash
    writeState(state)
    appendAudit('initial_spy_funded', {
      hash: funding.hash,
      actualSpyWei: after.spyWei,
      ethRemainingWei: after.ethWei,
    })
    return resumeBuy()
  } catch (error) {
    const latest = readState()
    if (latest) {
      latest.lastErrorAt = new Date().toISOString()
      latest.lastError = errorMessage(error)
      writeState(latest)
    }
    appendAudit('initial_entry_partial_or_failed', {
      message: errorMessage(error),
      state: readState()?.status,
    })
    throw error
  }
}

async function resumeBuy() {
  const state = readState()
  if (!state || state.status !== 'BUY_FUNDED' || state.pending?.kind !== 'INITIAL_BUY') {
    throw new Error('没有可恢复的 BUY_FUNDED 状态')
  }
  await assertRuntimeIdentity()
  await assertNonceClear()
  const account = loadAccount()
  const before = await walletSnapshot()
  if (
    state.control?.expectedNextNonce !== undefined &&
    before.nonceLatest !== state.control.expectedNextNonce
  ) {
    throw new Error(
      `签名器 nonce 隔离破坏：本地预期 ${state.control.expectedNextNonce}，链上已是 ${before.nonceLatest}`,
    )
  }
  if (before.nftBalance !== 0n) {
    throw new Error(`钱包已出现 ${before.nftBalance} 个 LP NFT，可能 mint 回执未归档，禁止重试`)
  }
  if (before.pairWei !== 0n || before.spyWei < BigInt(state.pending.swapMinimumSpyWei)) {
    throw new Error(`恢复前代币余额不符：SPY=${before.spyWei}, PAIR=${before.pairWei}`)
  }
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  const transactions = []
  try {
    const add = await buildLegAdd(account, {
      leg: 'BUY',
      tickLower: state.pending.tickLower,
      tickUpper: state.pending.tickUpper,
      availableWei: before.spyWei,
    })
    const gasPrice = await publicClient.getGasPrice()
    const mintReserve = MIN_GAS_RESERVE + (CONSERVATIVE_MINT_GAS * gasPrice * 125n) / 100n
    transactions.push(
      ...(await setErc20AllowanceExact(
        walletClient,
        SPY,
        add.amount0Max,
        '初始买入腿 2/3：SPY 授权 Permit2',
        mintReserve,
      )),
    )
    const refreshedAdd = await buildLegAdd(account, {
      leg: 'BUY',
      tickLower: state.pending.tickLower,
      tickUpper: state.pending.tickUpper,
      availableWei: before.spyWei,
    })
    const mint = await sendChecked(walletClient, {
      label: '初始买入腿 3/3：mint SPY-only NFT',
      to: POSITION_MANAGER,
      data: refreshedAdd.data,
      minimumBalanceAfter: MIN_GAS_RESERVE,
    })
    transactions.push(mint)
    const tokenId = parseMintTokenId(mint.receipt)
    if (tokenId === null) throw new Error(`mint 成功但未解析到 NFT tokenId：${mint.hash}`)
    const [owner, liquidity, after, finalPool] = await Promise.all([
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'ownerOf',
        args: [tokenId],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [tokenId],
      }),
      walletSnapshot(),
      getPoolState(),
    ])
    if (owner.toLowerCase() !== WALLET.toLowerCase() || liquidity <= 0n) {
      throw new Error(`NFT 链上回读不完整：owner=${owner}, liquidity=${liquidity}`)
    }
    if (liquidity !== refreshedAdd.liquidity) {
      throw new Error(`NFT 流动性与计划不一致：chain=${liquidity}, plan=${refreshedAdd.liquidity}`)
    }
    const underlying = positionAmounts({
      sqrtPriceX96: finalPool.sqrtPriceX96,
      liquidity,
      tickLower: state.pending.tickLower,
      tickUpper: state.pending.tickUpper,
      tickSpacing: TICK_SPACING,
    })
    const underlyingSpy = underlying.amount0
    const underlyingPair = underlying.amount1
    if (finalPool.tick < state.pending.tickLower && underlyingPair !== 0n) {
      throw new Error(`买入腿链上成分不是纯 SPY：PAIR=${underlyingPair}`)
    }
    const spyNet = tokenNetFromReceipt(mint.receipt, SPY)
    const actualSpySpent = spyNet < 0n ? -spyNet : refreshedAdd.amount0Desired
    state.status = 'BUY_ACTIVE'
    state.activeLeg = 'BUY'
    state.positions.buy = {
      tokenId: tokenId.toString(),
      tickLower: state.pending.tickLower,
      tickUpper: state.pending.tickUpper,
      liquidity: liquidity.toString(),
      mintTransaction: mint.hash,
      mintBlock: mint.receipt.blockNumber.toString(),
    }
    state.activeEntry = {
      leg: 'BUY',
      cycleNumber: state.cycleNumber,
      amountSpentWei: actualSpySpent.toString(),
      inputToken: 'SPY',
      enteredAt: new Date().toISOString(),
      transaction: mint.hash,
    }
    state.initialEntry = {
      fundingTransaction: state.pending.fundingTransaction,
      fundingGasWei: state.pending.fundingGasWei,
      mintAndApprovalGasWei: receiptGasTotal(transactions).toString(),
      totalKnownGasWei: (BigInt(state.pending.fundingGasWei) + receiptGasTotal(transactions)).toString(),
      acquiredSpyWei: state.pending.actualSpyWei,
      allocatedSpyWei: actualSpySpent.toString(),
      residualSpyWei: after.spyWei.toString(),
      finalEthWei: after.ethWei.toString(),
    }
    state.control.expectedNextNonce = after.nonceLatest
    state.control.lastStrategyTransaction = mint.hash
    delete state.pending
    delete state.lastError
    delete state.lastErrorAt
    writeState(state)
    appendAudit('buy_leg_active', {
      tokenId,
      liquidity,
      tickLower: state.positions.buy.tickLower,
      tickUpper: state.positions.buy.tickUpper,
      underlyingSpyWei: underlyingSpy,
      underlyingPairWei: underlyingPair,
      walletEthWei: after.ethWei,
      walletSpyWei: after.spyWei,
    })
    console.log(
      stringify({
        status: 'BUY_ACTIVE',
        evidenceClass: 'CANONICAL_RECEIPT_AND_POST_STATE_READBACK',
        tokenId,
        liquidity,
        tickLower: state.positions.buy.tickLower,
        tickUpper: state.positions.buy.tickUpper,
        currentTick: finalPool.tick,
        pairPriceSpy: humanPairPriceFromTick(finalPool.tick).toPrecision(12),
        underlying: { spy: formatUnits(underlyingSpy, 18), pair: formatUnits(underlyingPair, 18) },
        walletResidual: {
          eth: formatEther(after.ethWei),
          spy: formatUnits(after.spyWei, 18),
          pair: formatUnits(after.pairWei, 18),
        },
        transactions: [state.initialEntry.fundingTransaction, ...transactions.map((item) => item.hash)],
        explorer: `${EXPLORER_TX}${mint.hash}`,
      }),
    )
  } catch (error) {
    const latest = readState()
    if (latest?.status === 'BUY_FUNDED') {
      latest.lastErrorAt = new Date().toISOString()
      latest.lastError = errorMessage(error)
      writeState(latest)
    }
    appendAudit('buy_mint_partial_or_failed', { message: errorMessage(error) })
    throw error
  }
}

async function statusData() {
  await assertRuntimeIdentity()
  const local = readState()
  const [blockNumber, poolState, wallet] = await Promise.all([
    publicClient.getBlockNumber(),
    getPoolState(),
    walletSnapshot(),
  ])
  const result = {
    evidenceClass: 'CANONICAL_CHAIN_READBACK_WITH_LOCAL_STATE_COMPARISON',
    observedAt: new Date().toISOString(),
    blockNumber,
    wallet: WALLET,
    localStatus: local?.status || 'NO_LOCAL_STATE',
    activeLeg: local?.activeLeg || null,
    cycleNumber: local?.cycleNumber || null,
    pool: {
      tick: poolState.tick,
      pairPriceSpy: humanPairPriceFromTick(poolState.tick).toPrecision(12),
      liquidity: poolState.liquidity.toString(),
    },
    walletBalances: {
      eth: formatEther(wallet.ethWei),
      spy: formatUnits(wallet.spyWei, 18),
      pair: formatUnits(wallet.pairWei, 18),
      nfts: wallet.nftBalance.toString(),
    },
    nonce: { latest: wallet.nonceLatest, pending: wallet.noncePending },
    signerControl: {
      expectedNextNonce: local?.control?.expectedNextNonce ?? null,
      matchesExpected:
        local?.control?.expectedNextNonce === undefined
          ? null
          : wallet.nonceLatest === local.control.expectedNextNonce,
    },
    position: null,
    local,
  }
  if (local?.activeLeg && ['BUY_ACTIVE', 'SELL_ACTIVE'].includes(local.status)) {
    const key = local.activeLeg.toLowerCase()
    const record = local.positions?.[key]
    if (!record?.tokenId) throw new Error(`本地 ${local.activeLeg} 头寸缺少 tokenId`)
    const tokenId = BigInt(record.tokenId)
    const [owner, liquidity, fees] = await Promise.all([
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'ownerOf',
        args: [tokenId],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [tokenId],
      }),
      getAccruedFees(record),
    ])
    const underlying = positionAmounts({
      sqrtPriceX96: poolState.sqrtPriceX96,
      liquidity,
      tickLower: record.tickLower,
      tickUpper: record.tickUpper,
      tickSpacing: TICK_SPACING,
    })
    const amount0 = underlying.amount0
    const amount1 = underlying.amount1
    const boundaryComplete = legCompletion(
      local.activeLeg,
      poolState.tick,
      record.tickLower,
      record.tickUpper,
    )
    const compositionComplete = local.activeLeg === 'BUY' ? amount0 === 0n : amount1 === 0n
    result.position = {
      tokenId,
      owner,
      ownerMatches: owner.toLowerCase() === WALLET.toLowerCase(),
      tickLower: record.tickLower,
      tickUpper: record.tickUpper,
      liquidity,
      localLiquidity: record.liquidity,
      liquidityMatches: liquidity.toString() === record.liquidity,
      inRange: poolState.tick >= record.tickLower && poolState.tick < record.tickUpper,
      underlying: { spy: formatUnits(amount0, 18), pair: formatUnits(amount1, 18) },
      accruedFeesEstimate: { spy: formatUnits(fees.spyWei, 18), pair: formatUnits(fees.pairWei, 18) },
      boundaryComplete,
      compositionComplete,
      fullyConverted: boundaryComplete && compositionComplete && liquidity > 0n,
    }
  }
  return { result, local, poolState, wallet }
}

function addressesEqual(left, right) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase())
}

async function canonicalAuditedTransactions(expectedNonce, latestNonce) {
  if (!Number.isInteger(expectedNonce)) throw new Error('本地状态缺少 expectedNextNonce，不能自动对账')
  if (latestNonce < expectedNonce) {
    throw new Error(`链上 nonce ${latestNonce} 小于本地预期 ${expectedNonce}`)
  }
  if (latestNonce === expectedNonce) return []

  const broadcasts = stateStore
    .readAudit()
    .filter(
      (item) => item.event === 'broadcast' && typeof item.hash === 'string' && Number.isInteger(item.nonce),
    )
  const transactions = []
  for (let nonce = expectedNonce; nonce < latestNonce; nonce += 1) {
    const candidates = broadcasts.filter((item) => item.nonce === nonce)
    const hashes = [...new Set(candidates.map((item) => item.hash.toLowerCase()))]
    if (hashes.length !== 1) {
      throw new Error(`nonce ${nonce} 没有唯一的本地广播证据，禁止自动归档`)
    }
    const audit = candidates.find((item) => item.hash.toLowerCase() === hashes[0])
    const [transaction, receipt] = await Promise.all([
      publicClient.getTransaction({ hash: audit.hash }),
      publicClient.getTransactionReceipt({ hash: audit.hash }),
    ])
    if (
      transaction.nonce !== nonce ||
      !addressesEqual(transaction.from, WALLET) ||
      receipt.status !== 'success' ||
      receipt.transactionHash.toLowerCase() !== audit.hash.toLowerCase()
    ) {
      throw new Error(`nonce ${nonce} 的链上交易与本地广播证据不匹配`)
    }
    transactions.push({
      hash: audit.hash,
      nonce,
      label: audit.label,
      to: transaction.to,
      value: transaction.value,
      receipt,
      blockNumber: receipt.blockNumber.toString(),
      gasWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
      reconciledAt: new Date().toISOString(),
    })
  }
  return transactions
}

function requireLastTransaction(transactions, expectedTo, labelFragment) {
  const transaction = transactions.at(-1)
  if (
    !transaction ||
    !addressesEqual(transaction.to, expectedTo) ||
    !transaction.label?.includes(labelFragment)
  ) {
    throw new Error(`缺少 ${labelFragment} 的唯一 canonical 交易证据`)
  }
  return transaction
}

function recoveryPositionComposition(leg, poolState, record, liquidity) {
  const position = {
    sqrtPriceX96: poolState.sqrtPriceX96,
    liquidity,
    tickLower: record.tickLower,
    tickUpper: record.tickUpper,
    tickSpacing: TICK_SPACING,
  }
  const amounts = positionAmounts(position)
  const spyWei = amounts.amount0
  const pairWei = amounts.amount1
  const compositionValid =
    leg === 'BUY'
      ? poolState.tick >= record.tickLower || pairWei === 0n
      : poolState.tick < record.tickUpper || spyWei === 0n
  return { position, spyWei, pairWei, compositionValid }
}

function writeReconciled(state, event, details) {
  writeState(state)
  appendAudit(event, details)
  console.log(
    stringify({
      status: 'RECONCILED',
      localStatus: state.status,
      event,
      evidenceClass: 'CANONICAL_RECEIPT_AND_POST_STATE_READBACK',
      haltStillRequiresExplicitClear: Boolean(stateStore.readHalt()),
      ...details,
    }),
  )
}

async function reconcile() {
  await assertRuntimeIdentity()
  const state = readState()
  if (!state) throw new Error('没有本地策略状态可对账')
  const wallet = await walletSnapshot()
  if (wallet.nonceLatest !== wallet.noncePending) {
    throw new Error(`对账时存在 pending nonce：latest=${wallet.nonceLatest}, pending=${wallet.noncePending}`)
  }
  const expected = state.control?.expectedNextNonce
  const transactions = await canonicalAuditedTransactions(expected, wallet.nonceLatest)
  const poolState = await getPoolState()

  if (state.status === 'BUY_FUNDING_PENDING') {
    if (!transactions.length && wallet.spyWei === 0n && wallet.pairWei === 0n && wallet.nftBalance === 0n) {
      if (state.pending?.phase !== 'FUNDING_PLANNED') throw new Error('初始入金阶段与钱包状态不一致')
      console.log(
        stringify({ status: 'CONSISTENT', localStatus: state.status, action: 'SAFE_TO_RETRY_ENTER_BUY' }),
      )
      return
    }
    const transaction = requireLastTransaction(transactions, V3_ROUTER, 'ETH 换 SPY')
    if (transaction.value !== CANARY_ETH) throw new Error('初始换币交易的 ETH 数量与原计划不一致')
    const recovered = recoverInitialFunding({ state, wallet, transaction })
    writeReconciled(recovered, 'initial_funding_recovered', { transaction: transaction.hash })
    return
  }

  if (state.status === 'BUY_FUNDED') {
    if (wallet.nftBalance === 0n) {
      if (transactions.some((item) => !addressesEqual(item.to, SPY))) {
        throw new Error('BUY_FUNDED nonce 差异中存在非 SPY 授权交易')
      }
      if (transactions.length) {
        state.control.expectedNextNonce = wallet.nonceLatest
        state.reconciledAt = new Date().toISOString()
        writeReconciled(state, 'initial_approvals_recovered', {
          transactions: transactions.map((item) => item.hash),
        })
      } else {
        console.log(
          stringify({ status: 'CONSISTENT', localStatus: state.status, action: 'SAFE_TO_RESUME_BUY' }),
        )
      }
      return
    }
    if (wallet.nftBalance !== 1n) throw new Error(`初始 mint 恢复发现 ${wallet.nftBalance} 个 NFT`)
    const transaction = requireLastTransaction(transactions, POSITION_MANAGER, 'mint SPY-only NFT')
    const tokenId = parseMintTokenId(transaction.receipt)
    if (tokenId === null) throw new Error('初始 mint 回执没有目标 NFT Transfer')
    const [owner, liquidity] = await Promise.all([
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'ownerOf',
        args: [tokenId],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [tokenId],
      }),
    ])
    const record = { tickLower: state.pending.tickLower, tickUpper: state.pending.tickUpper }
    const composition = recoveryPositionComposition('BUY', poolState, record, liquidity)
    const spyNet = tokenNetFromReceipt(transaction.receipt, SPY)
    if (spyNet >= 0n) throw new Error('初始 mint 回执没有可核验的 SPY 支出')
    const recovered = recoverInitialMint({
      state,
      wallet,
      transaction,
      knownMintAndApprovalGasWei: receiptGasTotal(
        transactions.map((item) => ({ gasCost: BigInt(item.gasWei) })),
      ),
      position: {
        tokenId,
        liquidity,
        actualSpentWei: -spyNet,
        ownerMatches: addressesEqual(owner, WALLET),
        compositionValid: composition.compositionValid,
      },
    })
    writeReconciled(recovered, 'initial_mint_recovered', { transaction: transaction.hash, tokenId })
    return
  }

  if (['BUY_ACTIVE', 'SELL_ACTIVE'].includes(state.status)) {
    const source = state.positions?.[state.activeLeg.toLowerCase()]
    if (!source?.tokenId) throw new Error('活动状态缺少源 NFT')
    const [owner, liquidity] = await Promise.all([
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'ownerOf',
        args: [BigInt(source.tokenId)],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(source.tokenId)],
      }),
    ])
    if (!addressesEqual(owner, WALLET)) throw new Error('活动 NFT owner 与策略钱包不匹配')

    if (state.pendingRotation?.phase === 'REMOVAL_PLANNED') {
      if (liquidity > 0n) {
        if (transactions.length) throw new Error('撤池意图仍有流动性，但 nonce 已发生变化')
        if (
          wallet.spyWei.toString() !== state.pendingRotation.baselineWalletSpyWei ||
          wallet.pairWei.toString() !== state.pendingRotation.baselineWalletPairWei
        )
          throw new Error('撤池未发生但钱包余额已变化')
        const id = state.pendingRotation.id
        delete state.pendingRotation
        delete state.lastError
        delete state.lastErrorAt
        writeReconciled(state, 'rotation_intent_reset', { id, action: 'SAFE_TO_RETRY_ROTATE' })
        return
      }
      const transaction = requireLastTransaction(transactions, POSITION_MANAGER, '撤出已完全成交')
      const target = rotationTargetFromWallet(state, poolState, wallet)
      const recovered = recoverRotationRemoval({ state, wallet, transaction, target })
      writeReconciled(recovered, 'rotation_removal_recovered', { transaction: transaction.hash })
      return
    }

    if (state.pendingExit?.phase === 'REMOVAL_PLANNED') {
      if (liquidity > 0n) {
        if (transactions.length) throw new Error('退出意图仍有流动性，但 nonce 已发生变化')
        const id = state.pendingExit.id
        delete state.pendingExit
        delete state.lastError
        delete state.lastErrorAt
        writeReconciled(state, 'exit_intent_reset', { id, action: 'SAFE_TO_RETRY_EXIT' })
        return
      }
      const transaction = requireLastTransaction(transactions, POSITION_MANAGER, '退出：撤出')
      const recovered = recoverExit({ state, wallet, transaction })
      writeReconciled(recovered, 'exit_recovered', { transaction: transaction.hash })
      return
    }

    if (liquidity.toString() !== source.liquidity) throw new Error('活动 NFT 流动性与本地账本不匹配')
    if (transactions.length) throw new Error('活动状态存在没有交易意图覆盖的 nonce 变化')
    console.log(
      stringify({ status: 'CONSISTENT', localStatus: state.status, tokenId: source.tokenId, liquidity }),
    )
    return
  }

  if (state.status === 'ROTATION_FUNDED' && state.pendingRotation?.phase === 'TARGET_FUNDED') {
    const pending = state.pendingRotation
    const source = state.positions[pending.fromLeg.toLowerCase()]
    const sourceLiquidity = await publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [BigInt(source.tokenId)],
    })
    if (sourceLiquidity !== 0n) throw new Error('ROTATION_FUNDED 的源 NFT 仍有流动性')

    const targetKey = pending.toLeg.toLowerCase()
    const existingTarget = state.positions[targetKey] || null
    let targetTokenId = existingTarget?.tokenId ? BigInt(existingTarget.tokenId) : null
    const targetTransaction = transactions.filter((item) => addressesEqual(item.to, POSITION_MANAGER)).at(-1)
    if (!targetTokenId && targetTransaction) targetTokenId = parseMintTokenId(targetTransaction.receipt)

    let targetLiquidity = 0n
    let targetOwner = null
    if (targetTokenId !== null) {
      try {
        ;[targetOwner, targetLiquidity] = await Promise.all([
          publicClient.readContract({
            address: POSITION_MANAGER,
            abi: POSITION_NFT_ABI,
            functionName: 'ownerOf',
            args: [targetTokenId],
          }),
          publicClient.readContract({
            address: POSITION_MANAGER,
            abi: POSITION_NFT_ABI,
            functionName: 'getPositionLiquidity',
            args: [targetTokenId],
          }),
        ])
      } catch {
        targetLiquidity = 0n
      }
    }

    if (targetLiquidity === 0n) {
      const approvalToken = pending.toLeg === 'BUY' ? SPY : PAIR
      if (transactions.some((item) => !addressesEqual(item.to, approvalToken))) {
        throw new Error('目标腿没有流动性，但 nonce 差异中存在非授权交易')
      }
      if (transactions.length) {
        state.control.expectedNextNonce = wallet.nonceLatest
        state.reconciledAt = new Date().toISOString()
        writeReconciled(state, 'rotation_approvals_recovered', {
          transactions: transactions.map((item) => item.hash),
        })
      } else {
        console.log(
          stringify({ status: 'CONSISTENT', localStatus: state.status, action: 'SAFE_TO_RESUME_ROTATE' }),
        )
      }
      return
    }

    if (!targetTransaction) throw new Error('目标腿已有流动性，但没有对应的 canonical mint 交易')
    if (
      existingTarget &&
      (existingTarget.tickLower !== pending.targetTickLower ||
        existingTarget.tickUpper !== pending.targetTickUpper)
    )
      throw new Error('重用目标 NFT 的区间与换腿计划不一致')
    const record = { tickLower: pending.targetTickLower, tickUpper: pending.targetTickUpper }
    const composition = recoveryPositionComposition(pending.toLeg, poolState, record, targetLiquidity)
    const token = pending.toLeg === 'BUY' ? SPY : PAIR
    const tokenNet = tokenNetFromReceipt(targetTransaction.receipt, token)
    if (tokenNet >= 0n) throw new Error('目标腿 mint 回执没有可核验的输入代币支出')
    const recovered = recoverRotationMint({
      state,
      wallet,
      transaction: targetTransaction,
      knownTargetGasWei: receiptGasTotal(transactions.map((item) => ({ gasCost: BigInt(item.gasWei) }))),
      position: {
        tokenId: targetTokenId,
        liquidity: targetLiquidity,
        actualSpentWei: -tokenNet,
        ownerMatches: addressesEqual(targetOwner, WALLET),
        liquidityMatches: true,
        compositionValid: composition.compositionValid,
      },
    })
    writeReconciled(recovered, 'rotation_mint_recovered', {
      transaction: targetTransaction.hash,
      tokenId: targetTokenId,
    })
    return
  }

  if (['EXITED', 'ABORTED'].includes(state.status) && !transactions.length) {
    console.log(stringify({ status: 'CONSISTENT', localStatus: state.status }))
    return
  }
  throw new Error(`状态 ${state.status} 没有可证明安全的自动恢复路径`)
}

async function printStatus() {
  const { result } = await statusData()
  console.log(stringify(result))
}

async function keeperOnce() {
  const { result, local, wallet } = await statusData()
  const decision = decideKeeperAction({ result, local, wallet })
  if (decision.action === 'NO_ACTION') {
    console.log(
      stringify({
        status: 'NO_ACTION',
        reason: decision.reason,
        leg: local?.activeLeg || null,
        currentTick: result.pool?.tick,
        tickLower: result.position?.tickLower,
        tickUpper: result.position?.tickUpper,
        inRange: result.position?.inRange,
      }),
    )
    return
  }
  return rotate()
}

function decimalRatio(numeratorWei, denominatorWei) {
  if (numeratorWei <= 0n || denominatorWei <= 0n) throw new Error('价格比率分子和分母必须为正')
  return Number(formatUnits(numeratorWei, 18)) / Number(formatUnits(denominatorWei, 18))
}

function rotationTargetFromWallet(local, afterPool, afterWallet) {
  const baselineSpy = BigInt(local.pendingRotation.baselineWalletSpyWei)
  const baselinePair = BigInt(local.pendingRotation.baselineWalletPairWei)
  const currentSpy = BigInt(afterWallet.spyWei)
  const currentPair = BigInt(afterWallet.pairWei)
  const spyReceived = currentSpy - baselineSpy
  const pairReceived = currentPair - baselinePair

  if (local.activeLeg === 'BUY') {
    const spentSpy = BigInt(local.activeEntry.amountSpentWei)
    const returnedSpy = spyReceived > 0n ? spyReceived : 0n
    const receivedPair = pairReceived > 0n ? pairReceived : 0n
    const netSpyCost = spentSpy > returnedSpy ? spentSpy - returnedSpy : 1n
    if (receivedPair <= 0n) throw new Error('买入腿撤出后没有收到 PAIR')
    const basis = decimalRatio(netSpyCost, receivedPair)
    const range = sellRangeFromBasis(basis, afterPool.tick, { tickSpacing: TICK_SPACING })
    return {
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      availableWei: receivedPair,
      accounting: {
        spentSpyWei: spentSpy.toString(),
        returnedSpyWei: returnedSpy.toString(),
        receivedPairWei: receivedPair.toString(),
        netSpyCostWei: netSpyCost.toString(),
        effectiveBuyPriceSpyPerPair: basis.toPrecision(16),
      },
    }
  }

  const spentPair = BigInt(local.activeEntry.amountSpentWei)
  const returnedPair = pairReceived > 0n ? pairReceived : 0n
  const receivedSpy = spyReceived > 0n ? spyReceived : 0n
  const netPairSold = spentPair > returnedPair ? spentPair - returnedPair : 1n
  if (receivedSpy <= 0n) throw new Error('卖出腿撤出后没有收到 SPY')
  const salePrice = decimalRatio(receivedSpy, netPairSold)
  const buyRecord = local.positions.buy
  if (!buyRecord?.tokenId) throw new Error('缺少可重用的买入腿 NFT')
  assertLegIsSingleSided('BUY', afterPool, buyRecord.tickLower, buyRecord.tickUpper)
  return {
    tickLower: buyRecord.tickLower,
    tickUpper: buyRecord.tickUpper,
    availableWei: receivedSpy,
    accounting: {
      spentPairWei: spentPair.toString(),
      returnedPairWei: returnedPair.toString(),
      receivedSpyWei: receivedSpy.toString(),
      netPairSoldWei: netPairSold.toString(),
      effectiveSellPriceSpyPerPair: salePrice.toPrecision(16),
    },
  }
}

async function rotate() {
  const { result, local, poolState, wallet } = await statusData()
  if (!local || !['BUY_ACTIVE', 'SELL_ACTIVE'].includes(local.status)) {
    if (local?.status === 'ROTATION_FUNDED') return resumeRotate()
    throw new Error(`当前状态 ${local?.status || 'NONE'} 不能换腿`)
  }
  if (local.pendingRotation) throw new Error(`存在未结算换腿 ${local.pendingRotation.id}`)
  if (!result.position?.fullyConverted) {
    throw new Error(`当前 ${local.activeLeg} 腿尚未完全转换，禁止撤池：tick=${poolState.tick}`)
  }
  if (!result.position.ownerMatches || !result.position.liquidityMatches) {
    throw new Error('NFT owner 或流动性与本地账本不匹配')
  }
  if (wallet.nonceLatest !== wallet.noncePending) throw new Error('存在 pending nonce')
  if (
    local.control?.expectedNextNonce !== undefined &&
    wallet.nonceLatest !== local.control.expectedNextNonce
  ) {
    throw new Error(
      `签名器 nonce 隔离破坏：本地预期 ${local.control.expectedNextNonce}，链上 ${wallet.nonceLatest}`,
    )
  }
  const sourceKey = local.activeLeg.toLowerCase()
  const source = local.positions[sourceKey]
  const sourceLiquidity = BigInt(source.liquidity)
  const removal = buildFullRemove(source, sourceLiquidity, poolState)
  const removalBudget = await transactionBudget(POSITION_MANAGER, removal.data)
  const gasPrice = await publicClient.getGasPrice()
  const futureMintBudget = (CONSERVATIVE_ROTATION_MINT_GAS * gasPrice * 125n) / 100n
  const requiredEth = removalBudget.budget + futureMintBudget + MIN_GAS_RESERVE
  if (wallet.ethWei < requiredEth) {
    throw new Error(
      `换腿 Gas 储备不足：余额 ${formatEther(wallet.ethWei)} ETH，需要 ${formatEther(requiredEth)} ETH`,
    )
  }
  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  const id = `rotate-${Date.now()}`
  local.pendingRotation = {
    id,
    phase: 'REMOVAL_PLANNED',
    fromLeg: local.activeLeg,
    toLeg: local.activeLeg === 'BUY' ? 'SELL' : 'BUY',
    sourceTokenId: source.tokenId,
    sourceLiquidity: source.liquidity,
    plannedAt: new Date().toISOString(),
    triggerTick: poolState.tick,
    baselineWalletSpyWei: wallet.spyWei.toString(),
    baselineWalletPairWei: wallet.pairWei.toString(),
  }
  writeState(local)
  appendAudit('rotation_planned', local.pendingRotation)

  try {
    const removed = await sendChecked(walletClient, {
      label: `换腿 1/3：撤出已完全成交的 ${local.activeLeg} 腿`,
      to: POSITION_MANAGER,
      data: removal.data,
      minimumBalanceAfter: MIN_GAS_RESERVE + futureMintBudget,
    })
    const [after, sourceLiquidityAfter, afterPool] = await Promise.all([
      walletSnapshot(),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(source.tokenId)],
      }),
      getPoolState(),
    ])
    if (sourceLiquidityAfter !== 0n) throw new Error(`撤出回读失败：剩余流动性 ${sourceLiquidityAfter}`)
    const target = rotationTargetFromWallet(local, afterPool, after)
    local.status = 'ROTATION_FUNDED'
    local.positions[sourceKey].liquidity = '0'
    local.pendingRotation = {
      ...local.pendingRotation,
      phase: 'TARGET_FUNDED',
      removalTransaction: removed.hash,
      removalBlock: removed.receipt.blockNumber.toString(),
      removalGasWei: removed.gasCost.toString(),
      targetTickLower: target.tickLower,
      targetTickUpper: target.tickUpper,
      availableWei: target.availableWei.toString(),
      accounting: target.accounting,
      walletAfterRemoval: {
        ethWei: after.ethWei.toString(),
        spyWei: after.spyWei.toString(),
        pairWei: after.pairWei.toString(),
      },
    }
    local.control = {
      ...(local.control || {}),
      expectedNextNonce: after.nonceLatest,
      signerIsolationRequired: true,
      lastStrategyTransaction: removed.hash,
    }
    writeState(local)
    appendAudit('rotation_source_removed', local.pendingRotation)
    return resumeRotate()
  } catch (error) {
    const latest = readState()
    if (latest?.pendingRotation?.id === id) {
      latest.lastErrorAt = new Date().toISOString()
      latest.lastError = errorMessage(error)
      writeState(latest)
    }
    appendAudit('rotation_partial_or_failed', { id, message: errorMessage(error) })
    throw error
  }
}

async function resumeRotate() {
  const state = readState()
  if (!state || state.status !== 'ROTATION_FUNDED' || state.pendingRotation?.phase !== 'TARGET_FUNDED') {
    throw new Error('没有可恢复的 ROTATION_FUNDED 状态')
  }
  await assertRuntimeIdentity()
  await assertNonceClear()
  const account = loadAccount()
  const pending = state.pendingRotation
  const targetLeg = pending.toLeg
  const targetKey = targetLeg.toLowerCase()
  const sourceKey = pending.fromLeg.toLowerCase()
  const snapshot = await walletSnapshot()
  if (
    state.control?.expectedNextNonce !== undefined &&
    snapshot.nonceLatest !== state.control.expectedNextNonce
  ) {
    throw new Error(
      `签名器 nonce 隔离破坏：本地预期 ${state.control.expectedNextNonce}，链上 ${snapshot.nonceLatest}`,
    )
  }
  const availableWei = BigInt(pending.availableWei)
  const balanceForLeg = targetLeg === 'BUY' ? snapshot.spyWei : snapshot.pairWei
  if (balanceForLeg < availableWei) {
    throw new Error(
      `${targetLeg} 腿钱包余额低于已归档可用金额：balance=${balanceForLeg}, available=${availableWei}`,
    )
  }
  const sourceLiquidity = await publicClient.readContract({
    address: POSITION_MANAGER,
    abi: POSITION_NFT_ABI,
    functionName: 'getPositionLiquidity',
    args: [BigInt(state.positions[sourceKey].tokenId)],
  })
  if (sourceLiquidity !== 0n) throw new Error('源 NFT 仍有流动性，禁止建反向腿')
  const existingTarget = state.positions[targetKey] || null
  const knownNftCount = BigInt(Object.values(state.positions).filter((item) => item?.tokenId).length)
  if (!existingTarget?.tokenId && snapshot.nftBalance !== knownNftCount) {
    throw new Error(
      `链上 NFT 数量 ${snapshot.nftBalance} 与本地已知数量 ${knownNftCount} 不符，可能存在回执未归档的 mint，禁止重试`,
    )
  }
  if (existingTarget?.tokenId) {
    const [owner, liquidity] = await Promise.all([
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'ownerOf',
        args: [BigInt(existingTarget.tokenId)],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(existingTarget.tokenId)],
      }),
    ])
    if (owner.toLowerCase() !== WALLET.toLowerCase() || liquidity !== 0n) {
      throw new Error(`目标 NFT 不可重用：owner=${owner}, liquidity=${liquidity}`)
    }
    if (
      existingTarget.tickLower !== pending.targetTickLower ||
      existingTarget.tickUpper !== pending.targetTickUpper
    ) {
      throw new Error('目标 NFT 固定区间与本次计划不一致')
    }
  }
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  const transactions = []
  try {
    const add = await buildLegAdd(account, {
      leg: targetLeg,
      tickLower: pending.targetTickLower,
      tickUpper: pending.targetTickUpper,
      availableWei,
      tokenId: existingTarget?.tokenId || null,
    })
    const token = targetLeg === 'BUY' ? SPY : PAIR
    const required = targetLeg === 'BUY' ? add.amount0Max : add.amount1Max
    const gasPrice = await publicClient.getGasPrice()
    const mintReserve = MIN_GAS_RESERVE + (CONSERVATIVE_ROTATION_MINT_GAS * gasPrice * 125n) / 100n
    transactions.push(
      ...(await setErc20AllowanceExact(
        walletClient,
        token,
        required,
        `换腿 2/3：${targetLeg} 输入币授权 Permit2`,
        mintReserve,
      )),
    )
    const refreshed = await buildLegAdd(account, {
      leg: targetLeg,
      tickLower: pending.targetTickLower,
      tickUpper: pending.targetTickUpper,
      availableWei,
      tokenId: existingTarget?.tokenId || null,
    })
    const added = await sendChecked(walletClient, {
      label: `换腿 3/3：${existingTarget ? '重用' : '新建'} ${targetLeg} 单边 NFT`,
      to: POSITION_MANAGER,
      data: refreshed.data,
      minimumBalanceAfter: MIN_GAS_RESERVE,
    })
    transactions.push(added)
    const tokenId = existingTarget?.tokenId || parseMintTokenId(added.receipt)?.toString()
    if (!tokenId) throw new Error(`换腿 mint 成功但未解析 tokenId：${added.hash}`)
    const [owner, liquidity, after, finalPool] = await Promise.all([
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'ownerOf',
        args: [BigInt(tokenId)],
      }),
      publicClient.readContract({
        address: POSITION_MANAGER,
        abi: POSITION_NFT_ABI,
        functionName: 'getPositionLiquidity',
        args: [BigInt(tokenId)],
      }),
      walletSnapshot(),
      getPoolState(),
    ])
    if (owner.toLowerCase() !== WALLET.toLowerCase() || liquidity !== refreshed.liquidity) {
      throw new Error(
        `换腿 NFT 回读不匹配：owner=${owner}, chainLiquidity=${liquidity}, plan=${refreshed.liquidity}`,
      )
    }
    const underlying = positionAmounts({
      sqrtPriceX96: finalPool.sqrtPriceX96,
      liquidity,
      tickLower: pending.targetTickLower,
      tickUpper: pending.targetTickUpper,
      tickSpacing: TICK_SPACING,
    })
    const underlyingSpy = underlying.amount0
    const underlyingPair = underlying.amount1
    if (targetLeg === 'BUY' && underlyingPair !== 0n) throw new Error('新买入腿不是纯 SPY')
    if (targetLeg === 'SELL' && underlyingSpy !== 0n) throw new Error('新卖出腿不是纯 PAIR')
    const tokenNet = tokenNetFromReceipt(added.receipt, token)
    const actualSpent =
      tokenNet < 0n ? -tokenNet : targetLeg === 'BUY' ? refreshed.amount0Desired : refreshed.amount1Desired
    const completedRotation = {
      ...pending,
      phase: 'COMPLETE',
      targetTokenId: String(tokenId),
      targetLiquidity: liquidity.toString(),
      targetTransaction: added.hash,
      targetBlock: added.receipt.blockNumber.toString(),
      targetAmountSpentWei: actualSpent.toString(),
      targetGasWei: receiptGasTotal(transactions).toString(),
      completedAt: new Date().toISOString(),
    }
    state.positions[targetKey] = {
      ...(existingTarget || {}),
      tokenId: String(tokenId),
      tickLower: pending.targetTickLower,
      tickUpper: pending.targetTickUpper,
      liquidity: liquidity.toString(),
      lastAddTransaction: added.hash,
      lastAddBlock: added.receipt.blockNumber.toString(),
    }
    state.status = `${targetLeg}_ACTIVE`
    state.activeLeg = targetLeg
    if (targetLeg === 'BUY') state.cycleNumber += 1
    state.activeEntry = {
      leg: targetLeg,
      cycleNumber: state.cycleNumber,
      amountSpentWei: actualSpent.toString(),
      inputToken: targetLeg === 'BUY' ? 'SPY' : 'PAIR',
      enteredAt: completedRotation.completedAt,
      transaction: added.hash,
    }
    state.control = {
      ...(state.control || {}),
      expectedNextNonce: after.nonceLatest,
      signerIsolationRequired: true,
      lastStrategyTransaction: added.hash,
    }
    state.history.push(completedRotation)
    delete state.pendingRotation
    delete state.lastError
    delete state.lastErrorAt
    writeState(state)
    appendAudit('rotation_complete', completedRotation)
    console.log(
      stringify({
        status: state.status,
        evidenceClass: 'CANONICAL_RECEIPT_AND_POST_STATE_READBACK',
        cycleNumber: state.cycleNumber,
        tokenId,
        reusedNft: Boolean(existingTarget),
        liquidity,
        tickLower: state.positions[targetKey].tickLower,
        tickUpper: state.positions[targetKey].tickUpper,
        currentTick: finalPool.tick,
        underlying: { spy: formatUnits(underlyingSpy, 18), pair: formatUnits(underlyingPair, 18) },
        walletResidual: {
          eth: formatEther(after.ethWei),
          spy: formatUnits(after.spyWei, 18),
          pair: formatUnits(after.pairWei, 18),
        },
        accounting: pending.accounting,
        transactions: [pending.removalTransaction, ...transactions.map((item) => item.hash)],
      }),
    )
  } catch (error) {
    const latest = readState()
    if (latest?.status === 'ROTATION_FUNDED') {
      latest.lastErrorAt = new Date().toISOString()
      latest.lastError = errorMessage(error)
      writeState(latest)
    }
    appendAudit('rotation_target_partial_or_failed', { id: pending.id, message: errorMessage(error) })
    throw error
  }
}

async function exitPosition() {
  await assertRuntimeIdentity()
  const state = readState()
  if (!state) throw new Error('没有本地策略状态')
  if (state.status === 'ROTATION_FUNDED') {
    state.status = 'EXITED'
    state.exitedAt = new Date().toISOString()
    state.exitReason = 'user_exit_while_assets_in_wallet'
    state.history.push({ ...state.pendingRotation, phase: 'EXITED_WITH_ASSETS_IN_WALLET' })
    delete state.pendingRotation
    writeState(state)
    appendAudit('exit_without_liquidity', { status: state.status })
    console.log(
      stringify({ status: 'EXITED', transaction: null, note: '流动性已在之前换腿步骤撤出，代币保留在钱包' }),
    )
    return
  }
  if (!['BUY_ACTIVE', 'SELL_ACTIVE'].includes(state.status)) {
    throw new Error(`当前状态 ${state.status} 没有可撤出的活动流动性`)
  }
  const nonceControl = await walletSnapshot()
  if (
    state.control?.expectedNextNonce !== undefined &&
    nonceControl.nonceLatest !== state.control.expectedNextNonce
  ) {
    throw new Error(
      `签名器 nonce 隔离破坏：本地预期 ${state.control.expectedNextNonce}，链上 ${nonceControl.nonceLatest}`,
    )
  }
  const key = state.activeLeg.toLowerCase()
  const record = state.positions[key]
  const tokenId = BigInt(record.tokenId)
  const [owner, liquidity, poolState] = await Promise.all([
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [tokenId],
    }),
    getPoolState(),
  ])
  if (owner.toLowerCase() !== WALLET.toLowerCase() || liquidity <= 0n) {
    throw new Error(`活动 NFT 回读不符：owner=${owner}, liquidity=${liquidity}`)
  }
  const removal = buildFullRemove(record, liquidity, poolState)
  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  const before = await walletSnapshot()
  state.pendingExit = {
    id: `exit-${Date.now()}`,
    phase: 'REMOVAL_PLANNED',
    activeLeg: state.activeLeg,
    tokenId: record.tokenId,
    liquidity: liquidity.toString(),
    baselineWalletSpyWei: before.spyWei.toString(),
    baselineWalletPairWei: before.pairWei.toString(),
    plannedAt: new Date().toISOString(),
  }
  writeState(state)
  appendAudit('exit_planned', state.pendingExit)
  const removed = await sendChecked(walletClient, {
    label: `退出：撤出 ${state.activeLeg} 腿全部流动性`,
    to: POSITION_MANAGER,
    data: removal.data,
    minimumBalanceAfter: MIN_GAS_RESERVE,
  })
  const [after, liquidityAfter] = await Promise.all([
    walletSnapshot(),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_NFT_ABI,
      functionName: 'getPositionLiquidity',
      args: [tokenId],
    }),
  ])
  if (liquidityAfter !== 0n) throw new Error(`退出后流动性仍为 ${liquidityAfter}`)
  record.liquidity = '0'
  state.status = 'EXITED'
  state.exitedAt = new Date().toISOString()
  state.exitReason = 'user_exit'
  state.control = {
    ...(state.control || {}),
    expectedNextNonce: after.nonceLatest,
    signerIsolationRequired: true,
    lastStrategyTransaction: removed.hash,
  }
  state.history.push({
    kind: 'EXIT',
    fromLeg: state.activeLeg,
    tokenId: record.tokenId,
    transaction: removed.hash,
    blockNumber: removed.receipt.blockNumber.toString(),
    gasWei: removed.gasCost.toString(),
    receivedSpyWei: (after.spyWei - before.spyWei).toString(),
    receivedPairWei: (after.pairWei - before.pairWei).toString(),
    exitedAt: state.exitedAt,
  })
  delete state.activeLeg
  delete state.activeEntry
  delete state.pendingExit
  writeState(state)
  appendAudit('exit_complete', state.history.at(-1))
  console.log(
    stringify({
      status: 'EXITED',
      evidenceClass: 'CANONICAL_RECEIPT_AND_POST_STATE_READBACK',
      transaction: removed.hash,
      received: {
        spy: formatUnits(BigInt(after.spyWei) - BigInt(before.spyWei), 18),
        pair: formatUnits(BigInt(after.pairWei) - BigInt(before.pairWei), 18),
      },
      wallet: {
        eth: formatEther(after.ethWei),
        spy: formatUnits(after.spyWei, 18),
        pair: formatUnits(after.pairWei, 18),
      },
    }),
  )
}

function printHaltStatus() {
  console.log(
    stringify({
      status: stateStore.readHalt() ? 'HALTED' : 'NOT_HALTED',
      halt: stateStore.readHalt(),
    }),
  )
}

function clearHalt() {
  const previous = stateStore.clearHalt(process.env.PAIR_GRID_UNHALT_CONFIRM)
  console.log(stringify({ status: previous ? 'HALT_CLEARED' : 'NOT_HALTED', previous }))
}

async function dispatchCommand(command) {
  if (command === 'key-check') return keyCheck()
  if (command === 'inspect') return inspect()
  if (command === 'preflight') return initialPreflight()
  if (command === 'enter-buy') return enterBuy()
  if (command === 'resume-buy') return resumeBuy()
  if (command === 'status') return printStatus()
  if (command === 'reconcile') return reconcile()
  if (command === 'keeper-once') return keeperOnce()
  if (command === 'rotate') return rotate()
  if (command === 'resume-rotate') return resumeRotate()
  if (command === 'exit') return exitPosition()
  if (command === 'halt-status') return printHaltStatus()
  if (command === 'clear-halt') return clearHalt()
  throw new Error(`未知命令: ${command}`)
}

const LIVE_COMMANDS = new Set(['enter-buy', 'resume-buy', 'keeper-once', 'rotate', 'resume-rotate', 'exit'])
const LOCKED_COMMANDS = new Set([...LIVE_COMMANDS, 'reconcile', 'clear-halt'])

async function main() {
  const command = process.argv[2] || 'inspect'
  if (!LOCKED_COMMANDS.has(command)) return dispatchCommand(command)
  return stateStore.withLock(command, async () => {
    if (LIVE_COMMANDS.has(command)) {
      stateStore.assertNotHalted()
      assertLiveArm()
    }
    return dispatchCommand(command)
  })
}

main().catch((error) => {
  const command = process.argv[2] || 'inspect'
  const message = errorMessage(error)
  if (LIVE_COMMANDS.has(command)) {
    try {
      stateStore.halt({ command, reason: message })
    } catch (haltError) {
      console.error(`HALTED 写入失败：${errorMessage(haltError)}`)
    }
  }
  appendAudit('command_failed', { command, message })
  console.error(message)
  process.exitCode = 1
})
