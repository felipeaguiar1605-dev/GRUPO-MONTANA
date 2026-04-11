#!/bin/bash
# Montana ERP — Importação automática WebISS (NFS-e Palmas-TO)
# Cron: 0 19 * * * /home/diretoria/webiss_import.sh
# WebISS bloqueia das 08h às 18h — executar após 18h

BASE="http://localhost:3002"
LOG="/home/diretoria/montana/logs/webiss_import.log"
mkdir -p /home/diretoria/montana/logs
echo "=== $(date '+%Y-%m-%d %H:%M:%S') ===" >> "$LOG"

for COMPANY in assessoria seguranca; do
  TOKEN=$(curl -s -X POST "$BASE/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"usuario\":\"admin\",\"senha\":\"montana2026\",\"company\":\"$COMPANY\"}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

  if [ -z "$TOKEN" ]; then
    echo "[$COMPANY] ERRO: nao obteve token" >> "$LOG"
    continue
  fi

  RESULT=$(curl -s -X POST "$BASE/api/webiss/importar" \
    -H "Authorization: Bearer $TOKEN" \
    -H "X-Company: $COMPANY" \
    -H "Content-Type: application/json" \
    -d '{"dataInicial":"2023-01-01","dataFinal":"2026-12-31"}')

  echo "[$COMPANY] $RESULT" >> "$LOG"
  echo "[$COMPANY] OK"
done

echo "=== FIM ===" >> "$LOG"
