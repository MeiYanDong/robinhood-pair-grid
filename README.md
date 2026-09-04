# robinhood-pair-grid

[![CI](https://github.com/MeiYanDong/robinhood-pair-grid/actions/workflows/ci.yml/badge.svg)](https://github.com/MeiYanDong/robinhood-pair-grid/actions/workflows/ci.yml)

Robinhood Chain 上 PAIR/SPY Uniswap v4 单边区间网格。策略在同一个池中交替维护 BUY 和 SELL
两个方向的 NFT；任何时刻只允许一条腿持有流动性。

本仓库公开源代码、测试和部署模板，但不包含钱包地址、私钥、运行状态、服务器地址或告警凭证。
`package.json` 的 `private: true` 仅用于防止误发布到 npm。

## 策略

- BUY：在锚点价格下方约 10%～20% 建 SPY-only 区间，价格下跌穿越时换成 PAIR。
- SELL：按实际买入成本上方约 12%～25% 建 PAIR-only 区间，价格上涨穿越时换回 SPY。
- 完全转换前不撤池；完全转换后才允许切换方向。
- 首次金丝雀默认为 `0.005 ETH`，硬上限 `0.01 ETH`，并保留至少 `0.005 ETH` Gas。

这不是“无风险网格”。收益来自 LP 手续费，风险包括单边库存、LVR/无常损失、合约与链风险、
Gas、滑点以及自动化故障。

## Fail-closed 边界

- chain ID、池、代币、Router、Permit2、PositionManager 和 Hook 都在每次写交易前重新校验。
- 签名地址必须与 `PAIR_GRID_WALLET` 一致。
- macOS 从 Keychain 读取；Linux 只接受 systemd `CREDENTIALS_DIRECTORY`。
- 私钥不从环境变量、命令行或仓库读取。
- `PAIR_GRID_LIVE_ARM=1` 是真实交易的显式门禁。
- pending/意外 nonce、NFT owner/liquidity 不一致或回执未知都会持久化为 `HALTED`。
- 进程锁防止 timer、人工命令和其他进程并发使用同一状态与 nonce。
- `reconcile` 只接受本地广播记录与链上成功回执一一对应的恢复证据，不盲目重试交易。

## 本地开发

要求 Node.js 22 或更高版本：

```bash
cp .env.example .env.local
npm ci
npm run verify
```

`.env.local` 只配置公开运行身份，不得存放私钥。macOS Keychain 默认服务名为
`codex-rh-pair-grid`，可用 `PAIR_GRID_KEYCHAIN_SERVICE` 覆盖。

## 命令

```bash
npm run key-check       # 只验证凭证反推地址，不广播
npm run inspect         # 全量只读链上检查
npm run preflight       # 构造签名材料和预算，不广播
npm run status          # 链上状态与本地账本对比
npm run reconcile       # 用 canonical receipt 恢复中断状态，不签名
npm run halt-status     # 查看持久化停机状态
npm run clear-halt      # 对账后显式解除停机

npm run enter-buy       # 写交易；需要 PAIR_GRID_LIVE_ARM=1
npm run resume-buy      # 写交易；需要 PAIR_GRID_LIVE_ARM=1
npm run keeper-once     # 健康且完全转换时才切腿
npm run rotate          # 写交易；需要 PAIR_GRID_LIVE_ARM=1
npm run resume-rotate   # 写交易；需要 PAIR_GRID_LIVE_ARM=1
npm run exit            # 撤出流动性，不自动兑换
```

解除 `HALTED` 必须先完成 `npm run reconcile`，然后临时设置：

```bash
PAIR_GRID_UNHALT_CONFIRM=I_UNDERSTAND npm run clear-halt
```

## 证据边界

测试、CI、preflight 和部署成功都不是经济结果。真实完成必须同时具备：

1. canonical transaction receipt；
2. NFT owner/liquidity 与钱包余额的链上回读；
3. 本地状态和预期 nonce 对账；
4. 服务器 systemd 与已部署 commit 的运行时回读。

详细设计见 [技术规格](docs/specs/pair-grid.md)，恢复与运维见
[运行手册](docs/runbook.md)，部署方式见 [部署文档](docs/deployment.md)。

## 当前发布策略

PR 必须通过格式、lint、类型、单元测试、覆盖率、secret scan 和 critical dependency review。
发布工作流只生成带 SHA256 的不可变工件；生产部署是人工受控动作。仓库合并或发布不会自动
启用钱包签名。

## License

[MIT](LICENSE)
