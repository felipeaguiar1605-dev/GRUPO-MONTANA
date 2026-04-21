/**
 * Montana — Comprovantes de Pagamento (frontend)
 *
 * Depende de (globais de app.js):
 *   - currentCompany, getToken(), brl(), toast()
 *
 * Endpoints usados: /api/comprovantes/*
 */

(function () {
  'use strict';

  // ── HTTP helper que usa a mesma auth do app.js ────────────────────
  async function http(path, opts = {}) {
    const headers = { 'X-Company': window.currentCompany || 'assessoria' };
    const token = (typeof getToken === 'function') ? getToken() : null;
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (!(opts.body instanceof FormData) && opts.body) {
      headers['Content-Type'] = 'application/json';
    }
    if (opts.headers) Object.assign(headers, opts.headers);
    const r = await fetch('/api/comprovantes' + path, { ...opts, headers });
    const isJson = (r.headers.get('content-type') || '').includes('json');
    const data = isJson ? await r.json().catch(() => ({})) : await r.text();
    if (!r.ok) throw new Error((data && data.error) || ('HTTP ' + r.status));
    return data;
  }

  function fmtBrl(v) {
    if (typeof brl === 'function') return brl(v);
    return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
  }
  function notify(msg, type) {
    if (typeof toast === 'function') return toast(msg, type);
    alert(msg);
  }

  function badgeStatus(s) {
    const map = {
      PENDENTE: ['#fee2e2', '#991b1b', 'Pendente'],
      PARCIAL:  ['#fef3c7', '#92400e', 'Parcial'],
      TOTAL:    ['#dcfce7', '#166534', 'Total'],
    };
    const [bg, fg, tx] = map[s] || ['#e2e8f0', '#334155', s || '-'];
    return `<span style="background:${bg};color:${fg};padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">${tx}</span>`;
  }

  function badgeDirecao(d) {
    return d === 'ENTRADA'
      ? '<span style="background:#dbeafe;color:#1e40af;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">↓ Entrada</span>'
      : '<span style="background:#fce7f3;color:#9f1239;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">↑ Saída</span>';
  }

  // ── Form toggle + submit ──────────────────────────────────────────
  window.compToggleForm = function () {
    const w = document.getElementById('comp-form-wrap');
    w.style.display = (w.style.display === 'none' || !w.style.display) ? 'block' : 'none';
    if (w.style.display === 'block') {
      const f = document.getElementById('comp-form');
      f.reset();
      // default data = hoje
      f.querySelector('[name=data_pagamento]').value = new Date().toISOString().slice(0, 10);
    }
  };

  window.compSalvar = async function (e) {
    e.preventDefault();
    const f = e.target;
    const fd = new FormData(f);
    try {
      const r = await http('/upload', { method: 'POST', body: fd });
      notify('Comprovante salvo (#' + r.id + ')', 'success');
      window.compToggleForm();
      compListar();
      // abre direto o modal para vincular
      setTimeout(() => compAbrirModal(r.id), 200);
    } catch (err) {
      notify('Erro: ' + err.message, 'error');
    }
    return false;
  };

  // ── Listagem ──────────────────────────────────────────────────────
  window.compListar = async function () {
    const status = document.getElementById('comp-filter-status').value;
    const direcao = document.getElementById('comp-filter-direcao').value;
    const q = document.getElementById('comp-filter-q').value.trim();
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    if (direcao) p.set('direcao', direcao);
    if (q) p.set('q', q);
    try {
      const { rows, total } = await http('/?' + p.toString());
      document.getElementById('comp-counter').textContent = `${rows.length} de ${total} comprovantes`;
      const body = document.getElementById('comp-body');
      if (!rows.length) {
        body.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#94a3b8;padding:20px">Nenhum comprovante cadastrado. Clique em <strong>+ Novo Comprovante</strong>.</td></tr>';
        return;
      }
      body.innerHTML = rows.map(r => `
        <tr>
          <td>${r.data_pagamento || ''}</td>
          <td><span style="font-family:monospace;background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:10px">${r.tipo}</span></td>
          <td>${badgeDirecao(r.direcao)}</td>
          <td title="${(r.cnpj_destinatario || '')}">${(r.nome_destinatario || '-')}${r.cnpj_destinatario ? '<div style="font-size:9px;color:#64748b">' + r.cnpj_destinatario + '</div>' : ''}</td>
          <td class="r mono">${fmtBrl(r.valor)}</td>
          <td class="r mono" style="color:${r.valor_vinculado >= r.valor - 0.01 ? '#166534' : r.valor_vinculado > 0 ? '#92400e' : '#991b1b'}">${fmtBrl(r.valor_vinculado)}</td>
          <td>${badgeStatus(r.status)}</td>
          <td style="font-size:10px;font-family:monospace">${r.numero_documento || '-'}</td>
          <td>${r.arquivo_path ? `<a href="/api/comprovantes/${r.id}/arquivo?_jwt=${encodeURIComponent((typeof getToken==='function' && getToken()) || '')}" target="_blank" style="color:#1d4ed8">📎</a>` : '-'}</td>
          <td><button onclick="compAbrirModal(${r.id})" style="background:#eef2ff;color:#3730a3;border:0;border-radius:4px;padding:3px 10px;font-size:10px;font-weight:700;cursor:pointer">Vincular</button></td>
        </tr>`).join('');
    } catch (err) {
      document.getElementById('comp-body').innerHTML = `<tr><td colspan="10" style="text-align:center;color:#991b1b;padding:20px">Erro: ${err.message}</td></tr>`;
    }
  };

  // ── Modal de detalhe + vínculos + sugestões ───────────────────────
  let _currentComp = null;

  window.compAbrirModal = async function (id) {
    try {
      const cp = await http('/' + id);
      _currentComp = cp;
      document.getElementById('comp-modal-title').textContent = `Comprovante #${cp.id} — ${cp.tipo} ${cp.direcao} — ${fmtBrl(cp.valor)}`;
      const body = document.getElementById('comp-modal-body');

      const saldoLivre = Number(cp.valor) - Number(cp.valor_vinculado || 0);
      body.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;font-size:11px;background:#f8fafc;padding:10px;border-radius:6px;margin-bottom:12px">
          <div><strong>Data:</strong><br>${cp.data_pagamento}</div>
          <div><strong>Valor:</strong><br>${fmtBrl(cp.valor)}</div>
          <div><strong>Vinculado:</strong><br>${fmtBrl(cp.valor_vinculado || 0)}</div>
          <div><strong>Saldo livre:</strong><br><span style="color:${saldoLivre > 0.01 ? '#166534' : '#64748b'};font-weight:700">${fmtBrl(saldoLivre)}</span></div>
          <div><strong>Pagador:</strong><br>${cp.banco_pagador || '-'} ${cp.conta_pagador || ''}<br><span style="font-size:10px;color:#64748b">${cp.cnpj_pagador || ''}</span></div>
          <div style="grid-column:span 2"><strong>Destinatário:</strong><br>${cp.nome_destinatario || '-'}<br><span style="font-size:10px;color:#64748b">${cp.cnpj_destinatario || ''}</span></div>
          <div><strong>Nº Doc:</strong><br>${cp.numero_documento || '-'}</div>
          ${cp.observacao ? `<div style="grid-column:span 4"><strong>Obs:</strong> ${cp.observacao}</div>` : ''}
        </div>

        <h4 style="margin:12px 0 6px;font-size:12px">Vínculos atuais (${(cp.vinculos || []).length})</h4>
        <div id="comp-vinc-list">
          ${(cp.vinculos || []).length === 0 ? '<div style="color:#94a3b8;font-size:11px">Nenhum vínculo ainda.</div>' :
            cp.vinculos.map(v => `
              <div style="display:flex;justify-content:space-between;align-items:center;background:#f1f5f9;padding:8px 10px;border-radius:6px;margin-bottom:4px;font-size:11px">
                <div>
                  <span style="background:#dbeafe;color:#1e40af;padding:1px 6px;border-radius:4px;font-size:10px;margin-right:6px">${v.tipo_destino}</span>
                  <strong>${fmtBrl(v.valor_vinculado)}</strong> — ${v.destino_label || v.destino_id}
                  ${v.observacao ? `<span style="color:#64748b"> · ${v.observacao}</span>` : ''}
                </div>
                <button onclick="compDesvincular(${v.id})" style="background:#fee2e2;color:#b91c1c;border:0;border-radius:4px;padding:3px 8px;font-size:10px;cursor:pointer">Remover</button>
              </div>`).join('')}
        </div>

        <h4 style="margin:14px 0 6px;font-size:12px">Sugestões automáticas (mesmo CNPJ + valor próximo)</h4>
        <div id="comp-sugestoes" style="font-size:11px;color:#94a3b8">Buscando...</div>

        <h4 style="margin:14px 0 6px;font-size:12px">Vincular manualmente</h4>
        <div style="display:grid;grid-template-columns:140px 1fr 160px 160px 90px;gap:8px;font-size:11px;align-items:end">
          <label>Tipo destino
            <select id="comp-vinc-tipo" style="width:100%">
              <option value="NF">NF (nota fiscal)</option>
              <option value="DESPESA">Despesa</option>
              <option value="CONTRATO_CREDITO">Crédito em Contrato</option>
              <option value="EXTRATO">Extrato bancário</option>
            </select>
          </label>
          <label>ID / número<input id="comp-vinc-id" placeholder="ID ou numContrato"></label>
          <label>Valor a vincular<input id="comp-vinc-valor" type="number" step="0.01" min="0.01" value="${saldoLivre > 0 ? saldoLivre.toFixed(2) : ''}"></label>
          <label>Observação<input id="comp-vinc-obs" placeholder="opcional"></label>
          <button onclick="compVincularManual()" style="background:#15803d;color:#fff;border:0;padding:6px 14px;border-radius:6px;font-weight:700;cursor:pointer">Vincular</button>
        </div>

        <div style="margin-top:14px;display:flex;justify-content:space-between">
          <button onclick="compExcluir(${cp.id})" style="background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;padding:6px 14px;border-radius:6px;font-weight:700;cursor:pointer">🗑 Excluir comprovante</button>
          <button onclick="compFecharModal()" style="background:#e2e8f0;color:#334155;border:0;padding:6px 14px;border-radius:6px;font-weight:700;cursor:pointer">Fechar</button>
        </div>
      `;
      document.getElementById('comp-modal').style.display = 'flex';
      compCarregarSugestoes(id);
    } catch (err) {
      notify('Erro: ' + err.message, 'error');
    }
  };

  window.compFecharModal = function () {
    document.getElementById('comp-modal').style.display = 'none';
    _currentComp = null;
  };

  async function compCarregarSugestoes(id) {
    try {
      const s = await http('/' + id + '/sugerir-matches');
      const el = document.getElementById('comp-sugestoes');
      const blocks = [];
      if (s.nfs && s.nfs.length) {
        blocks.push(`<div style="margin-bottom:6px"><strong style="color:#1e40af">NFs candidatas (${s.nfs.length})</strong></div>` +
          s.nfs.slice(0, 10).map(n => sugestaoLinha('NF', n.id, `NF ${n.numero} — ${n.tomador} — ${fmtBrl(n.valor_liquido || n.valor_bruto)} — ${n.data_emissao || ''}`)).join(''));
      }
      if (s.despesas && s.despesas.length) {
        blocks.push(`<div style="margin:8px 0 6px"><strong style="color:#9f1239">Despesas candidatas (${s.despesas.length})</strong></div>` +
          s.despesas.slice(0, 10).map(d => sugestaoLinha('DESPESA', d.id, `Desp #${d.id} — ${d.fornecedor || d.descricao} — ${fmtBrl(d.valor_bruto)} — ${d.data_vencimento || ''}`)).join(''));
      }
      if (s.extratos && s.extratos.length) {
        blocks.push(`<div style="margin:8px 0 6px"><strong style="color:#166534">Extratos candidatos (${s.extratos.length})</strong></div>` +
          s.extratos.slice(0, 10).map(e => {
            const v = e.credito || e.debito || 0;
            return sugestaoLinha('EXTRATO', e.id, `${e.data_iso} — ${fmtBrl(v)} — ${(e.descricao || '').slice(0, 60)}`);
          }).join(''));
      }
      el.innerHTML = blocks.length
        ? blocks.join('')
        : '<div style="color:#94a3b8">Nenhuma sugestão automática (sem match por CNPJ + valor). Use vínculo manual abaixo.</div>';
    } catch (err) {
      document.getElementById('comp-sugestoes').innerHTML = '<span style="color:#991b1b">Erro ao buscar sugestões: ' + err.message + '</span>';
    }
  }

  function sugestaoLinha(tipo, id, label) {
    return `<div style="display:flex;justify-content:space-between;align-items:center;background:#f8fafc;padding:6px 8px;border-radius:5px;margin-bottom:3px">
      <span>${label}</span>
      <button onclick="compSugestaoVincular('${tipo}', ${JSON.stringify(String(id))})" style="background:#dcfce7;color:#166534;border:0;border-radius:4px;padding:3px 10px;font-size:10px;font-weight:700;cursor:pointer">+ Vincular</button>
    </div>`;
  }

  window.compSugestaoVincular = async function (tipo, id) {
    if (!_currentComp) return;
    const saldoLivre = Number(_currentComp.valor) - Number(_currentComp.valor_vinculado || 0);
    const valor = prompt('Valor a vincular (saldo livre: ' + fmtBrl(saldoLivre) + '):', saldoLivre.toFixed(2));
    if (!valor) return;
    try {
      await http('/' + _currentComp.id + '/vincular', {
        method: 'POST',
        body: JSON.stringify({ tipo_destino: tipo, destino_id: id, valor_vinculado: parseFloat(valor) }),
      });
      notify('Vinculado!', 'success');
      compAbrirModal(_currentComp.id);
      compListar();
    } catch (err) {
      notify('Erro: ' + err.message, 'error');
    }
  };

  window.compVincularManual = async function () {
    if (!_currentComp) return;
    const tipo = document.getElementById('comp-vinc-tipo').value;
    const id = document.getElementById('comp-vinc-id').value.trim();
    const valor = parseFloat(document.getElementById('comp-vinc-valor').value);
    const obs = document.getElementById('comp-vinc-obs').value.trim();
    if (!id) return notify('Informe o ID/numContrato', 'error');
    if (!valor || valor <= 0) return notify('Informe valor > 0', 'error');
    try {
      await http('/' + _currentComp.id + '/vincular', {
        method: 'POST',
        body: JSON.stringify({ tipo_destino: tipo, destino_id: id, valor_vinculado: valor, observacao: obs }),
      });
      notify('Vinculado!', 'success');
      compAbrirModal(_currentComp.id);
      compListar();
    } catch (err) {
      notify('Erro: ' + err.message, 'error');
    }
  };

  window.compDesvincular = async function (vid) {
    if (!confirm('Remover este vínculo?')) return;
    try {
      await http('/vinculos/' + vid, { method: 'DELETE' });
      notify('Vínculo removido', 'success');
      if (_currentComp) compAbrirModal(_currentComp.id);
      compListar();
    } catch (err) {
      notify('Erro: ' + err.message, 'error');
    }
  };

  window.compExcluir = async function (id) {
    if (!confirm('Excluir comprovante #' + id + ' e todos os vínculos? Esta ação não pode ser desfeita.')) return;
    try {
      await http('/' + id, { method: 'DELETE' });
      notify('Comprovante excluído', 'success');
      compFecharModal();
      compListar();
    } catch (err) {
      notify('Erro: ' + err.message, 'error');
    }
  };

})();
