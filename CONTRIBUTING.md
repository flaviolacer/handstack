# Contributing to HandStack

HandStack accepts focused changes that preserve module boundaries, secure defaults, and requirements traceability.

## Development setup

Use Node.js 22 or 24 and npm 11. Use yarn only when `yarn.lock` exists.

```sh
npm install
npm run docs:validate
npm run lint
npm run typecheck
npm run test
npm run build
npm run graph:update
npm run graph:validate
```

Copy `.env.example` only for local overrides. Telemetry remains disabled unless explicitly enabled. Never commit credentials, generated graph output, local databases, or environment files.

## Change requirements

- Link behavior changes to stable IDs in `docs/requirements/catalog.yaml` and update traceability.
- Add or update tests for observable behavior.
- Keep canonical user documentation in English and Brazilian Portuguese with matching slugs.
- Add an ADR under `docs/architecture/adr` for durable architectural choices.
- Keep domain code independent of framework and infrastructure packages.

Contributions are licensed under Apache License 2.0 and must follow the Code of Conduct.

## Pull requests

Use the pull request template and describe the user-visible impact, affected requirements, validation,
and rollout or rollback considerations. Keep each pull request focused enough to review safely.

Maintainers may request changes to preserve security boundaries, documentation parity, API compatibility,
or requirements traceability. Passing CI is necessary but does not replace review of behavior and risk.

## Issue reports

Use the repository issue forms for bugs and feature requests. Usage questions belong in Discussions when
that feature is enabled. Never disclose credentials, personal data, or vulnerability details publicly;
see [SECURITY.md](./SECURITY.md) for responsible disclosure.
