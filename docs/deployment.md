# SWAS deployment

## Host layout

```text
/opt/robinhood-pair-grid/releases/<commit>/   immutable application release
/opt/robinhood-pair-grid/current              active release symlink
/var/lib/robinhood-pair-grid/                 private state and audit ledger
/etc/robinhood-pair-grid/runtime.env          root-owned public runtime identity
/etc/credstore.encrypted/                     encrypted wallet credential
/etc/credstore.encrypted/pair-grid-alert      encrypted Feishu alert credential
```

## Install a release

On a trusted workstation, create a tarball from a clean, verified Git commit. Copy it over SSH and run:

```bash
sudo deploy/install-release.sh /path/to/release.tar.gz <full-commit-sha>
```

The installer runs production dependency installation and tests, installs systemd units and disables the
timer. It does not create, overwrite or arm credentials.

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

The bot should use both signature verification and the SWAS public egress IP allowlist. Test the independent
path before enabling its monitor timer:

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
```

Expected initial timer state is `disabled` and `inactive`. A successful status command is readback evidence,
not evidence that automatic trading is active.

The installer always disables the trading timer. It preserves an already-enabled monitor timer across later
releases but does not enable monitoring on first install. After the external synthetic proof succeeds, enable
only the monitor:

```bash
sudo systemctl enable --now robinhood-pair-grid-monitor.timer
systemctl is-enabled robinhood-pair-grid.timer
systemctl is-active robinhood-pair-grid.timer
```

Both final trading-timer checks must still report `disabled` and `inactive`.
