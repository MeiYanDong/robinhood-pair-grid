import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditRuntimePackageSpecs, runtimePackageSpecs } from '../lib/github-advisory-audit.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

try {
  const lock = JSON.parse(await readFile(path.join(ROOT, 'package-lock.json'), 'utf8'))
  const specs = runtimePackageSpecs(lock)
  const result = await auditRuntimePackageSpecs(specs, {
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
    onRetry: ({ attempt, maxAttempts, message }) => {
      console.error(`production advisory query ${attempt}/${maxAttempts} failed: ${message}`)
    },
  })
  console.log(JSON.stringify(result, null, 2))
  if (result.totalBlocking > 0) process.exitCode = 1
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`production advisory audit incomplete: ${message}`)
  process.exitCode = 2
}
