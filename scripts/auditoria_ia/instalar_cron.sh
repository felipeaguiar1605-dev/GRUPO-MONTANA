#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  Montana — Instalador do cron da Auditoria IA (sábado 04h00)
#
#  EXECUTAR NO SERVIDOR DE PRODUCAO, como o usuário que roda o ERP:
#
#      bash /opt/montana/app_unificado/scripts/auditoria_ia/instalar_cron.sh
#
#  Operações (todas idempotentes):
#   1. cria /var/log/montana/ se não existir
#   2. garante permissão de execução no orquestrador
#   3. adiciona a linha no crontab do usuário atual — sem duplicar
#
#  Desinstalar:
#      bash /opt/montana/app_unificado/scripts/auditoria_ia/instalar_cron.sh --remover
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

APP_DIR="/opt/montana/app_unificado"
LOG_DIR="/var/log/montana"
LOG_FILE="$LOG_DIR/auditoria_ia.log"
ORQ="$APP_DIR/scripts/auditoria_ia/orquestrador.js"
NODE_BIN="$(command -v node || echo /usr/bin/node)"

# Marca identificadora para achar/remover a linha sem afetar outras
MARCA="# montana-auditoria-ia"
CRON_LINE="0 4 * * 6 cd $APP_DIR && $NODE_BIN $ORQ >> $LOG_FILE 2>&1  $MARCA"

# ── Desinstalar ─────────────────────────────────────────────────────
if [[ "${1:-}" == "--remover" ]]; then
  echo "→ Removendo cron da Auditoria IA..."
  crontab -l 2>/dev/null | grep -v -F "$MARCA" | crontab -
  echo "  ✅ removido"
  exit 0
fi

# ── Instalar ────────────────────────────────────────────────────────
echo "→ Instalando cron da Auditoria IA"
echo "  APP_DIR : $APP_DIR"
echo "  NODE    : $NODE_BIN"
echo "  LOG     : $LOG_FILE"
echo "  Horário : sábado 04h00"

# 1. log dir
if [[ ! -d "$LOG_DIR" ]]; then
  echo "  • Criando $LOG_DIR"
  sudo mkdir -p "$LOG_DIR"
  sudo chown "$USER" "$LOG_DIR"
fi

# 2. orquestrador existe?
if [[ ! -f "$ORQ" ]]; then
  echo "  ❌ $ORQ não encontrado. Faça git pull antes." >&2
  exit 1
fi
chmod +x "$ORQ"

# 3. verifica ANTHROPIC_API_KEY no .env
if ! grep -q '^ANTHROPIC_API_KEY=' "$APP_DIR/.env" 2>/dev/null; then
  echo "  ⚠️  AVISO: ANTHROPIC_API_KEY não encontrada em $APP_DIR/.env"
  echo "     A auditoria vai falhar até a chave estar configurada."
fi

# 4. crontab — sem duplicar
CRON_ATUAL="$(crontab -l 2>/dev/null || true)"
if echo "$CRON_ATUAL" | grep -qF "$MARCA"; then
  echo "  • Linha já existe no crontab — atualizando (caso path tenha mudado)"
  echo "$CRON_ATUAL" | grep -v -F "$MARCA" | { cat; echo "$CRON_LINE"; } | crontab -
else
  echo "  • Adicionando ao crontab"
  { echo "$CRON_ATUAL"; echo "$CRON_LINE"; } | crontab -
fi

echo ""
echo "  ✅ Instalado. Próxima execução: sábado 04h00"
echo ""
echo "Dicas:"
echo "  • Ver cron atual:  crontab -l"
echo "  • Teste agora:     cd $APP_DIR && node $ORQ --somente=contabil_fiscal --teto-brl=1"
echo "  • Log:             tail -f $LOG_FILE"
echo "  • Desinstalar:     bash $0 --remover"
