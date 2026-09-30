# Troubleshooting

## Start with environment information

Record the following before changing configuration:

```bash
node --version
npm --version
git rev-parse --short HEAD
```

Use a sanitized copy of `.env.example`. Do not paste secrets into issues, logs, or pull requests.

## Dependencies are not ready

The default development setup uses SQLite. For optional services, verify the selected Compose profile:

```bash
docker compose -f deploy/docker-compose/compose.yaml ps
docker compose -f deploy/docker-compose/compose.yaml logs --tail=100
```

A local container is a development dependency and does not certify a production deployment. Consult
[Compose profiles](../deploy/docker-compose/README.md) for the expected variables and profiles.

## Port already in use

The default API and Web ports are `3001` and `3000`. Change the corresponding local environment
variables or stop the process that owns the port. Do not expose development services publicly.

## Tests fail after a dependency change

Run the smallest affected package test first, then the full checks:

```bash
npm run docs:validate
npm run lint
npm run typecheck
npm run test
```

If a failure depends on a real provider, database, or Redis service, label it as an integration
environment issue and include the exact provider/profile used.

## Docker cleanup

The project cleanup command removes resources named for the HandStack development environment:

```bash
npm run docker:clean
```

Review the script and active resource names before running cleanup in a shared Docker host.

## Still blocked?

Search existing issues and discussions first. Then open a report using the appropriate template with
the version, environment, reproduction steps, sanitized output, and expected behavior.
