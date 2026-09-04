import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildFeishuPayload,
  createAlertEvent,
  createFeishuSignature,
  deliverFeishuAlert,
  loadFeishuCredential,
  validateFeishuCredential,
} from '../lib/feishu-alerts.mjs'

const CREDENTIAL = {
  provider: 'feishu-custom-bot',
  webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-test-hook',
  signingSecret: 'synthetic-signing-secret',
}

test('matches the documented Feishu HMAC-SHA256 signing algorithm', () => {
  assert.equal(createFeishuSignature(1_599_360_473, 'demo'), 'l1N0gAcBjdwBvGm1xMjOF0XSyaLRpR7tuO5dHfhAYc8=')
})

test('credential loader only accepts a systemd credential with an official hook URL', () => {
  const loaded = loadFeishuCredential(
    { CREDENTIALS_DIRECTORY: '/run/credentials/synthetic.service' },
    (filePath) => {
      assert.equal(filePath, '/run/credentials/synthetic.service/pair-grid-alert')
      return JSON.stringify(CREDENTIAL)
    },
  )
  assert.deepEqual(loaded, CREDENTIAL)
  assert.throws(() => loadFeishuCredential({}, () => ''), /CREDENTIALS_DIRECTORY/)
  assert.throws(
    () => validateFeishuCredential({ ...CREDENTIAL, webhookUrl: 'https://example.com/hook/value' }),
    /官方 HTTPS/,
  )
  assert.throws(
    () => validateFeishuCredential({ ...CREDENTIAL, webhookUrl: `${CREDENTIAL.webhookUrl}?token=leak` }),
    /官方 HTTPS/,
  )
  assert.throws(() => validateFeishuCredential({ ...CREDENTIAL, privateKey: 'never' }), /不支持的字段/)
})

test('payload contains the alert keyword and never includes the signing secret', () => {
  const event = createAlertEvent({
    kind: 'service-failure',
    summary: 'keeper failed',
    details: `RPC https://node.invalid/path?token=secret failed <at user_id="all">everyone</at> 0x${'ab'.repeat(32)}`,
    unit: 'synthetic.service',
    now: new Date('2026-09-04T00:00:00.000Z'),
  })
  const payload = buildFeishuPayload({
    event,
    hostname: 'synthetic-host',
    timestamp: 1_599_360_473,
    signingSecret: CREDENTIAL.signingSecret,
  })
  const serialized = JSON.stringify(payload)
  assert.match(payload.content.text, /\[PAIR 网格告警\]/u)
  assert.match(payload.content.text, /fail-closed/u)
  assert.doesNotMatch(serialized, /node\.invalid|token=secret|synthetic-signing-secret/u)
  assert.doesNotMatch(serialized, /<at|<\/at>/u)
  assert.doesNotMatch(serialized, new RegExp(`0x${'ab'.repeat(32)}`, 'u'))
})

test('delivery accepts only an HTTP success with provider code zero', async () => {
  let requestedUrl
  const acknowledgement = await deliverFeishuAlert({
    credential: CREDENTIAL,
    event: createAlertEvent({ kind: 'synthetic-test', severity: 'test', summary: 'test' }),
    hostname: 'synthetic-host',
    fetchImpl: async (url, options) => {
      requestedUrl = url
      const payload = JSON.parse(options.body)
      assert.equal(options.method, 'POST')
      assert.equal(options.redirect, 'error')
      assert.equal(payload.msg_type, 'text')
      assert.equal(typeof payload.sign, 'string')
      return new Response(JSON.stringify({ code: 0, msg: 'success', data: {} }), { status: 200 })
    },
    now: () => new Date('2026-09-04T00:00:00.000Z'),
    maxAttempts: 1,
  })
  assert.equal(requestedUrl, CREDENTIAL.webhookUrl)
  assert.equal(acknowledgement.providerCode, 0)
  assert.equal(acknowledgement.attempts, 1)

  await assert.rejects(
    deliverFeishuAlert({
      credential: CREDENTIAL,
      event: createAlertEvent({ kind: 'synthetic-test', severity: 'test', summary: 'test' }),
      hostname: 'synthetic-host',
      fetchImpl: async () => new Response(JSON.stringify({ code: 19021, msg: 'sign fail' }), { status: 200 }),
      maxAttempts: 1,
    }),
    /未获服务端成功回执.*code=19021/u,
  )
})

test('delivery retries bounded transport failures without exposing the webhook', async () => {
  let attempts = 0
  const acknowledgement = await deliverFeishuAlert({
    credential: CREDENTIAL,
    event: createAlertEvent({ kind: 'synthetic-test', severity: 'test', summary: 'test' }),
    hostname: 'synthetic-host',
    fetchImpl: async () => {
      attempts += 1
      if (attempts === 1) throw new Error(`request to ${CREDENTIAL.webhookUrl} failed`)
      return new Response(JSON.stringify({ code: 0, msg: 'success' }), { status: 200 })
    },
    sleep: async () => {},
    maxAttempts: 2,
  })
  assert.equal(acknowledgement.attempts, 2)
  assert.equal(attempts, 2)

  await assert.rejects(
    deliverFeishuAlert({
      credential: CREDENTIAL,
      event: createAlertEvent({ kind: 'synthetic-test', severity: 'test', summary: 'test' }),
      hostname: 'synthetic-host',
      fetchImpl: async () => {
        throw new Error(`request to ${CREDENTIAL.webhookUrl} failed`)
      },
      sleep: async () => {},
      maxAttempts: 2,
    }),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /未获服务端成功回执/u)
      assert.doesNotMatch(error.message, /open\.feishu\.cn|synthetic-test-hook/u)
      return true
    },
  )
})
