/**
 * Montana — Roadmap de Substituição do Omie (frontend)
 *
 * Depende de globais de app.js: getToken(), toast()
 * Endpoints: /api/roadmap/*
 *
 * Rota global (não envia X-Company).
 */
(function () {
  'use strict';

  const SECOES_META = {
    A: { nome: 'Onda 1 — Financeiro Operacional',   cor: '#f59e0b', icon: '🟡' },
    B: { nome: 'Onda 2 — Gestão e Análise',          cor: '#10b981', icon: '🟢' },
    C: { nome: 'Onda 3 — Corte do Omie',             cor: '#3b82f6', icon: '🔵' },
    D: { nome: 'Pré-requisitos / Dívida Técnica',    cor: '#dc2626', icon: '🔴' },
    E: { nome: 'Melhorias em Módulos Existentes',    cor: '#a855f7', icon: '🟣' },
    F: { nome: 'Gaps vs Omie',                       cor: '#64748b', icon: '⚪' },
  };

  const STATUS_META = {
    'pendente':     { label: 'Pendente',     bg: '#fee2e2', fg: '#991b1b' },
    'em-andamento': { label: 'Em andamento', bg: '#fef3c7', fg: '#92400e' },
    'em-review':    { label: 'Em review',    bg: '#dbeafe', fg: '#1e40af' },
    'concluido':    { label: 'Concluído',    bg: '#dcfce7', fg: '#166534' },
    'cancelado':    { label: 'Cancelado',    bg: '#e2e8f0', fg: '#475569' },
  };

  const PRIO_META = {
    'A': { bg: '#fef2f2', fg: '#b91c1c', label: 'A' },
    'B': { bg: '#fffbeb', fg: '#b45309', label: 'B' },
    'C': { bg: '#f0fdf4', fg: '#15803d', label: 'C' },
    '':  { bg: '#f1f5f9', fg: '#64748b', label: '—' },
  };

  // ── HTTP helper — sem X-Company (rota global) ─────────────────
  async function http(path, opts = {}) {
    const headers = {};
    const token = (typeof getToken === 'function') ? getToken() : null;
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (opts.body && !(opts.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    if (opts.headers) Object.assign(headers, opts.headers);
    const r = await fetch('/api/roadmap' + path, { ...opts, headers });
    const isJson = (r.headers.get('content-type') || '').includes('json');
    const data = isJson ? await r.json().catch(() => ({})) : await r.text();
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    return data;
  }

  function notify(msg, type) {
    if (typeof toast === 'function') return toast(msg, type);
    console.log('[roadmap]', msg);
  }

  const state = {
    secoes: {},
    stats: {},
    filtro: { secao: '', status: '', prioridade: '' },
  };

  // ── Render ────────────────────────────────────────────────────
  function renderKPIs() {
    const s = state.stats;
    const box = document.getElementById('rm-kpis');
    if (!box) return;
    box.innerHTML = `
      <div class="rm-kpi" style="background:#f1f5f9;border-left:4px solid #0f172a">
        <div class="rm-kpi-v">${s.total ?? 0}</div>
        <div class="rm-kpi-l">Total</div>
      </div>
      <div class="rm-kpi" style="background:#fee2e2;border-left:4px solid #dc2626">
        <div class="rm-kpi-v">${s.pendentes ?? 0}</div>
        <div class="rm-kpi-l">Pendentes</div>
      </div>
      <div class="rm-kpi" style="background:#fef3c7;border-left:4px solid #f59e0b">
        <div class="rm-kpi-v">${s.andamento ?? 0}</div>
        <div class="rm-kpi-l">Em andamento</div>
      </div>
      <div class="rm-kpi" style="background:#dbeafe;border-left:4px solid #3b82f6">
        <div class="rm-kpi-v">${s.review ?? 0}</div>
        <div class="rm-kpi-l">Em review</div>
      </div>
      <div class="rm-kpi" style="background:#dcfce7;border-left:4px solid #10b981">
        <div class="rm-kpi-v">${s.concluidos ?? 0}</div>
        <div class="rm-kpi-l">Concluídos</div>
      </div>
      <div class="rm-kpi" style="background:#f1f5f9;border-left:4px solid #64748b">
        <div class="rm-kpi-v">${(s.prio_a ?? 0) + '/' + (s.prio_b ?? 0) + '/' + (s.prio_c ?? 0)}</div>
        <div class="rm-kpi-l">Prio A/B/C</div>
      </div>
    `;
  }

  function matchFiltro(item) {
    if (state.filtro.secao      && item.secao      !== state.filtro.secao)      return false;
    if (state.filtro.status     && item.status     !== state.filtro.status)     return false;
    if (state.filtro.prioridade !== undefined && state.filtro.prioridade !== ''
        && item.prioridade !== state.filtro.prioridade) return false;
    return true;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[c]);
  }

  function renderTabela() {
    const box = document.getElementById('rm-secoes');
    if (!box) return;
    const secoesOrd = Object.keys(SECOES_META).filter(k => state.secoes[k]);
    if (!secoesOrd.length) {
      box.innerHTML = '<div style="padding:40px;text-align:center;color:#64748b">Nenhum item carregado.</div>';
      return;
    }

    let html = '';
    for (const sec of secoesOrd) {
      const meta = SECOES_META[sec];
      const itens = (state.secoes[sec] || []).filter(matchFiltro);
      const total = (state.secoes[sec] || []).length;
      const concl = (state.secoes[sec] || []).filter(i => i.status === 'concluido').length;

      html += `
        <div class="rm-secao" style="margin-bottom:18px;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;background:#fff">
          <div style="padding:10px 14px;background:${meta.cor}15;border-left:4px solid ${meta.cor};display:flex;align-items:center;gap:10px">
            <span style="font-size:18px">${meta.icon}</span>
            <div style="flex:1">
              <div style="font-weight:800;color:#0f172a;font-size:13px">Seção ${sec} — ${meta.nome}</div>
              <div style="font-size:11px;color:#64748b">${concl}/${total} concluído${total !== 1 ? 's' : ''} · exibindo ${itens.length}</div>
            </div>
          </div>
          ${itens.length ? renderLinhas(itens) : '<div style="padding:20px;text-align:center;color:#94a3b8;font-size:12px">Nenhum item corresponde aos filtros.</div>'}
        </div>
      `;
    }
    box.innerHTML = html;
  }

  function renderLinhas(itens) {
    let rows = '';
    for (const it of itens) {
      const prio = PRIO_META[it.prioridade || ''] || PRIO_META[''];
      const stat = STATUS_META[it.status] || STATUS_META['pendente'];
      rows += `
        <tr data-id="${it.id}">
          <td style="font-weight:700;color:#475569;white-space:nowrap">${escapeHtml(it.codigo)}</td>
          <td>
            <div style="font-weight:700;color:#0f172a">${escapeHtml(it.titulo)}</div>
            <div style="font-size:11px;color:#64748b;margin-top:2px">${escapeHtml(it.descricao)}</div>
          </td>
          <td>
            <select onchange="rmUpd(${it.id},'prioridade',this.value)"
                    style="padding:4px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:11px;font-weight:700;background:${prio.bg};color:${prio.fg}">
              <option value=""  ${it.prioridade === ''  ? 'selected' : ''}>—</option>
              <option value="A" ${it.prioridade === 'A' ? 'selected' : ''}>A</option>
              <option value="B" ${it.prioridade === 'B' ? 'selected' : ''}>B</option>
              <option value="C" ${it.prioridade === 'C' ? 'selected' : ''}>C</option>
            </select>
          </td>
          <td>
            <input type="number" min="1" value="${it.ordem ?? ''}"
                   onblur="rmUpd(${it.id},'ordem',this.value)"
                   style="width:56px;padding:4px 6px;border:1px solid #cbd5e1;border-radius:6px;font-size:11px;text-align:center">
          </td>
          <td>
            <select onchange="rmUpd(${it.id},'status',this.value)"
                    style="padding:4px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:11px;font-weight:700;background:${stat.bg};color:${stat.fg}">
              ${Object.entries(STATUS_META).map(([k, m]) =>
                `<option value="${k}" ${it.status === k ? 'selected' : ''}>${m.label}</option>`
              ).join('')}
            </select>
          </td>
          <td>
            <input type="text" value="${escapeHtml(it.responsavel || '')}"
                   onblur="rmUpd(${it.id},'responsavel',this.value)" placeholder="—"
                   style="width:100px;padding:4px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:11px">
          </td>
          <td>
            <input type="text" value="${escapeHtml(it.observacoes || '')}"
                   onblur="rmUpd(${it.id},'observacoes',this.value)" placeholder="—"
                   style="width:100%;min-width:140px;padding:4px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:11px">
          </td>
        </tr>
      `;
    }
    return `
      <div style="overflow-x:auto">
        <table class="rm-table" style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0">
              <th style="text-align:left;padding:8px 10px;font-size:10px;text-transform:uppercase;color:#64748b;font-weight:700">ID</th>
              <th style="text-align:left;padding:8px 10px;font-size:10px;text-transform:uppercase;color:#64748b;font-weight:700">Item</th>
              <th style="text-align:left;padding:8px 10px;font-size:10px;text-transform:uppercase;color:#64748b;font-weight:700">Prio</th>
              <th style="text-align:left;padding:8px 10px;font-size:10px;text-transform:uppercase;color:#64748b;font-weight:700">Ordem</th>
              <th style="text-align:left;padding:8px 10px;font-size:10px;text-transform:uppercase;color:#64748b;font-weight:700">Status</th>
              <th style="text-align:left;padding:8px 10px;font-size:10px;text-transform:uppercase;color:#64748b;font-weight:700">Resp.</th>
              <th style="text-align:left;padding:8px 10px;font-size:10px;text-transform:uppercase;color:#64748b;font-weight:700">Obs.</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  // ── Ações ──────────────────────────────────────────────────────
  async function carregar() {
    try {
      const r = await http('/');
      state.secoes = r.secoes || {};
      state.stats  = r.stats  || {};
      renderKPIs();
      renderTabela();
    } catch (err) {
      notify('Erro ao carregar roadmap: ' + err.message, 'error');
    }
  }

  window.rmInit = carregar;

  window.rmUpd = async function (id, campo, valor) {
    try {
      const body = {};
      body[campo] = valor;
      const r = await http('/' + id, { method: 'PATCH', body: JSON.stringify(body) });
      // Atualiza item no state sem recarregar tudo
      for (const sec of Object.keys(state.secoes)) {
        const idx = state.secoes[sec].findIndex(i => i.id === id);
        if (idx >= 0) { state.secoes[sec][idx] = r.item; break; }
      }
      // Recarrega stats rapidamente
      const fresh = await http('/');
      state.stats = fresh.stats || {};
      renderKPIs();
      renderTabela();
      notify('✓ Salvo', 'success');
    } catch (err) {
      notify('Erro: ' + err.message, 'error');
    }
  };

  window.rmFiltrar = function (campo, valor) {
    state.filtro[campo] = valor;
    renderTabela();
  };

  window.rmLimparFiltros = function () {
    state.filtro = { secao: '', status: '', prioridade: '' };
    document.getElementById('rm-f-secao').value = '';
    document.getElementById('rm-f-status').value = '';
    document.getElementById('rm-f-prio').value = '';
    renderTabela();
  };

  window.rmExportar = function () {
    const linhas = [['Seção', 'Código', 'Título', 'Prioridade', 'Ordem', 'Status', 'Responsável', 'Observações']];
    for (const sec of Object.keys(state.secoes)) {
      for (const it of state.secoes[sec]) {
        linhas.push([sec, it.codigo, it.titulo, it.prioridade || '', it.ordem ?? '', it.status, it.responsavel || '', it.observacoes || '']);
      }
    }
    const csv = linhas.map(l => l.map(c => {
      const s = String(c).replace(/"/g, '""');
      return /[",\n;]/.test(s) ? `"${s}"` : s;
    }).join(';')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `roadmap-omie-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };
})();
