import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { assertMartingaleReadbackReport } from '../../lib/alert-monitor.mjs'
import { StressRuntime } from './martingale-runtime.mjs'

const seedPath = process.argv[2]
if (!seedPath) throw new Error('Pass a sanitized, read-only production seed JSON path')
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
const output = path.dirname(seedPath)
const results = []
const status = (r) => r.entries.find((e) => typeof e === 'object' && e.status)?.status || `EXIT_${r.exitCode}`
const reason = (r) =>
  r.entries.find((e) => typeof e === 'object' && e.reason)?.reason ||
  r.entries.find((e) => typeof e === 'string') ||
  ''
async function scenario(name, exercise) {
  const runtime = new StressRuntime(seed)
  try {
    const details = await exercise(runtime)
    results.push({
      name,
      assertions: 'PASS',
      ...details,
      cycles: runtime.logs.filter((l) => l.command).length,
      minedTransactions: runtime.mined.length,
      finalNonce: runtime.nonce,
      finalNfts: runtime.positions.size,
      pending: runtime.state.pendingRotation?.phase || null,
      halted: Boolean(runtime.halt),
      logs: runtime.logs,
    })
    console.log(
      `${name}: PASS (${runtime.logs.filter((l) => l.command).length} cycles, ${runtime.mined.length} simulated transactions)`,
    )
  } catch (error) {
    results.push({ name, assertions: 'FAIL', error: error.message, logs: runtime.logs })
    console.log(`${name}: FAIL — ${error.message}`)
  } finally {
    runtime.close()
  }
}
await scenario('breakout-oscillation-pullback', async (s) => {
  const rows = []
  for (const price of [
    0.0096, 0.011, 0.013, 0.0142, 0.0143, 0.0139, 0.0144, 0.014, 0.013, 0.012, 0.011, 0.01, 0.009,
  ]) {
    s.advance(price)
    const r = await s.run()
    assert.equal(r.exitCode, 0)
    assert.equal(r.halted, false)
    assert.ok(r.mined <= 4)
    rows.push({ price, status: status(r), reason: reason(r), phases: r.phases })
  }
  assert.equal(s.mined.length, 10)
  assert.equal(s.state.bands[3].phase, 'BUY_ACTIVE')
  assert.equal(s.state.bands[2].cycleNumber, 2)
  assert.equal(s.state.bands[3].cycleNumber, 1)
  assert.equal(s.state.bands[4].activePosition.tokenId, seed.bands[4].activePosition.tokenId)
  return {
    observation:
      'Legacy 18-slot budget finishes B3 but defers B4 after residual-allowance reset costs; B5 retains its NFT at the floor',
    rows,
  }
})
await scenario('brief-spike-without-safe-block-confirmation', async (s) => {
  s.advance(0.0142, 1n)
  const r = await s.run()
  assert.equal(status(r), 'NO_ACTION')
  assert.equal(r.mined, 0)
  s.advance(0.0096)
  assert.equal((await s.run()).mined, 0)
})
await scenario('reversal-before-first-signature', async (s) => {
  s.advance(0.0142)
  s.fault.reverseBeforeBurn = 0.0096
  const r = await s.run()
  assert.equal(status(r), 'NO_ACTION')
  assert.equal(r.mined, 0)
  assert.equal(s.state.pendingRotation, undefined)
})
await scenario('lagging-six-hour-distribution-selects-valid-range', async (s) => {
  s.advance(0.0142)
  s.marketAnchor = 0.0096
  const r = await s.run()
  assert.equal(status(r), 'ROTATION_COMPLETE')
  const target = s.state.bands[2].activePosition
  assert.ok(target.priceLowUsdg >= 0.01 && target.priceHighUsdg < 0.0142)
  return {
    observation: 'Lagging volume distribution still selects a valid single-sided range above the hard floor',
  }
})
for (const fault of [
  'marketUnavailable',
  'staleMarket',
  'rpcOutage',
  'secondRpcDown',
  'poolDisagreement',
  'pendingNonce',
  'ownerMismatch',
  'liquidityMismatch',
])
  await scenario(fault, async (s) => {
    s.advance(0.0142)
    s.fault[fault] = true
    const r = await s.run()
    assert.equal(r.mined, 0)
    if (['poolDisagreement', 'pendingNonce', 'ownerMismatch', 'liquidityMismatch'].includes(fault))
      assert.equal(r.halted, true)
    else {
      delete s.fault[fault]
      const recovered = await s.run()
      assert.equal(recovered.exitCode, 0)
      assert.equal(status(recovered), 'ROTATION_COMPLETE')
    }
    return { firstStatus: status(r), firstReason: reason(r), persistentHalt: r.halted }
  })
await scenario('unknown-external-nonce', async (s) => {
  s.advance(0.0142)
  s.nonce++
  const r = await s.run()
  assert.equal(r.halted, true)
  assert.equal(r.mined, 0)
})
await scenario('one-broadcast-provider-down', async (s) => {
  s.advance(0.0142)
  s.fault.broadcastOneDown = true
  const r = await s.run()
  assert.equal(status(r), 'ROTATION_COMPLETE')
  assert.equal(s.mined.length, 3)
})
await scenario('all-broadcast-providers-down-and-restart', async (s) => {
  s.advance(0.0142)
  s.fault.broadcastOutage = true
  const r = await s.run()
  assert.equal(r.mined, 0)
  assert.ok(r.pending)
  const original = Object.values(s.state.transactions).find((t) => t.status === 'SIGNED_INTENT').hash
  s.fault.broadcastOutage = false
  const recovered = await s.run()
  assert.equal(status(recovered), 'ROTATION_COMPLETE')
  assert.equal(s.mined[0].hash, original)
})
await scenario('receipt-timeout-after-burn-and-restart', async (s) => {
  s.advance(0.0142)
  s.fault.receiptUnavailable = true
  const r = await s.run()
  assert.equal(r.mined, 1)
  assert.equal(r.nfts, 4)
  assert.ok(r.pending)
  const hash = s.mined[0].hash
  s.fault.receiptUnavailable = false
  const recovered = await s.run()
  assert.equal(status(recovered), 'ROTATION_COMPLETE')
  assert.equal(s.mined.filter((t) => t.hash === hash).length, 1)
})
for (const reset of [false, true])
  await scenario(`approval-${reset ? 'zero' : 'exact'}-receipt-timeout-and-restart`, async (s) => {
    if (reset) s.allowances.set('0x5fc5360d0400a0fd4f2af552add042d716f1d168', 1n)
    s.advance(0.0142)
    s.fault.receiptUnavailableAfter = 'approve'
    const interrupted = await s.run()
    assert.ok(interrupted.pending)
    assert.equal(interrupted.mined, 2)
    const originalHashes = s.mined.map((t) => t.hash)
    s.fault = {}
    const recovered = await s.run()
    assert.equal(status(recovered), 'ROTATION_COMPLETE')
    assert.equal(recovered.halted, false)
    assert.equal(s.mined.length, reset ? 4 : 3)
    for (const hash of originalHashes) assert.equal(s.mined.filter((t) => t.hash === hash).length, 1)
    assert.ok(Object.values(s.state.transactions).every((t) => t.status === 'CANONICAL_SUCCESS'))
    assertMartingaleReadbackReport((await s.run('status')).entries[0])
  })

await scenario('canonical-reorg-after-mining', async (s) => {
  s.advance(0.0142)
  s.fault.reorgAfterMine = true
  const r = await s.run()
  assert.equal(r.halted, true)
  assert.equal(r.mined, 1)
  assert.ok(r.pending)
})
await scenario('crash-in-price-after-source-burn', async (s) => {
  s.advance(0.0142)
  s.fault.afterBurnDrop = 0.009
  const first = await s.run()
  assert.equal(status(first), 'WAITING_NO_ACTION')
  assert.equal(first.nfts, 4)
  assert.equal(first.mined, 1)
  const cash = s.usdg
  for (let i = 0; i < 5; i++) {
    s.advance(0.009)
    const r = await s.run()
    assert.equal(status(r), 'WAITING_PENDING_ROTATION')
    assert.equal(r.mined, 0)
    assert.equal(s.usdg, cash)
  }
  s.advance(0.0142)
  const resumed = await s.run()
  assert.equal(status(resumed), 'ROTATION_COMPLETE')
  assert.equal(resumed.nfts, 5)
  return {
    observation:
      '4 NFT + USDG persisted safely below floor; other bands are blocked until pending target can resume',
  }
})
await scenario('insufficient-gas-and-replenishment-in-model', async (s) => {
  s.advance(0.0142)
  s.eth = 1000000000000000n
  const r = await s.run()
  assert.equal(r.mined, 0)
  assert.equal(r.halted, false)
  s.eth = 3815642979008000n
  const recovered = await s.run()
  assert.equal(status(recovered), 'ROTATION_COMPLETE')
})
await scenario('gas-price-spike-and-recovery', async (s) => {
  s.advance(0.0142)
  s.gasPrice = 100000000000n
  const r = await s.run()
  assert.equal(r.mined, 0)
  assert.equal(r.halted, false)
  s.gasPrice = 225280000n
  const recovered = await s.run()
  assert.equal(status(recovered), 'ROTATION_COMPLETE')
  return { firstStatus: status(r), firstReason: reason(r) }
})
await scenario('simultaneous-keeper-invocations', async (s) => {
  s.advance(0.0142)
  const calls = await Promise.all([s.run(), s.run()])
  assert.equal(calls.filter((r) => r.exitCode === 0).length, 1)
  assert.equal(s.mined.length, 3)
  assert.equal(s.halt, null)
})
await scenario('same-day-rotation-limit-and-next-UTC-day', async (s) => {
  for (const price of [0.016, 0.016, 0.016, 0.016, 0.016, 0.016]) {
    s.advance(price)
    await s.run()
  }
  assert.equal(
    s.state.history.filter((h) => h.kind === 'ROTATION' && h.completedAt?.startsWith('2026-09-09')).length,
    5,
  )
  const r = await s.run()
  assert.equal(status(r), 'WAITING_NO_ACTION')
  assert.equal(r.mined, 0)
  s.clock = Date.parse('2026-09-10T00:00:01Z')
  const next = await s.run()
  assert.equal(status(next), 'ROTATION_COMPLETE')
  return {
    observation:
      'Legacy transaction slots admit 3 additional rotations with residual approval resets; next band resumes after UTC rollover',
  }
})
await scenario('receipt-timeout-after-mint-and-restart', async (s) => {
  s.advance(0.0142)
  s.fault.receiptUnavailableAfter = 'mint'
  const interrupted = await s.run()
  assert.equal(interrupted.mined, 3)
  assert.equal(interrupted.nfts, 5)
  assert.ok(interrupted.pending)
  s.fault = {}
  const resumed = await s.run()
  assert.equal(status(resumed), 'ROTATION_COMPLETE')
  assert.equal(resumed.mined, 0)
  assert.equal(resumed.pending, null)
})
await scenario('four-slot-reservation-keeps-source-NFT-before-UTC-rollover', async (s) => {
  const state = s.state
  for (let i = 0; i < 9; i++)
    state.transactions[`synthetic-prior-${i}`] = {
      status: 'CANONICAL_SUCCESS',
      confirmedAt: '2026-09-09T01:00:00Z',
      gasCostWei: '1',
    }
  fs.writeFileSync(s.statePath, JSON.stringify(state))
  s.allowances.set('0x5fc5360d0400a0fd4f2af552add042d716f1d168', 1n)
  s.advance(0.0142)
  const waiting = await s.run()
  assert.equal(waiting.mined, 0)
  assert.equal(waiting.nfts, 5)
  assert.equal(waiting.pending, null)
  s.clock = Date.parse('2026-09-10T00:00:01Z')
  const resumed = await s.run()
  assert.equal(status(resumed), 'ROTATION_COMPLETE')
  assert.equal(resumed.nfts, 5)
  return {
    observation: 'Four slots are reserved before burn; source stays intact with only three slots left',
  }
})
await scenario('1000-seeded-oscillation-cycles', async (s) => {
  let rng = 917
  const counts = {}
  for (let i = 0; i < 1000; i++) {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0
    const price =
      i < 50
        ? 0.0096 + ((0.016 - 0.0096) * i) / 49
        : i < 500
          ? 0.014 + (rng / 2 ** 32 - 0.5) * 0.004
          : 0.009 + (rng / 2 ** 32) * 0.004
    s.advance(price)
    const r = await s.run()
    assert.equal(r.exitCode, 0)
    assert.equal(r.halted, false)
    counts[status(r)] = (counts[status(r)] || 0) + 1
    assert.ok(
      s.state.history.filter((h) => h.kind === 'ROTATION' && h.completedAt?.startsWith('2026-09-09'))
        .length <= 6,
    )
  }
  return {
    statusCounts: counts,
    observation: '30-second sequential cycles; budgets intentionally retain production limits',
  }
})
await scenario('seven-UTC-days-without-gas-topups', async (s) => {
  const counts = {}
  for (let day = 0; day < 7; day++) {
    s.clock = Date.parse(`2026-09-${String(9 + day).padStart(2, '0')}T03:00:00Z`)
    for (let i = 0; i < 40; i++) {
      const price = 0.0125 + 0.0035 * Math.sin((i / 40) * 2 * Math.PI)
      s.advance(price)
      const r = await s.run()
      assert.equal(r.exitCode, 0, JSON.stringify(r.entries))
      assert.equal(r.halted, false)
      counts[status(r)] = (counts[status(r)] || 0) + 1
    }
  }
  return {
    statusCounts: counts,
    finalGasEth: Number(s.eth) / 1e18,
    observation:
      'No simulated gas replenishment; low-gas waiting is allowed but duplicate execution and hard halts are not',
  }
})

await scenario('monitor-validates-canonical-four-NFT-wait', async (s) => {
  s.advance(0.0142)
  s.fault.afterBurnDrop = 0.009
  await s.run()
  const result = await s.run('status')
  const report = result.entries[0]
  assertMartingaleReadbackReport(report)
  assert.equal(report.balances.nfts, '4')
  const bad = structuredClone(report)
  bad.nonce.pending++
  assert.throws(() => assertMartingaleReadbackReport(bad))
  const unresolved = structuredClone(report)
  Object.values(unresolved.transactions)[0].status = 'BROADCAST'
  assert.throws(() => assertMartingaleReadbackReport(unresolved))
})

const artifact = {
  evidenceClass: 'OFFLINE_REAL_RUNTIME_WITH_SYNTHETIC_CHAIN_NOT_EVM_FORK',
  createdAt: new Date().toISOString(),
  seedPath: path.basename(seedPath),
  passed: results.filter((r) => r.assertions === 'PASS').length,
  failed: results.filter((r) => r.assertions === 'FAIL').length,
  limitations: [
    'No live signing, RPC transaction or production writes',
    'Contract execution, fees, gas estimates, ordering and market evolution are synthetic',
    'Same production policy and remaining daily usage; simulated market is not a price forecast',
  ],
  results,
}
fs.writeFileSync(path.join(output, 'stress-results.json'), JSON.stringify(artifact, null, 2))
console.log(JSON.stringify({ passed: artifact.passed, failed: artifact.failed }))
if (artifact.failed) process.exitCode = 1
