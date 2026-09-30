# Architecture overview

HandStack is organized around a governed execution pipeline. A request enters through a supported
channel, resolves tenant and principal context, evaluates policy, executes a capability, and emits
auditable operational signals.

```text
Web / REST / MCP / Agent
          |
          v
  API and gateway boundaries
          |
          v
 Identity + tenant context + policy + access grants
          |
          v
       Capability runtime
          |
   +------+-------+-----------+
   |              |           |
Knowledge      Jobs       Workflows
   |              |           |
Storage/vector  Redis    Durable state
          |
          v
 Audit, telemetry, health, and operations
```

## Repository boundaries

- `apps/api` — HTTP API and runtime composition.
- `apps/web` — user-facing workspace and administration UI.
- `apps/worker` — background processing and distributed work.
- `packages/*` — domain packages, adapters, SDK, CLI, and shared contracts.
- `deploy/*` — Compose, Kubernetes, Helm, and release manifests.
- `docs/*` — user documentation, architecture decisions, requirements, and API contracts.

## Design principles

1. Domain packages should not depend on framework or infrastructure details unnecessarily.
2. All channels should use the same governed capability path.
3. Tenant and organization boundaries must be explicit in state, authorization, and audit events.
4. Secure defaults are preferred: telemetry opt-in, secret redaction, and deny-by-default boundaries.
5. External certification is separate from local conformance and must not be inferred from unit tests.

Stable architectural decisions belong in [ADRs](./adr/), while normative behavior belongs in the
[requirements catalog](../requirements/catalog.yaml).
