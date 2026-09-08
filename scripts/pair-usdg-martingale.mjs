import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  formatEther,
  formatUnits,
  fallback,
  getAddress,
  http,
  parseAbi,
  zeroAddress,
} from 'viem'

import { loadSignerAccount } from '../lib/account-loader.mjs'
import {
  buyFillAccounting,
  DEFAULT_FINITE_MARTINGALE_POLICY,
  decideNextVerifiedBandAction,
  directPairPriceAtTick,
  parseMarketEvidence,
  planInitialBuyLadder,
  planSellRange,
  positionConversionBps,
  sellFillAccounting,
} from '../lib/finite-martingale.mjs'
import { canonicalGasSpent, executePersistedTransaction } from '../lib/persisted-transaction.mjs'
import { parseBroadcastEndpoints, parseRpcEndpoints, rpcEndpointSummary } from '../lib/rpc-endpoints.mjs'
import { StateStore } from '../lib/state-store.mjs'
import {
  burnAmountsWithSlippage,
  encodeAddLiquidity,
  encodeBatchMintPositions,
  encodeBurnPosition,
  mintAmounts,
  poolId,
  positionAmounts,
  singleSidedPosition,
  validateBatchMintSimulationData,
} from '../lib/uniswap-v4-position.mjs'

const CHAIN_ID = 4663
const RPC_ENDPOINTS = parseRpcEndpoints()
const BROADCAST_ENDPOINTS = parseBroadcastEndpoints(process.env, RPC_ENDPOINTS)
const WALLET = getAddress(process.env.PAIR_MARTINGALE_WALLET || zeroAddress)
const KEYCHAIN_SERVICE = process.env.PAIR_MARTINGALE_KEYCHAIN_SERVICE || 'codex-rh-pair-usdg-martingale'
const MARKET_URL = process.env.PAIR_MARTINGALE_MARKET_URL || ''
const BOOTSTRAP_PATH = path.resolve(process.env.PAIR_MARTINGALE_BOOTSTRAP_PATH || './runs/bootstrap.json')
const RUN_DIR = path.resolve(process.env.PAIR_MARTINGALE_RUN_DIR || './runs/usdg-martingale')

const USDG = getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168')
const SPY = getAddress('0x117cc2133c37B721F49dE2A7a74833232B3B4C0C')
const PAIR = getAddress('0x6b1d42927B1a84eC28Fa88d4fC6FA7AF404966be')
const PERMIT2 = getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3')
const STATE_VIEW = getAddress('0xF3334192D15450CdD385c8B70e03f9A6bD9E673b')
const POSITION_MANAGER = getAddress('0x58daec3116aae6D93017bAAea7749052E8a04fA7')
const POOL_ID = DEFAULT_FINITE_MARTINGALE_POLICY.poolId
const TICK_SPACING = DEFAULT_FINITE_MARTINGALE_POLICY.tickSpacing
const POOL_FEE = DEFAULT_FINITE_MARTINGALE_POLICY.feePips
const CONFIRMATION_DEPTH = 128n
const MINIMUM_FINAL_ETH_WEI = 3_500_000_000_000_000n
const MAXIMUM_INITIAL_GAS_WEI = 1_000_000_000_000_000n
const CONSERVATIVE_APPROVAL_GAS = 80_000n
const CONSERVATIVE_FIVE_MINT_GAS = 1_500_000n
const CONSERVATIVE_THREE_MINT_GAS = 1_100_000n
const MAXIMUM_BUILD_FRICTION_BPS = 500
const MINIMUM_DEPLOYMENT_UTILIZATION_BPS = 9_990n
const ROTATION_REMOVE_SLIPPAGE_BPS = 100n
const MINIMUM_KEEPER_ETH_WEI = BigInt(process.env.PAIR_MARTINGALE_MINIMUM_ETH_WEI || '1000000000000000')
const MAXIMUM_ROTATION_TRANSACTION_GAS_WEI = BigInt(
  process.env.PAIR_MARTINGALE_MAX_TRANSACTION_GAS_WEI || '750000000000000',
)
const MAXIMUM_DAILY_GAS_WEI = BigInt(process.env.PAIR_MARTINGALE_MAX_DAILY_GAS_WEI || '2000000000000000')
const MAXIMUM_DAILY_TRANSACTIONS = Number(process.env.PAIR_MARTINGALE_MAX_DAILY_TRANSACTIONS || 18)
const MAXIMUM_DAILY_ROTATIONS = Number(process.env.PAIR_MARTINGALE_MAX_DAILY_ROTATIONS || 6)
const CONSERVATIVE_ROTATION_GAS_UNITS = 1_250_000n
const TARGET_DEADLINE_SECONDS = 30 * 60
const UINT160_MAX = (1n << 160n) - 1n
const ZERO = zeroAddress
const EXPLORER_TX = 'https://robinhoodchain.blockscout.com/tx/'
const INITIAL_APPROVAL_STEP = ['approve', 'usdg', 'permit2'].join('_')
const READ_HTTP_OPTIONS = Object.freeze({
  timeout: 20_000,
  retryCount: 1,
  batch: { batchSize: 20, wait: 10 },
})

if (WALLET === zeroAddress) throw new Error('缺少 PAIR_MARTINGALE_WALLET')
if (!MARKET_URL) throw new Error('缺少 PAIR_MARTINGALE_MARKET_URL')

const chain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: RPC_ENDPOINTS } },
  blockExplorers: {
    default: { name: 'Robinhood Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
})

/** @type {any} viem's custom-chain generics are isolated at this RPC adapter boundary. */
const publicClient = createPublicClient({
  chain,
  transport:
    RPC_ENDPOINTS.length === 1
      ? http(RPC_ENDPOINTS[0], READ_HTTP_OPTIONS)
      : fallback(
          RPC_ENDPOINTS.map((endpoint) => http(endpoint, { ...READ_HTTP_OPTIONS, retryCount: 0 })),
          { rank: false, retryCount: 1 },
        ),
})
const store = new StateStore(RUN_DIR)
let cachedAccount

function createBroadcastClients(account) {
  return BROADCAST_ENDPOINTS.map((endpoint) =>
    createWalletClient({
      account,
      chain,
      transport: http(endpoint, { timeout: 20_000, retryCount: 0 }),
    }),
  )
}

const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
])

const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
])

const POSITION_MANAGER_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,uint256 info)',
  'event Transfer(address indexed from,address indexed to,uint256 indexed id)',
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

const poolKey = {
  currency0: USDG,
  currency1: PAIR,
  fee: POOL_FEE,
  tickSpacing: TICK_SPACING,
  hooks: ZERO,
}

if (poolId(poolKey).toLowerCase() !== POOL_ID.toLowerCase()) {
  throw new Error('本地 PAIR/USDG poolId 编码不匹配')
}

function stringify(value) {
  return JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item), 2)
}

function nowSeconds() {
  return Math.floor(Date.now() / 1_000)
}

function readBootstrap() {
  if (!fs.existsSync(BOOTSTRAP_PATH)) throw new Error(`缺少 bootstrap 账本：${BOOTSTRAP_PATH}`)
  const bootstrap = JSON.parse(fs.readFileSync(BOOTSTRAP_PATH, 'utf8'))
  if (
    Number(bootstrap.chainId) !== CHAIN_ID ||
    getAddress(bootstrap.wallet).toLowerCase() !== WALLET.toLowerCase() ||
    String(bootstrap.poolId).toLowerCase() !== POOL_ID.toLowerCase()
  ) {
    throw new Error('bootstrap 的链、钱包或池身份不匹配')
  }
  if (bootstrap.normalization?.status !== 'complete') throw new Error('手续费资产尚未完成 USDG 标准化')
  if (bootstrap.normalization?.gasExcludedFromPrincipal !== true)
    throw new Error('bootstrap 未隔离 Gas 与本金')
  const principal = BigInt(bootstrap.normalization.output.usdgAtomic)
  if (principal <= 0n) throw new Error('bootstrap 的 USDG 本金无效')
  return { bootstrap, principal }
}

async function verifyNormalizationReceipts(bootstrap) {
  const hashes = Object.values(bootstrap.normalization.transactions || {})
  if (hashes.length < 2) throw new Error('标准化交易回执清单不完整')
  const seen = new Set()
  for (const hash of hashes) {
    if (seen.has(hash)) throw new Error(`标准化交易哈希重复：${hash}`)
    seen.add(hash)
    const [receipt, transaction] = await Promise.all([
      publicClient.getTransactionReceipt({ hash }),
      publicClient.getTransaction({ hash }),
    ])
    if (receipt.status !== 'success' || transaction.from.toLowerCase() !== WALLET.toLowerCase()) {
      throw new Error(`标准化交易身份或回执失败：${hash}`)
    }
    const canonical = await publicClient.getBlock({ blockNumber: receipt.blockNumber })
    if (canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      throw new Error(`标准化交易不再 canonical：${hash}`)
    }
  }
  return hashes.length
}

async function assertRuntimeIdentity() {
  const chainId = await publicClient.getChainId()
  if (chainId !== CHAIN_ID) throw new Error(`RPC chainId=${chainId}，预期 ${CHAIN_ID}`)
  const contracts = [USDG, SPY, PAIR, PERMIT2, STATE_VIEW, POSITION_MANAGER]
  const codes = await Promise.all(contracts.map((address) => publicClient.getCode({ address })))
  const missing = contracts.filter((_, index) => !codes[index] || codes[index] === '0x')
  if (missing.length) throw new Error(`目标合约没有 bytecode：${missing.join(', ')}`)
  const metadata = await Promise.all(
    [
      [USDG, 'USDG', 6],
      [PAIR, 'PAIR', 18],
      [SPY, 'SPY', 18],
    ].map(async ([address, symbol, decimals]) => {
      const [actualSymbol, actualDecimals] = await Promise.all([
        publicClient.readContract({ address, abi: ERC20_ABI, functionName: 'symbol' }),
        publicClient.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' }),
      ])
      return { symbol, decimals, actualSymbol, actualDecimals }
    }),
  )
  for (const item of metadata) {
    if (item.symbol !== item.actualSymbol || item.decimals !== item.actualDecimals) {
      throw new Error(`代币元数据不匹配：${item.symbol}`)
    }
  }
  const walletCode = await publicClient.getCode({ address: WALLET })
  if (walletCode && walletCode !== '0x') throw new Error('策略钱包不再是 EOA')
}

async function getPoolState(blockNumber) {
  const block = blockNumber === undefined ? {} : { blockNumber }
  const [[sqrtPriceX96, tick, protocolFee, lpFee], liquidity] = await Promise.all([
    publicClient.readContract({
      address: STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getSlot0',
      args: [POOL_ID],
      ...block,
    }),
    publicClient.readContract({
      address: STATE_VIEW,
      abi: STATE_VIEW_ABI,
      functionName: 'getLiquidity',
      args: [POOL_ID],
      ...block,
    }),
  ])
  if (sqrtPriceX96 <= 0n || liquidity <= 0n || Number(lpFee) !== POOL_FEE) {
    throw new Error('PAIR/USDG 1% 池状态异常')
  }
  return {
    sqrtPriceX96,
    tick: Number(tick),
    protocolFee: Number(protocolFee),
    lpFee: Number(lpFee),
    liquidity,
  }
}

async function walletSnapshot(blockNumber) {
  const block = blockNumber === undefined ? {} : { blockNumber }
  const [ethWei, usdgAtomic, pairWei, spyWei, nftBalance, nonceLatest, noncePending] = await Promise.all([
    publicClient.getBalance({ address: WALLET, ...block }),
    publicClient.readContract({
      address: USDG,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [WALLET],
      ...block,
    }),
    publicClient.readContract({
      address: PAIR,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [WALLET],
      ...block,
    }),
    publicClient.readContract({
      address: SPY,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [WALLET],
      ...block,
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'balanceOf',
      args: [WALLET],
      ...block,
    }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'latest' }),
    publicClient.getTransactionCount({ address: WALLET, blockTag: 'pending' }),
  ])
  return { ethWei, usdgAtomic, pairWei, spyWei, nftBalance, nonceLatest, noncePending }
}

async function fetchMarketEvidence() {
  const response = await fetch(MARKET_URL, {
    signal: AbortSignal.timeout(15_000),
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`市场面板 HTTP ${response.status}`)
  const text = await response.text()
  if (text.length > 5_000_000) throw new Error('市场面板响应超过 5 MB')
  const snapshot = JSON.parse(text)
  const evidence = parseMarketEvidence(snapshot)
  const canonical = await publicClient.getBlock({ blockNumber: BigInt(evidence.asOfBlock) })
  if (canonical.hash.toLowerCase() !== evidence.asOfBlockHash.toLowerCase()) {
    throw new Error('市场面板安全区块不再 canonical')
  }
  const ethUsdg = Number(snapshot.comparison?.migrationEstimate?.ethQuote?.ethUsdg)
  if (!Number.isFinite(ethUsdg) || ethUsdg <= 0) throw new Error('面板缺少可核验的 ETH/USDG 报价')
  return { evidence, ethUsdg }
}

function loadAccount() {
  if (cachedAccount) return cachedAccount
  const credentialsDirectory =
    process.env.PAIR_MARTINGALE_CREDENTIALS_DIRECTORY || process.env.CREDENTIALS_DIRECTORY
  cachedAccount = loadSignerAccount({
    expectedWallet: WALLET,
    keychainService: KEYCHAIN_SERVICE,
    credentialName: process.env.PAIR_MARTINGALE_CREDENTIAL_NAME || 'pair-usdg-martingale-private-key',
    environment: { ...process.env, CREDENTIALS_DIRECTORY: credentialsDirectory },
  }).account
  return cachedAccount
}

async function signTokenPermit(account, token, amount) {
  if (amount <= 0n || amount > UINT160_MAX) throw new Error('Permit2 代币金额无效')
  const [, , rawNonce] = await publicClient.readContract({
    address: PERMIT2,
    abi: PERMIT2_ABI,
    functionName: 'allowance',
    args: [WALLET, token, POSITION_MANAGER],
  })
  const nonce = BigInt(rawNonce)
  const permitBatch = {
    details: [
      {
        token,
        amount,
        expiration: BigInt(nowSeconds() + 2 * 60 * 60),
        nonce,
      },
    ],
    spender: POSITION_MANAGER,
    sigDeadline: BigInt(nowSeconds() + TARGET_DEADLINE_SECONDS),
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

async function buildBatchMint(account, plan) {
  const positions = plan.selected.bands.map((band) => ({
    tickLower: band.tickLower,
    tickUpper: band.tickUpper,
    liquidity: band.liquidity,
    amount0Max: band.amount0Max,
    amount1Max: 0n,
    recipient: WALLET,
  }))
  const totalMaximum = positions.reduce((sum, position) => sum + position.amount0Max, 0n)
  if (totalMaximum !== plan.plannedSpendUsdgAtomic) throw new Error('批量 mint 上限与规划支出不一致')
  const batchPermit = await signTokenPermit(account, USDG, totalMaximum)
  const deadline = BigInt(nowSeconds() + TARGET_DEADLINE_SECONDS)
  return {
    totalMaximum,
    deadline,
    data: encodeBatchMintPositions({ poolKey, positions, batchPermit, deadline }),
  }
}

function modeledGasFrictionBps(gasUnits, gasPrice, ethUsdg, principalAtomic) {
  const gasEth = (Number(gasUnits) * Number(gasPrice)) / 1e18
  const principalUsdg = Number(principalAtomic) / 1e6
  return Math.ceil(((gasEth * ethUsdg) / principalUsdg) * 10_000)
}

async function chooseBandCount(gasPrice, ethUsdg, principal) {
  const fiveBps = modeledGasFrictionBps(
    CONSERVATIVE_APPROVAL_GAS + CONSERVATIVE_FIVE_MINT_GAS,
    gasPrice,
    ethUsdg,
    principal,
  )
  if (fiveBps <= MAXIMUM_BUILD_FRICTION_BPS) return { bandCount: 5, frictionBps: fiveBps }
  const threeBps = modeledGasFrictionBps(
    CONSERVATIVE_APPROVAL_GAS + CONSERVATIVE_THREE_MINT_GAS,
    gasPrice,
    ethUsdg,
    principal,
  )
  if (threeBps > MAXIMUM_BUILD_FRICTION_BPS) {
    throw new Error(`3 档建仓预计摩擦 ${threeBps} BPS 仍超过 5%`)
  }
  return { bandCount: 3, frictionBps: threeBps, degradedFromFive: true }
}

async function buildFreshPlan(principal, requestedBandCount = null) {
  const [{ evidence, ethUsdg }, poolState, gasPrice] = await Promise.all([
    fetchMarketEvidence(),
    getPoolState(),
    publicClient.getGasPrice(),
  ])
  const choice = requestedBandCount
    ? { bandCount: requestedBandCount, frictionBps: null }
    : await chooseBandCount(gasPrice, ethUsdg, principal)
  const plan = planInitialBuyLadder({
    principalUsdgAtomic: principal,
    currentTick: poolState.tick,
    sqrtPriceX96: poolState.sqrtPriceX96,
    market: evidence,
    bandCount: choice.bandCount,
  })
  return { plan, poolState, gasPrice, ethUsdg, choice }
}

function publicPlan(plan) {
  return {
    method: plan.method,
    bandCount: plan.bandCount,
    principalUsdg: formatUnits(plan.principalUsdgAtomic, 6),
    plannedSpendUsdg: formatUnits(plan.plannedSpendUsdgAtomic, 6),
    reserveUsdg: formatUnits(plan.reserveUsdgAtomic, 6),
    currentTick: plan.currentTick,
    currentPairPriceUsdg: plan.currentPairPriceUsdg,
    hotBand6hUsdg: plan.hotBand6hUsdg,
    volumeAcceleration: plan.observedVolumeAcceleration,
    marketScore: plan.selected.metrics,
    bands: plan.selected.bands.map((band) => ({
      id: band.id,
      weightPct: band.weightBps / 100,
      allocationUsdg: formatUnits(band.allocationUsdgAtomic, 6),
      maximumSpendUsdg: formatUnits(band.amount0Max, 6),
      tickLower: band.tickLower,
      tickUpper: band.tickUpper,
      priceLowUsdg: band.priceLowUsdg,
      priceHighUsdg: band.priceHighUsdg,
      theoreticalBuyBasisUsdg: band.theoreticalBuyBasisUsdg,
      liquidity: band.liquidity.toString(),
    })),
    evidence: plan.evidence,
  }
}

async function initialPreflight({ requireReady = false, print = true } = {}) {
  await assertRuntimeIdentity()
  const existing = store.readState()
  if (existing) {
    const report = {
      status: existing.status === 'BUY_LADDER_ACTIVE' ? 'ALREADY_ACTIVE' : 'RESUME_REQUIRED',
      state: existing.status,
    }
    if (print) console.log(stringify(report))
    return { report, state: existing }
  }
  const { bootstrap, principal } = readBootstrap()
  const receiptCount = await verifyNormalizationReceipts(bootstrap)
  const [wallet, allowance, fresh] = await Promise.all([
    walletSnapshot(),
    publicClient.readContract({
      address: USDG,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [WALLET, PERMIT2],
    }),
    buildFreshPlan(principal),
  ])
  if (wallet.nonceLatest !== wallet.noncePending) throw new Error('策略钱包存在 pending nonce')
  if (
    wallet.usdgAtomic !== principal ||
    wallet.spyWei !== 0n ||
    wallet.pairWei !== 0n ||
    wallet.nftBalance !== 0n
  ) {
    throw new Error('策略钱包余额/NFT 已偏离标准化账本，禁止自动归因')
  }
  if (allowance !== 0n) throw new Error(`USDG→Permit2 存在意外旧授权：${allowance}`)
  const modeledGas =
    CONSERVATIVE_APPROVAL_GAS +
    (fresh.choice.bandCount === 5 ? CONSERVATIVE_FIVE_MINT_GAS : CONSERVATIVE_THREE_MINT_GAS)
  const modeledGasWei = (modeledGas * fresh.gasPrice * 13_750n) / 10_000n
  const ready =
    wallet.ethWei >= modeledGasWei + MINIMUM_FINAL_ETH_WEI && modeledGasWei <= MAXIMUM_INITIAL_GAS_WEI
  const report = {
    status: ready ? 'READY' : 'NOT_READY',
    evidenceClass: 'CANONICAL_NORMALIZATION_RECEIPTS_PLUS_LIVE_MARKET_PLAN_NOT_BROADCAST',
    observedAt: new Date().toISOString(),
    wallet: WALLET,
    normalizedReceiptCount: receiptCount,
    nonce: { latest: wallet.nonceLatest, pending: wallet.noncePending },
    balances: {
      eth: formatEther(wallet.ethWei),
      usdg: formatUnits(wallet.usdgAtomic, 6),
      pair: formatUnits(wallet.pairWei, 18),
      spy: formatUnits(wallet.spyWei, 18),
      nfts: wallet.nftBalance.toString(),
    },
    plan: publicPlan(fresh.plan),
    gas: {
      gasPriceGwei: formatUnits(fresh.gasPrice, 9),
      conservativeGasUnits: modeledGas.toString(),
      modeledMaximumEth: formatEther(modeledGasWei),
      hardMaximumEth: formatEther(MAXIMUM_INITIAL_GAS_WEI),
      minimumFinalEth: formatEther(MINIMUM_FINAL_ETH_WEI),
      modeledFrictionBps: fresh.choice.frictionBps,
      degradedFromFive: Boolean(fresh.choice.degradedFromFive),
    },
    policy: {
      feeDerivedPrincipalOnly: true,
      gasExcludedFromPrincipal: true,
      deployPct: 90,
      reservePct: 10,
      maximumBuildFrictionPct: 5,
      exactApprovalsOnly: true,
      singleBatchMint: true,
      confirmationDepth: CONFIRMATION_DEPTH.toString(),
    },
  }
  store.appendAudit('initial_preflight', report)
  if (print) console.log(stringify(report))
  if (requireReady && !ready) throw new Error('首次阶梯建仓预检未就绪')
  return { report, bootstrap, principal, wallet, fresh }
}

function serializablePlan(plan) {
  return JSON.parse(stringify(plan))
}

function newState(check) {
  return {
    schemaVersion: 1,
    strategyId: 'pair-usdg-finite-martingale-live-1',
    name: 'PAIR/USDG 有限马丁 LP',
    status: 'INITIAL_APPROVAL_REQUIRED',
    wallet: WALLET,
    chainId: CHAIN_ID,
    pool: { poolId: POOL_ID, ...poolKey },
    sourceBootstrapPath: BOOTSTRAP_PATH,
    sourceNormalizationOperationId: check.bootstrap.normalization.operationId,
    principal: {
      initialUsdgAtomic: check.principal.toString(),
      gasExcluded: true,
      externalTopUpsAllowed: false,
      reinvestmentEnabled: false,
    },
    policy: {
      deployBps: 9_000,
      reserveBps: 1_000,
      weightsBps: check.fresh.plan.selected.bands.map((band) => band.weightBps),
      maximumBuildFrictionBps: MAXIMUM_BUILD_FRICTION_BPS,
      minimumFinalEthWei: MINIMUM_FINAL_ETH_WEI.toString(),
      maximumInitialGasWei: MAXIMUM_INITIAL_GAS_WEI.toString(),
      minimumConversionBps: DEFAULT_FINITE_MARTINGALE_POLICY.minimumConversionBps,
      minimumNetProfitBps: DEFAULT_FINITE_MARTINGALE_POLICY.minimumNetProfitBps,
      noLeverage: true,
      oneBandPerKeeperCycle: true,
    },
    control: {
      expectedNextNonce: check.wallet.nonceLatest,
      lastStrategyTransaction: null,
      signerIsolationRequired: true,
    },
    initialWallet: {
      ethWei: check.wallet.ethWei.toString(),
      usdgAtomic: check.wallet.usdgAtomic.toString(),
      pairWei: check.wallet.pairWei.toString(),
      spyWei: check.wallet.spyWei.toString(),
      nftBalance: check.wallet.nftBalance.toString(),
    },
    plan: serializablePlan(check.fresh.plan),
    bands: [],
    transactions: {},
    history: [],
    createdAt: new Date().toISOString(),
  }
}

function parseMintTokenIds(receipt) {
  const tokenIds = []
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== POSITION_MANAGER.toLowerCase()) continue
    try {
      const parsed = /** @type {any} */ (
        decodeEventLog({ abi: POSITION_MANAGER_ABI, data: log.data, topics: log.topics })
      )
      if (
        parsed.eventName === 'Transfer' &&
        parsed.args.from.toLowerCase() === ZERO.toLowerCase() &&
        parsed.args.to.toLowerCase() === WALLET.toLowerCase()
      ) {
        tokenIds.push(BigInt(parsed.args.id))
      }
    } catch {
      // Ignore unrelated PositionManager logs.
    }
  }
  return tokenIds
}

function errorMessage(error) {
  return error?.shortMessage || error?.message || String(error)
}

function utcDay(value = new Date()) {
  return value.toISOString().slice(0, 10)
}

function canonicalTransactionsForDay(state, day = utcDay()) {
  return Object.values(state.transactions || {}).filter(
    (transaction) =>
      transaction.status === 'CANONICAL_SUCCESS' &&
      typeof transaction.confirmedAt === 'string' &&
      transaction.confirmedAt.startsWith(day),
  )
}

function completedRotationsForDay(state, day = utcDay()) {
  return (state.history || []).filter(
    (entry) => entry.kind === 'ROTATION' && entry.phase === 'COMPLETE' && entry.completedAt?.startsWith(day),
  )
}

function keeperLimits(state) {
  return {
    maximumDailyTransactions: Number(state.policy.maximumDailyTransactions || MAXIMUM_DAILY_TRANSACTIONS),
    maximumDailyRotations: Number(state.policy.maximumDailyRotations || MAXIMUM_DAILY_ROTATIONS),
    maximumDailyGasWei: BigInt(state.policy.maximumDailyGasWei || MAXIMUM_DAILY_GAS_WEI),
    maximumTransactionGasWei: BigInt(
      state.policy.maximumTransactionGasWei || MAXIMUM_ROTATION_TRANSACTION_GAS_WEI,
    ),
    minimumKeeperEthWei: BigInt(state.policy.minimumKeeperEthWei || MINIMUM_KEEPER_ETH_WEI),
  }
}

function dailyUsage(state) {
  const transactions = canonicalTransactionsForDay(state)
  return {
    transactionCount: transactions.length,
    rotationCount: completedRotationsForDay(state).length,
    gasWei: transactions.reduce((sum, transaction) => sum + BigInt(transaction.gasCostWei || 0), 0n),
  }
}

function ensureKeeperSchema(state) {
  if (!state || state.strategyId !== 'pair-usdg-finite-martingale-live-1') {
    throw new Error('有限马丁本地账本身份不匹配')
  }
  if (getAddress(state.wallet).toLowerCase() !== WALLET.toLowerCase()) {
    throw new Error('有限马丁本地账本钱包不匹配')
  }
  let changed = false
  if (Number(state.schemaVersion) < 2) {
    state.schemaVersion = 2
    changed = true
  }
  const defaults = {
    maximumDailyTransactions: MAXIMUM_DAILY_TRANSACTIONS,
    maximumDailyRotations: MAXIMUM_DAILY_ROTATIONS,
    maximumDailyGasWei: MAXIMUM_DAILY_GAS_WEI.toString(),
    maximumTransactionGasWei: MAXIMUM_ROTATION_TRANSACTION_GAS_WEI.toString(),
    minimumKeeperEthWei: MINIMUM_KEEPER_ETH_WEI.toString(),
    rangePlanningEvidence: 'LIVE_1H_6H_VOLUME_LIQUIDITY_AND_PROJECTED_SHARE',
    automaticSigning: true,
    manualPerTransactionApproval: false,
  }
  for (const [key, value] of Object.entries(defaults)) {
    if (state.policy[key] === undefined) {
      state.policy[key] = value
      changed = true
    }
  }
  state.history ||= []
  for (const band of state.bands || []) {
    band.history ||= []
    if (!band.activePosition?.inputAmountAtomic) {
      const planned = state.plan?.selected?.bands?.find((candidate) => candidate.id === band.id)
      const amount = planned?.amount0Max || band.allocationUsdgAtomic
      if (!amount) throw new Error(`${band.id} 缺少首次 BUY 输入归因`)
      band.activePosition.inputToken = 'USDG'
      band.activePosition.inputAmountAtomic = String(amount)
      changed = true
    }
  }
  if (changed) {
    state.updatedAt = new Date().toISOString()
    store.writeState(state)
    store.appendAudit('keeper_schema_upgraded', {
      schemaVersion: state.schemaVersion,
      automaticSigning: true,
      manualPerTransactionApproval: false,
    })
  }
  return state
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
      // Ignore unrelated logs from the token contract.
    }
  }
  return net
}

function receiptBurnsTokenId(receipt, tokenId) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== POSITION_MANAGER.toLowerCase()) continue
    try {
      const parsed = /** @type {any} */ (
        decodeEventLog({ abi: POSITION_MANAGER_ABI, data: log.data, topics: log.topics })
      )
      if (
        parsed.eventName === 'Transfer' &&
        BigInt(parsed.args.id) === tokenId &&
        parsed.args.from.toLowerCase() === WALLET.toLowerCase() &&
        parsed.args.to.toLowerCase() === ZERO.toLowerCase()
      ) {
        return true
      }
    } catch {
      // Ignore unrelated PositionManager logs.
    }
  }
  return false
}

function assertPoolKey(chainPoolKey) {
  if (
    getAddress(chainPoolKey.currency0) !== USDG ||
    getAddress(chainPoolKey.currency1) !== PAIR ||
    Number(chainPoolKey.fee) !== POOL_FEE ||
    Number(chainPoolKey.tickSpacing) !== TICK_SPACING ||
    getAddress(chainPoolKey.hooks) !== ZERO
  ) {
    throw new Error('活动 NFT poolKey 与 PAIR/USDG 1% 池不匹配')
  }
}

async function readActivePosition(band, poolState, blockNumber) {
  const tokenId = BigInt(band.activePosition.tokenId)
  const [owner, liquidity, [chainPoolKey, info]] = await Promise.all([
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
      blockNumber,
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'getPositionLiquidity',
      args: [tokenId],
      blockNumber,
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'getPoolAndPositionInfo',
      args: [tokenId],
      blockNumber,
    }),
  ])
  if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error(`${band.id} NFT owner 不匹配`)
  if (liquidity !== BigInt(band.activePosition.liquidity)) {
    throw new Error(`${band.id} NFT liquidity 与账本不匹配`)
  }
  assertPoolKey(chainPoolKey)
  const tickLower = signed24(BigInt(info) >> 8n)
  const tickUpper = signed24(BigInt(info) >> 32n)
  if (tickLower !== band.activePosition.tickLower || tickUpper !== band.activePosition.tickUpper) {
    throw new Error(`${band.id} NFT tick 与账本不匹配`)
  }
  const amounts = positionAmounts({
    sqrtPriceX96: poolState.sqrtPriceX96,
    liquidity,
    tickLower,
    tickUpper,
    tickSpacing: TICK_SPACING,
  })
  return {
    tokenId,
    owner,
    liquidity,
    tickLower,
    tickUpper,
    amount0UsdgAtomic: amounts.amount0,
    amount1PairWei: amounts.amount1,
    conversionBps: positionConversionBps({
      leg: band.activePosition.leg,
      amount0UsdgAtomic: amounts.amount0,
      amount1PairWei: amounts.amount1,
      sqrtPriceX96: poolState.sqrtPriceX96,
    }),
  }
}

async function inspectKeeperState(state) {
  const [headBlock, wallet] = await Promise.all([publicClient.getBlockNumber(), walletSnapshot()])
  if (headBlock < CONFIRMATION_DEPTH) throw new Error('链高度不足以形成安全区块')
  const safeBlock = headBlock - CONFIRMATION_DEPTH + 1n
  const [headPool, safePool] = await Promise.all([getPoolState(headBlock), getPoolState(safeBlock)])
  if (wallet.nonceLatest !== wallet.noncePending) {
    throw new Error(`HARD: 策略钱包存在 pending nonce ${wallet.nonceLatest}/${wallet.noncePending}`)
  }
  if (wallet.nonceLatest !== state.control.expectedNextNonce) {
    throw new Error(
      `HARD: nonce 隔离破坏；账本 ${state.control.expectedNextNonce}，链上 ${wallet.nonceLatest}`,
    )
  }
  if (wallet.spyWei !== 0n) throw new Error('HARD: 隔离钱包出现非策略资产 SPY')
  if (wallet.nftBalance !== BigInt(state.bands.length)) {
    throw new Error(`HARD: NFT 数量 ${wallet.nftBalance} 与活动档位 ${state.bands.length} 不一致`)
  }

  /** @type {Record<string,{headConversionBps:number,safeConversionBps:number}>} */
  const observations = {}
  const positions = {}
  for (const band of state.bands) {
    const head = await readActivePosition(band, headPool, headBlock)
    let safe = null
    if (safeBlock >= BigInt(band.activePosition.mintBlock)) {
      safe = await readActivePosition(band, safePool, safeBlock)
    }
    observations[band.id] = {
      headConversionBps: head.conversionBps,
      safeConversionBps: safe?.conversionBps || 0,
    }
    positions[band.id] = { head, safe }
  }
  return { headBlock, safeBlock, wallet, headPool, safePool, observations, positions }
}

async function attachMarketEvidence(inspection) {
  const market = await fetchMarketEvidence()
  if (
    Math.abs(inspection.headPool.tick - market.evidence.currentTick) >
    DEFAULT_FINITE_MARTINGALE_POLICY.maximumTickDivergence
  ) {
    throw new Error('DEGRADED: 面板与当前 RPC tick 偏离过大')
  }
  inspection.market = market
  return inspection
}

function assertRotationCapacity(state) {
  const limits = keeperLimits(state)
  const usage = dailyUsage(state)
  if (usage.rotationCount >= limits.maximumDailyRotations) {
    throw new Error('WAIT: 已达到 UTC 日换腿次数上限')
  }
  if (usage.transactionCount + 3 > limits.maximumDailyTransactions) {
    throw new Error('WAIT: 今日剩余交易次数不足以完成一次安全换腿')
  }
  if (usage.gasWei >= limits.maximumDailyGasWei) throw new Error('WAIT: 已达到 UTC 日 Gas 上限')
}

async function executeKeeperTransaction({ state, key, label, to, data, metadata = {} }) {
  const limits = keeperLimits(state)
  const existing = state.transactions?.[key]
  const usage = dailyUsage(state)
  if (!existing?.request) {
    if (usage.transactionCount >= limits.maximumDailyTransactions) throw new Error('WAIT: 今日交易次数已用完')
    if (usage.gasWei >= limits.maximumDailyGasWei) throw new Error('WAIT: 今日 Gas 预算已用完')
  }
  const remainingDaily =
    usage.gasWei < limits.maximumDailyGasWei ? limits.maximumDailyGasWei - usage.gasWei : 0n
  const allowedAdditional =
    remainingDaily < limits.maximumTransactionGasWei ? remainingDaily : limits.maximumTransactionGasWei
  if (!existing?.request && allowedAdditional <= 0n) throw new Error('WAIT: 当前交易没有剩余 Gas 预算')
  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  const broadcastClients = createBroadcastClients(account)
  return executePersistedTransaction({
    state,
    key,
    label,
    to,
    data,
    metadata,
    account,
    walletClient,
    broadcastClients,
    publicClient,
    walletAddress: WALLET,
    chainId: CHAIN_ID,
    store,
    minimumFinalEthWei: limits.minimumKeeperEthWei,
    maximumOperationGasWei:
      canonicalGasSpent(state) + (existing?.request ? limits.maximumTransactionGasWei : allowedAdditional),
    confirmationDepth: CONFIRMATION_DEPTH,
  })
}

async function ensureTokenAllowanceExact(state, token, amount, keyPrefix) {
  const current = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [WALLET, PERMIT2],
  })
  if (current === amount) return []
  const transactions = []
  if (current !== 0n) {
    transactions.push(
      await executeKeeperTransaction({
        state,
        key: `${keyPrefix}_approval_zero`,
        label: `${keyPrefix}：撤销旧 Permit2 精确额度`,
        to: token,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2, 0n] }),
        metadata: { token, amount: '0' },
      }),
    )
  }
  transactions.push(
    await executeKeeperTransaction({
      state,
      key: `${keyPrefix}_approval_exact`,
      label: `${keyPrefix}：设置 Permit2 精确额度`,
      to: token,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2, amount] }),
      metadata: { token, amount: amount.toString() },
    }),
  )
  const readback = await publicClient.readContract({
    address: token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [WALLET, PERMIT2],
  })
  if (readback !== amount) throw new Error('HARD: Permit2 ERC20 精确授权回读不匹配')
  return transactions
}

async function buildSingleSidedMint(account, { leg, tickLower, tickUpper, availableAmount }) {
  const poolState = await getPoolState()
  const position = singleSidedPosition({
    leg,
    sqrtPriceX96: poolState.sqrtPriceX96,
    tickLower,
    tickUpper,
    tickSpacing: TICK_SPACING,
    amount: availableAmount,
  })
  const desired = mintAmounts(position)
  const token = leg === 'BUY' ? USDG : PAIR
  const required = leg === 'BUY' ? desired.amount0 : desired.amount1
  if (required <= 0n || (leg === 'BUY' ? desired.amount1 !== 0n : desired.amount0 !== 0n)) {
    throw new Error(`HARD: ${leg} 目标不再是预期单边成分`)
  }
  const batchPermit = await signTokenPermit(account, token, required)
  const data = encodeAddLiquidity({
    poolKey,
    tickLower,
    tickUpper,
    liquidity: position.liquidity,
    amount0Max: desired.amount0,
    amount1Max: desired.amount1,
    recipient: WALLET,
    batchPermit,
    deadline: BigInt(nowSeconds() + TARGET_DEADLINE_SECONDS),
  })
  return { leg, token, required, position, desired, data, poolState }
}

function signed24(value) {
  const masked = Number(BigInt(value) & 0xffffffn)
  return masked >= 0x800000 ? masked - 0x1000000 : masked
}

async function verifyMintedPositions(tokenIds, plan, mintBlock) {
  if (tokenIds.length !== plan.bandCount) {
    throw new Error(`批量 mint 解析到 ${tokenIds.length} 个 NFT，预期 ${plan.bandCount}`)
  }
  const records = await Promise.all(
    tokenIds.map(async (tokenId) => {
      const [owner, liquidity, [chainPoolKey, info]] = await Promise.all([
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_MANAGER_ABI,
          functionName: 'ownerOf',
          args: [tokenId],
          blockNumber: mintBlock,
        }),
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_MANAGER_ABI,
          functionName: 'getPositionLiquidity',
          args: [tokenId],
          blockNumber: mintBlock,
        }),
        publicClient.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_MANAGER_ABI,
          functionName: 'getPoolAndPositionInfo',
          args: [tokenId],
          blockNumber: mintBlock,
        }),
      ])
      return {
        tokenId,
        owner,
        liquidity,
        tickLower: signed24(BigInt(info) >> 8n),
        tickUpper: signed24(BigInt(info) >> 32n),
        poolKey: chainPoolKey,
      }
    }),
  )
  const mintPool = await getPoolState(mintBlock)
  return plan.selected.bands.map((band) => {
    const record = records.find(
      (candidate) => candidate.tickLower === band.tickLower && candidate.tickUpper === band.tickUpper,
    )
    if (!record) throw new Error(`未找到 ${band.id} 对应的链上 NFT`)
    if (
      record.owner.toLowerCase() !== WALLET.toLowerCase() ||
      record.liquidity !== band.liquidity ||
      getAddress(record.poolKey.currency0) !== USDG ||
      getAddress(record.poolKey.currency1) !== PAIR ||
      Number(record.poolKey.fee) !== POOL_FEE ||
      Number(record.poolKey.tickSpacing) !== TICK_SPACING ||
      getAddress(record.poolKey.hooks) !== ZERO
    ) {
      throw new Error(`${band.id} NFT owner/liquidity/poolKey 回读不匹配`)
    }
    if (mintPool.tick >= band.tickLower) throw new Error(`${band.id} mint 区块已不是 USDG-only`)
    const underlying = positionAmounts({
      sqrtPriceX96: mintPool.sqrtPriceX96,
      liquidity: record.liquidity,
      tickLower: record.tickLower,
      tickUpper: record.tickUpper,
      tickSpacing: TICK_SPACING,
    })
    if (underlying.amount0 <= 0n || underlying.amount1 !== 0n)
      throw new Error(`${band.id} mint 成分不是 USDG-only`)
    return { ...record, band }
  })
}

async function updateBootstrapWithPositions(state, mint) {
  const { bootstrap } = readBootstrap()
  bootstrap.positions = {
    status: 'active',
    strategyId: state.strategyId,
    activatedAt: state.activatedAt,
    transaction: mint.hash,
    blockNumber: mint.receipt.blockNumber.toString(),
    tokenIds: state.bands.map((band) => band.activePosition.tokenId),
    bands: state.bands.map((band) => ({
      id: band.id,
      weightBps: band.weightBps,
      allocationUsdgAtomic: band.allocationUsdgAtomic,
      tickLower: band.anchorBuyRange.tickLower,
      tickUpper: band.anchorBuyRange.tickUpper,
      priceLowUsdg: band.anchorBuyRange.priceLowUsdg,
      priceHighUsdg: band.anchorBuyRange.priceHighUsdg,
    })),
  }
  const temporary = `${BOOTSTRAP_PATH}.tmp`
  fs.writeFileSync(temporary, `${stringify(bootstrap)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, BOOTSTRAP_PATH)
  fs.chmodSync(BOOTSTRAP_PATH, 0o600)
}

async function resumeInitial(state) {
  await assertRuntimeIdentity()
  const { bootstrap, principal } = readBootstrap()
  await verifyNormalizationReceipts(bootstrap)
  const account = loadAccount()
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(undefined, { timeout: 30_000, retryCount: 0 }),
  })
  const broadcastClients = createBroadcastClients(account)
  if (!state.transactions?.initial_mint) {
    const required = BigInt(state.plan.deployableUsdgAtomic)
    const allowance = await publicClient.readContract({
      address: USDG,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [WALLET, PERMIT2],
    })
    if (allowance !== required) {
      if (allowance !== 0n) throw new Error(`USDG→Permit2 存在非零异常授权：${allowance}`)
      const approveData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [PERMIT2, required],
      })
      await executePersistedTransaction({
        state,
        key: INITIAL_APPROVAL_STEP,
        label: '有限马丁 1/2：精确授权 USDG 给 Permit2',
        to: USDG,
        data: approveData,
        metadata: { amountUsdgAtomic: required.toString() },
        account,
        walletClient,
        broadcastClients,
        publicClient,
        walletAddress: WALLET,
        chainId: CHAIN_ID,
        store,
        minimumFinalEthWei: MINIMUM_FINAL_ETH_WEI,
        maximumOperationGasWei: MAXIMUM_INITIAL_GAS_WEI,
        confirmationDepth: CONFIRMATION_DEPTH,
      })
      const readback = await publicClient.readContract({
        address: USDG,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [WALLET, PERMIT2],
      })
      if (readback !== required) throw new Error('USDG→Permit2 精确授权回读不匹配')
      state.status = 'INITIAL_MINT_REQUIRED'
      store.writeState(state)
    }
  }

  if (!state.transactions?.initial_mint?.result) {
    const walletBefore = await walletSnapshot()
    if (
      walletBefore.usdgAtomic !== principal ||
      walletBefore.pairWei !== 0n ||
      walletBefore.spyWei !== 0n ||
      walletBefore.nftBalance !== 0n
    ) {
      throw new Error('首次 mint 前钱包本金或 NFT 状态偏离')
    }
    const persistedBandCount = Number(state.plan.bandCount)
    if (persistedBandCount !== 3 && persistedBandCount !== 5) {
      throw new Error(`持久化档位数无效：${persistedBandCount}`)
    }
    const fresh = await buildFreshPlan(principal, persistedBandCount)
    state.plan = serializablePlan(fresh.plan)
    state.policy.weightsBps = fresh.plan.selected.bands.map((band) => band.weightBps)
    state.status = 'INITIAL_MINT_REQUIRED'
    store.writeState(state)
    const built = await buildBatchMint(account, fresh.plan)
    const [simulation, estimatedGas] = await Promise.all([
      publicClient.call({ account: WALLET, to: POSITION_MANAGER, data: built.data }),
      publicClient.estimateGas({ account: WALLET, to: POSITION_MANAGER, data: built.data }),
    ])
    validateBatchMintSimulationData(simulation.data)
    const totalGasUnits = estimatedGas + CONSERVATIVE_APPROVAL_GAS
    const actualFrictionBps = modeledGasFrictionBps(totalGasUnits, fresh.gasPrice, fresh.ethUsdg, principal)
    if (actualFrictionBps > MAXIMUM_BUILD_FRICTION_BPS) {
      if (fresh.plan.bandCount === 5) {
        const degraded = await buildFreshPlan(principal, 3)
        state.plan = serializablePlan(degraded.plan)
        state.policy.weightsBps = degraded.plan.selected.bands.map((band) => band.weightBps)
        store.writeState(state)
        return resumeInitial(state)
      }
      throw new Error(`真实 3 档建仓摩擦 ${actualFrictionBps} BPS 超过 5%`)
    }
    const mint = await executePersistedTransaction({
      state,
      key: 'initial_mint',
      label: `有限马丁 2/2：批量 mint ${fresh.plan.bandCount} 个 USDG-only BUY NFT`,
      to: POSITION_MANAGER,
      data: built.data,
      metadata: {
        bandCount: fresh.plan.bandCount,
        plan: publicPlan(fresh.plan),
        actualFrictionBps,
        estimatedGas: estimatedGas.toString(),
      },
      account,
      walletClient,
      broadcastClients,
      publicClient,
      walletAddress: WALLET,
      chainId: CHAIN_ID,
      store,
      minimumFinalEthWei: MINIMUM_FINAL_ETH_WEI,
      maximumOperationGasWei: MAXIMUM_INITIAL_GAS_WEI,
      confirmationDepth: CONFIRMATION_DEPTH,
    })
    const tokenIds = parseMintTokenIds(mint.receipt)
    const verified = await verifyMintedPositions(tokenIds, fresh.plan, mint.receipt.blockNumber)
    const walletAfter = await walletSnapshot()
    const spent = BigInt(walletBefore.usdgAtomic) - BigInt(walletAfter.usdgAtomic)
    const planned = fresh.plan.plannedSpendUsdgAtomic
    if (
      spent > planned ||
      spent * 10_000n < planned * MINIMUM_DEPLOYMENT_UTILIZATION_BPS ||
      walletAfter.spyWei !== 0n ||
      walletAfter.pairWei !== 0n ||
      walletAfter.nftBalance !== BigInt(fresh.plan.bandCount)
    ) {
      throw new Error('批量 mint 回执成功但本金利用率/钱包余额/NFT 数量不匹配')
    }
    state.transactions.initial_mint.result = {
      tokenIds: tokenIds.map(String),
      actualSpentUsdgAtomic: spent.toString(),
      walletAfter: {
        ethWei: walletAfter.ethWei.toString(),
        usdgAtomic: walletAfter.usdgAtomic.toString(),
        pairWei: walletAfter.pairWei.toString(),
        spyWei: walletAfter.spyWei.toString(),
        nftBalance: walletAfter.nftBalance.toString(),
      },
    }
    state.bands = verified.map(({ tokenId, liquidity, band }) => ({
      id: band.id,
      index: band.index,
      weightBps: band.weightBps,
      allocationUsdgAtomic: band.allocationUsdgAtomic.toString(),
      cycleNumber: 1,
      phase: 'BUY_ACTIVE',
      anchorBuyRange: {
        tickLower: band.tickLower,
        tickUpper: band.tickUpper,
        priceLowUsdg: band.priceLowUsdg,
        priceHighUsdg: band.priceHighUsdg,
        theoreticalBuyBasisUsdg: band.theoreticalBuyBasisUsdg,
      },
      activePosition: {
        tokenId: tokenId.toString(),
        leg: 'BUY',
        tickLower: band.tickLower,
        tickUpper: band.tickUpper,
        liquidity: liquidity.toString(),
        mintTransaction: mint.hash,
        mintBlock: mint.receipt.blockNumber.toString(),
      },
      positions: { buyTokenId: tokenId.toString(), sellTokenId: null },
      history: [],
    }))
    state.status = 'BUY_LADDER_ACTIVE'
    state.activatedAt = new Date().toISOString()
    state.principal.deployedUsdgAtomic = spent.toString()
    state.principal.reserveUsdgAtomic = walletAfter.usdgAtomic.toString()
    state.initialBuildGasWei = canonicalGasSpent(state).toString()
    store.writeState(state)
    store.appendAudit('initial_ladder_active', {
      transaction: mint.hash,
      tokenIds,
      spentUsdgAtomic: spent,
      reserveUsdgAtomic: walletAfter.usdgAtomic,
    })
    await updateBootstrapWithPositions(state, mint)
  }
  console.log(
    stringify({
      status: 'BUY_LADDER_ACTIVE',
      evidenceClass: 'CANONICAL_RECEIPTS_AND_POSITION_POST_STATE',
      wallet: WALLET,
      principalUsdg: formatUnits(BigInt(state.principal.initialUsdgAtomic), 6),
      deployedUsdg: formatUnits(BigInt(state.principal.deployedUsdgAtomic), 6),
      reserveUsdg: formatUnits(BigInt(state.principal.reserveUsdgAtomic), 6),
      gasSpentEth: formatEther(BigInt(state.initialBuildGasWei)),
      bands: state.bands.map((band) => ({
        id: band.id,
        tokenId: band.activePosition.tokenId,
        priceLowUsdg: band.anchorBuyRange.priceLowUsdg,
        priceHighUsdg: band.anchorBuyRange.priceHighUsdg,
        allocationUsdg: formatUnits(BigInt(band.allocationUsdgAtomic), 6),
      })),
      transactions: Object.fromEntries(
        Object.entries(state.transactions).map(([key, transaction]) => [
          key,
          `${EXPLORER_TX}${transaction.hash}`,
        ]),
      ),
    }),
  )
}

function assertLiveArm() {
  if (process.env.PAIR_MARTINGALE_LIVE_ARM !== 'I_AUTHORIZE_FINITE_MARTINGALE') {
    throw new Error('实盘门禁未开启：PAIR_MARTINGALE_LIVE_ARM')
  }
}

function buildBurn(activePosition, poolState) {
  const position = {
    sqrtPriceX96: poolState.sqrtPriceX96,
    liquidity: BigInt(activePosition.liquidity),
    tickLower: activePosition.tickLower,
    tickUpper: activePosition.tickUpper,
    tickSpacing: TICK_SPACING,
  }
  const principal = positionAmounts(position)
  const minimums = burnAmountsWithSlippage(position, ROTATION_REMOVE_SLIPPAGE_BPS)
  return {
    principal,
    minimums,
    data: encodeBurnPosition({
      poolKey,
      tokenId: BigInt(activePosition.tokenId),
      amount0Min: minimums.amount0,
      amount1Min: minimums.amount1,
      deadline: BigInt(nowSeconds() + TARGET_DEADLINE_SECONDS),
    }),
  }
}

function modeledRotationGasUsdg(gasPrice, ethUsdg) {
  return (Number(CONSERVATIVE_ROTATION_GAS_UNITS * gasPrice) / 1e18) * ethUsdg
}

function freshBuyTarget(state, band, market, poolState) {
  const bandCount = Number(state.plan.bandCount)
  if (bandCount !== 3 && bandCount !== 5) throw new Error(`HARD: 档位数 ${bandCount} 无效`)
  const fresh = planInitialBuyLadder({
    principalUsdgAtomic: BigInt(state.principal.initialUsdgAtomic),
    currentTick: poolState.tick,
    sqrtPriceX96: poolState.sqrtPriceX96,
    market: market.evidence,
    bandCount,
  })
  const target = fresh.selected.bands.find((candidate) => candidate.index === band.index)
  if (!target) throw new Error(`无法为 ${band.id} 生成动态 BUY 区间`)
  return {
    leg: 'BUY',
    tickLower: target.tickLower,
    tickUpper: target.tickUpper,
    priceLowUsdg: target.priceLowUsdg,
    priceHighUsdg: target.priceHighUsdg,
    rangeEvidence: {
      method: fresh.method,
      generatedAt: market.evidence.generatedAt,
      asOfBlock: market.evidence.asOfBlock,
      asOfBlockHash: market.evidence.asOfBlockHash,
      hotBand6hUsdg: market.evidence.hotBand6hUsdg,
      marketScore: fresh.selected.metrics,
    },
  }
}

function sellTargetFromAccounting(accounting, pending, poolState) {
  const range = planSellRange({
    basisPriceUsdg: accounting.effectiveBuyPriceUsdg,
    principalUsdg: Number(accounting.spentUsdgAtomic) / 1e6,
    modeledRoundTripGasUsdg: pending.modeledRotationGasUsdg,
    currentPairPriceUsdg: directPairPriceAtTick(poolState.tick),
  })
  return {
    leg: 'SELL',
    tickLower: range.tickLower,
    tickUpper: range.tickUpper,
    priceLowUsdg: range.priceLowUsdg,
    priceHighUsdg: range.priceHighUsdg,
    rangeEvidence: {
      method: 'realized net buy basis plus gas and minimum profit floor',
      basisPriceUsdg: accounting.effectiveBuyPriceUsdg,
      gasRecoveryBps: range.gasRecoveryBps,
      requiredMarkupBps: range.requiredMarkupBps,
      minimumNetProfitBps: range.minimumNetProfitBps,
      profitFloorUsdg: range.profitFloorUsdg,
    },
  }
}

async function verifyBurnedPosition(receipt, tokenId) {
  if (!receiptBurnsTokenId(receipt, tokenId)) throw new Error('HARD: 撤池回执缺少 NFT burn 事件')
  let stillOwned = false
  try {
    const owner = await publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
      blockNumber: receipt.blockNumber,
    })
    stillOwned = owner.toLowerCase() === WALLET.toLowerCase()
  } catch {
    // ownerOf reverting at the canonical burn block is the expected state.
  }
  if (stillOwned) throw new Error('HARD: NFT burn 回执成功但 ownerOf 仍指向策略钱包')
}

async function verifySingleMint(receipt, expected) {
  const tokenIds = parseMintTokenIds(receipt)
  if (tokenIds.length !== 1) throw new Error(`HARD: 目标 mint 解析到 ${tokenIds.length} 个 NFT`)
  const tokenId = tokenIds[0]
  const [owner, liquidity, [chainPoolKey, info], poolState] = await Promise.all([
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'ownerOf',
      args: [tokenId],
      blockNumber: receipt.blockNumber,
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'getPositionLiquidity',
      args: [tokenId],
      blockNumber: receipt.blockNumber,
    }),
    publicClient.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'getPoolAndPositionInfo',
      args: [tokenId],
      blockNumber: receipt.blockNumber,
    }),
    getPoolState(receipt.blockNumber),
  ])
  if (owner.toLowerCase() !== WALLET.toLowerCase()) throw new Error('HARD: 新 NFT owner 不匹配')
  if (liquidity !== expected.position.liquidity) throw new Error('HARD: 新 NFT liquidity 与计划不匹配')
  assertPoolKey(chainPoolKey)
  const tickLower = signed24(BigInt(info) >> 8n)
  const tickUpper = signed24(BigInt(info) >> 32n)
  if (tickLower !== expected.position.tickLower || tickUpper !== expected.position.tickUpper) {
    throw new Error('HARD: 新 NFT tick 与计划不匹配')
  }
  const amounts = positionAmounts({
    sqrtPriceX96: poolState.sqrtPriceX96,
    liquidity,
    tickLower,
    tickUpper,
    tickSpacing: TICK_SPACING,
  })
  if (expected.leg === 'BUY' && amounts.amount1 !== 0n) throw new Error('HARD: 新 BUY NFT 不是 USDG-only')
  if (expected.leg === 'SELL' && amounts.amount0 !== 0n) throw new Error('HARD: 新 SELL NFT 不是 PAIR-only')
  return { tokenId, owner, liquidity, tickLower, tickUpper, amounts, poolState }
}

function publicRotation(pending) {
  return {
    id: pending.id,
    bandId: pending.bandId,
    phase: pending.phase,
    fromLeg: pending.fromLeg,
    toLeg: pending.toLeg,
    sourceTokenId: pending.sourceTokenId,
    trigger: pending.trigger,
    target: pending.target || null,
    sourceBurnTransaction: pending.sourceBurnTransaction || null,
  }
}

async function startRotation(state, inspection, decision) {
  assertRotationCapacity(state)
  const band = state.bands.find((candidate) => candidate.id === decision.bandId)
  if (!band) throw new Error(`HARD: 找不到待换腿档位 ${decision.bandId}`)
  const fromLeg = band.phase === 'BUY_ACTIVE' ? 'BUY' : 'SELL'
  const toLeg = fromLeg === 'BUY' ? 'SELL' : 'BUY'
  const gasPrice = await publicClient.getGasPrice()
  const pending = {
    id: `${band.id.toLowerCase()}-c${band.cycleNumber}-${fromLeg.toLowerCase()}-to-${toLeg.toLowerCase()}`,
    kind: 'ROTATION',
    phase: 'SOURCE_BURN_PLANNED',
    bandId: band.id,
    bandIndex: band.index,
    cycleNumber: band.cycleNumber,
    fromLeg,
    toLeg,
    sourceTokenId: band.activePosition.tokenId,
    sourceLiquidity: band.activePosition.liquidity,
    sourceInputToken: band.activePosition.inputToken,
    sourceInputAmountAtomic: band.activePosition.inputAmountAtomic,
    plannedAt: new Date().toISOString(),
    modeledRotationGasUsdg: modeledRotationGasUsdg(gasPrice, inspection.market.ethUsdg),
    trigger: {
      reason: decision.reason,
      headBlock: inspection.headBlock.toString(),
      safeBlock: inspection.safeBlock.toString(),
      headTick: inspection.headPool.tick,
      safeTick: inspection.safePool.tick,
      headConversionBps: inspection.observations[band.id].headConversionBps,
      safeConversionBps: inspection.observations[band.id].safeConversionBps,
      marketAsOfBlock: inspection.market.evidence.asOfBlock,
      marketAsOfBlockHash: inspection.market.evidence.asOfBlockHash,
    },
  }
  if (toLeg === 'BUY') pending.target = freshBuyTarget(state, band, inspection.market, inspection.headPool)
  state.pendingRotation = pending
  state.status = 'ROTATION_PENDING'
  store.writeState(state)
  store.appendAudit('rotation_planned', publicRotation(pending))
  return resumeRotation(state)
}

async function refreshPendingTargetIfNeeded(state, band, pending) {
  const poolState = await getPoolState()
  const target = pending.target
  const targetIsSingleSided =
    pending.toLeg === 'BUY' ? poolState.tick < target.tickLower : poolState.tick >= target.tickUpper
  if (targetIsSingleSided) return poolState
  if (pending.toLeg === 'SELL') {
    pending.target = sellTargetFromAccounting(pending.buyAccounting, pending, poolState)
  } else {
    const market = await fetchMarketEvidence()
    pending.target = freshBuyTarget(state, band, market, poolState)
  }
  pending.targetReplannedAt = new Date().toISOString()
  store.writeState(state)
  store.appendAudit('rotation_target_replanned', publicRotation(pending))
  return poolState
}

async function resumeRotation(state) {
  assertLiveArm()
  const pending = state.pendingRotation
  if (!pending?.id) throw new Error('没有可恢复的有限马丁换腿')
  const band = state.bands.find((candidate) => candidate.id === pending.bandId)
  if (!band) throw new Error(`HARD: 换腿档位 ${pending.bandId} 不存在`)
  const keyPrefix = `rotation_${pending.id.replaceAll('-', '_')}`

  if (pending.phase === 'SOURCE_BURN_PLANNED') {
    const currentPool = await getPoolState()
    const burnKey = `${keyPrefix}_burn`
    if (!state.transactions?.[burnKey]?.request) {
      const source = await readActivePosition(band, currentPool)
      if (source.conversionBps < Number(state.policy.minimumConversionBps)) {
        delete state.pendingRotation
        state.status = 'MARTINGALE_ACTIVE'
        store.writeState(state)
        store.appendAudit('rotation_cancelled_before_signing', {
          id: pending.id,
          conversionBps: source.conversionBps,
        })
        console.log(stringify({ status: 'NO_ACTION', reason: 'CONVERSION_REVERSED_BEFORE_SIGNING' }))
        return
      }
    }
    const burn = buildBurn(band.activePosition, currentPool)
    const removed = await executeKeeperTransaction({
      state,
      key: burnKey,
      label: `${band.id} ${pending.fromLeg}→${pending.toLeg}：撤出并 burn 源 NFT`,
      to: POSITION_MANAGER,
      data: burn.data,
      metadata: {
        rotationId: pending.id,
        tokenId: pending.sourceTokenId,
        minimumUsdgAtomic: burn.minimums.amount0.toString(),
        minimumPairWei: burn.minimums.amount1.toString(),
      },
    })
    await verifyBurnedPosition(removed.receipt, BigInt(pending.sourceTokenId))
    const usdgNet = tokenNetFromReceipt(removed.receipt, USDG)
    const pairNet = tokenNetFromReceipt(removed.receipt, PAIR)
    if (usdgNet < 0n || pairNet < 0n || (usdgNet === 0n && pairNet === 0n)) {
      throw new Error('HARD: 源 NFT burn 后代币净流入无法归因')
    }
    pending.phase = 'SOURCE_BURNED'
    pending.sourceBurnTransaction = removed.hash
    pending.sourceBurnBlock = removed.receipt.blockNumber.toString()
    pending.sourceBurnGasWei = removed.step.gasCostWei
    pending.receivedUsdgAtomic = usdgNet.toString()
    pending.receivedPairWei = pairNet.toString()
    band.phase = `${pending.fromLeg}_BURNED_PENDING_TARGET`
    band.activePosition.liquidity = '0'

    if (pending.fromLeg === 'BUY') {
      pending.buyAccounting = buyFillAccounting({
        spentUsdgAtomic: BigInt(pending.sourceInputAmountAtomic),
        returnedUsdgAtomic: usdgNet,
        receivedPairWei: pairNet,
      })
    } else {
      pending.sellAccounting = sellFillAccounting({
        spentPairWei: BigInt(pending.sourceInputAmountAtomic),
        returnedPairWei: pairNet,
        receivedUsdgAtomic: usdgNet,
      })
    }
    store.writeState(state)
    store.appendAudit('rotation_source_burned', publicRotation(pending))
  }

  if (pending.phase === 'SOURCE_BURNED') {
    const poolState = await getPoolState()
    if (pending.toLeg === 'SELL') {
      pending.target = sellTargetFromAccounting(pending.buyAccounting, pending, poolState)
      pending.availableTargetAtomic = pending.receivedPairWei
    } else {
      if (!pending.target) {
        const market = await fetchMarketEvidence()
        pending.target = freshBuyTarget(state, band, market, poolState)
      }
      const available = BigInt(pending.receivedUsdgAtomic)
      const allocation = BigInt(band.allocationUsdgAtomic)
      pending.availableTargetAtomic = (available < allocation ? available : allocation).toString()
      const previousCost = BigInt(band.cycleAccounting?.netCostUsdgAtomic || 0)
      pending.realizedProfitUsdgAtomic = (available - previousCost).toString()
    }
    if (BigInt(pending.availableTargetAtomic) <= 0n) throw new Error('HARD: 换腿目标没有可部署资产')
    pending.phase = 'TARGET_READY'
    pending.targetPreparedAt = new Date().toISOString()
    store.writeState(state)
    store.appendAudit('rotation_target_ready', publicRotation(pending))
  }

  if (pending.phase !== 'TARGET_READY') throw new Error(`HARD: 未知换腿阶段 ${pending.phase}`)
  const mintKey = `${keyPrefix}_mint`
  const persistedMint = state.transactions?.[mintKey]
  let built
  if (persistedMint?.request) {
    const metadata = persistedMint.metadata
    const leg = metadata.leg
    const token = leg === 'BUY' ? USDG : leg === 'SELL' ? PAIR : null
    if (!token || !metadata.liquidity || !metadata.maximumInputAtomic) {
      throw new Error('HARD: 持久化目标 mint 元数据不完整')
    }
    built = {
      leg,
      token,
      required: BigInt(metadata.maximumInputAtomic),
      position: {
        tickLower: Number(metadata.tickLower),
        tickUpper: Number(metadata.tickUpper),
        tickSpacing: TICK_SPACING,
        liquidity: BigInt(metadata.liquidity),
      },
      data: persistedMint.request.data,
    }
  } else {
    await refreshPendingTargetIfNeeded(state, band, pending)
    const account = loadAccount()
    built = await buildSingleSidedMint(account, {
      leg: pending.toLeg,
      tickLower: pending.target.tickLower,
      tickUpper: pending.target.tickUpper,
      availableAmount: BigInt(pending.availableTargetAtomic),
    })
    await ensureTokenAllowanceExact(
      state,
      built.token,
      built.required,
      `${keyPrefix}_${pending.toLeg.toLowerCase()}`,
    )
    await refreshPendingTargetIfNeeded(state, band, pending)
    built = await buildSingleSidedMint(account, {
      leg: pending.toLeg,
      tickLower: pending.target.tickLower,
      tickUpper: pending.target.tickUpper,
      availableAmount: BigInt(pending.availableTargetAtomic),
    })
    const simulation = await publicClient.call({ account: WALLET, to: POSITION_MANAGER, data: built.data })
    validateBatchMintSimulationData(simulation.data)
  }
  const minted = await executeKeeperTransaction({
    state,
    key: mintKey,
    label: `${band.id} ${pending.fromLeg}→${pending.toLeg}：mint 新单边 NFT`,
    to: POSITION_MANAGER,
    data: built.data,
    metadata: {
      rotationId: pending.id,
      leg: pending.toLeg,
      tickLower: pending.target.tickLower,
      tickUpper: pending.target.tickUpper,
      maximumInputAtomic: built.required.toString(),
      liquidity: built.position.liquidity.toString(),
    },
  })
  const verified = await verifySingleMint(minted.receipt, built)
  const inputNet = tokenNetFromReceipt(minted.receipt, built.token)
  if (inputNet >= 0n) throw new Error('HARD: 目标 mint 回执没有输入代币净支出')
  const actualSpent = -inputNet
  if (actualSpent > BigInt(pending.availableTargetAtomic)) {
    throw new Error('HARD: 目标 mint 实际支出超过归因上限')
  }
  const walletAfter = await walletSnapshot()
  if (walletAfter.nftBalance !== BigInt(state.bands.length)) {
    throw new Error('HARD: 换腿完成后 NFT 数量与档位数不一致')
  }
  const completed = {
    ...pending,
    phase: 'COMPLETE',
    targetTokenId: verified.tokenId.toString(),
    targetLiquidity: verified.liquidity.toString(),
    targetMintTransaction: minted.hash,
    targetMintBlock: minted.receipt.blockNumber.toString(),
    targetInputSpentAtomic: actualSpent.toString(),
    targetMintGasWei: minted.step.gasCostWei,
    completedAt: new Date().toISOString(),
  }
  band.history.push(completed)
  state.history.push({ ...completed, kind: 'ROTATION' })
  if (pending.fromLeg === 'BUY') {
    band.cycleAccounting = {
      cycleNumber: band.cycleNumber,
      ...pending.buyAccounting,
    }
  } else {
    band.lastRealizedCycle = {
      cycleNumber: band.cycleNumber,
      buy: band.cycleAccounting || null,
      sell: pending.sellAccounting,
      realizedProfitUsdgAtomic: pending.realizedProfitUsdgAtomic,
      completedAt: completed.completedAt,
    }
    band.cumulativeRealizedProfitUsdgAtomic = (
      BigInt(band.cumulativeRealizedProfitUsdgAtomic || 0) + BigInt(pending.realizedProfitUsdgAtomic)
    ).toString()
    band.cycleNumber += 1
    delete band.cycleAccounting
  }
  band.phase = `${pending.toLeg}_ACTIVE`
  band.activePosition = {
    tokenId: verified.tokenId.toString(),
    leg: pending.toLeg,
    tickLower: verified.tickLower,
    tickUpper: verified.tickUpper,
    liquidity: verified.liquidity.toString(),
    inputToken: pending.toLeg === 'BUY' ? 'USDG' : 'PAIR',
    inputAmountAtomic: actualSpent.toString(),
    mintTransaction: minted.hash,
    mintBlock: minted.receipt.blockNumber.toString(),
    priceLowUsdg: pending.target.priceLowUsdg,
    priceHighUsdg: pending.target.priceHighUsdg,
    rangeEvidence: pending.target.rangeEvidence,
  }
  band.positions = {
    buyTokenId: pending.toLeg === 'BUY' ? verified.tokenId.toString() : null,
    sellTokenId: pending.toLeg === 'SELL' ? verified.tokenId.toString() : null,
  }
  state.status = 'MARTINGALE_ACTIVE'
  state.lastRotation = {
    id: pending.id,
    bandId: band.id,
    transaction: minted.hash,
    completedAt: completed.completedAt,
  }
  state.accounting = {
    ...(state.accounting || {}),
    cumulativeRealizedProfitUsdgAtomic: state.bands
      .reduce((sum, item) => sum + BigInt(item.cumulativeRealizedProfitUsdgAtomic || 0), 0n)
      .toString(),
    walletUsdgAtomic: walletAfter.usdgAtomic.toString(),
    walletPairWei: walletAfter.pairWei.toString(),
    totalGasWei: canonicalGasSpent(state).toString(),
  }
  delete state.pendingRotation
  state.updatedAt = completed.completedAt
  store.writeState(state)
  store.appendAudit('rotation_complete', {
    id: completed.id,
    bandId: band.id,
    fromLeg: completed.fromLeg,
    toLeg: completed.toLeg,
    sourceBurnTransaction: completed.sourceBurnTransaction,
    targetMintTransaction: completed.targetMintTransaction,
    targetTokenId: completed.targetTokenId,
  })
  console.log(
    stringify({
      status: 'ROTATION_COMPLETE',
      evidenceClass: 'CANONICAL_RECEIPTS_AND_POSITION_POST_STATE',
      bandId: band.id,
      fromLeg: completed.fromLeg,
      toLeg: completed.toLeg,
      tokenId: completed.targetTokenId,
      range: {
        priceLowUsdg: band.activePosition.priceLowUsdg,
        priceHighUsdg: band.activePosition.priceHighUsdg,
      },
      transactions: [completed.sourceBurnTransaction, completed.targetMintTransaction],
    }),
  )
}

function isHardFailure(message) {
  return /^(HARD:)|nonce 隔离|回执失败|回执不再 canonical|人工对账|owner 不匹配|liquidity 与账本不匹配|poolKey/u.test(
    message,
  )
}

function isRetryableRuntimeWait(message) {
  return (
    message.startsWith('WAIT:') ||
    /无法保留要求的 ETH Gas|市场面板|fetch failed|timed? ?out|HTTP 5\d\d|RPC request failed/iu.test(message)
  )
}

async function resumeRotationOrWait(state) {
  try {
    return await resumeRotation(state)
  } catch (error) {
    const message = errorMessage(error)
    if (!isRetryableRuntimeWait(message)) throw error
    console.log(
      stringify({
        status: 'WAITING_PENDING_ROTATION',
        reason: message,
        pendingRotation: publicRotation(state.pendingRotation),
      }),
    )
  }
}

async function keeperOnce() {
  assertLiveArm()
  return store.withLock('martingale-keeper-once', async () => {
    store.assertNotHalted()
    const state = ensureKeeperSchema(store.readState())
    if (!['BUY_LADDER_ACTIVE', 'MARTINGALE_ACTIVE', 'ROTATION_PENDING'].includes(state.status)) {
      throw new Error(`HARD: 当前状态 ${state.status} 不能运行 Keeper`)
    }
    if (state.pendingRotation) return resumeRotationOrWait(state)
    let inspection
    try {
      inspection = await inspectKeeperState(state)
    } catch (error) {
      const message = errorMessage(error)
      if (message.startsWith('DEGRADED:')) {
        console.log(stringify({ status: 'DEGRADED_NO_ACTION', reason: message }))
        return
      }
      throw error
    }
    const decision = decideNextVerifiedBandAction(
      state,
      inspection.observations,
      Number(state.policy.minimumConversionBps),
    )
    if (decision.action === 'NO_ACTION') {
      console.log(
        stringify({
          status: 'NO_ACTION',
          reason: decision.reason,
          observedAt: new Date().toISOString(),
          headBlock: inspection.headBlock,
          safeBlock: inspection.safeBlock,
          pairPriceUsdg: directPairPriceAtTick(inspection.headPool.tick),
          observations: inspection.observations,
          dailyUsage: dailyUsage(state),
        }),
      )
      return
    }
    try {
      await attachMarketEvidence(inspection)
    } catch (error) {
      console.log(
        stringify({
          status: 'DEGRADED_NO_ACTION',
          reason: `可执行市场证据不可用：${errorMessage(error)}`,
          candidate: decision,
        }),
      )
      return
    }
    try {
      return await startRotation(state, inspection, decision)
    } catch (error) {
      const message = errorMessage(error)
      if (isRetryableRuntimeWait(message)) {
        console.log(stringify({ status: 'WAITING_NO_ACTION', reason: message }))
        return
      }
      throw error
    }
  })
}

async function keyCheck() {
  await assertRuntimeIdentity()
  const account = loadAccount()
  console.log(
    stringify({
      status: 'CREDENTIAL_OK',
      expectedWallet: WALLET,
      derivedWallet: account.address,
      automaticSigning: true,
      privateKeyPrinted: false,
    }),
  )
}

async function enter() {
  assertLiveArm()
  return store.withLock('enter', async () => {
    let state = store.readState()
    if (!state) {
      const check = await initialPreflight({ requireReady: true, print: true })
      state = newState(check)
      store.writeState(state)
      store.appendAudit('initial_plan_persisted', { plan: publicPlan(check.fresh.plan) })
    }
    if (['BUY_LADDER_ACTIVE', 'MARTINGALE_ACTIVE'].includes(state.status)) {
      console.log(stringify({ status: 'ALREADY_ACTIVE', bands: state.bands.length }))
      return
    }
    if (state.pendingRotation) return resumeRotation(ensureKeeperSchema(state))
    return resumeInitial(state)
  })
}

async function status() {
  await assertRuntimeIdentity()
  const blockNumber = await publicClient.getBlockNumber()
  const [wallet, poolState] = await Promise.all([walletSnapshot(blockNumber), getPoolState(blockNumber)])
  const rawState = store.readState()
  const state =
    rawState?.strategyId === 'pair-usdg-finite-martingale-live-1' ? ensureKeeperSchema(rawState) : rawState
  const bands = []
  for (const band of state?.bands || []) {
    let chain = null
    let readError = null
    if (BigInt(band.activePosition?.liquidity || 0) > 0n) {
      try {
        const observed = await readActivePosition(band, poolState, blockNumber)
        chain = {
          ownerMatches: true,
          liquidityMatches: true,
          conversionBps: observed.conversionBps,
          underlyingUsdg: formatUnits(observed.amount0UsdgAtomic, 6),
          underlyingPair: formatUnits(observed.amount1PairWei, 18),
        }
      } catch (error) {
        readError = errorMessage(error)
      }
    }
    bands.push({
      id: band.id,
      index: band.index,
      cycleNumber: band.cycleNumber,
      phase: band.phase,
      allocationUsdg: formatUnits(BigInt(band.allocationUsdgAtomic), 6),
      activePosition: band.activePosition
        ? {
            tokenId: band.activePosition.tokenId,
            leg: band.activePosition.leg,
            tickLower: band.activePosition.tickLower,
            tickUpper: band.activePosition.tickUpper,
            liquidity: band.activePosition.liquidity,
            priceLowUsdg:
              band.activePosition.priceLowUsdg || directPairPriceAtTick(band.activePosition.tickUpper),
            priceHighUsdg:
              band.activePosition.priceHighUsdg || directPairPriceAtTick(band.activePosition.tickLower),
            mintTransaction: band.activePosition.mintTransaction,
          }
        : null,
      chain,
      readError,
      cumulativeRealizedProfitUsdg: formatUnits(BigInt(band.cumulativeRealizedProfitUsdgAtomic || 0), 6),
    })
  }
  console.log(
    stringify({
      status: state?.status || 'NOT_STARTED',
      evidenceClass: 'LIVE_CHAIN_READBACK_WITH_LOCAL_STATE',
      observedAt: new Date().toISOString(),
      blockNumber: blockNumber.toString(),
      wallet: WALLET,
      pool: {
        tick: poolState.tick,
        pairPriceUsdg: directPairPriceAtTick(poolState.tick),
        liquidity: poolState.liquidity.toString(),
      },
      balances: {
        eth: formatEther(wallet.ethWei),
        usdg: formatUnits(wallet.usdgAtomic, 6),
        pair: formatUnits(wallet.pairWei, 18),
        spy: formatUnits(wallet.spyWei, 18),
        nfts: wallet.nftBalance.toString(),
      },
      nonce: { latest: wallet.nonceLatest, pending: wallet.noncePending },
      expectedNextNonce: state?.control?.expectedNextNonce ?? null,
      policy: state
        ? {
            minimumConversionBps: state.policy.minimumConversionBps,
            minimumNetProfitBps: state.policy.minimumNetProfitBps,
            maximumDailyTransactions: state.policy.maximumDailyTransactions,
            maximumDailyRotations: state.policy.maximumDailyRotations,
            maximumDailyGasWei: state.policy.maximumDailyGasWei,
            automaticSigning: state.policy.automaticSigning,
            manualPerTransactionApproval: state.policy.manualPerTransactionApproval,
          }
        : null,
      rpc: {
        reads: rpcEndpointSummary(RPC_ENDPOINTS),
        broadcasts: rpcEndpointSummary(BROADCAST_ENDPOINTS),
      },
      pendingRotation: state?.pendingRotation ? publicRotation(state.pendingRotation) : null,
      dailyUsage: state ? dailyUsage(state) : null,
      accounting: state?.accounting || null,
      bands,
      transactions: Object.fromEntries(
        Object.entries(state?.transactions || {}).map(([key, transaction]) => [
          key,
          {
            status: transaction.status,
            hash: transaction.hash,
            confirmedAt: transaction.confirmedAt || null,
          },
        ]),
      ),
    }),
  )
}

async function reconcile() {
  await assertRuntimeIdentity()
  return store.withLock('martingale-reconcile', async () => {
    const state = ensureKeeperSchema(store.readState())
    if (state.pendingRotation) {
      assertLiveArm()
      return resumeRotation(state)
    }
    const inspection = await inspectKeeperState(state)
    console.log(
      stringify({
        status: 'CONSISTENT',
        evidenceClass: 'LIVE_CHAIN_OWNER_LIQUIDITY_POOL_NONCE_AND_SAFE_BLOCK_READBACK',
        headBlock: inspection.headBlock,
        safeBlock: inspection.safeBlock,
        observations: inspection.observations,
      }),
    )
  })
}

async function main() {
  const command = process.argv[2] || 'preflight'
  if (command === 'plan' || command === 'preflight') await initialPreflight()
  else if (command === 'enter' || command === 'resume') await enter()
  else if (command === 'status') await status()
  else if (command === 'key-check') await keyCheck()
  else if (command === 'keeper-once') await keeperOnce()
  else if (command === 'reconcile') await reconcile()
  else throw new Error(`未知命令：${command}`)
}

main().catch((error) => {
  const command = process.argv[2] || 'preflight'
  const message = errorMessage(error)
  try {
    store.appendAudit('command_failed', { command, error: message })
    if (['keeper-once', 'reconcile', 'resume'].includes(command) && isHardFailure(message)) {
      store.halt({ command, reason: message })
    }
  } catch {
    // Preserve the primary failure if local audit storage is unavailable.
  }
  console.error(`ERROR: ${message}`)
  process.exitCode = 1
})
