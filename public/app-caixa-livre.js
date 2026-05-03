/**
 * Montana ERP — Aba "Caixa Livre Consolidado"
 *
 * Visão por empresa: caixa real disponível separando obrigações operacionais
 * (folha + despesas) e impostos estimados das entradas brutas. Permite ver
 * cada empresa isoladamente OU o consolidado do grupo.
 *
 * Dependências globais: api(), brl()/fmtBRL(), navGo(), currentCompany.
 */
(function () {
  'use strict';

  const COMPANIES = ['assessoria', 'seguranca', 'portodovau', 'mustang'];
  const COMPANY_LABEL = {
    assessoria: '🏢 Montana Assessoria',
    seguranca:  '🔒 Montana Segurança',
    portodovau: '🛡️ Porto do Vau',
    mustang:    '🐎 Mustang',
  };

  // ── Helpers ────────────────────────────────────────────────────
  function brlFmt(v) {
    if (typeof brl === 'function') return brl(v);
    if (typeof fmtBRL === 'function') return fmtBRL(v);
    return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function pctFmt(v) {
    const n = Number(v || 0);
    return (n >= 0 ? '' : '') + n.toFixed(1) + '%';
  }
  function classMargem(margem) {
    if (margem >= 20) return 'cl-margem-bom';
    if (margem >= 10) return 'cl-margem-medio';
    return 'cl-margem-ruim';
  }
  function mesLabel(ym) {
    const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return ym || '';
    const [y, m] = ym.split('-');
    return `${meses[parseInt(m, 10) - 1]}/${y.slice(2)}`;
  }
  function semaforoBadge(sem, txt) {
    const map = {
      verde:    { bg: '#dcfce7', fg: '#166534', icone: '🟢' },
      amarelo:  { bg: '#fef3c7', fg: '#92400e', icone: '🟡' },
      vermelho: { bg: '#fee2e2', fg: '#991b1b', icone: '🔴' },
    };
    const s = map[sem] || map.amarelo;
    return `<span style="display:inline-flex;align-items:center;gap:6px;background:${s.bg};color:${s.fg};padding:6px 12px;border-radius:999px;font-size:12px;font-weight:700">${s.icone} ${txt || sem}</span>`;
  }

  // ── Estado ────────────────────────────────────────────────────
  let _empresa = '';   // '' = consolidado
  let _meses   = 6;
  let _params  = null; // alíquotas atuais

  // ── Init / refresh ─────────────────────────────────────────────
  async function caixaLivreInit() {
    const sel = document.getElementById('cl-empresa');
    const per = document.getElementById('cl-meses');
    if (sel && !sel.dataset.bound) {
      sel.dataset.bound = '1';
      sel.value = (typeof currentCompany === 'string' && currentCompany) || 'assessoria';
      sel.addEventListener('change', () => caixaLivreCarregar());
    }
    if (per && !per.dataset.bound) {
      per.dataset.bound = '1';
      per.value = '6';
      per.addEventListener('change', () => caixaLivreCarregar());
    }
    await caixaLivreCarregar();
  }

  async function caixaLivreCarregar() {
    _empresa = document.getElementById('cl-empresa')?.value || 'assessoria';
    _meses   = parseInt(document.getElementById('cl-meses')?.value || '6', 10) || 6;

    const body = document.getElementById('cl-body');
    if (!body) return;
    body.innerHTML = '<div class="loading" style="padding:30px;text-align:center;color:#94a3b8">Carregando caixa livre…</div>';

    try {
      if (_empresa === '__grupo__' || !_empresa) {
        await renderConsolidado(body);
      } else {
        await renderEmpresa(body, _empresa);
      }
    } catch (e) {
      body.innerHTML = `<div style="padding:20px;color:#b91c1c;background:#fee2e2;border-radius:8px">Erro ao carregar caixa livre: ${e.message}</div>`;
    }
  }

  // ── Render: empresa única ─────────────────────────────────────
  async function renderEmpresa(root, empresa) {
    const [mensal, posicao] = await Promise.all([
      api(`/caixa-livre/mensal?empresa=${empresa}&meses=${_meses}`),
      api(`/caixa-livre/posicao-atual?empresa=${empresa}`),
    ]);
    if (!mensal.ok) throw new Error(mensal.erro || 'Falha ao buscar série mensal');
    _params = mensal.parametros;

    const html = [
      renderPosicaoAtual(posicao),
      renderEvolucaoMensal(mensal.meses, mensal.totais, mensal.empresa_nome),
      renderBarrasMensais(mensal.meses),
    ].join('');
    root.innerHTML = html;
  }

  function renderPosicaoAtual(p) {
    if (!p || !p.ok) return '';
    const card = (titulo, valor, cor, sub) => `
      <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;flex:1;min-width:160px">
        <div style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.5px">${titulo}</div>
        <div style="font-size:20px;font-weight:800;color:${cor};margin-top:4px">${brlFmt(valor)}</div>
        ${sub ? `<div style="font-size:10px;color:#94a3b8;margin-top:2px">${sub}</div>` : ''}
      </div>`;

    const corLivre = p.caixa_livre_projetado >= 0 ? '#16a34a' : '#dc2626';

    return `
      <div style="background:linear-gradient(135deg,#f8fafc,#eff6ff);border:1px solid #dbeafe;border-radius:12px;padding:16px;margin-bottom:18px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
          <h3 style="margin:0;font-size:14px;color:#1e293b;font-weight:700">📊 Posição Atual — ${p.empresa_nome}</h3>
          <div style="display:flex;align-items:center;gap:10px">
            ${semaforoBadge(p.semaforo, `${p.dias_de_caixa} dias de caixa`)}
            <span style="font-size:10px;color:#64748b">snapshot ${p.hoje}</span>
          </div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${card('Saldo atual', p.saldo_atual, '#0f172a', p.saldo_ultima_data ? `até ${p.saldo_ultima_data}` : '')}
          ${card('Entradas projetadas (30d)', p.projecao_entradas, '#16a34a', `${p.projecao_contratos} contratos ativos`)}
          ${card('Compromissos (30d)', p.projecao_saidas, '#dc2626', 'média 3 meses')}
          ${card('Caixa Livre projetado', p.caixa_livre_projetado, corLivre, p.semaforo_texto)}
        </div>
        <div style="margin-top:10px;font-size:10px;color:#64748b;display:flex;gap:14px;flex-wrap:wrap">
          <span>Folha méd.: <b>${brlFmt(p.projecao_detalhe.media_folha)}</b></span>
          <span>Despesas méd.: <b>${brlFmt(p.projecao_detalhe.media_despesas)}</b></span>
          <span>Impostos est.: <b>${brlFmt(p.projecao_detalhe.media_impostos)}</b></span>
        </div>
      </div>`;
  }

  function renderEvolucaoMensal(meses, totais, empresaNome) {
    const linhas = meses.map(m => {
      const cls = classMargem(m.margem_pct);
      return `
        <tr class="${cls}">
          <td style="font-weight:600">${mesLabel(m.mes)}</td>
          <td class="r mono">${brlFmt(m.entradas)}</td>
          <td class="r mono" style="color:#7c2d12">${brlFmt(m.saidas_folha)}</td>
          <td class="r mono" style="color:#7c2d12">${brlFmt(m.saidas_despesas)}</td>
          <td class="r mono" style="color:#a16207">${brlFmt(m.impostos_estimados)}</td>
          <td class="r mono" style="color:#0f172a;font-weight:600">${brlFmt(m.caixa_operacional)}</td>
          <td class="r mono" style="font-weight:700">${brlFmt(m.caixa_livre)}</td>
          <td class="r mono">${pctFmt(m.margem_pct)}</td>
        </tr>`;
    }).join('');

    const totalLine = `
      <tr style="background:#0f172a;color:#fff;font-weight:700">
        <td>TOTAL ${_meses}m</td>
        <td class="r mono">${brlFmt(totais.entradas)}</td>
        <td class="r mono">${brlFmt(totais.saidas_folha)}</td>
        <td class="r mono">${brlFmt(totais.saidas_despesas)}</td>
        <td class="r mono">${brlFmt(totais.impostos_estimados)}</td>
        <td class="r mono">${brlFmt(totais.caixa_operacional)}</td>
        <td class="r mono">${brlFmt(totais.caixa_livre)}</td>
        <td class="r mono">${pctFmt(totais.margem_pct)}</td>
      </tr>`;

    return `
      <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:18px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px">
          <h3 style="margin:0;font-size:14px;color:#1e293b;font-weight:700">📅 Evolução Mensal — ${empresaNome}</h3>
          <button onclick="window.caixaLivreAbrirAliquotas()" style="font-size:11px;padding:6px 12px;background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer;font-weight:600">⚙️ Alíquotas</button>
        </div>
        <div class="tw">
          <table>
            <thead>
              <tr>
                <th>Mês</th>
                <th class="r">Entradas</th>
                <th class="r">Folha</th>
                <th class="r">Despesas</th>
                <th class="r">Impostos est.</th>
                <th class="r">Caixa Operac.</th>
                <th class="r">Caixa Livre</th>
                <th class="r">Margem</th>
              </tr>
            </thead>
            <tbody>${linhas}${totalLine}</tbody>
          </table>
        </div>
        <div style="margin-top:8px;font-size:10px;color:#64748b">
          Linhas: <span style="color:#16a34a;font-weight:600">verde</span> margem &gt;20% ·
          <span style="color:#a16207;font-weight:600">amarelo</span> 10–20% ·
          <span style="color:#dc2626;font-weight:600">vermelho</span> &lt;10%.
          Impostos heurísticos (Lucro Presumido) — ajustáveis via Alíquotas.
        </div>
      </div>`;
  }

  function renderBarrasMensais(meses) {
    if (!meses || !meses.length) return '';
    const linhas = meses.map(m => {
      const ent = Math.max(m.entradas, 1);
      const obrig = Math.max(0, m.saidas_folha + m.saidas_despesas);
      const imp   = Math.max(0, m.impostos_estimados);
      const livre = Math.max(0, m.caixa_livre);
      const totalSeg = obrig + imp + livre;
      const denom = Math.max(totalSeg, ent);
      const wObrig = (obrig / denom) * 100;
      const wImp   = (imp   / denom) * 100;
      const wLivre = (livre / denom) * 100;

      return `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
          <div style="width:60px;font-size:11px;color:#475569;font-weight:600">${mesLabel(m.mes)}</div>
          <div style="flex:1;background:#f1f5f9;border-radius:6px;height:22px;display:flex;overflow:hidden;border:1px solid #e2e8f0" title="Entradas: ${brlFmt(m.entradas)}">
            <div style="background:#ef4444;width:${wObrig}%" title="Folha+Despesas: ${brlFmt(obrig)}"></div>
            <div style="background:#f59e0b;width:${wImp}%"   title="Impostos: ${brlFmt(imp)}"></div>
            <div style="background:#22c55e;width:${wLivre}%" title="Caixa Livre: ${brlFmt(livre)}"></div>
          </div>
          <div style="width:120px;text-align:right;font-size:11px;color:#0f172a;font-weight:600;font-variant-numeric:tabular-nums">${brlFmt(m.entradas)}</div>
        </div>`;
    }).join('');

    return `
      <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:18px">
        <h3 style="margin:0 0 10px 0;font-size:14px;color:#1e293b;font-weight:700">📊 Composição das Entradas Mensais</h3>
        ${linhas}
        <div style="display:flex;gap:14px;margin-top:8px;font-size:11px">
          <span style="display:inline-flex;align-items:center;gap:6px"><span style="display:inline-block;width:12px;height:12px;background:#ef4444;border-radius:2px"></span>Folha + Despesas</span>
          <span style="display:inline-flex;align-items:center;gap:6px"><span style="display:inline-block;width:12px;height:12px;background:#f59e0b;border-radius:2px"></span>Impostos est.</span>
          <span style="display:inline-flex;align-items:center;gap:6px"><span style="display:inline-block;width:12px;height:12px;background:#22c55e;border-radius:2px"></span>Caixa Livre</span>
        </div>
      </div>`;
  }

  // ── Render: consolidado (todas as empresas + grupo) ───────────
  async function renderConsolidado(root) {
    const data = await api(`/caixa-livre/consolidado?meses=${_meses}`);
    if (!data.ok) throw new Error(data.erro || 'Falha ao buscar consolidado');

    if (!data.empresas.length) {
      root.innerHTML = '<div style="padding:30px;text-align:center;color:#94a3b8">Nenhuma empresa com movimentação no período.</div>';
      return;
    }

    const linhasEmp = data.empresas.map(e => {
      const cls = classMargem(e.totais.margem_pct);
      return `
        <tr class="${cls}">
          <td>
            <span style="display:inline-flex;align-items:center;gap:6px">
              <span style="width:10px;height:10px;border-radius:50%;background:${e.cor || '#64748b'}"></span>
              <b>${e.icone || ''} ${e.nome}</b>
            </span>
          </td>
          <td class="r mono">${brlFmt(e.totais.entradas)}</td>
          <td class="r mono" style="color:#7c2d12">${brlFmt(e.totais.saidas_folha + e.totais.saidas_despesas)}</td>
          <td class="r mono" style="color:#a16207">${brlFmt(e.totais.impostos_estimados)}</td>
          <td class="r mono" style="font-weight:700">${brlFmt(e.totais.caixa_livre)}</td>
          <td class="r mono">${pctFmt(e.totais.margem_pct)}</td>
          <td class="r mono" style="font-size:10px;color:#16a34a">${e.melhor_mes ? mesLabel(e.melhor_mes.mes) + ' · ' + brlFmt(e.melhor_mes.caixa_livre) : '—'}</td>
          <td class="r mono" style="font-size:10px;color:#dc2626">${e.pior_mes ? mesLabel(e.pior_mes.mes)  + ' · ' + brlFmt(e.pior_mes.caixa_livre)  : '—'}</td>
        </tr>`;
    }).join('');

    const g = data.grupo.totais;
    const linhaGrupo = `
      <tr style="background:#0f172a;color:#fff;font-weight:700">
        <td>🏛️ GRUPO MONTANA — TOTAL ${_meses}m</td>
        <td class="r mono">${brlFmt(g.entradas)}</td>
        <td class="r mono">${brlFmt(g.saidas_folha + g.saidas_despesas)}</td>
        <td class="r mono">${brlFmt(g.impostos_estimados)}</td>
        <td class="r mono">${brlFmt(g.caixa_livre)}</td>
        <td class="r mono">${pctFmt(g.margem_pct)}</td>
        <td class="r mono">—</td>
        <td class="r mono">—</td>
      </tr>`;

    // Barras consolidadas mês a mês
    const barras = renderBarrasMensais(data.grupo.meses);

    root.innerHTML = `
      <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:18px">
        <h3 style="margin:0 0 10px 0;font-size:14px;color:#1e293b;font-weight:700">🏛️ Consolidado do Grupo — Caixa Livre por Empresa</h3>
        <div class="tw">
          <table>
            <thead>
              <tr>
                <th>Empresa</th>
                <th class="r">Entradas</th>
                <th class="r">Folha+Despesas</th>
                <th class="r">Impostos est.</th>
                <th class="r">Caixa Livre</th>
                <th class="r">Margem</th>
                <th class="r">Melhor mês</th>
                <th class="r">Pior mês</th>
              </tr>
            </thead>
            <tbody>${linhasEmp}${linhaGrupo}</tbody>
          </table>
        </div>
        <div style="margin-top:8px;font-size:10px;color:#64748b">
          Cada empresa usa as alíquotas configuradas em <i>⚙️ Alíquotas</i>.
          Empresas sem entradas no período são omitidas.
        </div>
      </div>
      <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:18px">
        <h3 style="margin:0 0 10px 0;font-size:14px;color:#1e293b;font-weight:700">📊 Composição Mensal — Grupo Consolidado</h3>
        ${barras.replace(/<div style="background:#fff[^"]+"[^>]*>|<\/div>$|<h3[^>]*>[^<]*<\/h3>/g, '')}
      </div>`;
  }

  // ── Modal de alíquotas ────────────────────────────────────────
  async function caixaLivreAbrirAliquotas() {
    const empresa = document.getElementById('cl-empresa')?.value || 'assessoria';
    if (empresa === '__grupo__' || !empresa) {
      alert('Selecione uma empresa específica para configurar alíquotas.');
      return;
    }

    let resp;
    try { resp = await api(`/caixa-livre/parametros?empresa=${empresa}`); }
    catch (e) { alert('Erro ao carregar parâmetros: ' + e.message); return; }

    const p = resp.parametros || {};
    const d = resp.defaults   || {};

    const ov = document.createElement('div');
    ov.id = 'cl-modal-ov';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    ov.innerHTML = `
      <div style="background:#fff;border-radius:14px;width:100%;max-width:480px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.35)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <h3 style="margin:0;font-size:16px;color:#0f172a">⚙️ Alíquotas — ${COMPANY_LABEL[empresa] || empresa}</h3>
          <button onclick="document.getElementById('cl-modal-ov').remove()" style="background:none;border:none;font-size:18px;cursor:pointer;color:#64748b">✕</button>
        </div>
        <p style="margin:0 0 14px 0;font-size:12px;color:#64748b">
          Heurísticas de Lucro Presumido para o cálculo de impostos estimados sobre a receita bruta.
          Salvas por empresa.
        </p>
        ${campoAliq('pis_cofins_pct', 'PIS/COFINS', p.pis_cofins_pct, d.pis_cofins_pct)}
        ${campoAliq('csll_pct',       'CSLL',        p.csll_pct,       d.csll_pct)}
        ${campoAliq('irpj_pct',       'IRPJ',        p.irpj_pct,       d.irpj_pct)}
        ${campoAliq('iss_pct',        'ISS',         p.iss_pct,        d.iss_pct)}
        <div style="display:flex;gap:8px;margin-top:18px;justify-content:flex-end">
          <button onclick="document.getElementById('cl-modal-ov').remove()" style="padding:8px 14px;background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;border-radius:6px;cursor:pointer;font-size:12px">Cancelar</button>
          <button id="cl-aliq-salvar" style="padding:8px 16px;background:#3b82f6;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600">Salvar</button>
        </div>
      </div>`;
    document.body.appendChild(ov);

    document.getElementById('cl-aliq-salvar').addEventListener('click', async () => {
      const body = {
        empresa,
        pis_cofins_pct: parseFloat(document.getElementById('cl-aliq-pis_cofins_pct').value),
        csll_pct:       parseFloat(document.getElementById('cl-aliq-csll_pct').value),
        irpj_pct:       parseFloat(document.getElementById('cl-aliq-irpj_pct').value),
        iss_pct:        parseFloat(document.getElementById('cl-aliq-iss_pct').value),
      };
      try {
        const r = await api('/caixa-livre/parametros', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(r.erro || 'Falha ao salvar');
        document.getElementById('cl-modal-ov').remove();
        await caixaLivreCarregar();
      } catch (e) {
        alert('Erro ao salvar: ' + e.message);
      }
    });
  }

  function campoAliq(id, label, valor, def) {
    const v = (valor != null ? valor : def);
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px">
        <label for="cl-aliq-${id}" style="font-size:13px;color:#0f172a;font-weight:600;flex:1">${label}</label>
        <div style="display:flex;align-items:center;gap:6px">
          <input type="number" id="cl-aliq-${id}" step="0.01" min="0" max="100" value="${Number(v).toFixed(2)}"
                 style="width:90px;padding:6px 8px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;text-align:right;font-variant-numeric:tabular-nums">
          <span style="font-size:11px;color:#94a3b8">%</span>
          <span style="font-size:10px;color:#94a3b8;width:60px">def. ${Number(def || 0).toFixed(2)}</span>
        </div>
      </div>`;
  }

  // ── Exposição global ──────────────────────────────────────────
  window.caixaLivreInit          = caixaLivreInit;
  window.caixaLivreCarregar      = caixaLivreCarregar;
  window.caixaLivreAbrirAliquotas = caixaLivreAbrirAliquotas;
})();
