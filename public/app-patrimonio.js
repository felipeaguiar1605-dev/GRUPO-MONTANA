/**
 * Montana — Módulo Patrimônio (Ativos Fixos + Depreciação Linear)
 * Frontend: lista, KPIs, depreciação, alocação por contrato, baixa.
 */
(function () {
  'use strict';

  // estado
  let _ativosCache  = [];
  let _filtros      = { categoria: 'todos', status: 'ativo', contrato_id: '' };
  let _competencia  = null;
  let _editId       = null;

  const CATEGORIAS = ['Veículo', 'Equipamento', 'Fardamento', 'Mobiliário', 'TI', 'Outro'];

  // ── Init ────────────────────────────────────────────────────────────
  window.patrimonioInit = function () {
    const inputComp = document.getElementById('patr-competencia');
    if (inputComp && !inputComp.value) {
      const d = new Date();
      inputComp.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    }
    _competencia = inputComp ? inputComp.value : null;
    patrCarregar();
  };

  // ── Sub-tab switch ──────────────────────────────────────────────────
  window.patrSubtab = function (tab) {
    document.querySelectorAll('.patr-subtab').forEach(b => {
      const active = b.dataset.tab === tab;
      b.style.borderBottomColor = active ? '#3b82f6' : 'transparent';
      b.style.color = active ? '#3b82f6' : '#64748b';
      b.classList.toggle('active', active);
    });
    document.getElementById('patr-tab-ativos').style.display    = tab === 'ativos'    ? '' : 'none';
    document.getElementById('patr-tab-contratos').style.display = tab === 'contratos' ? '' : 'none';
    if (tab === 'contratos') patrCarregarPorContrato();
  };

  // ── Carrega resumo + lista ──────────────────────────────────────────
  window.patrCarregar = async function () {
    showLoading('Carregando patrimônio…');
    try {
      _competencia = document.getElementById('patr-competencia')?.value
        || new Date().toISOString().slice(0, 7);

      const [resumo, lista] = await Promise.all([
        api(`/patrimonio/resumo?competencia=${_competencia}`),
        api(`/patrimonio?` + buildListQS()),
      ]);
      if (!resumo.ok) throw new Error(resumo.erro || 'Erro ao carregar resumo');
      if (!lista.ok)  throw new Error(lista.erro  || 'Erro ao carregar ativos');

      _ativosCache = lista.ativos || [];
      patrRenderKpis(resumo.kpis);
      patrRenderCategorias(resumo.ativos_por_categoria);
      patrRenderTabela(_ativosCache);
    } catch (e) {
      toast('Erro: ' + e.message, 'error');
    } finally {
      hideLoading();
    }
  };

  function buildListQS() {
    const p = new URLSearchParams();
    if (_filtros.categoria   && _filtros.categoria !== 'todos') p.set('categoria', _filtros.categoria);
    if (_filtros.status      && _filtros.status    !== 'todos') p.set('status', _filtros.status);
    if (_filtros.contrato_id) p.set('contrato_id', _filtros.contrato_id);
    return p.toString();
  }

  window.patrFiltrar = function () {
    _filtros.categoria   = document.getElementById('patr-f-categoria').value;
    _filtros.status      = document.getElementById('patr-f-status').value;
    _filtros.contrato_id = document.getElementById('patr-f-contrato').value.trim();
    patrCarregar();
  };

  // ── KPIs ────────────────────────────────────────────────────────────
  function patrRenderKpis(k) {
    const $ = id => document.getElementById(id);
    $('patr-k-total').textContent     = k.total_ativos + (k.total_baixados ? ` (+${k.total_baixados} baix.)` : '');
    $('patr-k-aquisicao').textContent = brl(k.valor_total_aquisicao);
    $('patr-k-atual').textContent     = brl(k.valor_atual_total);
    $('patr-k-deprmes').textContent   = brl(k.depreciacao_mensal_total);
  }

  function patrRenderCategorias(cats) {
    const wrap = document.getElementById('patr-categorias');
    if (!wrap) return;
    if (!cats || !cats.length) {
      wrap.innerHTML = '<div style="padding:8px;color:#94a3b8;font-size:11px">Sem categorias</div>';
      return;
    }
    wrap.innerHTML = cats.map(c => `
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:8px 12px;display:flex;flex-direction:column;gap:2px;min-width:140px">
        <div style="font-size:10px;color:#64748b;font-weight:700;text-transform:uppercase">${escHtml(c.categoria)}</div>
        <div style="font-size:13px;font-weight:800;color:#0f172a">${c.qtd}<span style="font-size:9px;color:#94a3b8;font-weight:600;margin-left:3px">ativos</span></div>
        <div style="font-size:10px;color:#475569">${brl(c.valor_atual)} <span style="color:#94a3b8">(atual)</span></div>
        <div style="font-size:10px;color:#0ea5e9">${brl(c.depreciacao_mensal)}/mês</div>
      </div>
    `).join('');
  }

  // ── Tabela principal ────────────────────────────────────────────────
  function patrRenderTabela(ativos) {
    const tbody = document.getElementById('patr-body');
    if (!ativos || !ativos.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#94a3b8;padding:24px">Nenhum ativo encontrado</td></tr>';
      return;
    }
    tbody.innerHTML = ativos.map(a => {
      const pct = Math.min(a.percentual_depreciado || 0, 100);
      const corBarra = pct >= 90 ? '#94a3b8' : pct >= 60 ? '#f59e0b' : '#22c55e';
      const contratoTxt = a.contrato_ref || (a.contrato_id ? '#' + a.contrato_id : '<span style="color:#cbd5e1">—</span>');
      return `
      <tr style="cursor:pointer" onclick="patrVerDetalhe(${a.id})" title="Clique para ver detalhe">
        <td style="font-size:11px;color:#0f172a;font-weight:600;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${escHtml(a.descricao)}
          ${a.numero_serie ? `<div style="font-size:9px;color:#94a3b8">SN: ${escHtml(a.numero_serie)}</div>` : ''}
        </td>
        <td style="font-size:11px;color:#475569">${escHtml(a.categoria || '—')}</td>
        <td style="font-size:11px;color:#475569;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${contratoTxt}</td>
        <td style="font-size:10px;color:#64748b">${a.data_aquisicao || '—'}</td>
        <td class="r mono" style="font-weight:700">${brl(a.valor_atual)}</td>
        <td class="r mono" style="color:#0ea5e9">${brl(a.depreciacao_mensal)}</td>
        <td>
          <div style="display:flex;align-items:center;gap:5px">
            <div style="flex:1;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden;min-width:60px">
              <div style="width:${pct}%;height:100%;background:${corBarra};border-radius:3px"></div>
            </div>
            <span style="font-size:9px;color:#475569;white-space:nowrap">${pct.toFixed(0)}%</span>
          </div>
        </td>
        <td class="r mono muted" style="font-size:10px">${a.vida_util_restante_meses}m</td>
        <td>${patrStatusBadge(a.status)}</td>
      </tr>`;
    }).join('');
  }

  function patrStatusBadge(status) {
    const map = {
      ativo:    { cor: '#dcfce7', txt: '#166534', label: '🟢 Ativo' },
      baixado:  { cor: '#fee2e2', txt: '#991b1b', label: '🔴 Baixado' },
      alienado: { cor: '#fef9c3', txt: '#854d0e', label: '🟡 Alienado' },
    };
    const s = map[status] || map.ativo;
    return `<span style="background:${s.cor};color:${s.txt};padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;white-space:nowrap">${s.label}</span>`;
  }

  // ── Sub-aba: Por Contrato ───────────────────────────────────────────
  window.patrCarregarPorContrato = async function () {
    const tbody = document.getElementById('patr-contratos-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:14px;color:#94a3b8">Carregando…</td></tr>';
    try {
      const comp = document.getElementById('patr-competencia').value;
      const d = await api(`/patrimonio/por-contrato?competencia=${comp}`);
      if (!d.ok) throw new Error(d.erro || 'Erro');

      const lista = d.contratos || [];
      if (!lista.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:18px;color:#94a3b8">Nenhum ativo gerando depreciação na competência</td></tr>';
        return;
      }
      tbody.innerHTML = lista.map(c => {
        const semAlocacao = !c.contrato_id && (!c.contrato_ref || c.contrato_ref === 'Sem alocação');
        return `
          <tr style="${semAlocacao ? 'background:#f8fafc' : ''}">
            <td style="font-size:12px;font-weight:${semAlocacao ? '500' : '700'};color:${semAlocacao ? '#94a3b8' : '#0f172a'}">
              ${semAlocacao ? '⚪ Sem alocação' : escHtml(c.contrato_ref || ('Contrato #' + c.contrato_id))}
            </td>
            <td class="r mono">${c.qtd_ativos}</td>
            <td class="r mono">${brl(c.valor_aquisicao)}</td>
            <td class="r mono" style="font-weight:700">${brl(c.valor_atual)}</td>
            <td class="r mono" style="color:#0ea5e9;font-weight:700">${brl(c.depreciacao_mensal)}</td>
          </tr>`;
      }).join('') + `
        <tr style="background:#f1f5f9;font-weight:800;border-top:2px solid #cbd5e1">
          <td colspan="4" style="text-align:right;padding:8px 12px;color:#0f172a">TOTAL DEPRECIAÇÃO MENSAL</td>
          <td class="r mono" style="color:#0ea5e9;font-size:13px">${brl(d.total_depreciacao_mensal)}</td>
        </tr>`;
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:14px;color:#ef4444">Erro: ${escHtml(e.message)}</td></tr>`;
    }
  };

  // ── Modal: Detalhe / Edição ─────────────────────────────────────────
  window.patrVerDetalhe = async function (id) {
    showLoading('Carregando detalhe…');
    try {
      const d = await api(`/patrimonio/${id}`);
      if (!d.ok) throw new Error(d.erro || 'Erro');
      patrAbrirModalDetalhe(d.ativo, d.historico);
    } catch (e) {
      toast('Erro: ' + e.message, 'error');
    } finally {
      hideLoading();
    }
  };

  function patrAbrirModalDetalhe(a, historico) {
    const ex = document.getElementById('patr-modal-detalhe');
    if (ex) ex.remove();

    const linhasHist = (historico || []).map(h => `
      <tr style="${h.projetado ? 'background:#fafbfc;color:#94a3b8' : ''}">
        <td style="font-size:11px;font-weight:${h.projetado ? '500' : '600'}">${h.mes}${h.projetado ? ' <span style="font-size:9px;color:#cbd5e1">(proj)</span>' : ''}</td>
        <td class="r mono" style="font-size:11px">${h.meses_decorridos}m</td>
        <td class="r mono" style="font-size:11px">${brl(h.depreciacao_mensal)}</td>
        <td class="r mono" style="font-size:11px;color:#0ea5e9">${brl(h.depreciacao_acumulada)}</td>
        <td class="r mono" style="font-size:11px;font-weight:700">${brl(h.valor_contabil)}</td>
      </tr>
    `).join('');

    const modal = document.createElement('div');
    modal.id = 'patr-modal-detalhe';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:9000;display:flex;align-items:flex-start;justify-content:center;padding-top:30px';
    modal.onclick = e => { if (e.target === modal) modal.remove(); };

    modal.innerHTML = `
      <div style="background:#fff;border-radius:12px;width:780px;max-width:96vw;max-height:90vh;overflow-y:auto;padding:18px;box-shadow:0 20px 60px rgba(0,0,0,.3)">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px;gap:12px">
          <div style="flex:1">
            <div style="font-size:16px;font-weight:800;color:#0f172a;margin-bottom:4px">🏗️ ${escHtml(a.descricao)}</div>
            <div style="font-size:11px;color:#64748b">
              ${escHtml(a.categoria || 'Sem categoria')}
              ${a.numero_serie ? ' · SN: ' + escHtml(a.numero_serie) : ''}
              · ${patrStatusBadge(a.status)}
            </div>
          </div>
          <button onclick="document.getElementById('patr-modal-detalhe').remove()"
            style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:4px 12px;cursor:pointer;color:#64748b;font-size:12px">
            ✕ Fechar
          </button>
        </div>

        <!-- Cards de resumo -->
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 12px">
            <div style="font-size:9px;color:#64748b;font-weight:700;text-transform:uppercase">Aquisição</div>
            <div style="font-size:13px;font-weight:800;color:#0f172a">${brl(a.valor_aquisicao)}</div>
            <div style="font-size:10px;color:#94a3b8">${a.data_aquisicao || '—'}</div>
          </div>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 12px">
            <div style="font-size:9px;color:#64748b;font-weight:700;text-transform:uppercase">Valor Atual</div>
            <div style="font-size:13px;font-weight:800;color:#0f172a">${brl(a.valor_atual)}</div>
            <div style="font-size:10px;color:#94a3b8">${a.percentual_depreciado.toFixed(1)}% depreciado</div>
          </div>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 12px">
            <div style="font-size:9px;color:#64748b;font-weight:700;text-transform:uppercase">Depr. Mensal</div>
            <div style="font-size:13px;font-weight:800;color:#0ea5e9">${brl(a.depreciacao_mensal)}</div>
            <div style="font-size:10px;color:#94a3b8">linear</div>
          </div>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:8px 12px">
            <div style="font-size:9px;color:#64748b;font-weight:700;text-transform:uppercase">Vida Restante</div>
            <div style="font-size:13px;font-weight:800;color:#0f172a">${a.vida_util_restante_meses}<span style="font-size:9px;color:#94a3b8">/${a.vida_util_meses}m</span></div>
            <div style="font-size:10px;color:#94a3b8">${a.meses_decorridos} meses decorridos</div>
          </div>
        </div>

        <!-- Dados completos -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;font-size:11px">
          <div><b>Contrato:</b> ${escHtml(a.contrato_ref || (a.contrato_id ? '#' + a.contrato_id : '—'))}</div>
          <div><b>Valor residual:</b> ${brl(a.valor_residual)}</div>
          <div><b>Vida útil:</b> ${a.vida_util_meses} meses</div>
          <div><b>Status:</b> ${escHtml(a.status)}</div>
          ${a.data_baixa ? `<div><b>Data baixa:</b> ${a.data_baixa}</div>` : ''}
          ${a.motivo_baixa ? `<div><b>Motivo baixa:</b> ${escHtml(a.motivo_baixa)}</div>` : ''}
          ${a.observacoes ? `<div style="grid-column:1/-1"><b>Obs:</b> ${escHtml(a.observacoes)}</div>` : ''}
        </div>

        <!-- Ações -->
        <div style="display:flex;gap:8px;margin-bottom:14px">
          <button onclick="patrAbrirEdicao(${a.id})" style="background:#dbeafe;color:#1d4ed8;border:1px solid #93c5fd;padding:6px 14px;font-size:11px;border-radius:6px;cursor:pointer;font-weight:700">
            ✏️ Editar
          </button>
          ${a.status === 'ativo' ? `
          <button onclick="patrAbrirBaixa(${a.id})" style="background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;padding:6px 14px;font-size:11px;border-radius:6px;cursor:pointer;font-weight:700">
            🗑️ Registrar Baixa
          </button>` : ''}
        </div>

        <!-- Histórico mês a mês -->
        <div>
          <div style="font-size:11px;font-weight:700;color:#0f172a;margin-bottom:6px">📈 Histórico de Depreciação (24m + projeção)</div>
          <div class="tw" style="max-height:280px;overflow-y:auto">
            <table>
              <thead><tr style="font-size:10px">
                <th>Competência</th>
                <th class="r">Mês</th>
                <th class="r">Depr. Mês</th>
                <th class="r">Acumulada</th>
                <th class="r">Valor Contábil</th>
              </tr></thead>
              <tbody>${linhasHist || '<tr><td colspan="5" style="text-align:center;color:#94a3b8;padding:10px">Sem histórico</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  // ── Modal: Cadastro / Edição ────────────────────────────────────────
  window.patrAbrirCadastro = function () { patrAbrirEdicao(null); };

  window.patrAbrirEdicao = async function (id) {
    _editId = id || null;
    let dados = null;
    if (id) {
      try {
        const d = await api(`/patrimonio/${id}`);
        if (!d.ok) throw new Error(d.erro || 'Erro');
        dados = d.ativo;
      } catch (e) { toast('Erro: ' + e.message, 'error'); return; }
    }
    patrAbrirModalForm(dados);
  };

  function patrAbrirModalForm(a) {
    document.getElementById('patr-modal-detalhe')?.remove();
    document.getElementById('patr-modal-form')?.remove();

    const isNovo = !a;
    const opts = CATEGORIAS.map(c =>
      `<option value="${c}" ${a && a.categoria === c ? 'selected' : ''}>${c}</option>`
    ).join('');

    const modal = document.createElement('div');
    modal.id = 'patr-modal-form';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:9100;display:flex;align-items:flex-start;justify-content:center;padding-top:30px';
    modal.onclick = e => { if (e.target === modal) modal.remove(); };

    modal.innerHTML = `
      <div style="background:#fff;border-radius:12px;width:680px;max-width:96vw;max-height:90vh;overflow-y:auto;padding:18px;box-shadow:0 20px 60px rgba(0,0,0,.3)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <div style="font-size:15px;font-weight:800;color:#0f172a">${isNovo ? '➕ Novo Ativo' : '✏️ Editar Ativo'}</div>
          <button onclick="document.getElementById('patr-modal-form').remove()"
            style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:4px 12px;cursor:pointer;color:#64748b;font-size:12px">
            ✕
          </button>
        </div>
        <form id="patr-form" onsubmit="return patrSalvar(event)" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:11px">
          <label style="grid-column:1/-1">Descrição*
            <input name="descricao" required value="${a ? escAttr(a.descricao) : ''}" style="width:100%;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px">
          </label>
          <label>Categoria
            <select name="categoria" style="width:100%;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px">
              <option value="">— sem —</option>${opts}
            </select>
          </label>
          <label>Número de série / patrimônio
            <input name="numero_serie" value="${a ? escAttr(a.numero_serie || '') : ''}" style="width:100%;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px">
          </label>
          <label>Contrato (referência textual)
            <input name="contrato_ref" placeholder="ex.: UFT 16/2025" value="${a ? escAttr(a.contrato_ref || '') : ''}" style="width:100%;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px">
          </label>
          <label>Contrato ID (opcional)
            <input name="contrato_id" type="number" value="${a && a.contrato_id ? a.contrato_id : ''}" style="width:100%;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px">
          </label>
          <label>Valor de aquisição*
            <input name="valor_aquisicao" type="number" step="0.01" required value="${a ? num(a.valor_aquisicao) : ''}" style="width:100%;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px">
          </label>
          <label>Valor residual
            <input name="valor_residual" type="number" step="0.01" value="${a ? num(a.valor_residual || 0) : '0'}" style="width:100%;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px">
          </label>
          <label>Data de aquisição*
            <input name="data_aquisicao" type="date" required value="${a ? (a.data_aquisicao || '') : ''}" style="width:100%;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px">
          </label>
          <label>Vida útil (meses)*
            <input name="vida_util_meses" type="number" required value="${a ? a.vida_util_meses : '60'}" style="width:100%;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px">
          </label>
          <label>Status
            <select name="status" style="width:100%;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px">
              <option value="ativo"    ${!a || a.status === 'ativo'    ? 'selected' : ''}>Ativo</option>
              <option value="baixado"  ${a && a.status === 'baixado'  ? 'selected' : ''}>Baixado</option>
              <option value="alienado" ${a && a.status === 'alienado' ? 'selected' : ''}>Alienado</option>
            </select>
          </label>
          <label>Data de baixa (se baixado)
            <input name="data_baixa" type="date" value="${a && a.data_baixa ? a.data_baixa : ''}" style="width:100%;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px">
          </label>
          <label style="grid-column:1/-1">Motivo da baixa
            <input name="motivo_baixa" value="${a ? escAttr(a.motivo_baixa || '') : ''}" style="width:100%;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px">
          </label>
          <label style="grid-column:1/-1">Observações
            <textarea name="observacoes" rows="2" style="width:100%;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px;resize:vertical">${a ? escHtml(a.observacoes || '') : ''}</textarea>
          </label>
          <div style="grid-column:1/-1;display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
            <button type="button" onclick="document.getElementById('patr-modal-form').remove()" style="background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;padding:6px 16px;border-radius:6px;cursor:pointer;font-weight:600">Cancelar</button>
            <button type="submit" style="background:#3b82f6;color:#fff;border:none;padding:6px 18px;border-radius:6px;cursor:pointer;font-weight:700">${isNovo ? '➕ Cadastrar' : '💾 Salvar'}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(modal);
  }

  window.patrSalvar = async function (ev) {
    ev.preventDefault();
    const f = ev.target;
    const body = {
      descricao:       f.descricao.value,
      categoria:       f.categoria.value || null,
      numero_serie:    f.numero_serie.value || null,
      contrato_id:     f.contrato_id.value ? parseInt(f.contrato_id.value) : null,
      contrato_ref:    f.contrato_ref.value || null,
      valor_aquisicao: parseFloat(f.valor_aquisicao.value),
      valor_residual:  parseFloat(f.valor_residual.value || 0),
      data_aquisicao:  f.data_aquisicao.value,
      vida_util_meses: parseInt(f.vida_util_meses.value),
      status:          f.status.value,
      data_baixa:      f.data_baixa.value || null,
      motivo_baixa:    f.motivo_baixa.value || null,
      observacoes:     f.observacoes.value || null,
    };

    try {
      const url = _editId ? `/patrimonio/${_editId}` : '/patrimonio';
      const m   = _editId ? 'PUT' : 'POST';
      const r = await api(url, { method: m, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(r.erro || 'Erro ao salvar');
      toast(_editId ? 'Ativo atualizado' : 'Ativo cadastrado', 'success');
      document.getElementById('patr-modal-form')?.remove();
      _editId = null;
      patrCarregar();
    } catch (e) {
      toast('Erro: ' + e.message, 'error');
    }
    return false;
  };

  // ── Modal: Baixa ────────────────────────────────────────────────────
  window.patrAbrirBaixa = function (id) {
    document.getElementById('patr-modal-detalhe')?.remove();
    document.getElementById('patr-modal-baixa')?.remove();

    const hoje = new Date().toISOString().slice(0, 10);
    const modal = document.createElement('div');
    modal.id = 'patr-modal-baixa';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:9200;display:flex;align-items:center;justify-content:center';
    modal.onclick = e => { if (e.target === modal) modal.remove(); };

    modal.innerHTML = `
      <div style="background:#fff;border-radius:12px;width:460px;max-width:94vw;padding:18px;box-shadow:0 20px 60px rgba(0,0,0,.3)">
        <div style="font-size:15px;font-weight:800;color:#991b1b;margin-bottom:12px">🗑️ Registrar Baixa</div>
        <form onsubmit="return patrConfirmarBaixa(event, ${id})" style="display:grid;gap:10px;font-size:12px">
          <label>Tipo
            <select name="status" style="width:100%;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px">
              <option value="baixado">Baixa (descarte)</option>
              <option value="alienado">Alienação (venda)</option>
            </select>
          </label>
          <label>Data da baixa
            <input name="data_baixa" type="date" value="${hoje}" required style="width:100%;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px">
          </label>
          <label>Motivo / observação
            <textarea name="motivo_baixa" rows="3" placeholder="ex.: descarte por desgaste, venda, perda, sinistro…" style="width:100%;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;resize:vertical"></textarea>
          </label>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button type="button" onclick="document.getElementById('patr-modal-baixa').remove()" style="background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;padding:6px 14px;border-radius:6px;cursor:pointer;font-weight:600">Cancelar</button>
            <button type="submit" style="background:#dc2626;color:#fff;border:none;padding:6px 16px;border-radius:6px;cursor:pointer;font-weight:700">🗑️ Confirmar Baixa</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(modal);
  };

  window.patrConfirmarBaixa = async function (ev, id) {
    ev.preventDefault();
    const f = ev.target;
    try {
      const r = await api(`/patrimonio/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          status:       f.status.value,
          data_baixa:   f.data_baixa.value,
          motivo_baixa: f.motivo_baixa.value || null,
        }),
      });
      if (!r.ok) throw new Error(r.erro || 'Erro');
      toast('Baixa registrada', 'success');
      document.getElementById('patr-modal-baixa')?.remove();
      patrCarregar();
    } catch (e) {
      toast('Erro: ' + e.message, 'error');
    }
    return false;
  };

  // ── Exportar CSV ────────────────────────────────────────────────────
  window.patrExportarCSV = function () {
    if (!_ativosCache.length) { toast('Nada para exportar', 'error'); return; }
    const cab = ['ID','Descrição','Categoria','Número Série','Contrato','Aquisição','Vida (m)','Vida Rest.','Valor Aq.','Valor Atual','Depr. Mês','% Depr.','Status'];
    const linhas = _ativosCache.map(a => [
      a.id, a.descricao, a.categoria || '', a.numero_serie || '',
      a.contrato_ref || (a.contrato_id ? '#' + a.contrato_id : ''),
      a.data_aquisicao || '', a.vida_util_meses, a.vida_util_restante_meses,
      num(a.valor_aquisicao).toFixed(2).replace('.', ','),
      num(a.valor_atual).toFixed(2).replace('.', ','),
      num(a.depreciacao_mensal).toFixed(2).replace('.', ','),
      (a.percentual_depreciado || 0).toFixed(1).replace('.', ',') + '%',
      a.status,
    ]);
    const csv = [cab, ...linhas].map(row =>
      row.map(c => `"${String(c).replace(/"/g,'""')}"`).join(';')
    ).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `patrimonio_${new Date().toISOString().slice(0,10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // ── Helpers ─────────────────────────────────────────────────────────
  function num(v) { return parseFloat(v) || 0; }
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escAttr(s) { return escHtml(s); }
})();
