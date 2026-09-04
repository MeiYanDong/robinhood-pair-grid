import crypto from 'node:crypto'
import { redactSensitiveText } from './runtime-guards.mjs'

const SCHEMA_VERSION = 1
const CANONICAL_READBACK_EVIDENCE_CLASS = 'CANONICAL_CHAIN_READBACK_WITH_LOCAL_STATE_COMPARISON'

/**
 * @typedef {{fingerprint: string, deliveredAt: string}} DeliveryRecord
 * @typedef {{
 *   consecutiveReadbackFailures?: number,
 *   lastReadbackSuccessAt?: string | null,
 *   haltDelivery?: DeliveryRecord | null,
 *   readbackDelivery?: DeliveryRecord | null
 * }} PriorMonitorState
 */

function asNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function asTimestamp(value) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(timestamp) ? timestamp : null
}

function shouldRepeat(delivery, fingerprint, nowMs, repeatMs) {
  if (!delivery || delivery.fingerprint !== fingerprint) return true
  const deliveredAt = asTimestamp(delivery.deliveredAt)
  return deliveredAt === null || nowMs - deliveredAt >= repeatMs
}

function haltFingerprint(halt) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        status: halt?.status,
        command: halt?.command,
        reason: redactSensitiveText(halt?.reason || '原因未记录'),
        haltedAt: halt?.haltedAt,
      }),
    )
    .digest('hex')
}

export function assertCanonicalReadbackReport(report) {
  if (report?.evidenceClass !== CANONICAL_READBACK_EVIDENCE_CLASS) {
    throw new Error(`status 返回意外 evidenceClass ${String(report?.evidenceClass)}`)
  }
  if (!Number.isFinite(Date.parse(report.observedAt))) {
    throw new Error('status 返回无效 observedAt')
  }
  if (typeof report.blockNumber !== 'string' || !/^\d+$/u.test(report.blockNumber)) {
    throw new Error('status 返回无效 blockNumber')
  }
  if (typeof report.localStatus !== 'string' || report.localStatus.length === 0) {
    throw new Error('status 返回无效 localStatus')
  }
  if (
    !Number.isInteger(report.nonce?.latest) ||
    report.nonce.latest < 0 ||
    !Number.isInteger(report.nonce?.pending) ||
    report.nonce.pending < 0
  ) {
    throw new Error('status 返回无效 nonce')
  }
  return report
}

/**
 * @param {{
 *   previous?: PriorMonitorState,
 *   halt?: Record<string, any> | null,
 *   readback: {ok: boolean, error?: string},
 *   now?: Date,
 *   failureThreshold?: number,
 *   repeatMinutes?: number
 * }} options
 */
export function planMonitorRun({
  previous = {},
  halt = null,
  readback,
  now = new Date(),
  failureThreshold = 3,
  repeatMinutes = 360,
}) {
  if (!readback || typeof readback.ok !== 'boolean') throw new Error('readback 结果无效')
  if (!Number.isInteger(failureThreshold) || failureThreshold < 1 || failureThreshold > 100) {
    throw new Error('readback 失败阈值必须在 1 到 100 之间')
  }
  if (!Number.isInteger(repeatMinutes) || repeatMinutes < 5 || repeatMinutes > 10_080) {
    throw new Error('告警重复间隔必须在 5 到 10080 分钟之间')
  }

  const nowIso = now.toISOString()
  const nowMs = now.getTime()
  const repeatMs = repeatMinutes * 60_000
  const priorFailures = asNonNegativeInteger(previous.consecutiveReadbackFailures)
  const consecutiveReadbackFailures = readback.ok ? 0 : priorFailures + 1
  const next = {
    schemaVersion: SCHEMA_VERSION,
    checkedAt: nowIso,
    consecutiveReadbackFailures,
    lastReadbackSuccessAt: readback.ok ? nowIso : previous.lastReadbackSuccessAt || null,
    lastReadbackFailureAt: readback.ok ? null : nowIso,
    lastReadbackError: readback.ok
      ? null
      : redactSensitiveText(readback.error || '未知 readback 错误').slice(0, 1_000),
    haltDelivery: halt ? previous.haltDelivery || null : null,
    readbackDelivery: readback.ok ? null : previous.readbackDelivery || null,
  }
  const alerts = []

  if (halt) {
    const fingerprint = haltFingerprint(halt)
    if (shouldRepeat(next.haltDelivery, fingerprint, nowMs, repeatMs)) {
      alerts.push({
        kind: 'persistent-halted',
        severity: 'critical',
        fingerprint,
        summary: 'PAIR 网格处于持久 HALTED 状态',
        details: `command=${halt.command || 'unknown'}; haltedAt=${halt.haltedAt || 'unknown'}; reason=${redactSensitiveText(halt.reason || '原因未记录')}`,
      })
    }
  }

  if (!readback.ok && consecutiveReadbackFailures >= failureThreshold) {
    const fingerprint = 'repeated-readback-failure'
    if (shouldRepeat(next.readbackDelivery, fingerprint, nowMs, repeatMs)) {
      alerts.push({
        kind: 'repeated-readback-failure',
        severity: 'critical',
        fingerprint,
        summary: `链上只读核验连续失败 ${consecutiveReadbackFailures} 次`,
        details: next.lastReadbackError,
      })
    }
  }

  return { state: next, alerts }
}

export function markMonitorDelivery(state, alert, deliveredAt) {
  const next = structuredClone(state)
  const delivery = { fingerprint: alert.fingerprint, deliveredAt }
  if (alert.kind === 'persistent-halted') next.haltDelivery = delivery
  else if (alert.kind === 'repeated-readback-failure') next.readbackDelivery = delivery
  else throw new Error(`不支持记录告警类型 ${alert.kind}`)
  return next
}
