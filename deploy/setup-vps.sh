#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Montana ERP — Script de deploy seguro para VPS (Ubuntu 22.04+)
#
# Uso: sudo bash deploy/setup-vps.sh SEU_DOMINIO
# Exemplo: sudo bash deploy/setup-vps.sh erp.grupomontana.com.br
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="/opt/montana"
APP_USER="montana"
NODE_VERSION="22"

if [ -z "$DOMAIN" ]; then
  echo "Uso: sudo bash deploy/setup-vps.sh SEU_DOMINIO"
  echo "Exemplo: sudo bash deploy/setup-vps.sh erp.grupomontana.com.br"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Execute como root: sudo bash deploy/setup-vps.sh $DOMAIN"
  exit 1
fi

echo "═══════════════════════════════════════════════════════"
echo "  Montana ERP — Deploy Seguro"
echo "  Domínio: $DOMAIN"
echo "═══════════════════════════════════════════════════════"

# ── 1. Atualizar sistema e instalar dependências ────────────────────
echo "[1/8] Atualizando sistema..."
apt-get update -qq && apt-get upgrade -y -qq

echo "[2/8] Instalando Nginx, Certbot e build tools..."
apt-get install -y -qq nginx certbot python3-certbot-nginx \
  build-essential git curl ufw

# ── 2. Instalar Node.js ─────────────────────────────────────────────
if ! command -v node &>/dev/null || [[ ! "$(node -v)" =~ ^v${NODE_VERSION} ]]; then
  echo "[3/8] Instalando Node.js ${NODE_VERSION}..."
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y -qq nodejs
else
  echo "[3/8] Node.js $(node -v) já instalado."
fi

# ── 3. Criar usuário do sistema (sem login) ─────────────────────────
echo "[4/8] Configurando usuário do sistema..."
if ! id "$APP_USER" &>/dev/null; then
  useradd --system --create-home --home-dir "$APP_DIR" --shell /bin/false "$APP_USER"
fi

# ── 4. Copiar aplicação ─────────────────────────────────────────────
echo "[5/8] Instalando aplicação em ${APP_DIR}..."
mkdir -p "$APP_DIR"
rsync -a --exclude='node_modules' --exclude='.git' --exclude='data' \
  "$(dirname "$(dirname "$(realpath "$0")")")/" "$APP_DIR/"

# Criar diretórios com permissões corretas
mkdir -p "$APP_DIR/data"/{assessoria,portodovau,mustang,seguranca}
mkdir -p "$APP_DIR/certificados"
mkdir -p "$APP_DIR/logs"

# Instalar dependências
cd "$APP_DIR" && npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Permissões: app user é dono, certificados restritos
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
chmod 700 "$APP_DIR/certificados"
chmod 700 "$APP_DIR/data"
chmod 600 "$APP_DIR/.env" 2>/dev/null || true

# ── 5. Criar .env se não existir ────────────────────────────────────
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  # Gerar JWT_SECRET aleatório
  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
  sed -i "s/JWT_SECRET=.*/JWT_SECRET=${JWT_SECRET}/" "$APP_DIR/.env"
  sed -i "s|ALLOWED_ORIGIN=.*|ALLOWED_ORIGIN=https://${DOMAIN}|" "$APP_DIR/.env"
  chown "$APP_USER":"$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "  ⚠ ATENÇÃO: edite $APP_DIR/.env e preencha as senhas!"
fi

# ── 6. Configurar systemd ───────────────────────────────────────────
echo "[6/8] Configurando serviço systemd..."
cat > /etc/systemd/system/montana.service <<EOF
[Unit]
Description=Montana ERP
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

# Segurança: restringe acesso do processo
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}/data ${APP_DIR}/certificados ${APP_DIR}/logs ${APP_DIR}/.env
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable montana

# ── 7. Configurar Nginx como reverse proxy com HTTPS ────────────────
echo "[7/8] Configurando Nginx..."
cat > /etc/nginx/sites-available/montana <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    # Certbot vai adicionar o redirect para HTTPS automaticamente
    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;

        # Upload de certificados (max 5MB)
        client_max_body_size 5m;
    }

    # Bloquear acesso direto a arquivos sensíveis
    location ~ /\. { deny all; }
    location ~* \.(env|pfx|db|db-wal|db-shm)$ { deny all; }
}
EOF

ln -sf /etc/nginx/sites-available/montana /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ── 8. Firewall ─────────────────────────────────────────────────────
echo "[8/8] Configurando firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# ── 9. HTTPS com Let's Encrypt ──────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Setup quase completo!"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Próximos passos:"
echo ""
echo "  1. Aponte o DNS de ${DOMAIN} para o IP deste servidor"
echo ""
echo "  2. Obtenha o certificado HTTPS (após DNS propagado):"
echo "     sudo certbot --nginx -d ${DOMAIN}"
echo ""
echo "  3. Edite as credenciais:"
echo "     sudo nano ${APP_DIR}/.env"
echo ""
echo "  4. Faça upload do certificado A1 (.pfx) pela interface"
echo "     ou copie manualmente:"
echo "     sudo cp seu_cert.pfx ${APP_DIR}/certificados/assessoria.pfx"
echo "     sudo chown ${APP_USER}:${APP_USER} ${APP_DIR}/certificados/*.pfx"
echo "     sudo chmod 600 ${APP_DIR}/certificados/*.pfx"
echo ""
echo "  5. Inicie o serviço:"
echo "     sudo systemctl start montana"
echo "     sudo journalctl -u montana -f   # ver logs"
echo ""
echo "═══════════════════════════════════════════════════════"
