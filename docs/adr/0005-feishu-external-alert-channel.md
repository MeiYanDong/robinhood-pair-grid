# ADR 0005: Feishu external alert channel

Status: Accepted for implementation; live delivery pending operator credential

Date: 2026-09-04

## Context

The keeper's existing `OnFailure` handler records only a local journal message. A host or network failure can
therefore remove both execution and notification. The alert path must remain separate from the signing path,
retain credentials outside Git and process arguments, and produce provider-side evidence before unattended
trading can be considered.

## Decision

Use a Feishu custom group bot with signature verification as the external delivery channel. Store the webhook
URL and signing secret together in the separate encrypted systemd credential named `pair-grid-alert`. The alert
process accepts only the official `https://open.feishu.cn/open-apis/bot/v2/hook/...` endpoint, emits the required
signed text payload and treats only HTTP success plus provider `code: 0` as delivery acknowledgement. The
protocol follows the [official custom-bot guide](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot).

The write-capable keeper loads only the wallet credential. Alert and monitor units load only the alert
credential. The monitor invokes the read-only `status` command with `PAIR_GRID_LIVE_ARM=0`, reports a durable
HALTED sentinel immediately, and reports chain readback only after three consecutive failures. Acknowledged
alerts are deduplicated for six hours; failed delivery remains pending for the next monitor run.

## Consequences

The monitor timer may be enabled independently of the trading timer. Installing this code does not configure a
webhook, enable monitoring or arm trading. Issue 8 remains open until an operator creates the group bot, enables
signature verification, installs the encrypted credential, receives a synthetic alert in Feishu and preserves
the provider `code: 0` acknowledgement without recording either secret.
