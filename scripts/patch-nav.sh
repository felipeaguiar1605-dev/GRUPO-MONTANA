#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  Montana App — Patch: Nova Navegação Sidebar
#  Execute no servidor GCP via Cloud Console SSH
#  Uso: bash /opt/montana/app_unificado/scripts/patch-nav.sh
# ═══════════════════════════════════════════════════════════════════

APP="/opt/montana/app_unificado"
PUB="$APP/public"

echo "🔧 Aplicando patch de navegação sidebar..."

# Backup
cp "$PUB/index.html" "$PUB/index.html.bak.$(date +%Y%m%d%H%M%S)"
cp "$PUB/styles.css" "$PUB/styles.css.bak.$(date +%Y%m%d%H%M%S)"
cp "$PUB/app.js"     "$PUB/app.js.bak.$(date +%Y%m%d%H%M%S)"
echo "✔ Backup criado"

# ─── 1. Patch index.html via Python ───────────────────────────────
python3 << 'PYEOF'
import re, sys

PUB = "/opt/montana/app_unificado/public"

with open(f"{PUB}/index.html", "r", encoding="utf-8") as f:
    lines = f.readlines()

# Find tabs block boundaries
start = end = -1
for i, l in enumerate(lines):
    if '<!-- Tabs -->' in l or ('<div class="tabs">' in l and start == -1):
        start = i
    if start >= 0 and end == -1 and '</div>' in l and i > start + 5:
        end = i
        break

if start == -1:
    print("WARN: tabs block not found — may already be patched")
    sys.exit(0)

NEW_NAV = '''<!-- Sidebar Navigation -->
<div id="app-layout">

<div id="sidenav-overlay" onclick="closeSidebar()"></div>

<nav id="sidenav">
  <div class="sidenav-header">
    <span style="font-size:15px;font-weight:800;color:#e2e8f0">⚖️ Montana</span>
    <button id="sidenav-close" onclick="closeSidebar()" title="Fechar menu">✕</button>
  </div>

  <div class="nav-group open" id="ng-inicio">
    <div class="nav-group-hdr" onclick="toggleNavGroup('ng-inicio')">
      <span class="ng-icon">📊</span><span class="ng-label">Início</span><span class="ng-chevron">▾</span>
    </div>
    <div class="nav-group-items">
      <div class="tab active" data-tab="dash" onclick="navGo('dash',this)">📊 Dashboard</div>
      <div class="tab" data-tab="consolidado" onclick="navGo('consolidado',this)">🏛️ Consolidado</div>
    </div>
  </div>

  <div class="nav-group" id="ng-financeiro">
    <div class="nav-group-hdr" onclick="toggleNavGroup('ng-financeiro')">
      <span class="ng-icon">💼</span><span class="ng-label">Financeiro</span><span class="ng-chevron">▾</span>
    </div>
    <div class="nav-group-items" style="display:none">
      <div class="tab" data-tab="ext" onclick="navGo('ext',this)">🏦 Extratos</div>
      <div class="tab" data-tab="nfs" onclick="navGo('nfs',this)">🧾 Notas Fiscais</div>
      <div class="tab" data-tab="cont" onclick="navGo('cont',this)">📋 Contratos</div>
      <div class="tab" data-tab="pag" onclick="navGo('pag',this)">💵 Pagamentos</div>
      <div class="tab" data-tab="desp" onclick="navGo('desp',this)">💸 Despesas</div>
      <div class="tab" data-tab="fluxo" onclick="navGo('fluxo',this)">📈 Fluxo de Caixa</div>
      <div class="tab" data-tab="conta-vinculada" onclick="navGo('conta-vinculada',this)">🏦 Conta Vinculada</div>
      <div class="tab" data-tab="conciliacao3v" onclick="navGo('conciliacao3v',this)">🔗 Conciliação 3V</div>
      <div class="tab" data-tab="import" onclick="navGo('import',this)">📥 Importar</div>
    </div>
  </div>

  <div class="nav-group" id="ng-fiscal">
    <div class="nav-group-hdr" onclick="toggleNavGroup('ng-fiscal')">
      <span class="ng-icon">📑</span><span class="ng-label">Fiscal / Legal</span><span class="ng-chevron">▾</span>
    </div>
    <div class="nav-group-items" style="display:none">
      <div class="tab" data-tab="pref" onclick="navGo('pref',this)">🏛️ Prefeitura / NFS-e</div>
      <div class="tab" data-tab="certidoes" onclick="navGo('certidoes',this)">📋 Certidões</div>
      <div class="tab" data-tab="licitacoes" onclick="navGo('licitacoes',this)">🏛️ Licitações</div>
      <div class="tab" data-tab="retencoes" onclick="navGo('retencoes',this)">🏛️ Retenções</div>
      <div class="tab" data-tab="reajuste" onclick="navGo('reajuste',this)">📈 Reajuste</div>
      <div class="tab" data-tab="boletins" onclick="navGo('boletins',this)">📄 Boletins</div>
    </div>
  </div>

  <div class="nav-group" id="ng-pessoas">
    <div class="nav-group-hdr" onclick="toggleNavGroup('ng-pessoas')">
      <span class="ng-icon">👥</span><span class="ng-label">Pessoas</span><span class="ng-chevron">▾</span>
    </div>
    <div class="nav-group-items" style="display:none">
      <div class="tab" data-tab="rh" onclick="navGo('rh',this)">👥 RH / DP</div>
      <div class="tab" data-tab="ponto" onclick="navGo('ponto',this)">🕐 Ponto</div>
      <div class="tab" id="tab-usuarios" data-tab="usuarios" onclick="navGo('usuarios',this)" style="display:none">👥 Usuários</div>
    </div>
  </div>

  <div class="nav-group" id="ng-analise">
    <div class="nav-group-hdr" onclick="toggleNavGroup('ng-analise')">
      <span class="ng-icon">📈</span><span class="ng-label">Análise</span><span class="ng-chevron">▾</span>
    </div>
    <div class="nav-group-items" style="display:none">
      <div class="tab" data-tab="dre" onclick="navGo('dre',this)">📊 DRE</div>
      <div class="tab" data-tab="margem" onclick="navGo('margem',this)">💰 Margem</div>
      <div class="tab" data-tab="relat" onclick="navGo('relat',this)">📄 Relatórios</div>
      <div class="tab" data-tab="calculadora" onclick="navGo('calculadora',this)">🧮 Calculadora</div>
    </div>
  </div>

  <div class="nav-group" id="ng-sistema">
    <div class="nav-group-hdr" onclick="toggleNavGroup('ng-sistema')">
      <span class="ng-icon">⚙️</span><span class="ng-label">Sistema</span><span class="ng-chevron">▾</span>
    </div>
    <div class="nav-group-items" style="display:none">
      <div class="tab" data-tab="estoque" onclick="navGo('estoque',this)">📦 Estoque</div>
      <div class="tab" data-tab="keywords" onclick="navGo('keywords',this)">⚙️ Keywords</div>
      <div class="tab" data-tab="auditoria" onclick="navGo('auditoria',this)">🔍 Auditoria</div>
      <div class="tab" id="tab-config" data-tab="config" onclick="navGo('config',this)">⚙️ Config</div>
    </div>
  </div>
</nav>

<div id="main-content">
'''

# Add hamburger to hdr
new_lines = []
for i, l in enumerate(lines):
    if '<div class="hdr">' in l and '#hamburger-btn' not in ''.join(lines[i:i+3]):
        l = l.replace('<div class="hdr">', '<div class="hdr">\n  <button id="hamburger-btn" onclick="openSidebar()" title="Menu">☰</button>')
    new_lines.append(l)
lines = new_lines

# Replace tabs block
lines = lines[:start] + [NEW_NAV + '\n'] + lines[end+1:]

# Insert closing divs before scripts
for i, l in enumerate(lines):
    if '<script src="/app.js"></script>' in l:
        lines.insert(i, '\n</div><!-- /#main-content -->\n</div><!-- /#app-layout -->\n\n')
        break

# Fix showTab calls in index.html
content = ''.join(lines)
content = content.replace(
    "showTab('ext',document.querySelector('[data-tab=ext]'))",
    "navGo('ext',document.querySelector('[data-tab=ext]'))"
)
content = content.replace(
    "showTab('ponto',document.querySelector('[data-tab=ponto]'))",
    "navGo('ponto',document.querySelector('[data-tab=ponto]'))"
)

with open(f"{PUB}/index.html", "w", encoding="utf-8") as f:
    f.write(content)

print(f"✔ index.html patched ({len(content.splitlines())} linhas)")
PYEOF

# ─── 2. Patch styles.css — append sidebar CSS ─────────────────────
# Check if already patched
if grep -q "SIDEBAR NAVIGATION" "$PUB/styles.css"; then
  echo "✔ styles.css já tem o CSS de sidebar"
else
cat >> "$PUB/styles.css" << 'CSS_EOF'

/* ═══════════════════════════════════════════════════════
   SIDEBAR NAVIGATION
   ═══════════════════════════════════════════════════════ */
#hamburger-btn{display:none;background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.3);color:#fff;font-size:20px;width:38px;height:38px;border-radius:8px;cursor:pointer;align-items:center;justify-content:center;flex-shrink:0;margin-right:4px}
#app-layout{display:flex;min-height:calc(100vh - 160px)}
#sidenav{width:220px;flex-shrink:0;background:#1e293b;display:flex;flex-direction:column;overflow-y:auto;border-right:1px solid #334155;position:sticky;top:0;height:100vh}
.sidenav-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 12px;border-bottom:1px solid #334155}
#sidenav-close{display:none;background:none;border:none;color:#94a3b8;font-size:16px;cursor:pointer;padding:2px 6px;border-radius:4px}
#sidenav-close:hover{background:#334155;color:#e2e8f0}
.nav-group{border-bottom:1px solid #253347}
.nav-group-hdr{display:flex;align-items:center;gap:8px;padding:10px 14px;cursor:pointer;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;transition:.15s;user-select:none}
.nav-group-hdr:hover{background:#253347;color:#cbd5e1}
.nav-group.open .nav-group-hdr{color:#60a5fa}
.ng-icon{font-size:14px}.ng-label{flex:1}
.ng-chevron{font-size:9px;transition:transform .2s}
.nav-group.open .ng-chevron{transform:rotate(0deg)}
.nav-group:not(.open) .ng-chevron{transform:rotate(-90deg)}
.nav-group-items .tab{display:block;padding:8px 14px 8px 36px;font-size:12px;font-weight:500;color:#94a3b8;cursor:pointer;transition:.1s;border-bottom:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:0;margin-bottom:0}
.nav-group-items .tab:hover{background:#253347;color:#e2e8f0}
.nav-group-items .tab.active{background:#1d3a5f;color:#60a5fa;border-left:3px solid #3b82f6;padding-left:33px;font-weight:700}
#main-content{flex:1;min-width:0;overflow-x:hidden}
#sidenav-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999;backdrop-filter:blur(2px)}
@media(max-width:768px){
  #hamburger-btn{display:flex}
  #sidenav{position:fixed;left:-240px;top:0;bottom:0;width:240px;z-index:1000;transition:left .25s cubic-bezier(.4,0,.2,1);height:100vh;box-shadow:4px 0 20px rgba(0,0,0,.4)}
  #sidenav.open{left:0}
  #sidenav-overlay.visible{display:block}
  #sidenav-close{display:block}
  #app-layout{display:block}
  #main-content{padding-bottom:60px}
  .hdr h1{font-size:15px}.hdr p{display:none}.hdr-stats{display:none !important}
}
@media(min-width:769px){
  #hamburger-btn{display:none !important}
  #sidenav-close{display:none !important}
  #sidenav-overlay{display:none !important}
}
CSS_EOF
  echo "✔ styles.css atualizado"
fi

# ─── 3. Patch app.js — add sidebar functions ──────────────────────
if grep -q "function openSidebar" "$PUB/app.js"; then
  echo "✔ app.js já tem funções de sidebar"
else
python3 << 'PYEOF'
PUB = "/opt/montana/app_unificado/public"
with open(f"{PUB}/app.js", "r", encoding="utf-8") as f:
    content = f.read()

OLD = "// ─── Tabs ────────────────────────────────────────────────────────\nfunction showTab(id,el){"
NEW_FUNCS = """// ─── Sidebar Navigation ───────────────────────────────────────────
function openSidebar(){
  document.getElementById('sidenav').classList.add('open');
  document.getElementById('sidenav-overlay').classList.add('visible');
}
function closeSidebar(){
  document.getElementById('sidenav').classList.remove('open');
  document.getElementById('sidenav-overlay').classList.remove('visible');
}
function toggleNavGroup(id){
  const g=document.getElementById(id);
  const items=g.querySelector('.nav-group-items');
  const isOpen=g.classList.contains('open');
  if(isOpen){g.classList.remove('open');items.style.display='none';}
  else{g.classList.add('open');items.style.display='block';}
}
function navGo(id,el){
  if(window.innerWidth<=768) closeSidebar();
  if(el){const grp=el.closest('.nav-group');if(grp&&!grp.classList.contains('open')){grp.classList.add('open');grp.querySelector('.nav-group-items').style.display='block';}}
  showTab(id,el);
}

// ─── Tabs ────────────────────────────────────────────────────────
function showTab(id,el){"""

if OLD in content:
    content = content.replace(OLD, NEW_FUNCS)
    # Also patch showTab to auto-expand group
    OLD2 = "  if(el) el.classList.add('active');\n  // Load data on tab switch"
    NEW2 = """  if(!el) el=document.querySelector(`.nav-group-items .tab[data-tab="${id}"]`);
  if(el) el.classList.add('active');
  if(el){const grp=el.closest('.nav-group');if(grp&&!grp.classList.contains('open')){grp.classList.add('open');const it=grp.querySelector('.nav-group-items');if(it)it.style.display='block';}}
  // Load data on tab switch"""
    content = content.replace(OLD2, NEW2)
    with open(f"{PUB}/app.js", "w", encoding="utf-8") as f:
        f.write(content)
    print("✔ app.js atualizado")
else:
    print("WARN: app.js padrão não encontrado — pode já estar patched")
PYEOF
fi

# ─── 4. Reinicia PM2 ──────────────────────────────────────────────
echo ""
echo "🚀 Reiniciando servidor..."
pm2 restart montana-app
echo ""
echo "═══════════════════════════════════════════"
echo " ✅ Patch aplicado com sucesso!"
echo "    Acesse: http://localhost:3002"
echo "═══════════════════════════════════════════"
