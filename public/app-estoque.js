// ═══════════════════════════════════════════════════════════════
//  MÓDULO DE ESTOQUE — Equipamentos, Maquinários, EPIs, Consumíveis
// ═══════════════════════════════════════════════════════════════

// Helper: reutiliza a função api() global do app.js que já inclui Authorization + X-Company
function estApi(url, opts) {
  return api('/estoque' + url, opts);
}

// Mapeamento empresa → label amigável
const EMPRESA_LABELS = {
  assessoria: '🏢 Assessoria',
  seguranca:  '🔒 Segurança',
  portodovau: '🛡️ Porto do Vau',
  mustang:    '🐎 Mustang',
};

// Keywords para auto-sugestão (espelha as regras do backend)
const EMPRESA_KEYWORDS_FRONT = {
  seguranca: ['colete','balístico','balistico','coturno','algema','bastão','bastao',
    'detector','rádio comunicador','radio comunicador','radiotransmissor',
    'lanterna tática','lanterna tatica','cinto tático','cinto tatico',
    'armamento','vigilante','sprays','spray de pimenta','tonfa','gilet'],
  assessoria: ['enceradeira','aspirador','lavadora','esfregão','esfregao','mop','rodo',
    'cera piso','cera de piso','detergente','desinfetante','papel toalha',
    'vassoura','saco de lixo','caneta','grampeador','perfurador','resma',
    'tonner','toner','cartucho'],
};

function estoqueSugerirEmpresa(nome) {
  const n = (nome || '').toLowerCase();
  for (const [emp, kws] of Object.entries(EMPRESA_KEYWORDS_FRONT)) {
    if (kws.some(k => n.includes(k))) return emp;
  }
  return null;
}

const CAT_INFO = {
  EQUIPAMENTO: { icon: '🔧', label: 'Equipamento',  cor: '#0369a1' },
  MAQUINARIO:  { icon: '⚙️', label: 'Maquinário',   cor: '#7c3aed' },
  EPI:         { icon: '🦺', label: 'EPI',           cor: '#d97706' },
  UNIFORME:    { icon: '👕', label: 'Uniforme',      cor: '#0891b2' },
  CONSUMIVEL:  { icon: '📦', label: 'Consumível',    cor: '#059669' },
  MATERIAL:    { icon: '🧱', label: 'Material',      cor: '#78716c' },
};

function estoqueShowView(v) {
  ['dashboard','itens','mov','rel','ficha','alertas','novo'].forEach(id => {
    document.getElementById('est-view-'+id).style.display = id === v ? '' : 'none';
    const btnId = id === 'dashboard' ? 'est-btn-dash' : 'est-btn-' + id;
    const btn = document.getElementById(btnId);
    if (btn) btn.classList.toggle('active-est', id === v);
  });
  if (v === 'dashboard') estoqueCarregarDashboard();
  if (v === 'itens') estoqueCarregarItens();
  if (v === 'mov') estoqueCarregarSelectItens();
  if (v === 'rel') {
    const hoje = new Date().toISOString().slice(0,10);
    const ini = hoje.slice(0,7)+'-01';
    document.getElementById('est-rel-ini').value = ini;
    document.getElementById('est-rel-fim').value = hoje;
    estoqueCarregarRelatorio();
  }
  if (v === 'ficha') estoqueFichaCarregar();
  if (v === 'alertas') estoqueCarregarAlertas();
  if (v === 'novo') estoqueNovoForm();
}

// ── DASHBOARD ──────────────────────────────────────────────────
async function estoqueCarregarDashboard() {
  try {
    const d = await estApi('/resumo');

    // Cards por categoria
    const cards = document.getElementById('est-cards');
    cards.innerHTML = '';

    const total = { itens: 0, alertas: 0, valor: 0 };
    d.por_categoria.forEach(c => { total.itens += c.total_itens; total.alertas += c.alertas; total.valor += c.valor_total || 0; });

    // Card total
    cards.innerHTML += `<div style="background:linear-gradient(135deg,#0f766e,#0d9488);color:#fff;border-radius:10px;padding:14px 16px">
      <div style="font-size:.75rem;opacity:.85">TOTAL ESTOQUE</div>
      <div style="font-size:1.5rem;font-weight:700">${total.itens}</div>
      <div style="font-size:.78rem;opacity:.9">itens cadastrados</div>
      <div style="font-size:.9rem;font-weight:600;margin-top:4px">R$ ${total.valor.toLocaleString('pt-BR',{minimumFractionDigits:2})}</div>
      ${total.alertas > 0 ? `<div style="background:rgba(255,255,255,.2);border-radius:4px;padding:3px 6px;margin-top:6px;font-size:.75rem">⚠️ ${total.alertas} alertas</div>` : ''}
    </div>`;

    Object.entries(CAT_INFO).forEach(([cat, info]) => {
      const c = d.por_categoria.find(x => x.categoria === cat) || { total_itens: 0, alertas: 0, valor_total: 0 };
      cards.innerHTML += `<div style="background:#fff;border:1px solid #e2e8f0;border-left:4px solid ${info.cor};border-radius:10px;padding:14px 16px;cursor:pointer" onclick="estoqueShowView('itens');document.getElementById('est-filtro-cat').value='${cat}';estoqueCarregarItens()">
        <div style="font-size:.75rem;color:#6b7280">${info.icon} ${info.label.toUpperCase()}</div>
        <div style="font-size:1.4rem;font-weight:700;color:${info.cor}">${c.total_itens}</div>
        <div style="font-size:.78rem;color:#6b7280">R$ ${(c.valor_total||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}</div>
        ${c.alertas > 0 ? `<div style="color:#dc2626;font-size:.75rem;margin-top:4px">⚠️ ${c.alertas} abaixo do mínimo</div>` : '<div style="color:#16a34a;font-size:.75rem;margin-top:4px">✅ OK</div>'}
      </div>`;
    });

    // Alertas
    const alertasDiv = document.getElementById('est-alertas');
    if (!d.alertas.length) { alertasDiv.innerHTML = '<div style="color:#16a34a;padding:8px">✅ Nenhum item abaixo do mínimo</div>'; }
    else {
      alertasDiv.innerHTML = d.alertas.map(a => `
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:8px 10px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-weight:600;color:#dc2626">${CAT_INFO[a.categoria]?.icon||''} ${esc(a.nome)}</div>
            <div style="font-size:.75rem;color:#6b7280">${esc(a.categoria)}</div>
          </div>
          <div style="text-align:right">
            <div style="font-weight:700;color:#dc2626">${a.estoque_atual} ${a.unidade}</div>
            <div style="font-size:.72rem;color:#6b7280">mín: ${a.estoque_minimo}</div>
          </div>
        </div>`).join('');
    }

    // Últimos movimentos
    const ultimosDiv = document.getElementById('est-ultimos');
    if (!d.ultimos_movimentos.length) { ultimosDiv.innerHTML = '<div style="color:#6b7280;padding:8px">Nenhum movimento registrado</div>'; }
    else {
      const tipoIcon = { ENTRADA: '📥', SAIDA: '📤', AJUSTE: '🔧', TRANSFERENCIA: '↔️' };
      ultimosDiv.innerHTML = d.ultimos_movimentos.map(m => `
        <div style="border-bottom:1px solid #f1f5f9;padding:7px 0;display:flex;justify-content:space-between">
          <div>
            <span style="font-size:.8rem">${tipoIcon[m.tipo]||''} <strong>${esc(m.item_nome)}</strong></span>
            <div style="font-size:.72rem;color:#6b7280">${esc(m.data_movimento)} — ${esc(m.motivo||m.tipo)}</div>
          </div>
          <div style="text-align:right;font-size:.82rem;color:${m.tipo==='ENTRADA'?'#16a34a':'#dc2626'};font-weight:600">
            ${m.tipo==='ENTRADA'?'+':'-'}${m.quantidade} ${m.unidade}
          </div>
        </div>`).join('');
    }
  } catch (e) { console.error('estoque dashboard:', e); }
}

// ── LISTA DE ITENS ─────────────────────────────────────────────
async function estoqueCarregarItens() {
  const busca = document.getElementById('est-busca').value;
  const cat = document.getElementById('est-filtro-cat').value;
  const baixo = document.getElementById('est-filtro-baixo').checked ? '1' : '';

  const params = new URLSearchParams();
  if (busca) params.set('busca', busca);
  if (cat) params.set('categoria', cat);
  if (baixo) params.set('baixo_estoque', '1');

  try {
    const itens = await estApi('/itens?' + params);

    const wrap = document.getElementById('est-itens-table');
    if (!itens.length) { wrap.innerHTML = '<div style="padding:20px;color:#6b7280;text-align:center">Nenhum item encontrado</div>'; return; }

    wrap.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:.83rem">
      <thead><tr style="background:#f8fafc">
        <th style="padding:8px;text-align:left;border-bottom:2px solid #e2e8f0">Código</th>
        <th style="padding:8px;text-align:left;border-bottom:2px solid #e2e8f0">Nome</th>
        <th style="padding:8px;text-align:left;border-bottom:2px solid #e2e8f0">Categoria</th>
        <th style="padding:8px;text-align:center;border-bottom:2px solid #e2e8f0">Estoque</th>
        <th style="padding:8px;text-align:center;border-bottom:2px solid #e2e8f0">Mínimo</th>
        <th style="padding:8px;text-align:right;border-bottom:2px solid #e2e8f0">Valor Unit.</th>
        <th style="padding:8px;text-align:right;border-bottom:2px solid #e2e8f0">Total</th>
        <th style="padding:8px;text-align:left;border-bottom:2px solid #e2e8f0">Local</th>
        <th style="padding:8px;border-bottom:2px solid #e2e8f0"></th>
      </tr></thead><tbody>
      ${itens.map(it => {
        const alerta = it.estoque_minimo > 0 && it.estoque_atual <= it.estoque_minimo;
        const info = CAT_INFO[it.categoria] || { icon: '📦', label: it.categoria, cor: '#374151' };
        return `<tr style="border-bottom:1px solid #f1f5f9;${alerta?'background:#fef2f2':''}">
          <td style="padding:7px 8px;color:#6b7280;font-family:monospace">${it.codigo||'—'}</td>
          <td style="padding:7px 8px;font-weight:500">
            ${it.empresa_mismatch ? `<span title="Item típico de ${EMPRESA_LABELS[it.empresa_mismatch]||it.empresa_mismatch} — verifique se está na empresa certa" style="background:#fef3c7;color:#92400e;border:1px solid #fde68a;border-radius:4px;padding:1px 5px;font-size:.7rem;margin-right:4px;cursor:help">⚠️ ${EMPRESA_LABELS[it.empresa_mismatch]||it.empresa_mismatch}</span>` : ''}
            ${it.nome}${it.descricao?`<div style="font-size:.72rem;color:#9ca3af">${it.descricao}</div>`:''}
          </td>
          <td style="padding:7px 8px"><span style="background:${info.cor}18;color:${info.cor};padding:2px 7px;border-radius:20px;font-size:.75rem">${info.icon} ${info.label}</span></td>
          <td style="padding:7px 8px;text-align:center;font-weight:700;color:${alerta?'#dc2626':'#059669'}">${it.estoque_atual} ${it.unidade}${alerta?` <span title="Abaixo do mínimo">⚠️</span>`:''}</td>
          <td style="padding:7px 8px;text-align:center;color:#6b7280">${it.estoque_minimo||'—'}</td>
          <td style="padding:7px 8px;text-align:right">R$ ${(it.valor_unitario||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}</td>
          <td style="padding:7px 8px;text-align:right;font-weight:600">R$ ${((it.estoque_atual||0)*(it.valor_unitario||0)).toLocaleString('pt-BR',{minimumFractionDigits:2})}</td>
          <td style="padding:7px 8px;font-size:.75rem;color:#6b7280">${it.localizacao||'—'}</td>
          <td style="padding:7px 8px;white-space:nowrap">
            <button onclick="estoqueEditarItem(${it.id})" style="background:#e0f2fe;color:#0369a1;border:none;padding:3px 8px;border-radius:4px;font-size:.75rem;cursor:pointer">✏️</button>
            <button onclick="estoqueAbrirMovimento(${it.id},'${it.nome.replace(/'/g,"\\'")}',${it.estoque_atual},'${it.unidade}')" style="background:#dcfce7;color:#16a34a;border:none;padding:3px 8px;border-radius:4px;font-size:.75rem;cursor:pointer;margin-left:3px">🔄</button>
            <button onclick="estoqueToggleAtivo(${it.id},1,this)" style="background:#fef3c7;color:#92400e;border:none;padding:3px 8px;border-radius:4px;font-size:.75rem;cursor:pointer;margin-left:3px" title="Inativar item">🚫</button>
          </td>
        </tr>`;
      }).join('')}
      </tbody>
      <tfoot><tr style="background:#f8fafc;font-weight:600">
        <td colspan="6" style="padding:8px;text-align:right;border-top:2px solid #e2e8f0">Total em Estoque:</td>
        <td style="padding:8px;text-align:right;border-top:2px solid #e2e8f0;color:#0f766e">R$ ${itens.reduce((s,i)=>s+(i.estoque_atual||0)*(i.valor_unitario||0),0).toLocaleString('pt-BR',{minimumFractionDigits:2})}</td>
        <td colspan="2" style="border-top:2px solid #e2e8f0"></td>
      </tr></tfoot>
    </table>`;
  } catch (e) { console.error('estoque itens:', e); }
}

// ── MOVIMENTAÇÃO ───────────────────────────────────────────────
async function estoqueCarregarSelectItens() {
  try {
    const itens = await estApi('/itens');
    const sel = document.getElementById('est-mov-item');
    sel.innerHTML = '<option value="">Selecione o item...</option>';
    Object.entries(CAT_INFO).forEach(([cat, info]) => {
      const grupo = itens.filter(i => i.categoria === cat);
      if (!grupo.length) return;
      const og = document.createElement('optgroup');
      og.label = info.icon + ' ' + info.label;
      grupo.forEach(i => {
        const o = document.createElement('option');
        o.value = i.id;
        o.textContent = `${i.nome} (${i.estoque_atual} ${i.unidade})`;
        o.dataset.estoque = i.estoque_atual;
        o.dataset.unidade = i.unidade;
        o.dataset.vunit = i.valor_unitario;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    document.getElementById('est-mov-data').value = new Date().toISOString().slice(0,10);
  } catch(e) { console.error(e); }
}

function estoqueAbrirMovimento(id, nome, estoque, unidade) {
  estoqueShowView('mov');
  setTimeout(() => {
    const sel = document.getElementById('est-mov-item');
    sel.value = id;
    estoquePreencherItem();
  }, 100);
}

function estoquePreencherItem() {
  const sel = document.getElementById('est-mov-item');
  const opt = sel.selectedOptions[0];
  const info = document.getElementById('est-mov-item-info');
  if (opt && opt.value) {
    info.textContent = `Estoque atual: ${opt.dataset.estoque} ${opt.dataset.unidade}`;
    if (opt.dataset.vunit > 0) document.getElementById('est-mov-vunit').value = opt.dataset.vunit;
  } else { info.textContent = ''; }
}

async function estoqueRegistrarMovimento() {
  const item_id = document.getElementById('est-mov-item').value;
  const tipo = document.getElementById('est-mov-tipo').value;
  const quantidade = document.getElementById('est-mov-qtd').value;
  const data_movimento = document.getElementById('est-mov-data').value;
  const valor_unitario = document.getElementById('est-mov-vunit').value;
  const motivo = document.getElementById('est-mov-motivo').value;
  const fornecedor = document.getElementById('est-mov-forn').value;
  const nota_fiscal = document.getElementById('est-mov-nf').value;
  const responsavel = document.getElementById('est-mov-resp').value;

  if (!item_id || !quantidade || !data_movimento) { alert('Preencha item, quantidade e data'); return; }

  try {
    const d = await estApi('/movimentos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id, tipo, quantidade, valor_unitario, data_movimento, motivo, fornecedor, nota_fiscal, responsavel })
    });
    if (d.error) { alert(d.error); return; }
    alert(`✅ ${d.message}\nEstoque atual: ${d.estoque_atual}`);
    // Limpar form
    ['est-mov-item','est-mov-qtd','est-mov-motivo','est-mov-forn','est-mov-nf','est-mov-resp','est-mov-vunit'].forEach(id => { document.getElementById(id).value = ''; });
    document.getElementById('est-mov-item-info').textContent = '';
    document.getElementById('est-mov-data').value = new Date().toISOString().slice(0,10);
    estoqueCarregarSelectItens();
  } catch(e) { alert('Erro: '+e.message); }
}

// ── CADASTRO / EDIÇÃO DE ITEM ──────────────────────────────────
function _estoqueToggleEpiFields() {
  const cat = document.getElementById('est-form-cat').value;
  const show = cat === 'EPI' || cat === 'UNIFORME';
  document.getElementById('est-form-epi-fields').style.display = show ? 'grid' : 'none';
}

function estoqueNovoForm(item) {
  document.getElementById('est-form-titulo').textContent = item ? 'Editar Item' : 'Cadastrar Novo Item';
  document.getElementById('est-form-id').value = item?.id || '';
  document.getElementById('est-form-codigo').value = item?.codigo || '';
  document.getElementById('est-form-cat').value = item?.categoria || 'EPI';
  document.getElementById('est-form-nome').value = item?.nome || '';
  document.getElementById('est-form-desc').value = item?.descricao || '';
  document.getElementById('est-form-un').value = item?.unidade || 'UN';
  document.getElementById('est-form-min').value = item?.estoque_minimo || '';
  document.getElementById('est-form-vunit').value = item?.valor_unitario || '';
  document.getElementById('est-form-local').value = item?.localizacao || '';
  document.getElementById('est-form-fab').value = item?.fabricante || '';
  document.getElementById('est-form-contrato').value = item?.contrato_ref || '';
  document.getElementById('est-form-ca').value = item?.ca_numero || '';
  document.getElementById('est-form-ca-val').value = item?.ca_validade || '';
  document.getElementById('est-form-vida').value = item?.vida_util_meses || '';
  document.getElementById('est-form-empresa').value = item?.empresa_restrita || '';
  document.getElementById('est-form-empresa-sugestao').textContent = '';
  // Attach listeners
  const sel = document.getElementById('est-form-cat');
  sel.onchange = _estoqueToggleEpiFields;
  _estoqueToggleEpiFields();
  // Auto-sugestão ao digitar nome
  const nomeInput = document.getElementById('est-form-nome');
  nomeInput.oninput = function() {
    const sug = estoqueSugerirEmpresa(this.value);
    const empresaSel = document.getElementById('est-form-empresa');
    const sugSpan = document.getElementById('est-form-empresa-sugestao');
    if (sug && !empresaSel.value) {
      sugSpan.textContent = `→ sugerido: ${EMPRESA_LABELS[sug]}`;
      sugSpan.style.cursor = 'pointer';
      sugSpan.onclick = () => { empresaSel.value = sug; sugSpan.textContent = ''; };
    } else {
      sugSpan.textContent = '';
    }
  };
}

async function estoqueEditarItem(id) {
  try {
    const d = await estApi('/itens/' + id);
    estoqueShowView('novo');
    estoqueNovoForm(d.item);
  } catch(e) { console.error(e); }
}

async function estoqueSalvarItem() {
  const id = document.getElementById('est-form-id').value;
  const body = {
    codigo:          document.getElementById('est-form-codigo').value,
    categoria:       document.getElementById('est-form-cat').value,
    nome:            document.getElementById('est-form-nome').value,
    descricao:       document.getElementById('est-form-desc').value,
    unidade:         document.getElementById('est-form-un').value,
    estoque_minimo:  document.getElementById('est-form-min').value,
    valor_unitario:  document.getElementById('est-form-vunit').value,
    localizacao:     document.getElementById('est-form-local').value,
    fabricante:       document.getElementById('est-form-fab').value,
    contrato_ref:     document.getElementById('est-form-contrato').value,
    ca_numero:        document.getElementById('est-form-ca').value,
    ca_validade:      document.getElementById('est-form-ca-val').value,
    vida_util_meses:  document.getElementById('est-form-vida').value,
    empresa_restrita: document.getElementById('est-form-empresa').value,
    ativo: 1
  };
  if (!body.nome || !body.categoria) { alert('Nome e categoria são obrigatórios'); return; }

  try {
    const url = id ? '/itens/' + id : '/itens';
    const method = id ? 'PUT' : 'POST';
    const d = await estApi(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (d.error) { alert(d.error); return; }
    const msg = d.aviso ? `✅ ${d.message}\n\n${d.aviso}` : `✅ ${d.message}`;
    alert(msg);
    estoqueShowView('itens');
  } catch(e) { alert('Erro: '+e.message); }
}

// ── RELATÓRIO ──────────────────────────────────────────────────
async function estoqueCarregarRelatorio() {
  const params = new URLSearchParams();
  const ini = document.getElementById('est-rel-ini').value;
  const fim = document.getElementById('est-rel-fim').value;
  const tipo = document.getElementById('est-rel-tipo').value;
  const cat = document.getElementById('est-rel-cat').value;
  if (ini) params.set('data_ini', ini);
  if (fim) params.set('data_fim', fim);
  if (tipo) params.set('tipo', tipo);
  if (cat) params.set('categoria', cat);

  try {
    const movs = await estApi('/relatorio?' + params);
    const wrap = document.getElementById('est-rel-table');

    if (!movs.length) { wrap.innerHTML = '<div style="padding:20px;color:#6b7280;text-align:center">Nenhum movimento no período</div>'; return; }

    const tipoStyle = { ENTRADA: 'color:#16a34a', SAIDA: 'color:#dc2626', AJUSTE: 'color:#d97706', TRANSFERENCIA: 'color:#7c3aed' };
    const tipoIcon = { ENTRADA: '📥', SAIDA: '📤', AJUSTE: '🔧', TRANSFERENCIA: '↔️' };

    wrap.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:.82rem">
      <thead><tr style="background:#f8fafc">
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Data</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Item</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Cat.</th>
        <th style="padding:7px 8px;text-align:center;border-bottom:2px solid #e2e8f0">Tipo</th>
        <th style="padding:7px 8px;text-align:right;border-bottom:2px solid #e2e8f0">Qtd</th>
        <th style="padding:7px 8px;text-align:right;border-bottom:2px solid #e2e8f0">V.Unit</th>
        <th style="padding:7px 8px;text-align:right;border-bottom:2px solid #e2e8f0">Total</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Motivo</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Fornecedor/NF</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Resp.</th>
      </tr></thead><tbody>
      ${movs.map(m => `<tr style="border-bottom:1px solid #f1f5f9">
        <td style="padding:6px 8px;white-space:nowrap">${m.data_movimento}</td>
        <td style="padding:6px 8px;font-weight:500">${m.codigo?`<span style="font-family:monospace;font-size:.72rem;color:#6b7280">${m.codigo} </span>`:''}${m.item_nome}</td>
        <td style="padding:6px 8px;font-size:.75rem">${CAT_INFO[m.categoria]?.icon||''}</td>
        <td style="padding:6px 8px;text-align:center;${tipoStyle[m.tipo]||''};font-weight:600">${tipoIcon[m.tipo]||''} ${m.tipo}</td>
        <td style="padding:6px 8px;text-align:right;font-weight:600;${tipoStyle[m.tipo]||''}">${m.tipo==='SAIDA'?'-':''}${m.quantidade} ${m.unidade}</td>
        <td style="padding:6px 8px;text-align:right">R$ ${(m.valor_unitario||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}</td>
        <td style="padding:6px 8px;text-align:right;font-weight:600">R$ ${(m.total||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}</td>
        <td style="padding:6px 8px;color:#374151">${m.motivo||'—'}</td>
        <td style="padding:6px 8px;font-size:.75rem;color:#6b7280">${m.fornecedor||''}${m.nota_fiscal?`<br>NF: ${m.nota_fiscal}`:''}</td>
        <td style="padding:6px 8px;font-size:.75rem;color:#6b7280">${m.responsavel||'—'}</td>
      </tr>`).join('')}
      </tbody>
    </table>`;
  } catch(e) { console.error(e); }
}

// ── ATIVAR / INATIVAR ITEM ─────────────────────────────────────
async function estoqueToggleAtivo(id, ativoAtual, btn) {
  const novoAtivo = ativoAtual ? 0 : 1;
  const msg = novoAtivo ? 'Reativar este item?' : 'Inativar este item? Ele não aparecerá mais na lista.';
  if (!confirm(msg)) return;
  try {
    const d = await estApi('/itens/'+id+'/ativo', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ativo: novoAtivo })
    });
    if (d.error) { alert(d.error); return; }
    estoqueCarregarItens();
  } catch(e) { alert('Erro: '+e.message); }
}

// ── EXPORTAR RELATÓRIO CSV ─────────────────────────────────────
function estoqueExportarCSV() {
  const rows = document.querySelectorAll('#est-rel-table table tbody tr');
  if (!rows.length) { alert('Nenhum dado para exportar'); return; }
  const headers = ['Data','Item','Código','Categoria','Tipo','Quantidade','Unidade','V.Unit (R$)','Total (R$)','Motivo','Fornecedor','NF','Responsável'];
  const lines = [headers.join(';')];
  rows.forEach(tr => {
    const tds = tr.querySelectorAll('td');
    if (tds.length < 9) return;
    const linha = [
      tds[0].textContent.trim(),
      tds[1].textContent.trim().replace(/\n/g,' '),
      '',
      tds[2].textContent.trim(),
      tds[3].textContent.trim(),
      tds[4].textContent.trim(),
      '',
      tds[5].textContent.trim().replace('R$ ','').replace(/\./g,'').replace(',','.'),
      tds[6].textContent.trim().replace('R$ ','').replace(/\./g,'').replace(',','.'),
      tds[7].textContent.trim(),
      tds[8].textContent.trim(),
      '',
      tds[9].textContent.trim()
    ].map(v => `"${v.replace(/"/g,'""')}"`);
    lines.push(linha.join(';'));
  });
  const blob = new Blob(['\uFEFF'+lines.join('\r\n')], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url;
  a.download = 'relatorio_estoque_'+new Date().toISOString().slice(0,10)+'.csv';
  a.click(); URL.revokeObjectURL(url);
}

// ══════════════════════════════════════════════════════════════
//  FICHA DE EPI / UNIFORME — Controle de entrega por funcionário
// ══════════════════════════════════════════════════════════════

let _fichaFuncionarios = [];

async function estoqueFichaCarregar() {
  // Carrega selects
  await _fichaCarregarItensEpiUniforme();
  await _fichaCarregarFuncionarios();
  document.getElementById('est-ficha-data').value = new Date().toISOString().slice(0,10);
  // Lista fichas pendentes
  estoqueFichaListar();
}

async function _fichaCarregarItensEpiUniforme() {
  try {
    const itens = await estApi('/itens?categoria=EPI');
    const itensU = await estApi('/itens?categoria=UNIFORME');
    const todos = [...itens, ...itensU];
    const sel = document.getElementById('est-ficha-item');
    sel.innerHTML = '<option value="">Selecione o item...</option>';
    ['EPI','UNIFORME'].forEach(cat => {
      const grupo = todos.filter(i => i.categoria === cat);
      if (!grupo.length) return;
      const og = document.createElement('optgroup');
      og.label = CAT_INFO[cat].icon + ' ' + CAT_INFO[cat].label;
      grupo.forEach(i => {
        const o = document.createElement('option');
        o.value = i.id; o.dataset.unidade = i.unidade;
        o.textContent = `${i.nome} (estoque: ${i.estoque_atual} ${i.unidade})`;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
  } catch(e) { console.error(e); }
}

async function _fichaCarregarFuncionarios() {
  try {
    _fichaFuncionarios = await estApi('/ficha-epi/funcionarios');
    const datalist = document.getElementById('est-ficha-func-list');
    if (datalist) {
      datalist.innerHTML = _fichaFuncionarios.map(f =>
        `<option value="${f.nome}" data-id="${f.id}" data-mat="${f.matricula||''}">`
      ).join('');
    }
  } catch(e) { _fichaFuncionarios = []; }
}

function estoqueFichaAutoFill() {
  const nome = document.getElementById('est-ficha-func').value;
  const func = _fichaFuncionarios.find(f => f.nome === nome);
  if (func) {
    document.getElementById('est-ficha-func-id').value = func.id;
    document.getElementById('est-ficha-mat').value = func.matricula || '';
    document.getElementById('est-ficha-lotacao').value = func.lotacao || '';
  }
}

async function estoqueRegistrarEntrega() {
  const funcionario_nome = document.getElementById('est-ficha-func').value;
  const funcionario_id   = document.getElementById('est-ficha-func-id').value || null;
  const funcionario_matricula = document.getElementById('est-ficha-mat').value;
  const item_id    = document.getElementById('est-ficha-item').value;
  const quantidade = document.getElementById('est-ficha-qtd').value;
  const tamanho    = document.getElementById('est-ficha-tam').value;
  const data_entrega = document.getElementById('est-ficha-data').value;
  const responsavel  = document.getElementById('est-ficha-resp').value;
  const obs          = document.getElementById('est-ficha-obs').value;
  const contrato_ref = document.getElementById('est-ficha-contrato').value;
  const posto        = document.getElementById('est-ficha-posto').value;

  if (!funcionario_nome || !item_id || !data_entrega) {
    alert('Preencha Funcionário, Item e Data'); return;
  }
  try {
    const d = await estApi('/ficha-epi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ funcionario_id, funcionario_nome, funcionario_matricula, item_id, quantidade, tamanho, data_entrega, responsavel, obs, contrato_ref, posto })
    });
    if (d.error) { alert(d.error); return; }
    const validadeMsg = d.data_validade ? `\nVálido até: ${d.data_validade}` : '';
    const empresaMsg = d.aviso_empresa ? `\n\n${d.aviso_empresa}` : '';
    alert('✅ Entrega registrada!' + validadeMsg + empresaMsg);
    ['est-ficha-func','est-ficha-func-id','est-ficha-mat','est-ficha-lotacao','est-ficha-tam','est-ficha-obs','est-ficha-resp','est-ficha-contrato','est-ficha-posto'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value='';
    });
    document.getElementById('est-ficha-qtd').value = '1';
    document.getElementById('est-ficha-item').value = '';
    document.getElementById('est-ficha-data').value = new Date().toISOString().slice(0,10);
    estoqueFichaListar();
    _fichaCarregarItensEpiUniforme();
  } catch(e) { alert('Erro: '+e.message); }
}

async function estoqueFichaListar() {
  const busca   = document.getElementById('est-ficha-busca').value;
  const pendente = document.getElementById('est-ficha-pend').checked ? '1' : '';
  const params  = new URLSearchParams();
  if (busca) params.set('busca', busca);
  if (pendente) params.set('pendente', '1');

  try {
    const fichas = await estApi('/ficha-epi?' + params);
    const wrap = document.getElementById('est-ficha-table');
    if (!fichas.length) {
      wrap.innerHTML = '<div style="padding:16px;color:#6b7280;text-align:center">Nenhuma entrega encontrada</div>'; return;
    }
    const hoje = new Date().toISOString().slice(0,10);
    wrap.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:.82rem">
      <thead><tr style="background:#f8fafc">
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Funcionário</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Matrícula</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Item / CA</th>
        <th style="padding:7px 8px;text-align:center;border-bottom:2px solid #e2e8f0">Qtd</th>
        <th style="padding:7px 8px;text-align:center;border-bottom:2px solid #e2e8f0">Tam.</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Entrega</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Vence</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Devolução</th>
        <th style="padding:7px 8px;text-align:left;border-bottom:2px solid #e2e8f0">Contrato / Posto</th>
        <th style="padding:7px 8px;border-bottom:2px solid #e2e8f0"></th>
      </tr></thead><tbody>
      ${fichas.map(f => {
        const devolvido = !!(f.data_devolucao);
        const vencido = f.data_validade && f.data_validade < hoje && !devolvido;
        const vencendo = f.data_validade && f.data_validade >= hoje && f.data_validade <= new Date(Date.now()+30*86400000).toISOString().slice(0,10) && !devolvido;
        let rowStyle = 'border-bottom:1px solid #f1f5f9;';
        if (devolvido) rowStyle += 'background:#f0fdf4;';
        else if (vencido) rowStyle += 'background:#fef2f2;';
        else if (vencendo) rowStyle += 'background:#fffbeb;';
        return `<tr style="${rowStyle}">
          <td style="padding:6px 8px;font-weight:500">${f.funcionario_nome}</td>
          <td style="padding:6px 8px;font-size:.77rem;color:#6b7280">${f.funcionario_matricula||'—'}</td>
          <td style="padding:6px 8px">
            <span style="background:${CAT_INFO[f.categoria]?.cor||'#374151'}18;color:${CAT_INFO[f.categoria]?.cor||'#374151'};padding:1px 6px;border-radius:10px;font-size:.72rem">${CAT_INFO[f.categoria]?.icon||''}</span>
            ${f.item_nome}${f.ca_numero?`<div style="font-size:.7rem;color:#92400e">CA ${f.ca_numero}</div>`:''}
          </td>
          <td style="padding:6px 8px;text-align:center;font-weight:600">${f.quantidade} ${f.unidade}</td>
          <td style="padding:6px 8px;text-align:center;font-size:.78rem">${f.tamanho||'—'}</td>
          <td style="padding:6px 8px;white-space:nowrap">${f.data_entrega}</td>
          <td style="padding:6px 8px;white-space:nowrap;font-size:.78rem;${vencido?'color:#dc2626;font-weight:700':vencendo?'color:#d97706;font-weight:600':'color:#6b7280'}">
            ${f.data_validade ? (vencido?'❌ ':vencendo?'⚠️ ':'')+f.data_validade : '—'}
          </td>
          <td style="padding:6px 8px;white-space:nowrap;${devolvido?'color:#16a34a':'color:#dc2626'}">${devolvido?f.data_devolucao:'⏳ Pendente'}</td>
          <td style="padding:6px 8px;font-size:.75rem;color:#6b7280">${f.contrato_ref||''}${f.posto?`<br>${f.posto}`:''}</td>
          <td style="padding:6px 8px;white-space:nowrap">
            ${!devolvido ? `<button onclick="estoqueFichaDevolver(${f.id})" style="background:#dcfce7;color:#16a34a;border:none;padding:3px 8px;border-radius:4px;font-size:.75rem;cursor:pointer">↩️ Devolver</button>` : '<span style="color:#16a34a;font-size:.75rem">✅</span>'}
          </td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>`;
  } catch(e) { console.error('ficha epi:', e); }
}

async function estoqueFichaDevolver(fichaId) {
  const data = prompt('Data de devolução (AAAA-MM-DD):', new Date().toISOString().slice(0,10));
  if (!data) return;
  try {
    const d = await estApi('/ficha-epi/'+fichaId+'/devolucao', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data_devolucao: data })
    });
    if (d.error) { alert(d.error); return; }
    alert('✅ Devolução registrada');
    estoqueFichaListar();
  } catch(e) { alert('Erro: '+e.message); }
}

// ── ALERTAS EPI / CA ───────────────────────────────────────────
async function estoqueCarregarAlertas() {
  try {
    const d = await estApi('/alertas');
    const hoje = new Date().toISOString().slice(0,10);

    // Resumo
    const resumoDiv = document.getElementById('est-alertas-resumo');
    const cards = [
      { label: 'CA Vencidos',      val: d.resumo.ca_vencidos,      cor: '#dc2626', bg: '#fef2f2', icon: '❌' },
      { label: 'CA Vencendo 30d',  val: d.resumo.ca_vencendo_30d,  cor: '#d97706', bg: '#fffbeb', icon: '⚠️' },
      { label: 'EPI Vencidos',     val: d.resumo.epi_vencidos,     cor: '#dc2626', bg: '#fef2f2', icon: '🦺' },
      { label: 'EPI Vencendo 30d', val: d.resumo.epi_vencendo_30d, cor: '#d97706', bg: '#fffbeb', icon: '⏰' },
      { label: 'Estoque Baixo',    val: d.resumo.estoque_baixo,    cor: '#0369a1', bg: '#eff6ff', icon: '📦' },
    ];
    resumoDiv.innerHTML = cards.map(c => `
      <div style="background:${c.bg};border:1px solid ${c.cor}30;border-radius:8px;padding:10px 14px;text-align:center">
        <div style="font-size:1.4rem;font-weight:700;color:${c.cor}">${c.val}</div>
        <div style="font-size:.73rem;color:#6b7280">${c.icon} ${c.label}</div>
      </div>`).join('');

    // CA alertas
    const caDiv = document.getElementById('est-alertas-ca');
    if (!d.ca_alertas.length) { caDiv.innerHTML = '<div style="color:#16a34a;padding:8px;font-size:.83rem">✅ Nenhum CA vencido ou vencendo</div>'; }
    else {
      caDiv.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:.82rem">
        <thead><tr style="background:#fef3c7">
          <th style="padding:6px 8px;text-align:left">Item</th>
          <th style="padding:6px 8px;text-align:left">CA Nº</th>
          <th style="padding:6px 8px;text-align:left">Validade</th>
          <th style="padding:6px 8px;text-align:right">Estoque</th>
        </tr></thead><tbody>
        ${d.ca_alertas.map(a => {
          const venc = a.ca_validade < hoje;
          return `<tr style="border-bottom:1px solid #fde68a;${venc?'background:#fef2f2':'background:#fffbeb'}">
            <td style="padding:5px 8px;font-weight:500">${a.nome}</td>
            <td style="padding:5px 8px;font-family:monospace">${a.ca_numero||'—'}</td>
            <td style="padding:5px 8px;${venc?'color:#dc2626;font-weight:700':'color:#d97706;font-weight:600'}">${venc?'❌ ':'⚠️ '}${a.ca_validade}</td>
            <td style="padding:5px 8px;text-align:right">${a.estoque_atual} ${a.unidade}</td>
          </tr>`;
        }).join('')}
        </tbody></table>`;
    }

    // EPI vencidos
    const epiDiv = document.getElementById('est-alertas-epi');
    if (!d.epi_vencidos.length) { epiDiv.innerHTML = '<div style="color:#16a34a;padding:8px;font-size:.83rem">✅ Nenhum EPI com vida útil vencida</div>'; }
    else {
      epiDiv.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:.82rem">
        <thead><tr style="background:#fef3c7">
          <th style="padding:6px 8px;text-align:left">Funcionário</th>
          <th style="padding:6px 8px;text-align:left">Item / CA</th>
          <th style="padding:6px 8px;text-align:left">Entrega</th>
          <th style="padding:6px 8px;text-align:left">Vencimento</th>
          <th style="padding:6px 8px;text-align:left">Contrato / Posto</th>
        </tr></thead><tbody>
        ${d.epi_vencidos.map(e => {
          const venc = e.data_validade < hoje;
          return `<tr style="border-bottom:1px solid #fde68a;${venc?'background:#fef2f2':'background:#fffbeb'}">
            <td style="padding:5px 8px;font-weight:500">${e.funcionario_nome}${e.funcionario_matricula?`<div style="font-size:.7rem;color:#6b7280">${e.funcionario_matricula}</div>`:''}</td>
            <td style="padding:5px 8px">${e.item_nome}${e.ca_numero?`<div style="font-size:.7rem;color:#92400e">CA ${e.ca_numero}</div>`:''}</td>
            <td style="padding:5px 8px;font-size:.78rem">${e.data_entrega}</td>
            <td style="padding:5px 8px;${venc?'color:#dc2626;font-weight:700':'color:#d97706;font-weight:600'}">${venc?'❌ ':'⚠️ '}${e.data_validade}</td>
            <td style="padding:5px 8px;font-size:.75rem;color:#6b7280">${e.contrato_ref||''}${e.posto?` / ${e.posto}`:''}</td>
          </tr>`;
        }).join('')}
        </tbody></table>`;
    }

    // Estoque baixo
    const baixoDiv = document.getElementById('est-alertas-baixo');
    if (!d.estoque_baixo.length) { baixoDiv.innerHTML = '<div style="color:#16a34a;padding:8px;font-size:.83rem">✅ Todos os itens acima do mínimo</div>'; }
    else {
      baixoDiv.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:.82rem">
        <thead><tr style="background:#eff6ff">
          <th style="padding:6px 8px;text-align:left">Item</th>
          <th style="padding:6px 8px;text-align:left">Categoria</th>
          <th style="padding:6px 8px;text-align:right">Atual</th>
          <th style="padding:6px 8px;text-align:right">Mínimo</th>
          <th style="padding:6px 8px;text-align:left">Contrato</th>
        </tr></thead><tbody>
        ${d.estoque_baixo.map(b => `<tr style="border-bottom:1px solid #dbeafe">
          <td style="padding:5px 8px;font-weight:500">${b.nome}</td>
          <td style="padding:5px 8px"><span style="background:${CAT_INFO[b.categoria]?.cor||'#374151'}18;color:${CAT_INFO[b.categoria]?.cor||'#374151'};padding:1px 6px;border-radius:10px;font-size:.72rem">${CAT_INFO[b.categoria]?.icon||''} ${CAT_INFO[b.categoria]?.label||b.categoria}</span></td>
          <td style="padding:5px 8px;text-align:right;font-weight:700;color:#dc2626">${b.estoque_atual} ${b.unidade}</td>
          <td style="padding:5px 8px;text-align:right;color:#6b7280">${b.estoque_minimo}</td>
          <td style="padding:5px 8px;font-size:.75rem;color:#6b7280">${b.contrato_ref||'—'}</td>
        </tr>`).join('')}
        </tbody></table>`;
    }
  } catch(e) { console.error('alertas estoque:', e); }
}

// ── CSS BOTÕES NAV ─────────────────────────────────────────────
(function injectEstoqueStyle() {
  const s = document.createElement('style');
  s.textContent = `
    .btn-est-nav { background:#f1f5f9;color:#374151;border:1px solid #e2e8f0;padding:6px 12px;border-radius:6px;font-size:.83rem;cursor:pointer;transition:.15s }
    .btn-est-nav:hover { background:#e2e8f0 }
    .btn-est-nav.active-est { background:#0f766e;color:#fff;border-color:#0f766e }
  `;
  document.head.appendChild(s);
})();

// Inicializar ao abrir aba
document.addEventListener('DOMContentLoaded', () => {});
window.estoqueInit = function() { estoqueShowView('dashboard'); };
