import { decodeEventLog, parseAbi } from 'viem'

const TRANSFER_ABI = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)'])
const HASH = /^0x[0-9a-f]{64}$/iu

function tokenFlow(receipt, token, wallet) {
  let net = 0n
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue
    let decoded
    try {
      decoded = /** @type {{ eventName: string, args: { from: string, to: string, value: bigint } }} */ (
        decodeEventLog({ abi: TRANSFER_ABI, data: log.data, topics: log.topics })
      )
    } catch {
      continue
    }
    if (decoded.eventName !== 'Transfer') continue
    if (decoded.args.from.toLowerCase() === wallet.toLowerCase()) net -= decoded.args.value
    if (decoded.args.to.toLowerCase() === wallet.toLowerCase()) net += decoded.args.value
  }
  return net
}

async function canonicalWalletTransaction(client, hash, wallet) {
  if (typeof hash !== 'string' || !HASH.test(hash)) throw new Error('HARD: 外部交易哈希无效')
  const [transaction, receipt] = await Promise.all([
    client.getTransaction({ hash }),
    client.getTransactionReceipt({ hash }),
  ])
  if (
    transaction.from.toLowerCase() !== wallet.toLowerCase() ||
    receipt.status !== 'success' ||
    receipt.transactionHash.toLowerCase() !== hash.toLowerCase()
  ) {
    throw new Error('HARD: 外部交易身份或回执失败')
  }
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  if (block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    throw new Error('HARD: 外部交易回执不再 canonical')
  }
  return { transaction, receipt }
}

/** Verify the five externally signed transactions after the completed withdrawal.
 * Their token flows must bridge the old ledger to the observed empty wallet.
 * This establishes a new principal without calling it liquidation proceeds or profit.
 */
export async function auditWithdrawnWalletRestart({
  previous,
  wallet,
  priorWallet,
  hashes,
  client,
  walletAddress,
  usdgAddress,
  pairAddress,
}) {
  if (previous?.strategyId !== 'pair-usdg-finite-martingale-live-1' || previous.status !== 'WITHDRAWN') {
    throw new Error('HARD: 重启来源不是已全撤的独立策略账本')
  }
  if (
    previous.pending ||
    previous.pendingRotation ||
    previous.pendingRebase ||
    previous.pendingWithdrawal ||
    previous.pendingLiquidation
  )
    throw new Error('HARD: 上一轮有未完成操作')
  const startNonce = Number(previous.control?.expectedNextNonce)
  const finalBurn = previous.lastWithdrawal?.burns?.B5
  if (!Number.isSafeInteger(startNonce) || !finalBurn?.hash || !finalBurn?.blockNumber) {
    throw new Error('HARD: 上一轮缺少最终撤池回执或 nonce')
  }
  if (
    wallet.usdgAtomic <= 0n ||
    wallet.pairWei !== 0n ||
    wallet.spyWei !== 0n ||
    wallet.nftBalance !== 0n ||
    wallet.nonceLatest !== wallet.noncePending
  )
    throw new Error('HARD: 当前钱包资产、NFT 或 pending nonce 不满足重启条件')
  if (
    priorWallet.usdgAtomic !== BigInt(previous.accounting?.walletUsdgAtomic ?? -1) ||
    priorWallet.pairWei !== BigInt(previous.accounting?.walletPairWei ?? -1) ||
    priorWallet.nftBalance !== 0n
  )
    throw new Error('HARD: 撤池完成时链上余额与旧账本不一致')
  if (!Array.isArray(hashes) || hashes.length !== wallet.nonceLatest - startNonce || hashes.length === 0) {
    throw new Error('HARD: 外部交易哈希数量与 nonce 差额不一致')
  }
  if (new Set(hashes.map((hash) => String(hash).toLowerCase())).size !== hashes.length) {
    throw new Error('HARD: 外部交易哈希重复')
  }
  const finalBurnProof = await canonicalWalletTransaction(client, finalBurn.hash, walletAddress)
  if (finalBurnProof.receipt.blockNumber !== BigInt(finalBurn.blockNumber)) {
    throw new Error('HARD: 最终撤池区块与旧账本不一致')
  }
  const historicalNonce = await client.getTransactionCount({
    address: walletAddress,
    blockNumber: finalBurnProof.receipt.blockNumber,
  })
  if (historicalNonce !== startNonce) throw new Error('HARD: 撤池完成时链上 nonce 与旧账本不一致')

  let usdgFlow = 0n
  let pairFlow = 0n
  let priorBlock = finalBurnProof.receipt.blockNumber
  const transactions = []
  for (const [index, hash] of hashes.entries()) {
    const { transaction, receipt } = await canonicalWalletTransaction(client, hash, walletAddress)
    if (transaction.nonce !== startNonce + index || receipt.blockNumber < priorBlock) {
      throw new Error('HARD: 外部交易 nonce 或区块顺序不连续')
    }
    priorBlock = receipt.blockNumber
    const receivedUsdgAtomic = tokenFlow(receipt, usdgAddress, walletAddress)
    const receivedPairWei = tokenFlow(receipt, pairAddress, walletAddress)
    usdgFlow += receivedUsdgAtomic
    pairFlow += receivedPairWei
    transactions.push({
      nonce: transaction.nonce,
      hash,
      blockNumber: receipt.blockNumber.toString(),
      usdgFlowAtomic: receivedUsdgAtomic.toString(),
      pairFlowWei: receivedPairWei.toString(),
      ethValueWei: transaction.value.toString(),
      gasWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    })
  }
  if (
    priorWallet.usdgAtomic + usdgFlow !== wallet.usdgAtomic ||
    priorWallet.pairWei + pairFlow !== wallet.pairWei
  )
    throw new Error('HARD: 外部交易代币流与新钱包余额不闭合')
  return {
    kind: 'CANONICAL_AUDITED_WITHDRAWN_WALLET_RESTART',
    sameWallet: true,
    previousCreatedAt: previous.createdAt,
    previousWithdrawnAt: previous.lastWithdrawal.completedAt,
    finalWithdrawalTransaction: finalBurn.hash,
    finalWithdrawalBlockNumber: finalBurn.blockNumber,
    previousInitialUsdgAtomic: previous.principal.initialUsdgAtomic,
    previousWalletUsdgAtomic: priorWallet.usdgAtomic.toString(),
    previousWalletPairWei: priorWallet.pairWei.toString(),
    externalTransactions: transactions,
    reentryUsdgAtomic: wallet.usdgAtomic.toString(),
    expectedNonce: wallet.nonceLatest,
    provenance: 'EXTERNAL_WALLET_ACTIVITY_NOT_STRATEGY_PROFIT',
  }
}
