// ─── Montana Extras — Melhorias 1-6 ─────────────────────────────
// Carregado após app.js. Estende showTab e implementa os novos módulos.

// ─── Extensão do showTab ─────────────────────────────────────────
(function() {
  const _orig = window.showTab;
  window.showTab = function(id, el) {
    _orig(id, el);
    if (id === 'certidoes')   loadCertidoes();
    if (id === 'licitacoes')  { loadLicKpis(); loadLicitacoes(); }
    if (id === 'calculadora') { loadOrcamentos(); calcularPosto(); }
    if (id === 'dre')         { loadDRE(); loadApuracaoMensal(); }
    if (id === 'margem')      loadMargem();
    if (id === 'reajuste')    loadReajustes();
    if (id === 'rh')          { loadRH(); loadEPIRelatorio(); }
    if (id === 'auditoria')   loadAuditoria();
    if (id === 'retencoes')        loadRetencoes();
    if (id === 'conta-vinculada') loadContaVinculada();
    if (id === 'consolidado')     loadConsolidadoResumo();
    if (id === 'desp')            loadSubcontratados();
    if (id === 'piscofins-seg')   initPisCofinsSeg();
    if (id === 'inss-retido')     initInssRetido();
  };
})();

// ═══════════════════════════════════════════════════════════════
// 1. CERTIDÕES
// ═══════════════════════════════════════════════════════════════

async function loadCertidoes() {
  const status = document.getElementById('cert-filtro-status')?.value || '';
  const tipo   = document.getElementById('cert-filtro-tipo')?.value   || '';
  let url = '/certidoes?_=1';
  if (status) url += '&status=' + encodeURIComponent(status);
  if (tipo)   url += '&tipo='   + encodeURIComponent(tipo);

  const data = await api(url);
  if (!data || data.error) return;

  renderCertKpis(data.data);
  renderCertTable(data.data);
}

function renderCertKpis(rows) {
  const validas   = rows.filter(r => r.status === 'válida').length;
  const proximas  = rows.filter(r => r.status === 'próxima do vencimento').length;
  const vencidas  = rows.filter(r => r.status === 'vencida').length;

  document.getElementById('cert-kpis').innerHTML = `
    <div class="kpi-card" style="border-left:4px solid #22c55e">
      <div class="kpi-v" style="color:#15803d">${validas}</div>
      <div class="kpi-l">Válidas</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #f59e0b">
      <div class="kpi-v" style="color:#d97706">${proximas}</div>
      <div class="kpi-l">Próximas do Vencimento</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #ef4444">
      <div class="kpi-v" style="color:#dc2626">${vencidas}</div>
      <div class="kpi-l">Vencidas</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-v">${rows.length}</div>
      <div class="kpi-l">Total</div>
    </div>
    <div style="display:flex;align-items:center;margin-left:auto">
      <button onclick="exportarExcel('certidoes')" style="padding:6px 14px;font-size:11px;border:1px solid #15803d;border-radius:5px;background:#f0fdf4;color:#15803d;cursor:pointer;font-weight:600">⬇ Excel</button>
    </div>
  `;
}

const CERT_STATUS_STYLE = {
  'válida':                  { bg: '#dcfce7', color: '#15803d', icon: '✅' },
  'próxima do vencimento':   { bg: '#fef3c7', color: '#d97706', icon: '⚠️' },
  'vencida':                 { bg: '#fee2e2', color: '#dc2626', icon: '🔴' }
};

function certStatusBadge(s) {
  const st = CERT_STATUS_STYLE[s] || { bg: '#f1f5f9', color: '#475569', icon: '•' };
  return `<span style="background:${st.bg};color:${st.color};padding:2px 8px;border-radius:20px;font-size:9px;font-weight:700">${st.icon} ${s}</span>`;
}

function renderCertTable(rows) {
  document.getElementById('cert-head').innerHTML = `
    <tr>
      <th>Tipo</th><th>Número</th><th>Emissão</th><th>Validade</th>
      <th>Status</th><th>PDF</th><th>Obs</th><th style="width:80px">Ações</th>
    </tr>`;

  document.getElementById('cert-body').innerHTML = rows.length === 0
    ? `<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:20px">Nenhuma certidão cadastrada. Clique em "+ Nova Certidão" para começar.</td></tr>`
    : rows.map(r => `
      <tr>
        <td><strong>${r.tipo}</strong></td>
        <td>${r.numero || '—'}</td>
        <td>${r.data_emissao || '—'}</td>
        <td><strong>${r.data_validade || '—'}</strong></td>
        <td>${certStatusBadge(r.status)}</td>
        <td>${r.arquivo_pdf
          ? `<a href="/api/certidoes/arquivo/${r.arquivo_pdf}?company=${window.currentCompany}" target="_blank" style="color:#0369a1;font-size:10px">📄 Ver PDF</a>`
          : '<span style="color:#94a3b8;font-size:10px">—</span>'}</td>
        <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.observacoes || ''}</td>
        <td>
          <button onclick="editarCertidao(${r.id})" style="background:#dbeafe;color:#1d4ed8;border:none;padding:3px 8px;border-radius:4px;font-size:9px;cursor:pointer;margin-right:4px">✏️</button>
          <button onclick="deletarCertidao(${r.id})" style="background:#fee2e2;color:#dc2626;border:none;padding:3px 8px;border-radius:4px;font-size:9px;cursor:pointer">🗑️</button>
        </td>
      </tr>`).join('');
}

function abrirModalCertidao(id) {
  document.getElementById('modal-cert-titulo').textContent = id ? 'Editar Certidão' : 'Nova Certidão';
  document.getElementById('cert-id').value = id || '';
  if (!id) {
    document.getElementById('cert-tipo').value    = 'CND Federal';
    document.getElementById('cert-numero').value  = '';
    document.getElementById('cert-emissao').value = '';
    document.getElementById('cert-validade').value= '';
    document.getElementById('cert-obs').value     = '';
    document.getElementById('cert-arquivo').value = '';
  }
  document.getElementById('modal-certidao').style.display = 'flex';
}

async function editarCertidao(id) {
  const row = await api('/certidoes/' + id);
  if (row && !row.error) {
    // row is a single item from the list — refetch list to find it
    const list = await api('/certidoes');
    const item = list.data.find(r => r.id === id);
    if (item) {
      document.getElementById('cert-tipo').value    = item.tipo;
      document.getElementById('cert-numero').value  = item.numero;
      document.getElementById('cert-emissao').value = item.data_emissao;
      document.getElementById('cert-validade').value= item.data_validade;
      document.getElementById('cert-obs').value     = item.observacoes;
    }
  }
  abrirModalCertidao(id);
}

function fecharModalCertidao() {
  document.getElementById('modal-certidao').style.display = 'none';
}

async function salvarCertidao() {
  const id      = document.getElementById('cert-id').value;
  const tipo    = document.getElementById('cert-tipo').value;
  const validade= document.getElementById('cert-validade').value;
  if (!tipo)    { toast('Selecione o tipo de certidão', 'error'); return; }
  if (!validade){ toast('Informe a data de validade', 'error'); return; }

  const fd = new FormData();
  fd.append('tipo',           tipo);
  fd.append('numero',         document.getElementById('cert-numero').value);
  fd.append('data_emissao',   document.getElementById('cert-emissao').value);
  fd.append('data_validade',  validade);
  fd.append('observacoes',    document.getElementById('cert-obs').value);
  const arq = document.getElementById('cert-arquivo').files[0];
  if (arq) fd.append('arquivo_pdf', arq);

  const token = localStorage.getItem('montana_jwt') || '';
  const method = id ? 'PUT' : 'POST';
  const url    = id ? `/api/certidoes/${id}` : '/api/certidoes';

  const r = await fetch(url, {
    method,
    headers: { 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
    body: fd
  });
  const res = await r.json();
  if (res.ok) {
    toast(id ? 'Certidão atualizada!' : 'Certidão cadastrada!');
    fecharModalCertidao();
    loadCertidoes();
  } else {
    toast(res.error || 'Erro ao salvar', 'error');
  }
}

async function deletarCertidao(id) {
  if (!confirm('Excluir esta certidão?')) return;
  const r = await api('/certidoes/' + id, { method: 'DELETE' });
  if (r.ok) { toast('Certidão excluída'); loadCertidoes(); }
  else toast(r.error || 'Erro ao excluir', 'error');
}

// Integração no dashboard: cards de certidões vencendo
async function loadCertAlertas() {
  try {
    const data = await api('/certidoes/alertas');
    if (!data || data.total_alertas === 0) return;
    const al = document.getElementById('dash-alertas');
    if (!al) return;
    if (data.vencidas.length > 0) {
      const el = document.createElement('div');
      el.style.cssText = 'background:#fee2e2;border-left:3px solid #dc2626;padding:6px 10px;border-radius:4px;font-size:10px;cursor:pointer';
      el.innerHTML = `🔴 <strong>${data.vencidas.length} certidão(ões) vencida(s)</strong> — clique para ver`;
      el.onclick = () => showTab('certidoes', document.querySelector('[data-tab="certidoes"]'));
      al.appendChild(el);
    }
    if (data.proximas_15.length > 0) {
      const el = document.createElement('div');
      el.style.cssText = 'background:#fef3c7;border-left:3px solid #f59e0b;padding:6px 10px;border-radius:4px;font-size:10px;cursor:pointer';
      el.innerHTML = `⚠️ <strong>${data.proximas_15.length} certidão(ões)</strong> vencendo em 15 dias`;
      el.onclick = () => showTab('certidoes', document.querySelector('[data-tab="certidoes"]'));
      al.appendChild(el);
    }
  } catch(e) {}
}

// ═══════════════════════════════════════════════════════════════
// 5. LICITAÇÕES
// ═══════════════════════════════════════════════════════════════

const LIC_STATUS_META = {
  'em análise':      { color: '#0369a1', bg: '#e0f2fe', icon: '🔍' },
  'proposta enviada':{ color: '#7c3aed', bg: '#ede9fe', icon: '📤' },
  'recurso':         { color: '#d97706', bg: '#fef3c7', icon: '⚖️' },
  'ganhou':          { color: '#15803d', bg: '#dcfce7', icon: '🏆' },
  'perdeu':          { color: '#dc2626', bg: '#fee2e2', icon: '❌' },
  'desistiu':        { color: '#64748b', bg: '#f1f5f9', icon: '🚫' }
};

function licBadge(s) {
  const m = LIC_STATUS_META[s] || { color:'#475569', bg:'#f1f5f9', icon:'•' };
  return `<span style="background:${m.bg};color:${m.color};padding:2px 8px;border-radius:20px;font-size:9px;font-weight:700">${m.icon} ${s}</span>`;
}

async function loadLicKpis() {
  const data = await api('/licitacoes/kpis');
  if (!data || data.error) return;

  document.getElementById('lic-kpis').innerHTML = `
    <div class="kpi-card" style="border-left:4px solid #0369a1">
      <div class="kpi-v">${data.total}</div>
      <div class="kpi-l">Total de Licitações</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #7c3aed">
      <div class="kpi-v">${data.em_disputa}</div>
      <div class="kpi-l">Em Disputa — ${brl(data.em_disputa_valor)}</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #15803d">
      <div class="kpi-v">${data.ganhou}</div>
      <div class="kpi-l">Ganhou — ${brl(data.ganhou_valor)}</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #f59e0b">
      <div class="kpi-v">${data.taxa_aproveitamento}%</div>
      <div class="kpi-l">Taxa de Aproveitamento</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #dc2626">
      <div class="kpi-v">${data.perdeu}</div>
      <div class="kpi-l">Perdidas</div>
    </div>
  `;

  // Pipeline visual
  const pipeline = document.getElementById('lic-pipeline');
  const ORDER = ['em análise','proposta enviada','recurso','ganhou','perdeu','desistiu'];
  pipeline.innerHTML = ORDER.map(s => {
    const m = LIC_STATUS_META[s] || {};
    const n = (data.por_status.find(p => p.status === s) || {}).n || 0;
    return `<div style="background:${m.bg};border-radius:8px;padding:8px 14px;text-align:center;min-width:100px;flex:1;cursor:pointer" onclick="document.getElementById('lic-filtro-status').value='${s}';loadLicitacoes()">
      <div style="font-size:16px">${m.icon}</div>
      <div style="font-size:18px;font-weight:800;color:${m.color}">${n}</div>
      <div style="font-size:9px;color:${m.color};font-weight:600">${s.toUpperCase()}</div>
    </div>`;
  }).join('<div style="display:flex;align-items:center;color:#cbd5e1;font-size:18px">›</div>');
}

async function loadLicitacoes() {
  const status    = document.getElementById('lic-filtro-status')?.value || '';
  let url = '/licitacoes?_=1';
  if (status) url += '&status=' + encodeURIComponent(status);

  const data = await api(url);
  if (!data || data.error) return;

  document.getElementById('lic-head').innerHTML = `
    <tr><th>Órgão</th><th>Edital</th><th>Modalidade</th><th>Abertura</th>
    <th>V. Estimado</th><th>V. Proposta</th><th>Status</th><th>Resultado</th>
    <th style="width:80px">Ações</th>
    <th><button onclick="exportarExcel('licitacoes')" style="padding:2px 8px;font-size:9px;border:1px solid #0369a1;border-radius:4px;background:#f0f9ff;color:#0369a1;cursor:pointer;font-weight:600">⬇ Excel</button></th></tr>`;

  document.getElementById('lic-body').innerHTML = data.data.length === 0
    ? `<tr><td colspan="9" style="text-align:center;color:#94a3b8;padding:20px">Nenhuma licitação cadastrada.</td></tr>`
    : data.data.map(r => `
      <tr>
        <td><strong>${r.orgao}</strong></td>
        <td style="font-size:10px">${r.numero_edital || '—'}</td>
        <td style="font-size:10px">${r.modalidade}</td>
        <td>${r.data_abertura || '—'}</td>
        <td style="text-align:right">${r.valor_estimado > 0 ? brl(r.valor_estimado) : '—'}</td>
        <td style="text-align:right">${r.valor_proposta > 0 ? brl(r.valor_proposta) : '—'}</td>
        <td>${licBadge(r.status)}</td>
        <td style="font-size:10px;color:#64748b">${r.resultado || '—'}</td>
        <td>
          <button onclick="editarLicitacao(${r.id})" style="background:#dbeafe;color:#1d4ed8;border:none;padding:3px 8px;border-radius:4px;font-size:9px;cursor:pointer;margin-right:4px">✏️</button>
          <button onclick="deletarLicitacao(${r.id})" style="background:#fee2e2;color:#dc2626;border:none;padding:3px 8px;border-radius:4px;font-size:9px;cursor:pointer">🗑️</button>
        </td>
      </tr>`).join('');
}

function abrirModalLicitacao(id) {
  document.getElementById('modal-lic-titulo').textContent = id ? 'Editar Licitação' : 'Nova Licitação';
  document.getElementById('lic-id').value = id || '';
  if (!id) {
    ['lic-orgao','lic-edital','lic-objeto','lic-abertura','lic-encerramento','lic-resultado','lic-obs'].forEach(i => {
      const el = document.getElementById(i);
      if (el) el.value = '';
    });
    document.getElementById('lic-val-est').value  = '';
    document.getElementById('lic-val-prop').value = '';
    document.getElementById('lic-modalidade').value = 'pregão';
    document.getElementById('lic-status').value    = 'em análise';
  }
  document.getElementById('modal-licitacao').style.display = 'flex';
}

async function editarLicitacao(id) {
  const list = await api('/licitacoes');
  const item = list.data.find(r => r.id === id);
  if (item) {
    document.getElementById('lic-orgao').value       = item.orgao;
    document.getElementById('lic-edital').value      = item.numero_edital;
    document.getElementById('lic-modalidade').value  = item.modalidade;
    document.getElementById('lic-objeto').value      = item.objeto;
    document.getElementById('lic-abertura').value    = item.data_abertura;
    document.getElementById('lic-encerramento').value= item.data_encerramento;
    document.getElementById('lic-val-est').value     = item.valor_estimado || '';
    document.getElementById('lic-val-prop').value    = item.valor_proposta || '';
    document.getElementById('lic-status').value      = item.status;
    document.getElementById('lic-resultado').value   = item.resultado;
    document.getElementById('lic-obs').value         = item.observacoes;
  }
  abrirModalLicitacao(id);
}

function fecharModalLicitacao() {
  document.getElementById('modal-licitacao').style.display = 'none';
}

async function salvarLicitacao() {
  const id    = document.getElementById('lic-id').value;
  const orgao = document.getElementById('lic-orgao').value.trim();
  if (!orgao) { toast('Informe o órgão licitante', 'error'); return; }

  const body = {
    orgao,
    numero_edital:    document.getElementById('lic-edital').value,
    modalidade:       document.getElementById('lic-modalidade').value,
    objeto:           document.getElementById('lic-objeto').value,
    data_abertura:    document.getElementById('lic-abertura').value,
    data_encerramento:document.getElementById('lic-encerramento').value,
    valor_estimado:   parseFloat(document.getElementById('lic-val-est').value) || 0,
    valor_proposta:   parseFloat(document.getElementById('lic-val-prop').value) || 0,
    status:           document.getElementById('lic-status').value,
    resultado:        document.getElementById('lic-resultado').value,
    observacoes:      document.getElementById('lic-obs').value
  };

  const r = await api(id ? '/licitacoes/' + id : '/licitacoes', {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (r.ok) {
    toast(id ? 'Licitação atualizada!' : 'Licitação cadastrada!');
    fecharModalLicitacao();
    loadLicKpis();
    loadLicitacoes();
  } else {
    toast(r.error || 'Erro ao salvar', 'error');
  }
}

async function deletarLicitacao(id) {
  if (!confirm('Excluir esta licitação?')) return;
  const r = await api('/licitacoes/' + id, { method: 'DELETE' });
  if (r.ok) { toast('Licitação excluída'); loadLicKpis(); loadLicitacoes(); }
  else toast(r.error || 'Erro', 'error');
}

// ═══════════════════════════════════════════════════════════════
// 2. CALCULADORA DE POSTO
// ═══════════════════════════════════════════════════════════════

const SALARIOS_PADRAO = {
  vigilante_12x36_diurno:  { salario_base: 1950.00, peric: 585.00 },
  vigilante_12x36_noturno: { salario_base: 1950.00, peric: 585.00 },
  vigilante_44h:           { salario_base: 1820.00, peric: 546.00 },
  supervisor:              { salario_base: 2800.00, peric: 840.00 },
  vigilante_armado:        { salario_base: 2100.00, peric: 630.00 },
  personalizado:           { salario_base: 0,       peric: 0 }
};

function preencherSalarioPadrao() {
  const tipo = document.getElementById('calc-tipo').value;
  const std  = SALARIOS_PADRAO[tipo];
  if (std && std.salario_base > 0) {
    document.getElementById('calc-salario').value = std.salario_base.toFixed(2);
    document.getElementById('calc-peric').value   = std.peric.toFixed(2);
    calcularPosto();
  }
}

async function calcularPosto() {
  const body = {
    salario_base:           parseFloat(document.getElementById('calc-salario')?.value) || 0,
    adicional_periculosidade: parseFloat(document.getElementById('calc-peric')?.value) || 0,
    ferias:                 parseFloat(document.getElementById('calc-ferias')?.value)  || 11.11,
    decimo_terceiro:        parseFloat(document.getElementById('calc-13')?.value)      || 8.33,
    fgts:                   parseFloat(document.getElementById('calc-fgts')?.value)    || 8.00,
    inss_patronal:          parseFloat(document.getElementById('calc-inss')?.value)    || 28.80,
    vale_transporte:        parseFloat(document.getElementById('calc-vt')?.value)      || 0,
    vale_alimentacao:       parseFloat(document.getElementById('calc-va')?.value)      || 0,
    plano_saude:            parseFloat(document.getElementById('calc-saude')?.value)   || 0,
    uniforme:               parseFloat(document.getElementById('calc-unif')?.value)    || 0,
    equipamento:            parseFloat(document.getElementById('calc-equip')?.value)   || 0,
    seguro:                 parseFloat(document.getElementById('calc-seguro')?.value)  || 0,
    custos_indiretos_pct:   parseFloat(document.getElementById('calc-ci')?.value)      || 10,
    tributos_pct:           parseFloat(document.getElementById('calc-trib')?.value)    || 8.65,
    lucro_pct:              parseFloat(document.getElementById('calc-lucro')?.value)   || 8.00
  };

  const r = await api('/calculadora/calcular', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r || r.error) return;

  const d = r;
  const s = d.resumo;
  const pct = v => `<span style="font-size:9px;color:#94a3b8">${v}</span>`;

  document.getElementById('calc-resultado-inner').innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:11px">
      <tr><td style="padding:4px 0;border-bottom:1px solid #f1f5f9;color:#64748b">Salário Base</td>           <td style="text-align:right;font-weight:600">${brl(s.salario_base)}</td></tr>
      <tr><td style="padding:4px 0;border-bottom:1px solid #f1f5f9;color:#64748b">Adic. Periculosidade (30%)</td><td style="text-align:right;font-weight:600">${brl(s.adicional_periculosidade)}</td></tr>
      <tr style="background:#eff6ff"><td style="padding:5px 4px;font-weight:700">Salário Total</td>          <td style="text-align:right;font-weight:700">${brl(s.salario_total)}</td></tr>
      <tr><td style="padding:4px 0;border-bottom:1px solid #f1f5f9;color:#64748b">Encargos Sociais</td>      <td style="text-align:right;font-weight:600">${brl(s.total_encargos)}</td></tr>
      <tr><td style="padding:4px 0;border-bottom:1px solid #f1f5f9;color:#64748b">Insumos</td>               <td style="text-align:right;font-weight:600">${brl(s.total_insumos)}</td></tr>
      <tr style="background:#f0fdf4"><td style="padding:5px 4px;font-weight:700">Custo Direto</td>           <td style="text-align:right;font-weight:700">${brl(s.custo_direto)}</td></tr>
      <tr><td style="padding:4px 0;border-bottom:1px solid #f1f5f9;color:#64748b">Custos Indiretos</td>      <td style="text-align:right;font-weight:600">${brl(s.custos_indiretos)}</td></tr>
      <tr><td style="padding:4px 0;border-bottom:1px solid #f1f5f9;color:#64748b">Tributos</td>              <td style="text-align:right;font-weight:600">${brl(s.total_tributos)}</td></tr>
      <tr><td style="padding:4px 0;border-bottom:1px solid #f1f5f9;color:#64748b">Lucro Empresarial</td>     <td style="text-align:right;font-weight:600">${brl(s.total_lucro)}</td></tr>
    </table>
    <div style="margin-top:12px;background:#d1fae5;border-radius:8px;padding:12px;text-align:center">
      <div style="font-size:10px;color:#065f46;font-weight:700;text-transform:uppercase">PREÇO MENSAL DO POSTO</div>
      <div style="font-size:26px;font-weight:900;color:#065f46">${brl(s.preco_mensal)}</div>
    </div>
    <div style="margin-top:8px;background:#dbeafe;border-radius:8px;padding:10px;text-align:center">
      <div style="font-size:10px;color:#1e40af;font-weight:700">PREÇO ANUAL (12 meses)</div>
      <div style="font-size:18px;font-weight:800;color:#1e40af">${brl(s.preco_anual)}</div>
    </div>
  `;
}

async function salvarOrcamento() {
  const nome = document.getElementById('calc-nome').value.trim();
  if (!nome) { toast('Informe um nome para o orçamento', 'error'); return; }

  const body = {
    nome,
    tipo_posto:             document.getElementById('calc-tipo').value,
    salario_base:           parseFloat(document.getElementById('calc-salario').value) || 0,
    adicional_periculosidade: parseFloat(document.getElementById('calc-peric').value) || 0,
    ferias:                 parseFloat(document.getElementById('calc-ferias').value)  || 11.11,
    decimo_terceiro:        parseFloat(document.getElementById('calc-13').value)      || 8.33,
    fgts:                   parseFloat(document.getElementById('calc-fgts').value)    || 8.00,
    inss_patronal:          parseFloat(document.getElementById('calc-inss').value)    || 28.80,
    vale_transporte:        parseFloat(document.getElementById('calc-vt').value)      || 0,
    vale_alimentacao:       parseFloat(document.getElementById('calc-va').value)      || 0,
    plano_saude:            parseFloat(document.getElementById('calc-saude').value)   || 0,
    uniforme:               parseFloat(document.getElementById('calc-unif').value)    || 0,
    equipamento:            parseFloat(document.getElementById('calc-equip').value)   || 0,
    seguro:                 parseFloat(document.getElementById('calc-seguro').value)  || 0,
    custos_indiretos_pct:   parseFloat(document.getElementById('calc-ci').value)      || 10,
    tributos_pct:           parseFloat(document.getElementById('calc-trib').value)    || 8.65,
    lucro_pct:              parseFloat(document.getElementById('calc-lucro').value)   || 8.00,
    salvar: true
  };

  const r = await api('/calculadora/calcular', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (r && !r.error) { toast('Orçamento salvo!'); loadOrcamentos(); }
  else toast(r?.error || 'Erro ao salvar', 'error');
}

async function loadOrcamentos() {
  const data = await api('/calculadora/orcamentos');
  const panel = document.getElementById('calc-orcamentos-panel');
  const list  = document.getElementById('calc-orcamentos-list');
  if (!data || data.error || data.data.length === 0) {
    if (panel) panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  list.innerHTML = data.data.map(r => `
    <div style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:6px">
      <div style="flex:1">
        <div style="font-size:11px;font-weight:700;color:#0f172a">${r.nome}</div>
        <div style="font-size:9px;color:#64748b">${r.tipo_posto} · Salário: ${brl(r.salario_base)}</div>
        <div style="font-size:10px;color:#059669;font-weight:700">${brl(r.preco_mensal)}/mês</div>
      </div>
      <a href="/api/calculadora/exportar/${r.id}?company=${currentCompany}" style="padding:4px 8px;background:#dcfce7;color:#15803d;border:1px solid #86efac;border-radius:4px;font-size:9px;text-decoration:none;font-weight:700">📗 Excel</a>
      <button onclick="deletarOrcamento(${r.id})" style="padding:4px 8px;background:#fee2e2;color:#dc2626;border:none;border-radius:4px;font-size:9px;cursor:pointer">🗑️</button>
    </div>
  `).join('');
}

async function deletarOrcamento(id) {
  if (!confirm('Excluir este orçamento?')) return;
  const r = await api('/calculadora/orcamentos/' + id, { method: 'DELETE' });
  if (r.ok) { toast('Orçamento excluído'); loadOrcamentos(); }
  else toast(r.error || 'Erro', 'error');
}

// ═══════════════════════════════════════════════════════════════
// 3. DRE
// ═══════════════════════════════════════════════════════════════

async function loadDRE() {
  const ano = document.getElementById('dre-ano')?.value || new Date().getFullYear();
  const mes = document.getElementById('dre-mes')?.value || '';
  let url = `/dre?ano=${ano}`;
  if (mes) url += `&mes=${mes}`;

  showLoading('Gerando DRE…');
  let data;
  try { data = await api(url); } finally { hideLoading(); }
  if (!data || data.error) {
    document.getElementById('dre-content').innerHTML = `<div style="padding:20px;color:#dc2626">Erro ao carregar DRE</div>`;
    return;
  }

  const d = data.dre;
  const periodo = data.periodo;

  function dreLinha(indent, label, valor, bold, bg, negativo, pct) {
    const v = negativo ? -Math.abs(valor) : valor;
    const cor = v >= 0 ? '#0f172a' : '#dc2626';
    return `<tr style="${bg ? 'background:' + bg : ''}">
      <td style="padding:5px ${8 + indent * 12}px;font-size:11px;${bold ? 'font-weight:700' : 'color:#475569'}">${label}</td>
      <td style="text-align:right;padding:5px 12px;font-size:11px;font-weight:${bold ? 700 : 500};color:${cor}">${brl(Math.abs(v))}</td>
      <td style="text-align:right;padding:5px 8px;font-size:9px;color:#94a3b8">${pct !== null && pct !== undefined ? pct + '%' : ''}</td>
    </tr>`;
  }

  const rb = d.receita_bruta;
  document.getElementById('dre-content').innerHTML = `
    <div style="padding:12px 16px;background:#1e293b;color:#fff;font-weight:700;font-size:12px">
      DRE — ${data.periodo} — ${currentCompany === 'assessoria' ? 'Montana Assessoria' : 'Montana Segurança'}
    </div>
    <div style="padding:6px 16px;background:#f8fafc;font-size:10px;color:#64748b;border-bottom:1px solid #e2e8f0">
      Base: Notas Fiscais emitidas no período${d.qtd_nfs ? ` (${d.qtd_nfs} NFs)` : ''} — regime de competência
    </div>
    <table style="width:100%;border-collapse:collapse">
      <col style="width:70%"><col style="width:20%"><col style="width:10%">
      ${dreLinha(0,'(+) RECEITA OPERACIONAL BRUTA', rb, true, '#dbeafe', false, 100)}
      ${dreLinha(1,'(-) INSS Retido',    d.deducoes.inss,   false, null, true, null)}
      ${dreLinha(1,'(-) IRRF Retido',    d.deducoes.irrf,   false, null, true, null)}
      ${dreLinha(1,'(-) ISS Retido',     d.deducoes.iss,    false, null, true, null)}
      ${dreLinha(1,'(-) CSLL Retida',    d.deducoes.csll,   false, null, true, null)}
      ${dreLinha(1,'(-) PIS Retido',     d.deducoes.pis,    false, null, true, null)}
      ${dreLinha(1,'(-) COFINS Retida',  d.deducoes.cofins, false, null, true, null)}
      <tr><td colspan="3" style="padding:2px;background:#f1f5f9"></td></tr>
      ${dreLinha(0,'(=) RECEITA OPERACIONAL LÍQUIDA', d.receita_liquida, true, '#e0f2fe', false, rb > 0 ? +((d.receita_liquida/rb)*100).toFixed(1) : 0)}
      <tr><td colspan="3" style="padding:2px;background:#f1f5f9"></td></tr>
      ${dreLinha(0,'(-) CUSTO DOS SERVIÇOS PRESTADOS', d.custos.total, true, '#fef3c7', true, null)}
      ${dreLinha(1,'Folha de Pagamento',     d.custos.folha,    false, null, true, null)}
      ${dreLinha(1,'Serviços Terceirizados', d.custos.servicos, false, null, true, null)}
      <tr><td colspan="3" style="padding:2px;background:#f1f5f9"></td></tr>
      ${dreLinha(0,'(=) LUCRO BRUTO', d.lucro_bruto, true, '#d1fae5', false, d.margem_bruta_pct)}
      <tr><td colspan="3" style="padding:2px;background:#f1f5f9"></td></tr>
      ${dreLinha(0,'(-) DESPESAS OPERACIONAIS', d.despesas_operacionais, true, '#fce7f3', true, null)}
      <tr><td colspan="3" style="padding:4px;background:#f1f5f9"></td></tr>
      ${dreLinha(0,'(=) RESULTADO OPERACIONAL', d.resultado_operacional, true, '#e2e8f0', false, null)}
      <tr><td colspan="3" style="padding:4px;background:#f1f5f9"></td></tr>
      ${d.tributos_proprios ? `
      ${dreLinha(0,'(-) PIS/COFINS (Lucro Real não-cumulativo)', d.tributos_proprios.total_pis_cofins || d.tributos_proprios.total, true, '#fef9c3', true, null)}
      ${dreLinha(1,'PIS bruto (1,65%)',               d.tributos_proprios.pis_bruto,         false, null, true, null)}
      ${dreLinha(1,'(+) Crédito PIS retido na fonte', d.tributos_proprios.pis_credito_fonte,  false, null, false, null)}
      ${dreLinha(1,'= PIS a recolher',                d.tributos_proprios.pis_a_pagar,        false, '#fef3c7', true, null)}
      ${dreLinha(1,'COFINS bruta (7,6%)',              d.tributos_proprios.cofins_bruta,       false, null, true, null)}
      ${dreLinha(1,'(+) Crédito COFINS retida na fonte', d.tributos_proprios.cofins_credito_fonte, false, null, false, null)}
      ${dreLinha(1,'= COFINS a recolher',             d.tributos_proprios.cofins_a_pagar,     false, '#fef3c7', true, null)}
      <tr><td colspan="3" style="padding:4px;background:#f1f5f9"></td></tr>
      ` : ''}
      ${d.irpj ? `
      ${dreLinha(0,'(-) IRPJ (Lucro Real — 15% + adicional 10%)', d.irpj.total, true, '#fce7f3', true, null)}
      ${dreLinha(1,'Base de cálculo (lucro apurado)',  d.irpj.base,           false, null, false, null)}
      ${dreLinha(1,'IRPJ 15%',                        d.irpj.aliquota_base,  false, null, true,  null)}
      ${d.irpj.adicional_10pct > 0 ? dreLinha(1,'Adicional 10% (lucro > R$20k/mês)', d.irpj.adicional_10pct, false, null, true, null) : ''}
      ` : ''}
      ${d.csll ? `
      ${dreLinha(0,'(-) CSLL (9%)', d.csll.total, true, '#fce7f3', true, null)}
      <tr><td colspan="3" style="padding:4px;background:#f1f5f9"></td></tr>
      ` : ''}
      ${d.total_impostos ? `
      ${dreLinha(0,'(=) TOTAL DE IMPOSTOS', d.total_impostos, true, '#fef2f2', true, d.receita_bruta > 0 ? +((d.total_impostos/d.receita_bruta)*100).toFixed(1) : null)}
      <tr><td colspan="3" style="padding:4px;background:#f1f5f9"></td></tr>
      ` : ''}
      ${dreLinha(0,'(=) RESULTADO LÍQUIDO (após impostos)', d.resultado_liquido, true,
          d.resultado_liquido >= 0 ? '#bbf7d0' : '#fecaca', false, d.margem_liquida_pct)}
    </table>
  `;

  // Gráfico mensal
  const chart = document.getElementById('dre-chart');
  if (data.porMes && data.porMes.length > 0) {
    const maxV = Math.max(...data.porMes.map(m => Math.max(m.receita, m.saidas)), 1);
    chart.innerHTML = data.porMes.map(m => {
      const rPct = (m.receita / maxV * 100).toFixed(0);
      const sPct = (m.saidas  / maxV * 100).toFixed(0);
      return `<div style="margin-bottom:6px">
        <div style="font-size:9px;color:#475569;margin-bottom:2px;font-weight:600">${m.mes_ano}</div>
        <div style="display:flex;align-items:center;gap:4px">
          <div style="width:${rPct}%;height:10px;background:#22c55e;border-radius:2px;min-width:2px" title="${brl(m.receita)}"></div>
          <span style="font-size:8px;color:#15803d">${brl(m.receita)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:4px;margin-top:2px">
          <div style="width:${sPct}%;height:10px;background:#f87171;border-radius:2px;min-width:2px" title="${brl(m.saidas)}"></div>
          <span style="font-size:8px;color:#dc2626">${brl(m.saidas)}</span>
        </div>
      </div>`;
    }).join('');
  } else {
    chart.innerHTML = '<div style="color:#94a3b8;font-size:11px;padding:8px">Sem dados mensais</div>';
  }
}

function exportDREExcel() {
  const ano = document.getElementById('dre-ano')?.value || new Date().getFullYear();
  const mes = document.getElementById('dre-mes')?.value || '';
  let url = `/api/dre/excel?company=${currentCompany}&ano=${ano}`;
  if (mes) url += `&mes=${mes}`;
  window.open(url, '_blank');
}

// ═══════════════════════════════════════════════════════════════
// 4. MARGEM POR CONTRATO
// ═══════════════════════════════════════════════════════════════

async function loadMargem() {
  const from = document.getElementById('margem-from')?.value || '';
  const to   = document.getElementById('margem-to')?.value   || '';
  let url = '/relatorios/lucro-por-contrato?_=1';
  if (from) url += '&from=' + from;
  if (to)   url += '&to='   + to;

  showLoading('Calculando margem…');
  let data;
  try { data = await api(url); } finally { hideLoading(); }
  if (!data || data.error) return;

  const rows = data.data;
  const r    = data.resumo;

  // KPIs — agora com contadores lucro/alerta/prejuízo do backend
  document.getElementById('margem-kpis').innerHTML = `
    <div class="kpi-card" style="border-left:4px solid #3b82f6">
      <div class="kpi-v">${brl(r.total_receita)}</div>
      <div class="kpi-l">Receita Bruta Total</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #6366f1">
      <div class="kpi-v">${brl(r.total_retencao || 0)}</div>
      <div class="kpi-l">Retenções / Impostos</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #ef4444">
      <div class="kpi-v">${brl(r.total_despesas)}</div>
      <div class="kpi-l">Despesas Totais</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid ${r.lucro_bruto >= 0 ? '#22c55e' : '#ef4444'}">
      <div class="kpi-v" style="color:${r.lucro_bruto >= 0 ? '#15803d' : '#dc2626'}">${brl(r.lucro_bruto)}</div>
      <div class="kpi-l">Lucro Bruto</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #f59e0b">
      <div class="kpi-v">${r.margem_pct}%</div>
      <div class="kpi-l">Margem Geral</div>
    </div>
    <div style="display:flex;gap:6px;align-items:center;margin-left:auto">
      <span style="background:#dcfce7;color:#15803d;padding:4px 10px;border-radius:6px;font-size:10px;font-weight:700">✅ ${r.contratos_lucro || 0} lucro</span>
      <span style="background:#fef3c7;color:#d97706;padding:4px 10px;border-radius:6px;font-size:10px;font-weight:700">⚠️ ${r.contratos_alerta || 0} alerta</span>
      <span style="background:#fee2e2;color:#dc2626;padding:4px 10px;border-radius:6px;font-size:10px;font-weight:700">🔴 ${r.contratos_prejuizo || 0} prejuízo</span>
    </div>
  `;

  // Gráfico de barras — margem por contrato
  const maxMargem = Math.max(...rows.map(c => Math.abs(c.margem_pct)), 1);
  document.getElementById('margem-chart').innerHTML = rows.slice(0, 15).map(c => {
    const pct  = Math.abs(c.margem_pct);
    const cor  = c.margem_pct < 0 ? '#ef4444' : c.margem_pct < 10 ? '#f59e0b' : '#22c55e';
    const wPct = (pct / maxMargem * 100).toFixed(0);
    const label = c.contrato.length > 35 ? c.contrato.substring(0, 35) + '…' : c.contrato;
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
      <div style="font-size:9px;color:#475569;width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${c.contrato}">${label}</div>
      <div style="flex:1;height:16px;background:#f1f5f9;border-radius:3px;overflow:hidden">
        <div style="width:${wPct}%;height:100%;background:${cor};border-radius:3px;display:flex;align-items:center;padding-left:4px">
          <span style="font-size:8px;color:#fff;font-weight:700;white-space:nowrap">${c.margem_pct}%</span>
        </div>
      </div>
      <div style="font-size:9px;color:#64748b;width:85px;text-align:right">${brl(c.lucro_bruto)}</div>
    </div>`;
  }).join('');

  // Tabela detalhada com breakdown de despesas e botão de evolução
  document.getElementById('margem-head').innerHTML = `
    <tr>
      <th>#</th><th>Contrato</th><th>Órgão</th>
      <th style="text-align:right">Rec. Bruta</th>
      <th style="text-align:right">Rec. Líquida</th>
      <th style="text-align:right">Folha</th>
      <th style="text-align:right">Fornec.</th>
      <th style="text-align:right">Outras Desp.</th>
      <th style="text-align:right">Total Desp.</th>
      <th style="text-align:right">Lucro</th>
      <th style="text-align:center">Margem %</th>
      <th style="text-align:center">Evolução</th>
    </tr>`;

  document.getElementById('margem-body').innerHTML = rows.map((c, i) => {
    const bg  = c.margem_pct < 0 ? '#fff5f5' : c.margem_pct < 10 ? '#fffbeb' : '';
    const cor = c.margem_pct < 0 ? '#dc2626' : c.margem_pct < 10 ? '#d97706' : '#15803d';
    const hasEvol = c.evolucao && c.evolucao.length > 0;
    const evolId  = 'evol-' + i;
    const evolHtml = hasEvol ? c.evolucao.map(e => {
      const lucroE = e.receita - e.despesa;
      const margE  = e.receita > 0 ? ((lucroE / e.receita) * 100).toFixed(1) : 0;
      const cE     = lucroE < 0 ? '#dc2626' : lucroE < e.receita * 0.1 ? '#d97706' : '#15803d';
      return `<td style="font-size:9px;text-align:center">${e.mes}</td><td style="font-size:9px;text-align:right">${brl(e.receita)}</td><td style="font-size:9px;text-align:right">${brl(e.despesa)}</td><td style="font-size:9px;text-align:right;color:${cE};font-weight:700">${brl(lucroE)}</td><td style="font-size:9px;text-align:center;color:${cE}">${margE}%</td>`;
    }).join('</tr><tr style="background:#f8fafc">') : '';

    return `<tr style="${bg ? 'background:' + bg : ''}">
      <td style="font-size:10px;color:#94a3b8">${i + 1}</td>
      <td><strong style="font-size:11px">${c.numContrato}</strong></td>
      <td style="font-size:10px">${c.contrato}</td>
      <td style="text-align:right;font-size:11px">${brl(c.receita_bruta)}</td>
      <td style="text-align:right;font-size:11px;color:#6366f1">${brl(c.receita_liquida)}</td>
      <td style="text-align:right;font-size:10px;color:#64748b">${brl(c.desp_folha)}</td>
      <td style="text-align:right;font-size:10px;color:#64748b">${brl(c.desp_fornecedor)}</td>
      <td style="text-align:right;font-size:10px;color:#64748b">${brl(c.desp_outras)}</td>
      <td style="text-align:right;font-weight:600">${brl(c.despesas)}</td>
      <td style="text-align:right;font-weight:700;color:${c.lucro_bruto >= 0 ? '#15803d' : '#dc2626'}">${brl(c.lucro_bruto)}</td>
      <td style="text-align:center">
        <span style="background:${c.margem_pct < 0 ? '#fee2e2' : c.margem_pct < 10 ? '#fef3c7' : '#dcfce7'};color:${cor};padding:2px 8px;border-radius:20px;font-size:10px;font-weight:700">
          ${c.margem_pct < 0 ? '▼' : '▲'} ${c.margem_pct}%
        </span>
      </td>
      <td style="text-align:center">
        ${hasEvol ? `<button onclick="toggleMargEvol('${evolId}')" style="font-size:9px;padding:2px 7px;border:1px solid #cbd5e1;border-radius:4px;background:#f8fafc;cursor:pointer">📈 ${c.evolucao.length}m</button>` : '<span style="color:#cbd5e1;font-size:9px">—</span>'}
      </td>
    </tr>
    ${hasEvol ? `<tr id="${evolId}" style="display:none;background:#f0f9ff">
      <td colspan="12" style="padding:0 12px 10px">
        <div style="font-size:10px;font-weight:700;color:#3b82f6;margin:8px 0 4px">Evolução mensal — ${c.numContrato}</div>
        <table style="width:auto;font-size:9px;border-collapse:collapse">
          <thead><tr style="background:#e0f2fe">
            <th style="padding:3px 8px">Mês</th><th style="padding:3px 8px">Receita</th><th style="padding:3px 8px">Despesas</th><th style="padding:3px 8px">Lucro</th><th style="padding:3px 8px">Margem</th>
          </tr></thead>
          <tbody><tr style="background:#f8fafc">${evolHtml}</tr></tbody>
        </table>
      </td>
    </tr>` : ''}`;
  }).join('');
}

function toggleMargEvol(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = el.style.display === 'none' ? 'table-row' : 'none';
}

// ═══════════════════════════════════════════════════════════════
// MÓDULO 3 — REAJUSTE CONTRATUAL
// ═══════════════════════════════════════════════════════════════

let _reajusteAtual = null;

async function loadReajustes() {
  showLoading('Carregando reajustes…');
  let data;
  try { data = await api('/reajustes'); } finally { hideLoading(); }
  if (!data?.data) return;

  const rows = data.data;
  const r    = data.resumo;

  // KPIs
  document.getElementById('reaj-kpis').innerHTML = `
    <div class="kpi-card" style="border-left:4px solid #64748b">
      <div class="kpi-v">${r.total}</div>
      <div class="kpi-l">Contratos Ativos</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #ef4444">
      <div class="kpi-v" style="color:#dc2626">${r.atrasado}</div>
      <div class="kpi-l">Reajuste Atrasado (&gt;12m)</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #f59e0b">
      <div class="kpi-v" style="color:#d97706">${r.proximo}</div>
      <div class="kpi-l">Reajuste em até 60 dias</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #8b5cf6">
      <div class="kpi-v" style="color:#7c3aed">${r.vencimento_proximo}</div>
      <div class="kpi-l">Vencimento em até 90 dias</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #94a3b8">
      <div class="kpi-v" style="color:#64748b">${r.sem_registro}</div>
      <div class="kpi-l">Sem Registro de Reajuste</div>
    </div>
  `;

  // Tabela
  const ALERTA_STYLE = {
    atrasado:          { bg: '#fee2e2', cor: '#dc2626', icon: '🔴', label: 'Reajuste atrasado' },
    proximo:           { bg: '#fef3c7', cor: '#d97706', icon: '⚠️', label: 'Reajuste em breve' },
    vencimento_proximo:{ bg: '#ede9fe', cor: '#7c3aed', icon: '📅', label: 'Vencimento próximo' },
    sem_registro:      { bg: '#f1f5f9', cor: '#64748b', icon: '❓', label: 'Sem registro' },
  };

  document.getElementById('reaj-body').innerHTML = `
    <div class="tw">
      <table>
        <thead><tr>
          <th>Contrato</th><th>Órgão</th><th>Índice</th>
          <th style="text-align:right">Último Reajuste</th>
          <th style="text-align:right">% Aplicado</th>
          <th style="text-align:right">Próximo Reajuste</th>
          <th style="text-align:right">Vencimento</th>
          <th style="text-align:right">Valor Mensal</th>
          <th style="text-align:center">Alerta</th>
          <th style="text-align:center">Ação</th>
        </tr></thead>
        <tbody>${rows.map(c => {
          const a = c.alerta ? ALERTA_STYLE[c.alerta] : null;
          const bgRow = a ? a.bg : '';
          const diasReaj = c.diasSemReajuste !== null ? `${c.diasSemReajuste}d atrás` : '—';
          const diasProx = c.diasParaReajuste !== null
            ? (c.diasParaReajuste < 0 ? `${Math.abs(c.diasParaReajuste)}d atrás` : `em ${c.diasParaReajuste}d`)
            : '—';
          const diasVenc = c.diasParaVencimento !== null
            ? (c.diasParaVencimento < 0 ? 'Vencido' : `em ${c.diasParaVencimento}d`)
            : '—';
          return `<tr style="${bgRow ? 'background:' + bgRow : ''}">
            <td><strong style="font-size:11px">${c.numContrato}</strong></td>
            <td style="font-size:10px">${c.contrato}</td>
            <td style="text-align:center;font-size:10px">${c.indice_reajuste || '—'}</td>
            <td style="text-align:right;font-size:10px">${c.data_ultimo_reajuste || '—'}<br><span style="font-size:8px;color:#94a3b8">${diasReaj}</span></td>
            <td style="text-align:right;font-size:11px;font-weight:600">${c.pct_reajuste_ultimo ? c.pct_reajuste_ultimo + '%' : '—'}</td>
            <td style="text-align:right;font-size:10px">${c.data_proximo_reajuste || '—'}<br><span style="font-size:8px;color:#94a3b8">${diasProx}</span></td>
            <td style="text-align:right;font-size:10px">${c.vigencia_fim || '—'}<br><span style="font-size:8px;color:#94a3b8">${diasVenc}</span></td>
            <td style="text-align:right;font-size:11px">${brl(c.valor_mensal_bruto)}</td>
            <td style="text-align:center">${a ? `<span style="background:${a.bg};color:${a.cor};padding:2px 7px;border-radius:20px;font-size:9px;font-weight:700;white-space:nowrap">${a.icon} ${a.label}</span>` : '<span style="color:#22c55e;font-size:9px">✅ OK</span>'}</td>
            <td style="text-align:center">
              <button onclick="abrirModalReajuste(${JSON.stringify(c).replace(/"/g,'&quot;')})"
                style="font-size:9px;padding:3px 8px;border:1px solid #7c3aed;border-radius:4px;background:#f5f3ff;color:#7c3aed;cursor:pointer;font-weight:600">
                ✏️ Editar
              </button>
            </td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
}

function abrirModalReajuste(contrato) {
  _reajusteAtual = contrato;
  document.getElementById('reaj-modal-num').textContent = contrato.numContrato;
  document.getElementById('reaj-data-ultimo').value   = contrato.data_ultimo_reajuste || '';
  document.getElementById('reaj-data-proximo').value  = contrato.data_proximo_reajuste || '';
  document.getElementById('reaj-indice').value        = contrato.indice_reajuste || 'INPC';
  document.getElementById('reaj-pct').value           = contrato.pct_reajuste_ultimo || '';
  document.getElementById('reaj-obs').value           = contrato.obs_reajuste || '';
  document.getElementById('modal-reajuste').style.display = 'flex';
}

function fecharModalReajuste() {
  document.getElementById('modal-reajuste').style.display = 'none';
  _reajusteAtual = null;
}

async function salvarReajuste() {
  if (!_reajusteAtual) return;
  const body = {
    data_ultimo_reajuste:  document.getElementById('reaj-data-ultimo').value || null,
    indice_reajuste:       document.getElementById('reaj-indice').value || null,
    pct_reajuste_ultimo:   parseFloat(document.getElementById('reaj-pct').value) || null,
    data_proximo_reajuste: document.getElementById('reaj-data-proximo').value || null,
    obs_reajuste:          document.getElementById('reaj-obs').value || null,
  };
  showLoading('Salvando reajuste…');
  try {
    const r = await api('/reajustes/' + encodeURIComponent(_reajusteAtual.numContrato), {
      method: 'PATCH', body: JSON.stringify(body)
    });
    if (r.ok) { toast('Reajuste salvo!'); fecharModalReajuste(); loadReajustes(); }
    else toast(r.error || 'Erro ao salvar', 'error');
  } finally { hideLoading(); }
}

// ═══════════════════════════════════════════════════════════════
// 6. NOTIFICAÇÕES — Botão no Dashboard + Modal SMTP
// ═══════════════════════════════════════════════════════════════

function criarPainelNotificacoes() {
  // Inserir card de notificações no dashboard após os alertas
  const alertas = document.getElementById('dash-alertas');
  if (!alertas) return;
  const parent = alertas.closest('.dash-panel');
  if (!parent || document.getElementById('notif-panel')) return;

  const panel = document.createElement('div');
  panel.className = 'dash-panel';
  panel.id = 'notif-panel';
  panel.style.cssText = 'margin-top:14px';
  panel.innerHTML = `
    <div class="dash-panel-title">🔔 Notificações por E-mail</div>
    <div id="notif-preview" style="font-size:11px;color:#64748b;margin-bottom:10px">Carregando alertas pendentes...</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button onclick="enviarAlertas()" id="btn-enviar-alertas"
        style="padding:7px 14px;background:#1e293b;color:#fff;border:none;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer">
        📧 Enviar Alertas Agora
      </button>
      <button onclick="abrirConfigSmtp()"
        style="padding:7px 14px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;font-size:11px;cursor:pointer">
        ⚙️ Configurar SMTP
      </button>
    </div>
    <div id="notif-log-link" style="margin-top:8px;font-size:9px;color:#94a3b8"></div>
  `;
  parent.parentElement.insertBefore(panel, parent.nextSibling);
  loadNotifPreview();
}

async function loadNotifPreview() {
  const el = document.getElementById('notif-preview');
  if (!el) return;
  try {
    const data = await api('/notificacoes/preview');
    if (!data || data.error) { el.innerHTML = '<span style="color:#dc2626">Erro ao verificar alertas</span>'; return; }
    const total = data.certidoes.length + data.contratos.length + data.pagamentos_atrasados + data.licitacoes.length;
    if (total === 0) {
      el.innerHTML = '<span style="color:#15803d">✅ Nenhum alerta pendente</span>';
    } else {
      const items = [];
      if (data.certidoes.length)        items.push(`<span style="color:#dc2626">📋 ${data.certidoes.length} certidão(ões) vencendo</span>`);
      if (data.contratos.length)        items.push(`<span style="color:#d97706">📄 ${data.contratos.length} contrato(s) vencendo</span>`);
      if (data.pagamentos_atrasados)    items.push(`<span style="color:#7c3aed">💸 ${data.pagamentos_atrasados} pgto(s) atrasado(s)</span>`);
      if (data.licitacoes.length)       items.push(`<span style="color:#0369a1">🏛️ ${data.licitacoes.length} licitação(ões) em breve</span>`);
      el.innerHTML = items.join(' · ');
    }
  } catch(e) {
    el.innerHTML = '<span style="color:#94a3b8">—</span>';
  }
}

async function enviarAlertas() {
  const btn = document.getElementById('btn-enviar-alertas');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Enviando...'; }
  const r = await api('/notificacoes/enviar', { method: 'POST' });
  if (btn) { btn.disabled = false; btn.textContent = '📧 Enviar Alertas Agora'; }
  if (r.ok) {
    if (r.enviado) {
      toast('E-mail enviado: ' + r.message);
    } else {
      toast(r.message || 'Nenhum alerta para enviar', 'info');
    }
    loadNotifPreview();
  } else {
    toast(r.error || 'Erro ao enviar', 'error');
  }
}

function abrirConfigSmtp() {
  // Criar modal SMTP se não existir
  if (!document.getElementById('modal-smtp')) {
    const m = document.createElement('div');
    m.id = 'modal-smtp';
    m.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;align-items:center;justify-content:center';
    m.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:24px;width:460px;max-width:95vw">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <h3 style="font-size:15px;font-weight:700;color:#0f172a">⚙️ Configuração SMTP — E-mail</h3>
          <button onclick="document.getElementById('modal-smtp').style.display='none'" style="background:none;border:none;font-size:18px;cursor:pointer;color:#64748b">✕</button>
        </div>
        <div style="display:grid;gap:10px">
          <div style="display:grid;grid-template-columns:1fr 120px;gap:10px">
            <div><label style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase">Servidor SMTP</label>
              <input id="smtp-host" type="text" placeholder="smtp.gmail.com" style="width:100%;padding:7px;border:1px solid #e2e8f0;border-radius:5px;font-size:12px;margin-top:3px;box-sizing:border-box">
            </div>
            <div><label style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase">Porta</label>
              <input id="smtp-port" type="number" value="587" style="width:100%;padding:7px;border:1px solid #e2e8f0;border-radius:5px;font-size:12px;margin-top:3px;box-sizing:border-box">
            </div>
          </div>
          <div><label style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase">Usuário (e-mail)</label>
            <input id="smtp-user" type="email" placeholder="seu@email.com.br" style="width:100%;padding:7px;border:1px solid #e2e8f0;border-radius:5px;font-size:12px;margin-top:3px;box-sizing:border-box">
          </div>
          <div><label style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase">Senha (ou App Password)</label>
            <input id="smtp-pass" type="password" placeholder="Senha ou senha de app do Gmail" style="width:100%;padding:7px;border:1px solid #e2e8f0;border-radius:5px;font-size:12px;margin-top:3px;box-sizing:border-box">
          </div>
          <div><label style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase">E-mail Remetente</label>
            <input id="smtp-from" type="email" placeholder="montanaseguranaca@email.com.br" style="width:100%;padding:7px;border:1px solid #e2e8f0;border-radius:5px;font-size:12px;margin-top:3px;box-sizing:border-box">
          </div>
          <div><label style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase">Destinatário dos Alertas</label>
            <input id="smtp-to" type="email" placeholder="financeiro@empresa.com.br" style="width:100%;padding:7px;border:1px solid #e2e8f0;border-radius:5px;font-size:12px;margin-top:3px;box-sizing:border-box">
          </div>
          <div style="background:#fef3c7;border-radius:6px;padding:8px;font-size:9px;color:#92400e">
            💡 Para Gmail: ative autenticação de 2 fatores e gere uma <strong>Senha de App</strong> em myaccount.google.com/apppasswords
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
          <button onclick="document.getElementById('modal-smtp').style.display='none'" style="padding:8px 16px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;font-size:11px;cursor:pointer">Cancelar</button>
          <button onclick="salvarSmtp()" style="padding:8px 16px;background:#1e293b;color:#fff;border:none;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer">💾 Salvar</button>
        </div>
        <div style="margin-top:12px;border-top:1px solid #e2e8f0;padding-top:10px">
          <div style="font-size:10px;font-weight:700;color:#475569;margin-bottom:6px">Log de Envios Recentes</div>
          <div id="smtp-log" style="max-height:120px;overflow-y:auto;font-size:9px;color:#64748b"></div>
        </div>
      </div>
    `;
    document.body.appendChild(m);
  }

  // Pré-preencher config salva
  api('/notificacoes/smtp').then(smtp => {
    if (smtp && !smtp.error) {
      document.getElementById('smtp-host').value = smtp.host || '';
      document.getElementById('smtp-port').value = smtp.port || 587;
      document.getElementById('smtp-user').value = smtp.user || '';
      document.getElementById('smtp-pass').value = smtp.pass || '';
      document.getElementById('smtp-from').value = smtp.from || '';
      document.getElementById('smtp-to').value   = smtp.to   || '';
    }
  });

  // Carregar log
  api('/notificacoes/log').then(data => {
    const el = document.getElementById('smtp-log');
    if (!el) return;
    if (!data || !data.data || data.data.length === 0) {
      el.innerHTML = '<span style="color:#94a3b8">Nenhum envio registrado</span>';
    } else {
      el.innerHTML = data.data.slice(0, 10).map(r => `
        <div style="padding:3px 0;border-bottom:1px solid #f1f5f9;display:flex;gap:6px;align-items:center">
          <span style="color:${r.status === 'enviado' ? '#15803d' : '#dc2626'}">${r.status === 'enviado' ? '✅' : '❌'}</span>
          <span>${r.created_at}</span>
          <span>→</span>
          <span>${r.destinatario}</span>
          ${r.erro ? `<span style="color:#dc2626">${r.erro}</span>` : ''}
        </div>`).join('');
    }
  });

  document.getElementById('modal-smtp').style.display = 'flex';
}

async function salvarSmtp() {
  const body = {
    host: document.getElementById('smtp-host').value.trim(),
    port: document.getElementById('smtp-port').value,
    user: document.getElementById('smtp-user').value.trim(),
    pass: document.getElementById('smtp-pass').value,
    from: document.getElementById('smtp-from').value.trim(),
    to:   document.getElementById('smtp-to').value.trim()
  };
  const r = await api('/notificacoes/smtp', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (r.ok) { toast('Configuração SMTP salva!'); document.getElementById('modal-smtp').style.display = 'none'; }
  else toast(r.error || 'Erro ao salvar', 'error');
}

// ═══════════════════════════════════════════════════════════════
// INICIALIZAÇÃO — chamar após o dashboard carregar
// ═══════════════════════════════════════════════════════════════

// Aguarda o DOM e o loadDashboard original terminarem
document.addEventListener('DOMContentLoaded', () => {
  // Inserir painel de notificações no dashboard após 500ms
  // (dá tempo do loadDashboard preencher os elementos)
  setTimeout(() => {
    criarPainelNotificacoes();
    loadCertAlertas();
  }, 800);
});

// ─── RETENÇÕES TRIBUTÁRIAS ──────────────────────────────────────

let _retData = null;

async function loadRetencoes() {
  const el = document.getElementById('ret-kpis');
  if (!_retData) {
    el.innerHTML = '<div class="loading">Carregando análise de retenções</div>';
    _retData = await api('/retencoes/analise');
  }
  const d = _retData;
  const r = d.resumo;
  const filtroEsfera = document.getElementById('ret-esfera')?.value || '';
  const filtroStatus = document.getElementById('ret-status')?.value || '';

  // Filtrar dados
  let dados = d.data || [];
  if (filtroEsfera) dados = dados.filter(x => x.esfera === filtroEsfera);
  if (filtroStatus) dados = dados.filter(x => x.status === filtroStatus);

  // KPIs
  const totalBruto = dados.reduce((s, x) => s + x.valor_bruto, 0);
  const totalRetReal = dados.reduce((s, x) => s + x.retencao_real, 0);
  const totalRetEsp = dados.reduce((s, x) => s + x.retencao_esperada, 0);
  const diff = totalRetReal - totalRetEsp;
  const oks = dados.filter(x => x.status === 'OK').length;
  const alerts = dados.filter(x => x.status === 'ALERTA').length;
  const divs = dados.filter(x => x.status === 'DIVERGENTE').length;
  const pctAder = dados.length > 0 ? ((oks / dados.length) * 100).toFixed(1) : 0;

  el.innerHTML = `
    <div class="kpi" style="border-left:4px solid #0e7490">
      <div class="kpi-l">🧾 NFs Analisadas</div>
      <div class="kpi-v" style="color:#0e7490">${dados.length}</div>
      <div class="kpi-s">de ${r.total_nfs} total</div>
    </div>
    <div class="kpi" style="border-left:4px solid #7c3aed">
      <div class="kpi-l">💰 Valor Bruto</div>
      <div class="kpi-v" style="color:#7c3aed">${brl(totalBruto)}</div>
      <div class="kpi-s">faturamento</div>
    </div>
    <div class="kpi" style="border-left:4px solid #dc2626">
      <div class="kpi-l">🏛️ Ret. Real</div>
      <div class="kpi-v red">${brl(totalRetReal)}</div>
      <div class="kpi-s">${totalBruto > 0 ? ((totalRetReal/totalBruto)*100).toFixed(1) : 0}% do bruto</div>
    </div>
    <div class="kpi" style="border-left:4px solid #1d4ed8">
      <div class="kpi-l">📐 Ret. Esperada</div>
      <div class="kpi-v blue">${brl(totalRetEsp)}</div>
      <div class="kpi-s">pela legislação</div>
    </div>
    <div class="kpi" style="border-left:4px solid ${diff >= 0 ? '#15803d' : '#dc2626'}">
      <div class="kpi-l">${diff >= 0 ? '📈' : '📉'} Diferença</div>
      <div class="kpi-v" style="color:${diff >= 0 ? '#15803d' : '#dc2626'}">${brl(diff)}</div>
      <div class="kpi-s">${diff >= 0 ? 'retido a mais (favor empresa)' : 'retido a menos (risco)'}</div>
    </div>
    <div class="kpi" style="border-left:4px solid #15803d">
      <div class="kpi-l">✅ Aderência</div>
      <div class="kpi-v green">${pctAder}%</div>
      <div style="background:#e2e8f0;border-radius:4px;height:6px;margin:6px 0 2px"><div style="background:#22c55e;height:6px;border-radius:4px;width:${pctAder}%"></div></div>
      <div class="kpi-s">${oks} OK · ${alerts} alertas · ${divs} divergentes</div>
    </div>
  `;

  // Gráfico por tributo (barras horizontais comparativas)
  const tributos = d.porTributo || {};
  const tribNomes = { inss: 'INSS 11%', irrf: 'IR/CSRF 4,8%', iss: 'ISS (2-5%)', csll: 'CSLL 1%', pis: 'PIS 0,65% (ret.)', cofins: 'COFINS 3% (ret.)' };
  const maxTrib = Math.max(...Object.values(tributos).map(t => Math.max(t.real, t.esperado)), 1);
  let chartHtml = '';
  for (const [key, val] of Object.entries(tributos)) {
    const wReal = Math.max((val.real / maxTrib) * 100, 1);
    const wEsp = Math.max((val.esperado / maxTrib) * 100, 1);
    const diffT = val.real - val.esperado;
    const diffColor = Math.abs(diffT) < 100 ? '#64748b' : diffT > 0 ? '#dc2626' : '#15803d';
    chartHtml += `
      <div style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:3px">
          <span style="font-weight:700;color:#334155">${tribNomes[key] || key.toUpperCase()}</span>
          <span style="color:${diffColor};font-weight:600">${diffT >= 0 ? '+' : ''}${brl(diffT)}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:2px">
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:8px;color:#64748b;width:50px">Real</span>
            <div style="flex:1;background:#f1f5f9;border-radius:3px;height:10px;overflow:hidden">
              <div style="background:linear-gradient(90deg,#3b82f6,#1d4ed8);height:100%;width:${wReal}%;border-radius:3px"></div>
            </div>
            <span style="font-size:8px;color:#475569;min-width:80px;text-align:right">${brl(val.real)}</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:8px;color:#64748b;width:50px">Esperado</span>
            <div style="flex:1;background:#f1f5f9;border-radius:3px;height:10px;overflow:hidden">
              <div style="background:linear-gradient(90deg,#a78bfa,#7c3aed);height:100%;width:${wEsp}%;border-radius:3px"></div>
            </div>
            <span style="font-size:8px;color:#475569;min-width:80px;text-align:right">${brl(val.esperado)}</span>
          </div>
        </div>
      </div>`;
  }
  document.getElementById('ret-chart-tributos').innerHTML = chartHtml;

  // Gráfico por esfera
  const esferas = d.porEsfera || {};
  let esfHtml = '';
  const esfCores = { Federal: '#1d4ed8', Estadual: '#d97706', Municipal: '#15803d' };
  const maxEsf = Math.max(...Object.values(esferas).map(e => Math.max(e.retReal, e.retEsperada)), 1);
  for (const [esf, val] of Object.entries(esferas)) {
    const wR = Math.max((val.retReal / maxEsf) * 100, 1);
    const wE = Math.max((val.retEsperada / maxEsf) * 100, 1);
    const diffE = val.retReal - val.retEsperada;
    const cor = esfCores[esf] || '#64748b';
    esfHtml += `
      <div style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <span style="font-weight:700;color:${cor};font-size:11px">${esf}</span>
          <span style="font-size:10px;color:#64748b">${val.nfs} NFs · Bruto ${brl(val.bruto)}</span>
        </div>
        <div style="display:flex;gap:4px;align-items:center;margin-bottom:2px">
          <span style="font-size:8px;color:#64748b;width:50px">Real</span>
          <div style="flex:1;background:#f1f5f9;border-radius:3px;height:12px;overflow:hidden">
            <div style="background:${cor};height:100%;width:${wR}%;border-radius:3px;opacity:.8"></div>
          </div>
          <span style="font-size:9px;color:#475569;font-weight:600;min-width:90px;text-align:right">${brl(val.retReal)}</span>
        </div>
        <div style="display:flex;gap:4px;align-items:center">
          <span style="font-size:8px;color:#64748b;width:50px">Esperado</span>
          <div style="flex:1;background:#f1f5f9;border-radius:3px;height:12px;overflow:hidden">
            <div style="background:${cor};height:100%;width:${wE}%;border-radius:3px;opacity:.4"></div>
          </div>
          <span style="font-size:9px;color:#475569;min-width:90px;text-align:right">${brl(val.retEsperada)}</span>
        </div>
        <div style="font-size:9px;text-align:right;color:${Math.abs(diffE)<100?'#64748b':diffE>0?'#dc2626':'#15803d'};font-weight:600;margin-top:2px">
          Diff: ${diffE>=0?'+':''}${brl(diffE)}
        </div>
      </div>`;
  }
  document.getElementById('ret-chart-esfera').innerHTML = esfHtml;

  // Regras (expandível)
  const regras = d.regras || {};
  let regrasHtml = '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:10px">';
  for (const [key, regra] of Object.entries(regras)) {
    const totalAliq = regra.inss + regra.irrf + regra.csll + regra.pis + regra.cofins;
    regrasHtml += `
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px">
        <div style="font-weight:700;color:#334155;font-size:12px;margin-bottom:8px">${regra.label}</div>
        <table style="width:100%;font-size:10px">
          <tr><td style="color:#64748b">INSS</td><td style="text-align:right;font-weight:600">${regra.inss}%</td></tr>
          <tr><td style="color:#64748b">IRRF</td><td style="text-align:right;font-weight:600">${regra.irrf}%</td></tr>
          <tr><td style="color:#64748b">CSLL</td><td style="text-align:right;font-weight:600">${regra.csll}%</td></tr>
          <tr><td style="color:#64748b">PIS</td><td style="text-align:right;font-weight:600">${regra.pis}%</td></tr>
          <tr><td style="color:#64748b">COFINS</td><td style="text-align:right;font-weight:600">${regra.cofins}%</td></tr>
          <tr style="border-top:1px solid #e2e8f0"><td style="color:#334155;font-weight:700;padding-top:4px">s/ ISS</td><td style="text-align:right;font-weight:800;padding-top:4px;color:#0e7490">${totalAliq.toFixed(2)}%</td></tr>
        </table>
        <div style="font-size:9px;color:#94a3b8;margin-top:8px;line-height:1.3">${regra.nota}</div>
      </div>`;
  }
  regrasHtml += '</div>';
  document.getElementById('ret-regras-content').innerHTML = regrasHtml;

  // Tabela NF a NF
  document.getElementById('ret-counter').textContent = dados.length + ' notas fiscais';
  document.getElementById('ret-head').innerHTML = `<tr>
    <th>NF</th><th>Tomador</th><th>Esfera</th><th class="r">Bruto</th>
    <th class="r">Ret. Real</th><th class="r">Ret. Esperada</th><th class="r">Diferença</th>
    <th>ISS</th><th>Status</th>
  </tr>`;

  document.getElementById('ret-body').innerHTML = dados.map(x => {
    const stColor = x.status === 'OK' ? 'green' : x.status === 'ALERTA' ? 'amber' : 'red';
    const diffColor = Math.abs(x.pct_diferenca) < 1 ? '#64748b' : x.diferenca > 0 ? '#dc2626' : '#15803d';
    const esfColor = x.esfera === 'Federal' ? '#1d4ed8' : x.esfera === 'Municipal' ? '#15803d' : '#d97706';
    return `<tr style="${x.status === 'DIVERGENTE' ? 'background:#fef2f2' : x.status === 'ALERTA' ? 'background:#fffbeb' : ''}">
      <td class="mono" style="font-size:10px;font-weight:700;color:#0e7490">NF ${x.numero}</td>
      <td style="font-size:10px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${x.tomador}">${(x.tomador || '').substring(0, 35)}</td>
      <td><span style="font-size:9px;font-weight:700;color:${esfColor}">${x.esfera}</span></td>
      <td class="r mono" style="font-weight:600">${brl(x.valor_bruto)}</td>
      <td class="r mono" style="color:#dc2626;font-weight:600">${brl(x.retencao_real)}</td>
      <td class="r mono" style="color:#1d4ed8">${brl(x.retencao_esperada)}</td>
      <td class="r mono" style="color:${diffColor};font-weight:700">${x.diferenca >= 0 ? '+' : ''}${brl(x.diferenca)} <span style="font-size:8px">(${x.pct_diferenca >= 0 ? '+' : ''}${x.pct_diferenca}%)</span></td>
      <td style="font-size:10px;color:#64748b;text-align:center">${x.aliquotas.iss}%</td>
      <td>${badge(x.status, stColor)}</td>
    </tr>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════
// 7. CONTA VINCULADA — Provisões Trabalhistas (contratos federais)
// ═══════════════════════════════════════════════════════════════

async function loadContaVinculada() {
  const data = await api('/conta-vinculada/estimativa');
  if (!data || data.error || !data.contratos || !data.contratos.length) {
    document.getElementById('cv-kpis').innerHTML = '<div style="padding:20px;text-align:center;color:#94a3b8">Nenhum contrato federal com conta vinculada encontrado para esta empresa.</div>';
    return;
  }

  // Usar o primeiro contrato (UFT)
  const cv = data.contratos[0];
  const c = cv.contrato;
  const p = cv.parametros;

  // ─── KPIs ───
  const kpis = [
    { icon: '📄', label: 'CONTRATO', value: c.numContrato, sub: c.nome.substring(0, 40), color: '#1e40af' },
    { icon: '💰', label: 'FAT. MENSAL', value: brl(c.valorMensalBruto), sub: 'valor bruto NF/mês', color: '#059669' },
    { icon: '👷', label: 'MÓD. 1 ESTIMADO', value: brl(p.modulo1Estimado), sub: `${(data.fatorRemuneracao * 100).toFixed(0)}% do faturamento`, color: '#7c3aed' },
    { icon: '🏦', label: 'CV MENSAL', value: brl(cv.totalProvisaoMensal), sub: `${p.pctSobreFaturamento}% do faturamento`, color: '#0891b2' },
    { icon: '📊', label: 'SALDO CV ACUM.', value: brl(cv.saldoCVAcumulado), sub: `projeção acumulada`, color: '#dc2626' },
    { icon: '📅', label: 'CV ANUAL', value: brl(cv.cvAnualEstimada), sub: '12 meses estimados', color: '#d97706' }
  ];

  document.getElementById('cv-kpis').innerHTML = kpis.map(k => `
    <div class="kc" style="border-left:3px solid ${k.color}">
      <div class="kc-h"><span>${k.icon}</span> ${k.label}</div>
      <div class="kc-v" style="color:${k.color};font-size:${k.label === 'CONTRATO' ? '14px' : '18px'}">${k.value}</div>
      <div class="kc-s">${k.sub}</div>
    </div>
  `).join('');

  // ─── Provisões Mensais ───
  const provItems = Object.entries(cv.provisoesMensais).map(([key, prov]) => {
    const barW = (prov.pct / 12) * 100; // escala para visualização
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f1f5f9">
        <div style="width:200px;font-size:11px;font-weight:600;color:#334155">${prov.label}</div>
        <div style="flex:1;background:#f1f5f9;border-radius:4px;height:16px;position:relative">
          <div style="background:linear-gradient(90deg,#0891b2,#06b6d4);height:100%;border-radius:4px;width:${Math.min(barW, 100)}%"></div>
          <span style="position:absolute;right:4px;top:0;font-size:9px;color:#475569;line-height:16px">${prov.pct}%</span>
        </div>
        <div style="width:100px;text-align:right;font-size:12px;font-weight:700;color:#0f172a;font-family:monospace">${brl(prov.valor)}</div>
      </div>`;
  }).join('');

  // Totais
  const totalLine = `
    <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-top:2px solid #0891b2;margin-top:4px">
      <div style="width:200px;font-size:12px;font-weight:800;color:#0891b2">TOTAL MENSAL CV</div>
      <div style="flex:1;background:#ecfeff;border-radius:4px;height:20px;position:relative">
        <div style="background:linear-gradient(90deg,#0891b2,#22d3ee);height:100%;border-radius:4px;width:100%"></div>
        <span style="position:absolute;right:4px;top:0;font-size:10px;color:#0e7490;line-height:20px;font-weight:700">${CONTA_VINCULADA_PROVISOES_TOTAL}%</span>
      </div>
      <div style="width:100px;text-align:right;font-size:14px;font-weight:800;color:#0891b2;font-family:monospace">${brl(cv.totalProvisaoMensal)}</div>
    </div>`;

  document.getElementById('cv-provisoes').innerHTML = provItems + totalLine;

  // ─── Base Legal ───
  document.getElementById('cv-legal').innerHTML = `
    <div style="font-size:11px;line-height:1.8;color:#334155">
      ${cv.baseLegal.map(l => `<div style="padding:4px 8px;background:#f8fafc;border-radius:4px;margin-bottom:4px;border-left:2px solid #0891b2">📜 ${l}</div>`).join('')}
    </div>
    <div style="margin-top:12px;padding:10px;background:#fffbeb;border-radius:8px;border:1px solid #fbbf24">
      <div style="font-size:11px;font-weight:700;color:#92400e;margin-bottom:4px">⚠️ Nota Importante</div>
      <div style="font-size:10px;color:#78350f">
        Esta é uma <b>estimativa</b> baseada nos percentuais padrão da IN 05/2017.
        Os valores reais dependem da planilha de custos do contrato e do extrato da conta vinculada.
        O Módulo 1 (remuneração) foi estimado em <b>${(data.fatorRemuneracao * 100).toFixed(0)}%</b> do faturamento mensal.
        Confirmar com o extrato bancário da conta vinculada.
      </div>
    </div>
    <div style="margin-top:10px;padding:8px;background:#f0fdf4;border-radius:8px;border:1px solid #86efac">
      <div style="font-size:10px;color:#166534">
        <b>✅ Validação:</b> Saldo reportado R$ ${(c.totalAberto || 0).toLocaleString('pt-BR', {minimumFractionDigits:2})}
        vs. estimativa ${brl(cv.projecaoMensal.length > 0 ? cv.projecaoMensal[cv.projecaoMensal.length - 1].saldoCVAcumulado : 0)}
        — ${cv.projecaoMensal.length} mês(es) de NF
      </div>
    </div>`;

  // ─── Gráfico de barras — Saldo CV acumulado ───
  const todosMeses = [...cv.projecaoMensal, ...cv.mesesFuturos];
  if (todosMeses.length > 0) {
    const maxSaldo = Math.max(...todosMeses.map(m => m.saldoCVAcumulado));
    document.getElementById('cv-proj-legenda').innerHTML = `
      <span style="display:inline-block;width:10px;height:10px;background:#0891b2;border-radius:2px;margin-right:3px"></span>Realizado
      <span style="display:inline-block;width:10px;height:10px;background:#67e8f9;border-radius:2px;margin-left:8px;margin-right:3px;border:1px dashed #0891b2"></span>Projetado`;

    document.getElementById('cv-chart').innerHTML = `
      <div style="display:flex;align-items:flex-end;gap:3px;height:180px;padding:10px 0">
        ${todosMeses.map(m => {
          const h = maxSaldo > 0 ? (m.saldoCVAcumulado / maxSaldo * 150) : 0;
          const isProj = m.projetado;
          const bg = isProj ? 'background:repeating-linear-gradient(45deg,#67e8f9,#67e8f9 3px,#cffafe 3px,#cffafe 6px)' : 'background:linear-gradient(180deg,#0891b2,#06b6d4)';
          return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;min-width:0">
            <div style="font-size:8px;color:#0e7490;font-weight:700;margin-bottom:2px;white-space:nowrap">${brl(m.saldoCVAcumulado).replace('R$','').trim()}</div>
            <div style="${bg};width:100%;height:${Math.max(h, 4)}px;border-radius:4px 4px 0 0;min-width:20px" title="Saldo CV: ${brl(m.saldoCVAcumulado)}"></div>
            <div style="font-size:8px;color:#64748b;margin-top:3px;writing-mode:vertical-lr;transform:rotate(180deg);height:40px;overflow:hidden">${m.competencia}</div>
          </div>`;
        }).join('')}
      </div>`;
  }

  // ─── Eventos de Liberação ───
  document.getElementById('cv-eventos').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px">
      ${cv.eventosLiberacao.map(ev => {
        const provBase = cv.provisoesMensais[ev.base];
        const valorMensal = provBase ? provBase.valor : 0;
        const valorAnual = +(valorMensal * 12).toFixed(2);
        const iconEv = ev.evento.includes('13º') ? '🎄' : ev.evento.includes('Férias') ? '🏖️' : ev.evento.includes('1/3') ? '⅓' : '📋';
        return `
          <div style="background:#f8fafc;border-radius:8px;padding:10px;border:1px solid #e2e8f0">
            <div style="font-size:12px;font-weight:700;color:#0f172a;margin-bottom:4px">${iconEv} ${ev.evento}</div>
            <div style="font-size:10px;color:#64748b;margin-bottom:6px">${ev.fundamentacao}</div>
            <div style="display:flex;justify-content:space-between;align-items:center">
              <span style="font-size:10px;color:#475569">Mês: <b>${ev.mes}</b></span>
              <span style="font-size:12px;font-weight:700;color:#059669;font-family:monospace">${brl(valorAnual)}</span>
            </div>
            <div style="font-size:9px;color:#94a3b8;margin-top:2px">Provisão mensal: ${brl(valorMensal)} × 12 = ${brl(valorAnual)}</div>
          </div>`;
      }).join('')}
    </div>`;

  // ─── Tabela detalhada ───
  document.getElementById('cv-thead').innerHTML = `<tr>
    <th>Competência</th><th>Status</th><th>NFs</th>
    <th class="r">Fat. Bruto</th><th class="r">Ret. Tributária</th>
    <th class="r">Líq. após Tributos</th><th class="r">CV Estimada</th>
    <th class="r">Líq. após CV</th><th class="r">Saldo CV Acum.</th>
  </tr>`;

  document.getElementById('cv-tbody').innerHTML = todosMeses.map(m => {
    const isProj = m.projetado;
    const rowStyle = isProj ? 'background:#f0fdfa;font-style:italic' : '';
    const statusBadge = isProj
      ? '<span style="background:#e0f2fe;color:#0369a1;padding:2px 6px;border-radius:8px;font-size:9px">📅 Projetado</span>'
      : '<span style="background:#dcfce7;color:#166534;padding:2px 6px;border-radius:8px;font-size:9px">✅ NF Emitida</span>';

    return `<tr style="${rowStyle}">
      <td style="font-weight:700">${m.competencia}</td>
      <td>${statusBadge}</td>
      <td class="r">${m.qtdNFs || '—'}</td>
      <td class="r mono">${brl(m.faturamentoBruto)}</td>
      <td class="r mono" style="color:#dc2626">${m.retencaoTributaria != null ? brl(m.retencaoTributaria) : '—'}</td>
      <td class="r mono">${m.liquidoAposTributos != null ? brl(m.liquidoAposTributos) : '—'}</td>
      <td class="r mono" style="color:#0891b2;font-weight:700">${brl(m.cvEstimada)}</td>
      <td class="r mono">${m.liquidoAposCV != null ? brl(m.liquidoAposCV) : '—'}</td>
      <td class="r mono" style="color:#0e7490;font-weight:700">${brl(m.saldoCVAcumulado)}</td>
    </tr>`;
  }).join('');
}

// Constante usada no render
const CONTA_VINCULADA_PROVISOES_TOTAL = '31.04';

// ═══════════════════════════════════════════════════════════════
// MELHORIAS EXTRAS (sem dados)
// ═══════════════════════════════════════════════════════════════

// ── 8. Tela de Configurações ──────────────────────────────────
const CFG_KEYS = ['periodo-padrao','paginacao','smtp-host','smtp-port','smtp-user','smtp-dest','alerta-certidoes','alerta-parcelas','alerta-extratos'];

function loadConfig() {
  CFG_KEYS.forEach(k => {
    const el = document.getElementById('cfg-' + k);
    if (!el) return;
    const val = localStorage.getItem('montana_cfg_' + k);
    if (val === null) return;
    if (el.type === 'checkbox') el.checked = val === '1';
    else el.value = val;
  });

  // Setar defaults Gmail antes de carregar do banco
  const hostEl = document.getElementById('cfg-smtp-host');
  const portEl = document.getElementById('cfg-smtp-port');
  if (hostEl && !hostEl.value) hostEl.value = 'smtp.gmail.com';
  if (portEl && !portEl.value) portEl.value = '587';

  // Carregar configurações SMTP salvas no banco
  api('/notificacoes/smtp').then(smtp => {
    if (!smtp || smtp.error) return;
    const fld = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
    fld('cfg-smtp-host', smtp.host || 'smtp.gmail.com');
    fld('cfg-smtp-port', smtp.port || '587');
    fld('cfg-smtp-user', smtp.user);
    fld('cfg-smtp-pass', smtp.pass && smtp.pass !== '••••••••' ? smtp.pass : '');
    fld('cfg-smtp-dest', smtp.to);
    if (smtp.user) {
      const statusEl = document.getElementById('cfg-smtp-status');
      if (statusEl && !statusEl.textContent) statusEl.textContent = '✅ SMTP configurado';
    }
  }).catch(() => {});

  // Dados cadastrais da empresa ativa
  const em = (typeof COMPANIES_META !== 'undefined' && COMPANIES_META[currentCompany]) || {};
  const infoEl = document.getElementById('cfg-empresa-info');
  if (infoEl && em.nome) {
    infoEl.innerHTML = `
      <div><strong>Razão Social:</strong> ${em.nome}</div>
      <div><strong>CNPJ:</strong> ${em.cnpj}</div>
      <div><strong>Chave interna:</strong> ${currentCompany}</div>
    `;
  }
}

function saveConfig() {
  CFG_KEYS.forEach(k => {
    const el = document.getElementById('cfg-' + k);
    if (!el) return;
    const val = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
    if (val !== '') localStorage.setItem('montana_cfg_' + k, val);
    else localStorage.removeItem('montana_cfg_' + k);
  });
  toast('Configurações salvas');
}

async function testarSmtpConfig() {
  const statusEl = document.getElementById('cfg-smtp-status');
  // Usar valor real OU placeholder como fallback (smtp.gmail.com / 587)
  const hostEl = document.getElementById('cfg-smtp-host');
  const portEl = document.getElementById('cfg-smtp-port');
  const host = (hostEl?.value?.trim()) || (hostEl?.placeholder?.trim()) || 'smtp.gmail.com';
  const port = (portEl?.value) || (portEl?.placeholder) || '587';
  // Se campo estava vazio (só placeholder), preencher visualmente
  if (hostEl && !hostEl.value) hostEl.value = host;
  if (portEl && !portEl.value) portEl.value = port;
  const user = document.getElementById('cfg-smtp-user')?.value?.trim();
  const pass = document.getElementById('cfg-smtp-pass')?.value;
  const dest = document.getElementById('cfg-smtp-dest')?.value?.trim();

  if (!host || !user || !pass) {
    if (statusEl) statusEl.textContent = '❌ Preencha servidor, usuário e senha';
    toast('Preencha todos os campos SMTP antes de testar', 'error');
    return;
  }

  if (statusEl) statusEl.textContent = '⏳ Salvando e testando...';

  // 1. Salvar primeiro no banco via PUT /notificacoes/smtp
  const saved = await api('/notificacoes/smtp', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host, port, user, pass, from: user, to: dest || user })
  });
  if (!saved.ok) {
    if (statusEl) statusEl.textContent = '❌ Erro ao salvar: ' + (saved.error || 'falha');
    return;
  }

  // 2. Enviar email de teste via POST /notificacoes/enviar
  try {
    const r = await api('/notificacoes/enviar', { method: 'POST' });
    if (r.ok) {
      if (statusEl) statusEl.textContent = '✅ Configuração salva! E-mail enviado para ' + (dest || user);
      toast('SMTP configurado! E-mail de teste enviado com sucesso.');
    } else if (r.enviado === false && r.message) {
      // Sem alertas pendentes mas conexão OK
      if (statusEl) statusEl.textContent = '✅ Conexão OK — ' + r.message;
      toast('SMTP configurado com sucesso!');
    } else {
      if (statusEl) statusEl.textContent = '❌ ' + (r.error || 'Falha no envio');
      toast(r.error || 'Falha ao enviar e-mail de teste', 'error');
    }
  } catch(e) {
    if (statusEl) statusEl.textContent = '❌ Erro de rede';
    toast('Erro de rede ao testar SMTP', 'error');
  }
}

// ── WebISS / Certificado A1 ───────────────────────────────────
async function loadWebissConfig() {
  const el = document.getElementById('webiss-cert-status');
  if (!el) return;
  el.innerHTML = '<span style="color:#94a3b8;font-size:10px">Verificando...</span>';
  try {
    const r = await api('/webiss/config');
    if (!r) return;

    let html = '<div style="display:flex;flex-wrap:wrap;gap:8px">';
    const badge = (ok, label) => `<span style="background:${ok ? '#dcfce7' : '#fee2e2'};color:${ok ? '#15803d' : '#dc2626'};padding:3px 10px;border-radius:20px;font-size:10px;font-weight:700">${ok ? '✅' : '❌'} ${label}</span>`;

    html += badge(r.certExists, 'Certificado .pfx');
    html += badge(r.hasSenha,   'Senha certificado');
    html += badge(r.hasLogin,   'Login WebISS');
    html += badge(r.hasSenhaLogin, 'Senha WebISS');

    if (r.certInfo && !r.certInfo.erro) {
      const diasCor = r.certInfo.diasRestantes < 30 ? '#dc2626' : r.certInfo.diasRestantes < 90 ? '#d97706' : '#15803d';
      html += `<span style="background:#f0f9ff;color:#0369a1;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:600">📜 ${r.certInfo.cn} · válido até ${r.certInfo.validTo} <span style="color:${diasCor}">(${r.certInfo.diasRestantes}d)</span></span>`;
    } else if (r.certInfo?.erro) {
      html += `<span style="background:#fef3c7;color:#d97706;padding:3px 10px;border-radius:20px;font-size:10px">⚠️ Erro ao ler cert: ${r.certInfo.erro}</span>`;
    }

    html += `<span style="background:${r.pronto ? '#dcfce7' : '#f1f5f9'};color:${r.pronto ? '#15803d' : '#64748b'};padding:3px 10px;border-radius:20px;font-size:10px;font-weight:700">${r.pronto ? '🚀 PRONTO para emitir NFS-e' : '⚠️ Configuração incompleta'}</span>`;
    html += '</div>';
    el.innerHTML = html;
  } catch { el.innerHTML = ''; }
}

async function uploadCertWebiss() {
  const fileInput = document.getElementById('cfg-cert-file');
  const senha = document.getElementById('cfg-cert-senha')?.value;
  if (!fileInput?.files?.length) return toast('Selecione um arquivo .pfx', 'error');

  const form = new FormData();
  form.append('cert', fileInput.files[0]);
  if (senha) form.append('senha', senha);

  showLoading('Enviando certificado…');
  try {
    const token = localStorage.getItem('montana_jwt');
    const r = await fetch(`/api/webiss/upload-cert?company=${currentCompany}`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: form,
    }).then(x => x.json());

    if (r.ok) {
      toast('Certificado enviado! ' + (r.size ? Math.round(r.size / 1024) + ' KB' : ''));
      fileInput.value = '';
      loadWebissConfig();
    } else {
      toast(r.error || 'Erro ao enviar certificado', 'error');
    }
  } finally { hideLoading(); }
}

async function salvarConfigWebiss() {
  const login      = document.getElementById('cfg-webiss-login')?.value;
  const senha      = document.getElementById('cfg-webiss-senha')?.value;
  const senha_cert = document.getElementById('cfg-cert-senha')?.value;
  if (!login && !senha && !senha_cert) return toast('Preencha ao menos um campo', 'error');

  showLoading('Salvando credenciais…');
  try {
    const r = await api('/webiss/config-senha', {
      method: 'POST',
      body: JSON.stringify({ login: login || null, senha_login: senha || null, senha_cert: senha_cert || null })
    });
    if (r.ok) { toast('Credenciais salvas!'); loadWebissConfig(); }
    else toast(r.error || 'Erro ao salvar', 'error');
  } finally { hideLoading(); }
}

async function testarWebiss() {
  const statusEl = document.getElementById('cfg-webiss-status');
  if (statusEl) statusEl.textContent = 'Testando...';
  try {
    const r = await api('/webiss/status');
    const ok = r?.ok === true;
    if (statusEl) statusEl.textContent = ok ? '✅ WebISS acessível' : '❌ Falha: ' + (r?.error || 'sem resposta');
    toast(ok ? 'WebISS: conexão OK' : 'WebISS: falha de conexão', ok ? 'success' : 'error');
  } catch (e) {
    if (statusEl) statusEl.textContent = '❌ Erro: ' + e.message;
  }
}

// Carrega config WebISS quando abre aba Config
const _origLoadConfig = typeof loadConfig !== 'undefined' ? loadConfig : null;
if (_origLoadConfig) {
  loadConfig = function() {
    _origLoadConfig();
    loadWebissConfig();
  };
}

// ── 4. Tratamento de erro global no frontend ──────────────────
window.addEventListener('unhandledrejection', e => {
  const msg = e.reason?.message || '';
  if (msg === 'Unauthorized') return; // já tratado no api()
  if (msg && !msg.includes('Failed to fetch')) {
    toast('Erro inesperado: ' + msg, 'error');
  } else if (msg.includes('Failed to fetch')) {
    toast('Sem conexão com o servidor. Verifique se o Node.js está rodando.', 'error');
  }
});

// ── 5. Atalhos de teclado ────────────────────────────────────
document.addEventListener('keydown', e => {
  // Ignorar quando foco está em inputs/textareas
  if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
  if (e.altKey) {
    const map = { '1':'assessoria','2':'seguranca','3':'portodovau','4':'mustang' };
    if (map[e.key]) { e.preventDefault(); switchCompany(map[e.key]); return; }
    const tabs = { 'd':'dashboard','e':'ext','n':'nfs','c':'cont','i':'import','s':'desp','r':'relat','p':'dre' };
    if (tabs[e.key]) {
      e.preventDefault();
      const tab = document.querySelector(`.tab[data-tab="${tabs[e.key]}"]`);
      if (tab) { showTab(tabs[e.key], tab); tab.scrollIntoView({block:'nearest'}); }
    }
  }
  // F5 → refresh dashboard
  if (e.key === 'F5' && !e.ctrlKey) {
    e.preventDefault();
    loadDashboard();
    toast('Dashboard atualizado');
  }
});

// ── 6. Debounce nos filtros de período ───────────────────────
(function() {
  const _orig = window.applyGlobalPeriod;
  if (!_orig) return;
  let _debTimer;
  window.applyGlobalPeriod = function() {
    clearTimeout(_debTimer);
    _debTimer = setTimeout(_orig, 350);
  };
})();

// ── 7. Auto-refresh do dashboard ─────────────────────────────
let _autoRefreshInterval = null;

function setAutoRefresh(minutos) {
  clearInterval(_autoRefreshInterval);
  _autoRefreshInterval = null;
  const btn = document.getElementById('btn-auto-refresh');
  if (!minutos || minutos <= 0) {
    if (btn) btn.textContent = '🔄 Auto';
    return;
  }
  _autoRefreshInterval = setInterval(() => {
    const dashTab = document.querySelector('.tab[data-tab="dashboard"]');
    if (dashTab && dashTab.classList.contains('active')) loadDashboard();
  }, minutos * 60000);
  if (btn) btn.textContent = `🔄 ${minutos}min`;
  toast(`Auto-refresh: a cada ${minutos} minuto${minutos>1?'s':''}`);
}

// Injeta botão de auto-refresh no header do dashboard
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const gbar = document.querySelector('.gbar');
    if (!gbar || document.getElementById('btn-auto-refresh')) return;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:4px;margin-left:8px';
    wrap.innerHTML = `
      <button id="btn-auto-refresh" title="Auto-refresh dashboard"
        style="padding:4px 10px;font-size:10px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;color:#475569;cursor:pointer;font-weight:600">
        🔄 Auto
      </button>
      <select id="sel-refresh" onchange="setAutoRefresh(parseInt(this.value))"
        style="padding:4px 6px;font-size:10px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;color:#475569;cursor:pointer">
        <option value="0">Off</option>
        <option value="1">1 min</option>
        <option value="5">5 min</option>
        <option value="15">15 min</option>
        <option value="30">30 min</option>
      </select>`;
    gbar.appendChild(wrap);
  }, 600);

  // Mostrar dicas de atalhos no rodapé
  setTimeout(() => {
    const hint = document.createElement('div');
    hint.id = 'kbd-hints';
    hint.style.cssText = 'position:fixed;bottom:8px;left:12px;font-size:9px;color:#94a3b8;pointer-events:none;z-index:100';
    hint.innerHTML = 'Alt+1-4: empresa · Alt+D: dashboard · Alt+E: extratos · Alt+I: importar · F5: atualizar';
    document.body.appendChild(hint);
    setTimeout(() => { hint.style.transition='opacity 2s'; hint.style.opacity='0'; setTimeout(()=>hint.remove(), 2500); }, 6000);
  }, 1500);
});

// ═══════════════════════════════════════════════════════════════
// MELHORIAS DE PRODUTO
// ═══════════════════════════════════════════════════════════════

// ── Conciliação automática por valor+data ────────────────────
async function conciliarAutoValor() {
  if (!confirm('Vincular automaticamente extratos a NFs com mesmo valor (±R$0,05) em até 3 dias de diferença?\n\nApenas extratos PENDENTES com crédito serão processados.')) return;
  showLoading('Conciliando por valor+data…');
  try {
    const r = await api('/conciliar-auto-valor', { method: 'POST', body: JSON.stringify({ dias_tolerancia: 3 }) });
    if (r.ok) {
      toast(r.message || `${r.vinculados} vinculação(ões) criada(s)`);
      loadDashboard();
      if (document.getElementById('pg-ext')?.classList.contains('active')) loadExtratos();
    } else {
      toast(r.error || 'Erro na conciliação por valor', 'error');
    }
  } finally { hideLoading(); }
}

// ── Relatório de diferença de retenção ──────────────────────
async function loadRelatorioRetencao() {
  const from = document.getElementById('ret-from')?.value || '';
  const to   = document.getElementById('ret-to')?.value   || '';
  let url = '/relatorio/retencao?_=1';
  if (from) url += '&from=' + from;
  if (to)   url += '&to='   + to;
  showLoading('Carregando relatório de retenção…');
  let data;
  try { data = await api(url); } finally { hideLoading(); }
  if (!data?.ok) return;

  const el = document.getElementById('ret-diff-body');
  if (!el) return;
  const t = data.totais;
  document.getElementById('ret-diff-totais').innerHTML = `
    <div class="kpi-card" style="border-left:4px solid #3b82f6">
      <div class="kpi-l">Total Retido nas NFs</div>
      <div class="kpi-v" style="font-size:16px;color:#1d4ed8">${brl(t.total_retencao_nf)}</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #15803d">
      <div class="kpi-l">Total Retido nos Extratos</div>
      <div class="kpi-v" style="font-size:16px;color:#15803d">${brl(t.total_retencao_extrato)}</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid ${t.diferenca > 50 ? '#dc2626' : '#d97706'}">
      <div class="kpi-l">Diferença (NF − Extrato)</div>
      <div class="kpi-v" style="font-size:16px;color:${t.diferenca > 50 ? '#dc2626' : '#d97706'}">${brl(t.diferenca)}</div>
    </div>
  `;
  el.innerHTML = data.linhas.slice(0,200).map(l => {
    const diff = l.diferenca;
    const cor = diff === null ? '#94a3b8' : Math.abs(diff) < 1 ? '#15803d' : diff > 0 ? '#dc2626' : '#d97706';
    return `<tr>
      <td class="mono">${l.numero}</td>
      <td>${l.data_emissao || '—'}</td>
      <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.tomador || '—'}</td>
      <td class="r mono">${brl(l.valor_bruto)}</td>
      <td class="r mono red">${brl(l.total_ret)}</td>
      <td class="r mono">${l.ret_extrato != null ? brl(l.ret_extrato) : '<span class="muted">—</span>'}</td>
      <td class="r mono" style="color:${cor};font-weight:700">${diff != null ? brl(diff) : '<span class="muted">—</span>'}</td>
    </tr>`;
  }).join('');
}

// ── Gráfico evolução margem mensal ───────────────────────────
// Chamado dentro de loadMargem() — injetado via hook
const _origLoadMargem = typeof loadMargem !== 'undefined' ? loadMargem : null;
if (_origLoadMargem) {
  loadMargem = async function() {
    await _origLoadMargem();
    // Busca DRE por mês para obter margem líquida mensal
    try {
      const ano = new Date().getFullYear();
      const d = await api(`/dre?ano=${ano}`);
      if (!d?.porMes?.length) return;
      const maxV = Math.max(...d.porMes.map(m => Math.abs(m.receita)), 1);
      const evolEl = document.getElementById('margem-evolucao');
      const labEl  = document.getElementById('margem-evolucao-labels');
      if (!evolEl) return;
      evolEl.innerHTML = d.porMes.map(m => {
        const margem = m.receita > 0 ? +((m.receita - m.saidas) / m.receita * 100).toFixed(1) : 0;
        const h = Math.round(Math.abs(m.receita) / maxV * 140);
        const cor = margem < 0 ? '#ef4444' : margem < 10 ? '#f59e0b' : '#22c55e';
        return `<div style="display:flex;flex-direction:column;align-items:center;flex:1;min-width:36px" title="${m.mes_ano}: ${margem}%">
          <span style="font-size:9px;color:${cor};font-weight:700;margin-bottom:2px">${margem}%</span>
          <div style="width:100%;height:${h}px;background:${cor};border-radius:3px 3px 0 0;opacity:.85"></div>
        </div>`;
      }).join('');
      labEl.innerHTML = d.porMes.map(m =>
        `<div style="flex:1;min-width:36px;text-align:center;font-size:9px;color:#64748b;font-weight:600">${m.mes_ano.slice(5)}</div>`
      ).join('');
    } catch(_) {}
  };
}

// ── DRE exportar PDF ────────────────────────────────────────
function exportDREPdf() {
  const ano = document.getElementById('dre-ano')?.value || new Date().getFullYear();
  const mes = document.getElementById('dre-mes')?.value || '';
  let url = `/api/dre/pdf?company=${currentCompany}&ano=${ano}`;
  if (mes) url += `&mes=${mes}`;
  const token = localStorage.getItem('montana_jwt');
  window.open(url + (token ? `&_token=${token}` : ''), '_blank');
}

// ── Holerite PDF ─────────────────────────────────────────────
function gerarHolerite(folhaId, funcId) {
  const token = localStorage.getItem('montana_jwt');
  const url = `/api/rh/folha/${folhaId}/holerite/${funcId}?company=${currentCompany}` + (token ? `&_token=${token}` : '');
  window.open(url, '_blank');
}

// ── Visão consolidada multi-empresa ─────────────────────────
async function loadConsolidado() {
  const el = document.getElementById('consolidado-cards');
  if (!el) return;
  el.innerHTML = '<div class="loading">Carregando...</div>';
  try {
    const token = localStorage.getItem('montana_jwt');
    const r = await fetch('/api/consolidado', { headers: { 'Authorization': 'Bearer ' + token } });
    const data = await r.json();
    if (!data.ok) { el.innerHTML = '<p style="color:#dc2626">Erro ao carregar consolidado</p>'; return; }

    const empresas = Object.values(data.empresas);
    el.innerHTML = empresas.map(e => {
      if (e.erro) return `<div class="kpi-card" style="border-left:4px solid #dc2626"><div class="kpi-l">${e.nome}</div><div style="color:#dc2626;font-size:11px">Erro: ${e.erro}</div></div>`;
      const saldo = e.entradas - e.saidas;
      return `<div class="kpi-card" style="border-left:4px solid ${e.cor || '#64748b'}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span style="font-size:20px">${e.icone || '🏢'}</span>
          <div>
            <div style="font-size:11px;font-weight:700;color:#0f172a">${e.nomeAbrev}</div>
            <div style="font-size:9px;color:#94a3b8">${e.cnpj}</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div><div class="kpi-l">Faturamento ${data.ano}</div><div style="font-size:14px;font-weight:800;color:#1d4ed8">${brl(e.faturamento)}</div></div>
          <div><div class="kpi-l">Saldo Extrato</div><div style="font-size:14px;font-weight:800;color:${saldo>=0?'#15803d':'#dc2626'}">${brl(saldo)}</div></div>
          <div><div class="kpi-l">Despesas</div><div style="font-size:13px;font-weight:700;color:#dc2626">${brl(e.despesas)}</div></div>
          <div><div class="kpi-l">Funcionários</div><div style="font-size:13px;font-weight:700;color:#475569">${e.funcionarios}</div></div>
        </div>
        ${e.pendentes > 0 ? `<div style="margin-top:8px;background:#fef3c7;border-radius:4px;padding:4px 8px;font-size:10px;color:#92400e;font-weight:600">⚠️ ${e.pendentes} extratos pendentes</div>` : ''}
      </div>`;
    }).join('');

    // Tabela comparativa
    const tw = document.getElementById('consolidado-table-wrap');
    if (tw) {
      tw.innerHTML = `<div class="tw" style="margin-top:14px"><table>
        <thead><tr>
          <th>Empresa</th><th class="r">Faturamento</th><th class="r">Entradas</th><th class="r">Saídas</th><th class="r">Saldo</th><th class="r">Despesas</th><th class="r">Funcionários</th><th class="r">Pendentes</th>
        </tr></thead>
        <tbody>${empresas.filter(e => !e.erro).map(e => {
          const saldo = e.entradas - e.saidas;
          return `<tr>
            <td><strong>${e.icone} ${e.nomeAbrev}</strong></td>
            <td class="r mono">${brl(e.faturamento)}</td>
            <td class="r mono green">${brl(e.entradas)}</td>
            <td class="r mono red">${brl(e.saidas)}</td>
            <td class="r mono" style="color:${saldo>=0?'#15803d':'#dc2626'};font-weight:700">${brl(saldo)}</td>
            <td class="r mono red">${brl(e.despesas)}</td>
            <td class="r">${e.funcionarios}</td>
            <td class="r">${e.pendentes > 0 ? `<span class="badge badge-amber">${e.pendentes}</span>` : '<span class="badge badge-green">0</span>'}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>`;
    }
  } catch(err) {
    el.innerHTML = `<p style="color:#dc2626">Erro: ${err.message}</p>`;
  }
}

// ═══════════════════════════════════════════════════════════════
// APURAÇÃO MENSAL AUTOMÁTICA
// ═══════════════════════════════════════════════════════════════
async function loadApuracaoMensal() {
  const el = document.getElementById('apuracao-body');
  const kpiEl = document.getElementById('apuracao-kpis');
  if (!el) return;

  const d = await api('/relatorios/apuracao-mensal?meses=12');
  if (!d || !d.data) return;

  const brl = v => 'R$\u00a0' + (v||0).toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2});
  const cor = v => v >= 0 ? '#059669' : '#dc2626';

  const ultimo = d.data[0];
  if (ultimo && kpiEl) {
    const margem = ultimo.receita_liquida > 0 ? (ultimo.resultado / ultimo.receita_liquida * 100) : 0;
    const totalImpostos = (ultimo.pis_a_pagar||0) + (ultimo.cofins_a_pagar||0) + (ultimo.irpj_estimado||0) + (ultimo.csll_estimado||0);
    kpiEl.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px">
        <div class="kpi" style="border-left:4px solid #3b82f6">
          <div class="kpi-l">📅 Última Apuração</div>
          <div class="kpi-v" style="color:#3b82f6;font-size:15px">${ultimo.competencia}</div>
          <div class="kpi-s">${d.fonte === 'cron' ? 'gerado automaticamente' : 'calculado agora'}</div>
        </div>
        <div class="kpi" style="border-left:4px solid #059669">
          <div class="kpi-l">💰 Receita Líquida</div>
          <div class="kpi-v" style="color:#059669">${brl(ultimo.receita_liquida)}</div>
          <div class="kpi-s">${ultimo.qtd_nfs} NFs emitidas</div>
        </div>
        <div class="kpi" style="border-left:4px solid #dc2626">
          <div class="kpi-l">💸 Despesas</div>
          <div class="kpi-v" style="color:#dc2626">${brl(ultimo.despesas_total)}</div>
          <div class="kpi-s">no período</div>
        </div>
        <div class="kpi" style="border-left:4px solid ${cor(ultimo.resultado)}">
          <div class="kpi-l">📊 Resultado</div>
          <div class="kpi-v" style="color:${cor(ultimo.resultado)}">${brl(ultimo.resultado)}</div>
          <div class="kpi-s">margem ${margem.toFixed(1)}%</div>
        </div>
        <div class="kpi" style="border-left:4px solid #7c3aed">
          <div class="kpi-l">🏛️ Impostos Estimados</div>
          <div class="kpi-v" style="color:#7c3aed">${brl(totalImpostos)}</div>
          <div class="kpi-s">PIS+COFINS+IRPJ+CSLL</div>
        </div>
        <div class="kpi" style="border-left:4px solid ${cor(ultimo.resultado - totalImpostos)}">
          <div class="kpi-l">✅ Resultado Líq. c/ Impostos</div>
          <div class="kpi-v" style="color:${cor(ultimo.resultado - totalImpostos)};font-size:13px">${brl(ultimo.resultado - totalImpostos)}</div>
          <div class="kpi-s">após tributação estimada</div>
        </div>
      </div>`;
  }

  el.innerHTML = d.data.map(m => {
    const margem = m.receita_liquida > 0 ? (m.resultado / m.receita_liquida * 100) : 0;
    const hasTax = m.pis_a_pagar != null || m.irpj_estimado != null;
    return `<tr>
      <td style="font-weight:700">${m.competencia}</td>
      <td style="text-align:right">${brl(m.receita_bruta)}</td>
      <td style="text-align:right;color:#dc2626">${brl(m.retencoes)}</td>
      <td style="text-align:right;color:#059669">${brl(m.receita_liquida)}</td>
      <td style="text-align:right;color:#dc2626">${brl(m.despesas_total)}</td>
      <td style="text-align:right;font-weight:700;color:${cor(m.resultado)}">${brl(m.resultado)}</td>
      <td style="text-align:right;color:#7c3aed;font-size:11px">${hasTax ? brl(m.pis_a_pagar||0) : '—'}</td>
      <td style="text-align:right;color:#7c3aed;font-size:11px">${hasTax ? brl(m.cofins_a_pagar||0) : '—'}</td>
      <td style="text-align:right;color:#7c3aed;font-size:11px">${hasTax ? brl(m.irpj_estimado||0) : '—'}</td>
      <td style="text-align:right;color:#7c3aed;font-size:11px">${hasTax ? brl(m.csll_estimado||0) : '—'}</td>
      <td style="text-align:center">
        <span style="background:${cor(margem)}20;color:${cor(margem)};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">${margem.toFixed(1)}%</span>
      </td>
      <td style="text-align:center;font-size:10px;color:#94a3b8">${m.qtd_nfs}</td>
    </tr>`;
  }).join('');
}

// Apurar o mês atual/anterior manualmente
async function apurarAgora() {
  const btn = document.getElementById('btn-apurar-agora');
  const comp = prompt('Competência (AAAA-MM):', new Date().toISOString().slice(0,7));
  if (!comp || !/^\d{4}-\d{2}$/.test(comp)) return;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Apurando...'; }
  try {
    const r = await api('/dre/apurar-agora', { method:'POST', body: JSON.stringify({ competencia: comp }) });
    alert(r && r.message ? r.message : 'Apuração concluída!');
    await loadApuracaoMensal();
  } catch(e) {
    alert('Erro: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Apurar Agora'; }
  }
}

// Disparar manualmente e-mail de alertas de reajuste
async function alertarReajustes() {
  if (!confirm('Enviar e-mail de alertas de reajuste agora?')) return;
  try {
    const r = await api('/notificacoes/alertar-reajustes', { method:'POST', body: JSON.stringify({}) });
    alert(r && r.message ? r.message : 'E-mail enviado!');
  } catch(e) {
    alert('Erro: ' + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// GESTÃO DE SUBCONTRATADOS
// ═══════════════════════════════════════════════════════════════
async function loadSubcontratados() {
  const el = document.getElementById('subcontratados-body');
  const kpiEl = document.getElementById('subcontratados-kpis');
  if (!el) return;

  const p = window._globalPeriod || {};
  const qs = p.from ? `?from=${p.from}&to=${p.to}` : '';
  const d = await api('/relatorios/subcontratados' + qs);
  if (!d || !d.data) return;

  const brl = v => 'R$\u00a0' + (v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});

  if (kpiEl) {
    const top = d.data[0];
    kpiEl.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px">
        <div class="kpi" style="border-left:4px solid #7c3aed">
          <div class="kpi-l">🏢 Total Subcontratados</div>
          <div class="kpi-v" style="color:#7c3aed">${d.data.length}</div>
          <div class="kpi-s">fornecedores no período</div>
        </div>
        <div class="kpi" style="border-left:4px solid #dc2626">
          <div class="kpi-l">💸 Total Repassado</div>
          <div class="kpi-v" style="color:#dc2626">${brl(d.total_geral)}</div>
          <div class="kpi-s">pagamentos a terceiros</div>
        </div>
        <div class="kpi" style="border-left:4px solid #d97706">
          <div class="kpi-l">🏆 Maior Subcontratado</div>
          <div class="kpi-v" style="color:#d97706;font-size:13px">${top?.fornecedor?.substring(0,20)||'—'}</div>
          <div class="kpi-s">${brl(top?.total_pago||0)}</div>
        </div>
      </div>`;
  }

  el.innerHTML = d.data.map(s => `
    <tr>
      <td style="font-weight:600;font-size:12px">${s.fornecedor||'—'}</td>
      <td style="color:#64748b;font-size:10px">${s.cnpj_fornecedor||'—'}</td>
      <td style="text-align:center">${s.qtd_pagamentos}</td>
      <td style="text-align:center">${s.meses_ativos}m</td>
      <td style="text-align:right;font-weight:700;color:#dc2626">${brl(s.total_pago)}</td>
      <td style="text-align:center">${s.nfs_recebidas > 0
        ? `<span style="color:#059669;font-size:11px">✅ ${s.nfs_recebidas} NFs</span>`
        : `<span style="color:#dc2626;font-size:11px">⚠️ sem NF</span>`}</td>
      <td style="text-align:center">
        <div style="background:#e2e8f0;border-radius:4px;height:6px;width:60px;display:inline-block">
          <div style="background:${s.cobertura_nf>=80?'#059669':'#d97706'};height:6px;border-radius:4px;width:${Math.min(100,s.cobertura_nf)}%"></div>
        </div>
        <span style="font-size:10px;color:#64748b;margin-left:4px">${s.cobertura_nf}%</span>
      </td>
    </tr>`).join('');
}

// ═══════════════════════════════════════════════════════════════
// CONSOLIDADO MULTI-EMPRESA (tabela financeira detalhada)
// ═══════════════════════════════════════════════════════════════
async function loadConsolidadoResumo() {
  const el = document.getElementById('consolidado-resumo-body');
  const kpiEl = document.getElementById('consolidado-resumo-kpis');
  if (!el) return;

  const p = window._globalPeriod || {};
  const qs = p.from ? `?from=${p.from}&to=${p.to}` : '';
  const d = await api('/consolidado/resumo' + qs);
  if (!d || !d.empresas) return;

  const brl = v => 'R$\u00a0' + (v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const cor = v => v >= 0 ? '#059669' : '#dc2626';

  if (kpiEl) {
    const t = d.totais;
    kpiEl.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px">
        <div class="kpi" style="border-left:4px solid #3b82f6">
          <div class="kpi-l">🏢 Grupo — Receita Bruta</div>
          <div class="kpi-v" style="color:#3b82f6">${brl(t.receita_bruta)}</div>
          <div class="kpi-s">${t.qtd_nfs} NFs · ${t.contratos_ativos} contratos</div>
        </div>
        <div class="kpi" style="border-left:4px solid #dc2626">
          <div class="kpi-l">💸 Grupo — Despesas</div>
          <div class="kpi-v" style="color:#dc2626">${brl(t.despesas)}</div>
          <div class="kpi-s">todas as empresas</div>
        </div>
        <div class="kpi" style="border-left:4px solid ${cor(t.resultado)}">
          <div class="kpi-l">📊 Grupo — Resultado</div>
          <div class="kpi-v" style="color:${cor(t.resultado)}">${brl(t.resultado)}</div>
          <div class="kpi-s">receita líq. - despesas</div>
        </div>
      </div>`;
  }

  const icones = { assessoria:'🏢', seguranca:'🔒', portodovau:'🛡️', mustang:'🐎' };
  el.innerHTML = d.empresas.map(e => e.erro ? `
    <tr><td colspan="7" style="color:#dc2626;padding:8px">${icones[e.empresa]||'🏢'} ${e.nome}: ${e.erro}</td></tr>` : `
    <tr>
      <td style="font-weight:700">${icones[e.empresa]||'🏢'} ${e.nome}</td>
      <td style="text-align:right">${brl(e.receita_bruta)}</td>
      <td style="text-align:right;color:#dc2626">${brl(e.retencoes)}</td>
      <td style="text-align:right;color:#059669">${brl(e.receita_liquida)}</td>
      <td style="text-align:right;color:#dc2626">${brl(e.despesas)}</td>
      <td style="text-align:right;font-weight:700;color:${cor(e.resultado)}">${brl(e.resultado)}</td>
      <td style="text-align:center">
        <span style="background:${cor(e.margem_pct)}20;color:${cor(e.margem_pct)};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">${e.margem_pct}%</span>
      </td>
    </tr>`).join('') + `
    <tr style="background:#f1f5f9;font-weight:700;border-top:2px solid #e2e8f0">
      <td>TOTAL GRUPO</td>
      <td style="text-align:right">${brl(d.totais.receita_bruta)}</td>
      <td style="text-align:right;color:#dc2626">—</td>
      <td style="text-align:right;color:#059669">${brl(d.totais.receita_liquida)}</td>
      <td style="text-align:right;color:#dc2626">${brl(d.totais.despesas)}</td>
      <td style="text-align:right;font-weight:700;color:${cor(d.totais.resultado)}">${brl(d.totais.resultado)}</td>
      <td></td>
    </tr>`;
}

// ── Inadimplência por Contrato ───────────────────────────────
async function loadInadimplencia() {
  const el = document.getElementById('inadimplencia-kpis');
  const elBody = document.getElementById('inadimplencia-body');
  if (!el) return;
  el.innerHTML = '<div class="loading">Carregando…</div>';
  if (elBody) elBody.innerHTML = '';

  showLoading('Carregando inadimplência…');
  let data;
  try { data = await api('/relatorios/a-receber-por-contrato'); } finally { hideLoading(); }
  if (!data?.data) { el.innerHTML = '<p style="color:#dc2626">Erro ao carregar dados</p>'; return; }

  const r = data.resumo;
  el.innerHTML = `
    <div class="kpi-card" style="border-left:4px solid #3b82f6">
      <div class="kpi-v">${brl(r.total_a_receber)}</div>
      <div class="kpi-l">Total a Receber</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #dc2626">
      <div class="kpi-v" style="color:#dc2626">${brl(r.total_em_atraso)}</div>
      <div class="kpi-l">Em Atraso</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #f59e0b">
      <div class="kpi-v" style="color:#d97706">${brl(r.total_emitir_nf)}</div>
      <div class="kpi-l">Aguardando Emissão NF</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #22c55e">
      <div class="kpi-v" style="color:#15803d">${brl(r.total_pago)}</div>
      <div class="kpi-l">Total Pago</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #64748b">
      <div class="kpi-v">${r.qtd_com_pendencia}</div>
      <div class="kpi-l">Contratos c/ Pendência</div>
    </div>
  `;

  if (!elBody) return;
  const rows = data.data;
  elBody.innerHTML = rows.length === 0
    ? '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:20px;font-size:11px">Nenhum contrato com pendência</td></tr>'
    : rows.map((c, i) => {
        const temAtraso = c.em_atraso > 0;
        const bg = temAtraso ? '#fff5f5' : c.emitir_nf > 0 ? '#fffbeb' : '';
        const ultimoPgto = c.ultimo_pgto
          ? c.ultimo_pgto.slice(0, 10).split('-').reverse().join('/')
          : '—';
        return `<tr style="${bg ? 'background:' + bg : ''}">
          <td style="font-size:10px;color:#94a3b8">${i + 1}</td>
          <td><strong style="font-size:11px">${c.numContrato}</strong></td>
          <td style="font-size:10px">${c.contrato || c.orgao || '—'}</td>
          <td style="text-align:right;font-size:11px;font-weight:700;color:#1d4ed8">${brl(c.a_receber)}</td>
          <td style="text-align:right;font-size:11px;font-weight:700;color:${temAtraso ? '#dc2626' : '#94a3b8'}">${brl(c.em_atraso)}</td>
          <td style="text-align:right;font-size:11px;color:#d97706">${brl(c.emitir_nf)}</td>
          <td style="text-align:center;font-size:10px;color:#64748b">${ultimoPgto}</td>
        </tr>`;
      }).join('');
}

// ── Previsão de caixa por parcelas reais ────────────────────
async function loadFluxoParcelas() {
  const el = document.getElementById('fluxo-parcelas-body');
  if (!el) return;
  el.innerHTML = '<div class="loading">Carregando parcelas…</div>';
  const data = await api('/fluxo-parcelas');
  if (!data?.data) { el.innerHTML = '<div style="color:#94a3b8;font-size:11px;padding:10px">Sem parcelas cadastradas para os próximos 3 meses.</div>'; return; }

  const meses = data.data;
  const totalGeral = meses.reduce((s, m) => s + m.a_receber, 0);

  // Cards por mês
  const cards = meses.map(m => {
    const cor = m.saldo_estimado >= 0 ? '#15803d' : '#dc2626';
    const bgCor = m.saldo_estimado >= 0 ? '#dcfce7' : '#fee2e2';
    const detalhes = m.contratos.map(c => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid #f1f5f9">
        <div style="font-size:9px;color:#475569;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${c.orgao}">${c.contrato_num} — ${c.orgao || '—'}</div>
        <div style="font-size:10px;font-weight:700;color:#1d4ed8;margin-left:8px;white-space:nowrap">${brl(c.a_receber)}</div>
      </div>`).join('');

    return `<div style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;flex:1;min-width:220px">
      <div style="background:#f8fafc;padding:10px 14px;border-bottom:1px solid #e2e8f0">
        <div style="font-weight:800;font-size:13px;color:#1e293b">${m.mesLabel}</div>
        <div style="font-size:9px;color:#94a3b8">${m.qtd_parcelas} parcela(s) em aberto</div>
      </div>
      <div style="padding:10px 14px">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
          <span style="font-size:9px;color:#64748b">A receber</span>
          <span style="font-size:13px;font-weight:800;color:#15803d">${brl(m.a_receber)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:4px">
          <span style="font-size:9px;color:#64748b">Despesa média</span>
          <span style="font-size:12px;font-weight:700;color:#dc2626">- ${brl(m.despesa_media)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding-top:6px;border-top:1px solid #e2e8f0;margin-top:6px">
          <span style="font-size:9px;font-weight:700;color:#1e293b">Saldo estimado</span>
          <span style="font-size:13px;font-weight:800;color:${cor};background:${bgCor};padding:1px 8px;border-radius:10px">${brl(m.saldo_estimado)}</span>
        </div>
        ${m.contratos.length > 0 ? `<div style="margin-top:8px;border-top:1px solid #f1f5f9;padding-top:6px">${detalhes}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:8px 14px;margin-bottom:12px;display:flex;align-items:center;gap:10px">
      <span style="font-size:20px">💰</span>
      <div>
        <div style="font-size:11px;font-weight:700;color:#1d4ed8">Total a receber nos próximos 3 meses: ${brl(totalGeral)}</div>
        <div style="font-size:9px;color:#64748b">Baseado nas parcelas cadastradas — exclui parcelas com status ✅ PAGO</div>
      </div>
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap">${cards}</div>`;
}

// Nota: loadFluxoParcelas() é chamada diretamente por loadFluxoProjetado() em app.js

// ═══════════════════════════════════════════════════════════════
// MÓDULO RH / DEPARTAMENTO PESSOAL
// ═══════════════════════════════════════════════════════════════

let _rhFuncionarios = [];
let _rhSubTab = 'func';

async function loadRH() {
  await Promise.all([loadRHFuncionarios(), loadRHFolhas()]);
}

async function loadRHFuncionarios() {
  const data = await api('/rh/funcionarios');
  if (!Array.isArray(data)) return;
  _rhFuncionarios = data;

  // KPIs
  const ativos   = data.filter(f => f.status === 'ATIVO').length;
  const demitidos = data.filter(f => f.status === 'DEMITIDO').length;
  const totalSalarios = data.filter(f => f.status === 'ATIVO').reduce((s, f) => s + (f.salario_base || 0), 0);
  document.getElementById('rh-kpis').innerHTML = `
    <div class="kpi-card" style="border-left:4px solid #22c55e">
      <div class="kpi-v">${ativos}</div>
      <div class="kpi-l">Ativos</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #94a3b8">
      <div class="kpi-v">${demitidos}</div>
      <div class="kpi-l">Demitidos</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #3b82f6">
      <div class="kpi-v">${data.length}</div>
      <div class="kpi-l">Total Cadastrados</div>
    </div>
    <div class="kpi-card" style="border-left:4px solid #f59e0b">
      <div class="kpi-v">${brl(totalSalarios)}</div>
      <div class="kpi-l">Folha Bruta Estimada</div>
    </div>
  `;

  // Popula filtro de contratos
  const contratos = [...new Set(data.map(f => f.contrato_ref).filter(Boolean))].sort();
  const sel = document.getElementById('rh-filtro-contrato');
  if (sel) {
    sel.innerHTML = '<option value="">Todos os contratos</option>' +
      contratos.map(c => `<option value="${c}">${c}</option>`).join('');
  }

  filtrarFuncionarios();
}

function filtrarFuncionarios() {
  const busca    = (document.getElementById('rh-busca')?.value || '').toLowerCase();
  const status   = document.getElementById('rh-filtro-status')?.value || '';
  const contrato = document.getElementById('rh-filtro-contrato')?.value || '';

  let rows = _rhFuncionarios;
  if (busca)    rows = rows.filter(f => f.nome.toLowerCase().includes(busca));
  if (status)   rows = rows.filter(f => f.status === status);
  if (contrato) rows = rows.filter(f => f.contrato_ref === contrato);

  document.getElementById('rh-func-head').innerHTML = `<tr>
    <th>#</th><th>Nome</th><th>CPF</th><th>Cargo</th><th>Contrato / Lotação</th>
    <th style="text-align:right">Salário Base</th><th>Admissão</th>
    <th style="text-align:center">Status</th><th style="text-align:center">Ações</th>
  </tr>`;

  document.getElementById('rh-func-body').innerHTML = rows.map((f, i) => {
    const statusBg = f.status === 'ATIVO' ? '#dcfce7' : '#f1f5f9';
    const statusCor = f.status === 'ATIVO' ? '#15803d' : '#64748b';
    return `<tr>
      <td style="font-size:10px;color:#94a3b8">${i + 1}</td>
      <td><strong style="font-size:11px">${f.nome}</strong></td>
      <td style="font-size:10px;color:#64748b">${f.cpf || '—'}</td>
      <td style="font-size:10px">${f.cargo_nome || '—'}</td>
      <td style="font-size:10px">${f.contrato_ref || '—'}${f.lotacao ? '<br><span style="color:#94a3b8;font-size:9px">' + f.lotacao + '</span>' : ''}</td>
      <td style="text-align:right;font-weight:700">${brl(f.salario_base)}</td>
      <td style="font-size:10px">${f.data_admissao || '—'}</td>
      <td style="text-align:center">
        <span style="background:${statusBg};color:${statusCor};padding:2px 8px;border-radius:20px;font-size:9px;font-weight:700">${f.status}</span>
      </td>
      <td style="text-align:center;display:flex;gap:4px;justify-content:center;flex-wrap:wrap">
        <button onclick="demitirFuncionario(${f.id},'${f.nome.replace(/'/g, "\\'")}')"
          style="font-size:9px;padding:2px 7px;border:1px solid #fca5a5;border-radius:4px;background:#fef2f2;color:#dc2626;cursor:pointer"
          ${f.status !== 'ATIVO' ? 'disabled' : ''}>Demitir</button>
        ${f.status === 'ATIVO' ? `<button onclick="verPontoFuncionario(${f.id})" style="font-size:9px;padding:2px 7px;border:1px solid #5eead4;border-radius:4px;background:#ccfbf1;color:#0f766e;cursor:pointer">Ponto</button>` : ''}
        <button onclick="abrirHolerite(${f.id},'${f.nome.replace(/'/g, "\\'")}')" style="font-size:9px;padding:2px 7px;border:1px solid #93c5fd;border-radius:4px;background:#eff6ff;color:#1d4ed8;cursor:pointer">Holerite</button>
        <button onclick="abrirEntregaEPI(${f.id},'${f.nome.replace(/'/g, "\\'")}')" style="font-size:9px;padding:2px 7px;border:1px solid #fcd34d;border-radius:4px;background:#fffbeb;color:#d97706;cursor:pointer">EPI</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" style="text-align:center;color:#94a3b8;padding:20px;font-size:11px">Nenhum funcionário encontrado</td></tr>';
}

async function loadRHFolhas() {
  const data = await api('/rh/folha');
  if (!Array.isArray(data)) return;

  document.getElementById('rh-folha-body').innerHTML = data.map(f => {
    const statusBg = f.status === 'FECHADA' ? '#dcfce7' : '#fef3c7';
    const statusCor = f.status === 'FECHADA' ? '#15803d' : '#d97706';
    return `<tr>
      <td><strong style="font-size:11px">${f.competencia}</strong><br><span style="font-size:9px;background:${statusBg};color:${statusCor};padding:1px 6px;border-radius:10px">${f.status}</span></td>
      <td style="font-size:10px">${f.data_pagamento || '—'}</td>
      <td style="text-align:right;font-size:10px">${f.qtd_funcionarios || 0}</td>
      <td style="text-align:right;font-weight:600">${brl(f.total_bruto || 0)}</td>
      <td style="text-align:right;font-size:10px;color:#d97706">${brl(f.total_inss || 0)}</td>
      <td style="text-align:right;font-size:10px;color:#dc2626">${brl(f.total_irrf || 0)}</td>
      <td style="text-align:right;font-weight:700;color:#15803d">${brl(f.total_liquido || 0)}</td>
      <td style="text-align:center;display:flex;gap:4px;justify-content:center;flex-wrap:wrap">
        <button onclick="calcularFolha(${f.id})" style="font-size:9px;padding:2px 7px;border:1px solid #93c5fd;border-radius:4px;background:#eff6ff;color:#1d4ed8;cursor:pointer">🔢 Calcular</button>
        <button onclick="importarExcelFolha(${f.id})" style="font-size:9px;padding:2px 7px;border:1px solid #d8b4fe;border-radius:4px;background:#faf5ff;color:#7c3aed;cursor:pointer">📊 Excel</button>
        <button onclick="verItensFolha(${f.id},'${f.competencia}')" style="font-size:9px;padding:2px 7px;border:1px solid #e2e8f0;border-radius:4px;background:#f8fafc;color:#475569;cursor:pointer">👁 Ver</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:20px;font-size:11px">Nenhuma folha cadastrada</td></tr>';
}

function rhSubTab(tab) {
  _rhSubTab = tab;
  ['func','folha','calc'].forEach(t => {
    const btn   = document.getElementById('rh-tab-' + t);
    const panel = document.getElementById('rh-panel-' + t);
    const active = t === tab;
    if (btn)   { btn.style.color = active ? '#0891b2' : '#64748b'; btn.style.fontWeight = active ? '700' : '600'; btn.style.borderBottomColor = active ? '#0891b2' : 'transparent'; }
    if (panel) panel.style.display = active ? '' : 'none';
  });
}

function abrirModalNovoFunc() {
  ['nf-nome','nf-cpf','nf-admissao','nf-salario','nf-contrato','nf-lotacao','nf-email','nf-telefone','nf-pis','nf-banco','nf-obs']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('modal-novo-func').style.display = 'flex';
}
function fecharModalNovoFunc() { document.getElementById('modal-novo-func').style.display = 'none'; }

async function salvarNovoFunc() {
  const nome = document.getElementById('nf-nome')?.value?.trim();
  const data_admissao = document.getElementById('nf-admissao')?.value;
  const salario_base = parseFloat(document.getElementById('nf-salario')?.value) || 0;
  if (!nome || !data_admissao || !salario_base) return toast('Nome, data de admissão e salário são obrigatórios', 'error');

  const body = {
    nome, data_admissao, salario_base,
    cpf:         document.getElementById('nf-cpf')?.value || '',
    contrato_ref: document.getElementById('nf-contrato')?.value || '',
    lotacao:     document.getElementById('nf-lotacao')?.value || '',
    email:       document.getElementById('nf-email')?.value || '',
    telefone:    document.getElementById('nf-telefone')?.value || '',
    pis:         document.getElementById('nf-pis')?.value || '',
    obs:         document.getElementById('nf-obs')?.value || '',
  };
  // banco no campo banco como texto livre por ora
  const bancoStr = document.getElementById('nf-banco')?.value || '';
  if (bancoStr) body.obs = (body.obs ? body.obs + ' | ' : '') + 'Banco: ' + bancoStr;

  showLoading('Salvando funcionário…');
  try {
    const r = await api('/rh/funcionarios', { method: 'POST', body: JSON.stringify(body) });
    if (r.ok) { toast('Funcionário cadastrado!'); fecharModalNovoFunc(); await loadRHFuncionarios(); }
    else toast(r.erro || 'Erro ao salvar', 'error');
  } finally { hideLoading(); }
}

async function demitirFuncionario(id, nome) {
  if (!confirm(`Confirmar demissão de ${nome}?`)) return;
  showLoading('Registrando demissão…');
  try {
    const r = await api('/rh/funcionarios/' + id, { method: 'DELETE' });
    if (r.ok) { toast(nome + ' demitido(a)'); await loadRHFuncionarios(); }
    else toast(r.erro || 'Erro', 'error');
  } finally { hideLoading(); }
}

function abrirModalNovaFolha() {
  const hoje = new Date();
  document.getElementById('folha-comp').value = hoje.getFullYear() + '-' + String(hoje.getMonth() + 1).padStart(2, '0');
  document.getElementById('folha-pgto').value = '';
  document.getElementById('folha-obs').value  = '';
  document.getElementById('modal-nova-folha').style.display = 'flex';
}
function fecharModalNovaFolha() { document.getElementById('modal-nova-folha').style.display = 'none'; }

async function salvarNovaFolha() {
  const competencia = document.getElementById('folha-comp')?.value;
  if (!competencia) return toast('Competência obrigatória', 'error');
  const body = {
    competencia,
    data_pagamento: document.getElementById('folha-pgto')?.value || '',
    obs: document.getElementById('folha-obs')?.value || '',
  };
  showLoading('Criando folha…');
  try {
    const r = await api('/rh/folha', { method: 'POST', body: JSON.stringify(body) });
    if (r.ok) {
      fecharModalNovaFolha();
      toast('Folha criada! Calculando…');
      await calcularFolha(r.id);
      await loadRHFolhas();
      rhSubTab('folha');
    } else toast(r.erro || 'Erro ao criar folha', 'error');
  } finally { hideLoading(); }
}

async function calcularFolha(folhaId) {
  showLoading('Calculando folha…');
  try {
    const r = await api('/rh/folha/' + folhaId + '/calcular', { method: 'POST', body: '{}' });
    if (r.qtd !== undefined) toast(`Folha calculada: ${r.qtd} funcionário(s) — Total líquido: ${brl(r.total_liquido)}`);
    else toast(r.erro || 'Erro ao calcular', 'error');
    await loadRHFolhas();
  } finally { hideLoading(); }
}

async function verItensFolha(folhaId, competencia) {
  showLoading('Carregando itens…');
  try {
    const data = await api('/rh/folha/' + folhaId + '/itens');
    const rows = Array.isArray(data) ? data : (data?.data || []);
    if (!rows.length) return toast('Folha sem itens — calcule primeiro', 'error');
    const totalBruto = rows.reduce((s, r) => s + r.total_bruto, 0);
    const totalLiq   = rows.reduce((s, r) => s + r.total_liquido, 0);
    const totalINSS  = rows.reduce((s, r) => s + r.inss, 0);
    const totalIRRF  = rows.reduce((s, r) => s + r.irrf, 0);

    const html = `<div style="max-height:70vh;overflow-y:auto">
      <div style="font-weight:800;font-size:14px;color:#1e293b;margin-bottom:12px">📋 Folha ${competencia}</div>
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <thead><tr style="background:#f1f5f9;font-size:9px;color:#64748b;font-weight:700;text-transform:uppercase">
          <th style="padding:6px 10px;text-align:left">Funcionário</th>
          <th style="padding:6px 10px;text-align:right">Bruto</th>
          <th style="padding:6px 10px;text-align:right">INSS</th>
          <th style="padding:6px 10px;text-align:right">IRRF</th>
          <th style="padding:6px 10px;text-align:right">Líquido</th>
          <th style="padding:6px 10px;text-align:center">Holerite</th>
        </tr></thead>
        <tbody>${rows.map((r, i) => `<tr style="background:${i%2?'#f8fafc':'#fff'};border-bottom:1px solid #f1f5f9">
          <td style="padding:5px 10px;font-weight:600">${r.funcionario_nome || r.funcionario_id}</td>
          <td style="padding:5px 10px;text-align:right">${brl(r.total_bruto)}</td>
          <td style="padding:5px 10px;text-align:right;color:#d97706">${brl(r.inss)}</td>
          <td style="padding:5px 10px;text-align:right;color:#dc2626">${brl(r.irrf)}</td>
          <td style="padding:5px 10px;text-align:right;font-weight:700;color:#15803d">${brl(r.total_liquido)}</td>
          <td style="padding:5px 10px;text-align:center">
            <button onclick="gerarHolerite(${folhaId},${r.funcionario_id})" style="font-size:9px;padding:2px 7px;border:1px solid #fca5a5;border-radius:4px;background:#fef2f2;color:#dc2626;cursor:pointer">📄 PDF</button>
          </td>
        </tr>`).join('')}</tbody>
        <tfoot><tr style="background:#f1f5f9;font-weight:700">
          <td style="padding:6px 10px;font-size:10px">TOTAL</td>
          <td style="padding:6px 10px;text-align:right">${brl(totalBruto)}</td>
          <td style="padding:6px 10px;text-align:right;color:#d97706">${brl(totalINSS)}</td>
          <td style="padding:6px 10px;text-align:right;color:#dc2626">${brl(totalIRRF)}</td>
          <td style="padding:6px 10px;text-align:right;color:#15803d">${brl(totalLiq)}</td>
          <td></td>
        </tr></tfoot>
      </table>
    </div>`;

    // Reutiliza modal genérico ou cria um temporário
    const mod = document.createElement('div');
    mod.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center';
    mod.innerHTML = `<div style="background:#fff;border-radius:12px;padding:24px;width:700px;max-width:95vw;max-height:90vh;overflow-y:auto">
      ${html}
      <div style="margin-top:16px;text-align:right">
        <button onclick="this.closest('div[style*=fixed]').remove()" style="padding:7px 18px;border:1px solid #e2e8f0;border-radius:6px;font-size:11px;cursor:pointer">Fechar</button>
      </div>
    </div>`;
    document.body.appendChild(mod);
  } finally { hideLoading(); }
}

function importarExcelFolha(folhaId) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.xlsx,.xls';
  inp.onchange = async () => {
    if (!inp.files.length) return;
    const form = new FormData();
    form.append('file', inp.files[0]);
    showLoading('Importando Excel…');
    try {
      const token = localStorage.getItem('montana_jwt');
      const r = await fetch(`/api/rh/folha/${folhaId}/importar-excel?company=${currentCompany}`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        body: form,
      }).then(x => x.json());
      if (r.ok) { toast(`Importado: ${r.atualizados} funcionário(s)`); await loadRHFolhas(); }
      else toast(r.erro || 'Erro ao importar', 'error');
    } finally { hideLoading(); }
  };
  inp.click();
}

async function calcularTributos() {
  const salario = parseFloat(document.getElementById('calc-salario')?.value) || 0;
  const dep     = parseInt(document.getElementById('calc-dep')?.value) || 0;
  if (!salario) return toast('Informe o salário', 'error');

  const r = await api(`/rh/calcular-tributos?salario=${salario}&dependentes=${dep}`);
  if (!r || r.error) return toast('Erro ao calcular', 'error');

  document.getElementById('calc-result').innerHTML = `
    <div style="margin-top:14px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
      <div style="background:#f8fafc;padding:10px 14px;font-weight:700;font-size:11px;color:#1e293b;border-bottom:1px solid #e2e8f0">
        Resultado — Salário: ${brl(salario)} | ${dep} dependente(s)
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <tr style="border-bottom:1px solid #f1f5f9"><td style="padding:7px 14px;color:#475569">Salário Bruto</td><td style="padding:7px 14px;text-align:right;font-weight:600">${brl(r.salario_bruto)}</td></tr>
        <tr style="border-bottom:1px solid #f1f5f9;background:#fef3c7"><td style="padding:7px 14px;color:#d97706">(-) INSS (Progressivo 2026)</td><td style="padding:7px 14px;text-align:right;font-weight:700;color:#d97706">- ${brl(r.inss)}</td></tr>
        <tr style="border-bottom:1px solid #f1f5f9;background:#fee2e2"><td style="padding:7px 14px;color:#dc2626">(-) IRRF</td><td style="padding:7px 14px;text-align:right;font-weight:700;color:#dc2626">- ${brl(r.irrf)}</td></tr>
        <tr style="border-bottom:1px solid #f1f5f9"><td style="padding:7px 14px;color:#64748b">Base de cálculo IRRF</td><td style="padding:7px 14px;text-align:right;color:#64748b">${brl(r.base_irrf)}</td></tr>
        <tr style="border-bottom:1px solid #f1f5f9"><td style="padding:7px 14px;color:#64748b">Total Descontos</td><td style="padding:7px 14px;text-align:right;color:#64748b">- ${brl(r.total_descontos)}</td></tr>
        <tr style="background:#dcfce7"><td style="padding:10px 14px;font-weight:700;color:#15803d;font-size:13px">💰 Salário Líquido</td><td style="padding:10px 14px;text-align:right;font-weight:800;color:#15803d;font-size:15px">${brl(r.salario_liquido)}</td></tr>
      </table>
      <div style="padding:8px 14px;font-size:9px;color:#94a3b8">Faixa IRRF: ${r.faixa_irrf || '—'} · Alíquota efetiva INSS: ${r.aliq_efetiva_inss || '—'}%</div>
    </div>`;
}

// ── Alerta de créditos sem NF no dashboard ──────────────────
// Injetado no loadDashboard (hook pós-carregamento)
const _origLoadDashboard = typeof loadDashboard !== 'undefined' ? loadDashboard : null;
if (_origLoadDashboard) {
  loadDashboard = async function() {
    await _origLoadDashboard();
    try {
      // Filtra pelo período global atual e conta apenas créditos (entradas) pendentes
      const qs = new URLSearchParams({ status: 'PENDENTE', somente_creditos: '1', limit: '1' });
      if (typeof _from !== 'undefined' && _from) qs.set('from', _from);
      if (typeof _to   !== 'undefined' && _to)   qs.set('to',   _to);
      const d = await api('/extratos?' + qs.toString());
      const alertEl = document.getElementById('dash-alerta-sem-nf');
      const textoEl = document.getElementById('dash-alerta-sem-nf-texto');
      if (alertEl && textoEl && d.total > 0) {
        const periodo = (typeof _from !== 'undefined' && _from) ? ` no período selecionado` : '';
        textoEl.textContent = `${d.total} crédito(s) PENDENTE${periodo} sem NF correspondente — conciliação necessária`;
        alertEl.style.display = 'flex';
      } else if (alertEl) {
        alertEl.style.display = 'none';
      }
    } catch(_) {}
  };
}

// ═══════════════════════════════════════════════════════════════
// LOG DE AUDITORIA
// ═══════════════════════════════════════════════════════════════

let _auditPage = 1;
const AUDIT_LIMIT = 50;

async function loadAuditoria() {
  const tabela  = document.getElementById('audit-tabela')?.value  || '';
  const usuario = document.getElementById('audit-usuario')?.value || '';
  const from    = document.getElementById('audit-from')?.value    || '';
  const to      = document.getElementById('audit-to')?.value      || '';
  const offset  = (_auditPage - 1) * AUDIT_LIMIT;
  let url = `/audit?limit=${AUDIT_LIMIT}&offset=${offset}`;
  if (tabela)  url += '&tabela='  + encodeURIComponent(tabela);
  if (usuario) url += '&usuario=' + encodeURIComponent(usuario);
  if (from)    url += '&from='    + from;
  if (to)      url += '&to='      + to;

  showLoading('Carregando auditoria…');
  let data;
  try { data = await api(url); } finally { hideLoading(); }
  if (!data?.data) return;

  const rows = data.data, total = data.total, pages = Math.ceil(total / AUDIT_LIMIT);

  const acoes = {};
  rows.forEach(r => { acoes[r.acao] = (acoes[r.acao] || 0) + 1; });
  document.getElementById('audit-kpis').innerHTML = `
    <div class="kpi-card"><div class="kpi-v">${total}</div><div class="kpi-l">Registros Totais</div></div>
    ${Object.entries(acoes).slice(0, 5).map(([a, n]) => `<div class="kpi-card"><div class="kpi-v">${n}</div><div class="kpi-l">${a}</div></div>`).join('')}`;

  const ACAO_COR = { DELETE:'#dc2626', IMPORT:'#0369a1', UPDATE:'#d97706', UPDATE_LOTE:'#d97706', INSERT:'#15803d' };
  const ACAO_BG  = { DELETE:'#fee2e2', IMPORT:'#eff6ff', UPDATE:'#fef3c7', UPDATE_LOTE:'#fef3c7', INSERT:'#dcfce7' };

  document.getElementById('audit-head').innerHTML = `<tr>
    <th>#</th><th>Data/Hora</th><th>Usuário</th><th>Ação</th>
    <th>Tabela</th><th>Registro</th><th style="min-width:200px">Detalhe</th><th>IP</th></tr>`;

  document.getElementById('audit-body').innerHTML = rows.map((r, i) => {
    const cor = ACAO_COR[r.acao] || '#475569';
    const bg  = ACAO_BG[r.acao]  || '#f8fafc';
    return `<tr>
      <td style="font-size:9px;color:#94a3b8">${offset + i + 1}</td>
      <td style="font-size:10px;white-space:nowrap">${(r.created_at || '').replace('T',' ').slice(0,19)}</td>
      <td style="font-size:10px;font-weight:600">${r.usuario}</td>
      <td><span style="background:${bg};color:${cor};padding:2px 7px;border-radius:20px;font-size:9px;font-weight:700">${r.acao}</span></td>
      <td style="font-size:10px;color:#475569">${r.tabela}</td>
      <td style="font-size:10px;color:#64748b">${r.registro_id || '—'}</td>
      <td style="font-size:10px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.detalhe || ''}">${r.detalhe || '—'}</td>
      <td style="font-size:9px;color:#94a3b8">${r.ip || '—'}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:20px;font-size:11px">Nenhum registro ainda</td></tr>';

  document.getElementById('audit-pag').innerHTML = `
    <button ${_auditPage<=1?'disabled':''} onclick="_auditPage--;loadAuditoria()">← Anterior</button>
    <span>Página ${_auditPage} de ${pages||1} (${total} registros)</span>
    <button ${_auditPage>=pages?'disabled':''} onclick="_auditPage++;loadAuditoria()">Próxima →</button>`;
}

// ═══════════════════════════════════════════════════════════════
// BUSCA GLOBAL
// ═══════════════════════════════════════════════════════════════

async function executarBuscaGlobal() {
  const q   = document.getElementById('busca-global-input')?.value?.trim() || '';
  const res = document.getElementById('busca-global-result');
  if (!res) return;
  if (q.length < 2) { res.style.display = 'none'; return; }

  res.style.display = 'block';
  res.innerHTML = '<div style="padding:12px;text-align:center;color:#94a3b8;font-size:11px">🔍 Buscando…</div>';

  const data = await api('/busca?q=' + encodeURIComponent(q));
  if (!data?.data?.length) {
    res.innerHTML = '<div style="padding:16px;text-align:center;color:#94a3b8;font-size:11px">Nenhum resultado para <strong>' + q + '</strong></div>';
    return;
  }

  const ICONE = { contrato:'📋', nf:'🧾', extrato:'🏦', despesa:'💸' };
  const LABEL = { contrato:'Contrato', nf:'Nota Fiscal', extrato:'Extrato', despesa:'Despesa' };
  const COR   = { contrato:'#1d4ed8', nf:'#7c3aed', extrato:'#0369a1', despesa:'#dc2626' };
  const TAB   = { contrato:'cont', nf:'nfs', extrato:'ext', despesa:'desp' };

  const grupos = {};
  data.data.forEach(r => { if (!grupos[r.tipo]) grupos[r.tipo] = []; grupos[r.tipo].push(r); });

  res.innerHTML = `
    <div style="padding:8px 12px 4px;font-size:9px;color:#94a3b8;font-weight:700;text-transform:uppercase;border-bottom:1px solid #f1f5f9">
      ${data.data.length} resultado${data.data.length > 1 ? 's' : ''} para "${q}"
    </div>
    ${Object.entries(grupos).map(([tipo, itens]) => `
      <div style="padding:6px 12px 2px;font-size:9px;font-weight:700;color:${COR[tipo]||'#475569'};text-transform:uppercase;background:#f8fafc">
        ${ICONE[tipo]||'•'} ${LABEL[tipo]||tipo} (${itens.length})
      </div>
      ${itens.map(item => `
        <div onclick="irParaResultado('${tipo}')" style="padding:8px 14px;cursor:pointer;border-bottom:1px solid #f8fafc;display:flex;align-items:center;gap:10px"
          onmouseover="this.style.background='#f0f9ff'" onmouseout="this.style.background=''">
          <div style="flex:1;overflow:hidden">
            <div style="font-size:11px;font-weight:600;color:#1e293b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${item.codigo||''} ${item.descricao ? '— ' + String(item.descricao).substring(0,50) : ''}</div>
            <div style="font-size:9px;color:#94a3b8;margin-top:1px">${item.data||''} ${item.extra ? '· ' + item.extra : ''}</div>
          </div>
          ${item.valor > 0 ? `<div style="font-size:11px;font-weight:700;color:#15803d;white-space:nowrap">${brl(item.valor)}</div>` : ''}
        </div>`).join('')}
    `).join('')}
    <div style="padding:8px 12px;text-align:center">
      <button onclick="fecharBuscaGlobal()" style="font-size:10px;color:#94a3b8;background:none;border:none;cursor:pointer">Fechar</button>
    </div>`;
}

function irParaResultado(tipo) {
  const TAB = { contrato:'cont', nf:'nfs', extrato:'ext', despesa:'desp' };
  fecharBuscaGlobal();
  const tab = TAB[tipo];
  if (tab) { const el = document.querySelector(`.tab[data-tab="${tab}"]`); if (el) { showTab(tab, el); el.scrollIntoView({block:'nearest'}); } }
}

function fecharBuscaGlobal() {
  const inp = document.getElementById('busca-global-input');
  const res = document.getElementById('busca-global-result');
  if (inp) inp.value = '';
  if (res) res.style.display = 'none';
}

document.addEventListener('click', e => {
  const wrap = document.getElementById('busca-global-result');
  const inp  = document.getElementById('busca-global-input');
  if (wrap && !wrap.contains(e.target) && e.target !== inp) wrap.style.display = 'none';
});

// ═══════════════════════════════════════════════════════════════
// Portal Transparência Palmas — integração e conciliação
// ═══════════════════════════════════════════════════════════════

let transpDados = [];

function initTranspDatas() {
  const ini = document.getElementById('transp-dt-ini');
  const fim = document.getElementById('transp-dt-fim');
  if (ini && !ini.value) {
    const d = new Date(); d.setFullYear(d.getFullYear() - 1);
    ini.value = d.toISOString().split('T')[0];
  }
  if (fim && !fim.value) fim.value = new Date().toISOString().split('T')[0];
}

async function transpDescobrir() {
  const badge = document.getElementById('transp-status-badge');
  const msg   = document.getElementById('transp-msg');
  badge.textContent = 'Detectando...';
  badge.style.background = '#fef3c7'; badge.style.color = '#92400e';
  msg.textContent = 'Testando endpoints do portal...';
  try {
    const r = await apiPost('/api/transparencia/descobrir', {});
    if (r.ok) {
      badge.textContent = 'Conectado';
      badge.style.background = '#dcfce7'; badge.style.color = '#15803d';
      msg.textContent = 'Endpoint encontrado: ' + r.endpointEncontrado.url;
      document.getElementById('transp-aviso-config').style.display = 'none';
    } else {
      badge.textContent = 'Manual';
      badge.style.background = '#fef3c7'; badge.style.color = '#92400e';
      msg.textContent = 'API nao detectada automaticamente.';
      document.getElementById('transp-aviso-config').style.display = 'block';
    }
  } catch(e) {
    badge.textContent = 'Erro';
    badge.style.background = '#fee2e2'; badge.style.color = '#dc2626';
    msg.textContent = 'Erro: ' + e.message;
  }
}

async function transpConfigurarManual() {
  const url = document.getElementById('transp-url-manual').value.trim();
  if (!url) { alert('Cole a URL capturada do DevTools'); return; }
  try {
    const r = await apiPost('/api/transparencia/configurar', { url, method: 'POST' });
    if (r.ok) {
      const badge = document.getElementById('transp-status-badge');
      badge.textContent = 'Manual OK'; badge.style.background = '#dcfce7'; badge.style.color = '#15803d';
      document.getElementById('transp-aviso-config').style.display = 'none';
      document.getElementById('transp-msg').textContent = 'Endpoint configurado: ' + url;
    }
  } catch(e) { alert('Erro: ' + e.message); }
}

async function transpConsultar() {
  initTranspDatas();
  const msg  = document.getElementById('transp-msg');
  const wrap = document.getElementById('transp-table-wrap');
  msg.textContent = 'Consultando portal...';
  wrap.style.display = 'none';
  const ini  = document.getElementById('transp-dt-ini').value;
  const fim  = document.getElementById('transp-dt-fim').value;
  const cnpj = window.currentCompany === 'seguranca' ? '19200109000109' :
               window.currentCompany === 'assessoria' ? '14092519000151' : '';
  try {
    const params = new URLSearchParams({ dataInicial: ini, dataFinal: fim, cnpj });
    const r = await apiGet('/api/transparencia/consultar?' + params);
    if (!r.ok) {
      msg.textContent = (r.erro || 'Endpoint nao configurado. Use Auto-Detectar primeiro.');
      document.getElementById('transp-aviso-config').style.display = 'block';
      return;
    }
    transpDados = r.pagamentos || [];
    renderTranspTabela(transpDados);
    carregarTranspResumo();
    msg.textContent = r.total + ' pagamento(s) encontrado(s) no portal.';
  } catch(e) {
    msg.textContent = 'Erro: ' + e.message;
    document.getElementById('transp-aviso-config').style.display = 'block';
  }
}

async function transpImportar() {
  const ini = document.getElementById('transp-dt-ini').value;
  const fim = document.getElementById('transp-dt-fim').value;
  const msg = document.getElementById('transp-msg');
  msg.textContent = 'Importando...';
  const cnpj = window.currentCompany === 'seguranca' ? '19200109000109' :
               window.currentCompany === 'assessoria' ? '14092519000151' : '';
  const fmtData = v => v ? v.split('-').reverse().join('/') : '';
  try {
    const r = await apiPost('/api/transparencia/importar', {
      cnpj,
      dataInicial: fmtData(ini) || '01/01/2023',
      dataFinal:   fmtData(fim) || new Date().toLocaleDateString('pt-BR'),
    });
    if (r.ok) {
      msg.textContent = 'Importados: ' + r.importados + ' | Duplicados: ' + r.duplicados;
      carregarTranspResumo();
    } else {
      msg.textContent = (r.erro || 'Erro ao importar');
    }
  } catch(e) { msg.textContent = 'Erro: ' + e.message; }
}

async function transpConciliar() {
  const msg = document.getElementById('transp-msg');
  msg.textContent = 'Conciliando pagamentos com extratos...';
  try {
    const r = await apiGet('/api/transparencia/conciliar');
    if (r.ok) {
      msg.textContent = 'Conciliados: ' + r.conciliados + ' | Pendentes: ' + r.pendentes;
      carregarTranspResumo();
    } else {
      msg.textContent = (r.erro || 'Erro ao conciliar');
    }
  } catch(e) { msg.textContent = 'Erro: ' + e.message; }
}

async function carregarTranspResumo() {
  try {
    const r = await apiGet('/api/transparencia/resumo');
    if (!r.ok) return;
    const kpis    = document.getElementById('transp-kpis');
    const total   = r.porStatus.reduce((s,x) => s + Number(x.total||0), 0);
    const concil  = r.porStatus.find(x => x.status_conciliacao === 'CONCILIADO');
    const pend    = r.porStatus.find(x => x.status_conciliacao === 'PENDENTE');
    const pct     = total > 0 ? Math.round((Number(concil?.total||0)/total)*100) : 0;
    kpis.innerHTML =
      kpiBox('Total no Portal', brl(total), r.porStatus.reduce((s,x)=>s+x.qtd,0) + ' pagamentos', '#1e293b', '#fff') +
      kpiBox('Conciliados', brl(concil?.total||0), (concil?.qtd||0) + ' (' + pct + '%)', '#dcfce7', '#15803d') +
      kpiBox('Pendentes', brl(pend?.total||0), (pend?.qtd||0) + ' pagamentos', '#fffbeb', '#d97706') +
      kpiBox('API', r.endpointAtivo ? 'Ativa' : 'Nao config.', r.endpointAtivo ? r.endpointAtivo.url.split('/').pop() : 'Use Auto-Detectar', r.endpointAtivo ? '#f0fdf4' : '#fef3c7', r.endpointAtivo ? '#15803d' : '#d97706');
  } catch(_) {}
}

function kpiBox(label, valor, sub, bg, cor) {
  return '<div style="flex:1;min-width:140px;border:1px solid #e2e8f0;border-radius:8px;padding:12px;text-align:center;background:' + bg + '">' +
    '<div style="font-size:10px;color:#64748b">' + label + '</div>' +
    '<div style="font-size:15px;font-weight:800;color:' + cor + ';margin:4px 0">' + valor + '</div>' +
    '<div style="font-size:10px;color:#94a3b8">' + sub + '</div></div>';
}

function renderTranspTabela(dados) {
  const wrap = document.getElementById('transp-table-wrap');
  const head = document.getElementById('transp-head');
  const body = document.getElementById('transp-body');
  if (!dados || !dados.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  head.innerHTML = '<tr style="background:#1e40af;color:#fff">' +
    '<th style="padding:6px 10px;text-align:left;font-size:10px">Data Pgto</th>' +
    '<th style="padding:6px 10px;text-align:left;font-size:10px">Empenho</th>' +
    '<th style="padding:6px 10px;text-align:left;font-size:10px">Fornecedor</th>' +
    '<th style="padding:6px 10px;text-align:left;font-size:10px">Elemento</th>' +
    '<th style="padding:6px 10px;text-align:right;font-size:10px">Valor Pago</th>' +
    '<th style="padding:6px 10px;text-align:center;font-size:10px">Status</th></tr>';
  body.innerHTML = dados.map(function(p) {
    var cor   = p.status_conciliacao === 'CONCILIADO' ? '#f0fdf4' : '#fffbeb';
    var badge = p.status_conciliacao === 'CONCILIADO'
      ? '<span style="background:#dcfce7;color:#15803d;padding:2px 7px;border-radius:10px;font-size:9px;font-weight:700">Conciliado</span>'
      : '<span style="background:#fef3c7;color:#d97706;padding:2px 7px;border-radius:10px;font-size:9px;font-weight:700">Pendente</span>';
    return '<tr style="background:' + cor + ';border-bottom:1px solid #f1f5f9">' +
      '<td style="padding:5px 10px;font-size:10px">' + (p.data_pagamento||'—') + '</td>' +
      '<td style="padding:5px 10px;font-size:10px">' + (p.numero_empenho||'—') + '</td>' +
      '<td style="padding:5px 10px;font-size:10px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (p.fornecedor||'—') + '</td>' +
      '<td style="padding:5px 10px;font-size:10px">' + (p.elemento_despesa||'—') + '</td>' +
      '<td style="padding:5px 10px;font-size:10px;text-align:right;font-weight:700">' + brl(p.valor_pago) + '</td>' +
      '<td style="padding:5px 10px;text-align:center">' + badge + '</td></tr>';
  }).join('');
}

// Sobrescreve showPrefSub para inicializar a aba Transparência
const _origShowPrefSub = window.showPrefSub;
window.showPrefSub = function(stab, el) {
  document.querySelectorAll('.pref-sub').forEach(function(d) { d.style.display='none'; d.classList.remove('active'); });
  document.querySelectorAll('.pref-stab').forEach(function(d) { d.classList.remove('active'); d.style.borderBottomColor='transparent'; d.style.color='#64748b'; });
  var sec = document.getElementById('pref-sub-' + stab);
  if (sec) { sec.style.display='block'; sec.classList.add('active'); }
  if (el)  { el.classList.add('active'); el.style.borderBottomColor='#1e293b'; el.style.color='#1e293b'; }
  if (stab === 'transp') { initTranspDatas(); carregarTranspResumo(); }
};

// ─── Gestão de Usuários (Config) ─────────────────────────────────
async function criarUsuariosFuncionarios() {
  if (!confirm('Criar logins automáticos para todos os funcionários ativos?\nSenha inicial: Montana@2026')) return;
  showLoading('Gerando logins…');
  try {
    const r = await api('/usuarios/criar-funcionarios', { method: 'POST' });
    if (r.criados !== undefined) {
      toast(`✅ ${r.criados} criados · ${r.existentes} já existiam`, 'success');
      loadUsuariosConfig();
    } else {
      toast(r.error || 'Erro ao criar', 'error');
    }
  } catch(e) {
    toast('Erro: ' + e.message, 'error');
  } finally { hideLoading(); }
}

async function criarUsuarioManual() {
  const nome    = document.getElementById('cfg-novo-nome')?.value?.trim();
  const login   = document.getElementById('cfg-novo-login')?.value?.trim();
  const role    = document.getElementById('cfg-novo-role')?.value;
  const lotacao = document.getElementById('cfg-novo-lotacao')?.value?.trim() || '';
  if (!nome || !login) return toast('Preencha nome e login', 'error');
  showLoading('Criando usuário…');
  try {
    const r = await api('/usuarios', {
      method: 'POST',
      body: JSON.stringify({ usuario: login, nome, senha: 'Montana@2026', role, lotacao })
    });
    if (r.id || r.ok) {
      toast(`✅ Usuário "${login}" criado — senha: Montana@2026`, 'success');
      document.getElementById('cfg-novo-nome').value = '';
      document.getElementById('cfg-novo-login').value = '';
      if(document.getElementById('cfg-novo-lotacao')) document.getElementById('cfg-novo-lotacao').value = '';
      loadUsuariosConfig();
    } else {
      toast(r.error || 'Erro ao criar', 'error');
    }
  } catch(e) { toast('Erro: ' + e.message, 'error'); }
  finally { hideLoading(); }
}

async function loadUsuariosConfig() {
  const el = document.getElementById('cfg-usuarios-lista');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:10px;color:#94a3b8;font-size:11px">Carregando…</div>';
  try {
    const dados = await api('/usuarios');
    const lista = Array.isArray(dados) ? dados : (dados.usuarios || []);
    if (!lista.length) { el.innerHTML = '<div style="padding:12px;color:#94a3b8;font-size:11px;text-align:center">Nenhum usuário cadastrado</div>'; return; }
    const ROLE_BADGE = {
      admin:       '<span style="background:#fee2e2;color:#dc2626;padding:1px 7px;border-radius:8px;font-size:9px;font-weight:700">Admin</span>',
      financeiro:  '<span style="background:#dbeafe;color:#1d4ed8;padding:1px 7px;border-radius:8px;font-size:9px;font-weight:700">Financeiro</span>',
      operacional: '<span style="background:#f0fdf4;color:#15803d;padding:1px 7px;border-radius:8px;font-size:9px;font-weight:700">Operacional</span>',
      visualizador:'<span style="background:#f1f5f9;color:#475569;padding:1px 7px;border-radius:8px;font-size:9px;font-weight:700">Visualizador</span>',
      rh:          '<span style="background:#f0fdf4;color:#0f766e;padding:1px 7px;border-radius:8px;font-size:9px;font-weight:700">RH/Ponto</span>',
    };
    el.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <thead><tr style="background:#f8fafc">
          <th style="padding:7px 10px;text-align:left;color:#64748b;font-size:9px;text-transform:uppercase;border-bottom:1px solid #e2e8f0">Nome</th>
          <th style="padding:7px 10px;text-align:left;color:#64748b;font-size:9px;text-transform:uppercase;border-bottom:1px solid #e2e8f0">Login</th>
          <th style="padding:7px 10px;text-align:center;color:#64748b;font-size:9px;text-transform:uppercase;border-bottom:1px solid #e2e8f0">Perfil</th>
          <th style="padding:7px 10px;text-align:center;color:#64748b;font-size:9px;text-transform:uppercase;border-bottom:1px solid #e2e8f0">Status</th>
          <th style="padding:7px 10px;text-align:center;color:#64748b;font-size:9px;text-transform:uppercase;border-bottom:1px solid #e2e8f0">Ações</th>
        </tr></thead>
        <tbody>${lista.map(u => `
          <tr style="border-bottom:1px solid #f1f5f9">
            <td style="padding:6px 10px">${u.nome}</td>
            <td style="padding:6px 10px;font-family:monospace;font-size:10px;color:#1d4ed8">${u.login}</td>
            <td style="padding:6px 10px;text-align:center">${ROLE_BADGE[u.role] || u.role}</td>
            <td style="padding:6px 10px;text-align:center">${u.ativo ? '<span style="color:#15803d;font-weight:700">●</span> Ativo' : '<span style="color:#94a3b8">○</span> Inativo'}</td>
            <td style="padding:6px 10px;text-align:center;display:flex;gap:6px;justify-content:center">
              <button onclick="resetarSenhaUsuario(${u.id},'${u.login}')" style="padding:2px 8px;font-size:9px;border:1px solid #e2e8f0;border-radius:5px;background:#f8fafc;color:#64748b;cursor:pointer" title="Resetar senha">🔑 Senha</button>
              <button onclick="toggleAtivoUsuario(${u.id},${u.ativo?1:0})" style="padding:2px 8px;font-size:9px;border:1px solid #e2e8f0;border-radius:5px;background:#f8fafc;color:#64748b;cursor:pointer">${u.ativo ? '🔒 Bloquear' : '🔓 Ativar'}</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  } catch(e) { el.innerHTML = '<div style="padding:12px;color:#dc2626;font-size:11px">Erro ao carregar usuários</div>'; }
}

async function resetarSenhaUsuario(id, login) {
  if (!confirm(`Resetar senha de "${login}" para Montana@2026?`)) return;
  try {
    const r = await api(`/usuarios/${id}/reset-senha`, { method: 'POST' });
    toast(r.ok ? `✅ Senha resetada — nova senha: Montana@2026` : (r.error || 'Erro'), r.ok ? 'success' : 'error');
  } catch(e) { toast('Erro: ' + e.message, 'error'); }
}

async function toggleAtivoUsuario(id, ativo) {
  try {
    const r = await api(`/usuarios/${id}`, { method: 'PATCH', body: JSON.stringify({ ativo: ativo ? 0 : 1 }) });
    if (r.ok) { toast('Usuário atualizado', 'success'); loadUsuariosConfig(); }
    else toast(r.error || 'Erro', 'error');
  } catch(e) { toast('Erro: ' + e.message, 'error'); }
}

// ─── Fluxo de Caixa Projetado ────────────────────────────
async function loadFluxoProjetadoContratos() {
  const kpiEl = document.getElementById('fluxo-proj-kpis');
  const tblEl = document.getElementById('fluxo-proj-body');
  if (!kpiEl || !tblEl) return;

  kpiEl.innerHTML = '<div style="color:#94a3b8;font-size:12px">Carregando projeção...</div>';

  const d = await api('/relatorios/fluxo-projetado?meses=6');
  if (!d || !d.projecao) { kpiEl.innerHTML = '<div style="color:#dc2626">Erro ao carregar projeção</div>'; return; }

  const brl = v => 'R$\u00a0' + (v||0).toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2});
  const hoje = new Date();
  const prox30 = d.projecao.find(p => new Date(p.data_recebimento_prevista) <= new Date(hoje.getTime() + 30*86400000));

  kpiEl.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px">
      <div class="kpi" style="border-left:4px solid #0891b2">
        <div class="kpi-l">Previsto Prox. 30 dias</div>
        <div class="kpi-v" style="color:#0891b2">${brl(prox30?.receita_prevista||0)}</div>
        <div class="kpi-s">${prox30 ? 'Recebimento em ~' + prox30.data_recebimento_prevista : 'sem previsão'}</div>
      </div>
      <div class="kpi" style="border-left:4px solid #059669">
        <div class="kpi-l">Receita Mensal Prevista</div>
        <div class="kpi-v" style="color:#059669">${brl(d.total_mensal_previsto)}</div>
        <div class="kpi-s">${d.contratos_ativos} contratos ativos</div>
      </div>
      <div class="kpi" style="border-left:4px solid #d97706">
        <div class="kpi-l">Atraso Medio</div>
        <div class="kpi-v" style="color:#d97706">${d.media_atraso_geral} dias</div>
        <div class="kpi-s">média histórica dos órgãos</div>
      </div>
    </div>`;

  tblEl.innerHTML = d.projecao.map((p) => `
    <tr style="cursor:pointer" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'table-row':'none'">
      <td><strong>${p.mes}</strong></td>
      <td style="color:#059669;font-weight:700">${brl(p.receita_prevista)}</td>
      <td>${p.data_recebimento_prevista}</td>
      <td>${p.atraso_medio_dias} dias</td>
      <td><span style="font-size:10px;color:#64748b">▼ ${p.contratos.length} contratos</span></td>
    </tr>
    <tr style="display:none;background:#f8fafc">
      <td colspan="5" style="padding:8px 16px">
        <table style="width:100%;font-size:11px">
          <tr style="color:#64748b"><th>Contrato</th><th>Órgão</th><th>Valor</th><th>Atraso Médio</th></tr>
          ${p.contratos.map(c => `<tr>
            <td>${c.numContrato}</td><td>${c.orgao}</td>
            <td style="color:#059669">${brl(c.valor)}</td>
            <td>${c.atraso_medio_dias}d</td>
          </tr>`).join('')}
        </table>
      </td>
    </tr>`).join('');
}

// ─── Margem por Posto ────────────────────────────────────
async function loadMargemPorPosto() {
  const kpiEl = document.getElementById('margem-posto-kpis');
  const tblEl = document.getElementById('margem-posto-body');
  if (!kpiEl || !tblEl) return;

  const p = window._globalPeriod || {};
  const qs = p.from ? `?from=${p.from}&to=${p.to}` : '';
  const d = await api('/relatorios/margem-por-posto' + qs);
  if (!d || d.error) { kpiEl.innerHTML = '<span style="color:#dc2626">Erro: ' + (d?.error||'sem dados') + '</span>'; return; }
  if (!d.postos?.length) { kpiEl.innerHTML = '<span style="color:#94a3b8">Nenhum posto com dados no período</span>'; return; }

  const brl = v => 'R$\u00a0' + (v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const pct = v => (v||0).toFixed(1) + '%';
  const corMargem = v => v >= 20 ? '#059669' : v >= 10 ? '#d97706' : '#dc2626';

  kpiEl.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px">
      <div class="kpi" style="border-left:4px solid #059669">
        <div class="kpi-l">Posto Mais Lucrativo</div>
        <div class="kpi-v" style="color:#059669;font-size:14px">${d.melhor_posto?.descricao||'—'}</div>
        <div class="kpi-s">${pct(d.melhor_posto?.margem_pct)} de margem</div>
      </div>
      <div class="kpi" style="border-left:4px solid #dc2626">
        <div class="kpi-l">Posto Menor Margem</div>
        <div class="kpi-v" style="color:#dc2626;font-size:14px">${d.pior_posto?.descricao||'—'}</div>
        <div class="kpi-s">${pct(d.pior_posto?.margem_pct)} de margem</div>
      </div>
      <div class="kpi" style="border-left:4px solid #3b82f6">
        <div class="kpi-l">Receita Total Postos</div>
        <div class="kpi-v" style="color:#3b82f6">${brl(d.total_receita)}</div>
        <div class="kpi-s">${d.postos.length} postos analisados</div>
      </div>
    </div>`;

  tblEl.innerHTML = d.postos.map(p => `
    <tr>
      <td style="font-weight:600">${p.descricao}</td>
      <td style="color:#64748b;font-size:11px">${p.contrato_ref||'—'}</td>
      <td style="text-align:right">${brl(p.receita_total)}</td>
      <td style="text-align:right;color:#dc2626">${brl(p.custo_estimado)}</td>
      <td style="text-align:right;font-weight:700;color:${corMargem(p.margem_pct)}">${brl(p.margem_valor)}</td>
      <td style="text-align:center">
        <span style="background:${corMargem(p.margem_pct)}20;color:${corMargem(p.margem_pct)};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">${pct(p.margem_pct)}</span>
      </td>
    </tr>`).join('');
}

// ─── Cobertura de Postos ──────────────────────────────────────────────────────
async function loadCoberturaPosots() {
  const el = document.getElementById('cobertura-body');
  const kpiEl = document.getElementById('cobertura-kpis');
  if (!el) return;

  const p = window._globalPeriod || {};
  const qs = p.from ? `?from=${p.from}&to=${p.to}` : '';
  const d = await api('/relatorios/cobertura-postos' + qs);
  if (!d) return;
  if (d.message) { el.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:20px">${d.message}</td></tr>`; return; }

  const r = d.resumo || {};
  if (kpiEl) {
    kpiEl.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px">
        <div class="kpi" style="border-left:4px solid #3b82f6">
          <div class="kpi-l">Total de Postos</div>
          <div class="kpi-v" style="color:#3b82f6">${r.total_postos||0}</div>
          <div class="kpi-s">competência ${d.competencia}</div>
        </div>
        <div class="kpi" style="border-left:4px solid #059669">
          <div class="kpi-l">Postos Cobertos</div>
          <div class="kpi-v" style="color:#059669">${r.postos_ok||0}</div>
          <div class="kpi-s">cobertura &ge; 90%</div>
        </div>
        <div class="kpi" style="border-left:4px solid #dc2626">
          <div class="kpi-l">Postos Críticos</div>
          <div class="kpi-v" style="color:#dc2626">${r.postos_criticos||0}</div>
          <div class="kpi-s">cobertura &lt; 60%</div>
        </div>
        <div class="kpi" style="border-left:4px solid #d97706">
          <div class="kpi-l">Postos Parciais</div>
          <div class="kpi-v" style="color:#d97706">${r.postos_parciais||0}</div>
          <div class="kpi-s">cobertura 60–90%</div>
        </div>
      </div>`;
  }

  const corStatus = { 'OK':'#059669', 'PARCIAL':'#d97706', 'CRÍTICO':'#dc2626' };
  el.innerHTML = (d.postos||[]).map(p => `
    <tr>
      <td style="font-weight:600">${p.descricao||'—'}</td>
      <td style="color:#64748b;font-size:11px">${p.orgao||'—'}</td>
      <td style="text-align:center">${p.qtd_esperada}</td>
      <td style="text-align:center">${p.funcionarios_escalados}</td>
      <td style="text-align:center">
        <div style="background:#e2e8f0;border-radius:4px;height:8px;width:80px;display:inline-block;vertical-align:middle">
          <div style="background:${corStatus[p.status_cobertura]};height:8px;border-radius:4px;width:${p.cobertura_pct}%"></div>
        </div>
        <span style="font-size:11px;margin-left:4px">${p.cobertura_pct}%</span>
      </td>
      <td style="text-align:center">
        <span style="background:${corStatus[p.status_cobertura]}20;color:${corStatus[p.status_cobertura]};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">${p.status_cobertura}</span>
      </td>
      <td style="text-align:center;font-size:11px;color:${p.status_boletim==='aprovado'?'#059669':'#d97706'}">${p.status_boletim||'sem boletim'}</td>
    </tr>`).join('');
}

// ─── Holerite Digital ─────────────────────────────────────────────────────────
function abrirHolerite(funcionario_id, nome) {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:24px;width:360px;max-width:95vw">
      <h3 style="font-size:15px;font-weight:700;margin-bottom:16px">Holerite — ${nome}</h3>
      <div style="margin-bottom:16px">
        <label style="font-size:11px;font-weight:700;color:#64748b;display:block;margin-bottom:4px">COMPETÊNCIA</label>
        <input type="month" id="hol-comp" value="${new Date().toISOString().substring(0,7)}"
          style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:7px;font-size:13px;box-sizing:border-box">
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button onclick="this.closest('[style*=fixed]').remove()" style="padding:8px 16px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:7px;font-size:12px;cursor:pointer">Cancelar</button>
        <button onclick="
          const comp = document.getElementById('hol-comp').value;
          if(!comp){alert('Selecione a competência');return;}
          const company = window._selectedCompany||localStorage.getItem('company')||'assessoria';
          window.open('/api/rh/holerite-html/${funcionario_id}/'+comp+'?company='+company,'_blank','width=800,height=600');
          this.closest('[style*=fixed]').remove();
        " style="padding:8px 16px;background:#1e293b;color:#fff;border:none;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer">Gerar Holerite</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

// ─── WhatsApp Config ──────────────────────────────────────────────────────────
async function salvarConfigWhatsApp() {
  const body = {
    provider:        document.getElementById('cfg-wpp-provider')?.value,
    instance_id:     document.getElementById('cfg-wpp-instance')?.value?.trim(),
    token:           document.getElementById('cfg-wpp-token')?.value,
    numero_destino:  document.getElementById('cfg-wpp-numero')?.value?.trim(),
  };
  const r = await api('/whatsapp/config', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if (r && r.ok) toast('Configuração WhatsApp salva!');
  else toast((r && r.error) || 'Erro ao salvar', 'error');
}

async function testarWhatsApp() {
  const st = document.getElementById('cfg-wpp-status');
  if (st) st.textContent = 'Testando...';
  await salvarConfigWhatsApp();
  const r = await api('/whatsapp/testar', { method: 'POST' });
  if (st) st.textContent = (r && r.ok) ? 'Mensagem enviada!' : 'Falha: ' + ((r && r.error)||'erro');
  if (r && r.ok) toast('WhatsApp: mensagem de teste enviada!');
  else toast((r && r.error) || 'Falha no WhatsApp', 'error');
}

// ─── EPI / Uniformes ─────────────────────────────────────────────────────────
async function loadEPIRelatorio() {
  const el = document.getElementById('epi-body');
  const kpiEl = document.getElementById('epi-kpis');
  if (!el) return;

  const d = await api('/epi/relatorio');
  if (!d) return;

  const brl = v => 'R$\u00a0' + (v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});

  if (kpiEl) {
    const totalItens = (d.por_item||[]).reduce((s,i) => s + (i.em_uso||0), 0);
    kpiEl.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px">
        <div class="kpi" style="border-left:4px solid #f59e0b">
          <div class="kpi-l">EPIs em Uso</div>
          <div class="kpi-v" style="color:#f59e0b">${totalItens}</div>
          <div class="kpi-s">${(d.por_item||[]).length} tipos diferentes</div>
        </div>
        <div class="kpi" style="border-left:4px solid #dc2626">
          <div class="kpi-l">Custo Total EPIs</div>
          <div class="kpi-v" style="color:#dc2626">${brl(d.total_custo)}</div>
          <div class="kpi-s">estoque ativo</div>
        </div>
      </div>`;
  }

  el.innerHTML = (d.por_item||[]).map(i => `
    <tr>
      <td style="font-weight:600">${i.nome_item}</td>
      <td><span style="background:#fef3c7;color:#92400e;padding:2px 6px;border-radius:4px;font-size:10px">${i.tipo}</span></td>
      <td style="text-align:center">${i.em_uso}</td>
      <td style="text-align:center;color:#64748b">${i.devolvidos}</td>
      <td style="text-align:right;color:#dc2626">${brl(i.custo_total)}</td>
    </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:20px">Nenhum EPI registrado</td></tr>';
}

function abrirEntregaEPI(funcionario_id, nome_func) {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center';
  const itensComuns = ['Colete Balístico','Colete Refletivo','Farda Completa','Crachá','Algema','Lanterna','Cassetete','Boné/Boina','Coturno','Cinto Tático','Rádio Comunicador','Luva','Máscara'];
  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:24px;width:420px;max-width:95vw">
      <h3 style="font-size:15px;font-weight:700;margin-bottom:16px">Entrega de EPI — ${nome_func}</h3>
      <div style="display:grid;gap:10px">
        <div>
          <label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:4px">ITEM</label>
          <select id="epi-item" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:7px;font-size:12px;box-sizing:border-box">
            ${itensComuns.map(i => `<option>${i}</option>`).join('')}
            <option value="">Outro (digitar abaixo)</option>
          </select>
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:4px">ITEM PERSONALIZADO</label>
          <input id="epi-item-custom" type="text" placeholder="Deixe vazio para usar seleção acima" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:7px;font-size:12px;box-sizing:border-box">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
          <div>
            <label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:4px">TIPO</label>
            <select id="epi-tipo" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:7px;font-size:12px;box-sizing:border-box">
              <option value="EPI">EPI</option>
              <option value="UNIFORME">Uniforme</option>
              <option value="EQUIPAMENTO">Equipamento</option>
            </select>
          </div>
          <div>
            <label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:4px">VALOR (R$)</label>
            <input id="epi-valor" type="number" step="0.01" placeholder="0,00" style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:7px;font-size:12px;box-sizing:border-box">
          </div>
          <div>
            <label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:4px">TAMANHO</label>
            <input id="epi-tamanho" type="text" placeholder="M, G, 42..." style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:7px;font-size:12px;box-sizing:border-box">
          </div>
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;color:#64748b;display:block;margin-bottom:4px">OBS</label>
          <input id="epi-obs" type="text" placeholder="Observações..." style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:7px;font-size:12px;box-sizing:border-box">
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
        <button onclick="this.closest('[style*=fixed]').remove()" style="padding:8px 16px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:7px;font-size:12px;cursor:pointer">Cancelar</button>
        <button onclick="registrarEntregaEPI(${funcionario_id})" style="padding:8px 16px;background:#f59e0b;color:#fff;border:none;border-radius:7px;font-size:12px;font-weight:700;cursor:pointer">Registrar Entrega</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

async function registrarEntregaEPI(funcionario_id) {
  const itemSel = document.getElementById('epi-item')?.value;
  const itemCustom = document.getElementById('epi-item-custom')?.value?.trim();
  const nome_item = itemCustom || itemSel;
  if (!nome_item) { toast('Selecione ou digite o item', 'error'); return; }

  const r = await api('/epi/entregar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      funcionario_id,
      nome_item,
      tipo:     document.getElementById('epi-tipo')?.value,
      valor:    parseFloat(document.getElementById('epi-valor')?.value||0),
      tamanho:  document.getElementById('epi-tamanho')?.value,
      obs:      document.getElementById('epi-obs')?.value,
    })
  });

  if (r && r.ok) {
    toast('EPI registrado com sucesso!');
    document.querySelector('[style*=fixed]')?.remove();
    loadEPIRelatorio();
  } else {
    toast((r && r.error) || 'Erro ao registrar EPI', 'error');
  }
}

// ─── AUTO-VINCULAR NFs ───────────────────────────────────────────────────────
async function autoVincularNFs() {
  const ok = confirm('Deseja executar a auto-vinculação de Notas Fiscais sem contrato vinculado?\n\nO sistema aplicará as regras automáticas de matching por tomador.');
  if (!ok) return;

  try {
    const r = await api('/nfs/auto-vincular', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ somente_sem_contrato: true })
    });

    if (r && r.ok) {
      let msg = `✅ Auto-vinculação concluída!\n\n${r.total_vinculadas} NFs vinculadas.`;
      if (r.resumo && r.resumo.length > 0) {
        msg += '\n\nDetalhes:\n' + r.resumo.map(x => `  • ${x.contrato}: ${x.vinculadas} NFs`).join('\n');
      }
      if (r.ainda_sem_contrato > 0) {
        msg += `\n\n⚠️ Ainda sem contrato: ${r.ainda_sem_contrato} NFs`;
      } else {
        msg += '\n\n🎉 Todas as NFs estão vinculadas!';
      }
      alert(msg);
    } else {
      toast((r && r.error) || 'Erro na auto-vinculação', 'error');
    }
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// PIS/COFINS SEGURANÇA — Apuração Mensal (Cumulativo, Caixa)
// ═══════════════════════════════════════════════════════════════

let _pcDados = null;  // cache da última apuração

function initPisCofinsSeg() {
  const inp = document.getElementById('pc-mes');
  if (inp && !inp.value) {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    inp.value = `${prev.getFullYear()}-${String(prev.getMonth()+1).padStart(2,'0')}`;
  }
}

async function loadPisCofinsSeg() {
  const anoMes = document.getElementById('pc-mes')?.value;
  if (!anoMes) return;

  document.getElementById('pc-loading').textContent = 'Calculando…';
  document.getElementById('pc-loading').style.display = 'block';
  document.getElementById('pc-cards').style.display = 'none';
  document.getElementById('pc-aviso-nao-aplicavel').style.display = 'none';

  try {
    const data = await api(`/piscofins-seguranca/${anoMes}`);
    if (!data.ok) throw new Error(data.error || 'Erro');
    _pcDados = data.dados;

    // Título + subtítulo dinâmicos por empresa
    const tituloEl = document.getElementById('pc-titulo');
    const subEl    = document.getElementById('pc-subtitulo');
    if (tituloEl) tituloEl.textContent = `💰 Apuração PIS/COFINS — ${_pcDados.empresa_nome_curto || ''}`.trim();
    if (subEl && _pcDados.aplicavel) {
      const pct = (v) => (v*100).toLocaleString('pt-BR',{minimumFractionDigits:2});
      subEl.textContent =
        `Regime: ${_pcDados.regime} (PIS ${pct(_pcDados.aliq_pis)}% + COFINS ${pct(_pcDados.aliq_cofins)}%) · Base de caixa a partir de jan/2026`;
    }

    // Empresas Simples: mostra aviso e não renderiza cards
    if (!_pcDados.aplicavel) {
      document.getElementById('pc-loading').style.display = 'none';
      const av = document.getElementById('pc-aviso-nao-aplicavel');
      av.style.display = 'block';
      av.textContent = _pcDados.aviso || `${_pcDados.empresa_nome_curto} — ${_pcDados.regime}. PIS/COFINS recolhidos via DAS unificado; apuração separada não se aplica.`;
      if (subEl) subEl.textContent = `Regime: ${_pcDados.regime}`;
      document.getElementById('pc-btn-excel').style.display = 'none';
      return;
    }

    document.getElementById('pc-loading').style.display = 'none';
    document.getElementById('pc-cards').style.display = 'block';
    document.getElementById('pc-btn-excel').style.display = '';

    renderPcKpis(_pcDados);
    renderPcTabela('tributaveis', _pcDados.tributaveis);
    renderPcTabela('excluidos',   _pcDados.excluidos);
    renderPcTabela('nao_tributa', _pcDados.nao_tributa);
    renderPcTabela('pendentes',   _pcDados.pendentes);

    // Atualiza labels dos botões com contagens
    document.getElementById('pc-tab-tributaveis').textContent =
      `✅ Tributáveis (${_pcDados.resumo.qtd_tributaveis})`;
    document.getElementById('pc-tab-excluidos').textContent =
      `🚫 Excluídos (${_pcDados.resumo.qtd_excluidos})`;
    document.getElementById('pc-tab-nao_tributa').textContent =
      `⛔ Não Tributa (${_pcDados.resumo.qtd_nao_tributa})`;
    document.getElementById('pc-tab-pendentes').textContent =
      `⚠ Pendentes (${_pcDados.resumo.qtd_pendentes})`;

    // Alerta pendentes
    const alertEl = document.getElementById('pc-alerta-pendentes');
    if (_pcDados.resumo.tem_pendentes) {
      alertEl.style.display = 'block';
      alertEl.textContent =
        `⚠ ${_pcDados.resumo.qtd_pendentes} crédito(s) sem NF vinculada — verifique no Portal da Transparência e vincule no ERP antes de emitir o DARF.`;
    } else {
      alertEl.style.display = 'none';
    }

    pcShowTab('tributaveis');
  } catch (e) {
    document.getElementById('pc-loading').textContent = 'Erro: ' + e.message;
  }
}

function renderPcKpis(d) {
  const pct = v => (v*100).toLocaleString('pt-BR',{minimumFractionDigits:2});
  const cards = [
    { label: 'Base Tributável',       val: brl(d.base_tributavel), bg: '#dbeafe', bold: true },
    { label: `PIS ${pct(d.aliq_pis)}% (DARF ${d.darf_pis})`,   val: brl(d.pis),   bg: '#d1fae5' },
    { label: `COFINS ${pct(d.aliq_cofins)}% (DARF ${d.darf_cofins})`, val: brl(d.cofins), bg: '#d1fae5' },
    { label: 'Total a Recolher',      val: brl(d.total_darf),      bg: '#d1fae5', bold: true },
    { label: 'Vencimento DARF',       val: d.vencimento,           bg: '#fef3c7' },
  ];
  document.getElementById('pc-kpis').innerHTML = cards.map(c => `
    <div style="background:${c.bg};border-radius:10px;padding:12px 14px;border:1px solid #e2e8f0">
      <div style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;margin-bottom:4px">${c.label}</div>
      <div style="font-size:${c.bold?'17px':'15px'};font-weight:${c.bold?800:600};color:#0f172a">${c.val}</div>
    </div>
  `).join('');
}

const PC_COLS = [
  ['data_iso',             'Data'],
  ['historico',            'Histórico'],
  ['pagador_identificado', 'Pagador'],
  ['credito',              'Valor Crédito'],
  ['nf_numero',            'NF Nº'],
  ['data_emissao',         'Emissão NF'],
  ['tomador',              'Tomador'],
  ['status_conciliacao',   'Status'],
];
const PC_COLS_SIMPLES = [
  ['data_iso',  'Data'],
  ['historico', 'Histórico'],
  ['credito',   'Valor Crédito'],
];
const PC_COLS_PEND = [
  ['data_iso',             'Data'],
  ['historico',            'Histórico'],
  ['pagador_identificado', 'Pagador'],
  ['credito',              'Valor Crédito'],
  ['status_conciliacao',   'Status'],
];

function renderPcTabela(tipo, rows) {
  const cols = tipo === 'nao_tributa' ? PC_COLS_SIMPLES
             : tipo === 'pendentes'   ? PC_COLS_PEND
             : PC_COLS;

  const thead = document.getElementById(`pc-thead-${tipo}`);
  const tbody = document.getElementById(`pc-tbody-${tipo}`);
  if (!thead || !tbody) return;

  thead.innerHTML = `<tr>${cols.map(([,t]) =>
    `<th style="font-size:10px;font-weight:700;color:#fff;background:#1e293b;padding:7px 10px;text-align:left">${t}</th>`
  ).join('')}</tr>`;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="${cols.length}" style="padding:16px;text-align:center;color:#94a3b8;font-size:12px">Nenhum lançamento nesta categoria.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => `<tr>${cols.map(([k]) => {
    let v = r[k] ?? '';
    if (k === 'credito' || k === 'nf_valor_bruto' || k === 'nf_valor_liquido') {
      v = brl(v);
    }
    return `<td style="font-size:11px;padding:5px 10px;border-bottom:1px solid #f1f5f9;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${String(v).replace(/"/g,'')}">${v}</td>`;
  }).join('')}</tr>`).join('');
}

function pcShowTab(tipo) {
  ['tributaveis','excluidos','nao_tributa','pendentes'].forEach(t => {
    const panel = document.getElementById(`pc-panel-${t}`);
    if (panel) panel.style.display = t === tipo ? '' : 'none';
  });
}

async function exportarPisCofinsExcel() {
  const anoMes = document.getElementById('pc-mes')?.value;
  if (!anoMes) return;
  window.open(`/api/piscofins-seguranca/${anoMes}/excel?company=${window.currentCompany}`, '_blank');
}

// ═══════════════════════════════════════════════════════════════
// INSS RETIDO / S-1300
// ═══════════════════════════════════════════════════════════════

let _irDados = null;

async function initInssRetido() {
  const sel = document.getElementById('ir-competencia');
  if (!sel) return;
  try {
    const d = await api('/inss-retido/competencias', { headers: { 'X-Company': 'assessoria' } });
    if (!d.ok) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">Selecione…</option>' +
      d.competencias.map(c =>
        `<option value="${c.value}" ${c.value === cur ? 'selected' : ''}>${c.label} (${c.cnt} NFs)</option>`
      ).join('');
    if (!cur && d.competencias.length) {
      sel.value = d.competencias[0].value;
      loadInssRetido();
    }
  } catch (e) {
    console.warn('initInssRetido:', e.message);
  }
}

async function loadInssRetido() {
  const comp = document.getElementById('ir-competencia')?.value;
  if (!comp) return;

  document.getElementById('ir-loading').textContent = 'Carregando…';
  document.getElementById('ir-loading').style.display = 'block';
  ['ir-kpis','ir-alerta','ir-tomadores-box','ir-nfs-box','ir-dctfweb-box'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  try {
    const d = await api(`/inss-retido/apuracao?competencia=${comp}`, { headers: { 'X-Company': 'assessoria' } });
    if (!d.ok) throw new Error(d.error || 'Erro');
    _irDados = d;

    document.getElementById('ir-loading').style.display = 'none';
    document.getElementById('ir-btn-relatorio').style.display = '';

    const r = d.resumo;

    // DCTFWeb input
    const dctfBox = document.getElementById('ir-dctfweb-box');
    dctfBox.style.display = 'block';
    const dctfInp = document.getElementById('ir-dctfweb-valor');
    if (dctfInp && r.dctfweb_declarado > 0) dctfInp.value = r.dctfweb_declarado.toFixed(2);

    // Alerta gap
    const alertEl = document.getElementById('ir-alerta');
    if (r.gap > 1) {
      alertEl.style.display = 'block';
      alertEl.innerHTML = `⚠ DCTFWeb de ${d.competencia} declara apenas <strong>${brl(r.dctfweb_declarado)}</strong>.` +
        ` INSS retido nas NFs: <strong>${brl(r.total_inss_declarado)}</strong>.` +
        ` Gap: <strong>${brl(r.gap)}</strong> — possível necessidade de retificação.`;
    } else if (r.dctfweb_declarado === 0) {
      alertEl.style.display = 'block';
      alertEl.style.background = '#fef3c7';
      alertEl.style.borderColor = '#fcd34d';
      alertEl.style.color = '#92400e';
      alertEl.innerHTML = `⚠ DCTFWeb não informada para ${d.competencia}. Informe o valor declarado abaixo para calcular o gap.`;
    } else {
      alertEl.style.display = 'none';
    }

    // KPIs
    const kpisEl = document.getElementById('ir-kpis');
    kpisEl.style.display = 'grid';
    kpisEl.innerHTML = [
      { label: 'Total NFs Analisadas',      val: String(r.total_nfs),                    bg: '#f1f5f9' },
      { label: 'Valor Bruto Total',          val: brl(r.total_bruto),                     bg: '#dbeafe', bold: true },
      { label: 'INSS Retido nas NFs',        val: brl(r.total_inss_declarado),            bg: '#dcfce7', bold: true },
      { label: 'DCTFWeb Declarada',          val: brl(r.dctfweb_declarado),               bg: r.gap > 1 ? '#fee2e2' : '#f0fdf4' },
      { label: 'Gap (INSS − DCTFWeb)',       val: brl(r.gap),                             bg: r.gap > 1 ? '#fee2e2' : '#f0fdf4', bold: r.gap > 1 },
    ].map(c => `
      <div style="background:${c.bg};border-radius:10px;padding:12px 14px;border:1px solid #e2e8f0">
        <div style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;margin-bottom:4px">${c.label}</div>
        <div style="font-size:${c.bold?'17px':'15px'};font-weight:${c.bold?800:600};color:#0f172a">${c.val}</div>
      </div>`).join('');

    // Tabela por tomador
    irRenderTomadores(d.por_tomador);

    // Tabela NFs
    irRenderNFs(d.nfs);

  } catch (e) {
    document.getElementById('ir-loading').textContent = 'Erro: ' + e.message;
    document.getElementById('ir-loading').style.display = 'block';
  }
}

function irRenderTomadores(rows) {
  const box    = document.getElementById('ir-tomadores-box');
  const thead  = document.getElementById('ir-tomadores-thead');
  const tbody  = document.getElementById('ir-tomadores-tbody');
  if (!box || !thead || !tbody) return;

  box.style.display = 'block';
  const cols = ['Tomador','NFs','Valor Bruto','INSS Retido','% INSS','Status'];
  thead.innerHTML = cols.map(c =>
    `<th style="font-size:10px;font-weight:700;color:#fff;background:#1e293b;padding:7px 10px;text-align:left;white-space:nowrap">${c}</th>`
  ).join('');

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="padding:16px;text-align:center;color:#94a3b8;font-size:12px">Nenhuma NF nesta competência.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    let rowBg = '', statusIcon = '';
    if (r.inss === 0)               { rowBg = '#fee2e2'; statusIcon = '🔴 Sem INSS'; }
    else if (r.pct < 8)             { rowBg = '#fef3c7'; statusIcon = '🟡 INSS baixo'; }
    else if (Math.abs(r.pct-11)<=1) { rowBg = '#dcfce7'; statusIcon = '🟢 OK'; }
    else                            { rowBg = '#fef3c7'; statusIcon = '🟡 Divergente'; }
    return `<tr style="background:${rowBg}">
      <td style="font-size:11px;padding:6px 10px;border-bottom:1px solid #f1f5f9;font-weight:600">${r.tomador}</td>
      <td style="font-size:11px;padding:6px 10px;border-bottom:1px solid #f1f5f9;text-align:center">${r.nfs}</td>
      <td style="font-size:11px;padding:6px 10px;border-bottom:1px solid #f1f5f9;text-align:right">${brl(r.bruto)}</td>
      <td style="font-size:11px;padding:6px 10px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:700">${brl(r.inss)}</td>
      <td style="font-size:11px;padding:6px 10px;border-bottom:1px solid #f1f5f9;text-align:right">${r.pct.toFixed(2)}%</td>
      <td style="font-size:11px;padding:6px 10px;border-bottom:1px solid #f1f5f9">${statusIcon}</td>
    </tr>`;
  }).join('');
}

function irRenderNFs(rows) {
  const box   = document.getElementById('ir-nfs-box');
  const thead = document.getElementById('ir-nfs-thead');
  const tbody = document.getElementById('ir-nfs-tbody');
  if (!box || !thead || !tbody) return;

  box.style.display = 'block';
  const cols = ['NF','Data','Tomador','Valor Bruto','INSS','%'];
  thead.innerHTML = cols.map(c =>
    `<th style="font-size:10px;font-weight:700;color:#fff;background:#1e293b;padding:7px 10px;text-align:left;white-space:nowrap">${c}</th>`
  ).join('');

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="padding:16px;text-align:center;color:#94a3b8;font-size:12px">Nenhuma NF.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    let bg = '';
    if (r.status === 'sem_inss')   bg = '#fee2e2';
    else if (r.status === 'baixo') bg = '#fef3c7';
    return `<tr style="background:${bg}">
      <td style="font-size:11px;padding:5px 10px;border-bottom:1px solid #f1f5f9">${r.numero || '—'}</td>
      <td style="font-size:11px;padding:5px 10px;border-bottom:1px solid #f1f5f9;white-space:nowrap">${r.data_emissao || '—'}</td>
      <td style="font-size:11px;padding:5px 10px;border-bottom:1px solid #f1f5f9;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(r.tomador||'').replace(/"/g,'')}">${r.tomador || '—'}</td>
      <td style="font-size:11px;padding:5px 10px;border-bottom:1px solid #f1f5f9;text-align:right">${brl(r.valor_bruto)}</td>
      <td style="font-size:11px;padding:5px 10px;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:${r.inss>0?600:400}">${brl(r.inss)}</td>
      <td style="font-size:11px;padding:5px 10px;border-bottom:1px solid #f1f5f9;text-align:right">${r.pct.toFixed(2)}%</td>
    </tr>`;
  }).join('');
}

function irToggleNFs() {
  const tbl = document.getElementById('ir-nfs-table');
  const btn = document.getElementById('ir-toggle-nfs');
  if (!tbl) return;
  const visible = tbl.style.display !== 'none';
  tbl.style.display = visible ? 'none' : '';
  if (btn) btn.textContent = visible ? 'Ver detalhes ▼' : 'Ocultar ▲';
}

async function salvarDctfweb() {
  const comp  = document.getElementById('ir-competencia')?.value;
  const valor = document.getElementById('ir-dctfweb-valor')?.value;
  const stat  = document.getElementById('ir-dctfweb-status');
  if (!comp) return;

  try {
    const d = await api('/inss-retido/dctfweb', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Company': 'assessoria' },
      body: JSON.stringify({ competencia: comp, valor: parseFloat(valor) || 0 }),
    });
    if (!d.ok) throw new Error(d.error);
    if (stat) { stat.textContent = '✅ Salvo'; setTimeout(() => { stat.textContent = ''; }, 3000); }
    loadInssRetido();
  } catch (e) {
    if (stat) stat.textContent = '❌ Erro: ' + e.message;
  }
}

async function abrirRelatorioInss() {
  const comp = document.getElementById('ir-competencia')?.value;
  if (!comp) return;

  const modal   = document.getElementById('ir-modal');
  const content = document.getElementById('ir-modal-content');
  if (!modal || !content) return;

  content.innerHTML = '<div style="text-align:center;padding:30px;color:#94a3b8">Gerando relatório…</div>';
  modal.style.display = 'block';

  try {
    const d = await api(`/inss-retido/relatorio?competencia=${comp}`, { headers: { 'X-Company': 'assessoria' } });
    if (!d.ok) throw new Error(d.error);

    const linhasTomador = d.por_tomador.map(t => {
      let icon = '';
      if (t.inss === 0)               icon = '🔴';
      else if (t.pct < 8)             icon = '🟡';
      else if (Math.abs(t.pct-11)<=1) icon = '🟢';
      else                            icon = '🟡';
      return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;font-size:12px">${icon} ${t.tomador}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;text-align:center">${t.nfs}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;text-align:right">${brl(t.bruto)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;text-align:right;font-weight:700">${brl(t.inss)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;text-align:right">${t.pct.toFixed(2)}%</td>
      </tr>`;
    }).join('');

    const gapHtml = d.gap > 1
      ? `<div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:8px;padding:10px 14px;margin-top:14px;font-size:12px;color:#991b1b;font-weight:600">
          ⚠ DIVERGÊNCIA: DCTFWeb declara ${brl(d.dctfweb_declarado)} — INSS retido nas NFs: ${brl(d.total_inss)} — Gap: ${brl(d.gap)}.
          Verificar necessidade de retificação.
         </div>`
      : d.dctfweb_declarado > 0
        ? `<div style="background:#dcfce7;border:1px solid #86efac;border-radius:8px;padding:10px 14px;margin-top:14px;font-size:12px;color:#166534;font-weight:600">
            ✅ DCTFWeb (${brl(d.dctfweb_declarado)}) confere com o INSS retido nas NFs (${brl(d.total_inss)}).
           </div>`
        : `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:10px 14px;margin-top:14px;font-size:12px;color:#92400e">
            ⚠ DCTFWeb não informada para este período. Informe na tela principal para calcular o gap.
           </div>`;

    content.innerHTML = `
      <div style="font-family:Arial,sans-serif">
        <div style="text-align:center;margin-bottom:20px">
          <div style="font-size:16px;font-weight:800;color:#0f172a">RELATÓRIO DE INSS RETIDO — S-1300</div>
          <div style="font-size:13px;color:#334155;margin-top:4px">${d.empresa}</div>
          <div style="font-size:11px;color:#64748b">CNPJ: ${d.cnpj} · Regime: ${d.regime}</div>
          <div style="font-size:11px;color:#64748b">Competência: ${d.competencia.toUpperCase()} · Gerado em: ${d.gerado_em}</div>
        </div>

        <table style="width:100%;border-collapse:collapse;margin-bottom:14px">
          <tr style="background:#f1f5f9">
            <td style="padding:8px 12px;font-size:12px;font-weight:700">Total de NFs analisadas</td>
            <td style="padding:8px 12px;font-size:12px;text-align:right">${d.total_nfs}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;font-size:12px;font-weight:700">Valor Bruto Total</td>
            <td style="padding:8px 12px;font-size:12px;text-align:right">${brl(d.total_bruto)}</td>
          </tr>
          <tr style="background:#dcfce7">
            <td style="padding:8px 12px;font-size:13px;font-weight:800">INSS Retido Total (a declarar/recolher)</td>
            <td style="padding:8px 12px;font-size:13px;font-weight:800;text-align:right">${brl(d.total_inss)}</td>
          </tr>
          <tr>
            <td style="padding:8px 12px;font-size:12px">DCTFWeb Declarada</td>
            <td style="padding:8px 12px;font-size:12px;text-align:right">${brl(d.dctfweb_declarado)}</td>
          </tr>
        </table>

        <div style="font-size:13px;font-weight:700;color:#334155;margin-bottom:8px">Detalhamento por Tomador</div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:6px">
          <thead><tr style="background:#1e293b;color:#fff">
            <th style="padding:7px 10px;font-size:11px;text-align:left">Tomador</th>
            <th style="padding:7px 10px;font-size:11px;text-align:center">NFs</th>
            <th style="padding:7px 10px;font-size:11px;text-align:right">Valor Bruto</th>
            <th style="padding:7px 10px;font-size:11px;text-align:right">INSS Retido</th>
            <th style="padding:7px 10px;font-size:11px;text-align:right">% INSS</th>
          </tr></thead>
          <tbody>${linhasTomador}</tbody>
        </table>
        <div style="font-size:10px;color:#94a3b8;margin-bottom:4px">🟢 ≈ 11% correto · 🟡 INSS baixo (&lt;8%) — pode ser legítimo (contratos c/ material) · 🔴 INSS = 0</div>

        ${gapHtml}

        <div style="margin-top:18px;font-size:10px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:10px">
          Base legal: art. 31 Lei 8.212/91 · Retificação DCTFWeb: prazo até o vencimento do período de apuração subsequente.
          Relatório gerado pelo Sistema ERP Montana.
        </div>
      </div>`;
  } catch (e) {
    content.innerHTML = `<div style="color:#dc2626;padding:20px">Erro ao gerar relatório: ${e.message}</div>`;
  }
}
