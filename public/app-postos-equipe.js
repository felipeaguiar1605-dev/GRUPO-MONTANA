/**
 * Montana ERP — Postos & Equipes (frontend)
 *
 * Tela de visualização operacional: lista postos com sumário de equipe.
 * Clique no posto pra ver detalhes (funcionários alocados).
 *
 * Carregada como uma tab. Função entrada: showPostosEquipe()
 *
 * Adicionar no menu lateral em index.html:
 *   <a href="#" onclick="showPostosEquipe()" class="menu-item">👥 Postos & Equipes</a>
 *
 * Requer: api(), brl(), showLoading(), hideLoading() já existentes em app.js
 */

(function() {
  'use strict';

  let _postosCache = null;

  // ─── Tela principal ────────────────────────────────────────────────
  window.showPostosEquipe = async function() {
    // Se app.js tem showTab(), usa; senão renderiza num container fixo
    const main = document.querySelector('main') || document.getElementById('main') || document.body;

    main.innerHTML = `
      <div style="padding:16px;max-width:1400px;margin:0 auto">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <h1 style="font-size:22px;font-weight:800;margin:0">👥 Postos & Equipes</h1>
          <div>
            <button onclick="recarregarPostosEquipe()" class="btn"
                    style="background:#3b82f6;color:#fff;border:none;padding:6px 12px;border-radius:6px;cursor:pointer">
              🔄 Recarregar
            </button>
            <button onclick="mostrarSemPosto()" class="btn"
                    style="background:#f59e0b;color:#fff;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;margin-left:8px">
              ⚠ Funcionários sem posto
            </button>
          </div>
        </div>

        <div id="pe-sumario" style="margin-bottom:16px"></div>
        <div id="pe-lista" style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden"></div>
      </div>
    `;

    await carregar();
  };

  window.recarregarPostosEquipe = async function() {
    _postosCache = null;
    await carregar();
  };

  async function carregar() {
    const lista = document.getElementById('pe-lista');
    if (!lista) return;
    lista.innerHTML = `<div style="padding:32px;text-align:center;color:#64748b">Carregando…</div>`;

    try {
      const r = await api('/postos-equipe');
      _postosCache = r;
      renderizar(r);
    } catch (e) {
      lista.innerHTML = `<div style="padding:24px;color:#dc2626">Erro: ${e.message}</div>`;
    }
  }

  function renderizar(data) {
    const sumario = document.getElementById('pe-sumario');
    const lista   = document.getElementById('pe-lista');
    const s = data.sumario || {};

    // Sumário top
    sumario.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px">
        ${kpi('Postos', s.total_postos || 0, '#1d4ed8', '🏢')}
        ${kpi('Funcionários ATIVOS', s.total_funcionarios_ativos || 0, '#15803d', '👥')}
        ${kpi('Sem posto definido', s.sem_posto_id || 0, '#f59e0b', '⚠')}
        ${kpi('Folha estimada', brl(s.folha_total_estimada || 0), '#7c3aed', '💰')}
        ${kpi('Contratos ativos', s.contratos_ativos || 0, '#0ea5e9', '📑')}
      </div>
    `;

    // Lista de postos agrupada por contrato
    const postos = data.postos || [];
    if (postos.length === 0) {
      lista.innerHTML = `<div style="padding:32px;text-align:center;color:#64748b">Nenhum posto cadastrado.</div>`;
      return;
    }

    const porContrato = {};
    postos.forEach(p => {
      const k = p.contrato_nome || '(sem contrato)';
      if (!porContrato[k]) porContrato[k] = [];
      porContrato[k].push(p);
    });

    let html = '';
    Object.keys(porContrato).sort().forEach(contrato => {
      const grupo = porContrato[contrato];
      const totalFunc = grupo.reduce((s, p) => s + (p.qtd_funcionarios || 0), 0);
      const totalSal  = grupo.reduce((s, p) => s + (parseFloat(p.salario_total) || 0), 0);

      html += `
        <details open style="border-bottom:1px solid #e2e8f0">
          <summary style="padding:12px 16px;background:#f8fafc;cursor:pointer;font-weight:700;display:flex;justify-content:space-between;align-items:center">
            <span>📑 ${contrato} <span style="font-weight:400;color:#64748b;font-size:11px">${grupo.length} posto${grupo.length !== 1 ? 's' : ''}</span></span>
            <span style="font-size:11px;color:#475569">
              ${totalFunc} func · ${brl(totalSal)} folha
            </span>
          </summary>
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead style="background:#f1f5f9">
              <tr>
                <th style="text-align:left;padding:8px 12px">Posto</th>
                <th style="text-align:left;padding:8px 12px">Município</th>
                <th style="text-align:right;padding:8px 12px">Funcionários</th>
                <th style="text-align:right;padding:8px 12px">Folha posto</th>
                <th style="text-align:center;padding:8px 12px">Ação</th>
              </tr>
            </thead>
            <tbody>
              ${grupo.map(p => `
                <tr style="border-top:1px solid #f1f5f9;cursor:pointer" onclick="abrirDetalhePosto(${p.id})"
                    onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">
                  <td style="padding:8px 12px">
                    <strong>${escapeHtml(p.campus_nome || '—')}</strong>
                    ${p.descricao_posto ? `<br><span style="color:#64748b;font-size:10px">${escapeHtml(p.descricao_posto)}</span>` : ''}
                  </td>
                  <td style="padding:8px 12px;color:#475569">${escapeHtml(p.municipio || '—')}</td>
                  <td style="padding:8px 12px;text-align:right">
                    ${p.qtd_funcionarios > 0
                      ? `<span style="color:#15803d;font-weight:600">${p.qtd_funcionarios}</span>`
                      : `<span style="color:#dc2626;font-weight:600">0 (vazio)</span>`}
                  </td>
                  <td style="padding:8px 12px;text-align:right;color:#475569">${brl(p.salario_total || 0)}</td>
                  <td style="padding:8px 12px;text-align:center">
                    <button onclick="event.stopPropagation();abrirDetalhePosto(${p.id})"
                            style="background:#3b82f6;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px">
                      Ver equipe
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </details>
      `;
    });

    lista.innerHTML = html;
  }

  // ─── Detalhe posto (modal) ─────────────────────────────────────────
  window.abrirDetalhePosto = async function(posto_id) {
    const modal = document.createElement('div');
    modal.id = 'pe-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999';
    modal.innerHTML = `
      <div style="background:#fff;border-radius:10px;max-width:800px;width:95%;max-height:90vh;overflow:auto">
        <div style="padding:14px 18px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between">
          <strong id="pe-modal-title">Carregando…</strong>
          <button onclick="document.getElementById('pe-modal').remove()" style="background:none;border:none;font-size:18px;cursor:pointer">×</button>
        </div>
        <div id="pe-modal-body" style="padding:16px"></div>
      </div>
    `;
    document.body.appendChild(modal);

    try {
      const r = await api('/postos-equipe/' + posto_id);
      const p = r.posto || {};
      const funcs = r.funcionarios || [];

      document.getElementById('pe-modal-title').innerHTML = `
        🏢 ${escapeHtml(p.campus_nome || '—')}
        <span style="font-weight:400;font-size:11px;color:#64748b">
          · ${escapeHtml(p.contrato_nome || '')}
        </span>
      `;

      document.getElementById('pe-modal-body').innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px">
          ${kpi('Total funcionários', funcs.length, '#15803d', '👥')}
          ${kpi('Folha posto', brl(r.sumario.salario_total), '#7c3aed', '💰')}
          ${kpi('Município', p.municipio || '—', '#0ea5e9', '📍')}
          ${kpi('Escala', p.escala || '12x36', '#6366f1', '⏰')}
        </div>

        ${funcs.length === 0
          ? `<div style="padding:32px;text-align:center;color:#dc2626;background:#fef2f2;border:1px dashed #f87171;border-radius:8px">
              ⚠ Nenhum funcionário alocado a este posto.<br>
              <small style="color:#64748b">Verifique se a "Lotação" no cadastro do funcionário casa com o nome do posto.</small>
            </div>`
          : `<table style="width:100%;border-collapse:collapse;font-size:12px">
              <thead style="background:#f1f5f9">
                <tr>
                  <th style="text-align:left;padding:8px 12px">Nome</th>
                  <th style="text-align:left;padding:8px 12px">Cargo</th>
                  <th style="text-align:right;padding:8px 12px">Salário base</th>
                  <th style="text-align:left;padding:8px 12px">Lotação</th>
                  <th style="text-align:center;padding:8px 12px">Ação</th>
                </tr>
              </thead>
              <tbody>
                ${funcs.map(f => `
                  <tr style="border-top:1px solid #f1f5f9" id="pe-row-${f.id}">
                    <td style="padding:8px 12px"><strong>${escapeHtml(f.nome)}</strong></td>
                    <td style="padding:8px 12px">${escapeHtml(f.cargo_nome || '—')}</td>
                    <td style="padding:8px 12px;text-align:right">${brl(f.salario_base || 0)}</td>
                    <td style="padding:8px 12px;color:#64748b">${escapeHtml(f.lotacao || '—')}</td>
                    <td style="padding:8px 12px;text-align:center">
                      <button onclick="moverFuncionarioPosto(${f.id}, '${escapeHtml(f.nome).replace(/'/g, "\\'")}')"
                              style="background:#f59e0b;color:#fff;border:none;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:10px">
                        ↔ Mover
                      </button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>`}
      `;
    } catch (e) {
      document.getElementById('pe-modal-body').innerHTML = `<div style="color:#dc2626">Erro: ${e.message}</div>`;
    }
  };

  // ─── Sem posto (modal) com botão pra atribuir ────────────────────
  window.mostrarSemPosto = async function() {
    const modal = document.createElement('div');
    modal.id = 'pe-modal-semposto';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:9999';
    modal.innerHTML = `
      <div style="background:#fff;border-radius:10px;max-width:1000px;width:95%;max-height:90vh;overflow:auto">
        <div style="padding:14px 18px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between">
          <strong>⚠ Funcionários sem posto definido — clique pra atribuir</strong>
          <button onclick="document.getElementById('pe-modal-semposto').remove()" style="background:none;border:none;font-size:18px;cursor:pointer">×</button>
        </div>
        <div id="pe-sp-body" style="padding:16px">Carregando…</div>
      </div>
    `;
    document.body.appendChild(modal);

    try {
      // Busca lista de postos pra dropdown
      const postosResp = _postosCache || await api('/postos-equipe');
      const postos = (postosResp.postos || []).slice().sort((a,b) =>
        (a.contrato_nome||'').localeCompare(b.contrato_nome||'') || (a.campus_nome||'').localeCompare(b.campus_nome||'')
      );
      const postoOptions = postos.map(p =>
        `<option value="${p.id}">${escapeHtml((p.contrato_nome||'') + ' · ' + (p.campus_nome||p.descricao_posto||''))}</option>`
      ).join('');

      const r = await api('/postos-equipe/sem-posto');
      const grupos = r.por_lotacao || {};
      let html = `<p>Total: <strong>${r.total}</strong> funcionário${r.total !== 1 ? 's' : ''} ativo${r.total !== 1 ? 's' : ''} sem posto.</p>`;

      Object.keys(grupos).sort().forEach(lotacao => {
        const pessoas = grupos[lotacao];
        html += `
          <details style="margin-bottom:8px;border:1px solid #e2e8f0;border-radius:6px;padding:6px 12px">
            <summary style="cursor:pointer;font-weight:600">
              📍 ${escapeHtml(lotacao)}
              <span style="color:#64748b;font-weight:400;font-size:11px">${pessoas.length} pessoa${pessoas.length !== 1 ? 's' : ''}</span>
            </summary>
            <table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:6px">
              <thead style="background:#f1f5f9">
                <tr><th style="text-align:left;padding:6px">Nome</th><th style="text-align:left;padding:6px">Cargo</th><th style="text-align:left;padding:6px">Atribuir posto</th></tr>
              </thead>
              <tbody>
              ${pessoas.map(f => `
                <tr style="border-top:1px solid #f1f5f9">
                  <td style="padding:6px">${escapeHtml(f.nome)}</td>
                  <td style="padding:6px;color:#64748b">${escapeHtml(f.cargo_nome || 'sem cargo')}</td>
                  <td style="padding:6px">
                    <select id="pe-sel-${f.id}" style="font-size:10px;padding:2px 4px;max-width:280px">
                      <option value="">— escolher posto —</option>
                      ${postoOptions}
                    </select>
                    <button onclick="atribuirPostoFuncionario(${f.id})"
                            style="background:#15803d;color:#fff;border:none;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:10px;margin-left:4px">
                      ✓ Atribuir
                    </button>
                  </td>
                </tr>
              `).join('')}
              </tbody>
            </table>
          </details>
        `;
      });

      document.getElementById('pe-sp-body').innerHTML = html;
    } catch (e) {
      document.getElementById('pe-sp-body').innerHTML = `<div style="color:#dc2626">Erro: ${e.message}</div>`;
    }
  };

  // Move funcionário pra outro posto (a partir do modal detalhe)
  window.moverFuncionarioPosto = async function(funcionario_id, nome) {
    // Busca lista de postos pra dropdown
    const postosResp = _postosCache || await api('/postos-equipe');
    const postos = (postosResp.postos || []).slice().sort((a,b) =>
      (a.contrato_nome||'').localeCompare(b.contrato_nome||'') || (a.campus_nome||'').localeCompare(b.campus_nome||'')
    );

    // Cria modal compacto
    const m = document.createElement('div');
    m.id = 'pe-modal-mover';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:10000';
    m.innerHTML = `
      <div style="background:#fff;border-radius:8px;max-width:520px;width:90%;padding:20px">
        <h3 style="margin:0 0 8px;font-size:15px">Mover ${escapeHtml(nome)}</h3>
        <p style="font-size:11px;color:#64748b;margin:0 0 12px">Escolha o novo posto:</p>
        <select id="pe-mover-sel" style="width:100%;padding:6px;font-size:12px;border:1px solid #cbd5e1;border-radius:4px">
          <option value="">— escolher posto —</option>
          ${postos.map(p => `<option value="${p.id}">${escapeHtml((p.contrato_nome||'') + ' · ' + (p.campus_nome||p.descricao_posto||''))}</option>`).join('')}
        </select>
        <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:12px">
          <button onclick="document.getElementById('pe-modal-mover').remove()"
                  style="background:#e2e8f0;color:#1f2937;border:none;padding:6px 12px;border-radius:4px;cursor:pointer">Cancelar</button>
          <button id="pe-btn-confirmar-mover"
                  style="background:#15803d;color:#fff;border:none;padding:6px 12px;border-radius:4px;cursor:pointer">Confirmar</button>
        </div>
      </div>
    `;
    document.body.appendChild(m);

    document.getElementById('pe-btn-confirmar-mover').onclick = async () => {
      const sel = document.getElementById('pe-mover-sel');
      if (!sel.value) { alert('Escolha um posto'); return; }
      try {
        const r = await api(`/postos-equipe/${funcionario_id}/atribuir-posto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ posto_id: parseInt(sel.value) })
        });
        if (r && r.ok) {
          // Remove linha do modal de detalhe (se aberto)
          const row = document.getElementById('pe-row-' + funcionario_id);
          if (row) row.remove();
          m.remove();
          _postosCache = null;
          if (typeof window.toast === 'function') window.toast('✓ Funcionário movido', 'success');
          else alert('✓ Funcionário movido — recarregue pra atualizar lista');
        } else {
          alert('Erro: ' + (r.error || 'desconhecido'));
        }
      } catch (e) {
        alert('Erro: ' + e.message);
      }
    };
  };

  // Atribui posto a funcionário e remove linha visualmente
  window.atribuirPostoFuncionario = async function(funcionario_id) {
    const sel = document.getElementById('pe-sel-' + funcionario_id);
    if (!sel || !sel.value) {
      alert('Escolha um posto antes');
      return;
    }
    const posto_id = parseInt(sel.value);
    try {
      const r = await api(`/postos-equipe/${funcionario_id}/atribuir-posto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ posto_id })
      });
      if (r && r.ok) {
        // Remove a linha do funcionário do modal
        sel.closest('tr').remove();
        if (typeof window.toast === 'function') window.toast('✓ Posto atribuído', 'success');
        else console.log('✓ Posto atribuído pra func ' + funcionario_id);
        // Limpa cache pra próxima abertura mostrar atualizado
        _postosCache = null;
      } else {
        alert('Erro: ' + (r.error || 'desconhecido'));
      }
    } catch (e) {
      alert('Erro: ' + e.message);
    }
  };

  // ─── Helpers ───────────────────────────────────────────────────────
  function kpi(label, valor, cor, icone) {
    return `
      <div style="background:#fff;border:1px solid #e2e8f0;border-left:4px solid ${cor};border-radius:8px;padding:10px 12px">
        <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">${icone} ${label}</div>
        <div style="font-size:20px;font-weight:800;color:${cor};margin-top:2px">${valor}</div>
      </div>
    `;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

})();
