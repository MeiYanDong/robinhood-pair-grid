const DEFAULT_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com'
const DEFAULT_SEQUENCER_URL = 'https://sequencer.mainnet.chain.robinhood.com'

function splitEndpoints(value) {
  return String(value || '')
    .split(/[\n,]/u)
    .map((item) => item.trim())
    .filter(Boolean)
}

function validateEndpoint(raw, index) {
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`RPC 端点 ${index + 1} 不是有效 URL`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`RPC 端点 ${index + 1} 只允许 HTTP(S)`)
  }
  if (parsed.username || parsed.password) {
    throw new Error(`RPC 端点 ${index + 1} 不允许 URL 用户凭据`)
  }
  if (parsed.protocol === 'http:' && !['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname)) {
    throw new Error(`RPC 端点 ${index + 1} 的非本机连接必须使用 HTTPS`)
  }
  return parsed.toString()
}

export function parseRpcEndpoints(environment = process.env) {
  const configured = splitEndpoints(environment.RH_RPC_URLS)
  const candidates = configured.length
    ? configured
    : splitEndpoints(environment.RH_RPC_URL || DEFAULT_RPC_URL)
  if (candidates.length > 5) throw new Error('RPC 端点最多允许 5 个')
  const unique = []
  for (const candidate of candidates) {
    const endpoint = validateEndpoint(candidate, unique.length)
    if (!unique.includes(endpoint)) unique.push(endpoint)
  }
  if (unique.length === 0) throw new Error('至少需要一个 RPC 端点')
  return Object.freeze(unique)
}

export function parseBroadcastEndpoints(
  environment = process.env,
  rpcEndpoints = parseRpcEndpoints(environment),
) {
  const configured = splitEndpoints(environment.RH_BROADCAST_URLS)
  const candidates = configured.length ? configured : [...rpcEndpoints, DEFAULT_SEQUENCER_URL]
  if (candidates.length > 6) throw new Error('RPC 广播端点最多允许 6 个')
  const unique = []
  for (const candidate of candidates) {
    const endpoint = validateEndpoint(candidate, unique.length)
    if (!unique.includes(endpoint)) unique.push(endpoint)
  }
  if (unique.length === 0) throw new Error('至少需要一个 RPC 广播端点')
  return Object.freeze(unique)
}

export function rpcEndpointSummary(endpoints) {
  return {
    configured: endpoints.length,
    failoverAvailable: endpoints.length > 1,
  }
}
