// ─── Multi-Empresa ───────────────────────────────────────────────
const COMPANIES_META = {
  assessoria: { nome:'MONTANA ASSESSORIA EMPRESARIAL LTDA',    cnpj:'14.092.519/0001-51', cor:'#0d6efd', icone:'🏢', titulo:'Montana Assessoria — Conciliação v3' },
  seguranca:  { nome:'MONTANA SEGURANÇA LTDA',                 cnpj:'19.200.109/0001-09', cor:'#dc3545', icone:'🔒', titulo:'Montana Segurança — Conciliação v3' },
  portodovau: { nome:'PORTO DO VAU SEGURANÇA PRIVADA LTDA',    cnpj:'41.034.574/0001-68', cor:'#7c3aed', icone:'🛡️', titulo:'Porto do Vau — Conciliação v3' },
  mustang:    { nome:'MUSTANG GESTÃO EMPRESARIAL LTDA',        cnpj:'26.600.137/0001-70', cor:'#d97706', icone:'🐎', titulo:'Mustang — Conciliação v3' },
};

let currentCompany = localStorage.getItem('montana_company') || 'assessoria';

function switchCompany(key) {
  currentCompany = key;
  localStorage.setItem('montana_company', key);
  _contratos = []; // forçar reload dos contratos ao trocar empresa
  _extMes = ''; _extMesManual = false; _extMesesDisponiveis = []; _extPage = 1; // resetar filtro mês ao trocar empresa
  applyCompanyTheme();
  loadDashboard();
}

function applyCompanyTheme() {
  const m = COMPANIES_META[currentCompany];
  // Banner
  document.getElementById('company-banner').style.background = m.cor;
  document.getElementById('cb-icone').textContent = m.icone;
  document.getElementById('cb-nome').textContent = m.nome + ' — CNPJ ' + m.cnpj;
  // Botões de seleção: ativo vs inativo (4 empresas)
  ['assessoria','seguranca','portodovau','mustang'].forEach(key => {
    const btn = document.getElementById('btn-' + key);
    if (!btn) return;
    if (key === currentCompany) {
      btn.style.background = 'rgba(255,255,255,.35)'; btn.style.color = '#fff'; btn.style.borderColor = 'rgba(255,255,255,.5)';
    } else {
      btn.style.background = 'rgba(255,255,255,.12)'; btn.style.color = 'rgba(255,255,255,.65)'; btn.style.borderColor = 'rgba(255,255,255,.3)';
    }
  });
  // Título
  document.getElementById('hdr-title').textContent = m.titulo;
  document.title = m.titulo;
}

// ─── State ───────────────────────────────────────────────────────
let _from='', _to='';
let _contratos=[];
let _contratosEmpresa='';
let _vinculacoes={};
let _extPage=1, _pagPage=1, _nfsPage=1;
let _extMes='';
let _extMesManual=false; // true quando o usuário clicou manualmente num mês (inclusive "Todos")
const PAGE_SIZE=100;

// ─── Helpers ─────────────────────────────────────────────────────
function brl(v){
  if(v===null||v===undefined) return '—';
  const s=Math.abs(v).toFixed(2).replace('.',',').replace(/\B(?=(\d{3})+(?!\d))/g,'.');
  return (v>=0?'R$ ':'−R$ ')+s;
}

function badge(text,type){
  return `<span class="badge badge-${type}">${text}</span>`;
}

function shortBrl(v){
  if(v>=1000000)return(v/1000000).toFixed(1)+'M';
  if(v>=1000)return(v/1000).toFixed(0)+'k';
  return v.toFixed(0);
}

function toast(msg,type='success'){
  const t=document.getElementById('toast');
  t.textContent=msg;
  t.className='toast show '+type;
  const dur = type==='error' ? 6000 : 3000;
  setTimeout(()=>t.className='toast',dur);
}

// ─── Loading overlay ─────────────────────────────────────────────
let _loadingCount=0;
function showLoading(msg){
  _loadingCount++;
  const el=document.getElementById('loading-overlay');
  if(el){ el.style.display='flex'; const m=el.querySelector('.loading-msg'); if(m&&msg)m.textContent=msg; }
}
function hideLoading(){
  _loadingCount=Math.max(0,_loadingCount-1);
  if(_loadingCount===0){const el=document.getElementById('loading-overlay'); if(el) el.style.display='none';}
}

async function api(url,opts){
  const headers={'X-Company':currentCompany};
  const token=localStorage.getItem('montana_token');
  if(token) headers['Authorization']='Bearer '+token;
  if(opts&&opts.body&&typeof opts.body==='string') headers['Content-Type']='application/json';
  if(opts&&opts.headers) Object.assign(headers,opts.headers);
  const r=await fetch('/api'+url,{...opts,headers});
  if(r.status===401){const d=await r.json().catch(()=>({}));if(typeof clearToken==='function')clearToken();if(typeof showLoginModal==='function')showLoginModal(d.code==='TOKEN_EXPIRED'?'Sessão expirada.':'Autenticação necessária.');throw new Error('Unauthorized');}
  return r.json();
}

// api com loading indicator para operações longas
async function apiLoading(url,opts,msg){
  showLoading(msg||'Carregando…');
  try{ return await api(url,opts); } finally{ hideLoading(); }
}

// ─── Sidebar Navigation ───────────────────────────────────────────
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
  if(isOpen){
    g.classList.remove('open');
    items.style.display='none';
  } else {
    g.classList.add('open');
    items.style.display='block';
  }
}
// navGo: opens correct group, marks item active, closes sidebar on mobile
function navGo(id,el){
  // Close sidebar on mobile
  if(window.innerWidth<=768) closeSidebar();
  // Expand parent group if collapsed
  if(el){
    const grp=el.closest('.nav-group');
    if(grp && !grp.classList.contains('open')){
      grp.classList.add('open');
      grp.querySelector('.nav-group-items').style.display='block';
    }
  }
  showTab(id,el);
}

// ─── Tabs ────────────────────────────────────────────────────────
function showTab(id,el){
  document.querySelectorAll('.pg').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('pg-'+id).classList.add('active');
  // Find the sidebar item if not provided
  if(!el) el=document.querySelector(`.nav-group-items .tab[data-tab="${id}"]`);
  if(el) el.classList.add('active');
  // Auto-expand the group containing this item
  if(el){
    const grp=el.closest('.nav-group');
    if(grp && !grp.classList.contains('open')){
      grp.classList.add('open');
      const items=grp.querySelector('.nav-group-items');
      if(items) items.style.display='block';
    }
  }
  // Load data on tab switch
  if(id==='ext') loadExtratos();
  if(id==='nfs') loadNfs();
  if(id==='cont') loadContratos();
  if(id==='pag') loadPagamentos();
  if(id==='desp') loadDespesas();
  if(id==='import'){ loadImportHist(); setTimeout(initDragDrop,100); }
  if(id==='pref') loadPrefeitura();
  if(id==='fluxo') loadFluxoProjetado();
  if(id==='usuarios') loadUsuarios();
  // Novos módulos (extras) — também tratados em app-extras.js via override
  if(id==='relat') {} // sem auto-load
  if(id==='conciliacao3v') loadConciliacao3Vias();
  if(id==='keywords') loadKeywords();
  if(id==='config') loadConfig();
  if(id==='consolidado') loadConsolidado();
  if(id==='estoque')  window.estoqueInit  && window.estoqueInit();
  if(id==='juridico') window.juridicoInit && window.juridicoInit();
}

// ─── Global Period Filter ────────────────────────────────────────
function globalPeriodChange(){
  const tipo=document.getElementById('gf-tipo').value;
  document.getElementById('gf-mes-wrap').style.display=tipo==='mes'?'block':'none';
  document.getElementById('gf-trim-wrap').style.display=tipo==='trimestre'?'block':'none';
  document.getElementById('gf-ano-wrap').style.display=tipo==='ano'?'block':'none';
  document.getElementById('gf-custom-wrap').style.display=tipo==='custom'?'flex':'none';
  if(!tipo){clearGlobalPeriod();return;}
  applyGlobalPeriod();
}

function applyGlobalPeriod(){
  const tipo=document.getElementById('gf-tipo').value;
  if(tipo==='mes'){
    const mv=document.getElementById('gf-mes').value;
    if(!mv)return;
    const [y,m]=mv.split('-').map(Number);
    _from=mv+'-01';
    _to=mv+'-'+new Date(y,m,0).getDate().toString().padStart(2,'0');
  }else if(tipo==='trimestre'){
    const tv=document.getElementById('gf-trim').value;
    const [y,tq]=tv.split('-');
    const t=parseInt(tq.replace('T',''));
    const m1=(t-1)*3+1;
    _from=y+'-'+m1.toString().padStart(2,'0')+'-01';
    const m3=m1+2;
    _to=y+'-'+m3.toString().padStart(2,'0')+'-'+new Date(parseInt(y),m3,0).getDate();
  }else if(tipo==='ano'){
    _from=document.getElementById('gf-ano').value+'-01-01';
    _to=document.getElementById('gf-ano').value+'-12-31';
  }else if(tipo==='custom'){
    _from=document.getElementById('gf-de').value||'';
    _to=document.getElementById('gf-ate').value||'';
  }
  document.getElementById('gf-label').innerHTML=`<strong>${_from||'...'} a ${_to||'...'}</strong>`;
  loadDashboard();
  const activeTab=document.querySelector('.tab.active');
  if(activeTab) showTab(activeTab.dataset.tab, activeTab);
}

function clearGlobalPeriod(){
  _from='';_to='';
  document.getElementById('gf-tipo').value='';
  ['gf-mes-wrap','gf-trim-wrap','gf-ano-wrap','gf-custom-wrap'].forEach(id=>document.getElementById(id).style.display='none');
  document.getElementById('gf-label').textContent='Todos os períodos';
  loadDashboard();
}

// ─── Dashboard ───────────────────────────────────────────────────
async function loadDashboard(){
  let url='/dashboard?';
  if(_from)url+='from='+_from+'&';
  if(_to)url+='to='+_to;
  showLoading('Carregando dashboard…');
  document.getElementById('dash-kpis').innerHTML='<div class="loading">Carregando dashboard…</div>';
  let d;
  try{ d=await api(url); }catch(e){ hideLoading(); return; }

  // Estado vazio — onboarding para empresa sem dados
  if(d.extratos && d.extratos.total===0 && d.nfs.total===0 && d.contratos.total===0){
    document.getElementById('dash-kpis').innerHTML=`
      <div style="grid-column:1/-1;background:linear-gradient(135deg,#f0f9ff,#e0f2fe);border:2px dashed #38bdf8;border-radius:14px;padding:32px;text-align:center">
        <div style="font-size:40px;margin-bottom:12px">🚀</div>
        <h3 style="font-size:18px;font-weight:800;color:#0f172a;margin-bottom:6px">Empresa sem dados ainda</h3>
        <p style="font-size:12px;color:#64748b;margin-bottom:20px;max-width:500px;margin-left:auto;margin-right:auto">
          Este banco de dados está vazio. Siga os passos abaixo para começar a usar o sistema.
        </p>
        <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap">
          <div onclick="showTab('cont',null)" style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px;cursor:pointer;min-width:140px;transition:.15s" onmouseover="this.style.borderColor='#3b82f6'" onmouseout="this.style.borderColor='#e2e8f0'">
            <div style="font-size:22px">📋</div>
            <div style="font-size:11px;font-weight:700;color:#0f172a;margin-top:4px">1. Cadastrar Contratos</div>
            <div style="font-size:9px;color:#94a3b8;margin-top:2px">Órgãos, valores, vigência</div>
          </div>
          <div onclick="showTab('import',null)" style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px;cursor:pointer;min-width:140px;transition:.15s" onmouseover="this.style.borderColor='#3b82f6'" onmouseout="this.style.borderColor='#e2e8f0'">
            <div style="font-size:22px">📥</div>
            <div style="font-size:11px;font-weight:700;color:#0f172a;margin-top:4px">2. Importar Extratos</div>
            <div style="font-size:9px;color:#94a3b8;margin-top:2px">OFX ou CSV do banco</div>
          </div>
          <div onclick="showTab('nfs',null)" style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px;cursor:pointer;min-width:140px;transition:.15s" onmouseover="this.style.borderColor='#3b82f6'" onmouseout="this.style.borderColor='#e2e8f0'">
            <div style="font-size:22px">🧾</div>
            <div style="font-size:11px;font-weight:700;color:#0f172a;margin-top:4px">3. Lançar NFs</div>
            <div style="font-size:9px;color:#94a3b8;margin-top:2px">Notas fiscais emitidas</div>
          </div>
          <div onclick="showTab('desp',null)" style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px;cursor:pointer;min-width:140px;transition:.15s" onmouseover="this.style.borderColor='#3b82f6'" onmouseout="this.style.borderColor='#e2e8f0'">
            <div style="font-size:22px">💸</div>
            <div style="font-size:11px;font-weight:700;color:#0f172a;margin-top:4px">4. Registrar Despesas</div>
            <div style="font-size:9px;color:#94a3b8;margin-top:2px">Contas a pagar</div>
          </div>
        </div>
      </div>`;
    hideLoading();
    return;
  }

  const e=d.extratos;

  // Header stats
  document.getElementById('h-ext').textContent=e.total;
  document.getElementById('h-nfs').textContent=d.nfs.total;
  document.getElementById('h-cont').textContent=d.contratos.total;
  document.getElementById('h-pgs').textContent=d.pagamentos.total;
  document.getElementById('h-vinc').textContent=d.vinculacoes.total;

  // Saldo
  const saldo = e.total_creditos - e.total_debitos;
  const pctConc = e.total > 0 ? ((e.conciliados / e.total) * 100).toFixed(1) : 0;

  // ─── KPIs Linha 1 ───
  document.getElementById('dash-kpis').innerHTML=`
    <div class="kpi" style="border-left:4px solid #1d4ed8">
      <div class="kpi-l">🏦 Lançamentos</div>
      <div class="kpi-v blue">${e.total}</div>
      <div class="kpi-s">extratos bancários</div>
    </div>
    <div class="kpi" style="border-left:4px solid #15803d">
      <div class="kpi-l">💰 Total Créditos</div>
      <div class="kpi-v green">${brl(e.total_creditos)}</div>
      <div class="kpi-s">entradas</div>
    </div>
    <div class="kpi" style="border-left:4px solid #dc2626">
      <div class="kpi-l">📤 Total Débitos</div>
      <div class="kpi-v red">${brl(e.total_debitos)}</div>
      <div class="kpi-s">saídas</div>
    </div>
    <div class="kpi" style="border-left:4px solid ${saldo>=0?'#15803d':'#dc2626'}">
      <div class="kpi-l">📈 Saldo</div>
      <div class="kpi-v" style="color:${saldo>=0?'#15803d':'#dc2626'}">${brl(saldo)}</div>
      <div class="kpi-s">${saldo>=0?'positivo':'negativo'}</div>
    </div>
    <div class="kpi" style="border-left:4px solid #15803d">
      <div class="kpi-l">✅ Conciliados</div>
      <div class="kpi-v green">${e.conciliados}</div>
      <div style="background:#e2e8f0;border-radius:4px;height:6px;margin:6px 0 2px"><div style="background:#15803d;height:6px;border-radius:4px;width:${pctConc}%"></div></div>
      <div class="kpi-s">${pctConc}% do total</div>
    </div>
    <div class="kpi" style="border-left:4px solid #d97706">
      <div class="kpi-l">⏳ A Receber (Contratos)</div>
      <div class="kpi-v amber">${brl(d.contratos.totalAberto)}</div>
      <div class="kpi-s">${d.contratos.total} contratos ativos</div>
    </div>
    <div class="kpi" style="border-left:4px solid #7c3aed">
      <div class="kpi-l">🧾 NFs Emitidas</div>
      <div class="kpi-v" style="color:#7c3aed">${brl(d.nfs.totalBruto)}</div>
      <div class="kpi-s">${d.nfs.total} notas · Liq. ${brl(d.nfs.totalLiquido)}</div>
    </div>
    <div class="kpi" style="border-left:4px solid #0891b2">
      <div class="kpi-l">💸 Despesas</div>
      <div class="kpi-v" style="color:#0891b2">${brl(d.despesas.totalBruto)}</div>
      <div class="kpi-s">${d.despesas.total} lançamentos</div>
    </div>
    <div class="kpi" style="border-left:4px solid #dc2626">
      <div class="kpi-l">🏛️ Impostos/DARF</div>
      <div class="kpi-v" style="color:#dc2626">${brl(d.despesas.totalImpostos||0)}</div>
      <div class="kpi-s">tributos no período</div>
    </div>
  `;

  // ─── Gráfico Fluxo Mensal (barras CSS) ───
  const fluxo = d.fluxoMensal || [];
  const maxVal = Math.max(...fluxo.map(f=>Math.max(f.creditos,f.debitos)),1);
  const mesesNome = {
    '01':'Jan','02':'Fev','03':'Mar','04':'Abr','05':'Mai','06':'Jun',
    '07':'Jul','08':'Ago','09':'Set','10':'Out','11':'Nov','12':'Dez'
  };

  let chartHtml='', labelsHtml='';
  fluxo.forEach((f,i)=>{
    const hC = Math.max((f.creditos/maxVal)*155, 3);
    const hD = Math.max((f.debitos/maxVal)*155, 3);
    const saldo = f.creditos - f.debitos;
    const mesLabel = mesesNome[f.mes.split('-')[1]] + '/' + f.mes.split('-')[0].slice(2);
    const isLast = i === fluxo.length - 1;
    chartHtml += `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;justify-content:flex-end;${isLast?'background:rgba(59,130,246,.04);border-radius:6px;margin:-4px -2px;padding:4px 2px':''}">
        <div style="font-size:8px;color:#475569;font-weight:600;white-space:nowrap">${shortBrl(f.creditos)}</div>
        <div style="width:100%;display:flex;gap:3px;align-items:flex-end;justify-content:center">
          <div style="width:42%;height:${hC}px;background:linear-gradient(180deg,#4ade80,#16a34a);border-radius:4px 4px 0 0;transition:height .4s ease" title="Créditos: ${brl(f.creditos)}"></div>
          <div style="width:42%;height:${hD}px;background:linear-gradient(180deg,#fb923c,#ea580c);border-radius:4px 4px 0 0;transition:height .4s ease" title="Débitos: ${brl(f.debitos)}"></div>
        </div>
        <div style="font-size:7px;font-weight:700;color:${saldo>=0?'#15803d':'#dc2626'};margin-top:1px">${saldo>=0?'+':''}${shortBrl(saldo)}</div>
      </div>`;
    labelsHtml += `<div style="flex:1;text-align:center;font-size:10px;font-weight:${isLast?'800':'600'};color:${isLast?'#1d4ed8':'#64748b'}">${mesLabel}</div>`;
  });
  document.getElementById('dash-chart').innerHTML = chartHtml || '<div class="muted" style="padding:40px;text-align:center">Sem dados de fluxo</div>';
  document.getElementById('dash-chart-labels').innerHTML = labelsHtml;

  // ─── Donut Visual de Conciliação ───
  const cs = d.concStatus;
  const totalConc = cs.conciliados + cs.pendentes + cs.parciais + cs.a_identificar;
  const donutColor = pctConc >= 80 ? '#22c55e' : pctConc >= 50 ? '#f59e0b' : '#ef4444';

  function pctBar(val, cor, label) {
    const pct = totalConc > 0 ? ((val/totalConc)*100).toFixed(1) : 0;
    return `
      <div style="margin-bottom:2px">
        <div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:2px">
          <span style="font-weight:600;color:#334155">${label}</span>
          <span style="font-weight:700;color:#475569">${val.toLocaleString('pt-BR')}</span>
        </div>
        <div style="background:#f1f5f9;border-radius:4px;height:8px;overflow:hidden">
          <div style="background:${cor};height:100%;border-radius:4px;width:${pct}%;transition:width .6s ease"></div>
        </div>
      </div>`;
  }

  document.getElementById('dash-donut').innerHTML = `
    <div class="donut-ring" style="--donut-color:${donutColor};--donut-pct:${pctConc}%">
      <div class="donut-ring-inner">
        <span style="font-size:24px;font-weight:800;color:${donutColor};line-height:1">${pctConc}%</span>
        <span style="font-size:8px;color:#64748b;text-transform:uppercase;font-weight:600;margin-top:2px">conciliado</span>
      </div>
    </div>
  ` +
    pctBar(cs.conciliados, '#22c55e', '✅ Conciliados') +
    pctBar(cs.pendentes, '#f59e0b', '⏳ Pendentes') +
    pctBar(cs.parciais, '#3b82f6', '🔶 Parciais') +
    pctBar(cs.a_identificar, '#ef4444', '⚠️ A Identificar');

  // ─── Alertas ───
  const alertas = d.alertas || [];
  if (alertas.length === 0) {
    document.getElementById('dash-alertas').innerHTML = '<div style="text-align:center;padding:20px;color:#94a3b8;font-size:11px">✅ Nenhum alerta no momento</div>';
  } else {
    document.getElementById('dash-alertas').innerHTML = alertas.map(a => {
      const bg = a.tipo==='danger'?'#fef2f2':a.tipo==='warning'?'#fffbeb':'#eff6ff';
      const border = a.tipo==='danger'?'#fca5a5':a.tipo==='warning'?'#fcd34d':'#93c5fd';
      return `<div style="background:${bg};border:1px solid ${border};border-radius:6px;padding:8px 10px;font-size:11px;display:flex;align-items:center;gap:8px">
        <span style="font-size:14px">${a.icon}</span>
        <span style="color:#334155">${a.msg}</span>
      </div>`;
    }).join('');
  }

  // ─── Últimos Créditos ───
  document.getElementById('dash-cred-head').innerHTML = `<tr>
    <th>Data</th><th>Histórico</th><th class="r">Valor</th><th>Banco</th><th>Status</th>
  </tr>`;
  document.getElementById('dash-cred-body').innerHTML = (d.ultimosCreditos || []).map(r => {
    const stColor = r.status_conciliacao==='CONCILIADO'?'green':r.status_conciliacao==='PARCIAL'?'blue':'amber';
    return `<tr>
      <td style="font-size:10px;color:#64748b;white-space:nowrap">${r.data||''}</td>
      <td style="font-size:10px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.historico}">${(r.historico||'').substring(0,50)}</td>
      <td class="r mono green" style="font-weight:600">${brl(r.credito)}</td>
      <td style="font-size:9px;color:#64748b">${r.banco||''}</td>
      <td>${badge(r.status_conciliacao||'PENDENTE', stColor)}</td>
    </tr>`;
  }).join('');

  // ─── Top Contratos com barra de margem ───
  document.getElementById('dash-top-head').innerHTML = `<tr>
    <th>Contrato</th><th>Descrição</th><th class="r">Receita</th><th class="r">Despesas</th><th class="r">Lucro Est.</th><th style="min-width:110px">Margem</th><th>Status</th>
  </tr>`;
  const maxReceita = Math.max(...(d.topContratos||[]).map(c=>c.total_pago),1);
  document.getElementById('dash-top-body').innerHTML = (d.topContratos || []).map(c => {
    const lucro = c.total_pago - c.despesas_total;
    const margem = c.total_pago > 0 ? ((lucro / c.total_pago) * 100).toFixed(1) : 0;
    const margemCor = margem >= 30 ? '#22c55e' : margem >= 10 ? '#f59e0b' : '#ef4444';
    const barW = c.total_pago > 0 ? Math.max((c.total_pago / maxReceita) * 100, 5) : 0;
    const stColor = c.status==='ATIVO'||c.status==='ativo'?'green':c.status?'amber':'gray';
    return `<tr>
      <td class="mono" style="font-size:10px;color:#1d4ed8;font-weight:700;white-space:nowrap">${c.numContrato}</td>
      <td style="font-size:10px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${c.contrato}">${(c.contrato||'').substring(0,40)}</td>
      <td class="r mono" style="font-weight:700;color:#15803d">${brl(c.total_pago)}</td>
      <td class="r mono" style="color:#dc2626">${brl(c.despesas_total)}</td>
      <td class="r mono" style="font-weight:700;color:${lucro>=0?'#15803d':'#dc2626'}">${brl(lucro)}</td>
      <td>
        <div style="display:flex;align-items:center;gap:6px">
          <div style="flex:1;background:#f1f5f9;border-radius:3px;height:8px;overflow:hidden">
            <div style="background:${margemCor};height:100%;width:${Math.min(Math.abs(margem),100)}%;border-radius:3px;transition:width .5s"></div>
          </div>
          <span style="font-size:9px;font-weight:700;color:${margemCor};min-width:36px;text-align:right">${margem}%</span>
        </div>
      </td>
      <td>${badge(c.status||'—', stColor)}</td>
    </tr>`;
  }).join('');

  // Alertas de certidões — definido em app-extras.js; reaplicar após cada reload do dashboard
  if (typeof loadCertAlertas === 'function') loadCertAlertas();

  // ─── Widget Ponto Hoje ───
  _loadDashPonto();
  hideLoading();
}

async function _loadDashPonto() {
  const el = document.getElementById('dash-ponto');
  if (!el) return;
  try {
    const hoje = new Date().toISOString().substring(0, 10);
    const res  = await api(`/ponto?data=${hoje}`);
    const rows = (res && res.data) ? res.data : [];
    if (rows.length === 0) {
      el.innerHTML = `<div style="text-align:center;color:#94a3b8;font-size:11px;padding:16px">Nenhum registro hoje</div>`;
      return;
    }
    // Agrupar por funcionário — pegar último registro
    const porFunc = {};
    rows.forEach(r => {
      if (!porFunc[r.funcionario_id]) porFunc[r.funcionario_id] = { nome: r.funcionario_nome || '—', cargo: r.cargo_nome || '', registros: [] };
      porFunc[r.funcionario_id].registros.push(r);
    });
    const funcs = Object.values(porFunc);
    const presentes = funcs.filter(f => {
      const tipos = f.registros.map(r => r.tipo);
      return tipos.includes('entrada') && !tipos.includes('saida');
    }).length;
    const saidos = funcs.filter(f => f.registros.map(r => r.tipo).includes('saida')).length;
    const semReg = funcs.filter(f => !f.registros.map(r => r.tipo).includes('entrada')).length;
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px">
        <div style="background:#dcfce7;border-radius:6px;padding:6px;text-align:center">
          <div style="font-size:18px;font-weight:800;color:#15803d">${presentes}</div>
          <div style="font-size:8px;color:#166534;font-weight:600">PRESENTES</div>
        </div>
        <div style="background:#fef3c7;border-radius:6px;padding:6px;text-align:center">
          <div style="font-size:18px;font-weight:800;color:#d97706">${saidos}</div>
          <div style="font-size:8px;color:#92400e;font-weight:600">SAÍRAM</div>
        </div>
        <div style="background:#f1f5f9;border-radius:6px;padding:6px;text-align:center">
          <div style="font-size:18px;font-weight:800;color:#64748b">${rows.length}</div>
          <div style="font-size:8px;color:#475569;font-weight:600">BATIDAS</div>
        </div>
      </div>
      <div style="max-height:180px;overflow-y:auto;display:flex;flex-direction:column;gap:3px">
        ${funcs.slice(0, 12).map(f => {
          const tipos = f.registros.map(r => r.tipo);
          const presente = tipos.includes('entrada') && !tipos.includes('saida');
          const saiu = tipos.includes('saida');
          const cor = presente ? '#dcfce7' : saiu ? '#f0fdf4' : '#f8fafc';
          const icone = presente ? '🟢' : saiu ? '🏁' : '⬜';
          const ultimo = f.registros[f.registros.length - 1];
          const hora = ultimo ? ultimo.data_hora.substring(11, 16) : '';
          return `<div style="background:${cor};border-radius:4px;padding:4px 8px;display:flex;align-items:center;justify-content:space-between;font-size:10px">
            <span>${icone} <strong>${f.nome.split(' ')[0]}</strong></span>
            <span style="color:#64748b;font-size:9px">${hora} · ${ultimo ? ultimo.tipo.replace('_',' ') : ''}</span>
          </div>`;
        }).join('')}
        ${funcs.length > 12 ? `<div style="text-align:center;font-size:9px;color:#94a3b8;padding:4px">+${funcs.length - 12} funcionários</div>` : ''}
      </div>`;
  } catch(e) {
    el.innerHTML = `<div style="text-align:center;color:#94a3b8;font-size:10px;padding:16px">Ponto não disponível</div>`;
  }
}

// ─── Extratos ────────────────────────────────────────────────────
// Meses do ano corrente disponíveis no banco (carregados 1x por loadExtratos)
let _extMesesDisponiveis = [];

function renderExtFilters(){
  const MES_LABEL = {JAN:'Jan',FEV:'Fev',MAR:'Mar',ABR:'Abr',MAI:'Mai',JUN:'Jun',
                     JUL:'Jul',AGO:'Ago',SET:'Set',OUT:'Out',NOV:'Nov',DEZ:'Dez'};
  const MES_ORDER = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];
  const ano = (_from||'2026').substring(0,4);

  // Botões dinâmicos baseados nos meses disponíveis no banco
  const mesesBtn = _extMesesDisponiveis.length
    ? _extMesesDisponiveis
    : MES_ORDER.filter(m => ['JAN','FEV','MAR'].includes(m)); // fallback inicial

  const btnStyle = (ativo) =>
    `padding:4px 12px;border-radius:6px;border:1px solid ${ativo?'#1d4ed8':'#e2e8f0'};background:${ativo?'#dbeafe':'#fff'};color:${ativo?'#1d4ed8':'#64748b'};font-size:11px;font-weight:700;cursor:pointer`;

  const botoesHtml = mesesBtn
    .sort((a,b) => MES_ORDER.indexOf(a) - MES_ORDER.indexOf(b))
    .map(m => `<button onclick="_extMes='${m}';_extMesManual=true;_extPage=1;loadExtratos()" style="${btnStyle(_extMes===m)}">${MES_LABEL[m]||m}/${ano}</button>`)
    .join('');

  document.getElementById('ext-filters').innerHTML=`
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <label style="font-size:11px;font-weight:700;color:#64748b">FILTRAR MÊS:</label>
      <button onclick="_extMes='';_extMesManual=true;_extPage=1;loadExtratos()" style="${btnStyle(!_extMes)}">Todos</button>
      ${botoesHtml}
      <span style="margin-left:12px;font-size:10px;color:#94a3b8" id="ext-mes-info"></span>
    </div>`;
}

async function loadExtratos(){
  // Buscar meses disponíveis no banco (para botões dinâmicos)
  let mesesUrl=`/extratos/meses?`;
  if(_from) mesesUrl+='from='+_from+'&';
  if(_to)   mesesUrl+='to='+_to;
  const mesesData = await api(mesesUrl).catch(()=>({meses:[]}));
  if(mesesData.meses && mesesData.meses.length) {
    _extMesesDisponiveis = mesesData.meses;
    // Auto-seleciona o mês mais recente se o usuário não escolheu manualmente
    if(!_extMesManual && !_extMes) {
      _extMes = _extMesesDisponiveis[_extMesesDisponiveis.length - 1];
    }
  }

  renderExtFilters();
  let url=`/extratos?page=${_extPage}&limit=${PAGE_SIZE}`;
  if(_from) url+='&from='+_from;
  if(_to) url+='&to='+_to;
  if(_extMes) url+='&mes='+encodeURIComponent(_extMes);
  const d=await api(url);
  document.getElementById('ext-mes-info').textContent=_extMes?`Filtro: ${_extMes} (${d.total} registros)`:`Total: ${d.total} registros`;

  // Load contratos for dropdown (recarrega se empresa mudou)
  if(!_contratos.length || _contratosEmpresa !== currentCompany){
    const c=await api('/contratos');
    _contratos=c.data||[];
    _contratosEmpresa=currentCompany;
  }

  // Build options
  const contOpts=_contratos.map(c=>`<option value="${c.numContrato}">${c.numContrato} — ${c.contrato.substring(0,35)}</option>`).join('');

  document.getElementById('ext-head').innerHTML=`<tr><th>ID</th><th>Mês</th><th>Data</th><th>Histórico</th><th class="r">Débito</th><th class="r">Crédito</th><th>Posto</th><th>Status</th><th>Vincular Contrato</th></tr>`;

  const rows=d.data.map(r=>{
    const isVinc=r.contrato_vinculado?'vinculado':'';
    return `<tr class="${isVinc}" data-id="${r.id}">
      <td class="mono muted">${r.id}</td>
      <td style="font-size:10px;font-weight:600;color:#64748b">${r.mes}</td>
      <td style="font-size:10px;color:#64748b">${r.data}</td>
      <td style="font-size:11px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(r.historico||'').substring(0,80)}">${(r.historico||'').substring(0,50)}</td>
      <td class="r">${r.debito?`<span class="mono red">${brl(r.debito)}</span>`:'<span class="muted">—</span>'}</td>
      <td class="r">${r.credito?`<span class="mono green">${brl(r.credito)}</span>`:'<span class="muted">—</span>'}</td>
      <td style="font-size:10px;color:#475569;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.posto||''}</td>
      <td>${statusBadge(r.status_conciliacao)}</td>
      <td><select class="vinc-sel" data-id="${r.id}" data-val="${r.credito||r.debito||0}" data-tipo="${r.credito?'C':'D'}" onchange="onVincChange(this)">
        <option value="">— vincular —</option>${contOpts}
      </select></td>
    </tr>`;
  }).join('');

  document.getElementById('ext-body').innerHTML=rows;
  document.getElementById('ext-counter').textContent=`Exibindo ${d.data.length} de ${d.total} · Página ${d.page} de ${d.pages}`;

  // Set selected values for already-linked
  d.data.forEach(r=>{
    if(r.contrato_vinculado){
      const sel=document.querySelector(`.vinc-sel[data-id="${r.id}"]`);
      if(sel) sel.value=r.contrato_vinculado;
    }
  });

  // Pagination
  document.getElementById('ext-pag').innerHTML=`
    <button ${d.page<=1?'disabled':''} onclick="_extPage--;loadExtratos()">← Anterior</button>
    <span>Página ${d.page} de ${d.pages} (${d.total} registros)</span>
    <button ${d.page>=d.pages?'disabled':''} onclick="_extPage++;loadExtratos()">Próxima →</button>
    <button onclick="exportarExcel('extratos')" style="margin-left:10px;padding:4px 12px;font-size:10px;border:1px solid #1d4ed8;border-radius:5px;background:#eff6ff;color:#1d4ed8;cursor:pointer;font-weight:600">⬇ Excel</button>`;

  updateVincStats();
}

function statusBadge(st){
  const map={CONCILIADO:['✅ Conciliado','green'],PENDENTE:['⏳ Pendente','amber'],A_IDENTIFICAR:['⚠️ A Identificar','red'],TRANSFERENCIA:['🔄 Transferência','gray'],A_RECEBER:['⏳ A Receber','blue'],EM_ATRASO:['🔴 Em Atraso','red']};
  const [label,type]=map[st]||[st||'—','gray'];
  return badge(label,type);
}

function onVincChange(sel){
  const id=parseInt(sel.dataset.id);
  const tr=sel.closest('tr');
  if(sel.value){
    _vinculacoes[id]={contrato_num:sel.value,valor:parseFloat(sel.dataset.val)||0,tipo:sel.dataset.tipo||''};
    tr.classList.add('vinculado');
  }else{
    delete _vinculacoes[id];
    tr.classList.remove('vinculado');
  }
  updateVincStats();
}

function updateVincStats(){
  const total=document.querySelectorAll('.vinc-sel').length;
  const vinc=document.querySelectorAll('tr.vinculado').length + Object.keys(_vinculacoes).length;
  document.getElementById('vinc-count').textContent=document.querySelectorAll('tr.vinculado').length;
  document.getElementById('vinc-pending').textContent=total-document.querySelectorAll('tr.vinculado').length;
}

async function salvarVinculacoes(){
  const items=Object.entries(_vinculacoes).map(([id,v])=>({extrato_id:parseInt(id),...v}));
  if(!items.length){toast('Nenhuma vinculação pendente para salvar','error');return;}
  showLoading(`Salvando ${items.length} vinculações…`);
  const r=await api('/vinculacoes/batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vinculacoes:items})});
  hideLoading();
  if(r.ok){
    toast(`${items.length} vinculações salvas com sucesso!`);
    _vinculacoes={};
    loadExtratos();
    loadDashboard();
  }else{toast(r.error||'Erro ao salvar','error');}
}

async function autoVincular(){
  // Carregar keywords configuráveis do banco
  const kwData = await api('/configuracoes/keywords');
  const keywordsList = kwData.keywords || [];

  // Load all unlinked extratos and try to match by keywords
  const d=await api('/extratos?status=PENDENTE&limit=9999');
  const keywords={};
  _contratos.forEach(c=>{
    const name=c.contrato.toLowerCase();
    // Usar keywords configuráveis do banco (com fallback para contrato do banco ou busca por nome)
    keywordsList.forEach(kw=>{
      const palavra = (kw.palavra||'').toLowerCase();
      if(!palavra) return;
      // Se tem contrato fixo, usar direto; senão tentar fazer match pelo nome do contrato
      if(kw.contrato) { keywords[palavra]=kw.contrato; }
      else if(name.includes(palavra)) { keywords[palavra]=c.numContrato; }
    });
  });

  const batch=[];
  (d.data||[]).forEach(r=>{
    if(r.contrato_vinculado)return;
    const text=(r.historico+' '+r.posto).toLowerCase();
    for(const[word,num]of Object.entries(keywords)){
      if(text.includes(word)){
        batch.push({extrato_id:r.id,contrato_num:num,tipo:r.credito?'C':'D',valor:r.credito||r.debito||0});
        break;
      }
    }
  });

  if(!batch.length){toast('Nenhum lançamento para auto-vincular','error');return;}
  if(!confirm(`Auto-vincular ${batch.length} lançamentos aos contratos detectados?\n\nEsta ação pode ser desfeita individualmente.`))return;
  showLoading(`Auto-vinculando ${batch.length} lançamentos…`);
  const r=await api('/vinculacoes/batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vinculacoes:batch})});
  hideLoading();
  if(r.ok){
    toast(`${batch.length} lançamentos auto-vinculados!`);
    loadExtratos();loadDashboard();
  }
}

// ─── NFs ─────────────────────────────────────────────────────────
async function loadNfs(){
  let url=`/nfs?page=${_nfsPage}&limit=${PAGE_SIZE}`;
  if(_from) url+='&from='+_from;
  if(_to)   url+='&to='+_to;
  const d=await api(url);

  // Alerta de NFs sem data
  const semData = await api('/nfs/sem-data');
  const alertEl  = document.getElementById('nfs-alerta-sem-data');
  const textoEl  = document.getElementById('nfs-alerta-sem-data-texto');
  if (alertEl && textoEl) {
    if (semData?.total > 0) {
      textoEl.textContent = `${semData.total} nota${semData.total > 1 ? 's fiscais' : ' fiscal'} sem data de emissão — filtros de período não as capturam`;
      alertEl.style.display = 'flex';
    } else {
      alertEl.style.display = 'none';
    }
  }
  document.getElementById('nfs-head').innerHTML=`<tr><th>NF</th><th>Competência</th><th>Cidade</th><th>Tomador</th><th class="r">V. Bruto</th><th class="r">V. Líquido</th><th class="r">Retenção</th><th style="width:50px">Ação</th></tr>`;
  document.getElementById('nfs-body').innerHTML=(d.data||[]).map(r=>`<tr>
    <td class="mono" style="color:#7c3aed;font-weight:600">NF ${r.numero}</td>
    <td style="font-size:10px;color:#64748b">${r.competencia||''}</td>
    <td style="font-size:10px;color:#475569">${r.cidade||''}</td>
    <td style="font-size:10px;color:#475569">${(r.tomador||'').substring(0,40)}</td>
    <td class="r mono" style="color:#b45309;font-weight:600">${brl(r.valor_bruto)}</td>
    <td class="r mono green" style="font-weight:600">${brl(r.valor_liquido)}</td>
    <td class="r mono red">${brl(r.retencao)}</td>
    <td><button onclick="excluirNf(${r.id},'${(r.numero||'').replace(/'/g,"\\'")}')" style="padding:2px 6px;font-size:9px;border:1px solid #fca5a5;border-radius:4px;background:#fee2e2;color:#dc2626;cursor:pointer" title="Excluir NF">✕</button></td>
  </tr>`).join('');
  document.getElementById('nfs-counter').textContent=`${d.total} notas fiscais`;
  document.getElementById('nfs-pag').innerHTML=`
    <button ${d.page<=1?'disabled':''} onclick="_nfsPage--;loadNfs()">← Anterior</button>
    <span>Página ${d.page} de ${d.pages}</span>
    <button ${d.page>=d.pages?'disabled':''} onclick="_nfsPage++;loadNfs()">Próxima →</button>
    <button onclick="exportarExcel('nfs')" style="margin-left:10px;padding:4px 12px;font-size:10px;border:1px solid #7c3aed;border-radius:5px;background:#f5f3ff;color:#7c3aed;cursor:pointer;font-weight:600">⬇ Excel</button>`;
}

// ─── Contratos ───────────────────────────────────────────────────
function contStatusBadge(st){
  if(!st) return badge('—','gray');
  if(st.includes('EM DIA')) return badge('EM DIA','green');
  if(st.includes('CRÍTICO')) return badge('CRÍTICO','red');
  if(st.includes('ATENÇÃO')) return badge('ATENÇÃO','amber');
  if(st.includes('A RECEBER')) return badge('A RECEBER','blue');
  if(st.includes('PAGO')) return badge('PAGO','green');
  if(st.includes('ATRASO')) return badge('EM ATRASO','red');
  return badge(st.replace(/[^\w\s—àáãçéêíóôõú]/gi,'').trim()||'—','gray');
}

function parcStatusBadge(st){
  if(!st) return badge('—','gray');
  if(st.includes('PAGO')) return badge('PAGO','green');
  if(st.includes('PARCIAL')) return badge('PARCIAL','amber');
  if(st.includes('ATRASO') || st.includes('TÉRMINO')) return badge('EM ATRASO','red');
  if(st.includes('RECEBER') || st.includes('FUTURO')) return badge('A RECEBER','blue');
  if(st.includes('EMITIR')) return badge('EMITIR NF','amber');
  if(st.includes('RETENÇÃO')) return badge('RETENÇÃO','amber');
  return badge(st.replace(/[^\w\s—àáãçéêíóôõú]/gi,'').trim()||'—','gray');
}

// ─── Estado de filtro da aba Contratos ───────────────────────────
let _contFiltroStatus = 'ATIVOS'; // 'ATIVOS' | 'TODOS' | 'ENCERRADOS'

async function loadContratos(){
  const d=await api('/contratos');
  const todos = d.data || [];
  const s=d.summary||{soma_pago:0,soma_aberto:0,total_contratos:0};

  // Aplica filtro
  const lista = _contFiltroStatus === 'ATIVOS'
    ? todos.filter(c => !c.status.includes('ENCERRADO') && !c.status.includes('RESCINDIDO'))
    : _contFiltroStatus === 'ENCERRADOS'
    ? todos.filter(c => c.status.includes('ENCERRADO') || c.status.includes('RESCINDIDO'))
    : todos;

  const pctGeral=s.soma_pago+s.soma_aberto>0?((s.soma_pago/(s.soma_pago+s.soma_aberto))*100).toFixed(1):0;
  const emDia=todos.filter(c=>c.status.includes('EM DIA')).length;
  const criticos=todos.filter(c=>c.status.includes('CRÍTICO')).length;

  // Alerta de vigência: contratos vencendo em até 60 dias
  const hoje = new Date();
  const alertaVig = todos.filter(c => {
    if (!c.vigencia_fim) return false;
    const dias = Math.floor((new Date(c.vigencia_fim) - hoje) / 86400000);
    return dias >= 0 && dias <= 60;
  }).length;

  document.getElementById('cont-kpis').innerHTML=`
    <div class="kpi"><div class="kpi-l">Contratos Ativos</div><div class="kpi-v blue">${todos.filter(c=>!c.status.includes('ENCERRADO')).length}</div><div class="kpi-s">${emDia} em dia · ${criticos} críticos</div></div>
    <div class="kpi"><div class="kpi-l">Total Recebido</div><div class="kpi-v green">${brl(s.soma_pago)}</div><div class="kpi-s">valores pagos</div></div>
    <div class="kpi"><div class="kpi-l">Total Em Aberto</div><div class="kpi-v red">${brl(s.soma_aberto)}</div><div class="kpi-s">a receber / em atraso</div></div>
    <div class="kpi ${alertaVig>0?'':''}"><div class="kpi-l">Vigências</div><div class="kpi-v ${alertaVig>0?'red':'green'}">${alertaVig>0?alertaVig+' ⚠':'✅'}</div><div class="kpi-s">${alertaVig>0?alertaVig+' vencendo em 60 dias':'todas em vigor'}</div></div>
  `;

  // Popula filtro de contrato na aba de Conciliação 3V
  const c3vSel = document.getElementById('c3v-filtro-contrato');
  if (c3vSel && c3vSel.options.length <= 1) {
    todos.forEach(c => { const o=document.createElement('option'); o.value=c.numContrato; o.textContent=c.numContrato+' — '+c.contrato; c3vSel.appendChild(o); });
  }

  const cards=lista.map(c=>{
    const total=c.total_pago+c.total_aberto;
    const pct=total>0?((c.total_pago/total)*100).toFixed(1):0;
    const barColor=pct>=80?'#15803d':pct>=50?'#d97706':'#dc2626';
    const id=c.numContrato.replace(/[^a-zA-Z0-9]/g,'_');
    const numEsc = c.numContrato.replace(/'/g,"\\'");

    // Alerta de vigência
    let vigAlerta = '';
    if (c.vigencia_fim) {
      const dias = Math.floor((new Date(c.vigencia_fim) - hoje) / 86400000);
      if (dias < 0) vigAlerta = `<span style="font-size:9px;background:#fee2e2;color:#b91c1c;padding:1px 6px;border-radius:8px;font-weight:700">⛔ Vencido há ${Math.abs(dias)}d</span>`;
      else if (dias <= 30) vigAlerta = `<span style="font-size:9px;background:#fee2e2;color:#b91c1c;padding:1px 6px;border-radius:8px;font-weight:700">⚠️ Vence em ${dias}d</span>`;
      else if (dias <= 60) vigAlerta = `<span style="font-size:9px;background:#fef9c3;color:#92400e;padding:1px 6px;border-radius:8px;font-weight:700">⚠️ Vence em ${dias}d</span>`;
    }

    return `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:12px;overflow:hidden">
      <div style="padding:16px;cursor:pointer" onclick="toggleParcelas('${id}','${encodeURIComponent(c.numContrato)}')">
        <div style="display:flex;justify-content:space-between;align-items:start;flex-wrap:wrap;gap:8px;margin-bottom:10px">
          <div style="flex:1;min-width:200px">
            <div style="font-size:14px;font-weight:700;color:#0f172a">${c.contrato} ${vigAlerta}</div>
            <div style="font-size:10px;color:#94a3b8;margin-top:2px">Contrato: ${c.numContrato}${c.orgao?' · '+c.orgao:''}${c.vigencia_inicio?' · Vigência: '+c.vigencia_inicio+' a '+c.vigencia_fim:''}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            ${contStatusBadge(c.status)}
            <button onclick="event.stopPropagation();abrirDetalheContrato('${numEsc}');"
              style="padding:3px 10px;font-size:10px;border:1px solid #7c3aed;border-radius:6px;background:#f5f3ff;color:#7c3aed;cursor:pointer;font-weight:600">📊 Detalhe</button>
            <button onclick="event.stopPropagation();verTimelineContrato(${c.id});"
              style="padding:3px 10px;font-size:10px;border:1px solid #0891b2;border-radius:6px;background:#ecfeff;color:#0891b2;cursor:pointer;font-weight:600">📅 Timeline</button>
            <button onclick="event.stopPropagation();abrirEditarContrato('${numEsc}');"
              style="padding:3px 10px;font-size:10px;border:1px solid #0284c7;border-radius:6px;background:#f0f9ff;color:#0284c7;cursor:pointer;font-weight:600">✏️ Editar</button>
            <span style="font-size:18px;color:#94a3b8;transition:.2s" id="arrow-${id}">&#9660;</span>
          </div>
        </div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px">
          <div style="min-width:120px"><div style="font-size:9px;color:#64748b;font-weight:600;text-transform:uppercase">Mensal Líquido</div><div style="font-size:14px;font-weight:700;color:#1d4ed8">${brl(c.valor_mensal_liquido)}</div></div>
          <div style="min-width:120px"><div style="font-size:9px;color:#64748b;font-weight:600;text-transform:uppercase">Mensal Bruto</div><div style="font-size:14px;font-weight:700;color:#475569">${brl(c.valor_mensal_bruto)}</div></div>
          <div style="min-width:120px"><div style="font-size:9px;color:#64748b;font-weight:600;text-transform:uppercase">Total Pago</div><div style="font-size:14px;font-weight:700;color:#15803d">${brl(c.total_pago)}</div></div>
          <div style="min-width:120px"><div style="font-size:9px;color:#64748b;font-weight:600;text-transform:uppercase">Em Aberto</div><div style="font-size:14px;font-weight:700;color:${c.total_aberto>0?'#dc2626':'#15803d'}">${brl(c.total_aberto)}</div></div>
          <div style="min-width:80px"><div style="font-size:9px;color:#64748b;font-weight:600;text-transform:uppercase">Parcelas</div><div style="font-size:14px;font-weight:700;color:#475569">${c.qtd_parcelas}</div></div>
        </div>
        <div style="background:#f1f5f9;border-radius:6px;height:8px;overflow:hidden">
          <div style="background:${barColor};height:100%;width:${pct}%;border-radius:6px;transition:width .3s"></div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:3px">
          <span style="font-size:9px;color:#94a3b8">${pct}% pago · ${brl(c.total_pago)} de ${brl(total)}</span>
          <span style="font-size:9px;color:#94a3b8">▼ Clique para parcelas</span>
        </div>
      </div>
      <div id="parc-${id}" style="display:none;border-top:1px solid #e2e8f0;background:#f8fafc;padding:0"></div>
    </div>`;
  }).join('');

  // Barra de ações no topo
  const acoes = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center">
    <button onclick="abrirNovoContrato()" style="padding:5px 14px;font-size:11px;border:none;border-radius:6px;background:#15803d;color:#fff;cursor:pointer;font-weight:700">➕ Novo Contrato</button>
    <button onclick="classificarTodosCreditos()" style="padding:5px 14px;font-size:11px;border:1px solid #7c3aed;border-radius:6px;background:#f5f3ff;color:#7c3aed;cursor:pointer;font-weight:600">🏷 Classificar Todos</button>
    <button onclick="exportarExcel('contratos')" style="padding:5px 14px;font-size:11px;border:1px solid #1d4ed8;border-radius:6px;background:#eff6ff;color:#1d4ed8;cursor:pointer;font-weight:600">⬇ Excel</button>
    <div style="margin-left:auto;display:flex;gap:4px">
      ${['ATIVOS','TODOS','ENCERRADOS'].map(f=>`<button onclick="_contFiltroStatus='${f}';loadContratos()" style="padding:3px 10px;font-size:10px;border:1px solid ${_contFiltroStatus===f?'#1d4ed8':'#e2e8f0'};border-radius:5px;background:${_contFiltroStatus===f?'#eff6ff':'#fff'};color:${_contFiltroStatus===f?'#1d4ed8':'#64748b'};cursor:pointer;font-weight:600">${f}</button>`).join('')}
    </div>
  </div>`;

  document.getElementById('cont-cards').innerHTML = acoes + (lista.length ? cards : '<div style="padding:24px;text-align:center;color:#94a3b8;font-size:12px">Nenhum contrato encontrado.</div>');

  // Carrega o painel de saúde assincronamente
  loadSaudeContratos();
}

// ─── Novo Contrato: modal de criação ─────────────────────────────
function abrirNovoContrato() {
  const html = `
    <div id="modal-novo-cont" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center">
      <div style="background:#fff;border-radius:12px;padding:24px;width:100%;max-width:520px;box-shadow:0 20px 60px rgba(0,0,0,.3);max-height:90vh;overflow-y:auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <h3 style="margin:0;font-size:15px;color:#0f172a;font-weight:800">➕ Novo Contrato</h3>
          <button onclick="document.getElementById('modal-novo-cont').remove()" style="background:none;border:none;font-size:20px;cursor:pointer;color:#94a3b8">×</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div style="grid-column:1/-1"><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">NÚMERO DO CONTRATO *</label><input id="nc-num" style="${inputSt}" placeholder="ex: SESAU 178/2022"></div>
          <div style="grid-column:1/-1"><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">NOME / DESCRIÇÃO *</label><input id="nc-nome" style="${inputSt}" placeholder="ex: Limpeza e Higienização SESAU"></div>
          <div style="grid-column:1/-1"><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">ÓRGÃO / CONTRATANTE</label><input id="nc-orgao" style="${inputSt}" placeholder="ex: Secretaria da Saúde do Tocantins"></div>
          <div><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">VIGÊNCIA INÍCIO</label><input id="nc-vi" style="${inputSt}" placeholder="dd/mm/aaaa"></div>
          <div><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">VIGÊNCIA FIM</label><input id="nc-vf" style="${inputSt}" placeholder="dd/mm/aaaa"></div>
          <div><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">VALOR MENSAL BRUTO (R$)</label><input id="nc-vb" style="${inputSt}" placeholder="0,00" type="text"></div>
          <div><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">VALOR MENSAL LÍQUIDO (R$)</label><input id="nc-vl" style="${inputSt}" placeholder="0,00" type="text"></div>
          <div><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">STATUS</label>
            <select id="nc-status" style="${inputSt}">
              <option>ATIVO</option><option>EM DIA</option><option>CRÍTICO</option><option>ENCERRADO</option>
            </select>
          </div>
          <div style="grid-column:1/-1"><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">OBSERVAÇÕES</label><textarea id="nc-obs" style="${inputSt};resize:vertical;height:54px" placeholder="Termo aditivo, notas importantes..."></textarea></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button onclick="document.getElementById('modal-novo-cont').remove()" style="padding:7px 18px;border:1px solid #e2e8f0;border-radius:7px;background:#fff;color:#64748b;cursor:pointer;font-size:11px">Cancelar</button>
          <button onclick="salvarNovoContrato()" style="padding:7px 18px;border:none;border-radius:7px;background:#15803d;color:#fff;cursor:pointer;font-size:11px;font-weight:700">Salvar Contrato</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

const inputSt = 'width:100%;padding:6px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:11px;box-sizing:border-box';

async function salvarNovoContrato() {
  const num = document.getElementById('nc-num').value.trim();
  const nome = document.getElementById('nc-nome').value.trim();
  if (!num || !nome) { toast('Número e nome são obrigatórios'); return; }
  const body = {
    numContrato: num, contrato: nome,
    orgao: document.getElementById('nc-orgao').value.trim(),
    vigencia_inicio: document.getElementById('nc-vi').value.trim(),
    vigencia_fim: document.getElementById('nc-vf').value.trim(),
    valor_mensal_bruto: parseValorInput(document.getElementById('nc-vb').value),
    valor_mensal_liquido: parseValorInput(document.getElementById('nc-vl').value),
    status: document.getElementById('nc-status').value,
    obs: document.getElementById('nc-obs').value.trim(),
  };
  const d = await api('/contratos', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  if (d.ok) {
    toast('✅ Contrato criado com sucesso!');
    document.getElementById('modal-novo-cont').remove();
    loadContratos();
  } else {
    toast('Erro: ' + (d.error || 'desconhecido'));
  }
}

// ─── Editar Contrato ──────────────────────────────────────────────
async function abrirEditarContrato(numContrato) {
  const d = await api('/contratos');
  const c = (d.data||[]).find(x => x.numContrato === numContrato);
  if (!c) { toast('Contrato não encontrado'); return; }

  const html = `
    <div id="modal-editar-cont" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center">
      <div style="background:#fff;border-radius:12px;padding:24px;width:100%;max-width:520px;box-shadow:0 20px 60px rgba(0,0,0,.3);max-height:90vh;overflow-y:auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <h3 style="margin:0;font-size:15px;color:#0f172a;font-weight:800">✏️ Editar — ${c.numContrato}</h3>
          <button onclick="document.getElementById('modal-editar-cont').remove()" style="background:none;border:none;font-size:20px;cursor:pointer;color:#94a3b8">×</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div style="grid-column:1/-1"><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">NOME / DESCRIÇÃO *</label><input id="ec-nome" value="${(c.contrato||'').replace(/"/g,'&quot;')}" style="${inputSt}"></div>
          <div style="grid-column:1/-1"><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">ÓRGÃO</label><input id="ec-orgao" value="${(c.orgao||'').replace(/"/g,'&quot;')}" style="${inputSt}"></div>
          <div><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">VIGÊNCIA INÍCIO</label><input id="ec-vi" value="${c.vigencia_inicio||''}" style="${inputSt}"></div>
          <div><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">VIGÊNCIA FIM</label><input id="ec-vf" value="${c.vigencia_fim||''}" style="${inputSt}"></div>
          <div><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">MENSAL BRUTO (R$)</label><input id="ec-vb" value="${c.valor_mensal_bruto>0?c.valor_mensal_bruto.toFixed(2).replace('.',','):''}" style="${inputSt}"></div>
          <div><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">MENSAL LÍQUIDO (R$)</label><input id="ec-vl" value="${c.valor_mensal_liquido>0?c.valor_mensal_liquido.toFixed(2).replace('.',','):''}" style="${inputSt}"></div>
          <div><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">STATUS</label>
            <select id="ec-status" style="${inputSt}">
              ${['ATIVO','EM DIA','CRÍTICO','ENCERRADO','RESCINDIDO'].map(s=>`<option${c.status===s?' selected':''}>${s}</option>`).join('')}
            </select>
          </div>
          <div style="grid-column:1/-1"><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">OBSERVAÇÕES</label><textarea id="ec-obs" style="${inputSt};resize:vertical;height:54px">${c.obs||''}</textarea></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:space-between">
          <button onclick="encerrarContrato('${numContrato.replace(/'/g,"\\'")}',this)" style="padding:7px 16px;border:1px solid #dc2626;border-radius:7px;background:#fff;color:#dc2626;cursor:pointer;font-size:11px">⛔ Encerrar</button>
          <div style="display:flex;gap:8px">
            <button onclick="document.getElementById('modal-editar-cont').remove()" style="padding:7px 18px;border:1px solid #e2e8f0;border-radius:7px;background:#fff;color:#64748b;cursor:pointer;font-size:11px">Cancelar</button>
            <button onclick="salvarEdicaoContrato('${numContrato.replace(/'/g,"\\'")}',this)" style="padding:7px 18px;border:none;border-radius:7px;background:#0284c7;color:#fff;cursor:pointer;font-size:11px;font-weight:700">Salvar</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

async function salvarEdicaoContrato(num, btn) {
  btn.textContent = '...'; btn.disabled = true;
  const body = {
    contrato: document.getElementById('ec-nome').value.trim(),
    orgao: document.getElementById('ec-orgao').value.trim(),
    vigencia_inicio: document.getElementById('ec-vi').value.trim(),
    vigencia_fim: document.getElementById('ec-vf').value.trim(),
    valor_mensal_bruto: parseValorInput(document.getElementById('ec-vb').value),
    valor_mensal_liquido: parseValorInput(document.getElementById('ec-vl').value),
    status: document.getElementById('ec-status').value,
    obs: document.getElementById('ec-obs').value.trim(),
  };
  const d = await api('/contratos/'+encodeURIComponent(num), { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  if (d.ok) {
    toast('✅ Contrato atualizado!');
    document.getElementById('modal-editar-cont').remove();
    loadContratos();
  } else {
    toast('Erro: '+(d.error||'desconhecido'));
    btn.textContent = 'Salvar'; btn.disabled = false;
  }
}

async function encerrarContrato(num, btn) {
  if (!confirm(`Encerrar o contrato "${num}"? O status será alterado para ENCERRADO.`)) return;
  btn.textContent = '...'; btn.disabled = true;
  const d = await api('/contratos/'+encodeURIComponent(num), { method:'DELETE' });
  if (d.ok) {
    toast('Contrato encerrado.');
    document.getElementById('modal-editar-cont').remove();
    loadContratos();
  } else {
    toast('Erro: '+(d.error||'desconhecido'));
    btn.textContent = '⛔ Encerrar'; btn.disabled = false;
  }
}

// ─── Classificar TODOS os créditos ───────────────────────────────
async function classificarTodosCreditos() {
  toast('Classificando todos os créditos pendentes...');
  try {
    const d = await api('/extratos/classificar-todos', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    if (d.ok) {
      toast(`✅ ${d.atualizados} lançamentos classificados (de ${d.analisados} analisados)`);
      await loadSaudeContratos();
    } else {
      toast('Erro: '+(d.error||'desconhecido'));
    }
  } catch(e) { toast('Erro: '+e.message); }
}

// ─── Nova Parcela ─────────────────────────────────────────────────
function abrirNovaParcela(numEncoded) {
  const num = decodeURIComponent(numEncoded);
  const html = `
    <div id="modal-nova-parc" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center">
      <div style="background:#fff;border-radius:12px;padding:24px;width:100%;max-width:420px;box-shadow:0 20px 60px rgba(0,0,0,.3)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <h3 style="margin:0;font-size:14px;font-weight:800;color:#0f172a">➕ Nova Parcela — ${num}</h3>
          <button onclick="document.getElementById('modal-nova-parc').remove()" style="background:none;border:none;font-size:20px;cursor:pointer;color:#94a3b8">×</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div style="grid-column:1/-1"><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">COMPETÊNCIA * (ex: 2025-04 ou Abr/2025)</label><input id="np-comp" style="${inputSt}" placeholder="2025-04"></div>
          <div><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">VALOR BRUTO (R$)</label><input id="np-vb" style="${inputSt}" placeholder="0,00"></div>
          <div><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">VALOR LÍQUIDO (R$)</label><input id="np-vl" style="${inputSt}" placeholder="0,00"></div>
          <div><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">VALOR PAGO (R$)</label><input id="np-vp" style="${inputSt}" placeholder="0,00"></div>
          <div><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">DATA PAGAMENTO</label><input id="np-dp" style="${inputSt}" placeholder="dd/mm/aaaa"></div>
          <div><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">STATUS</label>
            <select id="np-status" style="${inputSt}">
              ${PARC_STATUS_OPTIONS.map(s=>`<option>${s}</option>`).join('')}
            </select>
          </div>
          <div style="grid-column:1/-1"><label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:3px">OBS</label><input id="np-obs" style="${inputSt}" placeholder="Observação opcional"></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end">
          <button onclick="document.getElementById('modal-nova-parc').remove()" style="padding:7px 16px;border:1px solid #e2e8f0;border-radius:7px;background:#fff;color:#64748b;cursor:pointer;font-size:11px">Cancelar</button>
          <button onclick="salvarNovaParcela('${numEncoded}',this)" style="padding:7px 16px;border:none;border-radius:7px;background:#15803d;color:#fff;cursor:pointer;font-size:11px;font-weight:700">Salvar Parcela</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

async function salvarNovaParcela(numEncoded, btn) {
  const num = decodeURIComponent(numEncoded);
  const competencia = document.getElementById('np-comp').value.trim();
  if (!competencia) { toast('Competência é obrigatória'); return; }
  btn.textContent = '...'; btn.disabled = true;
  const statusEmoji={PAGO:'✅ PAGO','A RECEBER':'⏳ A RECEBER','EM ATRASO':'🔴 EM ATRASO',PARCIAL:'🧾 PARCIAL','EMITIR NF':'⚠️ EMITIR NF',FUTURO:'⏳ FUTURO','RETENÇÃO':'🧾 RETENÇÃO','TÉRMINO':'🔴 TÉRMINO'};
  const status = document.getElementById('np-status').value;
  const body = {
    competencia,
    valor_bruto: parseValorInput(document.getElementById('np-vb').value),
    valor_liquido: parseValorInput(document.getElementById('np-vl').value),
    valor_pago: parseValorInput(document.getElementById('np-vp').value),
    data_pagamento: document.getElementById('np-dp').value.trim(),
    status: statusEmoji[status] || status,
    obs: document.getElementById('np-obs').value.trim(),
  };
  const d = await api('/contratos/'+encodeURIComponent(num)+'/parcelas', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
  });
  if (d.ok) {
    toast('✅ Parcela criada!');
    document.getElementById('modal-nova-parc').remove();
    const id = num.replace(/[^a-zA-Z0-9]/g,'_');
    delete document.getElementById('parc-'+id)?.dataset?.loaded;
    await renderParcelas(id, numEncoded);
    await loadContratos();
    const el = document.getElementById('parc-'+id);
    if (el) el.style.display='block';
    const arrow = document.getElementById('arrow-'+id);
    if (arrow) arrow.style.transform='rotate(180deg)';
  } else {
    toast('Erro: '+(d.error||'desconhecido'));
    btn.textContent='Salvar Parcela'; btn.disabled=false;
  }
}

async function deletarParcela(parcId, cardId, numEncoded) {
  if (!confirm('Excluir esta parcela? Esta ação não pode ser desfeita.')) return;
  const d = await api('/parcelas/'+parcId, { method:'DELETE' });
  if (d.ok) {
    toast('Parcela excluída.');
    delete document.getElementById('parc-'+cardId)?.dataset?.loaded;
    await renderParcelas(cardId, numEncoded);
    await loadContratos();
    const el = document.getElementById('parc-'+cardId);
    if (el) el.style.display='block';
    const arrow = document.getElementById('arrow-'+cardId);
    if (arrow) arrow.style.transform='rotate(180deg)';
  } else {
    toast('Erro: '+(d.error||'desconhecido'));
  }
}

// ─── Painel de Saúde dos Contratos ───────────────────────────────
const SAUDE_LABEL = {
  ADIMPLENTE:  ['✅ Adimplente',  '#dcfce7','#15803d'],
  A_VENCER:    ['⚠️ A Vencer',    '#fef9c3','#92400e'],
  ATRASADO:    ['🔴 Atrasado',    '#fee2e2','#b91c1c'],
  PENDENTE:    ['⏳ Pendente',    '#f1f5f9','#475569'],
  SEM_DADOS:   ['— Sem dados',    '#f8fafc','#94a3b8'],
  ENCERRADO:   ['⬛ Encerrado',   '#f1f5f9','#64748b'],
};

function saudeBadge(s){
  const [lbl,bg,color]=SAUDE_LABEL[s]||SAUDE_LABEL['SEM_DADOS'];
  return `<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700;background:${bg};color:${color}">${lbl}</span>`;
}

async function loadSaudeContratos(){
  const panel = document.getElementById('cont-saude-panel');
  if(!panel) return;
  panel.innerHTML=`<div style="color:#94a3b8;font-size:11px;padding:8px">Carregando análise de saúde...</div>`;
  try {
    const d = await api('/contratos/saude');
    if(!d.ok) { panel.innerHTML=''; return; }
    const { data=[], resumo={} } = d;
    const ativos = data.filter(r => r.statusSaude !== 'ENCERRADO');

    // KPIs resumidos
    const adimplPct = ativos.length > 0 ? Math.round(resumo.adimplentes/ativos.length*100) : 0;
    const kpiHtml = `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <div style="flex:1;min-width:120px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px">
          <div style="font-size:9px;color:#64748b;font-weight:700;text-transform:uppercase">NFs Emitidas (total)</div>
          <div style="font-size:15px;font-weight:800;color:#1d4ed8">${brl(resumo.total_nfs)}</div>
        </div>
        <div style="flex:1;min-width:120px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px">
          <div style="font-size:9px;color:#64748b;font-weight:700;text-transform:uppercase">Recebido (conciliado)</div>
          <div style="font-size:15px;font-weight:800;color:#15803d">${brl(resumo.total_recebido)}</div>
        </div>
        <div style="flex:1;min-width:120px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px">
          <div style="font-size:9px;color:#64748b;font-weight:700;text-transform:uppercase">Saldo a Receber</div>
          <div style="font-size:15px;font-weight:800;color:${resumo.total_saldo>0?'#dc2626':'#15803d'}">${brl(Math.abs(resumo.total_saldo))}</div>
        </div>
        <div style="flex:1;min-width:120px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px">
          <div style="font-size:9px;color:#64748b;font-weight:700;text-transform:uppercase">Adimplência</div>
          <div style="font-size:15px;font-weight:800;color:${adimplPct>=80?'#15803d':adimplPct>=50?'#d97706':'#dc2626'}">${adimplPct}%</div>
          <div style="font-size:9px;color:#94a3b8">${resumo.adimplentes} adimpl · ${resumo.atrasados} atrasados</div>
        </div>
      </div>`;

    // Tabela por contrato
    const thSt='background:#1e293b;color:#fff;padding:6px 10px;font-size:9px;font-weight:700;text-transform:uppercase;white-space:nowrap';
    const tdSt='padding:5px 10px;border-bottom:1px solid #e2e8f0;font-size:11px;white-space:nowrap';
    const rows = ativos.map(r => {
      const pctConc = r.total_nfs_bruto > 0 ? Math.round(r.total_recebido/r.total_nfs_bruto*100) : 0;
      const barColor = pctConc>=80?'#15803d':pctConc>=50?'#d97706':'#dc2626';
      const ultimaData = r.ultimo_pagamento
        ? new Date(r.ultimo_pagamento).toLocaleDateString('pt-BR')
        : (r.ultima_nf_data ? '— (NF '+new Date(r.ultima_nf_data).toLocaleDateString('pt-BR')+')' : '—');
      return `<tr>
        <td style="${tdSt};font-weight:700;max-width:180px;overflow:hidden;text-overflow:ellipsis" title="${r.contrato}">${r.contrato}</td>
        <td style="${tdSt};text-align:center">${saudeBadge(r.statusSaude)}</td>
        <td style="${tdSt};text-align:right;font-family:monospace">${brl(r.total_nfs_bruto)}</td>
        <td style="${tdSt};text-align:right;font-family:monospace;color:#15803d">${brl(r.total_recebido)}</td>
        <td style="${tdSt};text-align:right;font-family:monospace;color:${r.saldo_a_receber>0?'#dc2626':'#94a3b8'}">${brl(Math.abs(r.saldo_a_receber))}</td>
        <td style="${tdSt};text-align:center">
          <div style="display:flex;align-items:center;gap:6px">
            <div style="background:#e2e8f0;border-radius:4px;height:6px;width:60px;overflow:hidden">
              <div style="background:${barColor};height:100%;width:${Math.min(pctConc,100)}%"></div>
            </div>
            <span style="font-size:10px;color:#475569">${pctConc}%</span>
          </div>
        </td>
        <td style="${tdSt};text-align:right;font-family:monospace;color:#475569">${brl(r.valor_mensal_bruto)}</td>
        <td style="${tdSt};text-align:center;color:#64748b;font-size:10px">${ultimaData}</td>
        <td style="${tdSt};text-align:center"><span style="font-size:10px;color:#94a3b8">${r.qtd_nfs}</span></td>
      </tr>`;
    }).join('');

    const tableHtml = ativos.length ? `
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="${thSt};text-align:left">Contrato</th>
            <th style="${thSt};text-align:center">Saúde</th>
            <th style="${thSt};text-align:right">NFs Emitidas</th>
            <th style="${thSt};text-align:right">Recebido</th>
            <th style="${thSt};text-align:right">Saldo</th>
            <th style="${thSt};text-align:center">% Recebido</th>
            <th style="${thSt};text-align:right">Mensal Bruto</th>
            <th style="${thSt};text-align:center">Último Pgto</th>
            <th style="${thSt};text-align:center">NFs</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : '<div style="padding:12px;color:#94a3b8;font-size:11px">Nenhum contrato ativo encontrado.</div>';

    const btnClassificar = `<button onclick="classificarTodosCreditos()" style="padding:4px 12px;font-size:10px;border:1px solid #7c3aed;border-radius:5px;background:#f5f3ff;color:#7c3aed;cursor:pointer;font-weight:600;margin-left:8px">🏷 Classificar Todos</button>`;

    panel.innerHTML = `
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:4px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h3 style="margin:0;font-size:13px;color:#0f172a;font-weight:700">📊 Saúde dos Contratos</h3>
          <div>
            <button onclick="loadSaudeContratos()" style="padding:4px 12px;font-size:10px;border:1px solid #0284c7;border-radius:5px;background:#f0f9ff;color:#0284c7;cursor:pointer;font-weight:600">↻ Atualizar</button>
            ${btnClassificar}
          </div>
        </div>
        ${kpiHtml}
        ${tableHtml}
      </div>`;
  } catch(e) {
    panel.innerHTML='';
    console.error('saude contratos:', e);
  }
}

async function classificarInternoInvestimento(){
  toast('Classificando créditos INTERNO e INVESTIMENTO...');
  try {
    const d = await api('/extratos/classificar-interno', { method:'POST' });
    if(d.ok){
      toast(`✅ Classificados: ${d.marcados_interno} INTERNO + ${d.marcados_investimento} INVESTIMENTO`);
      await loadSaudeContratos();
    } else {
      toast('Erro ao classificar: '+(d.error||'desconhecido'));
    }
  } catch(e) { toast('Erro: '+e.message); }
}

const PARC_STATUS_OPTIONS=['PAGO','A RECEBER','EM ATRASO','PARCIAL','EMITIR NF','FUTURO','RETENÇÃO','TÉRMINO'];

async function toggleParcelas(id, numEncoded){
  const el=document.getElementById('parc-'+id);
  const arrow=document.getElementById('arrow-'+id);
  if(el.style.display!=='none'){
    el.style.display='none';
    arrow.style.transform='rotate(0deg)';
    return;
  }
  arrow.style.transform='rotate(180deg)';
  el.style.display='block';
  if(el.dataset.loaded){ return; }
  await renderParcelas(id, numEncoded);
}

async function renderParcelas(id, numEncoded){
  const el=document.getElementById('parc-'+id);
  el.innerHTML='<div style="padding:16px;color:#94a3b8;font-size:11px">Carregando parcelas...</div>';
  const num=decodeURIComponent(numEncoded);
  const d=await api('/contratos/'+encodeURIComponent(num)+'/parcelas');
  const rows=(d.data||[]);
  if(!rows.length){
    el.innerHTML='<div style="padding:16px;color:#94a3b8;font-size:11px">Nenhuma parcela cadastrada</div>';
    el.dataset.loaded='1';
    return;
  }
  const thSt='background:#e2e8f0;padding:6px 10px;font-size:9px;color:#475569;font-weight:700;text-transform:uppercase';
  el.innerHTML=`<div style="overflow-x:auto;padding:8px 12px 12px">
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
      <button onclick="abrirNovaParcela('${numEncoded}')" style="padding:4px 12px;font-size:10px;border:none;border-radius:6px;background:#15803d;color:#fff;cursor:pointer;font-weight:700">➕ Nova Parcela</button>
    </div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr>
        <th style="${thSt};text-align:left">Competência</th>
        <th style="${thSt};text-align:right">Valor Líquido</th>
        <th style="${thSt};text-align:right">Valor Bruto</th>
        <th style="${thSt};text-align:right">Valor Pago</th>
        <th style="${thSt};text-align:center">Data Pgto</th>
        <th style="${thSt};text-align:center">Status</th>
        <th style="${thSt};text-align:left">Obs</th>
        <th style="${thSt};text-align:center;width:80px">Ação</th>
      </tr></thead>
      <tbody>${rows.map(p=>{
        const isPago=p.valor_pago>0;
        const bgRow=isPago?'#f0fdf4':'';
        const tdSt='padding:5px 10px;border-bottom:1px solid #e2e8f0;font-size:11px';
        const selOpts=PARC_STATUS_OPTIONS.map(s=>{
          const sel=p.status.includes(s)?'selected':'';
          return `<option value="${s}" ${sel}>${s}</option>`;
        }).join('');
        return `<tr style="background:${bgRow}" id="parc-row-${p.id}">
          <td style="${tdSt};font-weight:600">${p.competencia}</td>
          <td style="${tdSt};text-align:right;font-family:monospace">${brl(p.valor_liquido)}</td>
          <td style="${tdSt};text-align:right;font-family:monospace;color:#94a3b8">${brl(p.valor_bruto)}</td>
          <td style="${tdSt};text-align:right">
            <input type="text" value="${p.valor_pago>0?p.valor_pago.toFixed(2).replace('.',','):''}" id="pv-${p.id}"
              style="width:100px;padding:3px 6px;font-size:10px;font-family:monospace;border:1px solid #e2e8f0;border-radius:4px;text-align:right;background:#fff;color:${isPago?'#15803d':'#475569'}"
              placeholder="0,00">
          </td>
          <td style="${tdSt};text-align:center">
            <input type="text" value="${p.data_pagamento||''}" id="pd-${p.id}"
              style="width:90px;padding:3px 6px;font-size:10px;border:1px solid #e2e8f0;border-radius:4px;text-align:center;background:#fff;color:#64748b"
              placeholder="dd/mm/aaaa">
          </td>
          <td style="${tdSt};text-align:center">
            <select id="ps-${p.id}" style="padding:3px 6px;font-size:9px;font-weight:600;border:1px solid #e2e8f0;border-radius:4px;background:#fff;color:#334155;cursor:pointer">
              ${selOpts}
            </select>
          </td>
          <td style="${tdSt};max-width:160px">
            <input type="text" value="${(p.obs||'').replace(/"/g,'&quot;')}" id="po-${p.id}"
              style="width:100%;padding:3px 6px;font-size:10px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;color:#94a3b8"
              placeholder="Observação">
          </td>
          <td style="${tdSt};text-align:center">
            <div style="display:flex;gap:4px;justify-content:center">
              <button onclick="saveParcela(${p.id},'${id}','${numEncoded}')"
                style="padding:3px 8px;font-size:9px;font-weight:700;border:1px solid #93c5fd;border-radius:5px;background:#eff6ff;color:#1d4ed8;cursor:pointer"
                title="Salvar">💾</button>
              <button onclick="deletarParcela(${p.id},'${id}','${numEncoded}')"
                style="padding:3px 8px;font-size:9px;font-weight:700;border:1px solid #fca5a5;border-radius:5px;background:#fff1f2;color:#dc2626;cursor:pointer"
                title="Excluir parcela">🗑</button>
            </div>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table>
  </div>`;
  el.dataset.loaded='1';
}

function parseValorInput(v){
  if(!v||!v.trim()) return 0;
  return parseFloat(v.replace(/\./g,'').replace(',','.'))||0;
}

async function saveParcela(parcId, cardId, numEncoded){
  const status=document.getElementById('ps-'+parcId).value;
  const valorPago=parseValorInput(document.getElementById('pv-'+parcId).value);
  const dataPgto=document.getElementById('pd-'+parcId).value.trim();
  const obs=document.getElementById('po-'+parcId).value.trim();

  const btn=event.target;
  btn.textContent='...';
  btn.disabled=true;

  const statusEmoji={PAGO:'✅ PAGO','A RECEBER':'⏳ A RECEBER','EM ATRASO':'🔴 EM ATRASO',PARCIAL:'🧾 PARCIAL','EMITIR NF':'⚠️ EMITIR NF',FUTURO:'⏳ FUTURO','RETENÇÃO':'🧾 RETENÇÃO','TÉRMINO':'🔴 TÉRMINO'};

  await api('/parcelas/'+parcId,{
    method:'PATCH',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({status:statusEmoji[status]||status, valor_pago:valorPago, data_pagamento:dataPgto, obs})
  });

  // Refresh parcelas table and contract cards
  delete document.getElementById('parc-'+cardId).dataset.loaded;
  await renderParcelas(cardId, numEncoded);
  await loadContratos();
  // Re-open this card
  const el=document.getElementById('parc-'+cardId);
  if(el) el.style.display='block';
  const arrow=document.getElementById('arrow-'+cardId);
  if(arrow) arrow.style.transform='rotate(180deg)';
}

// ─── Pagamentos ──────────────────────────────────────────────────
async function loadPagamentos(){
  let url=`/pagamentos?page=${_pagPage}&limit=${PAGE_SIZE}`;
  if(_from)url+='&from='+_from;
  if(_to)url+='&to='+_to;
  const d=await api(url);
  document.getElementById('pag-head').innerHTML=`<tr><th>OB</th><th>Gestão</th><th>Empenho</th><th>Favorecido</th><th>Data Pgto</th><th class="r">Valor Pago</th></tr>`;
  document.getElementById('pag-body').innerHTML=(d.data||[]).map(r=>`<tr>
    <td class="mono" style="color:#1d4ed8;font-weight:600">${r.ob||''}</td>
    <td style="font-size:10px;color:#475569;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.gestao||''}</td>
    <td class="mono muted">${r.empenho||''}</td>
    <td style="font-size:10px;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.favorecido||''}</td>
    <td style="font-size:10px;color:#64748b">${r.data_pagamento||''}</td>
    <td class="r mono green" style="font-weight:700">${brl(r.valor_pago)}</td>
  </tr>`).join('');
  document.getElementById('pag-counter').textContent=`${d.total} pagamentos`;
  document.getElementById('pag-pag').innerHTML=`
    <button ${d.page<=1?'disabled':''} onclick="_pagPage--;loadPagamentos()">← Anterior</button>
    <span>Página ${d.page} de ${d.pages}</span>
    <button ${d.page>=d.pages?'disabled':''} onclick="_pagPage++;loadPagamentos()">Próxima →</button>
    <button onclick="exportarExcel('pagamentos')" style="margin-left:10px;padding:4px 12px;font-size:10px;border:1px solid #15803d;border-radius:5px;background:#f0fdf4;color:#15803d;cursor:pointer;font-weight:600">⬇ Excel</button>`;
}

// ─── Despesas ────────────────────────────────────────────────────
const DESP_CATS=['FORNECEDOR','SERVICO','FOLHA','ENCARGOS','IMPOSTO','CONTRIBUICAO','Material Limpeza','EPI/Ferramentas','OUTROS'];
const DESP_CAT_LABELS={FORNECEDOR:'Fornecedor',SERVICO:'Serviço PJ',FOLHA:'Folha Pgto',ENCARGOS:'Encargos',IMPOSTO:'Imposto',CONTRIBUICAO:'Contribuição','Material Limpeza':'🧹 Mat. Limpeza','EPI/Ferramentas':'🦺 EPI/Ferramentas',OUTROS:'Outros'};
const DESP_CAT_COLORS={FORNECEDOR:'#1d4ed8',SERVICO:'#7c3aed',FOLHA:'#d97706',ENCARGOS:'#dc2626',IMPOSTO:'#475569',CONTRIBUICAO:'#0891b2','Material Limpeza':'#059669','EPI/Ferramentas':'#d97706',OUTROS:'#64748b'};
let _despPage=1;

function despCatBadge(cat){
  const c=DESP_CAT_COLORS[cat]||'#64748b';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:600;color:${c};background:${c}18;border:1px solid ${c}40">${DESP_CAT_LABELS[cat]||cat}</span>`;
}
function despStatusBadge(st){
  if(st==='PAGO') return badge('PAGO','green');
  if(st==='PENDENTE') return badge('PENDENTE','amber');
  if(st==='A_PAGAR') return badge('A Pagar','blue');
  if(st==='VENCIDO') return badge('VENCIDO','red');
  return badge(st||'—','gray');
}

let _despFiltersRendered=false;
async function loadDespesas(){
  // Render filters only once
  if(!_despFiltersRendered){
    document.getElementById('desp-filters').innerHTML=`
      <div><label>Categoria</label><select id="df-cat" onchange="_despPage=1;loadDespData()"><option value="">Todas</option>${DESP_CATS.map(c=>`<option value="${c}">${DESP_CAT_LABELS[c]||c}</option>`).join('')}</select></div>
      <div><label>Fornecedor</label><select id="df-forn" onchange="_despPage=1;loadDespData()"><option value="">Todos</option><option value="NEVADA EMBALAGENS e PRODUTOS DE LIMPEZA EIRELI -ME">🧹 Nevada</option><option value="MONTREAL MAQUINAS E FERRAMENTAS LTDA">🦺 Montreal</option></select></div>
      <div><label>Status</label><select id="df-st" onchange="_despPage=1;loadDespData()"><option value="">Todos</option><option value="PENDENTE">Pendente</option><option value="A_PAGAR">A Pagar</option><option value="PAGO">Pago</option><option value="VENCIDO">Vencido</option></select></div>
      <div><label>De</label><input type="date" id="df-de" onchange="_despPage=1;loadDespData()"></div>
      <div><label>Até</label><input type="date" id="df-ate" onchange="_despPage=1;loadDespData()"></div>
    `;
    // Forçar reset para evitar restauração do navegador
    document.getElementById('df-cat').value='';
    document.getElementById('df-forn').value='';
    document.getElementById('df-st').value='';
    document.getElementById('df-de').value='';
    document.getElementById('df-ate').value='';
    _despFiltersRendered=true;
  }
  await loadDespData();
}
async function loadDespData(){
  let url=`/despesas?page=${_despPage}&limit=${PAGE_SIZE}`;
  const cat=document.getElementById('df-cat')?.value;
  const forn=document.getElementById('df-forn')?.value;
  const st=document.getElementById('df-st')?.value;
  const de=document.getElementById('df-de')?.value||_from;
  const ate=document.getElementById('df-ate')?.value||_to;
  if(cat)url+='&categoria='+encodeURIComponent(cat);
  if(forn)url+='&fornecedor='+encodeURIComponent(forn);
  if(st)url+='&status='+st;
  if(de)url+='&from='+de;
  if(ate)url+='&to='+ate;

  let resumoUrl='/despesas/resumo';
  const resumoParams=[];
  if(de) resumoParams.push('from='+de);
  if(ate) resumoParams.push('to='+ate);
  if(resumoParams.length) resumoUrl+='?'+resumoParams.join('&');

  let apuracaoUrl='/apuracao-caixa';
  const apParams=[];
  if(de) apParams.push('from='+de);
  if(ate) apParams.push('to='+ate);
  if(apParams.length) apuracaoUrl+='?'+apParams.join('&');

  const [d, resumo, comp] = await Promise.all([
    api(url),
    api(resumoUrl),
    api(apuracaoUrl)
  ]);

  const t=resumo.totais;
  document.getElementById('desp-total-count').textContent=t.total;
  document.getElementById('desp-pend-count').textContent=t.pendentes;

  // KPIs
  document.getElementById('desp-kpis').innerHTML=`
    <div class="kpi"><div class="kpi-l">Total Despesas</div><div class="kpi-v red">${brl(t.total_bruto)}</div><div class="kpi-s">${t.total} lançamentos</div></div>
    <div class="kpi"><div class="kpi-l">Retenções Feitas</div><div class="kpi-v blue">${brl(t.total_retencoes)}</div><div class="kpi-s">IRRF+CSLL+PIS+COFINS+INSS</div></div>
    <div class="kpi"><div class="kpi-l">Líquido a Pagar</div><div class="kpi-v amber">${brl(t.total_liquido)}</div><div class="kpi-s">${t.pagos} pagos · ${t.pendentes} pendentes</div></div>
    <div class="kpi"><div class="kpi-l">PIS a Pagar (Caixa)</div><div class="kpi-v ${comp.pis_a_pagar>0?'red':'green'}">${brl(comp.pis_a_pagar)}</div><div class="kpi-s">1,65% s/ recebido</div></div>
    <div class="kpi"><div class="kpi-l">COFINS a Pagar (Caixa)</div><div class="kpi-v ${comp.cofins_a_pagar>0?'red':'green'}">${brl(comp.cofins_a_pagar)}</div><div class="kpi-s">7,60% s/ recebido</div></div>
  `;

  // Painel Apuração PIS/COFINS — Regime de Caixa
  function statusBadgePgto(st){
    if(st==='PAGO') return '<span style="padding:1px 6px;border-radius:4px;font-size:9px;font-weight:700;background:#dcfce7;color:#15803d;border:1px solid #86efac">PAGO</span>';
    if(st==='VENCIDO') return '<span style="padding:1px 6px;border-radius:4px;font-size:9px;font-weight:700;background:#fee2e2;color:#dc2626;border:1px solid #fca5a5">VENCIDO</span>';
    return '<span style="padding:1px 6px;border-radius:4px;font-size:9px;font-weight:700;background:#fefce8;color:#d97706;border:1px solid #fde68a">A PAGAR</span>';
  }
  function fmtVenc(v){if(!v)return'';const p=v.split('-');return p[2]+'/'+p[1]+'/'+p[0];}
  const mesRows=(comp.por_mes||[]).map(m=>`<tr style="background:${m.status==='PAGO'?'#f0fdf4':''}">
    <td style="padding:4px 10px;font-size:11px;font-weight:600;border-bottom:1px solid #e2e8f0">${m.mes}/${m.ano}</td>
    <td style="padding:4px 10px;font-size:11px;font-family:monospace;text-align:right;border-bottom:1px solid #e2e8f0">${brl(m.recebido)}</td>
    <td style="padding:4px 10px;font-size:11px;text-align:center;border-bottom:1px solid #e2e8f0;color:#64748b">${m.qtd}</td>
    <td style="padding:4px 10px;font-size:11px;font-family:monospace;text-align:right;border-bottom:1px solid #e2e8f0;color:#d97706" title="Bruto: ${brl(m.pis_bruto)} - Crédito: ${brl(m.pis_credito)}">${brl(m.pis)}</td>
    <td style="padding:4px 10px;font-size:11px;font-family:monospace;text-align:right;border-bottom:1px solid #e2e8f0;color:#dc2626" title="Bruto: ${brl(m.cofins_bruto)} - Crédito: ${brl(m.cofins_credito)}">${brl(m.cofins)}</td>
    <td style="padding:4px 10px;font-size:11px;text-align:center;border-bottom:1px solid #e2e8f0;color:#64748b">${fmtVenc(m.vencimento)}</td>
    <td style="padding:4px 10px;font-size:11px;text-align:center;border-bottom:1px solid #e2e8f0">${statusBadgePgto(m.status)}</td>
  </tr>`).join('');

  document.getElementById('desp-compensacao').innerHTML=`
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:12px">
      <div style="font-size:13px;font-weight:700;color:#0f172a;margin-bottom:10px">Apuração PIS/COFINS — Regime de Caixa (Efetivo Recebimento)</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px">
        <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:12px">
          <div style="font-size:9px;color:#64748b;font-weight:600;text-transform:uppercase;margin-bottom:6px">Receita Efetivamente Recebida</div>
          <div style="font-size:16px;font-weight:800;color:#1d4ed8">${brl(comp.receita_recebida)}</div>
          <div style="font-size:9px;color:#94a3b8;margin-top:2px">${comp.qtd_creditos} créditos de contratos (comp. 2026+)</div>
          ${comp.excluido_total>0?`<div style="font-size:8px;color:#d97706;margin-top:2px">Excluído: ${brl(comp.excluido_total)} (${comp.excluido_qtd} transf. internas / comp. 2025)</div>`:''}
        </div>
        <div style="background:#fefce8;border:1px solid #fde68a;border-radius:8px;padding:12px">
          <div style="font-size:9px;color:#64748b;font-weight:600;text-transform:uppercase;margin-bottom:4px">PIS Devido (1,65%)</div>
          <div style="font-size:13px;font-weight:700;color:#d97706">${brl(comp.pis_devido)}</div>
          <div style="font-size:9px;color:#15803d;margin-top:2px">(-) Retido na fonte: ${brl(comp.pis_retido)}</div>
          <div style="font-size:11px;font-weight:700;color:${comp.pis_a_pagar>0?'#dc2626':'#15803d'};margin-top:2px">= ${comp.pis_a_pagar>0?'A pagar':'Crédito'}: ${brl(comp.pis_a_pagar>0?comp.pis_a_pagar:comp.pis_credito)}</div>
        </div>
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px">
          <div style="font-size:9px;color:#64748b;font-weight:600;text-transform:uppercase;margin-bottom:4px">COFINS Devida (7,6%)</div>
          <div style="font-size:13px;font-weight:700;color:#dc2626">${brl(comp.cofins_devido)}</div>
          <div style="font-size:9px;color:#15803d;margin-top:2px">(-) Retido na fonte: ${brl(comp.cofins_retido)}</div>
          <div style="font-size:11px;font-weight:700;color:${comp.cofins_a_pagar>0?'#dc2626':'#15803d'};margin-top:2px">= ${comp.cofins_a_pagar>0?'A pagar':'Crédito'}: ${brl(comp.cofins_a_pagar>0?comp.cofins_a_pagar:comp.cofins_credito)}</div>
        </div>
      </div>
      ${mesRows?`<div style="margin-top:12px">
        <div style="font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;margin-bottom:6px">Detalhamento por Mês</div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr>
            <th style="padding:4px 10px;font-size:9px;color:#475569;font-weight:700;text-align:left;background:#f1f5f9">COMPETÊNCIA</th>
            <th style="padding:4px 10px;font-size:9px;color:#475569;font-weight:700;text-align:right;background:#f1f5f9">RECEBIDO</th>
            <th style="padding:4px 10px;font-size:9px;color:#475569;font-weight:700;text-align:center;background:#f1f5f9">CRÉDITOS</th>
            <th style="padding:4px 10px;font-size:9px;color:#475569;font-weight:700;text-align:right;background:#f1f5f9">PIS LÍQUIDO</th>
            <th style="padding:4px 10px;font-size:9px;color:#475569;font-weight:700;text-align:right;background:#f1f5f9">COFINS LÍQUIDO</th>
            <th style="padding:4px 10px;font-size:9px;color:#475569;font-weight:700;text-align:center;background:#f1f5f9">VENCIMENTO</th>
            <th style="padding:4px 10px;font-size:9px;color:#475569;font-weight:700;text-align:center;background:#f1f5f9">STATUS</th>
          </tr></thead>
          <tbody>${mesRows}</tbody>
        </table>
      </div>`:''}
      <div style="margin-top:8px;font-size:9px;color:#94a3b8">* Lucro Real — Regime Não-Cumulativo — Caixa: PIS 1,65% + COFINS 7,6% sobre o efetivo recebimento. Retenções na fonte (0,65% + 3% — tomadores federais) são créditos deduzidos. Créditos de insumos (Módulo 1 de contratos) podem reduzir adicionalmente o saldo a recolher.</div>
    </div>
  `;

  // Por Categoria (mini bar)
  if(resumo.porCategoria.length){
    const maxCat=Math.max(...resumo.porCategoria.map(c=>c.total));
    const catsHtml=resumo.porCategoria.map(c=>{
      const pct=maxCat>0?((c.total/maxCat)*100):0;
      const color=DESP_CAT_COLORS[c.categoria]||'#64748b';
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span style="font-size:10px;font-weight:600;color:#475569;width:90px;text-align:right">${DESP_CAT_LABELS[c.categoria]||c.categoria}</span>
        <div style="flex:1;background:#f1f5f9;border-radius:4px;height:14px;overflow:hidden"><div style="background:${color};height:100%;width:${pct}%;border-radius:4px"></div></div>
        <span style="font-size:10px;font-weight:700;color:#475569;width:110px">${brl(c.total)} (${c.qtd})</span>
      </div>`;
    }).join('');
    document.getElementById('desp-kpis').innerHTML+=`<div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px;flex:2;min-width:300px"><div style="font-size:10px;font-weight:600;color:#64748b;text-transform:uppercase;margin-bottom:6px">Por Categoria</div>${catsHtml}</div>`;
  }

  // Table
  document.getElementById('desp-head').innerHTML=`<tr>
    <th>Data</th><th>Categoria</th><th>Contrato</th><th>Descrição</th>
    <th class="r">Bruto</th><th class="r">Retenção</th><th class="r">Líquido</th><th>Status</th><th>Ações</th>
  </tr>`;
  document.getElementById('desp-body').innerHTML=(d.data||[]).map(r=>{
    const cName=(r.contrato_vinculado||'').replace(/\s*—.*$/,'');
    return `<tr>
    <td style="font-size:10px;color:#64748b;white-space:nowrap">${r.data_despesa||''}</td>
    <td>${despCatBadge(r.categoria)}</td>
    <td style="font-size:10px;font-weight:600;color:#1d4ed8;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.contrato_vinculado||''}">${cName||'—'}</td>
    <td style="font-size:10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(r.descricao||'').replace(/"/g,'&quot;')}">${r.descricao||'—'}</td>
    <td class="r mono" style="font-weight:600">${brl(r.valor_bruto)}</td>
    <td class="r mono" style="color:#d97706;font-size:10px" title="IRRF ${brl(r.irrf)} · CSLL ${brl(r.csll)} · PIS ${brl(r.pis_retido)} · COFINS ${brl(r.cofins_retido)} · INSS ${brl(r.inss_retido)}">${brl(r.total_retencao)}</td>
    <td class="r mono" style="font-weight:700;color:#15803d">${brl(r.valor_liquido)}</td>
    <td>${despStatusBadge(r.status)}</td>
    <td style="white-space:nowrap">
      <select onchange="updateDespStatus(${r.id},this.value)" style="padding:2px 6px;font-size:9px;border:1px solid #e2e8f0;border-radius:4px;cursor:pointer">
        <option value="PENDENTE" ${r.status==='PENDENTE'?'selected':''}>Pendente</option>
        <option value="A_PAGAR" ${r.status==='A_PAGAR'?'selected':''}>A Pagar</option>
        <option value="PAGO" ${r.status==='PAGO'?'selected':''}>Pago</option>
        <option value="VENCIDO" ${r.status==='VENCIDO'?'selected':''}>Vencido</option>
      </select>
      <button onclick="delDesp(${r.id})" style="padding:2px 6px;font-size:9px;border:1px solid #fca5a5;border-radius:4px;background:#fee2e2;color:#dc2626;cursor:pointer;margin-left:4px" title="Excluir">✕</button>
    </td>
  </tr>`;}).join('');

  document.getElementById('desp-pag').innerHTML=`
    <button ${d.page<=1?'disabled':''} onclick="_despPage--;loadDespData()">← Anterior</button>
    <span>Página ${d.page} de ${d.pages} (${d.total} registros)</span>
    <button ${d.page>=d.pages?'disabled':''} onclick="_despPage++;loadDespData()">Próxima →</button>
    <button onclick="exportarExcel('despesas')" style="margin-left:10px;padding:4px 12px;font-size:10px;border:1px solid #0891b2;border-radius:5px;background:#f0f9ff;color:#0891b2;cursor:pointer;font-weight:600">⬇ Excel</button>`;
}

async function updateDespStatus(id,status){
  await api('/despesas/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status})});
  loadDespData();
}
async function delDesp(id){
  if(!confirm('Excluir esta despesa?'))return;
  await api('/despesas/'+id,{method:'DELETE'});
  loadDespData();
}

async function excluirNf(id, numero){
  if(!confirm(`Excluir NF ${numero}?\nEsta ação não pode ser desfeita.`))return;
  const r=await api('/nfs/'+id,{method:'DELETE'});
  if(r.ok){ toast('NF excluída'); loadNfs(); loadDashboard(); }
  else toast(r.error||'Erro ao excluir','error');
}

// Form nova despesa
const RETENCAO_SERVICO_FE={irrf:0.015,csll:0.01,pis:0.0065,cofins:0.03,inss:0.11};
function toggleDespForm(){
  const w=document.getElementById('desp-form-wrap');
  if(w.style.display!=='none'){w.style.display='none';return;}
  w.style.display='block';
  w.innerHTML=`
    <div style="background:#fff;border:1px solid #93c5fd;border-radius:10px;padding:16px;margin-bottom:12px">
      <div style="font-size:13px;font-weight:700;color:#1d4ed8;margin-bottom:12px">+ Novo Lançamento de Despesa</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">
        <div><label style="font-size:9px;color:#64748b;font-weight:600;display:block;margin-bottom:2px">CATEGORIA</label>
          <select id="nd-cat" onchange="calcRetFe()" style="width:100%;padding:6px;font-size:11px;border:1px solid #e2e8f0;border-radius:6px">
            ${DESP_CATS.map(c=>`<option value="${c}">${DESP_CAT_LABELS[c]}</option>`).join('')}
          </select></div>
        <div><label style="font-size:9px;color:#64748b;font-weight:600;display:block;margin-bottom:2px">FORNECEDOR</label>
          <input id="nd-forn" style="width:100%;padding:6px;font-size:11px;border:1px solid #e2e8f0;border-radius:6px" placeholder="Nome do fornecedor"></div>
        <div><label style="font-size:9px;color:#64748b;font-weight:600;display:block;margin-bottom:2px">CNPJ</label>
          <input id="nd-cnpj" style="width:100%;padding:6px;font-size:11px;border:1px solid #e2e8f0;border-radius:6px" placeholder="00.000.000/0000-00"></div>
        <div><label style="font-size:9px;color:#64748b;font-weight:600;display:block;margin-bottom:2px">NF / DOC</label>
          <input id="nd-nf" style="width:100%;padding:6px;font-size:11px;border:1px solid #e2e8f0;border-radius:6px" placeholder="Número"></div>
        <div><label style="font-size:9px;color:#64748b;font-weight:600;display:block;margin-bottom:2px">DATA</label>
          <input id="nd-data" type="date" style="width:100%;padding:6px;font-size:11px;border:1px solid #e2e8f0;border-radius:6px"></div>
        <div><label style="font-size:9px;color:#64748b;font-weight:600;display:block;margin-bottom:2px">COMPETÊNCIA</label>
          <input id="nd-comp" style="width:100%;padding:6px;font-size:11px;border:1px solid #e2e8f0;border-radius:6px" placeholder="mar/26"></div>
        <div><label style="font-size:9px;color:#64748b;font-weight:600;display:block;margin-bottom:2px">VALOR BRUTO (R$)</label>
          <input id="nd-vbruto" type="text" onkeyup="calcRetFe()" style="width:100%;padding:6px;font-size:11px;border:1px solid #e2e8f0;border-radius:6px;font-weight:700" placeholder="0,00"></div>
        <div><label style="font-size:9px;color:#64748b;font-weight:600;display:block;margin-bottom:2px">DESCRIÇÃO</label>
          <input id="nd-desc" style="width:100%;padding:6px;font-size:11px;border:1px solid #e2e8f0;border-radius:6px" placeholder="Descrição da despesa"></div>
      </div>
      <div style="margin-top:10px;padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px">
        <div style="font-size:10px;font-weight:600;color:#64748b;margin-bottom:6px">RETENÇÕES (editáveis — calculadas automaticamente para Serviço PJ)</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <div><label style="font-size:8px;color:#94a3b8">IRRF 1,5%</label><input id="nd-irrf" type="text" style="width:80px;padding:4px;font-size:10px;border:1px solid #e2e8f0;border-radius:4px;text-align:right" value="0,00"></div>
          <div><label style="font-size:8px;color:#94a3b8">CSLL 1%</label><input id="nd-csll" type="text" style="width:80px;padding:4px;font-size:10px;border:1px solid #e2e8f0;border-radius:4px;text-align:right" value="0,00"></div>
          <div><label style="font-size:8px;color:#94a3b8">PIS 0,65%</label><input id="nd-pis" type="text" style="width:80px;padding:4px;font-size:10px;border:1px solid #e2e8f0;border-radius:4px;text-align:right" value="0,00"></div>
          <div><label style="font-size:8px;color:#94a3b8">COFINS 3%</label><input id="nd-cofins" type="text" style="width:80px;padding:4px;font-size:10px;border:1px solid #e2e8f0;border-radius:4px;text-align:right" value="0,00"></div>
          <div><label style="font-size:8px;color:#94a3b8">INSS 11%</label><input id="nd-inss" type="text" style="width:80px;padding:4px;font-size:10px;border:1px solid #e2e8f0;border-radius:4px;text-align:right" value="0,00"></div>
          <div><label style="font-size:8px;color:#94a3b8">ISS</label><input id="nd-iss" type="text" style="width:80px;padding:4px;font-size:10px;border:1px solid #e2e8f0;border-radius:4px;text-align:right" value="0,00"></div>
        </div>
        <div style="margin-top:6px;display:flex;gap:16px;font-size:11px;font-weight:700">
          <span>Total Retenção: <span id="nd-total-ret" style="color:#d97706">R$ 0,00</span></span>
          <span>Valor Líquido: <span id="nd-vliq" style="color:#15803d">R$ 0,00</span></span>
        </div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px">
        <button onclick="saveDespesa()" style="padding:8px 20px;font-size:11px;font-weight:700;border:1px solid #86efac;border-radius:6px;background:#dcfce7;color:#15803d;cursor:pointer">💾 Salvar Despesa</button>
        <button onclick="toggleDespForm()" style="padding:8px 20px;font-size:11px;font-weight:700;border:1px solid #e2e8f0;border-radius:6px;background:#f8fafc;color:#64748b;cursor:pointer">Cancelar</button>
      </div>
    </div>
  `;
}

function parseValorBR(v){
  if(!v||!v.trim())return 0;
  return parseFloat(v.replace(/\./g,'').replace(',','.'))||0;
}
function fmtBR(v){return v.toFixed(2).replace('.',',');}

function calcRetFe(){
  const cat=document.getElementById('nd-cat')?.value;
  const vb=parseValorBR(document.getElementById('nd-vbruto')?.value||'0');
  if(cat==='SERVICO'&&vb>215.05){
    document.getElementById('nd-irrf').value=fmtBR(vb*0.015);
    document.getElementById('nd-csll').value=fmtBR(vb*0.01);
    document.getElementById('nd-pis').value=fmtBR(vb*0.0065);
    document.getElementById('nd-cofins').value=fmtBR(vb*0.03);
    document.getElementById('nd-inss').value=fmtBR(vb*0.11);
  } else {
    ['nd-irrf','nd-csll','nd-pis','nd-cofins','nd-inss'].forEach(id=>{if(document.getElementById(id))document.getElementById(id).value='0,00';});
  }
  const irrf=parseValorBR(document.getElementById('nd-irrf')?.value);
  const csll=parseValorBR(document.getElementById('nd-csll')?.value);
  const pis=parseValorBR(document.getElementById('nd-pis')?.value);
  const cofins=parseValorBR(document.getElementById('nd-cofins')?.value);
  const inss=parseValorBR(document.getElementById('nd-inss')?.value);
  const iss=parseValorBR(document.getElementById('nd-iss')?.value);
  const totalRet=irrf+csll+pis+cofins+inss+iss;
  document.getElementById('nd-total-ret').textContent=brl(totalRet);
  document.getElementById('nd-vliq').textContent=brl(vb-totalRet);
}

async function saveDespesa(){
  const vb=parseValorBR(document.getElementById('nd-vbruto').value);
  if(!vb){alert('Informe o valor bruto');return;}
  const dataRaw=document.getElementById('nd-data').value;
  const dataBR=dataRaw?dataRaw.split('-').reverse().join('/'):'';
  const body={
    categoria:document.getElementById('nd-cat').value,
    fornecedor:document.getElementById('nd-forn').value,
    cnpj_fornecedor:document.getElementById('nd-cnpj').value,
    nf_numero:document.getElementById('nd-nf').value,
    data_despesa:dataBR,
    competencia:document.getElementById('nd-comp').value,
    valor_bruto:vb,
    descricao:document.getElementById('nd-desc').value,
    irrf:parseValorBR(document.getElementById('nd-irrf').value),
    csll:parseValorBR(document.getElementById('nd-csll').value),
    pis_retido:parseValorBR(document.getElementById('nd-pis').value),
    cofins_retido:parseValorBR(document.getElementById('nd-cofins').value),
    inss_retido:parseValorBR(document.getElementById('nd-inss').value),
    iss_retido:parseValorBR(document.getElementById('nd-iss').value),
  };
  await api('/despesas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  document.getElementById('desp-form-wrap').style.display='none';
  toast('Despesa salva!');
  loadDespData();
}

// ─── Drag & Drop nas import-zones ────────────────────────────────
function initDragDrop() {
  document.querySelectorAll('.import-zone').forEach(zone => {
    if (zone.dataset.ddInit) return;
    zone.dataset.ddInit = '1';
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.style.borderColor='#3b82f6'; zone.style.background='#eff6ff'; });
    zone.addEventListener('dragleave', () => { zone.style.borderColor=''; zone.style.background=''; });
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.style.borderColor=''; zone.style.background='';
      const file = e.dataTransfer.files[0];
      if (!file) return;
      // Encontra o input oculto dentro da zone e dispara importação
      const input = zone.querySelector('input[type=file]');
      if (!input) return;
      // Injeta o arquivo no input via DataTransfer
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    });
  });
}

// ─── Preview CSV antes de importar ───────────────────────────────
function previewCSV(file, callback) {
  const reader = new FileReader();
  reader.onload = e => {
    const lines = e.target.result.split('\n').filter(l => l.trim()).slice(0, 6);
    if (lines.length === 0) { callback(true); return; }
    const html = `<div style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center" id="preview-modal">
      <div style="background:#fff;border-radius:12px;padding:20px;max-width:90vw;width:700px;max-height:80vh;overflow:auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div>
            <strong style="font-size:14px">📄 Preview: ${file.name}</strong>
            <span style="font-size:10px;color:#64748b;margin-left:8px">(primeiras ${lines.length-1} linhas de dados)</span>
          </div>
          <button onclick="document.getElementById('preview-modal').remove()" style="background:none;border:none;font-size:18px;cursor:pointer;color:#64748b">✕</button>
        </div>
        <div style="overflow-x:auto;border:1px solid #e2e8f0;border-radius:6px">
          <table style="width:100%;border-collapse:collapse;font-size:10px">
            ${lines.map((l,i) => {
              const cols = l.split(';').map(c => `<td style="padding:4px 8px;border-bottom:1px solid #f1f5f9;white-space:nowrap;${i===0?'font-weight:700;background:#f8fafc;':''}">${c.replace(/"/g,'').substring(0,40)}</td>`).join('');
              return `<tr>${cols}</tr>`;
            }).join('')}
          </table>
        </div>
        <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end">
          <button onclick="document.getElementById('preview-modal').remove()" style="padding:7px 16px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;font-size:11px;cursor:pointer">Cancelar</button>
          <button onclick="document.getElementById('preview-modal').remove();__previewCb(true)" style="padding:7px 16px;background:#1d4ed8;color:#fff;border:none;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer">✅ Confirmar Importação</button>
        </div>
      </div>
    </div>`;
    window.__previewCb = callback;
    document.body.insertAdjacentHTML('beforeend', html);
  };
  reader.readAsText(file, 'latin1');
}

// ─── Import ──────────────────────────────────────────────────────
async function importFile(tipo,input){
  if(!input.files[0])return;
  const file = input.files[0];
  // Preview apenas para CSV
  if (file.name.toLowerCase().match(/\.(csv|txt)$/)) {
    previewCSV(file, confirmed => {
      if (!confirmed) { input.value=''; return; }
      _doImport(tipo, file, input);
    });
    return;
  }
  _doImport(tipo, file, input);
}

async function _doImport(tipo, file, input){
  const fd=new FormData();
  fd.append('file',file);
  showLoading('Importando '+file.name+'…');
  try{
    const r=await fetch('/api/import/'+tipo,{method:'POST',body:fd,headers:{'X-Company':currentCompany}});
    const d=await r.json();
    if(r.status===403){
      // Contaminação cruzada detectada
      const outroNome = d.empresaDetectada==='assessoria'?'Montana Assessoria (clique em 🏢 Assessoria)':'Montana Segurança (clique em 🔒 Segurança)';
      alert('⛔ IMPORTAÇÃO BLOQUEADA\n\n' + (d.error||'Arquivo inválido para esta empresa.') + '\n\nParece ser arquivo de: '+outroNome);
      toast(d.error||'Bloqueado — arquivo do app errado','error');
    }else if(d.ok){toast(d.message);loadDashboard();loadImportHist();}
    else toast(d.error||'Erro','error');
  }catch(err){toast('Erro: '+err.message,'error');}
  finally{hideLoading();}
  if(input) input.value='';
}

async function loadImportHist(){
  const d=await api('/importacoes');
  document.getElementById('import-hist').innerHTML=(d.data||[]).map(r=>`<tr>
    <td>${badge(r.tipo,r.tipo==='extratos'?'blue':r.tipo==='pagamentos'?'green':'amber')}</td>
    <td style="font-size:11px">${r.arquivo}</td>
    <td class="mono">${r.registros}</td>
    <td style="font-size:10px;color:#64748b">${r.data_importacao}</td>
    <td>${badge(r.status,'green')}</td>
  </tr>`).join('');
}

// ─── Export ──────────────────────────────────────────────────────
function exportCSV(tipo){
  let url=`/api/relatorios/conciliacao?format=csv&company=${currentCompany}`;
  if(_from)url+='&from='+_from;
  if(_to)url+='&to='+_to;
  window.open(url,'_blank');
}

function exportExcel(tipo){
  let url=`/api/relatorios/excel?tipo=${tipo}&company=${currentCompany}`;
  if(_from)url+='&from='+_from;
  if(_to)url+='&to='+_to;
  window.open(url,'_blank');
}

// Relatórios tab with its own date filters
function getRelDates(){
  const from=document.getElementById('rel-from')?.value||_from;
  const to=document.getElementById('rel-to')?.value||_to;
  return {from,to};
}
function exportRelCSV(tipo){
  const {from,to}=getRelDates();
  let url=`/api/relatorios/conciliacao?format=csv&company=${currentCompany}`;
  if(from)url+='&from='+from;
  if(to)url+='&to='+to;
  window.open(url,'_blank');
}
function exportRelExcel(tipo){
  const {from,to}=getRelDates();
  let url=`/api/relatorios/excel?tipo=${tipo}&company=${currentCompany}`;
  if(from)url+='&from='+from;
  if(to)url+='&to='+to;
  toast('Gerando relatório '+tipo+'...');
  window.open(url,'_blank');
}

// ─── Lucro por Contrato ──────────────────────────────────────
async function showLucroContrato(){
  const {from,to}=getRelDates();
  let url='/api/relatorios/lucro-por-contrato';
  const p=[];
  if(from)p.push('from='+from);
  if(to)p.push('to='+to);
  if(p.length)url+='?'+p.join('&');
  toast('Carregando lucro por contrato...');
  const r=await fetch(url).then(r=>r.json());
  const d=r.data||[];
  const s=r.resumo||{};
  let html=`<div style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center" onclick="if(event.target===this)this.remove()">
    <div style="background:#fff;border-radius:16px;max-width:950px;width:95%;max-height:90vh;overflow:auto;padding:24px" onclick="event.stopPropagation()">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 style="font-size:18px;font-weight:800;color:#0f172a">Lucro por Contrato</h2>
      <button onclick="this.closest('[style*=fixed]').remove()" style="background:none;border:none;font-size:20px;cursor:pointer;color:#94a3b8">&times;</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
      <div style="background:#f0fdf4;border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:9px;color:#059669;font-weight:700;text-transform:uppercase">Receita Total</div>
        <div style="font-size:16px;font-weight:800;color:#059669">${brl(s.total_receita)}</div>
      </div>
      <div style="background:#fef2f2;border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:9px;color:#dc2626;font-weight:700;text-transform:uppercase">Despesas NF</div>
        <div style="font-size:16px;font-weight:800;color:#dc2626">${brl(s.total_despesas)}</div>
      </div>
      <div style="background:#eff6ff;border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:9px;color:#1d4ed8;font-weight:700;text-transform:uppercase">Lucro Bruto</div>
        <div style="font-size:16px;font-weight:800;color:#1d4ed8">${brl(s.lucro_bruto)}</div>
      </div>
      <div style="background:#f5f3ff;border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:9px;color:#7c3aed;font-weight:700;text-transform:uppercase">Margem</div>
        <div style="font-size:16px;font-weight:800;color:#7c3aed">${s.margem_pct}%</div>
      </div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead><tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0">
        <th style="padding:8px;text-align:left">Contrato</th>
        <th style="padding:8px;text-align:right">Receita</th>
        <th style="padding:8px;text-align:right">Despesas NF</th>
        <th style="padding:8px;text-align:center">Qtd NFs</th>
        <th style="padding:8px;text-align:right">Lucro</th>
        <th style="padding:8px;text-align:center">Margem</th>
      </tr></thead><tbody>`;
  d.forEach(c=>{
    const cor=c.lucro_bruto>=0?'#059669':'#dc2626';
    const margemCor=c.margem_pct>=80?'#059669':c.margem_pct>=50?'#d97706':'#dc2626';
    html+=`<tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:8px"><div style="font-weight:600">${c.numContrato}</div><div style="font-size:9px;color:#94a3b8">${c.contrato}</div></td>
      <td style="padding:8px;text-align:right;font-weight:600">${brl(c.receita)}</td>
      <td style="padding:8px;text-align:right;color:#dc2626">${brl(c.despesas)}</td>
      <td style="padding:8px;text-align:center">${c.qtd_despesas}</td>
      <td style="padding:8px;text-align:right;font-weight:700;color:${cor}">${brl(c.lucro_bruto)}</td>
      <td style="padding:8px;text-align:center"><span style="background:${margemCor}15;color:${margemCor};padding:2px 8px;border-radius:10px;font-weight:700;font-size:10px">${c.margem_pct}%</span></td>
    </tr>`;
  });
  html+=`</tbody></table></div></div>`;
  document.body.insertAdjacentHTML('beforeend',html);
}

// ─── A Receber por Contrato ──────────────────────────────────
async function showAReceberContrato(){
  toast('Carregando A Receber...');
  const d = await api('/relatorios/a-receber-por-contrato');
  const rows = d.data || [];
  const s = d.resumo || {};

  // KPIs
  document.getElementById('ar-kpis').innerHTML = `
    <div style="background:#fef2f2;border-radius:10px;padding:14px;text-align:center">
      <div style="font-size:9px;color:#dc2626;font-weight:700;text-transform:uppercase">Total A Receber</div>
      <div style="font-size:17px;font-weight:800;color:#dc2626">${brl(s.total_a_receber)}</div>
      <div style="font-size:9px;color:#94a3b8">${s.qtd_com_pendencia} contratos</div>
    </div>
    <div style="background:#fff7ed;border-radius:10px;padding:14px;text-align:center">
      <div style="font-size:9px;color:#d97706;font-weight:700;text-transform:uppercase">⚠️ Emitir NF</div>
      <div style="font-size:17px;font-weight:800;color:#d97706">${brl(s.total_emitir_nf)}</div>
      <div style="font-size:9px;color:#94a3b8">aguardando emissão</div>
    </div>
    <div style="background:#fff1f2;border-radius:10px;padding:14px;text-align:center">
      <div style="font-size:9px;color:#e11d48;font-weight:700;text-transform:uppercase">🔴 Em Atraso</div>
      <div style="font-size:17px;font-weight:800;color:#e11d48">${brl(s.total_em_atraso)}</div>
      <div style="font-size:9px;color:#94a3b8">vencidas não pagas</div>
    </div>
    <div style="background:#f0fdf4;border-radius:10px;padding:14px;text-align:center">
      <div style="font-size:9px;color:#15803d;font-weight:700;text-transform:uppercase">✅ Total Pago</div>
      <div style="font-size:17px;font-weight:800;color:#15803d">${brl(s.total_pago)}</div>
      <div style="font-size:9px;color:#94a3b8">${s.qtd_contratos} contratos</div>
    </div>
  `;

  // Subtítulo
  document.getElementById('ar-subtitle').textContent =
    `${s.qtd_contratos} contratos · ${s.qtd_com_pendencia} com pendência · Gerado em ${new Date().toLocaleDateString('pt-BR')}`;

  // Tabela
  let tbody = '';
  rows.forEach((c, i) => {
    const bg = i % 2 === 0 ? '#fff' : '#f8fafc';
    const atrCor = c.em_atraso > 0 ? '#dc2626' : '#94a3b8';
    const nfCor  = c.emitir_nf > 0 ? '#d97706' : '#94a3b8';
    const arCor  = c.a_receber > 0 ? '#15803d' : '#94a3b8';
    const arBold = c.a_receber > 0 ? 'font-weight:700' : '';
    tbody += `<tr style="background:${bg};border-bottom:1px solid #f1f5f9">
      <td style="padding:8px 12px;font-weight:600;font-size:11px;color:#0f172a">${c.numContrato}</td>
      <td style="padding:8px 12px;font-size:11px;color:#475569">${(c.contrato||'').substring(0,45)}</td>
      <td style="padding:8px 12px;text-align:right;font-size:11px;color:#64748b">${brl(c.valor_mensal_liquido)}</td>
      <td style="padding:8px 12px;text-align:right;font-size:11px;color:#15803d">${brl(c.total_pago)}</td>
      <td style="padding:8px 12px;text-align:right;font-size:11px;color:${nfCor}">${c.emitir_nf > 0 ? brl(c.emitir_nf) : '—'}</td>
      <td style="padding:8px 12px;text-align:right;font-size:11px;color:${atrCor}">${c.em_atraso > 0 ? brl(c.em_atraso) : '—'}</td>
      <td style="padding:8px 12px;text-align:right;font-size:11px;color:${arCor};${arBold}">${c.a_receber > 0 ? brl(c.a_receber) : '—'}</td>
    </tr>`;
  });
  // Linha total
  tbody += `<tr style="background:#0f172a;color:#fff">
    <td colspan="3" style="padding:10px 12px;font-weight:700;font-size:12px">TOTAL GERAL</td>
    <td style="padding:10px 12px;text-align:right;font-weight:700;font-size:12px;color:#4ade80">${brl(s.total_pago)}</td>
    <td style="padding:10px 12px;text-align:right;font-weight:700;font-size:12px;color:#fbbf24">${brl(s.total_emitir_nf)}</td>
    <td style="padding:10px 12px;text-align:right;font-weight:700;font-size:12px;color:#f87171">${brl(s.total_em_atraso)}</td>
    <td style="padding:10px 12px;text-align:right;font-weight:700;font-size:12px;color:#34d399">${brl(s.total_a_receber)}</td>
  </tr>`;

  document.getElementById('ar-tbody').innerHTML = tbody;
  document.getElementById('modal-a-receber').style.display = 'block';
}

// ─── Prefeitura de Palmas ─────────────────────────────────────
let _prefPgPage=1, _prefGestao='', _prefAno='', _prefStatus='';
let _prefConcMes='';

function showPrefSub(id, el){
  document.querySelectorAll('.pref-sub').forEach(s=>s.style.display='none');
  document.querySelectorAll('.pref-stab').forEach(t=>{t.style.color='#64748b';t.style.borderBottomColor='transparent'});
  document.getElementById('pref-sub-'+id).style.display='block';
  if(el){el.style.color='#7c3aed';el.style.borderBottomColor='#7c3aed';}
  if(id==='pgtos') loadPrefPagamentos();
  if(id==='nfs') loadPrefNfs();
  if(id==='conc') loadPrefConciliacao();
  if(id==='webiss') { initWebissFilters(); checkWebissStatus(); }
}

async function loadPrefeitura(){
  const d = await api('/prefeitura/dashboard');
  const t = d.totais||{};
  const pctConc = t.total_pgtos>0?((t.recebidos/t.total_pgtos)*100).toFixed(1):0;

  document.getElementById('pref-kpis').innerHTML=`
    <div class="kpi" style="border-left:4px solid #7c3aed"><div class="kpi-l">🏛️ Total Pagamentos</div><div class="kpi-v" style="color:#7c3aed">${t.total_pgtos||0}</div><div class="kpi-s">ordens bancárias da Prefeitura</div></div>
    <div class="kpi" style="border-left:4px solid #15803d"><div class="kpi-l">💰 Total Bruto</div><div class="kpi-v green">${brl(t.total_bruto)}</div><div class="kpi-s">valor bruto pago</div></div>
    <div class="kpi" style="border-left:4px solid #1d4ed8"><div class="kpi-l">📋 Gestões</div><div class="kpi-v blue">${d.gestoes||0}</div><div class="kpi-s">contratos ativos</div></div>
    <div class="kpi" style="border-left:4px solid #d97706"><div class="kpi-l">🧾 NFs</div><div class="kpi-v amber">${d.nfs||0}</div><div class="kpi-s">notas fiscais</div></div>
    <div class="kpi" style="border-left:4px solid #15803d"><div class="kpi-l">✅ Recebidos</div><div class="kpi-v green">${t.recebidos||0}</div><div class="kpi-s">${pctConc}% conciliados</div></div>
    <div class="kpi" style="border-left:4px solid #dc2626"><div class="kpi-l">⏳ Pendentes</div><div class="kpi-v red">${t.pendentes||0}</div><div class="kpi-s">aguardando identificação</div></div>
  `;
  loadPrefGestoes();
}

async function loadPrefGestoes(){
  const d = await api('/prefeitura/gestoes');
  document.getElementById('pref-gestoes-head').innerHTML=`<tr>
    <th>Gestão</th><th>Código</th><th class="r">Total Pago</th><th class="r">Qtd Pgtos</th>
    <th>Primeiro Pgto</th><th>Último Pgto</th><th>Status</th>
  </tr>`;
  document.getElementById('pref-gestoes-body').innerHTML=(d.data||[]).map(r=>{
    const st = r.status==='ATIVO'?badge('ATIVO','green'):badge(r.status||'—','gray');
    return `<tr>
      <td style="font-size:10px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.gestao}">${r.gestao}</td>
      <td class="mono" style="font-size:10px;color:#7c3aed;font-weight:600">${r.gestao_codigo||''}</td>
      <td class="r mono green" style="font-weight:700">${brl(r.total_pago)}</td>
      <td class="r mono" style="color:#475569">${r.qtd_pagamentos}</td>
      <td style="font-size:10px;color:#64748b">${r.primeiro_pg||''}</td>
      <td style="font-size:10px;color:#64748b">${r.ultimo_pg||''}</td>
      <td>${st}</td>
    </tr>`;
  }).join('');
}

let _prefPgFiltersRendered=false;
async function loadPrefPagamentos(){
  if(!_prefPgFiltersRendered){
    const g = await api('/prefeitura/gestoes');
    const gestOpts = (g.data||[]).map(r=>`<option value="${r.gestao_codigo}">${r.gestao_codigo} — ${(r.gestao||'').substring(0,40)}</option>`).join('');
    document.getElementById('pref-pgtos-filters').innerHTML=`
      <div><label>Gestão</label><select id="pf-gestao" onchange="_prefPgPage=1;loadPrefPgData()"><option value="">Todas</option>${gestOpts}</select></div>
      <div><label>Ano Empenho</label><select id="pf-ano" onchange="_prefPgPage=1;loadPrefPgData()"><option value="">Todos</option><option value="2026">2026</option><option value="2025">2025</option><option value="2024">2024</option></select></div>
      <div><label>Status</label><select id="pf-status" onchange="_prefPgPage=1;loadPrefPgData()"><option value="">Todos</option><option value="RECEBIDO">Recebido</option><option value="PENDENTE">Pendente</option></select></div>
    `;
    _prefPgFiltersRendered=true;
  }
  await loadPrefPgData();
}

async function loadPrefPgData(){
  const gestao=document.getElementById('pf-gestao')?.value||'';
  const ano=document.getElementById('pf-ano')?.value||'';
  const status=document.getElementById('pf-status')?.value||'';
  let url=`/prefeitura/pagamentos?limit=100&offset=${(_prefPgPage-1)*100}`;
  if(gestao) url+='&gestao='+encodeURIComponent(gestao);
  if(ano) url+='&ano='+ano;
  if(status) url+='&status='+status;
  const d = await api(url);
  const pages = Math.ceil((d.total||0)/100)||1;
  const sm = d.sumario||{};
  document.getElementById('pref-pgtos-counter').innerHTML=`
    <span>${d.total} pagamentos</span> ·
    <span style="color:#15803d;font-weight:700">Bruto: ${brl(sm.bruto)}</span> ·
    <span style="color:#1d4ed8;font-weight:700">Líquido OB: ${brl(sm.liquido)}</span> ·
    <span style="color:#d97706;font-weight:700">Retenção: ${brl(sm.ret)}</span>
  `;
  document.getElementById('pref-pgtos-head').innerHTML=`<tr>
    <th>Data Pgto</th><th>Gestão</th><th>Fornecedor</th><th>Ano Emp.</th>
    <th class="r">Valor Bruto</th><th class="r">Líquido OB</th><th class="r">Retenção</th>
    <th>NF</th><th>Status</th>
  </tr>`;
  document.getElementById('pref-pgtos-body').innerHTML=(d.data||[]).map(r=>{
    const stBg = r.status_conciliacao==='RECEBIDO'?'green':'amber';
    return `<tr style="${r.status_conciliacao==='RECEBIDO'?'background:#f0fdf4':''}">
      <td style="font-size:10px;color:#64748b;white-space:nowrap">${r.data_pagamento||''}</td>
      <td style="font-size:10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.gestao}">${r.gestao_codigo||''}</td>
      <td style="font-size:10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.fornecedor}">${(r.fornecedor||'').substring(0,35)}</td>
      <td class="mono" style="font-size:10px;color:#64748b;text-align:center">${r.ano_empenho||''}</td>
      <td class="r mono" style="font-weight:600">${brl(r.valor_pago)}</td>
      <td class="r mono" style="color:#1d4ed8;font-weight:600">${r.valor_liquido_ob?brl(r.valor_liquido_ob):'<span class="muted">—</span>'}</td>
      <td class="r mono" style="color:#d97706">${r.retencao?brl(r.retencao):'<span class="muted">—</span>'}</td>
      <td style="font-size:10px;color:#7c3aed;font-weight:600">${r.nf_vinculada||'<span class="muted">—</span>'}</td>
      <td>${badge(r.status_conciliacao||'PENDENTE',stBg)}</td>
    </tr>`;
  }).join('');
  document.getElementById('pref-pgtos-pag').innerHTML=`
    <button ${_prefPgPage<=1?'disabled':''} onclick="_prefPgPage--;loadPrefPgData()">← Anterior</button>
    <span>Página ${_prefPgPage} de ${pages} (${d.total} registros)</span>
    <button ${_prefPgPage>=pages?'disabled':''} onclick="_prefPgPage++;loadPrefPgData()">Próxima →</button>`;
}

async function loadPrefNfs(){
  const d = await api('/prefeitura/nfs');
  const rows = d.data||[];
  const vinculadas = rows.filter(r=>r.pagamento_id).length;
  document.getElementById('pref-nfs-counter').innerHTML=`${rows.length} notas fiscais · <span style="color:#15803d;font-weight:700">${vinculadas} vinculadas</span> · <span style="color:#d97706;font-weight:700">${rows.length-vinculadas} livres</span>`;
  document.getElementById('pref-nfs-head').innerHTML=`<tr>
    <th>NF</th><th>Cidade</th><th>Gestão</th><th>Competência</th>
    <th class="r">V. Bruto</th><th class="r">V. Líquido</th><th class="r">Retenção</th>
    <th>Status</th><th>Pgto Vinculado</th>
  </tr>`;
  document.getElementById('pref-nfs-body').innerHTML=rows.map(r=>{
    const stColor = r.status==='VINCULADA'?'green':r.status==='EMITIDA'?'amber':'gray';
    return `<tr style="${r.pagamento_id?'background:#f0fdf4':''}">
      <td class="mono" style="color:#7c3aed;font-weight:600">NF ${r.numero}</td>
      <td style="font-size:10px;color:#475569">${r.cidade||''}</td>
      <td style="font-size:10px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.gestao}">${r.gestao_codigo||''}</td>
      <td style="font-size:10px;color:#64748b">${r.competencia||''}</td>
      <td class="r mono" style="font-weight:600">${brl(r.valor_bruto)}</td>
      <td class="r mono green" style="font-weight:600">${brl(r.valor_liquido)}</td>
      <td class="r mono" style="color:#d97706">${brl(r.retencao)}</td>
      <td>${badge(r.status||'EMITIDA',stColor)}</td>
      <td style="font-size:10px;color:#64748b">${r.pagamento_id?'#'+r.pagamento_id:'<span class="muted">—</span>'}</td>
    </tr>`;
  }).join('');
}

async function loadPrefConciliacao(){
  document.getElementById('pref-conc-filters').innerHTML=`
    <div><label>Mês</label>
      <select id="pc-mes" onchange="loadPrefConcData()">
        <option value="">Todos</option>
        <option value="2026-03">Mar/2026</option><option value="2026-02">Fev/2026</option><option value="2026-01">Jan/2026</option>
        <option value="2025-12">Dez/2025</option><option value="2025-11">Nov/2025</option><option value="2025-10">Out/2025</option>
        <option value="2025-09">Set/2025</option><option value="2025-08">Ago/2025</option><option value="2025-07">Jul/2025</option>
        <option value="2025-06">Jun/2025</option><option value="2025-05">Mai/2025</option><option value="2025-04">Abr/2025</option>
        <option value="2024-12">Dez/2024</option><option value="2024-11">Nov/2024</option><option value="2024-10">Out/2024</option>
        <option value="2024-09">Set/2024</option><option value="2024-08">Ago/2024</option><option value="2024-07">Jul/2024</option>
        <option value="2024-06">Jun/2024</option><option value="2024-05">Mai/2024</option><option value="2024-04">Abr/2024</option>
      </select>
    </div>
  `;
  loadPrefConcData();
}

async function loadPrefConcData(){
  const mes = document.getElementById('pc-mes')?.value||'';
  let url = '/prefeitura/conciliacao';
  if(mes) url += '?mes='+mes;
  const d = await api(url);
  const pgtos = d.pagamentos||[];
  const nfsLivres = d.nfs_livres||[];
  const recebidos = pgtos.filter(p=>p.status_conciliacao==='RECEBIDO').length;
  const pendentes = pgtos.length - recebidos;
  const totalBruto = pgtos.reduce((s,p)=>s+p.valor_pago,0);
  const totalLiq = pgtos.filter(p=>p.valor_liquido_ob>0).reduce((s,p)=>s+p.valor_liquido_ob,0);

  let html = `
    <div class="kpis" style="margin-bottom:14px">
      <div class="kpi"><div class="kpi-l">Pagamentos</div><div class="kpi-v blue">${pgtos.length}</div></div>
      <div class="kpi"><div class="kpi-l">Total Bruto</div><div class="kpi-v" style="color:#7c3aed">${brl(totalBruto)}</div></div>
      <div class="kpi"><div class="kpi-l">Líquido OB</div><div class="kpi-v green">${brl(totalLiq)}</div></div>
      <div class="kpi"><div class="kpi-l">Recebidos</div><div class="kpi-v green">${recebidos}</div></div>
      <div class="kpi"><div class="kpi-l">Pendentes</div><div class="kpi-v red">${pendentes}</div></div>
      <div class="kpi"><div class="kpi-l">NFs Livres</div><div class="kpi-v amber">${nfsLivres.length}</div></div>
    </div>
  `;

  html += `<div class="tw" style="max-height:500px;overflow-y:auto"><table>
    <thead><tr>
      <th>Data Pgto</th><th>Gestão</th><th class="r">Valor Bruto</th>
      <th class="r">Líquido OB</th><th>NFs Vinculadas</th><th>Status</th><th>Data OB</th>
    </tr></thead><tbody>`;
  pgtos.forEach(p=>{
    const stBadge = p.status_conciliacao==='RECEBIDO'?badge('RECEBIDO','green'):badge('PENDENTE','amber');
    const nfs = p.nfs_vinculadas||'';
    html += `<tr style="${p.status_conciliacao==='RECEBIDO'?'background:#f0fdf4':''}">
      <td style="font-size:10px;color:#64748b;white-space:nowrap">${p.data_pagamento||''}</td>
      <td style="font-size:10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${p.gestao}">${p.gestao_codigo||''}</td>
      <td class="r mono" style="font-weight:600">${brl(p.valor_pago)}</td>
      <td class="r mono" style="color:#1d4ed8;font-weight:600">${p.valor_liquido_ob?brl(p.valor_liquido_ob):'<span class="muted">—</span>'}</td>
      <td style="font-size:10px;color:#7c3aed;font-weight:600">${nfs?'NF '+nfs.replace(/,/g,', NF '):'<span class="muted">—</span>'}</td>
      <td>${stBadge}</td>
      <td style="font-size:10px;color:#64748b">${p.data_ob||''}</td>
    </tr>`;
  });
  html += '</tbody></table></div>';

  if(nfsLivres.length){
    html += `<div style="margin-top:16px"><h3 style="font-size:13px;font-weight:700;color:#475569;margin-bottom:8px">🧾 NFs Não Vinculadas (${nfsLivres.length})</h3>
    <div class="tw"><table>
      <thead><tr><th>NF</th><th>Cidade</th><th>Gestão</th><th class="r">V. Bruto</th><th class="r">V. Líquido</th><th>Status</th></tr></thead>
      <tbody>${nfsLivres.map(n=>`<tr>
        <td class="mono" style="color:#7c3aed;font-weight:600">NF ${n.numero}</td>
        <td style="font-size:10px;color:#475569">${n.cidade||''}</td>
        <td style="font-size:10px" title="${n.gestao}">${n.gestao_codigo||''}</td>
        <td class="r mono" style="font-weight:600">${brl(n.valor_bruto)}</td>
        <td class="r mono green">${brl(n.valor_liquido)}</td>
        <td>${badge(n.status||'EMITIDA','amber')}</td>
      </tr>`).join('')}</tbody>
    </table></div></div>`;
  }
  document.getElementById('pref-conc-content').innerHTML=html;
}

// ─── Init ────────────────────────────────────────────────────────
// Re-define api() para injetar JWT e X-Company
async function api(url, opts) {
  const headers = { 'X-Company': currentCompany };
  const token = getToken ? getToken() : null;
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (opts && opts.headers) Object.assign(headers, opts.headers);
  const r = await fetch('/api' + url, { ...opts, headers });
  if (r.status === 401) {
    const d = await r.json().catch(() => ({}));
    if (typeof clearToken === 'function') clearToken();
    if (typeof showLoginModal === 'function') showLoginModal(d.code === 'TOKEN_EXPIRED' ? 'Sessão expirada.' : 'Autenticação necessária.');
    throw new Error('Unauthorized');
  }
  return r.json();
}

applyCompanyTheme();
// Inicializa o filtro de período com o ANO corrente ao abrir o sistema
(function initDefaultPeriod(){
  const anoAtual = new Date().getFullYear().toString();
  document.getElementById('gf-tipo').value = 'ano';
  document.getElementById('gf-ano').value  = anoAtual;
  document.getElementById('gf-mes').value  = new Date().toISOString().slice(0,7);
  _from = anoAtual + '-01-01';
  _to   = anoAtual + '-12-31';
  document.getElementById('gf-ano-wrap').style.display = 'block';
  document.getElementById('gf-label').innerHTML = `<strong>${_from} a ${_to}</strong>`;
})();
initAuth();


// ─── Autenticação JWT ────────────────────────────────────────────
function getToken() { return localStorage.getItem('montana_jwt'); }
function setToken(t) { localStorage.setItem('montana_jwt', t); }
function clearToken() { localStorage.removeItem('montana_jwt'); localStorage.removeItem('montana_jwt_user'); }
function getJwtUser() { try { return JSON.parse(localStorage.getItem('montana_jwt_user')||'null'); } catch(e){return null;} }

function showLoginModal(msg) {
  let ov = document.getElementById('login-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'login-overlay';
    ov.className = 'login-overlay';
    ov.innerHTML = `
      <div class="login-box">
        <div style="font-size:36px;text-align:center;margin-bottom:10px">⚖️</div>
        <h2 style="text-align:center">Montana Multi-Empresa</h2>
        <p style="text-align:center">Conciliação Financeira — Acesso Seguro</p>
        <div class="login-error" id="login-err"></div>
        <div class="login-field"><label>Usuário</label><input type="text" id="login-user" placeholder="admin" autocomplete="username"></div>
        <div class="login-field"><label>Senha</label><input type="password" id="login-pass" placeholder="••••••••" autocomplete="current-password" onkeydown="if(event.key==='Enter')doLogin()"></div>
        <button class="login-btn" onclick="doLogin()">Entrar</button>
        <div style="margin-top:12px;text-align:center;font-size:9px;color:#cbd5e1">admin / montana2026 · financeiro / fin2026</div>
      </div>`;
    document.body.appendChild(ov);
  }
  ov.style.display = 'flex';
  if (msg) { const e=document.getElementById('login-err'); e.textContent=msg; e.style.display='block'; }
  setTimeout(() => { const u=document.getElementById('login-user'); if(u) u.focus(); }, 100);
}

async function doLogin() {
  const usuario = document.getElementById('login-user').value.trim();
  const senha   = document.getElementById('login-pass').value;
  const errEl   = document.getElementById('login-err');
  errEl.style.display = 'none';
  try {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario, senha })
    });
    const d = await r.json();
    if (!r.ok) { errEl.textContent = d.error || 'Credenciais inválidas'; errEl.style.display='block'; return; }
    setToken(d.token);
    localStorage.setItem('montana_jwt_user', JSON.stringify({ usuario: d.usuario, nome: d.nome, role: d.role }));
    const ov = document.getElementById('login-overlay');
    if (ov) ov.style.display = 'none';
    updateUserInfo();
    loadDashboard();
  } catch(e) { errEl.textContent = 'Erro de conexão: ' + e.message; errEl.style.display='block'; }
}

function logout() {
  clearToken();
  showLoginModal();
}

function updateUserInfo() {
  const u = getJwtUser();
  let el = document.getElementById('hdr-user-info');
  if (!el) {
    el = document.createElement('div');
    el.id = 'hdr-user-info';
    el.className = 'hdr-user';
    const hdr = document.querySelector('.hdr');
    if (hdr) hdr.appendChild(el);
  }
  if (u) {
    const roleLabel = {admin:'Admin',financeiro:'Financeiro',operacional:'Operacional',visualizador:'Visualizador'}[u.role]||u.role;
    el.innerHTML = `<span>${u.nome} <small style="opacity:.7">(${roleLabel})</small></span><button onclick="logout()" title="Sair">Sair</button>`;
    // Exibe aba de usuários somente para admin
    const tabUsu = document.getElementById('tab-usuarios');
    if (tabUsu) tabUsu.style.display = u.role === 'admin' ? 'flex' : 'none';
  } else {
    el.innerHTML = '';
  }
}

function initAuth() {
  const token = getToken();
  if (!token) { showLoginModal(); return; }
  // Verifica se token ainda é válido tentando uma requisição GET
  api('/dashboard').then(d => {
    if (d && !d.error) { updateUserInfo(); loadDashboard(); }
    else { clearToken(); showLoginModal('Sessão expirada. Faça login novamente.'); }
  }).catch(() => { clearToken(); showLoginModal('Erro de conexão.'); });
}

// ─── Override api() para injetar token JWT ──────────────────────
// (redefine a função api() já declarada acima)
const _origApi = api;
// Aqui redefinimos api globalmente — hoisting do var não se aplica a funções
// então usamos uma técnica de wrapper
window._apiBase = async function apiWithAuth(url, opts) {
  const headers = { 'X-Company': currentCompany };
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (opts && opts.headers) Object.assign(headers, opts.headers);
  const r = await fetch('/api' + url, { ...opts, headers });
  if (r.status === 401) {
    const d = await r.json().catch(() => ({}));
    clearToken();
    showLoginModal(d.code === 'TOKEN_EXPIRED' ? 'Sessão expirada. Faça login novamente.' : 'Autenticação necessária.');
    throw new Error('Unauthorized');
  }
  return r.json();
};

// ─── Importação OFX ─────────────────────────────────────────────
async function importOFX(input) {
  if (!input.files[0]) return;
  const fd = new FormData();
  fd.append('file', input.files[0]);
  showLoading('Importando OFX: ' + input.files[0].name + '…');
  try {
    const token = getToken();
    const headers = { 'X-Company': currentCompany };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch('/api/import/ofx', { method: 'POST', body: fd, headers });
    const d = await r.json();
    if (r.status === 403) { alert('⛔ IMPORTAÇÃO BLOQUEADA\n\n' + (d.error||'Arquivo inválido.')); toast(d.error||'Bloqueado','error'); }
    else if (d.ok) { toast(d.message); loadDashboard(); loadImportHist(); }
    else toast(d.error||'Erro','error');
  } catch(err) { toast('Erro: ' + err.message, 'error'); }
  finally { hideLoading(); }
  input.value = '';
}

// ─── Importação PDF de Extrato (BB / BRB / IA fallback) ─────────
async function importPDFExtrato(input) {
  if (!input.files[0]) return;
  const file = input.files[0];
  if (!file.name.toLowerCase().endsWith('.pdf')) { toast('Selecione um arquivo PDF','error'); input.value=''; return; }
  const fd = new FormData();
  fd.append('file', file);
  showLoading('Lendo PDF: ' + file.name + '… (pode levar alguns segundos)');
  try {
    const token = getToken();
    const headers = { 'X-Company': currentCompany };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch('/api/import/pdf-extrato', { method: 'POST', body: fd, headers });
    const d = await r.json();
    if (d.ok) {
      const bancoLabel = { BB:'Banco do Brasil', BRB:'BRB', IA:'IA (Claude)' }[d.banco] || d.banco;
      toast(`✅ ${d.imported} lançamentos importados via ${bancoLabel}` + (d.skipped ? ` · ${d.skipped} duplicados` : ''));
      loadDashboard(); loadImportHist();
    } else {
      toast(d.error || 'Erro ao processar PDF', 'error');
    }
  } catch(err) { toast('Erro: ' + err.message, 'error'); }
  finally { hideLoading(); }
  input.value = '';
}

// ─── Fluxo de Caixa Projetado ────────────────────────────────────
let _fluxoCenario = 'realista';
let _fluxoData = null;

async function loadFluxoProjetado() {
  const meses = parseInt(document.getElementById('fluxo-meses')?.value) || 6;
  const d = await api('/fluxo-projetado?meses=' + meses);
  _fluxoData = d;
  renderFluxo();
  // Parcelas reais carregadas via loadFluxoParcelas() (app-extras.js)
  if (typeof loadFluxoParcelas === 'function') loadFluxoParcelas();
  // Inadimplência por contrato
  if (typeof loadInadimplencia === 'function') loadInadimplencia();
  // Fluxo projetado por contratos (app-extras.js)
  if (typeof loadFluxoProjetadoContratos === 'function') loadFluxoProjetadoContratos();
}


function setFluxoCenario(c) {
  _fluxoCenario = c;
  document.querySelectorAll('.cenario-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('cenario-' + c);
  if (btn) btn.classList.add('active');
  renderFluxo();
}

function renderFluxo() {
  const d = _fluxoData;
  if (!d) return;
  const c = _fluxoCenario;

  // KPIs
  document.getElementById('fluxo-kpis').innerHTML = `
    <div class="kpi" style="border-left:4px solid #15803d">
      <div class="kpi-l">Receita Mensal Atual</div>
      <div class="kpi-v green">${brl(d.receitaMensal)}</div>
      <div class="kpi-s">${d.totalContratos} contratos ativos</div>
    </div>
    <div class="kpi" style="border-left:4px solid #dc2626">
      <div class="kpi-l">Despesa Média (3m)</div>
      <div class="kpi-v red">${brl(d.despesaMedia)}</div>
      <div class="kpi-s">últimos 3 meses</div>
    </div>
    <div class="kpi" style="border-left:4px solid #d97706">
      <div class="kpi-l">Inadimplência</div>
      <div class="kpi-v amber">${d.pctInadimplencia}%</div>
      <div class="kpi-s">créditos pendentes</div>
    </div>
    <div class="kpi" style="border-left:4px solid #1d4ed8">
      <div class="kpi-l">Saldo Projetado (${d.projecao?.length}m)</div>
      <div class="kpi-v blue">${brl(d.projecao?.[d.projecao.length-1]?.saldoAcumulado?.[c]||0)}</div>
      <div class="kpi-s">cenário ${c}</div>
    </div>
  `;

  // Gráfico de barras
  const proj = d.projecao || [];
  if (!proj.length) { document.getElementById('fluxo-chart').innerHTML = '<div class="muted loading" style="padding:40px">Sem dados para projeção</div>'; return; }

  const COLOR = { otimista: '#22c55e', realista: '#3b82f6', pessimista: '#ef4444' };
  const maxVal = Math.max(...proj.map(m => Math.max(m.receita[c], m.despesa[c])), 1);

  let barsHtml = '', labelsHtml = '';
  proj.forEach((m, i) => {
    const hRec = Math.max((m.receita[c] / maxVal) * 160, 4);
    const hDesp = Math.max((m.despesa[c] / maxVal) * 160, 4);
    const saldo = m.saldo[c];
    const isFirst = i === 0;
    barsHtml += `
      <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;justify-content:flex-end${isFirst?';background:rgba(59,130,246,.04);border-radius:6px;padding:0 2px':''}">
        <div style="font-size:8px;color:#475569;font-weight:600">${shortBrl(m.receita[c])}</div>
        <div style="width:100%;display:flex;gap:2px;align-items:flex-end;justify-content:center">
          <div style="width:45%;height:${hRec}px;background:linear-gradient(180deg,${COLOR[c]}99,${COLOR[c]});border-radius:3px 3px 0 0;transition:height .4s" title="Receita: ${brl(m.receita[c])}"></div>
          <div style="width:45%;height:${hDesp}px;background:linear-gradient(180deg,#fb923c99,#ea580c);border-radius:3px 3px 0 0;transition:height .4s" title="Despesa: ${brl(m.despesa[c])}"></div>
        </div>
        <div style="font-size:7px;font-weight:700;color:${saldo>=0?'#15803d':'#dc2626'}">${saldo>=0?'+':''}${shortBrl(saldo)}</div>
      </div>`;
    labelsHtml += `<div class="fluxo-label" style="font-weight:${isFirst?'800':'600'};color:${isFirst?'#1d4ed8':'#64748b'}">${m.mesLabel}</div>`;
  });

  document.getElementById('fluxo-bars').innerHTML = barsHtml;
  document.getElementById('fluxo-bar-labels').innerHTML = labelsHtml;

  // Tabela de projeção
  document.getElementById('fluxo-table').innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead><tr>
        <th style="padding:6px 10px;text-align:left;background:#f1f5f9;font-size:9px;color:#64748b;font-weight:700;text-transform:uppercase">Mês</th>
        <th style="padding:6px 10px;text-align:right;background:#f1f5f9;font-size:9px;color:#64748b;font-weight:700;text-transform:uppercase">Receita</th>
        <th style="padding:6px 10px;text-align:right;background:#f1f5f9;font-size:9px;color:#64748b;font-weight:700;text-transform:uppercase">Despesa</th>
        <th style="padding:6px 10px;text-align:right;background:#f1f5f9;font-size:9px;color:#64748b;font-weight:700;text-transform:uppercase">Saldo Mensal</th>
        <th style="padding:6px 10px;text-align:right;background:#f1f5f9;font-size:9px;color:#64748b;font-weight:700;text-transform:uppercase">Saldo Acum.</th>
      </tr></thead>
      <tbody>${proj.map((m,i) => {
        const saldo = m.saldo[c];
        const acum  = m.saldoAcumulado[c];
        return `<tr style="background:${i%2?'#fafbfc':'#fff'};border-bottom:1px solid #f1f5f9">
          <td style="padding:5px 10px;font-weight:${i===0?'700':'500'};color:${i===0?'#1d4ed8':'#334155'}">${m.mesLabel}</td>
          <td style="padding:5px 10px;text-align:right;font-family:monospace;color:#15803d;font-weight:600">${brl(m.receita[c])}</td>
          <td style="padding:5px 10px;text-align:right;font-family:monospace;color:#ea580c">${brl(m.despesa[c])}</td>
          <td style="padding:5px 10px;text-align:right;font-family:monospace;font-weight:700;color:${saldo>=0?'#15803d':'#dc2626'}">${brl(saldo)}</td>
          <td style="padding:5px 10px;text-align:right;font-family:monospace;font-weight:700;color:${acum>=0?'#1d4ed8':'#dc2626'}">${brl(acum)}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>
  `;
}

// ─── WebISS (NFS-e Palmas-TO) ─────────────────────────────────────────────────

/** Cache dos resultados da última consulta (para o botão Importar reusar sem nova chamada) */
let _webissLastResults = [];

/** Exibe a sub-aba WebISS — inicializa datas padrão se ainda não preenchidas */
function initWebissFilters() {
  const ini = document.getElementById('webiss-dt-ini');
  const fim = document.getElementById('webiss-dt-fim');
  if (!ini.value) {
    const hoje = new Date();
    const primeiroDia = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    ini.value = primeiroDia.toISOString().substring(0, 10);
    fim.value = hoje.toISOString().substring(0, 10);
  }
}

/** Testa conectividade com o endpoint WebISS */
async function checkWebissStatus() {
  const badge = document.getElementById('webiss-status-badge');
  badge.style.background = '#e2e8f0';
  badge.style.color = '#64748b';
  badge.textContent = 'Testando…';
  try {
    const d = await api('/webiss/status');
    if (d.ok) {
      badge.style.background = '#dcfce7';
      badge.style.color = '#15803d';
      badge.textContent = 'Online ✓';
    } else {
      badge.style.background = '#fee2e2';
      badge.style.color = '#dc2626';
      badge.textContent = `HTTP ${d.httpStatus}`;
    }
  } catch (e) {
    badge.style.background = '#fee2e2';
    badge.style.color = '#dc2626';
    badge.textContent = 'Offline';
  }
}

/** Renderiza tabela de NFS-e consultadas */
function renderWebissTable(nfses) {
  const wrap = document.getElementById('webiss-table-wrap');
  const counter = document.getElementById('webiss-counter');
  if (!nfses.length) {
    wrap.style.display = 'none';
    counter.style.display = 'none';
    return;
  }
  const ativas = nfses.filter(n => n.status === 'ATIVA').length;
  counter.style.display = '';
  counter.innerHTML = `${nfses.length} NFS-e encontradas · <span style="color:#15803d;font-weight:700">${ativas} ativas</span> · <span style="color:#dc2626;font-weight:700">${nfses.length - ativas} canceladas</span>`;
  document.getElementById('webiss-head').innerHTML = `<tr>
    <th>Nº NFS-e</th><th>Competência</th><th>Emissão</th><th>Tomador</th>
    <th class="r">Valor Bruto</th><th class="r">Valor Líquido</th>
    <th class="r">Retenções</th><th>Status</th>
  </tr>`;
  document.getElementById('webiss-body').innerHTML = nfses.map(n => {
    const ret = n.valorInss + n.valorIr + n.valorIss + n.valorCsll + n.valorPis + n.valorCofins;
    const stColor = n.status === 'ATIVA' ? 'green' : 'red';
    return `<tr style="${n.status === 'CANCELADA' ? 'opacity:.55' : ''}">
      <td class="mono" style="color:#7c3aed;font-weight:700">${n.numero}</td>
      <td style="font-size:10px;color:#64748b">${n.competencia || '—'}</td>
      <td style="font-size:10px;color:#64748b">${n.dataEmissao || '—'}</td>
      <td style="font-size:10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${n.tomadorRazaoSocial}">${n.tomadorRazaoSocial || '—'}</td>
      <td class="r mono" style="font-weight:600">${brl(n.valorServicos)}</td>
      <td class="r mono green" style="font-weight:600">${brl(n.valorLiquido)}</td>
      <td class="r mono" style="color:#d97706">${brl(ret)}</td>
      <td>${badge(n.status, stColor)}</td>
    </tr>`;
  }).join('');
  wrap.style.display = '';
}

/** Consulta NFS-e no WebISS (sem importar) */
async function consultarWebiss() {
  const ini = document.getElementById('webiss-dt-ini').value;
  const fim = document.getElementById('webiss-dt-fim').value;
  const msg = document.getElementById('webiss-msg');
  if (!ini || !fim) { msg.textContent = 'Preencha as datas.'; return; }

  msg.innerHTML = '<span style="color:#64748b">Consultando WebISS…</span>';
  document.getElementById('webiss-table-wrap').style.display = 'none';
  document.getElementById('webiss-counter').style.display = 'none';
  _webissLastResults = [];

  try {
    const d = await api(`/webiss/consultar?dataInicial=${ini}&dataFinal=${fim}`);
    if (!d.ok && d.erros?.length) {
      const erroList = d.erros.map(e => `[${e.codigo}] ${e.mensagem}`).join('; ');
      msg.innerHTML = `<span style="color:#dc2626">WebISS retornou erro: ${erroList}</span>`;
      return;
    }
    _webissLastResults = d.nfses || [];
    if (!_webissLastResults.length) {
      msg.innerHTML = '<span style="color:#64748b">Nenhuma NFS-e encontrada no período.</span>';
    } else {
      msg.innerHTML = '';
    }
    renderWebissTable(_webissLastResults);
  } catch (e) {
    msg.innerHTML = `<span style="color:#dc2626">Erro ao consultar WebISS: ${e.message || e}</span>`;
  }
}

/** Importa as NFS-e do WebISS para o banco local */
async function importarWebiss() {
  const ini = document.getElementById('webiss-dt-ini').value;
  const fim = document.getElementById('webiss-dt-fim').value;
  const msg = document.getElementById('webiss-msg');
  if (!ini || !fim) { msg.textContent = 'Preencha as datas antes de importar.'; return; }

  if (!confirm(`Importar NFS-e do WebISS de ${ini} a ${fim} para o banco?\n\nNFs já existentes (mesmo número) serão ignoradas.`)) return;

  msg.innerHTML = '<span style="color:#64748b">Importando do WebISS…</span>';

  try {
    const d = await api('/webiss/importar', { method: 'POST', body: JSON.stringify({ dataInicial: ini, dataFinal: fim }) });
    if (!d.ok && d.erros?.length) {
      const erroList = d.erros.map(e => `[${e.codigo}] ${e.mensagem}`).join('; ');
      msg.innerHTML = `<span style="color:#dc2626">Erro WebISS: ${erroList}</span>`;
      return;
    }
    msg.innerHTML = `<span style="color:#15803d;font-weight:600">✓ Importadas: ${d.imported} | Já existiam: ${d.skipped} | Total: ${d.total}</span>`;
    // Atualiza a aba NFs da Prefeitura se estiver carregada
    if (document.getElementById('pref-sub-nfs').style.display !== 'none') loadPrefNfs();
  } catch (e) {
    msg.innerHTML = `<span style="color:#dc2626">Erro ao importar: ${e.message || e}</span>`;
  }
}

/** Abre o modal de emissão de NFS-e */
function abrirModalEmitirNfse() {
  const hoje = new Date().toISOString().substring(0, 10);
  document.getElementById('em-data-emissao').value = hoje;
  document.getElementById('em-competencia').value = hoje.substring(0, 7) + '-01';
  document.getElementById('modal-emitir-msg').textContent = '';
  document.getElementById('modal-emitir-nfse').style.display = 'flex';
}

/** Envia a emissão de NFS-e para o backend */
async function enviarEmissaoNfse() {
  const msg = document.getElementById('modal-emitir-msg');
  const rps = {
    numero:      document.getElementById('em-rps-num').value.trim(),
    serie:       document.getElementById('em-rps-serie').value.trim() || 'A',
    dataEmissao: document.getElementById('em-data-emissao').value,
    competencia: document.getElementById('em-competencia').value,
    servico: {
      valorServicos:   parseFloat(document.getElementById('em-vlr-servicos').value) || 0,
      issRetido:       document.getElementById('em-iss-retido').value === '1',
      itemLista:       document.getElementById('em-item-lista').value.trim(),
      aliquota:        parseFloat(document.getElementById('em-aliquota').value) || 0,
      discriminacao:   document.getElementById('em-discriminacao').value.trim(),
      exigibilidadeIss: 1,
    },
    tomador: {
      cnpj:       document.getElementById('em-tom-cnpj').value.replace(/\D/g, ''),
      razaoSocial: document.getElementById('em-tom-razao').value.trim(),
    },
  };

  if (!rps.numero || !rps.competencia || !rps.servico.valorServicos || !rps.tomador.cnpj || !rps.servico.discriminacao) {
    msg.innerHTML = '<span style="color:#dc2626">Preencha todos os campos obrigatórios.</span>';
    return;
  }

  msg.innerHTML = '<span style="color:#64748b">Emitindo NFS-e…</span>';

  try {
    const d = await api('/webiss/emitir', { method: 'POST', body: JSON.stringify({ rps }) });
    if (d.ok && d.nfse) {
      msg.innerHTML = `<span style="color:#15803d;font-weight:700">✓ NFS-e ${d.nfse.numero} emitida com sucesso!</span>`;
      setTimeout(() => { document.getElementById('modal-emitir-nfse').style.display = 'none'; }, 2000);
    } else if (d.erros?.length) {
      const erroList = d.erros.map(e => `[${e.codigo}] ${e.mensagem}${e.correcao ? ' — ' + e.correcao : ''}`).join('<br>');
      msg.innerHTML = `<span style="color:#dc2626">WebISS recusou a emissão:<br>${erroList}</span>`;
    } else {
      msg.innerHTML = `<span style="color:#dc2626">${d.error || 'Erro desconhecido'}</span>`;
    }
  } catch (e) {
    msg.innerHTML = `<span style="color:#dc2626">Erro: ${e.message || e}</span>`;
  }
}

// ─── Gerenciamento de Usuários ───────────────────────────────────
let _usuarioEditId = null;

const ROLE_LABELS = {
  admin:       '🔴 Admin',
  financeiro:  '🟡 Financeiro',
  operacional: '🟢 Operacional',
  visualizador:'⚪ Visualizador'
};
const ROLE_DESC = {
  admin:       'Acesso total — todas as abas, CRUD, gestão de usuários',
  financeiro:  'Leitura geral + lançar despesas, NFs e parcelas',
  operacional: 'Extratos, NFs e conciliação bancária',
  visualizador:'Somente leitura, sem criar ou editar'
};

async function loadUsuarios() {
  mostrarLogsSeAdmin();
  const d = await api('/usuarios');
  if (d.error) { document.getElementById('usuarios-body').innerHTML=`<tr><td colspan="7" style="color:#dc2626;padding:12px">${d.error}</td></tr>`; return; }
  const rows = d.data || [];

  // KPIs
  const ativos = rows.filter(r=>r.ativo).length;
  document.getElementById('usuarios-kpis').innerHTML = Object.entries(ROLE_LABELS).map(([role,label])=>{
    const qtd = rows.filter(r=>r.role===role&&r.ativo).length;
    return `<div class="kpi" style="flex:1;min-width:140px;border-left:4px solid #1d4ed8">
      <div class="kpi-l">${label}</div>
      <div class="kpi-v blue">${qtd}</div>
      <div class="kpi-s">${ROLE_DESC[role]}</div>
    </div>`;
  }).join('') + `<div class="kpi" style="flex:1;min-width:140px;border-left:4px solid #15803d">
    <div class="kpi-l">Total ativos</div><div class="kpi-v green">${ativos}</div>
    <div class="kpi-s">${rows.length} usuários cadastrados</div></div>`;

  // Tabela
  document.getElementById('usuarios-head').innerHTML=`
    <th>Login</th><th>Nome</th><th>E-mail</th><th>Nível</th><th>Status</th><th>Criado por</th><th>Ações</th>`;
  document.getElementById('usuarios-body').innerHTML = rows.map(u=>`
    <tr style="opacity:${u.ativo?1:.5}">
      <td class="mono" style="font-weight:600">${u.usuario}</td>
      <td>${u.nome}</td>
      <td style="font-size:11px;color:#64748b">${u.email||'—'}</td>
      <td><span style="background:${u.role==='admin'?'#fee2e2':u.role==='financeiro'?'#fef3c7':u.role==='operacional'?'#dcfce7':'#f1f5f9'};
          padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600">${ROLE_LABELS[u.role]||u.role}</span></td>
      <td><span style="background:${u.ativo?'#dcfce7':'#f1f5f9'};padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;color:${u.ativo?'#15803d':'#64748b'}">${u.ativo?'Ativo':'Inativo'}</span></td>
      <td style="font-size:11px;color:#94a3b8">${u.criado_por||'sistema'}</td>
      <td style="white-space:nowrap">
        <button onclick="editarUsuario(${u.id})" style="background:#f1f5f9;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px">✏️</button>
        ${u.usuario!=='admin'?`<button onclick="excluirUsuario(${u.id},'${u.nome}')" style="background:#fee2e2;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;margin-left:4px">🗑️</button>`:''}
      </td>
    </tr>`).join('');
}

function abrirModalNovoUsuario() {
  _usuarioEditId = null;
  document.getElementById('modal-usuario-titulo').textContent = 'Novo Usuário';
  document.getElementById('usu-login').value = '';
  document.getElementById('usu-login').disabled = false;
  document.getElementById('usu-nome').value = '';
  document.getElementById('usu-email').value = '';
  document.getElementById('usu-senha').value = '';
  document.getElementById('usu-senha').placeholder = 'Mínimo 6 caracteres';
  document.getElementById('usu-role').value = 'financeiro';
  document.getElementById('usu-ativo-wrap').style.display = 'none';
  document.getElementById('usu-erro').style.display = 'none';
  document.getElementById('modal-usuario').style.display = 'flex';
}

async function editarUsuario(id) {
  const d = await api('/usuarios');
  const user = (d.data||[]).find(u=>u.id===id);
  if (!user) return;
  _usuarioEditId = id;
  document.getElementById('modal-usuario-titulo').textContent = 'Editar Usuário';
  document.getElementById('usu-login').value = user.usuario;
  document.getElementById('usu-login').disabled = true;
  document.getElementById('usu-nome').value = user.nome;
  document.getElementById('usu-email').value = user.email||'';
  document.getElementById('usu-senha').value = '';
  document.getElementById('usu-senha').placeholder = 'Deixe vazio para não alterar a senha';
  document.getElementById('usu-role').value = user.role;
  document.getElementById('usu-ativo').value = user.ativo;
  document.getElementById('usu-ativo-wrap').style.display = 'block';
  document.getElementById('usu-erro').style.display = 'none';
  document.getElementById('modal-usuario').style.display = 'flex';
}

function fecharModalUsuario() {
  document.getElementById('modal-usuario').style.display = 'none';
}

async function salvarUsuario() {
  const errEl = document.getElementById('usu-erro');
  errEl.style.display='none';
  const login = document.getElementById('usu-login').value.trim();
  const nome  = document.getElementById('usu-nome').value.trim();
  const email = document.getElementById('usu-email').value.trim();
  const senha = document.getElementById('usu-senha').value;
  const role  = document.getElementById('usu-role').value;
  const ativo = parseInt(document.getElementById('usu-ativo')?.value ?? '1');

  if (!nome) { errEl.textContent='Nome obrigatório'; errEl.style.display='block'; return; }
  if (!_usuarioEditId && !senha) { errEl.textContent='Senha obrigatória para novo usuário'; errEl.style.display='block'; return; }

  const opts = { method: _usuarioEditId ? 'PATCH' : 'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(_usuarioEditId
      ? { nome, email, senha: senha||undefined, role, ativo }
      : { usuario: login, nome, email, senha, role })
  };
  const url = _usuarioEditId ? `/usuarios/${_usuarioEditId}` : '/usuarios';
  const d = await api(url, opts);
  if (d.error) { errEl.textContent=d.error; errEl.style.display='block'; return; }
  fecharModalUsuario();
  toast(_usuarioEditId ? 'Usuário atualizado' : 'Usuário criado');
  loadUsuarios();
}

async function excluirUsuario(id, nome) {
  if (!confirm(`Remover o usuário "${nome}"?`)) return;
  const d = await api(`/usuarios/${id}`, { method:'DELETE' });
  if (d.error) { toast('Erro: '+d.error); return; }
  toast('Usuário removido');
  loadUsuarios();
}

// ─── Logs de erros do sistema (só admin) ─────────────────────
async function loadLogs() {
  const n   = document.getElementById('logs-n')?.value || 100;
  const box = document.getElementById('logs-lista');
  const tot = document.getElementById('logs-total');
  if (!box) return;
  box.innerHTML = '<span style="color:#64748b">Carregando...</span>';
  const d = await fetch(`/api/logs?n=${n}`, {
    headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
  }).then(r => r.json()).catch(() => null);
  if (!d || d.error) { box.innerHTML = '<span style="color:#dc2626">' + (d?.error || 'Erro ao carregar') + '</span>'; return; }
  if (tot) tot.textContent = `Total no arquivo: ${d.total} linha(s)`;
  if (!d.linhas.length) { box.innerHTML = '<span style="color:#475569">Nenhum erro registrado. ✅</span>'; return; }
  box.innerHTML = d.linhas.map(l => {
    const cor = l.includes('[SERVER]') ? '#f87171' : '#fbbf24';
    return `<span style="color:${cor}">${l.replace(/</g,'&lt;')}</span>`;
  }).join('\n');
}

// Mostrar seção de logs ao entrar na aba usuários (só admin)
function mostrarLogsSeAdmin() {
  const sec = document.getElementById('logs-section');
  if (!sec) return;
  const u = JSON.parse(localStorage.getItem('user') || '{}');
  if (u.role === 'admin') { sec.style.display = 'block'; loadLogs(); }
  else sec.style.display = 'none';
}

// ─── F-3: Exportação Excel ───────────────────────────────────────
function exportarExcel(tipo) {
  let url = `/export/${tipo}`;
  const params = [];
  if (_from) params.push('from=' + _from);
  if (_to)   params.push('to='   + _to);
  // Filtros específicos da aba Auditoria
  if (tipo === 'audit') {
    const t  = document.getElementById('audit-tabela')?.value;
    const u  = document.getElementById('audit-usuario')?.value;
    const af = document.getElementById('audit-from')?.value;
    const at = document.getElementById('audit-to')?.value;
    if (t)  params.push('tabela='  + encodeURIComponent(t));
    if (u)  params.push('usuario=' + encodeURIComponent(u));
    if (af) { params.push('from='  + af); }
    if (at) { params.push('to='    + at); }
  }
  if (params.length) url += '?' + params.join('&');
  // Adiciona header de auth via link
  const token = localStorage.getItem('montana_token') || '';
  // Força download via fetch e blob para enviar header X-Company
  showLoading('Gerando Excel…');
  fetch('/api' + url, { headers: { 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token } })
    .then(r => r.blob())
    .then(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = tipo + '_export.xlsx';
      a.click();
      URL.revokeObjectURL(a.href);
    })
    .catch(e => toast('Erro ao exportar: ' + e.message, 'error'))
    .finally(() => hideLoading());
}

// ─── F-4: Dashboard por contrato ────────────────────────────────
async function abrirDetalheContrato(numContrato) {
  const m = document.getElementById('modal-contrato-detalhe');
  if (!m) return;
  m.style.display = 'flex';
  document.getElementById('mcd-title').textContent = 'Carregando…';
  document.getElementById('mcd-body').innerHTML = '<div class="loading">Carregando dados do contrato…</div>';

  showLoading('Carregando detalhe do contrato…');
  const d = await api('/contratos/' + encodeURIComponent(numContrato) + '/detalhe');
  hideLoading();

  if (d.error) { document.getElementById('mcd-body').innerHTML = `<p style="color:#dc2626">${d.error}</p>`; return; }
  const c = d.contrato;
  const r = d.resumo;

  document.getElementById('mcd-title').textContent = c.contrato + ' — ' + c.numContrato;

  // Fluxo mensal mini-gráfico
  const maxReceb = Math.max(...(d.fluxoMensal || []).map(f => f.recebido || 0), 1);
  const fluxoHtml = (d.fluxoMensal || []).map(f => {
    const h = Math.max(((f.recebido||0)/maxReceb)*60, 2);
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px">
      <div style="font-size:8px;color:#15803d">${(f.recebido/1000).toFixed(0)}k</div>
      <div style="width:24px;height:${h}px;background:#22c55e;border-radius:3px 3px 0 0" title="${brl(f.recebido)}"></div>
      <div style="font-size:7px;color:#94a3b8">${f.mes.slice(5)}</div>
    </div>`;
  }).join('');

  document.getElementById('mcd-body').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
      <div class="kpi" style="border-left:4px solid #15803d"><div class="kpi-l">Total Recebido</div><div class="kpi-v green">${brl(r.totalRecebido)}</div><div class="kpi-s">${r.qtdExtratos} lançamentos</div></div>
      <div class="kpi" style="border-left:4px solid #7c3aed"><div class="kpi-l">NFs Emitidas</div><div class="kpi-v" style="color:#7c3aed">${brl(r.totalNFs)}</div><div class="kpi-s">${r.qtdNFs} notas fiscais</div></div>
      <div class="kpi" style="border-left:4px solid #0891b2"><div class="kpi-l">Despesas</div><div class="kpi-v" style="color:#0891b2">${brl(r.totalDespesas)}</div><div class="kpi-s">${r.qtdDespesas} lançamentos</div></div>
      <div class="kpi" style="border-left:4px solid ${r.margem>=0?'#15803d':'#dc2626'}"><div class="kpi-l">Margem Estimada</div><div class="kpi-v ${r.margem>=0?'green':'red'}">${r.margem.toFixed(1)}%</div><div class="kpi-s">receita − despesas</div></div>
    </div>
    ${d.fluxoMensal?.length ? `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;color:#334155;margin-bottom:8px">Fluxo de Recebimentos Mensais</div>
      <div style="display:flex;gap:6px;align-items:flex-end;height:80px">${fluxoHtml}</div>
    </div>` : ''}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div>
        <div style="font-size:11px;font-weight:700;color:#334155;margin-bottom:6px">Últimas NFs Emitidas (${d.nfs.length})</div>
        <div class="tw"><table><thead><tr><th>NF</th><th>Data</th><th class="r">V. Bruto</th></tr></thead><tbody>
          ${d.nfs.slice(0,8).map(n=>`<tr><td class="mono" style="color:#7c3aed">NF ${n.numero}</td><td style="font-size:10px">${n.data_emissao||n.competencia}</td><td class="r mono">${brl(n.valor_bruto)}</td></tr>`).join('')}
        </tbody></table></div>
      </div>
      <div>
        <div style="font-size:11px;font-weight:700;color:#334155;margin-bottom:6px">Últimas Despesas (${d.despesas.length})</div>
        <div class="tw"><table><thead><tr><th>Categoria</th><th>Descrição</th><th class="r">V. Bruto</th></tr></thead><tbody>
          ${d.despesas.slice(0,8).map(d2=>`<tr><td style="font-size:9px">${d2.categoria}</td><td style="font-size:10px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${d2.descricao||''}</td><td class="r mono">${brl(d2.valor_bruto)}</td></tr>`).join('')}
        </tbody></table></div>
      </div>
    </div>`;
}

function fecharDetalheContrato() {
  const m = document.getElementById('modal-contrato-detalhe');
  if (m) m.style.display = 'none';
}

// ─── F-1: Conciliação 3 Vias ─────────────────────────────────────
async function loadConciliacao3Vias() {
  const cont = document.getElementById('c3v-filtro-contrato')?.value || '';
  let url = '/conciliacao/tres-vias?';
  if (_from) url += 'from=' + _from + '&';
  if (_to)   url += 'to='   + _to   + '&';
  if (cont)  url += 'contrato=' + encodeURIComponent(cont);

  document.getElementById('c3v-resumo').innerHTML = '<div class="loading">Carregando conciliação…</div>';
  showLoading('Calculando conciliação 3 vias…');
  const d = await api(url);
  hideLoading();
  if (d.error) { document.getElementById('c3v-resumo').innerHTML = `<p style="color:#dc2626">${d.error}</p>`; return; }

  const t = d.totais;
  document.getElementById('c3v-kpis').innerHTML = `
    <div class="kpi" style="border-left:4px solid #7c3aed"><div class="kpi-l">NFs Emitidas</div><div class="kpi-v" style="color:#7c3aed">${brl(t.totalNFs)}</div><div class="kpi-s">${d.nfs.length} notas</div></div>
    <div class="kpi" style="border-left:4px solid #15803d"><div class="kpi-l">Recebido (Extrato)</div><div class="kpi-v green">${brl(t.totalExtrato)}</div><div class="kpi-s">${d.extratos.length} lançamentos</div></div>
    <div class="kpi" style="border-left:4px solid #1d4ed8"><div class="kpi-l">Pago pelo Gov.</div><div class="kpi-v blue">${brl(t.totalPagamentos)}</div><div class="kpi-s">${d.pagamentos.length} OBs</div></div>
    <div class="kpi" style="border-left:4px solid ${t.qtdDivergente?'#dc2626':'#15803d'}">
      <div class="kpi-l">Status</div>
      <div class="kpi-v ${t.qtdDivergente?'red':'green'}">${t.qtdOK} OK · ${t.qtdDivergente} Div.</div>
      <div class="kpi-s">por contrato</div>
    </div>`;

  const statusColor = { OK:'#15803d', EXTRATO_MAIOR:'#d97706', NF_MAIOR:'#dc2626' };
  const statusLabel = { OK:'✅ OK', EXTRATO_MAIOR:'⬆ Extrato maior', NF_MAIOR:'⬇ NF maior' };

  document.getElementById('c3v-resumo').innerHTML = `
    <div style="font-size:12px;font-weight:700;color:#334155;margin-bottom:8px">Resumo por Contrato</div>
    <div class="tw"><table>
      <thead><tr><th>Contrato</th><th class="r">NFs</th><th class="r">Total NFs</th><th class="r">Extratos</th><th class="r">Total Extrato</th><th class="r">Diferença</th><th>Status</th></tr></thead>
      <tbody>${(d.resumo||[]).map(r=>`<tr>
        <td style="font-size:11px;font-weight:600">${r.contrato}</td>
        <td class="r mono muted">${r.qtdNFs}</td>
        <td class="r mono" style="color:#7c3aed">${brl(r.totalNFs)}</td>
        <td class="r mono muted">${r.qtdExtratos}</td>
        <td class="r mono green">${brl(r.totalExtrato)}</td>
        <td class="r mono" style="color:${statusColor[r.status]};font-weight:700">${brl(r.diferenca)}</td>
        <td><span style="font-size:10px;font-weight:600;color:${statusColor[r.status]}">${statusLabel[r.status]}</span></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
}

// ─── Créditos Pendentes / Não Identificados ──────────────────────
async function loadCreditosPendentes() {
  const panel = document.getElementById('creditos-pendentes-panel');
  if (!panel) return;
  panel.innerHTML = '<div class="loading">Analisando créditos bancários...</div>';
  try {
    let url = '/conciliacao/creditos';
    if (_from) url += '?from=' + _from;
    if (_to)   url += (_from ? '&' : '?') + 'to=' + _to;
    const d = await api(url);
    if (!d.ok) { panel.innerHTML = `<p style="color:#dc2626">Erro: ${d.error||'desconhecido'}</p>`; return; }

    const s = d.sumario;
    const pctIdent = s.pct_identificado;
    const barColor = pctIdent >= 80 ? '#15803d' : pctIdent >= 50 ? '#d97706' : '#dc2626';

    // KPIs
    const kpis = `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <div style="flex:1;min-width:130px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px">
          <div style="font-size:9px;color:#64748b;font-weight:700;text-transform:uppercase">Total Pendente</div>
          <div style="font-size:15px;font-weight:800;color:#7c3aed">${brl(s.total_pendente)}</div>
          <div style="font-size:9px;color:#94a3b8">${s.qtd_pendente} lançamentos</div>
        </div>
        <div style="flex:1;min-width:130px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px">
          <div style="font-size:9px;color:#64748b;font-weight:700;text-transform:uppercase">Identificados</div>
          <div style="font-size:15px;font-weight:800;color:#15803d">${brl(s.total_identificado)}</div>
          <div style="font-size:9px;color:#94a3b8">${s.qtd_identificado} lançamentos</div>
        </div>
        <div style="flex:1;min-width:130px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px">
          <div style="font-size:9px;color:#64748b;font-weight:700;text-transform:uppercase">Não Identificados</div>
          <div style="font-size:15px;font-weight:800;color:#dc2626">${brl(s.total_nao_identificado)}</div>
          <div style="font-size:9px;color:#94a3b8">${s.qtd_nao_identificado} lançamentos</div>
        </div>
        <div style="flex:1;min-width:130px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px">
          <div style="font-size:9px;color:#64748b;font-weight:700;text-transform:uppercase">% Identificado</div>
          <div style="font-size:15px;font-weight:800;color:${barColor}">${pctIdent}%</div>
          <div style="background:#e2e8f0;border-radius:4px;height:6px;margin-top:6px;overflow:hidden">
            <div style="background:${barColor};height:100%;width:${Math.min(pctIdent,100)}%"></div>
          </div>
        </div>
      </div>`;

    // Tabela de categorizados
    const thSt = 'background:#1e293b;color:#fff;padding:6px 10px;font-size:9px;font-weight:700;text-transform:uppercase;white-space:nowrap';
    const tdSt = 'padding:5px 10px;border-bottom:1px solid #e2e8f0;font-size:11px';
    const CATEG_COLOR = { CONTRATO:'#1d4ed8', INTERNO:'#6b7280', INVESTIMENTO:'#0891b2', ESTADO_TO:'#059669', DEVOLVIDO:'#d97706', NEVADA:'#7c3aed', MUSTANG:'#7c3aed' };
    const catRows = (d.categorizado||[]).map(c => {
      const cor = CATEG_COLOR[c.categoria] || '#334155';
      const pct = s.total_pendente > 0 ? (c.total / s.total_pendente * 100).toFixed(1) : 0;
      return `<tr>
        <td style="${tdSt};font-weight:600;color:${cor}">${c.chave}</td>
        <td style="${tdSt};text-align:center"><span style="font-size:9px;padding:2px 7px;border-radius:10px;background:${cor}22;color:${cor};font-weight:700">${c.categoria}</span></td>
        <td style="${tdSt};text-align:center;color:#64748b">${c.qtd}</td>
        <td style="${tdSt};text-align:right;font-family:monospace;font-weight:700;color:${cor}">${brl(c.total)}</td>
        <td style="${tdSt};text-align:center;color:#94a3b8;font-size:10px">${pct}%</td>
      </tr>`;
    }).join('');

    // Top não identificados
    const niRows = (d.nao_identificados_top20||[]).map(e => `<tr>
      <td style="${tdSt};color:#64748b;font-family:monospace">${e.data}</td>
      <td style="${tdSt};text-align:right;font-family:monospace;color:#dc2626;font-weight:700">${brl(e.credito)}</td>
      <td style="${tdSt};font-size:10px;color:#475569;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${e.historico}">${e.historico||'—'}</td>
    </tr>`).join('');

    panel.innerHTML = `
      ${kpis}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:4px">
        <div>
          <div style="font-size:11px;font-weight:700;color:#334155;margin-bottom:6px">Por Contrato / Categoria</div>
          <div style="overflow-x:auto;border-radius:8px;border:1px solid #e2e8f0">
            <table style="width:100%;border-collapse:collapse">
              <thead><tr>
                <th style="${thSt};text-align:left;border-radius:8px 0 0 0">Chave</th>
                <th style="${thSt};text-align:center">Tipo</th>
                <th style="${thSt};text-align:center">Qtd</th>
                <th style="${thSt};text-align:right">Total</th>
                <th style="${thSt};text-align:center;border-radius:0 8px 0 0">%</th>
              </tr></thead>
              <tbody>${catRows}</tbody>
            </table>
          </div>
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;color:#dc2626;margin-bottom:6px">🔴 Top 20 Não Identificados</div>
          <div style="overflow-x:auto;border-radius:8px;border:1px solid #fca5a5">
            <table style="width:100%;border-collapse:collapse">
              <thead><tr>
                <th style="${thSt};text-align:left;background:#7f1d1d;border-radius:8px 0 0 0">Data</th>
                <th style="${thSt};text-align:right;background:#7f1d1d">Valor</th>
                <th style="${thSt};text-align:left;background:#7f1d1d;border-radius:0 8px 0 0">Histórico</th>
              </tr></thead>
              <tbody>${niRows}</tbody>
            </table>
          </div>
        </div>
      </div>`;
  } catch(e) {
    panel.innerHTML = `<p style="color:#dc2626;font-size:11px">Erro ao carregar créditos: ${e.message}</p>`;
    console.error('creditos pendentes:', e);
  }
}

// ─── A-2: Keywords de Auto-Vinculação ───────────────────────────
let _keywords = [];

async function loadKeywords() {
  const d = await api('/configuracoes/keywords');
  _keywords = d.keywords || [];
  renderKeywords();
}

function renderKeywords() {
  const c = document.getElementById('keywords-lista');
  if (!c) return;
  c.innerHTML = _keywords.map((k, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f1f5f9">
      <input type="text" value="${k.palavra}" placeholder="Palavra-chave"
        style="flex:1;padding:4px 8px;font-size:12px;border:1px solid #e2e8f0;border-radius:4px"
        onchange="_keywords[${i}].palavra=this.value">
      <input type="text" value="${k.contrato||''}" placeholder="Contrato (opcional)"
        style="flex:1;padding:4px 8px;font-size:12px;border:1px solid #e2e8f0;border-radius:4px"
        onchange="_keywords[${i}].contrato=this.value">
      <button onclick="_keywords.splice(${i},1);renderKeywords()" style="padding:2px 8px;background:#fee2e2;color:#dc2626;border:1px solid #fca5a5;border-radius:4px;cursor:pointer;font-size:11px" title="Remover">✕</button>
    </div>`).join('');
}

async function addKeyword() {
  _keywords.push({ palavra: '', contrato: '' });
  renderKeywords();
  const inputs = document.querySelectorAll('#keywords-lista input[type="text"]');
  if (inputs.length) inputs[inputs.length - 2].focus();
}

async function saveKeywords() {
  try {
    const d = await api('/configuracoes/keywords', {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ keywords: _keywords.filter(k => k.palavra.trim()) })
    });
    if (d.ok) toast('✅ Keywords salvas!');
    else toast('Erro: ' + (d.error || 'desconhecido'));
  } catch(e) { toast('Erro: ' + e.message); }
}

// ─── BUSCA GLOBAL ─────────────────────────────────────────────────
let _buscaTimer = null;

function buscaGlobalDebounce() {
  clearTimeout(_buscaTimer);
  _buscaTimer = setTimeout(executarBuscaGlobal, 350);
}

function fecharBuscaGlobal() {
  const el = document.getElementById('busca-resultado');
  if (el) el.style.display = 'none';
  const inp = document.getElementById('busca-global');
  if (inp) inp.value = '';
}

async function executarBuscaGlobal() {
  const q = (document.getElementById('busca-global')?.value || '').trim();
  const el = document.getElementById('busca-resultado');
  if (!el) return;
  if (q.length < 2) { el.style.display = 'none'; return; }

  el.style.display = 'block';
  el.innerHTML = '<div style="padding:10px;color:#94a3b8;font-size:11px">Buscando…</div>';

  try {
    const [exts, nfs, conts] = await Promise.all([
      api(`/extratos?limit=5&historico=${encodeURIComponent(q)}`).catch(() => ({ data: [] })),
      api(`/nfs?tomador=${encodeURIComponent(q)}&limit=5`).catch(() => ({ data: [] })),
      api('/contratos').catch(() => ({ data: [] })),
    ]);

    const contsFiltrados = (conts.data || []).filter(c =>
      c.contrato.toLowerCase().includes(q.toLowerCase()) ||
      c.numContrato.toLowerCase().includes(q.toLowerCase()) ||
      (c.orgao || '').toLowerCase().includes(q.toLowerCase())
    ).slice(0, 5);

    let html = '';
    const tdSt = 'padding:4px 8px;font-size:11px;border-bottom:1px solid #f1f5f9';

    if (contsFiltrados.length) {
      html += `<div style="padding:4px 10px;font-size:9px;font-weight:700;color:#64748b;background:#f8fafc;text-transform:uppercase">Contratos</div>`;
      contsFiltrados.forEach(c => {
        html += `<div style="${tdSt};cursor:pointer;display:flex;justify-content:space-between" onclick="fecharBuscaGlobal();navegarPara('cont');setTimeout(()=>abrirDetalheContrato('${c.numContrato.replace(/'/g,"\\'")}'),400)">
          <span style="font-weight:600">${c.numContrato}</span>
          <span style="color:#64748b">${c.contrato.slice(0,40)}</span>
        </div>`;
      });
    }

    if ((nfs.data || []).length) {
      html += `<div style="padding:4px 10px;font-size:9px;font-weight:700;color:#64748b;background:#f8fafc;text-transform:uppercase">Notas Fiscais</div>`;
      (nfs.data || []).forEach(n => {
        html += `<div style="${tdSt};display:flex;justify-content:space-between">
          <span style="color:#7c3aed">NF ${n.numero}</span>
          <span style="color:#64748b">${(n.tomador||'').slice(0,40)}</span>
          <span style="font-family:monospace">${brl(n.valor_bruto)}</span>
        </div>`;
      });
    }

    if (!html) html = '<div style="padding:10px;color:#94a3b8;font-size:11px">Nenhum resultado para "' + q + '"</div>';
    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = `<div style="padding:10px;color:#dc2626;font-size:11px">Erro na busca: ${e.message}</div>`;
  }
}

function navegarPara(id) {
  const link = document.querySelector(`[data-tab="${id}"]`) || document.querySelector(`#tab-${id}`);
  if (link) link.click();
}

// ─── CONCILIAR POR VALOR ─────────────────────────────────────────
async function conciliarAutoValor() {
  toast('Buscando matches por valor...');
  try {
    const d = await api('/conciliacao/match-por-valor?tolerancia=0.01');
    if (!d.ok) { toast('Erro: ' + (d.error || 'desconhecido')); return; }
    if (d.com_sugestao === 0) { toast(`Nenhum match encontrado (${d.sem_historico_total} sem histórico)`); return; }
    toast(`✅ ${d.com_sugestao} sugestão(ões) encontrada(s) de ${d.sem_historico_total} lançamentos sem histórico.`);
    // Exibe resumo rápido no console para debug
    console.log('Matches por valor:', d.sugestoes);
  } catch(e) { toast('Erro: ' + e.message); }
}

// ─── REAJUSTES ────────────────────────────────────────────────────
async function loadReajustes() {
  const el = document.getElementById('reajustes-corpo');
  if (!el) return;
  el.innerHTML = '<tr><td colspan="8" style="padding:16px;text-align:center;color:#94a3b8;font-size:11px">Carregando...</td></tr>';
  try {
    const d = await api('/reajustes');
    if (!d.data) return;

    const corAlerta = { atrasado:'#fee2e2', proximo:'#fef9c3', vencimento_proximo:'#fef9c3', sem_registro:'#f1f5f9' };
    const tdSt = 'padding:6px 10px;font-size:11px;border-bottom:1px solid #e2e8f0';
    el.innerHTML = d.data.map(r => {
      const bg = r.alerta ? `background:${corAlerta[r.alerta]}` : '';
      const badge = r.alerta === 'atrasado' ? '🔴 Atrasado'
                  : r.alerta === 'proximo' ? '⚠️ A Vencer'
                  : r.alerta === 'vencimento_proximo' ? '⏳ Vigência'
                  : r.alerta === 'sem_registro' ? '— Sem reg.' : '✅';
      return `<tr style="${bg}">
        <td style="${tdSt};font-weight:600">${r.numContrato}</td>
        <td style="${tdSt}">${r.contrato.slice(0,30)}</td>
        <td style="${tdSt};text-align:center">${r.data_ultimo_reajuste || '—'}</td>
        <td style="${tdSt};text-align:center">${r.data_proximo_reajuste || '—'}</td>
        <td style="${tdSt};text-align:center">${r.indice_reajuste || '—'}</td>
        <td style="${tdSt};text-align:right">${r.pct_reajuste_ultimo != null ? r.pct_reajuste_ultimo.toFixed(2)+'%' : '—'}</td>
        <td style="${tdSt};text-align:center;font-size:10px">${badge}</td>
        <td style="${tdSt};text-align:center">
          <button onclick="abrirModalReajuste('${r.numContrato.replace(/'/g,"\\'")}','${(r.contrato||'').slice(0,20).replace(/'/g,"\\'")}',this)"
            style="padding:3px 8px;font-size:9px;border:1px solid #7c3aed;border-radius:4px;background:#f5f3ff;color:#7c3aed;cursor:pointer">Registrar</button>
        </td>
      </tr>`;
    }).join('');

    // Atualiza resumo se existir
    const resumoEl = document.getElementById('reajustes-resumo');
    if (resumoEl && d.resumo) {
      resumoEl.innerHTML = `
        <span style="font-size:11px;color:#64748b">${d.resumo.total} contratos</span>
        ${d.resumo.atrasado ? `<span style="font-size:11px;background:#fee2e2;color:#b91c1c;padding:2px 8px;border-radius:10px;margin-left:8px">🔴 ${d.resumo.atrasado} atrasados</span>` : ''}
        ${d.resumo.proximo ? `<span style="font-size:11px;background:#fef9c3;color:#92400e;padding:2px 8px;border-radius:10px;margin-left:8px">⚠️ ${d.resumo.proximo} a vencer</span>` : ''}
        ${d.resumo.sem_registro ? `<span style="font-size:11px;background:#f1f5f9;color:#475569;padding:2px 8px;border-radius:10px;margin-left:8px">— ${d.resumo.sem_registro} sem registro</span>` : ''}
      `;
    }
  } catch(e) { el.innerHTML = `<tr><td colspan="8" style="padding:12px;color:#dc2626;font-size:11px">Erro: ${e.message}</td></tr>`; }
}

function abrirModalReajuste(num, nome, btn) {
  const el = document.getElementById('modal-reajuste');
  if (!el) return;
  document.getElementById('reaj-num').value = num;
  document.getElementById('reaj-nome').textContent = nome;
  el.style.display = 'flex';
}

function fecharModalReajuste() {
  const el = document.getElementById('modal-reajuste');
  if (el) el.style.display = 'none';
}

async function salvarReajuste() {
  const num = document.getElementById('reaj-num')?.value;
  if (!num) return;
  const body = {
    data_ultimo_reajuste:  document.getElementById('reaj-data-ultimo')?.value || null,
    indice_reajuste:       document.getElementById('reaj-indice')?.value || null,
    pct_reajuste_ultimo:   parseFloat(document.getElementById('reaj-pct')?.value) || null,
    data_proximo_reajuste: document.getElementById('reaj-data-proximo')?.value || null,
    obs_reajuste:          document.getElementById('reaj-obs')?.value || null,
  };
  try {
    const d = await api('/reajustes/' + encodeURIComponent(num), {
      method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body)
    });
    if (d.ok) { toast('✅ Reajuste registrado!'); fecharModalReajuste(); loadReajustes(); }
    else toast('Erro: ' + (d.error || 'desconhecido'));
  } catch(e) { toast('Erro: ' + e.message); }
}

// ─── RETENÇÕES ────────────────────────────────────────────────────
async function loadRetencoes() {
  const el = document.getElementById('ret-tabela-corpo');
  const esfera = document.getElementById('ret-esfera')?.value || '';
  const status = document.getElementById('ret-status')?.value || '';
  if (!el) return;
  el.innerHTML = '<tr><td colspan="10" style="padding:16px;text-align:center;color:#94a3b8;font-size:11px">Carregando...</td></tr>';
  try {
    const d = await api('/retencoes/analise');
    let rows = d.resultado || [];
    if (esfera) rows = rows.filter(r => r.esfera === esfera);
    if (status === 'divergente') rows = rows.filter(r => Math.abs(r.diff) > 1);
    if (status === 'sem_retencao') rows = rows.filter(r => r.retencao_real === 0);

    const tdSt = 'padding:5px 8px;font-size:10px;border-bottom:1px solid #e2e8f0;white-space:nowrap';
    el.innerHTML = rows.slice(0, 200).map(r => {
      const diverge = Math.abs(r.diff) > 1;
      const bg = diverge ? 'background:#fff7ed' : r.retencao_real === 0 ? 'background:#f0fdf4' : '';
      return `<tr style="${bg}">
        <td style="${tdSt};color:#7c3aed">NF ${r.numero}</td>
        <td style="${tdSt}">${r.competencia || ''}</td>
        <td style="${tdSt};max-width:140px;overflow:hidden;text-overflow:ellipsis" title="${r.tomador||''}">${(r.tomador||'').slice(0,25)}</td>
        <td style="${tdSt};text-align:center"><span style="font-size:9px;padding:1px 5px;border-radius:8px;background:#e0f2fe;color:#0284c7">${r.esferaLabel||''}</span></td>
        <td style="${tdSt};text-align:right;font-family:monospace">${brl(r.valor_bruto)}</td>
        <td style="${tdSt};text-align:right;font-family:monospace">${brl(r.retencao_real)}</td>
        <td style="${tdSt};text-align:right;font-family:monospace">${brl(r.retencao_esperada)}</td>
        <td style="${tdSt};text-align:right;font-family:monospace;color:${diverge?'#dc2626':'#15803d'}">${diverge?'⚠️ ':''} ${brl(Math.abs(r.diff))}</td>
        <td style="${tdSt};text-align:center;font-size:9px;color:${diverge?'#dc2626':'#64748b'}">${r.pctDiff ? r.pctDiff.toFixed(1)+'%' : '—'}</td>
        <td style="${tdSt};max-width:80px;font-size:9px;color:#64748b;overflow:hidden;text-overflow:ellipsis">${r.nota||''}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="10" style="padding:12px;text-align:center;color:#94a3b8;font-size:11px">Nenhum registro encontrado</td></tr>';
  } catch(e) {
    el.innerHTML = `<tr><td colspan="10" style="padding:12px;color:#dc2626;font-size:11px">Erro: ${e.message}</td></tr>`;
  }
}

async function loadRelatorioRetencao() {
  const el = document.getElementById('ret-relatorio');
  if (!el) return;
  el.innerHTML = '<div style="padding:10px;color:#94a3b8;font-size:11px">Calculando...</div>';
  try {
    const d = await api('/retencoes/analise');
    const resumo = d.resumo || {};
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:12px">
        <div class="kpi"><div class="kpi-l">Total Retido (Real)</div><div class="kpi-v blue">${brl(resumo.totalRetReal||0)}</div></div>
        <div class="kpi"><div class="kpi-l">Total Esperado</div><div class="kpi-v">${brl(resumo.totalRetEsperada||0)}</div></div>
        <div class="kpi"><div class="kpi-l">Divergência Total</div><div class="kpi-v ${Math.abs((resumo.totalRetReal||0)-(resumo.totalRetEsperada||0))>100?'red':'green'}">${brl(Math.abs((resumo.totalRetReal||0)-(resumo.totalRetEsperada||0)))}</div></div>
        <div class="kpi"><div class="kpi-l">NFs Divergentes</div><div class="kpi-v ${resumo.divergentes>0?'red':'green'}">${resumo.divergentes||0}</div></div>
      </div>`;
    loadRetencoes();
  } catch(e) { el.innerHTML = `<div style="color:#dc2626;font-size:11px">Erro: ${e.message}</div>`; }
}

// ─── MARGEM / DRE ─────────────────────────────────────────────────
async function loadMargem() {
  const el = document.getElementById('margem-corpo');
  if (!el) return;
  const from = document.getElementById('margem-from')?.value || '';
  const to   = document.getElementById('margem-to')?.value   || '';
  el.innerHTML = '<tr><td colspan="8" style="padding:16px;text-align:center;color:#94a3b8;font-size:11px">Carregando...</td></tr>';
  try {
    let url = '/relatorios/lucro-por-contrato';
    if (from || to) url += '?' + [from?'from='+from:'', to?'to='+to:''].filter(Boolean).join('&');
    const d = await api(url);
    const rows = d.data || [];
    const tdSt = 'padding:6px 10px;font-size:11px;border-bottom:1px solid #e2e8f0;white-space:nowrap';
    el.innerHTML = rows.map(r => {
      const margemColor = r.margem >= 20 ? '#15803d' : r.margem >= 0 ? '#d97706' : '#dc2626';
      return `<tr>
        <td style="${tdSt};font-weight:700;max-width:160px;overflow:hidden;text-overflow:ellipsis" title="${r.contrato}">${r.numContrato}</td>
        <td style="${tdSt};max-width:160px;overflow:hidden;text-overflow:ellipsis">${r.contrato}</td>
        <td style="${tdSt};text-align:right;font-family:monospace">${brl(r.receita)}</td>
        <td style="${tdSt};text-align:right;font-family:monospace;color:#dc2626">${brl(r.totalDespesas)}</td>
        <td style="${tdSt};text-align:right;font-family:monospace;color:#7c3aed">${brl(r.totalRetencao||0)}</td>
        <td style="${tdSt};text-align:right;font-family:monospace;font-weight:700;color:${margemColor}">${brl(r.lucro)}</td>
        <td style="${tdSt};text-align:center;font-weight:700;color:${margemColor}">${r.margem.toFixed(1)}%</td>
        <td style="${tdSt};text-align:center"><button onclick="abrirDetalheContrato('${r.numContrato.replace(/'/g,"\\'")}');navegarPara('cont')" style="padding:2px 8px;font-size:9px;border:1px solid #7c3aed;border-radius:4px;background:#f5f3ff;color:#7c3aed;cursor:pointer">Ver</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="8" style="padding:12px;text-align:center;color:#94a3b8;font-size:11px">Nenhum dado encontrado</td></tr>';

    // Totais
    const totalEl = document.getElementById('margem-totais');
    if (totalEl && d.totais) {
      const t = d.totais;
      totalEl.innerHTML = `
        <div class="kpi"><div class="kpi-l">Receita Total</div><div class="kpi-v green">${brl(t.totalReceita||0)}</div></div>
        <div class="kpi"><div class="kpi-l">Despesas Total</div><div class="kpi-v red">${brl(t.totalDespesa||0)}</div></div>
        <div class="kpi"><div class="kpi-l">Lucro Total</div><div class="kpi-v ${(t.totalReceita||0)-(t.totalDespesa||0)>=0?'green':'red'}">${brl((t.totalReceita||0)-(t.totalDespesa||0))}</div></div>
        <div class="kpi"><div class="kpi-l">Margem Geral</div><div class="kpi-v">${t.totalReceita>0?(((t.totalReceita-t.totalDespesa)/t.totalReceita)*100).toFixed(1)+'%':'—'}</div></div>`;
    }
  } catch(e) {
    el.innerHTML = `<tr><td colspan="8" style="padding:12px;color:#dc2626;font-size:11px">Erro: ${e.message}</td></tr>`;
  }
}

// ─── MODAIS: CERTIDÃO, LICITAÇÃO, FUNCS, FOLHA ─────────────────
function fecharModalCertidao() {
  const el = document.getElementById('modal-certidao');
  if (el) el.style.display = 'none';
}

function fecharModalLicitacao() {
  const el = document.getElementById('modal-licitacao');
  if (el) el.style.display = 'none';
}

function fecharModalNovoFunc() {
  const el = document.getElementById('modal-novo-func');
  if (el) el.style.display = 'none';
}

function fecharModalNovaFolha() {
  const el = document.getElementById('modal-nova-folha');
  if (el) el.style.display = 'none';
}

// ─── TIMELINE DE CONTRATO ────────────────────────────────────────
async function verTimelineContrato(id) {
  const d = await api('/contratos/' + id + '/timeline');
  if (!d || d.error) { toast('Erro ao carregar timeline', 'error'); return; }
  const c = d.contrato;
  const brl = v => 'R$\u00a0' + (v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const cor = d.dias_para_vencer == null ? '#059669' : d.dias_para_vencer < 0 ? '#dc2626' : d.dias_para_vencer < 30 ? '#d97706' : '#059669';

  const html = `
    <div style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9000;display:flex;align-items:center;justify-content:center" id="modal-timeline">
      <div style="background:#fff;border-radius:12px;width:700px;max-width:95vw;max-height:90vh;overflow-y:auto;padding:24px">
        <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:16px">
          <div>
            <div style="font-size:18px;font-weight:800;color:#0f172a">${c.numContrato}</div>
            <div style="font-size:13px;color:#64748b">${c.orgao||''} · ${c.contrato||''}</div>
          </div>
          <button onclick="document.getElementById('modal-timeline').remove()" style="background:none;border:none;font-size:20px;cursor:pointer;color:#64748b">✕</button>
        </div>

        <!-- KPIs -->
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
          <div style="background:#f0fdf4;border-radius:8px;padding:10px;text-align:center">
            <div style="font-size:10px;color:#64748b;font-weight:700">TOTAL PAGO</div>
            <div style="font-size:14px;font-weight:800;color:#059669">${brl(d.total_pago)}</div>
          </div>
          <div style="background:#eff6ff;border-radius:8px;padding:10px;text-align:center">
            <div style="font-size:10px;color:#64748b;font-weight:700">NFs EMITIDAS</div>
            <div style="font-size:14px;font-weight:800;color:#2563eb">${brl(d.total_nfs)}</div>
          </div>
          <div style="background:#fef3c7;border-radius:8px;padding:10px;text-align:center">
            <div style="font-size:10px;color:#64748b;font-weight:700">BOLETINS</div>
            <div style="font-size:14px;font-weight:800;color:#d97706">${d.boletins.length} competências</div>
          </div>
          <div style="background:${d.dias_para_vencer != null && d.dias_para_vencer < 30 ? '#fef2f2' : '#f0fdf4'};border-radius:8px;padding:10px;text-align:center">
            <div style="font-size:10px;color:#64748b;font-weight:700">VENCIMENTO</div>
            <div style="font-size:14px;font-weight:800;color:${cor}">${d.dias_para_vencer != null ? (d.dias_para_vencer < 0 ? 'Vencido' : d.dias_para_vencer + 'd') : '—'}</div>
          </div>
        </div>

        <!-- Barra de progresso -->
        <div style="margin-bottom:16px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:#64748b;margin-bottom:4px">
            <span>Execução do contrato</span><span>${d.percentual_executado}% de ${brl(d.valor_total_estimado)}</span>
          </div>
          <div style="background:#e2e8f0;border-radius:4px;height:10px">
            <div style="background:${d.percentual_executado>80?'#059669':'#3b82f6'};height:10px;border-radius:4px;width:${d.percentual_executado}%;transition:width .5s"></div>
          </div>
        </div>

        <!-- Últimos pagamentos -->
        ${d.pagamentos.length ? `
        <div style="margin-bottom:16px">
          <div style="font-size:12px;font-weight:700;color:#475569;margin-bottom:8px">Últimos Pagamentos</div>
          <table style="width:100%;font-size:11px;border-collapse:collapse">
            ${d.pagamentos.slice(0,6).map(p => `
              <tr style="border-bottom:1px solid #f1f5f9">
                <td style="padding:5px">${p.data_iso}</td>
                <td style="padding:5px;color:#64748b">${p.competencia||'—'}</td>
                <td style="padding:5px;text-align:right;color:#059669;font-weight:700">${brl(p.credito)}</td>
              </tr>`).join('')}
          </table>
        </div>` : ''}

        <!-- Aditivos -->
        ${d.aditivos.length ? `
        <div>
          <div style="font-size:12px;font-weight:700;color:#475569;margin-bottom:8px">Aditivos / Reajustes</div>
          ${d.aditivos.map(a => `<div style="background:#f8fafc;border-radius:6px;padding:8px;margin-bottom:6px;font-size:11px"><strong>${a.tipo}</strong>${a.data ? ' · ' + a.data : ''}: ${a.descricao}</div>`).join('')}
        </div>` : ''}
      </div>
    </div>`;

  document.body.insertAdjacentHTML('beforeend', html);
}

// ─── CORREÇÃO DE NFs ──────────────────────────────────────────────
async function abrirCorrecaoNfs() {
  toast('Analisando NFs com possível erro de retenção...');
  try {
    const d = await api('/retencoes/preencher', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
    if (d.ok) {
      toast(`✅ ${d.atualizadas||0} NFs corrigidas / verificadas`);
    } else {
      toast('Erro: ' + (d.error || 'desconhecido'));
    }
  } catch(e) { toast('Erro: ' + e.message); }
}