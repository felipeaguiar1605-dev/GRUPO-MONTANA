/**
 * Montana ERP — Contas a Pagar (Frontend)
 * Criado: 2026-05-05
 * Atualizado: 2026-05-05 — adicionado botão "Marcar como Pago"
 */

let _cpSituacao = 'todas';
let _cpPage = 1;

window.contasPagarInit = async function contasPagarInit() {
  _cpPage = 1;
  await _cpLoadResumo();
  await _cpLoadAging();
};

async function _cpLoadResumo() {
  const el = document.getElementById('cp-kpis');
  if (!el) return;
  el.innerHTML = '<div class="loading">Carregando…</div>';

  try {
    const d = await api('/contas-pagar/resumo');

    const brlFmt = (v) => {
      if (!v) return 'R$ 0,00';
      const s = Math.abs(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
      return 'R$ ' + s;
    };

    el.innerHTML = `
      <div class="kpi" style="border-left:4px solid #dc2626;cursor:pointer" onclick="_cpSituacao='vencidas';_cpPage=1;_cpLoadAging()">
        <div class="kpi-l">🔴 Vencidas</div>
        <div class="kpi-v red">${d.vencidas.count}</div>
        <div class="kpi-s">${brlFmt(d.vencidas.total)}</div>
      </div>
      <div class="kpi" style="border-left:4px solid #d97706;cursor:pointer" onclick="_cpSituacao='semana';_cpPage=1;_cpLoadAging()">
        <div class="kpi-l">🟡 Esta semana</div>
        <div class="kpi-v" style="color:#d97706">${d.semana.count}</div>
        <div class="kpi-s">${brlFmt(d.semana.total)}</div>
      </div>
      <div class="kpi" style="border-left:4px solid #f59e0b;cursor:pointer" onclick="_cpSituacao='trinta';_cpPage=1;_cpLoadAging()">
        <div class="kpi-l">🟠 30 dias</div>
        <div class="kpi-v" style="color:#f59e0b">${d.trinta_dias.count}</div>
        <div class="kpi-s">${brlFmt(d.trinta_dias.total)}</div>
      </div>
      <div class="kpi" style="border-left:4px solid #1d4ed8;cursor:pointer" onclick="_cpSituacao='todas';_cpPage=1;_cpLoadAging()">
        <div class="kpi-l">📋 Total Pendente</div>
        <div class="kpi-v blue">${d.total_pendente.count}</div>
        <div class="kpi-s">${brlFmt(d.total_pendente.total)}</div>
      </div>`;
  } catch(e) {
    el.innerHTML = `<div style="color:#dc2626;font-size:11px">Erro: ${e.message}</div>`;
  }
}

async function _cpLoadAging() {
  const tbody = document.getElementById('cp-body');
  const pager = document.getElementById('cp-pag');
  const filtros = document.querySelectorAll('[data-cp-filtro]');
  if (!tbody) return;

  // Atualiza filtro visual
  filtros.forEach(b => {
    const ativo = b.dataset.cpFiltro === _cpSituacao;
    b.style.background    = ativo ? '#eff6ff' : '#fff';
    b.style.color         = ativo ? '#1d4ed8' : '#64748b';
    b.style.borderColor   = ativo ? '#1d4ed8' : '#e2e8f0';
    b.style.fontWeight    = ativo ? '700' : '400';
  });

  tbody.innerHTML = '<tr><td colspan="8" style="padding:20px;text-align:center;color:#94a3b8">Carregando…</td></tr>';

  const qs = _cpSituacao !== 'todas' ? `&situacao=${_cpSituacao}` : '';
  try {
    const d = await api(`/contas-pagar/aging?page=${_cpPage}&limit=50${qs}`);
    const rows = d.data || [];

    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="padding:20px;text-align:center;color:#94a3b8">Nenhuma despesa pendente</td></tr>';
      if (pager) pager.innerHTML = '';
      return;
    }

    const brlFmt = (v) => {
      if (!v) return '—';
      const s = Math.abs(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
      return (v >= 0 ? 'R$ ' : '−R$ ') + s;
    };

    const agingBadge = (dias) => {
      if (dias === null || dias === undefined) return '<span style="color:#94a3b8">—</span>';
      const d = parseInt(dias);
      if (d < 0) {
        // Futuro
        const future = Math.abs(d);
        const cor = future <= 7 ? '#d97706' : '#f59e0b';
        return `<span style="color:${cor};font-weight:700">Em ${future}d</span>`;
      }
      if (d === 0) return `<span style="color:#dc2626;font-weight:700">Hoje</span>`;
      const cor = d <= 7 ? '#dc2626' : d <= 30 ? '#b91c1c' : '#7f1d1d';
      return `<span style="color:${cor};font-weight:700">${d}d atrasado</span>`;
    };

    tbody.innerHTML = rows.map(r => `
      <tr id="cp-row-${r.id}">
        <td style="padding:5px 10px;font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.descricao||''}">${r.descricao||'—'}</td>
        <td style="padding:5px 10px;font-size:10px;color:#475569">${r.categoria||'—'}</td>
        <td style="padding:5px 10px;font-size:10px;color:#475569;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.fornecedor||'—'}</td>
        <td style="padding:5px 10px;font-size:10px;color:#64748b;white-space:nowrap">${r.data_iso||'—'}</td>
        <td style="padding:5px 10px;font-size:11px;text-align:right;font-family:monospace;color:#dc2626">${brlFmt(r.valor_bruto)}</td>
        <td style="padding:5px 10px;font-size:10px;text-align:center">${agingBadge(r.aging_dias)}</td>
        <td style="padding:5px 10px;font-size:10px;color:#64748b">${r.contrato_ref||r.centro_custo||'—'}</td>
        <td style="padding:5px 8px;text-align:center">
          <button onclick="_cpMarcarPago(${r.id})" title="Marcar como Pago"
            style="padding:3px 8px;font-size:9px;background:#dcfce7;color:#15803d;border:1px solid #86efac;border-radius:4px;cursor:pointer;font-weight:600;white-space:nowrap">
            ✓ Pago
          </button>
        </td>
      </tr>`).join('');

    // Paginação
    const pg = d.page ?? 1, pgs = d.pages ?? 1;
    if (pager) {
      pager.innerHTML = `
        <button ${pg<=1?'disabled':''} onclick="_cpPage--;_cpLoadAging()" style="padding:4px 10px;font-size:10px;border:1px solid #e2e8f0;border-radius:5px;background:#fff;cursor:pointer">← Anterior</button>
        <span style="font-size:10px;color:#64748b">Página ${pg} de ${pgs} (${d.total??0} registros)</span>
        <button ${pg>=pgs?'disabled':''} onclick="_cpPage++;_cpLoadAging()" style="padding:4px 10px;font-size:10px;border:1px solid #e2e8f0;border-radius:5px;background:#fff;cursor:pointer">Próxima →</button>`;
    }
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="8" style="padding:16px;color:#dc2626;font-size:11px">Erro: ${e.message}</td></tr>`;
  }
}

async function _cpMarcarPago(id) {
  const row = document.getElementById('cp-row-' + id);
  if (!row) return;

  // Animação visual imediata
  row.style.opacity = '0.4';
  row.style.transition = 'opacity 0.2s';

  try {
    await api('/despesas/' + id, { method: 'PATCH', body: JSON.stringify({ status: 'PAGO' }) });

    // Remove a linha com animação suave
    row.style.opacity = '0';
    setTimeout(() => {
      row.remove();
      // Atualiza KPIs após remover
      _cpLoadResumo();
      // Se tabela ficou vazia, mostra mensagem
      const tbody = document.getElementById('cp-body');
      if (tbody && tbody.querySelectorAll('tr[id^="cp-row-"]').length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="padding:20px;text-align:center;color:#94a3b8">Nenhuma despesa pendente</td></tr>';
      }
    }, 250);
  } catch(e) {
    row.style.opacity = '1';
    alert('Erro ao marcar como pago: ' + e.message);
  }
}
