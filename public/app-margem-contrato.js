/**
 * Montana — Margem Real por Contrato
 * Frontend: KPIs, tabela, gráfico de barras horizontais, ranking, histórico.
 */
(function () {
  'use strict';

  let _mcCompAtual = null;
  let _mcData     = null;
  let _mcRanking  = null;

  // ── Inicialização (chamada pelo navGo) ────────────────────────
  window.margemContratoInit = function () {
    const inp = document.getElementById('mc-comp');
    if (!inp) return;
    if (!inp.value) {
      const d = new Date();
      inp.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    }
    mcCarregar();
  };

  // ── Carrega resumo + ranking ──────────────────────────────────
  window.mcCarregar = async function () {
    const comp = document.getElementById('mc-comp').value;
    if (!comp) { toast('Selecione a competência', 'error'); return; }
    _mcCompAtual = comp;
    showLoading('Calculando margens…');
    try {
      const [d, r] = await Promise.all([
        api('/margem-contrato/resumo?competencia=' + comp),
        api('/margem-contrato/ranking?competencia=' + comp),
      ]);
      if (!d.ok) throw new Error(d.error || 'Erro ao carregar resumo');
      if (!r.ok) throw new Error(r.error || 'Erro ao carregar ranking');
      _mcData    = d;
      _mcRanking = r;

      mcRenderKpis(d.kpis);
      mcRenderTabela(d.contratos);
      mcRenderDiagnostico(d.diagnostico);
      mcRenderGrafico(d.contratos);
      mcRenderRanking(r);
      mcFecharDetalhe();
    } catch (e) {
      toast('Erro: ' + e.message, 'error');
    } finally {
      hideLoading();
    }
  };

  // ── KPI Cards ────────────────────────────────────────────────
  function mcRenderKpis(k) {
    const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    if (k.melhor_margem) {
      set('mc-k-melhor', (k.melhor_margem.margem_pct || 0).toFixed(1) + '%');
      set('mc-k-melhor-l', 'Melhor: ' + (k.melhor_margem.numContrato || '—').slice(0, 28));
    } else {
      set('mc-k-melhor', '—');
      set('mc-k-melhor-l', 'Melhor margem');
    }
    if (k.pior_margem) {
      set('mc-k-pior', (k.pior_margem.margem_pct || 0).toFixed(1) + '%');
      set('mc-k-pior-l', 'Pior: ' + (k.pior_margem.numContrato || '—').slice(0, 28));
    } else {
      set('mc-k-pior', '—');
      set('mc-k-pior-l', 'Pior margem');
    }
    set('mc-k-media', (k.media_margem_pct || 0).toFixed(1) + '%');
    set('mc-k-total', String(k.contratos_com_receita || 0) + ' / ' + String(k.total_contratos || 0));
  }

  // ── Diagnóstico de alocação ──────────────────────────────────
  function mcRenderDiagnostico(d) {
    const el = document.getElementById('mc-diagnostico');
    if (!el || !d) return;
    const naoAlocPct = d.despesas_total_mes > 0
      ? (d.despesas_nao_alocadas / d.despesas_total_mes * 100).toFixed(0) : 0;
    const folhaNaoPct = d.folha_total_mes > 0
      ? (d.folha_nao_alocada / d.folha_total_mes * 100).toFixed(0) : 0;
    el.innerHTML = `
      ℹ️ Despesas: ${brl(d.despesas_alocadas)} alocadas · ${brl(d.despesas_nao_alocadas)} não alocadas (${naoAlocPct}%) ·
      Folha: ${brl(d.folha_alocada)} alocada · ${brl(d.folha_nao_alocada)} interna (${folhaNaoPct}%, ${d.headcount_interno} func.)
    `;
  }

  // ── Tabela principal ─────────────────────────────────────────
  function mcRenderTabela(contratos) {
    const tbody = document.getElementById('mc-body');
    if (!contratos || !contratos.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:24px">Nenhum contrato com movimentação no período</td></tr>';
      return;
    }
    tbody.innerHTML = contratos.map(r => `
      <tr style="cursor:pointer" onclick="mcVerHistorico(${r.contrato_id}, '${escHtml(r.numContrato)}')"
          title="Clique para ver histórico de 6 meses">
        <td style="font-weight:700;font-size:11px;color:#0f172a;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${escHtml(r.numContrato)}
        </td>
        <td style="font-size:11px;color:#475569;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${escHtml(r.orgao || r.tomador || '—')}
        </td>
        <td class="r mono" style="font-weight:600">${brl(r.receita)}</td>
        <td class="r mono red">${brl(r.despesas_alocadas)}</td>
        <td class="r mono red">${brl(r.folha_alocada)}</td>
        <td class="r mono ${r.margem_bruta >= 0 ? 'green' : 'red'}" style="font-weight:700">${brl(r.margem_bruta)}</td>
        <td class="r mono" style="font-weight:700;color:${corMargem(r.margem_pct)}">${r.margem_pct.toFixed(1)}%</td>
        <td>${mcStatusBadge(r.status, r.status_emoji)}</td>
      </tr>
    `).join('');
  }

  function mcStatusBadge(status, emoji) {
    const map = {
      BOM:     { cor: '#dcfce7', txt: '#166534', label: '🟢 BOM' },
      ATENCAO: { cor: '#fef9c3', txt: '#854d0e', label: '🟡 ATENÇÃO' },
      CRITICO: { cor: '#fee2e2', txt: '#991b1b', label: '🔴 CRÍTICO' },
    };
    const s = map[status] || { cor: '#f1f5f9', txt: '#475569', label: emoji + ' ' + status };
    return `<span style="background:${s.cor};color:${s.txt};padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;white-space:nowrap">${s.label}</span>`;
  }

  function corMargem(pct) {
    if (pct >= 20) return '#15803d';
    if (pct >= 10) return '#d97706';
    return '#dc2626';
  }

  // ── Sub-tabs ─────────────────────────────────────────────────
  window.mcSubtab = function (tab) {
    document.querySelectorAll('.mc-subtab').forEach(b => {
      const active = b.dataset.tab === tab;
      b.style.borderBottomColor = active ? '#3b82f6' : 'transparent';
      b.style.color = active ? '#3b82f6' : '#64748b';
      b.classList.toggle('active', active);
    });
    document.getElementById('mc-tab-tabela').style.display  = tab === 'tabela'  ? '' : 'none';
    document.getElementById('mc-tab-grafico').style.display = tab === 'grafico' ? '' : 'none';
    document.getElementById('mc-tab-ranking').style.display = tab === 'ranking' ? '' : 'none';
  };

  // ── Gráfico de barras horizontais (HTML/CSS puro) ────────────
  function mcRenderGrafico(contratos) {
    const wrap = document.getElementById('mc-bars');
    if (!wrap) return;
    const comReceita = (contratos || []).filter(c => c.receita > 0);
    if (!comReceita.length) {
      wrap.innerHTML = '<div style="padding:24px;text-align:center;color:#94a3b8">Sem dados</div>';
      return;
    }
    // ordena por margem_pct desc
    const ord = [...comReceita].sort((a, b) => b.margem_pct - a.margem_pct);
    // escala 0-100% no eixo X (suporta margem negativa via âncora 0)
    const minPct = Math.min(0, ...ord.map(c => c.margem_pct));
    const maxPct = Math.max(40, ...ord.map(c => c.margem_pct));
    const span   = (maxPct - minPct) || 1;
    const zeroPct = ((0 - minPct) / span * 100);     // posição 0% no eixo
    const linha15 = ((15 - minPct) / span * 100);    // referência 15%

    const bars = ord.map(c => {
      const cor = corMargem(c.margem_pct);
      const pos = ((c.margem_pct - minPct) / span * 100);
      const inicio = Math.min(zeroPct, pos);
      const largura = Math.abs(pos - zeroPct);
      return `
        <div style="display:flex;align-items:center;gap:8px;font-size:11px">
          <div style="width:200px;flex-shrink:0;font-weight:600;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
               title="${escHtml(c.numContrato)}">
            ${escHtml(c.numContrato)}
          </div>
          <div style="flex:1;height:22px;background:#f1f5f9;border-radius:4px;position:relative">
            <!-- linha 0% -->
            <div style="position:absolute;left:${zeroPct}%;top:0;bottom:0;width:1px;background:#94a3b8"></div>
            <!-- linha de referência 15% -->
            <div style="position:absolute;left:${linha15}%;top:-2px;bottom:-2px;width:0;border-left:2px dashed #ef4444;opacity:.6"
                 title="margem mínima saudável: 15%"></div>
            <!-- barra -->
            <div style="position:absolute;left:${inicio}%;top:2px;bottom:2px;width:${largura}%;background:${cor};border-radius:3px;display:flex;align-items:center;justify-content:flex-end;padding-right:6px;color:#fff;font-weight:700;font-size:10px">
              ${largura > 6 ? c.margem_pct.toFixed(1) + '%' : ''}
            </div>
            ${largura <= 6 ? `<div style="position:absolute;left:${pos + 1}%;top:50%;transform:translateY(-50%);font-weight:700;font-size:10px;color:${cor}">${c.margem_pct.toFixed(1)}%</div>` : ''}
          </div>
          <div style="width:90px;text-align:right;font-family:monospace;font-size:10px;color:${c.margem_bruta >= 0 ? '#15803d' : '#dc2626'};font-weight:600">
            ${brl(c.margem_bruta)}
          </div>
        </div>
      `;
    }).join('');

    wrap.innerHTML = `
      <div style="font-size:10px;color:#94a3b8;margin-bottom:6px;display:flex;justify-content:space-between">
        <span>${minPct.toFixed(0)}%</span>
        <span style="color:#ef4444;font-weight:600">— — — referência 15% — — —</span>
        <span>${maxPct.toFixed(0)}%</span>
      </div>
      ${bars}
    `;
  }

  // ── Ranking ──────────────────────────────────────────────────
  function mcRenderRanking(r) {
    const fmt = (linha, idx) => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid #f1f5f9;${idx === 0 ? 'background:#f8fafc;border-radius:6px' : ''}">
        <div style="width:24px;height:24px;border-radius:50%;background:#1e293b;color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700">${idx + 1}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:700;color:#0f172a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(linha.numContrato)}</div>
          <div style="font-size:10px;color:#64748b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(linha.orgao || '—')}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:14px;font-weight:800;color:${corMargem(linha.margem_pct)}">${linha.margem_pct.toFixed(1)}%</div>
          <div style="font-size:10px;color:#64748b">${brl(linha.margem_bruta)}</div>
        </div>
      </div>
    `;
    const top = (r.mais_rentaveis || []).map((l, i) => fmt(l, i)).join('') ||
      '<div style="color:#94a3b8;padding:12px;text-align:center">Sem dados</div>';
    const bot = (r.menos_rentaveis || []).map((l, i) => fmt(l, i)).join('') ||
      '<div style="color:#94a3b8;padding:12px;text-align:center">Sem dados</div>';
    document.getElementById('mc-rank-top').innerHTML    = top;
    document.getElementById('mc-rank-bottom').innerHTML = bot;
  }

  // ── Histórico (modal) ────────────────────────────────────────
  window.mcVerHistorico = async function (contratoId, label) {
    showLoading('Carregando histórico…');
    try {
      const d = await api(`/margem-contrato/historico?contrato_id=${contratoId}&meses=6`);
      if (!d.ok) throw new Error(d.error || 'Erro');
      mcMostrarModalHistorico(label, d);
    } catch (e) {
      toast('Erro ao carregar histórico: ' + e.message, 'error');
    } finally {
      hideLoading();
    }
  };

  function mcMostrarModalHistorico(label, d) {
    const old = document.getElementById('mc-modal-hist');
    if (old) old.remove();
    const modal = document.createElement('div');
    modal.id = 'mc-modal-hist';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:9000;display:flex;align-items:center;justify-content:center';
    modal.onclick = e => { if (e.target === modal) modal.remove(); };

    const hist = d.historico || [];
    const maxRec = Math.max(...hist.map(h => h.receita), 1);
    const barras = hist.map(h => {
      const altRec  = (h.receita / maxRec * 100).toFixed(1);
      const altCust = ((h.despesas_alocadas + h.folha_alocada) / maxRec * 100).toFixed(1);
      return `
        <div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1;min-width:60px">
          <div style="font-size:10px;font-weight:700;color:${corMargem(h.margem_pct)}">${h.margem_pct.toFixed(1)}%</div>
          <div style="width:32px;background:#e2e8f0;border-radius:4px;height:140px;display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden;position:relative">
            <div style="width:100%;height:${altRec}%;background:#bfdbfe;position:absolute;bottom:0;left:0"></div>
            <div style="width:100%;height:${altCust}%;background:#fca5a5;position:absolute;bottom:0;left:0;opacity:.85"></div>
          </div>
          <div style="font-size:9px;color:#475569">${h.mes.slice(5)}/${h.mes.slice(2,4)}</div>
        </div>
      `;
    }).join('');

    const linhas = hist.map(h => `
      <tr>
        <td style="font-weight:600;color:#0f172a">${h.mes}</td>
        <td class="r mono">${brl(h.receita)}</td>
        <td class="r mono red">${brl(h.despesas_alocadas)}</td>
        <td class="r mono red">${brl(h.folha_alocada)}</td>
        <td class="r mono ${h.margem_bruta >= 0 ? 'green' : 'red'}" style="font-weight:700">${brl(h.margem_bruta)}</td>
        <td class="r" style="font-weight:700;color:${corMargem(h.margem_pct)}">${h.margem_pct.toFixed(1)}%</td>
        <td>${mcStatusBadge(h.status, '')}</td>
      </tr>
    `).join('');

    modal.innerHTML = `
      <div style="background:#fff;border-radius:12px;width:760px;max-height:88vh;overflow-y:auto;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.3)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <div>
            <div style="font-size:16px;font-weight:800;color:#0f172a">📈 Histórico de Margem — ${escHtml(label)}</div>
            <div style="font-size:11px;color:#64748b">${escHtml(d.contrato.orgao || '')} · últimos ${hist.length} meses</div>
          </div>
          <button onclick="document.getElementById('mc-modal-hist').remove()"
            style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:4px 12px;cursor:pointer;color:#64748b;font-size:12px">
            ✕ Fechar
          </button>
        </div>
        <div style="display:flex;align-items:flex-end;gap:8px;padding:12px 0;border-bottom:1px solid #e2e8f0;margin-bottom:14px">
          ${barras}
        </div>
        <div style="display:flex;gap:14px;margin-bottom:12px;font-size:10px;color:#475569">
          <span><span style="display:inline-block;width:10px;height:10px;background:#bfdbfe;border-radius:2px;margin-right:4px"></span>Receita</span>
          <span><span style="display:inline-block;width:10px;height:10px;background:#fca5a5;border-radius:2px;margin-right:4px"></span>Custos (despesas + folha)</span>
        </div>
        <div class="tw">
          <table>
            <thead>
              <tr style="font-size:11px">
                <th>Mês</th><th class="r">Receita</th><th class="r">Despesas</th>
                <th class="r">Folha</th><th class="r">Margem R$</th><th class="r">Margem %</th><th>Status</th>
              </tr>
            </thead>
            <tbody>${linhas}</tbody>
          </table>
        </div>
        <div style="margin-top:14px;text-align:right">
          <button onclick="mcAbrirDetalhe(${d.contrato.id});document.getElementById('mc-modal-hist').remove()"
            style="background:#3b82f6;color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:11px;font-weight:700;cursor:pointer">
            🔍 Ver detalhe da competência atual
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }

  // ── Detalhe inline (NFs + despesas + folha do mês) ───────────
  window.mcAbrirDetalhe = async function (contratoId) {
    if (!_mcCompAtual) return;
    const panel = document.getElementById('mc-detalhe-panel');
    const body  = document.getElementById('mc-detalhe-body');
    const title = document.getElementById('mc-detalhe-title');
    panel.style.display = 'block';
    body.innerHTML = '<div style="text-align:center;padding:16px;color:#94a3b8">Carregando…</div>';
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    try {
      const d = await api(`/margem-contrato/detalhe?contrato_id=${contratoId}&competencia=${_mcCompAtual}`);
      if (!d.ok) throw new Error(d.error || 'Erro');
      title.textContent = `🔍 ${d.contrato.numContrato} — ${_mcCompAtual}`;
      body.innerHTML = mcRenderDetalheHtml(d);
    } catch (e) {
      body.innerHTML = `<div style="color:#ef4444;padding:8px">Erro: ${escHtml(e.message)}</div>`;
    }
  };

  function mcRenderDetalheHtml(d) {
    const t = d.totais || {};
    const nfRows = (d.nfs || []).map(n => `
      <tr>
        <td class="mono muted" style="font-size:10px">${escHtml(n.numero || '')}</td>
        <td style="font-size:11px">${n.data_emissao || '—'}</td>
        <td style="font-size:11px;color:#475569;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(n.tomador || '')}</td>
        <td class="r mono">${brl(n.valor_bruto)}</td>
        <td class="r mono">${brl(n.retencao || 0)}</td>
        <td class="r mono" style="font-weight:600">${brl(n.valor_liquido || (n.valor_bruto - (n.retencao||0)))}</td>
        <td style="font-size:10px;color:#64748b">${n.data_pagamento || '—'}</td>
      </tr>
    `).join('');

    const catRows = (d.despesas_por_categoria || []).map(c => `
      <tr>
        <td style="font-size:11px;font-weight:600;color:#475569">${escHtml(c.categoria)}</td>
        <td class="r mono red">${brl(c.total)}</td>
      </tr>
    `).join('');

    const funcRows = (d.folha?.funcionarios || []).slice(0, 50).map(f => `
      <tr>
        <td class="muted" style="font-size:10px">${f.id}</td>
        <td style="font-size:11px">${escHtml(f.nome)}</td>
        <td class="r mono">${brl(f.valor)}</td>
      </tr>
    `).join('');

    return `
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
        <div class="kpi"><div class="kpi-l">Receita</div><div class="kpi-v green">${brl(t.receita)}</div></div>
        <div class="kpi"><div class="kpi-l">Despesas</div><div class="kpi-v red">${brl(t.despesas)}</div></div>
        <div class="kpi"><div class="kpi-l">Folha (${d.folha?.headcount || 0} func.)</div><div class="kpi-v red">${brl(t.folha)}</div></div>
        <div class="kpi"><div class="kpi-l">Margem (${(t.margem_pct||0).toFixed(1)}%)</div><div class="kpi-v" style="color:${corMargem(t.margem_pct||0)}">${brl(t.margem_bruta)}</div></div>
      </div>

      <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:14px">
        <div>
          <div style="font-size:11px;font-weight:700;color:#0f172a;margin-bottom:6px">📄 NFs emitidas (${d.nfs?.length || 0})</div>
          <div class="tw" style="max-height:240px;overflow-y:auto">
            <table>
              <thead><tr style="font-size:10px"><th>Nº</th><th>Emissão</th><th>Tomador</th><th class="r">Bruto</th><th class="r">Retenções</th><th class="r">Líquido</th><th>Pgto</th></tr></thead>
              <tbody>${nfRows || '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:10px">Nenhuma NF</td></tr>'}</tbody>
            </table>
          </div>
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;color:#0f172a;margin-bottom:6px">💸 Despesas por categoria</div>
          <div class="tw" style="max-height:240px;overflow-y:auto">
            <table>
              <thead><tr style="font-size:10px"><th>Categoria</th><th class="r">Total</th></tr></thead>
              <tbody>${catRows || '<tr><td colspan="2" style="text-align:center;color:#94a3b8;padding:10px">Nenhuma alocada</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </div>

      ${funcRows ? `
      <div style="margin-top:14px">
        <div style="font-size:11px;font-weight:700;color:#0f172a;margin-bottom:6px">👥 Folha do contrato (${d.folha?.headcount || 0} func.)</div>
        <div class="tw" style="max-height:200px;overflow-y:auto">
          <table>
            <thead><tr style="font-size:10px"><th>ID</th><th>Nome</th><th class="r">Bruto</th></tr></thead>
            <tbody>${funcRows}</tbody>
          </table>
        </div>
      </div>` : ''}
    `;
  }

  window.mcFecharDetalhe = function () {
    const p = document.getElementById('mc-detalhe-panel');
    if (p) p.style.display = 'none';
  };

  function escHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

})();
