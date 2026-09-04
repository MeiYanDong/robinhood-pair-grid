import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function stringify(value) {
  return JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item), 2)
}

export class StateStore {
  constructor(runDirectory, options = {}) {
    this.runDirectory = path.resolve(runDirectory)
    this.statePath = path.join(this.runDirectory, 'pair-grid.json')
    this.auditPath = path.join(this.runDirectory, 'pair-grid.jsonl')
    this.haltPath = path.join(this.runDirectory, 'pair-grid.halted.json')
    this.lockPath = path.join(this.runDirectory, 'pair-grid.lock')
    this.pid = options.pid || process.pid
    this.hostname = options.hostname || os.hostname()
    this.now = options.now || (() => new Date())
  }

  ensureDirectory() {
    fs.mkdirSync(this.runDirectory, { recursive: true, mode: 0o700 })
    fs.chmodSync(this.runDirectory, 0o700)
  }

  readState() {
    if (!fs.existsSync(this.statePath)) return null
    return JSON.parse(fs.readFileSync(this.statePath, 'utf8'))
  }

  writeState(state) {
    this.#writeJsonAtomic(this.statePath, state)
  }

  appendAudit(event, details = {}) {
    this.ensureDirectory()
    const line = JSON.stringify({ at: this.now().toISOString(), event, ...details }, (_, item) =>
      typeof item === 'bigint' ? item.toString() : item,
    )
    const descriptor = fs.openSync(this.auditPath, 'a', 0o600)
    try {
      fs.writeFileSync(descriptor, `${line}\n`)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    fs.chmodSync(this.auditPath, 0o600)
  }

  readAudit() {
    if (!fs.existsSync(this.auditPath)) return []
    return fs
      .readFileSync(this.auditPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line)
        } catch {
          throw new Error(`审计账本第 ${index + 1} 行不是有效 JSON`)
        }
      })
  }

  readHalt() {
    if (!fs.existsSync(this.haltPath)) return null
    return JSON.parse(fs.readFileSync(this.haltPath, 'utf8'))
  }

  assertNotHalted() {
    const halt = this.readHalt()
    if (halt) {
      throw new Error(`策略处于 HALTED：${halt.reason || '原因未记录'}；必须先 reconcile，再显式 clear-halt`)
    }
  }

  halt({ command, reason }) {
    const existing = this.readHalt()
    if (existing) return existing
    const record = {
      status: 'HALTED',
      command,
      reason,
      haltedAt: this.now().toISOString(),
      pid: this.pid,
      hostname: this.hostname,
    }
    this.#writeJsonAtomic(this.haltPath, record)
    this.appendAudit('strategy_halted', record)
    return record
  }

  clearHalt(confirmation) {
    if (confirmation !== 'I_UNDERSTAND') {
      throw new Error('清除 HALTED 需要 PAIR_GRID_UNHALT_CONFIRM=I_UNDERSTAND')
    }
    const previous = this.readHalt()
    if (!previous) return null
    fs.unlinkSync(this.haltPath)
    this.#syncDirectory()
    this.appendAudit('strategy_halt_cleared', { previous })
    return previous
  }

  acquireLock(command) {
    this.ensureDirectory()
    const record = {
      command,
      pid: this.pid,
      hostname: this.hostname,
      acquiredAt: this.now().toISOString(),
    }
    try {
      return this.#createLock(record)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const current = this.#readExistingLock()
      if (current && current.hostname === this.hostname && Number.isInteger(current.pid)) {
        try {
          process.kill(current.pid, 0)
        } catch (probeError) {
          if (probeError?.code === 'ESRCH') {
            fs.unlinkSync(this.lockPath)
            return this.#createLock(record)
          }
        }
      }
      throw new Error(`已有策略进程持锁：${current ? stringify(current) : '锁文件不可解析'}`)
    }
  }

  async withLock(command, operation) {
    const release = this.acquireLock(command)
    try {
      return await operation()
    } finally {
      release()
    }
  }

  #createLock(record) {
    const descriptor = fs.openSync(this.lockPath, 'wx', 0o600)
    try {
      fs.writeFileSync(descriptor, `${stringify(record)}\n`)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      try {
        const current = this.#readExistingLock()
        if (current?.pid === this.pid && current?.hostname === this.hostname) {
          fs.unlinkSync(this.lockPath)
          this.#syncDirectory()
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }

  #readExistingLock() {
    try {
      return JSON.parse(fs.readFileSync(this.lockPath, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      return null
    }
  }

  #writeJsonAtomic(targetPath, value) {
    this.ensureDirectory()
    const temporary = `${targetPath}.${this.pid}.${Date.now()}.tmp`
    const descriptor = fs.openSync(temporary, 'wx', 0o600)
    try {
      fs.writeFileSync(descriptor, `${stringify(value)}\n`)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    fs.renameSync(temporary, targetPath)
    fs.chmodSync(targetPath, 0o600)
    this.#syncDirectory()
  }

  #syncDirectory() {
    let descriptor
    try {
      descriptor = fs.openSync(this.runDirectory, 'r')
      fs.fsyncSync(descriptor)
    } catch (error) {
      if (!['EINVAL', 'EBADF', 'EISDIR'].includes(error?.code)) throw error
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
    }
  }
}
