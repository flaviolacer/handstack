# Requirements traceability

This matrix is generated conceptually from `catalog.yaml` and is enforced by `npm run docs:validate`. Each implemented requirement names existing modules, test files, and canonical article IDs.

| Requirement | Module / contract                                | Test evidence                | Documentation                       |
| ----------- | ------------------------------------------------ | ---------------------------- | ----------------------------------- |
| HS-CORE-001 | workspace manifests                              | HS-T-M0-WORKSPACE-001        | getting-started/overview            |
| HS-CORE-002 | strict TypeScript and ESLint                     | HS-T-M0-TYPES-001            | getting-started/overview            |
| HS-CORE-003 | ExtensionProvider / ExtensionRegistry            | HS-T-M0-EXT-001..002         | getting-started/overview            |
| HS-API-001  | Fastify health endpoints                         | HS-T-M0-HEALTH-001           | getting-started/overview            |
| HS-API-002  | ProblemDetails                                   | HS-T-M0-PROBLEM-001..002     | getting-started/overview            |
| HS-CORE-004 | HandStackConfig                                  | HS-T-M0-CONFIG-001..003      | getting-started/overview            |
| HS-DOC-001  | docs-engine, public docs, Help Center            | HS-T-M0-DOCS-001..003        | user/help-center                    |
| HS-UX-001   | Web Help Center shell                            | HS-T-M0-WEB-001..003         | user/help-center                    |
| HS-DATA-001 | Repository / TransactionManager                  | HS-T-M1-PERSISTENCE-001      | getting-started/overview            |
| HS-DATA-002 | UUIDv7 identifiers                               | HS-T-M1-UUID-001..003        | getting-started/overview            |
| HS-DATA-003 | TypeOrmAdapter / SQL migration                   | HS-T-M1-SQL-001..004         | getting-started/overview            |
| HS-DATA-004 | MongoAdapter / document migrations               | HS-T-M1-MONGO-001..003       | getting-started/overview            |
| HS-DATA-005 | Database factory / NestJS lifecycle              | HS-T-M1-FACTORY-001..004     | getting-started/overview            |
| HS-DATA-006 | Shared persistence conformance                   | HS-T-M1-CONFORMANCE-001      | getting-started/overview            |
| HS-DATA-007 | Official SQL adapter matrix                      | HS-T-M1-SQL-MATRIX-001       | getting-started/overview            |
| HS-DATA-008 | Signed portable persistence protocol             | HS-T-M1-PORTABLE-001         | getting-started/overview            |
| HS-OPS-001  | Portable database CLI commands                   | HS-T-M1-CLI-001              | getting-started/overview            |
| HS-AI-014   | Chat domain, API, SSE and Web workspace          | HS-T-M4-WEB-CLIENT-001       | user/chat-workspace                 |
| HS-API-003  | Virtual API keys and OpenAI-compatible Gateway   | HS-T-M5-GATEWAY-HTTP-001     | getting-started/gateway             |
| HS-API-004  | Tenant budgets, reservations, usage and cost     | HS-T-M6-BUDGET-001..002      | getting-started/budgets             |
| HS-API-005  | Governed capability registry and execution       | HS-T-M7-CAPABILITY-001..002  | getting-started/capabilities        |
| HS-API-006  | Agent harness and governed tool loop             | HS-T-M8-AGENT-001..002       | getting-started/agents              |
| HS-API-007  | Governed MCP client connectivity                 | HS-T-M9-MCP-CLIENT-001       | getting-started/mcp-client          |
| HS-API-008  | Authenticated MCP server endpoint                | HS-T-M10-MCP-SERVER-001      | getting-started/mcp-server          |
| HS-CORE-006 | Plugin SDK lifecycle and isolation               | HS-T-M11-PLUGIN-001          | getting-started/plugins             |
| HS-AI-015   | Portable tenant-scoped Knowledge/RAG             | HS-T-M12-KNOWLEDGE-001       | getting-started/knowledge           |
| HS-API-009  | Plugin registry and marketplace catalogs         | HS-T-M13-PLUGIN-REGISTRY-001 | getting-started/plugins             |
| HS-AI-016   | Multi-agent orchestration, memory and guardrails | HS-T-M15-AGENTS-001          | getting-started/agents              |
| HS-DATA-011 | Tenant-scoped storage and file security          | HS-T-M18-STORAGE-001         | getting-started/storage             |
| HS-CORE-007 | Hierarchical feature flags                       | HS-T-M19-FLAGS-001           | getting-started/feature-flags       |
| HS-SEC-012  | Privacy, retention and data lifecycle controls   | HS-T-M20-PRIVACY-001         | getting-started/privacy-lifecycle   |
| HS-OPS-005  | Bounded background jobs and worker queues        | HS-T-M22-JOBS-001            | getting-started/jobs                |
| HS-OPS-004  | Append-only audit and SIEM export                | HS-T-M21-AUDIT-001           | getting-started/audit-observability |

Migrations are empty for the M0 requirements and the initial M1 contracts because they introduce no concrete stored collection or table. Adapter requirements that add state must reference SQL and MongoDB migration evidence.
| HS-OPS-006 | Distributed deployment topology and scaling | HS-T-M23-DEPLOY-001 | getting-started/distributed-deployment |
| HS-API-010 | Tenant-scoped operations administration API | HS-T-M24-OPERATIONS-001 | getting-started/operations-api |
| HS-DATA-012 | Portable object-storage adapter matrix | HS-T-M25-STORAGE-ADAPTERS-001 | getting-started/storage |
| HS-SEC-014 | Encryption at rest for secrets | HS-T-M34-ENCRYPTION-001..003 | getting-started/encryption-secrets |
| HS-SEC-015 | SCIM 2.0 corporate provisioning domain | HS-T-M35-SCIM-001 | getting-started/scim |
| HS-SEC-016 | Secure sandbox for untrusted code execution | HS-T-M36-SANDBOX-001..003 | getting-started/plugin-sandbox |
| HS-SEC-017 | Dedicated SCIM 2.0 HTTP endpoint | HS-T-M37-SCIM-HTTP-001 | getting-started/scim |
