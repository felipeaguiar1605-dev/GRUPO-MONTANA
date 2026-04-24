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
  // Cobertura de postos (app-extras.js)
  if (typeof loadCoberturaPosots === 'function') loadCoberturaPosots();
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

  let html = '<table class="tbl"><thead><tr><th>Contrato</th><th>Competência</th><th>Total Boletim</th><th>NFs vinculadas</th><th>Status</th><th>Data Emissão</th><th>Pacote Fiscal</th></tr></thead><tbody>';
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
      <td></td>
    </tr>`;
    for (const b of grupo) {
      const emitida = b.nfse_status === 'EMITIDA';
      const pacoteCol = emitida
        ? `<button class="btn btn-xs" style="background:#1d4ed8;color:#fff;border:none;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-weight:600" onclick="baixarPacoteFiscal(${b.id})" title="Baixar ZIP com boletim + NFS-e + ofício para o fiscal">📦 Baixar pacote</button>`
        : `<span style="color:#94a3b8;font-size:11px">NFS-e pendente</span>`;
      html += `<tr>
        <td style="padding-left:24px">${b.contrato_nome}</td>
        <td>${b.competencia}</td>
        <td>${brl(b.total_geral)}</td>
        <td>${b.nfs ? b.nfs.length : 0} NFs</td>
        <td>${bolStatusBadge(b.status)} ${emitida ? `<small style="color:#15803d">· NFS-e ${b.nfse_numero}</small>` : ''}</td>
        <td style="font-size:11px;color:#64748b">${b.data_emissao||'—'}</td>
        <td>${pacoteCol}</td>
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
    const token = localStorage.getItem('montana_jwt') || '';
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

  const token = localStorage.getItem('montana_jwt') || '';
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
  const token = localStorage.getItem('montana_jwt') || '';
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
  const token = localStorage.getItem('montana_jwt') || '';
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

  const token = localStorage.getItem('montana_jwt') || '';
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
  const token = localStorage.getItem('montana_jwt') || '';
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
  const token = localStorage.getItem('montana_jwt') || '';
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

  const token = localStorage.getItem('montana_jwt') || '';
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

  const token = localStorage.getItem('montana_jwt') || '';
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
  const token = localStorage.getItem('montana_jwt') || '';
  await fetch('/api/boletins/itens/' + itemId, {
    method: 'DELETE',
    headers: { 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token }
  });
  toast('Item excluído');
  bolAbrirContrato(contratoId);
}

// ─── GERAR BOLETIM + EMITIR NFS-e (Modal) ─────────────────────

/**
 * abrirGerarBoletim(contrato_id, contrato_ref, orgao, valor_mensal)
 * Abre modal para criar boletim de competência e iniciar emissão de NFS-e.
 * Se contrato_id não for passado, mostra seletor de contratos primeiro.
 */
async function abrirGerarBoletim(contrato_id, contrato_ref, orgao, valor_mensal) {
  // Se chamado sem argumento, mostrar seletor de contrato
  if (!contrato_id) {
    await _abrirSeletorContrato();
    return;
  }

  const hoje = new Date();
  const anoAtual = hoje.getFullYear();
  const mesAtual = String(hoje.getMonth() + 1).padStart(2, '0');
  const competenciaDefault = `${anoAtual}-${mesAtual}`;

  const overlay = document.createElement('div');
  overlay.id = 'modal-gerar-boletim';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.65);z-index:3000;display:flex;align-items:center;justify-content:center;padding:20px';

  const mesesNome = ['','Janeiro','Fevereiro','Março','Abril','Maio','Junho',
    'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

  const valorBase = parseFloat(valor_mensal) || 0;
  const valorBaseFmt = brl(valorBase);

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:14px;width:100%;max-width:560px;box-shadow:0 24px 80px rgba(0,0,0,.35);overflow:hidden">
      <div style="background:#059669;color:#fff;padding:16px 20px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:15px;font-weight:800">📄 Gerar Boletim / Emitir NF-e</div>
          <div style="font-size:11px;opacity:.85;margin-top:2px">${orgao || contrato_ref || 'Contrato'}</div>
        </div>
        <button onclick="document.getElementById('modal-gerar-boletim').remove()"
          style="background:rgba(255,255,255,.2);border:none;color:#fff;font-size:18px;cursor:pointer;border-radius:6px;padding:2px 10px;line-height:1">×</button>
      </div>
      <div style="padding:20px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
          <div>
            <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:4px">Competência (AAAA-MM)</label>
            <input type="month" id="gbm-competencia" value="${competenciaDefault}"
              style="width:100%;padding:8px 10px;border:1.5px solid #d1d5db;border-radius:8px;font-size:13px;box-sizing:border-box"
              onchange="_gbmRecalcular()">
          </div>
          <div>
            <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:4px">Valor Base (contrato)</label>
            <input type="text" value="${valorBaseFmt}" readonly
              style="width:100%;padding:8px 10px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:13px;background:#f8fafc;box-sizing:border-box;color:#64748b">
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
          <div>
            <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:4px">Glosas (R$)</label>
            <input type="number" id="gbm-glosas" value="0" min="0" step="0.01"
              style="width:100%;padding:8px 10px;border:1.5px solid #d1d5db;border-radius:8px;font-size:13px;box-sizing:border-box"
              oninput="_gbmRecalcular()">
          </div>
          <div>
            <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:4px">Acréscimos (R$)</label>
            <input type="number" id="gbm-acrescimos" value="0" min="0" step="0.01"
              style="width:100%;padding:8px 10px;border:1.5px solid #d1d5db;border-radius:8px;font-size:13px;box-sizing:border-box"
              oninput="_gbmRecalcular()">
          </div>
        </div>

        <div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:10px;padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:13px;font-weight:700;color:#166534">Valor Final da NF:</span>
          <span id="gbm-valor-final" style="font-size:18px;font-weight:900;color:#15803d">${valorBaseFmt}</span>
        </div>
        <input type="hidden" id="gbm-valor-base" value="${valorBase}">

        <div style="margin-bottom:16px">
          <label style="font-size:12px;font-weight:700;color:#374151;display:block;margin-bottom:4px">Discriminação da NF <span style="font-weight:400;color:#94a3b8">(editável)</span></label>
          <textarea id="gbm-discriminacao" rows="4"
            style="width:100%;padding:8px 10px;border:1.5px solid #d1d5db;border-radius:8px;font-size:12px;line-height:1.5;box-sizing:border-box;resize:vertical"
            placeholder="Texto que irá no campo Discriminação da NFS-e..."></textarea>
        </div>

        <div id="gbm-resultado" style="margin-bottom:12px"></div>

        <div style="display:flex;gap:8px">
          <button onclick="document.getElementById('modal-gerar-boletim').remove()"
            style="flex:1;padding:10px;font-size:13px;border:1.5px solid #e2e8f0;border-radius:8px;background:#fff;cursor:pointer;font-weight:600;color:#64748b">
            Cancelar
          </button>
          <button id="gbm-btn-gerar" onclick="_gbmExecutar(${contrato_id})"
            style="flex:2;padding:10px;font-size:13px;font-weight:800;background:#059669;color:#fff;border:none;border-radius:8px;cursor:pointer">
            📄 Gerar Boletim
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Preencher discriminação gerada automaticamente pelo backend ao criar (inicialmente vazio — o backend gera)
  // Buscar a discriminação padrão com base no contrato
  try {
    const bc = _bolContratos.find(c => c.id === contrato_id);
    if (bc) {
      const [ano, mes] = competenciaDefault.split('-');
      const mNome = mesesNome[parseInt(mes)] || mes;
      const tipoServ = bc.descricao_servico || bc.nome || 'SERVIÇOS';
      const numC = bc.contrato_ref || bc.numero_contrato || '';
      document.getElementById('gbm-discriminacao').value =
        `PRESTAÇÃO DE SERVIÇOS DE ${tipoServ.toUpperCase()} CONFORME CONTRATO Nº ${numC}, COMPETÊNCIA ${mNome.toUpperCase()}/${ano}. VALOR MENSAL CONFORME BOLETIM DE MEDIÇÃO APROVADO.`;
    }
  } catch (_) {}
}

function _gbmRecalcular() {
  const base = parseFloat(document.getElementById('gbm-valor-base')?.value) || 0;
  const glosas = parseFloat(document.getElementById('gbm-glosas')?.value) || 0;
  const acrescimos = parseFloat(document.getElementById('gbm-acrescimos')?.value) || 0;
  const total = Math.round((base - glosas + acrescimos) * 100) / 100;
  const el = document.getElementById('gbm-valor-final');
  if (el) el.textContent = brl(total);
}

async function _gbmExecutar(contrato_id) {
  const btn = document.getElementById('gbm-btn-gerar');
  const resultEl = document.getElementById('gbm-resultado');
  const competencia = document.getElementById('gbm-competencia')?.value?.trim();
  const glosas = parseFloat(document.getElementById('gbm-glosas')?.value) || 0;
  const acrescimos = parseFloat(document.getElementById('gbm-acrescimos')?.value) || 0;
  const discriminacao = document.getElementById('gbm-discriminacao')?.value?.trim();

  if (!competencia) { toast('Informe a competência', 'error'); return; }

  btn.disabled = true;
  btn.textContent = '⏳ Gerando...';

  try {
    const token = localStorage.getItem('montana_jwt') || '';
    const headers = { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token };

    // 1. Criar/obter boletim
    const r1 = await fetch('/api/boletins/gerar-boletim', {
      method: 'POST', headers,
      body: JSON.stringify({ contrato_id, competencia }),
    }).then(r => r.json());

    if (r1.error) throw new Error(r1.error);
    const boletim = r1.data;

    // 2. Aplicar ajustes se há glosas/acréscimos ou discriminação personalizada
    if (glosas || acrescimos || discriminacao) {
      await fetch(`/api/boletins/${boletim.id}/ajustar`, {
        method: 'PATCH', headers,
        body: JSON.stringify({ glosas, acrescimos, discriminacao: discriminacao || undefined }),
      }).then(r => r.json());
    }

    // Recarregar boletim atualizado
    const bolAtual = glosas || acrescimos
      ? await fetch(`/api/boletins/historico`, { headers }).then(r => r.json())
          .then(hist => (Array.isArray(hist) ? hist : []).find(b => b.id === boletim.id) || boletim)
      : boletim;

    const valorFinal = bolAtual.valor_total || boletim.valor_total || 0;
    const jaExistia = !r1.novo;

    resultEl.innerHTML = `
      <div style="background:#dcfce7;border:1px solid #86efac;border-radius:8px;padding:12px 16px;margin-bottom:10px">
        <div style="font-weight:700;color:#15803d;margin-bottom:4px">
          ${jaExistia ? '♻️ Boletim já existente carregado' : '✅ Boletim gerado com sucesso!'}
        </div>
        <div style="font-size:12px;color:#166534">
          ID: <strong>#${boletim.id}</strong> · Competência: <strong>${competencia}</strong> · Valor: <strong>${brl(valorFinal)}</strong>
          ${boletim.nfse_status === 'EMITIDA' ? ` · NFS-e: <strong>${boletim.nfse_numero}</strong>` : ''}
        </div>
      </div>
    `;

    // Mostrar botão de emitir NFS-e se ainda não emitida
    if (boletim.nfse_status !== 'EMITIDA') {
      btn.style.background = '#1d4ed8';
      btn.textContent = '🚀 Emitir NFS-e agora';
      btn.disabled = false;
      btn.onclick = () => emitirNFSe(boletim.id, competencia, valorFinal);
    } else {
      btn.textContent = '✅ NFS-e já emitida';
      btn.disabled = true;
      btn.style.background = '#6b7280';
    }

    // Recarregar histórico em background
    if (typeof loadBolHistorico === 'function') loadBolHistorico();

  } catch (err) {
    resultEl.innerHTML = `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;color:#dc2626;font-size:12px">❌ ${err.message}</div>`;
    btn.disabled = false;
    btn.textContent = '📄 Gerar Boletim';
  }
}

/**
 * emitirNFSe(boletim_id, competencia, valor)
 * Confirma e emite a NFS-e para o boletim via WebISS.
 */
async function emitirNFSe(boletim_id, competencia, valor) {
  const valorFmt = brl(valor || 0);

  // Criar overlay de confirmação
  const overlay = document.createElement('div');
  overlay.id = 'modal-emitir-nfse';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.65);z-index:3500;display:flex;align-items:center;justify-content:center;padding:20px';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:14px;width:100%;max-width:440px;box-shadow:0 24px 80px rgba(0,0,0,.35);overflow:hidden">
      <div style="background:#1d4ed8;color:#fff;padding:16px 20px;display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:15px;font-weight:800">🚀 Emitir NFS-e via WebISS</div>
        <button onclick="document.getElementById('modal-emitir-nfse').remove()"
          style="background:rgba(255,255,255,.2);border:none;color:#fff;font-size:18px;cursor:pointer;border-radius:6px;padding:2px 10px;line-height:1">×</button>
      </div>
      <div style="padding:20px">
        <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px 16px;margin-bottom:16px">
          <div style="font-size:12px;color:#1e40af;margin-bottom:4px">Boletim #${boletim_id} · Competência: <strong>${competencia || '—'}</strong></div>
          <div style="font-size:20px;font-weight:900;color:#1d4ed8">${valorFmt}</div>
        </div>
        <div style="background:#fef9c3;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:11px;color:#92400e">
          ⚠️ <strong>Atenção:</strong> Esta ação emite uma NFS-e oficial no portal WebISS (Prefeitura de Palmas). A operação não pode ser desfeita automaticamente — cancelamentos devem ser feitos diretamente no portal.
        </div>
        <div id="nfse-resultado" style="margin-bottom:12px"></div>
        <div style="display:flex;gap:8px">
          <button onclick="document.getElementById('modal-emitir-nfse').remove()"
            style="flex:1;padding:10px;font-size:13px;border:1.5px solid #e2e8f0;border-radius:8px;background:#fff;cursor:pointer;font-weight:600;color:#64748b">
            Cancelar
          </button>
          <button id="nfse-btn-emitir" onclick="_nfseConfirmarEmissao(${boletim_id})"
            style="flex:2;padding:10px;font-size:13px;font-weight:800;background:#1d4ed8;color:#fff;border:none;border-radius:8px;cursor:pointer">
            🚀 Confirmar Emissão
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

async function _nfseConfirmarEmissao(boletim_id) {
  const btn = document.getElementById('nfse-btn-emitir');
  const resultEl = document.getElementById('nfse-resultado');

  btn.disabled = true;
  btn.innerHTML = '<span style="display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:6px"></span>Emitindo...';

  try {
    const token = localStorage.getItem('montana_jwt') || '';
    const res = await fetch(`/api/boletins/${boletim_id}/emitir-nfse`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Company': currentCompany,
        'Authorization': 'Bearer ' + token,
      },
    });

    const result = await res.json();

    if (result.ok && result.numero_nfse) {
      resultEl.innerHTML = `
        <div style="background:#dcfce7;border:1px solid #86efac;border-radius:8px;padding:14px;text-align:center">
          <div style="font-size:28px;margin-bottom:6px">✅</div>
          <div style="font-weight:800;color:#15803d;font-size:15px;margin-bottom:4px">NFS-e Emitida com Sucesso!</div>
          <div style="font-size:13px;color:#166534">Número: <strong style="font-size:18px">${result.numero_nfse}</strong></div>
          ${result.nfse?.dataEmissao ? `<div style="font-size:11px;color:#64748b;margin-top:4px">Data: ${result.nfse.dataEmissao}</div>` : ''}
          <button onclick="baixarPacoteFiscal(${boletim_id})"
            style="margin-top:10px;padding:8px 16px;background:#1d4ed8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:700;font-size:12px">
            📦 Baixar pacote para o fiscal
          </button>
        </div>
      `;
      btn.textContent = '✅ Emitida';
      btn.style.background = '#059669';
      // Fechar modal após 6s (tempo pra clicar no pacote)
      setTimeout(() => {
        document.getElementById('modal-emitir-nfse')?.remove();
        document.getElementById('modal-gerar-boletim')?.remove();
        if (typeof loadBolHistorico === 'function') loadBolHistorico();
      }, 6000);
    } else {
      const erroMsg = result.error || 'Erro desconhecido';
      resultEl.innerHTML = `
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px">
          <div style="font-weight:700;color:#dc2626;margin-bottom:4px">❌ Falha na Emissão</div>
          <div style="font-size:12px;color:#7f1d1d">${erroMsg}</div>
          ${result.detalhes?.erros?.length ? `<div style="font-size:10px;color:#94a3b8;margin-top:4px">Detalhes: ${JSON.stringify(result.detalhes.erros)}</div>` : ''}
        </div>
      `;
      btn.disabled = false;
      btn.textContent = '🔄 Tentar Novamente';
    }
  } catch (err) {
    resultEl.innerHTML = `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;color:#dc2626;font-size:12px">❌ Erro de rede: ${err.message}</div>`;
    btn.disabled = false;
    btn.textContent = '🔄 Tentar Novamente';
  }
}

// ═══════════════════════════════════════════════════════════════
// PAINEL DE FATURAMENTO MENSAL
// ═══════════════════════════════════════════════════════════════

let _painelMes = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
})();

function abrirPainelFaturamento() {
  _bolView = 'painel';
  renderPainelFaturamento();
}

async function renderPainelFaturamento() {
  const el = document.getElementById('bol-content');
  el.innerHTML = '<div class="loading">Carregando painel...</div>';

  const token = localStorage.getItem('montana_jwt') || '';
  const headers = { 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token };

  let data;
  try {
    const r = await fetch(`/api/boletins/painel-faturamento?mes=${_painelMes}`, { headers });
    data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Erro ao carregar painel');
  } catch (err) {
    el.innerHTML = `<div style="color:#dc2626;padding:12px">❌ ${err.message}</div>`;
    return;
  }

  const { contratos, stats, mes } = data;
  const [ano, mesNum] = mes.split('-');
  const MESES_NOMES = ['','Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const mesNome = MESES_NOMES[parseInt(mesNum)] || mes;

  // Meses para selector (6 meses atrás até 3 à frente)
  const now = new Date();
  const mesOpts = [];
  for (let i = -6; i <= 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const v = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    const n = `${MESES_NOMES[d.getMonth()+1]}/${d.getFullYear()}`;
    mesOpts.push(`<option value="${v}" ${v===_painelMes?'selected':''}>${n}</option>`);
  }

  const brl = v => 'R$ ' + Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});

  // Contagem por status para o badge batch-emitir
  const qtdAprovados = contratos.filter(c => c.boletim?.status === 'aprovado' && c.boletim?.nfse_status !== 'EMITIDA').length;

  el.innerHTML = `
  <div style="margin-bottom:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <button onclick="_bolView='lista';renderBolLista()" style="background:#f1f5f9;border:none;border-radius:7px;padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;color:#475569">← Voltar</button>
    <h3 style="margin:0;font-size:16px;font-weight:800;color:#1e293b">📊 Painel de Faturamento</h3>
    <select onchange="_painelMes=this.value;renderPainelFaturamento()"
      style="padding:7px 12px;border:1px solid #e2e8f0;border-radius:7px;font-size:12px;font-weight:600;background:#fff;cursor:pointer;color:#1e293b">
      ${mesOpts.join('')}
    </select>
    <span style="font-size:11px;color:#64748b;margin-left:2px">Competência: <strong>${mesNome}/${ano}</strong></span>
  </div>

  <!-- KPIs -->
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:18px">
    ${[
      ['Contratos', stats.total, '#1e293b', '🏢'],
      ['Sem Boletim', stats.sem_boletim, stats.sem_boletim>0?'#dc2626':'#16a34a', '⚠'],
      ['Rascunho', stats.rascunho, '#d97706', '📝'],
      ['Aprovado', stats.aprovado, '#2563eb', '✅'],
      ['Emitido', stats.emitido, '#059669', '✔'],
      ['Total R$', brl(stats.valor_total), '#7c3aed', '💰'],
    ].map(([lbl, val, cor, ico]) => `
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px;text-align:center">
        <div style="font-size:18px">${ico}</div>
        <div style="font-size:20px;font-weight:800;color:${cor}">${val}</div>
        <div style="font-size:10px;color:#64748b;font-weight:600">${lbl}</div>
      </div>`).join('')}
  </div>

  <!-- Ações em lote -->
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
    <button onclick="painelGerarTodos('${mes}')"
      style="padding:8px 16px;background:#0f172a;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer">
      ⚡ Gerar Todos (${stats.sem_boletim} sem boletim)
    </button>
    <button onclick="painelAprovarTodos('${mes}')"
      style="padding:8px 16px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer">
      ✅ Aprovar Todos Rascunhos (${stats.rascunho})
    </button>
    <button onclick="painelEmitirLote('${mes}')"
      style="padding:8px 16px;background:#059669;color:#fff;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer${qtdAprovados===0?';opacity:.5':''}"
      ${qtdAprovados===0?'disabled':''}>
      🚀 Emitir NFS-e Lote (${qtdAprovados} aprovados)
    </button>
  </div>

  <!-- Tabela de contratos -->
  <div style="overflow-x:auto">
  <table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead>
      <tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0">
        <th style="padding:10px 12px;text-align:left;font-weight:700;color:#475569">Contrato</th>
        <th style="padding:10px 8px;text-align:left;font-weight:700;color:#475569">Contratante</th>
        <th style="padding:10px 8px;text-align:right;font-weight:700;color:#475569">Valor Base</th>
        <th style="padding:10px 8px;text-align:right;font-weight:700;color:#475569">Valor Boletim</th>
        <th style="padding:10px 8px;text-align:center;font-weight:700;color:#475569">Status</th>
        <th style="padding:10px 8px;text-align:center;font-weight:700;color:#475569">NFS-e</th>
        <th style="padding:10px 8px;text-align:center;font-weight:700;color:#475569">Ações</th>
      </tr>
    </thead>
    <tbody>
      ${contratos.map((c, i) => _renderLinhaContratoPainel(c, i, mes)).join('')}
    </tbody>
    <tfoot>
      <tr style="background:#f1f5f9;font-weight:800;border-top:2px solid #cbd5e1">
        <td colspan="3" style="padding:10px 12px;color:#1e293b">TOTAL</td>
        <td style="padding:10px 8px;text-align:right;color:#7c3aed">${brl(stats.valor_total)}</td>
        <td colspan="3"></td>
      </tr>
    </tfoot>
  </table>
  </div>`;
}

function _renderLinhaContratoPainel(c, idx, mes) {
  const brl = v => 'R$ ' + Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
  const bg = idx % 2 === 0 ? '#fff' : '#f8fafc';
  const bol = c.boletim;

  let statusBadge, nfseBadge, acoes;

  if (!bol) {
    statusBadge = `<span style="background:#fef3c7;color:#92400e;padding:3px 8px;border-radius:12px;font-size:10px;font-weight:700">SEM BOLETIM</span>`;
    nfseBadge   = `<span style="color:#94a3b8;font-size:10px">—</span>`;
    acoes = `<button onclick="painelGerarUm(${c.contrato_id},'${mes}')"
      style="padding:4px 10px;background:#0f172a;color:#fff;border:none;border-radius:6px;font-size:10px;font-weight:700;cursor:pointer">Gerar</button>`;
  } else {
    const statusCor = {rascunho:'#fef3c7|#92400e', aprovado:'#dbeafe|#1d4ed8', emitido:'#d1fae5|#065f46'}[bol.status] || '#f1f5f9|#475569';
    const [bg2, col2] = statusCor.split('|');
    statusBadge = `<span style="background:${bg2};color:${col2};padding:3px 8px;border-radius:12px;font-size:10px;font-weight:700">${bol.status.toUpperCase()}</span>`;

    if (bol.nfse_status === 'EMITIDA') {
      nfseBadge = `<span style="background:#d1fae5;color:#065f46;padding:3px 8px;border-radius:12px;font-size:10px;font-weight:700" title="NFS-e ${bol.nfse_numero}">✔ ${bol.nfse_numero}</span>`;
    } else if (bol.nfse_status === 'ERRO') {
      nfseBadge = `<span style="background:#fef2f2;color:#dc2626;padding:3px 8px;border-radius:12px;font-size:10px;font-weight:700" title="${bol.nfse_erro||''}">❌ ERRO</span>`;
    } else if (bol.nfse_status === 'ENVIANDO') {
      nfseBadge = `<span style="background:#eff6ff;color:#3b82f6;padding:3px 8px;border-radius:12px;font-size:10px;font-weight:700">⏳ ENVIANDO</span>`;
    } else {
      nfseBadge = `<span style="color:#94a3b8;font-size:10px">PENDENTE</span>`;
    }

    const btnAjustar = bol.nfse_status !== 'EMITIDA'
      ? `<button onclick="painelAjustar(${bol.id},'${mes}')" title="Ajustar glosas/acréscimos"
           style="padding:4px 8px;background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;border-radius:6px;font-size:10px;font-weight:700;cursor:pointer">✏️</button>`
      : '';

    const btnAprovar = (bol.status === 'rascunho' && bol.nfse_status !== 'EMITIDA')
      ? `<button onclick="painelAprovar(${bol.id},'${mes}')"
           style="padding:4px 9px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:10px;font-weight:700;cursor:pointer">✅ Aprovar</button>`
      : '';

    const btnEmitir = (bol.status === 'aprovado' && bol.nfse_status !== 'EMITIDA')
      ? `<button onclick="emitirNFSe(${bol.id},'${mes}',${bol.valor_total})"
           style="padding:4px 9px;background:#059669;color:#fff;border:none;border-radius:6px;font-size:10px;font-weight:700;cursor:pointer">🚀 Emitir NFS-e</button>`
      : '';

    const btnPacote = bol.nfse_status === 'EMITIDA'
      ? `<button onclick="baixarPacoteFiscal(${bol.id})" title="Baixar pacote fiscal (ZIP)"
           style="padding:4px 8px;background:#7c3aed;color:#fff;border:none;border-radius:6px;font-size:10px;font-weight:700;cursor:pointer">📦 ZIP</button>`
      : '';

    acoes = `<div style="display:flex;gap:4px;justify-content:center;flex-wrap:wrap">${btnAjustar}${btnAprovar}${btnEmitir}${btnPacote}</div>`;
  }

  const valorBase   = brl(c.valor_mensal_bruto);
  const valorBoletim = bol ? brl(bol.valor_total) : `<span style="color:#94a3b8">—</span>`;
  const glosaTag    = (bol?.glosas > 0) ? `<span style="color:#dc2626;font-size:9px"> (-${brl(bol.glosas)})</span>` : '';

  return `
  <tr style="background:${bg};border-bottom:1px solid #f1f5f9">
    <td style="padding:10px 12px;font-weight:700;color:#1e293b;max-width:180px">${c.nome}</td>
    <td style="padding:10px 8px;color:#475569;font-size:11px;max-width:160px">${c.contratante}</td>
    <td style="padding:10px 8px;text-align:right;color:#64748b;font-weight:600">${valorBase}</td>
    <td style="padding:10px 8px;text-align:right;color:#1e293b;font-weight:700">${valorBoletim}${glosaTag}</td>
    <td style="padding:10px 8px;text-align:center">${statusBadge}</td>
    <td style="padding:10px 8px;text-align:center">${nfseBadge}</td>
    <td style="padding:10px 8px;text-align:center">${acoes}</td>
  </tr>`;
}

// ─── Ações do Painel ──────────────────────────────────────────

async function painelGerarTodos(mes) {
  const token = localStorage.getItem('montana_jwt') || '';
  const btn = event?.target;
  if (btn) { btn.disabled = true; btn.textContent = 'Gerando...'; }
  try {
    const r = await fetch('/api/boletins/gerar-mes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ mes }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast(`✅ ${d.criados} boletim(ns) criado(s) | ${d.existentes} já existiam`, 'success');
    renderPainelFaturamento();
  } catch (err) {
    toast('Erro: ' + err.message, 'error');
    if (btn) { btn.disabled = false; }
  }
}

async function painelGerarUm(contrato_id, mes) {
  const token = localStorage.getItem('montana_jwt') || '';
  try {
    const r = await fetch('/api/boletins/gerar-boletim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ contrato_id, competencia: mes }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast(d.novo ? '✅ Boletim criado' : '⚠ Boletim já existia', d.novo ? 'success' : 'info');
    renderPainelFaturamento();
  } catch (err) {
    toast('Erro: ' + err.message, 'error');
  }
}

async function painelAprovar(boletim_id, mes) {
  const token = localStorage.getItem('montana_jwt') || '';
  try {
    const r = await fetch(`/api/boletins/${boletim_id}/aprovar`, {
      method: 'POST',
      headers: { 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast('✅ Boletim aprovado', 'success');
    renderPainelFaturamento();
  } catch (err) {
    toast('Erro: ' + err.message, 'error');
  }
}

async function painelAprovarTodos(mes) {
  const token = localStorage.getItem('montana_jwt') || '';
  const btn = event?.target;
  if (btn) { btn.disabled = true; btn.textContent = 'Aprovando...'; }
  try {
    // Busca boletins rascunho do mês
    const r = await fetch(`/api/boletins/historico-mes?mes=${mes}`, {
      headers: { 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
    });
    const lista = await r.json();
    const rascunhos = (Array.isArray(lista) ? lista : []).filter(b => b.status === 'rascunho' && b.nfse_status !== 'EMITIDA');
    let aprovados = 0;
    for (const b of rascunhos) {
      const rr = await fetch(`/api/boletins/${b.id}/aprovar`, {
        method: 'POST',
        headers: { 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
      });
      if (rr.ok) aprovados++;
    }
    toast(`✅ ${aprovados} boletim(ns) aprovado(s)`, 'success');
    renderPainelFaturamento();
  } catch (err) {
    toast('Erro: ' + err.message, 'error');
    if (btn) { btn.disabled = false; }
  }
}

function painelAjustar(boletim_id, mes) {
  const token = localStorage.getItem('montana_jwt') || '';
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center';
  overlay.id = 'modal-ajustar-boletim';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:14px;padding:28px;width:380px;max-width:95vw;box-shadow:0 20px 60px rgba(0,0,0,.35)">
      <h3 style="margin:0 0 16px;font-size:16px;font-weight:800;color:#1e293b">✏️ Ajustar Boletim #${boletim_id}</h3>
      <div style="margin-bottom:12px">
        <label style="font-size:11px;font-weight:700;color:#475569;display:block;margin-bottom:4px">Glosas (R$)</label>
        <input id="ajuste-glosas" type="number" step="0.01" min="0" value="0"
          style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:7px;font-size:13px;box-sizing:border-box">
      </div>
      <div style="margin-bottom:12px">
        <label style="font-size:11px;font-weight:700;color:#475569;display:block;margin-bottom:4px">Acréscimos (R$)</label>
        <input id="ajuste-acrescimos" type="number" step="0.01" min="0" value="0"
          style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:7px;font-size:13px;box-sizing:border-box">
      </div>
      <div style="margin-bottom:16px">
        <label style="font-size:11px;font-weight:700;color:#475569;display:block;margin-bottom:4px">Observação</label>
        <textarea id="ajuste-obs" rows="2"
          style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:7px;font-size:12px;resize:vertical;box-sizing:border-box"></textarea>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button onclick="document.getElementById('modal-ajustar-boletim').remove()"
          style="padding:8px 16px;background:#f1f5f9;border:none;border-radius:7px;font-size:12px;cursor:pointer;font-weight:600">Cancelar</button>
        <button id="ajuste-btn-salvar" onclick="_painelSalvarAjuste(${boletim_id},'${mes}')"
          style="padding:8px 16px;background:#2563eb;color:#fff;border:none;border-radius:7px;font-size:12px;cursor:pointer;font-weight:700">Salvar</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

async function _painelSalvarAjuste(boletim_id, mes) {
  const token = localStorage.getItem('montana_jwt') || '';
  const btn = document.getElementById('ajuste-btn-salvar');
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }
  try {
    const glosas      = parseFloat(document.getElementById('ajuste-glosas').value) || 0;
    const acrescimos  = parseFloat(document.getElementById('ajuste-acrescimos').value) || 0;
    const obs         = document.getElementById('ajuste-obs').value || '';
    const r = await fetch(`/api/boletins/${boletim_id}/ajustar`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ glosas, acrescimos, obs }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    document.getElementById('modal-ajustar-boletim')?.remove();
    toast('✅ Ajuste salvo', 'success');
    renderPainelFaturamento();
  } catch (err) {
    toast('Erro: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Salvar'; }
  }
}

async function painelEmitirLote(mes) {
  const qtd = parseInt(event?.target?.textContent?.match(/\d+/)?.[0] || '0');
  if (qtd === 0) { toast('Nenhum boletim aprovado para emitir', 'info'); return; }
  if (!confirm(`Emitir NFS-e para ${qtd} boletim(ns) aprovado(s) de ${mes}?\n\nEsta ação envia para o WebISS e não pode ser desfeita.`)) return;

  const token = localStorage.getItem('montana_jwt') || '';
  toast('⏳ Emitindo NFS-e em lote...', 'info');

  try {
    const r = await fetch(`/api/boletins/historico-mes?mes=${mes}`, {
      headers: { 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
    });
    const lista = await r.json();
    const aprovados = (Array.isArray(lista) ? lista : []).filter(b => b.status === 'aprovado' && b.nfse_status !== 'EMITIDA');

    let emitidos = 0, erros = [];
    for (const b of aprovados) {
      const rr = await fetch(`/api/boletins/${b.id}/emitir-nfse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({}),
      });
      const dd = await rr.json();
      if (dd.ok) {
        emitidos++;
        toast(`✅ NFS-e ${dd.numero_nfse} emitida (boletim #${b.id})`, 'success');
      } else {
        erros.push(`Boletim #${b.id}: ${dd.error || 'erro desconhecido'}`);
      }
      // Pausa entre emissões para não sobrecarregar WebISS
      await new Promise(res => setTimeout(res, 1500));
    }

    renderPainelFaturamento();
    if (erros.length) {
      alert(`⚠ ${emitidos} NFS-e emitidas com sucesso.\n\nErros (${erros.length}):\n${erros.join('\n')}`);
    } else {
      toast(`✅ ${emitidos} NFS-e emitidas com sucesso!`, 'success');
    }
  } catch (err) {
    toast('Erro: ' + err.message, 'error');
  }
}

// ─── Download do pacote fiscal (ZIP) ───
// Autentica via JWT + X-Company (rotas protegidas); blob é salvo com filename do Content-Disposition
async function baixarPacoteFiscal(boletim_id) {
  try {
    toast('Gerando pacote fiscal...', 'info');
    const token = localStorage.getItem('montana_jwt') || '';
    const res = await fetch(`/api/boletins/${boletim_id}/pacote-fiscal.zip`, {
      method: 'GET',
      headers: {
        'X-Company': currentCompany,
        'Authorization': 'Bearer ' + token,
      },
    });
    if (!res.ok) {
      let msg = `Erro ${res.status}`;
      try { const j = await res.json(); msg = j.error || msg; } catch (_) {}
      toast('❌ Falha ao baixar pacote: ' + msg, 'error');
      return;
    }
    // Extrair filename do Content-Disposition
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="([^"]+)"/);
    const filename = m ? m[1] : `Pacote_Fiscal_Boletim_${boletim_id}.zip`;

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('✅ Pacote gerado: ' + filename, 'success');
  } catch (err) {
    console.error('baixarPacoteFiscal:', err);
    toast('❌ Erro ao baixar pacote: ' + err.message, 'error');
  }
}

// Seletor de contrato quando abrirGerarBoletim() chamado sem argumentos
async function _abrirSeletorContrato() {
  if (!_bolContratos.length) await loadBolContratos();
  if (!_bolContratos.length) { toast('Nenhum contrato de boletim cadastrado', 'error'); return; }

  // Buscar valores dos contratos financeiros
  const contratosFinanc = (await api('/contratos'))?.data || [];
  const valMap = {};
  for (const cf of contratosFinanc) {
    valMap[cf.numContrato] = cf.valor_mensal_bruto || 0;
  }

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.65);z-index:3000;display:flex;align-items:center;justify-content:center;padding:20px';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:14px;width:100%;max-width:500px;box-shadow:0 24px 80px rgba(0,0,0,.35);overflow:hidden">
      <div style="background:#059669;color:#fff;padding:16px 20px;display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:15px;font-weight:800">📄 Selecionar Contrato</div>
        <button onclick="this.closest('div[style*=fixed]').remove()"
          style="background:rgba(255,255,255,.2);border:none;color:#fff;font-size:18px;cursor:pointer;border-radius:6px;padding:2px 10px;line-height:1">×</button>
      </div>
      <div style="padding:16px;max-height:70vh;overflow-y:auto">
        ${_bolContratos.map(c => {
          const vm = valMap[c.contrato_ref || c.numero_contrato] || 0;
          return `<button onclick="this.closest('div[style*=fixed]').remove();abrirGerarBoletim(${c.id},'${(c.contrato_ref||c.numero_contrato||'').replace(/'/g,"\\'")}','${(c.nome||c.contratante||'').replace(/'/g,"\\'")}',${vm})"
            style="display:block;width:100%;text-align:left;padding:10px 14px;border:1.5px solid #e2e8f0;border-radius:8px;margin-bottom:8px;background:#fff;cursor:pointer;font-size:13px;transition:background .15s"
            onmouseover="this.style.background='#f0fdf4'" onmouseout="this.style.background='#fff'">
            <div style="font-weight:700;color:#0f172a">${c.nome}</div>
            <div style="font-size:11px;color:#64748b">${c.contratante || '—'} · ${vm ? brl(vm) + '/mês' : 'valor não cadastrado'}</div>
          </button>`;
        }).join('')}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
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

    const token = localStorage.getItem('montana_jwt') || '';
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
