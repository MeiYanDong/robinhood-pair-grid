import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  parseAbi,
  parseAbiParameters,
  parseEther,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { humanPairPriceFromTick } from '../lib/ranges.mjs'

const RPC_URL = process.env.RH_RPC_URL || ''
if (process.env.PAIR_GRID_FORK_TEST !== '1' || !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(RPC_URL)) {
  throw new Error('该工具只能在 PAIR_GRID_FORK_TEST=1 的 localhost Anvil fork 上运行')
}

const targetTick = Number(process.argv[2])
if (!Number.isInteger(targetTick)) throw new Error('用法: node scripts/fork-drive-price.mjs <targetRawTick>')

const CHAIN_ID = 4663
const SPY = getAddress('0x117cc2133c37B721F49dE2A7a74833232B3B4C0C')
const PAIR = getAddress('0x6b1d42927B1a84eC28Fa88d4fC6FA7AF404966be')
const PERMIT2 = getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3')
const UNIVERSAL_ROUTER = getAddress('0x8876789976dEcBfCbBbe364623C63652db8C0904')
const STATE_VIEW = getAddress('0xF3334192D15450CdD385c8B70e03f9A6bD9E673b')
const POOL_MANAGER = getAddress('0x8366a39CC670B4001A1121B8F6A443A643e40951')
const HOOK = getAddress('0x16D1560630Ce74af4478d9b8AD46548A092A2000')
const POOL_ID = '0xf224a070c8626c890a085b258cf562ee4bf052b6d1d59104b3b44d722640c001'

const chain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain Local Fork',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
})
const transport = http(RPC_URL, { timeout: 30_000, retryCount: 0 })
/** @type {any} viem's custom-chain generics are isolated at this fork adapter boundary. */
const publicClient = createPublicClient({ chain, transport })
/** @type {any} */
const testClient = createTestClient({ chain, mode: 'anvil', transport })

const traderPrivateKey = process.env.ANVIL_TRADER_PRIVATE_KEY
if (!/^0x[0-9a-fA-F]{64}$/.test(traderPrivateKey || '')) {
  throw new Error('本地 fork 需要 ANVIL_TRADER_PRIVATE_KEY；不要把它写入仓库')
}
const trader = privateKeyToAccount(/** @type {`0x${string}`} */ (traderPrivateKey))
/** @type {any} */
const traderClient = createWalletClient({ account: trader, chain, transport })

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
])
const PERMIT2_ABI = parseAbi([
  'function approve(address token,address spender,uint160 amount,uint48 expiration)',
])
const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
])
const UNIVERSAL_ROUTER_ABI = parseAbi([
  'function execute(bytes commands,bytes[] inputs,uint256 deadline) payable',
])
const poolKey = {
  currency0: SPY,
  currency1: PAIR,
  fee: 10_000,
  tickSpacing: 200,
  hooks: HOOK,
}

async function tick() {
  const [, currentTick] = await publicClient.readContract({
    address: STATE_VIEW,
    abi: STATE_VIEW_ABI,
    functionName: 'getSlot0',
    args: [POOL_ID],
  })
  return currentTick
}

async function send(client, request) {
  const hash = await client.writeContract(request)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`fork 交易失败: ${hash}`)
  return receipt
}

async function seedTrader() {
  await testClient.setBalance({ address: trader.address, value: parseEther('100') })
  const desiredSpy = parseEther('30')
  const desiredPair = parseEther('8000000')
  const [spyBalance, pairBalance] = await Promise.all([
    publicClient.readContract({
      address: SPY,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [trader.address],
    }),
    publicClient.readContract({
      address: PAIR,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [trader.address],
    }),
  ])
  await testClient.impersonateAccount({ address: POOL_MANAGER })
  const poolManagerClient = createWalletClient({ account: POOL_MANAGER, chain, transport })
  if (spyBalance < desiredSpy) {
    await testClient.setBalance({ address: POOL_MANAGER, value: parseEther('10') })
    await send(poolManagerClient, {
      address: SPY,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [trader.address, desiredSpy - spyBalance],
      account: POOL_MANAGER,
    })
  }
  if (pairBalance < desiredPair) {
    await send(poolManagerClient, {
      address: PAIR,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [trader.address, desiredPair - pairBalance],
      account: POOL_MANAGER,
    })
  }
  await testClient.stopImpersonatingAccount({ address: POOL_MANAGER })

  for (const [token, amount] of [
    [SPY, desiredSpy],
    [PAIR, desiredPair],
  ]) {
    await send(traderClient, {
      address: token,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [PERMIT2, amount],
    })
    await send(traderClient, {
      address: PERMIT2,
      abi: PERMIT2_ABI,
      functionName: 'approve',
      args: [token, UNIVERSAL_ROUTER, amount, BigInt(Math.floor(Date.now() / 1_000) + 3_600)],
    })
  }
}

function swapData(zeroForOne, amountIn) {
  const inputToken = zeroForOne ? SPY : PAIR
  const outputToken = zeroForOne ? PAIR : SPY
  const swap = encodeAbiParameters(
    parseAbiParameters(
      '((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData) params',
    ),
    /** @type {any} */ ([[poolKey, zeroForOne, amountIn, 0n, 0n, '0x']]),
  )
  const settle = encodeAbiParameters(parseAbiParameters('address currency,uint256 amount,bool payerIsUser'), [
    inputToken,
    amountIn,
    true,
  ])
  const take = encodeAbiParameters(parseAbiParameters('address currency,address recipient,uint256 amount'), [
    outputToken,
    trader.address,
    0n,
  ])
  const v4Input = encodeAbiParameters(parseAbiParameters('bytes actions,bytes[] params'), [
    '0x060b0e',
    [swap, settle, take],
  ])
  return encodeFunctionData({
    abi: UNIVERSAL_ROUTER_ABI,
    functionName: 'execute',
    args: ['0x10', [v4Input], BigInt(Math.floor(Date.now() / 1_000) + 600)],
  })
}

await seedTrader()
let currentTick = await tick()
const startTick = currentTick
const movingUp = targetTick > currentTick
for (let iteration = 0; iteration < 30; iteration += 1) {
  if ((movingUp && currentTick >= targetTick) || (!movingUp && currentTick <= targetTick)) break
  const zeroForOne = !movingUp
  const amountIn = zeroForOne ? parseEther('0.5') : parseEther('500000')
  const data = swapData(zeroForOne, amountIn)
  const hash = await traderClient.sendTransaction({ account: trader, to: UNIVERSAL_ROUTER, data })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`fork 推价交易失败: ${hash}`)
  currentTick = await tick()
  console.log(
    JSON.stringify({
      iteration: iteration + 1,
      hash,
      tick: currentTick,
      pairPriceSpy: humanPairPriceFromTick(currentTick),
    }),
  )
}

const [spyBalance, pairBalance, ethBalance] = await Promise.all([
  publicClient.readContract({
    address: SPY,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [trader.address],
  }),
  publicClient.readContract({
    address: PAIR,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [trader.address],
  }),
  publicClient.getBalance({ address: trader.address }),
])
const reached = movingUp ? currentTick >= targetTick : currentTick <= targetTick
console.log(
  JSON.stringify(
    {
      status: reached ? 'TARGET_CROSSED' : 'TARGET_NOT_REACHED',
      startTick,
      targetTick,
      finalTick: currentTick,
      pairPriceSpy: humanPairPriceFromTick(currentTick),
      trader: {
        address: trader.address,
        eth: formatEther(ethBalance),
        spyWei: spyBalance.toString(),
        pairWei: pairBalance.toString(),
      },
    },
    null,
    2,
  ),
)
if (!reached) process.exitCode = 1
