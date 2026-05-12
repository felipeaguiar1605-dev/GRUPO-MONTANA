/**
 * Montana ERP — Contas a Pagar
 * Usa a tabela `despesas` com status PENDENTE como base.
 * A coluna `data_iso` (data da despesa) serve como data de vencimento.
 *
 * Criado: 2026-05-05
 */
'use strict';
const express   = require('express');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

// GET /api/contas-pagar/resumo
// Retorna contagens e totais por situação
router.get('/resumo', async (req, res) => {
  const db = req.db;
  try {
    const vencidas = await db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(valor_bruto),0) as total
      FROM despesas
      WHERE status != 'PAGO'
        AND data_iso IS NOT NULL AND data_iso != ''
        AND safe_date(data_iso) < CURRENT_DATE
    `).get();

    const semana = await db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(valor_bruto),0) as total
      FROM despesas
      WHERE status != 'PAGO'
        AND data_iso IS NOT NULL AND data_iso != ''
        AND safe_date(data_iso) >= CURRENT_DATE
        AND safe_date(data_iso) <= CURRENT_DATE + INTERVAL '7 days'
    `).get();

    const trinta = await db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(valor_bruto),0) as total
      FROM despesas
      WHERE status != 'PAGO'
        AND data_iso IS NOT NULL AND data_iso != ''
        AND safe_date(data_iso) > CURRENT_DATE + INTERVAL '7 days'
        AND safe_date(data_iso) <= CURRENT_DATE + INTERVAL '30 days'
    `).get();

    const total_pendente = await db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(valor_bruto),0) as total
      FROM despesas WHERE status != 'PAGO'
    `).get();

    res.json({
      ok: true,
      vencidas:      { count: vencidas?.count ?? 0,      total: vencidas?.total ?? 0 },
      semana:        { count: semana?.count ?? 0,         total: semana?.total ?? 0 },
      trinta_dias:   { count: trinta?.count ?? 0,         total: trinta?.total ?? 0 },
      total_pendente:{ count: total_pendente?.count ?? 0, total: total_pendente?.total ?? 0 },
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/contas-pagar/aging
// Lista despesas pendentes com aging em dias, ordenada por data_iso ASC
router.get('/aging', async (req, res) => {
  const db = req.db;
  const { situacao, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let whereExtra = '';
  if (situacao === 'vencidas') {
    whereExtra = ` AND safe_date(data_iso) < CURRENT_DATE`;
  } else if (situacao === 'semana') {
    whereExtra = ` AND safe_date(data_iso) >= CURRENT_DATE AND safe_date(data_iso) <= CURRENT_DATE + INTERVAL '7 days'`;
  } else if (situacao === 'trinta') {
    whereExtra = ` AND safe_date(data_iso) > CURRENT_DATE + INTERVAL '7 days' AND safe_date(data_iso) <= CURRENT_DATE + INTERVAL '30 days'`;
  }

  try {
    const countRow = await db.prepare(`
      SELECT COUNT(*) as cnt FROM despesas
      WHERE status != 'PAGO' AND data_iso IS NOT NULL AND data_iso != ''
      ${whereExtra}
    `).get();
    const total = countRow?.cnt ?? 0;

    const rows = await db.prepare(`
      SELECT
        id, descricao, categoria, fornecedor, data_iso, valor_bruto, valor_liquido,
        status, contrato_ref, centro_custo,
        (CURRENT_DATE - safe_date(data_iso)) AS aging_dias
      FROM despesas
      WHERE status != 'PAGO' AND data_iso IS NOT NULL AND data_iso != ''
      ${whereExtra}
      ORDER BY data_iso ASC
      LIMIT $1 OFFSET $2
    `).all(parseInt(limit), offset);

    res.json({
      ok: true,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
      data: rows,
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/contas-pagar/alertas
// Retorna apenas vencidas + vencendo nesta semana (para widget no dashboard)
router.get('/alertas', async (req, res) => {
  const db = req.db;
  try {
    const rows = await db.prepare(`
      SELECT
        id, descricao, categoria, fornecedor, data_iso, valor_bruto,
        (CURRENT_DATE - safe_date(data_iso)) AS aging_dias
      FROM despesas
      WHERE status != 'PAGO'
        AND data_iso IS NOT NULL AND data_iso != ''
        AND safe_date(data_iso) <= CURRENT_DATE + INTERVAL '7 days'
      ORDER BY data_iso ASC
      LIMIT 20
    `).all();

    res.json({ ok: true, data: rows });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
