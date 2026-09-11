import { execFileSync } from 'node:child_process'
import test from 'node:test'

test('liquidation sells the full withdrawn inventory and recovers every persisted stage', () => {
  execFileSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import {StressRuntime} from './scripts/stress/martingale-runtime.mjs';
    import {stressSeed} from './test/fixtures/martingale-stress-seed.mjs';
    for(const fault of ['none','approve','router_approve','swap','quoteTooLow']) {
      const s=new StressRuntime(stressSeed());
      try {
        s.advance(.00555);assert.equal((await s.run('withdraw-all')).exitCode,0);
        const initialPair=s.pair,initialUsdg=s.usdg,before=s.mined.length;
        if(fault==='quoteTooLow') {
          s.fault.quoteTooLow=true;
          const refused=await s.run('liquidate-pair');
          assert.notEqual(refused.exitCode,0);assert.equal(s.mined.length,before);assert.equal(s.pair,initialPair);continue;
        }
        assert.equal((await s.run('liquidate-pair-plan')).exitCode,0);
        if(fault!=='none')s.fault.receiptUnavailableAfter=fault;
        const first=await s.run('liquidate-pair');
        if(fault!=='none'){
          assert.ok(s.state.pendingLiquidation);
          const count=s.mined.length;
          assert.equal((await s.run()).mined,0);
          s.fault={};
          const resumed=await s.run('liquidate-pair');
          assert.equal(resumed.exitCode,0,JSON.stringify(resumed));
          assert.ok(s.mined.length>=count);
        }else assert.equal(first.exitCode,0,JSON.stringify(first));
        assert.equal(s.pair,0n);assert.ok(s.usdg>initialUsdg);assert.equal(s.positions.size,0);
        assert.equal(s.state.status,'LIQUIDATED');assert.equal(s.state.pendingLiquidation,undefined);
        assert.equal(s.mined.filter(t=>t.kind==='swap').length,1);
        assert.equal(s.mined.length-before,3);
        assert.equal(s.state.control.expectedNextNonce,s.nonce);
        assert.ok(Object.values(s.state.transactions).every(t=>t.status==='CANONICAL_SUCCESS'));
        assert.equal((await s.run('liquidate-pair')).mined,0);
        assert.equal((await s.run()).mined,0);
      }finally{s.close();}
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
})
