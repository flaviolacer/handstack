# HandStack — plano para aderência integral

## Objetivo

Fechar as 160 seções normativas da especificação, mantendo a distinção entre
implementação, evidência executável e certificação externa. Nenhum requisito
será promovido para `verified` sem teste e documentação compatíveis com seu
nível de abrangência.

## Revalidação incremental — 2026-09-28

- [x] Uniformizar a cadeia tamper-evident na API e nos handlers do worker, incluindo auditoria de
      jobs, Secrets e Webhooks; evidência focal em `packages/audit/tests/audit.test.ts` e
      `apps/worker/tests/domain-handlers.test.ts`.
- [x] Coordenar o trecho leitura/hash/append entre réplicas no perfil distribuído com lock Redis
      tenant-scoped, token, TTL, renovação e falha fechada; o contrato é conectado pelo
      `EventBusRuntimeService` e pelos handlers do worker.
- [x] Preparar o drill Redis reproduzível em `apps/worker/tests/redis.integration.test.ts`, usando
      `HANDSTACK_TEST_REDIS_URL`; sem Redis, o teste permanece `skipped` e não altera a certificação.
- [ ] Executar o drill Redis real, failover e expiração de lease em ambiente autorizado; isso exige
      infraestrutura externa e evidência datada, conforme `CERTIFICATION-READINESS.md`.
- [x] Adicionar verificação agendada da cadeia de audit com `AuditIntegritySchedulerService`,
      lease persistente por tenant, configuração opt-in propagada aos deployments e evento
      sanitizado `AUDIT_VERIFIED`; a restauração WORM/SIEM e os drills externos continuam separados.

## Onda 0 — baseline e governança

- [x] Fixar npm, Git, OpenAPI gerado e documentação localizada.
- [x] Reconciliar 160 seções da especificação com o catálogo de 105 requisitos.
- [x] Auditoria executável com status global `PARTIAL` e lista de lacunas.
- [x] Criar matriz seção → requisito → código → contrato → teste → documentação. O crosswalk por
      famílias de seções está em `docs/requirements/traceability.md`; o catálogo canônico continua
      sendo `docs/requirements/catalog.yaml`.

## Onda 1 — fundamentos operacionais

Revalidação de privacidade: os executores de traces e anexos já possuem rotas autenticadas,
legal-hold, CAS, limpeza/estado do recurso e evidência de deletion job; não devem ser confundidos
com a lacuna ainda aberta de retenção de auditoria append-only e seus adaptadores de arquivamento.

- [x] Conformance local dos adapters PostgreSQL, MongoDB, MySQL, MariaDB e SQL Server.
- [ ] Exercitar backup/restore portátil e `doctor` em todos os adapters. (Progresso: jornada E2E
      em processo real cobre `migrate`, `doctor`, backup assinado e restore em SQLite com banco de
      destino separado; MongoDB passou backup/restore portátil assinado em banco separado e o
      `doctor` passou nos cinco adapters não-SQLite; PostgreSQL, MySQL, MariaDB e SQL Server também
      passaram conformance real e backup/restore portátil assinado com importação transacional.
      Ainda falta certificação de restauração em infraestrutura independente e backup imutável
      externo.)
- [ ] Conectar todos os parâmetros de configuração efetivos aos runtimes consumidores. (Progresso: `privacy.storePrompts`, `storeResponses` e `storeToolPayloads` são lidos dinamicamente pelo ChatRuntimeService; prompts não persistidos ficam em cache de execução somente em memória, com expiração de 15 minutos e limite de 512, já redigidos quando `redactPii` está ativo. `privacy.sendTelemetry` é gate adicional ao opt-in operacional no bootstrap da API. `redactPii` remove emails, CPFs e telefones detectáveis antes da persistência e do envio de conteúdo ao modelo. `queue.pendingClaimIdleMs` controla a retomada de PEL no Event Bus e é propagado por ambiente, Compose, Kubernetes e Helm. `queue.namespaces.rateLimit` agora forma as chaves Redis do ChatRateLimitService e `queue.namespaces.cache` isola o cache de discovery MCP, incluindo sua limpeza tenant-scoped. `HANDSTACK_MASTER_KEY` foi ligada a Compose, Kubernetes e Helm e também protege os segredos de webhooks com migração do ciphertext legado. `timeouts.agent` define o timeout padrão de versões de Agent; `timeouts.http` limita webhook deliveries, notificações HTTP externas e filas de operações HTTP; `timeouts.mcp` cancela chamadas remotas MCP; `timeouts.provider` controla providers oficiais e a fila `embeddings`; `timeouts.tool` limita capabilities e plugins; `timeouts.workflow` controla também a fila longa `indexing`, alinhando produtor API e worker. `rateLimits.chat` limita inícios de execução por organização/minuto, usando Redis compartilhado no perfil distribuído. Regressões cobrem configuração dinâmica, timeouts, cancelamento e limite de chat. A resolução de configuração por organização agora respeita a precedência ambiente → arquivo → configuração persistida do sistema → configuração da organização; teste HTTP comprova herança do timeout persistido no nível global. A retenção de conversas tem execução tenant-scoped explícita e scheduler opt-in com descoberta paginada de organizações ativas e lease CAS persistido por tenant; usa política específica ou `retention.conversation`, respeita legal holds em conversas/filhos, remove anexos pela cascata do Chat e grava evidência. A retenção de usage agora tem executor HTTP tenant-scoped, aplica `retention.usage`/política `usage-records`, preserva legal holds, exclui por CAS e grava evidência; a tela `/privacy` expõe a execução. Retenção de auditoria/traces/anexos e demais parâmetros continuam pendentes.)
      Evidência adicional da UI administrativa: `apps/web/tests/settings.test.tsx` exercita leitura/gravação autenticadas dos settings globais e organizacionais, estado visual, acessibilidade e bloqueio da alteração do adapter primário; não fecha o wiring de retenção de audit/usage/trace/anexos nem o restante da configuração operacional.
      Evidência adicional de retenção: `settings.http.test.ts` agora cobre usage, anexos e traces; usage aplica política e legal hold com CAS, anexos removem o blob local e marcam metadata com CAS, e traces removem apenas a correlação expirada preservando o conteúdo da mensagem. A tela `/privacy` expõe as três execuções e o scheduler executa todas sob a mesma lease. Capabilities podem declarar `metadata.consentPurposeId`; o runtime consulta o consentimento mais recente e falha fechado após retirada, com cobertura HTTP. Falhas de adapters externos agora geram evidência parcial retryable sem expor mensagens; `RedisSubjectCache` fornece um adapter externo executável com ownership por chave, índice tenant/titular e ligação ao Redis compartilhado no perfil distribuído; `ExternalBackupTombstoneAdapter` fornece o contrato executável para tombstones de backup e o perfil distribuído compõe o store Redis compartilhado com o tombstone do repositório. Retenção de audit append-only, restauração externa e drills reais continuam pendentes.
- [x] Fazer os workers herdarem o timeout de `timeouts.*` correspondente à fila; `HANDSTACK_WORKER_TIMEOUT_MS` permanece como substituição explícita. Cobertura de mapeamento para Agents, providers, HTTP, Plugins e Workflows e teste da precedência do override; 11 testes do worker, typecheck e lint aprovados.
- [x] Fazer o timeout distribuído de BullMQ falhar o job, abortar o sinal do handler e enviá-lo à DLQ; teste executado contra Redis 7.4 real nas dez filas oficiais, com cleanup do container ao final.
- [ ] Uniformizar Secrets em providers, MCP, plugins, notificações e webhooks. (Progresso: `ctx.secrets.get` faz RPC bidirecional para plugins isolados e exige permissão explícita; OIDC e Model Providers resolvem referências pelo broker auditado; webhook signing cifra com `HANDSTACK_MASTER_KEY`, AAD tenant-bound e envelope AES-GCM comum, migra ciphertext legado na leitura com a antiga `HANDSTACK_WEBHOOK_MASTER_KEY` opcional e registra `SECRET_ACCESSED` sem material secreto nos caminhos da API/worker. A rotação em cache agora persiste uma única chave e mantém o `keyId` usado pelo dispatcher. Testes cobrem migração atual/anterior, auditoria na API e no worker, e assinatura após rotação; seguem faltando referências brokeradas uniformes nos demais workers/provedores e integração com secret managers externos.)
      Evidência adicional de Secrets/Notifications: `NotificationRuntimeService` agora recebe explicitamente Database/Auth/SecretRuntime pelo container Nest. Teste do runtime com Nest real resolve `HANDSTACK_SMTP_PASSWORD_REF` pelo broker, busca o recipient no tenant e entrega ao nodemailer; permanecem pendentes outros consumers/workers e secret managers externos.
- [ ] Completar integração API → Redis → workers para todas as classes e cenários de retry/DLQ. (Progresso: as 10 filas BullMQ incluem `workflow-executions`; o E2E local publicou pela API, consumiu via BullMQ/Redis 7 e concluiu o workflow pela rota HTTP. Jobs duráveis agora preservam `requestId`, `traceId`, `principalId` e `source` da origem até o `JobContext` em memória e no transporte BullMQ; Operations, Knowledge reindex e Workflows passam essa proveniência. Billing agora também grava o `traceId` herdado em `UsageRecord` e `CostRecord` durante a liquidação. Contra Redis 7.4 real, testes consomem jobs nas dez filas e provocam falha terminal em handlers sintéticos: cada fila executa duas tentativas e entrega payload/erro à sua DLQ. O handler de workflow segue coberto por contrato. Faltam políticas de retry ligadas aos erros/domínios reais e prova operacional dos Deployments.)
- [ ] Adicionar testes de saturação, idempotência, retenção e failover do scheduler. (Progresso: nós Agent/MCP de workflows agora propagam as permissões RBAC efetivas do principal; duas instâncias agora são testadas disputando uma lease persistente no adapter SQLite, com execução única e takeover após liberação; o scheduler de privacidade agora executa conversas, usage e anexos sob a mesma lease, com regressão de ordem; ainda falta o drill distribuído do scheduler e cobertura de saturação.)
      A allow-list do cleanup worker foi alinhada aos nomes reais dos repositórios (`conversation-stream-events`); nomes legados (`chat-stream-events`, `chat-attachments`) são rejeitados. `conversation-attachments` permanece intencionalmente fora do cleanup genérico porque a remoção precisa apagar também o blob local. Teste focal, typecheck e lint do worker passaram; isto corrige o contrato de seleção, mas não implementa scheduler nem enforcement das políticas de retenção.

## Onda 2 — IA, Agents, MCP e Knowledge

- [ ] Completar jornadas E2E do Agent Builder, publicação, Web, MCP e Agent Tool. (Progresso:
      o Chat Workspace lista agentes publicados para WEB e o teste HTTP cobre seleção via `agentId`,
      execução no stream e persistência da resposta; agentes publicados com `publishChannels: ['MCP']`
      também são expostos como ferramentas `agent.<slug>` no JSON-RPC; o runtime resolve Agents
      publicados como `AGENT_TOOL` entre si com permissões herdadas e limite de recursão. Ainda falta
      E2E com provider compatível real e cobertura operacional externa. REST/stream público agora
      deriva permissões por RBAC e possui regressão contra privilege escalation. Testes adicionais
      exercitam no `AgentRuntimeService` a resolução de guardrails publicados (input/output e ID
      desconhecido fail-closed) e o resolver MCP por servidor, incluindo negação sem permissão e
      execução autorizada; Playwright agora verifica em Chromium/Firefox/WebKit que a UI seleciona
      o Agent WEB publicado, envia o `agentId` e apresenta sua resposta usando API simulada;
      os 9 testes Playwright de Chat passaram e os snapshots foram alinhados à UI atual; permanecem
      E2E das jornadas completas e dos provedores externos.)
- [ ] Completar gates de avaliação/red-team e rollback aprovado. (Progresso: campanhas para Model
      e Prompt agora executam cenários por adapters de provider, aplicam oráculos declarativos de
      contém/não contém e persistem evidência por digest sem salvar a resposta bruta; a publicação
      segue fail-closed. Agent e Workflow também executam pelos runtimes publicados, sem conceder
      permissões ao principal sintético; workflows precisam estar publicados para gatilho manual. O
      teste HTTP de model-admin passou (8/8), incluindo os quatro alvos. Falta prova operacional de
      rollback em ambiente implantado.)
- [ ] Completar conexão MCP externa, OAuth por usuário, publicação e reconexão. (Progresso: teste HTTP de interoperabilidade usa `McpServer` real em loopback, valida publicação, descoberta persistida/reidratação e execução no engine governado; SDK agora expõe credenciais por usuário e `oauth/start`/`oauth/callback`; `McpClientRegistry.reconnect`, a rota autenticada e `mcp.reconnect` no SDK fecham o transporte quebrado sem repetir tool não idempotente, e os testes stdio/HTTP confirmam a reabertura lazy; ainda falta E2E com servidor externo/deployado, credenciais reais e reconexão operacional em deployment.)
- [ ] Completar sincronização privada RAG, ACL revalidation, cursores, deleção e reindexação. (Progresso: testes de integração do KnowledgeRuntime com SQLite/vector store persistente cobrem fonte pública e Google Drive: fetch→ingestão→busca ACL-scoped→mudança de ACL por cursor→deleção. Novo E2E da API percorre o scheduler real e cobre S3/MinIO, vault criptografado, referência tenant-scoped, lease, ingestão e auditoria; o teste do pacote também confirma conteúdo e ETag. Permanecem pendentes os demais provedores externos, sincronização OAuth real e failover do scheduler em deployment.)
- [ ] Completar sincronização privada RAG, ACL revalidation, cursores e deleção. (Progresso: o scheduler opt-in sincroniza os conectores com runtime concreto — URL, GitHub, Google Drive, SharePoint, Confluence, Notion e S3 — e exclui FILE/TEXT/DATABASE sem fetch incremental. Lease persistente CAS já coordena instâncias; teste SQLite cobre disputa/handoff entre duas réplicas e Compose/Kubernetes/Helm expõem o controle desativado por padrão. Os testes existentes cobrem seleção de fontes, descoberta paginada, Google Drive simulado e ACL/cursor/deleção; há E2E S3/MinIO real pela API com vault e auditoria. Permanecem os outros providers e failover operacional em deployment.)
- [x] Conectar jobs duráveis de reindexação do Knowledge à API e ao worker `indexing`. Há rotas tenant-scoped para criar/consultar/cancelar, migração/resume por cursor e publicação do modelo somente no sucesso; profile distribuído enfileira e usa endpoint interno com service token, enquanto o compacto oferece execução manual. Testes do package, integração SQLite persistente, HTTP/RBAC, worker handler e scopes de embedding passaram. O E2E API→Redis 7.4→BullMQ worker→endpoint interno passou com provider de embedding simulado; provider real, broker real e descoberta operacional de tenants seguem pendentes.
- [ ] Executar conformance dos seis adapters vetoriais configurados. (Progresso: pgvector/PostgreSQL
      16 com extensão real, Qdrant 1.13.6, Weaviate 1.28.4 e Chroma 1.0.0 passaram por busca,
      filtros, exclusão e isolamento tenant-scoped. Foram corrigidos `has_id`, filtros GraphQL e
      exclusão multi-tenant no Weaviate, e a migração do Chroma para API v2 (IDs de coleção, header
      de token, composição `$and` e deleção de titulares em lotes). Testes simulados cobrem
      tenant-spoofing em Pinecone e MongoDB Atlas. MongoDB Atlas Vector Search passou em integração
      real com a imagem oficial Atlas Local (mongot): criação de índice, busca com filtro nested e
      tenant-spoofing, exclusão por IDs e por titular; o teste cria a coleção e aguarda a indexação
      assíncrona. Container, volumes anônimos e imagem temporários foram removidos. Em 29/09/2026,
      pgvector, Qdrant 1.13.6, Chroma 1.0.0 e Weaviate 1.28.4 passaram 1/1 teste cada em
      containers reais; o primeiro cold start do Chroma excedeu o timeout padrão, mas a repetição
      aquecida passou. A primeira tentativa do pgvector ocorreu durante o bootstrap e foi repetida
      após a prontidão do serviço.
      Ainda faltam Pinecone real, execução do índice no Atlas gerenciado e certificação operacional
      dos seis adapters.)

## Onda 3 — plugins, privacidade e operações

- [ ] Completar lifecycle isolado e marketplace remoto com assinatura/SBOM/provenance verificáveis.
      (Progresso: artefatos externos NPM/GitHub agora exigem cache pré-provisionado, checksum conferido,
      assinatura Ed25519 vinculada à identidade/versão e digests supply-chain, publisher confiável em
      configuração e modo isolado. O runtime também valida digests e conteúdo de SBOM CycloneDX/SPDX e
      attestation in-toto/SLSA associada ao checksum, descartando os documentos após validação. Restam
      marketplace remoto, malware/dependency scanning e E2E operacional.)
- [x] Aplicar quarentena persistente ao loader e expor a ação na administração Web.
- [ ] Aplicar revogação de publisher a todos os fluxos operacionais existentes.
      (Progresso: controles de quarentena/revogação são persistidos antes de hooks; o Registry
      desativa instalações afetadas, falhas de `onDisable` não liberam reativação, e testes de
      runtime/HTTP cobrem quarentena e revogação. Marketplace remoto e validação operacional ainda
      faltam.)
- [ ] Completar adaptadores externos de cache, backup, busca e storage para privacidade.
- [ ] Provar consentimento, residência, legal hold e deleção em cada destino de dados.
- [ ] Exercitar Notifications, Webhooks, Incidents, Audit e Event Bus em modo distribuído. (Progresso: Redis Streams retoma PEL com `XAUTOCLAIM`, contador de tentativas e ACK após DLQ; workflows publicados restauram subscriptions no startup, recebem eventos do Redis, enfileiram execução com chave idempotente derivada por hash e preservam request/trace/principal/source, rejeitando evento cross-tenant. Teste focal passou em API compacta e integração real com Redis 7.4 após restart simulado. Workflows HTTP também preservam contexto até o endpoint interno. Notifications, Webhooks, Incidents e Audit agora publicam eventos de domínio sanitizados no mesmo Event Bus, com teste focal de entrega e não vazamento de corpo/metadados sensíveis. O contexto HTTP (`requestId`, `traceId`, `principalId`, `source`) agora atravessa Notifications, Incidents, Webhooks e auditoria até os eventos publicados; `traceId` também é persistido no registro de auditoria. Os handlers de worker também repassam `requestId` e `traceId` nas chamadas internas à API. Entregas Webhook do worker agora anexam o contexto limitado aos eventos de auditoria, sem enviá-lo ao endpoint externo. Ainda falta executar o cenário distribuído completo e certificar o contexto nos providers externos.)

## Onda 4 — SDK, CLI, frontend e contratos

- [ ] Completar E2E do SDK/CLI para todos os domínios e Configuration as Code. (Progresso:
      SDK agora cobre execução REST e streaming de Agents, Knowledge, Privacy, MCP, Plugins,
      Secrets, Workflows, Notifications, Incidents, Operations, Settings, Gateway API Keys,
      Webhooks, Chat Workspace, Access, Directory/RBAC, Budgets, Policies, Service Accounts,
      Routing, settings de database, Models/Providers/Evaluation/Red-Team e Identity/SCIM, com 20
      testes de contrato; a superfície administrativa local do SDK está mais completa, mas ainda
      falta execução contra API implantada. O CLI agora tem uma jornada E2E
      em processo real para `init` → `apply` → `export` → `config sync`, com fixture Git e API HTTP
      autenticada simulada. A Governança de Privacy agora também cobre todos os endpoints do
      controller no SDK, com 18 testes de contrato; permanecem os demais domínios e o E2E contra
      deployment. Incremento local adicional: o SDK agora também expõe auditoria, feature flags,
      enqueue de jobs e retry/discard de DLQ em Operations, com teste de contrato. O CLI também
      expõe `mcp reconnect --server <server-id>` pela API de gestão autenticada, com teste focal
      do contrato HTTP. O SDK agora publica o tipo de execução do Chat Workspace, e o CLI valida
      antecipadamente o caminho de saída do export e `metadata.name` nos manifests; os testes
      focais e as duas jornadas E2E locais do CLI passaram. O E2E contra deployment continua
      pendente.)
- [ ] Completar testes de acessibilidade, reconexão, erros e compatibilidade dos fluxos administrativos.
- [x] Validar artigos e links contextuais contra as rotas atuais. A governança verifica superfícies,
      IDs de artigos localizados e a existência das 33 rotas apontadas no App Router Web.
- [ ] Garantir compatibilidade pública, depreciação, schemas e idempotência conforme OpenAPI.
      (Progresso: o validador agora verifica as 205 rotas e 267 operações geradas, exige
      `operationId` único, respostas declaradas e parâmetros de caminho obrigatórios; a correção
      da revogação de grants também valida o vínculo entre `requestId` e `grantId`. Ainda faltam
      compatibilidade de versões implantadas, depreciações exercitadas e E2E contra deployment.)

## Onda 5 — certificação e release

- [ ] Drill de HA/failover e backup/restore em ambiente implantado.
- [ ] Drill de DR multi-zona/multi-região com RPO/RTO medidos.
- [ ] Teste de capacidade com p95/p99, taxas e topologia registrados.
- [ ] Upgrade/rollback sem downtime em janela de rolling upgrade.
- [ ] Contract/E2E com providers externos compatíveis.
- [ ] Threat-model review e pentest da release.

Pré-requisitos e bloqueios objetivos das seis certificações estão registrados em
`SCOPE-AUDIT.md`; drills locais de MongoDB/Redis e provider loopback não são tratados como
certificação de produção ou de segurança. Na revalidação de 2026-09-18, os validadores de Helm,
release, resiliência offline, contrato DR, Kubernetes, container e frontend passaram; o teste de
startup Playwright passou nos três engines. Isso comprova os contratos locais, sem substituir os
pré-requisitos de ambiente, credenciais, janela de operação e autorização documentados para as seis
certificações.

## Gate de cada onda

Executar testes focados e globais, typecheck, lint, build, OpenAPI/documentação,
auditoria de escopo e `npm run docker:clean`. A onda só será considerada
concluída quando a evidência corresponder ao nível do requisito; certificações
que dependam de infraestrutura/credenciais serão registradas como pendência
objetiva, nunca como `verified`.
