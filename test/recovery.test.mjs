import assert from 'node:assert/strict'
import test from 'node:test'
import {
  recoverExit,
  recoverInitialFunding,
  recoverInitialMint,
  recoverRotationMint,
  recoverRotationRemoval,
} from '../lib/recovery.mjs'

const transaction = {
  hash: `0x${'ab'.repeat(32)}`,
  nonce: 4,
  blockNumber: '100',
  gasWei: '50',
  reconciledAt: '2026-09-04T00:00:00.000Z',
}

function initialState(status = 'BUY_FUNDING_PENDING') {
  return {
    status,
    cycleNumber: 1,
    positions: {},
    history: [],
    control: { expectedNextNonce: 4 },
    pending: {
      kind: 'INITIAL_BUY',
      minimumSpyWei: '100',
      swapMinimumSpyWei: '100',
      actualSpyWei: '120',
      fundingGasWei: '25',
      fundingTransaction: `0x${'cd'.repeat(32)}`,
      tickLower: 100,
      tickUpper: 200,
    },
  }
}

test('recovers a confirmed initial swap without retrying it', () => {
  const recovered = recoverInitialFunding({
    state: initialState(),
    wallet: { ethWei: '900', spyWei: '120', pairWei: '0', nftBalance: '0', nonceLatest: 5, noncePending: 5 },
    transaction,
  })
  assert.equal(recovered.status, 'BUY_FUNDED')
  assert.equal(recovered.pending.actualSpyWei, '120')
  assert.equal(recovered.control.expectedNextNonce, 5)
})

test('rejects ambiguous initial swap recovery', () => {
  assert.throws(
    () =>
      recoverInitialFunding({
        state: initialState(),
        wallet: { spyWei: '120', pairWei: '1', nftBalance: '0', nonceLatest: 5, noncePending: 5 },
        transaction,
      }),
    /非预期/,
  )
})

test('recovers a confirmed initial mint into BUY_ACTIVE', () => {
  const recovered = recoverInitialMint({
    state: initialState('BUY_FUNDED'),
    wallet: { ethWei: '800', spyWei: '2', nonceLatest: 6, noncePending: 6 },
    transaction: { ...transaction, nonce: 5 },
    position: {
      tokenId: '9',
      liquidity: '500',
      actualSpentWei: '118',
      ownerMatches: true,
      compositionValid: true,
    },
    knownMintAndApprovalGasWei: '75',
  })
  assert.equal(recovered.status, 'BUY_ACTIVE')
  assert.equal(recovered.positions.buy.tokenId, '9')
  assert.equal(recovered.pending, undefined)
})

function activeState() {
  return {
    status: 'BUY_ACTIVE',
    activeLeg: 'BUY',
    cycleNumber: 1,
    positions: { buy: { tokenId: '9', liquidity: '500', tickLower: 100, tickUpper: 200 } },
    activeEntry: { amountSpentWei: '100' },
    control: { expectedNextNonce: 4 },
    history: [],
    pendingRotation: { id: 'r1', phase: 'REMOVAL_PLANNED', fromLeg: 'BUY', toLeg: 'SELL' },
  }
}

test('recovers a confirmed removal into ROTATION_FUNDED', () => {
  const recovered = recoverRotationRemoval({
    state: activeState(),
    wallet: { ethWei: '700', spyWei: '1', pairWei: '1000', nonceLatest: 5, noncePending: 5 },
    transaction,
    target: { tickLower: 10, tickUpper: 20, availableWei: '1000', accounting: { basis: '1' } },
  })
  assert.equal(recovered.status, 'ROTATION_FUNDED')
  assert.equal(recovered.positions.buy.liquidity, '0')
  assert.equal(recovered.pendingRotation.phase, 'TARGET_FUNDED')
})

test('recovers a confirmed target mint without creating another NFT', () => {
  const state = recoverRotationRemoval({
    state: activeState(),
    wallet: { ethWei: '700', spyWei: '1', pairWei: '1000', nonceLatest: 5, noncePending: 5 },
    transaction,
    target: { tickLower: 10, tickUpper: 20, availableWei: '1000', accounting: {} },
  })
  const recovered = recoverRotationMint({
    state,
    wallet: { nonceLatest: 6, noncePending: 6 },
    transaction: { ...transaction, nonce: 5 },
    position: {
      tokenId: '10',
      liquidity: '600',
      actualSpentWei: '980',
      ownerMatches: true,
      liquidityMatches: true,
      compositionValid: true,
    },
    knownTargetGasWei: '80',
  })
  assert.equal(recovered.status, 'SELL_ACTIVE')
  assert.equal(recovered.positions.sell.tokenId, '10')
  assert.equal(recovered.pendingRotation, undefined)
})

test('recovers a confirmed explicit exit', () => {
  const state = activeState()
  delete state.pendingRotation
  state.pendingExit = {
    phase: 'REMOVAL_PLANNED',
    baselineWalletSpyWei: '2',
    baselineWalletPairWei: '3',
  }
  const recovered = recoverExit({
    state,
    wallet: { spyWei: '12', pairWei: '23', nonceLatest: 5, noncePending: 5 },
    transaction,
  })
  assert.equal(recovered.status, 'EXITED')
  assert.equal(recovered.history.at(-1).receivedPairWei, '20')
})
