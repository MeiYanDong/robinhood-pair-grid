import { decodeEventLog, encodeFunctionData, parseAbi } from 'viem'

const ABI = parseAbi([
  'function transfer(address,uint256) returns(bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
])
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()

// This only accepts one explicitly identified, already canonical PAIR transfer.
// It never prepares, signs or broadcasts a transaction.
export async function reconcileInternalTransfer({
  store,
  clients,
  wallet,
  token,
  hash,
  recipient,
  amount,
  consensus,
  inspect,
  now = () => new Date().toISOString(),
}) {
  if (clients.length < 2) throw new Error('HARD: internal transfer requires two RPCs')
  if (
    !/^0x[0-9a-fA-F]{64}$/.test(hash) ||
    !/^0x[0-9a-fA-F]{40}$/.test(recipient) ||
    equal(recipient, wallet) ||
    /^0x0{40}$/i.test(recipient) ||
    amount <= 0n
  ) {
    throw new Error('HARD: invalid explicit internal transfer identity')
  }
  return store.withLock('martingale-reconcile-internal-transfer', async () => {
    const state = store.readState()
    if (
      !state ||
      state.status !== 'MARTINGALE_ACTIVE' ||
      state.pending ||
      state.pendingRotation ||
      state.pendingRebase ||
      Object.values(state.transactions || {}).some((t) => t.status !== 'CANONICAL_SUCCESS')
    ) {
      throw new Error('HARD: incomplete strategy transaction state')
    }
    const report = await consensus()
    const previous = state.internalTransfers?.[hash]
    const expected = state.control?.expectedNextNonce
    if (
      !report.verified ||
      report.nonceLatest !== report.noncePending ||
      !Number.isInteger(expected) ||
      report.nonceLatest !== expected + (previous ? 0 : 1)
    ) {
      throw new Error('HARD: unexplained nonce gap or pending transaction')
    }
    const nonce = previous ? previous.nonce : expected
    const data = encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [recipient, amount] })
    const receipts = await Promise.all(
      clients.map(async (client) => {
        const [tx, receipt] = await Promise.all([
          client.getTransaction({ hash }),
          client.getTransactionReceipt({ hash }),
        ])
        if (
          !equal(tx.hash, hash) ||
          !equal(receipt.transactionHash, hash) ||
          !equal(tx.from, wallet) ||
          !equal(tx.to, token) ||
          tx.nonce !== nonce ||
          tx.value !== 0n ||
          !equal(tx.input, data) ||
          receipt.status !== 'success' ||
          receipt.blockNumber > report.commonSafeBlock ||
          tx.blockNumber !== receipt.blockNumber ||
          !equal(tx.blockHash, receipt.blockHash)
        ) {
          throw new Error('HARD: transfer identity or canonical receipt mismatch')
        }
        const block = await client.getBlock({ blockNumber: receipt.blockNumber })
        if (!equal(block.hash, receipt.blockHash)) throw new Error('HARD: transfer receipt is not canonical')
        if (receipt.logs.length !== 1 || !equal(receipt.logs[0].address, token))
          throw new Error('HARD: unexpected transfer receipt logs')
        const event = /** @type {any} */ (
          decodeEventLog({ abi: ABI, data: receipt.logs[0].data, topics: receipt.logs[0].topics })
        )
        if (
          event.eventName !== 'Transfer' ||
          !equal(event.args.from, wallet) ||
          !equal(event.args.to, recipient) ||
          event.args.value !== amount
        )
          throw new Error('HARD: transfer event mismatch')
        return {
          blockNumber: receipt.blockNumber.toString(),
          blockHash: receipt.blockHash,
          gasWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
        }
      }),
    )
    if (receipts.some((receipt) => JSON.stringify(receipt) !== JSON.stringify(receipts[0])))
      throw new Error('HARD: RPC transfer receipt disagreement')
    if (
      previous &&
      (previous.nonce !== nonce ||
        !equal(previous.recipient, recipient) ||
        previous.amountWei !== amount.toString())
    )
      throw new Error('HARD: existing internal transfer record mismatch')
    const recovered = structuredClone(state)
    recovered.control.expectedNextNonce = report.nonceLatest
    // Validate all normal NFT, pool, wallet and nonce gates before persistence.
    const inspection = await inspect(recovered)
    const fresh = await consensus()
    if (
      !fresh.verified ||
      fresh.nonceLatest !== report.nonceLatest ||
      fresh.noncePending !== report.nonceLatest
    )
      throw new Error('HARD: nonce changed during recovery')
    if (previous) return { status: 'ALREADY_RECONCILED', hash, expectedNextNonce: expected }
    const record = {
      hash,
      nonce,
      sender: wallet,
      recipient,
      token,
      amountWei: amount.toString(),
      classification: 'INTERNAL_TRANSFER_BETWEEN_USER_CONTROLLED_WALLETS',
      strategyProfitDeltaUsdgAtomic: '0',
      externalCapitalDeltaUsdgAtomic: '0',
      ...receipts[0],
      reconciledAt: now(),
    }
    recovered.internalTransfers = { ...recovered.internalTransfers, [hash]: record }
    recovered.reconciledAt = record.reconciledAt
    store.appendAudit('internal_transfer_reconcile_verified', record)
    store.writeState(recovered)
    store.appendAudit('internal_transfer_reconciled', {
      hash,
      expectedNextNonce: recovered.control.expectedNextNonce,
    })
    return {
      status: 'RECONCILED',
      record,
      expectedNextNonce: recovered.control.expectedNextNonce,
      observations: inspection.observations,
      haltStillRequiresExplicitClear: Boolean(store.readHalt()),
    }
  })
}
