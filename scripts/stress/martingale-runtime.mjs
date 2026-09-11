import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import * as viemExports from 'viem'
// The adapter deliberately accepts a small set of different synthetic RPC shapes.
const viem = /** @type {any} */ (viemExports)
import { positionAmounts, sqrtRatioAtTick } from '../../lib/uniswap-v4-position.mjs'
import { directPairTickAtPrice, directPairPriceAtTick } from '../../lib/finite-martingale.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const PAIR = '0x6b1d42927B1a84eC28Fa88d4fC6FA7AF404966be'
const PM = '0x58daec3116aae6D93017bAAea7749052E8a04fA7'
const PERMIT = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const ZERO = viem.zeroAddress
const poolKey = { currency0: USDG, currency1: PAIR, fee: 10000, tickSpacing: 100, hooks: ZERO }
const poolId = '0x97f48c8d9639b7940874b6c6a43b3d606d070a694920b545acff9c35926593a6'
const abi = viem.parseAbi([
  'function approve(address,uint256) returns(bool)',
  'function approve(address token,address spender,uint160 amount,uint48 expiration)',
  'function execute(bytes commands,bytes[] inputs,uint256 deadline) payable',
  'function multicall(bytes[]) returns(bytes[])',
  'function modifyLiquidities(bytes,uint256)',
])
const tokenEvent = viem.parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)'])
const nftEvent = viem.parseAbi(['event Transfer(address indexed from,address indexed to,uint256 indexed id)'])
const mintTypes = viem.parseAbiParameters(
  '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks),int24,int24,uint256,uint128,uint128,address,bytes',
)
const stringify = (value) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
const lower = (value) => value.toLowerCase()

// Offline chain adapter only. No transport, signing key, credential or external fetch is available.
export class StressRuntime {
  constructor(seed, options = {}) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'martingale-stress-'))
    this.seed = structuredClone(seed)
    this.wallet = seed.wallet
    this.clock = Date.parse('2026-09-09T03:00:00Z')
    this.head = 60000000n
    this.path = [{ block: 0n, tick: Math.round(directPairTickAtPrice(0.0096)) }]
    this.nonce = seed.control.expectedNextNonce
    this.eth = BigInt(options.eth || '3815642979008000')
    this.usdg = BigInt(seed.accounting.walletUsdgAtomic)
    this.pair = BigInt(seed.accounting.walletPairWei)
    this.positions = new Map(
      seed.bands.map((b) => [
        b.activePosition.tokenId,
        { ...b.activePosition, liquidity: BigInt(b.activePosition.liquidity), owner: this.wallet },
      ]),
    )
    this.nextNft = 9000000n
    this.allowances = new Map([
      [lower(USDG), 0n],
      [lower(PAIR), 0n],
    ])
    this.routerAllowances = new Map()
    this.signed = new Map()
    this.receipts = new Map()
    this.transactions = new Map()
    this.mined = []
    this.logs = []
    this.fault = {}
    this.gasPrice = 225280000n
    this.marketAnchor = null
    fs.writeFileSync(this.statePath, stringify(this.seed))
  }
  get statePath() {
    return path.join(this.dir, 'pair-grid.json')
  }
  get state() {
    return JSON.parse(fs.readFileSync(this.statePath, 'utf8'))
  }
  get halt() {
    const p = path.join(this.dir, 'pair-grid.halted.json')
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
  }
  close() {
    fs.rmSync(this.dir, { recursive: true, force: true })
  }
  blockHash(block) {
    return viem.keccak256(viem.toHex(`offline-block-${block}`))
  }
  tickAt(block = this.head) {
    return [...this.path].reverse().find((item) => item.block <= block).tick
  }
  advance(price, blocks = 300n) {
    this.head += blocks
    this.clock += Number(blocks) * 100
    this.path.push({ block: this.head - blocks + 1n, tick: Math.round(directPairTickAtPrice(price)) })
  }
  tokenLog(token, from, to, amount) {
    return {
      address: token,
      topics: viem.encodeEventTopics({ abi: tokenEvent, eventName: 'Transfer', args: { from, to } }),
      data: viem.encodeAbiParameters([{ type: 'uint256' }], [amount]),
    }
  }
  nftLog(from, to, id) {
    return {
      address: PM,
      topics: viem.encodeEventTopics({ abi: nftEvent, eventName: 'Transfer', args: { from, to, id } }),
      data: '0x',
    }
  }
  /** @returns {any} */
  decode(request) {
    const decoded = viem.decodeFunctionData({ abi, data: request.data })
    if (decoded.functionName === 'approve' && decoded.args.length === 4)
      return {
        kind: 'router_approve',
        token: decoded.args[0],
        spender: decoded.args[1],
        amount: decoded.args[2],
        expiration: decoded.args[3],
      }
    if (decoded.functionName === 'execute') {
      assert.equal(decoded.args[0], '0x10')
      assert.ok(BigInt(decoded.args[2]) >= BigInt(Math.floor(this.clock / 1000)), 'swap deadline')
      const [actions, params] = viem.decodeAbiParameters(
        viem.parseAbiParameters('bytes actions,bytes[] params'),
        decoded.args[1][0],
      )
      assert.equal(actions, '0x060b0e')
      const [swap] = viem.decodeAbiParameters(
        viem.parseAbiParameters(
          '((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData) params',
        ),
        params[0],
      )
      const [currency, recipient] = viem.decodeAbiParameters(
        viem.parseAbiParameters('address,address,uint256'),
        params[2],
      )
      assert.equal(lower(currency), lower(USDG))
      assert.equal(lower(recipient), lower(this.wallet))
      assert.equal(swap.zeroForOne, false)
      assert.deepEqual(swap.poolKey, poolKey)
      return { kind: 'swap', amount: swap.amountIn, minimum: swap.amountOutMinimum, router: request.to }
    }
    if (decoded.functionName === 'approve')
      return { kind: 'approve', token: request.to, amount: decoded.args[1] }
    const inner =
      decoded.functionName === 'multicall'
        ? viem.decodeFunctionData({ abi, data: decoded.args[0][1] })
        : decoded
    const [actions, params] = viem.decodeAbiParameters(
      viem.parseAbiParameters('bytes,bytes[]'),
      inner.args[0],
    )
    if (actions.startsWith('0x03')) {
      const [id, min0, min1] = viem.decodeAbiParameters(
        viem.parseAbiParameters('uint256,uint128,uint128,bytes'),
        params[0],
      )
      return { kind: 'burn', id, min0, min1 }
    }
    assert.ok(actions.startsWith('0x02'), 'unsupported simulated calldata')
    const [key, tickLower, tickUpper, liquidity, max0, max1, owner] = viem.decodeAbiParameters(
      mintTypes,
      params[0],
    )
    return { kind: 'mint', key, tickLower, tickUpper, liquidity, max0, max1, owner }
  }
  check(request) {
    const operation = this.decode(request)
    if (operation.kind === 'swap') {
      const output = (((operation.amount * (1n << 192n)) / sqrtRatioAtTick(this.tickAt()) ** 2n) * 99n) / 100n
      assert.ok(operation.amount <= this.pair, 'swap input solvency')
      assert.ok((this.allowances.get(lower(PAIR)) || 0n) >= operation.amount, 'ERC20 swap allowance')
      assert.ok(
        (this.routerAllowances.get(lower(operation.router))?.[0] || 0n) >= operation.amount,
        'Router swap allowance',
      )
      if (output < operation.minimum) throw new Error('simulated slippage revert')
      return { ...operation, output }
    }
    if (operation.kind === 'burn') {
      const position = this.positions.get(String(operation.id))
      assert.ok(position, 'burn must refer to a live NFT')
      const amounts = positionAmounts({
        ...position,
        sqrtPriceX96: sqrtRatioAtTick(this.tickAt()),
        tickSpacing: 100,
      })
      if (amounts.amount0 < operation.min0 || amounts.amount1 < operation.min1)
        throw new Error('simulated slippage revert')
      return { ...operation, ...amounts }
    }
    if (operation.kind === 'mint') {
      const amounts = positionAmounts({
        ...operation,
        sqrtPriceX96: sqrtRatioAtTick(this.tickAt()),
        tickSpacing: 100,
      })
      assert.ok(amounts.amount0 <= operation.max0 && amounts.amount1 <= operation.max1, 'mint maximum inputs')
      assert.ok(amounts.amount0 <= this.usdg && amounts.amount1 <= this.pair, 'wallet solvency')
      return { ...operation, ...amounts }
    }
    return operation
  }
  market() {
    if (this.fault.marketUnavailable) throw new Error('fetch failed')
    const tick = this.tickAt(this.head - 127n)
    const price = this.marketAnchor || directPairPriceAtTick(tick)
    const hot = { p10: price * 0.92, p50: price * 0.97, p90: price * 1.06 }
    const row = {
      id: 'pair-usdg-1',
      poolId,
      feePips: 10000,
      tickSpacing: 100,
      hooks: ZERO,
      currentTick: tick,
      pairUsdg: directPairPriceAtTick(tick),
      currentActiveLiquidity: '4000000000000000000',
      windows: {
        '1h': { swapEvents: 160, volumeUsdg: 100000 },
        '6h': { swapEvents: 1000, volumeUsdg: 600000 },
      },
      rangeAnalysis: {
        hotBand6hUsdg: hot,
        topVolumeBins6h: Array.from({ length: 15 }, (_, i) => ({
          tickLower: Math.ceil(tick / 100) * 100 + i * 100,
          tickUpper: Math.ceil(tick / 100) * 100 + (i + 1) * 100,
          volumeUsdg: 40000,
          marketLiquidity: '4000000000000000000',
        })),
      },
    }
    const block = this.head - 127n
    return {
      status: 'LIVE',
      generatedAt: new Date(this.clock - (this.fault.staleMarket ? 900000 : 0)).toISOString(),
      runtime: {
        snapshotId: `offline:${this.blockHash(block)}`,
        blockNumber: String(block),
        blockHash: this.blockHash(block),
      },
      comparison: {
        asOfBlock: String(block),
        asOfBlockHash: this.blockHash(block),
        rows: [row],
        migrationEstimate: { ethQuote: { ethUsdg: 3000 } },
      },
    }
  }
  client(index) {
    const self = this
    const gate = () => {
      if (self.fault.rpcOutage || (self.fault.secondRpcDown && index === 1))
        throw new Error('RPC request failed')
    }
    return {
      async getChainId() {
        gate()
        return self.fault.chainId && index === 1 ? 1 : 4663
      },
      async getBlockNumber() {
        gate()
        return self.head
      },
      async getBlock({ blockNumber }) {
        gate()
        return {
          hash: self.fault.reorg ? '0x' + 'f'.repeat(64) : self.blockHash(blockNumber),
          number: blockNumber,
        }
      },
      async getTransactionCount({ blockTag }) {
        gate()
        return self.nonce + (self.fault.pendingNonce && blockTag === 'pending' ? 1 : 0)
      },
      async getBalance() {
        gate()
        return self.eth
      },
      async getCode({ address }) {
        return lower(address) === lower(self.wallet) ? '0x' : '0x1234'
      },
      async getGasPrice() {
        if (self.fault.reverseBeforeBurn) {
          const price = self.fault.reverseBeforeBurn
          delete self.fault.reverseBeforeBurn
          self.advance(price)
        }
        return self.gasPrice
      },
      async estimateGas({ data, to }) {
        return self.decode({ data, to }).kind === 'approve' ? 50000n : 250000n
      },
      async readContract({ address, functionName, args = [], blockNumber = self.head }) {
        gate()
        if (functionName === 'getSlot0')
          return [
            sqrtRatioAtTick(self.tickAt(blockNumber) + (self.fault.poolDisagreement && index === 1 ? 1 : 0)),
            self.tickAt(blockNumber),
            0,
            10000,
          ]
        if (functionName === 'getLiquidity') return 4000000000000000000n
        if (functionName === 'symbol')
          return lower(address) === lower(USDG) ? 'USDG' : lower(address) === lower(PAIR) ? 'PAIR' : 'SPY'
        if (functionName === 'decimals') return lower(address) === lower(USDG) ? 6 : 18
        if (functionName === 'balanceOf')
          return lower(address) === lower(PM)
            ? BigInt(self.positions.size)
            : lower(address) === lower(USDG)
              ? self.usdg
              : lower(address) === lower(PAIR)
                ? self.pair
                : 0n
        if (functionName === 'allowance')
          return lower(address) === lower(PERMIT)
            ? self.routerAllowances.get(lower(args[2])) || [0n, 0, 0]
            : self.allowances.get(lower(address)) || 0n
        const position = self.positions.get(String(args[0]))
        if (!position) throw new Error('ownerOf reverted')
        if (functionName === 'ownerOf') return self.fault.ownerMismatch ? ZERO : position.owner
        if (functionName === 'getPositionLiquidity')
          return position.liquidity + (self.fault.liquidityMismatch ? 1n : 0n)
        if (functionName === 'getPoolAndPositionInfo')
          return [poolKey, (BigInt(position.tickLower) << 8n) | (BigInt(position.tickUpper) << 32n)]
        throw new Error(`unimplemented offline read ${functionName}`)
      },
      async simulateContract({ functionName, args }) {
        gate()
        assert.equal(functionName, 'quoteExactInputSingle')
        const output =
          (((args[0].exactAmount * (1n << 192n)) / sqrtRatioAtTick(self.tickAt()) ** 2n) * 99n) / 100n
        return { result: [self.fault.quoteTooLow ? output / 2n : output, 250000n] }
      },
      async call(request) {
        self.check(request)
        return {
          data: viem.encodeAbiParameters(
            [{ type: 'bytes[]' }],
            [[viem.encodeAbiParameters([{ type: 'bytes' }], ['0x']), '0x']],
          ),
        }
      },
      async getTransactionReceipt({ hash }) {
        if (self.fault.receiptUnavailable) throw new Error('receipt timed out')
        if (!self.receipts.has(hash)) throw new Error('receipt not found')
        return self.receipts.get(hash)
      },
      async getTransaction({ hash }) {
        return self.transactions.get(hash)
      },
      async waitForTransactionReceipt({ hash }) {
        if (self.fault.receiptUnavailable) throw new Error('receipt timed out')
        if (!self.receipts.has(hash)) throw new Error('receipt timed out')
        if (self.fault.afterBurnDrop && self.mined.at(-1)?.kind === 'burn') {
          const price = self.fault.afterBurnDrop
          delete self.fault.afterBurnDrop
          self.advance(price)
        }
        return self.receipts.get(hash)
      },
      async sendRawTransaction({ serializedTransaction }) {
        if (self.fault.broadcastOutage) throw new Error('RPC request failed')
        if (self.fault.broadcastOneDown && index === 0) throw new Error('RPC request failed')
        const hash = viem.keccak256(serializedTransaction)
        if (self.receipts.has(hash)) return hash
        const request = self.signed.get(serializedTransaction)
        assert.ok(request, 'only synthetic signed requests can be broadcast')
        assert.equal(request.nonce, self.nonce, 'no duplicate or skipped nonce')
        let operation
        try {
          operation = self.check(request)
        } catch (error) {
          if (error.message !== 'simulated slippage revert') throw error
          // A stale signed transaction can be accepted and revert on chain.
          // It consumes nonce/Gas but never mutates token or NFT balances.
          operation = { kind: 'reverted' }
        }
        const gasUsed = operation.kind === 'approve' ? 45000n : 230000n
        assert.ok(gasUsed <= request.gas, 'transaction gas limit covers execution')
        assert.ok(self.eth >= gasUsed * request.gasPrice, 'gas solvency before state mutation')
        const gas = gasUsed * request.gasPrice
        let logs = []
        if (operation.kind === 'approve') self.allowances.set(lower(operation.token), operation.amount)
        if (operation.kind === 'router_approve')
          self.routerAllowances.set(lower(operation.spender), [operation.amount, operation.expiration, 0])
        if (operation.kind === 'swap') {
          self.pair -= operation.amount
          self.usdg += operation.output
          self.allowances.set(lower(PAIR), (self.allowances.get(lower(PAIR)) || 0n) - operation.amount)
          const permit = self.routerAllowances.get(lower(operation.router))
          permit[0] -= operation.amount
          logs = [
            self.tokenLog(PAIR, self.wallet, PM, operation.amount),
            self.tokenLog(USDG, PM, self.wallet, operation.output),
          ]
        }
        if (operation.kind === 'burn') {
          self.positions.delete(String(operation.id))
          self.usdg += operation.amount0
          self.pair += operation.amount1
          logs = [
            self.nftLog(self.wallet, ZERO, operation.id),
            self.tokenLog(USDG, PM, self.wallet, operation.amount0),
            self.tokenLog(PAIR, PM, self.wallet, operation.amount1),
          ]
        }
        if (operation.kind === 'mint') {
          assert.deepEqual(operation.key, poolKey, 'pool key must match')
          const id = self.nextNft++
          const spent0 = operation.amount0,
            spent1 = operation.amount1
          assert.ok(spent0 <= self.usdg && spent1 <= self.pair)
          assert.ok(
            (self.allowances.get(lower(USDG)) || 0n) >= spent0 &&
              (self.allowances.get(lower(PAIR)) || 0n) >= spent1,
            'exact ERC20 allowance',
          )
          self.allowances.set(lower(USDG), (self.allowances.get(lower(USDG)) || 0n) - spent0)
          self.allowances.set(lower(PAIR), (self.allowances.get(lower(PAIR)) || 0n) - spent1)
          self.usdg -= spent0
          self.pair -= spent1
          self.positions.set(String(id), { ...operation, owner: operation.owner })
          logs = [
            self.nftLog(ZERO, self.wallet, id),
            self.tokenLog(USDG, self.wallet, PM, spent0),
            self.tokenLog(PAIR, self.wallet, PM, spent1),
          ]
        }
        self.eth -= gas
        self.nonce++
        const blockNumber = self.head + 1n
        self.head += 128n
        self.clock += 12800
        const receipt = {
          status: operation.kind === 'reverted' ? 'reverted' : 'success',
          transactionHash: hash,
          blockNumber,
          blockHash: self.blockHash(blockNumber),
          gasUsed,
          effectiveGasPrice: request.gasPrice,
          logs,
        }
        self.receipts.set(hash, receipt)
        self.transactions.set(hash, {
          from: self.wallet,
          nonce: request.nonce,
          to: request.to,
          value: request.value,
          input: request.data,
        })
        if (self.fault.reorgAfterMine) self.fault.reorg = true
        if (self.fault.receiptUnavailableAfter === operation.kind) self.fault.receiptUnavailable = true
        self.mined.push({
          hash,
          nonce: request.nonce,
          kind: operation.kind,
          time: new Date(self.clock).toISOString(),
        })
        return hash
      },
    }
  }
  async run(command = 'keeper-once') {
    assert.ok(vm.SourceTextModule, 'run with node --experimental-vm-modules')
    const self = this
    const entries = []
    const mockProcess = {
      env: {
        RH_RPC_URLS: 'https://offline-a.invalid,https://offline-b.invalid',
        PAIR_MARTINGALE_WALLET: this.wallet,
        PAIR_MARTINGALE_MARKET_URL: 'https://offline-market.invalid',
        PAIR_MARTINGALE_RUN_DIR: this.dir,
        PAIR_MARTINGALE_LIVE_ARM: 'I_AUTHORIZE_FINITE_MARTINGALE',
        PAIR_MARTINGALE_EXIT_CONFIRM: 'I_AUTHORIZE_WITHDRAW_ALL_FIVE',
        PAIR_MARTINGALE_LIQUIDATE_CONFIRM: 'I_AUTHORIZE_SELL_ALL_PAIR',
        PAIR_MARTINGALE_REQUIRE_RPC_CONSENSUS: '1',
      },
      argv: ['node', 'offline', command],
      pid: process.pid,
      exitCode: 0,
    }
    class Clock extends Date {
      constructor(value = self.clock) {
        super(value)
      }
      static now() {
        return self.clock
      }
    }
    const context = vm.createContext({
      URL,
      process: mockProcess,
      console: { log: (s) => entries.push(String(s)), error: (s) => entries.push(String(s)) },
      Date: Clock,
      BigInt,
      Buffer,
      structuredClone,
      setTimeout: (callback) => {
        self.clock += 1000
        callback()
      },
      clearTimeout: () => {},
      AbortSignal,
      fetch: async (url) => {
        assert.equal(url, mockProcess.env.PAIR_MARTINGALE_MARKET_URL)
        return { ok: true, text: async () => stringify(self.market()) }
      },
    })
    let index = 0
    const fakeAccount = {
      address: this.wallet,
      signTypedData: async () => '0x' + '11'.repeat(65),
      signTransaction: async (request) => {
        const bytes = viem.toHex('OFFLINE_UNSIGNED:' + stringify(request))
        self.signed.set(bytes, request)
        return bytes
      },
    }
    const injectedViem = {
      ...viem,
      http: (...args) => ({ offline: args }),
      fallback: () => ({}),
      createPublicClient: () => self.client(index++ === 2 ? 1 : 0),
      createWalletClient: () => {
        const c = self.client(index++ % 2)
        const send = c.sendRawTransaction
        c.sendRawTransaction = async (r) => {
          try {
            return await send(r)
          } catch (e) {
            self.logs.push({ adapterError: e.message })
            throw e
          }
        }
        return c
      },
    }
    const modules = new Map()
    const synthetic = (id, exports) => {
      const mod = new vm.SyntheticModule(
        Object.keys(exports),
        function () {
          for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
        },
        { context, identifier: id },
      )
      modules.set(id, mod)
      return mod
    }
    const load = async (id) => {
      if (modules.has(id)) return modules.get(id)
      if (id === 'viem') return synthetic(id, injectedViem)
      if (id === 'node:process') return synthetic(id, { default: mockProcess })
      if (id.endsWith('/account-loader.mjs'))
        return synthetic(id, { loadSignerAccount: () => ({ account: fakeAccount, source: 'OFFLINE_STUB' }) })
      if (id.startsWith('node:')) return synthetic(id, await import(id))
      assert.ok(id.startsWith(root + path.sep), 'only repository modules are allowed')
      let source = fs.readFileSync(id, 'utf8')
      if (id.endsWith('/pair-usdg-martingale.mjs'))
        source = source.replace('main().catch(', 'globalThis.finished = main().catch(')
      const mod = new vm.SourceTextModule(source, { context, identifier: id })
      modules.set(id, mod)
      await mod.link((specifier, parent) =>
        load(
          specifier.startsWith('.') ? path.resolve(path.dirname(parent.identifier), specifier) : specifier,
        ),
      )
      return mod
    }
    const before = this.mined.length
    const mod = await load(path.join(root, 'scripts/pair-usdg-martingale.mjs'))
    await mod.evaluate()
    await context.finished
    const result = {
      command,
      price: directPairPriceAtTick(this.tickAt()),
      exitCode: mockProcess.exitCode,
      entries: entries.map((s) => {
        try {
          return JSON.parse(s)
        } catch {
          return s
        }
      }),
      mined: this.mined.length - before,
      nonce: this.nonce,
      nfts: this.positions.size,
      halted: Boolean(this.halt),
      pending: this.state.pendingRotation?.phase || null,
      phases: this.state.bands.map((b) => `${b.id}:${b.phase}`),
    }
    this.logs.push(result)
    assert.equal(new Set(this.mined.map((t) => t.nonce)).size, this.mined.length, 'unique mined nonces')
    assert.ok(this.eth >= 0n && this.usdg >= 0n && this.pair >= 0n, 'nonnegative wallet')
    if (
      !result.pending &&
      !result.halted &&
      result.exitCode === 0 &&
      !this.state.pendingWithdrawal &&
      !['WITHDRAWN', 'LIQUIDATED'].includes(this.state.status) &&
      !this.state.pendingLiquidation
    )
      assert.equal(this.positions.size, 5, 'five live NFTs after a healthy cycle')
    return result
  }
}
