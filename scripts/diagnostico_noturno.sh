#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  Montana ERP — Diagnóstico Noturno Automático
#  Roda todo dia às 03h00 via crontab do servidor
# ═══════════════════════════════════════════════════════════

LOG_DIR="/opt/montana/app_unificado/data"
OUT="$LOG_DIR/diagnostico_noturno.json"
DATA_HORA=$(date '+%Y-%m-%d %H:%M:%S')
ALERTAS_ARR=()
ITENS_ARR=()

log_item() {
  local status="$1" label="$2" detalhe="$3"
  # escape double quotes
  detalhe=$(echo "$detalhe" | sed 's/"/\\"/g')
  label=$(echo "$label" | sed 's/"/\\"/g')
  ITENS_ARR+=("{\"status\":\"$status\",\"label\":\"$label\",\"detalhe\":\"$detalhe\"}")
  if [ "$status" = "ERRO" ] || [ "$status" = "AVISO" ]; then
    ALERTAS_ARR+=("\"$label: $detalhe\"")
  fi
}

# ── 1. PM2 Status ───────────────────────────────────────────
PM2_OUT=$(pm2 list 2>/dev/null | grep montana-app)
if echo "$PM2_OUT" | grep -q "online"; then
  RESTARTS=$(pm2 list 2>/dev/null | grep montana-app | grep -oP '\d+(?=\s+online)' | tail -1 || echo 0)
  log_item "OK" "PM2 montana-app" "online"
else
  log_item "ERRO" "PM2 montana-app" "FORA DO AR ou não encontrado"
fi

# ── 2. Erros nos logs PM2 ───────────────────────────────────
ERROS_LOG=$(pm2 logs montana-app --lines 200 --nostream 2>/dev/null | grep -iE "error|exception|uncaught|FATAL" | grep -v "npm warn" | wc -l)
if [ "$ERROS_LOG" -gt 10 ]; then
  ULTIMO=$(pm2 logs montana-app --lines 200 --nostream 2>/dev/null | grep -iE "error|exception|uncaught" | tail -1 | cut -c1-100)
  log_item "AVISO" "Logs PM2" "$ERROS_LOG erros encontrados. Ultimo: $ULTIMO"
else
  log_item "OK" "Logs PM2" "$ERROS_LOG ocorrencias de erro nas ultimas 200 linhas"
fi

# ── 3. Disco ────────────────────────────────────────────────
DISCO_INFO=$(df /opt/montana 2>/dev/null | tail -1)
DISCO_PCT=$(echo "$DISCO_INFO" | awk '{gsub(/%/,"",$5); print $5}')
DISCO_DISP=$(df -h /opt/montana 2>/dev/null | tail -1 | awk '{print $4}')
if [ -n "$DISCO_PCT" ] && [ "$DISCO_PCT" -ge 85 ] 2>/dev/null; then
  log_item "ERRO" "Disco" "CRITICO: ${DISCO_PCT}% usado, restam ${DISCO_DISP}"
elif [ -n "$DISCO_PCT" ] && [ "$DISCO_PCT" -ge 70 ] 2>/dev/null; then
  log_item "AVISO" "Disco" "${DISCO_PCT}% usado, restam ${DISCO_DISP}"
else
  log_item "OK" "Disco" "${DISCO_PCT}% usado, restam ${DISCO_DISP} livres"
fi

# ── 4. Memória ──────────────────────────────────────────────
MEM_TOTAL=$(free -m | awk 'NR==2{print $2}')
MEM_USADA=$(free -m | awk 'NR==2{print $3}')
SWAP_USADA=$(free -m | awk 'NR==3{print $3}')
if [ -n "$MEM_TOTAL" ] && [ "$MEM_TOTAL" -gt 0 ] 2>/dev/null; then
  MEM_PCT=$(( MEM_USADA * 100 / MEM_TOTAL ))
  if [ "$MEM_PCT" -ge 90 ]; then
    log_item "ERRO" "Memoria" "CRITICO: ${MEM_PCT}% usada (${MEM_USADA}MB/${MEM_TOTAL}MB)"
  elif [ "$SWAP_USADA" -gt 200 ] 2>/dev/null; then
    log_item "AVISO" "Memoria" "${MEM_PCT}% RAM, SWAP: ${SWAP_USADA}MB em uso"
  else
    log_item "OK" "Memoria" "${MEM_PCT}% usada (${MEM_USADA}/${MEM_TOTAL}MB), swap: ${SWAP_USADA}MB"
  fi
else
  log_item "OK" "Memoria" "nao foi possivel verificar"
fi

# ── 5. Integridade SQLite ───────────────────────────────────
DB_ERROS=0
DB_STATUS=""
for DB in /opt/montana/app_unificado/data/*/montana.db; do
  EMPRESA=$(echo "$DB" | sed 's|.*/data/||' | sed 's|/montana.db||')
  RESULT=$(sqlite3 "$DB" "PRAGMA integrity_check;" 2>/dev/null | head -1)
  if [ "$RESULT" != "ok" ]; then
    DB_ERROS=$((DB_ERROS+1))
    DB_STATUS="$DB_STATUS $EMPRESA:CORROMPIDO"
  fi
done
if [ "$DB_ERROS" -gt 0 ]; then
  log_item "ERRO" "SQLite Integridade" "BANCO(S) CORROMPIDO(S):$DB_STATUS"
else
  log_item "OK" "SQLite Integridade" "Todos os bancos OK"
fi

# ── 6. Certificado SSL ──────────────────────────────────────
SSL_EXPIRY=$(echo | openssl s_client -connect sistema.grupomontanasec.com:443 -servername sistema.grupomontanasec.com 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
if [ -n "$SSL_EXPIRY" ]; then
  DIAS=$(( ( $(date -d "$SSL_EXPIRY" +%s 2>/dev/null || date +%s) - $(date +%s) ) / 86400 ))
  if [ "$DIAS" -lt 14 ] 2>/dev/null; then
    log_item "ERRO" "Certificado SSL" "Vence em ${DIAS} dias - RENOVAR URGENTE"
  elif [ "$DIAS" -lt 30 ] 2>/dev/null; then
    log_item "AVISO" "Certificado SSL" "Vence em ${DIAS} dias"
  else
    log_item "OK" "Certificado SSL" "Valido por ${DIAS} dias"
  fi
else
  log_item "AVISO" "Certificado SSL" "Nao foi possivel verificar"
fi

# ── 7. Certidões vencendo em ≤15 dias ──────────────────────
CERT_VENC=$(sqlite3 /opt/montana/app_unificado/data/assessoria/montana.db \
  "SELECT tipo||' ('||orgao||') vence '||validade FROM certidoes WHERE date(validade) <= date('now','+15 days') AND date(validade) >= date('now') ORDER BY validade;" 2>/dev/null | head -5)
if [ -n "$CERT_VENC" ]; then
  CERT_VENC_INLINE=$(echo "$CERT_VENC" | tr '\n' ' | ' | sed 's/ | $//')
  log_item "AVISO" "Certidoes" "$CERT_VENC_INLINE"
else
  log_item "OK" "Certidoes" "Nenhuma certidao vencendo nos proximos 15 dias"
fi

# ── 8. Backup ───────────────────────────────────────────────
BACKUP_HOJE=$(find /opt/montana/backups -name "*.db" -mtime -1 2>/dev/null | wc -l)
if [ "$BACKUP_HOJE" -gt 0 ]; then
  log_item "OK" "Backup diario" "$BACKUP_HOJE arquivo(s) gerado(s) nas ultimas 24h"
else
  log_item "AVISO" "Backup diario" "Nenhum backup encontrado nas ultimas 24h"
fi

# ── Montar JSON ─────────────────────────────────────────────
N_ALERTAS=${#ALERTAS_ARR[@]}

# Build alertas JSON array
ALERTAS_JSON=""
for i in "${!ALERTAS_ARR[@]}"; do
  [ "$i" -gt 0 ] && ALERTAS_JSON="$ALERTAS_JSON,"
  ALERTAS_JSON="$ALERTAS_JSON${ALERTAS_ARR[$i]}"
done

# Build itens JSON array
ITENS_JSON=""
for i in "${!ITENS_ARR[@]}"; do
  [ "$i" -gt 0 ] && ITENS_JSON="$ITENS_JSON,"
  ITENS_JSON="$ITENS_JSON${ITENS_ARR[$i]}"
done

cat > "$OUT" <<JSONEOF
{
  "data_hora": "$DATA_HORA",
  "alertas_count": $N_ALERTAS,
  "alertas": [$ALERTAS_JSON],
  "itens": [$ITENS_JSON]
}
JSONEOF

# Histórico (append)
echo "[$DATA_HORA] Diagnostico concluido: $N_ALERTAS alerta(s)" >> "$LOG_DIR/diagnostico_historico.log"
# Manter apenas últimas 30 linhas do histórico
tail -30 "$LOG_DIR/diagnostico_historico.log" > "$LOG_DIR/diagnostico_historico.log.tmp" && mv "$LOG_DIR/diagnostico_historico.log.tmp" "$LOG_DIR/diagnostico_historico.log"

echo "[$DATA_HORA] OK — $N_ALERTAS alerta(s) — saida: $OUT"
