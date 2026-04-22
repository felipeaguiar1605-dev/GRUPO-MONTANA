# Proposta: Migração SQLite → PostgreSQL (D2 do roadmap)

> **Status**: proposta em discussão. Código NÃO escrito. Execução só após aprovação.
> **Estimativa**: 2–3 semanas em paralelo com operação normal (não é big bang).

## Por que migrar

| Limitação SQLite hoje | Consequência |
|---|---|
| Single-writer (lock global em WRITE) | Conciliação travada quando outro processo escreve — hoje é raro, mas bloqueia escalabilidade |
| Sem blue/green deploy real | Todo deploy causa janela de ~5s de 502 enquanto pm2 reinicia |
| Backup = `.backup` (cópia binária) | Restore parcial impossível; tempo de restore = tempo de cópia + replay WAL |
| Sem replicação nativa | DR manual (copiar arquivo) em caso de falha da VM |
| Queries analíticas pesadas competem com OLTP | Dashboard puxando 18k extratos + JOIN vs NFs trava a UI |

## O que já protege a migração

- **Database Factory** (`src/db.js`): toda abertura de DB passa por `getDb(key)`. Trocar o driver é 1 arquivo.
- **better-sqlite3 é síncrono**; `pg` é async. Isso é o principal impacto: quase toda rota em `src/api.js` precisa virar `async/await`.
- **Queries são SQL padrão** quase sempre — `PRIMARY KEY AUTOINCREMENT`, `datetime('now')`, `?` placeholders (Postgres usa `$1`, `$2`).

## Pontos de atrito identificados (auditoria prévia necessária)

```
grep -rnE "datetime\('now'\)|AUTOINCREMENT|PRAGMA|\.changes|\.lastInsertRowid" src/ | wc -l
```
- `datetime('now')` → `NOW()` ou `CURRENT_TIMESTAMP` (não é drop-in)
- `AUTOINCREMENT` → `GENERATED ALWAYS AS IDENTITY` ou `SERIAL`
- `PRAGMA journal_mode=WAL` → irrelevante em PG
- `.changes` / `.lastInsertRowid` → `RETURNING id` em PG
- Placeholders `?` → `$1, $2, $3`

## Plano em 4 fases (sem big bang)

### Fase 1 — Preparação (1 semana, zero risco produção)
1. Levantar Postgres 16 local + em staging (VM GCP nova, não tocar prod)
2. Script `scripts/sqlite_to_pg_schema.js`: lê schema de um DB SQLite, gera DDL Postgres equivalente
3. Script `scripts/sqlite_to_pg_data.js`: lê cada tabela, faz INSERT batch no PG (com conversões de tipo)
4. Testar com DB Mustang primeiro (menor, menos dados)

### Fase 2 — Dual-write (1 semana, zero downtime)
1. `src/db-pg.js` — novo driver que implementa a mesma interface mínima usada (`prepare().run()`, `prepare().get()`, `prepare().all()`)
2. Flag `DUAL_WRITE=1`: escrita em SQLite **e** Postgres (lê de SQLite ainda)
3. Monitor diário: compara counts tabela a tabela entre os dois
4. Rodar por 3-5 dias até counts baterem 100%

### Fase 3 — Corte de leitura (1 dia, reversível)
1. Flag `READ_FROM_PG=1` por empresa (mustang → portodovau → seguranca → assessoria)
2. Se divergência: volta a flag, debuga, tenta de novo
3. Quando todas as 4 estiverem lendo do PG por 48h, entra fase 4

### Fase 4 — Remoção SQLite (1 dia)
1. Desliga `DUAL_WRITE`, PG é fonte única
2. SQLite fica congelado como backup por 30 dias
3. Após 30d estável: remove `better-sqlite3` do package.json, remove `data/*/montana.db`

## Custo

- VM Postgres em GCP: ~R$ 100-150/mês (db-f1-micro Cloud SQL ou Postgres self-hosted na mesma VM)
- Tempo de desenvolvimento: 60–80h (2–3 semanas 1 dev)
- Risco de dados perdidos: praticamente zero se seguir fase 2 (dual-write + reconciliação)

## Pré-requisitos (outros itens do roadmap)

- **D1 ✅ feito** — smoke tests passando. Fundamental pra validar cada fase.
- **D6** — backup validado (assim o rollback é seguro)
- **D7** — CI rodando (validar cada PR da migração antes de merge)

## Decisão pendente

| Opção | Prós | Contras |
|---|---|---|
| **A) Postgres self-hosted na VM atual** | R$ 0 extra, rede interna | Backup manual, sem HA |
| **B) Cloud SQL Postgres** | Backup automático, PITR, HA opcional | +R$ 150-300/mês |
| **C) Supabase (free tier)** | Zero setup, Studio admin UI | Vendor lock, limite de conexões free |

Recomendação: começar com **A** (zero custo), migrar pra **B** quando volume justificar.

## O que fazer agora

1. Confirmar que D6 está funcionando (preciso de SSH prod autorizado)
2. Push do `ci.yml` (precisa user criar via UI ou liberar scope `workflow` no token)
3. Aprovar esta proposta ou vetar com contra-argumento
4. Se aprovado: começar Fase 1 em branch `feat/D2-postgres-phase1`
