/**
 * Montana — Margem Real por Contrato
 *
 * Receita (NF emitida líquida) - Despesas alocadas - Folha alocada = Margem.
 *
 * Alocação de despesas (em ordem de prioridade):
 *   1) despesas.contrato_id quando preenchido (se a coluna existir)
 *   2) match fuzzy: tomador-keyword presente em obs/descricao/fornecedor/historico
 *   3) sobra → "Não alocadas"
 *
 * Alocação de folha:
 *   1) rh_folha_itens JOIN rh_funcionarios ON contrato_id = contratos.id
 *   2) rateio proporcional ao headcount do contrato (sobre o total não alocado)
 *
 * Endpoints:
 *   GET /resumo?empresa=&competencia=YYYY-MM
 *   GET /historico?empresa=&contrato_id=&meses=6
 *   GET /ranking?empresa=&competencia=YYYY-MM
 *   GET /detalhe?empresa=&contrato_id=&competencia=YYYY-MM
 */
'use strict';
const express = require('express');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

// ── Keywords por tomador (mesma lógica de pagamentos-contrato) ──────
const TOMADOR_KEYWORDS = [
  [/DETRAN/i,                          'DETRAN'],
  [/UFNT/i,                            'UFNT'],
  [/\bUFT\b/i,                         'UFT'],
  [/UNITINS/i,                         'UNITINS'],
  [/SESAU|SEMUS|LACEN|SAUDE/i,         'SESAU'],
  [/PREVI.?PALMAS|PREVIPALMAS/i,       'PREVIPALMAS'],
  [/SEDUC/i,                           'SEDUC'],
  [/SEMARH/i,                          'SEMARH'],
  [/CBMTO|BOMBEIRO/i,                  'CBMTO'],
  [/\bTCE\b|TRIBUNAL DE CONTAS/i,      'TCE'],
  [/MINISTERIO PUBLICO|\bMPTO\b|\bMP\b/i, 'MP'],
  [/FUNJURIS/i,                        'FUNJURIS'],
  [/PREFEITURA|MUNICIPIO DE PALMAS|PMP/i, 'PALMAS'],
  [/SEPLAD/i,                          'SEPLAD'],
];

function extrairKeywords(numContratoOuTexto) {
  const t = String(numContratoOuTexto || '').toUpperCase();
  const kws = new Set();
  for (const [rx, kw] of TOMADOR_KEYWORDS) if (rx.test(t)) kws.add(kw);
  return [...kws];
}

// ── Helpers de data/competência ─────────────────────────────────────
function rangeFromCompetencia(comp) {
  if (!/^\d{4}-\d{2}$/.test(comp)) {
    throw new Error('competencia deve ser YYYY-MM');
  }
  const [ano, mes] = comp.split('-');
  return { from: `${ano}-${mes}-01`, to: `${ano}-${mes}-31` };
}

function statusMargem(pct) {
  if (pct >= 20) return { codigo: 'BOM',     emoji: '🟢' };
  if (pct >= 10) return { codigo: 'ATENCAO', emoji: '🟡' };
  return            { codigo: 'CRITICO', emoji: '🔴' };
}

// ── Detecta se uma coluna existe (cache por DB+tabela) ─────────────
const _colCache = {};
async function colunaExiste(db, tabela, coluna) {
  const key = `${db.companyKey}|${tabela}|${coluna}`;
  if (key in _colCache) return _colCache[key];
  try {
    const r = await db.prepare(`
      SELECT 1 AS ok FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ? AND column_name = ?
      LIMIT 1
    `).get([tabela, coluna]);
    _colCache[key] = !!r;
  } catch (_) {
    _colCache[key] = false;
  }
  return _colCache[key];
}

// ── Carrega contratos ativos com receita-tomador-keyword ───────────
async function listarContratosAtivos(db) {
  const rows = await db.prepare(`
    SELECT id, numContrato, contrato, orgao, valor_mensal_bruto
    FROM contratos
    WHERE LOWER(COALESCE(status,'')) NOT LIKE '%encerrad%'
      AND LOWER(COALESCE(numContrato,'')) NOT LIKE '%encerrad%'
    ORDER BY numContrato
  `).all();
  for (const c of rows) {
    c.keywords = extrairKeywords(c.numContrato + ' ' + (c.contrato || '') + ' ' + (c.orgao || ''));
  }
  return rows;
}

// ── Receita: NFs emitidas no período por contrato_ref ──────────────
async function receitaPorContrato(db, from, to) {
  const rows = await db.prepare(`
    SELECT contrato_ref AS k,
           COUNT(*) AS qtd,
           ROUND(SUM(COALESCE(valor_liquido, valor_bruto - COALESCE(retencao,0))), 2) AS receita,
           ROUND(SUM(COALESCE(valor_bruto, 0)), 2) AS bruto,
           ROUND(SUM(COALESCE(retencao, 0)), 2) AS retencoes
    FROM notas_fiscais
    WHERE data_emissao >= ? AND data_emissao <= ?
      AND COALESCE(valor_bruto, 0) > 0
      AND UPPER(COALESCE(status_conciliacao,'')) NOT IN ('ASSESSORIA','IGNORAR','CANCELADA')
    GROUP BY contrato_ref
  `).all([from, to]);
  const map = {};
  for (const r of rows) map[r.k || '(sem ref)'] = r;
  return map;
}

// ── Despesas: total + alocação por contrato (priority 1 → 2 → 3) ──
async function despesasPorContrato(db, from, to, contratos) {
  const total = (await db.prepare(`
    SELECT ROUND(SUM(COALESCE(valor_bruto,0)), 2) AS tot, COUNT(*) AS qtd
    FROM despesas WHERE data_iso >= ? AND data_iso <= ?
  `).get([from, to])) || { tot: 0, qtd: 0 };

  const porContrato = {};
  for (const c of contratos) porContrato[c.id] = { valor: 0, qtd: 0 };
  let naoAlocado = 0, qtdNaoAlocada = 0;

  // P1: coluna contrato_id em despesas (se existir)
  const temContratoId = await colunaExiste(db, 'despesas', 'contrato_id');
  if (temContratoId) {
    const linhas = await db.prepare(`
      SELECT contrato_id, ROUND(SUM(COALESCE(valor_bruto,0)),2) AS tot, COUNT(*) AS qtd
      FROM despesas
      WHERE data_iso >= ? AND data_iso <= ? AND contrato_id IS NOT NULL
      GROUP BY contrato_id
    `).all([from, to]);
    for (const l of linhas) {
      if (porContrato[l.contrato_id]) {
        porContrato[l.contrato_id].valor += Number(l.tot || 0);
        porContrato[l.contrato_id].qtd   += Number(l.qtd || 0);
      }
    }
  }

  // P1.5: coluna contrato_ref textual (numContrato exato)
  // Mapa numContrato → id para alocação direta
  const numToId = {};
  for (const c of contratos) numToId[c.numContrato] = c.id;

  // P2: textual + fuzzy. Pega despesas remanescentes (sem contrato_id alocado).
  const candidatas = await db.prepare(`
    SELECT id, valor_bruto, COALESCE(contrato_ref,'') AS contrato_ref,
           UPPER(COALESCE(descricao,'') || ' ' || COALESCE(fornecedor,'') || ' ' || COALESCE(obs,'')) AS texto
    FROM despesas
    WHERE data_iso >= ? AND data_iso <= ?
      ${temContratoId ? 'AND contrato_id IS NULL' : ''}
  `).all([from, to]);

  for (const d of candidatas) {
    let alocou = false;
    // P1.5: contrato_ref textual exato
    if (d.contrato_ref && numToId[d.contrato_ref]) {
      const cid = numToId[d.contrato_ref];
      porContrato[cid].valor += Number(d.valor_bruto || 0);
      porContrato[cid].qtd   += 1;
      alocou = true;
    }
    // P2: fuzzy match por keyword
    if (!alocou) {
      for (const c of contratos) {
        if (!c.keywords?.length) continue;
        if (c.keywords.some(kw => d.texto.includes(kw))) {
          porContrato[c.id].valor += Number(d.valor_bruto || 0);
          porContrato[c.id].qtd   += 1;
          alocou = true;
          break;
        }
      }
    }
    if (!alocou) {
      naoAlocado    += Number(d.valor_bruto || 0);
      qtdNaoAlocada += 1;
    }
  }

  // arredonda
  for (const k of Object.keys(porContrato)) {
    porContrato[k].valor = +(porContrato[k].valor.toFixed(2));
  }

  return {
    total: total.tot || 0,
    qtdTotal: total.qtd || 0,
    porContrato,
    naoAlocado: +naoAlocado.toFixed(2),
    qtdNaoAlocada,
  };
}

// ── Folha: por contrato_id em rh_funcionarios (ou rateio) ─────────
async function folhaPorContrato(db, competencia, contratos) {
  // 1) Pega total da folha do mês (todas competências do mes)
  const folhaMes = await db.prepare(`
    SELECT COALESCE(SUM(total_bruto), 0) AS bruto, COALESCE(SUM(total_liquido), 0) AS liquido
    FROM rh_folha WHERE competencia = ?
  `).get([competencia]);

  // 2) Pega itens da folha JOIN funcionario para alocar
  // Se contrato_id existir em rh_funcionarios, usa direto.
  let porContrato = {};
  for (const c of contratos) porContrato[c.id] = { valor: 0, headcount: 0 };
  let naoAlocado = 0, headcountInterno = 0;

  const temContratoIdFunc = await colunaExiste(db, 'rh_funcionarios', 'contrato_id');

  if (temContratoIdFunc) {
    const linhas = await db.prepare(`
      SELECT rfu.contrato_id AS contr_id,
             COUNT(DISTINCT i.funcionario_id) AS func,
             ROUND(SUM(COALESCE(i.total_bruto, i.salario_base, 0)), 2) AS bruto
      FROM rh_folha_itens i
      JOIN rh_folha f ON f.id = i.folha_id
      JOIN rh_funcionarios rfu ON rfu.id = i.funcionario_id
      WHERE f.competencia = ?
      GROUP BY rfu.contrato_id
    `).all([competencia]);

    for (const l of linhas) {
      if (l.contr_id && porContrato[l.contr_id]) {
        porContrato[l.contr_id].valor     += Number(l.bruto || 0);
        porContrato[l.contr_id].headcount += Number(l.func  || 0);
      } else {
        naoAlocado       += Number(l.bruto || 0);
        headcountInterno += Number(l.func  || 0);
      }
    }
  } else {
    // Fallback: rateio proporcional ao headcount via contrato_ref textual
    const funcs = await db.prepare(`
      SELECT id, contrato_ref, lotacao FROM rh_funcionarios WHERE COALESCE(status,'ATIVO')='ATIVO'
    `).all();

    // Headcount por contrato (por nome em lotacao/contrato_ref)
    const head = {};
    for (const c of contratos) head[c.id] = 0;
    let internoCt = 0;
    for (const f of funcs) {
      const txt = ((f.lotacao || '') + ' ' + (f.contrato_ref || '')).toUpperCase();
      let alocou = false;
      for (const c of contratos) {
        if (c.keywords?.some(kw => txt.includes(kw))) { head[c.id]++; alocou = true; break; }
      }
      if (!alocou) internoCt++;
    }
    const totalHead = Object.values(head).reduce((a, b) => a + b, 0) + internoCt;
    const totalBruto = Number(folhaMes.bruto || 0);
    if (totalHead > 0) {
      for (const c of contratos) {
        const share = head[c.id] / totalHead;
        porContrato[c.id].valor     = +(totalBruto * share).toFixed(2);
        porContrato[c.id].headcount = head[c.id];
      }
      naoAlocado = +(totalBruto * (internoCt / totalHead)).toFixed(2);
      headcountInterno = internoCt;
    } else {
      naoAlocado = totalBruto;
    }
  }

  for (const k of Object.keys(porContrato)) {
    porContrato[k].valor = +(porContrato[k].valor.toFixed(2));
  }

  return {
    totalMes:        +Number(folhaMes.bruto    || 0).toFixed(2),
    totalLiquido:    +Number(folhaMes.liquido || 0).toFixed(2),
    porContrato,
    naoAlocado:      +Number(naoAlocado).toFixed(2),
    headcountInterno,
  };
}

// ── Monta linha de margem por contrato ─────────────────────────────
function montarLinha(c, receitaInfo, despesaInfo, folhaInfo) {
  const receita        = receitaInfo?.receita || 0;
  const receitaBruta   = receitaInfo?.bruto   || 0;
  const despesas       = despesaInfo?.valor   || 0;
  const folha          = folhaInfo?.valor     || 0;
  const margemBruta    = +(receita - despesas - folha).toFixed(2);
  const margemPct      = receita > 0 ? +(margemBruta / receita * 100).toFixed(2) : 0;
  const st = statusMargem(margemPct);

  return {
    contrato_id:    c.id,
    numContrato:    c.numContrato,
    contrato:       c.contrato || '',
    orgao:          c.orgao || '',
    tomador:        c.orgao || c.contrato || '',
    valor_mensal_bruto: c.valor_mensal_bruto || 0,
    qtd_nfs:        receitaInfo?.qtd  || 0,
    qtd_despesas:   despesaInfo?.qtd  || 0,
    headcount:      folhaInfo?.headcount || 0,
    receita:        +receita.toFixed(2),
    receita_bruta:  +receitaBruta.toFixed(2),
    retencoes:      +(receitaInfo?.retencoes || 0).toFixed(2),
    despesas_alocadas: +despesas.toFixed(2),
    folha_alocada:  +folha.toFixed(2),
    margem_bruta:   margemBruta,
    margem_pct:     margemPct,
    status:         st.codigo,
    status_emoji:   st.emoji,
  };
}

// ─── 1. Resumo da competência ───────────────────────────────────────
router.get('/resumo', async (req, res) => {
  try {
    const db   = req.db;
    const comp = (req.query.competencia || new Date().toISOString().slice(0, 7));
    const { from, to } = rangeFromCompetencia(comp);

    const contratos = await listarContratosAtivos(db);
    const [receita, despesas, folha] = await Promise.all([
      receitaPorContrato(db, from, to),
      despesasPorContrato(db, from, to, contratos),
      folhaPorContrato(db, comp, contratos),
    ]);

    const linhas = contratos.map(c => montarLinha(
      c,
      receita[c.numContrato],
      despesas.porContrato[c.id],
      folha.porContrato[c.id],
    ));

    // Filtra contratos sem nenhuma movimentação no mês
    const ativos = linhas.filter(l =>
      l.receita > 0 || l.despesas_alocadas > 0 || l.folha_alocada > 0
    );

    // Ordena: maior receita primeiro
    ativos.sort((a, b) => b.receita - a.receita);

    // KPIs
    const comReceita = ativos.filter(l => l.receita > 0);
    const melhor  = comReceita.reduce((m, l) => l.margem_pct > (m?.margem_pct ?? -Infinity) ? l : m, null);
    const pior    = comReceita.reduce((m, l) => l.margem_pct < (m?.margem_pct ??  Infinity) ? l : m, null);
    const mediaPct = comReceita.length
      ? +(comReceita.reduce((s, l) => s + l.margem_pct, 0) / comReceita.length).toFixed(2)
      : 0;

    const totalReceita     = ativos.reduce((s, l) => s + l.receita, 0);
    const totalDespesas    = ativos.reduce((s, l) => s + l.despesas_alocadas, 0);
    const totalFolha       = ativos.reduce((s, l) => s + l.folha_alocada, 0);
    const totalMargem      = totalReceita - totalDespesas - totalFolha;

    res.json({
      ok: true,
      competencia: comp,
      periodo: { from, to },
      kpis: {
        total_contratos:         ativos.length,
        contratos_com_receita:   comReceita.length,
        media_margem_pct:        mediaPct,
        melhor_margem: melhor ? {
          numContrato: melhor.numContrato, orgao: melhor.orgao,
          margem_pct: melhor.margem_pct, margem_bruta: melhor.margem_bruta,
        } : null,
        pior_margem: pior ? {
          numContrato: pior.numContrato, orgao: pior.orgao,
          margem_pct: pior.margem_pct, margem_bruta: pior.margem_bruta,
        } : null,
        total_receita:     +totalReceita.toFixed(2),
        total_despesas:    +totalDespesas.toFixed(2),
        total_folha:       +totalFolha.toFixed(2),
        total_margem:      +totalMargem.toFixed(2),
        margem_portfolio_pct: totalReceita > 0
          ? +(totalMargem / totalReceita * 100).toFixed(2) : 0,
      },
      diagnostico: {
        despesas_total_mes:           despesas.total,
        despesas_alocadas:            +totalDespesas.toFixed(2),
        despesas_nao_alocadas:        despesas.naoAlocado,
        folha_total_mes:              folha.totalMes,
        folha_alocada:                +totalFolha.toFixed(2),
        folha_nao_alocada:            folha.naoAlocado,
        headcount_interno:            folha.headcountInterno,
      },
      contratos: ativos,
    });
  } catch (e) {
    console.error('[margem-contrato/resumo]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── 2. Histórico mês a mês para um contrato ───────────────────────
router.get('/historico', async (req, res) => {
  try {
    const db = req.db;
    const contratoId = parseInt(req.query.contrato_id || '0', 10);
    const meses = Math.min(parseInt(req.query.meses || '6', 10) || 6, 24);
    if (!contratoId) return res.status(400).json({ error: 'Parâmetro contrato_id obrigatório' });

    const c = await db.prepare(`SELECT * FROM contratos WHERE id = ?`).get([contratoId]);
    if (!c) return res.status(404).json({ error: 'Contrato não encontrado' });
    c.keywords = extrairKeywords(c.numContrato + ' ' + (c.contrato || '') + ' ' + (c.orgao || ''));

    const hoje = new Date();
    const out = [];

    // Roda em série para reaproveitar caches do detector de coluna
    for (let i = meses - 1; i >= 0; i--) {
      const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
      const ano = d.getFullYear();
      const mm  = String(d.getMonth() + 1).padStart(2, '0');
      const comp = `${ano}-${mm}`;
      const { from, to } = rangeFromCompetencia(comp);

      const [receita, despesas, folha] = await Promise.all([
        receitaPorContrato(db, from, to),
        despesasPorContrato(db, from, to, [c]),
        folhaPorContrato(db, comp, [c]),
      ]);

      const linha = montarLinha(
        c,
        receita[c.numContrato],
        despesas.porContrato[c.id],
        folha.porContrato[c.id],
      );

      out.push({
        mes: comp,
        receita:           linha.receita,
        despesas_alocadas: linha.despesas_alocadas,
        folha_alocada:     linha.folha_alocada,
        margem_bruta:      linha.margem_bruta,
        margem_pct:        linha.margem_pct,
        status:            linha.status,
        qtd_nfs:           linha.qtd_nfs,
      });
    }

    res.json({
      ok: true,
      contrato: { id: c.id, numContrato: c.numContrato, orgao: c.orgao },
      historico: out,
    });
  } catch (e) {
    console.error('[margem-contrato/historico]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── 3. Ranking (mais e menos rentáveis) ───────────────────────────
router.get('/ranking', async (req, res) => {
  try {
    const db   = req.db;
    const comp = (req.query.competencia || new Date().toISOString().slice(0, 7));
    const { from, to } = rangeFromCompetencia(comp);

    const contratos = await listarContratosAtivos(db);
    const [receita, despesas, folha] = await Promise.all([
      receitaPorContrato(db, from, to),
      despesasPorContrato(db, from, to, contratos),
      folhaPorContrato(db, comp, contratos),
    ]);

    const linhas = contratos.map(c => montarLinha(
      c, receita[c.numContrato], despesas.porContrato[c.id], folha.porContrato[c.id]
    )).filter(l => l.receita > 0);

    const ordenado = [...linhas].sort((a, b) => b.margem_pct - a.margem_pct);
    const top3    = ordenado.slice(0, 3);
    const bottom3 = ordenado.slice(-3).reverse();

    res.json({
      ok: true,
      competencia: comp,
      total_contratos: linhas.length,
      mais_rentaveis: top3,
      menos_rentaveis: bottom3,
      ranking_completo: ordenado,
    });
  } catch (e) {
    console.error('[margem-contrato/ranking]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── 4. Detalhe completo do contrato na competência ────────────────
router.get('/detalhe', async (req, res) => {
  try {
    const db   = req.db;
    const contratoId = parseInt(req.query.contrato_id || '0', 10);
    const comp = (req.query.competencia || new Date().toISOString().slice(0, 7));
    if (!contratoId) return res.status(400).json({ error: 'Parâmetro contrato_id obrigatório' });
    const { from, to } = rangeFromCompetencia(comp);

    const c = await db.prepare(`SELECT * FROM contratos WHERE id = ?`).get([contratoId]);
    if (!c) return res.status(404).json({ error: 'Contrato não encontrado' });
    c.keywords = extrairKeywords(c.numContrato + ' ' + (c.contrato || '') + ' ' + (c.orgao || ''));

    // NFs do período
    const nfs = await db.prepare(`
      SELECT id, numero, tomador, data_emissao, data_pagamento,
             valor_bruto, valor_liquido, retencao, status_conciliacao
      FROM notas_fiscais
      WHERE data_emissao >= ? AND data_emissao <= ?
        AND contrato_ref = ?
        AND COALESCE(valor_bruto,0) > 0
      ORDER BY data_emissao
    `).all([from, to, c.numContrato]);

    // Despesas do período candidatas (P1 → P1.5 → P2)
    const temContratoId = await colunaExiste(db, 'despesas', 'contrato_id');
    const despesasCand = await db.prepare(`
      SELECT id, data_iso, valor_bruto, descricao, fornecedor, categoria, obs,
             COALESCE(contrato_ref,'') AS contrato_ref
             ${temContratoId ? ', contrato_id' : ''}
      FROM despesas
      WHERE data_iso >= ? AND data_iso <= ?
      ORDER BY data_iso
    `).all([from, to]);

    const despesasAlocadas = [];
    const porCategoria = {};
    for (const d of despesasCand) {
      let motivo = null;
      if (temContratoId && d.contrato_id === c.id) motivo = 'contrato_id';
      else if (d.contrato_ref === c.numContrato) motivo = 'contrato_ref';
      else {
        const txt = `${d.descricao || ''} ${d.fornecedor || ''} ${d.obs || ''}`.toUpperCase();
        if (c.keywords.some(kw => txt.includes(kw))) motivo = 'keyword';
      }
      if (motivo) {
        despesasAlocadas.push({ ...d, motivo });
        const cat = (d.categoria || 'OUTROS').toUpperCase().trim();
        porCategoria[cat] = (porCategoria[cat] || 0) + Number(d.valor_bruto || 0);
      }
    }

    // Folha do mês para o contrato
    const folha = await folhaPorContrato(db, comp, [c]);
    const folhaContr = folha.porContrato[c.id] || { valor: 0, headcount: 0 };

    // Funcionários alocados (se a coluna existir)
    let funcionarios = [];
    const temContratoIdFunc = await colunaExiste(db, 'rh_funcionarios', 'contrato_id');
    if (temContratoIdFunc) {
      try {
        funcionarios = await db.prepare(`
          SELECT i.funcionario_id AS id, rfu.nome,
                 COALESCE(i.total_bruto, i.salario_base, rfu.salario_base, 0) AS valor
          FROM rh_folha_itens i
          JOIN rh_folha f ON f.id = i.folha_id
          JOIN rh_funcionarios rfu ON rfu.id = i.funcionario_id
          WHERE f.competencia = ? AND rfu.contrato_id = ?
          ORDER BY rfu.nome
        `).all([comp, c.id]);
      } catch (_) { /* schema variation */ }
    }

    const receita = nfs.reduce((s, n) =>
      s + Number(n.valor_liquido || (n.valor_bruto - (n.retencao || 0))), 0);
    const totalDespesas = despesasAlocadas.reduce((s, d) => s + Number(d.valor_bruto || 0), 0);
    const margem = +(receita - totalDespesas - folhaContr.valor).toFixed(2);
    const margemPct = receita > 0 ? +(margem / receita * 100).toFixed(2) : 0;
    const st = statusMargem(margemPct);

    res.json({
      ok: true,
      competencia: comp,
      contrato: {
        id: c.id, numContrato: c.numContrato, orgao: c.orgao,
        contrato: c.contrato, valor_mensal_bruto: c.valor_mensal_bruto,
      },
      nfs,
      despesas: despesasAlocadas,
      despesas_por_categoria: Object.entries(porCategoria)
        .map(([k, v]) => ({ categoria: k, total: +v.toFixed(2) }))
        .sort((a, b) => b.total - a.total),
      folha: {
        total: folhaContr.valor,
        headcount: folhaContr.headcount,
        funcionarios,
      },
      totais: {
        receita: +receita.toFixed(2),
        despesas: +totalDespesas.toFixed(2),
        folha: +folhaContr.valor.toFixed(2),
        margem_bruta: margem,
        margem_pct: margemPct,
        status: st.codigo,
        status_emoji: st.emoji,
      },
    });
  } catch (e) {
    console.error('[margem-contrato/detalhe]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
