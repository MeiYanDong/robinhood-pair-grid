import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

test('same-wallet reentry preserves the liquidated epoch and prepares full-capital five bands', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { StressRuntime } from './scripts/stress/martingale-runtime.mjs';
    const hash = '0x' + '42'.repeat(32), block = 59900000n;
    const seed = {
      schemaVersion: 2,
      strategyId: 'pair-usdg-finite-martingale-live-1',
      status: 'LIQUIDATED',
      wallet: '0x1111111111111111111111111111111111111111',
      control: { expectedNextNonce: 37 },
      principal: { initialUsdgAtomic: '78232837', reinvestmentEnabled: false },
      policy: { automaticSigning: false },
      accounting: { walletUsdgAtomic: '44633881', walletPairWei: '0' },
      plan: { bandCount: 5 }, bands: [], transactions: {}, history: [],
      createdAt: '2026-09-08T12:17:53.083Z',
      lastLiquidation: { hash, blockNumber: String(block), completedAt: '2026-09-11T08:33:58.383Z' },
    };
    const runtime = new StressRuntime(seed, {
      environment: { PAIR_MARTINGALE_REENTRY_CONFIRM: 'I_AUTHORIZE_REENTRY_SAME_WALLET' },
    });
    try {
      runtime.receipts.set(hash, {
        status: 'success', transactionHash: hash, blockNumber: block,
        blockHash: runtime.blockHash(block), gasUsed: 1n, effectiveGasPrice: 1n, logs: [],
      });
      runtime.transactions.set(hash, { from: runtime.wallet });
      const planned = await runtime.run('reentry-plan');
      assert.equal(planned.exitCode, 0);
      assert.equal(planned.entries[0].status, 'READY_FOR_REENTRY_PREPARATION');
      assert.equal(planned.entries[0].sameWallet, true);
      assert.equal(planned.entries[0].principalUsdg, '44.633881');
      assert.equal(planned.entries[0].plan.bandCount, 5);
      assert.equal(planned.entries[0].plan.plannedSpendUsdg, '44.633881');
      assert.equal(runtime.state.status, 'LIQUIDATED');
      const prepared = await runtime.run('reentry-prepare');
      assert.equal(prepared.exitCode, 0);
      assert.equal(prepared.entries[0].status, 'REENTRY_PREPARED');
      assert.equal(runtime.state.status, 'INITIAL_APPROVAL_REQUIRED');
      assert.equal(runtime.state.wallet, runtime.wallet);
      assert.equal(runtime.state.principal.initialUsdgAtomic, '44633881');
      assert.equal(runtime.state.policy.deployBps, 10000);
      assert.equal(runtime.state.policy.reserveBps, 0);
      assert.equal(runtime.state.sourceReentry.liquidationTransaction, hash);
      assert.equal(runtime.state.transactions.initial_mint, undefined);
    } finally { runtime.close(); }
  `
  const output = execFileSync(
    process.execPath,
    ['--experimental-vm-modules', '--input-type=module', '-e', script],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 30_000 },
  )
  assert.equal(output, '')
})
