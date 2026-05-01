# Staging — Checklist manual

> Use após rodar `bash scripts/setup_staging.sh` para garantir que o ambiente
> de staging está realmente equivalente à produção e sem vazamento de dados sensíveis.

---

## Pré-flight (uma vez, antes do primeiro setup)

- [ ] VM `montana-staging` provisionada no GCP (e2-small, Ubuntu 22.04, 30 GB SSD)
- [ ] IP fixo + firewall liberando 3002 só para IPs internos / VPN
- [ ] `~/.ssh/config` com alias `montana-staging`
- [ ] CloudSQL `montana-erp-staging` criado (db-f1-micro, mesma região)
- [ ] Bucket `gs://montana-erp-backups-staging` criado (lifecycle 30 dias)
- [ ] `STAGING_PG_PASSWORD` exportado no shell ou em `.env.staging.local`
- [ ] DNS interno apontando `staging.montana.local` → IP da VM (opcional)

---

## Após cada setup / refresh

### 1. Smoke tests funcionais (5 min)
- [ ] `curl http://staging:3002/healthz` retorna `{"ok":true}`
- [ ] Login com `admin / staging123!` funciona
- [ ] Trocar admin password imediatamente após login
- [ ] Trocar para empresa "Assessoria" → vê pelo menos 1 contrato listado
- [ ] Repetir nas outras 3 empresas (Segurança, Porto do Vau, Mustang)
- [ ] Dashboard mostra números (não vazio)
- [ ] Gerar boletim de qualquer mês funciona
- [ ] Exportar Excel de qualquer relatório funciona

### 2. Sanidade de dados (5 min)
- [ ] Contagem de NFs por empresa ≈ produção (±5%):
  ```sql
  SELECT 'assessoria' AS sch, count(*) FROM assessoria.notas_fiscais
  UNION SELECT 'seguranca', count(*) FROM seguranca.notas_fiscais
  UNION SELECT 'portodovau', count(*) FROM portodovau.notas_fiscais
  UNION SELECT 'mustang', count(*) FROM mustang.notas_fiscais;
  ```
- [ ] Audit log existe e tem registros recentes
- [ ] Tabelas `bol_contratos`, `extratos_bancarios`, `usuarios` populadas

### 3. Sanitização confirmada (LGPD) — CRÍTICO
- [ ] Emails de usuários não são reais:
  ```sql
  SELECT email FROM assessoria.usuarios LIMIT 5;
  -- todos devem ser staging+<id>@montana.local
  ```
- [ ] Configurações sensíveis vazias:
  ```sql
  SELECT chave FROM assessoria.configuracoes
  WHERE chave LIKE 'smtp_%' OR chave LIKE 'bb_%' OR chave LIKE 'whatsapp_%';
  -- deve retornar 0 linhas
  ```
- [ ] 2FA secrets resetados:
  ```sql
  SELECT count(*) FROM assessoria.usuarios WHERE totp_secret IS NOT NULL;
  -- deve ser 0
  ```
- [ ] Cron de backup DESABILITADO em staging:
  ```bash
  ssh montana-staging "pm2 stop montana-cron-backup"
  ```
- [ ] Cron de WhatsApp e SMTP DESABILITADOS:
  ```bash
  ssh montana-staging "pm2 stop montana-cron-boletins"
  # (ou deixar rodar — sem SMTP configurado, vira no-op)
  ```

### 4. Não-vazamento de produção (CRÍTICO)
- [ ] `.env` aponta para CloudSQL **staging** (não 35.247.208.7)
- [ ] `JWT_SECRET` é **diferente** de produção
- [ ] `SENTRY_ENV=staging` (eventos não viram de prod)
- [ ] `GCS_BUCKET` é **staging** (não sobrescreve backups de prod)
- [ ] Firewall: porta 3002 NÃO está aberta para 0.0.0.0/0

### 5. Performance baseline
- [ ] Login < 1s
- [ ] Dashboard carrega < 3s
- [ ] Listar 100 contratos < 2s
- [ ] Geração de PDF de boletim < 5s

---

## Quando refazer staging?

| Evento                                | Ação                          |
|---------------------------------------|-------------------------------|
| Migration aplicada em prod            | `--refresh-data` no staging   |
| Bug em prod precisa reproduzir        | `--refresh-data` (dados do dia) |
| Mensalmente (drift de dados)          | `--refresh-data`              |
| Mudou versão de Node / PG             | full setup                    |
| Novo dev no time                      | full setup em VM dedicada     |

---

## Quando NÃO usar staging

- ❌ Para enviar emails de teste (nem sequer com SMTP — risco de vazar)
- ❌ Para integrações reais com BB / WebISS (use sandbox dessas APIs)
- ❌ Para demos com clientes reais (montar ambiente de demo separado)

---

## Decommission

```bash
# Parar app
ssh montana-staging "pm2 delete all"

# Snapshot final (caso precise voltar)
gcloud compute disks snapshot montana-staging-disk --snapshot-names=staging-final

# Destruir VM
gcloud compute instances delete montana-staging

# Destruir DB
gcloud sql instances delete montana-erp-staging

# Limpar bucket (após confirmação)
gsutil -m rm -r gs://montana-erp-backups-staging
```
