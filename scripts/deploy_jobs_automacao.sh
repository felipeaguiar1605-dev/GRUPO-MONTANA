#!/bin/bash
# Montana ERP — Deploy dos jobs de automação
#
# Cria os 3 arquivos no servidor (auto-classify, quality-checks, ofx-import-validator)
# + adiciona crons no PM2 (sem mexer em ecosystem.config.js que está divergente)
#
# Uso:
#   bash scripts/deploy_jobs_automacao.sh
#
# Resultado:
#   - /opt/montana/app_unificado/src/jobs/auto-classify.js
#   - /opt/montana/app_unificado/src/jobs/quality-checks.js
#   - /opt/montana/app_unificado/src/jobs/ofx-import-validator.js
#   - crontab entries pra rodar diariamente

set -euo pipefail

APP_DIR="/opt/montana/app_unificado"
JOBS_DIR="$APP_DIR/src/jobs"

echo "▶ [1/4] Garantindo diretório src/jobs/"
sudo mkdir -p "$JOBS_DIR"

echo "▶ [2/4] Copiando arquivos (este script deve ser rodado a partir do worktree)"
WORKTREE_JOBS="$(dirname "$(readlink -f "$0")")/../src/jobs"
if [ ! -d "$WORKTREE_JOBS" ]; then
  echo "✗ Não achei src/jobs/ no worktree em $WORKTREE_JOBS"
  exit 1
fi

for f in auto-classify.js quality-checks.js ofx-import-validator.js; do
  if [ -f "$WORKTREE_JOBS/$f" ]; then
    sudo cp "$WORKTREE_JOBS/$f" "$JOBS_DIR/$f"
    sudo chmod 644 "$JOBS_DIR/$f"
    echo "  ✓ $f"
  else
    echo "  ⚠ $f não encontrado em $WORKTREE_JOBS"
  fi
done

echo ""
echo "▶ [3/4] Testando dry-run (não muda nada no DB)"
cd "$APP_DIR"
node src/jobs/auto-classify.js --empresa=assessoria 2>&1 | head -20 || echo "  ⚠ Dry-run com erro — checar acima"

echo ""
echo "▶ [4/4] Adicionando crons (auto-classify às 04h, quality-checks às 07h)"
( sudo crontab -l 2>/dev/null | grep -vE '(auto-classify|quality-checks)' ; \
  echo '0 4 * * * cd /opt/montana/app_unificado && /usr/bin/node src/jobs/auto-classify.js --apply >> /opt/montana/logs/cron-auto-classify.log 2>&1' ; \
  echo '0 7 * * * cd /opt/montana/app_unificado && /usr/bin/node src/jobs/quality-checks.js --email >> /opt/montana/logs/cron-quality-checks.log 2>&1' \
) | sudo crontab -

echo ""
echo "✅ Deploy concluído. Crontab atual:"
sudo crontab -l | grep -E '(auto-classify|quality-checks|backup)'
echo ""
echo "💡 Pra testar manualmente AGORA:"
echo "  sudo node $APP_DIR/src/jobs/auto-classify.js                    # dry-run"
echo "  sudo node $APP_DIR/src/jobs/auto-classify.js --apply            # aplica"
echo "  sudo node $APP_DIR/src/jobs/quality-checks.js                   # relatório console"
echo "  sudo node $APP_DIR/src/jobs/quality-checks.js --email           # envia email"
