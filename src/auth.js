/**
 * Montana Multi-Empresa — Autenticação JWT + 2FA TOTP + Password Policy
 * Usuários armazenados no banco SQLite (tabela `usuarios`) com senha bcrypt.
 * Fallback para .env caso o banco ainda não tenha sido inicializado.
 *
 * Features:
 *   - JWT 8h
 *   - 2FA TOTP opt-in por usuário (totp_enabled flag)
 *   - Password policy NIST 800-63B (12+ chars, mixed)
 *   - Lockout após 5 tentativas falhas (15 min)
 *
 * Endpoints adicionais expostos por este módulo (montar via routes/usuarios):
 *   POST /api/auth/2fa/setup
 *   POST /api/auth/2fa/enable
 *   POST /api/auth/2fa/disable
 *   POST /api/auth/senha/alterar
 */
require('dotenv').config();
const jwt    = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getDb } = require('./db');

const JWT_SECRET  = process.env.JWT_SECRET  || 'montana_seg_secret_2026_!xK9#';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';

const MAX_TENTATIVAS = parseInt(process.env.AUTH_MAX_TENTATIVAS || '5', 10);
const LOCKOUT_MIN    = parseInt(process.env.AUTH_LOCKOUT_MIN    || '15', 10);

/**
 * Middleware JWT — protege todos os métodos (incluindo GET).
 * Rotas públicas explícitas: /auth/login, /health, OPTIONS.
 */
function authMiddleware(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  if (req.path === '/auth/login') return next();
  // Health check público (não expõe dados)
  if (req.path === '/health') return next();
  // OAuth Drive: popup não envia Bearer, autenticação verificada internamente via query param
  if (req.path === '/drive/auth') return next();
  if (req.path === '/drive/callback') return next();

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
 * POST /api/auth/login — busca usuário no banco, verifica bcrypt + 2FA opcional, retorna JWT
 *
 * Body: { usuario, senha, company, totp? }
 * - Se usuário tem totp_enabled=true e totp não foi enviado, retorna 401 com code='2FA_REQUIRED'
 * - Frontend então pede o código e re-submete
 */
async function loginHandler(req, res) {
  const { usuario, senha, company, totp } = req.body || {};
  if (!usuario || !senha) {
    return res.status(400).json({ error: 'usuario e senha obrigatórios' });
  }

  // Resolve a empresa pelo body ou header
  const companyKey = (company || req.headers['x-company'] || 'assessoria').toLowerCase();

  try {
    const { seedAdmin, ensureTable } = require('./routes/usuarios');
    const db = getDb(companyKey);
    await ensureTable(db);
    await seedAdmin(db);  // garante admin padrão na primeira vez

    const user = await db.prepare('SELECT * FROM usuarios WHERE usuario = ? AND ativo = 1').get(usuario);
    if (!user) {
      return res.status(401).json({ error: 'Usuário ou senha incorretos' });
    }

    // ── Lockout ────────────────────────────────────────────────
    if (user.bloqueado_ate && new Date(user.bloqueado_ate) > new Date()) {
      const minRest = Math.ceil((new Date(user.bloqueado_ate) - new Date()) / 60000);
      return res.status(429).json({
        error: `Conta bloqueada por excesso de tentativas. Tente em ${minRest} minutos.`,
        code: 'LOCKED'
      });
    }

    const senhaOk = await bcrypt.compare(senha, user.senha_hash);
    if (!senhaOk) {
      // Incrementa tentativas
      try {
        const novas = (user.tentativas_login || 0) + 1;
        const bloqueio = novas >= MAX_TENTATIVAS
          ? new Date(Date.now() + LOCKOUT_MIN * 60000).toISOString()
          : null;
        await db.prepare('UPDATE usuarios SET tentativas_login=?, bloqueado_ate=? WHERE id=?')
          .run(novas, bloqueio, user.id);
      } catch(_) { /* coluna pode não existir ainda — ignora */ }
      return res.status(401).json({ error: 'Usuário ou senha incorretos' });
    }

    // ── 2FA TOTP ──────────────────────────────────────────────
    if (user.totp_enabled && user.totp_secret) {
      if (!totp) {
        return res.status(401).json({
          error: 'Código 2FA necessário',
          code: '2FA_REQUIRED'
        });
      }
      const tfa = require('./lib/twoFactor');
      const okTotp = tfa.verify(user.totp_secret, totp);
      if (!okTotp) {
        return res.status(401).json({ error: 'Código 2FA inválido', code: '2FA_INVALID' });
      }
    }

    // Reset tentativas após login bem-sucedido
    try {
      await db.prepare('UPDATE usuarios SET tentativas_login=0, bloqueado_ate=NULL WHERE id=?').run(user.id);
    } catch(_) {}

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
      expiresIn: JWT_EXPIRES,
      twoFactor: !!user.totp_enabled
    });
  } catch (e) {
    console.error('[Auth]', e.message);
    res.status(500).json({ error: 'Erro interno na autenticação' });
  }
}

module.exports = { authMiddleware, loginHandler, JWT_SECRET };
