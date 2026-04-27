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

function bolEditarContrato(id) {
  const c = _bolContratoSelecionado;
  if (!c) return;
  document.getElementById('modal-editar-contrato-bol')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'modal-editar-contrato-bol';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;overflow-y:auto;padding:20px';

  const fld = (lbl, key, hint) => `
    <div style="margin-bottom:10px">
      <label style="font-size:11px;font-weight:700;color:#475569;display:block;margin-bottom:3px">${lbl}${hint?`<span style="font-weight:400;color:#94a3b8"> — ${hint}</span>`:''}</label>
      <input id="bec-${key}" value="${(c[key]||'').replace(/"/g,'&quot;')}"
        style="width:100%;padding:7px 10px;border:1px solid #e2e8f0;border-radius:7px;font-size:12px;box-sizing:border-box">
    </div>`;

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:14px;padding:28px;width:560px;max-width:95vw;box-shadow:0 20px 60px rgba(0,0,0,.35)">
      <h3 style="margin:0 0 18px;font-size:16px;font-weight:800;color:#1e293b">✏️ Editar Contrato de Boletim</h3>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">
        ${fld('Nome','nome')}
        ${fld('Nº Contrato','numero_contrato')}
      </div>
      ${fld('Contratante (Razão Social do Órgão)','contratante')}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">
        ${fld('Processo','processo')}
        ${fld('Pregão','pregao')}
      </div>
      ${fld('Descrição do Serviço','descricao_servico')}
      ${fld('Escala','escala')}

      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px;margin:12px 0">
        <div style="font-size:11px;font-weight:800;color:#1d4ed8;margin-bottom:8px">🔗 Vinculação Financeira (necessário para emissão NFS-e)</div>
        ${fld('Referência do Contrato Financeiro','contrato_ref','numContrato exato da tabela contratos — ex: UFT 16/2025')}
        ${fld('CNPJ do Tomador','insc_municipal','CNPJ do órgão contratante — 18 caracteres c/ máscara')}
        ${fld('Orgão/Campo auxiliar','orgao','deixe vazio — preenchido automaticamente se contrato_ref estiver correto')}
      </div>

      <div style="background:#f8fafc;border-radius:8px;padding:12px;margin:12px 0">
        <div style="font-size:11px;font-weight:700;color:#475569;margin-bottom:8px">Dados da Empresa Emitente</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">
          ${fld('Razão Social','empresa_razao')}
          ${fld('CNPJ','empresa_cnpj')}
        </div>
        ${fld('Endereço','empresa_endereco')}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">
          ${fld('E-mail','empresa_email')}
          ${fld('Telefone','empresa_telefone')}
        </div>
      </div>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px">
        <button onclick="document.getElementById('modal-editar-contrato-bol').remove()"
          style="padding:8px 18px;background:#f1f5f9;border:none;border-radius:7px;font-size:12px;cursor:pointer;font-weight:600">Cancelar</button>
        <button id="bec-salvar-btn" onclick="_bolSalvarContrato(${id})"
          style="padding:8px 18px;background:#2563eb;color:#fff;border:none;border-radius:7px;font-size:12px;cursor:pointer;font-weight:700">💾 Salvar</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

async function _bolSalvarContrato(id) {
  const btn = document.getElementById('bec-salvar-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }
  const get = key => document.getElementById('bec-'+key)?.value || '';
  const token = localStorage.getItem('montana_jwt') || '';
  try {
    const r = await fetch('/api/boletins/contratos/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        nome:              get('nome'),
        contratante:       get('contratante'),
        numero_contrato:   get('numero_contrato'),
        processo:          get('processo'),
        pregao:            get('pregao'),
        descricao_servico: get('descricao_servico'),
        escala:            get('escala') || '12x36',
        empresa_razao:     get('empresa_razao'),
        empresa_cnpj:      get('empresa_cnpj'),
        empresa_endereco:  get('empresa_endereco'),
        empresa_email:     get('empresa_email'),
        empresa_telefone:  get('empresa_telefone'),
        // FIX2: campos de vinculação financeira
        contrato_ref:      get('contrato_ref'),
        orgao:             get('orgao'),
        insc_municipal:    get('insc_municipal'),
      })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Erro ao salvar');
    document.getElementById('modal-editar-contrato-bol')?.remove();
    toast('✅ Contrato atualizado!', 'success');
    bolAbrirContrato(id);
  } catch (err) {
    toast('Erro: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '💾 Salvar'; }
  }
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

// ─── Templates pré-configurados de contratos (Boletins) ─────────
// Cada template tem o JSON pronto pra POST /boletins/seed-template,
// idempotente. Cadastra contrato + postos + items + boletim em rascunho
// pra competência selecionada.
const _BOL_TEMPLATES = {
  'SEDUC_016_2023': {
    label: 'SEDUC 016/2023 — Limpeza/Conservação Palmas (R$ 209.815,61/mês)',
    empresa: 'assessoria',
    payload: {
      contrato: {
        nome: 'SEDUC',
        contratante: 'SECRETARIA DA EDUCAÇÃO DO ESTADO DO TOCANTINS',
        numero_contrato: '016/2023',
        descricao_servico: 'Prestação de serviços continuados nas áreas de limpeza, asseio e conservação, nas instalações da Secretaria da Educação do Estado do Tocantins e anexos/Palmas - TO. Considerando os serviços de copeiragem, jardinagem, serviços gerais e encarregadas. Com fornecimento de todo material e equipamentos que se fizerem necessários à execução dos serviços.',
        escala: 'Mensal',
        empresa_razao: 'MONTANA ASSESSORIA EMPRESARIAL LTDA',
        empresa_cnpj: '14.092.519/0001-51',
        empresa_endereco: 'QD. 104 SUL RUA SE 05 LOTE 19 SALA 07 CEP: 77020-018 PALMAS-TO',
        empresa_email: 'montanaempresarial@gmail.com',
        empresa_telefone: '(63) 3215-0351',
        orgao: 'SECRETARIA DA EDUCAÇÃO DO ESTADO DO TOCANTINS',
        contrato_ref: 'SEDUC 016/2023',
      },
      postos: [{
        campus_key: 'PALMAS_SEDE',
        campus_nome: 'SEDUC PALMAS - SEDE E ANEXOS',
        municipio: 'PALMAS/TO',
        descricao_posto: 'Limpeza, asseio, conservação, copeiragem e jardinagem',
        label_resumo: 'PALMAS SEDE',
        ordem: 1,
        itens: [
          { descricao: 'AUXILIAR DE SERVIÇO GERAL', quantidade: 24, valor_unitario: 5481.89 },
          { descricao: 'COPEIRA',                   quantidade: 13, valor_unitario: 4060.53 },
          { descricao: 'ENCARREGADA',               quantidade:  2, valor_unitario: 5513.62 },
          { descricao: 'JARDINEIRO',                quantidade:  3, valor_unitario: 4812.04 },
        ],
      }],
    },
  },
};

function abrirImportarTemplate() {
  const old = document.getElementById('modal-bol-template');
  if (old) old.remove();
  // Sem filtro por empresa — o backend (POST /boletins/seed-template)
  // direciona automaticamente pra empresa atual via companyMiddleware.
  // O campo `empresa` no template é apenas informativo (dica de UX).
  const empresaAtual = window.currentCompany || '(empresa atual)';
  const opcoes = Object.entries(_BOL_TEMPLATES)
    .map(([k, t]) => {
      const aviso = t.empresa && t.empresa !== window.currentCompany
        ? ` ⚠ desenhado para ${t.empresa}`
        : '';
      return `<option value="${k}">${t.label}${aviso}</option>`;
    })
    .join('');

  const modal = document.createElement('div');
  modal.id = 'modal-bol-template';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;max-width:560px;width:100%;padding:24px">
      <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:14px">
        <div>
          <div style="font-size:17px;font-weight:800;color:#0f172a">📥 Importar Template de Contrato</div>
          <div style="font-size:11px;color:#64748b;margin-top:2px">Cadastra contrato + postos + items + boletim em rascunho. Idempotente — pode rodar 2x sem duplicar.</div>
        </div>
        <button onclick="document.getElementById('modal-bol-template').remove()" style="background:none;border:none;font-size:20px;cursor:pointer;color:#64748b">✕</button>
      </div>

      ${opcoes ? `
      <div style="margin-bottom:12px">
        <label style="font-size:10px;font-weight:700;color:#475569;text-transform:uppercase;display:block;margin-bottom:4px">Template</label>
        <select id="bt-template" style="width:100%;padding:8px;font-size:12px;border:1px solid #cbd5e1;border-radius:6px">
          ${opcoes}
        </select>
      </div>
      <div style="margin-bottom:14px">
        <label style="font-size:10px;font-weight:700;color:#475569;text-transform:uppercase;display:block;margin-bottom:4px">Competência (gera boletim em rascunho)</label>
        <input id="bt-comp" type="month" value="${(()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;})()}" style="width:100%;padding:8px;font-size:12px;border:1px solid #cbd5e1;border-radius:6px">
      </div>
      <div style="margin-bottom:14px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:10px 12px">
        <div style="font-size:10px;font-weight:700;color:#c2410c;text-transform:uppercase;margin-bottom:6px">⚠ Opções avançadas (use só se houve duplicação)</div>
        <label style="font-size:11px;display:flex;align-items:center;gap:6px;cursor:pointer;margin-bottom:4px">
          <input type="checkbox" id="bt-reset-postos">
          <span><strong>Resetar postos + items</strong> antes de importar (apaga estrutura existente do contrato)</span>
        </label>
        <label style="font-size:11px;display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="bt-reset-boletim">
          <span><strong>Resetar boletim</strong> da competência (apaga rascunho/aprovado; protege EMITIDA)</span>
        </label>
        <div style="font-size:9px;color:#9a3412;margin-top:6px">Ative ambos pra fazer um clean reset desse contrato.</div>
      </div>
      <div id="bt-result" style="display:none;padding:10px 12px;border-radius:8px;font-size:11px;margin-bottom:10px"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button onclick="document.getElementById('modal-bol-template').remove()" style="padding:8px 16px;font-size:12px;border:1px solid #cbd5e1;border-radius:6px;background:#f8fafc;color:#475569;cursor:pointer">Cancelar</button>
        <button onclick="confirmarImportTemplate()" style="padding:8px 22px;font-size:12px;font-weight:800;border:none;border-radius:6px;background:#d97706;color:#fff;cursor:pointer">✓ Importar</button>
      </div>
      ` : `
      <div style="padding:14px;background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;font-size:11px;color:#92400e">
        Nenhum template disponível para a empresa <strong>${empresaAtual}</strong>.<br>
        Os templates são pré-configurados por empresa. Quem precisa adicionar templates novos: <code>app-boletins.js → _BOL_TEMPLATES</code>.
      </div>
      `}
    </div>
  `;
  document.body.appendChild(modal);
}

async function confirmarImportTemplate() {
  const sel = document.getElementById('bt-template');
  const compEl = document.getElementById('bt-comp');
  const resEl = document.getElementById('bt-result');
  if (!sel || !compEl) return;
  const tpl = _BOL_TEMPLATES[sel.value];
  if (!tpl) return;
  const competencia = compEl.value || null;
  const resetPostos  = document.getElementById('bt-reset-postos')?.checked || false;
  const resetBoletim = document.getElementById('bt-reset-boletim')?.checked || false;

  // Confirmação extra se reset estiver ativado (perigoso)
  if (resetPostos || resetBoletim) {
    const aviso = [
      resetPostos  && 'apagar TODOS os postos+items existentes do contrato',
      resetBoletim && `apagar o boletim da competência ${competencia || ''}`,
    ].filter(Boolean).join(' E ');
    if (!confirm(`⚠ Você marcou opções de reset.\n\nIsso vai ${aviso}.\n\n(Não apaga boletim com NFS-e EMITIDA — proteção.)\n\nProsseguir?`)) return;
  }

  const body = {
    ...tpl.payload,
    gerar_boletim_competencia: competencia,
    reset_postos: resetPostos,
    reset_boletim: resetBoletim,
  };
  resEl.style.display = 'block';
  resEl.style.background = '#f8fafc';
  resEl.style.color = '#334155';
  resEl.style.border = '1px solid #e2e8f0';
  resEl.innerHTML = '⏳ Cadastrando...';

  try {
    const r = await api('/boletins/seed-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(r.error || 'erro desconhecido');

    resEl.style.background = '#dcfce7';
    resEl.style.color = '#15803d';
    resEl.style.border = '1px solid #86efac';
    const resetLine = (r.reset && (r.reset.postos_deletados || r.reset.itens_deletados || r.reset.boletim_deletado))
      ? `<br>🧹 Reset: ${r.reset.postos_deletados} posto(s), ${r.reset.itens_deletados} item(ns)${r.reset.boletim_deletado ? ', boletim apagado' : ''}`
      : '';
    resEl.innerHTML = `
      ✅ <strong>Template importado.</strong>${resetLine}<br>
      Contrato: ${r.contrato_existia_antes ? 'já existia (id=' + r.contrato_id + ')' : 'criado (id=' + r.contrato_id + ')'}<br>
      Postos novos: ${r.postos_criados}, Itens novos: ${r.itens_criados}<br>
      Boletim ${competencia || ''}: ${r.boletim?.status === 'criado' ? '<strong>rascunho criado</strong> (id=' + r.boletim.id + ')' : (r.boletim?.status === 'ja_existia' ? 'já existia' : '—')}
    `;

    setTimeout(() => {
      document.getElementById('modal-bol-template')?.remove();
      // Refresh do painel/lista de boletins
      if (typeof loadBoletins === 'function') loadBoletins();
      if (typeof renderPainelFaturamento === 'function' && _bolView === 'painel') renderPainelFaturamento();
    }, 1800);
  } catch (e) {
    resEl.style.background = '#fee2e2';
    resEl.style.color = '#991b1b';
    resEl.style.border = '1px solid #fca5a5';
    resEl.innerHTML = `❌ Erro: ${e.message || e}`;
  }
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

  <!-- Aviso CNPJ não resolvido -->
  ${stats.sem_cnpj > 0 ? `
  <div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:12px;color:#92400e">
    ⚠ <strong>${stats.sem_cnpj} contrato(s)</strong> sem CNPJ do tomador configurado — emissão NFS-e falhará para eles.
    Clique em ✏️ Editar no contrato e preencha <strong>contrato_ref</strong> ou <strong>CNPJ do Tomador</strong>.
  </div>` : ''}

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

    // FIX: usa mapa global para evitar problemas de escape no onclick inline
    window._painelBoletins = window._painelBoletins || {};
    if (bol) window._painelBoletins[bol.id] = bol;
    const btnAjustar = bol.nfse_status !== 'EMITIDA'
      ? `<button onclick="painelAjustar(${bol.id},'${mes}',window._painelBoletins[${bol.id}])" title="Ajustar glosas/acréscimos"
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

// FIX: recebe objeto boletim completo para pre-preencher valores existentes
// ════════════════════════════════════════════════════════════════════
//  PAINEL AJUSTAR BOLETIM — 3 sub-abas
//   • Glosas/Acréscimos (totalizadores simples, padrão legado)
//   • Colaboradores (nominal por posto)
//   • Glosas detalhadas (motivo + valor + posto)
// ════════════════════════════════════════════════════════════════════

function _bolBrl(v) { return 'R$ ' + Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2}); }
function _bolEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// Estado mantido entre re-renders das sub-abas
window._ajusteState = {
  boletim_id: null, mes: null, valorBase: 0, bolObj: null,
  abaAtiva: 'glosas',
  colaboradores: [],   // [{ id?, posto_id, nome_colaborador, cpf, funcao, observacao }]
  glosasDet: [],       // [{ id?, posto_id, motivo, valor, data_referencia }]
  postos: [],          // [{ id, descricao_posto, mostrar_colaboradores }]
};

async function _ajusteBolFetch(url, opts) {
  const token = localStorage.getItem('montana_jwt') || '';
  const r = await fetch('/api/boletins' + url, {
    ...opts,
    headers: {
      'X-Company': currentCompany,
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(opts?.headers || {}),
    },
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || ('HTTP ' + r.status));
  }
  return r.json();
}

function painelAjustar(boletim_id, mes, bolObj) {
  const glosas     = bolObj?.glosas     || 0;
  const acrescimos = bolObj?.acrescimos || 0;
  const obs        = bolObj?.obs        || '';
  const valorBase  = bolObj?.valor_base || bolObj?.valor_total || 0;

  window._ajusteState = {
    boletim_id, mes, valorBase, bolObj,
    abaAtiva: 'glosas',
    colaboradores: [], glosasDet: [], postos: [],
  };

  document.getElementById('modal-ajustar-boletim')?.remove();
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:30px;overflow:auto';
  overlay.id = 'modal-ajustar-boletim';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:14px;padding:24px;width:760px;max-width:96vw;box-shadow:0 20px 60px rgba(0,0,0,.35)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <h3 style="margin:0;font-size:16px;font-weight:800;color:#1e293b">✏️ Ajustar Boletim #${boletim_id}</h3>
        <button onclick="document.getElementById('modal-ajustar-boletim').remove()"
          style="background:none;border:none;font-size:18px;cursor:pointer;color:#64748b">✕</button>
      </div>
      <div style="font-size:11px;color:#64748b;margin-bottom:14px">Valor base: <strong>${_bolBrl(valorBase)}</strong> · Competência: <strong>${mes}</strong></div>

      <!-- Sub-tabs -->
      <div style="display:flex;gap:0;border-bottom:2px solid #e2e8f0;margin-bottom:14px">
        <button class="aju-subtab" data-aba="glosas" onclick="_ajusteAba('glosas')"
          style="padding:8px 16px;border:none;border-bottom:2px solid #2563eb;background:transparent;font-size:12px;font-weight:700;color:#2563eb;cursor:pointer;margin-bottom:-2px">
          💰 Glosas / Acréscimos
        </button>
        <button class="aju-subtab" data-aba="colaboradores" onclick="_ajusteAba('colaboradores')"
          style="padding:8px 16px;border:none;border-bottom:2px solid transparent;background:transparent;font-size:12px;font-weight:700;color:#64748b;cursor:pointer;margin-bottom:-2px">
          🧑 Colaboradores
        </button>
        <button class="aju-subtab" data-aba="glosasdet" onclick="_ajusteAba('glosasdet')"
          style="padding:8px 16px;border:none;border-bottom:2px solid transparent;background:transparent;font-size:12px;font-weight:700;color:#64748b;cursor:pointer;margin-bottom:-2px">
          📉 Glosas detalhadas
        </button>
      </div>

      <div id="aju-conteudo" style="min-height:280px"></div>

      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px;padding-top:14px;border-top:1px solid #e2e8f0">
        <button onclick="document.getElementById('modal-ajustar-boletim').remove()"
          style="padding:8px 16px;background:#f1f5f9;border:none;border-radius:7px;font-size:12px;cursor:pointer;font-weight:600">Fechar</button>
        <button id="aju-btn-salvar" onclick="_ajusteSalvarTudo()"
          style="padding:8px 16px;background:#2563eb;color:#fff;border:none;border-radius:7px;font-size:12px;cursor:pointer;font-weight:700">💾 Salvar tudo</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // Renderiza a aba inicial e carrega dados das outras em paralelo
  _ajusteRenderAbaGlosas();
  _ajusteCarregarColaboradores().catch(()=>{});
  _ajusteCarregarGlosasDet().catch(()=>{});
  _ajusteCarregarPostos().catch(()=>{});
}

function _ajusteAba(nome) {
  window._ajusteState.abaAtiva = nome;
  // Atualiza estilo das tabs
  document.querySelectorAll('.aju-subtab').forEach(b => {
    const ativa = b.dataset.aba === nome;
    b.style.borderBottomColor = ativa ? '#2563eb' : 'transparent';
    b.style.color = ativa ? '#2563eb' : '#64748b';
  });
  // Renderiza conteúdo
  if (nome === 'glosas') _ajusteRenderAbaGlosas();
  else if (nome === 'colaboradores') _ajusteRenderAbaColaboradores();
  else if (nome === 'glosasdet') _ajusteRenderAbaGlosasDet();
}

// ─── ABA 1: Glosas / Acréscimos (legado) ──────────────────────────
function _ajusteRenderAbaGlosas() {
  const s = window._ajusteState;
  const glosas     = s.bolObj?.glosas     || 0;
  const acrescimos = s.bolObj?.acrescimos || 0;
  const obs        = s.bolObj?.obs        || '';
  const cont = document.getElementById('aju-conteudo');
  if (!cont) return;
  cont.innerHTML = `
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px;margin-bottom:14px;font-size:11px;color:#854d0e">
      💡 Use estes campos para ajustes simples (totalizadores). Para detalhar glosas por posto/motivo, use a aba <strong>Glosas detalhadas</strong>. O total das glosas detalhadas sobrescreve este campo.
    </div>
    <div style="margin-bottom:12px">
      <label style="font-size:11px;font-weight:700;color:#475569;display:block;margin-bottom:4px">Glosas — total (R$)</label>
      <input id="ajuste-glosas" type="number" step="0.01" min="0" value="${glosas}"
        oninput="_ajustePreview(${s.valorBase})"
        style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:7px;font-size:13px;box-sizing:border-box">
    </div>
    <div style="margin-bottom:12px">
      <label style="font-size:11px;font-weight:700;color:#475569;display:block;margin-bottom:4px">Acréscimos (R$)</label>
      <input id="ajuste-acrescimos" type="number" step="0.01" min="0" value="${acrescimos}"
        oninput="_ajustePreview(${s.valorBase})"
        style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:7px;font-size:13px;box-sizing:border-box">
    </div>
    <div id="ajuste-preview" style="background:#f8fafc;border-radius:8px;padding:10px;margin-bottom:12px;font-size:12px;text-align:center;color:#1e293b">
      Valor final: <strong id="ajuste-preview-val">${_bolBrl(s.valorBase - glosas + acrescimos)}</strong>
    </div>
    <div>
      <label style="font-size:11px;font-weight:700;color:#475569;display:block;margin-bottom:4px">Observação</label>
      <textarea id="ajuste-obs" rows="2"
        style="width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:7px;font-size:12px;resize:vertical;box-sizing:border-box">${_bolEsc(obs)}</textarea>
    </div>`;
}

function _ajustePreview(base) {
  const g = parseFloat(document.getElementById('ajuste-glosas')?.value) || 0;
  const a = parseFloat(document.getElementById('ajuste-acrescimos')?.value) || 0;
  const total = base - g + a;
  const el = document.getElementById('ajuste-preview-val');
  if (el) el.textContent = 'R$ ' + total.toLocaleString('pt-BR',{minimumFractionDigits:2});
}

// ─── ABA 2: Colaboradores ─────────────────────────────────────────
async function _ajusteCarregarColaboradores() {
  const s = window._ajusteState;
  try {
    const r = await _ajusteBolFetch('/' + s.boletim_id + '/colaboradores');
    s.colaboradores = (r.colaboradores || []).map(c => ({ ...c, _saved: true }));
    if (s.abaAtiva === 'colaboradores') _ajusteRenderAbaColaboradores();
  } catch (_) {}
}

async function _ajusteCarregarPostos() {
  const s = window._ajusteState;
  if (!s.bolObj?.contrato_id) return;
  try {
    const r = await _ajusteBolFetch('/contratos/' + s.bolObj.contrato_id + '/postos');
    s.postos = Array.isArray(r) ? r : (r.postos || []);
    if (s.abaAtiva === 'colaboradores') _ajusteRenderAbaColaboradores();
  } catch (_) {}
}

function _ajusteRenderAbaColaboradores() {
  const s = window._ajusteState;
  const cont = document.getElementById('aju-conteudo');
  if (!cont) return;

  const postoOptions = (postoId) => {
    const opts = ['<option value="">— sem posto —</option>'];
    for (const p of s.postos) {
      const sel = String(p.id) === String(postoId) ? ' selected' : '';
      opts.push(`<option value="${p.id}"${sel}>${_bolEsc(p.descricao_posto || p.campus_nome || ('Posto ' + p.id))}${p.mostrar_colaboradores === false ? ' (oculto na NF)' : ''}</option>`);
    }
    return opts.join('');
  };

  const linhas = s.colaboradores.map((c, i) => `
    <tr>
      <td style="padding:3px 4px"><input value="${_bolEsc(c.nome_colaborador||'')}" oninput="_ajusteState.colaboradores[${i}].nome_colaborador=this.value;_ajusteState.colaboradores[${i}]._dirty=true" placeholder="Nome completo" style="width:100%;padding:4px 6px;border:1px solid #e2e8f0;border-radius:4px;font-size:11px"></td>
      <td style="padding:3px 4px"><input value="${_bolEsc(c.cpf||'')}" oninput="_ajusteState.colaboradores[${i}].cpf=this.value;_ajusteState.colaboradores[${i}]._dirty=true" placeholder="CPF" style="width:100%;padding:4px 6px;border:1px solid #e2e8f0;border-radius:4px;font-size:11px"></td>
      <td style="padding:3px 4px"><input value="${_bolEsc(c.funcao||'')}" oninput="_ajusteState.colaboradores[${i}].funcao=this.value;_ajusteState.colaboradores[${i}]._dirty=true" placeholder="Função" style="width:100%;padding:4px 6px;border:1px solid #e2e8f0;border-radius:4px;font-size:11px"></td>
      <td style="padding:3px 4px"><select onchange="_ajusteState.colaboradores[${i}].posto_id=this.value||null;_ajusteState.colaboradores[${i}]._dirty=true" style="width:100%;padding:4px;border:1px solid #e2e8f0;border-radius:4px;font-size:11px">${postoOptions(c.posto_id)}</select></td>
      <td style="padding:3px 4px;text-align:center;width:40px"><button onclick="_ajusteRemoverColab(${i})" style="background:#fef2f2;border:1px solid #fca5a5;color:#dc2626;padding:2px 7px;border-radius:4px;cursor:pointer;font-size:10px;font-weight:700">×</button></td>
    </tr>`).join('');

  cont.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:6px">
      <div style="font-size:11px;color:#475569">
        ${s.colaboradores.length} colaborador${s.colaboradores.length===1?'':'es'} ·
        ${s.postos.length} posto${s.postos.length===1?'':'s'} no contrato
      </div>
      <div style="display:flex;gap:6px">
        <button onclick="_ajusteCopiarMesAnterior()" title="Copia colaboradores do boletim anterior do mesmo contrato"
          style="background:#dbeafe;color:#1d4ed8;border:1px solid #93c5fd;padding:5px 10px;border-radius:5px;cursor:pointer;font-size:10px;font-weight:700">📋 Copiar mês anterior</button>
        <button onclick="_ajusteAddColab()"
          style="background:#dcfce7;color:#15803d;border:1px solid #86efac;padding:5px 10px;border-radius:5px;cursor:pointer;font-size:10px;font-weight:700">+ Adicionar</button>
      </div>
    </div>
    <div style="max-height:340px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px">
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <thead style="background:#f8fafc;position:sticky;top:0">
          <tr>
            <th style="padding:6px 4px;text-align:left;font-size:10px;color:#475569;font-weight:700">Nome *</th>
            <th style="padding:6px 4px;text-align:left;font-size:10px;color:#475569;font-weight:700;width:120px">CPF</th>
            <th style="padding:6px 4px;text-align:left;font-size:10px;color:#475569;font-weight:700;width:120px">Função</th>
            <th style="padding:6px 4px;text-align:left;font-size:10px;color:#475569;font-weight:700;width:180px">Posto</th>
            <th style="width:40px"></th>
          </tr>
        </thead>
        <tbody>${linhas || '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:30px;font-size:11px">Nenhum colaborador cadastrado.<br>Clique em <strong>+ Adicionar</strong> ou <strong>📋 Copiar mês anterior</strong>.</td></tr>'}</tbody>
      </table>
    </div>
    <div style="margin-top:10px;font-size:10px;color:#64748b">
      Postos com flag "<strong>oculto na NF</strong>" não nominam colaboradores na descrição da NF emitida (sigilo / contratos de segurança privada).
    </div>`;
}

function _ajusteAddColab() {
  window._ajusteState.colaboradores.push({ nome_colaborador: '', cpf: '', funcao: '', posto_id: null, _dirty: true });
  _ajusteRenderAbaColaboradores();
}

function _ajusteRemoverColab(idx) {
  const c = window._ajusteState.colaboradores[idx];
  if (c?.id && c?._saved) {
    if (!confirm('Remover ' + (c.nome_colaborador || 'este colaborador') + ' permanentemente?')) return;
    c._delete = true;
    // mantém na lista pra ser deletado no save
    _ajusteRenderAbaColaboradores();
  } else {
    window._ajusteState.colaboradores.splice(idx, 1);
    _ajusteRenderAbaColaboradores();
  }
}

async function _ajusteCopiarMesAnterior() {
  const s = window._ajusteState;
  if (!confirm('Copiar colaboradores do boletim anterior do mesmo contrato?\nIsso SUBSTITUI a lista atual.')) return;
  try {
    const r = await _ajusteBolFetch('/' + s.boletim_id + '/colaboradores/copiar-mes-anterior', { method: 'POST' });
    if (typeof toast === 'function') toast('✅ ' + (r.copiados || 0) + ' colaborador(es) copiado(s) do boletim ' + (r.fonte_boletim_id || 'anterior'), 'success');
    await _ajusteCarregarColaboradores();
  } catch (e) {
    if (typeof toast === 'function') toast('Erro: ' + e.message, 'error');
  }
}

// ─── ABA 3: Glosas detalhadas ─────────────────────────────────────
async function _ajusteCarregarGlosasDet() {
  const s = window._ajusteState;
  try {
    const r = await _ajusteBolFetch('/' + s.boletim_id + '/glosas');
    s.glosasDet = (r.glosas || []).map(g => ({ ...g, _saved: true }));
    if (s.abaAtiva === 'glosasdet') _ajusteRenderAbaGlosasDet();
  } catch (_) {}
}

function _ajusteRenderAbaGlosasDet() {
  const s = window._ajusteState;
  const cont = document.getElementById('aju-conteudo');
  if (!cont) return;
  const total = s.glosasDet.filter(g => !g._delete).reduce((sum, g) => sum + (parseFloat(g.valor) || 0), 0);

  const postoOptions = (postoId) => {
    const opts = ['<option value="">— geral —</option>'];
    for (const p of s.postos) {
      const sel = String(p.id) === String(postoId) ? ' selected' : '';
      opts.push(`<option value="${p.id}"${sel}>${_bolEsc(p.descricao_posto || p.campus_nome || ('Posto ' + p.id))}</option>`);
    }
    return opts.join('');
  };

  const linhas = s.glosasDet.map((g, i) => g._delete ? '' : `
    <tr>
      <td style="padding:3px 4px"><input value="${_bolEsc(g.motivo||'')}" oninput="_ajusteState.glosasDet[${i}].motivo=this.value;_ajusteState.glosasDet[${i}]._dirty=true" placeholder="Ex: 3 dias de falta colaborador X" style="width:100%;padding:4px 6px;border:1px solid #e2e8f0;border-radius:4px;font-size:11px"></td>
      <td style="padding:3px 4px"><input type="number" step="0.01" value="${g.valor||0}" oninput="_ajusteState.glosasDet[${i}].valor=parseFloat(this.value)||0;_ajusteState.glosasDet[${i}]._dirty=true;_ajusteRecalcGlosaTotal()" style="width:100%;padding:4px 6px;border:1px solid #e2e8f0;border-radius:4px;font-size:11px;text-align:right;font-family:monospace"></td>
      <td style="padding:3px 4px"><select onchange="_ajusteState.glosasDet[${i}].posto_id=this.value||null;_ajusteState.glosasDet[${i}]._dirty=true" style="width:100%;padding:4px;border:1px solid #e2e8f0;border-radius:4px;font-size:11px">${postoOptions(g.posto_id)}</select></td>
      <td style="padding:3px 4px"><input type="date" value="${g.data_referencia||''}" oninput="_ajusteState.glosasDet[${i}].data_referencia=this.value;_ajusteState.glosasDet[${i}]._dirty=true" style="width:100%;padding:4px 6px;border:1px solid #e2e8f0;border-radius:4px;font-size:11px"></td>
      <td style="padding:3px 4px;text-align:center;width:40px"><button onclick="_ajusteRemoverGlosa(${i})" style="background:#fef2f2;border:1px solid #fca5a5;color:#dc2626;padding:2px 7px;border-radius:4px;cursor:pointer;font-size:10px;font-weight:700">×</button></td>
    </tr>`).join('');

  cont.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:6px">
      <div style="font-size:11px;color:#475569">
        ${s.glosasDet.filter(g=>!g._delete).length} glosa${s.glosasDet.filter(g=>!g._delete).length===1?'':'s'} · Total <strong id="aju-glosa-total">${_bolBrl(total)}</strong>
      </div>
      <button onclick="_ajusteAddGlosa()"
        style="background:#fef9c3;color:#854d0e;border:1px solid #fde68a;padding:5px 10px;border-radius:5px;cursor:pointer;font-size:10px;font-weight:700">+ Adicionar glosa</button>
    </div>
    <div style="max-height:340px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px">
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <thead style="background:#f8fafc;position:sticky;top:0">
          <tr>
            <th style="padding:6px 4px;text-align:left;font-size:10px;color:#475569;font-weight:700">Motivo *</th>
            <th style="padding:6px 4px;text-align:right;font-size:10px;color:#475569;font-weight:700;width:120px">Valor (R$) *</th>
            <th style="padding:6px 4px;text-align:left;font-size:10px;color:#475569;font-weight:700;width:160px">Posto</th>
            <th style="padding:6px 4px;text-align:left;font-size:10px;color:#475569;font-weight:700;width:130px">Data</th>
            <th style="width:40px"></th>
          </tr>
        </thead>
        <tbody>${linhas || '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:30px;font-size:11px">Nenhuma glosa detalhada.<br>Clique em <strong>+ Adicionar glosa</strong>.</td></tr>'}</tbody>
      </table>
    </div>
    <div style="margin-top:10px;font-size:10px;color:#64748b">
      Ao salvar, o total das glosas detalhadas é gravado em <code>bol_boletins.glosas</code> e <code>valor_total</code> é recalculado automaticamente.
    </div>`;
}

function _ajusteAddGlosa() {
  window._ajusteState.glosasDet.push({ motivo: '', valor: 0, posto_id: null, data_referencia: '', _dirty: true });
  _ajusteRenderAbaGlosasDet();
}

function _ajusteRemoverGlosa(idx) {
  const g = window._ajusteState.glosasDet[idx];
  if (g?.id && g?._saved) {
    if (!confirm('Remover esta glosa permanentemente?')) return;
    g._delete = true;
    _ajusteRenderAbaGlosasDet();
  } else {
    window._ajusteState.glosasDet.splice(idx, 1);
    _ajusteRenderAbaGlosasDet();
  }
}

function _ajusteRecalcGlosaTotal() {
  const s = window._ajusteState;
  const total = s.glosasDet.filter(g => !g._delete).reduce((sum, g) => sum + (parseFloat(g.valor) || 0), 0);
  const el = document.getElementById('aju-glosa-total');
  if (el) el.textContent = _bolBrl(total);
}

// ─── SALVAR TUDO ──────────────────────────────────────────────────
async function _ajusteSalvarTudo() {
  const s = window._ajusteState;
  const btn = document.getElementById('aju-btn-salvar');
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }
  let erros = [];

  try {
    // 1. Glosas/Acréscimos legado (se aba renderizada e campos existem)
    const gEl = document.getElementById('ajuste-glosas');
    if (gEl) {
      const glosas      = parseFloat(gEl.value) || 0;
      const acrescimos  = parseFloat(document.getElementById('ajuste-acrescimos')?.value) || 0;
      const obs         = document.getElementById('ajuste-obs')?.value || '';
      try {
        await _ajusteBolFetch('/' + s.boletim_id + '/ajustar', {
          method: 'PATCH',
          body: JSON.stringify({ glosas, acrescimos, obs }),
        });
      } catch (e) { erros.push('Glosas/Acréscimos: ' + e.message); }
    }

    // 2. Colaboradores — DELETE pendentes, PUT modificados, POST novos em lote
    const colabsParaDeletar = s.colaboradores.filter(c => c._delete && c.id);
    const colabsParaAtualizar = s.colaboradores.filter(c => c.id && c._saved && c._dirty && !c._delete);
    const colabsNovos = s.colaboradores.filter(c => !c.id && !c._delete && (c.nome_colaborador || '').trim());

    for (const c of colabsParaDeletar) {
      try { await _ajusteBolFetch('/colaboradores/' + c.id, { method: 'DELETE' }); }
      catch (e) { erros.push('Excluir colaborador #' + c.id + ': ' + e.message); }
    }
    for (const c of colabsParaAtualizar) {
      try {
        await _ajusteBolFetch('/colaboradores/' + c.id, {
          method: 'PUT',
          body: JSON.stringify({
            nome_colaborador: c.nome_colaborador, cpf: c.cpf || null,
            funcao: c.funcao || null, observacao: c.observacao || null,
          }),
        });
      } catch (e) { erros.push('Atualizar colaborador: ' + e.message); }
    }
    if (colabsNovos.length) {
      try {
        await _ajusteBolFetch('/' + s.boletim_id + '/colaboradores', {
          method: 'POST',
          body: JSON.stringify({ colaboradores: colabsNovos }),
        });
      } catch (e) { erros.push('Inserir colaboradores: ' + e.message); }
    }

    // 3. Glosas detalhadas
    const glosasParaDeletar = s.glosasDet.filter(g => g._delete && g.id);
    const glosasParaAtualizar = s.glosasDet.filter(g => g.id && g._saved && g._dirty && !g._delete);
    const glosasNovas = s.glosasDet.filter(g => !g.id && !g._delete && (g.motivo || '').trim() && parseFloat(g.valor) > 0);

    for (const g of glosasParaDeletar) {
      try { await _ajusteBolFetch('/glosas/' + g.id, { method: 'DELETE' }); }
      catch (e) { erros.push('Excluir glosa #' + g.id + ': ' + e.message); }
    }
    for (const g of glosasParaAtualizar) {
      try {
        await _ajusteBolFetch('/glosas/' + g.id, {
          method: 'PUT',
          body: JSON.stringify({
            motivo: g.motivo, valor: parseFloat(g.valor) || 0,
            posto_id: g.posto_id || null, data_referencia: g.data_referencia || null,
          }),
        });
      } catch (e) { erros.push('Atualizar glosa: ' + e.message); }
    }
    for (const g of glosasNovas) {
      try {
        await _ajusteBolFetch('/' + s.boletim_id + '/glosas', {
          method: 'POST',
          body: JSON.stringify({
            motivo: g.motivo, valor: parseFloat(g.valor) || 0,
            posto_id: g.posto_id || null, data_referencia: g.data_referencia || null,
          }),
        });
      } catch (e) { erros.push('Inserir glosa: ' + e.message); }
    }

    if (erros.length) {
      if (typeof toast === 'function') toast('⚠ ' + erros.length + ' erro(s): ' + erros[0], 'error');
      console.error('[ajuste] erros:', erros);
      if (btn) { btn.disabled = false; btn.textContent = '💾 Salvar tudo'; }
      return;
    }

    document.getElementById('modal-ajustar-boletim')?.remove();
    if (typeof toast === 'function') toast('✅ Ajustes salvos', 'success');
    if (typeof renderPainelFaturamento === 'function') renderPainelFaturamento();
  } catch (err) {
    if (typeof toast === 'function') toast('Erro inesperado: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '💾 Salvar tudo'; }
  }
}

// Backwards compat — código legado pode chamar essa função diretamente
async function _painelSalvarAjuste(boletim_id, mes) { return _ajusteSalvarTudo(); }

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
      // FIX: pausa de 2500ms — WebISS limita ~1 req/2s
      await new Promise(res => setTimeout(res, 2500));
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
