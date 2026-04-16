#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  Montana MCP — Configurar proxy HTTPS + autenticação
#  Execute no servidor GCP:
#    chmod +x scripts/setup-mcp-auth.sh && sudo bash scripts/setup-mcp-auth.sh
#
#  Resultado:
#    ANTES:  http://104.196.22.170:3010/sse  (aberto, sem senha)
#    DEPOIS: https://sistema.grupomontanasec.com/mcp/sse (com senha)
# ═══════════════════════════════════════════════════════════════════
set -e

APP_DIR="/opt/montana/app_unificado"

echo ""
echo "═══════════════════════════════════════════"
echo "  Montana MCP — Setup HTTPS + Auth"
echo "═══════════════════════════════════════════"
echo ""

# ── 1. Instalar apache2-utils (htpasswd) ─────────────────────────
if ! command -v htpasswd &> /dev/null; then
    echo "▶ Instalando htpasswd..."
    apt-get update -y && apt-get install -y apache2-utils
fi

# ── 2. Criar senha para o usuário "diretoria" ────────────────────
echo "▶ Criando credencial de acesso..."
echo ""
echo "  Defina a SENHA para acessar o MCP Server."
echo "  Usuário: diretoria"
echo ""
htpasswd -c /etc/nginx/.htpasswd-mcp diretoria
echo ""
echo "✔ Credencial criada"

# ── 3. Aplicar config Nginx com proxy MCP ─────────────────────────
echo "▶ Atualizando Nginx..."
cp "$APP_DIR/scripts/nginx-montana.conf" /etc/nginx/sites-available/montana

nginx -t
if [ $? -ne 0 ]; then
    echo "✖ Erro na configuração do Nginx. Verifique o arquivo."
    exit 1
fi

systemctl reload nginx
echo "✔ Nginx recarregado com proxy MCP"

# ── 4. Restringir MCP server ao localhost (não expor porta 3010) ──
echo "▶ Verificando se MCP escuta apenas em localhost..."
echo ""
echo "  IMPORTANTE: O MCP server deve escutar em 127.0.0.1:3010"
echo "  (não em 0.0.0.0:3010) para bloquear acesso direto."
echo ""
echo "  Se o mcp_server.py usa host='0.0.0.0', mude para host='127.0.0.1'"
echo ""

# ── 5. Testar ────────────────────────────────────────────────────
echo "▶ Testando endpoint..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" https://sistema.grupomontanasec.com/mcp/sse -m 5 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "401" ]; then
    echo "✔ Endpoint protegido (retornou 401 — pede senha)"
elif [ "$HTTP_CODE" = "200" ]; then
    echo "⚠ Endpoint respondeu 200 sem pedir senha — verificar config"
else
    echo "⚠ Código HTTP: $HTTP_CODE — verificar se SSL e Nginx estão OK"
fi

echo ""
echo "═══════════════════════════════════════════"
echo "  ✅ Setup concluído!"
echo ""
echo "  URL do MCP:  https://sistema.grupomontanasec.com/mcp/sse"
echo "  Usuário:     diretoria"
echo ""
echo "  No seu PC, reconfigure o Claude Code:"
echo "    claude mcp remove montana-cloud"
echo "    claude mcp add montana-cloud --transport sse https://diretoria:SUA_SENHA@sistema.grupomontanasec.com/mcp/sse"
echo "═══════════════════════════════════════════"
