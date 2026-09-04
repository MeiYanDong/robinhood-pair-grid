import test from 'node:test'
import assert from 'node:assert/strict'
import {
  advisoryQueryUrl,
  auditRuntimePackageSpecs,
  runtimePackageSpecs,
  validateAdvisoryPage,
} from '../lib/github-advisory-audit.mjs'

const HIGH_ADVISORY = {
  ghsa_id: 'GHSA-96hv-2xvq-fx4p',
  severity: 'high',
  summary: 'ws memory exhaustion',
  html_url: 'https://github.com/advisories/GHSA-96hv-2xvq-fx4p',
  withdrawn_at: null,
}

test('runtime package specs include production peers and exclude dev-only packages', () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { viem: '1.0.0' }, devDependencies: { eslint: '1.0.0' } },
      'node_modules/viem': { version: '1.0.0' },
      'node_modules/ws': { version: '8.21.0', devOptional: true },
      'node_modules/viem/node_modules/ws': { version: '8.21.0' },
      'node_modules/eslint': { version: '1.0.0', dev: true },
      'node_modules/parent/node_modules/@scope/runtime': { version: '2.0.0' },
    },
  }
  assert.deepEqual(runtimePackageSpecs(lock), ['@scope/runtime@2.0.0', 'viem@1.0.0', 'ws@8.21.0'])
})

test('runtime package parsing rejects incomplete or unsafe lockfile data', () => {
  assert.throws(() => runtimePackageSpecs({ lockfileVersion: 1, packages: {} }), /lockfileVersion 2 or newer/)
  assert.throws(
    () =>
      runtimePackageSpecs({
        lockfileVersion: 3,
        packages: { 'node_modules/unsafe,name': { version: '1.0.0' } },
      }),
    /invalid package name/,
  )
  assert.throws(() => runtimePackageSpecs({ lockfileVersion: 3, packages: {} }), /no runtime packages/)
})

test('advisory query is version-specific and severity-specific', () => {
  const url = advisoryQueryUrl(['ws@8.21.0', '@scope/runtime@2.0.0'], 'critical')
  assert.equal(url.origin, 'https://api.github.com')
  assert.equal(url.pathname, '/advisories')
  assert.equal(url.searchParams.get('ecosystem'), 'npm')
  assert.equal(url.searchParams.get('severity'), 'critical')
  assert.equal(url.searchParams.get('affects'), 'ws@8.21.0,@scope/runtime@2.0.0')
  assert.equal(url.searchParams.get('is_withdrawn'), 'false')
})

test('advisory response validation fails closed on malformed or withdrawn data', () => {
  assert.deepEqual(validateAdvisoryPage([HIGH_ADVISORY], 'high'), [
    {
      ghsaId: HIGH_ADVISORY.ghsa_id,
      severity: 'high',
      summary: HIGH_ADVISORY.summary,
      url: HIGH_ADVISORY.html_url,
    },
  ])
  assert.throws(() => validateAdvisoryPage({}, 'high'), /must be an array/)
  assert.throws(
    () => validateAdvisoryPage([{ ...HIGH_ADVISORY, withdrawn_at: '2026-01-01T00:00:00Z' }], 'high'),
    /invalid shape/,
  )
  assert.throws(() => validateAdvisoryPage([HIGH_ADVISORY], 'critical'), /invalid shape/)
})

test('production audit reports blocking findings from every requested severity', async () => {
  const severities = []
  const fetchImpl = async (input) => {
    const url = new URL(input)
    const severity = url.searchParams.get('severity')
    severities.push(severity)
    return new Response(JSON.stringify(severity === 'high' ? [HIGH_ADVISORY] : []), { status: 200 })
  }
  const result = await auditRuntimePackageSpecs(['ws@8.18.0'], { fetchImpl, maxAttempts: 1 })
  assert.deepEqual(severities, ['high', 'critical'])
  assert.equal(result.packageVersions, 1)
  assert.equal(result.high, 1)
  assert.equal(result.critical, 0)
  assert.equal(result.totalBlocking, 1)
  assert.equal(result.findings[0].ghsaId, HIGH_ADVISORY.ghsa_id)
})

test('production audit retries transport failures and rejects incomplete responses', async () => {
  let attempts = 0
  const retryEvents = []
  const fetchImpl = async () => {
    attempts += 1
    if (attempts === 1) throw new Error('temporary failure')
    return new Response('[]', { status: 200 })
  }
  const result = await auditRuntimePackageSpecs(['ws@8.21.0'], {
    fetchImpl,
    maxAttempts: 2,
    retryDelayMs: 0,
    onRetry: (event) => retryEvents.push(event),
  })
  assert.equal(result.totalBlocking, 0)
  assert.equal(attempts, 3)
  assert.equal(retryEvents.length, 1)

  await assert.rejects(
    auditRuntimePackageSpecs(['ws@8.21.0'], {
      fetchImpl: async () => new Response('{}', { status: 200 }),
      maxAttempts: 1,
    }),
    /must be an array/,
  )
})
