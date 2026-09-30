# HandStack --- Technical Architecture & Implementation Plan

## 1. Visão do produto

**HandStack** é uma plataforma open source para criação, execução,
governança e distribuição de capacidades de inteligência artificial para
pessoas, aplicações e agentes.

O HandStack deve combinar em uma única plataforma:

- Frontend de chat completamente customizável e white-label.
- Suporte a múltiplos provedores e modelos LLM.
- LLM Gateway.
- Agent Harness.
- Agents configuráveis.
- Multi-agent orchestration.
- Tools.
- Plugins.
- MCP Client.
- MCP Server.
- Capability Registry.
- Knowledge/RAG.
- Users.
- Organizations.
- Groups.
- RBAC.
- ABAC/policies.
- Budgets.
- Quotas.
- Rate limiting.
- API Keys.
- Service Accounts.
- OAuth/OIDC/SSO.
- Auditoria.
- Observabilidade.
- AI evaluations e model governance.
- Privacy, data lifecycle e compliance extensíveis.
- Secure sandbox para plugins, tools e código não confiável.
- Audit sinks e SIEM exporters plugáveis.
- Incident management e release operations.
- Custos.
- Usage analytics.
- Web interface.
- REST API.
- OpenAI-compatible API.
- MCP endpoint.
- SDK.
- Plugin SDK.
- Admin interface.
- Marketplace/registry de plugins.
- Deploy self-hosted.
- Containerização.
- Kubernetes e Helm para produção distribuída.

A filosofia central do produto é:

> **Build once. Govern once. Expose everywhere.**

Uma capability criada no HandStack deverá poder ser disponibilizada
pelos mesmos mecanismos de autorização através de:

- Web
- API
- MCP
- Agent-to-Agent

---

## 2. Conceito central: Capability

O principal objeto conceitual do HandStack não deve ser `Chat`, `Agent`
ou `MCP`.

Deve ser:

```text
Capability
```

Uma Capability representa alguma coisa que o HandStack consegue executar
ou disponibilizar.

Exemplos:

```text
github.search_code
github.create_issue
security.review_code
knowledge.architecture.search
support.answer_customer
data.sales.query
agent.coding
workflow.release_review
```

Toda Capability possui:

```text
id
slug
name
description
type
inputSchema
outputSchema
executionHandler
requiredPermissions
allowedChannels
budgetPolicy
timeout
visibility
version
owner
organization
metadata
createdAt
updatedAt
```

`allowedChannels`:

```text
WEB
API
MCP
INTERNAL
AGENT
```

Isso permite que uma mesma capability seja publicada em vários canais.

Exemplo:

```text
Capability:
security.review_code

WEB:
botão "Security Review"

API:
POST /v1/capabilities/security.review_code/run

MCP:
security_review_code

AGENT:
tool disponível para outros agents
```

Todos chamam o mesmo runtime.

---

## 3. Princípios arquiteturais

### 3.1 Monólito modular com execução distribuída

O HandStack deve manter um **modular monolith** no código e oferecer dois
perfis oficiais de implantação do produto completo:

```text
compact
distributed
```

`compact` executa API, UI e worker em uma instalação simples para ambientes
pequenos. `distributed` executa Web, API, MCP e grupos de Workers como
processos independentes, replicáveis horizontalmente em Kubernetes.

O modo distribuído é requisito do produto final e não uma possibilidade
posterior. Ambos os perfis usam o mesmo domínio, os mesmos contratos e as
mesmas funcionalidades.

Motivos:

- desenvolvimento open source mais simples;
- instalação local simples;
- debugging mais fácil;
- contribuição comunitária mais simples;
- menor complexidade operacional;
- escalabilidade horizontal sem fragmentar prematuramente o domínio.

Os módulos devem possuir boundaries claros. Processos de execução podem
ser separados por responsabilidade e carga, mas nenhuma regra de negócio
pode existir somente em um perfil de implantação.

No modo distribuído, Web, API e MCP devem ser stateless. Sessões,
coordenação, rate limits, streams e filas ficam em serviços compartilhados.
Arquivos e artefatos ficam em `StorageProvider` externo. Nenhum pod pode
depender de memória ou disco local para estado necessário após restart.

---

## 4. Stack tecnológica

### Backend

```text
Node.js LTS
TypeScript
NestJS
Fastify Adapter
TypeORM
MongoDB Node.js Driver
Zod
```

NestJS será usado para:

- dependency injection
- modules
- controllers
- guards
- interceptors
- WebSockets
- background workers
- testing
- OpenAPI

Fastify como HTTP engine.

---

## 5. Bancos de dados

### Camada de persistência

Para bancos relacionais, o adapter padrão utiliza:

```text
TypeORM
```

Para MongoDB, o adapter oficial utiliza:

```text
MongoDB Node.js Driver
```

TypeORM não é a abstração canônica de persistência do HandStack. A
abstração canônica é composta pelos contratos de Repository e de
transação definidos pela camada de domínio/aplicação.

Portanto:

**nenhuma regra de negócio poderá depender diretamente do TypeORM, do
MongoDB Driver ou de conceitos específicos de SQL ou documentos.**

Implementar Repository Pattern:

```text
Domain
   │
   ▼
Repository Interface
   │
   ├──► TypeORM Repository Adapter ──► SQL Database
   │
   └──► Mongo Repository Adapter ────► MongoDB
```

Exemplo:

```typescript
export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  save(user: User): Promise<User>;
}
```

Implementação:

```typescript
export class TypeOrmUserRepository implements UserRepository {}
export class MongoUserRepository implements UserRepository {}
```

Adapters adicionais permitidos:

```text
PrismaAdapter
DrizzleAdapter
RemoteAdapter
```

sem alterar o domínio.

### Paridade entre SQL e MongoDB

MongoDB deve poder ser escolhido como banco principal exclusivo do
HandStack, sem exigir um banco SQL complementar.

Todas as entidades e funcionalidades disponíveis nos adapters SQL devem
ser suportadas pelo adapter MongoDB, incluindo:

```text
identity and organizations
users, groups, roles, permissions and policies
sessions, API keys and service accounts
providers and model registry
conversations and messages
agents, capabilities and workflows
MCP and plugin metadata
knowledge metadata and documents
budgets, reservations, usage and costs
approvals, notifications and webhooks
secrets metadata, audit and feature flags
```

É proibido implementar uma funcionalidade de domínio somente no adapter
SQL. Cada novo Repository e cada alteração de contrato devem possuir
implementação e testes de paridade para MongoDB.

O modelo de domínio e as APIs públicas devem produzir o mesmo
comportamento observável independentemente do banco selecionado. Diferenças
internas de modelagem, joins, agregações e índices ficam encapsuladas no
adapter.

### Transações e consistência no MongoDB

Operações que alteram múltiplas entidades de forma atômica devem usar
transactions/sessions do MongoDB. Isso inclui, no mínimo:

```text
budget reservation and settlement
membership and permission changes
agent/capability version publication
provisioning and deprovisioning
idempotent capability execution records
```

MongoDB em produção deve operar como replica set ou sharded cluster para
suportar transações multi-documento. Uma instalação standalone poderá ser
usada somente em desenvolvimento quando a operação não exigir transação
multi-documento; caso contrário, o startup/health check deve falhar com
orientação clara.

Concorrência crítica deve usar operações atômicas, versionamento otimista
ou transações, mantendo as mesmas garantias dos adapters SQL.

### Schema, índices e evolução no MongoDB

Apesar de MongoDB ser flexível, collections oficiais devem possuir schema
validation, versão de documento e índices gerenciados pelo HandStack.

Toda collection tenant-owned deve incluir `organizationId` e índices
compostos adequados. Identificadores e slugs únicos devem respeitar o
escopo da Organization.

Mudanças de schema devem usar migrations de documentos idempotentes,
retomáveis e observáveis, executadas pelo mesmo mecanismo de upgrade usado
pelos bancos SQL.

### Bancos oficialmente suportados

Tier 1:

```text
PostgreSQL
MySQL
MariaDB
SQLite
Microsoft SQL Server
MongoDB
```

PostgreSQL deverá ser o banco recomendado para produção.

SQLite deverá permitir uma instalação sem infraestrutura adicional.

MongoDB deverá ser uma alternativa de produção de primeira classe para
instalações que prefiram persistência documental. Ele poderá armazenar
todo o estado do HandStack, e não apenas mensagens, documentos ou eventos.

---

## 6. IDs

Não usar integer sequencial.

Usar:

```text
UUID v7
```

para todas as entidades.

No MongoDB, UUID v7 continua sendo o identificador público e canônico.
`ObjectId` não pode aparecer em contratos de domínio, APIs, eventos ou
referências entre entidades. O adapter deve definir uma representação UUID
consistente para `_id` e para referências, preservando ordenação e
portabilidade entre bancos.

Motivos:

- distribuição
- sorting temporal
- segurança
- migração
- operação multi-region

---

## 7. Monorepo

Usar:

```text
npm
Turborepo
```

Estrutura:

```text
handstack/

apps/
  api/
  web/
  docs/
  worker/
  mcp/
  cli/

packages/
  core/
  domain/
  database/
    contracts/
    typeorm/
    mongodb/
    migrations/
  auth/
  policy/
  llm/
  agents/
  capabilities/
  mcp-client/
  mcp-server/
  plugins/
  plugin-sdk/
  knowledge/
  budgets/
  audit/
  telemetry/
  docs-engine/
  sdk/
  ui/
  shared/
  config/

plugins/
  openai/
  anthropic/
  gemini/
  ollama/
  github/
  jira/
  slack/
  langfuse/
  identity-oidc/
  identity-saml/
  identity-ldap/
  identity-entra/
  identity-okta/
  identity-keycloak/
  identity-auth0/
  identity-google-workspace/
  coding-agent/
  security-agent/

examples/
docs/
  content/
    en/
    pt-BR/
  adr/
  api/
  assets/
docker/
graphify-out/       # generated development knowledge graph; never shipped
deploy/
  docker-compose/
  kubernetes/
  helm/
```

---

## 8. Frontend

Usar:

```text
Next.js
React
TypeScript
Tailwind
shadcn/ui
TanStack Query
Zustand
```

Não acoplar regras de negócio ao Next.js.

Frontend deve consumir API pública do HandStack.

---

## 9. White-label / Branding

Cada Organization pode possuir:

```text
name
displayName
logo
favicon
primaryColor
secondaryColor
accentColor
backgroundColor
font
loginBackground
customCss
customDomain
productName
welcomeMessage
legalLinks
supportUrl
```

Exemplos de branding:

```text
HandStack
Acme AI
PrimeUp AI
MyCompany Copilot
```

sem fork do código.

---

## 10. Sistema de temas

Criar design tokens:

```text
--hs-primary
--hs-secondary
--hs-accent
--hs-background
--hs-surface
--hs-text
--hs-border
```

Suportar:

```text
light
dark
system
custom
```

---

## 11. Chat

O chat deve suportar:

- streaming
- markdown
- syntax highlighting
- code blocks
- attachments
- images
- audio
- files
- tool calls
- agent events
- reasoning summaries
- citations
- artifacts
- message branches
- regenerate
- edit
- retry
- fork conversation
- model switch
- agent switch

Entidades:

```text
Conversation
ConversationParticipant
Message
MessagePart
Attachment
ToolCall
ToolResult
Artifact
Citation
```

---

## 12. Message model

Não armazenar somente `role` e `content`.

Usar estrutura multimodal.

```typescript
Message {
  id
  conversationId
  role
  parts: MessagePart[]
  model
  provider
  inputTokens
  outputTokens
  cost
  latency
  traceId
  createdAt
}
```

MessagePart:

```text
text
image
audio
file
tool_call
tool_result
reasoning
citation
artifact
error
```

---

## 13. LLM Provider abstraction

Criar interface:

```typescript
interface LLMProvider {
  listModels(): Promise<Model[]>;
  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<ChatEvent>;
  embeddings?(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  imageGeneration?(...args: unknown[]): Promise<unknown>;
  audioTranscription?(...args: unknown[]): Promise<unknown>;
}
```

Implementações iniciais:

```text
OpenAI
Anthropic
Google Gemini
Azure OpenAI
AWS Bedrock
OpenRouter
Ollama
vLLM
OpenAI-compatible
```

---

## 14. Model Registry

Não referenciar diretamente modelos externos nas regras de negócio.

Criar:

```text
ModelDefinition
```

Exemplo:

```text
id:
model-coding-large

displayName:
Coding Large

provider:
anthropic

providerModel:
claude-...

capabilities:
chat
vision
tools

contextWindow:
...

pricing:
...
```

Aliases:

```text
fast
smart
cheap
coding
reasoning
```

---

## 15. Model Routing

Criar Routing Policies.

Estratégias:

```text
fallback
round_robin
least_cost
least_latency
weighted
priority
random
custom
semantic routing
```

---

## 16. AI Gateway

Criar endpoint compatível com OpenAI:

```text
POST /v1/chat/completions
GET /v1/models
POST /v1/embeddings
POST /v1/responses
```

Isso permitirá usar HandStack com:

```text
OpenAI SDK
LangChain
LlamaIndex
Cursor
scripts existentes
```

alterando apenas `baseURL` e `apiKey`.

---

## 17. Virtual API Keys

Usuários, applications e service accounts podem criar keys.

Formato:

```text
hs_live_xxxxxxxxx
hs_test_xxxxxxxxx
```

Nunca armazenar a key completa.

Armazenar:

```text
keyPrefix
hash
owner
organization
permissions
models
budget
rateLimits
expiresAt
lastUsedAt
createdAt
```

---

## 18. Agent Harness

Agents devem ser entidades de primeira classe.

```typescript
Agent {
  id
  organizationId
  name
  slug
  description
  systemPrompt
  modelStrategy
  tools
  mcpServers
  knowledgeBases
  memoryConfig
  guardrails
  maxIterations
  maxTokens
  timeout
  budget
  humanApprovalPolicy
  visibility
  version
  createdBy
}
```

---

## 19. Agent runtime loop

Fluxo:

```text
START
  │
  ▼
Build Context
  │
  ▼
Policy Check
  │
  ▼
Budget Reservation
  │
  ▼
LLM
  │
  ├── final response → END
  │
  └── tool call
          │
          ▼
     Permission Check
          │
          ▼
     Human Approval?
          │
          ▼
     Tool Execution
          │
          ▼
     Tool Result
          │
          └──────► LLM
```

---

## 20. Agent Events

Runtime deve gerar eventos:

```text
agent.started
agent.model.started
agent.model.completed
agent.tool.requested
agent.tool.approved
agent.tool.denied
agent.tool.started
agent.tool.completed
agent.tool.failed
agent.step.started
agent.step.completed
agent.budget.warning
agent.budget.exceeded
agent.completed
agent.failed
```

Esses eventos alimentam:

```text
UI
audit
telemetry
webhook
stream API
```

---

## 21. Agent versioning

Nunca sobrescrever Agent publicado.

Criar:

```text
Agent
AgentVersion
```

Estados:

```text
draft
published
deprecated
```

---

## 22. Multi-Agent

Agents poderão chamar outros agents.

Um agent pode ser publicado como Tool.

Exemplo:

```text
Supervisor Agent
    │
    ├── Coding Agent
    ├── Security Agent
    └── Documentation Agent
```

---

## 23. Agent orchestration

Suportar:

```text
Sequential
Parallel
Supervisor
Handoff
graph workflow
```

---

## 24. Human-in-the-loop

Uma tool/capability pode exigir aprovação.

Entidade:

```text
ApprovalRequest
```

Estados:

```text
PENDING
APPROVED
DENIED
EXPIRED
CANCELLED
```

---

## 25. MCP Client

HandStack deve funcionar como MCP Host/Client.

Usar o SDK oficial TypeScript do Model Context Protocol.

Suportar:

```text
Streamable HTTP
stdio
```

Cada MCP Server cadastrado terá:

```text
name
description
transport
endpoint
command
arguments
environment
authentication
status
owner
organization
```

---

## 26. MCP discovery

Ao conectar MCP:

```text
tools/list
resources/list
prompts/list
```

Criar:

```text
McpServer
McpTool
McpResource
McpPrompt
```

---

## 27. MCP permissions

Permissão deve chegar a nível de tool.

```text
mcp.github.access
mcp.github.tool.search_code
mcp.github.tool.create_issue
mcp.github.tool.delete_repository
```

---

## 28. MCP authentication

Suportar:

```text
none
API key
Bearer token
OAuth 2
OIDC
custom headers
```

Credentials criptografadas.

---

## 29. Per-user MCP credentials

Permitir credenciais por usuário.

Exemplo:

```text
User A → GitHub OAuth Token A
User B → GitHub OAuth Token B
```

Agent executado em nome de um usuário usa as credenciais daquele
usuário.

---

## 30. MCP Server --- MCP OUT

Endpoint:

```text
/mcp
```

Opcionalmente:

```text
/mcp/:organization
```

O HandStack deve publicar capabilities através do MCP.

---

## 31. Publish as MCP

Qualquer:

```text
Agent
Tool
Workflow
Knowledge Search
Capability
```

pode possuir:

```text
Publish as MCP = true
```

---

## 32. Capability Registry

Criar:

```text
CapabilityRegistry
```

Todos os tools, agents, workflows, knowledge e plugins registram
capabilities.

API interna:

```typescript
listCapabilities();
getCapability();
executeCapability();
authorizeCapability();
publishCapability();
```

---

## 33. Plugin System

Plugins são fundamentais.

Um plugin deve ser pacote independente.

Exemplo:

```text
@handstack/plugin-github
```

Manifest:

```json
{
  "name": "@handstack/plugin-github",
  "version": "1.0.0",
  "handstack": {
    "apiVersion": "1",
    "capabilities": ["tools", "oauth", "mcp", "ui"]
  }
}
```

---

## 34. Tipos de Plugin

```text
provider
tool
mcp
agent
auth
identity
identity-provider
provisioning
guardrail
evaluation
compliance
privacy
data-lifecycle
sandbox
audit-export
siem
webhook-delivery
incident-management
workflow-node
rag-policy
knowledge
storage
observability
ui
workflow
```

---

## 35. Plugin lifecycle

Hooks:

```typescript
onInstall();
onEnable();
onDisable();
onUninstall();

onServerStart();
onServerStop();

onUserLogin();

beforeLLMCall();
afterLLMCall();

beforeToolCall();
afterToolCall();

beforeAgentRun();
afterAgentRun();
```

---

## 36. Plugin SDK

Criar:

```text
@handstack/plugin-sdk
```

Exemplo:

```typescript
export default definePlugin({
  manifest: {...},
  setup(ctx) {
    ctx.tools.register(...);
    ctx.capabilities.register(...);
    ctx.ui.register(...);
  },
});
```

---

## 37. Plugin isolation

Plugins da comunidade não devem executar arbitrariamente no processo
principal.

Modes:

```text
trusted
isolated
```

Trusted:

```text
official plugins
in-process
```

Isolated:

```text
community plugins
worker/container
RPC
```

---

## 38. Plugin permissions

Manifest declara:

```text
network
filesystem
secrets
database
user_identity
mcp
models
```

Admin aprova durante instalação.

---

## 39. Marketplace

Catálogos obrigatórios:

```text
Official
Community
Installed
Updates
```

Plugin Registry API:

```text
GET /registry/plugins
GET /registry/plugins/:name
```

Fontes de instalação suportadas:

```text
npm package
GitHub URL
local directory
```

---

## 40. Identity

Tipos:

```text
USER
SERVICE_ACCOUNT
APPLICATION
AGENT
API_KEY
```

Todos são:

```text
Principal
```

Conceito:

```text
Principal → Policy → Resource → Action
```

---

## 41. Organizations

HandStack deve ser multi-tenant desde o modelo de dados.

Todo objeto tenant-owned deve possuir `organizationId`.

---

## 42. Users

Criar:

```text
User
OrganizationMembership
```

---

## 43. Groups

Criar:

```text
Group
GroupMembership
```

Groups podem conter:

```text
users
service accounts
agents
```

---

## 44. RBAC

Roles sugeridas:

```text
SYSTEM_ADMIN
ORG_ADMIN
AI_ADMIN
DEVELOPER
MEMBER
VIEWER
BILLING_ADMIN
SECURITY_ADMIN
```

Mas não hardcode tudo.

Criar:

```text
Role
Permission
RolePermission
PrincipalRole
```

---

## 45. Permission model

Formato:

```text
resource.action
```

Exemplos:

```text
agent.read
agent.create
agent.execute
model.use
mcp.use
mcp.tool.execute
plugin.install
user.manage
budget.manage
```

---

## 46. ABAC / Policy Engine

Adicionar policy conditions além de RBAC.

Exemplo:

```yaml
allow:
  resource: mcp.database.production
  action: execute

conditions:
  group: developers
  time:
    from: '08:00'
    to: '18:00'
```

---

## 47. Policy Engine

```typescript
interface PolicyEngine {
  authorize(input: AuthorizationRequest): Promise<AuthorizationDecision>;
}
```

Resposta:

```typescript
{
  allowed: boolean,
  reason?: string,
  obligations?: [],
  policyIds?: []
}
```

---

## 48. Authentication

Suportar:

```text
local username/password
OIDC
OAuth2
SAML
LDAP
SCIM
```

OIDC:

```text
Keycloak
Azure Entra ID
Okta
Auth0
Google Workspace
```

---

## 49. SSO group mapping

Mapear claims de grupos externos para grupos do HandStack.

---

## 50. Sessions

Usar:

```text
short-lived access token
secure refresh token
httpOnly cookie para frontend
```

Nunca armazenar auth token em localStorage.

---

## 51. Budget Engine

Scopes:

```text
Organization
Group
User
Agent
API Key
Application
Model
Provider
Capability
```

---

## 52. Budget periods

```text
daily
weekly
monthly
custom
```

---

## 53. Budget strategies

```text
hard limit
soft limit
alert only
```

---

## 54. Budget reservation

Fluxo:

```text
estimate
↓
reserve
↓
execute
↓
settle actual cost
```

Entidades:

```text
Budget
BudgetReservation
UsageRecord
CostRecord
```

---

## 55. Pricing

Criar:

```text
ProviderPricing
ModelPricing
```

Campos:

```text
inputTokenPrice
outputTokenPrice
cachedInputPrice
imagePrice
audioPrice
requestPrice
```

Pricing versionado por data.

---

## 56. Rate limiting

Scopes:

```text
organization
group
user
API key
agent
model
capability
```

Métricas:

```text
RPM
TPM
concurrent requests
daily requests
```

---

## 57. Redis

Redis:

```text
optional development dependency
required distributed production dependency
```

Usado para:

```text
rate limiting
distributed locks
cache
session optional
queues
agent coordination
stream coordination
```

Produção distribuída deve usar Redis gerenciado ou uma topologia de alta
disponibilidade com failover automático, persistência e pelo menos três
nós de quorum. O sistema deve suportar Redis Sentinel e Redis Cluster
através de configuração explícita.

Locks distribuídos não podem ser a única garantia de correção de operações
financeiras, budgets ou publicação de versões. Essas operações devem usar
constraints, compare-and-set, fencing tokens ou transações no banco.

---

## 58. Background Jobs

Usar BullMQ.

Queues:

```text
agents
embeddings
documents
plugins
webhooks
audit
billing
cleanup
indexing
```

Worker:

```text
apps/worker
```

No modo distribuído, cada classe de carga deve poder ser executada em um
Deployment independente:

```text
worker-agents
worker-knowledge
worker-integrations
worker-webhooks
worker-audit-billing
worker-maintenance
```

Filas devem possuir prioridade, concurrency configurável, retries com
backoff e jitter, timeout, idempotency key, dead-letter queue, retenção e
limite máximo de backlog. Quando o limite for atingido, o sistema deve
aplicar backpressure e rejeitar novas solicitações com erro tipado e
`Retry-After`, sem consumir memória indefinidamente.

Workers devem concluir ou devolver o job à fila durante graceful shutdown.
Jobs longos devem emitir heartbeat, checkpoint e suportar cancelamento.

---

## 59. Knowledge / RAG

Entidades:

```text
KnowledgeBase
Document
DocumentVersion
Chunk
Embedding
DataSource
```

---

## 60. Data sources

Fontes nativas:

```text
file upload
URL
text
```

Plugins:

```text
Google Drive
SharePoint
Confluence
Notion
GitHub
S3
Database
```

---

## 61. Vector Database abstraction

```typescript
interface VectorStore {
  upsert();
  delete();
  search();
}
```

Adapters:

```text
pgvector
MongoDB Atlas Vector Search
Qdrant
Pinecone
Weaviate
Chroma
```

Default:

```text
pgvector quando PostgreSQL estiver disponível
MongoDB Atlas Vector Search quando habilitado em uma instalação MongoDB
Qdrant ou Chroma nos demais cenários
```

O uso de MongoDB como banco principal não pode depender de Atlas Vector
Search. Knowledge/RAG deve continuar funcional através de qualquer adapter
`VectorStore` configurado.

---

## 62. Embedding abstraction

```text
OpenAI
Gemini
local
Ollama
```

---

## 63. Chunking

Configuração por Knowledge Base:

```text
chunkSize
chunkOverlap
strategy
metadataExtraction
```

---

## 64. Conversations + Knowledge

Chat pode selecionar Knowledge Bases.

Agents podem definir Knowledge Bases permanentes.

---

## 65. Secrets

Criar:

```text
Secret
SecretProvider
```

Plugins não acessam secrets diretamente.

Usar:

```text
ctx.secrets.get("github.token")
```

---

## 66. Secret providers

```text
encrypted database
environment variables
Hashicorp Vault
AWS Secrets Manager
Azure Key Vault
GCP Secret Manager
```

---

## 67. Encryption

Master key:

```text
HANDSTACK_MASTER_KEY
```

Secrets:

```text
AES-256-GCM
```

Nunca logar secrets.

---

## 68. Audit Log

Eventos:

```text
USER_LOGIN
MODEL_USED
AGENT_EXECUTED
TOOL_EXECUTED
MCP_TOOL_EXECUTED
ACCESS_DENIED
PLUGIN_INSTALLED
SECRET_ACCESSED
BUDGET_EXCEEDED
POLICY_CHANGED
USER_CREATED
```

---

## 69. Audit event

```typescript
AuditEvent {
  id
  timestamp
  organizationId
  actorId
  actorType
  action
  resourceType
  resourceId
  decision
  ip
  userAgent
  traceId
  metadata
}
```

Audit append-only.

---

## 70. Observability

OpenTelemetry desde o início.

Instrumentar:

```text
HTTP
database
Redis
LLM
agent
tool
MCP
plugin
queue
```

---

## 71. Traces

Exemplo:

```text
Chat Request
  └ Agent Run
       └ Model Call
       └ Tool Call
            └ MCP
                 └ GitHub
       └ Model Call
```

Tudo relacionado por `traceId`.

---

## 72. Metrics

```text
handstack_requests_total
handstack_llm_requests_total
handstack_tokens_input_total
handstack_tokens_output_total
handstack_cost_total
handstack_agent_runs_total
handstack_tool_calls_total
handstack_mcp_calls_total
handstack_policy_denied_total
handstack_plugin_errors_total
```

---

## 73. Observability plugins

Permitir:

```text
OpenTelemetry OTLP
Langfuse
Datadog
Grafana
New Relic
```

---

## 74. Usage Dashboard

Dashboard organization:

```text
Total spend
Spend per provider
Spend per model
Spend per user
Spend per agent
Spend per group
Token consumption
Requests
Latency
Errors
```

---

## 75. User Dashboard

Usuário vê:

```text
monthly budget
current spend
model usage
agent usage
recent chats
API keys
Help Center
```

---

## 76. Admin UI

Navegação:

```text
Dashboard
Chat
Agents
Capabilities
Models
Knowledge
MCP
Plugins
Users
Groups
Roles
Budgets
API Keys
Audit
Usage
Settings
Help Center
```

O item `Help Center` deve estar sempre disponível na navegação do usuário
e do administrador. Telas e formulários devem oferecer links contextuais
`?` para o artigo e a âncora correspondentes à ação atual.

---

## 77. Chat Workspace

Sidebar:

```text
New Chat
Conversations
Agents
Saved Prompts
```

Topbar:

```text
Model
Agent
Knowledge
Tools
```

---

## 78. Agent Builder UI

Tabs:

```text
General
Prompt
Model
Tools
MCP
Knowledge
Memory
Guardrails
Budget
Permissions
Publishing
Versions
```

---

## 79. Agent Publishing

```text
Available through

☑ Web
☑ REST API
☑ MCP
☑ Agent Tool
```

---

## 80. Capability Catalog

Usuário vê somente capabilities permitidas.

---

## 81. Access Requests

Campos:

```text
resource
reason
duration
ticket/reference
```

---

## 82. Access grants

Permissões temporárias:

```text
1 hour
4 hours
24 hours
7 days
permanent
```

Entidade:

```text
AccessGrant
```

---

## 83. Notifications

```text
NotificationProvider
```

Providers nativos:

```text
in-app
email SMTP
webhook
```

Plugins:

```text
Slack
Teams
Discord
```

---

## 84. Webhooks

Eventos:

```text
agent.completed
budget.threshold
access.requested
access.approved
plugin.installed
user.created
```

Webhook:

```text
HMAC signed
retry
dead-letter
```

---

## 85. REST API

Versionar:

```text
/api/v1
```

Domínios:

```text
/auth
/users
/groups
/roles
/models
/providers
/chats
/conversations
/agents
/capabilities
/tools
/mcp
/plugins
/knowledge
/budgets
/usage
/audit
/settings
```

---

## 86. Public Agent API

```text
POST /api/v1/agents/:id/run
POST /api/v1/agents/:id/stream
```

---

## 87. Capability API

```text
GET /api/v1/capabilities
GET /api/v1/capabilities/:slug
POST /api/v1/capabilities/:slug/run
```

---

## 88. API schemas

Usar Zod como schema canônico quando possível.

Gerar:

```text
OpenAPI
JSON Schema
MCP schemas
SDK types
```

---

## 89. SDK

Criar:

```text
@handstack/sdk
```

Exemplo:

```typescript
const hs = new HandStack({
  baseUrl,
  apiKey,
});

await hs.agents.run('security-review', {
  repository: '...',
});
```

---

## 90. CLI

Package:

```text
@handstack/cli
```

Comandos:

```text
handstack init
handstack start
handstack doctor
handstack migrate
handstack user create
handstack plugin install
handstack plugin list
handstack agent list
handstack capability list
handstack mcp serve
```

---

## 91. Configuration

Hierarquia:

```text
environment
config file
database settings
organization settings
```

Arquivo:

```text
handstack.config.ts
```

Seleção explícita do adapter:

```typescript
export default defineConfig({
  database: {
    adapter: 'mongodb', // postgresql | mysql | mariadb | sqlite | sqlserver | mongodb
    url: process.env.HANDSTACK_DATABASE_URL,
  },
});
```

Uma instalação deve configurar exatamente um banco primário. O comando
`handstack doctor` deve validar conexão, versão suportada, transactions,
schema/collections, migrations e índices antes do startup em produção.

---

## 92. Feature Flags

Criar feature flag service:

```text
global
organization
user
```

---

## 93. Storage abstraction

```typescript
StorageProvider {
  put()
  get()
  delete()
  signedUrl()
}
```

Adapters:

```text
Local
S3
Cloudflare R2
Azure Blob
GCS
```

---

## 94. File security

Uploads:

```text
size limits
mime validation
extension validation
malware integration hook
random filenames
isolated storage
```

---

## 95. Memory

Agent memory:

```text
NONE
SESSION
USER
AGENT
ORGANIZATION
```

Criar `MemoryStore` abstraction.

---

## 96. Guardrails

Pipeline:

```text
input guardrails
→ model
→ tool guardrails
→ output guardrails
```

Plugins podem registrar guardrails.

Exemplos:

```text
PII detection
prompt injection
content policies
secret detection
tool argument policies
custom regex
```

---

## 97. Prompt management

Criar:

```text
Prompt
PromptVersion
```

Suportar:

```text
variables
versioning
draft/published
permissions
```

---

## 98. Workflows

Workflow:

```text
Trigger
Nodes
Edges
Conditions
```

Nodes:

```text
Agent
Capability
LLM
Tool
MCP
Condition
Human Approval
```

---

## 99. Workflow runtime

Persistir:

```text
WorkflowExecution
WorkflowStepExecution
```

Permitir resume após aprovação humana.

---

## 100. Triggers

```text
manual
API
webhook
schedule
event
```

---

## 101. Security architecture

Aplicar:

```text
zero trust entre módulos críticos
deny by default
least privilege
tenant isolation
secret isolation
tool-level authorization
```

---

## 102. Tenant isolation

Criar request context:

```typescript
ExecutionContext {
  principalId
  organizationId
  requestId
  traceId
}
```

Repositories recebem context.

Evitar `findAll()` sem organization scope.

---

## 103. Security against IDOR

Sempre consultar:

```text
resource.id
AND
resource.organizationId
```

---

## 104. SSRF protection

Implementar:

```text
private IP block
localhost block
metadata endpoints block
DNS rebinding protection
allowlists opcionais
```

---

## 105. MCP security

Antes de qualquer MCP tool call:

```text
authenticate
authorize server
authorize tool
validate schema
check budget
check approval
execute
sanitize output
audit
```

---

## 106. Plugin supply-chain security

Plugin registry armazena:

```text
package
version
checksum
signature
publisher
permissions
```

---

## 107. Dependency policy

Não permitir plugins instalarem dependências no processo principal em
runtime.

---

## 108. API security

Implementar:

```text
CORS
CSRF
rate limits
security headers
request size limits
schema validation
API key hashing
refresh token rotation
```

---

## 109. Passwords

Usar:

```text
Argon2id
```

---

## 110. Data retention

Configurar:

```text
conversation retention
audit retention
usage retention
trace retention
attachments retention
```

---

## 111. Privacy

Admin define:

```text
store prompts?
store responses?
store tool payloads?
redact PII?
send telemetry?
```

---

## 112. Provider privacy

Criar:

```text
dataClassificationAllowed
```

Classificações:

```text
PUBLIC
INTERNAL
CONFIDENTIAL
RESTRICTED
```

Policies podem impedir envio de dados restritos para providers externos.

---

## 113. Testing

Tipos:

```text
unit
integration
contract
E2E
security
property-based
fuzz
resilience
chaos
accessibility
visual regression
AI evaluation regression
plugin compatibility
database compatibility
```

---

## 114. Database test matrix

CI:

```text
PostgreSQL
MySQL
MariaDB
SQLite
SQL Server
MongoDB replica set
```

A mesma suíte de contratos deve validar comportamento, autorização,
isolamento de tenant, concorrência, paginação, ordenação, unicidade e
transações em todos os adapters. MongoDB deve executar também testes de
migration de documentos, índices e schema validation.

---

## 115. Provider contract tests

Todo `LLMProvider` deve passar:

```text
chat
stream
tool calls
errors
timeouts
usage extraction
```

---

## 116. Plugin contract tests

Criar:

```text
@handstack/plugin-testkit
```

O test kit deve validar manifest, apiVersion, permissions, configuration
schema, tenant isolation, timeout, cancellation, health, audit,
observability, resource limits, fail-closed behavior e compatibilidade.

Suites especializadas obrigatórias:

```text
PolicyProvider
GuardrailProvider
EvaluationProvider
Privacy/DataLifecycle providers
SandboxProvider
AuditSinkProvider and SiemExporterProvider
KnowledgeConnectorProvider and RagPolicyProvider
WorkflowNodeProvider and CompensationProvider
WebhookTransportProvider
IncidentManagementProvider and StatusPageProvider
```

---

## 117. MCP contract tests

Testar:

```text
initialize
tools/list
tools/call
resources/list
prompts/list
auth
disconnect
reconnect
```

---

## 118. Agent deterministic tests

Criar `FakeLLMProvider`.

Testar:

```text
tool execution
loops
budget
permissions
handoffs
approvals
```

---

## 119. CI/CD

GitHub Actions:

```text
lint
typecheck
unit tests
integration tests
database matrix
build
Docker image
security scan
dependency scan
SBOM generation
container and release artifact signing
build provenance attestation
secret scan
threat-model validation
Graphify structural graph validation
documentation build and quality gates
distributed deployment tests
load and queue saturation tests
zero-downtime upgrade test
```

O CI não deve executar extração semântica paga em cada pull request. A
validação obrigatória deve ser determinística e estrutural; rebuilds
semânticos completos podem rodar de forma agendada ou sob demanda.

---

## 120. Versionamento

Usar Semantic Versioning.

---

## 121. Release channels

```text
nightly
beta
stable
```

---

## 122. Docker

Imagem principal:

```text
handstack/handstack
```

Dev:

```text
docker compose up
```

Produção:

```text
web
api
mcp
specialized workers
Redis HA
SQL HA cluster ou MongoDB sharded/replica cluster
object storage
```

Os exemplos oficiais de Docker Compose devem oferecer profiles separados
para PostgreSQL e MongoDB, sem iniciar os dois quando apenas um for
selecionado.

---

## 123. Single-container development

Permitir:

```text
docker run handstack/handstack
```

subindo:

```text
API
UI
SQLite
```

sem Redis.

---

## 124. Kubernetes

Kubernetes e Helm são formas oficiais e completas de implantação em
produção, não itens posteriores.

Estrutura mínima:

```text
Ingress / Gateway
web Deployment + Service + HPA
api Deployment + Service + HPA
mcp Deployment + Service + HPA
worker Deployments + KEDA ScaledObjects
Redis HA or managed Redis
external SQL cluster or MongoDB cluster
external object storage
Secrets and ConfigMaps
PodDisruptionBudgets
NetworkPolicies
ServiceAccounts
```

O Helm Chart oficial deve instalar o modo distribuído completo e permitir
selecionar PostgreSQL, MySQL/MariaDB, SQL Server ou MongoDB como banco
primário. Banco e Redis embutidos são permitidos apenas para avaliação;
produção deve usar topologia HA ou serviço gerenciado.

Todos os Deployments devem definir requests/limits, probes, graceful
termination, topology spread constraints e anti-affinity entre zonas.

---

## 125. Health checks

```text
/health
/health/live
/health/ready
```

Checar:

```text
database
database transaction capability
database schema/index version
redis
plugin runtime
storage
event bus and queues
replication/failover status
```

`live` verifica somente se o processo pode continuar executando. `ready`
retira o pod do tráfego quando dependências obrigatórias impedirem
processamento seguro. Falhas transitórias de provider LLM não devem matar o
pod; devem afetar readiness/circuit breaker apenas das rotas dependentes.

---

## 126. Open Source

Licença oficial do core, SDKs, CLI, plugins oficiais e documentação:

```text
Apache License 2.0
```

Arquivos:

```text
LICENSE
CONTRIBUTING.md
CODE_OF_CONDUCT.md
SECURITY.md
GOVERNANCE.md
ROADMAP.md
```

---

## 127. Community architecture

GitHub:

```text
handstack/handstack
handstack/plugins
handstack/docs
```

---

## 128. Editions

Não criar forks Community/Enterprise.

Mesmo core.

Community:

```text
local auth
OIDC
users
groups
agents
MCP
plugins
budgets
audit
API
chat
```

Serviços e add-ons comerciais compatíveis:

```text
enterprise support
managed HandStack hosting
hosted control plane operations
certified plugin validation service
managed compliance evidence service
private marketplace hosting
enterprise SLA and support operations
```

Autenticação, SCIM, policy engine, auditoria, HA, backup, segurança,
privacidade, avaliações de IA, documentação e todos os extension points
definidos nesta especificação pertencem ao core open source completo. Um
serviço comercial pode operar, certificar ou gerenciar essas capacidades,
mas não pode ser necessário para habilitar a funcionalidade no produto
self-hosted.

---

## 129. Domain entities iniciais

```text
Organization
OrganizationSettings
Branding
User
OrganizationMembership
Group
GroupMembership
Principal
Role
Permission
RolePermission
PrincipalRole
Policy
AccessGrant
AccessRequest
ApiKey
ServiceAccount
Provider
ModelDefinition
ModelRoute
Conversation
Message
MessagePart
Attachment
Agent
AgentVersion
AgentRun
AgentStep
Tool
ToolExecution
Capability
CapabilityVersion
McpServer
McpTool
McpResource
McpPrompt
Plugin
PluginInstallation
PluginPermission
KnowledgeBase
Document
DocumentVersion
Chunk
Prompt
PromptVersion
Budget
BudgetReservation
UsageRecord
CostRecord
ApprovalRequest
Secret
AuditEvent
Webhook
WebhookDelivery
Notification
FeatureFlag
Requirement
RequirementTrace
ExtensionRegistration
DataInventoryEntry
DataProcessingPurpose
ConsentRecord
RetentionPolicy
LegalHold
DataSubjectRequest
DataExport
DeletionJob
DeletionEvidence
DataResidencyPolicy
ProcessorRecord
PrivacyIncident
EvaluationSuite
EvaluationDataset
EvaluationCase
EvaluationMetric
EvaluationRun
EvaluationResult
EvaluationGate
RedTeamCampaign
ModelApproval
Workflow
WorkflowVersion
WorkflowExecution
WorkflowStepExecution
WorkflowTrigger
WorkflowCompensation
Operation
AuditCheckpoint
AuditExport
Incident
```

---

## 130. Dependency direction

Regra:

```text
UI
 ↓
Application
 ↓
Domain
 ↑
Infrastructure
```

Domain nunca importa:

```text
NestJS
TypeORM
MongoDB Driver
Fastify
Redis
OpenAI SDK
MCP SDK
```

---

## 131. Event Bus interno

```typescript
interface EventBus {
  publish(event: DomainEvent): Promise<void>;
  subscribe(...args: unknown[]): void;
}
```

Modo compacto:

```text
in-process
```

Modo distribuído:

```text
Redis Streams
```

Redis Streams é o Event Bus oficial do modo distribuído. Eventos devem
possuir ID, schema version, correlation/causation IDs, tenant, timestamp e
idempotency key. Consumers usam consumer groups, acknowledge explícito,
retry e dead-letter stream.

Kafka e NATS podem existir como adapters adicionais, mas não são
necessários para cumprir a arquitetura de escala definida nesta
especificação.

---

## 132. Execution Context

```typescript
ExecutionContext {
  requestId
  traceId
  principal
  organization
  permissions
  source
  conversationId?
  agentRunId?
}
```

`source`:

```text
WEB
API
MCP
AGENT
SYSTEM
```

---

## 133. Capability Execution Engine

Criar:

```text
CapabilityExecutionEngine
```

Fluxo:

```text
resolve capability
↓
authentication
↓
authorization
↓
guardrails
↓
budget reservation
↓
rate limit
↓
approval check
↓
execution
↓
usage measurement
↓
budget settlement
↓
audit
↓
telemetry
↓
response
```

**Web, API, MCP e Agents nunca executam Capability diretamente.**

Todos passam por esse engine.

---

## 134. Publicação

Capability possui:

```typescript
publications: {
  web?: {...},
  api?: {...},
  mcp?: {...},
  agent?: {...}
}
```

---

## 135. MCP publishing

```typescript
mcp: {
  enabled: true,
  toolName: "security_review",
  description: "...",
}
```

O MCP Server constrói `tools/list` com base no Capability Registry
autorizado para o Principal.

---

## 136. Dynamic MCP catalog

Não retornar tools sem permissão.

Exemplo:

```text
User A
→ tools/list
→ 12 tools

User B
→ tools/list
→ 4 tools
```

---

## 137. User connections

Tela:

```text
Connections
```

Exemplos:

```text
GitHub       Connected
Jira         Connect
Slack        Connected
```

Credenciais podem ser usadas por:

```text
Chat
Agent
MCP
API
```

---

## 138. Developer Experience

Tela:

```text
Developer
```

Mostrar:

```text
API Keys
OpenAI-compatible endpoint
MCP endpoint
SDK examples
curl examples
```

---

## 139. MCP connection helper

Oferecer snippets para:

```text
Claude
Cursor
VS Code
Codex
custom MCP clients
```

---

## 140. Core official plugins

```text
OpenAI Provider
Anthropic Provider
Gemini Provider
Ollama Provider
OpenAI-Compatible Provider
GitHub
HTTP Tool
Web Search abstraction
PostgreSQL Tool
Generic MCP
Core Evaluation Provider
Core Privacy and Data Lifecycle Provider
LGPD Compliance Control Pack
GDPR Compliance Control Pack
Container Sandbox Provider
Tamper-Evident Audit Sink
Generic SIEM Exporter
Core RAG Policy Provider
Core Workflow Nodes
HTTP Webhook Transport
Core Incident Management Provider
```

---

## 141. Official integration plugins

```text
Jira
Confluence
Slack
Microsoft Teams
Notion
Google Drive
SharePoint
AWS
Azure
S3
Cloudflare R2
Salesforce
```

---

## 142. First-party example agents

```text
General Assistant
Coding Assistant
Research Agent
Security Review Agent
```

---

## 143. Agent Templates

Criar:

```text
AgentTemplate
```

Instalação:

```text
Template
→ organization Agent
```

---

## 144. Import/Export

Exemplo:

```yaml
kind: Agent
apiVersion: handstack.io/v1

metadata:
  name: security-review

spec:
  model: smart
  tools:
    - github.search_code
```

---

## 145. Configuration as Code

Objetivo:

```text
handstack apply -f agent.yaml
```

Recursos:

```text
Agent
Model
Capability
Policy
Group
Budget
```

---

## 146. GitOps

```text
Git repository
→ HandStack config sync
```

---

## 147. Graphify / Code Knowledge Graph

Graphify deve ser adotado como ferramenta oficial de conhecimento do
código para reduzir releituras extensas do repositório e o consumo de
tokens por agentes de desenvolvimento.

Graphify é uma dependência de desenvolvimento. Não integra o runtime do
HandStack, não participa da execução de Capabilities e não deve ser
incluído nas imagens ou pacotes de produção.

### Corpus

O grafo deve ser construído principalmente a partir de:

```text
source code
tests
database migrations
configuration schemas
public API schemas
architecture documentation
user, administrator and developer documentation
Help Center articles and contextual-help mappings
ADRs
plugin manifests and contracts
```

Não indexar por padrão:

```text
node_modules
dist/build outputs
compiled binaries
coverage
temporary files
secrets and credentials
.env files
private keys
production data
database dumps
user uploads
graphify-out itself
```

Binários compilados não são o corpus canônico. Quando houver suporte
explícito a algum formato binário, sua inclusão deve ser justificada e o
resultado deve apontar para o código-fonte correspondente sempre que
possível.

### Outputs

Gerar em `graphify-out/`:

```text
graph.json        persistent queryable graph
graph.html        interactive visualization
GRAPH_REPORT.md   human-readable audit report
cost.json         cumulative token usage
```

Os artefatos devem registrar a origem das relações e distinguir:

```text
EXTRACTED
INFERRED
AMBIGUOUS
```

Relações inferidas ou ambíguas nunca substituem verificação no
código-fonte.

### Development workflow

Antes de uma leitura ampla do repositório:

```text
1. Check graphify-out/graph.json.
2. If missing, build the graph from the repository root.
3. If stale, run an incremental update.
4. Query the graph with a token budget.
5. Open the referenced source locations for critical decisions.
```

Comandos de referência:

```text
graphify . --directed
graphify . --update
graphify query "Trace capability execution and authorization" --budget 1500
graphify path "CapabilityExecutionEngine" "PolicyEngine"
graphify explain "BudgetReservation"
```

O grafo dirigido é recomendado para preservar a direção de imports,
chamadas e dependências. Consultas amplas devem começar com orçamento
entre 1.000 e 2.000 tokens e só aumentá-lo quando o resultado não possuir
evidência suficiente.

### Update policy

Executar `graphify --update` quando uma mudança alterar:

```text
module boundaries
public contracts
dependency direction
Capability execution flow
authorization or budget flow
database repositories
agent orchestration
MCP or plugin contracts
```

O rebuild completo deve ser executado no Milestone 0, antes de releases
estáveis e quando o diagnóstico indicar grafo incompleto ou inconsistente.

### Security and privacy

Graphify deve respeitar as mesmas regras de classificação de dados do
HandStack. Arquivos sensíveis devem ser detectados e excluídos antes da
extração. Nenhum código privado ou documento interno pode ser enviado a
um serviço sem autorização explícita.

A extração estrutural AST deve ser preferida para código. Extração
semântica de documentação deve usar apenas provider aprovado para o
repositório e nunca incluir secrets, prompts de produção ou dados de
usuários.

### Token-efficiency measurement

O projeto deve acompanhar:

```text
tokens used to build/update the graph
tokens used by graph queries
estimated full-repository reading tokens
query budget and source coverage
```

Economia de tokens é uma meta observável, não uma suposição. O grafo deve
ser usado quando oferecer contexto menor e suficiente; investigações de
segurança, migrations e mudanças críticas ainda exigem confirmação direta
nas fontes referenciadas.

---

## 148. Scalability, High Availability & Capacity

Esta seção define a arquitetura de escala obrigatória do produto final.
O HandStack deve escalar horizontalmente sem alterar APIs, regras de
autorização, budgets, auditoria ou comportamento das Capabilities.

### Topologia oficial distribuída

```text
Global DNS / CDN / WAF
          │
          ▼
Ingress / Load Balancer
          │
    ┌─────┼──────────────┐
    │     │              │
  Web    API            MCP       stateless replicas
    │     │              │
    └─────┼──────────────┘
          │
    Redis HA / Streams           coordination, cache and queues
          │
    ┌─────┼──────────────────────────────┐
    │     │              │               │
 Agents Knowledge  Integrations  Audit/Billing Workers
    │     │              │               │
    └─────┼──────────────┴───────────────┘
          │
  SQL cluster or MongoDB cluster        system of record
          │
  Object Storage                        files and artifacts
```

Cada camada escala de forma independente. A API não pode ser ampliada
para compensar backlog de embeddings; o respectivo worker deve escalar.

### Unidades de escala

```text
web replicas       HTTP UI and static/application rendering
api replicas       REST, OpenAI-compatible API and WebSocket/SSE control
mcp replicas       MCP sessions and capability exposure
worker-agents      agent and tool execution
worker-knowledge   ingestion, chunking and embeddings
worker-integrations plugins, MCP discovery and synchronization
worker-webhooks    webhook delivery
worker-audit-billing usage, cost and audit processing
worker-maintenance retention, cleanup and migrations support
```

Uma unidade não pode acessar memória local de outra. Comunicação ocorre
por APIs internas autenticadas, banco, Redis Streams ou filas BullMQ.

### Stateless request processing

Web, API e MCP devem ser stateless no modo distribuído. Estado necessário
entre requests deve ficar em:

```text
primary database
Redis HA
object storage
encrypted SecretProvider
```

Sessões HTTP usam refresh tokens seguros e estado compartilhado quando
revogação imediata for necessária. Nenhum fluxo pode depender de sticky
session para correção.

### Streaming, WebSocket and reconnection

Eventos de chat e Agent Runs devem possuir número sequencial ou cursor
persistente. SSE/WebSocket pode ser atendido por qualquer réplica.

Em desconexão:

```text
client reconnects with lastEventId/cursor
server replays retained events
live stream resumes without duplicating committed events
```

Redis Streams coordena fan-out entre réplicas. O sistema deve configurar
heartbeat, idle timeout, tamanho máximo de buffer e retenção. Clientes
lentos recebem backpressure; nunca deve haver buffer ilimitado em memória.

### Horizontal autoscaling

O Helm Chart deve entregar HPA para Web, API e MCP e KEDA para Workers.
Defaults de produção, todos configuráveis:

```text
web: min 2, max 20, CPU target 65%
api: min 3, max 50, CPU target 65%
mcp: min 2, max 30, CPU target 65%
workers: min 1 per class, max 100 per class
```

API e MCP devem combinar CPU com métricas externas:

```text
requests per second
active streams
p95 request latency
event-loop lag
in-flight capability executions
```

Workers devem escalar por:

```text
ready jobs
oldest job age
arrival rate
average execution time
provider concurrency quota
```

O target inicial do KEDA é 20 jobs prontos por réplica, ajustável por fila.
Scale-down deve respeitar o tempo máximo de execução e graceful shutdown.

### Admission control and backpressure

Antes de iniciar trabalho caro, o sistema deve verificar capacidade,
rate limit, provider quota e budget. Sob saturação:

```text
reject synchronous requests with 429 or 503
include Retry-After
queue only when the API contract permits asynchronous execution
preserve idempotency
emit saturation metrics and audit when relevant
```

Cada fila possui limites de tamanho, idade e bytes. Dead-letter queues
exigem UI e API administrativas para inspeção, retry controlado e descarte
auditado.

### Database scaling

O banco selecionado continua sendo o system of record.

Adapters SQL devem suportar:

```text
HA primary
read replicas
connection pooling
read/write routing
partitioning for high-volume append-only tables
online index creation when supported
```

Leituras sensíveis à consistência, budgets, permissions, publicação de
versões e idempotência usam o primary. Apenas queries explicitamente
marcadas como replica-safe podem usar read replicas.

Tabelas de alto volume, como `AuditEvent`, `UsageRecord`, `AgentEvent` e
`WebhookDelivery`, devem ser particionáveis por tempo e Organization.

MongoDB deve suportar:

```text
replica set
sharded cluster
read preference by operation class
majority write concern for critical state
managed indexes and schema validation
```

Collections tenant-owned usam shard key compatível com
`organizationId`. Collections de grande volume devem permitir distribuição
de tenants grandes sem quebrar o isolamento. Transações cross-shard devem
ser reduzidas por modelagem, mas mantidas quando necessárias à correção.

O adapter deve expor pool saturation, replication lag, slow queries,
transaction retries e shard/partition imbalance como métricas.

### Redis scaling and failure behavior

Redis HA deve separar, por namespace ou clusters independentes quando a
carga exigir:

```text
cache
rate limiting and ephemeral coordination
BullMQ queues
Redis Streams
```

Perda de cache não pode causar perda de estado de negócio. Falha do Redis
deve interromper com segurança novas execuções distribuídas que dependam
de locks, fila ou rate limit, retornando erro recuperável. O sistema não
pode ignorar rate limits ou autorização por indisponibilidade do Redis.

### Object storage and delivery

Uploads, documentos, artefatos e anexos devem usar storage compartilhado
S3-compatible, Azure Blob ou GCS no modo distribuído. Downloads usam URLs
assinadas de curta duração e podem passar por CDN. Pods não armazenam
arquivos persistentes localmente.

### Multi-zone high availability

Produção distribuída deve operar em pelo menos três failure domains quando
a infraestrutura permitir.

Requisitos:

```text
minimum two replicas for every synchronous stateless service
minimum three API replicas by default
PodDisruptionBudgets
topology spread constraints
anti-affinity across nodes and zones
rolling updates with maxUnavailable configured
Redis and database automatic failover
no single persistent volume as system-wide dependency
```

Manutenções de nó ou zona não podem interromper todas as APIs ou sessões
ativas simultaneamente.

### Multi-region disaster recovery

A topologia oficial multi-region usa uma região ativa para escrita e uma
região standby. Isso evita split-brain e diferenças de autorização ou
budget entre regiões.

```text
active region: all services and writes
standby region: warm stateless capacity and replicated data
global DNS: health-based failover
object storage: cross-region replication
secrets/config: replicated by approved provider
```

Metas padrão:

```text
RPO <= 5 minutes
RTO <= 15 minutes
```

O failover deve ser automatizável, exigir fencing da região anterior,
validar consistência do banco e executar smoke tests antes de receber
tráfego. Failback é uma operação separada e auditada.

### Zero-downtime deployment

Deployments devem usar rolling update e graceful shutdown. API pública e
event schemas permanecem compatíveis entre a versão anterior e a nova
durante o rollout.

Migrations seguem expand/migrate/contract:

```text
1. add backward-compatible structures
2. deploy code that reads old and new representation
3. backfill with resumable jobs
4. switch reads/writes
5. remove old structures only in a later compatible release
```

Rollback de aplicação não pode depender do rollback destrutivo de dados.

### SLOs and capacity certification

Defaults do produto, excluindo latência de providers LLM e tools externos:

```text
monthly API availability >= 99.9%
p95 control-plane API latency <= 300 ms under certified load
p99 authorization decision <= 100 ms when dependencies are healthy
accepted durable job loss = 0
duplicate side effects from retries = 0
queue wait p95 <= 5 seconds under certified load
```

Cada release estável deve publicar um relatório de capacidade com hardware,
topologia, dataset, número de tenants, requests/second, streams simultâneos,
jobs/second, latências, erros e custos. Números sem ambiente reproduzível
não são considerados garantia.

### Observability for scaling

Dashboards e alertas obrigatórios:

```text
request rate, errors and latency by route
active SSE/WebSocket/MCP streams
event-loop lag and memory pressure
HPA/KEDA desired versus available replicas
queue depth, oldest age, retries and dead letters
worker concurrency and execution duration
Redis latency, memory, failover and stream lag
database connections, replication lag and slow queries
provider quotas, 429s and circuit breaker state
budget reservation latency and conflicts
storage latency and error rate
```

Autoscaling não substitui alertas. Saturação sustentada no limite máximo
de réplicas deve gerar incidente.

### Resilience and load tests

CI e release validation devem incluir:

```text
load tests
spike tests
soak tests
queue saturation tests
pod termination during active streams
worker crash during jobs
Redis failover
database primary failover
network partition simulations
zone outage exercise
backup restore
regional failover drill
```

Testes devem confirmar ausência de perda de jobs aceitos, duplicação de
efeitos colaterais, bypass de autorização, budget incorreto e vazamento
entre Organizations.

### Scalability Definition of Done

O produto final só está completo quando:

```text
compact and distributed profiles pass the same functional suite
Helm installs a production-ready distributed topology
HPA and KEDA scale independently from observable load
Redis and database failover tests pass
streams reconnect and replay from cursor
queues enforce backpressure and dead-letter handling
zero-downtime upgrade succeeds across two consecutive versions
capacity report and SLO dashboards exist
multi-region recovery meets RPO and RTO targets
```

---

## 149. Cross-Cutting Extension Architecture

Privacidade, compliance, avaliação de IA, sandbox, RAG, auditoria,
webhooks, incidentes e workflow nodes devem ser extensíveis através do
Plugin System. Ser plugável não torna uma proteção opcional.

Regras obrigatórias:

```text
every critical extension point has an official built-in implementation
the product remains complete without third-party plugins
plugins may extend or replace adapters, never bypass the core pipeline
authorization, tenant isolation and audit remain enforced by the core
security-critical provider failure is fail-closed
plugin configuration is schema-validated, versioned and secret-safe
enablement may be global or Organization-scoped
every provider declares permissions, health, compatibility and capabilities
every provider passes the official contract test kit
```

Contrato base:

```typescript
interface ExtensionProvider {
  id: string;
  type: ExtensionType;
  apiVersion: string;
  capabilities: string[];
  configurationSchema: JsonSchema;
  requiredPermissions: string[];
  health(context: ExtensionHealthContext): Promise<ExtensionHealth>;
}
```

Tipos de extension point oficiais:

```text
PolicyProvider
GuardrailProvider
EvaluationProvider
PrivacyPolicyProvider
DataSubjectRequestProvider
DataLifecycleProvider
DataResidencyProvider
ComplianceControlProvider
SandboxProvider
AuditSinkProvider
SiemExporterProvider
KnowledgeConnectorProvider
RagPolicyProvider
VectorStoreProvider
WorkflowNodeProvider
CompensationProvider
WebhookTransportProvider
IncidentManagementProvider
StatusPageProvider
NotificationProvider
```

O `ExtensionRegistry` resolve providers por tipo, Organization, policy,
prioridade e compatibilidade. Seleção dinâmica deve ser determinística,
auditada e observável. Troca de provider não pode alterar contratos
públicos ou remover garantias de segurança.

Quando mais de um provider participa da mesma decisão:

```text
deny from any mandatory security provider wins
all required providers must complete successfully
advisory providers cannot authorize an action denied by the core
timeouts and unavailable mandatory providers fail closed
fallback is allowed only to an explicitly approved compatible provider
```

Plugins não podem registrar middleware global arbitrário. Extension points
são contratos fechados, com input/output schemas, timeout, limites de
recursos, classificação de dados e política de efeitos colaterais.

Cada extension point deve possuir:

```text
official default adapter
public interface and versioned schema
configuration UI extension
permissions and security documentation
contract tests
failure-mode tests
audit events
OpenTelemetry spans and metrics
step-by-step wiki documentation
compatibility and deprecation policy
```

---

## 150. Requirements Governance & Traceability

Esta especificação é normativa. Os termos abaixo têm significado fixo:

```text
MUST / deve       mandatory for the complete product
MUST NOT / não pode prohibited behavior
SHOULD / deveria  default requirement; exception requires an ADR
MAY / pode        optional extension that cannot be required for correctness
```

Todo requisito implementável deve receber ID estável:

```text
HS-CORE-nnn
HS-SEC-nnn
HS-DATA-nnn
HS-AI-nnn
HS-API-nnn
HS-OPS-nnn
HS-UX-nnn
HS-DOC-nnn
```

O repositório deve manter:

```text
docs/requirements/catalog.yaml
docs/requirements/traceability.md
docs/requirements/non-goals.md
docs/requirements/support-matrix.md
```

Cada entrada do catálogo contém:

```text
id
title
normative statement
rationale
owner
status
risk
affected modules
public contracts
data entities
security and privacy impact
acceptance criteria
test IDs
documentation article IDs
introduced version
```

A matriz de rastreabilidade deve provar:

```text
requirement → module → API/event/schema → migration → test → documentation
```

CI bloqueia requisitos sem teste ou documentação, código público sem
requisito correspondente e testes órfãos de requisito. Exceções exigem ADR
com owner e prazo de remoção.

Fora do escopo do produto:

```text
training foundation models from scratch
general-purpose ERP, CRM or payment processing
guaranteeing availability of external LLM/tool providers
active-active multi-region writes to the same tenant
executing untrusted code outside an approved SandboxProvider
bypassing provider terms, licensing or data-processing restrictions
```

---

## 151. Privacy, Compliance & Data Lifecycle

O core deve fornecer inventário de dados, classificação, retenção,
residência, legal hold e atendimento a titulares. Plugins podem implementar
regras regulatórias ou integrações específicas, mas não remover os controles
básicos.

Extension points:

```typescript
interface PrivacyPolicyProvider {
  evaluate(input: PrivacyDecisionInput): Promise<PrivacyDecision>;
}

interface DataSubjectRequestProvider {
  validate(request: DataSubjectRequest): Promise<void>;
  execute(request: DataSubjectRequest): Promise<DataSubjectRequestResult>;
}

interface DataLifecycleProvider {
  plan(resource: DataResource, policy: RetentionPolicy): Promise<LifecyclePlan>;
  execute(plan: LifecyclePlan): Promise<LifecycleResult>;
}

interface DataResidencyProvider {
  authorizePlacement(input: DataPlacementRequest): Promise<DataPlacementDecision>;
}
```

Entidades:

```text
DataInventoryEntry
DataProcessingPurpose
ConsentRecord
RetentionPolicy
LegalHold
DataSubjectRequest
DataExport
DeletionJob
DeletionEvidence
DataResidencyPolicy
ProcessorRecord
PrivacyIncident
```

Tipos de solicitação do titular:

```text
ACCESS
EXPORT
CORRECTION
DELETION
RESTRICTION
OBJECTION
```

Estados:

```text
RECEIVED
IDENTITY_VERIFICATION
APPROVED
IN_PROGRESS
COMPLETED
PARTIALLY_COMPLETED
DENIED_WITH_REASON
```

Exportação e exclusão devem alcançar:

```text
primary SQL or MongoDB database
vector stores and embeddings
search indexes
object storage and attachments
caches
queues and dead-letter payloads
provider-side stored data when supported
plugin-owned data
backups according to documented expiry and tombstone policy
```

Toda exclusão gera evidência auditável sem reter o conteúdo excluído. Legal
hold prevalece sobre expiração normal, exige autorização específica e não
pode ser ocultado de auditoria.

O produto deve oferecer políticas para LGPD e GDPR sem afirmar certificação
automática. `ComplianceControlProvider` pode adicionar frameworks, evidências,
relatórios e controles de jurisdições específicas.

Residência de dados deve abranger banco, storage, vetores, search, backups,
telemetria e providers externos. O `CapabilityExecutionEngine` bloqueia uma
execução quando a classificação ou residência não permite o destino.

Incidentes de privacidade possuem classificação, timeline, recursos afetados,
Organizations afetadas, decisões de notificação, evidências e postmortem.

---

## 152. AI Evaluation & Model Governance

Nenhum Prompt, Agent, model route, guardrail ou workflow de IA pode ser
publicado como estável sem avaliação versionada.

Extension point:

```typescript
interface EvaluationProvider {
  run(input: EvaluationRunInput): Promise<EvaluationRunResult>;
  validateGate(input: EvaluationGateInput): Promise<EvaluationGateDecision>;
}
```

Entidades:

```text
EvaluationSuite
EvaluationDataset
EvaluationCase
EvaluationMetric
EvaluationRun
EvaluationResult
EvaluationGate
RedTeamCampaign
ModelApproval
```

Métricas suportadas pelo core:

```text
task success
schema validity
tool selection correctness
tool argument correctness
groundedness
citation validity
hallucination rate
safety policy compliance
prompt-injection resistance
PII and secret leakage
latency
token usage
cost
human rating
```

Datasets usam conteúdo sintético ou aprovado, possuem classificação,
proveniência, owner, versão e política de retenção. Dados reais de usuários
não entram em avaliação sem base legal e sanitização explícita.

Publicação exige gates configuráveis por Organization e gates mínimos do
produto. Mudanças de prompt, model, provider, tool schema, guardrail,
retrieval ou workflow executam a suíte afetada.

Promoção:

```text
draft → evaluated → approved → published → deprecated → retired
```

Falha de gate bloqueia publicação. Override exige permissão específica,
justificativa, expiração e auditoria. Rollback restaura a última combinação
aprovada de prompt, model route, tools, policies e datasets.

Red teaming deve cobrir jailbreak, prompt injection indireta, data exfiltration,
cross-tenant access, unsafe tool use, excessive agency, denial of wallet e
poisoning de RAG.

---

## 153. Workflow Execution Semantics

Workflow é uma Capability versionada e sempre executa através do
`CapabilityExecutionEngine`.

Entidades adicionais:

```text
Workflow
WorkflowVersion
WorkflowExecution
WorkflowStepExecution
WorkflowTrigger
WorkflowCompensation
```

Estados de versão:

```text
DRAFT
VALIDATED
PUBLISHED
DEPRECATED
RETIRED
```

Estados de execução:

```text
PENDING
RUNNING
WAITING
PAUSED
COMPENSATING
COMPLETED
FAILED
CANCELLED
TIMED_OUT
```

O grafo publicado é imutável. Ciclos livres são proibidos; repetição utiliza
um node explícito de loop com limite de iterações, timeout e budget.

O runtime deve definir:

```text
branch and join semantics
bounded parallelism
per-step timeout and retry policy
execution and step idempotency keys
checkpoint after every committed transition
durable event ordering
resume after process or node failure
cancellation propagation
output size and retention limits
deterministic expression language
versioned input/output schemas
```

Entrega de eventos e jobs é at-least-once. Efeitos externos usam idempotência,
outbox/inbox ou compensação; a especificação não deve prometer exactly-once
para sistemas externos.

`WorkflowNodeProvider` pode registrar novos nodes somente com schemas,
permissões, classificação de efeito, timeout, capacidade de cancelamento,
política de retry e contrato de compensação.

Classificação de efeito:

```text
READ_ONLY
IDEMPOTENT_WRITE
REVERSIBLE_WRITE
IRREVERSIBLE_WRITE
FINANCIAL_OR_HIGH_IMPACT
```

Writes irreversíveis ou de alto impacto exigem policy explícita e podem exigir
aprovação humana. `CompensationProvider` nunca transforma compensação em
garantia de rollback; falhas parciais permanecem visíveis e auditadas.

Triggers webhook, schedule e event possuem deduplicação, cursor, timezone,
misfire policy, replay policy e identidade de execução.

---

## 154. Persistence Conformance & Adapter Portability

Paridade SQL/MongoDB deve ser definida por uma matriz canônica por repository
e operação, não apenas pela existência dos mesmos métodos.

Arquivo obrigatório:

```text
docs/architecture/persistence-conformance.yaml
```

Cada operação declara:

```text
transaction boundary
consistency requirement
uniqueness behavior
concurrency control
ordering and cursor semantics
read-replica safety
retryable errors
canonical domain error mapping
required indexes
tenant isolation predicate
expected behavior during migration and failover
```

O core deve fornecer testes de conformidade compartilhados e property-based
tests para todos os adapters oficiais.

Portabilidade operacional:

```text
handstack database export --portable
handstack database import --portable
handstack database verify
handstack database compare
```

O formato portátil é versionado, independente de SQL/ObjectId, tenant-aware,
streaming, resumable e assinado com manifest de checksums. Export/import deve
incluir dados de domínio, índices lógicos, plugin-owned schemas, storage
manifest e versões, sem exportar secrets em claro.

Migração entre SQL e MongoDB exige:

```text
preflight compatibility check
capacity and free-space validation
read-only or controlled dual-write window
resumable copy with checkpoints
canonical record counts and checksums
relationship and tenant-isolation verification
cutover plan
rollback boundary
post-cutover audit report
```

Dual-write não é modo permanente e não pode ser ativado sem mecanismo de
reconciliação. A fonte de verdade deve ser única em cada instante.

---

## 155. Secure Sandbox & Plugin Marketplace Trust

Execução de plugins da comunidade, código gerado, tools locais e comandos MCP
stdio deve ocorrer através de `SandboxProvider`.

```typescript
interface SandboxProvider {
  prepare(profile: SandboxProfile): Promise<SandboxHandle>;
  execute(handle: SandboxHandle, request: SandboxExecutionRequest): Promise<SandboxExecutionResult>;
  terminate(handle: SandboxHandle): Promise<void>;
}
```

Implementações oficiais:

```text
process-isolated development sandbox
container sandbox for production
external sandbox adapter extension point
```

Todo `SandboxProfile` define:

```text
CPU, memory, process and execution-time limits
read-only root filesystem
explicit writable temporary mounts
network deny-by-default and destination allowlist
DNS and SSRF enforcement
secret handles with scope and expiry
syscall/capability restrictions
maximum output and log size
artifact ingress/egress policy
tenant and execution identity
```

O host nunca monta Docker socket, kubeconfig, cloud credentials ou filesystem
do HandStack dentro do sandbox.

Supply chain obrigatória:

```text
SBOM
publisher identity
package checksum
signature and signing-key history
build provenance
malware and dependency scan
permission diff between versions
compatibility test result
revocation and quarantine status
```

Marketplace deve suportar remoção de versão maliciosa, revogação de publisher,
quarentena automática, aviso aos administradores, desabilitação controlada e
preservação de evidências. Atualização que amplia permissões exige nova
aprovação explícita.

Plugins oficiais in-process continuam sujeitos a revisão, assinatura, SBOM e
kill switch. Falha ou comprometimento de plugin não pode conceder permissões
adicionais.

---

## 156. RAG Security, Authorization & Lifecycle

Autorização deve ser preservada desde a fonte até cada resultado recuperado.

Extension points:

```typescript
interface KnowledgeConnectorProvider {
  discover(input: DiscoveryRequest): AsyncIterable<SourceItem>;
  sync(input: SyncRequest): AsyncIterable<SourceChange>;
  delete(input: SourceDeletionRequest): Promise<void>;
}

interface RagPolicyProvider {
  authorizeIngestion(input: IngestionPolicyInput): Promise<PolicyDecision>;
  filterRetrieval(input: RetrievalPolicyInput): Promise<RetrievalPolicyResult>;
}
```

Documento, versão, chunk e embedding carregam:

```text
organizationId
sourceId and sourceVersion
source permissions/ACL snapshot
data classification
residency
content hash
ingestedAt
lastVerifiedAt
retention policy
deletion status
```

Requisitos:

```text
ACL-aware ingestion and retrieval
permission revalidation for sensitive queries
incremental sync with durable cursor
deletion and permission-change propagation
deduplication by canonical source and content hash
poisoning and malicious-instruction detection
PII/secret detection before embedding
retrieval limits and tenant-safe filters
source freshness and stale-result signaling
complete citation provenance
reindex and embedding-model migration workflow
```

Nenhum resultado pode ser retornado apenas porque está próximo no vetor. O
filtro de Organization e ACL é obrigatório antes da resposta. Cache semântico
deve incluir tenant, principal/policy fingerprint, model, locale e versão do
corpus na chave.

Avaliações de RAG medem recall, precision, groundedness, citation validity,
freshness e vazamento cross-tenant.

---

## 157. API & Webhook Protocol Contract

Todas as APIs públicas seguem convenções únicas e geradas no OpenAPI.

```text
cursor-based pagination for mutable/high-volume collections
stable deterministic sort with id as tie-breaker
explicit filter and sort allowlists
RFC 9457 Problem Details with stable HandStack error codes
requestId and traceId in responses
Idempotency-Key with persisted result and conflict semantics
ETag/If-Match for optimistic concurrency
202 + Operation resource for asynchronous work
UTC RFC 3339 timestamps and explicit IANA timezone for schedules
documented size, rate and timeout limits
```

Recursos assíncronos expõem:

```text
GET /api/v1/operations/:id
POST /api/v1/operations/:id/cancel
```

Estados são `PENDING`, `RUNNING`, `WAITING`, `SUCCEEDED`, `FAILED`,
`CANCELLED` e `EXPIRED`.

Webhooks possuem:

```text
event id and schema version
organization and source metadata
HMAC signature with timestamp and key id
replay window
secret rotation with overlap
at-least-once delivery
ordering only within an explicitly documented partition key
deduplication guidance
exponential backoff with jitter
delivery attempt log
manual replay with audit
dead-letter inspection and retention
payload redaction and size limits
endpoint verification
```

`WebhookTransportProvider` pode adicionar transportes, mas o core continua
responsável por autorização, event schema, assinatura, retry, auditoria e
redaction.

Compatibilidade pública define janela de depreciação, sunset header, migration
guide e testes entre a versão estável atual e a anterior.

---

## 158. Tamper-Evident Audit & Security Operations

O audit store oficial é durável, append-only e tamper-evident.

```text
hash-chained segments
periodic signed checkpoints
immutable/WORM storage adapter support
verified export manifests
integrity verification command and scheduled job
UTC timestamp plus trusted clock-health metadata
```

Comandos:

```text
handstack audit verify
handstack audit export
handstack audit checkpoint
```

Eventos incluem resultado, policy IDs, approval, impersonation/delegation,
provider/plugin version e before/after resumido com redaction. Prompts, secrets,
tokens e payloads sensíveis nunca entram automaticamente no audit metadata.

Extension points:

```typescript
interface AuditSinkProvider {
  append(event: AuditEvent): Promise<AuditReceipt>;
  verify(range: AuditRange): Promise<AuditVerificationResult>;
}

interface SiemExporterProvider {
  export(events: AsyncIterable<AuditEvent>): Promise<ExportCheckpoint>;
}
```

O sink durável oficial é sempre obrigatório. Exporters SIEM são adicionais e
não substituem o system of record. Ações administrativas e de alto impacto
falham de modo seguro quando o evento obrigatório não pode ser persistido.

Suportar formatos JSON Lines e CEF/syslog através de adapters. Exportação
preserva cursor, backpressure, retry e dead-letter sem duplicar silenciosamente
eventos.

Legal hold, retenção e acesso ao audit possuem permissions próprias. Toda
consulta, exportação e verificação do audit também gera audit event.

---

## 159. Incident, Support & Release Operations

O produto deve possuir processo operacional executável, não apenas métricas.

Entidade `Incident`:

```text
id
severity
status
startedAt
detectedAt
acknowledgedAt
resolvedAt
affectedOrganizations
affectedCapabilities
owner
timeline
customerImpact
rootCause
correctiveActions
```

Estados:

```text
DETECTED
INVESTIGATING
IDENTIFIED
MITIGATING
MONITORING
RESOLVED
POSTMORTEM
```

`IncidentManagementProvider` integra PagerDuty, Opsgenie, Jira, Slack ou
sistemas equivalentes. O core oferece registro, severidade, timeline,
notificações por webhook/email e exportação mesmo sem plugin.

Requisitos operacionais:

```text
severity and escalation policy
on-call ownership per subsystem
status endpoint and StatusPageProvider
customer-safe incident communication
blameless postmortem with tracked actions
SLO error-budget policy
security vulnerability intake and disclosure process
patch severity and remediation SLA
regular penetration test and threat-model review
```

Cada release publica uma support matrix contendo versões mínimas e máximas de:

```text
Node.js
browsers
Kubernetes
Helm
Redis
PostgreSQL
MySQL
MariaDB
SQLite
SQL Server
MongoDB
vector stores
object storage APIs
```

Política de suporte:

```text
stable release supports upgrade from the previous two stable minor versions
security fixes declare affected versions
deprecation includes replacement and removal version
EOL is announced before support ends
release artifacts include SBOM, signature and provenance
database and event compatibility is tested across rolling upgrade windows
```

Certificados, signing keys, master keys, provider credentials, webhook secrets
e service-account credentials possuem rotação documentada, overlap quando
necessário, revogação e teste de recuperação.

---

## 160. Frontend Platform Contract

A aplicação Web deve ser responsiva, acessível e compatível com ambientes
corporativos.

Matriz mínima:

```text
latest two stable Chrome versions
latest two stable Edge versions
latest two stable Firefox versions
latest two stable Safari versions
responsive layout from 360px viewport width
keyboard-only and screen-reader operation
WCAG 2.2 AA
```

O design system oficial possui tokens, componentes, estados, validação,
mensagens, loading, empty states, destructive confirmations e padrões de
ajuda contextual. Plugins usam somente extension points e componentes
aprovados; não podem injetar scripts globais ou CSS que quebre isolamento,
branding ou acessibilidade.

Performance budgets sob ambiente de referência:

```text
Core Web Vitals in the good range for non-streaming control-plane pages
initial JavaScript budget per route
bounded rendering cost for long conversations
virtualization for high-volume lists and logs
stream rendering without unbounded memory growth
```

Frontend deve possuir:

```text
component tests
accessibility automation
visual regression
critical E2E journeys
browser compatibility suite
network loss and reconnection tests
error boundary and typed Problem Details handling
safe optimistic updates with rollback
locale, timezone and RTL-ready layout primitives
```

Offline é obrigatório para o Help Center empacotado. Demais funções devem
detectar ausência de rede, preservar edições locais seguras quando aplicável e
nunca aparentar sucesso antes de confirmação do servidor.

---

# Roadmap de implementação

O roadmap define ordem de entrega, não funcionalidades opcionais ou
promessas futuras. Ao concluir o último milestone, todo o conteúdo desta
especificação deve estar implementado.

Escalabilidade é transversal: cada milestone deve entregar seus contratos
stateless, métricas, filas, idempotência, concorrência e testes distribuídos
aplicáveis. O Milestone 18 consolida e certifica a topologia completa; ele
não é o primeiro momento em que requisitos de escala são implementados.

## Milestone 0 --- Repository Foundation

Implementar:

```text
monorepo
npm
Turborepo
TypeScript strict
ESLint
Prettier
Vitest/Jest
NestJS API
Next.js UI
Docker
CI
shared config
logging
OpenTelemetry bootstrap
Graphify development dependency
initial directed code knowledge graph
Graphify security exclusions
token-cost tracking
docs-as-code foundation
wiki-style public documentation portal
in-product Help Center shell
documentation search index
documentation quality gates
requirements catalog and stable IDs
requirements traceability matrix
non-goals and support-matrix foundations
ExtensionRegistry and ExtensionProvider base contracts
```

Critério:

```text
npm install
npm run dev
npm run test
npm run build
graphify query "Explain the HandStack module boundaries" --budget 1500
documentation validation and link checks
```

funcionam.

O grafo inicial deve possuir relatório, proveniência das relações e
diagnóstico de integridade sem endpoints ausentes ou relações colapsadas.

---

## Milestone 1 --- Database Foundation

Implementar:

```text
TypeORM adapter
MongoDB adapter
repository interfaces
UUIDv7
SQL migrations
MongoDB document migrations
transaction abstraction
schema validation
index management
database adapter selection by configuration
```

Primeiro:

```text
PostgreSQL
SQLite
MongoDB
```

Depois:

```text
MySQL
MariaDB
SQL Server
```

Critério:

mesma suíte de repository tests passa em todos os bancos oficialmente
suportados.

Critérios adicionais:

```text
HandStack inicia usando somente MongoDB, sem conexão SQL.
Todos os módulos do HandStack persistem e consultam seus dados em MongoDB.
Transactions críticas mantêm as mesmas garantias observáveis do SQL.
Migrations de documentos e índices são executadas automaticamente.
Trocar o adapter não altera contratos de domínio ou APIs públicas.
```

---

## Milestone 2 --- Identity

Implementar:

```text
Organization
User
Group
Role
Permission
local auth
sessions
OIDC
API keys
```

Critério:

- Admin cria user.
- User entra.
- Admin cria group.
- User entra no group.
- Permission altera acesso.

---

## Milestone 3 --- Providers & Models

Implementar:

```text
Provider abstraction
OpenAI
Anthropic
Gemini
Ollama
OpenAI-compatible
Model Registry
EvaluationProvider contract
EvaluationSuite and versioned datasets
model/prompt evaluation gates
```

Critério:

mesma API gera respostas através de pelo menos 3 providers e nenhuma rota
de model/prompt é publicada como estável sem passar seus evaluation gates.

---

## Milestone 4 --- Chat

Implementar:

```text
conversation
message
streaming
model selection
history
attachments basic
```

Critério:

usuário consegue conversar com múltiplos modelos pela UI.

---

## Milestone 5 --- Gateway

Implementar:

```text
/v1/models
/v1/chat/completions
streaming
virtual keys
usage
rate limits
```

Critério:

OpenAI SDK consegue usar HandStack trocando apenas `baseURL` e `apiKey`.

---

## Milestone 6 --- Budget & Usage

Implementar:

```text
token usage
pricing
cost
organization budgets
group budgets
user budgets
API key budgets
```

Critério:

Hard budget bloqueia request corretamente.

---

## Milestone 7 --- Capability Engine

Implementar:

```text
Capability
Capability Registry
Capability Execution Engine
Policy integration
Web publication
API publication
```

Critério:

uma capability customizada pode ser chamada por Web e API com a mesma
autorização.

---

## Milestone 8 --- Agent Harness

Implementar:

```text
Agent
AgentVersion
AgentRun
LLM loop
Tool execution
streaming events
timeouts
iteration limit
budget
```

Critério:

Agent chama Tool e responde.

---

## Milestone 9 --- MCP Client

Implementar:

```text
MCP server registry
Streamable HTTP
stdio
tools discovery
tool execution
auth
tool permissions
```

Critério:

Agent consegue chamar tool de MCP externo.

---

## Milestone 10 --- MCP Server

Implementar:

```text
HandStack MCP endpoint
tools/list
tools/call
dynamic authorized catalog
Capability → MCP
```

Critério:

1.  Criar Agent.
2.  Marcar `Publish as MCP`.
3.  Conectar Cursor/Claude/Codex.
4.  Agent aparece como tool.
5.  Executar com sucesso.

**Este milestone demonstra o principal diferencial do projeto.**

---

## Milestone 11 --- Plugin SDK

Implementar:

```text
plugin manifest
plugin lifecycle
tool registration
provider registration
capability registration
plugin configuration
```

Criar plugins de exemplo.

---

## Milestone 12 --- Plugin UI

Permitir plugins registrarem:

```text
settings pages
admin pages
chat actions
message renderers
```

Extension points controlados.

---

## Milestone 13 --- Knowledge

Implementar:

```text
documents
chunks
embeddings
vector store
retrieval
citations
ACL-aware ingestion and retrieval
incremental connector sync
permission/deletion propagation
RAG poisoning detection
RAG evaluation suite
```

Agent pode usar Knowledge Base.

---

## Milestone 14 --- Governance

Implementar:

```text
Access Requests
Temporary Access
Human Approval
ABAC
advanced policies
privacy inventory and retention
data-subject requests
legal hold and data residency
tamper-evident audit
SIEM exporter contract
compliance extension points
```

---

## Milestone 15 --- Multi-agent

Implementar:

```text
Agent as Tool
Supervisor
Parallel execution
Handoff
Agent collaboration
```

---

## Milestone 16 --- Workflows

Implementar:

```text
Workflow
WorkflowVersion
Nodes
Edges
Runtime
Approvals
Resume
durable checkpoints
idempotency and bounded parallelism
failure, cancellation and compensation semantics
WorkflowNodeProvider and CompensationProvider
```

---

## Milestone 17 --- Marketplace

Implementar:

```text
Plugin Registry
Search
Install
Upgrade
Version compatibility
Permissions
publisher identity and signature verification
SBOM and provenance
permission-diff approval
revocation and quarantine
SandboxProvider enforcement
```

---

## Milestone 18 --- Production Scale & Enterprise Hardening

Implementar:

```text
SAML
SCIM
advanced OIDC
SIEM
secret providers
HA
Kubernetes
Helm
backup/restore
horizontal autoscaling
Redis HA and Redis Streams
KEDA worker scaling
backpressure and dead-letter queues
zero-downtime deployment
multi-zone topology
capacity and failure testing
multi-region disaster recovery
incident lifecycle and on-call integrations
status page extension point
SLO error-budget policy
support matrix and EOL policy
artifact SBOM, signatures and provenance
penetration testing and threat-model review
credential, key and certificate rotation
browser, accessibility and frontend performance certification
```

---

# Definition of Done geral

Nenhuma feature está pronta sem:

```text
domain tests
integration tests
authorization tests
stable requirement IDs and traceability
audit events
privacy and data-lifecycle assessment
threat-model update when trust boundaries change
OpenTelemetry spans
documentation
OpenAPI
canonical step-by-step Help Center article
contextual UI help links
documentation localization parity
documentation quality gates
migration
SQL and MongoDB repository parity
portable persistence conformance when data contracts change
UI permissions
WCAG 2.2 AA and supported-browser tests for UI changes
error handling
extension provider contract and failure-mode tests when applicable
AI evaluation gates for prompts, models, agents, RAG and workflows
SBOM, signature and provenance for release artifacts
Graphify incremental update for structural changes
direct source verification for critical graph findings
compact/distributed behavioral parity
load, backpressure and graceful-shutdown tests when applicable
scaling metrics, dashboards and alerts
```

---

# Coding standards

TypeScript:

```text
strict: true
noImplicitAny
noUncheckedIndexedAccess
exactOptionalPropertyTypes
```

Evitar:

```text
any
global state
ORM entities fora infrastructure
MongoDB collections/documents fora infrastructure
SQL queries ou MongoDB queries na camada de domínio
business logic em controllers
business logic em React
```

---

# Domain architecture

Cada módulo:

```text
module/
  domain/
  application/
  infrastructure/
  api/
  tests/
```

Exemplo:

```text
agents/
  domain/
    Agent.ts
    AgentRepository.ts

  application/
    CreateAgent.ts
    RunAgent.ts

  infrastructure/
    TypeOrmAgentRepository.ts
    MongoAgentRepository.ts

  api/
    AgentController.ts
```

---

# Error model

Criar erros tipados:

```text
AuthenticationError
AuthorizationError
ValidationError
BudgetExceededError
RateLimitError
CapabilityNotFoundError
ProviderError
McpError
PluginError
AgentExecutionError
```

API converte para Problem Details.

---

# Idempotency

Operações públicas devem suportar:

```text
Idempotency-Key
```

especialmente:

```text
agent execution
capability execution
webhooks
```

---

# Cancellation

Agent e LLM streams devem suportar `AbortSignal`.

Quando usuário cancela chat:

```text
cancel LLM
cancel tools quando possível
release budget reservation
close streams
```

---

# Timeouts

Definir:

```text
HTTP timeout
provider timeout
tool timeout
MCP timeout
agent timeout
workflow timeout
```

Todos configuráveis.

---

# Retries

Retry somente para:

```text
network
429
temporary provider failure
```

Não retry automático para:

```text
unsafe tools
mutations
financial actions
```

sem idempotency.

---

# Caching

Criar:

```text
CacheProvider
```

Adapters:

```text
Memory
Redis
semantic cache
```

---

# Search

Criar abstração de Search para:

```text
conversations
agents
capabilities
plugins
knowledge
```

O adapter correspondente ao banco primário é obrigatório e não pode exigir
um banco SQL em instalações MongoDB-only. Implementações oficiais:

```text
SQL full-text search para adapters SQL compatíveis
MongoDB text search ou Atlas Search quando configurado
fallback repository search para bancos sem full-text adequado
```

Para instalações distribuídas e grandes volumes, suportar também:

```text
OpenSearch
Elasticsearch
```

---

# Localization

Frontend preparado para i18n desde o início.

Idiomas suportados:

```text
English
Portuguese
```

---

# Accessibility

Meta:

```text
WCAG 2.2 AA
```

---

# API backward compatibility

Nunca quebrar:

```text
/api/v1
```

sem nova versão.

Plugin API deve possuir `apiVersion`.

---

# Database backward compatibility

Migrations SQL e migrations de documentos MongoDB:

```text
forward-only
reversible quando possível
idempotent
resumable para transformações longas
versioned and observable
```

Nunca exigir SQL ou comandos MongoDB manuais para upgrade normal.

Upgrades devem preservar compatibilidade de leitura durante rolling
deployments quando suportados. Índices MongoDB potencialmente bloqueantes
devem ser criados de forma segura e documentada.

---

# Backup

CLI obrigatória:

```text
handstack backup
handstack restore
```

Exportar:

```text
database metadata
database adapter and version
MongoDB collection/index manifests quando aplicável
configuration
plugins
storage manifest
```

Secrets somente criptografados.

Backup e restore devem funcionar tanto para SQL quanto para MongoDB. O
restore deve validar compatibilidade de adapter, versão de schema e
isolamento por Organization antes de disponibilizar o sistema.

---

# Telemetry do próprio HandStack

Telemetry deve ser opt-in.

Nunca enviar:

```text
prompts
responses
user information
tokens
secrets
```

---

# Documentação

Documentação é uma funcionalidade do produto. O HandStack deve possuir uma
base documental completa, versionada e pesquisável, apresentada em estilo
wiki tanto no portal público quanto dentro da UI autenticada.

### Single source of truth

Todo conteúdo deve ser mantido como docs-as-code em:

```text
docs/content/<locale>/<section>/<article>.mdx
```

A mesma fonte alimenta:

```text
apps/docs             public documentation portal
apps/web/help         authenticated in-product Help Center
Graphify              documentation knowledge graph
search indexes        compact and distributed profiles
```

Não duplicar manualmente conteúdo entre portal e aplicação. Build, links,
versões, traduções e permissões devem derivar da fonte canônica.

### Wiki-style information architecture

O Help Center deve oferecer:

```text
hierarchical navigation tree
breadcrumbs
full-text search
article table of contents
previous/next article
related articles
backlinks
tags
glossary links
permalinks to headings
recently updated articles
version selector
language selector
copy link
print/PDF-friendly view
edit this page link for contributors
```

Rotas mínimas:

```text
/help
/help/search
/help/getting-started
/help/user
/help/admin
/help/developer
/help/security
/help/api
/help/plugins
/help/troubleshooting
/help/changelog
/help/glossary
```

O layout deve respeitar white-label, tema, idioma, acessibilidade e custom
domain da Organization.

### Documentation catalog

Cobrir integralmente:

```text
Getting Started
Installation
Architecture
Configuration
User Guide
Administrator Guide
Developer Guide
Providers
Agents
Capabilities
Chat and Conversations
MCP
Plugins
Knowledge and RAG
Workflows
AI Evaluations and Model Governance
Privacy, Data Lifecycle and Data Subject Requests
Compliance Extension Providers
Plugin Sandbox and Marketplace Trust
Budgets and Usage
Identity and SSO
Users, Groups, Roles and Policies
API Keys and Service Accounts
Audit and Observability
Backup and Restore
High Availability and Scaling
Incidents, SLOs and Status
Support Matrix and End-of-Life Policy
API
SDK
CLI
Security
Deployment
Troubleshooting
Error Reference
Glossary
Release Notes and Upgrade Guides
Contributing
```

Cada tela, ação, configuração, endpoint, comando CLI, tipo de plugin,
Capability e fluxo administrativo deve possuir pelo menos um artigo
canônico. Uma matriz entre funcionalidade, artigo, link contextual na UI e
testes deve detectar funcionalidades sem cobertura documental.

### Mandatory step-by-step article template

Todo artigo operacional deve conter, quando aplicável:

```text
Title
Purpose and expected outcome
Audience
Required role and permissions
Prerequisites
Supported deployment profiles
Before you begin warnings
Numbered step-by-step procedure
Expected result after each critical step
How to verify the final result
Examples with safe sample data
Screenshots or diagrams when they materially help
Common errors and exact corrective actions
Security, budget and audit implications
Rollback or undo procedure
Related API/CLI alternatives
Related articles
Version introduced/changed
Owner and last reviewed date
```

Passos não podem usar instruções vagas como “configure normalmente” ou
“preencha os campos necessários”. Cada campo deve informar finalidade,
formato, validação, exemplo seguro, valor default e consequência.

Procedimentos destrutivos devem possuir aviso visual, pré-condições,
impacto, possibilidade de recuperação e confirmação explícita.

### Article metadata

Frontmatter obrigatório:

```yaml
id: agents/create-agent
title: Create an agent
description: Create, configure, test and publish an agent.
audience:
  - ai-admin
permissions:
  - agent.create
features:
  - agents
deploymentProfiles:
  - compact
  - distributed
introducedIn: 1.0.0
lastReviewedAt: 2026-08-31
owner: agents-team
tags:
  - agents
  - publishing
```

IDs e URLs permanecem estáveis. Renomear artigo exige redirect permanente
e verificação automática de links antigos.

### In-product Help Center

A aplicação Web deve possuir um Help Center nativo, não apenas um link para
site externo. Ele deve funcionar em instalações self-hosted sem acesso à
internet.

Entradas de ajuda:

```text
global Help Center navigation item
global search / command palette
contextual ? icon on pages, sections and complex fields
empty-state learning links
error messages linked to troubleshooting articles
onboarding checklists
guided setup flows
release notes notification
keyboard shortcut for help
```

Ajuda contextual deve abrir drawer ou painel lateral preservando o estado
da tela. O usuário pode expandir para o artigo completo. Links carregam
`articleId` e heading estáveis, não URLs externas hardcoded.

Erros tipados da API devem possuir `helpArticleId` quando houver orientação
acionável. A UI deve mostrar “Learn how to fix this” sem expor stack traces
ou dados sensíveis.

### Audience and permission-aware documentation

O catálogo deve diferenciar:

```text
end user
organization administrator
AI administrator
developer/API consumer
security administrator
billing administrator
plugin developer
platform operator
```

Busca e navegação autenticadas devem priorizar conteúdo compatível com o
papel, permissões, features habilitadas e perfil de implantação. Isso não
substitui autorização: conteúdo confidencial ou operacional deve possuir
controle de acesso próprio.

Usuários sem permissão não devem receber passos administrativos que revelem
configurações sensíveis. Artigos públicos nunca incluem nomes internos,
tokens, secrets, endpoints privados ou dados reais.

### Search

No perfil compacto, gerar índice local no build. No perfil distribuído,
usar a abstração `Search` com SQL full-text, OpenSearch ou Elasticsearch.

Search deve suportar:

```text
title and body
headings
tags and glossary synonyms
feature and audience filters
locale and product version
typo tolerance
highlighted excerpts
permission filtering
zero-result analytics
```

Atalho de busca deve estar disponível em todas as telas. Resultados devem
apontar diretamente para a seção relevante do artigo.

### Contextual walkthroughs

Fluxos complexos devem possuir tutoriais guiados opcionais:

```text
first organization setup
provider and model configuration
SSO and provisioning
create and publish an Agent
connect an MCP server
publish a Capability through Web/API/MCP
configure budgets and policies
install and approve a plugin
create a Knowledge Base
deploy compact and distributed profiles
backup, restore and disaster recovery
```

Walkthroughs devem ser retomáveis, dispensáveis e compatíveis com teclado e
screen reader. Eles usam os mesmos IDs de artigo para evitar divergência de
conteúdo.

### API, SDK, CLI and configuration reference

Gerar automaticamente, quando possível:

```text
OpenAPI reference and interactive explorer
JSON Schema reference
MCP tools/resources/prompts reference
SDK typed reference and executable examples
CLI command, option and exit-code reference
configuration schema and environment variable reference
plugin manifest and permission reference
error catalog and Problem Details codes
```

Exemplos devem incluir `curl`, TypeScript SDK e, quando aplicável, Python
ou OpenAI-compatible clients. Exemplos executáveis usam dados fictícios e
nunca credentials reais.

### Plugin documentation

Todo plugin deve fornecer conteúdo através de extension point controlado:

```text
overview
installation
permissions requested
configuration fields
authentication setup
capabilities exposed
usage examples
troubleshooting
uninstall and data-retention behavior
version compatibility
```

Plugins não podem injetar HTML ou scripts arbitrários. Markdown/MDX passa
por sanitização e só utiliza componentes aprovados. Desabilitar ou remover
plugin remove seus artigos da navegação ativa, preservando redirects ou
histórico conforme política.

### Versioning and release coupling

Documentação publicada deve corresponder exatamente à versão instalada.

Regras:

```text
docs changes ship in the same pull request as behavior changes
release documentation is immutable after publication except corrections
upgrade guides cover every breaking or operationally relevant change
deprecated features show replacement and removal version
Help Center defaults to the installed product version
old supported versions remain addressable
```

Conteúdo não pode ensinar funcionalidade ausente na versão selecionada.

### Localization

Inglês e português brasileiro devem possuir paridade para toda
documentação de usuário, administrador, segurança e instalação.

CI deve bloquear release quando um artigo obrigatório estiver ausente em
um locale suportado ou quando sua tradução estiver marcada como
desatualizada após mudança material no original.

Código, nomes de campos e mensagens técnicas podem ser preservados quando
necessário, mas explicações e passos devem ser localizados.

### Documentation governance

Cada artigo possui owner e `lastReviewedAt`. Revisão é obrigatória quando:

```text
behavior changes
UI changes
permissions change
API/schema changes
defaults or limits change
security guidance changes
deployment procedure changes
an article receives repeated negative feedback
```

Artigos críticos de segurança, identidade, backup, restore e disaster
recovery devem ser revisados em cada release estável.

O Help Center pode coletar feedback útil/não útil e buscas sem resultado.
Telemetry segue opt-in e nunca envia conteúdo digitado sensível, prompts,
secrets ou dados de usuários.

### Documentation quality gates

CI deve executar:

```text
frontmatter/schema validation
broken internal and external link checks
orphan article and missing backlink detection
duplicate article ID detection
spelling and terminology checks
code sample compilation/typecheck
CLI example smoke tests
OpenAPI and SDK example tests
screenshot freshness checks when screenshots are used
localization parity checks
feature-to-documentation coverage check
contextual help target validation
accessibility tests for Help Center
search indexing tests
offline/self-hosted rendering test
```

### Documentation Definition of Done

Nenhuma funcionalidade está completa sem:

```text
canonical wiki article
complete numbered step-by-step procedure
permissions and prerequisites
verification and troubleshooting
security, budget and audit implications when applicable
contextual link from every relevant UI surface
API/SDK/CLI reference updates when applicable
English and Portuguese versions
passing documentation quality gates
Graphify update when documentation relationships change
```

---

# ADRs

Usar:

```text
docs/adr/
```

Exemplos:

```text
0001-modular-monolith.md
0002-persistence-adapters.md
0003-capability-model.md
0004-plugin-isolation.md
0005-mcp-v2.md
0006-mongodb-first-class-support.md
```

---

# Identity & Provisioning Plugin Architecture

Identity corporativa deve ser uma extensão de primeira classe do sistema
de plugins.

O HandStack Core **não deve depender diretamente de Microsoft Entra ID,
Okta, Keycloak, Auth0, Google Workspace, LDAP, Active Directory ou
qualquer outro fornecedor**.

A arquitetura deve separar claramente:

```text
Identity Provider Plugin
= autentica e/ou sincroniza a identidade externa

HandStack Identity Core
= representa o Principal, usuário, memberships e vínculos externos

RBAC / Policy Engine
= decide o que esse Principal pode fazer
```

Arquitetura:

```text
HandStack Identity Core
        │
        ├── @handstack/plugin-oidc
        ├── @handstack/plugin-saml
        ├── @handstack/plugin-ldap
        ├── @handstack/plugin-entra
        ├── @handstack/plugin-okta
        ├── @handstack/plugin-keycloak
        ├── @handstack/plugin-auth0
        └── @handstack/plugin-google-workspace
```

## Identity Core

Adicionar ao monorepo:

```text
packages/
  identity/
  identity-sdk/
  auth/
  policy/
```

Responsabilidades:

- `identity`: modelo interno de identidade, external identities,
  mappings, memberships e provisioning.
- `identity-sdk`: contratos usados por plugins de identidade.
- `auth`: sessões, tokens, login/logout e refresh.
- `policy`: autorização RBAC/ABAC e avaliação de policies.

O Identity Core não deve conhecer SDKs específicos de fornecedores.

## Identity Provider Plugin capabilities

Plugins devem declarar capabilities específicas no manifest.

Exemplo Microsoft Entra:

```json
{
  "name": "@handstack/plugin-entra",
  "version": "1.0.0",
  "handstack": {
    "apiVersion": "1",
    "capabilities": [
      "identity.oidc",
      "identity.saml",
      "identity.scim",
      "identity.user-sync",
      "identity.group-sync",
      "identity.logout"
    ]
  }
}
```

Exemplo LDAP / Active Directory:

```text
identity.ldap
identity.user-sync
identity.group-sync
```

Capabilities previstas:

```text
identity.oidc
identity.oauth2
identity.saml
identity.ldap
identity.scim
identity.jit
identity.user-sync
identity.group-sync
identity.attribute-mapping
identity.logout
identity.session-revocation
```

## Identity Provider contract

O SDK deve permitir contratos especializados em vez de obrigar todos os
plugins a implementar todas as operações.

Exemplo conceitual:

```typescript
interface IdentityProviderPlugin {
  authenticate?(request: AuthenticationRequest): Promise<AuthResult>;

  getAuthorizationUrl?(request: IdentityAuthorizationRequest): Promise<string>;

  handleCallback?(request: IdentityCallbackRequest): Promise<AuthResult>;

  refreshIdentity?(identity: ExternalIdentity): Promise<ExternalIdentity>;

  logout?(request: LogoutRequest): Promise<void>;

  provisionUsers?(request: ProvisioningRequest): Promise<ProvisioningResult>;

  provisionGroups?(request: ProvisioningRequest): Promise<ProvisioningResult>;

  syncUsers?(request: SyncRequest): Promise<SyncResult>;

  syncGroups?(request: SyncRequest): Promise<SyncResult>;

  validateConfiguration?(): Promise<ValidationResult>;
}
```

Preferir internamente interfaces menores por capability, por exemplo:

```text
OidcIdentityProvider
SamlIdentityProvider
LdapIdentityProvider
ScimProvisioningProvider
UserSyncProvider
GroupSyncProvider
LogoutProvider
SessionRevocationProvider
```

Isso evita interfaces monolíticas.

## Provedores oficiais

Plugins genéricos oficiais:

```text
@handstack/plugin-oidc
@handstack/plugin-saml
@handstack/plugin-ldap
```

Plugins específicos oficiais:

```text
@handstack/plugin-entra
@handstack/plugin-okta
@handstack/plugin-keycloak
@handstack/plugin-auth0
@handstack/plugin-google-workspace
```

Plugins específicos podem reutilizar componentes compartilhados dos
plugins/protocolos genéricos.

## Microsoft Active Directory

Suportar dois cenários distintos:

```text
Microsoft Entra ID
→ OIDC / OAuth2 / SAML / SCIM

Active Directory tradicional
→ LDAP / LDAPS

ADFS
→ SAML e/ou OIDC conforme configuração
```

Nunca tratar Entra ID e Active Directory LDAP como se fossem o mesmo
protocolo.

## SSO

Suportar:

```text
OIDC
OAuth2 quando aplicável
SAML 2.0
LDAP / LDAPS
```

Organizações podem configurar um ou mais Identity Providers.

Entidade:

```text
IdentityProvider
```

Campos conceituais:

```text
id
organizationId
pluginId
name
slug
type
enabled
priority
configuration
loginPolicy
provisioningPolicy
mappingPolicy
createdAt
updatedAt
```

## Multiple Identity Providers

Uma Organization pode possuir múltiplos IdPs.

Exemplo:

```text
Acme Corporation
  ├── Microsoft Entra — funcionários
  ├── Okta — parceiros
  └── Local break-glass — administradores de emergência
```

A tela de login deve poder apresentar os providers permitidos pela
Organization.

## IdP discovery

Suportar descoberta por:

```text
organization slug
custom domain
email domain
explicit login URL
```

Exemplo:

```text
user@acme.com
→ identifica Organization Acme
→ direciona para Microsoft Entra
```

Domain discovery deve ser configurável e não pode, sozinho, conceder
acesso.

## JIT Provisioning

Permitir Just-in-Time provisioning no primeiro login.

Fluxo:

```text
SSO callback
→ validar identidade
→ localizar ExternalIdentity
→ localizar User existente quando permitido
→ criar User se JIT estiver habilitado
→ mapear atributos
→ mapear grupos
→ aplicar default roles/groups
→ criar sessão
→ audit
```

O comportamento de account linking deve ser configurável para evitar
account takeover.

## SCIM 2.0

Implementar suporte a SCIM 2.0 para provisioning corporativo.

Cobrir:

```text
Users
Groups
Group memberships
activation
deactivation
profile updates
```

O HandStack deve permitir que IdPs corporativos façam provisioning e
deprovisioning sem exigir primeiro login.

O SCIM deve possuir autenticação própria, rate limiting, audit e
isolamento por Organization.

## User synchronization

Plugins podem implementar sincronização pull quando SCIM push não
estiver disponível.

Suportar:

```text
full sync
incremental sync quando provider permitir
scheduled sync
manual sync
dry-run
```

Registrar resultados e erros.

## Group synchronization

Grupos externos não devem ser automaticamente equivalentes aos grupos
internos.

Criar mapping explícito:

```text
External Group
      │
      ▼
Identity Mapping
      │
      ▼
HandStack Group
```

Exemplo:

```text
Entra: Developers
→ HandStack: developers

Entra: Security
→ HandStack: security
```

## Attribute Mapping

Permitir mapear claims/attributes externos:

```text
email
displayName
givenName
familyName
employeeId
department
jobTitle
manager
country
locale
custom attributes
```

Mappings podem alimentar policies, mas atributos externos devem ser
normalizados antes de serem usados pelo Policy Engine.

## Dynamic mapping rules

Permitir regras como:

```text
department == "Engineering"
→ add group Developers

jobTitle == "Architect"
→ add group Architects

country == "BR"
→ add group Brazil
```

A regra apenas produz memberships/attributes internos; o plugin não
concede diretamente acesso a models, agents, MCP ou capabilities.

## External Identity

Criar entidade:

```text
ExternalIdentity
```

Campos:

```text
id
organizationId
userId
identityProviderId
externalSubject
externalUsername
externalEmail
attributes
lastAuthenticatedAt
lastSynchronizedAt
createdAt
updatedAt
```

A chave externa deve considerar provider + subject, e não apenas email.

## External Groups

Criar:

```text
ExternalGroup
IdentityMapping
```

Campos conceituais:

```text
ExternalGroup:
  id
  organizationId
  identityProviderId
  externalId
  name
  attributes

IdentityMapping:
  id
  organizationId
  identityProviderId
  sourceType
  sourceValue
  targetType
  targetId
  conditions
```

## Provisioning entities

Adicionar:

```text
ProvisioningJob
ProvisioningEvent
ProvisioningError
```

Estados de job:

```text
PENDING
RUNNING
COMPLETED
PARTIALLY_COMPLETED
FAILED
CANCELLED
```

## Deprovisioning

Desativação externa deve poder:

```text
disable HandStack user
revoke active sessions
revoke refresh tokens
disable API keys owned by user quando configurado
remove temporary grants
prevent new executions
preserve audit history
preserve historical ownership references
```

Nunca apagar audit history por deprovisioning.

## Session revocation

Quando o Identity Provider ou provisioning indicar que o usuário foi
desativado:

```text
User disabled
→ Session revoked
→ Refresh tokens revoked
→ new requests denied
```

Para operações long-running, o sistema deve possuir pontos de
revalidação configuráveis.

## MFA

HandStack não deve reinventar MFA para usuários autenticados por IdP.

MFA, Conditional Access e políticas equivalentes devem preferencialmente
ser delegadas ao Identity Provider.

O HandStack pode consumir claims de autenticação para policies quando
disponíveis.

## IdP Enforcement

Organization pode configurar:

```text
local login allowed
local login disabled
SSO required
specific IdP required
```

Contas locais não devem contornar uma política `SSO required`.

## Break-glass administrators

Permitir contas administrativas locais de emergência de forma opcional.

Requisitos:

```text
explicit enablement
strong password policy
restricted number of accounts
audit
alerts on use
cannot silently bypass organization policy
```

## Service Accounts and Workload Identities

Identidade humana e identidade de máquina devem permanecer separadas.

Suportar:

```text
User
ServiceAccount
Application
Agent
API_KEY
```

Todos podem ser representados como `Principal`, mas não devem
compartilhar fluxos de login humano.

## Plugin-owned configuration UI

Identity plugins podem registrar formulários de configuração através dos
extension points controlados do Plugin UI.

Exemplo Entra:

```text
Tenant ID
Client ID
Client Secret
Redirect URI
Issuer
Scopes

Enable OIDC login
Enable SCIM provisioning
Enable group synchronization
Enable JIT provisioning
```

Secrets devem ser armazenados através de `SecretProvider`, nunca
diretamente no configuration JSON.

## Admin UI

Adicionar:

```text
Settings
  └── Identity Providers
```

Funções:

```text
Add Identity Provider
Enable / Disable
Test Connection
Configure Login
Configure Provisioning
Configure Attribute Mapping
Configure Group Mapping
Run Synchronization
View Synchronization History
View Errors
Set Default Provider
Configure SSO Enforcement
```

## Identity plugin security

Plugins de identidade são security-sensitive.

Exigir:

```text
explicit permissions
secret isolation
signed state/nonce validation
PKCE quando aplicável
OIDC issuer validation
token signature validation
audience validation
SAML signature validation
LDAP TLS validation
SCIM authentication
anti-replay controls
audit
rate limiting
```

Community identity plugins devem preferencialmente usar runtime isolado,
exceto quando explicitamente classificados como trusted.

## Authorization boundary

Regra arquitetural obrigatória:

> Identity plugins nunca autorizam diretamente acesso a recursos
> HandStack.

Fluxo correto:

```text
External IdP
   │
   ▼
Identity Plugin
   │
   ▼
Identity Core
   │
   ▼
Principal + Memberships + Attributes
   │
   ▼
Policy Engine
   │
   ▼
AuthorizationDecision
```

A autorização de:

```text
Models
Agents
Capabilities
MCP servers
MCP tools
Knowledge Bases
Plugins
Budgets
Administration
```

continua exclusivamente sob RBAC/ABAC/Policy Engine do HandStack.

## Identity audit events

Adicionar:

```text
IDENTITY_PROVIDER_CREATED
IDENTITY_PROVIDER_UPDATED
IDENTITY_PROVIDER_DISABLED
SSO_LOGIN_STARTED
SSO_LOGIN_SUCCEEDED
SSO_LOGIN_FAILED
JIT_USER_CREATED
EXTERNAL_IDENTITY_LINKED
EXTERNAL_IDENTITY_UNLINKED
SCIM_USER_CREATED
SCIM_USER_UPDATED
SCIM_USER_DISABLED
SCIM_GROUP_CREATED
SCIM_GROUP_UPDATED
IDENTITY_SYNC_STARTED
IDENTITY_SYNC_COMPLETED
IDENTITY_SYNC_FAILED
GROUP_MAPPING_CHANGED
SESSION_REVOKED_BY_IDENTITY_EVENT
BREAK_GLASS_LOGIN
```

## Identity observability

Instrumentar:

```text
SSO latency
SSO failures
SCIM requests
sync duration
sync failures
users provisioned
users deprovisioned
groups synchronized
mapping failures
session revocations
```

Nunca incluir tokens, passwords ou secrets em traces/logs.

## Identity plugin test kit

Adicionar testes ao `@handstack/plugin-testkit`:

```text
OIDC callback contract
state/nonce validation
PKCE
SAML assertion validation
LDAP connection
SCIM Users contract
SCIM Groups contract
JIT provisioning
group mapping
attribute mapping
deprovisioning
session revocation
multi-tenant isolation
secret leakage prevention
```

## Alteração no roadmap

Identity plugins não devem ficar inteiramente para Enterprise Hardening.

### Milestone 2 --- Identity Foundation

Implementar:

```text
Organization
User
Principal
Group
Role
Permission
local auth
sessions
API keys
Identity Core
Identity Provider contracts
ExternalIdentity
IdentityMapping
Generic OIDC plugin
JIT provisioning
```

Critério adicional:

```text
Um Identity Provider OIDC pode ser instalado/configurado como plugin,
um usuário pode entrar via SSO,
ser criado via JIT e receber memberships mapeadas.
```

### Milestone 11 --- Plugin SDK

Adicionar suporte formal a:

```text
identity provider registration
identity capabilities
plugin-owned identity configuration
identity plugin permissions
```

### Milestone 12 --- Plugin UI

Adicionar extension points controlados para:

```text
Identity Provider configuration
Provisioning configuration
Group mapping
Attribute mapping
Connection tests
Sync status
```

### Milestone 14 --- Governance & Provisioning

Adicionar:

```text
SCIM 2.0
user/group synchronization
deprovisioning
session revocation
multiple IdPs
IdP enforcement
advanced mapping
Access Requests
Temporary Access
Human Approval
ABAC
advanced policies
```

### Milestone 18 --- Enterprise Hardening

Completar:

```text
advanced SAML
AD/LDAP enterprise scenarios
ADFS compatibility
enterprise SCIM hardening
advanced Entra integration
advanced Okta integration
advanced Keycloak integration
identity HA
enterprise audit integrations
```

## Definition of Done para Identity Providers

Nenhuma integração de identidade está pronta sem:

```text
protocol contract tests
tenant isolation tests
login failure tests
account-linking tests
deprovisioning tests
session revocation tests
authorization boundary tests
audit events
OpenTelemetry spans
secret leakage tests
documentation
admin UI
migration
upgrade compatibility
```

# Prioridades arquiteturais máximas

1.  Capability é a abstração central.
2.  Web, REST, MCP e Agents passam pelo mesmo
    `CapabilityExecutionEngine`.
3.  Authorization ocorre em toda execução.
4.  Budget ocorre em toda execução paga.
5.  Audit ocorre em toda execução relevante.
6.  LLMs são providers substituíveis.
7.  MCP funciona nas duas direções.
8.  Agents são publicáveis como capabilities.
9.  Plugins não dependem do core internamente.
10. Bancos SQL e MongoDB ficam escondidos atrás de repositories e devem
    possuir paridade funcional.
11. Funcionalidades transversais usam extension points versionados com
    implementação oficial embutida.
12. Plugins nunca contornam autorização, isolamento de tenant, budget,
    auditoria, privacidade ou o `CapabilityExecutionEngine`.
13. Prompts, models, Agents, RAG e workflows publicados passam por
    evaluation gates reproduzíveis.
14. Requisitos possuem IDs estáveis e rastreabilidade até testes e
    documentação.

---

# Diferencial principal do HandStack

Fluxo principal a demonstrar:

```text
1. Admin cria grupo Developers.

2. Admin cria Security Agent.

3. Agent usa Claude.

4. Agent recebe GitHub MCP.

5. Admin permite:
   github.read
   github.search

6. Admin bloqueia:
   github.delete

7. Admin define:
   $25 / mês por usuário.

8. Admin habilita:
   Web ✓
   API ✓
   MCP ✓

9. Developer abre HandStack:
   Security Agent aparece.

10. Developer conecta Cursor:
    security_review aparece via MCP.

11. Developer chama:
    security_review

12. HandStack:
    autentica
    autoriza
    verifica budget
    executa agent
    agent chama GitHub MCP
    registra consumo
    registra audit
    retorna resultado
```

Se esse fluxo funcionar, a arquitetura central do produto estará
validada.

---

# Arquitetura final resumida

```text
                         HANDSTACK

                    ┌─────────────────┐
                    │    Web / Chat   │
                    │   White-label   │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
             Web            API            MCP
              │              │              │
              └──────────────┼──────────────┘
                             │
                  Execution Context
                             │
                             ▼
                Capability Execution Engine
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
       Identity           Policy             Budget
          │                  │                  │
          └──────────────────┼──────────────────┘
                             │
                             ▼
                   Capability Registry
                             │
       ┌─────────────────────┼─────────────────────┐
       │                     │                     │
     Agents                Tools               Knowledge
       │                     │                     │
       └─────────────────────┼─────────────────────┘
                             │
                  ┌──────────┴──────────┐
                  │                     │
               LLM Gateway          MCP Client
                  │                     │
       ┌──────────┼─────────┐     ┌─────┼──────┐
       │          │         │     │     │      │
     OpenAI    Anthropic  Gemini GitHub Jira Internal
       │
     Ollama
       │
      vLLM

                             │
                             ▼
                         Plugins
                             │
                ┌────────────┼────────────┐
                │            │            │
             Provider       Tool         Agent
                │            │            │
              Auth         MCP           UI
```

---

# Ordem recomendada para o Codex

Não solicitar:

> "Implemente HandStack."

Solicitar milestone por milestone.

Ordem:

```text
M0 repository
M1 database
M2 identity
M3 provider abstraction
M4 chat
M5 gateway
M6 usage/budget
M7 capability engine
M8 agent harness
M9 MCP client
M10 MCP server
M11 plugins
M12 plugin UI
M13 knowledge
M14 governance
M15 multi-agent
M16 workflows
M17 marketplace
M18 production scale and enterprise hardening
```

Cada milestone deverá obrigatoriamente:

1.  consultar o grafo existente com orçamento de tokens;
2.  confirmar no código-fonte os achados críticos do grafo;
3.  identificar e atualizar os requirement IDs e a rastreabilidade;
4.  propor arquitetura e extension points aplicáveis;
5.  listar arquivos a criar;
6.  implementar;
7.  criar migrations;
8.  criar unit tests;
9.  criar integration, contract e failure-mode tests;
10. executar evaluation gates quando houver comportamento de IA;
11. atualizar OpenAPI e schemas de eventos;
12. criar ou atualizar o artigo wiki passo a passo;
13. adicionar ou validar ajuda contextual na UI;
14. manter paridade da documentação em inglês e português;
15. executar os quality gates de documentação;
16. atualizar o Graphify quando houver mudança estrutural ou documental;
17. executar lint;
18. executar typecheck;
19. executar tests;
20. executar build;
21. reportar decisões, evidências e pendências.

---

# Prompt base recomendado para o Codex

```text
You are implementing HandStack, an open-source AI workspace,
agent runtime and capability gateway.

HandStack's central abstraction is Capability.

Every capability may be published through Web, REST API,
MCP or exposed as a tool to another Agent.

All execution channels MUST pass through the same
CapabilityExecutionEngine.

The engine MUST apply:

authentication
authorization
policy evaluation
rate limits
budget reservation
guardrails
human approval when required
execution
usage accounting
budget settlement
audit
telemetry

The architecture is a modular monolith written in Node.js
and TypeScript.

The complete product MUST support compact and distributed deployment
profiles. Distributed mode runs stateless Web, API and MCP replicas,
specialized BullMQ workers, Redis HA with Redis Streams, an HA SQL cluster
or MongoDB cluster, and shared object storage.

Kubernetes and the official Helm Chart MUST provide HPA for synchronous
services and KEDA for workers. Implement backpressure, bounded queues,
dead-letter handling, cursor-based stream reconnection, graceful shutdown,
multi-zone availability, zero-downtime upgrades and tested multi-region
disaster recovery. Scalability is part of the final product, not deferred
work.

Documentation is a product feature. Every user-visible or administrative
function MUST ship with a canonical docs-as-code wiki article containing
prerequisites, permissions, a complete numbered procedure, expected
results, verification, troubleshooting, security/budget/audit implications
and rollback guidance when applicable.

The Web UI MUST provide an offline-capable in-product Help Center with
wiki navigation, full-text search and contextual links from every relevant
page, section, complex field and actionable error. Public docs and the Help
Center MUST render the same canonical source. English and Portuguese
documentation MUST remain in parity, and documentation quality gates MUST
pass before a feature is complete.

Cross-cutting features MUST be pluggable through versioned extension
contracts, including policy, guardrails, AI evaluation, privacy, data
lifecycle, compliance, sandboxing, audit export, SIEM, RAG policy,
workflow nodes, webhook transports and incident management. Pluggable does
not mean optional: every critical extension point MUST have an official
built-in implementation, and third-party plugins MUST NOT bypass the core
execution, authorization, tenant-isolation, privacy or audit pipeline.

Every implementable requirement MUST have a stable requirement ID and
traceability to modules, public contracts, data entities, migrations,
tests and canonical documentation.

Prompts, models, Agents, RAG and AI workflows MUST pass versioned evaluation
gates before stable publication. Workflows MUST use durable checkpoints,
bounded concurrency, idempotent steps and explicit compensation semantics.

Privacy MUST cover data inventory, retention, legal hold, data-subject
requests, deletion propagation, residency and provider disclosure across
SQL/MongoDB, vector stores, search, object storage, caches, queues, backups
and plugin-owned data.

Backend:
NestJS + Fastify.

Database:
Repository and transaction interfaces are the canonical persistence
abstraction.

SQL databases use TypeORM adapters.
MongoDB uses an official MongoDB Node.js Driver adapter.

MongoDB MUST be usable as the only primary database, without a SQL
database. Every domain repository and feature available on SQL MUST have
behavioral parity on MongoDB.

No domain module may depend directly on TypeORM, MongoDB Driver, SQL,
MongoDB document concepts, NestJS, Redis, provider SDKs or the MCP SDK.

Official databases:

PostgreSQL
MySQL
MariaDB
SQLite
Microsoft SQL Server
MongoDB

PostgreSQL is the recommended production database.
SQLite is the default zero-infrastructure development database.
MongoDB is a first-class production alternative and may persist the
entire HandStack domain.

Production MongoDB deployments MUST use a replica set or sharded cluster
when multi-document transactions are required. MongoDB collections MUST
use managed schema validation, document migrations, tenant-scoped indexes
and the same repository contract test suite used by SQL adapters.

Frontend:
Next.js + React + TypeScript.

MCP:
Use the official Model Context Protocol TypeScript SDK.

Observability:
OpenTelemetry.

Background jobs:
BullMQ when distributed jobs are required.

The system is multi-tenant.
Every tenant-owned resource MUST be scoped by organizationId.

Authorization is deny-by-default.

Never place business logic in controllers or React components.

All external systems must be accessed through interfaces/adapters.

Write production-quality code with strict TypeScript,
tests, migrations, documentation and security checks.

Implement the selected milestone completely while preserving the final
architecture and contracts defined by this specification.

Prefer small modules with explicit contracts.

Preserve backwards compatibility of public APIs.

Before coding:
1. check whether graphify-out/graph.json exists;
2. build or incrementally update Graphify when missing or stale;
3. query Graphify first with an explicit token budget;
4. inspect the source locations returned by the graph;
5. treat INFERRED and AMBIGUOUS relationships as hypotheses;
6. identify the existing architecture;
7. propose the changes;
8. implement them incrementally;
9. update Graphify after structural changes;
10. run lint, typecheck, tests and build;
11. fix failures before completing.

Graphify is a development aid, not a source of truth. Never invent graph
edges, never expose secrets to semantic extraction, and never ship
graphify-out in production artifacts.
```

---

# North Star

O HandStack não deve se tornar apenas:

- mais um chat UI;
- mais um LLM gateway;
- mais um MCP Gateway;
- mais um agent framework.

A proposta central é unir:

```text
AI Workspace
+
Agent Harness
+
AI Gateway
+
Capability Platform
+
MCP Client / Server
+
Plugin Ecosystem
+
Enterprise Governance
```

em uma plataforma open source extensível.

O objeto fundamental não é o modelo.

Não é o chat.

Não é o MCP.

Não é o agent.

É:

```text
CAPABILITY
```

E qualquer Capability pode ser:

```text
created
installed
governed
budgeted
audited
executed
shared
published
```

através de:

```text
Web
API
MCP
Agents
```

Esse princípio deve orientar todas as decisões de arquitetura do
HandStack.
