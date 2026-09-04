import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertLiveArm,
  assertNonceControl,
  decideKeeperAction,
  redactSensitiveText,
} from '../lib/runtime-guards.mjs'

function activeFixture(overrides = {}) {
  return {
    local: {
      status: 'BUY_ACTIVE',
      control: { expectedNextNonce: 4 },
    },
    result: {
      localStatus: 'BUY_ACTIVE',
      position: {
        ownerMatches: true,
        liquidityMatches: true,
        liquidity: 100n,
        fullyConverted: false,
      },
    },
    wallet: { nonceLatest: 4, noncePending: 4 },
    ...overrides,
  }
}

test('live signing requires an explicit arm value', () => {
  assert.throws(() => assertLiveArm({}), /未武装/)
  assert.throws(() => assertLiveArm({ PAIR_GRID_LIVE_ARM: 'true' }), /未武装/)
  assert.doesNotThrow(() => assertLiveArm({ PAIR_GRID_LIVE_ARM: '1' }))
})

test('nonce guard blocks pending and unexpected external transactions', () => {
  assert.throws(() => assertNonceControl({ latest: 4, pending: 5, expected: 4 }), /pending nonce/)
  assert.throws(() => assertNonceControl({ latest: 5, pending: 5, expected: 4 }), /nonce 隔离破坏/)
  assert.doesNotThrow(() => assertNonceControl({ latest: 4, pending: 4, expected: 4 }))
})

test('keeper validates owner before returning no action', () => {
  const fixture = activeFixture()
  fixture.result.position.ownerMatches = false
  assert.throws(() => decideKeeperAction(fixture), /owner/)
})

test('keeper validates liquidity before returning no action', () => {
  const fixture = activeFixture()
  fixture.result.position.liquidityMatches = false
  assert.throws(() => decideKeeperAction(fixture), /流动性/)
})

test('keeper validates pending nonce before returning no action', () => {
  const fixture = activeFixture()
  fixture.wallet.noncePending = 5
  assert.throws(() => decideKeeperAction(fixture), /pending nonce/)
})

test('keeper blocks an unfinished rotation or exit intent', () => {
  const rotation = activeFixture()
  rotation.local.pendingRotation = { phase: 'REMOVAL_PLANNED' }
  assert.throws(() => decideKeeperAction(rotation), /reconcile/)

  const exit = activeFixture()
  exit.local.pendingExit = { phase: 'REMOVAL_PLANNED' }
  assert.throws(() => decideKeeperAction(exit), /reconcile/)
})

test('keeper returns no action only for a healthy incomplete position', () => {
  assert.deepEqual(decideKeeperAction(activeFixture()), {
    action: 'NO_ACTION',
    reason: 'ACTIVE_LEG_NOT_FULLY_CONVERTED',
  })
})

test('keeper rotates only after the healthy position is fully converted', () => {
  const fixture = activeFixture()
  fixture.result.position.fullyConverted = true
  assert.deepEqual(decideKeeperAction(fixture), {
    action: 'ROTATE',
    reason: 'ACTIVE_LEG_FULLY_CONVERTED',
  })
})

test('error redaction removes URLs and query credentials but keeps transaction hashes', () => {
  const hash = `0x${'ab'.repeat(32)}`
  const redacted = redactSensitiveText(`RPC https://node.invalid/path?apiKey=secret token=abc tx=${hash}`)
  assert.doesNotMatch(redacted, /node\.invalid|secret|token=abc/)
  assert.match(redacted, new RegExp(hash))
})
