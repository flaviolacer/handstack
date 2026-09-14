# ADR 0003: Capability is the central abstraction

- Status: Accepted
- Date: 2026-08-31
- Milestone: M7

## Context

Web, REST API, MCP, and Agents must expose the same governed behavior.

## Decision

Capabilities are versioned executable resources. Every channel calls the `CapabilityExecutionEngine`; channels never execute handlers directly.

## Consequences

Authentication, authorization, policy, rate limits, budgets, guardrails, approvals, usage, audit, and telemetry remain centralized. M7 supplies the runtime implementation and tests.
