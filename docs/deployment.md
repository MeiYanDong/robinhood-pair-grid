# SWAS deployment

## Host layout

```text
/opt/robinhood-pair-grid/releases/<commit>/   immutable application release
/opt/robinhood-pair-grid/current              active release symlink
/var/lib/robinhood-pair-grid/                 private state and audit ledger
/etc/robinhood-pair-grid/runtime.env          root-owned public runtime identity
/etc/credstore.encrypted/                     encrypted wallet credential
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

## Post-deploy verification

```bash
systemctl is-enabled robinhood-pair-grid.timer
systemctl is-active robinhood-pair-grid.timer
sudo systemctl start robinhood-pair-grid-key-check.service
sudo systemctl start robinhood-pair-grid-status.service
sudo journalctl -u robinhood-pair-grid-key-check.service --no-pager -n 30
sudo journalctl -u robinhood-pair-grid-status.service --no-pager -n 100
systemctl cat robinhood-pair-grid.service robinhood-pair-grid.timer
journalctl -u robinhood-pair-grid.service --no-pager -n 100
```

Expected initial timer state is `disabled` and `inactive`. A successful status command is readback evidence,
not evidence that automatic trading is active.
