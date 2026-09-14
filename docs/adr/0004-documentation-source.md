# ADR 0004: Canonical docs-as-code source

- Status: Accepted
- Date: 2026-08-31
- Requirement: HS-DOC-001

## Context

Public documentation and self-hosted in-product help cannot drift or depend on internet access.

## Decision

Maintain localized MDX under `docs/content/<locale>`. `@handstack/docs-engine` validates and loads the content for both Next.js applications.

## Consequences

Article IDs and metadata are stable. CI blocks invalid frontmatter, locale gaps, missing operational sections, invalid requirement evidence, and broken contextual-help targets.
