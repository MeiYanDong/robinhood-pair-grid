import assert from 'node:assert/strict'
import test from 'node:test'

import { parseBroadcastEndpoints, parseRpcEndpoints, rpcEndpointSummary } from '../lib/rpc-endpoints.mjs'

test('RPC endpoint list is ordered, deduplicated and overrides the legacy single URL', () => {
  const endpoints = parseRpcEndpoints({
    RH_RPC_URL: 'https://ignored.example',
    RH_RPC_URLS: 'https://primary.example/rpc, https://backup.example/rpc\nhttps://primary.example/rpc',
  })
  assert.deepEqual(endpoints, ['https://primary.example/rpc', 'https://backup.example/rpc'])
  assert.deepEqual(rpcEndpointSummary(endpoints), { configured: 2, failoverAvailable: true })
})

test('RPC endpoint parser supports the legacy variable and safe local HTTP', () => {
  assert.deepEqual(parseRpcEndpoints({ RH_RPC_URL: 'https://one.example' }), ['https://one.example/'])
  assert.deepEqual(parseRpcEndpoints({ RH_RPC_URL: 'http://127.0.0.1:8545' }), ['http://127.0.0.1:8545/'])
})

test('broadcast endpoints default to read RPCs plus the official direct sequencer', () => {
  const reads = parseRpcEndpoints({ RH_RPC_URL: 'https://one.example' })
  assert.deepEqual(parseBroadcastEndpoints({}, reads), [
    'https://one.example/',
    'https://sequencer.mainnet.chain.robinhood.com/',
  ])
  assert.deepEqual(parseBroadcastEndpoints({ RH_BROADCAST_URLS: 'https://broadcast.example/rpc' }, reads), [
    'https://broadcast.example/rpc',
  ])
})

test('RPC endpoint parser rejects unsafe or over-broad configurations without echoing secrets', () => {
  assert.throws(() => parseRpcEndpoints({ RH_RPC_URL: 'http://remote.example/?token=secret' }), {
    message: 'RPC 端点 1 的非本机连接必须使用 HTTPS',
  })
  assert.throws(() => parseRpcEndpoints({ RH_RPC_URL: 'ftp://user:secret@example.com' }), {
    message: 'RPC 端点 1 只允许 HTTP(S)',
  })
  assert.throws(
    () =>
      parseRpcEndpoints({
        RH_RPC_URLS: Array.from({ length: 6 }, (_, index) => `https://rpc${index}.example`).join(','),
      }),
    /最多允许 5 个/u,
  )
})
