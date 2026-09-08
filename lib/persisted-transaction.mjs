import { getAddress, keccak256 } from 'viem'

/** @param {any} value */
function errorMessage(value) {
  return value?.shortMessage || value?.message || String(value)
}

/** @param {any} request */
export function serializeLegacyRequest(request) {
  return {
    chainId: Number(request.chainId),
    nonce: Number(request.nonce),
    to: getAddress(request.to),
    value: BigInt(request.value || 0n).toString(),
    data: request.data,
    gas: BigInt(request.gas).toString(),
    gasPrice: BigInt(request.gasPrice).toString(),
    type: 'legacy',
  }
}

/** @param {any} request */
export function deserializeLegacyRequest(request) {
  return {
    chainId: Number(request.chainId),
    nonce: Number(request.nonce),
    to: getAddress(request.to),
    value: BigInt(request.value),
    data: request.data,
    gas: BigInt(request.gas),
    gasPrice: BigInt(request.gasPrice),
    type: /** @type {const} */ ('legacy'),
  }
}

/** @param {any} state */
export function canonicalGasSpent(state) {
  return Object.values(state.transactions || {}).reduce(
    (sum, step) => sum + BigInt(/** @type {any} */ (step).gasCostWei || 0),
    0n,
  )
}

/** @param {any} transaction @param {ReturnType<typeof deserializeLegacyRequest>} request @param {string} from */
export function transactionMatchesRequest(transaction, request, from) {
  return Boolean(
    transaction &&
    String(transaction.from).toLowerCase() === String(from).toLowerCase() &&
    Number(transaction.nonce) === request.nonce &&
    String(transaction.to).toLowerCase() === String(request.to).toLowerCase() &&
    BigInt(transaction.value) === request.value &&
    String(transaction.input).toLowerCase() === String(request.data).toLowerCase(),
  )
}

/**
 * Fan the same signed bytes out to every configured RPC. A provider is never
 * allowed to choose the nonce or payload, and no endpoint URL is included in
 * the result or error message.
 *
 * @param {{clients:any[], serializedTransaction:import('viem').Hex, expectedHash:import('viem').Hex}} input
 */
export async function broadcastRawTransaction({ clients, serializedTransaction, expectedHash }) {
  if (!Array.isArray(clients) || clients.length === 0) throw new Error('没有可用的 RPC 广播端点')
  const results = await Promise.allSettled(
    clients.map((client) => client.sendRawTransaction({ serializedTransaction })),
  )
  let accepted = 0
  let known = 0
  let failed = 0
  for (const result of results) {
    if (result.status === 'fulfilled') {
      if (String(result.value).toLowerCase() !== expectedHash.toLowerCase()) {
        throw new Error('RPC 返回哈希不一致')
      }
      accepted += 1
      continue
    }
    if (/already known|known transaction|nonce too low/iu.test(errorMessage(result.reason))) known += 1
    else failed += 1
  }
  if (accepted === 0 && known === 0) {
    throw new Error(`全部 ${clients.length} 个 RPC 广播失败`)
  }
  return { hash: expectedHash, accepted, known, failed }
}

/**
 * Execute or resume one byte-identical legacy transaction. The signed intent is
 * durably written before broadcast, and nonce advancement without its exact
 * receipt is treated as ambiguous instead of retried.
 *
 * @param {{
 * state:any, key:string, label:string, to:string, data:import('viem').Hex, value?:bigint,
 * metadata?:any, account:any, walletClient:any, broadcastClients?:any[], publicClient:any, walletAddress:string,
 * chainId:number, store:any, minimumFinalEthWei:bigint, maximumOperationGasWei:bigint,
 * confirmationDepth?:bigint, receiptTimeoutMs?:number, confirmationTimeoutMs?:number,
 * sleep?: (milliseconds:number)=>Promise<void>
 * }} input
 */
export async function executePersistedTransaction(input) {
  const value = input.value || 0n
  const confirmations = input.confirmationDepth || 128n
  const sleep =
    input.sleep ||
    ((milliseconds) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds)
      }))
  input.state.transactions ||= {}
  let step = input.state.transactions[input.key]
  let request
  if (step?.request) {
    request = deserializeLegacyRequest(step.request)
  } else {
    const [latest, pending] = await Promise.all([
      input.publicClient.getTransactionCount({ address: input.walletAddress, blockTag: 'latest' }),
      input.publicClient.getTransactionCount({ address: input.walletAddress, blockTag: 'pending' }),
    ])
    if (latest !== pending) throw new Error(`${input.label} 前存在 pending nonce：${latest}/${pending}`)
    if (input.state.control?.expectedNextNonce !== latest) {
      throw new Error(
        `${input.label} nonce 隔离破坏：预期 ${input.state.control?.expectedNextNonce}，链上 ${latest}`,
      )
    }
    await input.publicClient.call({ account: input.walletAddress, to: input.to, data: input.data, value })
    const [estimatedGas, gasPrice, ethBalance] = await Promise.all([
      input.publicClient.estimateGas({
        account: input.walletAddress,
        to: input.to,
        data: input.data,
        value,
      }),
      input.publicClient.getGasPrice(),
      input.publicClient.getBalance({ address: input.walletAddress }),
    ])
    const gas = (estimatedGas * 12_000n) / 10_000n + 10_000n
    const sendGasPrice = (gasPrice * 11_000n + 9_999n) / 10_000n
    const maximumCost = (gas * sendGasPrice * 12_500n) / 10_000n
    if (canonicalGasSpent(input.state) + maximumCost > input.maximumOperationGasWei) {
      throw new Error(`${input.label} 会突破本次操作 Gas 硬上限`)
    }
    if (ethBalance < value + maximumCost + input.minimumFinalEthWei) {
      throw new Error(`${input.label} 后无法保留要求的 ETH Gas`)
    }
    request = {
      chainId: input.chainId,
      nonce: pending,
      to: getAddress(input.to),
      value,
      data: input.data,
      gas,
      gasPrice: sendGasPrice,
      type: /** @type {const} */ ('legacy'),
    }
    const serialized = await input.account.signTransaction(request)
    const hash = keccak256(serialized)
    step = {
      status: 'SIGNED_INTENT',
      label: input.label,
      hash,
      request: serializeLegacyRequest(request),
      metadata: input.metadata || {},
      estimatedGas: estimatedGas.toString(),
      maximumCostWei: maximumCost.toString(),
      signedAt: new Date().toISOString(),
    }
    input.state.transactions[input.key] = step
    input.state.status = `PENDING_${input.key.toUpperCase()}`
    input.store.writeState(input.state)
    input.store.appendAudit('signed_intent', { key: input.key, step })
  }
  const serialized = await input.account.signTransaction(request)
  const expectedHash = keccak256(serialized)
  if (expectedHash.toLowerCase() !== step.hash.toLowerCase()) {
    throw new Error(`${input.label} 恢复签名哈希不一致`)
  }
  let receipt = null
  try {
    receipt = await input.publicClient.getTransactionReceipt({ hash: expectedHash })
  } catch {
    // A missing receipt is expected before first broadcast and during recovery.
  }
  if (!receipt) {
    const [latest, pending] = await Promise.all([
      input.publicClient.getTransactionCount({ address: input.walletAddress, blockTag: 'latest' }),
      input.publicClient.getTransactionCount({ address: input.walletAddress, blockTag: 'pending' }),
    ])
    let knownTransaction = false
    if (latest > request.nonce || pending > request.nonce) {
      let transaction = null
      try {
        transaction = await input.publicClient.getTransaction({ hash: expectedHash })
      } catch {
        // The nonce moved but the exact transaction is not readable: ambiguous.
      }
      if (!transactionMatchesRequest(transaction, request, input.walletAddress)) {
        throw new Error(`${input.label} 无回执且 nonce 已推进，但无法核验原交易，必须人工对账`)
      }
      knownTransaction = true
    }
    if (!knownTransaction) {
      await broadcastRawTransaction({
        clients: input.broadcastClients || [input.walletClient],
        serializedTransaction: serialized,
        expectedHash,
      })
    }
    step.status = 'BROADCAST'
    step.broadcastAt = new Date().toISOString()
    input.store.writeState(input.state)
    input.store.appendAudit('broadcast', { key: input.key, hash: expectedHash })
  }
  receipt = await input.publicClient.waitForTransactionReceipt({
    hash: expectedHash,
    confirmations: 1,
    timeout: input.receiptTimeoutMs || 120_000,
  })
  if (receipt.status !== 'success') throw new Error(`${input.label} 链上回执失败：${expectedHash}`)
  const targetBlock = receipt.blockNumber + confirmations - 1n
  const deadline = Date.now() + (input.confirmationTimeoutMs || 180_000)
  while ((await input.publicClient.getBlockNumber()) < targetBlock) {
    if (Date.now() > deadline) throw new Error(`${input.label} 等待 ${confirmations} 个确认超时`)
    await sleep(750)
  }
  const canonical = await input.publicClient.getBlock({ blockNumber: receipt.blockNumber })
  if (canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    throw new Error(`${input.label} 回执不再 canonical`)
  }
  step.status = 'CANONICAL_SUCCESS'
  step.blockNumber = receipt.blockNumber.toString()
  step.blockHash = receipt.blockHash
  step.gasUsed = receipt.gasUsed.toString()
  step.effectiveGasPrice = receipt.effectiveGasPrice.toString()
  step.gasCostWei = (receipt.gasUsed * receipt.effectiveGasPrice).toString()
  step.confirmedAt = new Date().toISOString()
  input.state.control.expectedNextNonce = request.nonce + 1
  input.state.control.lastStrategyTransaction = expectedHash
  input.store.writeState(input.state)
  input.store.appendAudit('canonical_receipt', { key: input.key, step })
  return { step, receipt, hash: expectedHash }
}
