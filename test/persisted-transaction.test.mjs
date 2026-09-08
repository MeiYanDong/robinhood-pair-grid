import assert from 'node:assert/strict'
import test from 'node:test'

import { keccak256 } from 'viem'

import {
  deserializeLegacyRequest,
  executePersistedTransaction,
  serializeLegacyRequest,
  transactionMatchesRequest,
} from '../lib/persisted-transaction.mjs'

const WALLET = /** @type {const} */ ('0x1111111111111111111111111111111111111111')
const TARGET = /** @type {const} */ ('0x2222222222222222222222222222222222222222')
const SERIALIZED = /** @type {const} */ ('0x1234')
const HASH = keccak256(SERIALIZED)

function request() {
  return {
    chainId: 4663,
    nonce: 7,
    to: TARGET,
    value: 9n,
    data: /** @type {const} */ ('0xabcd'),
    gas: 120_000n,
    gasPrice: 3n,
    type: /** @type {const} */ ('legacy'),
  }
}

test('legacy transaction requests round-trip without bigint or address loss', () => {
  assert.deepEqual(deserializeLegacyRequest(serializeLegacyRequest(request())), request())
  assert.equal(
    transactionMatchesRequest(
      { from: WALLET, nonce: 7, to: TARGET, value: 9n, input: '0xabcd' },
      request(),
      WALLET,
    ),
    true,
  )
  assert.equal(
    transactionMatchesRequest(
      { from: WALLET, nonce: 7, to: TARGET, value: 9n, input: '0xdead' },
      request(),
      WALLET,
    ),
    false,
  )
})

test('signed intent is persisted before raw broadcast and canonical receipt advances nonce', async () => {
  const events = []
  const state = { status: 'PLANNED', control: { expectedNextNonce: 0 }, transactions: {} }
  const store = {
    writeState(value) {
      events.push(`write:${value.transactions.approve?.status || 'none'}`)
    },
    appendAudit(event) {
      events.push(`audit:${event}`)
    },
  }
  const publicClient = {
    async getTransactionCount() {
      return 0
    },
    async call() {},
    async estimateGas() {
      return 100_000n
    },
    async getGasPrice() {
      return 2n
    },
    async getBalance() {
      return 10_000_000n
    },
    async getTransactionReceipt() {
      throw new Error('not found')
    },
    async waitForTransactionReceipt() {
      return {
        status: 'success',
        blockNumber: 10n,
        blockHash: `0x${'33'.repeat(32)}`,
        gasUsed: 90_000n,
        effectiveGasPrice: 2n,
      }
    },
    async getBlockNumber() {
      return 10n
    },
    async getBlock() {
      return { hash: `0x${'33'.repeat(32)}` }
    },
  }
  const walletClient = {
    async sendRawTransaction() {
      assert.ok(events.includes('write:SIGNED_INTENT'))
      events.push('broadcast-call')
      return HASH
    },
  }
  const result = await executePersistedTransaction({
    state,
    key: 'approve',
    label: 'approval',
    to: TARGET,
    data: '0xabcd',
    account: {
      async signTransaction() {
        return SERIALIZED
      },
    },
    walletClient,
    publicClient,
    walletAddress: WALLET,
    chainId: 4663,
    store,
    minimumFinalEthWei: 1n,
    maximumOperationGasWei: 1_000_000n,
    confirmationDepth: 1n,
  })
  assert.equal(result.hash, HASH)
  assert.equal(state.transactions.approve.status, 'CANONICAL_SUCCESS')
  assert.equal(state.control.expectedNextNonce, 1)
  assert.ok(events.indexOf('write:SIGNED_INTENT') < events.indexOf('broadcast-call'))
})

test('a known exact pending transaction resumes without a second broadcast', async () => {
  const persistedRequest = request()
  const state = {
    status: 'PENDING_MINT',
    control: { expectedNextNonce: 7 },
    transactions: {
      mint: {
        status: 'SIGNED_INTENT',
        hash: HASH,
        request: serializeLegacyRequest(persistedRequest),
        metadata: {},
      },
    },
  }
  let broadcasts = 0
  const publicClient = {
    async getTransactionReceipt() {
      throw new Error('not indexed yet')
    },
    async getTransactionCount({ blockTag }) {
      return blockTag === 'latest' ? 7 : 8
    },
    async getTransaction() {
      return { from: WALLET, nonce: 7, to: TARGET, value: 9n, input: '0xabcd' }
    },
    async waitForTransactionReceipt() {
      return {
        status: 'success',
        blockNumber: 20n,
        blockHash: `0x${'44'.repeat(32)}`,
        gasUsed: 1n,
        effectiveGasPrice: 1n,
      }
    },
    async getBlockNumber() {
      return 20n
    },
    async getBlock() {
      return { hash: `0x${'44'.repeat(32)}` }
    },
  }
  await executePersistedTransaction({
    state,
    key: 'mint',
    label: 'mint',
    to: TARGET,
    data: '0xabcd',
    value: 9n,
    account: {
      async signTransaction() {
        return SERIALIZED
      },
    },
    walletClient: {
      async sendRawTransaction() {
        broadcasts += 1
        return HASH
      },
    },
    publicClient,
    walletAddress: WALLET,
    chainId: 4663,
    store: { writeState() {}, appendAudit() {} },
    minimumFinalEthWei: 1n,
    maximumOperationGasWei: 1_000n,
    confirmationDepth: 1n,
  })
  assert.equal(broadcasts, 0)
  assert.equal(state.control.expectedNextNonce, 8)
})
