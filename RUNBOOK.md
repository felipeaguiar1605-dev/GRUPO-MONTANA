# Montana ERP — Runbook de incidentes

> Procedimentos passo-a-passo para responder a incidentes de produção.
> Mantenha este doc **brutalmente prático**: copia-e-cola tem que funcionar.

---

## 🚨 PRÉ-FLIGHT — leia ANTES de qualquer incidente

### Acesso ao servidor

| Recurso | Como acessar |
|---------|--------------|
| **SSH** (preferido) | `ssh montana-prod` (alias) ou Console GCP → Compute Engine → `montana-app-sp` → SSH |
| **IP da VM** | Console GCP → VM `montana-app-sp` (caso DNS caia) |
| **Console GCP** | https://console.cloud.google.com → projeto `propane-highway-492418-d0` |
| **PostgreSQL** | `35.247.208.7:5432` — db `montana_erp`, user `montana` |
| **Senha PG** | Vault (1Password / KeePass) → entry "Montana-Prod-PG" |
| **JWT_SECRET** | Vault → "Montana-Prod-JWT" (rotacionar invalida sessões) |

### Comando 1ª linha quando aparecer no SSH

```bash
# Carrega vars (não exponha senha em screen-share)
source ~/.montana_secrets   # arquivo 600 com export PG_PASSWORD=...
cd /opt/montana/app_unificado
pm2 status
curl -fsS http://localhost:3002/healthz | jq .
```

### Como decidir severidade (1 segundo)

| Sintoma                                              | Severidade | Resposta |
|------------------------------------------------------|------------|----------|
| Cliente NÃO consegue trabalhar agora                 | **P0**     | Acordar Felipe imediatamente, qualquer hora |
| Algo quebrado, mas tem workaround                    | **P1**     | Resolver em até 2h (horário comercial) |
| Falha em job batch / relatório / tela secundária    | **P2**     | Próximo dia útil |
| Pendência cosmética / UX / sugestão                  | **P3**     | Backlog |

### Postmortem express (10 linhas, copy-paste ao final do incidente)

```
## Postmortem YYYY-MM-DD HH:MM
- Sintoma observado:
- Quem reportou:
- Severidade:
- Causa raiz (1 linha):
- O que tentei antes de funcionar:
- Como detectar antes da próxima vez:
- TODO criado: <link issue/asana>
- Tempo total down: ____ min
```

---

## Índice de incidentes

| # | Sintoma                                  | Severidade | Tempo |
|---|------------------------------------------|------------|-------|
| 1 | App offline (timeout / 502 / 504)        | P0         | 5–15 min |
| 2 | Erro 500 generalizado                    | P0         | 10–30 min |
| 3 | Banco PostgreSQL inacessível             | P0         | 15–60 min |
| 4 | Login não funciona / JWT inválido        | P1         | 5–15 min |
| 5 | Backup falhou / não está rodando         | P1         | 30 min |
| 6 | WebISS / BB sync falhou                  | P2         | 1h |
| 7 | Disco cheio / memória alta               | P1         | 15–30 min |
| 8 | Conciliação bancária com divergência     | P2         | 1–2h |
| 9 | Performance degradada (lentidão)         | P1         | 30–60 min |
| 10| Vazamento de credencial / 2FA comprometido | P0       | imediato |

---

## Antes de tudo: triagem (60s)

```bash
# 1. App está vivo?
pm2 status
curl -fsS http://localhost:3002/healthz | jq

# 2. DB responde?
PGPASSWORD="$PG_PASSWORD" psql -h 35.247.208.7 -U montana -d montana_erp -c "SELECT 1"

# 3. Disco ok?
df -h /opt/montana

# 4. Memória ok?
free -h && pm2 list
```

Se **tudo verde** mas usuário reclama → checar `logs/erros.log` últimas 100 linhas.

---

## #1 — App offline (timeout / 502 / 504)

**Diagnóstico:**
```bash
pm2 status
# Se "errored" ou "stopped":
pm2 logs montana-app --lines 100 --err
```

**Resolução padrão:**
```bash
pm2 restart montana-app
sleep 5
curl -fsS http://localhost:3002/healthz
```

**Se restart loopa (max_restarts atingido):**
```bash
pm2 logs montana-app --err --lines 300 > /tmp/crash.log
# Procurar stack trace
grep -E "Error|throw|UnhandledPromise" /tmp/crash.log | head
```

**Causas comuns:**
- `EADDRINUSE` → `sudo fuser -k 3002/tcp` e `pm2 start`
- `ECONNREFUSED` no DB → ver #3
- `out of memory` → `pm2 reload --max-memory-restart 1G`
- Crash em código novo → `git log -5` e `git revert <hash>` se necessário

---

## #2 — Erro 500 generalizado

```bash
tail -f logs/erros.log
# Procurar padrão de erro:
grep -c "ERROR" logs/erros.log | tail
```

**Se tudo aponta pra mesma rota:**
1. Identificar rota: `grep "POST /api/X" logs/erros.log | tail`
2. Reproduzir local com mesma payload
3. Hotfix → branch → PR → deploy

**Se erros aleatórios:**
- Provavelmente DB ou memória — ver #3 ou #7

---

## #3 — Banco PostgreSQL inacessível

**Verificar:**
```bash
PGPASSWORD="$PG_PASSWORD" psql -h 35.247.208.7 -U montana -d montana_erp -c "SELECT now()"
# Se timeout:
nc -zv 35.247.208.7 5432
```

**Se DB caiu (CloudSQL):**
1. Acessar console GCP → Cloud SQL → instância `montana-erp`
2. Verificar status; se restart automático não rolou → `Restart` manual
3. Aguardar ~3 min
4. `pm2 reload montana-app` (reset connection pool)

**Se rede bloqueou:**
```bash
# Verificar firewall (IP da VM precisa estar na allowlist)
gcloud sql instances describe montana-erp | grep authorizedNetworks
```

**Se DB cheio (disk full):**
```sql
-- Conectar e verificar
SELECT pg_database_size('montana_erp')/1024/1024 AS mb;
-- Limpar audit_log antigo (>90d)
DELETE FROM audit_log WHERE ts < NOW() - INTERVAL '90 days';
VACUUM FULL audit_log;
```

---

## #4 — Login não funciona

**Sintoma**: usuário diz "não entra" ou recebe `TOKEN_INVALID`.

```bash
# 1. JWT_SECRET mudou?
pm2 env 0 | grep JWT_SECRET
# Se mudou → todos os tokens antigos invalidaram (esperado pós-deploy)

# 2. Usuário bloqueado por tentativas?
PGPASSWORD="$PG_PASSWORD" psql -h 35.247.208.7 -U montana -d montana_erp -c \
  "SELECT usuario, tentativas_login, bloqueado_ate FROM assessoria.usuarios WHERE usuario='X'"

# Desbloquear:
PGPASSWORD="$PG_PASSWORD" psql -h 35.247.208.7 -U montana -d montana_erp -c \
  "UPDATE assessoria.usuarios SET tentativas_login=0, bloqueado_ate=NULL WHERE usuario='X'"

# 3. 2FA comprometido / usuário perdeu device:
PGPASSWORD="$PG_PASSWORD" psql -h 35.247.208.7 -U montana -d montana_erp -c \
  "UPDATE assessoria.usuarios SET totp_enabled=FALSE, totp_secret=NULL WHERE usuario='X'"
# Avisar usuário pra re-cadastrar
```

**Reset senha admin emergência:**
```bash
node -e "console.log(require('bcryptjs').hashSync('NovaSenha@2026', 10))"
# Pegar o hash e:
PGPASSWORD="$PG_PASSWORD" psql -h 35.247.208.7 -U montana -d montana_erp -c \
  "UPDATE assessoria.usuarios SET senha_hash='<HASH>' WHERE usuario='admin'"
```

---

## #5 — Backup falhou

**Detecção:**
```bash
ls -lh /opt/montana/backups/ | tail
# Último arquivo deve ser de hoje (após 03h)

gsutil ls gs://montana-backups-2026/ | tail
# Pasta com data de hoje deve existir
```

**Diagnóstico:**
```bash
tail -50 /opt/montana/logs/cron-backup.log
tail -50 /opt/montana/backups/backup_*.log | tail -100
```

**Causas comuns:**
- `pg_dump: server version mismatch` → reinstalar `postgresql-client-16` (v15 não dumpa v16)
- `gsutil: command not found` → `sudo apt install google-cloud-sdk`
- `pg_dump: connection refused` → ver #3
- `permission denied` no script → `sudo chmod +x scripts/backup_postgres.sh`
- Disco cheio → ver #7

**Rodar backup manual:**
```bash
sudo PG_PASSWORD="$PG_PASSWORD" bash /opt/montana/app_unificado/scripts/backup_postgres.sh
```

---

## #6 — WebISS / BB sync falhou

**WebISS (NFS-e Palmas):**
```bash
grep "WebISS sync" logs/cron-*.log | tail
```
Causas: certificado A1 expirado, portal Palmas em manutenção, mTLS handshake.
Solução curto prazo: emitir NFs manualmente no portal; investigar à tarde.

**BB API:**
```bash
grep "BB sync" logs/cron-*.log | tail
```
Causa típica: `client_secret` expirou (BB rotaciona a cada 90 dias).
Renovar em developers.bb.com.br → atualizar via UI Configurações da empresa.

---

## #7 — Disco cheio / memória alta

```bash
df -h
du -sh /opt/montana/* | sort -h | tail
```

**Limpezas seguras:**
```bash
# Logs PM2 antigos
pm2 flush
# Backups locais (já em GCS)
find /opt/montana/backups -name '*.sql.gz' -mtime +7 -delete
# Logs do app
find /opt/montana/logs -name '*.log' -mtime +30 -delete
# Caches Drive
rm -rf /opt/montana/app_unificado/data/drive_cache/*
```

**Memória alta:**
```bash
pm2 monit
# Se montana-app > 800 MB → reload
pm2 reload montana-app
```

---

## #8 — Conciliação bancária com divergência

Se contador reclamou de números errados:

```sql
-- Comparar receita do mês
SELECT
  date_trunc('month', data_emissao) AS mes,
  SUM(valor_bruto) AS total_nfs
FROM assessoria.notas_fiscais
WHERE data_emissao >= '2026-04-01'
GROUP BY 1;

SELECT
  date_trunc('month', data_iso) AS mes,
  SUM(valor) AS total_extratos
FROM assessoria.extratos_bancarios
WHERE tipo='C' AND data_iso >= '2026-04-01'
GROUP BY 1;
```

Diferença > 5% → checar:
1. NFs canceladas marcadas como ativas (`status='cancelada' AND ativa=true`)
2. Extratos OFX não importados
3. Pagador alias errado (transferências entre contas contadas como receita)

---

## #9 — Performance degradada

```bash
# Conexões DB ativas
PGPASSWORD="$PG_PASSWORD" psql -h 35.247.208.7 -U montana -d montana_erp -c \
  "SELECT count(*), state FROM pg_stat_activity GROUP BY state"

# Queries lentas (último minuto)
PGPASSWORD="$PG_PASSWORD" psql -h 35.247.208.7 -U montana -d montana_erp -c "
SELECT pid, now()-query_start AS dur, left(query,80)
FROM pg_stat_activity
WHERE state='active' AND now()-query_start > interval '5 seconds'
ORDER BY dur DESC"

# Matar query travada
PGPASSWORD="$PG_PASSWORD" psql -c "SELECT pg_cancel_backend(<pid>)"
PGPASSWORD="$PG_PASSWORD" psql -c "SELECT pg_terminate_backend(<pid>)"  # se cancel não resolver
```

**Frontend lento:**
- F12 → Network → identificar request > 2s
- Provavelmente falta índice no DB; logar query e adicionar `CREATE INDEX CONCURRENTLY`

---

## #10 — Vazamento de credencial / 2FA comprometido

**AÇÃO IMEDIATA:**

1. **Rotacionar JWT_SECRET** (invalida todos os tokens):
   ```bash
   NOVA=$(openssl rand -hex 32)
   pm2 set montana-app:JWT_SECRET "$NOVA"
   pm2 reload montana-app
   ```

2. **Rotacionar PG_PASSWORD** se exposta:
   ```bash
   # No console GCP CloudSQL:
   gcloud sql users set-password montana --instance=montana-erp --password=<NOVA>
   pm2 set montana-app:PG_PASSWORD "<NOVA>"
   pm2 reload all
   ```

3. **Forçar reset de senha de todos os usuários**:
   ```sql
   UPDATE assessoria.usuarios SET senha_alterada_em=NULL, totp_enabled=FALSE;
   -- repetir nos 4 schemas
   ```

4. **Auditar audit_log últimas 24h**:
   ```sql
   SELECT * FROM audit_log WHERE ts > NOW() - INTERVAL '24h' ORDER BY ts;
   ```

5. **Avisar afetados** + registrar incidente em planilha.

---

## Contatos de emergência

- **Tech lead**: Felipe Aguiar — felipeaguiar1605@gmail.com
- **GCP support**: console.cloud.google.com → Suporte
- **BB API support**: developers.bb.com.br/atendimento
- **WebISS Palmas**: portal de chamados da prefeitura

---

## Setup do `~/.montana_secrets` (uma vez, no servidor)

Pra que `$PG_PASSWORD` funcione nos comandos acima sem ficar visível em screen-share:

```bash
# No SSH do servidor:
cat > ~/.montana_secrets <<'EOF'
export PG_PASSWORD='<senha-real-aqui>'
export JWT_SECRET='<jwt-real-aqui>'
export GCS_BUCKET='gs://montana-backups-2026'
EOF
chmod 600 ~/.montana_secrets

# Auto-carrega no login (adicionar ao .bashrc):
echo '[ -f ~/.montana_secrets ] && source ~/.montana_secrets' >> ~/.bashrc
```

Depois disso, qualquer comando `$PG_PASSWORD` neste runbook funciona direto sem expor senha.
