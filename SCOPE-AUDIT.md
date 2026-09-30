# Auditoria de escopo HandStack

Data da auditoria: 2026-09-29
Especificação: `C:\Users\flavi\Desktop\handstack-master-specification-v1.md`

## Critério

`Aderente` exige implementação funcional e evidência no nível do requisito. `Parcial` indica
contrato, modelo ou fluxo incompleto. `Ausente` indica que não há implementação utilizável. Um
teste de pacote não promove automaticamente um módulo inteiro para `Aderente`.

O auditor separa `implementationGaps` (funcionalidade ou cobertura ainda incompleta) de
`certificationGaps` (contrato existente, mas sem evidência no ambiente exigido pela
especificação). `scopeGaps` é a união das duas listas.

### Reconciliação do catálogo

A especificação original contém 160 seções numeradas, enquanto o catálogo interno contém 105
requisitos rastreáveis. Portanto, os 105 itens do catálogo não podem ser interpretados como uma
representação exaustiva das 160 seções. O catálogo agora declara `scopeStatus: partial`; a
aderência integral depende também das obrigações de milestones e Definition of Done listadas
neste relatório.

## Resultado por área

| Área da especificação                       | Evidência atual                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Estado                                  | Lacuna principal                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fundação, npm, TypeScript e Git             | `package-lock.json`, workspaces npm, `tsconfig`, repositório Git                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Aderente                                | —                                                                                                                                                                                                                                                                                                                                                                                                        |
| Persistência SQL/MongoDB                    | adapters, migrations, replica set MongoDB, conformance e failover local real executados                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Parcial                                 | certificação de produção, backup/restore e matriz de upgrade ainda não executadas                                                                                                                                                                                                                                                                                                                        |
| Identidade, RBAC, OIDC e SCIM               | API, storage, testes HTTP, telas administrativas, edição tenant-scoped e ciclo de vida de memberships, roles e permissões                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Parcial                                 | provisionamento e cobertura de produção ainda precisam de prova                                                                                                                                                                                                                                                                                                                                          |
| Models/providers/evaluation/pricing/routing | contratos, APIs e testes de runtime; datasets/suites/runs/gates persistentes; `RedTeamCampaign` versionada com vetores mínimos, execução por runtime para Model/Prompt/Agent/Workflow, findings redigidos e auditoria; `ModelApproval` persistida no ciclo de aprovação; publicação de modelos e versões de prompt falha fechada quando há campanha correspondente não aprovada                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Parcial                                 | campanhas aprovadas/reprovadas e quatro executores cobertos por testes HTTP; principal sintético de Agent/Workflow sem permissões; rollback operacional em ambiente implantado ainda falta                                                                                                                                                                                                               |
| Chat e gateway                              | Chat, SSE, reconexão após desconexão transitória, attachments e gateway implementados; Chat Workspace lista agentes publicados para WEB, permite agent switch e executa o agente pelo mesmo stream/idempotency flow; Playwright agora percorre a seleção do agente e o contrato de execução contra API simulada nos três browsers, além do E2E de reconexão                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Parcial                                 | execução E2E do agente com provider compatível real e cobertura E2E completa                                                                                                                                                                                                                                                                                                                             |
| Capabilities                                | APIs tenant-scoped e públicas, registro administrativo de descritores, publicação, engine governado, catálogo/UI e bloqueio de destinos externos por residência/classificação; descritores administrativos permanecem fail-closed até um runtime/plugin confiável carregar o handler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Parcial                                 | políticas de produção dependem de dados configurados                                                                                                                                                                                                                                                                                                                                                     |
| Agents/Agent Builder                        | CRUD, versões, publicação, templates first-party instaláveis, as 12 abas da especificação, memória, Knowledge, guardrails, MCP, Agent Tool entre agentes publicados, persistência de `AgentRun`/`AgentStep`/`ToolExecution`, navegação administrativa compartilhada e seleção explícita de canal (`WEB` no Chat Workspace, `REST_API` na API pública)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Parcial                                 | E2E completo dos canais Web/MCP/Agent Tool e resolvers de guardrails/integrações ainda precisam de prova                                                                                                                                                                                                                                                                                                 |
| Knowledge/RAG                               | ingestão, vetores persistentes, ACL, versões, conectores HTTP/GitHub públicos, conectores Bearer tenant-scoped para Drive/SharePoint/Confluence/Notion, conector S3 com cliente AWS injetável, normalização de conteúdo, proteção SSRF e scheduler opt-in para os sete conectores com fetch incremental e lease CAS persistente por tenant                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Parcial                                 | integração SQLite cobre fonte pública e Google Drive simulado, ingestão, busca ACL-scoped, mudança de ACL por cursor e deleção; API S3/MinIO cobre vault criptografado, fetch real, ingestão e auditoria; teste SQLite prova arbitragem de scheduler entre duas instâncias. Compose/Kubernetes/Helm expõem o scheduler desativado por padrão; resta E2E do scheduler em deployment e os outros providers |
| MCP                                         | registro, discovery, credenciais, execução, integração com Agents, OAuth authorization-code, persistência de `McpServer`, `McpTool`, `McpResource` e `McpPrompt`, `tools/list` filtrado pelas permissões efetivas do principal, integração HTTP com um `McpServer` real via loopback e reconexão lazy autenticada do transporte                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Parcial                                 | falta E2E operacional com servidor MCP externo/deployado, credenciais reais, OAuth por usuário e reconexão/publicação ponta a ponta                                                                                                                                                                                                                                                                      |
| Plugins/Marketplace                         | catálogo oficial/community; catálogos `INSTALLED`/`UPDATES` persistidos e tenant-scoped; instalação, upgrade e lifecycle administrativo; UI administrativa com enable/disable/uninstall/quarantine; checksum SHA-256; fontes externas exigem assinatura Ed25519 de publisher confiável, SBOM CycloneDX/SPDX, provenance in-toto/SLSA vinculada ao digest do artefato e modo isolado; controles persistentes tenant-scoped de quarentena e revogação com auditoria; fontes NPM/GitHub limitadas a cache pré-provisionado; runner sandbox/RPC isolado                                                                                                                                                                                                                                                                                                                                                       | Parcial                                 | marketplace remoto, malware/dependency scan, cobertura E2E operacional e integração completa da revogação ainda faltam                                                                                                                                                                                                                                                                                   |
| Workflows/Approvals/Access Grants           | runtime, persistência, aprovação, recuperação, APIs, execução governada de Agent/Capability/LLM/MCP, propagação das permissões RBAC efetivas do principal para nós Agent/MCP, dispatch de eventos, scheduler configurável com descoberta paginada de organizações ativas, lease persistente por tenant com CAS, teste de exclusão entre instâncias e takeover após expiração, e compensações em ordem reversa com sequência persistida                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Parcial                                 | integração com worker em ambiente implantado e drill completo de failover do scheduler ainda faltam                                                                                                                                                                                                                                                                                                      |
| Secrets                                     | vault AES-256-GCM, rotação e referências em partes do runtime; `ctx.secrets.get` funciona via RPC bidirecional entre plugin isolado e host; OIDC e Model Providers resolvem referências pelo broker auditado; `HANDSTACK_MASTER_KEY` está injetada em Compose/Kubernetes/Helm; webhooks derivam a chave central, migram ciphertext legado tenant-bound e registram `SECRET_ACCESSED` com metadados; rotação mantém o `keyId` anunciado pelo dispatcher                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Parcial                                 | faltam referências brokeradas uniformes nos demais workers/provedores e integrações com secret managers externos; o provider de webhooks segue especializado para overlap de rotação; cobertura integrada em deployment real continua ausente                                                                                                                                                            |
| Governança de privacidade                   | APIs e módulo administrativo Web tenant-scoped para inventário, finalidades, consentimentos, processors, incidentes, retenção, legal holds, solicitações de titulares, residência, `DeletionJob` e `DeletionEvidence`; persistência, autorização, exportação sanitizada e eliminação com respeito a holds; consentimento agora é aplicado em capabilities com `consentPurposeId`; `RedisSubjectCache` fornece purge externo indexado por tenant/titular e é ligado ao Redis compartilhado no perfil distribuído; `ExternalBackupTombstoneAdapter` fornece tombstones sem conteúdo para uma store de backup injetada e o perfil distribuído a compõe com o Redis compartilhado; adaptadores oficiais para search index, os seis vector stores, vetores do repositório, anexos locais, repositórios conhecidos de plugins, cache local/MCP, tombstones persistentes de backup e jobs pendentes/dead letters | Parcial                                 | faltam restauração/drill externo e enforcement de consentimento/residência em cada destino e E2E Mongo/produção                                                                                                                                                                                                                                                                                          |
| Jobs/Workers                                | filas BullMQ, retries, timeout, heartbeat, DLQ, backpressure, contrato explícito de handlers, seleção de classe no worker/Helm, transporte API→BullMQ e handlers concretos para as dez filas; a nova fila de workflows usa API interna autenticada para acessar o estado da aplicação                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Parcial                                 | a fila `workflow-executions` foi publicada pela API e consumida por worker real; teste Redis 7.4 consome as dez filas e, com handlers sintéticos, comprova duas tentativas, falha terminal e cópia do payload/erro para a DLQ de cada fila; faltam políticas exercitadas com falhas reais de domínio, capacidade certificada e prova operacional dos Deployments                                         |
| Notifications/Webhooks/Incidents/Audit      | contratos e APIs tenant-scoped; IN_APP persistente; SMTP via Nodemailer com credencial referenciada no vault; Webhook/Slack/Teams/Discord via transporte HTTPS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Parcial                                 | operação distribuída e E2E contra provedores reais ainda faltam                                                                                                                                                                                                                                                                                                                                          |
| Configuração                                | schema/resolver de precedência, seleção de adapter, camada persistente global de `database settings` carregada após a conexão, API/UI administrativa global, overrides operacionais persistidos em `OrganizationSettings`, `/settings` para branding/locale/timezone/theme e feature flags global/organização/usuário persistentes; parte dos parâmetros já chega aos consumidores (privacidade Chat, telemetria, namespace/PEL Redis, filas e timeouts padrão de Agent/MCP/provider/tool)                                                                                                                                                                                                                                                                                                                                                                                                                | Parcial                                 | ainda falta exercício de startup/produção e comprovação de wiring de todos os parâmetros em runtime; retenção e limites globais precisam de ligação/semântica comprovada nos consumidores; a seleção do adapter primário continua deliberadamente restrita ao ambiente/arquivo antes do startup                                                                                                          |
| Observabilidade/SIEM                        | auditoria append-only e exporter redator                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Aderente ao contrato                    | SIEM externo não faz parte do escopo inicial                                                                                                                                                                                                                                                                                                                                                             |
| Deploy/Compose/Helm/DR                      | Compose com API/Web/MCP e consumidores dedicados para as dez filas no profile distribuído, profiles de banco, contratos e manifests validados; manifesto Kubernetes referencia ConfigMap/Secret e injeta configuração nos workers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Parcial                                 | exercício operacional multi-região/Kubernetes, capacidade, upgrade/rollback e HA/backup/restore de produção                                                                                                                                                                                                                                                                                              |
| SDK/CLI/Help Center                         | SDK, `init`/`start`, `apply`, exportação/importação de configuração como código, comandos administrativos autenticados, docs localizadas e Help Center; `Policy` suportado por `apply`/`export`, engine persistente e API tenant-scoped; SDK agora expõe Agents REST/streaming, Knowledge, Privacy, MCP, Plugins, Secrets, Workflows, Notifications, Incidents, Operations, Settings, Gateway API Keys, Webhooks, Chat Workspace, Access, Directory/RBAC, Identity/SCIM, Budgets, Policies, Service Accounts, Routing, settings de database e Models/Providers/Evaluation/Red-Team                                                                                                                                                                                                                                                                                                                        | Parcial                                 | execução contra API implantada e E2E completo do CLI ainda faltam                                                                                                                                                                                                                                                                                                                                        |
| GitOps/config sync                          | repositório Git inicializado, Configuration as Code local (`apply`/`export`) e `handstack config sync` validando ref e lendo manifesto diretamente do Git                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Aderente ao escopo definido             | —                                                                                                                                                                                                                                                                                                                                                                                                        |
| Graphify / Code Knowledge Graph             | `graphify`, `graph:update`, validação estrutural e pipeline CI oficial com extração incremental, diagnóstico de grafo dirigido e consulta com orçamento explícito                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Aderente ao pipeline de desenvolvimento | —                                                                                                                                                                                                                                                                                                                                                                                                        |
| Event Bus e Execution Context               | contratos centrais `EventBus`/`DomainEvent`/`ExecutionContext` em `packages/core`, adapter Redis Streams concreto com consumer groups/ACK/DLQ e contexto tenant-scoped nas principais APIs; `operation.created` e o job de workflow propagam requestId, traceId, principalId e source validados até o endpoint interno, sem serializar permissões                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Parcial                                 | Redis 7.4 real comprova publicação, consumo, retomada de PEL via `XAUTOCLAIM`, contador de tentativas e ACK após DLQ; testes API/worker/core comprovam proveniência limitada no caminho de workflow; ainda falta wiring e propagação auditável uniforme em todos os domínios e workers                                                                                                                   |
| Entidades normativas da seção 129           | Entidades centrais de identidade, chat, agents, knowledge, budgets, policies, access, workflows e operações possuem contratos e/ou persistência; `AgentRun`, `AgentStep`, `ToolExecution`, `EvaluationResult`, `RedTeamCampaign`, `ModelApproval`, `WorkflowVersion`, `WorkflowTrigger`, `WorkflowCompensation`, `PluginInstallation`, `DataInventoryEntry`, `McpServer`, `McpTool`, `McpResource` e `McpPrompt` possuem contratos, persistência tenant-scoped e fluxos de runtime exercitados                                                                                                                                                                                                                                                                                                                                                                                                            | Aderente ao escopo implementado         | E2E externo de conexão/publicação MCP e integrações operacionais continuam registrados nas lacunas específicas de MCP e Plugins                                                                                                                                                                                                                                                                          |

## Evidência desta revisão

### Revalidação incremental (28/09/2026)

Após a execução de `retention.trace`, o `scope:audit` continua `PARTIAL`, com 160 seções,
105 requisitos `verified`, 15 lacunas funcionais/cobertura e 6 certificações externas. O OpenAPI
foi regenerado e validado com 205 caminhos, incluindo a rota autenticada de reconexão MCP;
`missingHandlers`, rotas administrativas, navegação e
ajuda contextual continuam sem lacunas. Docker, Redis e MongoDB local estão disponíveis para
conformance, mas os drills de infraestrutura externa não foram promovidos a certificação. Os testes focais da nova
retenção de traces passaram na API e Web, e o scheduler agora executa traces sob a mesma lease das
demais retenções; o audit append-only continua preservado e fora de uma exclusão automática. O
`AuditIntegritySchedulerService` agora verifica a cadeia por tenant em job opt-in, coordena réplicas
por lease persistente e registra `AUDIT_VERIFIED`; isso cobre o job local, mas não substitui
WORM/SIEM externo nem os drills de deployment.

Na revalidação de 28/09, a rota `audit/verify` também foi incluída no OpenAPI e exercitada com
permissão `audit.read`, registro `AUDIT_VERIFIED` e negação cross-tenant; o SDK correspondente e
os guias localizados foram atualizados. O resultado programático do `scope:audit` permanece
`PARTIAL`, com 15 lacunas funcionais/cobertura e 6 certificações externas.

Na continuação de 28/09, `McpClientRegistry.reconnect` passou a ser exposto pela API e pelo SDK;
o teste HTTP loopback confirmou autorização administrativa e resposta tenant-scoped, enquanto o
teste do cliente stdio confirmou a criação de um transporte novo após reinício. Isso reduz a
lacuna de reconexão local, mas não substitui E2E com servidor externo/deployment.

Na revalidação de 29/09, o SDK passou a publicar o contrato tipado de execução do Chat Workspace,
incluindo Agent, Knowledge, mensagem pai e trace. O CLI passou a validar `export -o` antes de
consultar a API e a exigir `metadata.name` em manifests, com 27 testes focais/E2E aprovados.
Esses incrementos fecham validações locais de contrato, mas a execução contra API implantada e
providers externos continua pendente.

Os rótulos de `implementationGaps` foram refinados nesta mesma revisão para não atribuir ao
repositório lacunas já fechadas localmente: Chat/Agents, Configuration e SDK/CLI agora identificam
explicitamente a evidência de deployment/provider que falta. A contagem permanece 15 lacunas
funcionais/cobertura e 6 certificações externas; nenhum item foi promovido por essa mudança.

### Revalidação mais recente (18/09/2026)

Os gates foram executados novamente no estado atual do worktree: `scope:audit` está
`PARTIAL` no nível de escopo global. Os 105 requisitos do catálogo estão verificados no nível
de seus contratos e testes declarados, mas isso não significa que toda a especificação esteja
concluída: o Milestone 18 e o Definition of Done geral possuem obrigações adicionais;
OpenAPI continua válido com 202 caminhos, a documentação
continua válida com 122 artigos/105 requisitos/33 alvos de ajuda contextual; o catálogo foi reconciliado
para 105 requisitos `verified`, sem itens `implemented` ou `partial`, e o manifesto Kubernetes continua válido com
35 documentos/13 Deployments/10 ScaledObjects; Compose distribuído também passou `config --quiet`
com consumidores para as dez filas. Os testes, typecheck, lint e build globais
também passaram nesta rodada.

O workflow de CI agora executa também auditoria de escopo, OpenAPI, Helm, Kubernetes, release,
resiliência, observabilidade e frontend; foi acrescentado um job de conformance real para Redis
Streams e todos os jobs de conformance removem seus containers mesmo em falha.

Após a revalidação global, uma revisão focalizada fechou dois comportamentos de segurança do
Marketplace: quarentena/revogação são persistidas antes da desativação; controles publicados pelo
endpoint do Registry desativam instalações afetadas, e falhas de `onDisable` não deixam plugin
ativo nem liberam reativação. Os testes de runtime e HTTP do Registry cobrem esses fluxos. O broker
comum de secrets também passou a resolver `env://HANDSTACK_SECRET_*` com namespace restrito e
auditoria sem valor confidencial; o OIDC usa esse broker. Testes de Secrets/Identity, Registry e
Plugin passaram (12 testes combinados nesta rodada), além do typecheck; OpenAPI (195 caminhos) e
documentação (122 artigos/105 requisitos/33 alvos de ajuda) foram revalidados. Isso é progresso de
implementação, não certificação: os gaps amplos de Marketplace e Secrets permanecem abertos para
conexão externa, providers/workers adicionais e evidência operacional, sem promoção de status.

Na revisão seguinte, testes de `AgentRuntimeService` passaram a cobrir o resolver de guardrails
publicados (bloqueio de entrada/saída e guardrail desconhecido fail-closed) e o resolver de
integração MCP configurada: seleção pelo servidor, checagem da permissão requerida, negação sem
permissão e execução com permissão. A suíte unitária do runtime passou com 8 testes; essa cobertura
específica não substitui as jornadas E2E completas Web/MCP/Agent Tool que continuam pendentes.

O scheduler de Workflows também ganhou teste concorrente de duas instâncias usando um adapter
SQLite persistente real: somente uma instância adquire a lease e executa o tenant por tick, e uma
segunda assume após a liberação. Os dois testes do scheduler passaram. Isso verifica a fronteira
CAS local, mas não é o drill de failover implantado nem comprova execução distribuída via worker;
ambos permanecem pendentes.

A auditoria reporta explicitamente 21 lacunas de especificação: 15 lacunas funcionais/cobertura
em áreas como identidade, agents, knowledge, MCP, plugins, workflows, secrets,
privacidade, CLI e Event Bus; e seis lacunas de certificação — HA/failover de banco em
produção e backup/restore, DR multi-zona/multi-região, capacidade medida, upgrade/rollback sem
downtime, E2E de providers externos e penetration test/threat-model review; a suíte Playwright
passou nos três browsers configurados com performance, acessibilidade e reconexão SSE. Os advisories
moderados do Fastify/Nest foram eliminados com a atualização coerente para Nest 12.0.3, Swagger
12.0.1 e Fastify 5.12.4; `npm audit --omit=dev --audit-level=moderate` retorna zero vulnerabilidades.
Os drills locais de Redis Sentinel e MongoDB passaram, e a
suíte Playwright agora inclui compatibilidade, acessibilidade, visual, jornadas críticas e
orçamento de performance nos três engines; isso ainda não constitui certificação dos releases
estáveis exigida pela especificação.

O daemon Docker esteve disponível nas conformance recentes: PostgreSQL, MongoDB, MySQL,
MariaDB, SQL Server, Redis Streams e MinIO passaram, e a limpeza posterior retornou nenhum
container, volume ou rede `handstack`.

O worker também foi exercitado contra Redis 7.4 real: testes publicaram e consumiram jobs nas dez
filas oficiais, verificando heartbeat, checkpoint e conclusão. Um segundo cenário provocou falha
terminal em handler sintético de cada fila, confirmou duas tentativas BullMQ e a cópia de payload e
erro à respectiva DLQ; o container temporário foi removido ao final. Isso valida a infraestrutura
comum de retries, não a política de erro própria de cada domínio.

O runtime de Event Bus da API também foi exercitado em perfil `distributed` contra Redis 7.4:
um evento tenant-scoped foi publicado, consumido pelo grupo Redis Streams e entregue ao handler;
o teste verificou a seleção do adapter configurado e encerrou o cliente Redis. A revisão encontrou
que o adapter só lia entradas novas (`XREADGROUP ... >`), sem retomar mensagens pendentes após queda
de consumer, e que mensagens poison movidas à DLQ não recebiam ACK. O transporte agora percorre o
PEL por `XAUTOCLAIM` com cursor e idle mínimo configurável, carrega o contador via `XPENDING` e
reconhece a origem somente depois da gravação na DLQ. A integração contra Redis 7.4 confirmou a
retomada por outro consumer (delivery count 2), o dead-letter e que a origem não reaparece após ACK;
a integração runtime/API, testes unitários, typecheck e lint também passaram. O contrato
`operation.created` tem proveniência limitada a requestId, traceId, principalId e source, rejeita
campos extras como permissões; um teste HTTP autenticado agora percorre criação/publicação/início
de workflow e confere causationId e proveniência no evento. Isto cobre esse produtor, não constitui
wiring uniforme: o mesmo contexto agora segue no payload do workflow, é validado pelo consumidor
worker e pelo endpoint interno e não inclui permissões. Testes runtime/HTTP/worker verificam o
round-trip e a rejeição de campos de autoridade ou identificadores acima de 128 caracteres. A
propagação de Execution Context e eventos de domínio nos demais workers/domínios permanece aberta.

### Certificações: bloqueios e pré-requisitos objetivos

Os seis itens abaixo não são promovidos por testes locais de unidade, loopback ou Docker efêmero.
Os bloqueios atuais e o material necessário para executar cada certificação são:

| Certificação                       | Estado atual                                                           | Pré-requisito para execução válida                                                                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Banco HA/failover + backup/restore | Drill MongoDB local passou; certificação pendente                      | ambiente implantado com topologia HA suportada, política de backup, destino de backup restaurável, janela de manutenção e acesso para simular falha/restaurar e medir resultado     |
| DR multi-zona/multi-região         | não executada                                                          | duas regiões/zonas independentes, tráfego ou failover controlável, réplica/backup entre regiões e critérios aprovados de RPO/RTO                                                    |
| Capacidade p95/p99                 | Playwright frontend startup 3/3 browsers passou; certificação pendente | ambiente representativo, carga autorizada e reproduzível, topologia/resource limits definidos, coleta de métricas e metas de taxa, p95 e p99                                        |
| Upgrade/rollback sem downtime      | não executada                                                          | deployment com pelo menos duas réplicas, artefatos versionados anterior/novo, migrações backward-compatible, health/readiness probes e janela para rolling upgrade/rollback         |
| Contract/E2E de provider externo   | provider loopback compatível coberto; certificação pendente            | endpoint real ou sandbox oficial compatível, credencial não fornecida no repositório, limites de custo/rate e autorização para executar chamadas e registrar evidências sanitizadas |
| Threat model + penetration test    | não executado                                                          | escopo escrito e autorizado, release/imagens atuais congeladas, ambiente isolado, janela de teste, responsável por triagem e relatório assinado com findings/remediações            |

Sem esses pré-requisitos, qualquer execução seria apenas um smoke test local e não evidência de
certificação; os seis itens permanecem pendentes no auditor.

Na revalidação local de 2026-09-18 também passaram `helm:validate`, `helm:release:validate`,
`release:validate`, `resilience:validate`, `dr:validate`, `kubernetes:validate`,
`container:validate`, `integration:validate` e `frontend:validate`. O teste Playwright
`performance.e2e.ts` passou em Chromium/Firefox/WebKit (3/3), verificando apenas o orçamento de
startup do frontend. Esses gates validam contratos/manifests e comportamento local; não medem carga
representativa p95/p99, failover real, restauração de backup, DR, rolling upgrade em cluster, provider
externo ou segurança ofensiva. Portanto não encerram nem promovem nenhuma das seis certificações.

O Web também foi validado em produção local: `next build` compilou 35 rotas administrativas,
incluindo `/settings`, e `next start` respondeu `HTTP 200` para `/settings` com HTML da tela de
configurações. O processo foi encerrado após a verificação.

A suíte Playwright foi reexecutada após a revisão: 9/9 testes passaram nos três engines, incluindo
uma queda transitória do stream SSE seguida de reconexão e conclusão da resposta. Isso comprova
essa parte do requisito de resiliência do frontend, mas não substitui a cobertura E2E completa de
agents, MCP e integrações externas.

O teste HTTP do Chat também criou uma conversa e uma mensagem, selecionou um `agentId` publicado,
executou o agente pelo fluxo `startStream`/`runStream` com idempotência e verificou a resposta
persistida como mensagem concluída. Essa é evidência de integração do agent switch no Chat
Workspace; a execução agora resolve as permissões efetivas do principal a partir de roles tenant-scoped.
Não é promovida a E2E externo porque o executor do agente usa provider/rota controlados.

O endpoint MCP JSON-RPC agora também carrega as permissões efetivas do principal a partir do RBAC
tenant-scoped, em vez de usar uma lista fixa. O teste HTTP exige uma permissão adicional (`mcp.extra`)
na capability publicada e confirma a chamada; isso cobre a autorização efetiva do endpoint, mas não
substitui a certificação contra um servidor MCP externo.

As rotas públicas REST e streaming de Agents também deixaram de aceitar permissões fornecidas no
payload: elas agora calculam a lista efetiva do principal por roles. O teste HTTP tenta enviar
`admin.write` sem essa concessão e confirma que somente `agents.execute` e `safe.read` chegam ao
runtime, evitando elevação de privilégio por entrada do cliente.

O Chat Workspace marca a execução selecionada como canal `WEB`, enquanto as rotas públicas REST e
streaming usam `REST_API`; o runtime mantém a validação de publicação por canal do `AgentHarness`.

Agents publicados com `publishChannels: ['MCP']` agora são expostos como ferramentas `agent.<slug>`
no endpoint JSON-RPC MCP. A lista é filtrada por `agents.execute` e a chamada delega ao runtime
com `channel: MCP`; `mcp.http.test.ts` cobre listagem, execução e permissões efetivas. Isso fecha
o adaptador MCP local. O harness/runtime também resolve Agents publicados como `AGENT_TOOL` entre
si, herdando permissões, tenant e cancelamento, com limite de recursão; `agent-runtime.test.ts`
cobre a delegação. Ainda não há prova de um servidor/provedor externo nem de um deployment com
todos os canais.

A API também foi exercitada contra Redis 7.4 real: `OperationsRuntimeService` publicou um job
na fila `agents` e um worker BullMQ separado consumiu e concluiu o payload. Essa rodada corrigiu
a injeção explícita de `DatabaseService`/`AuditRuntimeService` no runtime de operações e passou a
ser gate do workflow de CI.

As filas criadas pelo `OperationsRuntimeService` agora recebem os valores efetivos de
`config.timeouts` por domínio e `config.retention.audit` para retenção de dead letters. O teste de
operações verifica o mapeamento de agents e indexing; a validação de produção e a operação de
todas as classes ainda permanecem pendentes.

Essa integração foi reexecutada com o teste `distributed.queue.integration.test.ts` usando Redis
7.4 em container temporário: o perfil distribuído foi inicializado, a API publicou e o worker
BullMQ consumiu o job com sucesso. O container e seu volume anônimo foram removidos e a inspeção
final retornou `containers=`, `volumes=` e `networks=` vazios.

A seleção do banco também foi corrigida: `handstack.config.ts` não fixa mais SQLite e respeita
`HANDSTACK_DATABASE_ADAPTER`, permitindo que o adapter MongoDB seja selecionado antes do startup;
o typecheck global foi executado novamente após essa alteração.

A API foi inicializada contra MongoDB 8 em replica set real, sem SQL: o adapter efetivo foi
`mongodb`, health e replication health ficaram `up`, e configurações tenant-scoped foram gravadas,
fechada a conexão e relidas pela aplicação. Esse smoke test agora é um gate do CI.

O runtime BullMQ agora propaga `HANDSTACK_REDIS_TOPOLOGY`, interpreta opções Sentinel e cria
conexão Cluster via ioredis; o parsing Sentinel foi coberto por teste. Isso corrige a divergência
em que a configuração aceitava HA, mas o runtime tratava toda topologia como standalone.

O readiness probe normaliza corretamente URLs `redis+sentinel://` e `redis+cluster://`; essa
fronteira foi coberta por teste TCP. O failover Redis Sentinel também possui agora um drill real
aprovado, descrito abaixo.

O drill de failover Redis Sentinel foi então executado com duas réplicas e três Sentinels: após a
parada do master, o quorum promoveu uma réplica e um novo runtime BullMQ publicou/consumiu um job
após a recuperação. O cenário foi aprovado e todos os containers, volumes e a rede foram removidos.

O drill de failover MongoDB também foi executado localmente com três nós: uma gravação foi confirmada
antes da queda do primary, uma réplica foi promovida automaticamente e uma segunda gravação foi
confirmada após a reconexão do driver. O teste passou, mas isso não substitui a certificação de
produção, backup/restore e recuperação regional.

As linhas e parágrafos abaixo que registram números menores de caminhos, testes ou gates
descrevem rodadas históricas e não substituem os números desta seção.

### Itens normativos conferidos diretamente

Na seção 129 da especificação, as entidades dedicadas `WorkflowVersion`,
`WorkflowCompensation`, `PluginInstallation` e `DataInventoryEntry` agora existem e têm
persistência exercitada nos fluxos correspondentes. `WorkflowTrigger`, `McpServer`, `McpTool`,
`McpResource` e `McpPrompt` também têm persistência tenant-scoped no runtime, incluindo
hidratação após restart. A integração MCP HTTP agora usa uma instância real de `McpServer` em
loopback: o teste confirma que tools não publicadas não aparecem, publica a capability, descobre e
persiste a tool pelo cliente MCP e invoca-a através do engine governado, validando o contexto do
principal remoto. Isso substitui respostas JSON-RPC simuladas na prova de interoperabilidade local,
mas não certifica um servidor externo/deployado, OAuth por usuário ou reconexão operacional. Os
fluxos operacionais de marketplace continuam registrados nas lacunas específicas.

Na seção 125, os endpoints `health/live` e `health/ready` existem. O readiness agora executa
o doctor do adapter (conexão, versão, transação, schema, índices e migrações) e exige Redis
quando o perfil é `distributed`; os testes HTTP e unitários passaram. O readiness também executa
o probe do storage local configurado, retornando `up` ou `down` conforme o diretório e a chave de
assinatura estejam utilizáveis. No perfil distribuído, o check `eventBus` espelha o probe real
do Redis. O runtime de plugin agora informa `up` quando a execução confiável está disponível e
exige o runner quando o isolamento é obrigatório. O adapter MongoDB também verifica
`replSetGetStatus`; replicação/failover para os demais adapters ainda retorna `not-configured`,
portanto a área continua parcial e isso é uma lacuna funcional, não apenas uma lacuna de teste.

Na seção 61, a auditoria verifica explicitamente a matriz de adapters vetoriais. Existem agora
adapters concretos para pgvector, MongoDB Atlas Vector Search, Qdrant, Pinecone, Weaviate e Chroma,
com filtros por organização e transporte/cliente injetável. Também foi adicionado o boundary
tipado `VectorStoreProvider`/`VectorStoreProviderFactory`, com fail-closed explícito para providers
não configurados. A configuração agora expõe `vectorStore.adapter` e a API seleciona esses adapters
no runtime; ainda falta executar conformance contra cada backend real, portanto a matriz de código
não equivale ainda à aderência operacional completa. A API mantém
`repository` como default e seleciona Qdrant, Chroma, Pinecone e Weaviate em runtime, resolvendo
credenciais por organização quando configuradas. pgvector usa a conexão PostgreSQL primária e
MongoDB Atlas usa a coleção nativa somente com opt-in explícito; adapters externos sem configuração
compatível falham, em vez de serem ignorados silenciosamente. Ainda falta executar conformance
contra cada backend real e validar migrações/índices de produção. Testes de contrato cobrem tentativas
de sobrescrever `organizationId` via filtro nos adapters Pinecone, Chroma e MongoDB Atlas; a proteção
foi corrigida para que o escopo do tenant prevaleça sobre metadados de busca.
Além disso, Qdrant 1.13.6 foi executado localmente em Docker: upsert, busca isolada, exclusão de IDs
com tentativa de cruzar organizações e exclusão por titular passaram; a prova real também revelou e
corrigiu o formato REST da condição `has_id`. Weaviate 1.28.4 real também confirmou filtros GraphQL
aplicados no servidor, busca tenant-scoped e exclusão de objetos/titulares pelo endpoint batch com
tenant; isso corrigiu a omissão anterior dos filtros e do parâmetro de tenant nas exclusões. Ambos
os containers foram removidos após os testes. PostgreSQL 16 com pgvector também passou por criação
idempotente de schema, busca cosine tenant-scoped com filtro de metadados, exclusão tenant-scoped
e exclusão por titular com contagem real via `RETURNING`. Chroma 1.0.0 real passou
por criação de coleção, lookup nome→ID pela API v2, upsert, busca com filtros compostos, exclusão
por IDs sem atravessar organizações e exclusão por titular paginada; foi corrigida a incompatibilidade
com rotas/API v1 antigas. Todos os containers e imagens temporários foram removidos. O adapter
pgvector cria extensão, tabela e índice de forma idempotente quando selecionado; o índice de busca
do Atlas continua sendo uma configuração externa obrigatória. A integração real MongoDB Atlas Vector
Search passou também com a imagem oficial `mongodb/mongodb-atlas-local:preview` (MongoDB 8.3.11 +
mongot): o teste cria a coleção e o índice vetorial com campos filtráveis, aguarda `READY/queryable`
e a indexação assíncrona, e valida upsert, busca por metadados com tentativa de adulterar o tenant,
exclusão tenant-scoped por IDs e exclusão por titular. A execução passou (1/1); container, volumes
anônimos e imagem temporários foram removidos. Isso comprova integração local com Atlas Local, mas
não substitui a validação do índice nem a certificação em um cluster Atlas gerenciado. Pinecone real,
schema/índices operacionais e certificação completa dos seis adapters permanecem sem evidência.

Na seção 119, há um workflow de CI, porém não há evidência de todos os gates obrigatórios
da especificação: matriz completa de bancos, saturation/load de filas, upgrade sem downtime,
distributed deployment test, threat-model validation e validação completa de artefatos de
segurança/proveniência.

- OpenAPI gerado e validado: 195 caminhos, incluindo registro/publicação e APIs públicas de capabilities/agentes, templates de agents, catálogo de agentes do Chat Workspace, as duas rotas OAuth MCP, consulta de tools/resources/prompts persistidos, upgrade de plugins, edição de diretório, memberships/RBAC, dispatches de workflows, overrides de aprovação de modelos e prompts, rollback de agents, controles persistentes de quarentena/revogação do Marketplace, configurações globais de banco, governança de privacidade e campanhas de red team.
- Gates desta revisão: testes, build, typecheck e lint globais, documentação
  (122 artigos localizados/105 requisitos), Helm,
  release, resiliência, observabilidade, frontend, integração e Graphify passaram.
- Docker: as conformance de PostgreSQL, MongoDB, MySQL, MariaDB, SQL Server, Redis Streams e
  MinIO passaram; a limpeza posterior e o inventário atual não encontram containers, volumes ou
  redes `handstack`.
- Compose agora declara também o serviço MCP stateless na topologia local; `docker compose config`
  passou sem iniciar serviços. Workers continuam fail-closed até receberem handlers e organização.
- E2E distribuído executado com Redis real: a API publicou job em BullMQ e um worker separado
  consumiu o payload; convenção de nomes e `jobId` foi validada sem caracteres proibidos.
- Confluence agora possui locator `confluence://host/pageId`, autenticação Bearer via referência
  tenant-scoped ao vault e extração do corpo Storage; Notion agora extrai `plain_text` dos blocos
  antes da indexação. O pacote Knowledge passou build, lint e 13 testes.
- `S3StorageProvider` agora aceita um `S3Client` real injetável, aplica prefixo por organização,
  executa put/get/delete/head e gera presigned GET URLs. R2 e GCS reutilizam esse caminho
  S3-compatible com endpoint/provider scheme injetável. Azure Blob agora aceita `BlobServiceClient`
  real injetável, prefixa blobs por organização, implementa upload/download/delete e SAS URL; os
  quatro testes do pacote Storage passaram.
- O Knowledge passou a ter `S3KnowledgeSourceConnector`, que resolve credenciais JSON pelo vault,
  lê `s3://bucket/key` via AWS SDK e preserva o ETag como versão; o pacote Knowledge passou 15
  testes. Ainda falta E2E com S3 real e descoberta automática de fontes/tenants.
- A administração de identidade passou a expor listagem e mutação tenant-scoped de memberships,
  atribuições de roles, permissões e vínculos role-permission; o OpenAPI foi regenerado para 163
  caminhos e build/typecheck/lint da API passaram. O contrato HTTP agora também é exercitado por
  `apps/api/tests/directory.http.test.ts`, incluindo criação/edição, atribuições e bloqueio cross-tenant.
- O ciclo de vida desses vínculos agora inclui remoção com compare-and-delete por versão, e a UI de
  Groups expõe a remoção de memberships e atribuições; build/lint do Web passaram.
- A revisão do Agent Builder confirmou as 12 abas normativas (`General`, `Prompt`, `Model`, `Tools`,
  `MCP`, `Knowledge`, `Memory`, `Guardrails`, `Budget`, `Permissions`, `Publishing`, `Versions`)
  na UI, com persistência na configuração versionada; a lacuna é evidência E2E dos canais e
  integrações, não ausência das abas.
- As telas de Users, Groups e Roles agora oferecem ajuda contextual para o Help Center junto às
  ações administrativas; o build/lint do Web e a validação de documentação passaram.
- A tela de Usage agora apresenta total de gasto, consumo de tokens, requests, latência média,
  erros e agregações por provider, model, usuário, agent e grupo. O endpoint consolida `UsageRecord`
  do orçamento com uma projeção segura dos eventos/mensagens de chat; conteúdo de prompts e respostas
  não é exposto.
- A navegação administrativa agora expõe todas as telas Web já implementadas, incluindo workflows,
  access requests/grants, providers, routing, service accounts, secrets, incidents, webhooks,
  operações e pricing; typecheck, lint, testes (21) e build do Web passaram.
- A exportação e a eliminação de titulares agora reconhecem também coleções de identificadores
  (`subjectIds`, `userIds`, `principalIds` e `participantIds`), incluindo o inventário de dados;
  o teste HTTP de privacidade passou novamente (3 testes), com conteúdo sanitizado e isolamento
  tenant-scoped preservados.
- Os transports de jobs agora expõem purga tenant-scoped de payloads pendentes e dead letters;
  memória, repositório e BullMQ removem somente jobs que contenham o titular, com 25 testes do
  pacote Jobs aprovados e integração da API nas dez filas oficiais.
- Os seis adapters vetoriais agora expõem exclusão por titular com filtro obrigatório de
  organização; a API usa essa operação para pgvector, MongoDB Atlas, Qdrant, Pinecone, Weaviate,
  Chroma e o repositório local, com typecheck/lint e 18 testes do pacote Knowledge aprovados.
- O índice persistido de documentos do Knowledge agora possui purga por titular, considerando
  ACLs e metadados dos chunks com escopo de organização; a evidência é registrada como destino
  `SEARCH_INDEX` no job de exclusão.
- O tombstone de backup deixou de ser somente memória: cada exclusão grava de forma idempotente
  em `backup-tombstones`, preservando evidência após restart; a API continua com typecheck/lint
  aprovados.
- O catálogo contém 105 requisitos `verified`, sem itens `implemented` ou `partial`. Isso significa
  aderência aos contratos verificados; as áreas acima continuam parciais quando a especificação
  exige operação distribuída, integração externa, produção, HA/DR ou E2E que ainda não foi exercitada.

## Regra de promoção

Nenhuma área acima deve ser promovida para `Aderente` sem teste de integração ou evidência de
runtime que cubra o fluxo descrito na especificação. As pendências também permanecem registradas
em `STATUS.md`.

O CLI também cobre operações administrativas autenticadas para criação de usuários, listagem de
agents, capabilities e plugins, além do endpoint MCP; 13 testes do CLI, typecheck e lint passaram.
`init`/`start` e instalação efetiva de plugins permanecem pendentes.

O worker passou a carregar `HANDSTACK_WORKER_HANDLER_MODULE` e falhar antes do consumo quando o
módulo ou o handler da fila não existe; a seleção por fila foi coberta por teste (7 testes do
worker aprovados). Isso remove o consumidor vazio, mas não substitui os handlers de domínio.

O CLI passou a implementar `init` (configuração SQLite sem sobrescrita) e `start` (delegação ao
`npm run dev` com propagação de falha), além dos comandos administrativos já registrados; 15 testes
do CLI, typecheck e lint passaram.

O comando `handstack plugin install --data <json>` também foi adicionado, usando o endpoint
tenant-scoped de instalação e exigindo payload explícito; o CLI passou a ter 16 testes aprovados.

Na retomada de 2026-09-28, o SDK foi ampliado para os endpoints disponíveis de Knowledge, Privacy,
MCP, Plugins, Secrets e Workflows, com 11 testes, typecheck, lint e build aprovados. O exemplo
normativo de `agents.run('security-review', { repository: '...' })` também foi alinhado: a API
aceita `prompt` ou `repository`, preserva as permissões RBAC efetivas e o teste HTTP confirma a
conversão do repositório em contexto de execução. Isso reduz a lacuna de contrato do SDK, mas não
fecha a exigência mais ampla de E2E completo do SDK/CLI em todos os domínios.

Na continuação da retomada, o SDK também passou a expor os ciclos tenant-scoped de Notifications e
Incidents (listagem, envio/criação, transições, timeline, ações e políticas de escalação), além de
Operations, Settings, Gateway API Keys, Webhooks e Chat Workspace. A suíte focal passou a 15 testes,
com typecheck, lint e build aprovados; a lacuna de E2E real do CLI/SDK permanece aberta.

Na sequência, o SDK passou a expor o Chat Workspace para catálogo de modelos/agentes, conversas,
histórico, mensagens, execução com idempotência, edição/regeneração/retry, cancelamento, replay
SSE de eventos e upload/URL/remoção de anexos multipart. O E2E completo com provider compatível
permanece pendente.

Os seis gates externos agora têm uma matriz operacional em `CERTIFICATION-READINESS.md`, com
pré-requisitos, evidências e critérios de aprovação. A matriz melhora a preparação e a
reprodutibilidade, mas não altera o estado `PENDENTE` sem ambiente implantado e revisão externa.

O runtime administrativo de plugins passou a carregar artefatos `LOCAL`, validar SHA-256, executar
`PluginHost` para lifecycle trusted e persistir a instalação tenant-scoped; o teste de runtime passou.
NPM/GitHub e modo isolado continuam falhando fechadamente sem loader verificado ou RPC sandbox.

O MCP client/API passou a implementar OAuth authorization-code com `state` vinculado a organização,
servidor e principal, expiração de 10 minutos, troca de código por token e armazenamento no vault;
7 testes do MCP client, build/lint/typecheck do pacote e typecheck da API passaram.

Conformance Docker desta rodada: o profile MongoDB foi corrigido para `mongod --replSet rs0`; a
conformance canônica do adapter passou os 6 checks e o teste de Identity Storage MongoDB passou
persistência e rollback. Após os testes, containers, volumes e rede foram removidos; verificações
finais retornaram `containers=none` e `handstack_volumes=none`.

O fluxo também foi coberto no contrato do cliente com rejeição de state reutilizado; os endpoints
HTTP de início e callback estão protegidos por `mcp.use` e delegam o token ao vault. A existência
dos endpoints não substitui ainda um E2E com provedor OAuth externo.

O runtime de workflows deixou de usar um executor pass-through: nós `Agent`, `Capability`, `LLM` e
`MCP` agora delegam aos runtimes governados, preservando organização, principal e cancelamento.
O teste de integração cobre a cadeia Agent → Capability → LLM e o dispatch tenant-scoped de
workflows. Nesta rodada, a execução também passou a resolver as permissões efetivas do principal
via RBAC antes de entrar nos nós Agent, Capability e MCP; o teste `workflow-runtime.test.ts`
verifica a mesma lista `mcp.use` nos três runtimes. Isso elimina o contexto artificial
`permissions: []`, mas não
substitui ainda a prova de execução distribuída e o failover operacional do scheduler.
eventos publicados. O scheduler automático usa uma allow-list explícita ou descobre organizações
ativas pelo adapter com paginação cursor-based, evita overlap e tem shutdown limpo; execução
distribuída por worker e coordenação de ownership entre schedulers continuam pendentes.

O worker passou a aceitar a classe de fila como argumento de processo, compatibilizando os
Deployments Helm (`agents`, `knowledge`, `integrations`, `webhooks`, `auditBilling`, `maintenance`)
com `HANDSTACK_WORKER_QUEUE`; organização e módulo de handlers continuam obrigatórios. O mapa possui
9 handlers, mas a auditoria agora separa os quatro handlers nativos (`audit`, `billing`, `cleanup`,
`webhooks`) dos cinco que apenas delegam para a API (`agents`, `embeddings`, `documents`, `indexing`,
`plugins`); a validação distribuída completa ainda está pendente.

A revisão dos manifests encontrou e corrigiu o mapeamento de classes Helm/Kubernetes para filas
(`knowledge`→`embeddings`, `integrations`→`plugins`, `auditBilling`→`audit`, `maintenance`→`cleanup`).
O chart Helm agora exige explicitamente `workerOrganizationId` e `workerHandlerModule`; sem um
módulo de handlers de domínio real, o worker permanece corretamente fail-closed.

O módulo `apps/worker/src/domain-handlers.ts` possui handlers para as dez filas. Agents, embeddings,
documents, indexing, plugins, webhooks, audit, billing, cleanup e workflow-executions têm handlers
configurados; workflow-executions, assim como diversos jobs de domínio, usa rotas internas
autenticadas. A suíte Redis 7.4 cobre consumo e retry/DLQ sintéticos em todas as filas; permanecem
pendentes falhas específicas dos domínios e prova operacional dos Deployments.

A conferência direta do contrato confirma 10 filas em `packages/jobs/src/index.ts`; os handlers
configurados enviam operações por canal interno autenticado onde a topologia stateless exige acesso à
API. Ainda falta E2E operacional de cada classe com falhas próprias dos domínios.

Foi verificado que o processo worker não recebe `AuditRuntimeService`, repositório ou contrato de
retenção para executar audit/cleanup com segurança. Portanto essas filas permanecem fail-closed;
não são consideradas implementadas por um consumidor genérico ou por execução de comandos externos.

A sincronização de fontes Knowledge agora rejeita URLs não HTTPS, credenciais embutidas, hosts fora
da allowlist opcional e destinos DNS loopback/privados/link-local antes do `fetch`; dois testes de
SSRF passaram. O scheduler por organizações explícitas ou descoberta via adapter foi coberto por
testes; conectores externos nativos e conectores privados permanecem pendentes.

Plugins `LOCAL` agora também suportam upgrade administrativo somente para versões crescentes, com
revalidação do checksum e do `PluginHost`; downgrade e fontes NPM/GitHub continuam bloqueados até
existir loader verificado e execução isolada.

O Agent Builder agora expõe quatro templates first-party e instalação tenant-scoped que cria e
publica uma versão real do agent; o teste de runtime passou. O modelo ainda não resolve
automaticamente a disponibilidade do modelo `smart`, e os canais e integrações avançadas continuam
parciais.

O manifesto estático de Kubernetes agora declara o `handstack-secrets` como recurso externo a ser
preenchido pelo secret manager, referencia-o junto ao `handstack-config` em API, MCP e workers,
e alinha os triggers KEDA ao nome efetivo `HANDSTACK_REDIS_URL`. O gate reproduzível
`npm run kubernetes:validate` confirma 35 documentos, 13 Deployments e 10 KEDA ScaledObjects. Isso
valida o manifesto estático, mas não constitui um exercício operacional de cluster HA.

O Compose inclui `docker/worker.Dockerfile` e consumidores para as dez filas no profile `distributed`;
`docker compose config --quiet` foi validado sem iniciar os serviços. O Kubernetes também declara
consumidores para as dez filas. A aderência operacional completa ainda depende de E2E com falhas
específicas dos domínios e da certificação de carga.

Configuration as Code agora inclui os recursos `Policy` e `Capability`: a API persiste e lista políticas de
autorização por organização, com permissão `policy.manage`, e o CLI aceita `Policy` em `apply`
e `export`; capabilities agora aceitam descritor e publicação com `capability.manage`, e o CLI
aceita `Capability` em `apply` e `export`. O `PersistentPolicyEngine` carrega policies por
organização e preserva precedência de deny; o endpoint `POST /policies/evaluate` e os testes
cobrem esse comportamento. OpenAPI foi regenerado e validado com 175 caminhos.

O registro administrativo de capabilities não inventa handlers: um descritor criado pela API fica
visível no catálogo, mas a execução retorna erro fechado até um runtime/plugin confiável carregar
o handler. Isso atende diretamente ao requisito que proíbe invocar uma implementação durante o
registro; a execução extensível continua coberta pelos runtimes/plugins confiáveis.

A rota de organização `/settings` existe e possui teste HTTP; ela administra branding, locale,
timezone, tema e overrides operacionais persistidos. O `DatabaseService` também carrega a camada
global persistida de `database settings` depois de inicializar o adapter, recusando qualquer tentativa
de trocar o adapter primário ou sua URL nessa fase. `apps/web/tests/settings.test.tsx` agora verifica
a conexão da UI, leitura e gravação autenticadas das configurações globais e organizacionais,
aplicação visual, token mantido fora do DOM e rejeição do adapter primário; os 27 testes Web,
typecheck e lint passaram. A UI/API administrativa dedicada já existe; continua faltando cobrir
todos os parâmetros operacionais e exercitar startup/produção.

Limite identificado na validação: o `PersistentPolicyEngine` agora cobre a fronteira explícita de
avaliação de policies, mas os controllers existentes de identidade/capabilities ainda usam a
autorização administrativa própria baseada em roles e permissions. A substituição global dessas
fronteiras ainda requer integração deliberada e compatibilidade de políticas; portanto o item não
é contado como governança runtime universal completa.

A governança de privacidade também possui teste HTTP de integração para retenção, legal hold,
aprovação de solicitação, exportação sanitizada, consulta do export persistido e liberação do hold.
O runtime percorre as páginas dos repositórios tenant-scoped, preserva registros cobertos por
legal hold durante eliminação e registra evidências; a matriz completa de recursos e os testes
contra MongoDB/ambiente de produção continuam pendentes.

Também foram adicionados recursos persistentes e rotas autorizadas para inventário de dados,
finalidades de processamento, consentimento com retirada, processors e incidentes de privacidade.

O CLI agora oferece `handstack config sync --repo <path> --ref <ref> -f <manifest>`, com teste
que valida a referência Git, lê o arquivo pelo commit/ref e encaminha os recursos ao mesmo caminho
de validação e autorização do `apply`, conforme o fluxo GitOps definido na seção 146.

O comando `npm run graphify` também gera o grafo local com 7.131 nós e 1.835 arestas. A estrutura é
reproduzível e exclui dependências/builds, mas ainda não substitui uma operação Graphify completa
com atualização incremental e consultas integradas ao desenvolvimento.

A seção 152 ganhou `RedTeamCampaignService`: campanhas tenant-scoped exigem os oito vetores
mínimos (jailbreak, injeção indireta, exfiltração, cross-tenant, uso inseguro de tools, agência
excessiva, denial of wallet e poisoning de RAG), persistem findings apenas por digest e registram
sucesso/falha em auditoria. A aprovação de modelo também persiste `ModelApproval`. O gate fail-closed
de publicação foi conectado ao registro de modelos: campanha direcionada ao modelo que não esteja
`PASSED` impede publicar, e ausência de campanhas mantém o fluxo existente. O mesmo gate agora
cobre versões de prompt. Testes de evaluation (5/5), model-registry (9/9) e API model-admin (7/7)
passaram. Os quatro tipos de alvo de campanhas estão agora conectados aos runtimes governados;
comprovar rollback operacional ainda falta.

O MCP Server agora filtra `tools/list` por `requiredPermissions` do principal antes de expor o
catálogo. O teste cobre usuário com e sem a permissão da ferramenta; a execução continua usando
o mesmo engine governado. Isso fecha a filtragem dinâmica local, mas não substitui E2E de conexão,
publicação e autorização contra servidor MCP externo.

Capabilities agora possuem estado explícito de publicação: registros executáveis iniciam
publicados para os canais declarados, descritores administrativos iniciam não publicados, e
`publish` persiste a transição. O MCP só anuncia capabilities com `published=true`, evitando
que descritores sem handler apareçam como tools utilizáveis.

O runtime MCP também persiste e reidrata `McpTool` em `mcp-tools`, além de `McpResource` e
`McpPrompt` em repositórios próprios; as rotas de consulta foram incluídas no OpenAPI, que
passou a validar com 189 caminhos.

A administração Web possui a rota `/red-team`, ligada às APIs tenant-scoped de campanhas,
com formulário de cadastro dos oito vetores normativos e listagem de campanhas/finding digests.
Campanhas para alvos Model e Prompt executam cenários por adapters de provider, verificam oráculos
de contém/não contém e persistem evidência por digest sem gravar resposta bruta; o teste HTTP de
model-admin passou (8/8), exercitando os quatro tipos de alvo. Agent executa a versão publicada pelo
runtime Agent, e Workflow executa o runtime apenas quando publicado para gatilho manual; ambos usam
principal sintético sem permissões. Os testes exercitam todos os vetores e confirmam ausência de
resposta bruta na campanha. O rollback operacional continua pendente.

O armazenamento de workflows agora materializa `WorkflowVersion`, `WorkflowTriggerDefinition` e
`WorkflowCompensation` em repositórios próprios (`workflow-versions`, `workflow-triggers` e
`workflow-compensations`), com teste de persistência; isso reduz a lacuna da seção 129, mas não
fecha a execução distribuída nem as entidades MCP/Plugin ainda ausentes.

O runtime de workflows também persiste a sequência monotônica de cada etapa e invoca
`CompensationProvider` para etapas concluídas em ordem reversa quando uma etapa posterior falha;
falhas da compensação ficam diferenciadas como `workflow_compensation_failed`. A semântica foi
coberta pelos testes do pacote de workflows.

O `PluginType` do SDK agora declara explicitamente `compensation`, alinhando o manifesto de
plugins ao extension point `CompensationProvider` exigido pela especificação; os 14 testes do
SDK passaram.

Na revalidação, foi corrigido o default do `InMemoryCapabilityRegistry`: descritores administrativos
criados via `registerDescriptor` iniciam não publicados também em memória (antes somente a camada
persistente tinha esse comportamento). A prova MCP de publicação passou com 5 testes, e typecheck,
lint e `git diff --check` também passaram.

### Atualização — fila durável para execuções de workflow

A execução assíncrona deixou de rodar em segundo plano dentro do processo API: `startAsync` cria uma
Operation `PENDING` e publica um job tenant-scoped na fila `workflow-executions`. O novo handler do
worker valida a organização e envia o job à rota interna da API; essa rota exige token bearer de no
mínimo 32 caracteres comparado em tempo constante, valida a correspondência entre job e Operation,
e persiste estado/resultados terminais. A fila está incluída no Compose, Helm e Kubernetes, com o
token injetado via Secret nos Deployments aplicáveis.

Evidências executadas: testes de workflow/runtime e HTTP (13), testes de handlers do worker (6),
Jobs (25), typecheck/lint/build da API e worker, validação de Helm/release/Kubernetes, `docker compose
config --quiet` e E2E local: a API publicou a Operation/job, um consumidor BullMQ real processou a fila
em Redis 7 e chamou a rota HTTP autenticada, e o teste confirmou Operation `SUCCEEDED` e execução
`COMPLETED`. O handler de produção tem teste dedicado de tenant, token, heartbeat e checkpoint. O
Redis foi executado num container temporário sem volume próprio e removido ao final; a auditoria
posterior confirmou zero containers e volumes `handstack` no Docker local. Isso ainda não é um
deployment do worker em ambiente distribuído/prod nem prova HA. A lacuna Workflows/Access Grants
permanece `Parcial`; failover de scheduler, retry/DLQ por domínio e exercício operacional dos
Deployments seguem pendentes. A contagem de filas
e handlers do auditor foi ampliada para dez, sem alteração artificial no status dos 105 requisitos
do catálogo ou nas seis certificações externas.

O Model Provider Runtime deixou de ler `HANDSTACK_SECRET_*` diretamente: referências de ambiente
e do vault agora compartilham `SecretRuntimeService`, com escopo `model-provider` e evento de
auditoria `SECRET_ACCESSED`. O teste HTTP de model-admin executou os providers simulados Anthropic e
Gemini e verificou os dois eventos sem expor os valores; 8 testes passaram, junto de typecheck e
lint da API. Isso fecha apenas esse caminho, não a lacuna de uniformização de Secrets para todos os
workers e providers.

`privacy.storePrompts`, `storeResponses` e `storeToolPayloads` agora são conectados dinamicamente do
`DatabaseService` ao `ChatService`. Desativados, prompts do usuário/sistema, respostas do assistente
e payloads de ferramentas preservam somente `id` e `type`; conteúdo deixa de ser gravado nas mensagens,
eventos de stream e histórico. Prompts necessários para a execução permanecem apenas em memória, em
cache limitado a 512 itens e 15 minutos; teste do runtime prova que não aparecem no histórico gravado,
mas ainda chegam ao modelo. Testes unitários e HTTP de integração validam as três opções desligadas e
a alteração de configuração em runtime; build do pacote, testes, typecheck e lint passaram. O gate
`privacy.sendTelemetry` também é respeitado no bootstrap da API, em conjunto com o opt-in operacional
`telemetry.enabled`; teste comprova que nenhum SDK/exporter é inicializado quando o gate de privacidade
está fechado. `privacy.redactPii` agora redige emails, CPFs e telefones reconhecidos em texto, URI e
valores string de objetos `data` de partes do chat; o teste verifica redação antes da persistência e
envio do prompt ao modelo; quando prompts não são persistidos, a cópia transitória também é redigida.
Isso não equivale a detecção abrangente de toda PII nem cobre os demais destinos/runtimes. A
configuração geral permanece parcial; nenhum status de requisito foi promovido.

Na revisão de 2026-09-18, a camada persistida global passou a participar da resolução de settings
por organização, entre arquivo e configuração tenant-scoped. A retenção de conversas ganhou execução
HTTP tenant-scoped e explícita: aplica política `conversations` ou `retention.conversation`, respeita
holds na conversa e nos registros filhos, usa o cascade do Chat para remover anexos locais e grava
evidências consultáveis. A tela `/privacy` agora configura políticas/legal holds e dispara a execução
com confirmação explícita. O scheduler opt-in descobre organizações ativas, coordena por lease CAS
persistido e reconsulta os tenants a cada tick; testes SQLite cobrem disputa entre instâncias,
descoberta e startup habilitado. Execuções completadas aparecem no catálogo de deletion jobs e os
eventos do Chat atribuem a ação ao principal manual ou ao ator de scheduler. Compose/Kubernetes/Helm
o expõem desativado por padrão, e os validadores de deploy passaram. Testes HTTP/Web cobrem exclusão,
hold em registro filho, consentimento da ação e cancelamento; API/Web build/typecheck/lint, OpenAPI
(200 caminhos) e documentação (122 artigos) passaram. Permanecem pendentes retenção de
audit/trace/anexos e as demais lacunas da categoria de configuração; não houve promoção de
status de requisito. A retenção de usage agora também possui executor HTTP tenant-scoped: aplica
`retention.usage`/política `usage-records`, preserva registros sob legal hold, exclui com versão
esperada, mantém isolamento entre organizações e grava evidência por registro e deletion job;
`settings.http.test.ts` cobre o fluxo e o endpoint autenticado. Retenção de audit/trace/anexos e
agendamento específico de usage/anexos ainda permanece pendente. A retenção de anexos também
possui executor HTTP tenant-scoped: remove blobs locais expirados, marca a metadata como `DELETED`
por CAS, respeita legal holds e grava evidência por attachment; o teste HTTP usa o storage local
real e confirma que o blob protegido permanece disponível e o expirado deixa de existir.

Na retomada de 2026-09-18, testes opt-in do Knowledge cobrem o conector S3 e o caminho da API contra
um serviço S3 compatível. O teste ponta a ponta executa pelo scheduler real: MinIO serviu o objeto,
a API gravou a credencial criptografada no vault, resolveu a referência tenant-scoped, ingeriu o
conteúdo no índice e confirmou evidência de acesso no audit sink; também verificou a lease liberada.
O teste do conector verificou conteúdo e ETag. Isso prova apenas esse caminho S3 local: não cobre
OAuth/HTTP externos, os demais conectores nem failover do scheduler implantado; nenhuma evidência de
requisito foi promovida. `HS-AI-015` aponta para os testes e módulos de vault/auditoria/scheduler,
mantendo o status existente. Os containers MinIO temporários foram removidos, sem volumes ou redes.

O scheduler de sincronização Knowledge agora adquire lease CAS persistente por organização,
renova a lease antes de cada fonte, libera após o tenant e impede concorrência entre réplicas; um
teste com duas instâncias sobre SQLite comprova que somente uma sincroniza por vez e que a segunda
assume depois da liberação; o E2E MinIO percorre o mesmo scheduler com credenciais reais de teste.
Compose, Kubernetes e Helm expõem enable/interval/allow-list, com
execução desativada por padrão. Helm, release Helm, Kubernetes, Compose e documentação passaram.
Isso não substitui failover em deployment real; essa evidência permanece pendente.
