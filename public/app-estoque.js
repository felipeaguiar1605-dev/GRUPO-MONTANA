// ═══════════════════════════════════════════════════════════════
//  MÓDULO DE ESTOQUE — Equipamentos, Maquinários, EPIs, Consumíveis
// ═══════════════════════════════════════════════════════════════

// Helper: reutiliza a função api() global do app.js que já inclui Authorization + X-Company
function estApi(url, opts) {
  return api('/estoque' + url, opts);
}

const CAT_INFO = {
  EQUIPAMENTO: { icon: '🔧', label: 'Equipamento',  cor: '#0369a1' },
  MAQUINARIO:  { icon: '⚙️', label: 'Maquinário',   cor: '#7c3aed' },
  EPI:         { icon: '🦺', label: 'EPI',           cor: '#d97706' },
  CONSUMIVEL:  { icon: '📦', label: 'Consumível',    cor: '#059669' },
};

function estoqueShowView(v) {
  ['dashboard','itens','mov','rel','novo'].forEach(id => {
    document.getElementById('est-view-'+id).style.display = id === v ? '' : 'none';
    // O botão do dashboard tem id est-btn-dash (não est-btn-dashboard)
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
            <div style="font-weight:600;color:#dc2626">${CAT_INFO[a.categoria]?.icon||''} ${a.nome}</div>
            <div style="font-size:.75rem;color:#6b7280">${a.categoria}</div>
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
            <span style="font-size:.8rem">${tipoIcon[m.tipo]||''} <strong>${m.item_nome}</strong></span>
            <div style="font-size:.72rem;color:#6b7280">${m.data_movimento} — ${m.motivo||m.tipo}</div>
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
          <td style="padding:7px 8px;font-weight:500">${it.nome}${it.descricao?`<div style="font-size:.72rem;color:#9ca3af">${it.descricao}</div>`:''}</td>
          <td style="padding:7px 8px"><span style="background:${info.cor}18;color:${info.cor};padding:2px 7px;border-radius:20px;font-size:.75rem">${info.icon} ${info.label}</span></td>
          <td style="padding:7px 8px;text-align:center;font-weight:700;color:${alerta?'#dc2626':'#059669'}">${it.estoque_atual} ${it.unidade}${alerta?` <span title="Abaixo do mínimo">⚠️</span>`:''}</td>
          <td style="padding:7px 8px;text-align:center;color:#6b7280">${it.estoque_minimo||'—'}</td>
          <td style="padding:7px 8px;text-align:right">R$ ${(it.valor_unitario||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}</td>
          <td style="padding:7px 8px;text-align:right;font-weight:600">R$ ${((it.estoque_atual||0)*(it.valor_unitario||0)).toLocaleString('pt-BR',{minimumFractionDigits:2})}</td>
          <td style="padding:7px 8px;font-size:.75rem;color:#6b7280">${it.localizacao||'—'}</td>
          <td style="padding:7px 8px;white-space:nowrap">
            <button onclick="estoqueEditarItem(${it.id})" style="background:#e0f2fe;color:#0369a1;border:none;padding:3px 8px;border-radius:4px;font-size:.75rem;cursor:pointer">✏️</button>
            <button onclick="estoqueAbrirMovimento(${it.id},'${it.nome.replace(/'/g,"\\'")}',${it.estoque_atual},'${it.unidade}')" style="background:#dcfce7;color:#16a34a;border:none;padding:3px 8px;border-radius:4px;font-size:.75rem;cursor:pointer;margin-left:3px">🔄</button>
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
    codigo:        document.getElementById('est-form-codigo').value,
    categoria:     document.getElementById('est-form-cat').value,
    nome:          document.getElementById('est-form-nome').value,
    descricao:     document.getElementById('est-form-desc').value,
    unidade:       document.getElementById('est-form-un').value,
    estoque_minimo:document.getElementById('est-form-min').value,
    valor_unitario:document.getElementById('est-form-vunit').value,
    localizacao:   document.getElementById('est-form-local').value,
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
    alert('✅ ' + d.message);
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
