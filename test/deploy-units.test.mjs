import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

function unit(name) {
  return fs.readFileSync(new URL(`../deploy/systemd/${name}`, import.meta.url), 'utf8')
}

test('keeper failure is routed to the external alert unit', () => {
  const keeper = unit('robinhood-pair-grid.service')
  assert.match(keeper, /^OnFailure=robinhood-pair-grid-alert@%n\.service$/mu)
})

test('alert units load only the dedicated alert credential', () => {
  for (const name of [
    'robinhood-pair-grid-alert@.service',
    'robinhood-pair-grid-alert-test.service',
    'robinhood-pair-grid-monitor.service',
  ]) {
    const content = unit(name)
    assert.match(
      content,
      /^LoadCredentialEncrypted=pair-grid-alert:\/etc\/credstore\.encrypted\/pair-grid-alert$/mu,
    )
    assert.doesNotMatch(content, /pair-grid-private-key/u)
  }
})

test('monitor is read-only, durable and scheduled independently of trading', () => {
  const monitor = unit('robinhood-pair-grid-monitor.service')
  const timer = unit('robinhood-pair-grid-monitor.timer')
  assert.match(monitor, /scripts\/pair-grid-alert\.mjs monitor-once/u)
  assert.match(monitor, /^OnFailure=robinhood-pair-grid-alert@%n\.service$/mu)
  assert.match(monitor, /^ReadWritePaths=\/var\/lib\/robinhood-pair-grid$/mu)
  assert.match(timer, /^Unit=robinhood-pair-grid-monitor\.service$/mu)
  assert.match(timer, /^OnCalendar=\*-\*-\* \*:00\/5:00$/mu)
  assert.match(timer, /^Persistent=true$/mu)
  assert.doesNotMatch(timer, /^Unit=robinhood-pair-grid\.service$/mu)
  assert.doesNotMatch(timer, /^OnBootSec=/mu)
  assert.doesNotMatch(timer, /^OnUnitActiveSec=/mu)
})
