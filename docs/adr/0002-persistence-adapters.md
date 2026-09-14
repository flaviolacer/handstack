# ADR 0002: Repository and transaction contracts are canonical

- Status: Accepted
- Date: 2026-08-31
- Milestone: M1

## Context

SQL databases and MongoDB must expose identical observable domain behavior without leaking infrastructure concepts.

## Decision

Domain modules depend on repository and transaction interfaces. TypeORM and the MongoDB driver remain infrastructure adapters. Shared conformance suites define parity.

## Consequences

Every repository change requires SQL and MongoDB implementations, migrations, indexes, and parity tests. This ADR establishes direction; M1 supplies executable evidence.
