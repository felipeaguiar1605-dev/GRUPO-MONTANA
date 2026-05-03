/**
 * Montana — Frontend do fluxo Prévia → Aprovação → Emissão → Boletim Final
 * Acoplado ao app-boletins.js (usa api(), toast(), currentCompany).
 *
 * Endpoints consumidos:
 *   POST  /boletins/previa
 *   GET   /boletins/previas
 *   PATCH /boletins/:id/aprovar
 *   PATCH /boletins/:id/cancelar-previa
 *   PATCH /boletins/nfs-planejadas/:id
 *   DELETE /boletins/nfs-planejadas/:id
 *   POST  /boletins/:id/emitir-nfs
 *   GET   /boletins/:id/emissao-status (SSE)
 */
'use strict';

let _previaCompetencia = null;
let _previas = [];
let _previaSelected = new Set(); // P0-1: bulk selection

// ─── Util ─────────────────────────────────────────────────────────
function _brl(n) {
  if (n === null || n === undefined || n === '') return 'R$ 0,00';
  return 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _statusBadge(status) {
  const m = {
    'previa':                { label: 'Prévia',     color: '#fff', bg: '#3b82f6' },
    'aprovado_para_emissao': { label: 'Aprovado',   color: '#fff', bg: '#059669' },
    'emitindo':              { label: 'Emitindo…',  color: '#fff', bg: '#d97706' },
    'emitido':               { label: 'Emitido',    color: '#fff', bg: '#16a34a' },
    'erro_emissao':          { label: 'Erro',       color: '#fff', bg: '#dc2626' },
    'cancelado':             { label: 'Cancelado',  color: '#475569', bg: '#e2e8f0' },
    'gerado':                { label: 'Gerado',     color: '#475569', bg: '#e2e8f0' },
    'sem_nf':                { label: 'Sem NF',     color: '#92400e', bg: '#fef3c7' },
    'conciliado_nf':         { label: 'Conciliado', color: '#fff', bg: '#16a34a' },
    'divergencia_nf':        { label: 'Divergência', color: '#fff', bg: '#f59e0b' },
  };
  const s = m[status] || { label: status, color: '#475569', bg: '#e2e8f0' };
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;background:${s.bg};color:${s.color}">${s.label}</span>`;
}

// ─── Tela principal: lista de prévias do mês ──────────────────────
async function abrirPrevias() {
  const container = document.getElementById('bol-content');
  if (!container) return;

  const hoje = new Date();
  const compDefault = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
  const comp = _previaCompetencia || compDefault;

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <h3 style="margin:0;font-size:16px">📋 Prévias de Boletins — ${comp}</h3>
      <input type="month" id="prev-comp" value="${comp}" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12px">
      <button class="btn btn-primary btn-sm" onclick="bolPreviaCarregar()">🔄 Carregar</button>
      <button class="btn btn-success btn-sm" onclick="bolPreviaGerar()">⚙️ Gerar prévias do mês</button>
      <button class="btn btn-sm" onclick="renderBolLista()">← Voltar</button>
    </div>
    <div id="prev-content"><div class="loading">Carregando…</div></div>
  `;
  await bolPreviaCarregar();
}

async function bolPreviaCarregar() {
  const compInput = document.getElementById('prev-comp');
  const comp = compInput?.value || _previaCompetencia;
  if (!comp) return;
  _previaCompetencia = comp;

  const dest = document.getElementById('prev-content');
  if (!dest) return;
  dest.innerHTML = '<div class="loading">Carregando…</div>';

  try {
    const r = await api(`/boletins/previas?competencia=${encodeURIComponent(comp)}`);
    if (!r.ok) { dest.innerHTML = `<div style="color:#dc2626">Erro: ${r.error || 'desconhecido'}</div>`; return; }
    _previas = r.data || [];
    _bolPreviaRender();
  } catch (e) {
    dest.innerHTML = `<div style="color:#dc2626">Erro: ${e.message}</div>`;
  }
}

function _bolPreviaRender() {
  const dest = document.getElementById('prev-content');
  if (!dest) return;

  if (_previas.length === 0) {
    dest.innerHTML = `
      <div style="padding:30px;text-align:center;background:#f8fafc;border:2px dashed #cbd5e1;border-radius:10px;color:#64748b">
        <div style="font-size:32px;margin-bottom:8px">📭</div>
        <div style="font-weight:600">Nenhuma prévia para ${_previaCompetencia}</div>
        <div style="font-size:12px;margin-top:6px">Clique em <strong>"⚙️ Gerar prévias do mês"</strong> para criar.</div>
      </div>
    `;
    return;
  }

  // P0-1: limpa seleção que não existe mais nas prévias atuais
  for (const id of [..._previaSelected]) {
    if (!_previas.find(p => p.id === id)) _previaSelected.delete(id);
  }

  // Agrupa por status
  const porStatus = {};
  for (const p of _previas) {
    if (!porStatus[p.status]) porStatus[p.status] = [];
    porStatus[p.status].push(p);
  }
  const totalGeral = _previas.reduce((s, p) => s + Number(p.total_geral || 0), 0);

  // Bulk actions disponíveis para os selecionados
  const selecionadas = _previas.filter(p => _previaSelected.has(p.id));
  const podeAprovarAll = selecionadas.length > 0 && selecionadas.every(p => p.status === 'previa');
  const podeEmitirAll = selecionadas.length > 0 && selecionadas.every(p => p.status === 'aprovado_para_emissao');
  const podeCancelarAll = selecionadas.length > 0 && selecionadas.every(p => ['previa','aprovado_para_emissao'].includes(p.status));

  let html = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:14px">
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px">
        <div style="font-size:10px;color:#64748b;font-weight:600;text-transform:uppercase">Total geral</div>
        <div style="font-size:18px;font-weight:800;color:#0f172a">${_brl(totalGeral)}</div>
        <div style="font-size:11px;color:#94a3b8">${_previas.length} boletim(ns)</div>
      </div>
      ${Object.entries(porStatus).map(([s, list]) => `
        <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px;cursor:pointer" onclick="bolPreviaSelectByStatus('${s}')">
          ${_statusBadge(s)}
          <div style="font-size:18px;font-weight:800;color:#0f172a;margin-top:6px">${list.length}</div>
          <div style="font-size:11px;color:#94a3b8">${_brl(list.reduce((s2, p) => s2 + Number(p.total_geral || 0), 0))}</div>
          <div style="font-size:9px;color:#3b82f6;margin-top:2px">↓ clique pra selecionar todas</div>
        </div>
      `).join('')}
    </div>

    <!-- Barra de bulk actions (P0-1) -->
    <div id="prev-bulk-bar" style="display:${selecionadas.length > 0 ? 'flex' : 'none'};align-items:center;gap:10px;background:#1e293b;color:#fff;padding:10px 14px;border-radius:8px;margin-bottom:10px;flex-wrap:wrap">
      <span style="font-weight:700">📋 ${selecionadas.length} selecionada(s)</span>
      <span style="font-size:12px;opacity:.8">· ${_brl(selecionadas.reduce((s, p) => s + Number(p.total_geral || 0), 0))}</span>
      <span style="flex:1"></span>
      <button class="btn btn-xs btn-success" ${podeAprovarAll ? '' : 'disabled style="opacity:.4;cursor:not-allowed"'} onclick="bolPreviaAprovarLote()">✓ Aprovar todas</button>
      <button class="btn btn-xs btn-primary" ${podeEmitirAll ? '' : 'disabled style="opacity:.4;cursor:not-allowed"'} onclick="bolPreviaEmitirLote()">📤 Emitir todas</button>
      <button class="btn btn-xs btn-danger"  ${podeCancelarAll ? '' : 'disabled style="opacity:.4;cursor:not-allowed"'} onclick="bolPreviaCancelarLote()">✕ Cancelar</button>
      <button class="btn btn-xs" onclick="bolPreviaLimparSel()" style="background:#475569;color:#fff;border-color:#475569">Limpar seleção</button>
    </div>

    <div class="tw" style="margin-top:8px">
      <table>
        <thead>
          <tr>
            <th style="width:30px"><input type="checkbox" id="prev-check-all" onchange="bolPreviaToggleAll(this.checked)"></th>
            <th>Contrato</th>
            <th>Posto</th>
            <th>Status</th>
            <th>NFs</th>
            <th class="r">Valor</th>
            <th>Expira</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody>
          ${_previas.map(p => _renderLinhaPrevia(p)).join('')}
        </tbody>
      </table>
    </div>
  `;
  dest.innerHTML = html;
}

function _renderLinhaPrevia(p) {
  const nfsStatus = (p.nfs_planejadas || []).reduce((acc, n) => {
    acc[n.status] = (acc[n.status] || 0) + 1;
    return acc;
  }, {});
  const nfsResumo = Object.entries(nfsStatus).map(([s, n]) => `${n}× ${s}`).join(', ') || '—';

  let acoes = '';
  if (p.status === 'previa') {
    acoes = `
      <button class="btn btn-xs btn-success" onclick="bolPreviaAprovar(${p.id})">✓ Aprovar</button>
      <button class="btn btn-xs" onclick="bolPreviaDetalhe(${p.id})">📄 Detalhes</button>
      <button class="btn btn-xs btn-danger" onclick="bolPreviaCancelar(${p.id})">✕</button>
    `;
  } else if (p.status === 'aprovado_para_emissao') {
    acoes = `
      <button class="btn btn-xs btn-primary" onclick="bolPreviaEmitir(${p.id})">📤 Emitir NFs</button>
      <button class="btn btn-xs" onclick="bolPreviaDetalhe(${p.id})">📄 Detalhes</button>
    `;
  } else if (p.status === 'emitindo') {
    acoes = `<button class="btn btn-xs btn-warning" onclick="bolPreviaProgress(${p.id})">⏳ Acompanhar…</button>`;
  } else if (p.status === 'erro_emissao') {
    // P0-5: retry de erro
    acoes = `
      <button class="btn btn-xs btn-danger" onclick="bolPreviaRetry(${p.id})">🔄 Reemitir falhas</button>
      <button class="btn btn-xs" onclick="bolPreviaDetalhe(${p.id})">📄 Detalhes</button>
    `;
  } else {
    acoes = `<button class="btn btn-xs" onclick="bolPreviaDetalhe(${p.id})">📄 Detalhes</button>`;
  }

  const expiraTag = p.expira_em && p.status === 'previa'
    ? `<span style="font-size:10px;color:#94a3b8">${p.expira_em}</span>`
    : '—';

  const checked = _previaSelected.has(p.id) ? 'checked' : '';
  const selectable = ['previa', 'aprovado_para_emissao'].includes(p.status);

  return `
    <tr ${_previaSelected.has(p.id) ? 'style="background:#dbeafe"' : ''}>
      <td><input type="checkbox" ${checked} ${selectable ? '' : 'disabled'} onchange="bolPreviaToggle(${p.id})"></td>
      <td>
        <strong>${p.contrato_nome || ''}</strong>
        <div style="font-size:10px;color:#64748b">${p.numero_contrato || ''}</div>
      </td>
      <td>${p.posto_nome || '—'}<div style="font-size:10px;color:#64748b">${p.posto_municipio || ''}</div></td>
      <td>${_statusBadge(p.status)}</td>
      <td style="font-size:11px">${nfsResumo}</td>
      <td class="r"><strong>${_brl(p.total_geral)}</strong></td>
      <td>${expiraTag}</td>
      <td style="white-space:nowrap">${acoes}</td>
    </tr>
  `;
}

// ─── P0-1: Bulk actions ──────────────────────────────────────────
function bolPreviaToggle(id) {
  if (_previaSelected.has(id)) _previaSelected.delete(id);
  else _previaSelected.add(id);
  _bolPreviaRender();
}

function bolPreviaToggleAll(checked) {
  if (checked) {
    for (const p of _previas) {
      if (['previa', 'aprovado_para_emissao'].includes(p.status)) {
        _previaSelected.add(p.id);
      }
    }
  } else {
    _previaSelected.clear();
  }
  _bolPreviaRender();
}

function bolPreviaSelectByStatus(status) {
  for (const p of _previas) {
    if (p.status === status && ['previa', 'aprovado_para_emissao'].includes(p.status)) {
      _previaSelected.add(p.id);
    }
  }
  _bolPreviaRender();
}

function bolPreviaLimparSel() {
  _previaSelected.clear();
  _bolPreviaRender();
}

async function bolPreviaAprovarLote() {
  const ids = [..._previaSelected];
  if (ids.length === 0) return;
  const valor = _previas.filter(p => ids.includes(p.id)).reduce((s, p) => s + Number(p.total_geral || 0), 0);
  if (!confirm(`Aprovar ${ids.length} prévia(s) totalizando ${_brl(valor)}?`)) return;

  const token = localStorage.getItem('montana_jwt') || '';
  const r = await fetch('/api/boletins/aprovar-em-lote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ ids }),
  }).then(r => r.json());

  if (r.ok) {
    let msg = `✓ ${r.aprovados} aprovada(s)`;
    if (r.ignorados) msg += `, ${r.ignorados} já estavam aprovadas/emitidas`;
    if (r.erros?.length) msg += `, ${r.erros.length} com erro`;
    toast(msg, 'success');
    if (r.erros?.length) console.warn('Erros:', r.erros);
    _previaSelected.clear();
    await bolPreviaCarregar();
  } else {
    toast('Erro: ' + (r.error || 'desconhecido'), 'error');
  }
}

async function bolPreviaEmitirLote() {
  const ids = [..._previaSelected];
  if (ids.length === 0) return;
  // Conta total de NFs a emitir
  const totNfs = _previas.filter(p => ids.includes(p.id))
    .reduce((s, p) => s + (p.nfs_planejadas || []).filter(n => n.status === 'pendente').length, 0);
  if (!confirm(`Emitir ${totNfs} NF(s) de ${ids.length} boletim(ns) no WebISS Palmas?\n\nIsso pode levar ~${Math.ceil(totNfs * 30 / 60)} minutos. Acompanhe o progresso na tela.`)) return;

  const token = localStorage.getItem('montana_jwt') || '';
  const r = await fetch('/api/boletins/emitir-lote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ ids }),
  }).then(r => r.json());

  if (r.ok) {
    toast(`📤 Emissão iniciada: ${r.total_aceitos} aceitos, ${r.total_recusados} recusados`, 'success');
    _previaSelected.clear();
    // Abre modal de progresso multi-boletim
    bolPreviaProgressLote(r.aceitos);
  } else {
    toast('Erro: ' + (r.error || 'desconhecido'), 'error');
  }
}

async function bolPreviaCancelarLote() {
  const ids = [..._previaSelected];
  if (ids.length === 0) return;
  const motivo = await _modalMotivo(`Cancelar ${ids.length} prévia(s)`, 'Informe o motivo do cancelamento (obrigatório para audit fiscal):');
  if (!motivo) return;
  let cancelados = 0, erros = 0;
  const token = localStorage.getItem('montana_jwt') || '';
  for (const id of ids) {
    const r = await fetch(`/api/boletins/${id}/cancelar-previa`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ motivo }),
    }).then(r => r.json()).catch(() => ({ ok: false }));
    if (r.ok) cancelados++; else erros++;
  }
  toast(`${cancelados} cancelada(s)${erros ? `, ${erros} erro(s)` : ''}`, cancelados > 0 ? 'success' : 'error');
  _previaSelected.clear();
  await bolPreviaCarregar();
}

// P0-7: modal de motivo (substitui prompt() que tem UX ruim)
function _modalMotivo(titulo, descricao) {
  return new Promise(resolve => {
    document.getElementById('modal-motivo')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'modal-motivo';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000;display:flex;align-items:flex-start;justify-content:center;padding:5vh 20px';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:20px;width:min(440px, 92vw);box-shadow:0 20px 60px rgba(0,0,0,.35)">
        <h3 style="margin:0 0 8px;font-size:14px;font-weight:800">${titulo}</h3>
        <p style="margin:0 0 12px;font-size:12px;color:#475569">${descricao}</p>
        <textarea id="mm-input" rows="4" placeholder="Mínimo 5 caracteres" style="width:100%;padding:8px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:12px;font-family:inherit;resize:vertical;box-sizing:border-box"></textarea>
        <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:10px">
          <button class="btn btn-sm" onclick="document.getElementById('modal-motivo').remove();window._mmResolve(null)">Cancelar</button>
          <button class="btn btn-sm btn-primary" onclick="(()=>{const v=document.getElementById('mm-input').value.trim();if(v.length<5){toast('Mínimo 5 caracteres','error');return}document.getElementById('modal-motivo').remove();window._mmResolve(v)})()">Confirmar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    setTimeout(() => document.getElementById('mm-input')?.focus(), 50);
    window._mmResolve = resolve;
  });
}

// P0-5: Retry de NF com erro WebISS
async function bolPreviaRetry(id) {
  const p = _previas.find(x => x.id === id);
  if (!p) return;
  const erros = (p.nfs_planejadas || []).filter(n => n.status === 'erro').length;
  if (!confirm(`Reemitir ${erros} NF(s) com erro deste boletim?`)) return;

  const token = localStorage.getItem('montana_jwt') || '';
  // Volta status do boletim pra aprovado_para_emissao via patch direto
  // (alternativa: criar endpoint dedicado, mas o emitir-nfs já aceita force_retry)
  const r = await fetch(`/api/boletins/${id}/emitir-nfs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ force_retry: true }),
  }).then(r => r.json());

  if (r.ok && r.job_id) {
    bolPreviaProgress(r.job_id);
  } else {
    // Se status do boletim impede, tenta voltar ele pra 'aprovado_para_emissao'
    if ((r.error || '').includes('aprovado_para_emissao')) {
      toast('Boletim em estado inválido para retry. Veja Detalhes.', 'error');
    } else {
      toast('Erro: ' + (r.error || 'desconhecido'), 'error');
    }
  }
}

// Progresso de emissão em lote (vários boletins simultâneos)
function bolPreviaProgressLote(boletimIds) {
  document.getElementById('modal-emissao-lote')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'modal-emissao-lote';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:3vh 20px';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:22px;width:min(720px, 95vw);max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.35)">
      <h3 style="margin:0 0 12px;font-size:14px;font-weight:800">📤 Emitindo NFs em lote (${boletimIds.length} boletins)</h3>
      <div id="el-stats" style="background:#f8fafc;padding:10px;border-radius:8px;margin-bottom:12px;font-size:12px;display:flex;gap:14px;flex-wrap:wrap">
        <span>📋 Total: <strong>${boletimIds.length}</strong></span>
        <span style="color:#16a34a">✓ Concluídos: <strong id="el-done">0</strong></span>
        <span style="color:#d97706">⏳ Em andamento: <strong id="el-running">0</strong></span>
        <span style="color:#dc2626">✗ Com erro: <strong id="el-err">0</strong></span>
      </div>
      <div id="el-list" style="max-height:50vh;overflow-y:auto"></div>
      <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:12px">
        <button class="btn btn-sm" onclick="document.getElementById('modal-emissao-lote').remove();bolPreviaCarregar()">Fechar e atualizar</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const list = document.getElementById('el-list');
  const counts = { done: 0, running: 0, err: 0 };
  const status = {};

  for (const id of boletimIds) {
    const div = document.createElement('div');
    div.id = 'el-' + id;
    div.style.cssText = 'padding:8px 10px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:10px;font-size:11px';
    const p = _previas.find(x => x.id === id);
    div.innerHTML = `
      <span style="flex:1">
        <strong>${p?.contrato_nome || '#'+id}</strong>
        ${p?.posto_nome ? '<span style="color:#64748b"> / '+p.posto_nome+'</span>' : ''}
      </span>
      <span class="el-prog" style="font-size:10px;color:#64748b">aguardando…</span>
    `;
    list.appendChild(div);
    status[id] = 'queued';
    counts.running++;

    // Conecta SSE individual
    const token = localStorage.getItem('montana_jwt') || '';
    const ctrl = new AbortController();
    fetch(`/api/boletins/${id}/emissao-status`, {
      headers: { 'Accept': 'text/event-stream', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
      signal: ctrl.signal,
    }).then(async r => {
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';
        for (const blk of blocks) {
          const lines = blk.split('\n');
          let evt = 'message', data = '';
          for (const ln of lines) {
            if (ln.startsWith('event:')) evt = ln.slice(6).trim();
            if (ln.startsWith('data:')) data += ln.slice(5).trim();
          }
          if (!data) continue;
          try {
            const obj = JSON.parse(data);
            const prog = div.querySelector('.el-prog');
            if (evt === 'snapshot' || evt === 'progress') {
              const stats = await fetch(`/api/boletins/previas?contrato_id=${p?.contrato_id || 0}&status=emitindo,emitido,erro_emissao,aprovado_para_emissao`, {
                headers: { 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
              }).then(r => r.json()).catch(() => null);
              prog.textContent = `${obj.emitidas || 0}/${obj.total || '?'} emitidas, ${obj.erros || 0} erros`;
              prog.style.color = '#d97706';
            }
            if (evt === 'done') {
              if (status[id] === 'queued') counts.running--;
              if (obj.status_boletim === 'emitido') {
                prog.textContent = `✓ ${obj.emitidas} emitidas`;
                prog.style.color = '#16a34a';
                counts.done++;
                status[id] = 'done';
              } else {
                prog.textContent = `✗ ${obj.erros} erros, ${obj.emitidas} ok`;
                prog.style.color = '#dc2626';
                counts.err++;
                status[id] = 'err';
              }
              document.getElementById('el-done').textContent = counts.done;
              document.getElementById('el-err').textContent = counts.err;
              document.getElementById('el-running').textContent = counts.running;
            }
          } catch (_) {}
        }
      }
    }).catch(() => {});
  }
}

// ─── Geração de prévias (dry-run + diff modal + apply) ─────────────
async function bolPreviaGerar() {
  const comp = document.getElementById('prev-comp')?.value || _previaCompetencia;
  if (!comp) { toast('Informe a competência', 'error'); return; }

  // Dry-run primeiro
  const token = localStorage.getItem('montana_jwt') || '';
  toast('Calculando prévias…', 'info');
  const dry = await fetch('/api/boletins/previa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ competencia: comp, apply: false }),
  }).then(r => r.json());

  if (!dry.ok) { toast('Erro: ' + (dry.error || 'desconhecido'), 'error'); return; }

  // P0-3: modal com diff em vez de confirm() simples
  // Compara valor proposto x boletim existente (se houver)
  const existentesMap = new Map(_previas.map(p => [`${p.contrato_id}|${p.posto_id || 0}`, p]));
  const linhas = (dry.previas || []).map(p => {
    const key = `${p.contrato_id}|${p.posto_id || 0}`;
    const exist = existentesMap.get(key);
    const valorAtual = exist ? Number(exist.total_geral || 0) : 0;
    const delta = Number(p.valor_final || 0) - valorAtual;
    return { ...p, valor_atual: valorAtual, delta, _action: !exist ? 'create' : (Math.abs(delta) < 0.01 ? 'same' : 'update') };
  });

  const totalAntes = linhas.reduce((s, l) => s + l.valor_atual, 0);
  const totalDepois = linhas.reduce((s, l) => s + Number(l.valor_final || 0), 0);
  const totalDelta = totalDepois - totalAntes;
  const novos = linhas.filter(l => l._action === 'create').length;
  const alterados = linhas.filter(l => l._action === 'update').length;
  const sameCount = linhas.filter(l => l._action === 'same').length;

  const aprovado = await new Promise(resolve => {
    document.getElementById('modal-previa-diff')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'modal-previa-diff';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:3vh 20px;overflow-y:auto';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:18px 20px;width:min(820px, 95vw);max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.35)">
        <h3 style="margin:0 0 8px;font-size:14px;font-weight:800">📋 Pré-visualização — gerar prévias para ${comp}</h3>
        <div style="background:#f8fafc;padding:10px;border-radius:8px;margin-bottom:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;font-size:12px">
          <div><div style="font-size:9px;color:#64748b;text-transform:uppercase">Total antes</div><strong>${_brl(totalAntes)}</strong></div>
          <div><div style="font-size:9px;color:#64748b;text-transform:uppercase">Total depois</div><strong style="color:#1d4ed8">${_brl(totalDepois)}</strong></div>
          <div><div style="font-size:9px;color:#64748b;text-transform:uppercase">Delta</div><strong style="color:${totalDelta >= 0 ? '#16a34a' : '#dc2626'}">${totalDelta >= 0 ? '+' : ''}${_brl(totalDelta)}</strong></div>
          <div><div style="font-size:9px;color:#64748b;text-transform:uppercase">Novos</div><strong>${novos}</strong></div>
          <div><div style="font-size:9px;color:#64748b;text-transform:uppercase">Alterados</div><strong style="color:#d97706">${alterados}</strong></div>
          <div><div style="font-size:9px;color:#64748b;text-transform:uppercase">Inalterados</div><strong style="color:#94a3b8">${sameCount}</strong></div>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:11px">
          <thead style="background:#f1f5f9;position:sticky;top:0">
            <tr>
              <th style="padding:6px;text-align:left">Contrato / Posto</th>
              <th style="padding:6px;text-align:center">Ação</th>
              <th style="padding:6px;text-align:right">Atual</th>
              <th style="padding:6px;text-align:right">Proposto</th>
              <th style="padding:6px;text-align:right">Δ</th>
              <th style="padding:6px;text-align:left">Origem</th>
            </tr>
          </thead>
          <tbody>
            ${linhas.map(l => {
              const tag = l._action === 'create' ? '<span style="color:#16a34a;font-weight:700">+ NOVO</span>' :
                          l._action === 'update' ? '<span style="color:#d97706;font-weight:700">~ MUDA</span>' :
                          '<span style="color:#94a3b8">= igual</span>';
              const deltaStr = l.delta === 0 ? '—' : (l.delta > 0 ? '+' : '') + _brl(l.delta);
              const deltaCol = l.delta > 0 ? '#16a34a' : (l.delta < 0 ? '#dc2626' : '#94a3b8');
              const aditivos = (l.aditivos_aplicados || []).length;
              return `
                <tr style="border-bottom:1px solid #f1f5f9${l._action === 'update' ? ';background:#fef9c3' : ''}">
                  <td style="padding:6px"><strong>${l.contrato_nome || ''}</strong>${l.posto_nome ? '<span style="color:#64748b"> / ' + l.posto_nome + '</span>' : ''}<div style="font-size:9px;color:#94a3b8">${l.contrato_numero || ''}</div></td>
                  <td style="padding:6px;text-align:center">${tag}</td>
                  <td style="padding:6px;text-align:right;color:#94a3b8">${l._action === 'create' ? '—' : _brl(l.valor_atual)}</td>
                  <td style="padding:6px;text-align:right;font-weight:600">${_brl(l.valor_final)}</td>
                  <td style="padding:6px;text-align:right;color:${deltaCol};font-family:monospace">${deltaStr}</td>
                  <td style="padding:6px;font-size:9px;color:#64748b">${l.origem_valor}${aditivos ? ` · <span style="color:#7c3aed">+${aditivos} aditivo(s)</span>` : ''}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button class="btn btn-sm" onclick="document.getElementById('modal-previa-diff').remove();window._gerarResolve(false)">Cancelar</button>
          <button class="btn btn-sm btn-primary" onclick="document.getElementById('modal-previa-diff').remove();window._gerarResolve(true)">✓ Gerar ${linhas.length} prévia(s)</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    window._gerarResolve = resolve;
  });

  if (!aprovado) return;

  const apply = await fetch('/api/boletins/previa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ competencia: comp, apply: true }),
  }).then(r => r.json());

  if (apply.ok) {
    toast(`✓ ${apply.criados} criadas, ${apply.atualizados} atualizadas`, 'success');
    await bolPreviaCarregar();
  } else {
    toast('Erro: ' + (apply.error || 'desconhecido'), 'error');
  }
}

// ─── Aprovar prévia ───────────────────────────────────────────────
async function bolPreviaAprovar(id) {
  const p = _previas.find(x => x.id === id);
  if (!p) return;
  if (!confirm(`Aprovar prévia "${p.contrato_nome}"${p.posto_nome ? ' / ' + p.posto_nome : ''} (${_brl(p.total_geral)}) para emissão?`)) return;

  const token = localStorage.getItem('montana_jwt') || '';
  const r = await fetch(`/api/boletins/${id}/aprovar`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
  }).then(r => r.json());

  if (r.ok) {
    toast('✓ Aprovado', 'success');
    await bolPreviaCarregar();
  } else {
    toast('Erro: ' + (r.error || 'desconhecido'), 'error');
  }
}

async function bolPreviaCancelar(id) {
  // P0-7: motivo obrigatório
  const motivo = await _modalMotivo('Cancelar prévia', 'Informe o motivo do cancelamento (obrigatório para audit fiscal):');
  if (!motivo) return;
  const token = localStorage.getItem('montana_jwt') || '';
  const r = await fetch(`/api/boletins/${id}/cancelar-previa`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ motivo }),
  }).then(r => r.json());
  if (r.ok) { toast('Cancelado', 'info'); await bolPreviaCarregar(); }
  else { toast('Erro: ' + (r.error || ''), 'error'); }
}

// ─── Emissão NFs (assíncrona via SSE) ─────────────────────────────
async function bolPreviaEmitir(id) {
  const p = _previas.find(x => x.id === id);
  if (!p) return;
  const totNfs = (p.nfs_planejadas || []).filter(n => n.status === 'pendente').length;
  if (!confirm(`Emitir ${totNfs} NF(s) deste boletim no WebISS Palmas? Isso é irreversível após sucesso.`)) return;

  const token = localStorage.getItem('montana_jwt') || '';
  const r = await fetch(`/api/boletins/${id}/emitir-nfs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
    body: '{}',
  }).then(r => r.json());

  if (r.ok && r.job_id) {
    bolPreviaProgress(r.job_id);
  } else {
    toast('Erro: ' + (r.error || 'desconhecido'), 'error');
  }
}

// Modal de progresso de emissão (com SSE)
function bolPreviaProgress(boletimId) {
  document.getElementById('modal-emissao-progress')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'modal-emissao-progress';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:5vh 20px';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:22px;width:min(560px, 92vw);max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.35)">
      <h3 style="margin:0 0 12px;font-size:14px;font-weight:800">📤 Emitindo NFs — Boletim #${boletimId}</h3>
      <div id="ep-progresso" style="margin:14px 0">
        <div id="ep-bar-bg" style="background:#e2e8f0;border-radius:8px;height:18px;overflow:hidden">
          <div id="ep-bar-fill" style="background:linear-gradient(90deg,#1d4ed8,#3b82f6);height:100%;width:0%;transition:width .25s"></div>
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:11px;color:#475569">
          <span id="ep-stats">Aguardando…</span>
          <span id="ep-pct">0%</span>
        </div>
      </div>
      <div id="ep-log" style="background:#0f172a;color:#cbd5e1;font-family:monospace;font-size:11px;padding:10px;border-radius:6px;height:200px;overflow-y:auto"></div>
      <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:12px">
        <button id="ep-fechar-btn" onclick="bolPreviaProgressFechar()" class="btn btn-sm">Fechar</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const log = (msg, color) => {
    const el = document.getElementById('ep-log');
    if (!el) return;
    const div = document.createElement('div');
    div.style.cssText = `padding:2px 0${color ? ';color:' + color : ''}`;
    div.textContent = `[${new Date().toLocaleTimeString('pt-BR')}] ${msg}`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  };

  // Conecta SSE — usando fetch/streaming pra suportar headers (EventSource não suporta auth header)
  const token = localStorage.getItem('montana_jwt') || '';
  const ctrl = new AbortController();
  window._epSSEAbort = ctrl;

  fetch(`/api/boletins/${boletimId}/emissao-status`, {
    headers: { 'Accept': 'text/event-stream', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
    signal: ctrl.signal,
  }).then(async r => {
    if (!r.ok) { log('Erro de conexão SSE: HTTP ' + r.status, '#fca5a5'); return; }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';
      for (const blk of blocks) {
        if (!blk.trim()) continue;
        const lines = blk.split('\n');
        let evt = 'message', data = '';
        for (const ln of lines) {
          if (ln.startsWith('event:')) evt = ln.slice(6).trim();
          if (ln.startsWith('data:')) data += ln.slice(5).trim();
        }
        if (!data) continue;
        try {
          const obj = JSON.parse(data);
          _bolPreviaProgressHandle(evt, obj, log);
        } catch (e) {
          log('Erro parse SSE: ' + e.message, '#fca5a5');
        }
      }
    }
  }).catch(err => {
    if (err.name === 'AbortError') return;
    log('Erro SSE: ' + err.message, '#fca5a5');
  });

  log('Conectando ao stream de emissão…');
}

function _bolPreviaProgressHandle(evt, obj, log) {
  if (evt === 'snapshot') {
    log(`Snapshot: total=${obj.total} emitidas=${obj.emitidas} pendentes=${obj.pendentes} erros=${obj.erros}`);
    _bolEpUpdate(obj.emitidas, obj.total);
  } else if (evt === 'progress') {
    if (obj.status === 'emitida') {
      log(`✓ NF planejada #${obj.nf_planejada_id} emitida — NFS-e ${obj.nfse_numero} (${_brl(obj.valor)})`, '#86efac');
    } else if (obj.status === 'erro') {
      log(`✕ NF planejada #${obj.nf_planejada_id} erro: ${obj.erro}`, '#fca5a5');
    } else if (obj.status === 'emitindo') {
      log(`⌛ Emitindo NF planejada #${obj.nf_planejada_id}…`, '#fcd34d');
    }
  } else if (evt === 'done') {
    log(`✓ Concluído. status=${obj.status_boletim} emitidas=${obj.emitidas} erros=${obj.erros}`, '#86efac');
    _bolEpUpdate(obj.emitidas, obj.total);
    setTimeout(async () => {
      await bolPreviaCarregar();  // reload da lista
    }, 1500);
  } else if (evt === 'fatal') {
    log('✗ ERRO FATAL: ' + (obj.erro || 'desconhecido'), '#fca5a5');
  }
}

function _bolEpUpdate(emitidas, total) {
  const pct = total > 0 ? Math.round((emitidas / total) * 100) : 0;
  document.getElementById('ep-bar-fill').style.width = pct + '%';
  document.getElementById('ep-pct').textContent = pct + '%';
  document.getElementById('ep-stats').textContent = `${emitidas}/${total}`;
}

function bolPreviaProgressFechar() {
  if (window._epSSEAbort) try { window._epSSEAbort.abort(); } catch (_) {}
  document.getElementById('modal-emissao-progress')?.remove();
}

// ─── Detalhes (modal com NFs planejadas + edit override) ──────────
function bolPreviaDetalhe(id) {
  const p = _previas.find(x => x.id === id);
  if (!p) return;

  document.getElementById('modal-previa-detalhe')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'modal-previa-detalhe';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:3vh 20px';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:22px;width:min(720px, 95vw);max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.35)">
      <h3 style="margin:0 0 4px;font-size:15px;font-weight:800">${p.contrato_nome}${p.posto_nome ? ' / ' + p.posto_nome : ''}</h3>
      <div style="font-size:11px;color:#64748b;margin-bottom:14px">
        Contrato ${p.numero_contrato} · Competência ${p.competencia} · ${_statusBadge(p.status)}
      </div>

      <div style="background:#f8fafc;border-radius:8px;padding:12px;margin-bottom:14px;font-size:11px">
        <div><strong>Total geral:</strong> ${_brl(p.total_geral)}</div>
        <div><strong>Período:</strong> ${p.periodo_inicio} → ${p.periodo_fim}</div>
        ${p.expira_em ? `<div><strong>Expira em:</strong> ${p.expira_em}</div>` : ''}
        ${p.aprovado_por ? `<div><strong>Aprovado por:</strong> ${p.aprovado_por} em ${p.aprovado_em}</div>` : ''}
      </div>

      <h4 style="margin:0 0 6px;font-size:12px;font-weight:700">📜 Discriminação renderizada</h4>
      <div style="background:#fefce8;border:1px solid #fde047;border-radius:6px;padding:10px;font-family:monospace;font-size:10px;white-space:pre-wrap;max-height:200px;overflow-y:auto;margin-bottom:14px">${(p.template_renderizado || '').replace(/</g, '&lt;')}</div>

      <h4 style="margin:0 0 6px;font-size:12px;font-weight:700">🧾 NFs planejadas (${(p.nfs_planejadas || []).length})</h4>
      <table style="width:100%;font-size:11px;border-collapse:collapse">
        <thead style="background:#f1f5f9">
          <tr><th style="padding:6px;text-align:left">#</th><th style="padding:6px;text-align:left">Status</th><th style="padding:6px;text-align:right">Valor</th><th style="padding:6px;text-align:left">NFS-e</th></tr>
        </thead>
        <tbody>
          ${(p.nfs_planejadas || []).map(n => `
            <tr>
              <td style="padding:6px">${n.id}</td>
              <td style="padding:6px">${_statusBadge(n.status)}</td>
              <td style="padding:6px;text-align:right;font-weight:600">${_brl(n.valor)}</td>
              <td style="padding:6px;font-family:monospace">${n.nfse_numero || '—'}${n.erro_mensagem ? `<div style="color:#dc2626;font-size:9px">${n.erro_mensagem.slice(0, 80)}</div>` : ''}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:14px">
        <button class="btn btn-sm" onclick="document.getElementById('modal-previa-detalhe').remove()">Fechar</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

// Exposição global
window.abrirPrevias = abrirPrevias;
window.bolPreviaCarregar = bolPreviaCarregar;
window.bolPreviaGerar = bolPreviaGerar;
window.bolPreviaAprovar = bolPreviaAprovar;
window.bolPreviaCancelar = bolPreviaCancelar;
window.bolPreviaEmitir = bolPreviaEmitir;
window.bolPreviaProgress = bolPreviaProgress;
window.bolPreviaProgressFechar = bolPreviaProgressFechar;
window.bolPreviaDetalhe = bolPreviaDetalhe;
// P0-1 bulk
window.bolPreviaToggle = bolPreviaToggle;
window.bolPreviaToggleAll = bolPreviaToggleAll;
window.bolPreviaSelectByStatus = bolPreviaSelectByStatus;
window.bolPreviaLimparSel = bolPreviaLimparSel;
window.bolPreviaAprovarLote = bolPreviaAprovarLote;
window.bolPreviaEmitirLote = bolPreviaEmitirLote;
window.bolPreviaCancelarLote = bolPreviaCancelarLote;
window.bolPreviaProgressLote = bolPreviaProgressLote;
// P0-5 retry
window.bolPreviaRetry = bolPreviaRetry;
// Helper modal de motivo (usado por outros módulos também)
window._modalMotivo = _modalMotivo;
