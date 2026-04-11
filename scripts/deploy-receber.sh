#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  Montana App — Script executado no GCP após receber arquivos
#  Chamado automaticamente pelo deploy.bat do Windows
# ═══════════════════════════════════════════════════════════════════

APP_DIR="/opt/montana/app_unificado"
LOG="/opt/montana/logs/deploy.log"

echo "" >> $LOG
echo "══════════════════════════════════" >> $LOG
echo "Deploy: $(date '+%Y-%m-%d %H:%M:%S')" >> $LOG

cd $APP_DIR

# Instala/atualiza dependências apenas se package.json mudou
npm install --production 2>&1 | tail -5 >> $LOG

# Reinicia via PM2 (zero-downtime)
pm2 restart montana-app 2>&1 >> $LOG

echo "✔ Deploy concluído" >> $LOG
echo "══════════════════════════════════" >> $LOG

# Mostra status
pm2 status
