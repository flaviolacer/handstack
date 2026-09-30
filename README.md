# HandStack

[![CI](https://github.com/handstack/handstack/actions/workflows/ci.yml/badge.svg)](https://github.com/handstack/handstack/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)
[![Status: pre-1.0](https://img.shields.io/badge/status-pre--1.0-orange.svg)](./docs/roadmap.md)

HandStack is an open-source AI workspace, agent runtime, gateway, and capability platform.

Its central abstraction is the **Capability**: Web, REST, MCP, and Agent channels execute through
the same governed pipeline, with tenant-aware policy, access control, audit, secrets, and operational
boundaries.

> **Project status:** HandStack is under active development and is currently pre-1.0. Local validation
> is passing, but production certification and managed-provider validation are still pending. APIs and
> configuration may change before the first stable release.

## What HandStack provides

| Area            | Description                                                             |
| --------------- | ----------------------------------------------------------------------- |
| Capabilities    | Governed execution units shared by all supported channels               |
| Agents          | Runtime primitives for tool use, workflows, and agent execution         |
| Gateway         | REST, Web, MCP, and internal service boundaries                         |
| Governance      | Policies, access requests, grants, audit, secrets, and tenant isolation |
| Knowledge       | Source connectors, object storage, and vector-store integrations        |
| Operations      | Jobs, workflows, health, observability, and recovery tooling            |
| Developer tools | TypeScript packages, SDK, CLI, OpenAPI, and deployment manifests        |

## Quick start

### Requirements

- Node.js 22 or 24 LTS
- npm 11
- Docker Desktop or Docker Engine only when using an infrastructure profile

### Install and validate

```bash
git clone https://github.com/handstack/handstack.git
cd handstack
npm install
cp .env.example .env
npm run docs:validate
npm run lint
npm run typecheck
npm run test
npm run build
```

The default configuration uses SQLite and keeps telemetry disabled. Never put credentials in `.env`
under version control.

### Run locally

```bash
npm run dev
```

The default ports are API `3001` and Web `3000`. To run optional local infrastructure, choose a
Compose profile and configure the matching database variables:

```bash
docker compose -f deploy/docker-compose/compose.yaml --profile postgres up -d
docker compose -f deploy/docker-compose/compose.yaml --profile distributed up -d
```

See [Docker Compose profiles](./deploy/docker-compose/README.md) for profile-specific settings and
[troubleshooting](./docs/troubleshooting.md) when a service is not ready.

## Documentation map

| Need                     | Start here                                                        |
| ------------------------ | ----------------------------------------------------------------- |
| Understand the project   | [Architecture overview](./docs/architecture/overview.md)          |
| Install and configure    | [Getting started](./docs/content/en/getting-started/overview.mdx) |
| Use Docker               | [Compose profiles](./deploy/docker-compose/README.md)             |
| Use the API              | [OpenAPI contract](./docs/api/openapi.json)                       |
| Extend the platform      | [Contributing](./CONTRIBUTING.md)                                 |
| Understand requirements  | [Requirements catalog](./docs/requirements/catalog.yaml)          |
| Check current maturity   | [Roadmap and maturity](./docs/roadmap.md)                         |
| Diagnose a local problem | [Troubleshooting](./docs/troubleshooting.md)                      |
| Report a vulnerability   | [Security policy](./SECURITY.md)                                  |

The documentation is maintained in English and Brazilian Portuguese where user-facing content is
available. The [documentation validator](./packages/docs-engine) checks localization and requirement
coverage.

## First example

A capability should be exposed through the same governed execution path regardless of its channel.
The API contract and examples are the source of truth for request details:

1. Start the local stack with `npm run dev`.
2. Open the Web application at `http://localhost:3000`.
3. Configure the local organization and capability through the application or API.
4. Use the generated OpenAPI contract at `docs/api/openapi.json` to call the capability.

For production integrations, treat the API contract as versioned input and pin a released version of
the project rather than the default branch.

## Development checks

The main local gate is:

```bash
npm run format:check
npm run docs:validate
npm run lint
npm run typecheck
npm run test
npm run build
```

Focused package checks are encouraged during development. Read [CONTRIBUTING.md](./CONTRIBUTING.md)
before changing behavior, requirements, APIs, or deployment contracts.

## Scope and maturity

HandStack is designed for governed AI application infrastructure. It is not a hosted service,
model provider, or replacement for an organization's identity, secret-management, backup, or security
operations program. Local tests do not certify managed providers, multi-zone availability, production
load, immutable backup, disaster recovery, or independent penetration testing.

The current evidence package and known limitations are recorded in [STATUS.md](./STATUS.md) and the
[certification readiness matrix](./CERTIFICATION-READINESS.md).

## Community and support

- Read [SUPPORT.md](./SUPPORT.md) before opening an issue.
- Use the bug and feature templates for actionable reports.
- Use private vulnerability reporting as described in [SECURITY.md](./SECURITY.md).
- Follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## License

HandStack is released under the [Apache License 2.0](./LICENSE).
