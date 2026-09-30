# HandStack — laboratório local de certificação

Atualizado em 2026-09-29. Este laboratório é reproduzível e serve para preparar os seis gates;
não é staging autorizado nem certificação de produção.

## Serviços ativos verificados

| Área    | Serviço             | Imagem/porta                                          |
| ------- | ------------------- | ----------------------------------------------------- |
| Fila    | Redis               | `redis:7-alpine` / `6379`                             |
| Banco   | MongoDB replica set | `mongo:7` / `27017`                                   |
| Banco   | PostgreSQL          | `postgres:16-alpine` / `5434`                         |
| Banco   | MySQL               | `mysql:8.4` / `3307`                                  |
| Banco   | MariaDB             | `mariadb:11` / `3308`                                 |
| Banco   | SQL Server          | `mcr.microsoft.com/mssql/server:2022-latest` / `1434` |
| Vetor   | pgvector            | `pgvector/pgvector:pg16` / `5433`                     |
| Vetor   | Qdrant              | `qdrant/qdrant:v1.13.6` / `6333`                      |
| Vetor   | Chroma              | `chromadb/chroma:1.0.0` / `8000`                      |
| Vetor   | Weaviate            | `semitechnologies/weaviate:1.28.4` / `8080`           |
| Objetos | MinIO S3            | `quay.io/minio/minio:latest` / `9000`                 |

## Reprodução local

```text
docker compose -f deploy/docker-compose/compose.yaml up -d redis
$env:HANDSTACK_TEST_REDIS_URL='redis://localhost:6379'
npm run certification:preflight -- --output artifacts/certification/release-candidate-2026-09-29 --include-contracts
```

Os drills específicos de banco, vetores, S3, SDK/CLI e API estão nos logs do pacote de release.
Os containers de conformance usam portas isoladas e não substituem réplicas multi-zona, storage
imutável, providers externos ou revisão independente.

## Limites deliberados

- Mongo local tem um único membro; não há evidência válida de failover multi-réplica.
- Backup/restore SQL local usa origem e destino lógicos no mesmo banco.
- Providers gerenciados, OAuth real, carga de produção, rolling upgrade e pentest permanecem
  externos.
- Nenhum segredo ou credencial de produção deve ser adicionado ao repositório ou aos artefatos.

## Limpeza executada

Em 2026-09-29, após o preflight, o cleanup local removeu os containers, volumes e rede do projeto,
as tags de imagem usadas por este laboratório e as imagens locais `handstack-api`, `handstack-web` e
`handstack-docs`. Imagens de outros projetos não foram alteradas. Os artefatos de evidência foram
preservados.
