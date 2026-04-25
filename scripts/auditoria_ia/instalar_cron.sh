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
LOG_RUN="$LOG_DIR/auditoria_ia.log"
LOG_MAIL="$LOG_DIR/auditoria_ia_email.log"
ORQ="$APP_DIR/scripts/auditoria_ia/orquestrador.js"
MAIL="$APP_DIR/scripts/auditoria_ia/enviar_relatorio.js"
NODE_BIN="$(command -v node || echo /usr/bin/node)"

# Marcas identificadoras para achar/remover linhas sem afetar outras
MARCA_RUN="# montana-auditoria-ia"
MARCA_MAIL="# montana-auditoria-ia-email"
CRON_RUN="0 4 * * 6 cd $APP_DIR && $NODE_BIN $ORQ >> $LOG_RUN 2>&1  $MARCA_RUN"
CRON_MAIL="0 8 * * 1 cd $APP_DIR && $NODE_BIN $MAIL >> $LOG_MAIL 2>&1  $MARCA_MAIL"

# ── Desinstalar ─────────────────────────────────────────────────────
if [[ "${1:-}" == "--remover" ]]; then
  echo "→ Removendo cron da Auditoria IA..."
  crontab -l 2>/dev/null | grep -v -F "$MARCA_RUN" | grep -v -F "$MARCA_MAIL" | crontab -
  echo "  ✅ removido (execução + e-mail)"
  exit 0
fi

# ── Instalar ────────────────────────────────────────────────────────
echo "→ Instalando cron da Auditoria IA"
echo "  APP_DIR  : $APP_DIR"
echo "  NODE     : $NODE_BIN"
echo "  LOG run  : $LOG_RUN"
echo "  LOG mail : $LOG_MAIL"
echo "  Execução : sábado 04h00"
echo "  E-mail   : segunda 08h00"

# 1. log dir
if [[ ! -d "$LOG_DIR" ]]; then
  echo "  • Criando $LOG_DIR"
  sudo mkdir -p "$LOG_DIR"
  sudo chown "$USER" "$LOG_DIR"
fi

# 2. scripts existem?
for F in "$ORQ" "$MAIL"; do
  if [[ ! -f "$F" ]]; then
    echo "  ❌ $F não encontrado. Faça git pull antes." >&2
    exit 1
  fi
  chmod +x "$F"
done

# 3. verifica ANTHROPIC_API_KEY e SMTP_* no .env
if ! grep -q '^ANTHROPIC_API_KEY=' "$APP_DIR/.env" 2>/dev/null; then
  echo "  ⚠️  AVISO: ANTHROPIC_API_KEY não encontrada em $APP_DIR/.env"
  echo "     A auditoria vai falhar até a chave estar configurada."
fi
FALTA_SMTP=()
for V in SMTP_HOST SMTP_USER SMTP_PASS SMTP_TO; do
  if ! grep -qE "^${V}=.+" "$APP_DIR/.env" 2>/dev/null; then FALTA_SMTP+=("$V"); fi
done
if [[ ${#FALTA_SMTP[@]} -gt 0 ]]; then
  echo "  ⚠️  AVISO: variáveis SMTP vazias/ausentes: ${FALTA_SMTP[*]}"
  echo "     O envio de e-mail vai falhar até preencher em $APP_DIR/.env"
fi

# 4. crontab — sem duplicar
CRON_ATUAL="$(crontab -l 2>/dev/null || true)"
NOVO="$(echo "$CRON_ATUAL" | grep -v -F "$MARCA_RUN" | grep -v -F "$MARCA_MAIL")"
{
  [[ -n "$NOVO" ]] && echo "$NOVO"
  echo "$CRON_RUN"
  echo "$CRON_MAIL"
} | crontab -
echo "  • crontab atualizado (execução + e-mail)"

echo ""
echo "  ✅ Instalado."
echo "     sábado 04h00 → roda auditoria"
echo "     segunda 08h00 → envia relatório por e-mail"
echo ""
echo "Dicas:"
echo "  • Ver cron atual:   crontab -l"
echo "  • Testar auditoria: cd $APP_DIR && node $ORQ --somente=contabil_fiscal --teto-brl=1"
echo "  • Testar e-mail:    cd $APP_DIR && node $MAIL"
echo "  • Logs:             tail -f $LOG_RUN  ou  tail -f $LOG_MAIL"
echo "  • Desinstalar:      bash $0 --remover"
