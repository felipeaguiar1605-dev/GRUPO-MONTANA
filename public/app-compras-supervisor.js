// ═══════════════════════════════════════════════════════════════
// MÓDULO SETOR DE COMPRAS + SUPERVISOR OPERACIONAL
// Montana Multi-Empresa — app-compras-supervisor.js
// ═══════════════════════════════════════════════════════════════

// ─── UTILITÁRIOS LOCAIS ───────────────────────────────────────
function _brl(v) {
  if (v === null || v === undefined) return '—';
  const s = Math.abs(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (v >= 0 ? 'R$ ' : '−R$ ') + s;
}

function _badge(text, color) {
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;background:${color.bg};color:${color.text}">${text}</span>`;
}

// Mapeamento de cores por status/prioridade
const COMPRAS_PRIO_CORES = {
  URGENTE: { bg: '#fee2e2', text: '#dc2626' },
  NORMAL:  { bg: '#fef3c7', text: '#d97706' },
  BAIXA:   { bg: '#f1f5f9', text: '#64748b' },
};
const COMPRAS_STATUS_CORES = {
  PENDENTE:  { bg: '#fef3c7', text: '#d97706' },
  COTANDO:   { bg: '#dbeafe', text: '#1d4ed8' },
  APROVADA:  { bg: '#dcfce7', text: '#15803d' },
  COMPRADA:  { bg: '#d1fae5', text: '#065f46' },
  CANCELADA: { bg: '#f1f5f9', text: '#64748b' },
};
const SUP_TIPO_CORES = {
  FALTA:        { bg: '#fee2e2', text: '#dc2626' },
  ATRASO:       { bg: '#fef3c7', text: '#d97706' },
  INCIDENTE:    { bg: '#ede9fe', text: '#7c3aed' },
  SUBSTITUICAO: { bg: '#dbeafe', text: '#1d4ed8' },
  OUTRO:        { bg: '#f1f5f9', text: '#475569' },
};
const SUP_STATUS_CORES = {
  ABERTA:       { bg: '#fee2e2', text: '#dc2626' },
  EM_ANDAMENTO: { bg: '#fef3c7', text: '#d97706' },
  RESOLVIDA:    { bg: '#dcfce7', text: '#15803d' },
};

// ═══════════════════════════════════════════════════════════════
// SETOR DE COMPRAS
// ═══════════════════════════════════════════════════════════════

let _comprasReqId = null; // requisição aberta no modal

window.comprasInit = function() {
  comprasSubTab('dashboard');
};

function comprasShowView(view) {
  comprasSubTab(view);
}

function comprasSubTab(tab) {
  ['dashboard', 'requisicoes', 'nova'].forEach(t => {
    const panel = document.getElementById('compras-panel-' + t);
    const btn   = document.getElementById('compras-tab-' + t);
    if (panel) panel.style.display = t === tab ? '' : 'none';
    if (btn) {
      btn.style.color       = t === tab ? '#0d6efd' : '#64748b';
      btn.style.borderBottom = t === tab ? '2px solid #0d6efd' : '2px solid transparent';
    }
  });
  if (tab === 'dashboard')   loadComprasDashboard();
  if (tab === 'requisicoes') loadComprasRequisicoes();
  if (tab === 'nova')        initNovaRequisicaoForm();
}

async function loadComprasDashboard() {
  try {
    const data = await api('/compras/dashboard');

    // KPIs
    const statusMap = {};
    (data.porStatus || []).forEach(r => statusMap[r.status] = r);
    const kpis = [
      { label: 'Urgentes Abertas', value: data.urgentes || 0, icon: '🔴', color: '#fee2e2', border: '#dc2626' },
      { label: 'Pendentes',        value: (statusMap['PENDENTE'] || {}).total || 0, icon: '⏳', color: '#fef3c7', border: '#d97706' },
      { label: 'Em Cotação',       value: (statusMap['COTANDO']  || {}).total || 0, icon: '💰', color: '#dbeafe', border: '#1d4ed8' },
      { label: 'Valor do Mês',     value: _brl(data.valorMes || 0), icon: '📦', color: '#dcfce7', border: '#15803d', isText: true },
    ];
    const kpisEl = document.getElementById('compras-kpis');
    if (kpisEl) {
      kpisEl.innerHTML = kpis.map(k => `
        <div class="kpi" style="border-left:4px solid ${k.border};background:${k.color}">
          <div style="font-size:22px">${k.icon}</div>
          <div>
            <div class="kpi-val">${k.isText ? k.value : k.value.toLocaleString('pt-BR')}</div>
            <div class="kpi-lbl">${k.label}</div>
          </div>
        </div>`).join('');
    }

    // Tabela recentes
    const head = document.getElementById('compras-rec-head');
    const body = document.getElementById('compras-rec-body');
    if (head) head.innerHTML = '<tr><th>Requisição</th><th>Prioridade</th><th>Status</th><th>Valor Est.</th></tr>';
    if (body) body.innerHTML = (data.recentes || []).map(r => `
      <tr style="cursor:pointer" onclick="abrirDetalheRequisicao(${r.id})">
        <td>${r.titulo}<br><span style="font-size:10px;color:#94a3b8">${r.solicitante || '—'}</span></td>
        <td>${_badge(r.prioridade, COMPRAS_PRIO_CORES[r.prioridade] || COMPRAS_PRIO_CORES.NORMAL)}</td>
        <td>${_badge(r.status, COMPRAS_STATUS_CORES[r.status] || COMPRAS_STATUS_CORES.PENDENTE)}</td>
        <td style="text-align:right">${_brl(r.valor_aprovado || r.valor_estimado)}</td>
      </tr>`).join('') || '<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:20px">Nenhuma requisição</td></tr>';

    // Gráfico de status (barras simples)
    const chartEl = document.getElementById('compras-status-chart');
    if (chartEl) {
      const statuses = ['PENDENTE','COTANDO','APROVADA','COMPRADA','CANCELADA'];
      const labels   = ['Pendente','Cotando','Aprovada','Comprada','Cancelada'];
      const max = Math.max(1, ...statuses.map(s => (statusMap[s] || {}).total || 0));
      chartEl.innerHTML = statuses.map((s, i) => {
        const tot  = (statusMap[s] || {}).total || 0;
        const pct  = Math.round((tot / max) * 100);
        const cor  = COMPRAS_STATUS_CORES[s] || COMPRAS_STATUS_CORES.PENDENTE;
        return `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:11px">
            <div style="width:90px;color:#475569;font-weight:600">${labels[i]}</div>
            <div style="flex:1;background:#f1f5f9;border-radius:4px;height:16px">
              <div style="width:${pct}%;background:${cor.text};height:16px;border-radius:4px;min-width:${tot?4:0}px"></div>
            </div>
            <div style="width:28px;text-align:right;font-weight:700;color:${cor.text}">${tot}</div>
          </div>`;
      }).join('');
    }
  } catch(e) { console.error('compras dashboard', e); }
}

async function loadComprasRequisicoes() {
  try {
    const status = document.getElementById('compras-filtro-status')?.value || '';
    const prio   = document.getElementById('compras-filtro-prio')?.value   || '';
    const q      = document.getElementById('compras-filtro-q')?.value      || '';
    let url = '/compras/requisicoes?';
    if (status) url += `status=${encodeURIComponent(status)}&`;
    if (prio)   url += `prioridade=${encodeURIComponent(prio)}&`;
    if (q)      url += `q=${encodeURIComponent(q)}&`;

    const data = await api(url);
    const head = document.getElementById('compras-head');
    const body = document.getElementById('compras-body');

    if (head) head.innerHTML = `<tr>
      <th>#</th><th>Título</th><th>Solicitante</th><th>Prioridade</th><th>Status</th>
      <th>Valor Est.</th><th>Valor Aprov.</th><th>Necessidade</th><th>Cotações</th><th>Ações</th>
    </tr>`;

    if (body) body.innerHTML = (data.data || []).map(r => `
      <tr>
        <td>${r.id}</td>
        <td style="cursor:pointer;color:#1d4ed8;font-weight:600" onclick="abrirDetalheRequisicao(${r.id})">${r.titulo}</td>
        <td>${r.solicitante || '—'}</td>
        <td>${_badge(r.prioridade, COMPRAS_PRIO_CORES[r.prioridade] || COMPRAS_PRIO_CORES.NORMAL)}</td>
        <td>${_badge(r.status, COMPRAS_STATUS_CORES[r.status] || COMPRAS_STATUS_CORES.PENDENTE)}</td>
        <td style="text-align:right">${_brl(r.valor_estimado)}</td>
        <td style="text-align:right">${_brl(r.valor_aprovado)}</td>
        <td>${r.data_necessidade || '—'}</td>
        <td style="text-align:center">${r.qtd_cotacoes || 0}</td>
        <td>
          <button onclick="abrirDetalheRequisicao(${r.id})" style="padding:3px 10px;font-size:10px;background:#dbeafe;color:#1d4ed8;border:1px solid #93c5fd;border-radius:4px;cursor:pointer;font-weight:600">Ver</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="10" style="text-align:center;color:#94a3b8;padding:24px">Nenhuma requisição encontrada</td></tr>';
  } catch(e) { console.error('loadComprasRequisicoes', e); }
}

// ── Formulário Nova Requisição ───────────────────────────────
let _comprasItensCount = 0;

function initNovaRequisicaoForm() {
  // Limpar campos
  ['compras-titulo','compras-solicitante','compras-contrato-ref','compras-descricao'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const prioEl = document.getElementById('compras-prioridade');
  if (prioEl) prioEl.value = 'NORMAL';
  const valEl = document.getElementById('compras-val-est');
  if (valEl) valEl.value = '';
  const dataNec = document.getElementById('compras-data-nec');
  if (dataNec) dataNec.value = '';
  const wrap = document.getElementById('compras-itens-wrap');
  if (wrap) wrap.innerHTML = '';
  _comprasItensCount = 0;
  comprasAddItem(); // começa com 1 item
}

function comprasAddItem() {
  _comprasItensCount++;
  const i = _comprasItensCount;
  const wrap = document.getElementById('compras-itens-wrap');
  if (!wrap) return;
  const div = document.createElement('div');
  div.id = `compras-item-${i}`;
  div.style.cssText = 'display:grid;grid-template-columns:1fr 80px 80px 100px auto;gap:8px;align-items:center';
  div.innerHTML = `
    <input type="text" placeholder="Descrição do item" id="ci-desc-${i}"
      style="padding:6px 8px;border:1px solid #e2e8f0;border-radius:5px;font-size:11px;width:100%;box-sizing:border-box">
    <input type="text" placeholder="Unid." id="ci-un-${i}" value="un"
      style="padding:6px 8px;border:1px solid #e2e8f0;border-radius:5px;font-size:11px;width:100%;box-sizing:border-box">
    <input type="number" placeholder="Qtd" id="ci-qtd-${i}" value="1" min="0.01" step="0.01"
      style="padding:6px 8px;border:1px solid #e2e8f0;border-radius:5px;font-size:11px;width:100%;box-sizing:border-box">
    <input type="number" placeholder="Vlr Unit." id="ci-val-${i}" min="0" step="0.01"
      style="padding:6px 8px;border:1px solid #e2e8f0;border-radius:5px;font-size:11px;width:100%;box-sizing:border-box">
    <button onclick="document.getElementById('compras-item-${i}').remove()"
      style="padding:4px 8px;background:#fee2e2;color:#dc2626;border:1px solid #fca5a5;border-radius:4px;cursor:pointer;font-size:12px">✕</button>
  `;
  wrap.appendChild(div);
}

async function salvarComprasRequisicao() {
  const titulo = document.getElementById('compras-titulo')?.value?.trim();
  if (!titulo) { toast('Preencha o título', 'error'); return; }

  // Coletar itens
  const itens = [];
  document.querySelectorAll('[id^="compras-item-"]').forEach(div => {
    const idx = div.id.split('-')[2];
    const desc = document.getElementById(`ci-desc-${idx}`)?.value?.trim();
    if (!desc) return;
    itens.push({
      descricao: desc,
      unidade: document.getElementById(`ci-un-${idx}`)?.value || 'un',
      quantidade: parseFloat(document.getElementById(`ci-qtd-${idx}`)?.value) || 1,
      valor_unitario_est: parseFloat(document.getElementById(`ci-val-${idx}`)?.value) || null,
    });
  });

  const body = {
    titulo,
    solicitante:    document.getElementById('compras-solicitante')?.value || '',
    contrato_ref:   document.getElementById('compras-contrato-ref')?.value || '',
    prioridade:     document.getElementById('compras-prioridade')?.value || 'NORMAL',
    descricao:      document.getElementById('compras-descricao')?.value || '',
    valor_estimado: parseFloat(document.getElementById('compras-val-est')?.value) || null,
    data_necessidade: document.getElementById('compras-data-nec')?.value || '',
    itens,
  };

  try {
    showLoading('Salvando requisição…');
    const r = await api('/compras/requisicoes', { method: 'POST', body: JSON.stringify(body) });
    hideLoading();
    if (r.ok) {
      toast('Requisição criada com sucesso!');
      comprasSubTab('requisicoes');
    } else {
      toast(r.error || 'Erro ao salvar', 'error');
    }
  } catch(e) {
    hideLoading();
    toast('Erro ao salvar requisição', 'error');
  }
}

// ── Modal Detalhe Requisição ─────────────────────────────────

async function abrirDetalheRequisicao(id) {
  _comprasReqId = id;
  try {
    showLoading('Carregando requisição…');
    const data = await api('/compras/requisicoes/' + id);
    hideLoading();

    document.getElementById('modal-compras-titulo').textContent = '📋 ' + data.titulo;
    document.getElementById('modal-compras-meta').textContent =
      `Solicitante: ${data.solicitante || '—'} · ${data.prioridade} · ${data.status} · Criada: ${(data.created_at || '').substring(0, 10)}`;

    // Preencher status atual
    const statusEl = document.getElementById('mcd-novo-status');
    if (statusEl) statusEl.value = data.status;
    const valAprovEl = document.getElementById('mcd-val-aprov');
    if (valAprovEl) valAprovEl.value = data.valor_aprovado || '';
    const fornEl = document.getElementById('mcd-forn-esc');
    if (fornEl) fornEl.value = data.fornecedor_escolhido || '';

    // Itens
    const iHead = document.getElementById('mcd-itens-head');
    const iBody = document.getElementById('mcd-itens-body');
    if (iHead) iHead.innerHTML = '<tr><th>Descrição</th><th>Unid.</th><th>Qtd</th><th>Vlr Unit. Est.</th><th>Subtotal Est.</th></tr>';
    if (iBody) iBody.innerHTML = (data.itens || []).map(it => `
      <tr>
        <td>${it.descricao}</td>
        <td style="text-align:center">${it.unidade || 'un'}</td>
        <td style="text-align:center">${it.quantidade}</td>
        <td style="text-align:right">${_brl(it.valor_unitario_est)}</td>
        <td style="text-align:right">${it.valor_unitario_est ? _brl(it.quantidade * it.valor_unitario_est) : '—'}</td>
      </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:16px">Nenhum item</td></tr>';

    // Cotações
    renderMcdCotacoes(data.cotacoes || []);

    mcdTab('itens');
    const modal = document.getElementById('modal-compras-detalhe');
    if (modal) modal.style.display = 'flex';
  } catch(e) {
    hideLoading();
    toast('Erro ao carregar requisição', 'error');
  }
}

function renderMcdCotacoes(cotacoes) {
  const cHead = document.getElementById('mcd-cot-head');
  const cBody = document.getElementById('mcd-cot-body');
  if (cHead) cHead.innerHTML = '<tr><th>Fornecedor</th><th>CNPJ/CPF</th><th>Valor Total</th><th>Prazo</th><th>Obs.</th><th>Ação</th></tr>';
  if (cBody) cBody.innerHTML = cotacoes.map(c => `
    <tr style="${c.escolhida ? 'background:#f0fdf4;' : ''}">
      <td style="font-weight:${c.escolhida ? '700' : '400'}">${c.fornecedor}${c.escolhida ? ' ✅' : ''}</td>
      <td>${c.cnpj_cpf || '—'}</td>
      <td style="text-align:right;font-weight:600">${_brl(c.valor_total)}</td>
      <td>${c.prazo_entrega || '—'}</td>
      <td>${c.observacoes || '—'}</td>
      <td>${c.escolhida ? '<span style="font-size:10px;color:#15803d;font-weight:700">Escolhida</span>' :
        `<button onclick="escolherCotacao(${c.id})" style="padding:3px 8px;font-size:10px;background:#dcfce7;color:#15803d;border:1px solid #86efac;border-radius:4px;cursor:pointer;font-weight:600">✔ Escolher</button>`}
      </td>
    </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:16px">Nenhuma cotação</td></tr>';
}

function mcdTab(tab) {
  ['itens', 'cotacoes', 'status'].forEach(t => {
    const panel = document.getElementById('mcd-panel-' + t);
    const btn   = document.getElementById('mcd-tab-' + t);
    if (panel) panel.style.display = t === tab ? '' : 'none';
    if (btn) {
      btn.style.color        = t === tab ? '#0d6efd' : '#64748b';
      btn.style.borderBottom = t === tab ? '2px solid #0d6efd' : '2px solid transparent';
    }
  });
}

function abrirFormCotacao() {
  const form = document.getElementById('mcd-form-cotacao');
  if (form) {
    form.style.display = '';
    ['cot-fornecedor','cot-cnpj','cot-prazo','cot-obs'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const valEl = document.getElementById('cot-valor');
    if (valEl) valEl.value = '';
  }
}

async function salvarCotacao() {
  const fornecedor = document.getElementById('cot-fornecedor')?.value?.trim();
  if (!fornecedor) { toast('Preencha o fornecedor', 'error'); return; }

  const body = {
    requisicao_id: _comprasReqId,
    fornecedor,
    cnpj_cpf:    document.getElementById('cot-cnpj')?.value   || '',
    valor_total: parseFloat(document.getElementById('cot-valor')?.value) || null,
    prazo_entrega: document.getElementById('cot-prazo')?.value || '',
    observacoes: document.getElementById('cot-obs')?.value     || '',
  };

  try {
    showLoading('Salvando cotação…');
    const r = await api('/compras/cotacoes', { method: 'POST', body: JSON.stringify(body) });
    hideLoading();
    if (r.ok) {
      toast('Cotação salva!');
      document.getElementById('mcd-form-cotacao').style.display = 'none';
      // Recarregar cotações
      const data = await api('/compras/requisicoes/' + _comprasReqId);
      renderMcdCotacoes(data.cotacoes || []);
    } else {
      toast(r.error || 'Erro ao salvar', 'error');
    }
  } catch(e) {
    hideLoading();
    toast('Erro ao salvar cotação', 'error');
  }
}

async function escolherCotacao(cotId) {
  try {
    showLoading('Definindo fornecedor…');
    const r = await api('/compras/cotacoes/' + cotId + '/escolher', { method: 'PUT', body: '{}' });
    hideLoading();
    if (r.ok) {
      toast('Fornecedor escolhido!');
      const data = await api('/compras/requisicoes/' + _comprasReqId);
      renderMcdCotacoes(data.cotacoes || []);
      const fornEl = document.getElementById('mcd-forn-esc');
      if (fornEl) fornEl.value = data.fornecedor_escolhido || '';
      const statusEl = document.getElementById('mcd-novo-status');
      if (statusEl) statusEl.value = data.status;
    } else {
      toast(r.error || 'Erro', 'error');
    }
  } catch(e) {
    hideLoading();
    toast('Erro ao escolher cotação', 'error');
  }
}

async function atualizarStatusRequisicao() {
  if (!_comprasReqId) return;
  const body = {
    status:               document.getElementById('mcd-novo-status')?.value,
    valor_aprovado:       parseFloat(document.getElementById('mcd-val-aprov')?.value) || null,
    fornecedor_escolhido: document.getElementById('mcd-forn-esc')?.value || '',
  };

  try {
    showLoading('Atualizando…');
    const r = await api('/compras/requisicoes/' + _comprasReqId, { method: 'PUT', body: JSON.stringify(body) });
    hideLoading();
    if (r.ok) {
      toast('Requisição atualizada!');
      document.getElementById('modal-compras-detalhe').style.display = 'none';
      loadComprasRequisicoes();
    } else {
      toast(r.error || 'Erro', 'error');
    }
  } catch(e) {
    hideLoading();
    toast('Erro ao atualizar', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
// SUPERVISOR OPERACIONAL
// ═══════════════════════════════════════════════════════════════

const SUP_CHECKLIST_ITENS_PADRAO = [
  'Efetivo completo no posto',
  'EPIs verificados e em bom estado',
  'Equipamentos funcionando corretamente',
  'Ronda realizada no turno',
  'Ocorrências registradas no livro',
  'Comunicação com cliente realizada',
];

window.supervisorInit = function() {
  supSubTab('dashboard');
};

function supShowView(view) {
  supSubTab(view);
}

function supSubTab(tab) {
  ['dashboard', 'ocorrencias', 'checklist'].forEach(t => {
    const panel = document.getElementById('sup-panel-' + t);
    const btn   = document.getElementById('sup-tab-' + t);
    if (panel) panel.style.display = t === tab ? '' : 'none';
    if (btn) {
      btn.style.color        = t === tab ? '#0d6efd' : '#64748b';
      btn.style.borderBottom = t === tab ? '2px solid #0d6efd' : '2px solid transparent';
    }
  });
  if (tab === 'dashboard')   loadSupDashboard();
  if (tab === 'ocorrencias') loadSupOcorrencias();
  if (tab === 'checklist')   initChecklistForm();
}

async function loadSupDashboard() {
  try {
    const data = await api('/supervisor/dashboard');

    // KPIs
    const kpis = [
      { label: 'Ocorrências Abertas', value: data.total_abertas || 0,      icon: '🔴', color: '#fee2e2', border: '#dc2626' },
      { label: 'Ocorrências Hoje',    value: data.ocorrencias_hoje || 0,   icon: '📅', color: '#fef3c7', border: '#d97706' },
      { label: 'Checklists Hoje',     value: data.checklists_hoje || 0,    icon: '✅', color: '#dcfce7', border: '#15803d' },
      { label: 'Contratos c/ Aberta', value: (data.abertas_por_contrato || []).length, icon: '📋', color: '#dbeafe', border: '#1d4ed8' },
    ];
    const kpisEl = document.getElementById('sup-kpis');
    if (kpisEl) {
      kpisEl.innerHTML = kpis.map(k => `
        <div class="kpi" style="border-left:4px solid ${k.border};background:${k.color}">
          <div style="font-size:22px">${k.icon}</div>
          <div>
            <div class="kpi-val">${k.value.toLocaleString('pt-BR')}</div>
            <div class="kpi-lbl">${k.label}</div>
          </div>
        </div>`).join('');
    }

    // Tabela ocorrências recentes
    const head = document.getElementById('sup-rec-head');
    const body = document.getElementById('sup-rec-body');
    if (head) head.innerHTML = '<tr><th>Data</th><th>Tipo</th><th>Contrato</th><th>Descrição</th><th>Status</th></tr>';
    if (body) body.innerHTML = (data.recentes || []).map(o => `
      <tr style="cursor:pointer" onclick="abrirEditarOcorrencia(${o.id})">
        <td>${o.data_ocorrencia_iso || o.data_ocorrencia || '—'}</td>
        <td>${_badge(o.tipo, SUP_TIPO_CORES[o.tipo] || SUP_TIPO_CORES.OUTRO)}</td>
        <td>${o.contrato_ref || '—'}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${o.descricao}</td>
        <td>${_badge(o.status, SUP_STATUS_CORES[o.status] || SUP_STATUS_CORES.ABERTA)}</td>
      </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:20px">Nenhuma ocorrência</td></tr>';

    // Gráfico abertas por contrato
    const chartEl = document.getElementById('sup-por-contrato-chart');
    if (chartEl) {
      const abertas = data.abertas_por_contrato || [];
      const max = Math.max(1, ...abertas.map(r => r.total));
      if (!abertas.length) {
        chartEl.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:30px;font-size:12px">✅ Nenhuma ocorrência aberta</div>';
      } else {
        chartEl.innerHTML = abertas.map(r => {
          const pct = Math.round((r.total / max) * 100);
          return `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:11px">
              <div style="width:120px;color:#475569;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.contrato_ref || 'Sem contrato'}">${r.contrato_ref || '(sem contrato)'}</div>
              <div style="flex:1;background:#f1f5f9;border-radius:4px;height:16px">
                <div style="width:${pct}%;background:#dc2626;height:16px;border-radius:4px;min-width:4px"></div>
              </div>
              <div style="width:24px;text-align:right;font-weight:700;color:#dc2626">${r.total}</div>
            </div>`;
        }).join('');
      }
    }
  } catch(e) { console.error('sup dashboard', e); }
}

async function loadSupOcorrencias() {
  try {
    const status = document.getElementById('sup-filtro-status')?.value || '';
    const tipo   = document.getElementById('sup-filtro-tipo')?.value   || '';
    const de     = document.getElementById('sup-filtro-de')?.value     || '';
    const ate    = document.getElementById('sup-filtro-ate')?.value    || '';
    let url = '/supervisor/ocorrencias?';
    if (status) url += `status=${encodeURIComponent(status)}&`;
    if (tipo)   url += `tipo=${encodeURIComponent(tipo)}&`;
    if (de)     url += `de=${encodeURIComponent(de)}&`;
    if (ate)    url += `ate=${encodeURIComponent(ate)}&`;

    const data = await api(url);
    const head = document.getElementById('sup-oc-head');
    const body = document.getElementById('sup-oc-body');

    if (head) head.innerHTML = `<tr>
      <th>#</th><th>Data</th><th>Tipo</th><th>Contrato</th><th>Posto</th>
      <th>Funcionário</th><th>Descrição</th><th>Status</th><th>Ações</th>
    </tr>`;

    if (body) body.innerHTML = (data.data || []).map(o => `
      <tr>
        <td>${o.id}</td>
        <td>${o.data_ocorrencia_iso || o.data_ocorrencia || '—'}</td>
        <td>${_badge(o.tipo, SUP_TIPO_CORES[o.tipo] || SUP_TIPO_CORES.OUTRO)}</td>
        <td>${o.contrato_ref || '—'}</td>
        <td>${o.posto || '—'}</td>
        <td>${o.funcionario_nome || '—'}</td>
        <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${o.descricao}</td>
        <td>${_badge(o.status, SUP_STATUS_CORES[o.status] || SUP_STATUS_CORES.ABERTA)}</td>
        <td>
          <button onclick="abrirEditarOcorrencia(${o.id})" style="padding:3px 10px;font-size:10px;background:#dbeafe;color:#1d4ed8;border:1px solid #93c5fd;border-radius:4px;cursor:pointer;font-weight:600">Editar</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="9" style="text-align:center;color:#94a3b8;padding:24px">Nenhuma ocorrência</td></tr>';
  } catch(e) { console.error('loadSupOcorrencias', e); }
}

// ── Modal Ocorrência ─────────────────────────────────────────

let _ocorrenciaEditData = null;

function abrirModalOcorrencia() {
  _ocorrenciaEditData = null;
  document.getElementById('modal-oc-titulo').textContent = '⚠️ Registrar Ocorrência';
  document.getElementById('oc-edit-id').value = '';
  ['oc-contrato','oc-posto','oc-funcionario','oc-descricao','oc-resolucao'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const tipo = document.getElementById('oc-tipo');
  if (tipo) tipo.value = 'FALTA';
  const status = document.getElementById('oc-status-modal');
  if (status) status.value = 'ABERTA';
  const data = document.getElementById('oc-data');
  if (data) data.value = new Date().toISOString().substring(0, 10);
  const resolWrap = document.getElementById('oc-resolucao-wrap');
  if (resolWrap) resolWrap.style.display = 'none';
  const modal = document.getElementById('modal-ocorrencia');
  if (modal) modal.style.display = 'flex';
}

async function abrirEditarOcorrencia(id) {
  try {
    showLoading('Carregando ocorrência…');
    const data = await api('/supervisor/ocorrencias?status=&tipo=');
    // Buscar a ocorrência específica nos dados retornados
    const allData = await api('/supervisor/ocorrencias');
    hideLoading();
    const oc = (allData.data || []).find(o => o.id === id);
    if (!oc) { toast('Ocorrência não encontrada', 'error'); return; }

    _ocorrenciaEditData = oc;
    document.getElementById('modal-oc-titulo').textContent = '✏️ Editar Ocorrência #' + oc.id;
    document.getElementById('oc-edit-id').value = oc.id;

    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
    setVal('oc-contrato', oc.contrato_ref);
    setVal('oc-posto', oc.posto);
    setVal('oc-funcionario', oc.funcionario_nome);
    setVal('oc-descricao', oc.descricao);
    setVal('oc-resolucao', oc.resolucao);
    setVal('oc-data', oc.data_ocorrencia_iso || oc.data_ocorrencia);

    const tipo = document.getElementById('oc-tipo');
    if (tipo) tipo.value = oc.tipo || 'OUTRO';
    const status = document.getElementById('oc-status-modal');
    if (status) status.value = oc.status || 'ABERTA';

    const resolWrap = document.getElementById('oc-resolucao-wrap');
    if (resolWrap) resolWrap.style.display = oc.status === 'RESOLVIDA' ? '' : 'none';

    const modal = document.getElementById('modal-ocorrencia');
    if (modal) modal.style.display = 'flex';
  } catch(e) {
    hideLoading();
    toast('Erro ao carregar ocorrência', 'error');
  }
}

// Mostrar/ocultar campo resolução quando status muda
document.addEventListener('change', e => {
  if (e.target && e.target.id === 'oc-status-modal') {
    const resolWrap = document.getElementById('oc-resolucao-wrap');
    if (resolWrap) resolWrap.style.display = e.target.value === 'RESOLVIDA' ? '' : 'none';
  }
});

function fecharModalOcorrencia() {
  const modal = document.getElementById('modal-ocorrencia');
  if (modal) modal.style.display = 'none';
}

async function salvarOcorrencia() {
  const descricao = document.getElementById('oc-descricao')?.value?.trim();
  if (!descricao) { toast('Preencha a descrição', 'error'); return; }

  const editId = document.getElementById('oc-edit-id')?.value;
  const dataVal = document.getElementById('oc-data')?.value || '';
  const body = {
    contrato_ref:       document.getElementById('oc-contrato')?.value || '',
    posto:              document.getElementById('oc-posto')?.value || '',
    tipo:               document.getElementById('oc-tipo')?.value || 'OUTRO',
    status:             document.getElementById('oc-status-modal')?.value || 'ABERTA',
    descricao,
    funcionario_nome:   document.getElementById('oc-funcionario')?.value || '',
    data_ocorrencia:    dataVal,
    data_ocorrencia_iso: dataVal,
    resolucao:          document.getElementById('oc-resolucao')?.value || '',
  };

  try {
    showLoading('Salvando…');
    let r;
    if (editId) {
      r = await api('/supervisor/ocorrencias/' + editId, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      r = await api('/supervisor/ocorrencias', { method: 'POST', body: JSON.stringify(body) });
    }
    hideLoading();
    if (r.ok) {
      toast(editId ? 'Ocorrência atualizada!' : 'Ocorrência registrada!');
      fecharModalOcorrencia();
      loadSupOcorrencias();
      loadSupDashboard();
    } else {
      toast(r.error || 'Erro ao salvar', 'error');
    }
  } catch(e) {
    hideLoading();
    toast('Erro ao salvar ocorrência', 'error');
  }
}

// ── Checklist ────────────────────────────────────────────────

function initChecklistForm() {
  const dataEl = document.getElementById('sup-cl-data');
  if (dataEl && !dataEl.value) dataEl.value = new Date().toISOString().substring(0, 10);

  const itensEl = document.getElementById('sup-cl-itens');
  if (itensEl && !itensEl.innerHTML.trim()) {
    renderChecklistItens(SUP_CHECKLIST_ITENS_PADRAO.map(item => ({ item, ok: false, obs: '' })));
  }

  const antEl = document.getElementById('sup-cl-anteriores');
  if (antEl) antEl.style.display = 'none';
}

function renderChecklistItens(itens) {
  const el = document.getElementById('sup-cl-itens');
  if (!el) return;
  el.innerHTML = itens.map((it, i) => `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:${it.ok ? '#f0fdf4' : '#fff'};border:1px solid ${it.ok ? '#86efac' : '#e2e8f0'};border-radius:8px" id="cl-item-${i}">
      <button onclick="toggleClItem(${i})" style="width:28px;height:28px;border-radius:50%;border:2px solid ${it.ok ? '#15803d' : '#e2e8f0'};background:${it.ok ? '#15803d' : '#fff'};color:${it.ok ? '#fff' : '#94a3b8'};font-size:14px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center">
        ${it.ok ? '✓' : ''}
      </button>
      <span style="flex:1;font-size:12px;font-weight:600;color:#0f172a">${it.item}</span>
      <input type="text" value="${it.obs || ''}" placeholder="Obs…" oninput="updateClItemObs(${i}, this.value)"
        style="width:180px;padding:5px 8px;border:1px solid #e2e8f0;border-radius:5px;font-size:11px">
    </div>`).join('');
  // Store itens state on element
  el._itens = itens;
}

function toggleClItem(i) {
  const el = document.getElementById('sup-cl-itens');
  if (!el || !el._itens) return;
  el._itens[i].ok = !el._itens[i].ok;
  renderChecklistItens(el._itens);
}

function updateClItemObs(i, val) {
  const el = document.getElementById('sup-cl-itens');
  if (!el || !el._itens) return;
  el._itens[i].obs = val;
}

async function salvarChecklist() {
  const itensEl = document.getElementById('sup-cl-itens');
  const itens = itensEl?._itens || SUP_CHECKLIST_ITENS_PADRAO.map(item => ({ item, ok: false, obs: '' }));
  const dataVal = document.getElementById('sup-cl-data')?.value || new Date().toISOString().substring(0, 10);

  const body = {
    contrato_ref: document.getElementById('sup-cl-contrato')?.value || '',
    posto:        document.getElementById('sup-cl-posto')?.value    || '',
    data_iso:     dataVal,
    turno:        document.getElementById('sup-cl-turno')?.value    || 'DIURNO',
    supervisor:   document.getElementById('sup-cl-supervisor')?.value || '',
    itens_json:   JSON.stringify(itens),
    observacoes:  document.getElementById('sup-cl-obs')?.value      || '',
  };

  try {
    showLoading('Salvando checklist…');
    const r = await api('/supervisor/checklist', { method: 'POST', body: JSON.stringify(body) });
    hideLoading();
    if (r.ok) {
      toast('Checklist salvo!');
      // Resetar estado dos itens
      renderChecklistItens(SUP_CHECKLIST_ITENS_PADRAO.map(item => ({ item, ok: false, obs: '' })));
      document.getElementById('sup-cl-obs').value = '';
    } else {
      toast(r.error || 'Erro ao salvar', 'error');
    }
  } catch(e) {
    hideLoading();
    toast('Erro ao salvar checklist', 'error');
  }
}

async function loadChecklistsAnteriores() {
  const antEl = document.getElementById('sup-cl-anteriores');
  if (!antEl) return;
  antEl.style.display = '';

  try {
    const data = await api('/supervisor/checklist');
    const head = document.getElementById('sup-cl-hist-head');
    const body = document.getElementById('sup-cl-hist-body');

    if (head) head.innerHTML = '<tr><th>Data</th><th>Turno</th><th>Contrato</th><th>Posto</th><th>Supervisor</th><th>OK/Total</th><th>Obs.</th></tr>';
    if (body) body.innerHTML = (data.data || []).map(cl => {
      let itens = [];
      try { itens = JSON.parse(cl.itens_json || '[]'); } catch(_) {}
      const ok    = itens.filter(i => i.ok).length;
      const total = itens.length;
      return `
        <tr>
          <td>${cl.data_iso || '—'}</td>
          <td>${cl.turno === 'NOTURNO' ? '🌙 Noturno' : '☀️ Diurno'}</td>
          <td>${cl.contrato_ref || '—'}</td>
          <td>${cl.posto || '—'}</td>
          <td>${cl.supervisor || '—'}</td>
          <td style="text-align:center"><span style="font-weight:700;color:${ok===total?'#15803d':'#d97706'}">${ok}/${total}</span></td>
          <td>${cl.observacoes || '—'}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:16px">Nenhum checklist salvo</td></tr>';
  } catch(e) { console.error('loadChecklistsAnteriores', e); }
}
