import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { redactSensitiveText } from './runtime-guards.mjs'

export const ALERT_CREDENTIAL_NAME = 'pair-grid-alert'
const PROVIDER = 'feishu-custom-bot'
const FEISHU_ORIGIN = 'https://open.feishu.cn'
const FEISHU_HOOK_PATH = /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/u
const MAX_DETAIL_LENGTH = 3_000
const MAX_RESPONSE_LENGTH = 16_384
const CREDENTIAL_KEYS = new Set(['provider', 'webhookUrl', 'signingSecret'])

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON object`)
  }
  return value
}

export function validateFeishuCredential(value) {
  const credential = requireObject(value, '告警凭据')
  if (Object.keys(credential).some((key) => !CREDENTIAL_KEYS.has(key))) {
    throw new Error('告警凭据包含不支持的字段')
  }
  if (credential.provider !== PROVIDER) {
    throw new Error(`告警 provider 必须是 ${PROVIDER}`)
  }
  if (typeof credential.webhookUrl !== 'string' || credential.webhookUrl.length > 512) {
    throw new Error('飞书 webhookUrl 缺失或过长')
  }
  if (typeof credential.signingSecret !== 'string' || credential.signingSecret.length < 6) {
    throw new Error('飞书 signingSecret 缺失或过短')
  }

  let webhook
  try {
    webhook = new URL(credential.webhookUrl)
  } catch {
    throw new Error('飞书 webhookUrl 不是有效 URL')
  }
  if (
    webhook.origin !== FEISHU_ORIGIN ||
    webhook.username ||
    webhook.password ||
    webhook.search ||
    webhook.hash ||
    !FEISHU_HOOK_PATH.test(webhook.pathname)
  ) {
    throw new Error('飞书 webhookUrl 必须是官方 HTTPS 自定义机器人地址')
  }

  return {
    provider: PROVIDER,
    webhookUrl: webhook.toString(),
    signingSecret: credential.signingSecret,
  }
}

export function loadFeishuCredential(
  environment = process.env,
  readFile = (filePath) => fs.readFileSync(filePath, 'utf8'),
) {
  const directory = environment.CREDENTIALS_DIRECTORY
  if (!directory || !path.isAbsolute(directory)) {
    throw new Error('告警凭据只能从 systemd CREDENTIALS_DIRECTORY 读取')
  }
  const resolvedDirectory = path.resolve(directory)
  const credentialPath = path.resolve(resolvedDirectory, ALERT_CREDENTIAL_NAME)
  if (path.dirname(credentialPath) !== resolvedDirectory) {
    throw new Error('告警凭据路径越过了 systemd 凭据目录边界')
  }

  let parsed
  try {
    parsed = JSON.parse(readFile(credentialPath))
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('告警凭据不是有效 JSON')
    throw new Error('无法读取 systemd 告警凭据')
  }
  return validateFeishuCredential(parsed)
}

function sanitizeMessageText(value, maximumLength) {
  return redactSensitiveText(value)
    .replace(/\b0x[0-9a-f]{64}\b/giu, '[REDACTED_HEX_32]')
    .replace(/[<>&]/gu, (character) => ({ '<': '‹', '>': '›', '&': '＆' })[character])
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .trim()
    .slice(0, maximumLength)
}

export function createFeishuSignature(timestamp, signingSecret) {
  if (!Number.isInteger(timestamp) || timestamp <= 0) throw new Error('飞书签名时间戳无效')
  if (typeof signingSecret !== 'string' || !signingSecret) throw new Error('飞书签名密钥无效')
  return crypto.createHmac('sha256', `${timestamp}\n${signingSecret}`).update('').digest('base64')
}

export function createAlertEvent({
  kind,
  severity = 'critical',
  summary,
  details = '',
  unit = null,
  now = new Date(),
}) {
  if (!/^[a-z][a-z0-9-]{2,63}$/u.test(kind)) throw new Error('告警 kind 无效')
  if (!['warning', 'critical', 'recovery', 'test'].includes(severity)) {
    throw new Error('告警 severity 无效')
  }
  if (typeof summary !== 'string' || !summary.trim()) throw new Error('告警 summary 不能为空')

  return {
    eventId: crypto.randomUUID(),
    kind,
    severity,
    summary: sanitizeMessageText(summary, 500),
    details: sanitizeMessageText(details || '无附加详情', MAX_DETAIL_LENGTH),
    unit: unit ? sanitizeMessageText(unit, 200) : null,
    occurredAt: now.toISOString(),
  }
}

export function buildFeishuPayload({ event, hostname, timestamp, signingSecret }) {
  const signature = createFeishuSignature(timestamp, signingSecret)
  const lines = [
    '[PAIR 网格告警]',
    `级别：${event.severity.toUpperCase()}`,
    `事件：${event.summary}`,
    `类型：${event.kind}`,
    `事件 ID：${event.eventId}`,
    `主机：${sanitizeMessageText(hostname, 200)}`,
    `发生时间：${event.occurredAt}`,
  ]
  if (event.unit) lines.push(`systemd unit：${event.unit}`)
  lines.push(`详情：${event.details}`)
  lines.push('边界：策略保持 fail-closed；此告警程序不加载交易私钥，也不会签名或广播交易。')

  return {
    timestamp: String(timestamp),
    sign: signature,
    msg_type: 'text',
    content: { text: lines.join('\n') },
  }
}

function parseProviderResponse(responseText) {
  if (responseText.length > MAX_RESPONSE_LENGTH) throw new Error('飞书响应体异常过大')
  let body
  try {
    body = JSON.parse(responseText)
  } catch {
    throw new Error('飞书响应不是有效 JSON')
  }
  requireObject(body, '飞书响应')
  return body
}

export async function deliverFeishuAlert({
  credential,
  event,
  hostname,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = 10_000,
  maxAttempts = 3,
  sleep = (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds)
    }),
}) {
  const checked = validateFeishuCredential(credential)
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node 运行时不支持 fetch')
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new Error('告警重试次数必须在 1 到 5 之间')
  }

  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const requestedAt = now()
      const timestamp = Math.floor(requestedAt.getTime() / 1_000)
      const payload = buildFeishuPayload({
        event,
        hostname,
        timestamp,
        signingSecret: checked.signingSecret,
      })
      const response = await fetchImpl(checked.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const body = parseProviderResponse(await response.text())
      if (!response.ok || body.code !== 0) {
        throw new Error(`飞书拒绝告警：HTTP ${response.status}, code=${String(body.code)}`)
      }
      return {
        provider: PROVIDER,
        eventId: event.eventId,
        providerCode: body.code,
        deliveredAt: now().toISOString(),
        attempts: attempt,
      }
    } catch (error) {
      lastError = new Error(redactSensitiveText(error?.message || String(error)))
      if (attempt < maxAttempts) await sleep(250 * 2 ** (attempt - 1))
    }
  }
  throw new Error(`外部告警未获服务端成功回执：${lastError?.message || '未知错误'}`)
}
