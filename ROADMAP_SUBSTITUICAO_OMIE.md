# Roadmap de Substituição do Omie ERP

> **Objetivo**: substituir gradualmente o Omie ERP pelo sistema GRUPO-MONTANA, sem big-bang, mantendo paralelo durante a transição.
>
> **Estado atual (2026-04-21)**: projeto não tem integração com Omie; sistemas rodam em paralelo. Migração = fechar gaps de funcionalidade, não ripar dependências.
>
> **Como usar este documento**: cada item tem campos `Prioridade` (A/B/C) e `Ordem` (1,2,3…) em branco. Preencher por seção conforme decisão do time. Atualizar `Status` conforme execução (`pendente` → `em-andamento` → `concluído`).

---

## Seção A — Onda 1: Financeiro Operacional

> **Meta da onda**: parar de depender do Omie para o dia-a-dia (pagar, receber, cadastrar entidades). **Estimativa**: 1–2 meses.

| ID | Item | Descrição | Prioridade | Ordem | Status |
|----|------|-----------|------------|-------|--------|
| A1 | Cadastro unificado de entidades | Tabela `entidades` (CNPJ/CPF, tipo cliente/fornecedor/ambos, contatos, endereço, histórico). Migra dados espalhados hoje em `contratos`, `despesas`, `rh_*`. |  |  | pendente |
| A2 | Contas a Pagar (CP) | Módulo com agendamento, aprovação, geração de lote PIX/boleto, baixa automática via conciliação contra extrato BB. |  |  | pendente |
| A3 | Contas a Receber (CR) | Ligação contrato → NFS-e → pagamento (Transparência Palmas ou extrato). Régua de cobrança. |  |  | pendente |
| A4 | Geração de boletos/PIX out | Integração com API do banco (BB já tem OAuth mTLS) para emissão de cobrança e ordens de pagamento. |  |  | pendente |
| A5 | Régua de cobrança | Alertas escalonados (D-3, D+1, D+7, D+15) — reaproveitar `alertas-operacionais.js`. |  |  | pendente |
| A6 | UI unificada de Financeiro | Tela única com CP + CR + fluxo de caixa + conciliação (hoje espalhado em rotas diferentes). |  |  | pendente |

---

## Seção B — Onda 2: Gestão e Análise

> **Meta da onda**: parar de depender do Omie para relatórios, análises e compliance. **Estimativa**: 1 mês.

| ID | Item | Descrição | Prioridade | Ordem | Status |
|----|------|-----------|------------|-------|--------|
| B1 | Dashboard executivo consolidado | KPIs das 4 empresas em 1 tela (faturamento, margem, caixa, alertas críticos). Expandir `/consolidado` existente. |  |  | pendente |
| B2 | Export contábil | Gerar SPED Contribuições, balancete, razão no formato que o contador aceita (hoje sai do Omie). |  |  | pendente |
| B3 | RBAC (perfis e permissões) | Perfis: Admin, Financeiro, Operacional, Consulta. Restringir rotas por perfil. JWT já existe; faltam claims de role. |  |  | pendente |
| B4 | Auditoria global | Tabela `audit_log` (quem/quando/o-quê). Parcialmente iniciada no commit 2c8721f — consolidar e cobrir 100% das rotas de escrita. |  |  | pendente |
| B5 | Workflow de aprovações | Despesas acima de limite (ex: R$10k) requerem aprovação do diretor antes de agendar pagamento. |  |  | pendente |
| B6 | Montana Intelligence — expansão | MCP + Claude respondendo perguntas em linguagem natural (ver `ARQUITETURA_MONTANA_INTELLIGENCE.md` fases 2–4). |  |  | pendente |
| B7 | Relatórios gerenciais | DRE comparativo (MoM, YoY), análise de contratos (rentabilidade, glosas), projeção anual. |  |  | pendente |

---

## Seção C — Onda 3: Corte do Omie

> **Meta da onda**: desligar o Omie. **Estimativa**: 2–4 semanas + 1 ciclo fiscal em paralelo.

| ID | Item | Descrição | Prioridade | Ordem | Status |
|----|------|-----------|------------|-------|--------|
| C1 | Export completo do Omie | Baixar histórico integral (cadastros, lançamentos, anexos) em formato estruturado. |  |  | pendente |
| C2 | Importador Omie → Montana | Script único que mapeia entidades, CP, CR, histórico financeiro para as tabelas locais. |  |  | pendente |
| C3 | Reconciliação paralela | Rodar 1 mês fiscal completo com Omie + Montana, comparar fechamento, zerar divergências. |  |  | pendente |
| C4 | Congelamento do Omie | Omie em read-only; toda entrada nova só no Montana. |  |  | pendente |
| C5 | Desligamento | Cancelar assinatura Omie, arquivar exports em cold storage (GCS). |  |  | pendente |

---

## Seção D — Pré-requisitos e Dívida Técnica

> **Meta**: NÃO iniciar substituição do Omie sem resolver isto. Rede de segurança.

| ID | Item | Descrição | Prioridade | Ordem | Status |
|----|------|-----------|------------|-------|--------|
| D1 | Testes automatizados | Cobertura dos endpoints críticos: conciliação-robusta, fluxo-caixa-projetado, webiss, bb-sync. Mínimo para ter rede antes de mexer em financeiro. |  |  | pendente |
| D2 | Migração SQLite → PostgreSQL | Antes de Onda 1, porque CP/CR cross-company em 4 bancos SQLite separados é caro. Fase 4 do `PLANO_MIGRACAO_CLOUD.md`. |  |  | pendente |
| D3 | Limpeza de dados contaminados | 570 NFs Segurança codificadas como Assessoria (CONSULTORIA_2026-04-17). Não migrar lixo p/ sistema novo. |  |  | pendente |
| D4 | Investigar SEMUS 192/2025 | R$672k/mês com `total_pago = 0` — resolver antes que vire inconsistência sistêmica. |  |  | pendente |
| D5 | Renovação de certificados A1 | 5 certificados vencendo (CONSULTORIA_2026-04-17). Sem isso, WebISS/BB param. |  |  | pendente |
| D6 | Backup automatizado | Fase 3 do plano de migração cloud — backup diário dos 4 SQLites (ou Postgres após D2) p/ GCS. |  |  | pendente |
| D7 | CI + staging + aprovação no deploy | CD já existe (`.github/workflows/deploy.yml` faz `scp` + `pm2 restart` em push para `main`). Falta: (1) step de testes/lint como gate antes do deploy; (2) ambiente staging separado; (3) aprovação manual via GitHub Environments. Depende de D1 para o gate de testes real. Syntax check básico adicionado como mínimo temporário. |  |  | em-andamento |

---

## Seção E — Melhorias em Módulos Existentes

> **Meta**: elevar qualidade do que já existe antes de absorver carga do Omie.

| ID | Módulo | Melhoria | Prioridade | Ordem | Status |
|----|--------|----------|------------|-------|--------|
| E1 | Conciliação | Auto-categorização de despesas por padrão de histórico (ML simples ou regras). |  |  | pendente |
| E2 | Conciliação | Matching de NFS-e ↔ extrato ↔ contrato em cadeia única (hoje parcial). |  |  | pendente |
| E3 | Fluxo de caixa | Cenários (otimista/realista/pessimista) com premissas editáveis. |  |  | pendente |
| E4 | Contratos | Alerta automático de repactuação CCT (já fez TJ 440/2024 e 73/2020 manualmente). |  |  | pendente |
| E5 | NFS-e | Cache local de NFs emitidas (hoje WebISS é query-on-demand). |  |  | pendente |
| E6 | Folha | Reduzir dependência de Excel — importador robusto + validações. |  |  | pendente |
| E7 | Ponto | Integração com folha (horas extras alimentam folha automaticamente). |  |  | pendente |
| E8 | Estoque | Revisar — status "parcial" no mapeamento. |  |  | pendente |
| E9 | Licitações | Revisar — status "parcial" no mapeamento. |  |  | pendente |
| E10 | Volus | Revisar — status "parcial" no mapeamento. |  |  | pendente |

---

## Seção F — Gaps de Funcionalidade (vs Omie)

> **Meta**: catalogar tudo que o Omie faz e o Montana ainda não faz, para garantir que nada seja esquecido no corte.

| ID | Função Omie | Status Montana | Prioridade | Ordem | Status |
|----|-------------|----------------|------------|-------|--------|
| F1 | NFe de produto (se Porto/Mustang/Nevada precisarem) | ❌ Só NFS-e |  |  | pendente |
| F2 | NFC-e (varejo) | ❌ Não existe |  |  | pendente |
| F3 | Gestão de vendas / pedidos de venda | ❌ Não existe |  |  | pendente |
| F4 | Gestão de compras / pedidos de compra | ❌ Não existe |  |  | pendente |
| F5 | Ordens de serviço | ❌ Não existe |  |  | pendente |
| F6 | CRM leve (pipeline, oportunidades) | ❌ Não existe |  |  | pendente |
| F7 | Portal do cliente | ❌ Não existe |  |  | pendente |
| F8 | App mobile / PWA | ❌ Web only |  |  | pendente |
| F9 | Integração com marketplace | ❌ Não existe (avaliar se faz sentido) |  |  | pendente |
| F10 | Conciliação cartão de crédito (adquirente) | ❌ Não existe |  |  | pendente |
| F11 | Gestão de projetos (horas, apontamentos) | ⚠️ Parcial (ponto eletrônico existe) |  |  | pendente |
| F12 | Comissões de vendedores | ❌ Não existe |  |  | pendente |

---

## Convenções

- **Prioridade**: `A` = crítico (bloqueia corte do Omie), `B` = importante (melhora experiência), `C` = nice-to-have (pode ficar pós-corte).
- **Ordem**: numérica dentro da seção; define sequência de execução.
- **Status**: `pendente` → `em-andamento` → `em-review` → `concluído` → `cancelado`.
- Ao marcar item como `em-andamento`, criar branch `feat/<id-item>-<slug>` (ex: `feat/A2-contas-a-pagar`).
- Ao concluir, linkar commit/PR na coluna `Status` (ex: `concluído #123`).

## Próximos passos (para o time)

1. Preencher `Prioridade` e `Ordem` de cada seção (começar por D — pré-requisitos).
2. Validar estimativas de onda com quem operou Omie no dia-a-dia.
3. Definir quem é o responsável por cada seção (A/B/C/D/E/F).
4. Revisar este roadmap a cada fechamento de mês.
