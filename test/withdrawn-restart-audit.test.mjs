import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem'
import { auditWithdrawnWalletRestart } from '../lib/withdrawn-restart-audit.mjs'
import {
  directPairPriceAtTick,
  maximumAlignedBuyTickForPriceFloor,
  planAdaptiveHardFloorBuyLadder,
} from '../lib/finite-martingale.mjs'
import { sqrtRatioAtTick } from '../lib/uniswap-v4-position.mjs'

const walletAddress = '0x1111111111111111111111111111111111111111'
const usdgAddress = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const pairAddress = '0x6b1d42927b1a84ec28fa88d4fc6fa7af404966be'
const destination = '0x2222222222222222222222222222222222222222'
const transfer = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)'])
const hash = (number) => `0x${number.toString(16).padStart(64, '0')}`
const blockHash = (number) => hash(Number(number) + 10_000)
const tokenLog = (address, from, to, value) => ({
  address,
  topics: encodeEventTopics({ abi: transfer, eventName: 'Transfer', args: { from, to } }),
  data: encodeAbiParameters([{ type: 'uint256' }], [value]),
})

function fixture() {
  const finalWithdrawalBlock = 100n
  const transactions = new Map()
  const receipts = new Map()
  const burnHash = hash(58)
  transactions.set(burnHash, { from: walletAddress, nonce: 58, value: 0n })
  receipts.set(burnHash, {
    status: 'success',
    transactionHash: burnHash,
    blockNumber: finalWithdrawalBlock,
    blockHash: blockHash(finalWithdrawalBlock),
    gasUsed: 1n,
    effectiveGasPrice: 1n,
    logs: [],
  })
  const hashes = [59, 60, 61, 62, 63].map(hash)
  const logs = [
    [],
    [tokenLog(pairAddress, walletAddress, destination, 9_000_000_000_000_000_000_000n)],
    [tokenLog(usdgAddress, walletAddress, destination, 4_000_000n)],
    [],
    [tokenLog(usdgAddress, destination, walletAddress, 50_000_000n)],
  ]
  for (const [index, txHash] of hashes.entries()) {
    const number = 101n + BigInt(index)
    transactions.set(txHash, {
      from: walletAddress,
      nonce: 59 + index,
      value: index === 4 ? 20_000_000_000_000_000n : 0n,
    })
    receipts.set(txHash, {
      status: 'success',
      transactionHash: txHash,
      blockNumber: number,
      blockHash: blockHash(number),
      gasUsed: 21_000n,
      effectiveGasPrice: 100_000_000n,
      logs: logs[index],
    })
  }
  const client = {
    async getTransaction({ hash: txHash }) {
      return transactions.get(txHash)
    },
    async getTransactionReceipt({ hash: txHash }) {
      return receipts.get(txHash)
    },
    async getBlock({ blockNumber }) {
      return { hash: blockHash(blockNumber) }
    },
    async getTransactionCount() {
      return 59
    },
  }
  const previous = {
    strategyId: 'pair-usdg-finite-martingale-live-1',
    status: 'WITHDRAWN',
    createdAt: '2026-01-01T00:00:00Z',
    control: { expectedNextNonce: 59 },
    principal: { initialUsdgAtomic: '44000000' },
    accounting: { walletUsdgAtomic: '4000000', walletPairWei: '9000000000000000000000' },
    lastWithdrawal: {
      completedAt: '2026-01-02T00:00:00Z',
      burns: { B5: { hash: burnHash, blockNumber: '100' } },
    },
  }
  const priorWallet = { usdgAtomic: 4_000_000n, pairWei: 9_000_000_000_000_000_000_000n, nftBalance: 0n }
  const wallet = {
    usdgAtomic: 50_000_000n,
    pairWei: 0n,
    spyWei: 0n,
    nftBalance: 0n,
    nonceLatest: 64,
    noncePending: 64,
  }
  return { client, previous, priorWallet, wallet, hashes, receipts }
}

test('withdrawn restart proves all five nonce transitions and token flows', async () => {
  const input = fixture()
  const source = await auditWithdrawnWalletRestart({
    ...input,
    walletAddress,
    usdgAddress,
    pairAddress,
  })
  assert.equal(source.kind, 'CANONICAL_AUDITED_WITHDRAWN_WALLET_RESTART')
  assert.equal(source.reentryUsdgAtomic, '50000000')
  assert.equal(source.externalTransactions.length, 5)
  assert.equal(source.externalTransactions[4].usdgFlowAtomic, '50000000')
  assert.equal(source.provenance, 'EXTERNAL_WALLET_ACTIVITY_NOT_STRATEGY_PROFIT')
})

test('withdrawn restart rejects missing or noncanonical external transactions', async () => {
  const input = fixture()
  await assert.rejects(
    auditWithdrawnWalletRestart({
      ...input,
      hashes: input.hashes.slice(1),
      walletAddress,
      usdgAddress,
      pairAddress,
    }),
    /数量与 nonce 差额不一致/,
  )
  input.receipts.get(input.hashes[2]).blockHash = hash(999)
  await assert.rejects(
    auditWithdrawnWalletRestart({ ...input, walletAddress, usdgAddress, pairAddress }),
    /不再 canonical/,
  )
})

test('five-band 0.004 floor rounds upward to the nearest valid tick', () => {
  const tick = maximumAlignedBuyTickForPriceFloor(0.004)
  const plan = planAdaptiveHardFloorBuyLadder({
    bands: [1000, 1500, 2000, 2500, 3000].map((weightBps, index) => ({
      id: `B${index + 1}`,
      index,
      weightBps,
      allocationUsdgAtomic: BigInt(Math.floor((50_000_000 * weightBps) / 10_000)),
    })),
    currentTick: 327_584,
    sqrtPriceX96: sqrtRatioAtTick(327_584),
    minimumBuyPriceUsdg: 0.004,
  })
  assert.equal(plan.selected.bands.length, 5)
  assert.equal(plan.selected.bands.at(-1).tickUpper, tick)
  assert.ok(directPairPriceAtTick(tick) >= 0.004)
  assert.ok(directPairPriceAtTick(tick + 100) < 0.004)
})
