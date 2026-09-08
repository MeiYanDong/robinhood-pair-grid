import crypto from 'node:crypto'
import { redactSensitiveText } from './runtime-guards.mjs'

const SCHEMA_VERSION = 1
const CANONICAL_READBACK_EVIDENCE_CLASS = 'CANONICAL_CHAIN_READBACK_WITH_LOCAL_STATE_COMPARISON'
const MARTINGALE_READBACK_EVIDENCE_CLASS = 'LIVE_CHAIN_READBACK_WITH_LOCAL_STATE'

/**
 * @typedef {{fingerprint: string, deliveredAt: string}} DeliveryRecord
 * @typedef {{
 *   consecutiveReadbackFailures?: number,
 *   lastReadbackSuccessAt?: string | null,
 *   haltDelivery?: DeliveryRecord | null,
 *   readbackDelivery?: DeliveryRecord | null,
 *   heartbeatDelivery?: DeliveryRecord | null
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

export function assertMartingaleReadbackReport(report) {
  if (report?.evidenceClass !== MARTINGALE_READBACK_EVIDENCE_CLASS) {
    throw new Error(`status 返回意外 evidenceClass ${String(report?.evidenceClass)}`)
  }
  if (!Number.isFinite(Date.parse(report.observedAt))) {
    throw new Error('status 返回无效 observedAt')
  }
  if (typeof report.blockNumber !== 'string' || !/^\d+$/u.test(report.blockNumber)) {
    throw new Error('status 返回无效 blockNumber')
  }
  if (!['BUY_LADDER_ACTIVE', 'MARTINGALE_ACTIVE', 'ROTATION_PENDING'].includes(report.status)) {
    throw new Error(`status 返回非活动状态 ${String(report.status)}`)
  }
  if (
    !Number.isInteger(report.pool?.tick) ||
    !Number.isFinite(Number(report.pool?.pairPriceUsdg)) ||
    Number(report.pool.pairPriceUsdg) <= 0 ||
    typeof report.pool?.liquidity !== 'string' ||
    !/^\d+$/u.test(report.pool.liquidity)
  ) {
    throw new Error('status 返回无效 pool')
  }
  if (
    !Number.isInteger(report.nonce?.latest) ||
    report.nonce.latest < 0 ||
    !Number.isInteger(report.nonce?.pending) ||
    report.nonce.pending < 0 ||
    !Number.isInteger(report.expectedNextNonce) ||
    report.expectedNextNonce < 0
  ) {
    throw new Error('status 返回无效 nonce')
  }
  if (report.nonce.latest !== report.nonce.pending || report.nonce.latest !== report.expectedNextNonce) {
    throw new Error(
      `status nonce 不一致 ${report.nonce.latest}/${report.nonce.pending}/${report.expectedNextNonce}`,
    )
  }
  if (!Array.isArray(report.bands) || report.bands.length !== 5) {
    throw new Error(`status 活动档位数量不是 5：${String(report.bands?.length)}`)
  }
  const identifiers = new Set()
  let readablePositions = 0
  for (const band of report.bands) {
    if (typeof band?.id !== 'string' || identifiers.has(band.id)) {
      throw new Error('status 档位 ID 缺失或重复')
    }
    identifiers.add(band.id)
    if (band.readError) throw new Error(`${band.id} 链上持仓回读失败`)
    if (!band.activePosition || !/^\d+$/u.test(String(band.activePosition.tokenId))) {
      throw new Error(`${band.id} 缺少活动 NFT`)
    }
    if (!/^\d+$/u.test(String(band.activePosition.liquidity))) {
      throw new Error(`${band.id} 返回无效 liquidity`)
    }
    if (BigInt(band.activePosition.liquidity) > 0n) {
      if (band.chain?.ownerMatches !== true || band.chain?.liquidityMatches !== true) {
        throw new Error(`${band.id} owner/liquidity 链上核验失败`)
      }
      readablePositions += 1
    } else if (!report.pendingRotation) {
      throw new Error(`${band.id} 非换腿状态下 liquidity 为 0`)
    }
  }
  if (!/^\d+$/u.test(String(report.balances?.nfts))) throw new Error('status 返回无效 NFT 余额')
  const nftBalance = Number(report.balances.nfts)
  if (nftBalance !== readablePositions) {
    throw new Error(`status NFT 余额 ${nftBalance} 与可核验活动仓位 ${readablePositions} 不一致`)
  }
  if (report.pendingRotation) {
    if (report.status !== 'ROTATION_PENDING' || ![4, 5].includes(readablePositions)) {
      throw new Error('status 换腿状态与活动 NFT 数量不一致')
    }
  } else if (readablePositions !== 5) {
    throw new Error(`status 非换腿状态只有 ${readablePositions} 个可核验仓位`)
  }
  return report
}

export function assessHeartbeat({ modifiedAtMs, now = new Date(), maximumAgeSeconds = 120 }) {
  if (!Number.isInteger(maximumAgeSeconds) || maximumAgeSeconds < 30 || maximumAgeSeconds > 86_400) {
    throw new Error('心跳最大年龄必须在 30 到 86400 秒之间')
  }
  if (!Number.isFinite(modifiedAtMs)) return { ok: false, error: 'Keeper 成功心跳不存在' }
  const ageMs = Math.max(0, now.getTime() - modifiedAtMs)
  return ageMs <= maximumAgeSeconds * 1_000
    ? { ok: true, ageSeconds: Math.floor(ageMs / 1_000) }
    : {
        ok: false,
        ageSeconds: Math.floor(ageMs / 1_000),
        error: `Keeper 成功心跳已超过 ${maximumAgeSeconds} 秒`,
      }
}

/**
 * @param {{
 *   previous?: PriorMonitorState,
 *   halt?: Record<string, any> | null,
 *   readback: {ok: boolean, error?: string},
 *   heartbeat?: {ok: boolean, error?: string, ageSeconds?: number},
 *   strategyLabel?: string,
 *   now?: Date,
 *   failureThreshold?: number,
 *   repeatMinutes?: number
 * }} options
 */
export function planMonitorRun({
  previous = {},
  halt = null,
  readback,
  heartbeat = { ok: true },
  strategyLabel = 'PAIR 网格',
  now = new Date(),
  failureThreshold = 3,
  repeatMinutes = 360,
}) {
  if (!readback || typeof readback.ok !== 'boolean') throw new Error('readback 结果无效')
  if (!heartbeat || typeof heartbeat.ok !== 'boolean') throw new Error('heartbeat 结果无效')
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
    heartbeatDelivery: heartbeat.ok ? null : previous.heartbeatDelivery || null,
  }
  const alerts = []

  if (halt) {
    const fingerprint = haltFingerprint(halt)
    if (shouldRepeat(next.haltDelivery, fingerprint, nowMs, repeatMs)) {
      alerts.push({
        kind: 'persistent-halted',
        severity: 'critical',
        fingerprint,
        summary: `${strategyLabel} 处于持久 HALTED 状态`,
        details: `command=${halt.command || 'unknown'}; haltedAt=${halt.haltedAt || 'unknown'}; reason=${redactSensitiveText(halt.reason || '原因未记录')}`,
      })
    }
  }

  if (!heartbeat.ok) {
    const fingerprint = 'stale-keeper-heartbeat'
    if (shouldRepeat(next.heartbeatDelivery, fingerprint, nowMs, repeatMs)) {
      alerts.push({
        kind: 'stale-keeper-heartbeat',
        severity: 'critical',
        fingerprint,
        summary: `${strategyLabel} Keeper 成功心跳中断`,
        details: redactSensitiveText(heartbeat.error || 'Keeper 成功心跳异常'),
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
  else if (alert.kind === 'stale-keeper-heartbeat') next.heartbeatDelivery = delivery
  else throw new Error(`不支持记录告警类型 ${alert.kind}`)
  return next
}
