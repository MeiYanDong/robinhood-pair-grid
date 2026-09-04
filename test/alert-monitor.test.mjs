import assert from 'node:assert/strict'
import test from 'node:test'
import { markMonitorDelivery, planMonitorRun } from '../lib/alert-monitor.mjs'

const START = new Date('2026-09-04T00:00:00.000Z')

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

test('invalid monitor limits and unknown delivery kinds fail closed', () => {
  assert.throws(() => planMonitorRun({ readback: { ok: false }, failureThreshold: 0 }), /失败阈值/u)
  assert.throws(() => planMonitorRun({ readback: { ok: false }, repeatMinutes: 1 }), /重复间隔/u)
  assert.throws(
    () => markMonitorDelivery({}, { kind: 'unknown', fingerprint: 'x' }, START.toISOString()),
    /不支持/u,
  )
})
