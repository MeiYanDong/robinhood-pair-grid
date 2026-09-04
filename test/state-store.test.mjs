import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { StateStore } from '../lib/state-store.mjs'

function withTemporaryStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-grid-state-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return { directory, store: new StateStore(directory) }
}

test('state and audit persistence enforce private permissions', (t) => {
  const { directory, store } = withTemporaryStore(t)
  store.writeState({ status: 'BUY_ACTIVE', amount: 1n })
  store.appendAudit('tested', { amount: 1n })

  assert.deepEqual(store.readState(), { status: 'BUY_ACTIVE', amount: '1' })
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700)
  assert.equal(fs.statSync(store.statePath).mode & 0o777, 0o600)
  assert.equal(fs.statSync(store.auditPath).mode & 0o777, 0o600)
  assert.equal(store.readAudit()[0].event, 'tested')
})

test('process lock rejects a concurrent keeper and releases cleanly', (t) => {
  const { directory, store } = withTemporaryStore(t)
  const second = new StateStore(directory)
  const release = store.acquireLock('keeper-once')
  assert.throws(() => second.acquireLock('rotate'), /持锁/)
  release()
  const releaseSecond = second.acquireLock('rotate')
  releaseSecond()
})

test('HALTED survives process turns and requires explicit acknowledgement', (t) => {
  const { directory, store } = withTemporaryStore(t)
  store.halt({ command: 'keeper-once', reason: 'owner mismatch' })
  const nextProcess = new StateStore(directory)
  assert.throws(() => nextProcess.assertNotHalted(), /HALTED/)
  assert.throws(() => nextProcess.clearHalt('yes'), /I_UNDERSTAND/)
  nextProcess.clearHalt('I_UNDERSTAND')
  assert.doesNotThrow(() => nextProcess.assertNotHalted())
})
