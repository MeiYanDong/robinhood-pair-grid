#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "install-release.sh must run as root" >&2
  exit 1
fi
if [[ $# -ne 2 ]]; then
  echo "usage: install-release.sh <release.tar.gz> <full-commit-sha>" >&2
  exit 1
fi

archive=$1
commit_sha=$2
if [[ ! -f ${archive} || ! ${commit_sha} =~ ^[0-9a-f]{40}$ ]]; then
  echo "release archive or commit SHA is invalid" >&2
  exit 1
fi

app_root=/opt/robinhood-pair-grid
release_dir=${app_root}/releases/${commit_sha}
current_link=${app_root}/current
monitor_was_enabled=0
monitor_was_active=0
martingale_was_enabled=0
martingale_was_active=0
if systemctl is-enabled --quiet robinhood-pair-grid-monitor.timer 2>/dev/null; then
  monitor_was_enabled=1
fi
if systemctl is-active --quiet robinhood-pair-grid-monitor.timer 2>/dev/null; then
  monitor_was_active=1
  systemctl stop robinhood-pair-grid-monitor.timer
fi
if systemctl is-enabled --quiet robinhood-pair-usdg-martingale.timer 2>/dev/null; then
  martingale_was_enabled=1
fi
if systemctl is-active --quiet robinhood-pair-usdg-martingale.timer 2>/dev/null; then
  martingale_was_active=1
  systemctl stop robinhood-pair-usdg-martingale.timer
fi

if ! id pair-grid >/dev/null 2>&1; then
  useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin pair-grid
fi
install -d -o root -g pair-grid -m 0750 "${app_root}" "${app_root}/releases"
install -d -o pair-grid -g pair-grid -m 0700 /var/lib/robinhood-pair-grid
install -d -o root -g pair-grid -m 0750 /etc/robinhood-pair-grid
install -d -o root -g root -m 0700 /etc/credstore.encrypted

if [[ ! -d ${release_dir} ]]; then
  install -d -o root -g pair-grid -m 0750 "${release_dir}"
  tar -xzf "${archive}" -C "${release_dir}"
fi

cd "${release_dir}"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
npm test
node --check scripts/pair-grid.mjs
node --check scripts/pair-usdg-martingale.mjs
chown -R root:pair-grid "${release_dir}"
chmod -R o-rwx "${release_dir}"

ln -s "${release_dir}" "${current_link}.next"
mv -Tf "${current_link}.next" "${current_link}"
install -m 0644 deploy/systemd/robinhood-pair-grid.service /etc/systemd/system/
install -m 0644 deploy/systemd/robinhood-pair-grid.timer /etc/systemd/system/
install -m 0644 deploy/systemd/robinhood-pair-grid-alert@.service /etc/systemd/system/
install -m 0644 deploy/systemd/robinhood-pair-grid-alert-test.service /etc/systemd/system/
install -m 0644 deploy/systemd/robinhood-pair-grid-key-check.service /etc/systemd/system/
install -m 0644 deploy/systemd/robinhood-pair-grid-monitor.service /etc/systemd/system/
install -m 0644 deploy/systemd/robinhood-pair-grid-monitor.timer /etc/systemd/system/
install -m 0644 deploy/systemd/robinhood-pair-grid-status.service /etc/systemd/system/
install -m 0644 deploy/systemd/robinhood-pair-usdg-martingale.service /etc/systemd/system/
install -m 0644 deploy/systemd/robinhood-pair-usdg-martingale.timer /etc/systemd/system/
install -m 0644 deploy/systemd/robinhood-pair-usdg-martingale-key-check.service /etc/systemd/system/
install -m 0644 deploy/systemd/robinhood-pair-usdg-martingale-status.service /etc/systemd/system/
install -m 0600 deploy/runtime.env.example /etc/robinhood-pair-grid/runtime.env.example

systemctl daemon-reload
systemctl disable --now robinhood-pair-grid.timer
systemctl disable --now robinhood-pair-usdg-martingale.timer
if [[ ${monitor_was_enabled} -eq 1 ]]; then
  systemctl enable robinhood-pair-grid-monitor.timer
fi
if [[ ${monitor_was_active} -eq 1 ]]; then
  systemctl start robinhood-pair-grid-monitor.timer
fi
if [[ ${martingale_was_enabled} -eq 1 ]]; then
  systemctl enable robinhood-pair-usdg-martingale.timer
fi
if [[ ${martingale_was_active} -eq 1 ]]; then
  systemctl start robinhood-pair-usdg-martingale.timer
fi
echo "installed ${commit_sha}; legacy trading remains disabled, prior martingale/monitor state is preserved, and no credential was changed"
