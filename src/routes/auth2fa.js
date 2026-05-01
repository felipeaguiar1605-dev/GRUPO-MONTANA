/**
 * Montana ERP — 2FA TOTP — endpoints
 *
 * Mount em src/server.js APÓS authMiddleware:
 *   app.use('/api/auth/2fa', require('./routes/auth2fa'));
 *
 * Endpoints:
 *   POST /setup    → gera secret + QR + 10 backup codes (state: pending)
 *   POST /enable   → confirma com 1º código TOTP (state: enabled)
 *   POST /disable  → desativa 2FA (exige senha)
 *   POST /verify-backup → entrar usando código de backup (consome o código)
 *   GET  /status   → info atual do 2FA do usuário logado
 */
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const companyMw = require('../companyMiddleware');
const tfa     = require('../lib/twoFactor');
const passwordPolicy = require('../lib/passwordPolicy');

const router = express.Router();
router.use(companyMw);

const JWT_SECRET = process.env.JWT_SECRET || 'montana_seg_secret_2026_!xK9#';

// ── Helpers ──────────────────────────────────────────────────────
function meuUsuario(req, res) {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token necessário' });
    return null;
  }
  try {
    return jwt.verify(authHeader.slice(7), JWT_SECRET);
  } catch {
    res.status(401).json({ error: 'Token inválido' });
    return null;
  }
}

async function getUser(db, login) {
  return db.prepare('SELECT * FROM usuarios WHERE usuario = ?').get(login);
}

// ── GET /status — vê estado do 2FA do user logado ────────────────
router.get('/status', async (req, res) => {
  const me = meuUsuario(req, res);
  if (!me) return;
  const user = await getUser(req.db, me.usuario);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  res.json({
    enabled: !!user.totp_enabled,
    has_secret: !!user.totp_secret,
    backup_codes_remaining: user.totp_backup_codes
      ? JSON.parse(user.totp_backup_codes).filter(c => !c.used).length
      : 0,
    available: tfa.isAvailable()
  });
});

// ── POST /setup — gera secret + QR + 10 backup codes ────────────
// Salva secret no DB MAS deixa totp_enabled=FALSE até /enable confirmar
router.post('/setup', async (req, res) => {
  if (!tfa.isAvailable()) {
    return res.status(501).json({ error: 'Dependências 2FA não instaladas (npm i speakeasy qrcode)' });
  }
  const me = meuUsuario(req, res);
  if (!me) return;

  try {
    const user = await getUser(req.db, me.usuario);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    // Gera secret + QR
    const label = `${me.usuario}@${req.companyKey || 'montana'}`;
    const setup = await tfa.generateSecret(label);

    // Gera 10 códigos de backup (texto puro pra mostrar 1 VEZ AO USUÁRIO)
    const backupCodesPlain = tfa.generateBackupCodes(10);

    // Hasheia cada código antes de salvar
    const backupCodesHashed = await Promise.all(
      backupCodesPlain.map(async (code) => ({
        hash: await bcrypt.hash(code, 8),
        used: false
      }))
    );

    // Salva no DB (totp_enabled fica FALSE até /enable)
    await req.db.prepare(`
      UPDATE usuarios
         SET totp_secret = ?,
             totp_enabled = FALSE,
             totp_backup_codes = ?
       WHERE id = ?`
    ).run(setup.secret, JSON.stringify(backupCodesHashed), user.id);

    // RETORNA pro frontend (códigos em texto puro só esta vez!)
    res.json({
      ok: true,
      secret: setup.secret,
      otpauth_url: setup.otpauthUrl,
      qr_data_url: setup.qrDataUrl,
      backup_codes: backupCodesPlain,  // ← MOSTRAR AO USUÁRIO 1 VEZ
      instructions: [
        '1. Escaneie o QR code com Google Authenticator, Authy ou 1Password',
        '2. Anote os 10 códigos de backup em local seguro (cofre, gerenciador de senhas)',
        '3. Digite o código de 6 dígitos do app pra confirmar',
        '4. Cada código de backup só funciona UMA vez (use se perder o celular)'
      ]
    });
  } catch (e) {
    console.error('[2FA setup]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /enable — confirma com primeiro código TOTP ────────────
router.post('/enable', async (req, res) => {
  const me = meuUsuario(req, res);
  if (!me) return;
  const { totp } = req.body || {};
  if (!totp) return res.status(400).json({ error: 'Código TOTP obrigatório' });

  try {
    const user = await getUser(req.db, me.usuario);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (!user.totp_secret) return res.status(400).json({ error: 'Rode /setup primeiro' });

    if (!tfa.verify(user.totp_secret, totp)) {
      return res.status(401).json({ error: 'Código TOTP inválido. Verifique se o relógio do celular está sincronizado.' });
    }

    await req.db.prepare('UPDATE usuarios SET totp_enabled = TRUE WHERE id = ?').run(user.id);
    res.json({ ok: true, message: '2FA ativado com sucesso. Próximo login exigirá código.' });
  } catch (e) {
    console.error('[2FA enable]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /disable — desativa 2FA (exige senha + opcionalmente TOTP) ─
router.post('/disable', async (req, res) => {
  const me = meuUsuario(req, res);
  if (!me) return;
  const { senha, totp } = req.body || {};
  if (!senha) return res.status(400).json({ error: 'Senha obrigatória pra desativar 2FA' });

  try {
    const user = await getUser(req.db, me.usuario);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    const ok = await bcrypt.compare(senha, user.senha_hash);
    if (!ok) return res.status(401).json({ error: 'Senha incorreta' });

    // Se 2FA está ativo, exige também o código atual
    if (user.totp_enabled) {
      if (!totp) return res.status(400).json({ error: 'Código TOTP obrigatório' });
      if (!tfa.verify(user.totp_secret, totp)) {
        return res.status(401).json({ error: 'Código TOTP inválido' });
      }
    }

    await req.db.prepare(`
      UPDATE usuarios
         SET totp_enabled = FALSE,
             totp_secret = NULL,
             totp_backup_codes = NULL
       WHERE id = ?`
    ).run(user.id);

    res.json({ ok: true, message: '2FA desativado.' });
  } catch (e) {
    console.error('[2FA disable]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /verify-backup — login usando código de recuperação ────
// Body: { usuario, senha, backup_code }
// Marca o código como usado. Disponível mesmo sem JWT (é caminho de recuperação)
router.post('/verify-backup', async (req, res) => {
  const { usuario, senha, backup_code } = req.body || {};
  if (!usuario || !senha || !backup_code) {
    return res.status(400).json({ error: 'usuario, senha e backup_code obrigatórios' });
  }

  try {
    const user = await getUser(req.db, usuario);
    if (!user) return res.status(401).json({ error: 'Credenciais inválidas' });

    const senhaOk = await bcrypt.compare(senha, user.senha_hash);
    if (!senhaOk) return res.status(401).json({ error: 'Credenciais inválidas' });

    if (!user.totp_backup_codes) {
      return res.status(400).json({ error: 'Usuário não tem códigos de backup configurados' });
    }

    const codes = JSON.parse(user.totp_backup_codes);
    let matched = -1;
    for (let i = 0; i < codes.length; i++) {
      if (codes[i].used) continue;
      const match = await bcrypt.compare(
        backup_code.replace(/\s+/g, '').replace(/-/g, ''),
        codes[i].hash
      );
      if (match) { matched = i; break; }
    }

    if (matched === -1) {
      return res.status(401).json({ error: 'Código de backup inválido ou já usado' });
    }

    // Marca como usado
    codes[matched].used = true;
    codes[matched].used_at = new Date().toISOString();
    await req.db.prepare('UPDATE usuarios SET totp_backup_codes = ? WHERE id = ?')
      .run(JSON.stringify(codes), user.id);

    // Emite token (caminho de login completo)
    const token = jwt.sign(
      { usuario: user.usuario, nome: user.nome, role: user.role, lotacao: user.lotacao || '' },
      JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES || '8h' }
    );

    const remaining = codes.filter(c => !c.used).length;
    res.json({
      ok: true,
      token,
      usuario: user.usuario,
      nome: user.nome,
      role: user.role,
      backup_codes_remaining: remaining,
      warning: remaining <= 2
        ? `Só restam ${remaining} códigos de backup! Considere desativar e reativar 2FA pra gerar novos.`
        : null
    });
  } catch (e) {
    console.error('[2FA backup]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /senha/alterar — troca senha aplicando política ─────────
router.post('/senha/alterar', async (req, res) => {
  const me = meuUsuario(req, res);
  if (!me) return;
  const { senha_atual, senha_nova } = req.body || {};
  if (!senha_atual || !senha_nova) {
    return res.status(400).json({ error: 'senha_atual e senha_nova obrigatórias' });
  }

  try {
    const user = await getUser(req.db, me.usuario);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    const ok = await bcrypt.compare(senha_atual, user.senha_hash);
    if (!ok) return res.status(401).json({ error: 'Senha atual incorreta' });

    // Aplica política
    const validation = passwordPolicy.validate(senha_nova, {
      usuario: user.usuario,
      nome: user.nome
    });
    if (!validation.ok) {
      return res.status(400).json({
        error: 'Senha não atende a política',
        erros: validation.errors,
        score: passwordPolicy.score(senha_nova)
      });
    }

    // Verifica histórico (não pode repetir últimas 5)
    const historico = user.senha_historico ? JSON.parse(user.senha_historico) : [];
    for (const oldHash of historico.slice(-5)) {
      if (await bcrypt.compare(senha_nova, oldHash)) {
        return res.status(400).json({ error: 'Senha não pode repetir uma das 5 últimas usadas' });
      }
    }

    // Salva nova
    const novoHash = await bcrypt.hash(senha_nova, 10);
    historico.push(user.senha_hash); // adiciona a antiga ao histórico
    const novoHistorico = historico.slice(-10); // mantém só últimas 10

    await req.db.prepare(`
      UPDATE usuarios
         SET senha_hash = ?,
             senha_alterada_em = NOW(),
             senha_historico = ?
       WHERE id = ?
    `).run(novoHash, JSON.stringify(novoHistorico), user.id);

    res.json({
      ok: true,
      message: 'Senha alterada com sucesso',
      score: passwordPolicy.score(senha_nova)
    });
  } catch (e) {
    console.error('[senha alterar]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /senha/validar — apenas valida (pra UI mostrar feedback) ──
router.post('/senha/validar', (req, res) => {
  const { senha, usuario, nome } = req.body || {};
  const validation = passwordPolicy.validate(senha || '', { usuario, nome });
  res.json({
    ok: validation.ok,
    erros: validation.errors,
    score: passwordPolicy.score(senha || ''),
    score_label: (() => {
      const s = passwordPolicy.score(senha || '');
      if (s < 40) return 'fraca';
      if (s < 70) return 'razoável';
      if (s < 85) return 'boa';
      return 'forte';
    })()
  });
});

module.exports = router;
