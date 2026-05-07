# Reconciliação Git — Montana ERP

Última atualização: 2026-05-07
Estado: produção estável, divergência de `deploy-v2` pendente

## Produção hoje

- VM: `montana-app-sp` (GCP southamerica-east1)
- Branch operacional: `production` (HEAD `4bd9ac4`)
- pm2: `montana-app` :3002, `montana-mcp`, `oauth2-proxy` :443
- Postgres: VM separada `35.247.208.7:5432`, db `montana_erp`

## Conteúdo já em produção

- Histórico de `origin/main` até PR #10
- PR #11: `recon-vm.sh` + MCP Bearer auth + sqlglot guard
- Bug fixes 2026-05-07: HAVING cnt → COUNT(*), .all().reduce com await
- Arquivos novos: `src/jobs/`, `src/lib/`

## Pendências

1. **Branch `deploy-2026-05-03-v2`** — 35 commits únicos com features multi-posto, PG round 3, WIP `d642f41`. Decidir: mergear / cherry-pick / abandonar.
2. **SMTP quebrado** — Gmail app-password expirado. Alertas não enviam.
3. **Segurança PG** — IP público, senha trivial, PAT GitHub over-scoped.
4. **Limpeza** — `*.bak` rastreados em algumas branches; falta `.gitignore`.

## Branches no GitHub

| Branch | Commit | Papel |
|---|---|---|
| `production` | `4bd9ac4` | operacional |
| `main` | `ab5cdbe` | herança histórica |
| `deploy-2026-05-03-v2` | `d642f41` | features pendentes |
| `feature/pg-migration` | `4a2ce79` | migração SQLite→PG |
| `pg-migration-round2` | `65faaba` | round 2 |
| `wip-postos-preview-2026-05-05` | `60ed290` | WIP isolado |

## Tags

- `vm-state-2026-05-07` (`d642f41`)
- `vm-state-2026-05-07-14h` (`4bd9ac4`)

## Fluxo operacional

1. Edita local (Antigravity ou Claude Code)
2. Push para `production` no GitHub
3. VM: `git pull origin production && pm2 restart montana-app`
4. Backups (PG dump + GCP snapshot) independentes

## Próxima sessão

1. Avaliar `deploy-2026-05-03-v2`: comparar arquivos e decidir features a trazer
2. Setup PG local no Windows
3. Renovar SMTP
4. Trocar senha PG e restringir firewall
5. Reduzir escopo do PAT
x

