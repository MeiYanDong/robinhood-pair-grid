# Story set 0003: External alert delivery

## Story 1 - Isolate and validate the alert credential

Acceptance: only an encrypted systemd credential can supply the Feishu webhook and signing secret; the URL is
restricted to the official custom-bot endpoint; tests prove credentials and RPC URLs are absent from messages,
errors and acknowledgements.

## Story 2 - Deliver an independently acknowledged service failure

Acceptance: Keeper `OnFailure` invokes a non-signing unit; bounded retries require HTTP success and Feishu
`code: 0`; a dedicated synthetic unit exercises the same path without reading the wallet credential.

## Story 3 - Detect failures that outlive one process

Acceptance: a separate timer reads the durable HALTED sentinel on every run, invokes only the read-only status
command, alerts after three consecutive readback failures, deduplicates successful deliveries and retries an
unacknowledged alert.

## Story 4 - Prove the live external path

Acceptance: install the alert credential outside Git and argv, run the synthetic unit on the SWAS host, observe
the message in the selected Feishu group and capture a redacted provider `code: 0` acknowledgement. Only then
enable the monitor timer. Completed with provider, UI and recurring timer readback in the
[deployment evidence](../evidence/2026-09-04-feishu-alert-deployment.md).
