#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  Montana App — Setup inicial do servidor GCP
#  Instância: montana-app  |  Zona: us-east1-b
#  Projeto:   propane-highway-492418-d0
#  IP:        104.196.22.170
#  Domínio:   sistema.grupomontanasec.com
#
#  Execute UMA VEZ após criar a VM:
#    chmod +x setup-gcp.sh && sudo bash setup-gcp.sh
# ═══════════════════════════════════════════════════════════════════
set -e

echo ""
echo "═══════════════════════════════════════════"
echo "  Montana App — Setup do Servidor GCP"
echo "═══════════════════════════════════════════"
echo ""

# ── 1. Atualizar sistema ──────────────────────────────────────────
echo "▶ Atualizando sistema..."
apt-get update -y && apt-get upgrade -y

# ── 2. Instalar Node.js 20 LTS ────────────────────────────────────
echo "▶ Instalando Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs build-essential

echo "  Node: $(node -v)  NPM: $(npm -v)"

# ── 3. Instalar PM2 globalmente ───────────────────────────────────
echo "▶ Instalando PM2..."
npm install -g pm2

# ── 4. Instalar Nginx ─────────────────────────────────────────────
echo "▶ Instalando Nginx..."
apt-get install -y nginx

# ── 5. Instalar Certbot (SSL gratuito) ────────────────────────────
echo "▶ Instalando Certbot..."
apt-get install -y certbot python3-certbot-nginx

# ── 6. Criar estrutura de diretórios ─────────────────────────────
echo "▶ Criando diretórios..."
mkdir -p /opt/montana/app_unificado
mkdir -p /opt/montana/logs
mkdir -p /opt/montana/backups
chown -R $SUDO_USER:$SUDO_USER /opt/montana 2>/dev/null || true

# ── 7. Configurar Nginx ───────────────────────────────────────────
echo "▶ Configurando Nginx..."
cat > /etc/nginx/sites-available/montana << 'NGINX'
server {
    listen 80;
    server_name sistema.grupomontanasec.com;

    # Logs
    access_log /var/log/nginx/montana-access.log;
    error_log  /var/log/nginx/montana-error.log;

    # Aumentar timeout para exports grandes
    proxy_read_timeout    300s;
    proxy_connect_timeout 60s;
    proxy_send_timeout    300s;

    # Aumentar tamanho máximo de upload (importação Excel)
    client_max_body_size 20M;

    location / {
        proxy_pass         http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/montana /etc/nginx/sites-enabled/montana
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ── 8. Configurar firewall ────────────────────────────────────────
echo "▶ Configurando firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# ── 9. Criar script de backup automático ─────────────────────────
echo "▶ Configurando backup automático..."
cat > /opt/montana/backup.sh << 'BACKUP'
#!/bin/bash
# Backup diário dos bancos de dados Montana
DATE=$(date +%Y-%m-%d_%H-%M)
BACKUP_DIR="/opt/montana/backups"
APP_DIR="/opt/montana/app_unificado"

# Cria backup de cada banco
for db in assessoria seguranca porto_do_vau mustang; do
  DB_FILE="$APP_DIR/data/$db/montana.db"
  if [ -f "$DB_FILE" ]; then
    # Usa sqlite3 .backup para backup consistente (não corrompe com WAL)
    sqlite3 "$DB_FILE" ".backup '$BACKUP_DIR/montana_${db}_${DATE}.db'"
    echo "✔ Backup $db: $DATE"
  fi
done

# Remove backups com mais de 30 dias
find "$BACKUP_DIR" -name "*.db" -mtime +30 -delete
echo "✔ Limpeza de backups antigos concluída"
BACKUP

chmod +x /opt/montana/backup.sh

# Agendamento: backup todo dia às 03:00
(crontab -l 2>/dev/null; echo "0 3 * * * /opt/montana/backup.sh >> /opt/montana/logs/backup.log 2>&1") | crontab -

echo ""
echo "═══════════════════════════════════════════"
echo "  ✅ Setup concluído!"
echo ""
echo "  Próximos passos:"
echo "  1. Envie o código:  bash deploy.sh"
echo "  2. Inicie o app:    cd /opt/montana/app_unificado && npm install && pm2 start ecosystem.config.js"
echo "  3. Configure PM2:   pm2 save && pm2 startup"
echo "  4. SSL (opcional):  bash /opt/montana/app_unificado/scripts/setup-ssl.sh"
echo "═══════════════════════════════════════════"
