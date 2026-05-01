#!/bin/bash
# Montana ERP — Provisiona ambiente de STAGING (cópia de produção)
#
# Pré-requisitos:
#   - VM GCP staging já criada (e2-small Ubuntu 22.04, IP fixo)
#   - SSH configurado (~/.ssh/config: Host montana-staging)
#   - CloudSQL staging já provisionado (montana-erp-staging)
#   - Acesso a gs://montana-erp-backups
#
# Uso:
#   bash scripts/setup_staging.sh                    # full setup
#   bash scripts/setup_staging.sh --refresh-data     # só recopia dados de prod
#
# Resultado:
#   Staging idêntico a produção, dados de até 24h atrás.

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────
STAGING_HOST="${STAGING_HOST:-montana-staging}"
STAGING_PG_HOST="${STAGING_PG_HOST:-10.0.0.20}"
STAGING_PG_USER="${STAGING_PG_USER:-montana}"
STAGING_PG_DB="${STAGING_PG_DB:-montana_erp}"
APP_DIR="/opt/montana/app_unificado"
GCS_BUCKET="${GCS_BUCKET:-gs://montana-erp-backups}"
SCHEMAS=("assessoria" "seguranca" "portodovau" "mustang")

REFRESH_ONLY=false
[[ "${1:-}" == "--refresh-data" ]] && REFRESH_ONLY=true

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ── GUARD: nunca apontar pra produção (35.247.208.7) ────────────────
# Este script faz DROP SCHEMA. Se rodar contra prod por engano, apaga tudo.
PROD_HOSTS=("35.247.208.7" "montana-erp" "montana-prod")
for ph in "${PROD_HOSTS[@]}"; do
  if [[ "$STAGING_PG_HOST" == "$ph" ]] || [[ "$STAGING_HOST" == "$ph" ]]; then
    echo "✗✗✗ ABORT: STAGING_PG_HOST/STAGING_HOST aponta para PRODUÇÃO ($ph)"
    echo "    Este script faz DROP SCHEMA — recusando rodar."
    exit 1
  fi
done

# Confirma duas vezes se for full setup (não --refresh-data)
if ! $REFRESH_ONLY; then
  echo "⚠ Full setup vai DROPAR todos os 4 schemas em $STAGING_PG_HOST"
  read -p "  Digite 'staging' para confirmar: " confirm
  [[ "$confirm" == "staging" ]] || { echo "Abortado."; exit 1; }
fi

# ── 1. Setup inicial (full) ─────────────────────────────────────────
if ! $REFRESH_ONLY; then
  log "▶ [1/6] Conectando em $STAGING_HOST"
  ssh -q "$STAGING_HOST" 'echo conectado'

  log "▶ [2/6] Instalando dependências sistema"
  ssh "$STAGING_HOST" "sudo apt-get update -qq && sudo apt-get install -y -qq \
    curl git build-essential postgresql-client \
    google-cloud-sdk nodejs npm"

  log "▶ [3/6] Instalando PM2 + Node 20"
  ssh "$STAGING_HOST" "
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
    sudo npm install -g pm2
  "

  log "▶ [4/6] Clonando repositório"
  ssh "$STAGING_HOST" "
    sudo mkdir -p $APP_DIR
    sudo chown \$USER:\$USER /opt/montana
    cd /opt/montana
    [ -d app_unificado/.git ] || git clone https://github.com/montana-grupo/app_unificado.git app_unificado
    cd $APP_DIR
    git checkout staging || git checkout -b staging
    npm install --production
  "

  log "▶ [5/6] Criando .env de staging"
  ssh "$STAGING_HOST" "cat > $APP_DIR/.env <<EOF
NODE_ENV=staging
PORT=3002
PG_HOST=$STAGING_PG_HOST
PG_PORT=5432
PG_USER=$STAGING_PG_USER
PG_DB=$STAGING_PG_DB
PG_PASSWORD=__SUBSTITUIR__
JWT_SECRET=$(openssl rand -hex 32)
JWT_EXPIRES=8h
SENTRY_ENV=staging
BACKUP_DIR=/opt/montana/backups
GCS_BUCKET=gs://montana-erp-backups-staging
EOF
  echo '⚠ Editar PG_PASSWORD em $APP_DIR/.env antes de subir'"
fi

# ── 6. Refresh dos dados de produção ────────────────────────────────
log "▶ [6/6] Restaurando snapshot mais recente de produção"

LATEST=$(gsutil ls "$GCS_BUCKET/" | grep -E '/[0-9]{4}-[0-9]{2}-[0-9]{2}/$' | sort | tail -1)
log "  Snapshot: $LATEST"

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

for sch in "${SCHEMAS[@]}"; do
  log "  ↓ Baixando $sch"
  gsutil cp "${LATEST}*_${sch}.sql.gz" "$TMPDIR/" 2>/dev/null || {
    log "  ⚠ $sch não encontrado em $LATEST — pulando"
    continue
  }

  FILE=$(ls "$TMPDIR"/*_"$sch".sql.gz | head -1)
  log "  ↻ Restaurando $sch (drop + create + import)"

  PGPASSWORD="${STAGING_PG_PASSWORD:-?}" psql -h "$STAGING_PG_HOST" -U "$STAGING_PG_USER" -d "$STAGING_PG_DB" <<SQL
DROP SCHEMA IF EXISTS $sch CASCADE;
CREATE SCHEMA $sch;
GRANT ALL ON SCHEMA $sch TO $STAGING_PG_USER;
SQL

  gunzip -c "$FILE" | PGPASSWORD="${STAGING_PG_PASSWORD:-?}" \
    psql -h "$STAGING_PG_HOST" -U "$STAGING_PG_USER" -d "$STAGING_PG_DB" -q
  log "  ✓ $sch restaurado"
done

# ── Sanitização: anonimizar dados sensíveis em staging ──────────────
log "▶ Sanitizando PII em staging (LGPD-friendly)"

# Gera senha admin random pra ESTE setup (não vaza no script)
ADMIN_PASS=$(openssl rand -base64 18 | tr -d '/+=' | head -c 16)
ADMIN_HASH=$(node -e "console.log(require('bcryptjs').hashSync('$ADMIN_PASS', 10))")

PGPASSWORD="${STAGING_PG_PASSWORD:-?}" psql -h "$STAGING_PG_HOST" -U "$STAGING_PG_USER" -d "$STAGING_PG_DB" <<SQL
DO \$\$
DECLARE sch text;
BEGIN
  FOR sch IN SELECT unnest(ARRAY['assessoria','seguranca','portodovau','mustang'])
  LOOP
    EXECUTE format('UPDATE %I.usuarios SET email = ''staging+'' || id || ''@montana.local''', sch);
    EXECUTE format('UPDATE %I.usuarios SET totp_secret=NULL, totp_enabled=FALSE', sch);
    EXECUTE format(\$q\$UPDATE %I.usuarios SET senha_hash='${ADMIN_HASH}' WHERE usuario='admin'\$q\$, sch);
    EXECUTE format('DELETE FROM %I.configuracoes WHERE chave LIKE ''smtp_%%'' OR chave LIKE ''bb_%%'' OR chave LIKE ''whatsapp_%%''', sch);
  END LOOP;
END \$\$;
SQL

log ""
log "═══════════════════════════════════════════════════"
log "  CREDENCIAIS DO STAGING (anote agora!)"
log "  user:  admin"
log "  senha: $ADMIN_PASS"
log "═══════════════════════════════════════════════════"
log ""

# ── Subir app ───────────────────────────────────────────────────────
log "▶ Subindo app no staging"
ssh "$STAGING_HOST" "cd $APP_DIR && pm2 reload ecosystem.config.js || pm2 start ecosystem.config.js"

# ── Healthcheck ─────────────────────────────────────────────────────
log "▶ Aguardando healthz responder..."
for i in {1..10}; do
  if ssh "$STAGING_HOST" "curl -fsS http://localhost:3002/healthz" >/dev/null 2>&1; then
    log "✅ Staging UP em http://$STAGING_HOST:3002"
    log "   Login: admin / $ADMIN_PASS"
    log "   ⚠ Anote esta senha — não fica no script."
    exit 0
  fi
  sleep 3
done

log "✗ Staging não respondeu /healthz após 30s"
ssh "$STAGING_HOST" "pm2 logs montana-app --lines 50 --nostream"
exit 1
