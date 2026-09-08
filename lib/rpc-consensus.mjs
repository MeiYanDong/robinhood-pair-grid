function comparablePoolState(pool) {
  return [
    String(pool.sqrtPriceX96),
    Number(pool.tick),
    Number(pool.protocolFee),
    Number(pool.lpFee),
    String(pool.liquidity),
  ].join(':')
}

/**
 * Require two independently configured RPC paths to agree on chain identity,
 * one common canonical block, wallet nonce and the pool state at that block.
 * Endpoint URLs never enter the returned report or thrown errors.
 */
export async function verifyRpcConsensus({
  clients,
  expectedChainId,
  walletAddress,
  confirmationDepth,
  maximumHeadDivergence = 128n,
  readPoolState,
}) {
  if (!Array.isArray(clients) || clients.length < 2) {
    throw new Error('HARD: 写前 RPC 共识至少需要两个独立读取端点')
  }
  if (typeof confirmationDepth !== 'bigint' || confirmationDepth <= 0n) {
    throw new Error('HARD: RPC 共识确认深度无效')
  }
  if (typeof maximumHeadDivergence !== 'bigint' || maximumHeadDivergence < 0n) {
    throw new Error('HARD: RPC 最大头部偏差无效')
  }
  if (typeof readPoolState !== 'function') throw new Error('HARD: RPC 共识缺少池状态读取器')

  const identities = await Promise.all(
    clients.map(async (client) => ({
      chainId: await client.getChainId(),
      head: await client.getBlockNumber(),
    })),
  )
  if (identities.some(({ chainId }) => chainId !== expectedChainId)) {
    throw new Error('HARD: 写前 RPC chainId 不一致')
  }
  const heads = identities.map(({ head }) => head)
  const minimumHead = heads.reduce((minimum, head) => (head < minimum ? head : minimum))
  const maximumHead = heads.reduce((maximum, head) => (head > maximum ? head : maximum))
  if (maximumHead - minimumHead > maximumHeadDivergence) {
    throw new Error('HARD: 写前 RPC 链头偏差超过上限')
  }
  if (minimumHead < confirmationDepth) throw new Error('HARD: RPC 链高不足以形成共同安全区块')
  const commonSafeBlock = minimumHead - confirmationDepth + 1n

  const observations = await Promise.all(
    clients.map(async (client) => {
      const [block, nonceLatest, noncePending, pool] = await Promise.all([
        client.getBlock({ blockNumber: commonSafeBlock }),
        client.getTransactionCount({ address: walletAddress, blockTag: 'latest' }),
        client.getTransactionCount({ address: walletAddress, blockTag: 'pending' }),
        readPoolState(client, commonSafeBlock),
      ])
      if (!block.hash) throw new Error('HARD: 写前 RPC 安全区块缺少 block hash')
      return { blockHash: block.hash.toLowerCase(), nonceLatest, noncePending, pool }
    }),
  )
  const reference = observations[0]
  if (observations.some(({ blockHash }) => blockHash !== reference.blockHash)) {
    throw new Error('HARD: 写前 RPC 对共同安全区块 hash 无共识')
  }
  if (
    observations.some(
      ({ nonceLatest, noncePending }) =>
        nonceLatest !== reference.nonceLatest || noncePending !== reference.noncePending,
    )
  ) {
    throw new Error('HARD: 写前 RPC 对钱包 nonce 无共识')
  }
  if (reference.nonceLatest !== reference.noncePending) {
    throw new Error('HARD: 写前 RPC 发现钱包存在 pending nonce')
  }
  const referencePool = comparablePoolState(reference.pool)
  if (observations.some(({ pool }) => comparablePoolState(pool) !== referencePool)) {
    throw new Error('HARD: 写前 RPC 对安全区块池状态无共识')
  }
  return {
    verified: true,
    endpointCount: clients.length,
    minimumHead,
    maximumHead,
    commonSafeBlock,
    commonSafeBlockHash: reference.blockHash,
    nonceLatest: reference.nonceLatest,
    noncePending: reference.noncePending,
    pool: reference.pool,
  }
}
