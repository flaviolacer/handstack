# Docker Compose profiles

The default profile starts the compact API/Web stack with SQLite and no Redis.

Optional infrastructure is isolated by profile so selecting one database does not start another:

```text
docker compose -f deploy/docker-compose/compose.yaml --profile postgres up
docker compose -f deploy/docker-compose/compose.yaml --profile mongodb up
docker compose -f deploy/docker-compose/compose.yaml --profile distributed up
```

Set `HANDSTACK_DATABASE_ADAPTER` and `HANDSTACK_DATABASE_URL` when selecting a non-SQLite profile;
the API defaults to `sqlite`/`file:/data/handstack.db` when these variables are omitted.

The PostgreSQL, MongoDB and Redis services are development dependencies only. Production deployments
must use managed HA database/Redis services and inject credentials through an external secret manager.
