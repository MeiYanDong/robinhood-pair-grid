import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/

function readSystemdCredential(credentialsDirectory, credentialName) {
  const directory = path.resolve(credentialsDirectory)
  const credentialPath = path.resolve(directory, credentialName)
  if (path.dirname(credentialPath) !== directory) {
    throw new Error('systemd credential 名称越过了凭证目录边界')
  }
  return fs.readFileSync(credentialPath, { encoding: 'utf8', flag: 'r' }).trim()
}

function readMacOsKeychain(service) {
  try {
    return execFileSync('/usr/bin/security', ['find-generic-password', '-w', '-s', service], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    throw new Error(`macOS Keychain 中找不到服务 ${service}`)
  }
}

export function loadSignerAccount({
  expectedWallet,
  keychainService,
  credentialName = 'pair-grid-private-key',
  environment = process.env,
  credentialReader = readSystemdCredential,
  keychainReader = readMacOsKeychain,
}) {
  const expected = getAddress(expectedWallet)
  let privateKey
  let source

  if (environment.CREDENTIALS_DIRECTORY) {
    privateKey = credentialReader(environment.CREDENTIALS_DIRECTORY, credentialName)
    source = 'SYSTEMD_CREDENTIAL'
  } else if (process.platform === 'darwin') {
    privateKey = keychainReader(keychainService)
    source = 'MACOS_KEYCHAIN'
  } else {
    throw new Error('未找到受支持的私钥入口：需要 systemd CREDENTIALS_DIRECTORY')
  }

  if (!PRIVATE_KEY_PATTERN.test(privateKey)) {
    throw new Error('凭证不是有效的 32-byte EVM 私钥')
  }
  const account = privateKeyToAccount(/** @type {`0x${string}`} */ (privateKey))
  if (account.address.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`凭证地址不匹配；预期 ${expected}，实际 ${account.address}`)
  }
  return { account, source }
}
