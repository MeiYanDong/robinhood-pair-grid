import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

test('five-position withdrawal reconciles receipts, resumes once and never remints', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import {StressRuntime} from './scripts/stress/martingale-runtime.mjs';
    import {stressSeed} from './test/fixtures/martingale-stress-seed.mjs';
    for(const fault of ['none','receipt','owner']) {
      const s=new StressRuntime(stressSeed());
      try {
        s.advance(.0056);
        const planned=await s.run('withdraw-all-plan');
        assert.equal(planned.exitCode,0,JSON.stringify(planned));
        assert.equal(s.mined.length,0);
        if(fault==='receipt')s.fault.receiptUnavailableAfter='burn';
        if(fault==='owner')s.fault.ownerMismatch=true;
        const first=await s.run('withdraw-all');
        if(fault==='owner') {assert.equal(first.halted,true);assert.equal(s.mined.length,0);continue;}
        if(fault==='receipt') {
          assert.equal(s.mined.length,1);
          const hash=s.mined[0].hash;
          assert.ok(s.state.pendingWithdrawal);
          assert.equal((await s.run()).mined,0);
          s.fault={};
          const resumed=await s.run('withdraw-all');
          assert.equal(resumed.exitCode,0,JSON.stringify(resumed));
          assert.equal(s.mined.filter(t=>t.hash===hash).length,1);
        } else assert.equal(first.exitCode,0,JSON.stringify(first));
        assert.equal(s.state.status,'WITHDRAWN');
        assert.equal(s.state.pendingWithdrawal,undefined);
        assert.equal(s.positions.size,0);
        assert.equal(s.mined.length,5);
        assert.ok(s.mined.every(t=>t.kind==='burn'));
        assert.equal(s.state.control.expectedNextNonce,s.nonce);
        assert.equal(s.state.policy.automaticSigning,false);
        assert.ok(Object.values(s.state.transactions).every(t=>t.status==='CANONICAL_SUCCESS'));
        assert.equal((await s.run('withdraw-all')).mined,0);
        assert.equal((await s.run()).mined,0);
        assert.equal((await s.run('status')).entries[0].balances.nfts,'0');
      } finally{s.close();}
    }
  `,
    ],
    {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  assert.equal(output, '')
})
