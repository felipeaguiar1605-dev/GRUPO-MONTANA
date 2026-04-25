/**
 * Montana ERP — Rotas REST para Fluxo de Caixa Projetado
 *
 * GET /api/fluxo-caixa/projecao?dias=90&periodicidade=mensal|semanal&incluir_itens=1
 * GET /api/fluxo-caixa/projecao/entradas  → lista detalhada (NFs a receber)
 * GET /api/fluxo-caixa/projecao/saidas    → lista detalhada (folha + despesas recorrentes)
 * GET /api/fluxo-caixa/projecao/slas      → SLAs médios por tomador
 */

const express   = require('express');
const companyMw = require('../companyMiddleware');
const fc        = require('../fluxo-caixa-projetado');

const router = express.Router();
router.use(companyMw);

router.get('/projecao', (req, res) => {
  try {
    const opts = {
      dias:          req.query.dias ? Number(req.query.dias) : 90,
      periodicidade: req.query.periodicidade || 'mensal',
      incluir_itens: req.query.incluir_itens === '1' || req.query.incluir_itens === 'true',
    };
    const r = fc.projecaoFluxoCaixa(req.db, req.company, opts);
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error('[fluxo-caixa-projetado]', e);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

router.get('/projecao/entradas', (req, res) => {
  try {
    const dias = req.query.dias ? Number(req.query.dias) : 90;
    const itens = fc.projectarEntradas(req.db, dias);
    res.json({ ok: true, total: itens.length, itens });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

router.get('/projecao/saidas', (req, res) => {
  try {
    const dias = req.query.dias ? Number(req.query.dias) : 90;
    const itens = fc.projectarSaidas(req.db, dias);
    res.json({ ok: true, total: itens.length, itens });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

router.get('/projecao/slas', (req, res) => {
  try {
    const slas = fc.calcularSLAs(req.db);
    res.json({ ok: true, slas: Object.fromEntries(slas) });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

module.exports = router;
