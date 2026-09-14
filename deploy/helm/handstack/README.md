# HandStack Helm chart

This chart installs the distributed profile: stateless Web/API/MCP Deployments and Services,
six independently scalable worker classes, HPA, optional KEDA ScaledObjects, PDBs,
NetworkPolicies, ServiceAccount, ConfigMap and optional Ingress.

Production requires an external secret named by `externalSecrets.secretName` containing
`database-url` and `redis-url`. Set `externalSecrets.createSecret=true` only for controlled
evaluation environments; do not put production credentials in Helm values or release history.

The supported primary database adapters are `postgresql`, `mysql`, `mariadb`, `mssql` and
`mongodb`. Redis must be managed or HA (Sentinel/Cluster) in distributed production.

Example:

```sh
helm upgrade --install handstack deploy/helm/handstack \
  --set database.adapter=postgresql \
  --set externalSecrets.secretName=handstack-runtime \
  --set ingress.enabled=true
```

Use immutable image tags and a metrics-server plus an external-metrics adapter for the API/MCP HPA
signals (requests, latency, event-loop lag, active streams and in-flight capability executions).
Install KEDA separately before enabling
`keda.enabled`. Validate with `helm lint deploy/helm/handstack` and render with
`helm template handstack deploy/helm/handstack` before applying to a cluster.

## Upgrade and rollback

Keep chart releases and values under version control. Render the candidate revision and run
`pnpm helm:release:validate` before applying it. Upgrade with `helm upgrade --install` and wait for
all readiness probes to pass:

```sh
helm upgrade --install handstack deploy/helm/handstack --wait --timeout 10m
helm history handstack
```

If the rollout or readiness checks fail, return to the last known-good revision and verify health:

```sh
helm rollback handstack <REVISION> --wait --timeout 10m
kubectl rollout status deployment/handstack-api
kubectl get pods -l app.kubernetes.io/instance=handstack
```

Do not delete the release or its audit/database state as a rollback mechanism. Database migrations
must be backward-compatible with the previous application revision; destructive migrations require
a separately reviewed maintenance procedure and backup.
