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

# Política do supervisor

O HandStack Autopilot usa `npm` por padrão e `yarn` somente quando `yarn.lock` existir. O gerenciador legado
do lockfile não deve ser executado pelo supervisor ou pelo agente.
