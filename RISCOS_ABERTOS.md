# Riscos Abertos — Grupo Montana

Registro vivo dos riscos identificados em auditoria e das decisões de
priorização tomadas em conversa com o responsável técnico. Revisar
mensalmente. Quando um item for resolvido, mover para seção "Resolvidos"
com data e link do commit/PR.

Última atualização: 2026-04-24

---

## CRÍTICO

### 9. Testes fiscais inexistentes
- **Situação**: `tests/smoke.js` cobre apenas que a API sobe. Nenhum teste
  valida cálculo de INSS, IRRF, PIS/COFINS, retenção UFT 16,15%, folha →
  FGTS, emissão de NF-e, etc.
- **Risco**: qualquer alteração em apuração fiscal vai para produção sem
  validação. Bug silencioso em tabela de alíquotas (2026 ou futuro) não é
  detectado até o fechamento do mês.
- **Plano**: depois de concluir migração Postgres e consolidação `src/tax/`,
  escrever suíte mínima com 5 cálculos críticos (INSS, IRRF, UFT 16,15%,
  PIS cumulativo, PIS não-cumulativo) em `tests/tax.test.js`.
- **Status**: adiado conscientemente. Alerta mantido como crítico.

### 5. Backup sem validação de restore
- **Situação**: `DEPLOY.md` descreve backup noturno (`tar czf`). Nenhum
  teste automatizado de restore. Se o `.db` corromper, não há garantia de
  que o backup é íntegro.
- **Plano**: criar `scripts/restore_test.sh` que semanalmente restaura o
  backup em pasta temporária, roda sanidade (contagem de registros por
  empresa) e avisa se divergir de produção.
- **Status**: segunda prioridade do dia atual.

### 4. 570 NFs contaminadas entre Assessoria e Segurança
- **Situação**: documentado em `CONSULTORIA_2026-04-17.md`. NFs de receita
  Segurança foram registradas como Assessoria (e possivelmente vice-versa).
  Apuração PIS/COFINS 2024–2025 potencialmente errada (Assessoria é
  não-cumulativo, Segurança é cumulativo).
- **Plano**: diagnóstico read-only em `scripts/_diag_nfs_contaminadas.js`,
  revisão humana do CSV, script de correção separado com `--apply`.
- **Status**: primeira prioridade do dia atual.

---

## ALTO

### 3. Migração SQLite → PostgreSQL
- **Situação**: SQLite single-writer. Blue/green deploy inviável. Crescimento
  bate em teto. Cada deploy é downtime.
- **Plano**: `PROPOSTA_MIGRACAO_POSTGRES.md` tem esqueleto em 4 fases.
  Decisão pendente: schema multi-empresa (4 databases vs 4 schemas vs
  1 schema com `empresa_id`).
- **Status**: priorizado após conclusão do item 4 (570 NFs).

### 8. Lógica fiscal duplicada
- **Situação**: `calcINSS()` e `calcIRRF()` aparecem em `src/routes/rh.js`,
  `src/routes/piscofins-seguranca.js` e em scripts soltos de apuração.
  Tabela 2026 alterada em um lugar não propaga para os outros.
- **Plano**: consolidar em `src/tax/` com módulos `inss.js`, `irrf.js`,
  `piscofins.js`, `retencoes.js`. Todos as rotas/scripts importam de lá.
- **Status**: planejado após migração Postgres.

### 6. LGPD: CPF/RG/conta bancária não criptografados
- **Situação**: `rh_funcionarios` armazena dados pessoais de 592+
  funcionários em claro. Sem auditoria de acesso, sem política de retenção,
  sem DPO.
- **Plano**: implementar criptografia em repouso (hash determinístico
  para busca + valor encriptado para exibição) após migração Postgres.
- **Status**: planejado após migração Postgres.

---

## MÉDIO

### 2. Certificados A1 sem alerta automatizado
- **Situação**: 4 certificados `.pfx` (um por empresa). Vencimento silencioso
  quebra emissão WebISS sem aviso. Senhas em `.env` da VM.
- **Mitigação atual**: monitoramento manual; certificadora a 1 manhã de
  distância; tolerância operacional aceita.
- **Plano**: cron diário que valida expiração dos 4 `.pfx` e alerta em
  30/15/7 dias antes do vencimento.
- **Status**: adiado conscientemente.

### 10. Bus factor = 1
- **Situação**: conhecimento de regras de negócio (570 NFs, UFT motorista,
  regimes tributários por contrato, heurísticas de conciliação) concentrado
  em uma única pessoa.
- **Plano**: treinar colaboradora do back office, registrar cada
  procedimento em `docs/runbooks/` conforme aprendido.
- **Status**: em andamento.

---

## BAIXO / INFORMATIVO

### 7. Montana Intelligence é aspiracional
- **Situação**: `ARQUITETURA_MONTANA_INTELLIGENCE.md` descreve MCP server
  Python na porta 8001 que **não existe**. Pasta `montana_intelligence/`
  praticamente vazia.
- **Plano**: adiado como segundo plano. Não apresentar como componente
  existente em comunicação comercial/jurídica.
- **Status**: adiado.

### 1. Ponto Eletrônico (conformidade legal)
- **Situação**: `src/routes/ponto.js` (1.156 linhas) faz controle de
  jornada interno, **não** Ponto Eletrônico legal (sem REP-A/REP-C, sem
  AFD/AEJ, sem homologação MTE, sem conformidade com Portaria 671/2021).
- **Mitigação atual**: uso restrito a back office com colaboradores de
  confiança em fase piloto. Não apresentar como "ponto eletrônico" em
  comunicação com cliente / material jurídico até homologação real.
- **Plano**: homologação REP só após >20 colaboradores no piloto.
- **Status**: piloto em andamento.

---

## Resolvidos

_(nenhum ainda)_
