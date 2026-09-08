import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assessHeartbeat,
  assertCanonicalReadbackReport,
  assertMartingaleReadbackReport,
  markMonitorDelivery,
  planMonitorRun,
} from '../lib/alert-monitor.mjs'

const START = new Date('2026-09-04T00:00:00.000Z')

test('canonical monitor readback accepts the real status command contract', () => {
  const report = {
    evidenceClass: 'CANONICAL_CHAIN_READBACK_WITH_LOCAL_STATE_COMPARISON',
    observedAt: START.toISOString(),
    blockNumber: '54131011',
    localStatus: 'BUY_ACTIVE',
    nonce: { latest: 4, pending: 4 },
  }

  assert.equal(assertCanonicalReadbackReport(report), report)
  assert.throws(
    () => assertCanonicalReadbackReport({ ...report, evidenceClass: undefined }),
    /evidenceClass/u,
  )
  assert.throws(
    () => assertCanonicalReadbackReport({ ...report, nonce: { latest: 4, pending: -1 } }),
    /nonce/u,
  )
})

function martingaleReport(overrides = {}) {
  const bands = Array.from({ length: 5 }, (_, index) => ({
    id: `B${index + 1}`,
    activePosition: { tokenId: String(100 + index), liquidity: '1000' },
    chain: { ownerMatches: true, liquidityMatches: true },
    readError: null,
  }))
  return {
    status: 'MARTINGALE_ACTIVE',
    evidenceClass: 'LIVE_CHAIN_READBACK_WITH_LOCAL_STATE',
    observedAt: START.toISOString(),
    blockNumber: '57400000',
    pool: { tick: 123, pairPriceUsdg: '0.0132', liquidity: '999999' },
    balances: { nfts: '5' },
    nonce: { latest: 7, pending: 7 },
    expectedNextNonce: 7,
    pendingRotation: null,
    bands,
    ...overrides,
  }
}

test('martingale monitor validates five canonical positions and exact nonce isolation', () => {
  const report = martingaleReport()
  assert.equal(assertMartingaleReadbackReport(report), report)
  assert.throws(
    () => assertMartingaleReadbackReport(martingaleReport({ nonce: { latest: 7, pending: 8 } })),
    /nonce 不一致/u,
  )
  const unreadable = martingaleReport()
  unreadable.bands[2].readError = 'RPC failed at https://node.invalid/?token=secret'
  assert.throws(() => assertMartingaleReadbackReport(unreadable), /B3 链上持仓回读失败/u)
})

test('martingale monitor permits exactly one burned position only during a pending rotation', () => {
  const report = martingaleReport({
    status: 'ROTATION_PENDING',
    balances: { nfts: '4' },
    pendingRotation: { id: 'b1-c0-buy-to-sell' },
  })
  report.bands[0] = {
    ...report.bands[0],
    activePosition: { ...report.bands[0].activePosition, liquidity: '0' },
    chain: null,
  }
  assert.equal(assertMartingaleReadbackReport(report), report)
  assert.throws(() => assertMartingaleReadbackReport({ ...report, pendingRotation: null }), /liquidity 为 0/u)
})

test('keeper heartbeat reports fresh, stale and missing evidence', () => {
  assert.deepEqual(assessHeartbeat({ modifiedAtMs: START.getTime() - 45_000, now: START }), {
    ok: true,
    ageSeconds: 45,
  })
  assert.deepEqual(assessHeartbeat({ modifiedAtMs: START.getTime() - 121_000, now: START }), {
    ok: false,
    ageSeconds: 121,
    error: 'Keeper 成功心跳已超过 120 秒',
  })
  assert.deepEqual(assessHeartbeat({ modifiedAtMs: Number.NaN, now: START }), {
    ok: false,
    error: 'Keeper 成功心跳不存在',
  })
  assert.throws(() => assessHeartbeat({ modifiedAtMs: START.getTime(), maximumAgeSeconds: 10 }), /最大年龄/u)
})

test('readback alert starts only at the configured consecutive failure threshold', () => {
  let previous = {}
  for (let failure = 1; failure <= 3; failure += 1) {
    const plan = planMonitorRun({
      previous,
      readback: { ok: false, error: `RPC failure ${failure}` },
      now: new Date(START.getTime() + failure * 60_000),
      failureThreshold: 3,
    })
    assert.equal(plan.state.consecutiveReadbackFailures, failure)
    assert.equal(plan.alerts.length, failure === 3 ? 1 : 0)
    previous = plan.state
  }
  assert.equal(previous.lastReadbackError, 'RPC failure 3')
})

test('acknowledged readback failure is deduplicated and reset by a successful readback', () => {
  const threshold = planMonitorRun({
    previous: { consecutiveReadbackFailures: 2 },
    readback: { ok: false, error: 'timeout' },
    now: START,
    failureThreshold: 3,
  })
  const delivered = markMonitorDelivery(threshold.state, threshold.alerts[0], START.toISOString())
  const duplicate = planMonitorRun({
    previous: delivered,
    readback: { ok: false, error: 'timeout' },
    now: new Date(START.getTime() + 5 * 60_000),
    failureThreshold: 3,
  })
  assert.equal(duplicate.alerts.length, 0)

  const recovered = planMonitorRun({ previous: duplicate.state, readback: { ok: true }, now: START })
  assert.equal(recovered.state.consecutiveReadbackFailures, 0)
  assert.equal(recovered.state.readbackDelivery, null)
})

test('persistent HALTED state alerts immediately, deduplicates and repeats after interval', () => {
  const halt = {
    status: 'HALTED',
    command: 'keeper-once',
    reason: 'owner mismatch at https://node.invalid/?token=secret',
    haltedAt: '2026-09-03T23:59:00.000Z',
  }
  const first = planMonitorRun({ previous: {}, halt, readback: { ok: true }, now: START })
  assert.equal(first.alerts[0].kind, 'persistent-halted')
  assert.doesNotMatch(first.alerts[0].details, /node\.invalid|token=secret/u)
  const delivered = markMonitorDelivery(first.state, first.alerts[0], START.toISOString())

  const quiet = planMonitorRun({
    previous: delivered,
    halt,
    readback: { ok: true },
    now: new Date(START.getTime() + 359 * 60_000),
  })
  assert.equal(quiet.alerts.length, 0)

  const repeated = planMonitorRun({
    previous: quiet.state,
    halt,
    readback: { ok: true },
    now: new Date(START.getTime() + 360 * 60_000),
  })
  assert.equal(repeated.alerts[0].kind, 'persistent-halted')
})

test('changed HALTED evidence creates a new alert before the repeat interval', () => {
  const initial = planMonitorRun({
    previous: {},
    halt: { status: 'HALTED', command: 'keeper-once', reason: 'first', haltedAt: START.toISOString() },
    readback: { ok: true },
    now: START,
  })
  const delivered = markMonitorDelivery(initial.state, initial.alerts[0], START.toISOString())
  const changed = planMonitorRun({
    previous: delivered,
    halt: { status: 'HALTED', command: 'rotate', reason: 'second', haltedAt: START.toISOString() },
    readback: { ok: true },
    now: new Date(START.getTime() + 60_000),
  })
  assert.equal(changed.alerts.length, 1)
})

test('stale keeper heartbeat alerts immediately, deduplicates and clears after recovery', () => {
  const first = planMonitorRun({
    previous: {},
    readback: { ok: true },
    heartbeat: { ok: false, ageSeconds: 180, error: 'stale' },
    strategyLabel: 'PAIR/USDG 有限马丁',
    now: START,
  })
  assert.equal(first.alerts[0].kind, 'stale-keeper-heartbeat')
  assert.match(first.alerts[0].summary, /PAIR\/USDG 有限马丁/u)
  const delivered = markMonitorDelivery(first.state, first.alerts[0], START.toISOString())
  const duplicate = planMonitorRun({
    previous: delivered,
    readback: { ok: true },
    heartbeat: { ok: false, error: 'still stale' },
    now: new Date(START.getTime() + 5 * 60_000),
  })
  assert.equal(duplicate.alerts.length, 0)
  const recovered = planMonitorRun({
    previous: duplicate.state,
    readback: { ok: true },
    heartbeat: { ok: true, ageSeconds: 10 },
    now: START,
  })
  assert.equal(recovered.state.heartbeatDelivery, null)
})

test('invalid monitor limits and unknown delivery kinds fail closed', () => {
  assert.throws(() => planMonitorRun({ readback: { ok: false }, failureThreshold: 0 }), /失败阈值/u)
  assert.throws(() => planMonitorRun({ readback: { ok: false }, repeatMinutes: 1 }), /重复间隔/u)
  // @ts-expect-error Runtime validation must reject malformed monitor input.
  assert.throws(() => planMonitorRun({ readback: { ok: true }, heartbeat: {} }), /heartbeat/u)
  assert.throws(
    () => markMonitorDelivery({}, { kind: 'unknown', fingerprint: 'x' }, START.toISOString()),
    /不支持/u,
  )
})
