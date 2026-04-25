/**
 * Montana — Middleware de resolução de empresa
 * Lê header X-Company ou query ?company= e injeta req.db, req.company, req.companyKey.
 */
const { getDb, COMPANIES } = require('./db_pg');

module.exports = function companyMiddleware(req, res, next) {
  const companyKey = (req.headers['x-company'] || req.query.company || 'seguranca').toLowerCase();
  if (!COMPANIES[companyKey]) {
    return res.status(400).json({ error: 'Empresa inválida: ' + companyKey + '. Use: assessoria | seguranca' });
  }
  req.companyKey = companyKey;
  req.company = COMPANIES[companyKey];
  req.db = getDb(companyKey);
  next();
};
