#!/bin/bash
# ============================================================
# Montana ERP — Backup automático SQLite → Google Cloud Storage
# Executa diariamente via cron: 0 3 * * *
# ============================================================

PROJECT="propane-highway-492418-d0"
BUCKET="gs://montana-backups"
APP_DIR="/opt/montana/app_unificado"
LOG="/opt/montana/logs/backup_gcs.log"
DATE=$(date +%Y-%m-%d)
HOUR=$(date +%H%M)

mkdir -p /opt/montana/logs
echo "=== BACKUP $DATE $HOUR ===" >> "$LOG"

EMPRESAS=("assessoria" "seguranca" "portodovau" "mustang")
SUCCESS=0
FAIL=0

for EMPRESA in "${EMPRESAS[@]}"; do
  DB_PATH="$APP_DIR/data/$EMPRESA/montana.db"

  if [ ! -f "$DB_PATH" ]; then
    echo "[$EMPRESA] SKIP — banco não encontrado" >> "$LOG"
    continue
  fi

  # Cópia temporária para não bloquear o SQLite durante backup
  TMP="/tmp/montana_${EMPRESA}_${DATE}.db"
  cp "$DB_PATH" "$TMP"

  # Comprime e envia para GCS com estrutura de pastas por data
  DEST="$BUCKET/$DATE/$EMPRESA/montana_${DATE}_${HOUR}.db.gz"
  gzip -c "$TMP" | gsutil cp - "$DEST" 2>> "$LOG"

  if [ $? -eq 0 ]; then
    SIZE=$(du -h "$TMP" | cut -f1)
    echo "[$EMPRESA] OK — $SIZE → $DEST" >> "$LOG"
    SUCCESS=$((SUCCESS+1))
  else
    echo "[$EMPRESA] ERRO ao enviar para GCS" >> "$LOG"
    FAIL=$((FAIL+1))
  fi

  rm -f "$TMP"
done

# Limpa backups com mais de 30 dias no GCS
gsutil -m rm -r "$BUCKET/$(date -d '30 days ago' +%Y-%m-%d)/" 2>/dev/null

echo "Resultado: $SUCCESS OK, $FAIL erros" >> "$LOG"
echo "=== FIM ===" >> "$LOG"
