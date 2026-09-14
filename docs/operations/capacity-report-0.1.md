# HandStack capacity report 0.1

This report defines the reproducible acceptance targets for the compact and distributed profiles.
It is a release gate and not a production guarantee until the external environment is recorded.

```yaml
report_version: '0.1'
profile: compact
availability: 99.9%
api_p95_ms: 300
authorization_p99_ms: 100
queue_wait_p95_seconds: 5
accepted_durable_job_loss: 0
duplicate_side_effects_from_retries: 0
profile: distributed
availability: 99.9%
api_p95_ms: 300
authorization_p99_ms: 100
queue_wait_p95_seconds: 5
accepted_durable_job_loss: 0
duplicate_side_effects_from_retries: 0
```

The offline gate exercises bounded admission, retry idempotency and dead-letter retention. A
release report must additionally record CPU/memory, topology, database and Redis versions, tenant
count, request and job rates, concurrent streams, p95/p99 latency, error rate and cost.

External certification remains required for Redis/database failover, network partition, pod
termination during streams, zone outage, backup restore and regional failover against RPO <= 5
minutes and RTO <= 15 minutes.
