# HandStack observability and alerts

This runbook defines the versioned operational contract for the SLO dashboard and alert rules in
`deploy/observability/`. Import the dashboard into the approved Grafana instance and translate the
alert rules into the organization's Prometheus-compatible rule format. The offline gate checks the
coverage and metric references before a release.

## SLOs

- API availability: at least 99.9% monthly, excluding external providers and tools.
- Control-plane API p95: at most 300 ms under certified load.
- Authorization p99: at most 100 ms when dependencies are healthy.
- Queue wait p95: at most 5 seconds.
- Accepted durable job loss and duplicate retry side effects: zero.

## Response

Start with `/metrics`, the SLO dashboard, and the deployment revision. For saturation alerts,
confirm desired versus available replicas and queue age before increasing limits. For Redis or
database alerts, fail closed for new distributed work that depends on locks, queues, rate limits,
or consistent state; never bypass authorization or budgets. Inspect dead letters through the
administrative workflow and retry only after confirming idempotency.

Do not put prompts, payloads, tokens, passwords, tenant identifiers, user identifiers, model
names, or provider secrets into metric labels, dashboards, or alert annotations. Route-specific
and queue-level labels must use bounded, approved dimensions.

## Verification

```text
npm run observability:validate
npm run resilience:validate
```

External certification is still required for Redis/database failover, network partitions, zone
outages, stream termination, backup restore, and regional failover against RPO five minutes and
RTO fifteen minutes.
