import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyRpcConsensus } from '../lib/rpc-consensus.mjs'

const WALLET = '0x014E58cF3568641684a8278B50003F19fC87218B'
const HASH = `0x${'ab'.repeat(32)}`

function client(overrides = {}) {
  return {
    getChainId: async () => overrides.chainId ?? 4663,
    getBlockNumber: async () => overrides.head ?? 1_000n,
    getBlock: async () => ({ hash: overrides.hash ?? HASH }),
    getTransactionCount: async ({ blockTag }) =>
      blockTag === 'pending' ? (overrides.noncePending ?? 10) : (overrides.nonceLatest ?? 10),
    pool: overrides.pool || {
      sqrtPriceX96: 123n,
      tick: 319_000,
      protocolFee: 0,
      lpFee: 10_000,
      liquidity: 456n,
    },
  }
}

const readPoolState = async (source) => source.pool

test('RPC consensus verifies common safe block, nonce and pool state', async () => {
  const result = await verifyRpcConsensus({
    clients: [client({ head: 1_006n }), client({ head: 1_000n })],
    expectedChainId: 4663,
    walletAddress: WALLET,
    confirmationDepth: 128n,
    readPoolState,
  })
  assert.equal(result.endpointCount, 2)
  assert.equal(result.minimumHead, 1_000n)
  assert.equal(result.maximumHead, 1_006n)
  assert.equal(result.commonSafeBlock, 873n)
  assert.equal(result.nonceLatest, 10)
})

test('RPC consensus fails closed on too few providers, excessive lag or mismatched canonical data', async () => {
  const base = {
    expectedChainId: 4663,
    walletAddress: WALLET,
    confirmationDepth: 128n,
    readPoolState,
  }
  await assert.rejects(() => verifyRpcConsensus({ ...base, clients: [client()] }), /至少需要两个/u)
  await assert.rejects(
    () => verifyRpcConsensus({ ...base, clients: [client({ head: 1_200n }), client({ head: 1_000n })] }),
    /链头偏差/u,
  )
  await assert.rejects(
    () => verifyRpcConsensus({ ...base, clients: [client(), client({ hash: `0x${'cd'.repeat(32)}` })] }),
    /hash/u,
  )
  await assert.rejects(
    () => verifyRpcConsensus({ ...base, clients: [client(), client({ noncePending: 11 })] }),
    /nonce/u,
  )
  await assert.rejects(
    () =>
      verifyRpcConsensus({
        ...base,
        clients: [client(), client({ pool: { ...client().pool, tick: 319_100 } })],
      }),
    /池状态/u,
  )
})
