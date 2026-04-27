// ════════════════════════════════════════════════════════════════════════════
// MAPA DE POSTOS CONCOMITANTES — últimos 5 anos
// Série mensal de quantos postos de serviço estavam ativos em cada mês,
// agregando todos os contratos de boletim da empresa atual.
// ════════════════════════════════════════════════════════════════════════════

(function () {
  const _orig = window.showTab;
  window.showTab = function (id, el) {
    if (typeof _orig === 'function') _orig(id, el);
    if (id === 'postos-mapa') loadPostosMapa();
  };
})();

let _pmData = null;

async function loadPostosMapa() {
  const cont = document.getElementById('pm-content');
  if (!cont) return;
  cont.innerHTML = `<div style="padding:40px;text-align:center;color:#94a3b8">Carregando série dos últimos 5 anos…</div>`;
  try {
    const d = await api('/postos-mapa');
    if (!d || d.error || !d.ok) {
      cont.innerHTML = `<div style="padding:30px;color:#dc2626">Erro: ${d?.error || 'falha ao carregar'}</div>`;
      return;
    }
    _pmData = d;
    renderPostosMapa(d);
  } catch (e) {
    cont.innerHTML = `<div style="padding:30px;color:#dc2626">Erro: ${e.message}</div>`;
  }
}

function pmFmtMes(ym) {
  const [a, m] = ym.split('-');
  const nomes = ['', 'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  return `${nomes[parseInt(m, 10)]}/${a.slice(2)}`;
}
function pmFmtMesLongo(ym) {
  if (!ym) return '—';
  const [a, m] = ym.split('-');
  const nomes = ['', 'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
                 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  return `${nomes[parseInt(m, 10)]} de ${a}`;
}

function renderPostosMapa(d) {
  const cont = document.getElementById('pm-content');

  const empresaNome = d.empresa?.nome || '—';
  const empresaCnpj = d.empresa?.cnpj || '';
  const k = d.kpis || {};
  const meses = d.meses || [];
  const contratos = d.contratos || [];

  const variacao = (k.atual || 0) - (k.inicio_serie || 0);
  const corVar = variacao > 0 ? '#16a34a' : variacao < 0 ? '#dc2626' : '#64748b';
  const sinalVar = variacao > 0 ? '+' : '';

  let html = `
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
        <div>
          <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Empresa</div>
          <div style="font-size:15px;font-weight:700;color:#0f172a">${empresaNome}</div>
          <div style="font-size:11px;color:#64748b">CNPJ ${empresaCnpj}</div>
        </div>
        <div style="font-size:11px;color:#64748b">
          Janela: <b>${pmFmtMesLongo(d.janela?.from)}</b> a <b>${pmFmtMesLongo(d.janela?.to)}</b>
          (${meses.length} meses)
        </div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:14px">
      <div class="kpi" style="border-left:4px solid #2563eb">
        <div class="kpi-l">Pico de postos</div>
        <div class="kpi-v" style="color:#1d4ed8">${k.pico || 0}</div>
        <div class="kpi-s">em ${pmFmtMesLongo(k.pico_mes)}</div>
      </div>
      <div class="kpi" style="border-left:4px solid #16a34a">
        <div class="kpi-l">Postos ativos hoje</div>
        <div class="kpi-v" style="color:#15803d">${k.atual || 0}</div>
        <div class="kpi-s">competência atual</div>
      </div>
      <div class="kpi" style="border-left:4px solid #d97706">
        <div class="kpi-l">Média mensal</div>
        <div class="kpi-v" style="color:#b45309">${(k.media_mensal || 0).toLocaleString('pt-BR')}</div>
        <div class="kpi-s">postos/mês no período</div>
      </div>
      <div class="kpi" style="border-left:4px solid ${corVar}">
        <div class="kpi-l">Variação 5 anos</div>
        <div class="kpi-v" style="color:${corVar}">${sinalVar}${variacao}</div>
        <div class="kpi-s">de ${k.inicio_serie || 0} → ${k.atual || 0}</div>
      </div>
      <div class="kpi" style="border-left:4px solid #6366f1">
        <div class="kpi-l">Contratos no período</div>
        <div class="kpi-v" style="color:#4338ca">${k.contratos_no_periodo || 0}</div>
        <div class="kpi-s">de ${k.contratos_cadastrados || 0} cadastrados</div>
      </div>
    </div>

    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div>
          <div style="font-size:14px;font-weight:700;color:#0f172a">📊 Postos concomitantes por mês</div>
          <div style="font-size:11px;color:#64748b">Cada barra = soma de postos ativos de todos os contratos no mês</div>
        </div>
        <div style="font-size:11px;color:#64748b">passe o cursor para detalhes</div>
      </div>
      ${renderBars(meses, k.pico || 1)}
    </div>

    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:14px">
      <div style="margin-bottom:10px">
        <div style="font-size:14px;font-weight:700;color:#0f172a">🗺️ Mapa de calor — contratos × meses</div>
        <div style="font-size:11px;color:#64748b">Linhas = contratos · colunas = meses · intensidade = qtd. de postos no mês</div>
      </div>
      ${renderHeatmap(meses, contratos, k.pico || 1)}
    </div>

    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px">
      <div style="margin-bottom:10px;font-size:14px;font-weight:700;color:#0f172a">📋 Contratos no período</div>
      ${renderTabela(contratos)}
    </div>
  `;

  cont.innerHTML = html;
}

function renderBars(meses, pico) {
  if (!meses.length) return `<div style="color:#94a3b8;padding:20px">Sem dados</div>`;
  const maxV = Math.max(pico, 1);
  let html = `<div style="display:flex;gap:2px;align-items:flex-end;height:200px;overflow-x:auto;padding-bottom:4px">`;
  for (const m of meses) {
    const h = Math.max(2, (m.total / maxV) * 180);
    const cor = m.total === 0 ? '#e2e8f0'
              : m.total >= pico * 0.85 ? '#1d4ed8'
              : m.total >= pico * 0.5  ? '#3b82f6'
              : '#93c5fd';
    const tip = `${pmFmtMesLongo(m.ym)}: ${m.total} posto(s)`;
    html += `<div title="${tip}" style="flex:0 0 14px;display:flex;flex-direction:column;align-items:center">
      <div style="font-size:9px;color:#64748b;margin-bottom:2px;height:11px">${m.total > 0 ? m.total : ''}</div>
      <div style="width:10px;height:${h}px;background:${cor};border-radius:2px 2px 0 0"></div>
    </div>`;
  }
  html += `</div>`;
  // Legenda de meses (apenas Jan e Jul de cada ano para não poluir)
  html += `<div style="display:flex;gap:2px;margin-top:6px;font-size:9px;color:#64748b">`;
  for (const m of meses) {
    const showLabel = m.mes === 1 || m.mes === 7;
    html += `<div style="flex:0 0 14px;text-align:center;${showLabel?'':'visibility:hidden'}">${pmFmtMes(m.ym)}</div>`;
  }
  html += `</div>`;
  return html;
}

function renderHeatmap(meses, contratos, pico) {
  const ativos = contratos.filter(c => c.meses_ativos > 0);
  if (!ativos.length) return `<div style="color:#94a3b8;padding:20px">Sem contratos com atividade no período</div>`;

  const cellByContrato = new Map();
  for (const c of ativos) cellByContrato.set(c.id, new Map());
  for (const m of meses) {
    for (const c of (m.contratos || [])) {
      const row = cellByContrato.get(c.id);
      if (row) row.set(m.ym, c.qtd_postos);
    }
  }

  // Escala de intensidade — usa qtd_postos do contrato como referência
  function corCell(qtd, qtdMax) {
    if (!qtd || qtd === 0) return '#f1f5f9';
    const r = Math.min(1, qtd / Math.max(qtdMax, 1));
    if (r >= 0.85) return '#1d4ed8';
    if (r >= 0.5)  return '#3b82f6';
    if (r >= 0.25) return '#60a5fa';
    return '#bfdbfe';
  }

  let html = `<div style="overflow-x:auto"><table style="border-collapse:collapse;font-size:10px">
    <thead><tr>
      <th style="position:sticky;left:0;background:#f8fafc;text-align:left;padding:4px 8px;border-bottom:1px solid #e2e8f0;min-width:240px">Contrato</th>
      <th style="text-align:center;padding:4px 6px;border-bottom:1px solid #e2e8f0">Postos</th>`;
  for (const m of meses) {
    const isJan = m.mes === 1;
    html += `<th style="padding:0;border-bottom:1px solid #e2e8f0;writing-mode:vertical-rl;transform:rotate(180deg);font-weight:${isJan?'700':'400'};color:${isJan?'#0f172a':'#94a3b8'};font-size:9px;height:46px">${pmFmtMes(m.ym)}</th>`;
  }
  html += `</tr></thead><tbody>`;

  for (const c of ativos) {
    html += `<tr>
      <td style="position:sticky;left:0;background:#fff;padding:4px 8px;border-bottom:1px solid #f1f5f9;font-weight:600;color:#0f172a">
        <div>${escapeHtml(c.nome)}</div>
        <div style="font-size:9px;color:#94a3b8;font-weight:400">${escapeHtml(c.contratante || '')}</div>
      </td>
      <td style="text-align:center;padding:4px 6px;border-bottom:1px solid #f1f5f9;font-weight:700;color:#1d4ed8">${c.qtd_postos}</td>`;
    const row = cellByContrato.get(c.id) || new Map();
    for (const m of meses) {
      const v = row.get(m.ym) || 0;
      const cor = corCell(v, c.qtd_postos);
      const tip = `${escapeHtml(c.nome)} — ${pmFmtMesLongo(m.ym)}: ${v} posto(s)`;
      html += `<td title="${tip}" style="padding:0;border-bottom:1px solid #f1f5f9"><div style="width:14px;height:18px;background:${cor}"></div></td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody></table></div>`;
  return html;
}

function renderTabela(contratos) {
  if (!contratos.length) return `<div style="color:#94a3b8;padding:14px">Nenhum contrato cadastrado</div>`;
  let html = `<div style="overflow-x:auto"><table class="tbl" style="font-size:12px">
    <thead><tr>
      <th>Contrato</th>
      <th>Contratante</th>
      <th>Nº</th>
      <th style="text-align:right">Postos</th>
      <th>Início</th>
      <th>Fim</th>
      <th style="text-align:right">Meses</th>
      <th style="text-align:right">Posto·Mês</th>
    </tr></thead><tbody>`;
  for (const c of contratos) {
    html += `<tr>
      <td style="font-weight:600">${escapeHtml(c.nome)}</td>
      <td style="color:#64748b">${escapeHtml(c.contratante || '—')}</td>
      <td style="color:#64748b;font-size:11px">${escapeHtml(c.numero_contrato || '—')}</td>
      <td style="text-align:right;font-weight:700">${c.qtd_postos}</td>
      <td>${c.inicio ? pmFmtMesLongo(c.inicio) : '—'}</td>
      <td>${c.fim ? pmFmtMesLongo(c.fim) : '—'}</td>
      <td style="text-align:right">${c.meses_ativos}</td>
      <td style="text-align:right;font-weight:700;color:#1d4ed8">${c.posto_meses}</td>
    </tr>`;
  }
  html += `</tbody></table></div>`;
  return html;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
