# HandStack — runbooks dos gates externos

Este documento transforma `CERTIFICATION-READINESS.md` em uma sequência operacional. Ele não
promove gates e não deve conter URLs reais, tokens, prompts, respostas de modelos ou dados de
usuários. Substitua os placeholders somente no ambiente autorizado e preserve os artefatos
redigidos em um diretório externo de evidências.

O laboratório local reproduzível e suas limitações estão descritos em
[`LOCAL-CERTIFICATION-LAB.md`](./LOCAL-CERTIFICATION-LAB.md).

## Preparação comum

1. Obter owner, janela de mudança, autorização escrita e identificação do ambiente.
2. Fixar commit, versão e digests das imagens:

```text
git rev-parse HEAD
npm run certification:preflight -- --output artifacts/certification/release-candidate --include-contracts
```

3. Confirmar que os seis diretórios externos (`database-ha`, `dr`, `capacity`,
   `upgrade-rollback`, `providers`, `security`) têm `release.json`, `README.md`, logs,
   métricas, auditoria e aprovação independente.
4. Redigir credenciais e conteúdo sensível antes de anexar qualquer arquivo.

## 1. Banco HA e backup/restore

- Owner: DBA + operador de release.
- Executar backup imutável, checksum, restauração em ambiente isolado e failover controlado para
  SQL e Mongo com réplicas reais.
- Registrar timeline, perda de dados, latência de recuperação, membro promovido e smoke tests.
- Aprovar somente se não houver corrupção e os objetivos publicados de RPO/RTO forem atendidos.

## 2. DR multi-zona/multi-região

- Owner: SRE + owner de dados.
- Confirmar replicação de banco, objetos e segredos, fencing e DNS; promover uma única região de
  escrita, executar smoke tests e realizar failback separado.
- Registrar RPO/RTO medidos, timeline, comandos e auditoria de cada mudança.
- Aprovar somente com RPO ≤ 5 min, RTO ≤ 15 min e failback auditado.

## 3. Capacidade p95/p99

- Owner: engenharia de performance + SRE.
- Fixar cenário, taxa, duração, número de tenants e topologia final; executar carga representativa
  nos fluxos de API, filas, banco e providers.
- Registrar p50/p95/p99, erros, saturação, filas, custo e recursos por componente.
- Aprovar somente contra limites de latência/erro definidos para a release e com backpressure íntegro.

## 4. Upgrade e rollback sem downtime

- Owner: engenharia de release + DBA.
- Implantar release anterior, executar rolling upgrade com migrations compatíveis, observar health
  gates e executar rollback controlado.
- Registrar versões/digests, probes, timeline, tráfego, integridade pós-rollback e auditoria.
- Aprovar somente sem interrupção de tráfego, perda de dados ou perda de auditoria.

## 5. Providers externos e E2E

- Owner: integração + revisor de segurança.
- Usar credenciais de teste aprovadas para LLM, embeddings, MCP, storage e notificações; executar
  fluxos governados de Agent, Knowledge, Webhooks e Notifications.
- Registrar apenas IDs redigidos, traces, auditoria e request/response sanitizados.
- Aprovar somente se nenhum segredo ou identificador vendor sensível escapar do runtime.

## 6. Threat model e pentest

- Owner: líder de segurança independente.
- Congelar a release candidata, aprovar escopo/regras de engajamento e executar revisão e pentest
  em ambiente isolado.
- Registrar achados, severidade, correção, reteste e aceite formal de exceções.
- Aprovar somente sem achados críticos/altos sem correção ou aceite explícito.

## Critério de encerramento

O gate externo só muda para `APROVADO` quando o owner e o revisor independente assinarem o README
do exercício, os artefatos forem reproduzíveis e o critério específico acima estiver evidenciado.
O pacote local `artifacts/certification/release-candidate-2026-09-29` continua sendo preparação,
nunca substituto dos seis exercícios.
