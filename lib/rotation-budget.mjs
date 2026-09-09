/** Explicit expanded profile; only the budget-apply command persists it. */
export const EXPANDED_KEEPER_BUDGET = Object.freeze({
  maximumDailyRotations: 20,
  maximumDailyTransactions: 80,
  maximumDailyGasWei: '4000000000000000',
})

export function paddedTransactionCost(estimatedGas, gasPrice) {
  const gas = (estimatedGas * 12000n) / 10000n + 10000n
  const sendGasPrice = (gasPrice * 11000n + 9999n) / 10000n
  return (gas * sendGasPrice * 12500n) / 10000n
}

/** Reserve the whole burn / optional reset / approval / mint before any burn. */
export function planRotationBudget({
  limits,
  usage,
  walletEthWei,
  gasPrice,
  burnGasEstimate,
  currentTargetAllowance,
}) {
  if (gasPrice <= 0n || burnGasEstimate <= 0n || currentTargetAllowance < 0n)
    throw new Error('HARD: invalid rotation gas evidence')
  const gasPriceCeilingWei = gasPrice * 2n
  const estimates = {
    burn: burnGasEstimate > 300000n ? burnGasEstimate : 300000n,
    approval_zero: currentTargetAllowance > 0n ? 80000n : 0n,
    approval_exact: 80000n,
    mint: 500000n,
  }
  const stages = Object.fromEntries(
    Object.entries(estimates)
      .filter(([, gas]) => gas > 0n)
      .map(([key, gas]) => [key, paddedTransactionCost(gas, gasPriceCeilingWei).toString()]),
  )
  const maximumTransactions = Object.keys(stages).length
  const gasBudgetWei = Object.values(stages).reduce((sum, cost) => sum + BigInt(cost), 0n)
  if (usage.rotationCount >= limits.maximumDailyRotations) throw new Error('WAIT: 已达到 UTC 日换腿次数上限')
  if (usage.transactionCount + maximumTransactions > limits.maximumDailyTransactions)
    throw new Error(`WAIT: 整轮需要 ${maximumTransactions} 笔交易名额，当前日额度不足；保留源 NFT`)
  if (Object.values(stages).some((cost) => BigInt(cost) > limits.maximumTransactionGasWei))
    throw new Error('WAIT: 整轮 Gas 缓冲超过单笔硬上限；保留源 NFT')
  if (usage.gasWei + gasBudgetWei > limits.maximumDailyGasWei)
    throw new Error('WAIT: 日 Gas 余额不足以预留整轮；保留源 NFT')
  if (walletEthWei < limits.minimumKeeperEthWei + gasBudgetWei)
    throw new Error('WAIT: 钱包 Gas 不足以预留整轮和最低留存；保留源 NFT')
  return {
    version: 1,
    maximumTransactions,
    gasPriceCeilingWei: gasPriceCeilingWei.toString(),
    gasBudgetWei: gasBudgetWei.toString(),
    stages,
  }
}

/** Do not spend another stage's reservation while preparing a new transaction. */
export function guardReservedRotationStep({
  budget,
  stage,
  completedStages,
  limits,
  usage,
  gasPrice,
  walletEthWei,
}) {
  if (budget?.version !== 1 || !budget.stages?.[stage])
    throw new Error('HARD: missing reserved rotation stage')
  if (gasPrice > BigInt(budget.gasPriceCeilingWei))
    throw new Error('WAIT: Gas 价格超过整轮预留缓冲，保留原轮转等待')
  const outstanding = Object.entries(budget.stages).filter(([key]) => !completedStages.includes(key))
  if (!outstanding.some(([key]) => key === stage)) throw new Error('HARD: reserved stage is already complete')
  const total = outstanding.reduce((sum, [, cost]) => sum + BigInt(cost), 0n)
  const current = BigInt(budget.stages[stage])
  if (usage.transactionCount + outstanding.length > limits.maximumDailyTransactions)
    throw new Error('WAIT: 剩余交易名额不足以完成已预留轮转')
  if (usage.gasWei + total > limits.maximumDailyGasWei)
    throw new Error('WAIT: 剩余日 Gas 不足以完成已预留轮转')
  if (walletEthWei < limits.minimumKeeperEthWei + total)
    throw new Error('WAIT: 剩余钱包 Gas 不足以完成已预留轮转')
  return {
    maximumCurrentGasWei:
      current < limits.maximumTransactionGasWei ? current : limits.maximumTransactionGasWei,
    minimumFinalEthWei: limits.minimumKeeperEthWei + total - current,
  }
}
