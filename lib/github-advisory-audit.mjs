const NODE_MODULES_MARKER = 'node_modules/'
const BLOCKING_SEVERITIES = ['high', 'critical']
const MAX_AFFECTS_PER_QUERY = 50
const RESULTS_PER_PAGE = 100
const MAX_PAGES = 10

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function chunks(values, size) {
  const result = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

/**
 * Build the exact installed runtime package-version set from an npm v2/v3 lockfile.
 * Entries marked devOptional remain included because npm installs them to satisfy a
 * production peer dependency.
 *
 * @param {unknown} value
 */
export function runtimePackageSpecs(value) {
  if (!value || typeof value !== 'object') throw new TypeError('package lock must be an object')
  const lock = /** @type {{ lockfileVersion?: unknown, packages?: unknown }} */ (value)
  if (!Number.isInteger(lock.lockfileVersion) || Number(lock.lockfileVersion) < 2) {
    throw new TypeError('package lock must use lockfileVersion 2 or newer')
  }
  if (!lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
    throw new TypeError('package lock must contain a packages object')
  }

  const specs = new Set()
  for (const [installPath, rawEntry] of Object.entries(lock.packages)) {
    if (!installPath || !rawEntry || typeof rawEntry !== 'object') continue
    const entry = /** @type {{ dev?: unknown, name?: unknown, version?: unknown }} */ (rawEntry)
    if (entry.dev === true || typeof entry.version !== 'string') continue

    const markerIndex = installPath.lastIndexOf(NODE_MODULES_MARKER)
    if (markerIndex < 0) continue
    const inferredName = installPath.slice(markerIndex + NODE_MODULES_MARKER.length)
    const name = typeof entry.name === 'string' ? entry.name : inferredName
    if (!name || name.includes(',') || /[\u0000-\u001f]/.test(name)) {
      throw new TypeError(`invalid package name in lockfile path: ${installPath}`)
    }
    if (!entry.version || entry.version.includes(',') || /[\u0000-\u001f]/.test(entry.version)) {
      throw new TypeError(`invalid package version in lockfile path: ${installPath}`)
    }
    specs.add(`${name}@${entry.version}`)
  }

  if (specs.size === 0) throw new TypeError('package lock contains no runtime packages')
  return [...specs].sort()
}

/** @param {string[]} specs @param {string} severity @param {number} page */
export function advisoryQueryUrl(specs, severity, page = 1) {
  if (!BLOCKING_SEVERITIES.includes(severity)) throw new TypeError(`unsupported severity: ${severity}`)
  if (!Array.isArray(specs) || specs.length === 0 || specs.length > MAX_AFFECTS_PER_QUERY) {
    throw new TypeError(`affects query must contain 1-${MAX_AFFECTS_PER_QUERY} package versions`)
  }
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGES) {
    throw new TypeError(`page must be between 1 and ${MAX_PAGES}`)
  }

  const url = new URL('https://api.github.com/advisories')
  url.searchParams.set('ecosystem', 'npm')
  url.searchParams.set('severity', severity)
  url.searchParams.set('type', 'reviewed')
  url.searchParams.set('is_withdrawn', 'false')
  url.searchParams.set('affects', specs.join(','))
  url.searchParams.set('per_page', String(RESULTS_PER_PAGE))
  url.searchParams.set('page', String(page))
  return url
}

/** @param {unknown} value @param {string} severity */
export function validateAdvisoryPage(value, severity) {
  if (!Array.isArray(value)) throw new TypeError('GitHub Advisory API response must be an array')
  return value.map((rawAdvisory) => {
    if (!rawAdvisory || typeof rawAdvisory !== 'object') {
      throw new TypeError('GitHub advisory must be an object')
    }
    const advisory =
      /** @type {{ ghsa_id?: unknown, severity?: unknown, summary?: unknown, html_url?: unknown, withdrawn_at?: unknown }} */ (
        rawAdvisory
      )
    if (
      typeof advisory.ghsa_id !== 'string' ||
      advisory.severity !== severity ||
      typeof advisory.summary !== 'string' ||
      typeof advisory.html_url !== 'string' ||
      (advisory.withdrawn_at !== null && advisory.withdrawn_at !== undefined)
    ) {
      throw new TypeError('GitHub advisory response has an invalid shape')
    }
    return {
      ghsaId: advisory.ghsa_id,
      severity,
      summary: advisory.summary,
      url: advisory.html_url,
    }
  })
}

async function delay(milliseconds) {
  if (milliseconds <= 0) return
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

async function requestAdvisoryPage({
  fetchImpl,
  url,
  severity,
  token,
  maxAttempts,
  timeoutMs,
  retryDelayMs,
  onRetry,
}) {
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const headers = {
        accept: 'application/vnd.github+json',
        'user-agent': 'robinhood-pair-grid-production-audit',
        'x-github-api-version': '2022-11-28',
      }
      if (token) headers.authorization = `Bearer ${token}`
      const response = await fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`GitHub Advisory API returned HTTP ${response.status}`)
      return validateAdvisoryPage(await response.json(), severity)
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts) {
        onRetry({ attempt, maxAttempts, message: errorMessage(error) })
        await delay(retryDelayMs * attempt)
      }
    }
  }
  throw new Error(
    `GitHub Advisory API result incomplete after ${maxAttempts} attempts: ${errorMessage(lastError)}`,
  )
}

/**
 * @param {string[]} specs
 * @param {{ fetchImpl?: typeof fetch, token?: string, maxAttempts?: number, timeoutMs?: number, retryDelayMs?: number, onRetry?: (event: { attempt: number, maxAttempts: number, message: string }) => void }} [options]
 */
export async function auditRuntimePackageSpecs(specs, options = {}) {
  if (!Array.isArray(specs) || specs.length === 0 || specs.some((spec) => typeof spec !== 'string')) {
    throw new TypeError('runtime package specs must be a non-empty string array')
  }
  const uniqueSpecs = [...new Set(specs)].sort()
  const fetchImpl = options.fetchImpl ?? fetch
  const token = options.token
  const maxAttempts = options.maxAttempts ?? 3
  const timeoutMs = options.timeoutMs ?? 30_000
  const retryDelayMs = options.retryDelayMs ?? 1_000
  const onRetry = options.onRetry ?? (() => {})
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw new TypeError('maxAttempts must be between 1 and 5')
  }

  const findings = new Map()
  for (const severity of BLOCKING_SEVERITIES) {
    for (const specChunk of chunks(uniqueSpecs, MAX_AFFECTS_PER_QUERY)) {
      let completed = false
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const advisories = await requestAdvisoryPage({
          fetchImpl,
          url: advisoryQueryUrl(specChunk, severity, page),
          severity,
          token,
          maxAttempts,
          timeoutMs,
          retryDelayMs,
          onRetry,
        })
        for (const advisory of advisories) findings.set(advisory.ghsaId, advisory)
        if (advisories.length < RESULTS_PER_PAGE) {
          completed = true
          break
        }
      }
      if (!completed) throw new Error(`GitHub Advisory API exceeded ${MAX_PAGES} pages`)
    }
  }

  const orderedFindings = [...findings.values()].sort((left, right) =>
    left.ghsaId.localeCompare(right.ghsaId),
  )
  return {
    source: 'GitHub Advisory Database',
    ecosystem: 'npm',
    packageVersions: uniqueSpecs.length,
    high: orderedFindings.filter((finding) => finding.severity === 'high').length,
    critical: orderedFindings.filter((finding) => finding.severity === 'critical').length,
    totalBlocking: orderedFindings.length,
    findings: orderedFindings,
  }
}
