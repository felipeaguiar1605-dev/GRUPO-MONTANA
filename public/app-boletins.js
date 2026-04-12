// ═══════════════════════════════════════════════════════════════
// MÓDULO DE BOLETINS DE MEDIÇÃO
// Estende showTab e implementa gestão de contratos + geração de PDFs
// ═══════════════════════════════════════════════════════════════

(function() {
  const _orig = window.showTab;
  window.showTab = function(id, el) {
    _orig(id, el);
    if (id === 'boletins') loadBoletinsTab();
  };
})();

let _bolContratos = [];
let _bolContratoSelecionado = null;
let _bolView = 'lista'; // 'lista' | 'contrato' | 'gerar'

// ─── TAB LOAD ─────────────────────────────────────────────────

async function loadBoletinsTab() {
  await loadBolContratos();
  if (_bolView === 'lista') renderBolLista();
  // Margem por posto (app-extras.js)
  if (typeof loadMargemPorPosto === 'function') loadMargemPorPosto();
}

// ─── CONTRATOS ────────────────────────────────────────────────

async function loadBolContratos() {
  _bolContratos = await api('/boletins/contratos');
  if (!Array.isArray(_bolContratos)) _bolContratos = [];
}

function renderBolLista() {
  _bolView = 'lista';
  const container = document.getElementById('bol-content');

  // KPIs
  const ativos = _bolContratos.filter(c => c.ativo).length;
  let kpisHtml = `
    <div class="kpi-row" style="margin-bottom:16px">
      <div class="kpi-card" style="border-left:4px solid #2563eb">
        <div class="kpi-v" style="color:#1d4ed8">${_bolContratos.length}</div>
        <div class="kpi-l">Contratos Cadastrados</div>
      </div>
      <div class="kpi-card" style="border-left:4px solid #22c55e">
        <div class="kpi-v" style="color:#15803d">${ativos}</div>
        <div class="kpi-l">Ativos</div>
      </div>
    </div>
  `;

  // Tabela de contratos
  let tableHtml = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h3 style="margin:0;font-size:16px">📋 Contratos de Vigilância</h3>
      <button class="btn btn-primary" onclick="bolNovoContrato()">+ Novo Contrato</button>
    </div>
    <table class="tbl">
      <thead><tr>
        <th>Nome</th><th>Contratante</th><th>Nº Contrato</th><th>Postos</th><th>Status</th><th>Ações</th>
      </tr></thead>
      <tbody>
  `;

  if (_bolContratos.length === 0) {
    tableHtml += `<tr><td colspan="6">
      <div style="text-align:center;padding:30px 20px">
        <div style="font-size:32px;margin-bottom:8px">📋</div>
        <div style="font-weight:700;color:#334155;margin-bottom:4px">Nenhum contrato de boletim cadastrado</div>
        <div style="font-size:12px;color:#94a3b8;margin-bottom:16px">Cadastre manualmente ou inicialize a partir dos contratos financeiros existentes</div>
        <button onclick="bolInicializarDeContratos()" style="padding:8px 20px;font-size:12px;font-weight:700;background:#7c2d12;color:#fff;border:none;border-radius:6px;cursor:pointer">🚀 Inicializar a partir dos Contratos Financeiros</button>
      </div>
    </td></tr>`;
  }

  for (const c of _bolContratos) {
    const statusBadge = c.ativo
      ? '<span class="badge badge-ok">Ativo</span>'
      : '<span class="badge badge-warn">Inativo</span>';
    tableHtml += `<tr>
      <td><a href="#" onclick="bolAbrirContrato(${c.id});return false" style="color:#2563eb;font-weight:600">${c.nome}</a></td>
      <td>${c.contratante}</td>
      <td>${c.numero_contrato}</td>
      <td style="text-align:center">—</td>
      <td>${statusBadge}</td>
      <td>
        <button class="btn btn-sm" onclick="bolGerarBoletim(${c.id})" title="Gerar Boletim">📄 Gerar</button>
        <button class="btn btn-sm" onclick="bolAbrirContrato(${c.id})" title="Editar">✏️</button>
        <button class="btn btn-sm btn-danger" onclick="bolDeletarContrato(${c.id})" title="Excluir">🗑️</button>
      </td>
    </tr>`;
  }

  tableHtml += '</tbody></table>';

  // Histórico recente
  let histHtml = `
    <div style="margin-top:24px">
      <h3 style="font-size:16px">📜 Histórico de Boletins Gerados</h3>
      <div id="bol-historico">Carregando...</div>
    </div>
  `;

  container.innerHTML = kpisHtml + tableHtml + histHtml;
  loadBolHistorico();
}

async function loadBolHistorico() {
  const hist = await api('/boletins/historico');
  const el = document.getElementById('bol-historico');
  if (!el) return;

  if (!Array.isArray(hist) || hist.length === 0) {
    el.innerHTML = '<p style="color:#94a3b8;text-align:center;padding:20px">Nenhum boletim gerado ainda.</p>';
    return;
  }

  const statusBolMap = {
    'conciliado_nf': ['✅ Conciliado', '#dcfce7', '#15803d'],
    'divergencia_nf': ['⚠️ Divergência', '#fef9c3', '#854d0e'],
    'sem_nf': ['❌ Sem NF', '#fee2e2', '#b91c1c'],
    'pendente': ['⏳ Pendente', '#f1f5f9', '#475569'],
    'aprovado': ['✅ Aprovado', '#dcfce7', '#15803d'],
  };
  function bolStatusBadge(st) {
    const [label, bg, color] = statusBolMap[st] || ['⏳ Pendente', '#f1f5f9', '#475569'];
    return `<span style="background:${bg};color:${color};padding:2px 8px;border-radius:9px;font-size:11px;font-weight:600;white-space:nowrap">${label}</span>`;
  }

  let html = '<table class="tbl"><thead><tr><th>Contrato</th><th>Competência</th><th>Total Boletim</th><th>NFs vinculadas</th><th>Status</th><th>Data Emissão</th></tr></thead><tbody>';
  // Agrupar por competencia para facilitar visualização
  const byComp = {};
  for (const b of hist) {
    const k = b.competencia;
    if (!byComp[k]) byComp[k] = [];
    byComp[k].push(b);
  }
  const comps = Object.keys(byComp).sort().reverse();
  for (const comp of comps) {
    const grupo = byComp[comp];
    const totalGrupo = grupo.reduce((s,b) => s + (b.total_geral||0), 0);
    const totalNfs = grupo.reduce((s,b) => s + (b.nfs?.length||0), 0);
    const okCount = grupo.filter(b=>b.status==='conciliado_nf'||b.status==='aprovado').length;
    const divCount = grupo.filter(b=>b.status==='divergencia_nf').length;
    const semCount = grupo.filter(b=>b.status==='sem_nf').length;
    const grpStatus = semCount > 0 && okCount === 0 ? 'sem_nf' : divCount > 0 ? 'divergencia_nf' : 'conciliado_nf';
    html += `<tr style="background:#f8fafc;font-weight:600">
      <td colspan="2" style="padding-left:8px">📅 ${comp} — ${grupo.length} contratos</td>
      <td style="font-weight:700">${brl(totalGrupo)}</td>
      <td>${totalNfs} NFs</td>
      <td>${bolStatusBadge(grpStatus)} <small style="color:#64748b">${okCount}✅ ${divCount}⚠️ ${semCount}❌</small></td>
      <td></td>
    </tr>`;
    for (const b of grupo) {
      html += `<tr>
        <td style="padding-left:24px">${b.contrato_nome}</td>
        <td>${b.competencia}</td>
        <td>${brl(b.total_geral)}</td>
        <td>${b.nfs ? b.nfs.length : 0} NFs</td>
        <td>${bolStatusBadge(b.status)}</td>
        <td style="font-size:11px;color:#64748b">${b.data_emissao||'—'}</td>
      </tr>`;
    }
  }
  html += '</tbody></table>';
  el.innerHTML = html;
}

// ─── ABRIR CONTRATO (DETALHES + POSTOS + ITENS) ──────────────

async function bolAbrirContrato(id) {
  _bolView = 'contrato';
  const data = await api('/boletins/contratos/' + id);
  if (data.error) { toast(data.error, 'error'); return; }
  _bolContratoSelecionado = data;

  const container = document.getElementById('bol-content');
  let html = `
    <button class="btn" onclick="renderBolLista()" style="margin-bottom:12px">← Voltar</button>
    <h3 style="margin:0 0 16px 0">Contrato: ${data.nome} — ${data.numero_contrato}</h3>

    <div class="card" style="padding:16px;margin-bottom:16px">
      <h4 style="margin:0 0 12px 0">Dados do Contrato</h4>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:13px">
        <div><strong>Contratante:</strong> ${data.contratante}</div>
        <div><strong>Nº Contrato:</strong> ${data.numero_contrato}</div>
        <div><strong>Processo:</strong> ${data.processo}</div>
        <div><strong>Pregão:</strong> ${data.pregao}</div>
        <div><strong>Escala:</strong> ${data.escala}</div>
        <div><strong>Empresa:</strong> ${data.empresa_razao} (${data.empresa_cnpj})</div>
      </div>
      <button class="btn btn-sm" onclick="bolEditarContrato(${data.id})" style="margin-top:10px">✏️ Editar Dados</button>
    </div>

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <h4 style="margin:0">Postos / Campi (${(data.postos||[]).length})</h4>
      <button class="btn btn-primary btn-sm" onclick="bolNovoPosto(${data.id})">+ Novo Posto</button>
    </div>
  `;

  if (!data.postos || data.postos.length === 0) {
    html += '<p style="color:#94a3b8;text-align:center;padding:20px">Nenhum posto cadastrado.</p>';
  }

  for (const posto of (data.postos || [])) {
    let totalPosto = 0;
    let itensHtml = '';
    for (const item of (posto.itens || [])) {
      const vt = item.quantidade * item.valor_unitario;
      totalPosto += vt;
      itensHtml += `<tr>
        <td>${item.descricao}</td>
        <td style="text-align:center">${item.quantidade}</td>
        <td style="text-align:right">${brl(item.valor_unitario)}</td>
        <td style="text-align:right;font-weight:600">${brl(vt)}</td>
        <td>
          <button class="btn btn-xs" onclick="bolEditarItem(${item.id},${data.id})">✏️</button>
          <button class="btn btn-xs btn-danger" onclick="bolDeletarItem(${item.id},${data.id})">🗑️</button>
        </td>
      </tr>`;
    }

    html += `
      <div class="card" style="padding:14px;margin-bottom:12px;border-left:4px solid #2563eb">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div>
            <strong style="font-size:14px">${posto.campus_nome}</strong>
            <span style="color:#64748b;font-size:12px;margin-left:8px">${posto.municipio}</span>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-xs" onclick="bolNovoItem(${posto.id},${data.id})">+ Item</button>
            <button class="btn btn-xs" onclick="bolEditarPosto(${posto.id},${data.id})">✏️</button>
            <button class="btn btn-xs btn-danger" onclick="bolDeletarPosto(${posto.id},${data.id})">🗑️</button>
          </div>
        </div>
        <p style="font-size:12px;color:#64748b;margin:0 0 8px 0">${posto.descricao_posto}</p>
        <table class="tbl" style="font-size:12px">
          <thead><tr><th>Descrição</th><th>Qtd.</th><th>Valor Unitário</th><th>Valor Total</th><th></th></tr></thead>
          <tbody>${itensHtml}</tbody>
          <tfoot><tr><td colspan="3" style="text-align:right;font-weight:700">TOTAL DO POSTO:</td><td style="text-align:right;font-weight:700">${brl(totalPosto)}</td><td></td></tr></tfoot>
        </table>
      </div>
    `;
  }

  container.innerHTML = html;
}

// ─── GERAR BOLETIM ────────────────────────────────────────────

async function bolGerarBoletim(contratoId) {
  _bolView = 'gerar';
  const data = await api('/boletins/contratos/' + contratoId);
  if (data.error) { toast(data.error, 'error'); return; }

  const container = document.getElementById('bol-content');
  let html = `
    <button class="btn" onclick="renderBolLista()" style="margin-bottom:12px">← Voltar</button>
    <h3 style="margin:0 0 16px 0">Gerar Boletim — ${data.nome} (${data.numero_contrato})</h3>
    <div class="card" style="padding:20px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
        <div>
          <label style="font-weight:600;font-size:13px">Competência (ex: março 2026)</label>
          <input type="text" id="bol-competencia" placeholder="março 2026" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px">
        </div>
        <div>
          <label style="font-weight:600;font-size:13px">Data de Emissão das NFs</label>
          <input type="text" id="bol-data-emissao" placeholder="27/03/2026" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px">
        </div>
      </div>
      <h4 style="margin:0 0 12px 0">Notas Fiscais por Posto</h4>
  `;

  for (const posto of (data.postos || [])) {
    html += `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
        <label style="min-width:250px;font-size:13px;font-weight:500">${posto.campus_nome} (${posto.municipio})</label>
        <input type="text" id="bol-nf-${posto.id}" placeholder="Nº da NF" style="padding:8px;border:1px solid #d1d5db;border-radius:6px;width:120px">
      </div>
    `;
  }

  html += `
      <div style="margin-top:20px;display:flex;gap:8px">
        <button class="btn btn-primary" onclick="bolExecutarGeracao(${contratoId})" id="bol-btn-gerar">
          📄 Gerar Boletins (PDFs)
        </button>
        <button class="btn" onclick="renderBolLista()">Cancelar</button>
      </div>
      <div id="bol-resultado" style="margin-top:16px"></div>
    </div>
  `;

  container.innerHTML = html;
}

async function bolExecutarGeracao(contratoId) {
  const competencia = document.getElementById('bol-competencia').value.trim();
  const dataEmissao = document.getElementById('bol-data-emissao').value.trim();

  if (!competencia || !dataEmissao) {
    toast('Preencha competência e data de emissão', 'error');
    return;
  }

  // Coletar NFs
  const data = await api('/boletins/contratos/' + contratoId);
  const notas_fiscais = [];
  for (const posto of (data.postos || [])) {
    const nfInput = document.getElementById('bol-nf-' + posto.id);
    if (nfInput && nfInput.value.trim()) {
      notas_fiscais.push({ posto_id: posto.id, nf_numero: nfInput.value.trim() });
    }
  }

  if (notas_fiscais.length === 0) {
    toast('Informe ao menos uma nota fiscal', 'error');
    return;
  }

  const btn = document.getElementById('bol-btn-gerar');
  btn.disabled = true;
  btn.textContent = '⏳ Gerando...';

  try {
    const token = localStorage.getItem('montana_token') || '';
    const result = await fetch('/api/boletins/gerar', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Company': currentCompany,
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({ contrato_id: contratoId, competencia, data_emissao: dataEmissao, notas_fiscais })
    }).then(r => r.json());

    const el = document.getElementById('bol-resultado');
    if (result.ok) {
      el.innerHTML = `
        <div style="background:#dcfce7;border:1px solid #86efac;border-radius:8px;padding:16px">
          <h4 style="margin:0 0 8px 0;color:#15803d">✅ Boletins Gerados com Sucesso!</h4>
          <p style="margin:0;font-size:14px">
            <strong>${result.pdfs_gerados} PDFs</strong> criados · Total: <strong>${brl(result.total_geral)}</strong>
          </p>
          <p style="margin:4px 0 0;font-size:12px;color:#64748b">Diretório: ${result.diretorio}</p>
        </div>
      `;
      toast('Boletins gerados com sucesso!');
    } else {
      el.innerHTML = `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;color:#dc2626">${result.error}</div>`;
      toast(result.error || 'Erro ao gerar', 'error');
    }
  } catch (err) {
    toast('Erro: ' + err.message, 'error');
  }

  btn.disabled = false;
  btn.textContent = '📄 Gerar Boletins (PDFs)';
}

// ─── CRUD HELPERS (MODAIS SIMPLES VIA PROMPT) ─────────────────

async function bolNovoContrato() {
  const nome = prompt('Nome do contrato (ex: UFT, UNITINS):');
  if (!nome) return;
  const contratante = prompt('Nome do contratante:');
  if (!contratante) return;
  const numero = prompt('Número do contrato:');
  if (!numero) return;

  const token = localStorage.getItem('montana_token') || '';
  await fetch('/api/boletins/contratos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({
      nome, contratante, numero_contrato: numero,
      processo: prompt('Processo:') || '',
      pregao: prompt('Pregão:') || '',
      descricao_servico: prompt('Descrição do serviço:') || '',
      escala: prompt('Escala (ex: 12x36):') || '12x36',
      empresa_razao: prompt('Razão social da empresa:') || '',
      empresa_cnpj: prompt('CNPJ da empresa:') || '',
      empresa_endereco: prompt('Endereço:') || '',
      empresa_email: prompt('E-mail:') || '',
      empresa_telefone: prompt('Telefone:') || ''
    })
  });
  toast('Contrato criado!');
  await loadBolContratos();
  renderBolLista();
}

async function bolDeletarContrato(id) {
  if (!confirm('Excluir este contrato e todos os postos/itens?')) return;
  const token = localStorage.getItem('montana_token') || '';
  await fetch('/api/boletins/contratos/' + id, {
    method: 'DELETE',
    headers: { 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token }
  });
  toast('Contrato excluído');
  await loadBolContratos();
  renderBolLista();
}

async function bolEditarContrato(id) {
  const c = _bolContratoSelecionado;
  if (!c) return;
  const nome = prompt('Nome:', c.nome);
  if (nome === null) return;
  const token = localStorage.getItem('montana_token') || '';
  await fetch('/api/boletins/contratos/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({
      ...c, nome,
      contratante: prompt('Contratante:', c.contratante) || c.contratante,
      numero_contrato: prompt('Nº Contrato:', c.numero_contrato) || c.numero_contrato,
      processo: prompt('Processo:', c.processo) || '',
      pregao: prompt('Pregão:', c.pregao) || '',
      descricao_servico: prompt('Descrição do serviço:', c.descricao_servico) || '',
      escala: prompt('Escala:', c.escala) || '12x36',
      empresa_razao: prompt('Razão social:', c.empresa_razao) || '',
      empresa_cnpj: prompt('CNPJ:', c.empresa_cnpj) || '',
      empresa_endereco: prompt('Endereço:', c.empresa_endereco) || '',
      empresa_email: prompt('E-mail:', c.empresa_email) || '',
      empresa_telefone: prompt('Telefone:', c.empresa_telefone) || ''
    })
  });
  toast('Contrato atualizado!');
  bolAbrirContrato(id);
}

async function bolNovoPosto(contratoId) {
  const campus_key = prompt('Chave do campus (ex: PALMAS):');
  if (!campus_key) return;
  const campus_nome = prompt('Nome completo do campus:');
  if (!campus_nome) return;
  const municipio = prompt('Município (ex: PALMAS/TO):') || '';
  const descricao_posto = prompt('Descrição do posto:') || '';
  const label_resumo = prompt('Label no resumo:', campus_key) || campus_key;

  const token = localStorage.getItem('montana_token') || '';
  await fetch('/api/boletins/contratos/' + contratoId + '/postos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ campus_key, campus_nome, municipio, descricao_posto, label_resumo })
  });
  toast('Posto criado!');
  bolAbrirContrato(contratoId);
}

async function bolEditarPosto(postoId, contratoId) {
  const posto = (_bolContratoSelecionado?.postos || []).find(p => p.id === postoId);
  if (!posto) return;
  const campus_key = prompt('Chave:', posto.campus_key);
  if (campus_key === null) return;
  const token = localStorage.getItem('montana_token') || '';
  await fetch('/api/boletins/postos/' + postoId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({
      campus_key,
      campus_nome: prompt('Nome:', posto.campus_nome) || posto.campus_nome,
      municipio: prompt('Município:', posto.municipio) || '',
      descricao_posto: prompt('Descrição:', posto.descricao_posto) || '',
      label_resumo: prompt('Label resumo:', posto.label_resumo) || '',
      ordem: posto.ordem
    })
  });
  toast('Posto atualizado!');
  bolAbrirContrato(contratoId);
}

async function bolDeletarPosto(postoId, contratoId) {
  if (!confirm('Excluir este posto e todos os itens?')) return;
  const token = localStorage.getItem('montana_token') || '';
  await fetch('/api/boletins/postos/' + postoId, {
    method: 'DELETE',
    headers: { 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token }
  });
  toast('Posto excluído');
  bolAbrirContrato(contratoId);
}

async function bolNovoItem(postoId, contratoId) {
  const descricao = prompt('Descrição do item:');
  if (!descricao) return;
  const quantidade = parseInt(prompt('Quantidade de postos:', '1')) || 1;
  const valor_unitario = parseFloat(prompt('Valor unitário (ex: 14804.74):', '0')) || 0;

  const token = localStorage.getItem('montana_token') || '';
  await fetch('/api/boletins/postos/' + postoId + '/itens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ descricao, quantidade, valor_unitario })
  });
  toast('Item criado!');
  bolAbrirContrato(contratoId);
}

async function bolEditarItem(itemId, contratoId) {
  let item = null;
  for (const p of (_bolContratoSelecionado?.postos || [])) {
    item = (p.itens || []).find(i => i.id === itemId);
    if (item) break;
  }
  if (!item) return;

  const descricao = prompt('Descrição:', item.descricao);
  if (descricao === null) return;
  const quantidade = parseInt(prompt('Quantidade:', item.quantidade)) || item.quantidade;
  const valor_unitario = parseFloat(prompt('Valor unitário:', item.valor_unitario)) || item.valor_unitario;

  const token = localStorage.getItem('montana_token') || '';
  await fetch('/api/boletins/itens/' + itemId, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ descricao, quantidade, valor_unitario, ordem: item.ordem })
  });
  toast('Item atualizado!');
  bolAbrirContrato(contratoId);
}

async function bolDeletarItem(itemId, contratoId) {
  if (!confirm('Excluir este item?')) return;
  const token = localStorage.getItem('montana_token') || '';
  await fetch('/api/boletins/itens/' + itemId, {
    method: 'DELETE',
    headers: { 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token }
  });
  toast('Item excluído');
  bolAbrirContrato(contratoId);
}

// ─── F-7: Inicializar Boletins de Contratos Financeiros ─────────
async function bolInicializarDeContratos() {
  // Busca os contratos financeiros existentes
  const d = await api('/contratos');
  const contratos = d.data || [];
  if (!contratos.length) { toast('Nenhum contrato financeiro encontrado', 'error'); return; }

  // Monta modal de seleção
  let optionsHtml = contratos.map(c =>
    `<label style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:6px;cursor:pointer">
      <input type="checkbox" value="${c.numContrato}" data-nome="${c.contrato}" data-num="${c.numContrato}" checked style="accent-color:#7c2d12">
      <div>
        <div style="font-weight:600;font-size:12px">${c.contrato}</div>
        <div style="font-size:10px;color:#64748b">${c.numContrato} · ${brl(c.valor_mensal_liquido)}/mês</div>
      </div>
    </label>`
  ).join('');

  // Cria modal inline
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;width:100%;max-width:520px;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <div style="background:#7c2d12;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:14px;font-weight:800">🚀 Inicializar Contratos de Boletim</div>
        <button onclick="this.closest('div[style*=fixed]').remove()" style="background:rgba(255,255,255,.2);border:none;color:#fff;font-size:16px;cursor:pointer;border-radius:4px;padding:2px 8px">×</button>
      </div>
      <div style="padding:16px">
        <p style="font-size:12px;color:#64748b;margin-bottom:12px">Selecione os contratos para criar registros no módulo de Boletins de Medição. Você poderá editar os detalhes depois.</p>
        <div style="max-height:300px;overflow-y:auto">${optionsHtml}</div>
        <div style="margin-top:12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;padding:10px;font-size:11px;color:#9a3412">
          <strong>Empresa:</strong> Preencha os dados de CNPJ e endereço manualmente após a criação (necessários para o PDF do boletim).
        </div>
        <div style="display:flex;gap:8px;margin-top:14px">
          <button onclick="this.closest('div[style*=fixed]').remove()" style="flex:1;padding:8px;font-size:12px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;cursor:pointer">Cancelar</button>
          <button id="bol-init-btn" style="flex:2;padding:8px;font-size:12px;font-weight:700;background:#7c2d12;color:#fff;border:none;border-radius:6px;cursor:pointer">🚀 Criar Contratos Selecionados</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  document.getElementById('bol-init-btn').onclick = async () => {
    const checked = overlay.querySelectorAll('input[type=checkbox]:checked');
    if (!checked.length) { toast('Selecione ao menos um contrato', 'error'); return; }

    const token = localStorage.getItem('montana_token') || '';
    let criados = 0;
    for (const cb of checked) {
      const nome = cb.dataset.nome;
      const num  = cb.dataset.num;
      const body = {
        nome:             nome,
        contratante:      nome,
        numero_contrato:  num,
        descricao_servico: 'Serviços de vigilância/limpeza/copeiragem conforme contrato',
        escala:           '12x36',
        empresa_razao:    currentCompany === 'assessoria' ? 'MONTANA ASSESSORIA EMPRESARIAL LTDA' : 'MONTANA SEGURANÇA LTDA',
        empresa_cnpj:     currentCompany === 'assessoria' ? '14.092.519/0001-51' : '19.200.109/0001-09',
        empresa_endereco: '',
        empresa_email:    '',
        empresa_telefone: ''
      };
      const r = await fetch('/api/boletins/contratos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(body)
      });
      if (r.ok) criados++;
    }

    overlay.remove();
    toast(`${criados} contrato(s) de boletim criado(s)! Acesse cada um para adicionar postos e itens.`);
    loadBoletinsTab();
  };
}
