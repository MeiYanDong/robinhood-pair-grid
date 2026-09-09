import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EXPANDED_KEEPER_BUDGET,
  paddedTransactionCost,
  planRotationBudget,
  guardReservedRotationStep,
} from '../lib/rotation-budget.mjs'
const limits = {
  maximumDailyRotations: 20,
  maximumDailyTransactions: 80,
  maximumDailyGasWei: 4000000000000000n,
  maximumTransactionGasWei: 750000000000000n,
  minimumKeeperEthWei: 1000000000000000n,
}
const usage = { rotationCount: 2, transactionCount: 6, gasWei: 233396824728000n }
const input = () => ({
  limits: { ...limits },
  usage: { ...usage },
  walletEthWei: 3815642979008000n,
  gasPrice: 225280000n,
  burnGasEstimate: 180000n,
  currentTargetAllowance: 0n,
})
test('expanded profile is bounded and three/four-stage plans reserve doubled gas prices', () => {
  assert.equal(EXPANDED_KEEPER_BUDGET.maximumDailyTransactions, 80)
  const a = planRotationBudget(input()),
    b = planRotationBudget({ ...input(), currentTargetAllowance: 1n })
  assert.equal(a.maximumTransactions, 3)
  assert.equal(b.maximumTransactions, 4)
  assert.equal(a.gasPriceCeilingWei, '450560000')
  assert.equal(BigInt(a.stages.burn), paddedTransactionCost(300000n, 450560000n))
  assert.ok(BigInt(b.gasBudgetWei) > BigInt(a.gasBudgetWei))
  assert.ok(
    BigInt(planRotationBudget({ ...input(), burnGasEstimate: 400000n }).stages.burn) > BigInt(a.stages.burn),
  )
})
for (const [name, change] of Object.entries({
  'bad price': (x) => {
    x.gasPrice = 0n
  },
  'bad burn gas': (x) => {
    x.burnGasEstimate = 0n
  },
  'bad allowance': (x) => {
    x.currentTargetAllowance = -1n
  },
  'rotation cap': (x) => {
    x.usage.rotationCount = 20
  },
  'fourth slot missing': (x) => {
    x.usage.transactionCount = 77
    x.currentTargetAllowance = 1n
  },
  'daily gas': (x) => {
    x.usage.gasWei = 3900000000000000n
  },
  'wallet reserve': (x) => {
    x.walletEthWei = 1500000000000000n
  },
  'single-transaction ceiling': (x) => {
    x.gasPrice = 10000000000n
  },
}))
  test(`reservation rejects ${name} before source removal`, () => {
    const x = input()
    change(x)
    assert.throws(() => planRotationBudget(x))
  })
test('each step preserves the gas and transaction slots of all remaining steps', () => {
  const x = input(),
    budget = planRotationBudget(x)
  const r = guardReservedRotationStep({ ...x, budget, stage: 'burn', completedStages: [] })
  assert.equal(
    r.minimumFinalEthWei,
    limits.minimumKeeperEthWei + BigInt(budget.stages.approval_exact) + BigInt(budget.stages.mint),
  )
  const end = guardReservedRotationStep({
    ...x,
    budget,
    stage: 'mint',
    completedStages: ['burn', 'approval_exact'],
  })
  assert.equal(end.minimumFinalEthWei, limits.minimumKeeperEthWei)
  const capped = guardReservedRotationStep({
    ...x,
    limits: { ...limits, maximumTransactionGasWei: 1n },
    budget,
    stage: 'mint',
    completedStages: ['burn', 'approval_exact'],
  })
  assert.equal(capped.maximumCurrentGasWei, 1n)
})
for (const [name, change] of Object.entries({
  'missing reservation': (x) => {
    x.budget = null
  },
  'missing stage': (x) => {
    x.stage = 'unknown'
  },
  'completed stage': (x) => {
    x.completedStages = ['burn']
  },
  'gas beyond buffer': (x) => {
    x.gasPrice = 1000000000n
  },
  'fewer slots than remaining': (x) => {
    x.usage.transactionCount = 79
  },
  'daily gas changed': (x) => {
    x.usage.gasWei = 3900000000000000n
  },
  'wallet gas changed': (x) => {
    x.walletEthWei = 1500000000000000n
  },
}))
  test(`step rejects ${name} without consuming another stage's reserve`, () => {
    const base = input()
    const x = { ...base, budget: planRotationBudget(base), stage: 'burn', completedStages: [] }
    change(x)
    assert.throws(() => guardReservedRotationStep(x))
  })
