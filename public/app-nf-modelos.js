// ═══════════════════════════════════════════════════════════════
//  MODELOS DE NF — templates pré-cadastrados
//  Pré-cadastra um modelo, mês a mês muda só competência (e opcionalmente
//  colaboradores e glosas) → cria a NF na tabela notas_fiscais.
// ═══════════════════════════════════════════════════════════════

function nfmApi(url, opts) { return api('/nf-modelos' + url, opts); }
function nfmFmtMoeda(v) { return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',').replace(/B(?=(d{3})+(?!d))/g, '.'); }
function nfmEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

window.nfModelosInit = async function() {
  try {
    await nfmListar();
  } catch (e) {
    const body = document.getElementById('nfm-body');
    if (body) body.innerHTML = `<tr><td colspan="6" style="color:#dc2626;padding:24px;text-align:center">Erro ao carregar modelos: ${nfmEsc(e.message)}</td></tr>`;
  }
};

async function nfmListar() {
  const body = document.getElementById('nfm-body');
  if (!body) return;
  body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:24px">Carregando…</td></tr>';
  try {
    const r = await nfmApi('/');
    const modelos = (r && r.modelos) || [];
    if (!modelos.length) {
      body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:24px">Nenhum modelo cadastrado. Clique em "Novo Modelo" para criar o primeiro.</td></tr>';
      return;
    }
    body.innerHTML = modelos.map(m => `
      <tr>
        <td><b>${nfmEsc(m.nome)}</b>${m.tomador ? `<div style="font-size:11px;color:#64748b">${nfmEsc(m.tomador)}</div>` : ''}</td>
        <td>${nfmEsc(m.cnpj_tomador || '—')}</td>
        <td class="r mono">${nfmFmtMoeda(m.valor_bruto)}</td>
        <td>${m.qtd_emissoes || 0}× ${m.ultima_emissao ? `<div style="font-size:11px;color:#64748b">última: ${nfmEsc(m.ultima_emissao)}</div>` : ''}</td>
        <td>${m.mostrar_colaboradores ? '✓ sim' : '— não'}</td>
        <td style="white-space:nowrap">
          <button class="btn-emit" onclick="nfmAbrirEmitir(${m.id})" style="background:#16a34a;color:#fff;border:0;padding:4px 12px;border-radius:5px;font-size:11px;cursor:pointer;font-weight:700">📤 Emitir</button>
          <button onclick="nfmAbrirEdit(${m.id})" style="background:#f1f5f9;border:1px solid #cbd5e1;padding:4px 10px;border-radius:5px;font-size:11px;cursor:pointer">✏️ Editar</button>
          <button onclick="nfmExcluir(${m.id},'${nfmEsc(m.nome)}')" style="background:#fef2f2;color:#991b1b;border:1px solid #fecaca;padding:4px 10px;border-radius:5px;font-size:11px;cursor:pointer">🗑</button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#dc2626;padding:24px">Erro: ${nfmEsc(e.message)}</td></tr>`;
  }
}

function nfmAbrirNovo() { nfmAbrirModal(null); }
async function nfmAbrirEdit(id) {
  try {
    const r = await nfmApi('/' + id);
    nfmAbrirModal(r.modelo);
  } catch (e) { alert('Erro: ' + e.message); }
}

function nfmAbrirModal(m) {
  m = m || {};
  const isEdit = !!m.id;
  const html = `
    <div id="nfm-modal-bg" style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:24px;overflow:auto" onclick="if(event.target.id==='nfm-modal-bg')nfmFecharModal()">
      <div style="background:#fff;border-radius:12px;padding:22px;max-width:760px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.4)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <h2 style="margin:0;font-size:18px">${isEdit ? '✏️ Editar Modelo' : '➕ Novo Modelo de NF'}</h2>
          <button onclick="nfmFecharModal()" style="background:#f1f5f9;border:0;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:14px">✕</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <label style="grid-column:span 2"><span style="font-size:11px;color:#475569;font-weight:700">Nome do modelo *</span>
            <input id="nfm-f-nome" value="${nfmEsc(m.nome)}" placeholder="Ex: Assessoria mensal SESAU" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;margin-top:3px"></label>
          <label><span style="font-size:11px;color:#475569;font-weight:700">Tomador (razão social)</span>
            <input id="nfm-f-tomador" value="${nfmEsc(m.tomador)}" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;margin-top:3px"></label>
          <label><span style="font-size:11px;color:#475569;font-weight:700">CNPJ do tomador</span>
            <input id="nfm-f-cnpj" value="${nfmEsc(m.cnpj_tomador)}" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;margin-top:3px"></label>
          <label><span style="font-size:11px;color:#475569;font-weight:700">Contrato ref</span>
            <input id="nfm-f-contrato" value="${nfmEsc(m.contrato_ref)}" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;margin-top:3px"></label>
          <label><span style="font-size:11px;color:#475569;font-weight:700">Valor bruto base (R$)</span>
            <input id="nfm-f-valor" type="number" step="0.01" value="${m.valor_bruto || 0}" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;margin-top:3px"></label>
          <label style="grid-column:span 2"><span style="font-size:11px;color:#475569;font-weight:700">Descrição (placeholders: <code>{{competencia}}</code>, <code>{{competencia_extenso}}</code>, <code>{{ano}}</code>, <code>{{mes}}</code>, <code>{{colaboradores}}</code>, <code>{{tomador}}</code>, <code>{{valor}}</code>)</span>
            <textarea id="nfm-f-desc" rows="4" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;margin-top:3px;font-family:monospace;font-size:12px">${nfmEsc(m.descricao_template)}</textarea></label>
          <label><span style="font-size:11px;color:#475569;font-weight:700">PIS %</span><input id="nfm-f-pis" type="number" step="0.0001" value="${m.pis_pct || 0}" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;margin-top:3px"></label>
          <label><span style="font-size:11px;color:#475569;font-weight:700">COFINS %</span><input id="nfm-f-cofins" type="number" step="0.0001" value="${m.cofins_pct || 0}" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;margin-top:3px"></label>
          <label><span style="font-size:11px;color:#475569;font-weight:700">ISS %</span><input id="nfm-f-iss" type="number" step="0.0001" value="${m.iss_pct || 0}" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;margin-top:3px"></label>
          <label><span style="font-size:11px;color:#475569;font-weight:700">INSS %</span><input id="nfm-f-inss" type="number" step="0.0001" value="${m.inss_pct || 0}" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;margin-top:3px"></label>
          <label><span style="font-size:11px;color:#475569;font-weight:700">IR %</span><input id="nfm-f-ir" type="number" step="0.0001" value="${m.ir_pct || 0}" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;margin-top:3px"></label>
          <label><span style="font-size:11px;color:#475569;font-weight:700">CSLL %</span><input id="nfm-f-csll" type="number" step="0.0001" value="${m.csll_pct || 0}" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;margin-top:3px"></label>
          <label><span style="font-size:11px;color:#475569;font-weight:700">CNAE</span><input id="nfm-f-cnae" value="${nfmEsc(m.cnae)}" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;margin-top:3px"></label>
          <label><span style="font-size:11px;color:#475569;font-weight:700">Item lista de serviço</span><input id="nfm-f-item" value="${nfmEsc(m.item_lista_servico)}" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;margin-top:3px"></label>
          <label><span style="font-size:11px;color:#475569;font-weight:700">Cidade</span><input id="nfm-f-cidade" value="${nfmEsc(m.cidade)}" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;margin-top:3px"></label>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px"><input type="checkbox" id="nfm-f-mostrarcol" ${m.mostrar_colaboradores ? 'checked' : ''}> Permitir lista de colaboradores na emissão</label>
        </div>
        <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end">
          <button onclick="nfmFecharModal()" style="background:#f1f5f9;border:1px solid #cbd5e1;padding:8px 16px;border-radius:6px;cursor:pointer">Cancelar</button>
          <button onclick="nfmSalvar(${m.id || 'null'})" style="background:#3b82f6;color:#fff;border:0;padding:8px 18px;border-radius:6px;cursor:pointer;font-weight:700">${isEdit ? 'Salvar' : 'Criar'}</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

function nfmFecharModal() {
  const el = document.getElementById('nfm-modal-bg');
  if (el) el.remove();
}

async function nfmSalvar(id) {
  const dados = {
    nome:                  document.getElementById('nfm-f-nome').value.trim(),
    tomador:               document.getElementById('nfm-f-tomador').value.trim(),
    cnpj_tomador:          document.getElementById('nfm-f-cnpj').value.trim(),
    contrato_ref:          document.getElementById('nfm-f-contrato').value.trim(),
    descricao_template:    document.getElementById('nfm-f-desc').value,
    valor_bruto:           parseFloat(document.getElementById('nfm-f-valor').value) || 0,
    pis_pct:               parseFloat(document.getElementById('nfm-f-pis').value) || 0,
    cofins_pct:            parseFloat(document.getElementById('nfm-f-cofins').value) || 0,
    iss_pct:               parseFloat(document.getElementById('nfm-f-iss').value) || 0,
    inss_pct:              parseFloat(document.getElementById('nfm-f-inss').value) || 0,
    ir_pct:                parseFloat(document.getElementById('nfm-f-ir').value) || 0,
    csll_pct:              parseFloat(document.getElementById('nfm-f-csll').value) || 0,
    cnae:                  document.getElementById('nfm-f-cnae').value.trim(),
    item_lista_servico:    document.getElementById('nfm-f-item').value.trim(),
    cidade:                document.getElementById('nfm-f-cidade').value.trim(),
    mostrar_colaboradores: document.getElementById('nfm-f-mostrarcol').checked,
  };
  if (!dados.nome) { alert('Nome obrigatório'); return; }
  try {
    if (id) {
      await nfmApi('/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados) });
    } else {
      await nfmApi('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dados) });
    }
    nfmFecharModal();
    await nfmListar();
  } catch (e) { alert('Erro: ' + e.message); }
}

async function nfmExcluir(id, nome) {
  if (!confirm(`Desativar modelo "${nome}"?\n(Soft delete: pode ser reativado depois)`)) return;
  try {
    await nfmApi('/' + id, { method: 'DELETE' });
    await nfmListar();
  } catch (e) { alert('Erro: ' + e.message); }
}

// ─── EMITIR ──────────────────────────────────────────────────────

let _nfmEmitirState = { modelo: null, colaboradores: [], glosas: [] };

async function nfmAbrirEmitir(id) {
  try {
    const r = await nfmApi('/' + id);
    _nfmEmitirState = { modelo: r.modelo, colaboradores: [], glosas: [] };
    nfmRenderEmitir();
  } catch (e) { alert('Erro: ' + e.message); }
}

function nfmRenderEmitir() {
  const m = _nfmEmitirState.modelo;
  const hoje = new Date();
  const compDefault = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
  const dataDefault = hoje.toISOString().slice(0, 10);

  // remove modal anterior se existir
  const old = document.getElementById('nfm-emit-bg'); if (old) old.remove();

  const colabsHtml = _nfmEmitirState.colaboradores.map((c, i) => `
    <tr>
      <td><input value="${nfmEsc(c.nome)}" oninput="_nfmEmitirState.colaboradores[${i}].nome=this.value" placeholder="Nome" style="width:100%;padding:4px;border:1px solid #cbd5e1;border-radius:4px;font-size:12px"></td>
      <td><input value="${nfmEsc(c.cpf || '')}" oninput="_nfmEmitirState.colaboradores[${i}].cpf=this.value" placeholder="CPF" style="width:100%;padding:4px;border:1px solid #cbd5e1;border-radius:4px;font-size:12px"></td>
      <td><input value="${nfmEsc(c.funcao || '')}" oninput="_nfmEmitirState.colaboradores[${i}].funcao=this.value" placeholder="Função" style="width:100%;padding:4px;border:1px solid #cbd5e1;border-radius:4px;font-size:12px"></td>
      <td><button onclick="_nfmEmitirState.colaboradores.splice(${i},1);nfmRenderEmitir()" style="background:#fef2f2;color:#991b1b;border:1px solid #fecaca;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px">×</button></td>
    </tr>`).join('');

  const glosasHtml = _nfmEmitirState.glosas.map((g, i) => `
    <tr>
      <td><input value="${nfmEsc(g.motivo)}" oninput="_nfmEmitirState.glosas[${i}].motivo=this.value" placeholder="Motivo" style="width:100%;padding:4px;border:1px solid #cbd5e1;border-radius:4px;font-size:12px"></td>
      <td><input type="number" step="0.01" value="${g.valor || 0}" oninput="_nfmEmitirState.glosas[${i}].valor=parseFloat(this.value)||0" style="width:100%;padding:4px;border:1px solid #cbd5e1;border-radius:4px;font-size:12px;text-align:right"></td>
      <td><button onclick="_nfmEmitirState.glosas.splice(${i},1);nfmRenderEmitir()" style="background:#fef2f2;color:#991b1b;border:1px solid #fecaca;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px">×</button></td>
    </tr>`).join('');

  const html = `
    <div id="nfm-emit-bg" style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:24px;overflow:auto" onclick="if(event.target.id==='nfm-emit-bg')nfmFecharEmitir()">
      <div style="background:#fff;border-radius:12px;padding:22px;max-width:840px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.4)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <h2 style="margin:0;font-size:18px">📤 Emitir do modelo: <span style="color:#3b82f6">${nfmEsc(m.nome)}</span></h2>
          <button onclick="nfmFecharEmitir()" style="background:#f1f5f9;border:0;border-radius:6px;padding:6px 12px;cursor:pointer">✕</button>
        </div>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px;margin-bottom:14px;font-size:12px;color:#475569">
          <b>Tomador:</b> ${nfmEsc(m.tomador) || '—'} ${m.cnpj_tomador ? `(${nfmEsc(m.cnpj_tomador)})` : ''}<br>
          <b>Valor base:</b> ${nfmFmtMoeda(m.valor_bruto)} • <b>Última emissão:</b> ${m.ultima_emissao || '—'}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
          <label><span style="font-size:11px;color:#475569;font-weight:700">Competência *</span>
            <input id="nfm-em-comp" type="month" value="${compDefault}" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;margin-top:3px"></label>
          <label><span style="font-size:11px;color:#475569;font-weight:700">Data de emissão</span>
            <input id="nfm-em-data" type="date" value="${dataDefault}" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;margin-top:3px"></label>
          <label style="grid-column:span 2"><span style="font-size:11px;color:#475569;font-weight:700">Sobrescrever valor bruto (R$ — em branco usa o do modelo)</span>
            <input id="nfm-em-valor" type="number" step="0.01" placeholder="${m.valor_bruto}" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;margin-top:3px"></label>
          <label style="grid-column:span 2"><span style="font-size:11px;color:#475569;font-weight:700">Descrição extra (acrescentada no fim)</span>
            <textarea id="nfm-em-extra" rows="2" style="width:100%;padding:8px;border:1px solid #cbd5e1;border-radius:6px;margin-top:3px;font-family:monospace;font-size:12px"></textarea></label>
        </div>

        ${m.mostrar_colaboradores ? `
          <div style="margin-bottom:14px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
              <span style="font-size:13px;font-weight:700">🧑 Colaboradores do mês</span>
              <button onclick="_nfmEmitirState.colaboradores.push({nome:'',cpf:'',funcao:''});nfmRenderEmitir()" style="background:#dcfce7;color:#15803d;border:1px solid #86efac;padding:4px 10px;border-radius:5px;cursor:pointer;font-size:11px;font-weight:700">+ Adicionar</button>
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:12px">
              <thead><tr style="background:#f8fafc"><th style="padding:5px;text-align:left;font-size:11px">Nome</th><th style="padding:5px;text-align:left;font-size:11px;width:120px">CPF</th><th style="padding:5px;text-align:left;font-size:11px">Função</th><th style="width:32px"></th></tr></thead>
              <tbody>${colabsHtml || '<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:8px">Nenhum colaborador adicionado</td></tr>'}</tbody>
            </table>
          </div>` : ''}

        <div style="margin-bottom:14px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <span style="font-size:13px;font-weight:700">📉 Glosas do mês</span>
            <button onclick="_nfmEmitirState.glosas.push({motivo:'',valor:0});nfmRenderEmitir()" style="background:#fef9c3;color:#854d0e;border:1px solid #fde68a;padding:4px 10px;border-radius:5px;cursor:pointer;font-size:11px;font-weight:700">+ Adicionar</button>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead><tr style="background:#f8fafc"><th style="padding:5px;text-align:left;font-size:11px">Motivo</th><th style="padding:5px;text-align:right;font-size:11px;width:140px">Valor (R$)</th><th style="width:32px"></th></tr></thead>
            <tbody>${glosasHtml || '<tr><td colspan="3" style="text-align:center;color:#94a3b8;padding:8px">Nenhuma glosa adicionada</td></tr>'}</tbody>
          </table>
        </div>

        <div id="nfm-em-preview" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px;font-size:12px;display:none;margin-bottom:14px"></div>

        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button onclick="nfmFecharEmitir()" style="background:#f1f5f9;border:1px solid #cbd5e1;padding:8px 16px;border-radius:6px;cursor:pointer">Cancelar</button>
          <button onclick="nfmEmitirPreview()" style="background:#fef9c3;color:#854d0e;border:1px solid #fde68a;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:700">👁 Preview</button>
          <button onclick="nfmEmitirConfirmar()" style="background:#16a34a;color:#fff;border:0;padding:8px 18px;border-radius:6px;cursor:pointer;font-weight:700">📤 Emitir NF</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

function nfmFecharEmitir() {
  const el = document.getElementById('nfm-emit-bg'); if (el) el.remove();
  _nfmEmitirState = { modelo: null, colaboradores: [], glosas: [] };
}

function _nfmColetarPayload(dryRun) {
  const m = _nfmEmitirState.modelo;
  return {
    competencia:           document.getElementById('nfm-em-comp').value,
    data_emissao:          document.getElementById('nfm-em-data').value,
    valor_bruto_override:  document.getElementById('nfm-em-valor').value ? parseFloat(document.getElementById('nfm-em-valor').value) : null,
    descricao_extra:       document.getElementById('nfm-em-extra').value,
    colaboradores:         m.mostrar_colaboradores ? _nfmEmitirState.colaboradores.filter(c => c.nome) : [],
    glosas:                _nfmEmitirState.glosas.filter(g => g.motivo && g.valor > 0),
    dry_run:               dryRun,
  };
}

async function nfmEmitirPreview() {
  const m = _nfmEmitirState.modelo;
  try {
    const r = await nfmApi('/' + m.id + '/emitir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_nfmColetarPayload(true)),
    });
    const p = r.preview;
    const box = document.getElementById('nfm-em-preview');
    box.style.display = 'block';
    box.innerHTML = `
      <b>📋 Preview da NF que será criada:</b><br>
      <div style="margin-top:6px;font-family:monospace;font-size:11px;white-space:pre-wrap">${nfmEsc(p.descricao)}</div>
      <hr style="border:0;border-top:1px solid #bbf7d0;margin:8px 0">
      <b>Valor bruto:</b> ${nfmFmtMoeda(p.valor_bruto)} | <b>Glosas:</b> ${nfmFmtMoeda(p.glosas)} | <b>Após glosas:</b> ${nfmFmtMoeda(p.valor_com_glosas)}<br>
      <b>Retenções:</b> PIS ${nfmFmtMoeda(p.pis)} • COFINS ${nfmFmtMoeda(p.cofins)} • ISS ${nfmFmtMoeda(p.iss)} • INSS ${nfmFmtMoeda(p.inss)} • IR ${nfmFmtMoeda(p.ir)} • CSLL ${nfmFmtMoeda(p.csll)} • <b>Total: ${nfmFmtMoeda(p.retencao)}</b><br>
      <b style="color:#15803d;font-size:14px">Líquido: ${nfmFmtMoeda(p.valor_liquido)}</b>`;
  } catch (e) { alert('Erro no preview: ' + e.message); }
}

async function nfmEmitirConfirmar() {
  const m = _nfmEmitirState.modelo;
  if (!confirm(`Confirma a emissão do modelo "${m.nome}" para a competência ${document.getElementById('nfm-em-comp').value}?\nA NF será criada como PENDENTE em notas_fiscais.`)) return;
  try {
    const r = await nfmApi('/' + m.id + '/emitir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_nfmColetarPayload(false)),
    });
    alert(`✅ NF emitida! ID: ${r.nf_id}\nValor: ${nfmFmtMoeda(r.valor_bruto)}\nLíquido: ${nfmFmtMoeda(r.valor_liquido)}\n\nVá em "Notas Fiscais" para preencher o número definitivo da NF.`);
    nfmFecharEmitir();
    await nfmListar();
  } catch (e) { alert('Erro ao emitir: ' + e.message); }
}
