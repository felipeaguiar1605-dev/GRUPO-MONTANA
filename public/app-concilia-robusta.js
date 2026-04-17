/**
 * Conciliação Robusta — painel "Extratos sem NF" (Sprint 3).
 * Requer: window.api(url, opts) (definida em app.js).
 */
(function(){
  'use strict';

  const fmt = v => (v||0).toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2});
  const esc = s => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  // ── Inicialização (chamada ao abrir a aba) ───────────────────
  window.crInit = async function() {
    const hoje = new Date();
    const mes = `${hoje.getFullYear()}-${String(hoje.getMonth()+1).padStart(2,'0')}`;
    const elMes = document.getElementById('cr-mes');
    if (elMes && !elMes.value) elMes.value = mes;
    await crLoadStatus();
    await crLoad();
  };

  // ── KPIs do topo ─────────────────────────────────────────────
  async function crLoadStatus() {
    try {
      const r = await api('/conciliacao-robusta/status');
      const k = document.getElementById('cr-kpis');
      if (!k || !r.ok) return;
      k.innerHTML = `
        <div class="kpi"><div class="kpi-label">Aliases ativos</div><div class="kpi-value">${r.aliases_ativos}</div></div>
        <div class="kpi"><div class="kpi-label">Extratos c/ pagador</div><div class="kpi-value">${r.extratos_com_pagador}</div></div>
        <div class="kpi"><div class="kpi-label">Extratos pendentes</div><div class="kpi-value">${r.extratos_pendentes}</div></div>
        <div class="kpi"><div class="kpi-label">Valor pendente</div><div class="kpi-value" style="font-size:14px">R$ ${fmt(r.extratos_pendentes_valor)}</div></div>
      `;
    } catch(e) { console.error('[cr] status:', e); }
  }

  // ── Carrega grupos por pagador ───────────────────────────────
  window.crLoad = async function() {
    const mes = (document.getElementById('cr-mes')||{}).value || '';
    const valorMin = (document.getElementById('cr-valor-min')||{}).value || '0';
    const pagador = (document.getElementById('cr-pagador-filtro')||{}).value || '';
    const box = document.getElementById('cr-grupos');
    if (!box) return;
    box.innerHTML = `<div class="muted" style="text-align:center;padding:20px">⏳ Carregando...</div>`;
    try {
      const qs = new URLSearchParams({ mes, valor_min: valorMin, pagador });
      const r = await api(`/conciliacao-robusta/extratos-sem-nf?${qs}`);
      await crLoadStatus();
      if (!r.ok) { box.innerHTML = `<div class="muted">Erro: ${esc(r.error)}</div>`; return; }
      crRenderGrupos(r.grupos);
      crPreencherFiltroPagador(r.grupos);
    } catch(e) {
      box.innerHTML = `<div class="muted">Erro: ${esc(e.message)}</div>`;
    }
  };

  function crPreencherFiltroPagador(grupos) {
    const sel = document.getElementById('cr-pagador-filtro');
    if (!sel) return;
    const atual = sel.value;
    const opts = ['<option value="">Todos pagadores</option>'];
    for (const g of grupos) {
      opts.push(`<option value="${esc(g.pagador)}">${esc(g.pagador)} (${g.extratos.length})</option>`);
    }
    sel.innerHTML = opts.join('');
    sel.value = atual;
  }

  function crRenderGrupos(grupos) {
    const box = document.getElementById('cr-grupos');
    if (!grupos || grupos.length === 0) {
      box.innerHTML = `<div class="muted" style="text-align:center;padding:40px;background:#f0fdf4;border-radius:10px;color:#15803d">✅ Nenhum extrato pendente nesse filtro</div>`;
      return;
    }
    const html = grupos.map((g, idx) => {
      const cor = g.pagador === '(não identificado)' ? '#f43f5e' : '#0ea5e9';
      const linhas = g.extratos.map(e => `
        <tr style="border-bottom:1px solid #f1f5f9">
          <td style="padding:6px 8px;font-size:11px;white-space:nowrap">${esc(e.data_iso)}</td>
          <td style="padding:6px 8px;font-size:11px;text-align:right;font-weight:700;color:#15803d">R$ ${fmt(e.credito)}</td>
          <td style="padding:6px 8px;font-size:10px;color:#475569;max-width:380px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.historico)}">${esc((e.historico||'').substring(0,90) || '(sem histórico)')}</td>
          <td style="padding:6px 8px;font-size:10px;color:#64748b">${esc(e.metodo || '—')}</td>
          <td style="padding:6px 8px;white-space:nowrap">
            <button onclick="crVerSugestoes(${e.id})" style="background:#0ea5e9;color:#fff;border:none;padding:3px 10px;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer">🔍 Sugestões</button>
            <button onclick="crMenuStatus(${e.id})" style="background:#f59e0b;color:#fff;border:none;padding:3px 10px;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;margin-left:3px">📌 Status</button>
          </td>
        </tr>
      `).join('');
      return `
        <details ${idx<2?'open':''} style="margin-bottom:10px;border:1px solid #e2e8f0;border-radius:8px;background:#fff">
          <summary style="padding:10px 14px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;background:linear-gradient(to right,${cor}10,#fff)">
            <div>
              <span style="font-weight:800;color:${cor}">${esc(g.pagador)}</span>
              <span style="font-size:11px;color:#64748b;margin-left:8px">${g.extratos.length} extratos</span>
            </div>
            <span style="font-weight:800;color:#15803d">R$ ${fmt(g.total)}</span>
          </summary>
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:11px">
              <thead style="background:#f8fafc">
                <tr>
                  <th style="padding:6px 8px;text-align:left">Data</th>
                  <th style="padding:6px 8px;text-align:right">Crédito</th>
                  <th style="padding:6px 8px;text-align:left">Histórico</th>
                  <th style="padding:6px 8px;text-align:left">Método</th>
                  <th style="padding:6px 8px"></th>
                </tr>
              </thead>
              <tbody>${linhas}</tbody>
            </table>
          </div>
        </details>
      `;
    }).join('');
    document.getElementById('cr-grupos').innerHTML = html;
  }

  // ── Modal de sugestões ──────────────────────────────────────
  window.crVerSugestoes = async function(extratoId) {
    const modal = document.getElementById('cr-modal-sug');
    const body  = document.getElementById('cr-modal-body');
    const tit   = document.getElementById('cr-modal-titulo');
    modal.style.display = 'flex';
    body.innerHTML = `<div class="muted" style="text-align:center;padding:20px">⏳ Buscando sugestões...</div>`;
    try {
      const r = await api(`/conciliacao-robusta/sugestoes?extrato_id=${extratoId}`);
      if (!r.ok) { body.innerHTML = `<div class="muted">Erro: ${esc(r.error)}</div>`; return; }
      const ext = r.extrato;
      tit.textContent = `Sugestões para extrato ${ext.data_iso} — R$ ${fmt(ext.credito)}`;
      const header = `
        <div style="background:#f8fafc;padding:10px 12px;border-radius:8px;margin-bottom:10px;border:1px solid #e2e8f0">
          <div style="font-size:12px;color:#475569;margin-bottom:4px"><b>Pagador:</b> ${esc(ext.pagador_identificado || '(não identificado)')} ${ext.pagador_cnpj?`<span style="color:#64748b">CNPJ ${esc(ext.pagador_cnpj)}</span>`:''}</div>
          <div style="font-size:10px;color:#64748b">Histórico: ${esc(ext.historico || '(vazio)')}</div>
          ${r.alias?`<div style="font-size:10px;color:#64748b;margin-top:3px">Janela: ${r.janela_dias} dias · Tolerância: ${(r.tolerancia_pct*100).toFixed(1)}%</div>`:''}
        </div>
      `;
      if (!r.sugestoes_individuais || r.sugestoes_individuais.length === 0) {
        body.innerHTML = header + `<div class="muted" style="text-align:center;padding:20px;color:#b91c1c">❌ Nenhuma NF candidata encontrada na janela.<br><span style="font-size:10px">Considere ampliar a janela no alias ou marcar este extrato como INTERNO/INVESTIMENTO.</span></div>` +
          crBotoesStatus(extratoId);
        return;
      }
      const tabela = r.sugestoes_individuais.map(n => `
        <tr style="border-bottom:1px solid #f1f5f9">
          <td style="padding:6px 8px"><input type="checkbox" class="cr-nf-check" value="${n.id}" data-val="${n.valor_liquido}"></td>
          <td style="padding:6px 8px;font-size:11px;font-weight:700">${esc(n.numero)}</td>
          <td style="padding:6px 8px;font-size:11px">${esc(n.tomador||'').substring(0,40)}</td>
          <td style="padding:6px 8px;font-size:11px;text-align:right;font-weight:700">R$ ${fmt(n.valor_liquido)}</td>
          <td style="padding:6px 8px;font-size:10px">${esc(n.data_emissao)}</td>
          <td style="padding:6px 8px;font-size:10px">${n.dias_atraso}d</td>
          <td style="padding:6px 8px;font-size:10px;color:${n.diff_pct<1?'#15803d':'#d97706'}">${n.diff_pct}%</td>
          <td style="padding:6px 8px;font-size:10px"><span style="background:#f1f5f9;border-radius:3px;padding:1px 5px">${n.score}</span></td>
          <td style="padding:6px 8px;font-size:10px;color:#64748b">${esc(n.razoes.join(', '))}</td>
        </tr>
      `).join('');
      body.innerHTML = header + `
        <table style="width:100%;border-collapse:collapse;font-size:11px">
          <thead style="background:#f1f5f9">
            <tr>
              <th style="padding:6px 8px"></th>
              <th style="padding:6px 8px;text-align:left">NF</th>
              <th style="padding:6px 8px;text-align:left">Tomador</th>
              <th style="padding:6px 8px;text-align:right">Valor líq.</th>
              <th style="padding:6px 8px;text-align:left">Emissão</th>
              <th style="padding:6px 8px;text-align:left">Atraso</th>
              <th style="padding:6px 8px;text-align:left">Dif %</th>
              <th style="padding:6px 8px;text-align:left">Score</th>
              <th style="padding:6px 8px;text-align:left">Sinais</th>
            </tr>
          </thead>
          <tbody>${tabela}</tbody>
        </table>
        <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <div id="cr-soma-sel" style="font-size:11px;color:#475569">Selecione 1 NF (match 1:1) ou várias (match em lote)</div>
          <button onclick="crVincularSelecionadas(${extratoId}, ${ext.credito})" style="background:#15803d;color:#fff;border:none;padding:8px 18px;border-radius:6px;font-weight:700;cursor:pointer">✅ Vincular selecionadas</button>
        </div>
        ${crBotoesStatus(extratoId)}
      `;
      // Ativa o cálculo de soma ao marcar
      body.querySelectorAll('.cr-nf-check').forEach(cb => {
        cb.addEventListener('change', () => {
          let soma = 0, n = 0;
          body.querySelectorAll('.cr-nf-check:checked').forEach(c => { soma += parseFloat(c.dataset.val); n++; });
          const cred = ext.credito;
          const diff = cred - soma;
          const pct = cred > 0 ? Math.abs(diff/cred)*100 : 0;
          document.getElementById('cr-soma-sel').innerHTML =
            `Selecionadas: <b>${n}</b> · Soma: <b>R$ ${fmt(soma)}</b> · ` +
            `Extrato: R$ ${fmt(cred)} · <span style="color:${pct<2?'#15803d':pct<5?'#d97706':'#b91c1c'};font-weight:700">Diff: R$ ${fmt(diff)} (${pct.toFixed(2)}%)</span>`;
        });
      });
    } catch(e) {
      body.innerHTML = `<div class="muted">Erro: ${esc(e.message)}</div>`;
    }
  };

  function crBotoesStatus(extratoId) {
    return `
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid #e2e8f0">
        <div style="font-size:11px;color:#64748b;margin-bottom:6px;font-weight:700">Ou marcar este extrato como:</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button onclick="crMarcarStatus(${extratoId},'INTERNO')" style="background:#e0f2fe;color:#075985;border:1px solid #7dd3fc;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:700;cursor:pointer">🔁 Interno</button>
          <button onclick="crMarcarStatus(${extratoId},'INVESTIMENTO')" style="background:#fef3c7;color:#92400e;border:1px solid #fcd34d;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:700;cursor:pointer">💰 Investimento</button>
          <button onclick="crMarcarStatus(${extratoId},'DEVOLVIDO')" style="background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:700;cursor:pointer">↩️ Devolvido</button>
          <button onclick="crMarcarStatus(${extratoId},'TRANSFERENCIA')" style="background:#e0e7ff;color:#3730a3;border:1px solid #a5b4fc;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:700;cursor:pointer">🔄 Transferência</button>
          <button onclick="crMarcarStatus(${extratoId},'IGNORAR')" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:700;cursor:pointer">🚫 Ignorar</button>
        </div>
      </div>
    `;
  }

  window.crMenuStatus = function(extratoId) {
    // Abre modal com apenas os botões de status
    const modal = document.getElementById('cr-modal-sug');
    const body  = document.getElementById('cr-modal-body');
    const tit   = document.getElementById('cr-modal-titulo');
    tit.textContent = `Marcar status do extrato #${extratoId}`;
    body.innerHTML = `<div style="padding:10px">Escolha o status para este extrato:</div>` + crBotoesStatus(extratoId);
    modal.style.display = 'flex';
  };

  window.crVincularSelecionadas = async function(extratoId, credito) {
    const checks = Array.from(document.querySelectorAll('.cr-nf-check:checked'));
    if (checks.length === 0) { alert('Selecione ao menos 1 NF'); return; }
    const nfIds = checks.map(c => parseInt(c.value));
    const soma = checks.reduce((s,c) => s + parseFloat(c.dataset.val), 0);
    const diffPct = Math.abs(credito - soma) / credito * 100;
    if (diffPct > 10 && !confirm(`Diferença de ${diffPct.toFixed(1)}% entre soma das NFs e crédito. Vincular mesmo assim?`)) return;
    try {
      const r = await api('/conciliacao-robusta/vincular', {
        method: 'POST',
        body: JSON.stringify({ extrato_id: extratoId, nf_ids: nfIds })
      });
      if (!r.ok) { alert('Erro: ' + (r.error||'desconhecido')); return; }
      toast(`✅ ${r.vinculadas} NF(s) vinculadas ao extrato`);
      crFecharModal();
      await crLoad();
    } catch(e) { alert('Erro: ' + e.message); }
  };

  window.crMarcarStatus = async function(extratoId, status) {
    try {
      const r = await api('/conciliacao-robusta/marcar-status', {
        method: 'POST',
        body: JSON.stringify({ extrato_id: extratoId, status })
      });
      if (!r.ok) { alert('Erro: ' + (r.error||'desconhecido')); return; }
      toast(`✅ Extrato marcado como ${status}`);
      crFecharModal();
      await crLoad();
    } catch(e) { alert('Erro: ' + e.message); }
  };

  window.crFecharModal = () => { document.getElementById('cr-modal-sug').style.display = 'none'; };
  window.crFecharModalAlias = () => { document.getElementById('cr-modal-alias').style.display = 'none'; };

  // ── Modal de Aliases ────────────────────────────────────────
  window.crAbrirAliases = async function() {
    const modal = document.getElementById('cr-modal-alias');
    const body  = document.getElementById('cr-alias-body');
    modal.style.display = 'flex';
    body.innerHTML = `<div class="muted" style="text-align:center;padding:20px">⏳ Carregando...</div>`;
    try {
      const r = await api('/conciliacao-robusta/pagador-aliases');
      if (!r.ok) { body.innerHTML = `<div class="muted">Erro</div>`; return; }
      const rows = r.aliases.map(a => `
        <tr style="border-bottom:1px solid #f1f5f9;${a.ativo?'':'opacity:0.5'}">
          <td style="padding:6px 8px;font-size:11px;font-weight:700">${esc(a.nome_canonico)}</td>
          <td style="padding:6px 8px;font-size:10px;font-family:monospace">${esc(a.cnpj||a.cnpj_raiz||'—')}</td>
          <td style="padding:6px 8px;font-size:10px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(a.padrao_historico)}">${esc(a.padrao_historico||'—')}</td>
          <td style="padding:6px 8px;font-size:10px">${esc(a.contrato_default||'—')}</td>
          <td style="padding:6px 8px;font-size:10px">${esc(a.empresa_dono||'ambas')}</td>
          <td style="padding:6px 8px;font-size:10px">${a.janela_dias}d</td>
          <td style="padding:6px 8px;font-size:10px">${(a.tolerancia_pct*100).toFixed(1)}%</td>
          <td style="padding:6px 8px;font-size:10px">${a.prioridade}</td>
          <td style="padding:6px 8px"><button onclick="crDeleteAlias(${a.id})" style="background:#fee2e2;color:#991b1b;border:none;padding:3px 8px;border-radius:4px;font-size:10px;cursor:pointer">🗑️</button></td>
        </tr>
      `).join('');
      body.innerHTML = `
        <div style="margin-bottom:10px;font-size:11px;color:#64748b">Total: <b>${r.aliases.length}</b> aliases cadastrados (soft-delete não remove — apenas desativa)</div>
        <div style="overflow-x:auto;max-height:60vh">
          <table style="width:100%;border-collapse:collapse;font-size:11px">
            <thead style="background:#f1f5f9;position:sticky;top:0">
              <tr>
                <th style="padding:6px 8px;text-align:left">Nome Canônico</th>
                <th style="padding:6px 8px;text-align:left">CNPJ</th>
                <th style="padding:6px 8px;text-align:left">Padrão histórico</th>
                <th style="padding:6px 8px;text-align:left">Contrato default</th>
                <th style="padding:6px 8px;text-align:left">Empresa</th>
                <th style="padding:6px 8px;text-align:left">Janela</th>
                <th style="padding:6px 8px;text-align:left">Tol.</th>
                <th style="padding:6px 8px;text-align:left">Prio.</th>
                <th style="padding:6px 8px"></th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid #e2e8f0">
          <h4 style="font-size:12px;font-weight:700;margin:0 0 6px 0">➕ Adicionar novo alias</h4>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;font-size:11px">
            <input id="cr-a-nome" placeholder="Nome canônico*" style="padding:5px 8px;border:1px solid #e2e8f0;border-radius:4px">
            <input id="cr-a-cnpj" placeholder="CNPJ (14 dígitos)" style="padding:5px 8px;border:1px solid #e2e8f0;border-radius:4px">
            <input id="cr-a-regex" placeholder="Regex do histórico" style="padding:5px 8px;border:1px solid #e2e8f0;border-radius:4px">
            <input id="cr-a-tomador" placeholder="Tomador LIKE (% PALMAS %)" style="padding:5px 8px;border:1px solid #e2e8f0;border-radius:4px">
            <input id="cr-a-contrato" placeholder="Contrato default" style="padding:5px 8px;border:1px solid #e2e8f0;border-radius:4px">
            <select id="cr-a-empresa" style="padding:5px 8px;border:1px solid #e2e8f0;border-radius:4px">
              <option value="">Ambas empresas</option>
              <option value="assessoria">Assessoria</option>
              <option value="seguranca">Segurança</option>
            </select>
            <input id="cr-a-janela" type="number" placeholder="Janela (dias)" value="90" style="padding:5px 8px;border:1px solid #e2e8f0;border-radius:4px">
            <input id="cr-a-tol" type="number" step="0.01" placeholder="Tolerância (0.05)" value="0.05" style="padding:5px 8px;border:1px solid #e2e8f0;border-radius:4px">
            <input id="cr-a-prio" type="number" placeholder="Prioridade" value="100" style="padding:5px 8px;border:1px solid #e2e8f0;border-radius:4px">
          </div>
          <button onclick="crAddAlias()" style="margin-top:6px;background:#059669;color:#fff;border:none;padding:6px 14px;border-radius:5px;font-weight:700;cursor:pointer">➕ Adicionar</button>
        </div>
      `;
    } catch(e) {
      body.innerHTML = `<div class="muted">Erro: ${esc(e.message)}</div>`;
    }
  };

  window.crAddAlias = async function() {
    const payload = {
      nome_canonico: document.getElementById('cr-a-nome').value.trim(),
      cnpj: document.getElementById('cr-a-cnpj').value.replace(/\D/g,''),
      padrao_historico: document.getElementById('cr-a-regex').value.trim(),
      tomador_match: document.getElementById('cr-a-tomador').value.trim(),
      contrato_default: document.getElementById('cr-a-contrato').value.trim(),
      empresa_dono: document.getElementById('cr-a-empresa').value,
      janela_dias: parseInt(document.getElementById('cr-a-janela').value) || 90,
      tolerancia_pct: parseFloat(document.getElementById('cr-a-tol').value) || 0.05,
      prioridade: parseInt(document.getElementById('cr-a-prio').value) || 100,
    };
    if (!payload.nome_canonico) { alert('Nome canônico é obrigatório'); return; }
    if (payload.cnpj) payload.cnpj_raiz = payload.cnpj.substring(0,8);
    try {
      const r = await api('/conciliacao-robusta/pagador-alias', { method:'POST', body: JSON.stringify(payload) });
      if (!r.ok) { alert('Erro: ' + (r.error||'desconhecido')); return; }
      toast('✅ Alias adicionado');
      crAbrirAliases();
    } catch(e) { alert('Erro: ' + e.message); }
  };

  window.crDeleteAlias = async function(id) {
    if (!confirm('Desativar este alias? (soft delete — pode ser reativado via banco)')) return;
    try {
      await api('/conciliacao-robusta/pagador-alias/' + id, { method: 'DELETE' });
      toast('✅ Alias desativado');
      crAbrirAliases();
    } catch(e) { alert('Erro: ' + e.message); }
  };

  // ── Ações sobre scripts ─────────────────────────────────────
  window.crReidentificar = async function() {
    if (!confirm('Re-executar identificação de pagador nos extratos pendentes? (pode levar ~30s)')) return;
    toast('⏳ Re-identificando...');
    try {
      const r = await api('/conciliacao-robusta/reidentificar', { method:'POST', body: JSON.stringify({}) });
      if (r.ok) { toast('✅ Re-identificação concluída'); await crLoad(); }
      else alert('Falhou: ' + (r.stderr || r.error));
    } catch(e) { alert('Erro: ' + e.message); }
  };

  window.crReconciliar = async function() {
    if (!confirm('Re-executar match NF↔extrato? (pode levar ~1min)')) return;
    toast('⏳ Reconciliando...');
    try {
      const r = await api('/conciliacao-robusta/reconciliar', { method:'POST', body: JSON.stringify({}) });
      if (r.ok) { toast('✅ Reconciliação concluída'); await crLoad(); }
      else alert('Falhou: ' + (r.stderr || r.error));
    } catch(e) { alert('Erro: ' + e.message); }
  };

  window.crReseedAliases = async function() {
    if (!confirm('Re-popular pagador_alias com dados canônicos do código? (upsert — não remove aliases manuais)')) return;
    toast('⏳ Re-seed...');
    try {
      const r = await api('/conciliacao-robusta/reseed-aliases', { method:'POST', body: JSON.stringify({}) });
      if (r.ok) { toast('✅ Re-seed concluído'); crAbrirAliases(); }
      else alert('Falhou: ' + (r.stderr || r.error));
    } catch(e) { alert('Erro: ' + e.message); }
  };

  // ── toast fallback ──────────────────────────────────────────
  if (typeof window.toast !== 'function') {
    window.toast = (msg) => {
      const el = document.getElementById('toast') || (() => { const d=document.createElement('div');d.id='toast';document.body.appendChild(d);return d; })();
      el.textContent = msg; el.style.display='block';
      setTimeout(()=> el.style.display='none', 3000);
    };
  }
})();
