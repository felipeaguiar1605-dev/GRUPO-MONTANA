#!/bin/bash
# Montana ERP — Backup automatizado PostgreSQL → Google Cloud Storage
#
# Faz pg_dump dos 4 schemas (assessoria, seguranca, portodovau, mustang)
# em arquivos separados + um dump global, comprime, envia pra GCS,
# e remove backups locais com mais de 7 dias.
#
# Uso:
#   bash scripts/backup_postgres.sh
#
# Variáveis de ambiente esperadas (em .env ou shell):
#   PG_HOST     (default 35.247.208.7)
#   PG_PORT     (default 5432)
#   PG_USER     (default montana)
#   PG_PASSWORD (obrigatório)
#   PG_DB       (default montana_erp)
#   GCS_BUCKET  (default gs://montana-erp-backups)
#
# Retenção:
#   - GCS: lifecycle rule 90 dias (configurar separadamente)
#   - Local: 7 dias de backups (LOCAL_RETENTION_DAYS)

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────
PG_HOST="${PG_HOST:-35.247.208.7}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-montana}"
PG_PASSWORD="${PG_PASSWORD:-montana2026}"
PG_DB="${PG_DB:-montana_erp}"
GCS_BUCKET="${GCS_BUCKET:-gs://montana-erp-backups}"
BACKUP_DIR="${BACKUP_DIR:-/opt/montana/backups}"
LOCAL_RETENTION_DAYS=7
SCHEMAS=("assessoria" "seguranca" "portodovau" "mustang")

# ── Setup ───────────────────────────────────────────────────────────
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
TODAY=$(date +%Y-%m-%d)
mkdir -p "$BACKUP_DIR"
LOG_FILE="$BACKUP_DIR/backup_${TIMESTAMP}.log"

# Função de log que vai pra stdout E pro arquivo
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

log "═══════════════════════════════════════════════════"
log "  Montana ERP — Backup PostgreSQL — $TIMESTAMP"
log "═══════════════════════════════════════════════════"
log "Host: $PG_HOST:$PG_PORT/$PG_DB"
log "Bucket: $GCS_BUCKET"

export PGPASSWORD="$PG_PASSWORD"

# ── 1. Dump por schema ──────────────────────────────────────────────
TOTAL_SIZE=0
for schema in "${SCHEMAS[@]}"; do
  FILE="$BACKUP_DIR/${TODAY}_${schema}.sql.gz"
  log ""
  log "▶ Dump schema: $schema"

  if pg_dump --no-owner --no-acl --schema="$schema" \
      -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" 2>>"$LOG_FILE" \
      | gzip > "$FILE"; then
    SIZE=$(stat -c%s "$FILE" 2>/dev/null || stat -f%z "$FILE" 2>/dev/null || echo 0)
    SIZE_MB=$(awk "BEGIN {printf \"%.2f\", $SIZE/1024/1024}")
    TOTAL_SIZE=$((TOTAL_SIZE + SIZE))
    log "  ✓ $FILE (${SIZE_MB} MB)"
  else
    log "  ✗ ERRO ao fazer dump de $schema"
    rm -f "$FILE"
    exit 1
  fi
done

# ── 2. Dump global (roles, extensions, schema list) ─────────────────
GLOBAL_FILE="$BACKUP_DIR/${TODAY}_global.sql.gz"
log ""
log "▶ Dump global (estruturas compartilhadas)"
if pg_dumpall --globals-only -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" 2>>"$LOG_FILE" \
    | gzip > "$GLOBAL_FILE"; then
  log "  ✓ $GLOBAL_FILE"
else
  log "  ⚠ Globals dump falhou (pode ser permissão limitada do user montana — não-fatal)"
  rm -f "$GLOBAL_FILE"
fi

# ── 3. Upload para GCS ──────────────────────────────────────────────
log ""
log "▶ Enviando para $GCS_BUCKET/$TODAY/"
if command -v gsutil >/dev/null 2>&1; then
  if gsutil -m cp "$BACKUP_DIR/${TODAY}_"*.sql.gz "$GCS_BUCKET/$TODAY/" 2>>"$LOG_FILE"; then
    log "  ✓ Upload concluído"
  else
    log "  ✗ Upload falhou — backups mantidos localmente em $BACKUP_DIR"
    exit 1
  fi
else
  log "  ⚠ gsutil não encontrado — instale 'google-cloud-sdk' ou faça upload manual"
  log "     gsutil cp $BACKUP_DIR/${TODAY}_*.sql.gz $GCS_BUCKET/$TODAY/"
fi

# ── 4. Limpa backups locais antigos ─────────────────────────────────
log ""
log "▶ Limpando backups locais com mais de ${LOCAL_RETENTION_DAYS}d"
find "$BACKUP_DIR" -maxdepth 1 -name '*.sql.gz' -type f -mtime +"$LOCAL_RETENTION_DAYS" -delete 2>>"$LOG_FILE" || true
find "$BACKUP_DIR" -maxdepth 1 -name '*.log' -type f -mtime +"$LOCAL_RETENTION_DAYS" -delete 2>>"$LOG_FILE" || true

# ── 5. Resumo ───────────────────────────────────────────────────────
TOTAL_MB=$(awk "BEGIN {printf \"%.2f\", $TOTAL_SIZE/1024/1024}")
log ""
log "═══════════════════════════════════════════════════"
log "  ✅ Backup concluído — ${#SCHEMAS[@]} schemas, ${TOTAL_MB} MB"
log "═══════════════════════════════════════════════════"

# Exit limpo
unset PGPASSWORD
exit 0
