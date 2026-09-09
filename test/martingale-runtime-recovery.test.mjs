import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

// The child exposes only synthetic clients and signer stubs to the real runtime.
// VM modules are enabled only for this test process, not the production command.
test('real Keeper resumes persisted burn and mint intents after interruption', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { StressRuntime } from './scripts/stress/martingale-runtime.mjs';
    import { stressSeed } from './test/fixtures/martingale-stress-seed.mjs';
    import { assertMartingaleReadbackReport } from './lib/alert-monitor.mjs';
    for (const fault of ['broadcastOutage','receiptUnavailable','afterBurnDrop']) {
      const runtime = new StressRuntime(stressSeed());
      try {
        runtime.advance(.0142);
        runtime.fault[fault] = fault === 'afterBurnDrop' ? .009 : true;
        const interrupted = await runtime.run();
        assert.ok(interrupted.pending);
        delete runtime.fault[fault];
        if (fault === 'afterBurnDrop') {
          const waiting = await runtime.run();
          assert.equal(waiting.exitCode, 0);
          assert.equal(waiting.mined, 0);
          assert.equal(waiting.nfts, 4);
          const report=(await runtime.run('status')).entries[0];
          assertMartingaleReadbackReport(report);
          const bad=structuredClone(report);bad.nonce.pending++;
          assert.throws(()=>assertMartingaleReadbackReport(bad));
          const unresolved=structuredClone(report);Object.values(unresolved.transactions)[0].status='BROADCAST';
          assert.throws(()=>assertMartingaleReadbackReport(unresolved));
          runtime.advance(.0142);
        }
        const resumed = await runtime.run();
        assert.equal(resumed.exitCode, 0, JSON.stringify(resumed));
        assert.equal(resumed.pending, null);
        assert.equal(resumed.halted, false);
        assert.equal(resumed.nfts, 5);
        assert.equal(runtime.mined.length, 3);
        assert.equal(new Set(runtime.mined.map(t => t.nonce)).size, 3);
      } finally { runtime.close(); }
    }
  `
  const output = execFileSync(
    process.execPath,
    ['--experimental-vm-modules', '--input-type=module', '-e', script],
    {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  assert.equal(output, '')
})
