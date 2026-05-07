#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  Montana — Recon read-only da VM de produção
#
#  Uso (na VM):
#    ssh diretoria@35.235.241.162
#    bash <(curl -fsSL https://raw.githubusercontent.com/.../recon-vm.sh)
#
#  Ou se já clonou o repo:
#    bash /opt/montana/app_unificado/scripts/recon-vm.sh > /tmp/recon.txt
#
#  Cole o conteúdo de /tmp/recon.txt no chat para análise.
#  NÃO altera nada — apenas lê e reporta.
# ═══════════════════════════════════════════════════════════════════

set -u  # falha se var não definida; sem -e pra continuar mesmo se uma seção falhar

REPO_ROOT=${MONTANA_REPO:-/opt/montana/app_unificado}
INTEL_DIR=${MONTANA_INTEL:-$REPO_ROOT/montana_intelligence}
MCP_DIR=${MONTANA_MCP:-/opt/montana/mcp-server}
DATA_DIR=${MONTANA_DATA:-$REPO_ROOT/data}
LOGS_DIR=${MONTANA_LOGS:-/opt/montana/logs}

ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

section() { printf '\n══════════════════════════════════════════════════════════════════\n  %s\n══════════════════════════════════════════════════════════════════\n' "$1"; }
sub()     { printf '\n── %s ──\n' "$1"; }
run()     { printf '$ %s\n' "$*"; "$@" 2>&1 | sed 's/^/  /'; }

section "MONTANA VM RECON — $ts"
sub "Host"
run hostname
run uname -a
run uptime
run id
run pwd

section "CODE — file hashes (compare with local)"
for f in \
  "$REPO_ROOT/package.json" \
  "$REPO_ROOT/ecosystem.config.js" \
  "$REPO_ROOT/.env.example" \
  "$REPO_ROOT/Dockerfile" \
  "$REPO_ROOT/docker-compose.yml" \
  "$REPO_ROOT/src/server.js" \
  "$REPO_ROOT/src/routes/webiss.js" \
  "$INTEL_DIR/server.py" \
  "$INTEL_DIR/etl.py" \
  "$INTEL_DIR/setup_gcp.sh" \
  "$INTEL_DIR/requirements.txt" \
  "$MCP_DIR/mcp_server.py" \
  "$MCP_DIR/ecosystem.config.js" \
  "$MCP_DIR/requirements.txt" \
  "$REPO_ROOT/scripts/setup-ssl.sh" \
  "$REPO_ROOT/scripts/patch-nav.sh"
do
  if [ -f "$f" ]; then
    h=$(sha256sum "$f" 2>/dev/null | awk '{print $1}')
    sz=$(stat -c%s "$f" 2>/dev/null)
    mt=$(stat -c%y "$f" 2>/dev/null | cut -d. -f1)
    printf '  %s  %10s  %s  %s\n' "${h:0:12}" "$sz" "$mt" "$f"
  else
    printf '  %-12s  %10s  %-19s  %s  (MISSING)\n' "------------" "-" "-" "$f"
  fi
done

section "CODE — git status of repos"
for d in "$REPO_ROOT" "$MCP_DIR"; do
  sub "git in $d"
  if [ -d "$d/.git" ]; then
    (cd "$d" && \
      run git remote -v && \
      run git branch --show-current && \
      run git log --oneline -5 && \
      run git status --short && \
      run git rev-parse HEAD)
  else
    printf '  not a git repo (or .git missing)\n'
  fi
done

section "CODE — listing of key dirs"
for d in "$REPO_ROOT" "$MCP_DIR" "$INTEL_DIR" "$REPO_ROOT/src" "$REPO_ROOT/src/routes" "$REPO_ROOT/scripts"; do
  sub "$d"
  if [ -d "$d" ]; then
    ls -la "$d" 2>&1 | sed 's/^/  /'
  else
    echo "  (missing)"
  fi
done

section "RUNTIME — processes & ports"
sub "pm2 list (as current user)"
run pm2 list
sub "pm2 list (sudo, in case montana runs as root)"
run sudo -n pm2 list
sub "ports listening (3002, 3010, 8001, 80, 443)"
run ss -tlnp 2>/dev/null
sub "node/python processes"
ps -eo pid,user,etime,cmd 2>/dev/null | grep -E 'node|python' | grep -v grep | sed 's/^/  /'

section "RUNTIME — reverse proxy"
sub "caddy"
run systemctl is-active caddy
run caddy version
if [ -f /etc/caddy/Caddyfile ]; then
  run cat /etc/caddy/Caddyfile
else
  echo "  no /etc/caddy/Caddyfile"
fi
sub "nginx"
run systemctl is-active nginx
run nginx -v
if [ -d /etc/nginx/sites-enabled ]; then
  run ls -la /etc/nginx/sites-enabled/
fi

section "RUNTIME — cron jobs"
sub "crontab user"
run crontab -l
sub "crontab root (sudo)"
run sudo -n crontab -l -u root
sub "/etc/cron.d/"
run ls -la /etc/cron.d/

section "RUNTIME — firewall (best effort, may need sudo)"
sub "ufw"
run sudo -n ufw status
sub "iptables (head)"
run sudo -n iptables -L -n --line-numbers
sub "GCP firewall rules (if gcloud available)"
run which gcloud
run gcloud compute firewall-rules list --format="table(name,direction,sourceRanges.list():label=SRC_RANGES,allowed[].map().firewall_rule().list():label=ALLOW,targetTags.list():label=TARGET_TAGS)" 2>&1 | head -50

section "CONFIG — versions"
run node --version
run npm --version
run python3 --version
run pip3 --version
run pm2 --version
sub "python packages relevantes"
pip3 list 2>/dev/null | grep -iE 'mcp|fastapi|uvicorn|sqlglot|starlette' | sed 's/^/  /'

section "CONFIG — env file KEYS only (no values)"
for envf in "$REPO_ROOT/.env" "$INTEL_DIR/.env" "$MCP_DIR/.env"; do
  sub "$envf"
  if [ -f "$envf" ]; then
    awk -F= 'NF && $1 !~ /^[[:space:]]*#/ {print "  " $1}' "$envf" 2>/dev/null
    printf '  (total lines: %s)\n' "$(wc -l < "$envf" 2>/dev/null)"
  else
    echo "  (missing)"
  fi
done

section "CONFIG — ecosystem files"
for ef in "$REPO_ROOT/ecosystem.config.js" "$MCP_DIR/ecosystem.config.js" "$INTEL_DIR/ecosystem_intelligence.config.js"; do
  sub "$ef"
  if [ -f "$ef" ]; then
    cat "$ef" 2>/dev/null | sed 's/^/  /'
  else
    echo "  (missing)"
  fi
done

section "DATABASE — sqlite stats per empresa"
if [ -d "$DATA_DIR" ]; then
  for emp_dir in "$DATA_DIR"/*/; do
    emp=$(basename "$emp_dir")
    db="$emp_dir/montana.db"
    sub "$emp"
    if [ -f "$db" ]; then
      sz=$(stat -c%s "$db")
      printf '  path: %s\n  size: %s bytes\n' "$db" "$sz"
      printf '  tables:\n'
      sqlite3 "$db" ".tables" 2>&1 | tr -s ' ' '\n' | grep -v '^$' | sed 's/^/    /'
      printf '  row counts:\n'
      sqlite3 "$db" "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name" 2>/dev/null | while read t; do
        c=$(sqlite3 "$db" "SELECT COUNT(*) FROM \"$t\"" 2>/dev/null)
        printf '    %-30s %s\n' "$t" "$c"
      done
    else
      echo "  (no montana.db)"
    fi
  done
else
  echo "  $DATA_DIR não existe"
fi
sub "knowledge_base.db"
kb="$INTEL_DIR/knowledge_base.db"
if [ -f "$kb" ]; then
  printf '  size: %s bytes\n  mtime: %s\n' "$(stat -c%s "$kb")" "$(stat -c%y "$kb" | cut -d. -f1)"
  sqlite3 "$kb" ".tables" 2>&1 | sed 's/^/  /'
  sqlite3 "$kb" "SELECT name FROM sqlite_master WHERE type='table'" 2>/dev/null | while read t; do
    c=$(sqlite3 "$kb" "SELECT COUNT(*) FROM \"$t\"" 2>/dev/null)
    printf '    %-30s %s\n' "$t" "$c"
  done
else
  echo "  (missing)"
fi

section "DATABASE — schema completo (1 empresa de referência)"
ref_db="$DATA_DIR/assessoria/montana.db"
if [ -f "$ref_db" ]; then
  sqlite3 "$ref_db" ".schema" 2>&1 | sed 's/^/  /' | head -200
else
  echo "  $ref_db missing — tentando seguranca..."
  ref_db="$DATA_DIR/seguranca/montana.db"
  [ -f "$ref_db" ] && sqlite3 "$ref_db" ".schema" 2>&1 | sed 's/^/  /' | head -200
fi

section "LOGS — últimos erros (best effort)"
sub "pm2 logs (últimas 20 linhas de cada app)"
run pm2 logs --lines 20 --nostream
sub "audit log MCP (se existe)"
if [ -f "$LOGS_DIR/mcp_audit.jsonl" ]; then
  printf '  size: %s bytes\n' "$(stat -c%s "$LOGS_DIR/mcp_audit.jsonl")"
  printf '  últimas 10 linhas:\n'
  tail -10 "$LOGS_DIR/mcp_audit.jsonl" | sed 's/^/    /'
else
  echo "  (não existe)"
fi

section "FIM — $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo ""
echo "Cole TODO o conteúdo acima no chat para análise comparativa."
echo "Nada foi modificado."
