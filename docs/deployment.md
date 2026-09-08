# SWAS deployment

## Host layout

```text
/opt/robinhood-pair-grid/releases/<commit>/   immutable application release
/opt/robinhood-pair-grid/current              active release symlink
/var/lib/robinhood-pair-grid/                 private state and audit ledger
/etc/robinhood-pair-grid/runtime.env          root-owned public runtime identity
/etc/credstore.encrypted/                     encrypted wallet credential
/etc/credstore.encrypted/pair-grid-alert      encrypted Feishu alert credential
/etc/credstore.encrypted/pair-usdg-martingale-private-key
                                               isolated martingale wallet credential
```

## Install a release

On a trusted workstation, create a tarball from a clean, verified Git commit. Copy it over SSH and run:

```bash
sudo deploy/install-release.sh /path/to/release.tar.gz <full-commit-sha>
```

The installer runs production dependency installation and tests, installs systemd units, keeps legacy trading
disabled and preserves the prior enabled/active state of the isolated Keeper and monitor timers. It does not
create, overwrite or arm credentials.

Configure an ordered provider list in `RH_RPC_URLS` using comma- or newline-separated HTTPS endpoints. Keep API
keys only in the root-owned runtime environment; logs and status output expose counts only. `RH_RPC_URL` remains
the one-endpoint compatibility fallback. `RH_BROADCAST_URLS` is optional; when absent, the runtime broadcasts
the same signed bytes to all read endpoints and the official Robinhood Sequencer.

## Credential

Create the encrypted credential on the destination host so systemd binds it to that host:

```bash
sudo systemd-creds encrypt --name=pair-grid-private-key - /etc/credstore.encrypted/pair-grid-private-key
```

Pipe the value through an encrypted SSH session; do not paste it into shell history, argv, environment or
Cloud Assistant command text. Verify with `npm run key-check`; that command prints only source and derived
public address.

The host-bound systemd credential is defense in depth, not a hardware security module. On a host without a
usable TPM and encrypted root disk, root access or a complete disk image remains inside the signing-key threat
model.

The isolated martingale wallet uses a separate credential name and never shares the legacy grid signer:

```bash
sudo systemd-creds encrypt --name=pair-usdg-martingale-private-key - \
  /etc/credstore.encrypted/pair-usdg-martingale-private-key
```

Transfer its bootstrap and live state to `/var/lib/robinhood-pair-grid/` through the encrypted SSH channel,
set owner `pair-grid:pair-grid` and mode `0600`, and keep both files outside the release artifact.

## External alert credential

Create a Feishu custom group bot, enable signature verification and copy both values into this JSON shape:

```json
{
  "provider": "feishu-custom-bot",
  "webhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/REDACTED",
  "signingSecret": "REDACTED"
}
```

Encrypt it through standard input on the destination host. Do not place either value in shell history,
environment variables, process arguments, GitHub secrets or the public evidence file:

```bash
sudo systemd-creds encrypt --name=pair-grid-alert - /etc/credstore.encrypted/pair-grid-alert
```

The bot must use signature verification. It should also use the stable SWAS public egress IP allowlist; until
that separate UI change is explicitly approved and verified, track it as
[Issue 18](https://github.com/MeiYanDong/robinhood-pair-grid/issues/18) and do not claim it is active. Test the
independent path before enabling its monitor timer:

```bash
sudo systemctl start robinhood-pair-grid-alert-test.service
sudo journalctl -u robinhood-pair-grid-alert-test.service --no-pager -n 30
```

Success requires the test message to be visible in the selected Feishu group and a redacted
`EXTERNAL_ALERT_ACKNOWLEDGED` record with `providerCode: 0`. That response proves provider acceptance, not that a
human read the message. The alert service and monitor never load the wallet credential.

## SSH administration

Install the reviewed hardening fragment separately from the application release, validate it before reload,
and prove a second connection succeeds before closing the original session:

```bash
sudo install -o root -g root -m 0644 \
  deploy/sshd/60-robinhood-pair-grid-hardening.conf \
  /etc/ssh/sshd_config.d/60-robinhood-pair-grid-hardening.conf
sudo sshd -t
sudo systemctl reload ssh
```

The fragment keeps root public-key administration because this dedicated host currently has no separate admin
account, but disables password and keyboard-interactive authentication, SSH forwarding, tunnels and X11.
Restrict port 22 to a stable administrator CIDR at both the cloud and host firewalls when such an egress is
available. Do not use a transient observed IP as a permanent allowlist: losing that route can lock out routine
recovery.

## Post-deploy verification

```bash
systemctl is-enabled robinhood-pair-grid.timer
systemctl is-active robinhood-pair-grid.timer
systemctl is-enabled robinhood-pair-grid-monitor.timer
systemctl is-active robinhood-pair-grid-monitor.timer
sudo systemctl start robinhood-pair-grid-key-check.service
sudo systemctl start robinhood-pair-grid-status.service
sudo journalctl -u robinhood-pair-grid-key-check.service --no-pager -n 30
sudo journalctl -u robinhood-pair-grid-status.service --no-pager -n 100
systemctl cat robinhood-pair-grid.service robinhood-pair-grid.timer
journalctl -u robinhood-pair-grid.service --no-pager -n 100
sudo systemctl start robinhood-pair-usdg-martingale-key-check.service
sudo systemctl start robinhood-pair-usdg-martingale-status.service
sudo systemctl start robinhood-pair-usdg-martingale.service
sudo journalctl -u robinhood-pair-usdg-martingale.service --no-pager -n 100
systemctl is-enabled robinhood-pair-usdg-martingale.timer
systemctl is-active robinhood-pair-usdg-martingale.timer
systemctl is-enabled robinhood-pair-usdg-martingale-monitor.timer
systemctl is-active robinhood-pair-usdg-martingale-monitor.timer
```

Expected initial timer state is `disabled` and `inactive`. A successful status command is readback evidence,
not evidence that automatic trading is active.

The installer always disables the legacy trading timer. It preserves already-enabled monitor timers and the
isolated martingale timer across later releases but does not enable them on first install. After the external
synthetic proof succeeds, enable only the legacy monitor if that strategy is in use:

```bash
sudo systemctl enable --now robinhood-pair-grid-monitor.timer
systemctl is-enabled robinhood-pair-grid.timer
systemctl is-active robinhood-pair-grid.timer
```

Both final trading-timer checks must still report `disabled` and `inactive`.

For an explicitly authorized isolated deployment, the one-shot service must first return a healthy `NO_ACTION`
or a fully evidenced rotation. Then enable its independent timer and read it back:

```bash
sudo systemctl enable --now robinhood-pair-usdg-martingale.timer
sudo systemctl enable --now robinhood-pair-usdg-martingale-monitor.timer
systemctl is-enabled robinhood-pair-usdg-martingale.timer
systemctl is-active robinhood-pair-usdg-martingale.timer
systemctl list-timers robinhood-pair-usdg-martingale.timer --no-pager
systemctl list-timers robinhood-pair-usdg-martingale-monitor.timer --no-pager
```

This enables persistent automatic signing only for the isolated wallet. It does not enable the legacy
`robinhood-pair-grid.timer`.

The monitor loads only `pair-grid-alert`; it never loads the martingale signing credential. Confirm its journal
reports `monitorMode: martingale`, `readbackOk: true` and `heartbeatOk: true`, while `martingale-status` reports
five verified bands and exact `latest === pending === expectedNextNonce`, before treating unattended operation
as healthy.
