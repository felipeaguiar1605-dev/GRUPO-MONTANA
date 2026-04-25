/**
 * Montana - Rotas de Auditoria
 * ------------------------------
 * Permite admin/auditor consultar logs:
 *   - audit_log           (escritas manuais)
 *   - audit_log_routes    (automatico via middleware)
 *   - audit_authz_negado  (tentativas de acesso negado)
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

const JWT_SECRET = process.env.JWT_SECRET || 'montana_seg_secret_2026_!xK9#';

function soAdminOuAuditor(req, res, next) {
  const h = req.headers['authorization'];
  if (!h || !h.startsWith('Bearer ')) return res.status(401).json({ error: 'Token necessario' });
  try {
    const dec = jwt.verify(h.slice(7), JWT_SECRET);
    if (!['admin', 'auditor', 'diretoria'].includes(dec.role)) {
      return res.status(403).json({ error: 'Acesso negado. Role admin/auditor/diretoria necessario.' });
    }
    req.usuario = dec;
    next();
  } catch { return res.status(401).json({ error: 'Token invalido' }); }
}

router.use(soAdminOuAuditor);

function parseFiltros(q) {
  return {
    usuario: q.usuario || '',
    desde: q.desde || '',
    ate: q.ate || '',
    limit: Math.min(parseInt(q.limit) || 100, 500),
    offset: parseInt(q.offset) || 0,
  };
}

// GET /api/auditoria/resumo
router.get('/resumo', async (req, res) => {
  const db = req.db;
  const resumo = {};

  const safe = async (sql, fallback = 0) => {
    try { const r = await db.prepare(sql).get(); return r ? (r.total !== undefined ? r.total : r) : fallback; }
    catch { return fallback; }
  };

  resumo.escritas_24h = safe("SELECT COUNT(*) as total FROM audit_log_routes WHERE created_at >= datetime('now','-1 day','localtime')");
  resumo.escritas_7d  = safe("SELECT COUNT(*) as total FROM audit_log_routes WHERE created_at >= datetime('now','-7 days','localtime')");
  resumo.escritas_30d = safe("SELECT COUNT(*) as total FROM audit_log_routes WHERE created_at >= datetime('now','-30 days','localtime')");
  resumo.negacoes_24h = safe("SELECT COUNT(*) as total FROM audit_authz_negado WHERE created_at >= datetime('now','-1 day','localtime')");
  resumo.negacoes_7d  = safe("SELECT COUNT(*) as total FROM audit_authz_negado WHERE created_at >= datetime('now','-7 days','localtime')");

  try {
    resumo.top_usuarios_7d = db.prepare(
      "SELECT usuario, COUNT(*) as total FROM audit_log_routes WHERE created_at >= datetime('now','-7 days','localtime') GROUP BY usuario ORDER BY total DESC LIMIT 10"
    ).all();
    resumo.top_rotas_7d = db.prepare(
      "SELECT metodo, rota, COUNT(*) as total FROM audit_log_routes WHERE created_at >= datetime('now','-7 days','localtime') GROUP BY metodo, rota ORDER BY total DESC LIMIT 15"
    ).all();
  } catch (e) { resumo.erro = e.message; }

  res.json(resumo);
});

// GET /api/auditoria/routes
router.get('/routes', async (req, res) => {
  const f = parseFiltros(req.query);
  const where = [];
  const params = [];
  if (f.usuario) { where.push('usuario LIKE ?'); params.push('%' + f.usuario + '%'); }
  if (f.desde)   { where.push('created_at >= ?'); params.push(f.desde); }
  if (f.ate)     { where.push('created_at <= ?'); params.push(f.ate); }
  if (req.query.metodo) { where.push('metodo = ?'); params.push(req.query.metodo.toUpperCase()); }
  if (req.query.rota)   { where.push('rota LIKE ?'); params.push('%' + req.query.rota + '%'); }

  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  try {
    const total = await req.db.prepare('SELECT COUNT(*) as t FROM audit_log_routes ' + W).get(...params).t;
    const rows = req.db.prepare(
      'SELECT id, usuario, metodo, rota, body_resumo, ip, created_at FROM audit_log_routes ' + W + ' ORDER BY id DESC LIMIT ? OFFSET ?'
    ).all(...params, f.limit, f.offset);
    res.json({ total, limit: f.limit, offset: f.offset, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auditoria/authz-negado
router.get('/authz-negado', async (req, res) => {
  const f = parseFiltros(req.query);
  const where = [];
  const params = [];
  if (f.usuario) { where.push('usuario LIKE ?'); params.push('%' + f.usuario + '%'); }
  if (f.desde)   { where.push('created_at >= ?'); params.push(f.desde); }
  if (f.ate)     { where.push('created_at <= ?'); params.push(f.ate); }
  if (req.query.motivo) { where.push('motivo = ?'); params.push(req.query.motivo); }
  if (req.query.dry_run !== undefined) { where.push('dry_run = ?'); params.push(req.query.dry_run === 'true' ? 1 : 0); }

  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  try {
    const total = await req.db.prepare('SELECT COUNT(*) as t FROM audit_authz_negado ' + W).get(...params).t;
    const rows = req.db.prepare(
      'SELECT id, usuario, role, empresa_req, lotacao, metodo, rota, modulo, acao, motivo, dry_run, ip, created_at FROM audit_authz_negado ' + W + ' ORDER BY id DESC LIMIT ? OFFSET ?'
    ).all(...params, f.limit, f.offset);
    res.json({ total, limit: f.limit, offset: f.offset, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auditoria/log
router.get('/log', async (req, res) => {
  const f = parseFiltros(req.query);
  const where = [];
  const params = [];
  if (f.usuario) { where.push('usuario LIKE ?'); params.push('%' + f.usuario + '%'); }
  if (f.desde)   { where.push('created_at >= ?'); params.push(f.desde); }
  if (f.ate)     { where.push('created_at <= ?'); params.push(f.ate); }
  if (req.query.tabela) { where.push('tabela = ?'); params.push(req.query.tabela); }
  if (req.query.acao)   { where.push('acao = ?'); params.push(req.query.acao); }

  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  try {
    const total = await req.db.prepare('SELECT COUNT(*) as t FROM audit_log ' + W).get(...params).t;
    const rows = req.db.prepare(
      'SELECT id, usuario, acao, tabela, registro_id, detalhe, ip, created_at FROM audit_log ' + W + ' ORDER BY id DESC LIMIT ? OFFSET ?'
    ).all(...params, f.limit, f.offset);
    res.json({ total, limit: f.limit, offset: f.offset, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auditoria/export?tipo=routes&formato=csv
router.get('/export', async (req, res) => {
  const tipo = (req.query.tipo || 'routes').toLowerCase();
  const formato = (req.query.formato || 'csv').toLowerCase();

  const tabelas = {
    routes: { tabela: 'audit_log_routes', colunas: ['id','usuario','metodo','rota','body_resumo','ip','created_at'] },
    authz:  { tabela: 'audit_authz_negado', colunas: ['id','usuario','role','empresa_req','metodo','rota','modulo','acao','motivo','dry_run','ip','created_at'] },
    log:    { tabela: 'audit_log', colunas: ['id','usuario','acao','tabela','registro_id','detalhe','ip','created_at'] },
  };
  const cfg = tabelas[tipo];
  if (!cfg) return res.status(400).json({ error: 'tipo deve ser: routes | authz | log' });

  try {
    const rows = req.db.prepare(
      'SELECT ' + cfg.colunas.join(',') + ' FROM ' + cfg.tabela + ' ORDER BY id DESC LIMIT 10000'
    ).all();

    if (formato === 'json') return res.json({ total: rows.length, data: rows });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="auditoria_' + tipo + '_' + Date.now() + '.csv"');
    res.write('\uFEFF');
    res.write(cfg.colunas.join(';') + '\n');
    for (const r of rows) {
      res.write(cfg.colunas.map(c => {
        const v = r[c];
        if (v === null || v === undefined) return '';
        const s = String(v).replace(/"/g, '""');
        return /[;\n"]/.test(s) ? '"' + s + '"' : s;
      }).join(';') + '\n');
    }
    res.end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// GET /api/auditoria/alteracoes - Historico de mudancas em campos criticos
router.get('/alteracoes', async (req, res) => {
  const f = parseFiltros(req.query);
  const where = [];
  const params = [];
  if (f.usuario) { where.push('usuario LIKE ?'); params.push('%' + f.usuario + '%'); }
  if (f.desde)   { where.push('created_at >= ?'); params.push(f.desde); }
  if (f.ate)     { where.push('created_at <= ?'); params.push(f.ate); }
  if (req.query.tabela)      { where.push('tabela = ?'); params.push(req.query.tabela); }
  if (req.query.registro_id) { where.push('registro_id = ?'); params.push(req.query.registro_id); }
  if (req.query.campo)       { where.push('campo = ?'); params.push(req.query.campo); }

  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  try {
    const total = await req.db.prepare('SELECT COUNT(*) as t FROM registro_alteracoes ' + W).get(...params).t;
    const rows = req.db.prepare(
      'SELECT id, tabela, registro_id, campo, valor_antes, valor_depois, usuario, operacao, created_at FROM registro_alteracoes ' + W + ' ORDER BY id DESC LIMIT ? OFFSET ?'
    ).all(...params, f.limit, f.offset);
    res.json({ total, limit: f.limit, offset: f.offset, data: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auditoria/historico/:tabela/:id - timeline de 1 registro especifico
router.get('/historico/:tabela/:id', async (req, res) => {
  try {
    const rows = req.db.prepare(
      'SELECT campo, valor_antes, valor_depois, usuario, operacao, created_at FROM registro_alteracoes WHERE tabela = ? AND registro_id = ? ORDER BY id ASC'
    ).all(req.params.tabela, req.params.id);
    res.json({ tabela: req.params.tabela, registro_id: req.params.id, total: rows.length, historico: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
