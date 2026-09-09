import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeFunctionData, encodeEventTopics, encodeAbiParameters, parseAbi } from 'viem'
import { reconcileInternalTransfer } from '../lib/internal-transfer-recovery.mjs'
const wallet = '0x1111111111111111111111111111111111111111'
const recipient = '0x2222222222222222222222222222222222222222'
const token = '0x3333333333333333333333333333333333333333'
const hash = `0x${'a'.repeat(64)}`
const blockHash = `0x${'b'.repeat(64)}`
const abi = parseAbi([
  'function transfer(address,uint256) returns(bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
])
function fixture() {
  const state = {
    status: 'MARTINGALE_ACTIVE',
    strategyId: 'pair-usdg-finite-martingale-live-1',
    wallet,
    control: { expectedNextNonce: 28 },
    accounting: { profit: '0', pair: '7' },
    bands: [{ id: 'B1' }],
    transactions: { mint: { status: 'CANONICAL_SUCCESS' } },
  }
  const tx = {
    hash,
    from: wallet,
    to: token,
    nonce: 28,
    value: 0n,
    input: encodeFunctionData({ abi, functionName: 'transfer', args: [recipient, 30000n] }),
    blockNumber: 10n,
    blockHash,
  }
  const receipt = {
    transactionHash: hash,
    status: 'success',
    blockNumber: 10n,
    blockHash,
    gasUsed: 2n,
    effectiveGasPrice: 3n,
    logs: [
      {
        address: token,
        topics: encodeEventTopics({ abi, eventName: 'Transfer', args: { from: wallet, to: recipient } }),
        data: encodeAbiParameters([{ type: 'uint256' }], [30000n]),
      },
    ],
  }
  let saved = state
  const audits = []
  const client = {
    getTransaction: async () => tx,
    getTransactionReceipt: async () => receipt,
    getBlock: async () => ({ hash: blockHash }),
  }
  const report = { verified: true, nonceLatest: 29, noncePending: 29, commonSafeBlock: 20n }
  const input = {
    store: {
      readState: () => saved,
      withLock: async (_cmd, fn) => fn(),
      appendAudit: (event, details) => audits.push({ event, details }),
      writeState: (s) => {
        saved = s
      },
      readHalt: () => ({ reason: 'nonce' }),
    },
    clients: [client, client],
    wallet,
    token,
    hash,
    recipient,
    amount: 30000n,
    consensus: async () => report,
    inspect: async (candidate) => {
      assert.equal(candidate.control.expectedNextNonce, 29)
      return { observations: { B1: { headConversionBps: 0 } } }
    },
    now: () => '2026-09-09T00:00:00Z',
  }
  return { input, state, tx, receipt, report, client, audits, saved: () => saved }
}
test('canonical internal transfer advances only nonce and records classification; retry is idempotent', async () => {
  const f = fixture()
  const r = await reconcileInternalTransfer(f.input)
  assert.equal(r.status, 'RECONCILED')
  assert.equal(r.haltStillRequiresExplicitClear, true)
  assert.equal(f.saved().control.expectedNextNonce, 29)
  assert.deepEqual(f.saved().accounting, f.state.accounting)
  assert.deepEqual(f.saved().bands, f.state.bands)
  assert.deepEqual(f.saved().transactions, f.state.transactions)
  assert.equal(r.record.strategyProfitDeltaUsdgAtomic, '0')
  assert.equal(r.record.externalCapitalDeltaUsdgAtomic, '0')
  assert.equal(r.record.gasWei, '6')
  assert.equal((await reconcileInternalTransfer(f.input)).status, 'ALREADY_RECONCILED')
  assert.equal(f.audits.length, 2)
})
const failures = {
  'one RPC': (f) => {
    f.input.clients = [f.client]
  },
  'bad hash': (f) => {
    f.input.hash = 'bad'
  },
  'bad recipient': (f) => {
    f.input.recipient = 'bad'
  },
  'self transfer': (f) => {
    f.input.recipient = wallet
  },
  'zero recipient': (f) => {
    f.input.recipient = `0x${'0'.repeat(40)}`
  },
  'zero amount': (f) => {
    f.input.amount = 0n
  },
  'missing state': (f) => {
    f.input.store.readState = () => null
  },
  'wrong wallet': (f) => {
    f.state.wallet = recipient
  },
  'wrong strategy': (f) => {
    f.state.strategyId = 'legacy'
  },
  'wrong phase': (f) => {
    f.state.status = 'PENDING'
  },
  pending: (f) => {
    f.state['pending'] = {}
  },
  rotation: (f) => {
    f.state['pendingRotation'] = {}
  },
  rebase: (f) => {
    f.state['pendingRebase'] = {}
  },
  'unknown transaction': (f) => {
    f.state.transactions.mint.status = 'SIGNED'
  },
  'unverified RPC': (f) => {
    f.report.verified = false
  },
  'pending nonce': (f) => {
    f.report.noncePending = 30
  },
  'nonce gap': (f) => {
    f.report.nonceLatest = 30
    f.report.noncePending = 30
  },
  'missing expected': (f) => {
    delete f.state.control.expectedNextNonce
  },
  'wrong hash': (f) => {
    f.tx.hash = blockHash
  },
  'wrong receipt hash': (f) => {
    f.receipt.transactionHash = blockHash
  },
  'wrong sender': (f) => {
    f.tx.from = recipient
  },
  'wrong token': (f) => {
    f.tx.to = recipient
  },
  'wrong nonce': (f) => {
    f.tx.nonce = 27
  },
  'ETH value': (f) => {
    f.tx.value = 1n
  },
  'wrong amount': (f) => {
    f.input.amount = 30001n
  },
  'failed receipt': (f) => {
    f.receipt.status = 'reverted'
  },
  unconfirmed: (f) => {
    f.report.commonSafeBlock = 9n
  },
  'transaction block mismatch': (f) => {
    f.tx.blockNumber = 9n
  },
  'transaction block hash mismatch': (f) => {
    f.tx.blockHash = hash
  },
  reorg: (f) => {
    f.client.getBlock = async () => ({ hash })
  },
  'extra logs': (f) => {
    f.receipt.logs.push(f.receipt.logs[0])
  },
  'wrong log token': (f) => {
    f.receipt.logs[0].address = recipient
  },
  'wrong log amount': (f) => {
    f.receipt.logs[0].data = encodeAbiParameters([{ type: 'uint256' }], [1n])
  },
  'RPC receipt disagreement': (f) => {
    f.input.clients[1] = { ...f.client, getTransactionReceipt: async () => ({ ...f.receipt, gasUsed: 3n }) }
  },
  'NFT mismatch': (f) => {
    f.input.inspect = async () => {
      throw new Error('NFT mismatch')
    }
  },
  'nonce race': (f) => {
    let n = 0
    f.input.consensus = async () => (++n === 1 ? f.report : { ...f.report, nonceLatest: 30 })
  },
}
for (const [name, change] of Object.entries(failures))
  test(`rejects ${name} without saving`, async () => {
    const f = fixture()
    change(f)
    await assert.rejects(reconcileInternalTransfer(f.input))
    assert.equal(f.saved(), f.state)
    assert.equal(f.audits.length, 0)
  })
test('rejects a conflicting previously recorded classification', async () => {
  const f = fixture()
  await reconcileInternalTransfer(f.input)
  f.saved()['internalTransfers'][hash].recipient = token
  await assert.rejects(reconcileInternalTransfer(f.input), /record mismatch/)
})
