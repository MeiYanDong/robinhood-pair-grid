import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadSignerAccount } from '../lib/account-loader.mjs'

const DEVELOPMENT_PRIVATE_KEY = `0x${'11'.repeat(32)}`
const DEVELOPMENT_ADDRESS = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'

test('loads a systemd credential and validates its derived address', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pair-grid-credential-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'pair-grid-private-key'), `${DEVELOPMENT_PRIVATE_KEY}\n`, {
    mode: 0o400,
  })

  const loaded = loadSignerAccount({
    expectedWallet: DEVELOPMENT_ADDRESS,
    keychainService: 'unused',
    environment: { CREDENTIALS_DIRECTORY: directory },
  })
  assert.equal(loaded.source, 'SYSTEMD_CREDENTIAL')
  assert.equal(loaded.account.address, DEVELOPMENT_ADDRESS)
})

test('never treats a private-key environment variable as a credential source', () => {
  assert.throws(
    () =>
      loadSignerAccount({
        expectedWallet: DEVELOPMENT_ADDRESS,
        keychainService: 'unused',
        environment: { PRIVATE_KEY: DEVELOPMENT_PRIVATE_KEY },
        keychainReader: () => {
          throw new Error('missing')
        },
      }),
    /未找到|missing/,
  )
})

test('rejects a credential whose signer is not the configured wallet', () => {
  assert.throws(
    () =>
      loadSignerAccount({
        expectedWallet: '0x0000000000000000000000000000000000000001',
        keychainService: 'test',
        environment: { CREDENTIALS_DIRECTORY: '/synthetic-systemd-credentials' },
        credentialReader: () => DEVELOPMENT_PRIVATE_KEY,
      }),
    /地址不匹配/,
  )
})
