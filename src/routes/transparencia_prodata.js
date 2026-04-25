/**
 * Montana - Rotas /api/transparencia/prodata/*
 * Portal Transparência Palmas (SIG-Prodata) — read-only para UI.
 * Coleta roda via cron (/opt/montana/scripts/transparencia_coletor_prodata.js).
 */
const express = require('express');
const companyMw = require('../companyMiddleware');

const FONTE = 'prodata-palmas';

const router = express.Router();
router.use(companyMw);

// GET /status — contagens gerais
router.get('/status', async (req, res) => {
  try {
    const stats = await req.db.prepare(`
      SELECT COUNT(*) as qtd,
             ROUND(SUM(valor_pago), 2) as total_pago,
             MIN(data_pagamento) as primeiro,
             MAX(data_pagamento) as ultimo,
             COUNT(DISTINCT fornecedor_cnpj) as fornecedores
      FROM transparencia_pagamentos
      WHERE fonte_portal = ?
    `).get(FONTE);

    const porStatus = await req.db.prepare(`
      SELECT status_match, COUNT(*) as qtd, ROUND(SUM(valor_pago), 2) as valor
      FROM transparencia_pagamentos
      WHERE fonte_portal = ?
      GROUP BY status_match
    `).all(FONTE);

    const ultimaColeta = await req.db.prepare(`
      SELECT coletado_em, COUNT(*) as novos
      FROM transparencia_pagamentos
      WHERE fonte_portal = ?
      GROUP BY date(coletado_em)
      ORDER BY coletado_em DESC LIMIT 1
    `).get(FONTE);

    res.json({
      ok: true,
      portal: 'SIG-Prodata - Palmas/TO',
      fonte_portal: FONTE,
      estatisticas: stats,
      por_status: porStatus,
      ultima_coleta: ultimaColeta,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /pagamentos?cnpj=&ano=&mes=&status=
router.get('/pagamentos', async (req, res) => {
  const cnpj = (req.query.cnpj || '').replace(/\D/g, '');
  const ano = parseInt(req.query.ano) || null;
  const mes = parseInt(req.query.mes) || null;
  const status = req.query.status || null;
  const limit = Math.min(parseInt(req.query.limit) || 500, 2000);

  const where = ['fonte_portal = ?'];
  const params = [FONTE];
  if (cnpj) { where.push('fornecedor_cnpj = ?'); params.push(cnpj); }
  if (ano)  { where.push('ano = ?');            params.push(ano); }
  if (mes)  { where.push('mes = ?');            params.push(mes); }
  if (status) { where.push('status_match = ?'); params.push(status); }

  try {
    const rows = await req.db.prepare(`
      SELECT id, numero_empenho, numero_liquidacao, numero_pagamento, processo,
             data_empenho, data_liquidacao, data_pagamento,
             valor_empenhado, valor_liquidado, valor_pago,
             fornecedor_nome, fornecedor_cnpj,
             gestao, fonte_recurso, elemento_despesa, objeto,
             status_match, contrato_ref, ano, mes,
             coletado_em
      FROM transparencia_pagamentos
      WHERE ${where.join(' AND ')}
      ORDER BY data_pagamento DESC, id DESC
      LIMIT ?
    `).all(...params, limit);

    const total = rows.reduce((s, r) => s + (r.valor_pago || 0), 0);
    res.json({
      filtros: { cnpj, ano, mes, status, limit },
      total_registros: rows.length,
      total_valor_pago: Number(total.toFixed(2)),
      data: rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /resumo — agregado por ano/mês
router.get('/resumo', async (req, res) => {
  try {
    const rows = await req.db.prepare(`
      SELECT ano, mes,
             COUNT(*) as qtd,
             ROUND(SUM(valor_empenhado), 2) as empenhado,
             ROUND(SUM(valor_liquidado), 2) as liquidado,
             ROUND(SUM(valor_pago), 2) as pago,
             SUM(CASE WHEN status_match='conciliado' THEN 1 ELSE 0 END) as conciliados,
             SUM(CASE WHEN status_match='pendente' THEN 1 ELSE 0 END) as pendentes
      FROM transparencia_pagamentos
      WHERE fonte_portal = ?
      GROUP BY ano, mes
      ORDER BY ano DESC, mes DESC
    `).all(FONTE);
    res.json({ data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /matches — pagamentos conciliados com créditos de extrato
router.get('/matches', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
  try {
    const rows = await req.db.prepare(`
      SELECT p.id as pgto_id, p.numero_empenho, p.numero_pagamento,
             p.data_pagamento, p.valor_pago,
             p.fornecedor_nome, p.fornecedor_cnpj, p.objeto,
             l.metodo_match, l.confianca, l.diff_dias,
             l.extrato_id, l.data_credito, l.valor as valor_matched
      FROM transparencia_extrato_link l
      JOIN transparencia_pagamentos p ON p.id = l.transparencia_id
      WHERE p.fonte_portal = ?
      ORDER BY p.data_pagamento DESC
      LIMIT ?
    `).all(FONTE, limit);

    const porMetodo = {};
    for (const r of rows) {
      porMetodo[r.metodo_match] = (porMetodo[r.metodo_match] || 0) + 1;
    }

    res.json({
      total: rows.length,
      por_metodo: porMetodo,
      data: rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /pendentes — pagamentos portal sem credito correspondente
router.get('/pendentes', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 500, 2000);
  try {
    const rows = await req.db.prepare(`
      SELECT p.id, p.numero_empenho, p.numero_pagamento,
             p.data_pagamento, p.valor_pago,
             p.fornecedor_nome, p.fornecedor_cnpj, p.objeto,
             p.ano, p.mes
      FROM transparencia_pagamentos p
      LEFT JOIN transparencia_extrato_link l ON l.transparencia_id = p.id
      WHERE p.fonte_portal = ? AND l.id IS NULL
      ORDER BY p.data_pagamento DESC
      LIMIT ?
    `).all(FONTE, limit);

    const total = rows.reduce((s, r) => s + (r.valor_pago || 0), 0);
    res.json({
      total_registros: rows.length,
      total_valor: Number(total.toFixed(2)),
      data: rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /reconciliar?cnpj=
router.get('/reconciliar', async (req, res) => {
  const cnpj = (req.query.cnpj || '').replace(/\D/g, '');
  try {
    const pgtosPorMes = await req.db.prepare(`
      SELECT ano, mes,
             COUNT(*) as qtd,
             ROUND(SUM(valor_pago), 2) as pago,
             SUM(CASE WHEN status_match='conciliado' THEN 1 ELSE 0 END) as conciliados,
             ROUND(SUM(CASE WHEN status_match='conciliado' THEN valor_pago ELSE 0 END), 2) as pago_conciliado
      FROM transparencia_pagamentos
      WHERE fonte_portal = ?
      ${cnpj ? 'AND fornecedor_cnpj = ?' : ''}
      GROUP BY ano, mes
      ORDER BY ano, mes
    `).all(...(cnpj ? [FONTE, cnpj] : [FONTE]));

    const nfsPorMes = await req.db.prepare(`
      SELECT substr(data_emissao, 1, 7) as mes,
             COUNT(*) as qtd,
             ROUND(SUM(valor_bruto), 2) as bruto,
             ROUND(SUM(valor_liquido), 2) as liq
      FROM notas_fiscais
      WHERE (tomador LIKE '%PALMAS%' OR cnpj_tomador LIKE '%24851511%')
        AND data_emissao >= '2025-01-01'
      GROUP BY mes
    `).all();

    const pgMap = {};
    pgtosPorMes.forEach(p => {
      const k = p.ano + '-' + String(p.mes).padStart(2, '0');
      pgMap[k] = p;
    });
    const nfMap = {};
    nfsPorMes.forEach(n => { nfMap[n.mes] = n; });

    const meses = [...new Set([...Object.keys(pgMap), ...Object.keys(nfMap)])].sort();
    const comparativo = meses.map(mes => {
      const pg = pgMap[mes] || { qtd: 0, pago: 0, conciliados: 0, pago_conciliado: 0 };
      const nf = nfMap[mes] || { qtd: 0, bruto: 0, liq: 0 };
      return {
        mes,
        portal_qtd: pg.qtd,
        portal_pago: pg.pago,
        portal_conciliados: pg.conciliados,
        portal_pago_conciliado: pg.pago_conciliado,
        nf_qtd: nf.qtd,
        nf_valor_bruto: nf.bruto,
        nf_valor_liquido: nf.liq,
        dif_pago_liquido: Number(((pg.pago || 0) - (nf.liq || 0)).toFixed(2)),
      };
    });

    const totalPago = pgtosPorMes.reduce((s, p) => s + (p.pago || 0), 0);
    const totalConc = pgtosPorMes.reduce((s, p) => s + (p.pago_conciliado || 0), 0);
    const totalNfLiq = nfsPorMes.reduce((s, n) => s + (n.liq || 0), 0);

    res.json({
      cnpj,
      totais: {
        portal_total_pago: Number(totalPago.toFixed(2)),
        portal_total_conciliado: Number(totalConc.toFixed(2)),
        portal_pct_conciliado: totalPago ? Number(((totalConc / totalPago) * 100).toFixed(1)) : 0,
        nf_total_liquido: Number(totalNfLiq.toFixed(2)),
        diferenca_portal_nf: Number((totalPago - totalNfLiq).toFixed(2)),
      },
      comparativo_mensal: comparativo,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
