#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  Montana App — Configurar Nginx + SSL
#  Execute no servidor GCP:
#    chmod +x setup-ssl.sh && sudo bash setup-ssl.sh
#
#  PRÉ-REQUISITO: DNS do domínio deve apontar para o IP do servidor
#    sistema.grupomontanasec.com → <IP_DO_SERVIDOR>
# ═══════════════════════════════════════════════════════════════════
set -e

DOMAIN="sistema.grupomontanasec.com"
APP_DIR="/opt/montana/app_unificado"
EMAIL="diretoria@grupomontanasec.com"

echo ""
echo "═══════════════════════════════════════════"
echo "  Montana — Nginx + SSL para $DOMAIN"
echo "═══════════════════════════════════════════"
echo ""

# ── 1. Verificar se Nginx está instalado ─────────────────────────
if ! command -v nginx &> /dev/null; then
    echo "▶ Instalando Nginx..."
    apt-get update -y
    apt-get install -y nginx
fi

# ── 2. Instalar Certbot ───────────────────────────────────────────
if ! command -v certbot &> /dev/null; then
    echo "▶ Instalando Certbot..."
    apt-get install -y certbot python3-certbot-nginx
fi

# ── 3. Copiar config do Nginx ─────────────────────────────────────
echo "▶ Configurando Nginx (HTTP temporário para validação SSL)..."
cat > /etc/nginx/sites-available/montana << 'NGINX_TEMP'
server {
    listen 80;
    server_name sistema.grupomontanasec.com;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { proxy_pass http://127.0.0.1:3002; }
}
NGINX_TEMP

mkdir -p /var/www/certbot
ln -sf /etc/nginx/sites-available/montana /etc/nginx/sites-enabled/montana
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
nginx -t && systemctl reload nginx

# ── 4. Obter certificado SSL gratuito ────────────────────────────
echo ""
echo "▶ Obtendo certificado SSL para $DOMAIN..."
certbot certonly --nginx \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL" \
    -d "$DOMAIN"

echo "✔ Certificado obtido!"

# ── 5. Aplicar config Nginx completa com HTTPS ───────────────────
echo "▶ Aplicando configuração Nginx com HTTPS..."
cp "$APP_DIR/scripts/nginx-montana.conf" /etc/nginx/sites-available/montana
nginx -t && systemctl reload nginx

# ── 6. Renovação automática (já configurada pelo certbot) ─────────
echo "▶ Verificando renovação automática..."
certbot renew --dry-run && echo "✔ Renovação automática OK"

# ── 7. Abrir portas 80 e 443 no firewall ─────────────────────────
echo "▶ Abrindo portas no firewall..."
ufw allow 'Nginx Full' 2>/dev/null || true
ufw delete allow 'Nginx HTTP' 2>/dev/null || true

echo ""
echo "═══════════════════════════════════════════"
echo "  ✅ HTTPS configurado!"
echo ""
echo "  Acesse: https://$DOMAIN"
echo "  Certificado renova automaticamente"
echo "═══════════════════════════════════════════"
