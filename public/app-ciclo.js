/**
 * Montana ERP — Aba "Ciclo Completo"
 *
 * Visualiza o funil: Contratos → Boletins → NFs → Pagamento identificado
 * → Comprovante anexado → Conciliação. Mostra gaps acionáveis com links
 * diretos para as outras abas.
 *
 * Endpoint: GET /api/ciclo?competencia=YYYY-MM
 * Dependências globais: api(), empresaAtual(), fmtBRL(), navGo()
 */
(function () {
  'use strict';

  const COR_ETAPA = ['#3b82f6','#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981'];

  function fmt(v) {
    if (typeof fmtBRL === 'function') return fmtBRL(v);
    return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function mesAtual() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  async function cicloCarregar() {
    const competencia = document.getElementById('ciclo-competencia')?.value || mesAtual();
    const body = document.getElementById('ciclo-body');
    if (!body) return;
    body.innerHTML = '<div class="loading" style="padding:30px;text-align:center;color:#94a3b8">Carregando funil do ciclo…</div>';

    let data;
    try {
      data = await api(`/api/ciclo?competencia=${encodeURIComponent(competencia)}`);
    } catch (e) {
      body.innerHTML = `<div style="padding:20px;color:#b91c1c;background:#fee2e2;border-radius:8px">Erro ao carregar ciclo: ${e.message}</div>`;
      return;
    }

    // Renderiza
    const etapaMax = Math.max(1, ...data.funil.map(f => f.total));
    const funilHTML = data.funil.map((f, i) => {
      const cor = COR_ETAPA[i] || '#64748b';
      const pct = etapaMax ? Math.max(3, (f.total / etapaMax) * 100) : 3;
      return `
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
          <div style="width:36px;text-align:center;color:${cor};font-weight:700;font-size:18px">${f.etapa}</div>
          <div style="flex:1">
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
              <span style="font-weight:600;color:#1e293b">${f.nome}</span>
              <span style="color:#64748b"><b style="color:${cor}">${f.total}</b> · ${fmt(f.valor)}</span>
            </div>
            <div style="background:#f1f5f9;border-radius:4px;height:22px;overflow:hidden">
              <div style="background:${cor};height:100%;width:${pct}%;transition:width .3s"></div>
            </div>
          </div>
        </div>`;
    }).join('');

    // ─── Gaps acionáveis ───
    const contratosSemNf = data.acoes.contratos_sem_nf || [];
    const bolAprovadosSemNfse = data.acoes.boletins_aprovados_sem_nfse || [];
    const pagasSemComp = data.acoes.nfs_pagas_sem_comprovante || [];
    const nfsAbertas = data.acoes.nfs_abertas || { total: 0, valor: 0 };

    function cardAcao(titulo, cor, icone, itens, renderItem, linkTab, linkLabel) {
      if (!itens || itens.length === 0) {
        return `<div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:14px">
          <div style="display:flex;align-items:center;gap:8px"><span style="font-size:18px">✅</span><b style="color:#065f46">${titulo}</b></div>
          <div style="font-size:11px;color:#047857;margin-top:4px">Nenhuma pendência nesta etapa.</div>
        </div>`;
      }
      const lista = itens.slice(0, 6).map(renderItem).join('');
      const maisN = itens.length > 6 ? `<div style="font-size:11px;color:#64748b;margin-top:6px;text-align:center">+${itens.length - 6} items…</div>` : '';
      return `<div style="background:#fff;border:1px solid #e5e7eb;border-left:4px solid ${cor};border-radius:8px;padding:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div style="display:flex;align-items:center;gap:8px"><span style="font-size:18px">${icone}</span><b style="color:#1e293b">${titulo}</b>
            <span style="background:${cor};color:white;border-radius:10px;padding:1px 8px;font-size:11px;font-weight:600">${itens.length}</span></div>
          ${linkTab ? `<a href="#" onclick="event.preventDefault();navGo('${linkTab}',document.querySelector('[data-tab=${linkTab}]'))" style="color:${cor};font-size:11px;font-weight:600;text-decoration:none">${linkLabel} →</a>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">${lista}${maisN}</div>
      </div>`;
    }

    const cardContratos = cardAcao(
      'Contratos sem NF este mês', '#ec4899', '📋',
      contratosSemNf,
      c => `<div style="font-size:11px;display:flex;justify-content:space-between;padding:4px 6px;border-radius:4px;background:#fafafa">
        <span><b>${c.numContrato}</b> — ${c.orgao || ''}</span>
        <span style="color:#64748b">${fmt(c.valor_esperado)} ${c.tem_boletim ? '· 📄 c/ boletim' : ''}</span>
      </div>`,
      'cont', 'Ver contratos'
    );

    const cardBoletins = cardAcao(
      'Boletins aprovados sem NFS-e emitida', '#8b5cf6', '📄',
      bolAprovadosSemNfse,
      b => `<div style="font-size:11px;display:flex;justify-content:space-between;padding:4px 6px;border-radius:4px;background:#fafafa">
        <span><b>${b.contrato_ref || '(?)'}</b> — ${b.orgao || ''}</span>
        <span style="color:#64748b">${fmt(b.valor_total)}</span>
      </div>`,
      'boletins', 'Emitir NFS-e'
    );

    const cardAbertas = nfsAbertas.total === 0
      ? `<div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:14px">
          <div style="display:flex;align-items:center;gap:8px"><span style="font-size:18px">✅</span><b style="color:#065f46">NFs em aberto</b></div>
          <div style="font-size:11px;color:#047857;margin-top:4px">Todas as NFs do mês com pagamento identificado.</div>
        </div>`
      : `<div style="background:#fff;border:1px solid #e5e7eb;border-left:4px solid #f59e0b;border-radius:8px;padding:14px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <div style="display:flex;align-items:center;gap:8px"><span style="font-size:18px">⏳</span><b>NFs emitidas aguardando pagamento</b></div>
            <a href="#" onclick="event.preventDefault();navGo('nfs',document.querySelector('[data-tab=nfs]'))" style="color:#f59e0b;font-size:11px;font-weight:600;text-decoration:none">Ver NFs →</a>
          </div>
          <div style="font-size:18px;font-weight:700;color:#92400e">${nfsAbertas.total} <span style="font-size:12px;font-weight:500">NFs · ${fmt(nfsAbertas.valor)}</span></div>
          <div style="font-size:11px;color:#64748b;margin-top:4px">Sem match no extrato bancário ainda.</div>
        </div>`;

    const cardComprov = cardAcao(
      'NFs pagas sem comprovante anexado', '#10b981', '📎',
      pagasSemComp,
      n => `<div style="font-size:11px;display:flex;justify-content:space-between;padding:4px 6px;border-radius:4px;background:#fafafa">
        <span><b>NF ${n.numero}</b> — ${(n.tomador || '').slice(0, 35)}</span>
        <span style="color:#64748b">${fmt(n.valor_bruto)}</span>
      </div>`,
      'pag', 'Anexar comprovante'
    );

    // ─── Box de retenções ───
    const ret = data.retencoes;
    const divClasse = ret.divergencia_pct === null
      ? { cor: '#94a3b8', ico: '—', texto: 'Sem comprovantes ENTRADA para apurar' }
      : Math.abs(ret.divergencia_pct) < 2
        ? { cor: '#10b981', ico: '✅', texto: `Retenção apurada bate com declarada (±${Math.abs(ret.divergencia_pct)}%)` }
        : { cor: '#ef4444', ico: '⚠️', texto: `Divergência de ${ret.divergencia_pct > 0 ? '+' : ''}${ret.divergencia_pct}% entre declarado e apurado` };

    const cardRetencoes = `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:14px;border-left:4px solid ${divClasse.cor}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><span style="font-size:18px">${divClasse.ico}</span><b>Retenções — declarado × apurado</b></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:8px">
        <div><div style="font-size:11px;color:#64748b">Declarado em NFs</div><div style="font-size:16px;font-weight:700;color:#1e293b">${fmt(ret.declarada_nfs)}</div></div>
        <div><div style="font-size:11px;color:#64748b">Apurado via comprovantes</div><div style="font-size:16px;font-weight:700;color:${divClasse.cor}">${fmt(ret.apurada_comprovantes)}</div></div>
      </div>
      <div style="font-size:11px;color:${divClasse.cor}">${divClasse.texto}</div>
      <div style="font-size:10px;color:#94a3b8;margin-top:4px">${ret.nfs_com_retencao_apurada} NF(s) com comprovante ENTRADA anexado.</div>
    </div>`;

    // ─── Painel de Aging ───
    let cardAging = '';
    const ag = data.aging_resumo;
    if (ag && ag.total_nfs > 0) {
      const total = ag.total_valor || 1;
      const faixas = [
        { label: '0–30 dias',  val: ag.val_0_30,   cor: '#22c55e' },
        { label: '31–60 dias', val: ag.val_31_60,  cor: '#f59e0b' },
        { label: '61–90 dias', val: ag.val_61_90,  cor: '#f97316' },
        { label: '+90 dias',   val: ag.val_90plus, cor: '#ef4444' },
      ];
      const barras = faixas.map(f => {
        const pct = Math.max(2, (f.val / total) * 100).toFixed(1);
        if (f.val <= 0) return '';
        return `<div style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px">
            <span style="color:#475569;font-weight:600">${f.label}</span>
            <span style="color:${f.cor};font-weight:700">${fmt(f.val)}</span>
          </div>
          <div style="background:#f1f5f9;border-radius:4px;height:18px;overflow:hidden">
            <div style="background:${f.cor};height:100%;width:${pct}%"></div>
          </div>
        </div>`;
      }).join('');
      cardAging = `<div style="background:#fff;border:1px solid #e5e7eb;border-left:4px solid #ef4444;border-radius:8px;padding:14px;grid-column:1/-1">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:18px">📅</span>
            <b style="color:#1e293b">Aging de Recebíveis — ${ag.total_nfs} NFs PENDENTE · ${fmt(ag.total_valor)}</b>
          </div>
          <a href="#" onclick="event.preventDefault();navGo('nfs',document.querySelector('[data-tab=nfs]'))" style="color:#3b82f6;font-size:11px;font-weight:600;text-decoration:none">Ver NFs →</a>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px">
          ${faixas.map(f => {
            const pct = total > 0 ? ((f.val/total)*100).toFixed(0) : 0;
            return `<div style="background:#f8fafc;border-radius:6px;padding:10px">
              <div style="font-size:10px;color:#64748b;font-weight:600;margin-bottom:4px">${f.label}</div>
              <div style="font-size:17px;font-weight:800;color:${f.cor}">${fmt(f.val)}</div>
              <div style="font-size:10px;color:#94a3b8">${pct}% do total pendente</div>
            </div>`;
          }).join('')}
        </div>
      </div>`;
    }

    // ─── Monta layout final ───
    body.innerHTML = `
      <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h3 style="margin:0;color:#1e293b">🔄 Funil do Ciclo — ${data.empresa} · ${data.competencia}</h3>
          <div style="font-size:11px;color:#64748b">${data.meta.total_nfs_mes} NFs no mês · ${fmt(data.meta.valor_total_emitido)}</div>
        </div>
        ${funilHTML}
      </div>
      ${cardAging ? `<div style="margin-bottom:12px">${cardAging}</div>` : ''}
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">
        ${cardContratos}
        ${cardBoletins}
        ${cardAbertas}
        ${cardComprov}
        ${cardRetencoes}
      </div>
    `;
  }

  // Navegação inicial: carrega ao entrar na aba
  window.cicloCarregar = cicloCarregar;
  window.cicloInit = function () {
    const sel = document.getElementById('ciclo-competencia');
    if (sel && !sel.value) sel.value = mesAtual();
    cicloCarregar();
  };
})();
