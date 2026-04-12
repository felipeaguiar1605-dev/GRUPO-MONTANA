/**
 * Montana Multi-Empresa — Autenticação JWT
 * Usuários armazenados no banco SQLite (tabela `usuarios`) com senha bcrypt.
 * Fallback para .env caso o banco ainda não tenha sido inicializado.
 */
require('dotenv').config();
const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getDb } = require('./db');

const JWT_SECRET  = process.env.JWT_SECRET  || 'montana_seg_secret_2026_!xK9#';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

/**
 * Middleware JWT — protege todos os métodos (incluindo GET).
 * Rotas públicas explícitas: /auth/login, /health, OPTIONS.
 */
function authMiddleware(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  if (req.path === '/auth/login') return next();
  // Health check público (não expõe dados)
  if (req.path === '/health') return next();

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token de autenticação necessário', code: 'NO_TOKEN' });
  }

  try {
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET);
    req.usuario = decoded;
    next();
  } catch (e) {
    const code = e.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
    return res.status(401).json({ error: 'Token inválido ou expirado', code });
  }
}

/**
 * POST /api/auth/login — busca usuário no banco, verifica bcrypt, retorna JWT
 */
async function loginHandler(req, res) {
  const { usuario, senha, company } = req.body || {};
  if (!usuario || !senha) {
    return res.status(400).json({ error: 'usuario e senha obrigatórios' });
  }

  // Resolve a empresa pelo body ou header
  const companyKey = (company || req.headers['x-company'] || 'assessoria').toLowerCase();

  try {
    const { seedAdmin, ensureTable } = require('./routes/usuarios');
    const db = getDb(companyKey);
    ensureTable(db);
    seedAdmin(db);  // garante admin padrão na primeira vez

    const user = db.prepare('SELECT * FROM usuarios WHERE usuario = ? AND ativo = 1').get(usuario);
    if (!user) {
      return res.status(401).json({ error: 'Usuário ou senha incorretos' });
    }

    const senhaOk = await bcrypt.compare(senha, user.senha_hash);
    if (!senhaOk) {
      return res.status(401).json({ error: 'Usuário ou senha incorretos' });
    }

    const token = jwt.sign(
      { usuario: user.usuario, nome: user.nome, role: user.role, lotacao: user.lotacao || '' },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    res.json({
      ok: true, token,
      usuario: user.usuario,
      nome: user.nome,
      role: user.role,
      lotacao: user.lotacao || '',
      expiresIn: JWT_EXPIRES
    });
  } catch (e) {
    console.error('[Auth]', e.message);
    res.status(500).json({ error: 'Erro interno na autenticação' });
  }
}

module.exports = { authMiddleware, loginHandler, JWT_SECRET };
