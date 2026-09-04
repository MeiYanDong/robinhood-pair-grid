# Dedicated SWAS purchase boundary

Date: 2026-09-04

A dedicated Alibaba Cloud Simple Application Server was purchased for this strategy in `us-west-1`:

- Ubuntu 24.04;
- 2 vCPU, 2 GiB RAM and 40 GiB ESSD;
- one-month term at the observed control-plane price of CNY 56;
- instance state was observed as `Running` and Cloud Assistant was available.

Public documentation deliberately omits the public IP, instance ID, request IDs and idempotency tokens. Those
values are operational metadata, not application configuration.

At the time of purchase, application deployment, credential migration, systemd installation, runtime
readback, external alert delivery and live signing were not yet complete. Later deployment evidence must not
retroactively change this purchase-time boundary.
