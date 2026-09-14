# ADR 0001: Modular monolith with distributed execution

- Status: Accepted
- Date: 2026-08-31
- Requirement: HS-CORE-001

## Context

HandStack must remain approachable for local and open-source development while supporting independently scaled Web, API, MCP, and worker processes.

## Decision

Use an npm/Turborepo modular monorepo. Domain and application contracts live in packages; deployable applications consume them. Compact and distributed profiles share the same rules and public contracts.

## Consequences

Package boundaries are enforced by imports and tests. Distributed state must use shared persistence, queues, streams, and storage rather than process memory.
