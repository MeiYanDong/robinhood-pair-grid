import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const installer = fs.readFileSync(new URL('../deploy/install-release.sh', import.meta.url), 'utf8')

test('release failure restores every previously active isolated timer', () => {
  assert.match(installer, /^trap restore_runtime_on_failure EXIT$/mu)
  assert.ok(installer.includes('if [[ ${result} -ne 0 && ${install_completed} -eq 0 ]]; then'))
  for (const timer of [
    'robinhood-pair-grid-monitor.timer',
    'robinhood-pair-usdg-martingale.timer',
    'robinhood-pair-usdg-martingale-monitor.timer',
  ]) {
    assert.match(installer, new RegExp(`systemctl start ${timer.replaceAll('.', '\\.')}`))
  }
  assert.match(installer, /^install_completed=1$/mu)
})

test('release installer deploys both isolated monitor units', () => {
  assert.match(installer, /robinhood-pair-usdg-martingale-monitor\.service/u)
  assert.match(installer, /robinhood-pair-usdg-martingale-monitor\.timer/u)
})

test('release installer deploys the resumable hard-floor rebase unit', () => {
  assert.match(installer, /robinhood-pair-usdg-martingale-rebase-floor\.service/u)
})
