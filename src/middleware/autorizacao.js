/**
 * Montana - Middleware de Autorizacao Granular
 * ---------------------------------------------
 * Aplica-se APOS authMiddleware (req.usuario ja populado).
 * Verifica empresa (header x-company) e modulo/acao do path.
 * Pode ser desligado via DISABLE_AUTHZ=true (emergencia).
 */
const { moduloDoPath, acaoDoMetodo, temAcessoEmpresa, temPermissao, ROLES } = require('./roles');
const { getDb, COMPANIES } = require('../db_pg');

// Rotas que nao passam por controle de modulo/acao (mantem auth JWT)
const ROTAS_ABERTAS = [
  '/api/auth/me',
  '/api/identity',
];

// Feature flag: ligar/desligar via env
const DISABLED = process.env.DISABLE_AUTHZ === 'true';

// Modo "dry-run": nao bloqueia, apenas loga. Use para validar antes de ligar.
const DRY_RUN = process.env.AUTHZ_DRY_RUN === 'true';

if (DISABLED) console.warn('[authz] DESABILITADO via DISABLE_AUTHZ');
if (DRY_RUN)  console.warn('[authz] DRY_RUN ativo - nao bloqueia');

// Tabela de log de acessos negados
function ensureLogTable() {
  for (const key of Object.keys(COMPANIES)) {
    try {
      const db = getDb(key);
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_authz_negado (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          usuario TEXT, role TEXT, empresa_req TEXT, lotacao TEXT,
          metodo TEXT, rota TEXT, modulo TEXT, acao TEXT,
          motivo TEXT, dry_run INTEGER DEFAULT 0,
          ip TEXT, created_at TEXT DEFAULT (datetime('now','localtime'))
        );
        CREATE INDEX IF NOT EXISTS idx_authz_neg_user ON audit_authz_negado(usuario);
        CREATE INDEX IF NOT EXISTS idx_authz_neg_created ON audit_authz_negado(created_at);
      `);
    } catch (_) { /* ignora */ }
  }
}
ensureLogTable();

function registrarNegacao(req, motivo, modulo, acao) {
  try {
    const empresa = (req.headers['x-company'] || req.query.company || 'assessoria').toLowerCase();
    const db = getDb(COMPANIES[empresa] ? empresa : 'assessoria');
    db.prepare(`
      INSERT INTO audit_authz_negado
      (usuario, role, empresa_req, lotacao, metodo, rota, modulo, acao, motivo, dry_run, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.usuario?.usuario || 'anon',
      req.usuario?.role || '',
      empresa,
      req.usuario?.lotacao || '',
      req.method,
      (req.originalUrl || '').split('?')[0],
      modulo || '',
      acao || '',
      motivo,
      DRY_RUN ? 1 : 0,
      (req.ip || req.headers['x-forwarded-for'] || '').split(',')[0].trim(),
    );
  } catch (e) {
    console.error('[authz] erro ao gravar negacao:', e.message);
  }
}

function autorizacaoMiddleware(req, res, next) {
  if (DISABLED) return next();

  const path = (req.originalUrl || '').split('?')[0];
  if (ROTAS_ABERTAS.some(r => path.startsWith(r))) return next();

  const user = req.usuario;
  if (!user) return res.status(401).json({ error: 'Nao autenticado' });
  if (!user.role || !ROLES[user.role]) {
    registrarNegacao(req, 'role_invalido', null, null);
    if (DRY_RUN) return next();
    return res.status(403).json({ error: 'Role invalido: ' + (user.role || 'vazio') });
  }

  const empresaHeader = (req.headers['x-company'] || req.query.company || '').toLowerCase();
  if (!empresaHeader) {
    registrarNegacao(req, 'sem_empresa_header', null, null);
    if (DRY_RUN) return next();
    return res.status(400).json({ error: 'Header x-company obrigatorio' });
  }

  const lotacao = user.lotacao || user.empresa || '';
  if (!temAcessoEmpresa(user.role, empresaHeader, lotacao)) {
    registrarNegacao(req, 'empresa_forbidden', null, null);
    if (DRY_RUN) return next();
    return res.status(403).json({
      error: 'Seu perfil (' + user.role + ') nao tem acesso a empresa ' + empresaHeader,
      code: 'COMPANY_FORBIDDEN',
      sua_lotacao: lotacao,
    });
  }

  const modulo = moduloDoPath(path);
  const acao = acaoDoMetodo(req.method);

  if (!modulo) {
    // modulo nao mapeado - permite mas loga uma vez (rate-limited)
    return next();
  }

  if (!temPermissao(user.role, modulo, acao)) {
    registrarNegacao(req, 'modulo_forbidden', modulo, acao);
    if (DRY_RUN) return next();
    return res.status(403).json({
      error: 'Seu perfil (' + user.role + ') nao pode ' + acao + ' em ' + modulo,
      code: 'MODULE_FORBIDDEN',
      modulo, acao,
    });
  }

  req.autorizacao = { modulo, acao };
  next();
}

function permissoesDoUsuario(role, lotacao) {
  const perfil = ROLES[role];
  if (!perfil) return null;
  return {
    role,
    descricao: perfil.descricao,
    empresas: perfil.empresas === '*' ? 'todas' : (lotacao || '').split(',').map(s=>s.trim()).filter(Boolean),
    modulos: perfil.modulos,
    acoes: perfil.acoes,
    excecoes: perfil.excecoes || {},
  };
}

module.exports = { autorizacaoMiddleware, permissoesDoUsuario };
