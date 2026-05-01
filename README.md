# Montana ERP — App Unificado

> ERP multi-tenant para o Grupo Montana (4 empresas: Assessoria, Segurança, Porto do Vau, Mustang).
> Stack: **Node.js 20 + Express + PostgreSQL 16 + Vanilla JS frontend**.
> Servidor de produção: GCP VM (Tocantins region), PM2 daemon, porta 3002.

---

## Sumário

1. [Arquitetura](#arquitetura)
2. [Stack técnica](#stack-técnica)
3. [Quick start (dev local)](#quick-start-dev-local)
4. [Estrutura de diretórios](#estrutura-de-diretórios)
5. [Modelagem multi-tenant](#modelagem-multi-tenant)
6. [Autenticação e segurança](#autenticação-e-segurança)
7. [Integrações externas](#integrações-externas)
8. [Crons e jobs agendados](#crons-e-jobs-agendados)
9. [Deploy em produção](#deploy-em-produção)
10. [Backup e disaster recovery](#backup-e-disaster-recovery)
11. [Observabilidade](#observabilidade)
12. [Runbook de incidentes](./RUNBOOK.md)

---

## Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│                  Browser (Chrome / Edge)                    │
│  Vanilla JS — public/app.js + módulos por feature           │
└────────────────────┬────────────────────────────────────────┘
                     │ HTTPS / JWT Bearer
                     ▼
┌─────────────────────────────────────────────────────────────┐
│         Express server :3002 (PM2 fork mode, 1 inst)        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Middlewares:                                         │   │
│  │   compression → CORS → JWT auth → companyMiddleware  │   │
│  │   → rate limit → audit log → routes                  │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  Rotas:                                                     │
│   /api/* (40+ módulos)   /healthz   /                       │
└────────┬───────────────────┬────────────────────────────────┘
         │                   │
         │                   ▼
         │        ┌────────────────────┐
         │        │   PostgreSQL 16    │  35.247.208.7:5432
         │        │   montana_erp      │
         │        │   ─────────────    │
         │        │   schemas:         │
         │        │   • assessoria     │
         │        │   • seguranca      │
         │        │   • portodovau     │
         │        │   • mustang        │
         │        └────────────────────┘
         │
         ▼ (integrações)
   BB API · WebISS Palmas · Google Drive · Anthropic Claude · WhatsApp · SMTP
```

**Decisões arquiteturais:**

- **1 banco, N schemas (multi-tenant)**: cada empresa em seu schema; `companyMiddleware` resolve via header `X-Company` e seta `search_path`.
- **Single Express instance (não cluster)**: simplicidade > throughput; 4 empresas × ~5 usuários simultâneos cabe em 1 worker.
- **JWT 8h sem refresh token**: sessões longas para uso office; logout = limpar localStorage.
- **Frontend Vanilla JS sem framework**: zero build, zero dependências NPM no front; cada feature é um arquivo `app-<feature>.js` carregado sob demanda.

---

## Stack técnica

| Camada       | Tecnologia                                 | Versão |
|--------------|--------------------------------------------|--------|
| Runtime      | Node.js                                    | 20.x LTS |
| Web          | Express                                    | 4.x    |
| DB           | PostgreSQL                                 | 16     |
| DB driver    | pg (node-postgres) via `db_pg.js` wrapper  | 8.x    |
| Auth         | jsonwebtoken + bcryptjs                    | -      |
| 2FA          | speakeasy + qrcode (opcional)              | -      |
| PDF          | PDFKit                                     | 0.x    |
| Excel        | ExcelJS                                    | 4.x    |
| SOAP (WebISS)| https + xml2js (custom client)             | -      |
| Cron         | node-cron + PM2 cron_restart               | -      |
| Observability| Sentry (opcional via `SENTRY_DSN`)         | 8.x    |
| Daemon       | PM2 fork mode                              | 5.x    |

---

## Quick start (dev local)

```bash
# 1. Pré-requisitos
node -v   # >= 20
psql --version  # >= 14

# 2. Clonar
git clone <repo> montana-app
cd montana-app

# 3. Dependências
npm install

# 4. Banco local (Docker)
docker run -d --name pg-montana \
  -e POSTGRES_PASSWORD=montana \
  -e POSTGRES_DB=montana_erp \
  -p 5432:5432 postgres:16

# 5. Configurar .env (copiar de .env.example)
cp .env.example .env
# Editar PG_HOST=localhost, PG_PASSWORD=montana, JWT_SECRET=...

# 6. Aplicar migrations
psql -h localhost -U postgres -d montana_erp -f scripts/migrate_initial.sql
psql -h localhost -U postgres -d montana_erp -f scripts/migrate_p2_fluxo_previa.sql
psql -h localhost -U postgres -d montana_erp -f scripts/migrate_2fa.sql

# 7. Subir
npm start    # ou node src/server.js
# → http://localhost:3002
# Login inicial: admin / admin123 (será forçado a trocar)
```

---

## Estrutura de diretórios

```
app_unificado/
├── src/
│   ├── server.js            # Entry point Express + crons
│   ├── api.js               # Rotas legadas SQLite-style (em migração)
│   ├── auth.js              # JWT + 2FA + lockout
│   ├── db.js / db_pg.js     # Wrappers DB (interface compatível com better-sqlite3)
│   ├── companies.js         # Config das 4 empresas
│   ├── companyMiddleware.js # Resolve schema PG via X-Company
│   ├── healthz.js           # /healthz endpoint robusto
│   ├── sentry.js            # Sentry init opcional
│   ├── routes/              # Módulos REST por feature (40+)
│   ├── middleware/          # auditLog, etc
│   └── lib/                 # passwordPolicy, twoFactor, templateRenderer
├── public/                  # Frontend estático (HTML + JS modular)
│   ├── index.html
│   ├── app.js               # Bootstrap + dashboard
│   ├── app-<feature>.js     # 30+ módulos por feature
│   └── styles.css
├── scripts/
│   ├── backup_postgres.sh   # Backup diário → GCS
│   ├── setup_staging.sh     # Provisiona ambiente staging
│   ├── gerar_boletins_mensal.js  # Cron mensal
│   └── migrate_*.sql        # Schema migrations
├── certificados/            # A1 PFX (WebISS) — NÃO COMMITAR
├── data/                    # Diagnóstico noturno + caches locais
├── logs/                    # erros.log + outputs PM2
├── ecosystem.config.js      # PM2: app + 5 crons
├── README.md                # ← este arquivo
└── RUNBOOK.md               # Procedimentos de incidente
```

---

## Modelagem multi-tenant

Cada empresa = 1 schema PostgreSQL. Tabelas idênticas em todos:

```
montana_erp/
├── assessoria.bol_contratos, .notas_fiscais, .extratos_bancarios, ...
├── seguranca.bol_contratos, .notas_fiscais, ...
├── portodovau.<idem>
└── mustang.<idem>
```

**Resolução de schema** (`src/companyMiddleware.js`):

1. Frontend envia `X-Company: assessoria` em todo request.
2. Middleware seta `req.companyKey` e `db.search_path = '<key>',public`.
3. Queries não precisam prefixar schema; `pg` resolve automaticamente.

**Globals compartilhados** (no schema `public`):
- `usuarios` (centralizado — mesmo login para todas empresas)
- `audit_log`
- `notificacoes_log`

---

## Autenticação e segurança

### Login
```
POST /api/auth/login
Body: { usuario, senha, company?, totp? }
→ { ok, token, role, twoFactor }
```

### Política de senha (`src/lib/passwordPolicy.js`)
- 12+ caracteres
- maiúscula + minúscula + número + especial
- Não pode conter usuário/nome
- Blocklist de 50+ senhas comuns
- Bloqueio de sequências (1234, abcd, qwer)
- Bloqueio de repetições (aaaa)

### 2FA TOTP (`src/lib/twoFactor.js`)
- Compatível com Google Authenticator, Authy, 1Password
- Secret base32, janela ±30s
- 10 códigos de backup gerados no enrollment
- **Opt-in por usuário** (flag `usuarios.totp_enabled`)

### Lockout
- 5 tentativas → 15 min de bloqueio
- Configurável via `AUTH_MAX_TENTATIVAS` e `AUTH_LOCKOUT_MIN`

### JWT
- Secret: `JWT_SECRET` env (mínimo 32 chars em prod)
- TTL: 8 horas
- Sem refresh token — re-login após expiração

### Audit log
Todo `POST/PUT/PATCH/DELETE` registrado em `audit_log` com:
`{ usuario, action, table, row_id, detail_json, ip, ts }`

---

## Integrações externas

| Integração       | Tipo        | Auth                | Frequência   |
|------------------|-------------|---------------------|--------------|
| BB API           | REST        | OAuth2 client_creds | Diário 02:30 |
| WebISS Palmas    | SOAP+mTLS   | Certificado A1 PFX  | Diário 04:30 |
| Google Drive     | REST        | OAuth2 user         | On-demand    |
| Anthropic Claude | REST        | API key             | On-demand    |
| WhatsApp         | webhook     | Token               | Diário 08:00 |
| SMTP (alertas)   | SMTP        | user/pass DB        | Diário 08:00 |

Configurações ficam na tabela `configuracoes` (chave/valor) por empresa,
**não** em variáveis de ambiente, pois cada empresa tem credenciais diferentes.

---

## Crons e jobs agendados

Todos rodam no fuso `America/Araguaina`. Via `node-cron` no `server.js` + PM2 cron_restart no `ecosystem.config.js`.

| Cron                    | Horário      | Função |
|-------------------------|--------------|--------|
| Backup PostgreSQL → GCS | `0 3 * * *`  | Dump 4 schemas + globals → bucket |
| Anti-dedup              | `0 2 * * *`  | Detecta extratos/NFs duplicados |
| BB sync                 | `30 2 * * *` | Importa extratos do dia anterior |
| WebISS sync             | `30 4 * * *` | Importa NFS-e emitidas (Palmas) |
| Apuração mensal         | `0 5 1 * *`  | Calcula receita/despesa/impostos |
| Geração de boletins     | `30 5 1 * *` | Cria rascunhos do mês corrente |
| Alertas operacionais    | `0 8 * * *`  | Envia email com pendências |
| Boletins mensais (PM2)  | `0 8 5 * *`  | Refaz/concilia boletins |

---

## Deploy em produção

```bash
# Servidor: GCP VM, Ubuntu 22.04
ssh montana-prod

cd /opt/montana/app_unificado
git pull origin main
npm install --production

# Migrations (se houver)
psql -h 35.247.208.7 -U montana -d montana_erp -f scripts/migrate_<nova>.sql

# Reiniciar
pm2 reload montana-app
pm2 logs montana-app --lines 50

# Verificar
curl -s http://localhost:3002/healthz | jq
```

**Setup inicial** (uma vez):
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup    # configura auto-start no boot
```

---

## Backup e disaster recovery

### Backup automático
- **Script**: `scripts/backup_postgres.sh` — diário 03:00 via PM2 cron
- **Conteúdo**: 4 schemas separados + dump global, gzipped
- **Destino**: `gs://montana-erp-backups/<YYYY-MM-DD>/`
- **Retenção**: 7 dias local, 90 dias GCS (lifecycle rule)

### Restore (procedimento)
```bash
# 1. Baixar backup
gsutil cp gs://montana-erp-backups/2026-04-29/2026-04-29_assessoria.sql.gz /tmp/

# 2. Aplicar (em DB de teste primeiro!)
gunzip -c /tmp/2026-04-29_assessoria.sql.gz | \
  psql -h <host-staging> -U montana -d montana_erp_restore

# 3. Validar contagens vs produção
psql -c "SELECT count(*) FROM assessoria.bol_contratos"
```

**Teste de restore mensal**: dia 15 de cada mês. Documentar em `RUNBOOK.md`.

### RPO / RTO
- **RPO** (perda máxima): 24h (backup diário)
- **RTO** (tempo restauração): ~2h (downloads + restore + validação)

Para reduzir RPO: configurar **WAL archiving contínuo no GCP CloudSQL** (não implementado — backlog).

---

## Observabilidade

### Logs
- `logs/erros.log` — erros do Express
- `logs/app-out.log` / `app-err.log` — stdout/stderr PM2
- `logs/cron-*-{out,err}.log` — outputs dos crons

### Métricas
- `GET /healthz` → JSON completo (DB + memória + disco + uptime)
- `GET /healthz/live` → liveness (sempre 200 se vivo)
- `GET /healthz/ready` → readiness (200 só se DBs respondem)

### Sentry (opcional)
Setar `SENTRY_DSN` no `.env` e instalar:
```bash
npm install @sentry/node @sentry/profiling-node
```
Variáveis: `SENTRY_ENV`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_PROFILES_SAMPLE_RATE`.
Sanitização automática de `password`, `token`, `senha` no `beforeSend`.

### Audit log
```sql
SELECT ts, usuario, action, table_name, row_id
FROM audit_log
WHERE ts > NOW() - INTERVAL '1 day'
ORDER BY ts DESC;
```

---

## Variáveis de ambiente

Ver `.env.example`. Críticas:

| Var                  | Default                | Descrição |
|----------------------|------------------------|-----------|
| `PORT`               | `3002`                 | Porta HTTP |
| `PG_HOST`            | `35.247.208.7`         | PostgreSQL host |
| `PG_PASSWORD`        | —                      | **OBRIGATÓRIO** |
| `JWT_SECRET`         | (insecure default)     | **TROCAR EM PROD** (32+ chars) |
| `JWT_EXPIRES`        | `8h`                   | TTL dos tokens |
| `SENTRY_DSN`         | —                      | Opcional |
| `BACKUP_DIR`         | `/opt/montana/backups` | Diretório local de backup |
| `GCS_BUCKET`         | `gs://montana-erp-backups` | Destino dos backups |
| `AUTH_MAX_TENTATIVAS`| `5`                    | Tentativas antes de lockout |
| `AUTH_LOCKOUT_MIN`   | `15`                   | Minutos de bloqueio |
| `PASSWORD_MIN_LENGTH`| `12`                   | Comprimento mínimo |

---

## Contato / responsáveis

- **Tech lead**: Felipe Aguiar — felipeaguiar1605@gmail.com
- **DBA**: (a definir)
- **Infra GCP**: (a definir)

Em caso de incidente, ver [RUNBOOK.md](./RUNBOOK.md).
