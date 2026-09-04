#!/usr/bin/env bash
set -uo pipefail

max_attempts=3
attempt=1

while [[ ${attempt} -le ${max_attempts} ]]; do
  echo "production audit attempt ${attempt}/${max_attempts}" >&2
  audit_output=$(
    npm_config_fetch_retries=0 \
      npm_config_fetch_timeout=60000 \
      npm audit --omit=dev --audit-level=high --json
  )
  audit_status=$?
  printf '%s\n' "${audit_output}"

  if printf '%s' "${audit_output}" | node -e '
    let input = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk) => { input += chunk })
    process.stdin.on("end", () => {
      try {
        const parsed = JSON.parse(input)
        const counts = parsed?.metadata?.vulnerabilities
        const valid = counts && Number.isInteger(counts.total)
        process.exit(valid ? 0 : 1)
      } catch {
        process.exit(1)
      }
    })
  '; then
    exit "${audit_status}"
  fi

  if [[ ${attempt} -eq ${max_attempts} ]]; then
    echo "production audit failed without a complete vulnerability result" >&2
    exit 2
  fi

  sleep_seconds=$((attempt * 5))
  echo "transient npm audit failure; retrying in ${sleep_seconds}s" >&2
  sleep "${sleep_seconds}"
  attempt=$((attempt + 1))
done
