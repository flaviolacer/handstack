# HandStack — estado de retomada

## Estado atual — M297 (2026-09-14)

- Estado: implementação catalogada concluída; auditoria dos gates globais concluída.
- Requisitos: 104/104 em `docs/requirements/catalog.yaml` com `status: verified`.
- Evidência viva: Node v26.7.0 (fora do engine declarado), npm 11.19.0 e Docker 29.8.0 executáveis; o CI permanece fixado para Node 22/24.
- Gates verificados: `format:check`, `docs:validate`, `lint`, `typecheck`, `test`, `build`, resiliência, Helm, release, observabilidade, frontend, integração, Graphify, OpenAPI e conformance PostgreSQL/MongoDB/MySQL/MariaDB.
- Contrato: `docs/api/openapi.json` gerado automaticamente por `npm run openapi:generate` e validado por `npm run openapi:validate`.
- Repositório: Git inicializado na raiz; npm é o gerenciador padrão com `package-lock.json`, workspaces npm e CI migrada para `npm ci`.
- Bloqueios: nenhum gate funcional pendente; npm ainda emite warnings sobre chaves legadas do `.npmrc`.
- SIEM: não é dependência do MVP; qualquer exportação/integração SIEM permanece extensão operacional futura, fora dos gates de conformance.
- Histórico detalhado: `HISTORY.md`.
