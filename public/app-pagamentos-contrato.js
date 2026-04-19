/**
 * Montana — Painel de Pagamentos por Contrato
 * Frontend para monitoramento de inadimplência e status de pagamento.
 */
(function () {
  'use strict';

  let _pgtoMesAtual = null;
  let _pgtoData = null;   // última resposta do /resumo
  let _pgtoInadimData = null;

  // ── Inicialização (chamada pelo showTab) ─────────────────────────
  window.painelPgtoInit = function () {
    const inputMes = document.getElementById('pgto-mes');
    if (!inputMes) return;
    if (!inputMes.value) {
      const hoje = new Date();
      inputMes.value = hoje.getFullYear() + '-' +
        String(hoje.getMonth() + 1).padStart(2, '0');
    }
    pgtoCarregar();
  };

  // ── Carrega resumo do mês ────────────────────────────────────────
  window.pgtoCarregar = async function () {
    const mes = document.getElementById('pgto-mes').value;
    if (!mes) { toast('Selecione a competência', 'error'); return; }
    _pgtoMesAtual = mes;
    _pgtoInadimData = null; // invalida cache inadimplentes
    showLoading('Carregando painel de pagamentos…');
    try {
      const d = await api('/pagamentos-contrato/resumo?mes=' + mes);
      if (!d.ok) throw new Error(d.error || 'Erro ao carregar');
      _pgtoData = d;
      pgtoRenderKpis(d.kpis);
      pgtoRenderTabela(d.tomadores);
      pgtoFecharDetalhe();

      // Mantém a aba ativa visível
      const subAtiva = document.querySelector('.pgto-subtab.active');
      if (subAtiva && subAtiva.dataset.tab === 'inadimplentes') {
        pgtoCarregarInadimplentes();
      }
    } catch (e) {
      toast('Erro: ' + e.message, 'error');
    } finally {
      hideLoading();
    }
  };

  // ── KPI Cards ────────────────────────────────────────────────────
  function pgtoRenderKpis(k) {
    const s = v => document.getElementById(v);
    s('pgto-k-faturado').textContent = brl(k.total_faturado);
    s('pgto-k-recebido').textContent = brl(k.total_recebido);
    s('pgto-k-aberto').textContent   = brl(k.total_em_aberto);
    s('pgto-k-inadim').textContent   = k.inadimplentes;
  }

  // ── Tabela principal por tomador ─────────────────────────────────
  function pgtoRenderTabela(tomadores) {
    const tbody = document.getElementById('pgto-body');
    if (!tomadores || !tomadores.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:24px">Nenhuma NF encontrada para este mês</td></tr>';
      return;
    }
    tbody.innerHTML = tomadores.map(r => `
      <tr style="cursor:pointer" onclick="pgtoVerDetalhe('${escHtml(r.tomador)}')"
          title="Clique para ver detalhes">
        <td style="font-weight:600;font-size:12px;color:#0f172a;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${escHtml(r.tomador)}
        </td>
        <td class="r mono muted">${r.qtd_nfs}</td>
        <td class="r mono" style="font-weight:600">${brl(r.faturado)}</td>
        <td class="r mono green">${brl(r.recebido)}</td>
        <td class="r mono ${r.em_aberto > 0 ? 'red' : 'green'}" style="font-weight:600">
          ${r.em_aberto > 0 ? brl(r.em_aberto) : '—'}
        </td>
        <td class="r">
          <div style="display:flex;align-items:center;gap:4px;justify-content:flex-end">
            <div style="width:60px;height:6px;background:#e2e8f0;border-radius:3px;overflow:hidden">
              <div style="width:${Math.min(r.pct_recebido,100)}%;height:100%;background:${r.pct_recebido>=90?'#22c55e':r.pct_recebido>=30?'#f59e0b':'#ef4444'};border-radius:3px"></div>
            </div>
            <span style="font-size:10px;color:#475569">${r.pct_recebido}%</span>
          </div>
        </td>
        <td>${pgtoStatusBadge(r.status)}</td>
        <td>
          <button onclick="event.stopPropagation();pgtoVerHistorico('${escHtml(r.tomador)}')"
            style="font-size:10px;padding:2px 8px;border:1px solid #cbd5e1;border-radius:4px;background:#f8fafc;color:#475569;cursor:pointer">
            📈 Histórico
          </button>
        </td>
      </tr>
    `).join('');
  }

  function pgtoStatusBadge(status) {
    const map = {
      PAGO:    { cor: '#dcfce7', txt: '#166534', label: '✅ PAGO' },
      PARCIAL: { cor: '#fef9c3', txt: '#854d0e', label: '🟡 PARCIAL' },
      VENCIDO: { cor: '#fee2e2', txt: '#991b1b', label: '🔴 VENCIDO' },
      ABERTO:  { cor: '#f1f5f9', txt: '#475569', label: '⚪ ABERTO' },
      SEM_NF:  { cor: '#f8fafc', txt: '#94a3b8', label: '—' },
    };
    const s = map[status] || map.ABERTO;
    return `<span style="background:${s.cor};color:${s.txt};padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;white-space:nowrap">${s.label}</span>`;
  }

  // ── Sub-tabs ─────────────────────────────────────────────────────
  window.pgtoSubtab = function (tab) {
    document.querySelectorAll('.pgto-subtab').forEach(b => {
      const active = b.dataset.tab === tab;
      b.style.borderBottomColor = active ? '#3b82f6' : 'transparent';
      b.style.color = active ? '#3b82f6' : '#64748b';
      b.classList.toggle('active', active);
    });
    document.getElementById('pgto-tab-tomadores').style.display     = tab === 'tomadores'     ? '' : 'none';
    document.getElementById('pgto-tab-inadimplentes').style.display = tab === 'inadimplentes' ? '' : 'none';
    if (tab === 'inadimplentes') pgtoCarregarInadimplentes();
  };

  // ── Aba Inadimplentes ────────────────────────────────────────────
  async function pgtoCarregarInadimplentes() {
    if (_pgtoInadimData) { pgtoRenderInadimplentes(_pgtoInadimData); return; }
    const tbody = document.getElementById('pgto-inadim-body');
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:16px">Carregando…</td></tr>';
    try {
      const d = await api('/pagamentos-contrato/inadimplentes');
      if (!d.ok) throw new Error(d.error || 'Erro');
      _pgtoInadimData = d;
      pgtoRenderInadimplentes(d);
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#ef4444;padding:16px">Erro: ${escHtml(e.message)}</td></tr>`;
    }
  }

  function pgtoRenderInadimplentes(d) {
    const tbody = document.getElementById('pgto-inadim-body');
    if (!d.inadimplentes || !d.inadimplentes.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#22c55e;padding:24px;font-weight:600">✅ Nenhum tomador inadimplente nos últimos 90 dias</td></tr>';
      return;
    }
    tbody.innerHTML = d.inadimplentes.map(r => `
      <tr>
        <td style="font-weight:700;font-size:12px;color:#991b1b">${escHtml(r.tomador)}</td>
        <td class="r mono red" style="font-weight:700">${r.qtd_sem_pagamento}</td>
        <td class="r mono">${brl(r.faturado)}</td>
        <td class="r mono green">${brl(r.recebido)}</td>
        <td class="r mono red" style="font-weight:700">${brl(r.em_aberto)}</td>
        <td class="r">
          <span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700">
            ${r.dias_em_aberto}d
          </span>
        </td>
        <td style="font-size:11px;color:#64748b">${r.data_nf_mais_antiga || '—'}</td>
        <td>
          <button onclick="pgtoVerDetalhe('${escHtml(r.tomador)}')"
            style="font-size:10px;padding:2px 8px;border:1px solid #fca5a5;border-radius:4px;background:#fff1f2;color:#dc2626;cursor:pointer;font-weight:600">
            🔍 Detalhe
          </button>
        </td>
      </tr>
    `).join('');
  }

  // ── Detalhe NF × Pagamento ───────────────────────────────────────
  window.pgtoVerDetalhe = async function (tomador) {
    if (!_pgtoMesAtual) return;
    const panel = document.getElementById('pgto-detalhe-panel');
    const body  = document.getElementById('pgto-detalhe-body');
    const title = document.getElementById('pgto-detalhe-title');

    panel.style.display = 'block';
    title.textContent   = `🔍 Detalhe — ${tomador} — ${_pgtoMesAtual}`;
    body.innerHTML = '<div style="text-align:center;padding:16px;color:#94a3b8">Carregando…</div>';
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    try {
      const d = await api(`/pagamentos-contrato/detalhe?tomador=${encodeURIComponent(tomador)}&competencia=${_pgtoMesAtual}`);
      if (!d.ok) throw new Error(d.error || 'Erro');
      body.innerHTML = pgtoRenderDetalheHtml(d);
    } catch (e) {
      body.innerHTML = `<div style="color:#ef4444;padding:8px">Erro: ${escHtml(e.message)}</div>`;
    }
  };

  function pgtoRenderDetalheHtml(d) {
    const nfRows = (d.nfs || []).map(nf => `
      <tr>
        <td class="mono muted" style="font-size:10px">${escHtml(nf.numero || '')}</td>
        <td style="font-size:11px;color:#475569">${nf.data_emissao || '—'}</td>
        <td class="r mono" style="font-weight:600">${brl(nf.valor_bruto)}</td>
        <td class="r mono">${brl(nf.valor_liquido)}</td>
        <td class="r mono ${nf.pago > 0 ? 'green' : 'red'}">${brl(nf.pago)}</td>
        <td>${pgtoStatusBadge(nf.status)}</td>
        <td style="font-size:10px;color:#64748b">${nf.data_pagamento || '—'}</td>
        <td style="font-size:10px;color:#64748b;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            title="${escHtml(nf.historico_pgto || '')}">
          ${nf.historico_pgto ? escHtml(nf.historico_pgto.slice(0, 40)) + '…' : '—'}
        </td>
      </tr>
    `).join('');

    const livresRows = (d.creditos_nao_alocados || []).slice(0, 10).map(c => `
      <tr>
        <td style="font-size:11px;color:#475569">${c.data_iso || '—'}</td>
        <td class="r mono green" style="font-weight:600">${brl(c.credito)}</td>
        <td style="font-size:10px;color:#64748b;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            title="${escHtml(c.historico || '')}">
          ${escHtml((c.historico || '').slice(0, 60))}
        </td>
      </tr>
    `).join('');

    return `
      <div style="margin-bottom:12px">
        <div style="font-size:11px;font-weight:700;color:#0f172a;margin-bottom:8px">
          📄 Notas Fiscais (${d.nfs?.length || 0})
        </div>
        <div class="tw" style="max-height:280px;overflow-y:auto">
          <table>
            <thead>
              <tr style="font-size:10px">
                <th>Número</th><th>Emissão</th><th class="r">Bruto</th>
                <th class="r">Líquido</th><th class="r">Pago</th>
                <th>Status</th><th>Data Pgto</th><th>Histórico</th>
              </tr>
            </thead>
            <tbody>${nfRows || '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:12px">Nenhuma NF neste período</td></tr>'}</tbody>
          </table>
        </div>
      </div>
      ${d.creditos_nao_alocados?.length ? `
      <div>
        <div style="font-size:11px;font-weight:700;color:#0f172a;margin-bottom:8px">
          💳 Créditos encontrados não alocados a NFs (${d.creditos_nao_alocados.length})
        </div>
        <div class="tw" style="max-height:180px;overflow-y:auto">
          <table>
            <thead><tr style="font-size:10px"><th>Data</th><th class="r">Valor</th><th>Histórico</th></tr></thead>
            <tbody>${livresRows}</tbody>
          </table>
        </div>
      </div>` : ''}
    `;
  }

  window.pgtoFecharDetalhe = function () {
    document.getElementById('pgto-detalhe-panel').style.display = 'none';
  };

  // ── Modal de histórico mês a mês ─────────────────────────────────
  window.pgtoVerHistorico = async function (tomador) {
    showLoading('Carregando histórico…');
    try {
      const d = await api(`/pagamentos-contrato/historico?tomador=${encodeURIComponent(tomador)}&meses=6`);
      if (!d.ok) throw new Error(d.error || 'Erro');
      pgtoMostrarModalHistorico(tomador, d.historico);
    } catch (e) {
      toast('Erro ao carregar histórico: ' + e.message, 'error');
    } finally {
      hideLoading();
    }
  };

  function pgtoMostrarModalHistorico(tomador, historico) {
    const existente = document.getElementById('pgto-modal-hist');
    if (existente) existente.remove();

    const modal = document.createElement('div');
    modal.id = 'pgto-modal-hist';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:9000;display:flex;align-items:center;justify-content:center';
    modal.onclick = e => { if (e.target === modal) modal.remove(); };

    const maxFat = Math.max(...historico.map(h => h.faturado), 1);
    const barras = historico.map(h => {
      const pctFat = (h.faturado / maxFat * 100).toFixed(1);
      const pctRec = (h.recebido / maxFat * 100).toFixed(1);
      return `
        <div style="display:flex;flex-direction:column;align-items:center;gap:4px;flex:1;min-width:60px">
          <div style="font-size:9px;color:#64748b;font-weight:600">${brl(h.faturado)}</div>
          <div style="width:32px;background:#e2e8f0;border-radius:4px;height:120px;display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden;position:relative">
            <div style="width:100%;height:${pctFat}%;background:#bfdbfe;position:absolute;bottom:0;left:0;border-radius:4px"></div>
            <div style="width:100%;height:${pctRec}%;background:#22c55e;position:absolute;bottom:0;left:0;border-radius:4px"></div>
          </div>
          <div style="font-size:9px;color:#475569">${h.mes}</div>
          ${pgtoStatusBadge(h.status)}
        </div>
      `;
    }).join('');

    const linhas = historico.map(h => `
      <tr>
        <td style="font-weight:600;color:#0f172a">${h.mes}</td>
        <td class="r mono">${brl(h.faturado)}</td>
        <td class="r mono green">${brl(h.recebido)}</td>
        <td class="r mono ${h.em_aberto > 0 ? 'red' : ''}">${h.em_aberto > 0 ? brl(h.em_aberto) : '—'}</td>
        <td class="r muted">${h.qtd_nfs}</td>
        <td>${pgtoStatusBadge(h.status)}</td>
      </tr>
    `).join('');

    modal.innerHTML = `
      <div style="background:#fff;border-radius:12px;width:640px;max-height:85vh;overflow-y:auto;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.3)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <div>
            <div style="font-size:16px;font-weight:800;color:#0f172a">📈 Histórico — ${escHtml(tomador)}</div>
            <div style="font-size:11px;color:#64748b">Últimos 6 meses</div>
          </div>
          <button onclick="document.getElementById('pgto-modal-hist').remove()"
            style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:4px 12px;cursor:pointer;color:#64748b;font-size:12px">
            ✕ Fechar
          </button>
        </div>
        <!-- Gráfico de barras simples -->
        <div style="display:flex;align-items:flex-end;gap:8px;padding:12px 0;border-bottom:1px solid #e2e8f0;margin-bottom:14px">
          ${barras}
        </div>
        <div style="display:flex;gap:12px;margin-bottom:14px;font-size:10px;color:#475569">
          <span><span style="display:inline-block;width:10px;height:10px;background:#bfdbfe;border-radius:2px;margin-right:4px"></span>Faturado</span>
          <span><span style="display:inline-block;width:10px;height:10px;background:#22c55e;border-radius:2px;margin-right:4px"></span>Recebido</span>
        </div>
        <!-- Tabela -->
        <div class="tw">
          <table>
            <thead>
              <tr style="font-size:11px">
                <th>Mês</th><th class="r">Faturado</th><th class="r">Recebido</th>
                <th class="r">Em Aberto</th><th class="r">NFs</th><th>Status</th>
              </tr>
            </thead>
            <tbody>${linhas}</tbody>
          </table>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
  }

  // ── Utilitário HTML escape ───────────────────────────────────────
  function escHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

})();
