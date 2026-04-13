/**
 * Montana — Middleware de resolução de empresa
 * Lê header X-Company ou query ?company= e injeta req.db, req.company, req.companyKey.
 */
const { getDb, COMPANIES } = require('./db');

module.exports = function companyMiddleware(req, res, next) {
  const raw = req.headers['x-company'] || req.query.company || '';
  const companyKey = raw.toLowerCase();
  if (!companyKey) {
    return res.status(400).json({ error: 'Header X-Company é obrigatório. Use: ' + Object.keys(COMPANIES).join(' | ') });
  }
  if (!COMPANIES[companyKey]) {
    return res.status(400).json({ error: 'Empresa inválida: ' + companyKey + '. Use: ' + Object.keys(COMPANIES).join(' | ') });
  }
  req.companyKey = companyKey;
  req.company = COMPANIES[companyKey];
  req.db = getDb(companyKey);
  next();
};
