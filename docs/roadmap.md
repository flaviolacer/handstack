# Roadmap and maturity

HandStack is pre-1.0. This roadmap describes product maturity, not a promise of delivery dates.
The requirements catalog and release gates are the authoritative sources for implementation status.

## Current state

- Core workspace, capability, gateway, governance, knowledge, operations, SDK, and CLI work is under
  active implementation.
- Local format, documentation, lint, typecheck, test, build, contract, and security gates are tracked
  in the release evidence package.
- Production certification, managed-provider validation, multi-zone failover, immutable backup,
  disaster recovery, production load, rolling upgrades, and independent penetration testing require
  authorized external environments.

## Near-term priorities

1. Keep the local gates reproducible and fast for contributors.
2. Complete the first authorized staging certification exercise.
3. Publish supported runtime, deployment, API, and provider matrices.
4. Establish a versioned release process with upgrade and rollback evidence.
5. Close the remaining security and operations gates before declaring production readiness.

## Release criteria

Before `1.0.0`, the project should have:

- documented supported versions and compatibility policy;
- reproducible CI for the complete local gate suite;
- published API and migration policy;
- staging evidence for HA, DR, capacity, upgrade/rollback, providers, and threat assessment;
- maintainer ownership for security response and release operations;
- installation, upgrade, rollback, and troubleshooting documentation;
- no unresolved release-blocking security findings.

For the detailed requirement-to-evidence mapping, see [CERTIFICATION-READINESS.md](../CERTIFICATION-READINESS.md)
and [docs/requirements/catalog.yaml](./requirements/catalog.yaml).
