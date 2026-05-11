// ═══════════════════════════════════════════════════════════════
// PAINEL DE FATURAMENTO → EMISSÃO DE NFS-e
// Lista boletins por status NFS-e e permite emissão individual/em lote.
// Backend: GET /api/boletins/emissao + POST /api/boletins/:id/emitir-nfse
// ═══════════════════════════════════════════════════════════════
'use strict';

(function () {
  const _orig = window.showTab;
  window.showTab = function (id, el) {
    _orig(id, el);
    if (id === 'fat-emissao') fatEmiInit();
  };
})();

let _fatEmiBoletins = [];
let _fatEmiSelecionados = new Set();

function _fatEmiToken() { return localStorage.getItem('montana_jwt') || ''; }
function _fatEmiCompany() { return window.currentCompany || localStorage.getItem('montana_company') || ''; }
function _fatEmiBRL(v) {
  const n = Number(v) || 0;
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
function _fatEmiToast(msg, tipo) {
  if (typeof window.toast === 'function') window.toast(msg, tipo);
  else console.log('[fat-emissao]', tipo, msg);
}

// ─── Init / boot ──────────────────────────────────────────────
function fatEmiInit() {
  const cInp = document.getElementById('fat-emi-competencia');
  if (cInp && !cInp.value) {
    // Default: mês anterior (boletins recém aprovados costumam ser do mês passado)
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    cInp.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  fatEmiCarregar();
}

// ─── Carregar lista ───────────────────────────────────────────
async function fatEmiCarregar() {
  const tbody = document.getElementById('fat-emi-body');
  const resumo = document.getElementById('fat-emi-resumo');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="8" style="padding:24px;text-align:center;color:#94a3b8">Carregando...</td></tr>`;
  _fatEmiSelecionados.clear();
  _fatEmiAtualizarBotaoBulk();

  const mes = document.getElementById('fat-emi-competencia')?.value || '';
  const status = document.getElementById('fat-emi-status')?.value || '';
  const qs = new URLSearchParams();
  if (mes) qs.set('mes', mes);
  if (status) qs.set('nfse_status', status);

  try {
    const r = await fetch(`/api/boletins/emissao?${qs}`, {
      headers: { 'X-Company': _fatEmiCompany(), 'Authorization': 'Bearer ' + _fatEmiToken() },
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Falha ao carregar');
    _fatEmiBoletins = d.data || [];
    fatEmiRender();
    if (resumo) {
      const total = _fatEmiBoletins.reduce((s, b) => s + (Number(b.valor_total) || 0), 0);
      resumo.textContent = `${_fatEmiBoletins.length} boletim(ns) · ${_fatEmiBRL(total)}`;
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" style="padding:24px;text-align:center;color:#dc2626">Erro: ${e.message}</td></tr>`;
    if (resumo) resumo.textContent = '';
  }
}

// ─── Render da tabela ─────────────────────────────────────────
function fatEmiRender() {
  const tbody = document.getElementById('fat-emi-body');
  if (!tbody) return;
  if (!_fatEmiBoletins.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="padding:24px;text-align:center;color:#94a3b8">Nenhum boletim no filtro atual.</td></tr>`;
    return;
  }
  tbody.innerHTML = _fatEmiBoletins.map(b => fatEmiRenderLinha(b)).join('');
}

function fatEmiRenderLinha(b) {
  const podeEmitir = b.status === 'aprovado' && b.nfse_status !== 'EMITIDA' && b.nfse_status !== 'ENVIANDO';
  const chk = podeEmitir
    ? `<input type="checkbox" class="fat-emi-chk" data-id="${b.id}" onchange="fatEmiToggleLinha(${b.id}, this.checked)">`
    : `<span style="color:#cbd5e1">—</span>`;

  let statusBoletim = '';
  if (b.status === 'rascunho') statusBoletim = `<span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">RASCUNHO</span>`;
  else if (b.status === 'aprovado') statusBoletim = `<span style="background:#dbeafe;color:#1e40af;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">APROVADO</span>`;
  else if (b.status === 'emitido') statusBoletim = `<span style="background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">EMITIDO</span>`;
  else statusBoletim = `<span style="color:#64748b;font-size:10px">${b.status || '—'}</span>`;

  let statusNfse = '';
  if (b.nfse_status === 'EMITIDA') statusNfse = `<span style="background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700" title="Nº ${b.nfse_numero || ''}">✔ EMITIDA</span>`;
  else if (b.nfse_status === 'ERRO') statusNfse = `<span style="background:#fef2f2;color:#dc2626;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;cursor:pointer" onclick="fatEmiDetalhe(${b.id})" title="Ver erro">❌ ERRO</span>`;
  else if (b.nfse_status === 'ENVIANDO') statusNfse = `<span style="background:#eff6ff;color:#3b82f6;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">⏳ ENVIANDO</span>`;
  else statusNfse = `<span style="color:#94a3b8;font-size:10px">PENDENTE</span>`;

  let acoes = '';
  if (podeEmitir) {
    acoes = `<button onclick="fatEmiEmitirUm(${b.id})" style="padding:4px 10px;background:#059669;color:#fff;border:none;border-radius:6px;font-size:10px;font-weight:700;cursor:pointer">📤 Emitir</button>`;
  } else if (b.nfse_status === 'EMITIDA') {
    acoes = `<button onclick="fatEmiDetalhe(${b.id})" style="padding:4px 10px;background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;border-radius:6px;font-size:10px;font-weight:700;cursor:pointer">👁 Ver</button>`;
  } else if (b.nfse_status === 'ERRO') {
    acoes = `<button onclick="fatEmiEmitirUm(${b.id})" style="padding:4px 10px;background:#dc2626;color:#fff;border:none;border-radius:6px;font-size:10px;font-weight:700;cursor:pointer" title="Tentar emitir novamente">🔁 Reemitir</button>`;
  } else if (b.status === 'rascunho') {
    acoes = `<span style="color:#94a3b8;font-size:10px" title="Aprove o boletim antes de emitir">aprovar antes</span>`;
  } else {
    acoes = `<span style="color:#94a3b8;font-size:10px">—</span>`;
  }

  return `
  <tr style="border-bottom:1px solid #f1f5f9">
    <td style="padding:8px;text-align:center">${chk}</td>
    <td style="padding:8px;font-weight:700;color:#1e293b;max-width:220px">${b.contrato_nome || '—'}</td>
    <td style="padding:8px;color:#475569;font-size:11px;max-width:220px">${b.contratante || '—'}</td>
    <td style="padding:8px;text-align:center;color:#64748b">${b.competencia || '—'}</td>
    <td style="padding:8px;text-align:right;color:#1e293b;font-weight:700">${_fatEmiBRL(b.valor_total)}</td>
    <td style="padding:8px;text-align:center">${statusBoletim}</td>
    <td style="padding:8px;text-align:center">${statusNfse}</td>
    <td style="padding:8px;text-align:center">${acoes}</td>
  </tr>`;
}

// ─── Seleção (checkboxes) ─────────────────────────────────────
function fatEmiToggleLinha(id, checked) {
  if (checked) _fatEmiSelecionados.add(id);
  else _fatEmiSelecionados.delete(id);
  _fatEmiAtualizarBotaoBulk();
}

function fatEmiToggleAll(checked) {
  document.querySelectorAll('.fat-emi-chk').forEach(el => {
    el.checked = checked;
    const id = Number(el.getAttribute('data-id'));
    if (checked) _fatEmiSelecionados.add(id);
    else _fatEmiSelecionados.delete(id);
  });
  _fatEmiAtualizarBotaoBulk();
}

function _fatEmiAtualizarBotaoBulk() {
  const btn = document.getElementById('fat-emi-btn-bulk');
  if (!btn) return;
  const n = _fatEmiSelecionados.size;
  btn.disabled = n === 0;
  btn.style.opacity = n === 0 ? '.5' : '1';
  btn.textContent = n === 0 ? '📤 Emitir selecionados' : `📤 Emitir selecionados (${n})`;
}

// ─── Emissão individual ───────────────────────────────────────
async function fatEmiEmitirUm(id) {
  if (!confirm('Confirmar emissão de NFS-e deste boletim?')) return;
  await _fatEmiEmitirIds([id]);
}

// ─── Emissão em lote ──────────────────────────────────────────
async function fatEmiEmitirSelecionados() {
  const ids = [..._fatEmiSelecionados];
  if (!ids.length) return;
  if (!confirm(`Confirmar emissão de NFS-e para ${ids.length} boletim(ns)? A operação é sequencial e pode levar alguns segundos por boletim.`)) return;
  await _fatEmiEmitirIds(ids);
}

async function _fatEmiEmitirIds(ids) {
  const btn = document.getElementById('fat-emi-btn-bulk');
  const origText = btn?.textContent;
  let ok = 0, falha = 0;
  const erros = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (btn) btn.textContent = `Emitindo ${i + 1}/${ids.length}...`;
    try {
      const r = await fetch(`/api/boletins/${id}/emitir-nfse`, {
        method: 'POST',
        headers: { 'X-Company': _fatEmiCompany(), 'Authorization': 'Bearer ' + _fatEmiToken() },
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Falha');
      ok++;
    } catch (e) {
      falha++;
      erros.push(`#${id}: ${e.message}`);
    }
  }
  if (btn) btn.textContent = origText || '📤 Emitir selecionados';
  if (ok && !falha) _fatEmiToast(`✅ ${ok} NFS-e emitida(s) com sucesso`, 'success');
  else if (ok && falha) _fatEmiToast(`⚠ ${ok} OK, ${falha} com erro: ${erros[0]}`, 'error');
  else _fatEmiToast(`❌ Falha: ${erros[0] || 'sem detalhes'}`, 'error');
  fatEmiCarregar();
}

// ─── Detalhe (modal) ──────────────────────────────────────────
function fatEmiDetalhe(id) {
  const b = _fatEmiBoletins.find(x => x.id === id);
  if (!b) return;
  const titulo = `Boletim #${b.id} — ${b.contrato_nome || ''}`;
  let body = '';
  if (b.nfse_status === 'EMITIDA') {
    body = `
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px">
        <strong>Status:</strong> <span style="color:#059669">EMITIDA</span>
        <strong>Número NFS-e:</strong> <span>${b.nfse_numero || '—'}</span>
        <strong>Data emissão:</strong> <span>${b.nfse_data_emissao ? new Date(b.nfse_data_emissao).toLocaleString('pt-BR') : '—'}</span>
        <strong>Competência:</strong> <span>${b.competencia || '—'}</span>
        <strong>Valor:</strong> <span>${_fatEmiBRL(b.valor_total)}</span>
      </div>`;
  } else if (b.nfse_status === 'ERRO') {
    body = `
      <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 12px">
        <strong>Status:</strong> <span style="color:#dc2626">ERRO</span>
        <strong>Mensagem:</strong> <pre style="background:#fef2f2;padding:8px;border-radius:6px;font-size:11px;white-space:pre-wrap">${b.nfse_erro || '(sem detalhes)'}</pre>
      </div>`;
  } else {
    body = `<p>Sem dados de NFS-e ainda. Status atual: <strong>${b.nfse_status || 'PENDENTE'}</strong></p>`;
  }
  document.getElementById('fat-emi-detail-titulo').textContent = titulo;
  document.getElementById('fat-emi-detail-body').innerHTML = body;
  document.getElementById('fat-emi-detail').style.display = 'block';
}

// Expor no escopo global para uso via onclick inline
window.fatEmiCarregar = fatEmiCarregar;
window.fatEmiToggleAll = fatEmiToggleAll;
window.fatEmiToggleLinha = fatEmiToggleLinha;
window.fatEmiEmitirUm = fatEmiEmitirUm;
window.fatEmiEmitirSelecionados = fatEmiEmitirSelecionados;
window.fatEmiDetalhe = fatEmiDetalhe;
