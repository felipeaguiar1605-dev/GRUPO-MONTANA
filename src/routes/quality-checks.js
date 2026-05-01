/**
 * Montana ERP — Endpoint /api/quality-checks
 *
 * Mount em src/server.js APÓS authMiddleware:
 *   app.use('/api/quality-checks', require('./routes/quality-checks'));
 *
 * Endpoints:
 *   GET  /             — relatório completo (todas empresas)
 *   GET  /:empresa     — relatório de uma empresa só
 *   POST /run-classify — força auto-classify (admin only)
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const { COMPANIES } = require('../db');
const qc = require('../jobs/quality-checks');
const ac = require('../jobs/auto-classify');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'montana_seg_secret_2026_!xK9#';

function verifyToken(req, res) {
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Bearer ')) { res.status(401).json({ error: 'Token necessário' }); return null; }
  try { return jwt.verify(h.slice(7), JWT_SECRET); }
  catch { res.status(401).json({ error: 'Token inválido' }); return null; }
}

// GET /api/quality-checks — relatório de todas empresas
router.get('/', async (req, res) => {
  if (!verifyToken(req, res)) return;
  try {
    const reports = [];
    for (const key of Object.keys(COMPANIES)) {
      try { reports.push(await qc.checksEmpresa(key)); }
      catch (e) { reports.push({ empresa: key, error: e.message }); }
    }
    res.json({ ok: true, ts: new Date().toISOString(), reports });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/quality-checks/:empresa
router.get('/:empresa', async (req, res) => {
  if (!verifyToken(req, res)) return;
  const empresa = req.params.empresa.toLowerCase();
  if (!COMPANIES[empresa]) return res.status(404).json({ error: 'Empresa desconhecida' });
  try {
    const r = await qc.checksEmpresa(empresa);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/quality-checks/run-classify — força auto-classify (admin)
// Body: { empresa?: 'seguranca', dry_run?: false, since?: '2026-01-01' }
router.post('/run-classify', async (req, res) => {
  const tok = verifyToken(req, res);
  if (!tok) return;
  if (tok.role !== 'admin') return res.status(403).json({ error: 'Apenas admin' });

  const { empresa, dry_run = false, since } = req.body || {};
  const empresas = empresa ? [empresa] : Object.keys(COMPANIES);
  const opts = { apply: !dry_run, since };

  const total = { saldo: 0, sinal_invertido: 0, financeira: 0, intragrupo: 0, retirada_socio: 0, duplicata: 0 };
  const detalhe = {};
  for (const k of empresas) {
    if (!COMPANIES[k]) continue;
    try {
      const s = await ac.classifyEmpresa(k, opts);
      detalhe[k] = s;
      for (const key of Object.keys(total)) total[key] += s[key] || 0;
    } catch (e) {
      detalhe[k] = { error: e.message };
    }
  }

  res.json({ ok: true, dry_run, total, detalhe });
});

module.exports = router;
