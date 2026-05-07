#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  Montana Intelligence — Setup no Servidor GCP
#  Execute UMA VEZ no servidor após o deploy do código
#
#  ssh diretoria@104.196.22.170
#  cd /opt/montana/app_unificado/montana_intelligence
#  chmod +x setup_gcp.sh && ./setup_gcp.sh
# ═══════════════════════════════════════════════════════════════

set -e
VERDE='\033[0;32m'
AMARELO='\033[1;33m'
NC='\033[0m'

echo ""
echo "═══════════════════════════════════════════════"
echo "  Montana Intelligence — Setup GCP"
echo "═══════════════════════════════════════════════"
echo ""

# 1. Dependências Python
echo -e "${AMARELO}[1/5] Instalando dependências Python...${NC}"
pip3 install fastapi uvicorn pydantic --break-system-packages -q
echo -e "${VERDE}      ✅ Dependências instaladas${NC}"

# 2. Gera token seguro
TOKEN=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
echo ""
echo -e "${AMARELO}[2/5] Token de autenticação gerado:${NC}"
echo -e "      ${VERDE}${TOKEN}${NC}"
echo "      ⚠️  Guarde este token — você precisará dele no Claude Desktop"
echo ""

# Salva em arquivo de configuração
cat > /opt/montana/app_unificado/montana_intelligence/.env << EOF
MONTANA_TOKEN=${TOKEN}
MONTANA_PORT=8001
EOF
echo -e "${VERDE}      ✅ Token salvo em .env${NC}"

# 3. Primeira indexação (ETL)
echo ""
echo -e "${AMARELO}[3/5] Gerando base de conhecimento (ETL)...${NC}"
cd /opt/montana/app_unificado
python3 montana_intelligence/etl.py
echo -e "${VERDE}      ✅ Knowledge base criada${NC}"

# 4. Configura PM2 para o servidor MCP
echo ""
echo -e "${AMARELO}[4/5] Configurando PM2...${NC}"

cat > /opt/montana/app_unificado/montana_intelligence/ecosystem_intelligence.config.js << 'EOF'
module.exports = {
  apps: [
    {
      name: 'montana-intelligence',
      script: '/opt/montana/app_unificado/montana_intelligence/server.py',
      interpreter: 'python3',
      args: '--port 8001',
      env: {
        MONTANA_TOKEN: process.env.MONTANA_TOKEN || 'montana2026',
      },
      watch: false,
      autorestart: true,
      max_memory_restart: '200M',
    }
  ]
};
EOF

# Carrega token no ambiente e inicia
export MONTANA_TOKEN="${TOKEN}"
pm2 start /opt/montana/app_unificado/montana_intelligence/ecosystem_intelligence.config.js
pm2 save
echo -e "${VERDE}      ✅ Servidor MCP iniciado na porta 8001${NC}"

# 5. Cron job para ETL diário (meia-noite)
echo ""
echo -e "${AMARELO}[5/5] Configurando ETL automático (meia-noite)...${NC}"
CRON_CMD="0 0 * * * cd /opt/montana/app_unificado && python3 montana_intelligence/etl.py >> /opt/montana/logs/etl.log 2>&1"
(crontab -l 2>/dev/null | grep -v "etl.py"; echo "$CRON_CMD") | crontab -
mkdir -p /opt/montana/logs
echo -e "${VERDE}      ✅ Cron configurado${NC}"

# Teste final
echo ""
echo "═══════════════════════════════════════════════"
echo -e "${VERDE}  ✅ Setup concluído!${NC}"
echo ""
echo "  Servidor rodando em: http://104.196.22.170:8001"
echo "  Teste agora:"
echo "    curl http://104.196.22.170:8001/saude"
echo ""
echo "  Próximo passo — adicionar ao Claude Desktop:"
echo "  Arquivo: %APPDATA%\Claude\claude_desktop_config.json"
echo ""
cat << JSONEOF
  {
    "mcpServers": {
      "montana": {
        "command": "python3",
        "args": ["/opt/montana/app_unificado/montana_intelligence/server.py", "--stdio"],
        "env": {
          "MONTANA_TOKEN": "${TOKEN}"
        }
      }
    }
  }
JSONEOF
echo ""
echo "═══════════════════════════════════════════════"
