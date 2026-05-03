# Contexto pra próxima sessão — Montana ERP

> Leia este arquivo primeiro. Resume 2 dias de trabalho intenso (01-03/05/2026).

## Quem você está atendendo

**Felipe Aguiar** — sócio-administrador do **Grupo Montana** (Tocantins):
- 4 empresas: **Montana Assessoria** (terceirização: limpeza/copeiragem/recepção/motoristas), **Montana Segurança** (vigilância armada), **Porto do Vau**, **Mustang**
- ~R$ 100M+ faturamento/ano
- ~1.081 funcionários (592 Assessoria + 489 Segurança)
- 60 postos de trabalho cadastrados
- Bus factor = 1 (Felipe faz tudo)

## Sistema (Montana ERP)

- **Stack**: Node.js 20 + Express + PostgreSQL 16 + Vanilla JS
- **Servidor**: GCP VM `montana-app-sp` (southamerica-east1), porta 3002
- **DB**: 35.247.208.7:5432, db `montana_erp`, 4 schemas
- **Senha PG**: `montana2026` (ainda não rotacionada — pendência)
- **Branch worktree**: `claude/quizzical-pike-5e952d` (no GitHub felipeaguiar1605-dev/GRUPO-MONTANA)
- **Branch servidor**: `vm-snapshot-dispatch-26abr` (pushado, mas não mergeado em main)

## Estado em produção (rodando agora)

### Crons automáticos
- 02:30 — BB sync
- 03:00 — Backup PostgreSQL → GCS (bucket `montana-backups-2026`)
- 04:00 — Auto-classify lançamentos (9 regras)
- 04:30 — WebISS sync
- 05:00 dia 1 — Apuração mensal
- 05:30 dia 1 — Geração de boletins
- 07:00 — Quality-checks (email — falhando: SMTP desconfigurado)
- 08:00 — Alertas operacionais

### Status modules
- ✅ Backup off-site (GCS) funcionando
- ✅ Schema 2FA aplicado (mas auth.js ainda não wired)
- ✅ Auto-classify: SALDO, DUPLICATA, FINANCEIRA, INTRAGRUPO, RETIRADA_SOCIO, INVESTIMENTO, VOLUS, TARIFA
- ✅ Quality-checks endpoint /api/quality-checks
- ✅ OFX validator wired em routes/ofx.js
- ✅ STATUS_NAO_OPERACIONAL filtra: INTERNO, INVESTIMENTO, TRANSFERENCIA, DEVOLVIDO, CONTA_VINCULADA, SALDO, DUPLICATA, FINANCEIRA, RETIRADA_SOCIO
- ✅ receita_holding/margem_holding no /api/dashboard
- ✅ Modo Holding visual (toggle) em public/app.js
- ✅ Filtro CANCELADA em 14 queries api.js + 9 queries em 5 outras rotas
- ✅ ONDA 1 deployada: `/api/postos-equipe` + `public/app-postos-equipe.js`
- ⏸ ONDA 2 código pronto, falta testar (atribuir/mover funcionário a posto via UI)

## R$ ~25M+ de bugs corrigidos em 2 dias

| # | Bug | Status |
|---|-----|--------|
| 1 | SALDO contado como receita | ✅ |
| 2 | Folha duplicada cruzada (240 lanç) | ✅ R$ 6.5M |
| 3 | Pix Recebido em débito | ✅ R$ 1.77M |
| 4 | PROGIRO contado como op | ✅ |
| 5 | Intragrupo escapando filtro | ✅ 300+ |
| 6 | RETIRADA_SOCIO 142 lanç | ✅ R$ 7.2M |
| 7 | Conta BRB tratada como vinculada | ✅ |
| 8 | BB Rende Fácil pendente Seg | ✅ R$ 11.8M |
| 9 | VOLUS não classificado Seg | ✅ R$ 6M |
| 10 | NFs canceladas inflando | ✅ |
| 11 | PREFEITURA 062/2024 zerado | ✅ R$ 41M |

## Pendências priorizadas (próxima sessão)

### 🔴 Urgente
1. **Investigar `/api/dashboard/apuracao-caixa` 500** (quebra dashboard "fechar competência")
2. **404s**: criar `/api/relatorios/margem-por-posto`, `/api/relatorios/cobertura-postos`, `/api/epi/relatorio`
3. **SMTP**: gerar App Password Gmail e atualizar (10 min) — `scripts/smtp_setup.md`

### 🟡 Importante
4. **Reunião com novo contador** + apresentar `BRIEFING_CONSULTORIA_TRIBUTARIA.md`
5. **BB sync PortoVau (parcial) + Mustang (vazio)** — `scripts/bb_sync_setup.md`
6. **Importar OFX manual PortoVau e Mustang** (sem dados)
7. **ONDA 2**: validar UI atribuir/mover funcionário (já codada, só falta testar)
8. **Decisão sobre UFT 16/2025**: 2 lotes mesma empresa (Limpeza+Apoio) — manter ou separar?

### 🟢 Backlog
9. **ONDA 3**: Cockpit Executivo (8 áreas: RH/DP/Financeiro/Jurídico/Compras/Estoque/Certidões/Contratos)
10. **Token GitHub**: revogar `ghp_Umr0...` exposto e gerar novo
11. **Wire 2FA em auth.js** (schema aplicado, falta deploy do código)
12. **eSocial S-1200/S-2200/S-2299** — pendência fiscal (vide briefing)

## Dores do user explicitadas

> **Dor 1**: "Não consigo acompanhar o escritório via sistema, OMIE limita só financeiro, TOTVS Protheus muito caro" → atacado parcialmente com ONDA 1 (Postos & Equipes)

> **Dor 2**: "Não vejo colaboradores em postos em tempo real" → atacado parcialmente; falta ponto eletrônico + atestados

> **Dor 3**: 57 prévias paradas porque só admin aprova → resolvido (financeiro pode aprovar)

> **Risco fiscal pessoal**: R$ 7.2M em retiradas como sócio. User diz que declara como dividendos, mas não validou os 4 requisitos da Lei 9.249/95. Pendência pra novo contador validar.

## Comandos rápidos

```bash
# SSH (já está no servidor se vir prompt diretoria@montana-app-sp:)
ssh diretoria@montana-app-sp

# Rodar manualmente as 3 rotinas
cd /opt/montana/app_unificado
sudo node src/jobs/auto-classify.js --apply
sudo node src/jobs/quality-checks.js
sudo bash scripts/backup_postgres.sh

# Verificar status
pm2 status
curl http://localhost:3002/api/health

# Pull do branch worktree (após resolver token GitHub)
git pull origin claude/quizzical-pike-5e952d

# OU baixar arquivo específico via curl
BASE="https://raw.githubusercontent.com/felipeaguiar1605-dev/GRUPO-MONTANA/claude/quizzical-pike-5e952d"
sudo curl -fsSL -o <path> "${BASE}/<path>"
```

## Arquivos importantes pra ler

1. `RUNBOOK.md` — 10 procedimentos de incidente
2. `BRIEFING_CONSULTORIA_TRIBUTARIA.md` — pra mandar pro novo contador
3. `GUIA_MENSAL_FATURAMENTO.md` — pra equipe seguir mensalmente
4. `DEPLOY_ONDA1_POSTOS_EQUIPE.md` — passo-a-passo deploy ONDA 1
5. `scripts/smtp_setup.md` — fix do email
6. `scripts/bb_sync_setup.md` — fix do BB sync PortoVau/Mustang
7. `scripts/git_cleanup.sh` — faxina git já rodada

## Estilo do user

- **Direto**: aprecia objetividade, sem rodeios
- **Brutalmente honesto**: pediu várias vezes "análise crítica"
- **Auto mode preferido**: aceita ação direta sem ficar perguntando
- **Cansado**: 2 dias de trabalho intenso. Cuide pra não saturar
- **Decide com dados**: forneça métricas + recomendação clara
