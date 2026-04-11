/**
 * Montana — Gerenciamento de Usuários
 * Apenas role 'admin' pode criar/editar/desativar usuários.
 *
 * Roles disponíveis:
 *   admin        — acesso total (todas as abas, CRUD, gestão de usuários)
 *   financeiro   — leitura geral + lançar despesas, NFs, parcelas
 *   operacional  — somente extratos, NFs e conciliação (sem despesas)
 *   visualizador — somente leitura (sem criar/editar/deletar nada)
 */

require('dotenv').config();
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

const JWT_SECRET = process.env.JWT_SECRET || 'montana_seg_secret_2026_!xK9#';

// Permissões por role
const ROLE_PERMISSIONS = {
  admin:       ['read', 'write', 'delete', 'admin'],
  financeiro:  ['read', 'write'],
  operacional: ['read', 'write_extratos'],
  visualizador:['read'],
};

// ─── Middleware: somente admin pode acessar estas rotas ───────────

function soAdmin(req, res, next) {
  // Lê token do header
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token necessário' });
  }
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem gerenciar usuários' });
    }
    req.usuario = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

// ─── Garante tabela usuarios no banco da empresa ──────────────────

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario     TEXT NOT NULL UNIQUE,
      nome        TEXT NOT NULL,
      email       TEXT DEFAULT '',
      senha_hash  TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'visualizador',
      ativo       INTEGER NOT NULL DEFAULT 1,
      criado_por  TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ─── Seed: garante que o admin padrão existe ──────────────────────

function seedAdmin(db) {
  ensureTable(db);
  const existe = db.prepare('SELECT id FROM usuarios WHERE usuario = ?').get('admin');
  if (!existe) {
    const senhaAdmin = process.env.ADMIN_SENHA || 'montana2026';
    const hash = bcrypt.hashSync(senhaAdmin, 10);
    db.prepare(`
      INSERT INTO usuarios (usuario, nome, email, senha_hash, role, criado_por)
      VALUES ('admin', 'Administrador', '', ?, 'admin', 'sistema')
    `).run(hash);

    // Migra usuário financeiro também
    const senhaFin = process.env.FINANCEIRO_SENHA || 'fin2026';
    const hashFin = bcrypt.hashSync(senhaFin, 10);
    db.prepare(`
      INSERT OR IGNORE INTO usuarios (usuario, nome, email, senha_hash, role, criado_por)
      VALUES ('financeiro', 'Financeiro', '', ?, 'financeiro', 'sistema')
    `).run(hashFin);
  }
}

// ─── GET /api/usuarios — lista usuários (admin only) ─────────────

router.get('/', soAdmin, (req, res) => {
  ensureTable(req.db);
  const rows = req.db.prepare(`
    SELECT id, usuario, nome, email, role, ativo, criado_por, created_at, updated_at
    FROM usuarios ORDER BY id
  `).all();
  res.json({ data: rows, roles: Object.keys(ROLE_PERMISSIONS) });
});

// ─── POST /api/usuarios — criar usuário (admin only) ─────────────

router.post('/', soAdmin, (req, res) => {
  const { usuario, nome, email = '', senha, role } = req.body;
  if (!usuario || !nome || !senha || !role) {
    return res.status(400).json({ error: 'usuario, nome, senha e role são obrigatórios' });
  }
  if (!ROLE_PERMISSIONS[role]) {
    return res.status(400).json({ error: `Role inválido. Use: ${Object.keys(ROLE_PERMISSIONS).join(', ')}` });
  }
  if (senha.length < 6) {
    return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
  }

  ensureTable(req.db);
  const existe = req.db.prepare('SELECT id FROM usuarios WHERE usuario = ?').get(usuario);
  if (existe) return res.status(409).json({ error: 'Usuário já existe' });

  const hash = bcrypt.hashSync(senha, 10);
  const result = req.db.prepare(`
    INSERT INTO usuarios (usuario, nome, email, senha_hash, role, criado_por)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(usuario, nome, email, hash, role, req.usuario.usuario);

  res.status(201).json({ ok: true, id: result.lastInsertRowid, usuario, nome, role });
});

// ─── PATCH /api/usuarios/:id — editar (admin only) ───────────────

router.patch('/:id', soAdmin, (req, res) => {
  const { id } = req.params;
  const { nome, email, senha, role, ativo } = req.body;

  ensureTable(req.db);
  const user = req.db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

  // Impede desativar o próprio admin logado
  if (user.usuario === req.usuario.usuario && ativo === 0) {
    return res.status(400).json({ error: 'Você não pode desativar sua própria conta' });
  }

  if (role && !ROLE_PERMISSIONS[role]) {
    return res.status(400).json({ error: `Role inválido. Use: ${Object.keys(ROLE_PERMISSIONS).join(', ')}` });
  }

  let senhaHash = user.senha_hash;
  if (senha) {
    if (senha.length < 6) return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
    senhaHash = bcrypt.hashSync(senha, 10);
  }

  req.db.prepare(`
    UPDATE usuarios SET
      nome       = COALESCE(?, nome),
      email      = COALESCE(?, email),
      senha_hash = ?,
      role       = COALESCE(?, role),
      ativo      = COALESCE(?, ativo),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(nome ?? null, email ?? null, senhaHash, role ?? null, ativo ?? null, id);

  res.json({ ok: true });
});

// ─── DELETE /api/usuarios/:id — remover (admin only) ─────────────

router.delete('/:id', soAdmin, (req, res) => {
  const { id } = req.params;
  ensureTable(req.db);
  const user = req.db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (user.usuario === req.usuario.usuario) {
    return res.status(400).json({ error: 'Você não pode remover sua própria conta' });
  }
  req.db.prepare('DELETE FROM usuarios WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ─── GET /api/usuarios/me — dados do usuário logado ──────────────

router.get('/me', (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token necessário' });
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    res.json({
      usuario: decoded.usuario,
      nome: decoded.nome,
      role: decoded.role,
      permissions: ROLE_PERMISSIONS[decoded.role] || []
    });
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
});

module.exports = { router, seedAdmin, ensureTable, ROLE_PERMISSIONS };
