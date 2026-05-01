/**
 * Montana — Frontend para gestão de aditivos contratuais (Q3)
 * Fluxo: cadastra (rascunho) → preview impacto → valida (humano) → aplicado (auto na próxima prévia)
 */
'use strict';

let _aditivos = [];
let _aditivosContratoFilter = null;

function _brlA(n) {
  if (n === null || n === undefined || n === '') return 'R$ 0,00';
  return 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _aditStatusBadge(s) {
  const m = {
    rascunho:  { l: 'Rascunho',  bg: '#fef3c7', co: '#92400e' },
    validado:  { l: 'Validado',  bg: '#dbeafe', co: '#1d4ed8' },
    aplicado:  { l: 'Aplicado',  bg: '#dcfce7', co: '#15803d' },
    cancelado: { l: 'Cancelado', bg: '#f1f5f9', co: '#475569' },
  };
  const x = m[s] || { l: s, bg: '#f1f5f9', co: '#475569' };
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;background:${x.bg};color:${x.co}">${x.l}</span>`;
}

function _tipoTag(t) {
  const m = {
    reajuste: { l: 'Reajuste', co: '#1d4ed8' },
    prorrogacao: { l: 'Prorrogação', co: '#7c3aed' },
    apostilamento: { l: 'Apostilamento', co: '#0891b2' },
    reequilibrio: { l: 'Reequilíbrio', co: '#d97706' },
  };
  const x = m[t] || { l: t, co: '#475569' };
  return `<span style="font-size:10px;font-weight:700;color:${x.co}">${x.l}</span>`;
}

async function abrirAditivos() {
  const container = document.getElementById('bol-content');
  if (!container) return;
  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">
      <h3 style="margin:0;font-size:16px">📑 Aditivos Contratuais</h3>
      <button class="btn btn-primary btn-sm" onclick="abrirAditivoNovo()">+ Novo aditivo</button>
      <button class="btn btn-sm" onclick="aditivosCarregar()">🔄</button>
      <button class="btn btn-sm" onclick="renderBolLista()">← Voltar</button>
    </div>
    <div id="adit-content"><div class="loading">Carregando…</div></div>
  `;
  await aditivosCarregar();
}

async function aditivosCarregar() {
  const dest = document.getElementById('adit-content');
  if (!dest) return;
  dest.innerHTML = '<div class="loading">Carregando…</div>';
  try {
    const r = await api('/boletins/aditivos');
    if (!r.ok) { dest.innerHTML = `<div style="color:#dc2626">Erro: ${r.error || ''}</div>`; return; }
    _aditivos = r.data || [];
    _renderAditivos();
  } catch (e) {
    dest.innerHTML = `<div style="color:#dc2626">Erro: ${e.message}</div>`;
  }
}

function _renderAditivos() {
  const dest = document.getElementById('adit-content');
  if (!dest) return;
  if (_aditivos.length === 0) {
    dest.innerHTML = `
      <div style="padding:30px;text-align:center;background:#f8fafc;border:2px dashed #cbd5e1;border-radius:10px;color:#64748b">
        <div style="font-size:32px;margin-bottom:8px">📭</div>
        <div style="font-weight:600">Nenhum aditivo cadastrado</div>
        <div style="font-size:12px;margin-top:6px">Clique em <strong>"+ Novo aditivo"</strong> para registrar reajustes, prorrogações, apostilamentos ou reequilíbrios.</div>
      </div>
    `;
    return;
  }

  dest.innerHTML = `
    <div class="tw">
      <table>
        <thead>
          <tr>
            <th>Contrato</th>
            <th>Tipo</th>
            <th>Vigência</th>
            <th>Fator</th>
            <th>Base legal</th>
            <th>Status</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody>
          ${_aditivos.map(a => `
            <tr>
              <td>
                <strong>${a.contrato_nome || ''}</strong>
                <div style="font-size:10px;color:#64748b">${a.numero_contrato || ''}</div>
              </td>
              <td>${_tipoTag(a.tipo)}</td>
              <td style="font-size:11px">
                ${a.vigencia_de}${a.vigencia_ate ? ` → ${a.vigencia_ate}` : ' →'}
              </td>
              <td style="font-family:monospace;text-align:center">
                ${a.tipo === 'reajuste' ? `${(Number(a.fator) * 100 - 100).toFixed(2)}%` : '—'}
              </td>
              <td style="font-size:10px;color:#64748b;max-width:200px">${a.base_legal || ''}</td>
              <td>${_aditStatusBadge(a.status)}</td>
              <td style="white-space:nowrap">
                ${_aditAcoes(a)}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function _aditAcoes(a) {
  if (a.status === 'rascunho') {
    return `
      <button class="btn btn-xs btn-primary" onclick="aditivoPreviewImpacto(${a.id})">🔍 Preview</button>
      <button class="btn btn-xs btn-success" onclick="aditivoValidar(${a.id})">✓ Validar</button>
      <button class="btn btn-xs" onclick="abrirAditivoEditar(${a.id})">✏️</button>
      <button class="btn btn-xs btn-danger" onclick="aditivoExcluir(${a.id})">🗑️</button>
    `;
  }
  if (a.status === 'validado') {
    return `
      <button class="btn btn-xs btn-warning" onclick="aditivoCancelar(${a.id})">Cancelar</button>
    `;
  }
  return '—';
}

// ─── Modal: novo / editar ──────────────────────────────────────────
async function abrirAditivoNovo() { _abrirAditivoModal(null); }
async function abrirAditivoEditar(id) {
  const a = _aditivos.find(x => x.id === id);
  if (!a) return;
  _abrirAditivoModal(a);
}

async function _abrirAditivoModal(aditivo) {
  // Carregar contratos pra select
  let contratosOpts = '';
  try {
    const r = await api('/boletins/contratos');
    contratosOpts = (r || []).map(c => `
      <option value="${c.id}" ${aditivo?.contrato_id === c.id ? 'selected' : ''}>
        ${c.nome} (${c.numero_contrato || '?'})
      </option>
    `).join('');
  } catch (_) {}

  document.getElementById('modal-aditivo')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'modal-aditivo';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:5vh 20px';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:18px 20px;width:min(560px, 92vw);box-shadow:0 20px 60px rgba(0,0,0,.35);font-size:12px">
      <h3 style="margin:0 0 14px;font-size:14px;font-weight:800">${aditivo ? '✏️ Editar' : '+ Novo'} Aditivo</h3>

      <label style="font-size:10px;font-weight:700;color:#475569;display:block;margin-bottom:2px">Contrato</label>
      <select id="ad-contrato" style="width:100%;padding:6px 9px;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:8px;font-size:11px" ${aditivo ? 'disabled' : ''}>
        <option value="">— selecione —</option>
        ${contratosOpts}
      </select>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
        <div>
          <label style="font-size:10px;font-weight:700;color:#475569;display:block;margin-bottom:2px">Tipo</label>
          <select id="ad-tipo" style="width:100%;padding:6px 9px;border:1px solid #e2e8f0;border-radius:6px;font-size:11px">
            <option value="reajuste"      ${aditivo?.tipo === 'reajuste'      ? 'selected' : ''}>Reajuste</option>
            <option value="prorrogacao"   ${aditivo?.tipo === 'prorrogacao'   ? 'selected' : ''}>Prorrogação</option>
            <option value="apostilamento" ${aditivo?.tipo === 'apostilamento' ? 'selected' : ''}>Apostilamento</option>
            <option value="reequilibrio"  ${aditivo?.tipo === 'reequilibrio'  ? 'selected' : ''}>Reequilíbrio</option>
          </select>
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;color:#475569;display:block;margin-bottom:2px">Data assinatura</label>
          <input id="ad-data-ass" type="date" value="${aditivo?.data_assinatura || ''}" style="width:100%;padding:6px 9px;border:1px solid #e2e8f0;border-radius:6px;font-size:11px">
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
        <div>
          <label style="font-size:10px;font-weight:700;color:#475569;display:block;margin-bottom:2px">Vigência início *</label>
          <input id="ad-vig-de" type="date" value="${aditivo?.vigencia_de || ''}" style="width:100%;padding:6px 9px;border:1px solid #e2e8f0;border-radius:6px;font-size:11px">
        </div>
        <div>
          <label style="font-size:10px;font-weight:700;color:#475569;display:block;margin-bottom:2px">Vigência fim (opcional)</label>
          <input id="ad-vig-ate" type="date" value="${aditivo?.vigencia_ate || ''}" style="width:100%;padding:6px 9px;border:1px solid #e2e8f0;border-radius:6px;font-size:11px">
        </div>
      </div>

      <label style="font-size:10px;font-weight:700;color:#475569;display:block;margin-bottom:2px">
        Fator <span style="font-weight:400;color:#94a3b8">— para reajuste (ex: 1.0825 = +8.25%)</span>
      </label>
      <input id="ad-fator" type="number" step="0.0001" value="${aditivo?.fator || '1.0000'}" style="width:100%;padding:6px 9px;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:8px;font-size:11px;font-family:monospace">

      <label style="font-size:10px;font-weight:700;color:#475569;display:block;margin-bottom:2px">Base legal</label>
      <input id="ad-base" type="text" placeholder="Ex: CCT 24/2025 SINTECAP/TO" value="${aditivo?.base_legal || ''}" style="width:100%;padding:6px 9px;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:8px;font-size:11px">

      <label style="font-size:10px;font-weight:700;color:#475569;display:block;margin-bottom:2px">Observação</label>
      <textarea id="ad-obs" rows="3" style="width:100%;padding:6px 9px;border:1px solid #e2e8f0;border-radius:6px;font-size:11px;font-family:inherit;resize:vertical">${aditivo?.observacao || ''}</textarea>

      <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:14px">
        <button class="btn btn-sm" onclick="document.getElementById('modal-aditivo').remove()">Cancelar</button>
        <button class="btn btn-sm btn-primary" onclick="aditivoSalvar(${aditivo?.id || 'null'})">💾 Salvar</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

async function aditivoSalvar(id) {
  const body = {
    contrato_id: id ? undefined : Number(document.getElementById('ad-contrato')?.value),
    tipo: document.getElementById('ad-tipo')?.value,
    data_assinatura: document.getElementById('ad-data-ass')?.value || null,
    vigencia_de: document.getElementById('ad-vig-de')?.value,
    vigencia_ate: document.getElementById('ad-vig-ate')?.value || null,
    fator: Number(document.getElementById('ad-fator')?.value || 1),
    base_legal: document.getElementById('ad-base')?.value || '',
    observacao: document.getElementById('ad-obs')?.value || '',
  };

  if (!id && !body.contrato_id) { toast('Selecione um contrato', 'error'); return; }
  if (!body.vigencia_de) { toast('Vigência início obrigatória', 'error'); return; }

  const token = localStorage.getItem('montana_jwt') || '';
  const url = id ? `/api/boletins/aditivos/${id}` : '/api/boletins/aditivos';
  const method = id ? 'PATCH' : 'POST';

  const r = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json', 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
    body: JSON.stringify(body),
  }).then(r => r.json());

  if (r.ok) {
    toast(id ? 'Atualizado' : 'Aditivo cadastrado (rascunho)', 'success');
    document.getElementById('modal-aditivo')?.remove();
    await aditivosCarregar();
  } else {
    toast('Erro: ' + (r.error || 'desconhecido'), 'error');
  }
}

async function aditivoPreviewImpacto(id) {
  try {
    const r = await api(`/boletins/aditivos/${id}/preview-impacto`);
    if (!r.ok) { toast('Erro: ' + (r.error || ''), 'error'); return; }
    const p = r.preview;
    const txt = `Preview do impacto:

Competência alvo: ${p.competencia}
Boletim de referência: ${p.ref_boletim_competencia || '— sem histórico —'}
Valor base: ${_brlA(p.valor_base_referencia)}
Fator: ${p.fator_aplicado}
Valor após aditivo: ${_brlA(p.valor_apos_aditivo)}
Diferença: ${_brlA(p.diferenca)} (${p.diferenca_pct > 0 ? '+' : ''}${p.diferenca_pct}%)

${r.observacao || ''}`;
    alert(txt);
  } catch (e) {
    toast('Erro: ' + e.message, 'error');
  }
}

async function aditivoValidar(id) {
  if (!confirm('Validar este aditivo? A partir daqui ele será aplicado automaticamente nas próximas prévias dentro da vigência.')) return;
  const token = localStorage.getItem('montana_jwt') || '';
  const r = await fetch(`/api/boletins/aditivos/${id}/validar`, {
    method: 'PATCH',
    headers: { 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
  }).then(r => r.json());
  if (r.ok) { toast('✓ Validado', 'success'); await aditivosCarregar(); }
  else { toast('Erro: ' + (r.error || ''), 'error'); }
}

async function aditivoCancelar(id) {
  if (!confirm('Cancelar este aditivo? Ele não será mais aplicado em prévias futuras.')) return;
  const token = localStorage.getItem('montana_jwt') || '';
  const r = await fetch(`/api/boletins/aditivos/${id}/cancelar`, {
    method: 'PATCH',
    headers: { 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
  }).then(r => r.json());
  if (r.ok) { toast('Cancelado', 'info'); await aditivosCarregar(); }
  else { toast('Erro: ' + (r.error || ''), 'error'); }
}

async function aditivoExcluir(id) {
  if (!confirm('Excluir este rascunho de aditivo? Esta ação não pode ser desfeita.')) return;
  const token = localStorage.getItem('montana_jwt') || '';
  const r = await fetch(`/api/boletins/aditivos/${id}`, {
    method: 'DELETE',
    headers: { 'X-Company': currentCompany, 'Authorization': 'Bearer ' + token },
  }).then(r => r.json());
  if (r.ok) { toast('Excluído', 'info'); await aditivosCarregar(); }
  else { toast('Erro: ' + (r.error || ''), 'error'); }
}

window.abrirAditivos = abrirAditivos;
window.aditivosCarregar = aditivosCarregar;
window.abrirAditivoNovo = abrirAditivoNovo;
window.abrirAditivoEditar = abrirAditivoEditar;
window.aditivoSalvar = aditivoSalvar;
window.aditivoPreviewImpacto = aditivoPreviewImpacto;
window.aditivoValidar = aditivoValidar;
window.aditivoCancelar = aditivoCancelar;
window.aditivoExcluir = aditivoExcluir;
