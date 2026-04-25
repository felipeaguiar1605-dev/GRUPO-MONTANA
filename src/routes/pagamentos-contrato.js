/**
 * Montana — Painel de Pagamentos por Contrato
 * Monitora inadimplência e status de pagamento por tomador/contrato.
 */
const express = require('express');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

// ── Extrai keyword de busca do nome do tomador ───────────────────
function tomadorKeyword(tomador) {
  const t = (tomador || '').trim().toUpperCase();
  const patterns = [
    [/DETRAN/, 'DETRAN'],
    [/UFNT/, 'UFNT'],
    [/\bUFT\b/, 'UFT'],
    [/UNITINS/, 'UNITINS'],
    [/SEMUS|SESAU|SAUDE/, 'SAUDE'],
    [/PREVI.?PALMAS|PREVIPALMAS/, 'PREVIPALMAS'],
    [/SEDUC/, 'SEDUC'],
    [/SEMARH/, 'SEMARH'],
    [/CBMTO/, 'CBMTO'],
    [/\bTCE\b/, 'TCE'],
    [/MINISTERIO PUBLICO|MINIST.+PUBLICO|\bMPTO\b/, 'MINISTERIO'],
    [/FUNJURIS/, 'FUNJURIS'],
    [/PREFEITURA|MUNICIPIO DE PALMAS/, 'PALMAS'],
    [/SEPLAD/, 'SEPLAD'],
  ];
  for (const [rx, kw] of patterns) {
    if (rx.test(t)) return kw;
  }
  const word = t.split(/\s+/).find(w => w.length >= 3);
  return word ? word.slice(0, 8) : t.slice(0, 6);
}

// ── Status do pagamento ───────────────────────────────────────────
function calcStatus(faturado, recebido, diasDesdeEmissao) {
  if (faturado <= 0) return 'SEM_NF';
  const pct = recebido / faturado;
  if (pct >= 0.90) return 'PAGO';
  if (pct >= 0.30) return 'PARCIAL';
  if (diasDesdeEmissao > 30) return 'VENCIDO';
  return 'ABERTO';
}

function diasDesde(dataIso) {
  if (!dataIso) return 0;
  return Math.floor((Date.now() - new Date(dataIso).getTime()) / 86400000);
}

// Busca créditos por keyword e tenta match individual + agregado
async function matchCreditos(db, nfsSemLink, keyword, dataFrom, dataToExt) {
  if (!nfsSemLink.length || !keyword) return 0;

  const credits = await db.prepare(`
    SELECT id, credito, data_iso FROM extratos
    WHERE data_iso >= ? AND data_iso <= ?
      AND credito > 0
      AND UPPER(historico) LIKE ?
      AND id NOT IN (
        SELECT extrato_id FROM notas_fiscais
        WHERE extrato_id IS NOT NULL AND extrato_id != 0
      )
    ORDER BY data_iso
  `).all(dataFrom, dataToExt, `%${keyword}%`);

  if (!credits.length) return 0;

  let recebido = 0;
  const usados = new Set();

  for (const nf of nfsSemLink) {
    const target = nf.valor_liquido > 0 ? nf.valor_liquido : nf.valor_bruto;
    const tol = Math.max(target * 0.10, 50);
    const match = credits.find(c => !usados.has(c.id) && Math.abs(c.credito - target) <= tol);
    if (match) { recebido += match.credito; usados.add(match.id); }
  }

  // Nenhum match individual: tenta soma agregada (±15%)
  if (usados.size === 0) {
    const sumC = credits.reduce((s, c) => s + c.credito, 0);
    const sumN = nfsSemLink.reduce((s, n) => s + (n.valor_liquido > 0 ? n.valor_liquido : n.valor_bruto), 0);
    if (sumN > 0 && Math.abs(sumC - sumN) / sumN <= 0.15) recebido = sumC;
  }

  return recebido;
}

// ─── 1. Resumo por tomador no mês ────────────────────────────────
router.get('/resumo', async (req, res) => {
  try {
    const db = req.db;
    const mes = (req.query.mes || new Date().toISOString().slice(0, 7));
    const [ano, mesNum] = mes.split('-');
    const mm = mesNum.padStart(2, '0');
    const dataFrom = `${ano}-${mm}-01`;
    const dataTo   = `${ano}-${mm}-31`;
    const extTo    = new Date(`${ano}-${mm}-28`);
    extTo.setDate(extTo.getDate() + 60);
    const dataToExt = extTo.toISOString().split('T')[0];

    const nfs = await db.prepare(`
      SELECT id, numero, tomador, valor_bruto, valor_liquido,
             data_emissao, competencia, status_conciliacao, extrato_id
      FROM notas_fiscais
      WHERE data_emissao >= ? AND data_emissao <= ?
        AND valor_bruto > 0
        AND UPPER(COALESCE(status_conciliacao,'')) != 'ASSESSORIA'
      ORDER BY tomador, data_emissao
    `).all(dataFrom, dataTo);

    // Agrupa por tomador
    const groups = {};
    for (const nf of nfs) {
      const key = (nf.tomador || 'SEM TOMADOR').trim().toUpperCase();
      if (!groups[key]) groups[key] = { tomador: key, nfs: [], faturado: 0 };
      groups[key].nfs.push(nf);
      groups[key].faturado += nf.valor_bruto || 0;
    }

    const resultado = [];

    for (const grupo of Object.values(groups)) {
      const keyword = tomadorKeyword(grupo.tomador);
      let recebido = 0;

      // Método 1: links diretos (extrato_id definido)
      for (const nf of grupo.nfs.filter(n => n.extrato_id)) {
        const ext = await db.prepare(`SELECT COALESCE(credito,0) credito FROM extratos WHERE id=?`).get(nf.extrato_id);
        if (ext) recebido += ext.credito;
      }

      // Método 2: heurística para NFs sem link
      const semLink = grupo.nfs.filter(n => !n.extrato_id);
      recebido += matchCreditos(db, semLink, keyword, dataFrom, dataToExt);

      const faturado = grupo.faturado;
      const em_aberto = Math.max(faturado - recebido, 0);

      const nfsSemPag = grupo.nfs.filter(n => !n.extrato_id);
      const maisAntiga = nfsSemPag.sort((a, b) =>
        (a.data_emissao || '').localeCompare(b.data_emissao || '')
      )[0];
      const dias_em_aberto = maisAntiga ? diasDesde(maisAntiga.data_emissao) : 0;

      resultado.push({
        tomador: grupo.tomador,
        qtd_nfs: grupo.nfs.length,
        faturado: +faturado.toFixed(2),
        recebido: +recebido.toFixed(2),
        em_aberto: +em_aberto.toFixed(2),
        pct_recebido: faturado > 0 ? +(recebido / faturado * 100).toFixed(1) : 0,
        status: calcStatus(faturado, recebido, dias_em_aberto),
        dias_em_aberto,
      });
    }

    resultado.sort((a, b) => b.em_aberto - a.em_aberto);

    const kpis = {
      total_faturado:   +resultado.reduce((s, r) => s + r.faturado,   0).toFixed(2),
      total_recebido:   +resultado.reduce((s, r) => s + r.recebido,   0).toFixed(2),
      total_em_aberto:  +resultado.reduce((s, r) => s + r.em_aberto,  0).toFixed(2),
      inadimplentes:    resultado.filter(r => r.status === 'VENCIDO').length,
    };

    res.json({ ok: true, mes, kpis, tomadores: resultado });
  } catch (e) {
    console.error('[pagamentos-contrato/resumo]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── 2. Histórico mês a mês para um tomador ──────────────────────
router.get('/historico', async (req, res) => {
  try {
    const db = req.db;
    const { tomador, meses = 6 } = req.query;
    if (!tomador) return res.status(400).json({ error: 'Parâmetro tomador obrigatório' });

    const numMeses = Math.min(parseInt(meses) || 6, 24);
    const resultado = [];
    const hoje = new Date();
    const keyword = tomadorKeyword(tomador);

    for (let i = numMeses - 1; i >= 0; i--) {
      const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
      const ano = d.getFullYear();
      const mm  = String(d.getMonth() + 1).padStart(2, '0');
      const mesStr  = `${ano}-${mm}`;
      const dataFrom = `${ano}-${mm}-01`;
      const dataTo   = `${ano}-${mm}-31`;
      const extTo    = new Date(d.getFullYear(), d.getMonth() + 2, 28);
      const dataToExt = extTo.toISOString().split('T')[0];

      const nfs = await db.prepare(`
        SELECT id, valor_bruto, valor_liquido, data_emissao, extrato_id
        FROM notas_fiscais
        WHERE data_emissao >= ? AND data_emissao <= ?
          AND valor_bruto > 0
          AND UPPER(TRIM(tomador)) LIKE ?
          AND UPPER(COALESCE(status_conciliacao,'')) != 'ASSESSORIA'
      `).all(dataFrom, dataTo, `%${tomador.trim().toUpperCase()}%`);

      let faturado = nfs.reduce((s, n) => s + (n.valor_bruto || 0), 0);
      let recebido = 0;

      for (const nf of nfs.filter(n => n.extrato_id)) {
        const ext = await db.prepare(`SELECT COALESCE(credito,0) c FROM extratos WHERE id=?`).get(nf.extrato_id);
        if (ext) recebido += ext.c;
      }

      recebido += matchCreditos(db, nfs.filter(n => !n.extrato_id), keyword, dataFrom, dataToExt);

      resultado.push({
        mes: mesStr,
        faturado: +faturado.toFixed(2),
        recebido: +recebido.toFixed(2),
        em_aberto: +Math.max(faturado - recebido, 0).toFixed(2),
        qtd_nfs: nfs.length,
        status: calcStatus(faturado, recebido, 0),
      });
    }

    res.json({ ok: true, tomador: tomador.toUpperCase(), historico: resultado });
  } catch (e) {
    console.error('[pagamentos-contrato/historico]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── 3. Inadimplentes (saldo > 0 há mais de 30 dias) ─────────────
router.get('/inadimplentes', async (req, res) => {
  try {
    const db = req.db;
    const hoje = new Date().toISOString().split('T')[0];
    const inicio = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];

    const nfs = await db.prepare(`
      SELECT id, numero, tomador, valor_bruto, valor_liquido, data_emissao, extrato_id
      FROM notas_fiscais
      WHERE data_emissao >= ?
        AND valor_bruto > 0
        AND UPPER(COALESCE(status_conciliacao,'')) != 'ASSESSORIA'
      ORDER BY tomador, data_emissao
    `).all(inicio);

    const groups = {};
    for (const nf of nfs) {
      const key = (nf.tomador || 'SEM TOMADOR').trim().toUpperCase();
      if (!groups[key]) groups[key] = { tomador: key, nfs: [] };
      groups[key].nfs.push(nf);
    }

    const inadimplentes = [];

    for (const grupo of Object.values(groups)) {
      let faturado = grupo.nfs.reduce((s, n) => s + (n.valor_bruto || 0), 0);
      let recebido = 0;

      for (const nf of grupo.nfs.filter(n => n.extrato_id)) {
        const ext = await db.prepare(`SELECT COALESCE(credito,0) credito FROM extratos WHERE id=?`).get(nf.extrato_id);
        if (ext) recebido += ext.credito;
      }

      const semLink = grupo.nfs.filter(n => !n.extrato_id);
      if (semLink.length > 0) {
        const keyword = tomadorKeyword(grupo.tomador);
        const dataFromH = semLink.sort((a, b) => a.data_emissao.localeCompare(b.data_emissao))[0].data_emissao;
        recebido += matchCreditos(db, semLink, keyword, dataFromH, hoje);
      }

      const em_aberto = Math.max(faturado - recebido, 0);
      if (em_aberto < 1) continue;

      const semPag = grupo.nfs.filter(n => !n.extrato_id);
      const maisAntiga = semPag.sort((a, b) => a.data_emissao.localeCompare(b.data_emissao))[0];
      const dias_em_aberto = maisAntiga ? diasDesde(maisAntiga.data_emissao) : 0;
      if (dias_em_aberto <= 30) continue;

      inadimplentes.push({
        tomador: grupo.tomador,
        qtd_nfs: grupo.nfs.length,
        qtd_sem_pagamento: semPag.length,
        faturado: +faturado.toFixed(2),
        recebido: +recebido.toFixed(2),
        em_aberto: +em_aberto.toFixed(2),
        dias_em_aberto,
        data_nf_mais_antiga: maisAntiga?.data_emissao || '',
      });
    }

    inadimplentes.sort((a, b) => b.em_aberto - a.em_aberto);
    res.json({ ok: true, total: inadimplentes.length, inadimplentes });
  } catch (e) {
    console.error('[pagamentos-contrato/inadimplentes]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── 4. Detalhe NF×Pagamento para tomador/competência ─────────────
router.get('/detalhe', async (req, res) => {
  try {
    const db = req.db;
    const { tomador, competencia } = req.query;
    if (!tomador || !competencia)
      return res.status(400).json({ error: 'Parâmetros tomador e competencia obrigatórios' });

    const [ano, mm] = competencia.split('-');
    const mmP = mm.padStart(2, '0');
    const dataFrom = `${ano}-${mmP}-01`;
    const dataTo   = `${ano}-${mmP}-31`;
    const extTo    = new Date(`${ano}-${mmP}-28`);
    extTo.setDate(extTo.getDate() + 60);
    const dataToExt = extTo.toISOString().split('T')[0];
    const keyword = tomadorKeyword(tomador);

    const nfs = await db.prepare(`
      SELECT id, numero, tomador, valor_bruto, valor_liquido,
             data_emissao, competencia, status_conciliacao, extrato_id
      FROM notas_fiscais
      WHERE data_emissao >= ? AND data_emissao <= ?
        AND UPPER(TRIM(tomador)) LIKE ?
        AND valor_bruto > 0
        AND UPPER(COALESCE(status_conciliacao,'')) != 'ASSESSORIA'
      ORDER BY data_emissao
    `).all(dataFrom, dataTo, `%${tomador.trim().toUpperCase()}%`);

    const creditos = keyword ? await db.prepare(`
      SELECT id, data_iso, historico, credito
      FROM extratos
      WHERE data_iso >= ? AND data_iso <= ?
        AND credito > 0
        AND UPPER(historico) LIKE ?
      ORDER BY data_iso
    `).all(dataFrom, dataToExt, `%${keyword}%`) : [];

    const usadosExt = new Set();

    const nfDetalhe = nfs.map(nf => {
      let match = null;
      if (nf.extrato_id) {
        const ext = await db.prepare(`SELECT id, data_iso, historico, credito FROM extratos WHERE id=?`).get(nf.extrato_id);
        if (ext) { match = ext; usadosExt.add(ext.id); }
      } else {
        const target = nf.valor_liquido > 0 ? nf.valor_liquido : nf.valor_bruto;
        const tol    = Math.max(target * 0.10, 50);
        const found  = creditos.find(c => !usadosExt.has(c.id) && Math.abs(c.credito - target) <= tol);
        if (found) { match = found; usadosExt.add(found.id); }
      }

      const pago   = match ? match.credito : 0;
      const status = calcStatus(nf.valor_bruto, pago, diasDesde(nf.data_emissao));

      return {
        id:              nf.id,
        numero:          nf.numero,
        valor_bruto:     nf.valor_bruto,
        valor_liquido:   nf.valor_liquido,
        data_emissao:    nf.data_emissao,
        status,
        pago,
        extrato_id:      match?.id || null,
        data_pagamento:  match?.data_iso || null,
        historico_pgto:  match?.historico || null,
      };
    });

    const creditosNaoAlocados = creditos.filter(c => !usadosExt.has(c.id));

    res.json({
      ok: true,
      tomador: tomador.toUpperCase(),
      competencia,
      nfs: nfDetalhe,
      creditos_encontrados: creditos.length,
      creditos_nao_alocados: creditosNaoAlocados,
    });
  } catch (e) {
    console.error('[pagamentos-contrato/detalhe]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
