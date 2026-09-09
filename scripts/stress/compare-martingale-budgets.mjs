import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { StressRuntime } from './martingale-runtime.mjs'
import { directPairPriceAtTick } from '../../lib/finite-martingale.mjs'

const seed = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const cases = [
  {
    name: 'legacy-existing-wallet',
    rotations: 6,
    transactions: 18,
    gas: '2000000000000000',
    eth: '3815642979008000',
  },
  {
    name: 'moderate-funded',
    rotations: 10,
    transactions: 40,
    gas: '3000000000000000',
    eth: '10000000000000000',
  },
  {
    name: 'expanded-existing-wallet',
    rotations: 20,
    transactions: 80,
    gas: '4000000000000000',
    eth: '3815642979008000',
  },
  {
    name: 'expanded-funded',
    rotations: 20,
    transactions: 80,
    gas: '4000000000000000',
    eth: '10000000000000000',
  },
  {
    name: 'larger-funded',
    rotations: 30,
    transactions: 120,
    gas: '6000000000000000',
    eth: '10000000000000000',
  },
]
const results = []
for (const profile of cases) {
  const initial = structuredClone(seed)
  Object.assign(initial.policy, {
    maximumDailyRotations: profile.rotations,
    maximumDailyTransactions: profile.transactions,
    maximumDailyGasWei: profile.gas,
  })
  const s = new StressRuntime(initial, { eth: profile.eth })
  s.clock = Date.parse('2026-09-10T03:00:00Z')
  const rows = []
  try {
    for (let phase = 0; phase < 4; phase++) {
      const positions = s.state.bands.map((b) => b.activePosition)
      const price =
        phase % 2 === 0
          ? Math.max(...positions.map((p) => directPairPriceAtTick(p.tickLower))) * 1.05
          : Math.min(...positions.map((p) => directPairPriceAtTick(p.tickUpper))) * 0.95
      for (let step = 0; step < 5; step++) {
        s.advance(price)
        const r = await s.run()
        assert.equal(r.exitCode, 0, JSON.stringify(r))
        assert.equal(r.halted, false)
        assert.equal(r.pending, null)
        rows.push({ price, status: r.entries[0]?.status, reason: r.entries[0]?.reason, mined: r.mined })
      }
    }
    const completed = s.state.history.filter(
      (h) => h.kind === 'ROTATION' && h.completedAt?.startsWith('2026-09-10'),
    ).length
    results.push({
      profile: profile.name,
      limits: { rotations: profile.rotations, transactions: profile.transactions, gasWei: profile.gas },
      initialEth: profile.eth,
      completedRotations: completed,
      transactions: s.mined.length,
      finalEth: s.eth.toString(),
      finalNfts: s.positions.size,
      rows,
    })
    console.log(profile.name, completed, 'rotations', s.mined.length, 'transactions')
  } finally {
    s.close()
  }
}
const expanded = results.find((r) => r.profile === 'expanded-funded')
const larger = results.find((r) => r.profile === 'larger-funded')
assert.equal(expanded.completedRotations, 20)
assert.equal(larger.completedRotations, 20)
fs.writeFileSync(
  path.join(path.dirname(process.argv[2]), 'budget-comparison.json'),
  JSON.stringify(
    { evidenceClass: 'OFFLINE_SYNTHETIC_SATURATED_DEMAND_NOT_PRICE_FORECAST', results },
    null,
    2,
  ),
)
