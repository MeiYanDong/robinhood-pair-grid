import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { planMonitorRun, markMonitorDelivery } from '../lib/alert-monitor.mjs'
import { createAlertEvent, deliverFeishuAlert, loadFeishuCredential } from '../lib/feishu-alerts.mjs'
import { redactSensitiveText } from '../lib/runtime-guards.mjs'

const execFileAsync = promisify(execFile)
const runDirectory = path.resolve(process.env.PAIR_GRID_RUN_DIR || path.join(process.cwd(), 'runs'))
const haltPath = path.join(runDirectory, 'pair-grid.halted.json')
const monitorStatePath = path.join(runDirectory, 'pair-grid-alert-monitor.json')

function stringify(value) {
  return JSON.stringify(value, null, 2)
}

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new Error(`无法读取 ${path.basename(filePath)}：${error?.message || String(error)}`)
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  fs.chmodSync(path.dirname(filePath), 0o700)
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const descriptor = fs.openSync(temporary, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, `${stringify(value)}\n`)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporary, filePath)
  fs.chmodSync(filePath, 0o600)
  let directoryDescriptor
  try {
    directoryDescriptor = fs.openSync(path.dirname(filePath), 'r')
    fs.fsyncSync(directoryDescriptor)
  } catch (error) {
    if (!['EINVAL', 'EBADF', 'EISDIR'].includes(error?.code)) throw error
  } finally {
    if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor)
  }
}

function parseBoundedInteger(name, fallback, minimum, maximum) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`)
  }
  return value
}

async function deliver(event) {
  const acknowledgement = await deliverFeishuAlert({
    credential: loadFeishuCredential(),
    event,
    hostname: os.hostname(),
  })
  console.log(stringify({ status: 'EXTERNAL_ALERT_ACKNOWLEDGED', ...acknowledgement }))
  return acknowledgement
}

async function readCanonicalStatus() {
  const childEnvironment = { ...process.env }
  delete childEnvironment.CREDENTIALS_DIRECTORY
  childEnvironment.PAIR_GRID_LIVE_ARM = '0'
  try {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/pair-grid.mjs', 'status'], {
      cwd: process.cwd(),
      env: childEnvironment,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    })
    const result = JSON.parse(stdout)
    if (result.status !== 'OBSERVED_READ_ONLY') {
      throw new Error(`status 返回意外状态 ${String(result.status)}`)
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: redactSensitiveText(error?.message || String(error)) }
  }
}

async function monitorOnce() {
  const previous = readJsonIfPresent(monitorStatePath) || {}
  const halt = readJsonIfPresent(haltPath)
  const readback = await readCanonicalStatus()
  const plan = planMonitorRun({
    previous,
    halt,
    readback,
    failureThreshold: parseBoundedInteger('PAIR_GRID_ALERT_READBACK_FAILURES', 3, 1, 100),
    repeatMinutes: parseBoundedInteger('PAIR_GRID_ALERT_REPEAT_MINUTES', 360, 5, 10_080),
  })
  let state = plan.state
  writeJsonAtomic(monitorStatePath, state)

  for (const plannedAlert of plan.alerts) {
    const event = createAlertEvent(plannedAlert)
    try {
      const acknowledgement = await deliver(event)
      state = markMonitorDelivery(state, plannedAlert, acknowledgement.deliveredAt)
      writeJsonAtomic(monitorStatePath, state)
    } catch (error) {
      writeJsonAtomic(monitorStatePath, state)
      throw error
    }
  }

  console.log(
    stringify({
      status: 'MONITOR_OK',
      halted: Boolean(halt),
      readbackOk: readback.ok,
      consecutiveReadbackFailures: state.consecutiveReadbackFailures,
      alertsAcknowledged: plan.alerts.length,
    }),
  )
}

async function serviceFailure(unit) {
  if (!unit || !/^[A-Za-z0-9_.@:-]{1,200}$/u.test(unit)) throw new Error('systemd unit 参数无效')
  return deliver(
    createAlertEvent({
      kind: 'service-failure',
      severity: 'critical',
      summary: 'PAIR 网格 systemd service 失败',
      details: '请检查目标 unit 与 alert service journal，并保持自动交易关闭直至链上与本地状态完成核对。',
      unit,
    }),
  )
}

async function syntheticTest() {
  return deliver(
    createAlertEvent({
      kind: 'synthetic-non-signing-test',
      severity: 'test',
      summary: 'PAIR 网格外部告警链路测试',
      details: '这是合成测试，只验证外部投递与服务端回执；没有加载交易私钥。',
    }),
  )
}

async function main() {
  const command = process.argv[2]
  if (command === 'service-failure') return serviceFailure(process.argv[3])
  if (command === 'monitor-once') return monitorOnce()
  if (command === 'synthetic-test') return syntheticTest()
  throw new Error(`未知告警命令: ${String(command)}`)
}

main().catch((error) => {
  console.error(redactSensitiveText(error?.message || String(error)))
  process.exitCode = 1
})
