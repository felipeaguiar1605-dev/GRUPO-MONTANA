#!/bin/bash
# Montana ERP — Restore de backup PostgreSQL do GCS
#
# Uso:
#   bash scripts/restore_postgres.sh <data> <schema> [--target-db=<db>] [--target-schema=<sch>]
#
# Exemplos:
#   # Listar backups disponíveis
#   bash scripts/restore_postgres.sh --list
#
#   # Restaurar schema 'assessoria' do backup de 2026-05-01 para um schema de teste
#   bash scripts/restore_postgres.sh 2026-05-01 assessoria \
#       --target-db=montana_erp_restore --target-schema=assessoria_2026_05_01
#
#   # Restaurar para o mesmo schema (CUIDADO - DROPA SCHEMA EXISTENTE)
#   bash scripts/restore_postgres.sh 2026-05-01 assessoria --confirm-overwrite
#
# Pré-requisitos:
#   - pg_restore / psql v16+ (mesmo do servidor)
#   - gsutil autenticado
#   - PG_PASSWORD do target no env

set -euo pipefail

GCS_BUCKET="${GCS_BUCKET:-gs://montana-backups-2026}"
PG_HOST="${PG_HOST:-35.247.208.7}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-montana}"
PG_DB="${PG_DB:-montana_erp}"

# ── Listar backups disponíveis ──────────────────────────────────────
if [[ "${1:-}" == "--list" ]]; then
  echo "Backups disponíveis em $GCS_BUCKET:"
  gsutil ls "$GCS_BUCKET/" | grep -E '/[0-9]{4}-[0-9]{2}-[0-9]{2}/$' | sort | tail -30
  echo ""
  echo "Para listar arquivos de uma data: gsutil ls $GCS_BUCKET/<data>/"
  exit 0
fi

# ── Args ────────────────────────────────────────────────────────────
DATA="${1:-}"
SCHEMA="${2:-}"
TARGET_DB="$PG_DB"
TARGET_SCHEMA="$SCHEMA"
CONFIRM_OVERWRITE=false

shift 2 2>/dev/null || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-db=*)         TARGET_DB="${1#*=}"          ;;
    --target-schema=*)     TARGET_SCHEMA="${1#*=}"      ;;
    --confirm-overwrite)   CONFIRM_OVERWRITE=true       ;;
    *) echo "Flag desconhecida: $1"; exit 1             ;;
  esac
  shift
done

if [[ -z "$DATA" || -z "$SCHEMA" ]]; then
  echo "Uso: $0 <YYYY-MM-DD> <schema> [opções]"
  echo "     $0 --list"
  exit 1
fi

if [[ -z "${PG_PASSWORD:-}" ]]; then
  echo "✗ PG_PASSWORD não definida"
  exit 1
fi

# ── Guard: overwrite no schema original ─────────────────────────────
if [[ "$TARGET_DB" == "$PG_DB" && "$TARGET_SCHEMA" == "$SCHEMA" ]]; then
  if ! $CONFIRM_OVERWRITE; then
    echo "✗✗✗ Você está prestes a SOBRESCREVER o schema $SCHEMA em $PG_DB"
    echo "    Isso DROPA todos os dados atuais. Adicione --confirm-overwrite se for intencional."
    echo "    Ou use --target-db=montana_erp_restore --target-schema=${SCHEMA}_${DATA//-/_}"
    exit 1
  fi
  echo "⚠⚠⚠ ATENÇÃO: vai sobrescrever $TARGET_DB.$TARGET_SCHEMA — digite 'sobrescrever' pra confirmar:"
  read -r confirm
  [[ "$confirm" == "sobrescrever" ]] || { echo "Abortado."; exit 1; }
fi

# ── Download ────────────────────────────────────────────────────────
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

REMOTE="$GCS_BUCKET/$DATA/${DATA}_${SCHEMA}.sql.gz"
LOCAL="$TMPDIR/${SCHEMA}.sql.gz"

echo "▶ Baixando $REMOTE"
if ! gsutil cp "$REMOTE" "$LOCAL"; then
  echo "✗ Backup não encontrado: $REMOTE"
  echo "  Use --list pra ver datas disponíveis"
  exit 1
fi

SIZE=$(stat -c%s "$LOCAL" 2>/dev/null || stat -f%z "$LOCAL")
SIZE_MB=$(awk "BEGIN {printf \"%.2f\", $SIZE/1024/1024}")
echo "  ✓ Baixado: ${SIZE_MB} MB"

# ── Preparar target schema ──────────────────────────────────────────
export PGPASSWORD="$PG_PASSWORD"

# Cria DB target se não existir
DB_EXISTS=$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='$TARGET_DB'" 2>/dev/null || true)
if [[ -z "$DB_EXISTS" ]]; then
  echo "▶ Criando database $TARGET_DB"
  psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres \
    -c "CREATE DATABASE $TARGET_DB"
fi

echo "▶ Recriando schema $TARGET_SCHEMA em $TARGET_DB"
psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$TARGET_DB" <<SQL
DROP SCHEMA IF EXISTS $TARGET_SCHEMA CASCADE;
CREATE SCHEMA $TARGET_SCHEMA;
GRANT ALL ON SCHEMA $TARGET_SCHEMA TO $PG_USER;
SQL

# ── Restore ─────────────────────────────────────────────────────────
echo "▶ Restaurando $SCHEMA → $TARGET_DB.$TARGET_SCHEMA"

# Se schema source != target, precisa reescrever os refs no SQL
if [[ "$TARGET_SCHEMA" != "$SCHEMA" ]]; then
  echo "  ↻ Renomeando referências de $SCHEMA → $TARGET_SCHEMA"
  gunzip -c "$LOCAL" \
    | sed -E "s/\b$SCHEMA\./$TARGET_SCHEMA./g; s/SCHEMA $SCHEMA/SCHEMA $TARGET_SCHEMA/g" \
    | psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$TARGET_DB" -q -v ON_ERROR_STOP=0 \
      2>&1 | grep -v "already exists" || true
else
  gunzip -c "$LOCAL" \
    | psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$TARGET_DB" -q -v ON_ERROR_STOP=0 \
      2>&1 | grep -v "already exists" || true
fi

# ── Validação ───────────────────────────────────────────────────────
echo ""
echo "▶ Validando restore..."
TABLES=$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$TARGET_DB" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='$TARGET_SCHEMA'")
echo "  $TABLES tabelas restauradas"

# Conta linhas em tabelas-chave
for tbl in usuarios bol_contratos notas_fiscais extratos_bancarios; do
  COUNT=$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$TARGET_DB" -tAc \
    "SELECT count(*) FROM $TARGET_SCHEMA.$tbl" 2>/dev/null || echo "n/a")
  printf "  %-25s %s linhas\n" "$tbl" "$COUNT"
done

unset PGPASSWORD
echo ""
echo "✅ Restore concluído: $TARGET_DB.$TARGET_SCHEMA"
echo ""
echo "Para conectar e inspecionar:"
echo "  psql -h $PG_HOST -U $PG_USER -d $TARGET_DB -c \"SET search_path TO $TARGET_SCHEMA, public; SELECT count(*) FROM bol_contratos\""
