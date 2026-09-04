const INACTIVE_STATUSES = new Set(['NO_LOCAL_STATE', 'EXITED', 'ABORTED'])
const ACTIVE_STATUSES = new Set(['BUY_ACTIVE', 'SELL_ACTIVE'])

export function assertLiveArm(environment = process.env) {
  if (environment.PAIR_GRID_LIVE_ARM !== '1') {
    throw new Error('真实交易未武装：必须显式设置 PAIR_GRID_LIVE_ARM=1')
  }
}

export function assertNonceControl({ latest, pending, expected }) {
  if (!Number.isInteger(latest) || !Number.isInteger(pending)) {
    throw new Error('链上 nonce 必须是整数')
  }
  if (latest !== pending) {
    throw new Error(`存在 pending nonce：latest=${latest}, pending=${pending}`)
  }
  if (expected !== undefined && expected !== null && latest !== expected) {
    throw new Error(`签名器 nonce 隔离破坏：本地预期 ${expected}，链上 ${latest}`)
  }
}

export function assertActivePosition(position) {
  if (!position) throw new Error('活动状态缺少链上 NFT 读回')
  if (!position.ownerMatches) throw new Error('NFT owner 与策略钱包不匹配')
  if (!position.liquidityMatches) throw new Error('NFT 流动性与本地账本不匹配')
  if (BigInt(position.liquidity) <= 0n) throw new Error('活动 NFT 链上流动性为 0')
}

export function decideKeeperAction({ local, result, wallet }) {
  const status = result?.localStatus || local?.status || 'NO_LOCAL_STATE'
  if (!local || INACTIVE_STATUSES.has(status)) {
    return { action: 'NO_ACTION', reason: status }
  }
  if (!ACTIVE_STATUSES.has(local.status)) {
    throw new Error(`Keeper 发现需要人工核对的状态: ${local.status}`)
  }
  if (local.pendingRotation || local.pendingExit) {
    throw new Error('Keeper 发现未完成的本地交易意图；必须先 reconcile')
  }

  assertNonceControl({
    latest: wallet.nonceLatest,
    pending: wallet.noncePending,
    expected: local.control?.expectedNextNonce,
  })
  assertActivePosition(result.position)

  if (!result.position.fullyConverted) {
    return { action: 'NO_ACTION', reason: 'ACTIVE_LEG_NOT_FULLY_CONVERTED' }
  }
  return { action: 'ROTATE', reason: 'ACTIVE_LEG_FULLY_CONVERTED' }
}

export function redactSensitiveText(value) {
  return String(value)
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/giu, '[REDACTED_URL]')
    .replace(/\b(api[_-]?key|token|secret|password)=([^\s&]+)/giu, '$1=[REDACTED]')
}
