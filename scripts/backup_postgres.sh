#!/bin/bash
# Montana ERP — Backup PostgreSQL → GCS
set -euo pipefail

PG_HOST="${PG_HOST:-35.247.208.7}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-montana}"
PG_PASSWORD="${PG_PASSWORD:-montana2026}"
PG_DB="${PG_DB:-montana_erp}"
GCS_BUCKET="${GCS_BUCKET:-gs://montana-backups-2026}"
BACKUP_DIR="${BACKUP_DIR:-/opt/montana/backups}"
LOCAL_RETENTION_DAYS=7
SCHEMAS=("assessoria" "seguranca" "portodovau" "mustang")

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
TODAY=$(date +%Y-%m-%d)
mkdir -p "$BACKUP_DIR"
LOG_FILE="$BACKUP_DIR/backup_${TIMESTAMP}.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

log "═══════════════════════════════════════════════════"
log "  Montana ERP — Backup PostgreSQL — $TIMESTAMP"
log "═══════════════════════════════════════════════════"
log "Host: $PG_HOST:$PG_PORT/$PG_DB"
log "Bucket: $GCS_BUCKET"

export PGPASSWORD="$PG_PASSWORD"

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

GLOBAL_FILE="$BACKUP_DIR/${TODAY}_global.sql.gz"
log ""
log "▶ Dump global"
if pg_dumpall --globals-only -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" 2>>"$LOG_FILE" \
    | gzip > "$GLOBAL_FILE"; then
  log "  ✓ $GLOBAL_FILE"
else
  log "  ⚠ Globals dump falhou (não-fatal)"
  rm -f "$GLOBAL_FILE"
fi

log ""
log "▶ Enviando para $GCS_BUCKET/$TODAY/"
if command -v gsutil >/dev/null 2>&1; then
  if gsutil -m cp "$BACKUP_DIR/${TODAY}_"*.sql.gz "$GCS_BUCKET/$TODAY/" 2>>"$LOG_FILE"; then
    log "  ✓ Upload concluído"
  else
    log "  ✗ Upload falhou"
    exit 1
  fi
else
  log "  ⚠ gsutil não encontrado — instale 'google-cloud-sdk'"
fi

log ""
log "▶ Limpando backups locais antigos (>${LOCAL_RETENTION_DAYS}d)"
find "$BACKUP_DIR" -maxdepth 1 -name '*.sql.gz' -type f -mtime +"$LOCAL_RETENTION_DAYS" -delete 2>>"$LOG_FILE" || true
find "$BACKUP_DIR" -maxdepth 1 -name '*.log' -type f -mtime +"$LOCAL_RETENTION_DAYS" -delete 2>>"$LOG_FILE" || true

TOTAL_MB=$(awk "BEGIN {printf \"%.2f\", $TOTAL_SIZE/1024/1024}")
log ""
log "═══════════════════════════════════════════════════"
log "  ✅ Backup concluído — ${#SCHEMAS[@]} schemas, ${TOTAL_MB} MB"
log "═══════════════════════════════════════════════════"

unset PGPASSWORD
exit 0
