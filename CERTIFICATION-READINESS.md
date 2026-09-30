# HandStack — matriz de readiness para certificação

Atualizado em 2026-09-29. Este documento é um plano operacional de evidências, não substitui a
especificação nem o catálogo de rastreabilidade em `docs/requirements/catalog.yaml`. Um gate só
pode mudar de `PENDENTE` para `APROVADO` quando o artefato indicado existir, estiver datado e for
reproduzível no ambiente exigido.

## Estado atual

Os seis gates abaixo continuam `PENDENTE`. Os testes offline e os validadores locais comprovam
contratos e preparação, mas não certificam um ambiente implantado, provedores reais ou revisão
independente de segurança. A auditoria viva continua em `PARTIAL`.

Os procedimentos operacionais estão consolidados em [`CERTIFICATION-RUNBOOKS.md`](./CERTIFICATION-RUNBOOKS.md);
este documento continua sendo a matriz de decisão e de promoção dos gates.

| Gate                                | Pré-requisitos objetivos                                                                                          | Evidência obrigatória                                                                                                          | Critério de aprovação                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Banco HA, failover e backup/restore | Ambiente SQL e Mongo de produção ou equivalente aprovado; réplicas e armazenamento persistente; janela de mudança | plano de topologia, logs de failover, backup imutável, restauração em ambiente isolado, checksum e relatório de perda de dados | failover sem corrupção; restauração validada; tempo e perda dentro dos objetivos publicados         |
| DR multi-zona/multi-região          | duas regiões ou zonas independentes; replicação de banco, objetos e segredos; DNS/fencing operacionais            | diagrama, timeline do exercício, comandos, métricas de RPO/RTO, smoke tests pós-promoção e failback auditado                   | RPO ≤ 5 min, RTO ≤ 15 min, uma única região aceita escrita e failback é separado e auditado         |
| Capacidade p95/p99                  | ambiente com topologia final; carga representativa; métricas de API, filas, banco e providers                     | cenário versionado, volume/rate, p50/p95/p99, erros, saturação, custo e recursos por componente                                | limites de latência/erro definidos pela release são atendidos sem violar isolamento ou backpressure |
| Upgrade sem downtime e rollback     | release anterior e candidata implantadas; migrations reversíveis/compatíveis; health gates                        | versão/digest, plano de migração, timeline, probes, métricas durante rollout, rollback executado e integridade pós-rollback    | tráfego não interrompido, dados compatíveis, rollback comprovado e nenhuma perda de auditoria       |
| Providers externos e E2E            | credenciais de teste aprovadas; endpoints compatíveis para LLM, embeddings, MCP, storage e notificações           | contrato/configuração redigida, request/response sanitizados, IDs de execução, traces, auditoria e resultado por provider      | fluxos críticos passam pelo runtime governado; segredos e identificadores vendor não vazam          |
| Threat model e pentest              | release candidata congelada; escopo e regras de engajamento aprovados; ambiente isolado                           | threat model versionado, escopo, achados, severidade, evidência de reteste e aceite formal de risco                            | nenhum achado crítico/alto sem correção ou aceite explícito; reteste confirma correções             |

## Preparação local já disponível

Antes de um exercício externo, executar os gates locais com npm e guardar a saída no pacote de
evidências da release:

```text
npm run format:check
npm run docs:validate
npm run lint
npm run typecheck
npm test
npm run build
npm run security:validate
npm run openapi:validate
npm run scope:audit
```

Para coletar a mesma preparação, incluindo os validadores de contrato, com manifesto e um log
separado por comando, use:

```text
npm run certification:preflight -- --output artifacts/certification/release-candidate --include-contracts
```

O coletor nunca marca um gate externo como aprovado. O `manifest.json` registra explicitamente
`NOT_CERTIFIED` até que os artefatos de ambiente, providers autorizados e revisão independente
descritos nesta matriz sejam anexados.

Na revalidação local de 2026-09-29, o pacote
`artifacts/certification/release-candidate-2026-09-29` registrou 19/19 gates locais aprovados,
incluindo a validação de dependências de produção, com Docker 29.8.0 e Redis de conformance
disponíveis. Os drills Redis isolados (worker, core Streams, Event Bus, workflow e Knowledge
reindex) também passaram. Esse pacote é
reprodutível e útil como preparação da release, mas não deve ser movido para nenhum dos seis
diretórios externos nem usado para promover um gate sem os artefatos de ambiente correspondentes.
O resumo e os links para os logs dos drills estão em
`artifacts/certification/release-candidate-2026-09-29/redis-drill-summary.md`.

Os validadores adicionais de contrato (`resilience:validate`, `dr:validate`,
`container:validate`, `observability:validate`, `integration:validate`, `helm:validate`,
`kubernetes:validate` e `release:validate`) devem acompanhar a release quando aplicáveis. A saída
local deve ser anexada como preparação, nunca como substituta do drill externo.

Para o exercício de coordenação Redis do append de auditoria, provisionar um Redis de teste isolado e
executar, no PowerShell, o teste que usa dois coordenadores e mede exclusão mútua:

```text
$env:HANDSTACK_TEST_REDIS_URL='redis://localhost:6379/15'
npm --prefix apps/worker test -- --run tests/redis.integration.test.ts
```

O teste deve terminar sem casos `skipped` e seu log deve ser anexado ao diretório `dr/` ou
`database-ha/`, conforme o exercício. Sem a variável ou sem o Redis disponível, o Vitest marca o
arquivo como `skipped`; isso é preparação incompleta, não evidência de aprovação.

O exercício deve incluir uma seção crítica deliberadamente mais longa que um intervalo de renovação,
confirmar que a lease é renovada, interromper ou isolar o owner durante uma execução e verificar que
uma réplica concorrente nunca entra na mesma seção crítica enquanto o token original permanece válido.
Se a renovação perder ownership, o resultado esperado é falha fechada (`Audit append lock lease was
lost`) e nenhum evento deve ser promovido a evidência de append confirmado.

## Plano de desbloqueio

A preparação local já foi executada: Docker Desktop Linux Engine, Redis, MongoDB, SQL, vetores e
MinIO produziram evidências datadas no pacote de release candidate. O código local pode continuar
avançando, mas os seis gates externos exigem agora staging/produção autorizado, owner operacional,
janela de mudança e acesso aos dashboards de banco, filas, providers e auditoria. Não se deve
promover um gate externo usando apenas containers locais ou testes loopback.

Em qualquer rota, executar nesta ordem:

```text
# 1. Fixar a release e coletar a preparação local
git rev-parse HEAD
npm run certification:preflight -- --output artifacts/certification/release-candidate --include-contracts

# 2. Reconfirmar Redis distribuído no ambiente do exercício, sem deixar testes opcionais como skipped
$env:HANDSTACK_TEST_REDIS_URL='redis://<host>:<port>/15'
npm --prefix apps/worker test -- --run tests/redis.integration.test.ts

# 3. Executar os seis exercícios na ordem dos diretórios
# database-ha -> dr -> capacity -> upgrade-rollback -> providers -> security
```

Cada exercício deve anexar `release.json`, logs datados, métricas, auditoria e aprovação no diretório
correspondente. O gate só muda para `APROVADO` depois de revisar o README do exercício, confirmar que
não há credenciais nos artefatos e verificar o critério de aprovação da tabela acima. Um smoke test
local, um teste loopback ou um container efêmero não substitui essa evidência.

**Próxima decisão necessária:** indicar o primeiro gate externo, seu owner, a janela autorizada e o
ambiente de execução. Docker/Redis local já estão disponíveis e a preparação local está verde;
sem um ambiente autorizado e revisão independente, não há comando adicional no repositório que
possa produzir evidência válida para promover os gates externos.

## Próxima ação quando o ambiente autorizado estiver disponível

| Gate                                | Ação inicial                                                              | Responsável mínimo                    | Diretório de evidência |
| ----------------------------------- | ------------------------------------------------------------------------- | ------------------------------------- | ---------------------- |
| Banco HA, failover e backup/restore | congelar release, executar backup e simular failover controlado           | DBA + operador de release             | `database-ha/`         |
| DR multi-zona/multi-região          | validar fencing, promover uma região e medir RPO/RTO                      | SRE + owner de dados                  | `dr/`                  |
| Capacidade p95/p99                  | fixar cenário/rate e executar carga com métricas de API, filas e banco    | performance engineer + SRE            | `capacity/`            |
| Upgrade sem downtime e rollback     | implantar release anterior, fazer rolling upgrade e executar rollback     | release engineer + DBA                | `upgrade-rollback/`    |
| Providers externos e E2E            | registrar endpoints/credenciais redigidos e executar cada fluxo governado | integration owner + security reviewer | `providers/`           |
| Threat model e pentest              | congelar escopo, executar revisão autorizada e retestar findings          | security lead independente            | `security/`            |

Cada diretório deve conter o `release.json`, logs com timestamps, métricas, auditoria e aprovação
correspondentes ao pacote mínimo abaixo. A ausência de owner, janela ou autorização mantém o gate
em `PENDENTE`, mesmo que um smoke test local passe.

## Pacote mínimo de evidências por release

1. `release.json` com commit, versão, imagens por digest, configuração redigida e executor.
2. `test-results/` com logs, timestamps, ambiente e comandos reproduzidos.
3. `metrics/` com séries p95/p99, erro, taxa, filas, banco e recursos.
4. `audit/` com eventos de início, mudanças, failover, rollback, conclusão e responsáveis.
5. `approvals/` com owner, revisão independente e aceite formal de exceções.
6. `README.md` explicando o que foi executado, o que não foi executado e como reproduzir.

Não registrar credenciais, prompts, respostas de modelos, conteúdo de usuários ou segredos nos
artefatos. Os artefatos devem usar IDs redigidos e preservar apenas os metadados necessários para
auditoria.

## Bloqueios atuais

- Docker Desktop Linux Engine e Redis local estão disponíveis e os drills Redis de conformance
  foram executados com sucesso. Isso não substitui os exercícios de failover, DR ou capacidade
  em ambiente autorizado.
- Não há ambiente de produção/staging, provedores externos autorizados nem relatório independente
  de pentest anexados a este worktree.

Enquanto esses pré-requisitos não existirem, incrementos locais, contratos, testes focais e
validadores podem avançar, mas nenhum dos seis gates deve ser promovido.
