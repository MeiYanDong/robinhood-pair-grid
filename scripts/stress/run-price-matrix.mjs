import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { StressRuntime } from './martingale-runtime.mjs'
import { assertMartingaleReadbackReport } from '../../lib/alert-monitor.mjs'

const seedPath = process.argv[2]
if (!seedPath) throw new Error('Pass sanitized production seed JSON')
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
const n = 60
const line = (a, b) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1))
const wave = (center, amplitude, period) =>
  Array.from({ length: n }, (_, i) => center + amplitude * Math.sin((i * 2 * Math.PI) / period))
const triangle = (a, b, c) => [
  ...Array.from({ length: n }, (_, i) => (i < 30 ? a + ((b - a) * i) / 29 : b + ((c - b) * (i - 30)) / 29)),
]
const random = (start, volatility, drift, rngSeed) => {
  let rng = rngSeed,
    price = start
  return Array.from({ length: n }, () => {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0
    price = Math.max(0.0001, Math.min(0.1, price * Math.exp(drift + (rng / 2 ** 32 - 0.5) * volatility)))
    return price
  })
}
const paths = [
  ['slow-rise', '缓慢上涨', line(0.0096, 0.018)],
  ['fast-rise', '快速拉升', [0.0096, ...Array(59).fill(0.025)]],
  ['breakout-pullback', '突破 0.014 后回落', triangle(0.0096, 0.0148, 0.008)],
  [
    'breakout-consolidation',
    '突破后高位横盘',
    [...line(0.0096, 0.016).slice(0, 20), ...wave(0.016, 0.0003, 8).slice(0, 40)],
  ],
  ['threshold-chop', '0.014 附近密集震荡', wave(0.014, 0.0004, 4)],
  ['wide-oscillation', '宽幅震荡', wave(0.014, 0.005, 20)],
  ['narrow-oscillation', '低位窄幅震荡', wave(0.0096, 0.00005, 6)],
  ['slow-decline', '阴跌', line(0.0096, 0.004)],
  ['flash-crash', '暴跌后低位停留', [0.016, ...Array(59).fill(0.002)]],
  ['v-recovery', 'V 型反弹', triangle(0.016, 0.005, 0.019)],
  ['inverted-v', '倒 V 冲高回落', triangle(0.0096, 0.028, 0.004)],
  [
    'double-bottom',
    '双底反弹',
    [
      ...triangle(0.014, 0.006, 0.014).filter((_, i) => i % 2 === 0),
      ...triangle(0.014, 0.006, 0.022).filter((_, i) => i % 2 === 0),
    ],
  ],
  [
    'double-top',
    '双顶回落',
    [
      ...triangle(0.0096, 0.02, 0.012).filter((_, i) => i % 2 === 0),
      ...triangle(0.012, 0.02, 0.006).filter((_, i) => i % 2 === 0),
    ],
  ],
  ['staircase-rise', '阶梯上涨', Array.from({ length: n }, (_, i) => 0.0096 + Math.floor(i / 10) * 0.003)],
  ['staircase-fall', '阶梯下跌', Array.from({ length: n }, (_, i) => 0.025 - Math.floor(i / 10) * 0.004)],
  ['gap-whipsaw', '跳空反复穿越', Array.from({ length: n }, (_, i) => (i % 10 < 5 ? 0.023 : 0.009))],
  ['near-zero-recovery', '接近归零后反弹', triangle(0.0096, 0.0001, 0.025)],
  ['seeded-bull', '固定随机种子上涨', random(0.0096, 0.16, 0.018, 101)],
  ['seeded-bear', '固定随机种子下跌', random(0.02, 0.2, -0.018, 202)],
  ['seeded-turbulence', '固定随机种子剧烈波动', random(0.014, 0.65, 0, 303)],
]
const profiles = [
  { name: 'current-balance', eth: '3815642979008000' },
  { name: 'funded-model', eth: '10000000000000000' },
  { name: 'faults-funded-model', eth: '10000000000000000' },
]
const results = []
for (const [id, label, prices] of paths) {
  for (const profile of profiles.filter((p) => !process.argv[3] || p.name === process.argv[3])) {
    const s = new StressRuntime(seed, { eth: profile.eth })
    const counts = {},
      rows = [],
      injections = []
    let failure = null
    let protectedHalt = false
    try {
      for (let i = 0; i < prices.length; i++) {
        // UTC transitions ensure the suite cannot pass merely by waiting at one day's cap.
        if (i % 20 === 0)
          s.clock = Date.parse(`2026-09-${String(10 + Math.floor(i / 20)).padStart(2, '0')}T00:00:01Z`)
        s.fault = {}
        s.gasPrice = 225280000n
        if (profile.name === 'faults-funded-model') {
          const fault = {
            8: 'rpcOutage',
            16: 'staleMarket',
            24: 'broadcastOutage',
            32: 'receiptUnavailableAfter',
            36: 'receiptUnavailableAfter',
            40: 'secondRpcDown',
          }[i]
          if (fault) {
            s.fault[fault] = fault === 'receiptUnavailableAfter' ? (i === 36 ? 'approve' : 'burn') : true
            injections.push({ step: i, fault })
          }
          if (i === 48) {
            s.gasPrice = 100000000000n
            injections.push({ step: i, fault: 'gas-price-spike' })
          }
        }
        s.advance(prices[i])
        const before = s.mined.length
        const r = await s.run()
        const state = s.state
        const status = r.entries.find((e) => e?.status)?.status || `EXIT_${r.exitCode}`
        counts[status] = (counts[status] || 0) + 1
        if (r.halted) {
          assert.equal(
            s.mined.at(-1)?.kind,
            'reverted',
            'only a modeled on-chain revert permits a protective halt',
          )
          const beforeHalt = s.mined.length
          for (let retry = 0; retry < 3; retry++) {
            const stopped = await s.run()
            assert.equal(stopped.halted, true)
            assert.equal(s.mined.length, beforeHalt, 'halt prevents all subsequent transactions')
          }
          protectedHalt = true
          rows.push({
            step: i,
            price: prices[i],
            status: 'PROTECTED_HALT_REVERT',
            mined: r.mined,
            pending: r.pending,
            eth: s.eth.toString(),
          })
          break
        }
        if (!Object.keys(s.fault).length) assert.equal(r.exitCode, 0, JSON.stringify(r.entries))
        assert.ok(s.mined.length - before <= 4, 'at most one four-stage rotation per invocation')
        assert.ok(s.eth >= BigInt(state.policy.minimumKeeperEthWei), 'minimum ETH reserve retained')
        if (state.control.expectedNextNonce !== s.nonce) {
          const pendingTx = Object.values(state.transactions).find(
            (t) => t.request?.nonce === state.control.expectedNextNonce && t.status !== 'CANONICAL_SUCCESS',
          )
          assert.ok(
            pendingTx && s.mined.some((t) => t.hash === pendingTx.hash),
            'nonce lag must correspond to the exact persisted mined intent',
          )
          assert.equal(s.nonce, state.control.expectedNextNonce + 1, 'at most one unresolved nonce')
        }
        for (const band of state.bands) {
          if (BigInt(band.activePosition.liquidity) > 0n) {
            const p = s.positions.get(band.activePosition.tokenId)
            if (!p) {
              const pending = state.pendingRotation
              const burn = pending && state.transactions[`rotation_${pending.id.replaceAll('-', '_')}_burn`]
              assert.equal(
                pending?.sourceTokenId,
                band.activePosition.tokenId,
                'only pending source may be absent',
              )
              assert.equal(pending.phase, 'SOURCE_BURN_PLANNED')
              assert.ok(
                burn?.request &&
                  burn.status !== 'CANONICAL_SUCCESS' &&
                  s.receipts.get(burn.hash)?.status === 'success',
                'missing source is attributed to the exact mined burn awaiting receipt',
              )
              continue
            }
            assert.equal(p.liquidity, BigInt(band.activePosition.liquidity), 'liquidity agreement')
            assert.equal(p.owner.toLowerCase(), s.wallet.toLowerCase(), 'owner agreement')
            if (band.activePosition.leg === 'BUY')
              assert.ok(band.activePosition.priceLowUsdg >= 0.01, 'hard BUY floor')
          }
        }
        const day = new Date(s.clock).toISOString().slice(0, 10)
        const txs = Object.values(state.transactions).filter((t) => t.confirmedAt?.startsWith(day))
        assert.ok(txs.length <= state.policy.maximumDailyTransactions, 'daily tx budget')
        assert.ok(
          txs.reduce((sum, t) => sum + BigInt(t.gasCostWei || 0), 0n) <=
            BigInt(state.policy.maximumDailyGasWei),
          'daily gas budget',
        )
        assert.ok(
          state.history.filter((h) => h.kind === 'ROTATION' && h.completedAt?.startsWith(day)).length <=
            state.policy.maximumDailyRotations,
          'daily rotation budget',
        )
        rows.push({
          step: i,
          price: prices[i],
          status,
          mined: r.mined,
          pending: r.pending,
          eth: s.eth.toString(),
        })
      }
      s.fault = {}
      s.gasPrice = 225280000n
      // Resolve any final receipt on a fresh process without changing the final price.
      if (!protectedHalt) await s.run()
      const readback = await s.run('status')
      assert.equal(readback.exitCode, 0)
      if (!protectedHalt) assertMartingaleReadbackReport(readback.entries[0])
    } catch (error) {
      failure = error.message
    }
    results.push({
      id,
      label,
      profile: profile.name,
      pass: !failure,
      outcome: protectedHalt ? 'PROTECTED_HALT_REQUIRES_RECONCILIATION' : 'HEALTHY',
      error: failure,
      steps: rows.length,
      counts,
      injections,
      transactions: s.mined.length,
      finalEth: s.eth.toString(),
      pending: s.state.pendingRotation?.phase || null,
      rows,
      failLog: failure ? s.logs.at(-1) : undefined,
    })
    console.log(`${id}/${profile.name}: ${failure ? 'FAIL ' + failure : 'PASS'} (${s.mined.length} tx)`)
    s.close()
  }
}
const report = {
  evidenceClass: 'OFFLINE_REAL_RUNTIME_SYNTHETIC_CHAIN_NOT_EVM_FORK',
  createdAt: new Date().toISOString(),
  paths: paths.length,
  profiles: profiles.length,
  passed: results.filter((r) => r.pass).length,
  failed: results.filter((r) => !r.pass).length,
  limitations: [
    'No live signing or RPC',
    'Gas, receipts and market data are synthetic',
    'Funded profiles do not represent actual top-ups',
    'Healthy waiting is distinct from completed trading',
  ],
  results,
}
fs.writeFileSync(
  path.join(path.dirname(seedPath), `price-matrix${process.argv[3] ? '-' + process.argv[3] : ''}.json`),
  JSON.stringify(report, null, 2),
)
if (report.failed) process.exitCode = 1
