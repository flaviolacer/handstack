# Distributed deployment

`handstack.yaml` is a portable baseline for Kubernetes. It keeps Web, API, MCP and each worker
class stateless and independently scalable. Supply production secrets (database, Redis HA,
object storage and signing keys) through an external SecretProvider; they are intentionally absent
from this manifest.

Apply with `kubectl apply -f deploy/kubernetes/handstack.yaml`, then configure an Ingress/WAF and
replace image tags with immutable digests. HPAs cover Web, API and MCP CPU; KEDA ScaledObjects
provide Redis/BullMQ backlog hooks for workers (install KEDA and set `REDIS_URL`). Pod disruption
budgets, default-deny network policy, resource requests/limits, topology spread and graceful
termination are included as safe defaults. Readiness uses `/health/ready`, while liveness uses
`/health/live` so an unhealthy dependency is removed from service without killing every replica.
