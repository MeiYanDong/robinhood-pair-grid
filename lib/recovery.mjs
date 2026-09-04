function clone(value) {
  return structuredClone(value)
}

function assertTransaction(transaction) {
  if (!transaction?.hash || !Number.isInteger(transaction.nonce)) {
    throw new Error('恢复证据缺少 canonical transaction hash/nonce')
  }
  if (!transaction.blockNumber || BigInt(transaction.gasWei) < 0n) {
    throw new Error('恢复证据缺少 canonical block/gas')
  }
}

function assertWalletNonce(wallet, transaction) {
  if (wallet.nonceLatest !== wallet.noncePending) throw new Error('恢复时仍存在 pending nonce')
  if (wallet.nonceLatest !== transaction.nonce + 1) {
    throw new Error(`恢复交易后的 nonce 不唯一：tx=${transaction.nonce}, latest=${wallet.nonceLatest}`)
  }
}

export function recoverInitialFunding({ state, wallet, transaction }) {
  if (state?.status !== 'BUY_FUNDING_PENDING' || state.pending?.kind !== 'INITIAL_BUY') {
    throw new Error('当前状态不是可恢复的初始换币阶段')
  }
  assertTransaction(transaction)
  assertWalletNonce(wallet, transaction)
  if (BigInt(wallet.pairWei) !== 0n || BigInt(wallet.nftBalance) !== 0n) {
    throw new Error('初始换币恢复时钱包出现非预期 PAIR/NFT')
  }
  if (BigInt(wallet.spyWei) < BigInt(state.pending.minimumSpyWei)) {
    throw new Error('初始换币恢复时 SPY 低于原计划最小到账量')
  }

  const recovered = clone(state)
  recovered.status = 'BUY_FUNDED'
  recovered.pending.phase = 'SPY_FUNDED_RECOVERED'
  recovered.pending.fundingTransaction = transaction.hash
  recovered.pending.fundingBlock = String(transaction.blockNumber)
  recovered.pending.actualSpyWei = String(wallet.spyWei)
  recovered.pending.fundingGasWei = String(transaction.gasWei)
  recovered.pending.swapMinimumSpyWei = recovered.pending.minimumSpyWei
  recovered.control.expectedNextNonce = wallet.nonceLatest
  recovered.control.lastStrategyTransaction = transaction.hash
  recovered.reconciledAt = transaction.reconciledAt
  return recovered
}

export function recoverInitialMint({ state, wallet, transaction, position, knownMintAndApprovalGasWei }) {
  if (state?.status !== 'BUY_FUNDED' || state.pending?.kind !== 'INITIAL_BUY') {
    throw new Error('当前状态不是可恢复的初始 mint 阶段')
  }
  assertTransaction(transaction)
  if (wallet.nonceLatest !== wallet.noncePending || wallet.nonceLatest < transaction.nonce + 1) {
    throw new Error('初始 mint 恢复时 nonce 不一致')
  }
  if (!position?.ownerMatches || BigInt(position.liquidity) <= 0n || !position.compositionValid) {
    throw new Error('初始 mint 的 NFT owner/liquidity/composition 证据不完整')
  }

  const recovered = clone(state)
  const enteredAt = transaction.reconciledAt
  recovered.status = 'BUY_ACTIVE'
  recovered.activeLeg = 'BUY'
  recovered.positions.buy = {
    tokenId: String(position.tokenId),
    tickLower: recovered.pending.tickLower,
    tickUpper: recovered.pending.tickUpper,
    liquidity: String(position.liquidity),
    mintTransaction: transaction.hash,
    mintBlock: String(transaction.blockNumber),
  }
  recovered.activeEntry = {
    leg: 'BUY',
    cycleNumber: recovered.cycleNumber,
    amountSpentWei: String(position.actualSpentWei),
    inputToken: 'SPY',
    enteredAt,
    transaction: transaction.hash,
  }
  const fundingGas = BigInt(recovered.pending.fundingGasWei || 0)
  const mintGas = BigInt(knownMintAndApprovalGasWei)
  recovered.initialEntry = {
    fundingTransaction: recovered.pending.fundingTransaction,
    fundingGasWei: recovered.pending.fundingGasWei || null,
    mintAndApprovalGasWei: mintGas.toString(),
    totalKnownGasWei: (fundingGas + mintGas).toString(),
    acquiredSpyWei: recovered.pending.actualSpyWei,
    allocatedSpyWei: String(position.actualSpentWei),
    residualSpyWei: String(wallet.spyWei),
    finalEthWei: String(wallet.ethWei),
    recovered: true,
  }
  recovered.control.expectedNextNonce = wallet.nonceLatest
  recovered.control.lastStrategyTransaction = transaction.hash
  recovered.reconciledAt = enteredAt
  delete recovered.pending
  delete recovered.lastError
  delete recovered.lastErrorAt
  return recovered
}

export function recoverRotationRemoval({ state, wallet, transaction, target }) {
  if (
    !['BUY_ACTIVE', 'SELL_ACTIVE'].includes(state?.status) ||
    state.pendingRotation?.phase !== 'REMOVAL_PLANNED'
  ) {
    throw new Error('当前状态不是可恢复的换腿撤池阶段')
  }
  assertTransaction(transaction)
  assertWalletNonce(wallet, transaction)
  if (BigInt(target.availableWei) <= 0n) throw new Error('换腿恢复没有可用目标代币')

  const recovered = clone(state)
  const sourceKey = recovered.activeLeg.toLowerCase()
  recovered.status = 'ROTATION_FUNDED'
  recovered.positions[sourceKey].liquidity = '0'
  recovered.pendingRotation = {
    ...recovered.pendingRotation,
    phase: 'TARGET_FUNDED',
    removalTransaction: transaction.hash,
    removalBlock: String(transaction.blockNumber),
    removalGasWei: String(transaction.gasWei),
    targetTickLower: target.tickLower,
    targetTickUpper: target.tickUpper,
    availableWei: String(target.availableWei),
    accounting: target.accounting,
    walletAfterRemoval: {
      ethWei: String(wallet.ethWei),
      spyWei: String(wallet.spyWei),
      pairWei: String(wallet.pairWei),
    },
  }
  recovered.control.expectedNextNonce = wallet.nonceLatest
  recovered.control.lastStrategyTransaction = transaction.hash
  recovered.reconciledAt = transaction.reconciledAt
  return recovered
}

export function recoverRotationMint({ state, wallet, transaction, position, knownTargetGasWei }) {
  if (state?.status !== 'ROTATION_FUNDED' || state.pendingRotation?.phase !== 'TARGET_FUNDED') {
    throw new Error('当前状态不是可恢复的目标腿 mint 阶段')
  }
  assertTransaction(transaction)
  if (wallet.nonceLatest !== wallet.noncePending || wallet.nonceLatest < transaction.nonce + 1) {
    throw new Error('目标腿 mint 恢复时 nonce 不一致')
  }
  if (!position?.ownerMatches || !position.liquidityMatches || !position.compositionValid) {
    throw new Error('目标腿 NFT owner/liquidity/composition 证据不完整')
  }

  const recovered = clone(state)
  const pending = recovered.pendingRotation
  const targetLeg = pending.toLeg
  const targetKey = targetLeg.toLowerCase()
  const completedAt = transaction.reconciledAt
  const completedRotation = {
    ...pending,
    phase: 'COMPLETE_RECOVERED',
    targetTokenId: String(position.tokenId),
    targetLiquidity: String(position.liquidity),
    targetTransaction: transaction.hash,
    targetBlock: String(transaction.blockNumber),
    targetAmountSpentWei: String(position.actualSpentWei),
    targetGasWei: String(knownTargetGasWei),
    completedAt,
  }
  recovered.positions[targetKey] = {
    ...(recovered.positions[targetKey] || {}),
    tokenId: String(position.tokenId),
    tickLower: pending.targetTickLower,
    tickUpper: pending.targetTickUpper,
    liquidity: String(position.liquidity),
    lastAddTransaction: transaction.hash,
    lastAddBlock: String(transaction.blockNumber),
  }
  recovered.status = `${targetLeg}_ACTIVE`
  recovered.activeLeg = targetLeg
  if (targetLeg === 'BUY') recovered.cycleNumber += 1
  recovered.activeEntry = {
    leg: targetLeg,
    cycleNumber: recovered.cycleNumber,
    amountSpentWei: String(position.actualSpentWei),
    inputToken: targetLeg === 'BUY' ? 'SPY' : 'PAIR',
    enteredAt: completedAt,
    transaction: transaction.hash,
  }
  recovered.control.expectedNextNonce = wallet.nonceLatest
  recovered.control.lastStrategyTransaction = transaction.hash
  recovered.history.push(completedRotation)
  recovered.reconciledAt = completedAt
  delete recovered.pendingRotation
  delete recovered.lastError
  delete recovered.lastErrorAt
  return recovered
}

export function recoverExit({ state, wallet, transaction }) {
  if (
    !['BUY_ACTIVE', 'SELL_ACTIVE'].includes(state?.status) ||
    state.pendingExit?.phase !== 'REMOVAL_PLANNED'
  ) {
    throw new Error('当前状态不是可恢复的退出撤池阶段')
  }
  assertTransaction(transaction)
  assertWalletNonce(wallet, transaction)

  const recovered = clone(state)
  const record = recovered.positions[recovered.activeLeg.toLowerCase()]
  record.liquidity = '0'
  recovered.status = 'EXITED'
  recovered.exitedAt = transaction.reconciledAt
  recovered.exitReason = 'user_exit_recovered'
  recovered.control.expectedNextNonce = wallet.nonceLatest
  recovered.control.lastStrategyTransaction = transaction.hash
  recovered.history.push({
    kind: 'EXIT_RECOVERED',
    fromLeg: recovered.activeLeg,
    tokenId: record.tokenId,
    transaction: transaction.hash,
    blockNumber: String(transaction.blockNumber),
    gasWei: String(transaction.gasWei),
    receivedSpyWei: (BigInt(wallet.spyWei) - BigInt(recovered.pendingExit.baselineWalletSpyWei)).toString(),
    receivedPairWei: (
      BigInt(wallet.pairWei) - BigInt(recovered.pendingExit.baselineWalletPairWei)
    ).toString(),
    exitedAt: recovered.exitedAt,
  })
  delete recovered.activeLeg
  delete recovered.activeEntry
  delete recovered.pendingExit
  delete recovered.lastError
  delete recovered.lastErrorAt
  return recovered
}
