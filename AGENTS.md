# HandStack - instrucoes de continuidade

Leia STATUS.md primeiro. A especificacao indicada pelo supervisor e a fonte de verdade;
docs/requirements/catalog.yaml e o catalogo existente de rastreabilidade. Nao crie catalogos concorrentes.
Mantenha STATUS.md curto: estado atual, requisito em andamento, bloqueios, evidencia e proximo passo.
Acrescente o historico detalhado em HISTORY.md. Consulte apenas os trechos historicos pertinentes.
Releia cada arquivo antes de editar. Preserve trabalho existente e use incrementos verificaveis. Execute apenas testes focais relacionados aos arquivos alterados. Nao abra nem audite vitest.config.*, vitest.workspace.ts ou configuracoes de teste em incrementos que nao alterem testes; deixe o Vitest completo para o gate final. Limite a diagnostico de ambiente a uma sondagem curta por turno; nao execute o gerenciador legado do lockfile, nao repita npm/yarn nem crie scripts temporarios de probe.
Confirme o estado real do ambiente antes de adotar um bloqueio registrado em STATUS.md/HISTORY.md; esses arquivos podem estar desatualizados. Execute verificacoes focais para mudancas locais; gates globais quando houver impacto transversal ou na conclusao.
Gates de conclusao: execute format:check, docs:validate, lint, typecheck, test e build usando npm; use yarn somente se yarn.lock existir.
Respeite a matriz de runtime do projeto. Testes offline nao certificam integracoes com servicos reais.
Declare bloqueios externos explicitamente, mas continue com incrementos locais seguros que nao dependam da infraestrutura indisponivel. Nao repita o mesmo bloqueio sem nova sondagem. Se a recuperacao falhar uma vez, avance para codigo, contratos, documentacao ou testes focados. Nao crie arquivos temporarios de sondagem nem `.handstack-codex/COMPLETE`: pertence ao supervisor.
O gerenciador e o lockfile legados deste projeto nao devem ser executados, instalados ou usados para escolher comandos; use npm e, quando houver yarn.lock, yarn. Nao altere o lockfile legado apenas para contornar uma falha de ambiente. O arquivo `.handstack-codex/autopilot-v2.lock` pertence ao supervisor e nunca e um bloqueio do projeto; ignore sua existencia e continue o trabalho.
Nao edite o supervisor nem seus logs/contadores. Detalhe falhas e proximos passos no ledger.
