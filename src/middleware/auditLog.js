/**
 * Montana — Middleware de Auditoria
 * Registra todas as operações de escrita (POST, PUT, PATCH, DELETE) na tabela audit_log.
 * A tabela é criada em cada banco de empresa no startup.
 */
const { getDb, COMPANIES } = require('../db');

// ── Cria tabela audit_log em todos os bancos no require() ─────────
const AUDIT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS audit_log_routes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa     TEXT DEFAULT '',
    usuario     TEXT DEFAULT 'anon',
    metodo      TEXT NOT NULL,
    rota        TEXT NOT NULL,
    body_resumo TEXT DEFAULT '',
    ip          TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  )
`;

const AUDIT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_audit_routes_created
    ON audit_log_routes(created_at)
`;

for (const key of Object.keys(COMPANIES)) {
  try {
    const db = getDb(key);
    db.exec(AUDIT_TABLE_SQL);
    db.exec(AUDIT_INDEX_SQL);
  } catch (_e) {
    // Banco pode não estar disponível ainda — ignora silenciosamente
  }
}

// ── Rotas a ignorar ───────────────────────────────────────────────
const ROTAS_IGNORADAS = [
  '/api/auth/login',
  '/api/auth/logout',
  '/api/notificacoes/log',
  '/api/logs',
];

function deveIgnorar(rota) {
  return ROTAS_IGNORADAS.some(r => rota.startsWith(r));
}

// ── Sanitiza body removendo campos sensíveis ──────────────────────
function sanitizarBody(body) {
  if (!body || typeof body !== 'object') return '';
  const copia = { ...body };
  delete copia.password;
  delete copia.senha;
  delete copia.pass;
  delete copia.token;
  delete copia.secret;

  try {
    const json = JSON.stringify(copia);
    return json.slice(0, 500);
  } catch (_) {
    return '';
  }
}

// ── Middleware principal ──────────────────────────────────────────
function auditMiddleware(req, res, next) {
  const metodo = req.method.toUpperCase();

  // Só audita escritas
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(metodo)) return next();

  // Ignora rotas excluídas
  const rota = req.originalUrl || req.url || '';
  if (deveIgnorar(rota)) return next();

  // Captura após a resposta ser enviada (não bloqueia a request)
  res.on('finish', () => {
    // Só registra operações que foram processadas com sucesso (2xx ou 3xx)
    // Erros 4xx/5xx também são registrados para auditoria
    try {
      const empresa = (req.companyKey ||
        (req.headers['x-company'] || req.query?.company || '').toLowerCase() ||
        'desconhecida');

      const usuario = (req.user?.username || req.user?.user || 'anon');
      const ip = req.ip ||
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.connection?.remoteAddress || '';

      const bodyResumo = sanitizarBody(req.body);

      // Tenta gravar no banco da empresa detectada
      const chaves = empresa && COMPANIES[empresa] ? [empresa] : Object.keys(COMPANIES);

      for (const key of chaves) {
        try {
          const db = getDb(key);
          db.prepare(`
            INSERT INTO audit_log_routes (empresa, usuario, metodo, rota, body_resumo, ip)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(empresa, usuario, metodo, rota, bodyResumo, ip);
          break; // Apenas um banco
        } catch (_e) {
          // Ignora falha de escrita individual
        }
      }
    } catch (_e) {
      // Nunca deixar o auditLog quebrar a aplicação
    }
  });

  next();
}

module.exports = auditMiddleware;
