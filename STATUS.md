# HandStack — estado de retomada

## Estado atual — execução do plano (2026-09-29)

- Retomada após o desbloqueio do ambiente: Docker Desktop Linux Engine está ativo (29.8.0) e o
  Redis oficial do `deploy/docker-compose/compose.yaml` está saudável. Os drills Redis isolados
  passaram: worker 6/6, core Streams 1/1, API Event Bus 3/3, workflow distribuído 1/1 e Knowledge
  reindex distribuído 1/1. O parser do harness Redis do core foi corrigido para ler corretamente a
  linha de `XPENDING`; a correção é somente de conformance/teste.
- O preflight de release foi reexecutado com `HANDSTACK_TEST_REDIS_URL` configurada:
  `artifacts/certification/release-candidate-2026-09-29` contém 19/19 gates locais aprovados,
  incluindo format, docs, lint, typecheck, test, build, contratos e segurança. Os seis gates
  externos continuam `NOT_CERTIFIED`, pois ainda exigem staging/produção autorizado, providers e
  revisão independente; o próximo passo é executar o primeiro exercício externo com owner e janela.
- Após a simulação local, os containers, volumes, redes e imagens do laboratório foram removidos;
  as três imagens locais de aplicação também foram removidas; a verificação final não encontrou
  recursos `handstack` nem as onze tags de imagem do laboratório. Os artefatos de evidência e a
  documentação permanecem preservados.
- A base pública do projeto foi preparada para GitHub: README orientado a usuários, mapa de
  documentação, roadmap, troubleshooting, arquitetura, versionamento, suporte, citação, templates
  de issues/PR, Dependabot e CodeQL. Formatação global e `docs:validate` passaram.
- MongoDB repository conformance também foi executada contra o serviço Compose em replica set `rs0`:
  1/1 teste e 6 checks canônicos aprovados. O failover não foi promovido porque o Compose local tem
  um único membro; essa limitação está registrada no pacote de evidências.
- Conformance vetorial real também passou para pgvector 1/1, Qdrant 1/1, Chroma 1/1 e Weaviate 1/1 usando as
  imagens fixadas pelo plano. O primeiro Chroma teve cold start acima de 5s; a repetição aquecida
  passou no timeout padrão. Pinecone gerenciado, Atlas gerenciado e certificação de produção seguem
  pendentes. A primeira tentativa do pgvector ocorreu durante o bootstrap do PostgreSQL e foi
  repetida após a prontidão do serviço.
- O conector S3 do Knowledge passou 1/1 contra MinIO real, cobrindo lifecycle do objeto, referência
  de credencial tenant-scoped, leitura de conteúdo e versão do provider; o log está no pacote de
  release. Isso não certifica storage de produção.
- O backup/restore portátil MongoDB passou 1/1 em replica set, usando staging assinado e banco de
  destino separado. A evidência está no pacote de release; backup imutável e HA externo continuam
  pendentes.
- PostgreSQL/TypeORM, MySQL/TypeORM, MariaDB/TypeORM e SQL Server/TypeORM passaram 1/1 cada com
  6 checks canônicos, usando containers reais isolados.
- O CLI `doctor` passou para MongoDB, PostgreSQL, MySQL, MariaDB e SQL Server com `healthy=true`
  e todos os checks de conexão, versão, transações, schema, índices e migrações; SQLite já estava
  coberto pela jornada E2E. Isso fecha o diagnóstico local dos seis adapters; a certificação externa
  de backup imutável, HA ou DR continua separada.
- Backup/restore portátil SQL passou 1/1 em PostgreSQL, MySQL, MariaDB e SQL Server, com exportação
  assinada tenant-scoped, verificação HMAC, importação transacional e leitura restaurada. Os logs
  estão no pacote de release; o cenário local usa origem e destino lógicos no mesmo banco, portanto
  restauração independente, imutabilidade, HA e DR continuam gates externos.
- O contrato OpenAPI agora valida 205 rotas e 267 operações, exigindo `operationId` único, respostas
  e parâmetros de caminho completos. A revogação de access grants valida o vínculo entre `requestId`
  e `grantId`, com teste de serviço e E2E HTTP autenticado, build e lint aprovados.
- `CERTIFICATION-RUNBOOKS.md` consolida a execução dos seis gates externos sem credenciais; SDK passou
  22/22 testes e CLI passou 2/2 jornadas de processo. Os logs estão no pacote de release e não
  substituem E2E contra deployment ou providers reais.
- O runtime de auditoria da API agora envolve tanto o sink em memória quanto o repositório durável
  com `TamperEvidentAuditSink`; eventos de Webhooks passam pela mesma cadeia. O teste de runtime
  confirma sequência, `GENESIS` e hash; append concorrente é serializado por organização no
  processo. `AuditRuntimeService` expõe `verify` e `checkpoint` tenant-scoped para consumidores
  internos. Os fluxos de Secrets/Webhooks passaram 6/6; o worker agora também usa a cadeia
  tamper-evident para jobs de auditoria, secrets e webhooks. API e worker usam lock Redis
  tenant-scoped no perfil distribuído para coordenar o trecho leitura/hash/append, com renovação
  periódica da lease; o harness Redis agora cobre exclusão mútua, renovação observável e perda
  forçada de ownership com falha fechada. O drill distribuído externo ainda é necessário para
  certificar failover e expiração de leases.
- A verificação tamper-evident está disponível em `GET /api/v1/organizations/:organizationId/audit/verify`
  com permissão `audit.read`, contexto de execução e evento `AUDIT_VERIFIED`; o SDK expõe
  `operations.verifyAudit`. Operations passou 4/4 e SDK 21/21, incluindo negação cross-tenant.
- Diagnósticos de verificação agora têm limite de 50 erros por resposta; o teste de stream corrompido
  grande confirma o limite sem perder `valid`/`checked`.
- O cliente MCP agora expõe reconexão lazy por organização/servidor: fecha transporte HTTP/stdio
  quebrado sem repetir tool potencialmente não idempotente, preserva o cache de descoberta e cria
  transporte novo na próxima operação. A API expõe `POST /mcp/servers/:organizationId/:serverId/reconnect`
  e o SDK acompanha o contrato; teste HTTP passou 3/3, SDK 21/21 e os guias EN/PT-BR documentam
  o procedimento. O CLI agora expõe `handstack mcp reconnect --server <server-id>` com teste
  HTTP autenticado; E2E externo/deployment ainda pendente.
- O contrato publicado foi regenerado a partir dos controllers: `docs/api/openapi.json` agora
  contém as rotas de verificação/reconexão MCP e 205 caminhos; o `openapi:validate` permanece verde.
- Os guias EN/PT-BR de Operations documentam `audit/verify`, a permissão `audit.read`, o evento
  `AUDIT_VERIFIED` e o formato da resposta; documentação validada com 122 artigos localizados.
- `SCOPE-AUDIT.md` foi reconciliado com a auditoria programática atual: 205 caminhos OpenAPI,
  15 lacunas funcionais/cobertura e 6 certificações externas, mantendo o estado `PARTIAL`.
- O runtime de capabilities agora aplica consentimento tenant-scoped quando o descritor declara
  `metadata.consentPurposeId`: usa o consentimento mais recente do principal e falha fechado após
  retirada. O teste HTTP cobre autorização e retirada; os adaptadores externos de privacidade e o
  E2E em produção continuam pendentes.
- O propagador de deleção de privacidade agora converte falhas de adapters externos em evidência
  retryable `deleted: false`, sem serializar mensagens potencialmente sensíveis; o job permanece
  parcial em vez de desaparecer por exceção.
- O pacote `@handstack/privacy` agora inclui `RedisSubjectCache`, com índice explícito por tenant e
  titular, purge determinístico e teste de isolamento entre organizações. No perfil distribuído,
  a API reutiliza o client Redis do Event Bus e compõe o purge com o cache MCP; a integração real
  segue aguardando Redis disponível nesta máquina. O pacote também inclui tombstones para backup
  externo via store injetada; no perfil distribuído a API compõe o tombstone do repositório com o
  store Redis compartilhado. O drill real de restauração continua externo.
- O `RedisSubjectCache` mantém ownership explícito por chave e remove índices antigos quando uma
  chave é reutilizada por outro titular; a regressão cobre esse caso de isolamento.
- O adaptador Redis compartilhado do API agora expõe também `srem`, fechando o contrato do cache
  distribuído. Typecheck, lint, testes focais e os gates locais do preflight passaram; a
  certificação externa continua pendente por Redis/containers, provedores reais e drills autorizados.
- Consultas autenticadas de audit agora geram `AUDIT_QUERIED` depois de materializar a resposta,
  preservando a consulta atual sem auto-inclusão e carregando request/trace/principal no evento;
  o contrato HTTP passou 5/5, com typecheck e lint do API aprovados.
- O pacote de audit agora oferece `FormattedSiemExporter` para JSON Lines, CEF e syslog RFC 5424,
  com redaction case-insensitive e escaping específico de cada formato; 17 testes do pacote,
  typecheck, lint e formatação passaram.
- O scheduler opt-in de integridade de audit verifica a cadeia tamper-evident por tenant, registra
  `AUDIT_VERIFIED` como ator de sistema e coordena réplicas por lease persistente; a configuração
  `auditIntegrity` foi propagada para `.env`, Compose, Kubernetes e Helm. O teste focal passou 2/2.
- O pacote de audit agora expõe `WormAuditExporter` e `WormAuditStore.putIfAbsent` para arquivos
  tenant-scoped imutáveis, com redaction e rejeição de exportações cross-tenant; a suíte focal
  passou 19/19.
- `handstack config validate` agora informa o estado seguro do scheduler `auditIntegrity` (sem
  expor IDs ou segredos); o contrato focal do CLI passou 2/2, com typecheck e lint aprovados.
- O SDK agora publica e tipa o corpo de execução do Chat Workspace, incluindo seleção de Agent,
  base de Knowledge, mensagem pai e trace; a regressão de contrato cobre o import público e o
  envio desses campos sem alterar a rota ou os headers de idempotência.
- O CLI agora valida `export -o <manifest>` antes de consultar a API, evitando requisições
  desnecessárias quando o caminho de saída está ausente; a regressão confirma falha imediata.
- O `handstack apply` agora exige `metadata.name` em todos os recursos, alinhando o contrato ao
  formato Configuration as Code da especificação e falhando antes da primeira requisição quando
  o manifesto é ambíguo.
- O `handstack apply` também rejeita duplicatas de `kind` + `metadata.name` antes de qualquer
  requisição, evitando efeitos parciais em manifests não idempotentes.
- O coletor de preflight agora registra no manifesto um snapshot sanitizado da disponibilidade do
  Docker e da presença de URL de teste do Redis, sem incluir endpoints ou segredos; isso torna o
  motivo de drills externos não executados verificável no pacote de evidências.
- `apps/web/package.json` agora declara `@handstack/config` e o `package-lock.json` foi
  sincronizado pelo npm; o launcher de `dev/start` está coberto pelo lint da aplicação e scripts,
  typecheck e `tests/routes.test.tsx` (8/8). A configuração ESLint desativa apenas as regras
  type-aware para o `.mjs` e mantém as regras de ambiente Node.
- Auditoria viva reexecutada: `PARTIAL`, 160 seções normativas, 105 requisitos catalogados
  `verified`, 15 lacunas funcionais/cobertura e 6 certificações externas pendentes; OpenAPI atual
  com 205 caminhos, nenhum handler/fila ou rota administrativa/ajuda faltante. Docker/Redis local
  agora estão disponíveis para conformance; não há bloqueio técnico local para incrementos offline.
- Configuração de deployment do worker agora é tipada em `config.worker` (`apiUrl`, organização,
  fila e módulo de handlers); `parseWorkerOptions` e o carregador de handlers consomem o layer
  comum, preservando o override explícito de fila da CLI. Configuração 13/13 e worker 23/23 testes
  focais passaram, com typecheck e lint do worker aprovados.
- A configuração de cliente do CLI agora é `config.cli`; `apply`, `export`, `admin`, `audit` e
  `backup/restore` resolvem URL, organização, token e chave portátil pelo mesmo layer tipado, e
  `config validate` expõe apenas flags de presença. CLI: 10 testes focais, typecheck e lint passaram;
  os guias EN/PT-BR documentam o contrato sem aceitar segredos em argumentos.
- `HANDSTACK_MASTER_KEY` agora é resolvida como `config.security.masterKey`; Secrets, Webhooks e o
  worker de entrega decodificam a chave a partir da configuração, sem consumidores de produção
  chamarem `MasterKey.fromEnvironment` diretamente. Configuração 13/13, API 5/5 e worker 11/11
  focais passaram, com typecheck e lint de API/worker aprovados.
- O dispatcher de Webhooks agora recebe `retention.audit` como retenção padrão, eliminando o
  default fixo de 30 dias quando a política global estiver configurada; o teste focal de Webhooks
  passou 3/3, com typecheck e lint da API aprovados.
- O coletor de preflight agora gera `README.md` junto do manifesto e logs, com comando exato de
  reprodução (incluindo `--include-contracts`), status `NOT_CERTIFIED` e checklist dos seis pacotes
  externos. O pacote foi regenerado com 19/19 gates locais aprovados, incluindo `npm audit` sem
  vulnerabilidades de produção.
- `HANDSTACK_WEB_PORT` agora é consumido pelos scripts `dev`/`start` do Next através do mesmo
  `configLayerFromEnvironment`; o default continua 3000 e `PORT` é propagado ao processo filho.
  Web: 8 testes focais, typecheck e lint passaram.
- O scheduler de retenção tenant-scoped agora aciona também `WebhookRuntimeService.prune` sob o
  mesmo lease persistente das retenções de privacidade; a poda usa `retention.audit` e não cria uma
  segunda concorrência por organização. API: 8/8 testes focais combinados, typecheck e lint passaram.
- Primeiro incremento desta retomada: SDK agora expõe as operações tenant-scoped disponíveis de
  Knowledge (bases, documentos, ingestão, sync, busca e reindexação), Privacy (retenção, holds e
  subject requests), MCP, Plugins, Secrets e Workflows. SDK: 11 testes, typecheck, lint e build
  passaram.
- CLI: 24 testes passaram, incluindo E2E em processo real de `init`, `apply`, `export`, `config sync`,
  `migrate`, `doctor`, backup assinado e restore SQLite. Docker está indisponível nesta máquina,
  portanto drills que dependem de containers permanecem sem revalidação nesta rodada.
- `handstack audit verify-export` agora valida manifesto, tenant, SHA-256, contagem, extremos e
  head hash; conteúdo adulterado falha fechado. Audit: 8/8; CLI: 24/24; database: 15/15 testes.
- O CLI agora oferece `handstack config validate`, que valida a configuração efetiva e emite apenas
  um resumo não sensível; a superfície local de Configuration as Code passa a ter preflight explícito.
- Os controles operacionais do scheduler de privacidade (`enabled`, intervalo, organizações e
  instance ID) agora fazem parte do schema/config layer e são consumidos pelo serviço, em vez de
  serem lidos fora da hierarquia de configuração; o guia EN/PT-BR e `config validate` refletem o
  contrato.
- Os controles dos schedulers de Knowledge e Workflows agora seguem o mesmo layer tipado, incluindo
  habilitação, intervalo, allow-list, instance ID e principal de workflow; os defaults e o resumo
  seguro do `config validate` estão alinhados ao `.env.example`.
- Os limites operacionais do worker (`concurrency`, timeout explícito, heartbeat, tentativas, jitter
  e métricas) agora também são validados pelo schema e consumidos por `parseWorkerOptions`; o guia
  de jobs e o resumo seguro da CLI documentam o contrato.
- A referência de credencial do vector store configurado agora é parte de `config.vectorStore` e
  chega ao broker de segredos tenant-scoped; o consumidor não lê mais essa referência diretamente
  do ambiente, e a CLI só informa se ela está configurada.
- O caminho e o limite de anexos agora são parâmetros tipados (`attachments.storagePath` e
  `attachments.maxBytes`), consumidos pelo storage local e pelo Chat; upload, assinatura, exclusão
  e retenção HTTP passaram novamente após a mudança.
- A allow-list de hosts de Webhooks agora é `config.webhooks.allowedHosts`, com parsing deduplicado
  e consumo uniforme pela API e pelo worker; a CLI informa somente a contagem configurada.
- A allow-list de hosts remotos do Knowledge agora é `config.knowledge.allowedHosts` e é injetada
  no guard comum dos conectores URL/autenticados, mantendo as verificações DNS/SSRF.
- O bootstrap da API agora consome `logging.level` e `telemetry.otlpEndpoint` do config resolvido;
  o endpoint OTLP é validado sem ser exposto pelo `config validate`, e o opt-in de privacidade de
  telemetria continua obrigatório.
- O `HANDSTACK_REDIS_NAT_MAP` agora é validado em `queue.natMap` e compartilhado por Operations e
  workers Sentinel; a CLI expõe apenas sua presença e a regressão cobre a conexão resultante.
- O runtime de plugins agora consome `plugins.cacheDir`, `isolationRequired` e `trustedPublishers`
  do config resolvido; a CLI expõe somente presença, modo e contagem, sem imprimir chaves.
- A autenticação API→worker agora usa `security.internalServiceToken` no config resolvido e um
  autenticador comum para Workflows e Knowledge; o resumo da CLI informa apenas sua presença.
- Os handlers distribuídos de Workflows, Knowledge, Agents, Plugins e Documents também resolvem o
  token pelo parser tipado, mantendo a validação de comprimento e sem duplicar leitura de ambiente.
- O handler de Embeddings também usa `security.internalApiKey`; a CLI informa apenas a presença de
  cada credencial interna, sem emitir material secreto.
- Gateway, SCIM e OIDC agora consomem `security.gatewayKeyPepper`, `scimTokenPepper` e
  `oidcStatePepper`; o contrato preserva fallback somente fora de produção e falha fechado em produção.
- Auth de sessão, assinatura de anexos e migração de segredo legado de Webhooks agora consomem
  `security.accessTokenSecret`, `tokenPepper`, `attachmentSigningSecret` e `webhookLegacyMasterKey`.
- A matriz de certificação agora explicita a próxima ação, owner mínimo e diretório de evidência para
  cada um dos seis gates externos; todos permanecem `PENDENTE` até haver ambiente autorizado.
- O preflight foi reexecutado com `--include-contracts`: os nove gates base e os dez validadores
  adicionais de DR, resiliência, containers, segurança, observabilidade, integração, Helm,
  Kubernetes e frontend passaram.
- A última leitura direta de `HANDSTACK_WEBHOOK_MASTER_KEY` no worker foi removida; o provider de
  migração agora recebe `security.webhookLegacyMasterKey` pelo parser tipado.
- Criado `npm run certification:preflight`, que coleta os gates locais em logs separados e gera
  manifesto redigido com estado explícito `NOT_CERTIFIED` para os seis gates externos.
- Pacote executado em `artifacts/certification/local-2026-09-29/`: os 19 gates locais passaram;
  o manifesto registra o worktree sujo e
  certificação externa ainda não promovida.
- O E2E Web agora cobre a jornada administrativa de Agents (criar, versionar e publicar), verifica
  acessibilidade inicial com axe e valida a mensagem recuperável de indisponibilidade da API; 6/6
  casos passaram em Chromium, Firefox e WebKit.
- O E2E Web também cobre Workflows: criação de draft, publicação, acessibilidade inicial e erro
  recuperável de API; 6/6 casos passaram nos três navegadores. A execução distribuída continua
  explicitamente pendente para o worker.
- O exemplo oficial do SDK para `agents.run({ repository })` agora funciona: a API aceita `prompt`
  ou `repository`, e o SDK tipa ambas as formas; teste HTTP e teste do SDK cobrem o contrato.
- Contexto de execução de workflows agora atravessa o worker assíncrono até cada nó, preservando
  `requestId`, `traceId` e `source`; teste focal do runtime cobre a propagação.
- Event Bus agora recebe eventos sanitizados de Notifications, Webhooks, Incidents e Audit, usando
  a mesma seleção compacta/distribuída da API; typecheck, lint e testes focais passaram.
- Os eventos HTTP de Notifications, Incidents e Webhooks agora preservam `requestId`, `traceId`,
  `principalId` e `source: API`; 9 testes focais da API passaram, incluindo a verificação do contexto.
- Jobs duráveis agora carregam a proveniência opcional até `JobContext`, incluindo filas em memória,
  transporte BullMQ e worker; Operations, Knowledge reindex e Workflows passam esse contexto ao
  enfileirar. Jobs: 27 testes focais passaram.
- Os handlers de worker agora repassam `requestId` e `traceId` nas chamadas HTTP internas à API,
  preservando a correlação além da fronteira BullMQ sem transformar headers de diagnóstico em
  autoridade de identidade. Teste focal dos handlers cobre Agent, Embedding, Document, Workflow,
  Plugin e Knowledge reindex.
- O scheduler opt-in de privacidade agora executa conversas, usage e anexos sob a mesma lease
  tenant-scoped; a regressão focal confirma a ordem e o ator de sistema compartilhado.
- O handler de Workflow também reconstrói o contexto no payload interno quando a proveniência
  existe apenas no envelope durável do job; isso evita perder contexto entre BullMQ e a API interna.
- O SDK agora cobre também auditoria, feature flags, enqueue de jobs e operações de DLQ do domínio
  Operations, com contrato de URLs, métodos HTTP e encoding tenant-scoped.
- O SDK também expõe credenciais por usuário e os endpoints de início/conclusão OAuth do MCP;
  isso fecha a superfície de contrato local, sem alegar E2E com provedor OAuth externo.
- Auditoria agora preserva `requestId`, `traceId`, `principalId` e `source` no evento `audit.recorded`
  e no registro persistido; retry/discard de DLQ passam esse contexto HTTP explicitamente.
- Gate global mais recente: `npm test` passou com 105/105 tarefas; a API passou 145 testes e deixou
  7 testes opcionais ignorados. Os testes externos continuam fora da certificação por dependerem de
  Docker, provedores e ambientes de produção.
- O handler de auditoria do worker agora reconstrói `traceId` e metadados limitados de
  `requestId`/`principalId`/`source` a partir do contexto durável do job; o teste focal confirma que
  a proveniência é preservada sem aceitar campos de autoridade.
- A fila `billing` agora grava o `traceId` do `JobContext` em `UsageRecord` e `CostRecord` na
  liquidação; budgets (3 testes), worker (22 testes), typecheck e lint dos dois workspaces passaram.
- A matriz de rastreabilidade das 160 seções foi acrescentada ao `docs/requirements/traceability.md`
  em 17 famílias contíguas, ligando cada família ao catálogo canônico, código, contratos, testes e
  documentação; `docs:validate` continua aprovado.
- Os contratos locais de resiliência, DR, container, observabilidade, integração, Helm, Kubernetes,
  release, frontend e OpenAPI foram revalidados nesta rodada; todos passaram, incluindo 203 caminhos
  OpenAPI. Isso fortalece a preparação dos seis gates externos, mas não os promove a certificação.
- Os namespaces configuráveis de Redis deixaram de ser declarativos: `rateLimit` é usado pelo
  ChatRateLimitService e `cache` pelo cache tenant-scoped de discovery MCP; testes MCP, rate limit,
  HTTP de MCP, configuração, typecheck, lint e build dos consumidores passaram.
- `retention.trace` agora tem executor tenant-scoped: remove somente a correlação expirada das
  mensagens, preserva o conteúdo, respeita legal holds, grava evidência e é executado pelo scheduler;
  API, UI e teste HTTP cobrem o fluxo. Retenção do audit append-only continua deliberadamente
  pendente até existir política de arquivamento compatível.
- O SDK também expõe `privacy.runTraceRetention`, mantendo a superfície de retenção alinhada à API;
  o contrato de URL e método HTTP foi coberto na suíte focal do SDK.
- SDK ampliado com namespaces tenant-scoped de Notifications, Incidents, Operations, Settings,
  Gateway API Keys, Webhooks, Chat Workspace, Access, Directory/RBAC, Budgets, Policies,
  Service Accounts e Routing; também cobre settings de database; suíte focal agora tem 17 testes e
  typecheck, lint e
  build aprovados.
- A cobertura de Privacy do SDK foi completada para inventory, purposes, consents, processors,
  incidents, residency, deletion evidence e todo o ciclo de subject requests; suíte focal agora tem
  18 testes e passou com typecheck, lint e build.
- O SDK agora cobre também o ciclo administrativo de Models/Providers, prompts e versões,
  datasets/suites de avaliação, runs, gates, aprovação/publicação, overrides e campanhas Red-Team;
  suíte focal agora tem 19 testes e passou com typecheck, lint e build.
- O SDK agora cobre também administração de identidade/IdP e credenciais SCIM; suíte focal agora
  tem 20 testes e passou com typecheck e lint.
- Chat Workspace do SDK também suporta upload multipart, URL assinada e remoção de anexos; suíte
  focal agora tem 16 testes.
- Criada a matriz [CERTIFICATION-READINESS.md](CERTIFICATION-READINESS.md), com os seis gates
  externos, pré-requisitos, evidências e critérios de aprovação; todos permanecem `PENDENTE`.
- Gates globais desta rodada: `format:check`, `docs:validate`, `lint`, `typecheck`, `test`, `build` e
  `openapi:validate` passaram. Foram 108/108 tarefas de typecheck, 108/108 de lint, 105/105 de
  testes (145 aprovados, 7 opcionais ignorados) e 63/63 de build; OpenAPI validou 203 caminhos.
- Próximo passo: fechar E2Es funcionais locais que ainda tenham implementação possível e preparar as
  seis certificações externas; o escopo global continua `PARTIAL` até haver ambiente implantado,
  providers autorizados e revisão de segurança.

## Estado anterior — revalidação (2026-09-18)

- Revalidados nesta retomada os contratos offline de resiliência, DR, container, observabilidade,
  integrações, frontend, release, Helm e Kubernetes; todos passaram. Esses gates validam contratos
  locais, não execução de certificação em ambiente implantado. Os seis drills externos continuam
  dependentes dos pré-requisitos objetivos listados em `SCOPE-AUDIT.md`.
- Scheduler Knowledge: lease persistente CAS por tenant agora arbitra duas instâncias e permite
  handoff após liberação; o teste SQLite passou (4 testes de scheduler). Compose, Kubernetes e Helm
  expõem enable/interval/allow-list desativado por padrão; Helm/release/Kubernetes/Compose e docs
  passaram. O E2E S3/MinIO da API agora executa pelo scheduler real e confirma ingestão, audit event e
  lease liberada. O failover em deployment continua pendente.
- Privacy retention: usage records agora têm execução tenant-scoped autenticada em
  `/privacy/retention/usage/run`, usando `retention.usage` ou política `usage-records`, legal holds,
  exclusão CAS e evidência por registro/deletion job. O teste HTTP cobre isolamento de tenant e a UI
  `/privacy` expõe a ação; retenção de audit, trace e anexos ainda não está ligada a executores.
- MCP: o teste HTTP integra a API com uma instância real do pacote `McpServer` via loopback,
  sem servidor JSON-RPC simulado. Ele cobre ferramenta não publicada/publicada, discovery e
  hidratação persistidas, e invocação pelo engine governado preservando principal remoto. A prova
  segue local: servidor externo/deployado, OAuth por usuário e reconexão operacional permanecem
  pendentes; a evidência não altera status de requisito.
- Knowledge S3: testes opt-in passaram contra MinIO local; o E2E da API gravou credencial criptografada
  no vault, resolveu a referência tenant-scoped, leu objeto real, ingeriu conteúdo no índice e
  confirmou auditoria de acesso; o teste de pacote confirmou conteúdo e ETag. API e pacote Knowledge
  passaram typecheck/lint/build sob Node 24; a suíte Knowledge passou (21 testes, 5 integrações
  externas não configuradas foram ignoradas) e os testes S3 do pacote e da API passaram. Os containers
  temporários foram removidos sem volume/rede; os demais conectores e o scheduler implantado seguem
  pendentes. `HS-AI-015` agora referencia os dois testes e os módulos de vault/auditoria, sem mudança
  de status. O lockfile foi reconciliado com os manifests via npm 11; instalação lock-only auditou
  937 pacotes e reportou zero vulnerabilidades.
- Atualização da auditoria viva: 160 seções verificadas contra o escopo, status global `PARTIAL`,
  105 requisitos `verified`, 200 caminhos OpenAPI e documentação validada com 122 artigos,
  105 requisitos e 33 destinos de ajuda contextual. A auditoria encontrou as rotas da UI
  administrativa sem lacunas de navegação; isso confirma a existência das páginas, mas não a
  completude de todos os fluxos descritos na especificação.
- A governança de documentação agora valida também as 33 rotas do contextual-help contra o App Router
  Web, além das superfícies e dos IDs de artigos localizados; o teste do docs-engine cobre essa contagem.
- A verificação de hash-chain da auditoria agora ancora intervalos parciais no evento anterior e detecta
  saltos de sequência; o pacote `@handstack/audit` passou 7 testes, typecheck, lint e build.
- Entregas de Webhook executadas pelo worker agora levam o contexto limitado do job para os eventos de
  auditoria (`requestId`, `traceId`, `principalId`, `source`), sem incluí-lo no payload externo; webhooks
  passou 19 testes e o worker 22 testes focais.
- O manifesto de release agora referencia `npm audit` no scan de dependências, alinhado ao gerenciador
  oficial do projeto; `release:validate` passou e os gates externos continuam sem promoção.
- `handstack audit export` agora gera manifesto sidecar verificável (`audit.ndjson.manifest.json`) com
  tenant, contagem, head hash e SHA-256 do conteúdo exportado; audit e CLI cobrem o contrato.
- O CLI também oferece `audit verify-export`, validando hash, contagem, IDs extremos e isolamento
  tenant-scoped antes de anexar o pacote de evidências.
- MongoDB Atlas Vector Search passou em integração real com Atlas Local; Pinecone real e validação
  em Atlas gerenciado seguem pendentes. Container, volumes e imagem criados para o teste foram
  removidos; os dois volumes Docker restantes são anteriores a esta execução e foram preservados.
- Redis Streams agora recupera eventos pendentes após queda de consumer via `XAUTOCLAIM`, aplica
  limite configurável de idle e reconhece mensagens na origem depois de gravá-las na DLQ. Os testes
  unitários e as integrações reais Core/API com Redis 7.4 passaram, inclusive recuperação após crash;
  o Redis temporário foi encerrado e removido.
- Jobs duráveis de reindexação Knowledge agora têm E2E distribuído API→Redis 7.4→BullMQ worker→API
  interna autenticada; o modelo só é publicado após sucesso e o teste usa embedding mockado. API e
  worker passaram typecheck/lint e a documentação foi validada. O container temporário foi removido;
  os dois volumes órfãos observados já existiam antes desta execução e foram preservados.
- O timeout da fila `indexing` foi corrigido para usar `timeouts.workflow` tanto no produtor da API
  quanto no worker, mantendo `timeouts.provider` para `embeddings`. Testes focalizados da API (3) e
  worker (11), typecheck e lint de ambos passaram.
- Workflows publicados com trigger `event` agora restauram subscriptions no startup e consomem
  eventos por Event Bus/Redis Streams, criando jobs tenant-scoped idempotentes e preservando a
  proveniência validada. Testes cobrem isolamento de organização, restart e Redis 7.4 real (15/15
  nesta execução); o container temporário foi removido e nenhuma evidência foi promovida.
- O delivery SMTP agora recebe Database/Auth/Secrets explicitamente pelo container Nest e resolve
  `HANDSTACK_SMTP_PASSWORD_REF` sob demanda pelo broker, com teste de runtime Nest e verificação do
  transporte. API typecheck/lint, docs e OpenAPI passaram; providers SMTP externos e secret managers
  continuam sem certificação real.
- Webhooks de notificações agora usam `timeouts.http` do runtime de configuração em vez de um
  timeout fixo; o transporte aceita todo o intervalo suportado pelo schema global. Regressão API
  verifica cancelamento no prazo configurado e os seis testes do pacote Notifications passaram.
- Cleanup worker: corrigida a allow-list para `conversation-stream-events`, nome canônico do
  repositório, e rejeitados nomes legados inexistentes. Anexos seguem fora do cleanup genérico para
  não apagar metadados sem remover os blobs. Teste focal (9), typecheck e lint do worker passaram;
  retenção automática e limpeza de blobs seguem pendentes.
- Configuração: `resolveForOrganization` agora inclui a camada persistida de settings globais entre
  arquivo e settings da organização, em conformidade com a precedência documentada. O teste HTTP de
  Settings verifica herança de `timeouts.http` global e o override específico; 3 testes, typecheck e
  lint do API passaram. Demais parâmetros ainda estão sob auditoria e não foram promovidos.
- Retenção: novo `POST /api/v1/organizations/{organizationId}/privacy/retention/run` executa limpeza
  tenant-scoped usando política `conversations` ou `retention.conversation`, protege holds no root e
  nos registros filhos, usa a cascata do Chat (incluindo storage local) e gera evidência consultável.
  Cada execução concluída agora também consta como deletion job com contagem de evidências; eventos
  Chat registram o principal da execução manual ou o ator `system:privacy-retention-scheduler`.
  O teste HTTP confirmou uma conversa excluída e outra retida por hold, o ator auditável e a
  precedência de retenção global/tenant; junto aos testes de scheduler, 7 testes focados passaram.
  Nesta revalidação, API typecheck/lint/build também passaram. OpenAPI (200 paths) e docs (122
  artigos/105 requisitos/33 alvos) já constavam válidos na revalidação atual.
  O scheduler opt-in descobre organizações ativas, adquire lease CAS persistido por tenant, atualiza
  a descoberta a cada tick e usa intervalo padrão de 24h; testes confirmam startup habilitado,
  descoberta e exclusão concorrente entre duas instâncias. Configuração foi exposta em Compose,
  Kubernetes e Helm, desabilitada por padrão; validadores de chart/manifests/release passaram. Retenção
  das classes audit/usage/trace/attachments continua pendente.
- A tela `/privacy` agora oferece gestão tenant-scoped de políticas de retenção e legal holds, com
  execução manual confirmada e resultado resumido. Testes Web verificam salvar política, criar/liberar
  hold, confirmação/cancelamento da execução, acessibilidade da entrada e não persistência do token;
  a suíte Web completa passou (25 testes), e typecheck, lint e build também passaram. A trilha não
  altera o status global `PARTIAL`.

- Estado: implementação parcial; auditoria de aderência ao escopo completo em andamento.
- Catálogo: 105 entradas; os status do catálogo cobrem contratos e módulos, mas não equivalem à
  conclusão da superfície funcional inteira da especificação. A auditoria de escopo permanece aberta.
- Rastreabilidade: a matriz agora contém os 105 IDs do catálogo, e `docs:validate` rejeita IDs
  ausentes, duplicados ou desconhecidos na matriz.
- Lacunas explícitas da especificação: 21 itens ainda sem evidência executável suficiente — 15
  lacunas funcionais/cobertura em áreas como persistência, identidade, agents, knowledge, MCP,
  plugins, workflows, secrets, privacidade, CLI e Event Bus; além de seis certificações de
  produção/segurança: HA/failover e backup/restore, DR multi-zona/multi-região, capacidade,
  upgrade/rollback, E2E de providers externos e penetration test/threat-model review.
- Evidência viva: Node v26.7.0 (fora do engine declarado), npm 11.19.0 e Docker 29.8.0 executáveis; o CI permanece fixado para Node 22/24.
- Gates de código e conformance foram executados para os módulos existentes; telas presentes e
  testes de módulos individuais ainda não comprovam todos os fluxos e certificações da especificação.
- Contrato: `docs/api/openapi.json` gerado automaticamente por `npm run openapi:generate` e validado por `npm run openapi:validate`.
- Repositório: Git inicializado na raiz; npm é o gerenciador padrão com `package-lock.json`, workspaces npm e CI migrada para `npm ci`.
- Bloqueios: não há bloqueio técnico para continuar; a pendência é de implementação de escopo.
- CI: o job de qualidade executa auditoria de escopo, OpenAPI, documentação, Helm, Kubernetes,
  release, resiliência, observabilidade e frontend; há conformance Redis Streams dedicada e os
  jobs de banco/Redis removem containers mesmo em falha; a integração API→Redis→worker também é gate.
- SIEM: a especificação exige o contrato de exportação auditável, não uma instalação de SIEM externo.
- Última revalidação: `npm test --silent` passou com `exit=0`; a auditoria atual reporta 195
  caminhos OpenAPI e 105 requisitos catalogados como `verified`, mantendo o escopo global como
  `PARTIAL`.
- Chat Workspace: o agent switch agora resolve as permissões efetivas do principal por roles
  tenant-scoped antes de executar o agente; teste HTTP do Chat e suíte Web passaram após a mudança.
- Integração distribuída revalidada com Redis 7.4: API publicou e worker BullMQ consumiu o job;
  o container e o volume temporários foram removidos e a inspeção final ficou vazia.
- As rotas públicas REST/stream de Agents e o endpoint MCP passaram a calcular permissões efetivas
  por RBAC tenant-scoped, rejeitando tentativa de elevação via payload; testes HTTP dedicados passaram.
- O SDK passou a expor `agents.run` e `agents.stream`, com teste de endpoints, bearer auth, payload
  e SSE; cobertura completa de domínios e E2E do CLI ainda permanecem pendentes.
- Plugins `LOCAL` trusted agora suportam upgrade administrativo somente para versão crescente, com
  revalidação de checksum e lifecycle pelo `PluginHost`; NPM/GitHub usam cache pré-provisionado,
  checksum obrigatório e runner isolado por processo. Integração operacional completa ainda é
  pendente.
- Knowledge possui scheduler opt-in por organizações explícitas; falta E2E contra provedores
  externos e descoberta automática de tenants do Knowledge.
- O scheduler de workflows aceita allow-list explícita ou descobre organizações ativas pelo
  adapter de banco com paginação cursor-based; os nós Agent, Capability e MCP recebem as permissões
  RBAC efetivas do principal; ainda falta coordenação distribuída de ownership.
- Agents publicados com canal `MCP` agora aparecem como ferramentas `agent.<slug>` no JSON-RPC MCP,
  com filtro por `agents.execute` e execução governada; o canal `AGENT_TOOL` e E2E externo ainda faltam.
- Knowledge agora possui conectores Bearer tenant-scoped para Google Drive, SharePoint, Confluence
  e Notion, resolvendo tokens somente por referência ao vault; Confluence e Notion normalizam a
  resposta das APIs antes da indexação. S3, assinatura AWS e descoberta automática de tenants
  continua pendente a validação E2E dos provedores; 15 testes do pacote Knowledge passaram.
- O `S3StorageProvider` agora aceita `S3Client` real injetável, prefixa chaves por organização,
  implementa put/get/delete/head e gera presigned GET URLs. R2 e GCS usam o mesmo caminho
  S3-compatible com endpoint/provider scheme injetável. Azure Blob agora aceita `BlobServiceClient`
  real injetável, prefixa blobs por organização e gera SAS URLs.
- Limpeza final desta rodada: `containers=0 volumes=0` no Docker.
- A integração distribuída da API foi corrigida para injetar explicitamente `DatabaseService` e
  `AuditRuntimeService`; com Redis 7.4 real, um job publicado por `OperationsRuntimeService` foi
  consumido por um worker BullMQ separado. Typecheck e lint da API passaram após a correção.
- O Web foi compilado e servido localmente em modo de produção; `/settings` respondeu HTTP 200
  com HTML da tela, confirmando que a rota não existe apenas como arquivo-fonte.
- A API foi executada com MongoDB 8 em replica set real, sem SQL; health, replication health e
  persistência/releitura de configurações tenant-scoped passaram. O cenário foi incluído no CI.
- O drill local de failover MongoDB passou com três nós: uma gravação foi confirmada antes da queda
  do primary, uma réplica foi promovida automaticamente e uma nova gravação foi confirmada após a
  reconexão. Certificação de produção e backup/restore permanecem pendentes.
- A suíte Playwright real passou em Chromium, Firefox e WebKit a 360x800, com teclado, axe e
  regressão visual; os snapshots foram atualizados para refletir o campo Knowledge base existente.
  Isso cobre a suíte atual, mas não a certificação dos releases estáveis exigida pelo DoD.
- O runtime BullMQ passou a respeitar a topologia Redis configurada: Sentinel usa seus sentinels e
  master name, e Cluster usa seeds ioredis; o parsing Sentinel foi testado.
- O readiness probe também corrige a normalização dos esquemas Sentinel/Cluster; os 3 testes do
  `TcpRedisProbe` passaram. Isso não substitui a certificação de quorum e failover com três nós.
- Após configurar `HANDSTACK_REDIS_NAT_MAP`, o E2E BullMQ/Sentinel passou com job publicado e
  consumido pelo master descoberto; o drill de failover também foi executado com sucesso.
- O drill real de failover Redis Sentinel passou com duas réplicas e três Sentinels: o master foi
  parado, uma réplica foi promovida e um novo runtime BullMQ consumiu um job após a recuperação.
- A UI administrativa de Users/Groups/Roles agora interpreta corretamente respostas paginadas da
  API e oferece edição tenant-scoped; o build web passou após a alteração.
- A API administrativa agora também expõe memberships de grupos, atribuição de roles, permissões
  e vínculos role-permission tenant-scoped; o OpenAPI foi regenerado e validado com 163 caminhos.
- A revisão da tela `/agents` confirmou que as 12 abas normativas do Agent Builder já estão
  presentes e persistem prompt, modelo, tools, MCP, Knowledge, memória, guardrails, orçamento,
  permissões, canais de publicação e versões; permanecem pendentes os E2Es de integrações/canais.
- A API agora usa `BullMqJobTransport` no perfil `distributed`, com namespace e organização
  compatíveis com o worker; o modo compacto continua usando o transporte persistente local. O E2E
  API→Redis→worker passou; ainda falta E2E para cada classe, saturação certificada e comprovação
  operacional dos Deployments.
- O E2E API→Redis→worker foi executado com Redis real e passou; também foram corrigidos os nomes de
  filas e `jobId` para obedecer às restrições do BullMQ. Existem handlers concretos para as 9 filas,
  e os handlers que precisam de estado da aplicação usam API interna autenticada, como permitido
  pelo contrato distribuído; a certificação operacional das classes ainda é pendente.
- Histórico detalhado: `HISTORY.md`.

## Auditoria de aderência funcional — 2026-09-14

> Nota de leitura: os itens abaixo são registros históricos de rodadas anteriores. Eles não
> substituem a auditoria viva em `SCOPE-AUDIT.md`; números de caminhos, testes e pendências podem
> estar superados por alterações posteriores. Para o estado atual, use a auditoria viva acima e
> `SCOPE-AUDIT.md`; volumes Docker não atribuídos a esta revisão não são considerados artefatos do
> teste e não foram removidos.

- Verificado novamente: lint, typecheck e build do web/API, geração e validação do OpenAPI aprovados.
  O contrato validado contém 138 caminhos. `docker ps -a --filter name=handstack`
  não retorna containers.
- Administração de configurações existe em `/settings` e em
  `/api/v1/organizations/:organizationId/settings`, com persistência, branding e teste HTTP de
  isolamento entre organizações. Isso cobre a primeira fatia de Settings, não o módulo
  administrativo completo.
- Knowledge/RAG possui CRUD administrativo inicial em `/knowledge`, ingestão, busca, versionamento
  inicial, embeddings/vetores persistentes e contexto opcional no Chat. Ainda faltam conectores de
  fontes, atualização/sincronização de versões e uma experiência administrativa completa.
- A navegação administrativa da especificação ainda não está completa: faltam telas próprias e
  fluxos completos para conexões MCP por usuário, secrets, aprovação/concessão, plugins em runtime,
  Agent Builder e Capability Catalog. Dashboard, MCP, Plugins, pricing/routing e demais páginas
  têm superfícies iniciais, mas isso não equivale ao requisito de UI completo.
- Nesta rodada foram adicionadas as páginas `/mcp` e `/plugins`, incluindo consulta do catálogo de
  plugins. Elas tornam a integração visível, mas não inventam operações de instalação, conexão ou
  aprovação que ainda não possuem API administrativa correspondente.
- Também foi adicionada a gestão persistente de políticas de model routing em
  `/api/v1/organizations/:organizationId/routing-policies` e a tela `/routing`, com validação de
  estratégia, candidatos e isolamento por organização. O contrato OpenAPI foi regenerado e passou
  a 121 caminhos.
- A gestão de pricing foi ampliada com listagem persistente em
  `/api/v1/organizations/:organizationId/pricing/models` e a tela `/pricing`; os gates do pacote de
  budgets, API e web passaram.
- O Dashboard inicial deixou de ser somente estático: agora oferece uma sessão administrativa e
  agrega contagens de uso, budgets, modelos e auditoria pelas APIs tenant-scoped. A interface foi
  validada com lint, typecheck e build.
- Service Accounts/workload identities passaram a ter armazenamento tenant-scoped, emissão,
  listagem sem hash, rotação e revogação pela API, além da tela `/service-accounts`. API e web
  passaram nos gates; o OpenAPI validado agora contém 124 caminhos.
- O MCP Client agora possui registro e listagem tenant-scoped de servidores, com validação básica
  de transporte HTTPS/STDIO, expostos pela API e pela tela `/mcp`. Descoberta de tools/resources,
  credenciais OAuth por usuário e persistência durável ainda precisam ser concluídas; a área
  continua parcial.
- O cadastro de servidores MCP deixou de ser somente em memória: as configurações não secretas são
  persistidas no repositório `mcp-servers` e listadas pelo adapter. Lint da API, build da API e os
  5 testes do pacote MCP Client passaram; o OpenAPI permaneceu válido com 125 caminhos.
- A descoberta MCP foi exposta na API e na tela `/mcp`, com endpoints para executar discovery e
  listar tools descobertas. API/web passaram nos gates; o OpenAPI validado agora contém 127 caminhos.
- O discovery MCP foi ampliado para resources e prompts, com operações HTTP tenant-scoped. API,
  lint e os 5 testes do MCP Client passaram; o OpenAPI validado agora contém 129 caminhos e o
  Docker continua sem containers `handstack`.
- Nesta revalidação, todos os endpoints administrativos de MCP passaram a exigir também `mcp.manage`,
  além de autenticação e isolamento por organização; typecheck e build da API passaram novamente.
- Plugins agora possuem uma superfície administrativa persistida por organização para instalação e
  listagem, com validação de checksum, origem e permissões aprovadas, além da tela `/plugins`.
  O runtime de execução isolada, enable/disable e sandbox ainda não está conectado; a área segue
  parcial. O OpenAPI validado contém 130 caminhos.
- Knowledge/RAG agora expõe ingestão de conteúdo e busca tenant-scoped pela API, usando o runtime
  oficial de embeddings e respeitando `sourceAcl`; o CRUD deixou de descartar esse ACL. API lint e
  build passaram e o OpenAPI validado contém 132 caminhos. O vector store da API ainda é em memória,
  e conectores/versionamento persistente continuam pendentes.
- O vector store da API foi substituído por `RepositoryVectorStore`, persistindo vetores e metadados
  no repositório `knowledge-vectors`, com busca por similaridade, exclusão e atualização de ACL.
  API lint/build, 9 testes do pacote Knowledge e o teste HTTP de Settings passaram; OpenAPI válido
  com 132 caminhos.
- A execução de Chat agora aceita `knowledgeBaseId`, recupera contexto por ACL para o principal
  autenticado e o envia ao provider como contexto governado. O schema OpenAPI reflete o campo;
  API lint/build e os 13 testes do pacote Chat passaram. O vector store persistente e o fluxo Chat
  permanecem dependentes de um modelo de embeddings publicado/configurado.
- O Knowledge/RAG agora possui entidade e repositório `DocumentVersion`, registra a versão inicial
  de cada documento e expõe listagem em `/knowledge/documents/:documentId/versions`. API e 9 testes
  do pacote Knowledge passaram; OpenAPI válido com 133 caminhos. Atualização/sincronização de novas
  versões e conectores externos ainda permanecem pendentes.
- O Chat passou a aceitar opcionalmente `knowledgeBaseId` na interface e na execução, enviando o
  contexto recuperado por ACL ao provider. Web lint/typecheck e 21 testes passaram; o contrato segue
  válido com 133 caminhos.
- O pacote `@handstack/config` agora resolve explicitamente as quatro camadas de precedência da
  especificação, com teste de precedência aprovado. A integração efetiva com carregamento de
  `handstack.config.ts`, settings persistidos e startup ainda é necessária antes de promover
  `HS-CORE-004` para `verified`.
- A API agora carrega `handstack.config.ts` quando presente, usando o runtime TypeScript do projeto,
  e combina esse arquivo com a camada bruta do ambiente antes de inicializar o adapter. O fallback
  sem arquivo continua validado; a leitura de database settings/organization settings na inicialização
  ainda é uma pendência de integração.
- Revalidação desta rodada: OpenAPI válido com 125 caminhos, documentação válida com 105 requisitos,
  API lint/typecheck/build aprovados, configuração com 8 testes aprovados e nenhum container
  `handstack` listado pelo Docker.
- A auditoria permanece aberta. O número de requisitos `verified` não deve ser interpretado como
  entrega integral das 160 seções da especificação.
- Auditoria executável ampla concluída: `npm test` passou com 103 tarefas; API 24 arquivos/56
  testes e web 5 arquivos/21 testes. O teste de identidade havia falhado por expectativa antiga do
  manifesto e foi corrigido para incluir `organizationSettings`. A checagem Docker posterior não
  listou containers `handstack`.
- Revisão adicional do versionamento otimista corrigiu Settings e Service Accounts para incrementar
  `version` em updates; API lint/build, teste HTTP de Settings e os 3 testes de Service Accounts
  passaram.
- Revalidação final desta rodada: `npm test` passou com 103 tarefas (API 25 arquivos/57 testes,
  web 5 arquivos/21 testes); typecheck do monorepo passou com 106 tarefas; typecheck/build da API,
  OpenAPI (138 caminhos) e `docs:validate` (105 requisitos) passaram. Docker respondeu, mas não há
  containers ativos ou parados do projeto.
- Correção adicional: a administração MCP agora exige `mcp.manage` em todas as rotas de configuração
  e discovery. Isso elimina uma lacuna de autorização, mas não fecha o módulo MCP completo.
- Foi adicionada a primeira superfície central de Secrets: `/api/v1/organizations/:organizationId/secrets`
  e `/secrets`, com listagem de metadados, criação, rotação e remoção; valores são selados com
  AES-256-GCM e `HANDSTACK_MASTER_KEY`, e nunca retornados na listagem. A integração automática
  desse vault com todos os providers, MCP e plugins ainda precisa ser concluída.
- A administração de plugins agora também expõe desativação e desinstalação tenant-scoped com
  controle de versão persistente. O enable/upgrade ainda não está conectado a definições executáveis
  e runner isolado; portanto o lifecycle da especificação continua parcial.
- O vault de Secrets recebeu teste HTTP específico cobrindo criação, listagem sem plaintext, rotação
  e remoção; o teste passou junto com o lint da API.
- A tela `/agents` deixou de ser apenas catálogo: agora permite criar agentes, criar versões,
  visualizar versões por agente e publicar uma versão usando as APIs tenant-scoped existentes.
- Conformance real executada com Docker/MongoDB 8 em replica set: `@handstack/database-mongodb`,
  `@handstack/database` portable MongoDB e `@handstack/identity-storage` MongoDB passaram. O
  container temporário foi removido no `finally` e a checagem posterior não encontrou containers
  `handstack`. Isso não substitui a validação dos demais bancos, imagens e Kubernetes.
- Validação de distribuição executada com Docker: `docker compose ... config --quiet` passou e as
  imagens `handstack-api`, `handstack-web` e `handstack-docs` foram construídas localmente com
  sucesso. A atualização das dependências OpenTelemetry reduziu o alerta de produção para 1 high e
  3 moderate: o high permanece no PostCSS transitivo do Next 15 e os moderates incluem Fastify;
  os upgrades sugeridos exigem mudanças breaking de Next/Nest e não foram aplicados sem validação
  dedicada. A checagem pós-build não encontrou containers do projeto.
- Rechecagem após a ampliação de Agents: `npm run lint`, `npm run typecheck` e `npm test` do
  monorepo passaram (106 tarefas de typecheck e 103 de testes; API 25 arquivos/57 testes e web
  5 arquivos/21 testes). A auditoria atual reconciliou o catálogo para 91 requisitos `verified`,
  14 `partial` e nenhum `implemented`; isso não elimina as lacunas de escopo descritas acima.
- O MCP Client agora expõe execução de tool descoberta em
  `POST /mcp/servers/:organizationId/:serverId/tools/:toolName/call`, com autorização `mcp.use`,
  isolamento tenant-scoped e passagem do principal autenticado; o OpenAPI foi regenerado e validado
  com 144 caminhos. Credenciais por usuário agora são vinculadas ao servidor/principal e seladas
  pelo vault central; a autenticação OAuth interativa e headers customizados ainda permanecem
  pendentes.
- O transporte HTTP do MCP foi corrigido para aplicar credenciais `CUSTOM_HEADERS` recuperadas do
  vault; o pacote MCP Client passou a ter 6 testes aprovados. OAuth interativo ainda é pendente.
- Revalidação desta frente: Plugins lint/test passaram (3 testes) e MCP Client lint/test passaram
  (6 testes); OpenAPI continua válido com 141 caminhos e não há containers `handstack` no Docker.
- Access Grants agora têm endpoint de listagem e tela administrativa própria (`/access-grants`),
  completando a superfície de inspeção dos grants temporários já criados pelo fluxo de aprovação.
- A tela `/access-grants` agora também permite revogar grants ativos, com confirmação explícita e
  atualização da lista após a operação; Web lint/typecheck/build passaram e não há containers ativos.
- A tela `/workflows` agora permite criar drafts em JSON e publicar workflows, além de manter a
  inspeção das execuções; Web lint/typecheck/build passaram após essa alteração.
- A tela `/mcp` agora permite armazenar credenciais por usuário e servidor, incluindo Bearer,
  API key, OAuth/OIDC e custom headers; o valor nunca é renderizado após o envio.
- Knowledge/RAG agora expõe `POST .../knowledge/documents/:documentId/sync`, conectando o
  `KnowledgeSyncService` e cursores persistentes para eventos UPSERT, DELETE e PERMISSION_CHANGED,
  com comportamento idempotente por cursor. OpenAPI e documentação foram revalidados.
- Foi adicionado um conector HTTPS inicial para documentos `URL` via
  `POST .../knowledge/documents/:documentId/sync-source`: limita tamanho, rejeita HTTP/redirecionamento,
  calcula digest, evita reingestão sem mudança, cria nova `DocumentVersion` e substitui vetores
  antigos. Conectores autenticados de GitHub/S3/Drive/SharePoint/Notion e sincronização agendada
  pelo worker ainda são pendentes.
- O Agent Builder passou a persistir configuração versionada para MCP servers, Knowledge Bases,
  memória, guardrails, permissões e canais de publicação, além de prompt/modelo/tools/orçamento.
  A execução efetiva de algumas dessas políticas ainda depende das integrações de runtime listadas
  como pendências.
- A política de permissões do Agent Builder agora é aplicada durante a execução: as permissões
  recebidas pelo principal são restringidas à allowlist da versão publicada; teste do harness passou
  (8 testes).
- A administração de plugins agora expõe também `PATCH /api/v1/organizations/:organizationId/plugins/:pluginName/enable`, com estado persistido e versionamento otimista; o runner que executa o setup/hooks do plugin ainda requer integração isolada.
- A tela `/plugins` agora permite operar o lifecycle administrativo de instalações (enable, disable
  e uninstall) pela API tenant-scoped; isso não substitui a execução isolada dos hooks do plugin.
- A API pública de agentes agora expõe `POST /api/v1/agents/{agentId}/run` e
  `POST /api/v1/agents/{agentId}/stream`, resolvendo somente versões publicadas no tenant do token;
  o stream envia eventos SSE e o resultado final. API lint/typecheck passaram e o OpenAPI foi
  regenerado e validado com 146 caminhos. Isso não fecha as políticas ainda não executadas do
  Agent Builder (MCP, Knowledge, memória, guardrails e publicação por todos os canais).
- Rechecagem após as rotas públicas de agentes: os 25 arquivos e 57 testes da API passaram, `git
diff --check` não encontrou erro de whitespace e a checagem Docker continuou sem containers do
  projeto.
- A execução pública de agentes foi endurecida para aceitar UUID ou slug (compatível com o exemplo
  da especificação) e exigir `agents.execute`, mantendo o tenant derivado do token. API lint,
  typecheck e os 25 arquivos/57 testes passaram novamente.
- A Capability API pública prevista na especificação foi adicionada em
  `/api/v1/capabilities`, `/api/v1/capabilities/{slug}` e `/api/v1/capabilities/{slug}/run`, com
  organização e principal derivados do token e autorização `capability.execute`. OpenAPI agora
  valida 149 caminhos; lint/typecheck da API passaram.
- A tela de Agent Builder foi reorganizada em abas funcionais para General, Prompt, Model, Tools,
  MCP, Knowledge, Memory, Guardrails, Budget, Permissions, Publishing e Versions, mantendo o
  rascunho entre abas e as operações de criação/publicação. Web lint/typecheck/build passaram.
- A configuração de `publishChannels` do Agent Builder passou a ser aplicada pelo `AgentHarness`;
  execuções com canal não autorizado falham fechadamente. O teste de agentes agora tem 9 testes
  aprovados, e os typechecks de Agents e API passaram.
- O entrypoint distribuído do worker deixou de concluir jobs silenciosamente com `Promise.resolve()`;
  enquanto os handlers de domínio não forem conectados, ele falha explicitamente para acionar retry
  e dead-letter. Worker lint, typecheck e os 6 testes passaram. A implementação dos handlers por
  classe de fila continua pendente e permanece marcada como não concluída.
- O runtime público de agentes passou a aplicar `knowledgeBaseIds`: consulta as bases permitidas
  com ACL do principal, incorpora apenas as citações retornadas ao prompt e falha fechadamente se o
  runtime Knowledge não estiver disponível. API lint/typecheck passaram; memória, guardrails e
  MCP ainda precisam de integração equivalente.
- O `AgentHarness` passou a executar `GuardrailPipeline` nos estágios INPUT, TOOL e OUTPUT,
  rejeitando resultados que violem o tipo esperado; o runtime HTTP falha fechadamente quando há
  guardrails configurados sem um resolvedor concreto. Agents agora têm 10 testes aprovados e API
  typecheck/lint passaram.
- Foi criada a auditoria consolidada de escopo em `SCOPE-AUDIT.md`, separando aderência funcional
  de existência de contratos/testes e listando as lacunas por área da especificação.
- O loop de tools de agentes agora roteia versões com `mcpServers` por um `AgentMcpExecutor`, e o
  runtime da API descobre o tool apenas nos servidores declarados antes de executar com contexto
  tenant/principal/permissões/sinal de cancelamento. O teste de integração do harness passou; Agents
  agora têm 11 testes aprovados e os typechecks de Agents/API passaram.
- `memoryEnabled` agora é executado pelo harness: carrega as últimas memórias USER do principal e
  persiste o par pergunta/resposta; a API usa `RepositoryMemoryStore` tenant-scoped quando há banco
  e `InMemoryMemoryStore` no modo sem banco. Agents (11 testes), API typecheck/lint passaram.
- A memória recebeu teste explícito de leitura, inclusão no contexto e persistência da nova interação;
  Agents agora têm 12 testes aprovados e lint/typecheck passaram.
- Foram adicionados dois guardrails nativos mínimos (`secret-detection` e `prompt-injection`) ao
  runtime HTTP de agentes, usando o pipeline INPUT/TOOL/OUTPUT; IDs desconhecidos continuam
  falhando fechadamente até serem providos por plugin. API: 25 arquivos/57 testes, lint e typecheck
  passaram nesta revalidação.
- A execução de tools MCP por agentes agora valida também `requiredPermissions` retornado pelo
  servidor antes da chamada; qualquer permissão ausente bloqueia a operação. API lint/typecheck e
  os 12 testes de Agents passaram novamente.
- Revalidação final desta rodada: o conector HTTPS de Knowledge passou a aplicar timeout de 10s
  também durante a leitura do corpo; API lint/typecheck e os 9 testes de Knowledge passaram.
  `openapi:generate`, `openapi:validate` (144 caminhos), `docs:validate`, `npm test`, `npm run
typecheck` e `npm run lint` passaram. O catálogo permanece em 104 `verified` e 1 `implemented`;
  não houve promoção automática porque a auditoria funcional encontrou lacunas de escopo.
- A checagem Docker pós-validação não encontrou containers `handstack`. Permanecem pendentes:
  execução real dos handlers por classe de worker (o entrypoint ainda usa handler vazio), integração
  do lifecycle de plugins com definições/hooks em sandbox, conectores autenticados e agendamento de
  Knowledge, OAuth interativo do MCP e integração das settings persistidas no startup.
- Revalidação ampla em 2026-09-14: typecheck global (106 tarefas), testes globais (103 tarefas), lint
  global (106 tarefas), documentação (120 artigos/105 requisitos), OpenAPI (149 caminhos), Helm,
  release, resiliência, observabilidade, frontend, integração e Graphify passaram. Isso confirma a
  saúde dos contratos e gates automatizados, mas não transforma contratos em implementação funcional.
- Feature flags agora usam repositório persistente quando há banco: escopos global, organização e
  usuário sobrevivem à recriação do runtime e permanecem isolados por tenant. O caso global também
  foi corrigido para não receber identidade de usuário; teste de persistência passou.
- O CLI agora cobre `user create`, `agent list`, `capability list`, `plugin list` e o helper `mcp
serve`, usando API autenticada e organização explícita. CLI: 13 testes, typecheck e lint passaram;
  `init`/`start` e instalação efetiva de plugins permanecem pendentes.
- O worker deixou de iniciar com handler vazio: exige `HANDSTACK_WORKER_HANDLER_MODULE`, valida o
  mapa de handlers e falha antes de consumir a fila quando a classe selecionada não está configurada.
  A seleção foi testada; worker: 7 testes, typecheck e lint passaram. Ainda faltam os módulos de
  domínio concretos para as filas de agents, Knowledge, integrações, webhooks, audit/billing e
  manutenção.
- MCP passou a ter fluxo OAuth authorization-code: state anti-replay vinculado a organização,
  servidor e principal, expiração de 10 minutos, troca HTTPS do código por token e persistência do
  token no vault. MCP client: 7 testes, build e lint; API typecheck passaram. E2E completo e
  publicação MCP continuam pendentes.
- O contrato OAuth do MCP agora rejeita state reutilizado e mantém o token fora da resposta persistida;
  o pacote foi recompilado e os 7 testes passaram novamente. Os endpoints HTTP estão protegidos por
  `mcp.use`, mas ainda falta E2E com um provedor OAuth externo.
- O CLI agora implementa `init` e `start`: cria `handstack.config.ts` sem sobrescrever arquivos e
  inicia o perfil dev propagando falhas. CLI: 15 testes, typecheck e lint passaram; a cobertura
  completa de todos os domínios e E2E permanecem pendentes.
- O CLI também implementa `plugin install --data <json>` com API tenant-scoped; CLI: 16 testes,
  typecheck e lint passaram. Isso cobre o comando, mas a execução real e o sandbox do plugin ainda
  permanecem pendentes.
- Plugins `LOCAL` trusted agora têm execução real: o runtime carrega o entrypoint, valida SHA-256,
  executa o `PluginHost` lifecycle e persiste a instalação por tenant. API: 27 arquivos/59 testes;
  lint passou. NPM/GitHub e modo isolado continuam fail-closed até existir loader verificado/RPC.
- Conformance MongoDB executada com Docker: o Compose agora sobe Mongo com replica set `rs0`; a
  conformance canônica passou 6 checks e Identity Storage MongoDB passou persistência/rollback.
  A stack foi desmontada com volumes e rede; estado final: nenhum container e nenhum volume
  `handstack`.
- OpenAPI foi regenerado após o OAuth MCP: 151 caminhos válidos, incluindo as duas rotas OAuth.
  A suíte global passou com API em 27 arquivos/59 testes; typecheck global segue em 106 tarefas.
- Workflows agora executam nós `Agent`, `Capability`, `LLM` e `MCP` através dos runtimes governados,
  em vez de apenas repassar o input. Também há dispatch tenant-scoped para eventos publicados;
  scheduler persistente e execução distribuída por worker ainda não estão fechados. A API ficou
  com 27 arquivos e 63 testes aprovados.
- Workflows com trigger `schedule` agora têm `triggerConfig.intervalSeconds`, dispatch de janelas
  idempotentes e endpoint operacional de tick; OpenAPI validado com 153 caminhos. O scheduler
  automático exige organizações explicitamente configuradas.
- O processo `WorkflowSchedulerService` agora invoca automaticamente o tick para organizações
  explicitamente configuradas por ambiente, impede sobreposição e encerra o timer no shutdown.
  Descoberta global de tenants e execução por worker distribuído continuam pendentes.
- O worker agora usa o argumento de classe emitido pelos Deployments Helm como fallback para
  `HANDSTACK_WORKER_QUEUE`; isso corrige a seleção de fila no chart, mas ainda exige organização,
  módulo de handlers e implementação dos handlers concretos de domínio.
- O Compose agora inclui um serviço MCP stateless separado, compartilhando a configuração e o
  volume de desenvolvimento com a API; a validação estrutural passou sem levantar containers.
- Knowledge agora aplica proteção SSRF no conector HTTPS, bloqueando esquemas inseguros, credenciais
  embutidas e resoluções loopback/privadas/link-local, com allowlist opcional. A API ficou com 28
  arquivos e 66 testes; conectores externos continuam pendentes.
- O Agent Builder agora possui quatro templates first-party e instalação tenant-scoped que cria e
  publica uma versão real do agent. As rotas de catálogo/instalação foram incluídas no OpenAPI,
  agora com 155 caminhos válidos; disponibilidade automática do modelo `smart` e integrações
  avançadas continuam pendentes.
- A tela `/agents` agora consulta o catálogo de templates first-party e permite instalar
  `General Assistant`, `Coding Assistant`, `Research Agent` e `Security Review Agent` na
  organização autenticada, criando uma versão publicada real. O build de produção do Web,
  os testes globais (103 tarefas), o typecheck global (106 tarefas), o OpenAPI (155 caminhos)
  e a documentação (105 requisitos) foram revalidados nesta rodada.
- O CLI agora possui `handstack export -o <manifest.yaml>`, exportando recursos Agent, Model,
  Group e Budget como manifests `handstack.io/v1`, removendo IDs, metadados de persistência e
  segredos. O fluxo é complementar ao `handstack apply`; os 17 testes do CLI, lint e typecheck
  passaram.
- Settings também passou a persistir o tema da organização (`light`, `dark`, `system` ou `custom`),
  completando os tokens de preferência previstos no contrato de temas; o teste HTTP agora cobre
  o white-label completo e rejeição de URLs inseguras.
- Knowledge ganhou conectores públicos HTTP e GitHub: URLs `blob` são normalizadas para
  `raw.githubusercontent.com`, com timeout, limite de conteúdo e guarda SSRF obrigatória. Fontes
  sem conector continuam falhando fechadamente; 11 testes do pacote Knowledge passaram.
- A publicação agora consulta campanhas red-team por alvo tanto para modelos quanto para versões de
  prompt, bloqueando status diferente de `PASSED`. Todos os quatro alvos (Model, Prompt, Agent,
  Workflow) executam cenários pelos runtimes correspondentes, com oráculos declarativos e evidência
  por digest; respostas brutas não são persistidas. O teste HTTP de model-admin passou (8/8), com
  verificações de campanhas aprovadas/reprovadas e os quatro alvos; falta prova operacional de
  rollback em ambiente implantado. A suíte completa passou em 105/105 tarefas; API 109
  testes passaram, 3 de integração foram ignorados sem infraestrutura de teste. Typecheck/lint,
  OpenAPI (195 caminhos), documentação (122 artigos localizados, 105 requisitos, 33 alvos de ajuda)
  e auditoria das 160 seções também passaram; o status global permanece `PARTIAL`.
- O worker de webhooks deixou de usar `HANDSTACK_WEBHOOK_SECRET` global e de confiar no endpoint do
  job: lê endpoint e segredo cifrado nos mesmos stores tenant-scoped da API e usa idempotência
  persistente. Os segredos novos usam `HANDSTACK_MASTER_KEY` via `MasterKey`/HKDF, envelope AES-GCM
  com AAD da organização; a chave `HANDSTACK_WEBHOOK_MASTER_KEY` fica apenas como fallback de leitura
  temporário, com migração preguiçosa do segredo atual/anterior ao primeiro acesso. Teste comprova
  migração e leitura posterior somente com a chave central; o teste de worker também verifica que
  endpoint forjado no job é ignorado e que a organização é conferida. Compose, Helm e Kubernetes
  fornecem a chave central.
  A resolução na API e no worker agora emite `SECRET_ACCESSED` com metadados apenas; leitura e
  rotação preservam o key ID correto, e a rotação em configuração já carregada não persiste duas
  chaves. Testes focados verificaram auditoria HTTP e no worker, além da assinatura com a nova chave;
  a integração ainda depende de validação em deployment real.
  Na suíte global após a alteração, 105/105 tarefas passaram; worker: 13 testes passaram e 2 testes
  Redis/Sentinel foram ignorados porque a integração não estava habilitada.
- Plugins isolados agora invocam `ctx.secrets.get` por RPC bidirecional stdio para o host durante
  `setup`; o host aplica a permissão aprovada, resolve no escopo da organização/plugin e não inclui
  valores retornados em stdout/stderr de erro. Testes de subprocesso (sandbox 16/16) e do runtime
  isolado real (API 6/6) cobrem sucesso, permissão negada, ausência do valor no estado listado e
  redação em erro; build do sandbox/API passou. A integração restante em provedores e workers não
  foi marcada como concluída.
- A instalação externa de plugins NPM/GitHub agora recusa modo in-process, confere a assinatura
  Ed25519 contra o trust store de publishers e vincula a assinatura ao nome/versão, checksum do
  artefato e digests de SBOM/proveniência; também valida o conteúdo CycloneDX/SPDX e a attestation
  in-toto/SLSA contra o checksum do artefato. Os documentos são limitados em tamanho e descartados
  após validação. O teste usa keypair Ed25519 efêmero e verifica publisher não confiável, assinatura
  inválida, modo trusted recusado, digest adulterado, SBOM de pacote diferente e carregamento
  isolado de cache provisionado. `.env.example`, Compose, Helm e Kubernetes expõem a configuração de
  chaves públicas; guias EN/PT-BR explicam o payload assinado. Restam marketplace remoto e malware/
  dependency scanning. O contrato OpenAPI agora declara `supplyChainDocuments` e seus limites; a
  regressão HTTP rejeita documentos malformados antes de resolver o artefato. Na validação após
  essas mudanças, a suíte passou em 105/105 tarefas; API 109 passou e 3 integrações foram ignoradas,
  typecheck/lint, OpenAPI e documentação passaram.
