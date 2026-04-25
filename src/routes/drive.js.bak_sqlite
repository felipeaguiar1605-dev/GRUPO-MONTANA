/**
 * Montana ERP — Integração Google Drive + IA
 *
 * GET  /drive/status       — verifica se Drive está conectado
 * GET  /drive/auth         — inicia fluxo OAuth2 Google
 * GET  /drive/callback     — recebe token e salva no DB
 * POST /drive/buscar       — busca arquivos no Drive com resumo IA opcional
 * GET  /drive/sugestoes    — analisa documentos e gera recomendações operacionais
 * DELETE /drive/desconectar — remove token do DB
 */

const express   = require('express');
const companyMw = require('../companyMiddleware');

const router = express.Router();
// companyMw aplicado apenas nas rotas que precisam de DB (não em /auth e /callback do OAuth)

// ─── Helpers OAuth ─────────────────────────────────────────────────────────────

function getOAuth2Client() {
  const { google } = require('googleapis');
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3002/api/drive/callback'
  );
}

function isDriveConfigurado() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

async function getTokens(db) {
  try {
    const row = await db.prepare(`SELECT valor FROM configuracoes WHERE chave='drive_tokens' LIMIT 1`).get();
    return row ? JSON.parse(row.valor) : null;
  } catch { return null; }
}

async function saveTokens(db, tokens) {
  await db.prepare(`
    INSERT INTO configuracoes(chave, valor) VALUES('drive_tokens', ?)
    ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor
  `).run(JSON.stringify(tokens));
}

async function removeTokens(db) {
  await db.prepare(`DELETE FROM configuracoes WHERE chave='drive_tokens'`).run();
}

async function getDriveClient(db) {
  const oauth2 = getOAuth2Client();
  const tokens = getTokens(db);
  if (!tokens) return null;
  oauth2.setCredentials(tokens);
  // Renova token se próximo de expirar
  if (tokens.expiry_date && tokens.expiry_date < Date.now() + 60000) {
    try {
      const { credentials } = await oauth2.refreshAccessToken();
      saveTokens(db, credentials);
      oauth2.setCredentials(credentials);
    } catch { return null; }
  }
  return oauth2;
}

// ─── GET /status ──────────────────────────────────────────────────────────────

router.get('/status', companyMw, async (req, res) => {
  const db = req.db;
  const driveConfigurado = isDriveConfigurado();

  if (!db) return res.json({ ok: true, configurado: driveConfigurado, conectado: false });

  const tokens = driveConfigurado ? getTokens(db) : null;
  res.json({
    ok: true,
    configurado: driveConfigurado,
    conectado: !!tokens,
    mensagem: !driveConfigurado
      ? 'Google Drive não configurado — adicione GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no .env'
      : tokens ? 'Google Drive conectado' : 'Google Drive configurado mas não conectado — clique em "Conectar"',
  });
});

// ─── GET /auth ────────────────────────────────────────────────────────────────
// Aceita token JWT e company via query params (popup não envia headers)

router.get('/auth', async (req, res) => {
  if (!isDriveConfigurado()) {
    return res.status(503).json({ error: 'Google Drive não configurado no servidor' });
  }

  // Verifica JWT passado via query param (popup não pode enviar header Authorization)
  const token   = req.query.token || req.headers['authorization']?.replace('Bearer ', '');
  const company = req.query.company || req.headers['x-company'];

  if (!token || !company) {
    return res.status(401).send('Token e empresa obrigatórios');
  }

  try {
    const jwt = require('jsonwebtoken');
    jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).send('Token inválido');
  }

  const oauth2 = getOAuth2Client();
  // Codifica company no state para recuperar no callback
  const state = Buffer.from(JSON.stringify({ company, token })).toString('base64');

  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    state,
    scope: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.metadata.readonly',
    ],
  });
  res.redirect(url);
});

// ─── GET /callback ────────────────────────────────────────────────────────────

router.get('/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error) return res.status(400).send(`Erro OAuth: ${error}`);
  if (!code)  return res.status(400).send('Código OAuth ausente');

  // Recupera company do state
  let companyKey = null;
  try {
    const decoded = JSON.parse(Buffer.from(state || '', 'base64').toString('utf8'));
    companyKey = decoded.company;
  } catch (_) {}

  // Fallback: usa req.db se company não veio no state
  let db = req.db;
  if (!db && companyKey) {
    try { db = require('../db_pg').getDb(companyKey); } catch (_) {}
  }
  if (!db) return res.status(400).send('Empresa não identificada');

  try {
    const oauth2 = getOAuth2Client();
    const { tokens } = await oauth2.getToken(code);
    saveTokens(db, tokens);
    res.send(`<script>window.close(); window.opener && window.opener.postMessage('drive_conectado','*');</script>
              <p>✅ Google Drive conectado com sucesso! Pode fechar esta janela.</p>`);
  } catch (e) {
    res.status(500).send(`Erro ao obter token: ${e.message}`);
  }
});

// ─── DELETE /desconectar ──────────────────────────────────────────────────────

router.delete('/desconectar', companyMw, async (req, res) => {
  const db = req.db;
  if (!db) return res.status(400).json({ error: 'Empresa não identificada' });
  removeTokens(db);
  res.json({ ok: true });
});

// ─── POST /buscar ─────────────────────────────────────────────────────────────

router.post('/buscar', companyMw, async (req, res) => {
  const db = req.db;
  if (!db) return res.status(400).json({ error: 'Empresa não identificada' });

  if (!isDriveConfigurado()) {
    return res.json({ ok: false, configurado: false, arquivos: [] });
  }

  const auth = await getDriveClient(db);
  if (!auth) {
    return res.json({ ok: false, conectado: false, arquivos: [] });
  }

  const { termo = '', tipo = 'all' } = req.body;

  try {
    const { google } = require('googleapis');
    const drive = google.drive({ version: 'v3', auth });

    // Monta query de busca — 'me' in owners limita ao Drive próprio (não arquivos compartilhados)
    let q = "trashed = false and 'me' in owners";
    if (termo) q += ` and fullText contains '${termo.replace(/'/g, "\\'")}'`;
    if (tipo === 'pdf')   q += ` and mimeType = 'application/pdf'`;
    if (tipo === 'sheet') q += ` and mimeType = 'application/vnd.google-apps.spreadsheet'`;
    if (tipo === 'doc')   q += ` and mimeType = 'application/vnd.google-apps.document'`;

    const resp = await drive.files.list({
      q,
      pageSize: 20,
      fields: 'files(id,name,mimeType,size,modifiedTime,webViewLink)',
      orderBy: 'modifiedTime desc',
    });

    const arquivos = (resp.data.files || []).map(f => ({
      id:           f.id,
      nome:         f.name,
      tipo:         f.mimeType,
      tamanho:      f.size ? `${Math.round(f.size / 1024)} KB` : null,
      modificado:   f.modifiedTime?.split('T')[0] || '',
      link:         f.webViewLink,
      resumo_ia:    null, // preenchido abaixo se IA disponível
    }));

    // Resumo IA (somente se ANTHROPIC_API_KEY configurada e tem arquivos)
    if (process.env.ANTHROPIC_API_KEY && arquivos.length > 0) {
      try {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
        const lista = arquivos.map((a, i) => `${i+1}. ${a.nome} (${a.modificado})`).join('\n');
        const msg = await client.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 512,
          messages: [{
            role: 'user',
            content: `Para cada arquivo abaixo, gere um resumo de UMA linha (máx 80 chars) sobre o que provavelmente é, para um gestor financeiro. Retorne apenas um JSON array de strings na mesma ordem. Arquivos:\n${lista}`,
          }],
        });
        const texto = msg.content[0]?.text || '[]';
        const match = texto.match(/\[[\s\S]*\]/);
        if (match) {
          const resumos = JSON.parse(match[0]);
          resumos.forEach((r, i) => { if (arquivos[i]) arquivos[i].resumo_ia = r; });
        }
      } catch (_) {}
    }

    res.json({ ok: true, total: arquivos.length, arquivos });
  } catch (e) {
    console.error('[Drive] Erro busca:', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ─── GET /sugestoes ───────────────────────────────────────────────────────────

router.get('/sugestoes', companyMw, async (req, res) => {
  const db = req.db;
  if (!db) return res.status(400).json({ error: 'Empresa não identificada' });

  if (!isDriveConfigurado()) return res.json({ ok: false, configurado: false, sugestoes: [] });
  if (!process.env.ANTHROPIC_API_KEY) return res.json({ ok: false, ia_configurada: false, sugestoes: [] });

  const auth = await getDriveClient(db);
  if (!auth) return res.json({ ok: false, conectado: false, sugestoes: [] });

  try {
    const { google } = require('googleapis');
    const drive = google.drive({ version: 'v3', auth });

    // Busca últimos 30 arquivos modificados — 'me' in owners limita ao Drive próprio
    const resp = await drive.files.list({
      q: "trashed = false and 'me' in owners",
      pageSize: 30,
      fields: 'files(id,name,mimeType,modifiedTime)',
      orderBy: 'modifiedTime desc',
    });
    const arquivos = resp.data.files || [];
    if (!arquivos.length) return res.json({ ok: true, sugestoes: [] });

    // Busca contexto do ERP
    const mes = String(new Date().getMonth() + 1).padStart(2, '0');
    const ano = new Date().getFullYear();
    let erpCtx = '';
    try {
      const ctrs = await db.prepare(`SELECT numContrato, contrato FROM contratos WHERE LOWER(COALESCE(status,'')) NOT LIKE '%encerrad%' AND LOWER(COALESCE(numContrato,'')) NOT LIKE '%encerrad%' LIMIT 10`).all();
      erpCtx = `Contratos ativos: ${ctrs.map(c => c.numContrato).join(', ')}\n`;
      const nfsMes = await db.prepare(`SELECT COUNT(*) n FROM notas_fiscais WHERE strftime('%Y-%m',data_emissao)=?`).get(`${ano}-${mes}`);
      erpCtx += `NFs emitidas em ${mes}/${ano}: ${nfsMes?.n || 0}\n`;
    } catch (_) {}

    const listaArqs = arquivos.map((f, i) => `${i+1}. ${f.name} (${f.mimeType?.split('/').pop()}, ${f.modifiedTime?.split('T')[0]})`).join('\n');

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Você é um consultor financeiro do Montana ERP (empresa de terceirização de mão de obra, Palmas-TO).

Contexto do sistema:
${erpCtx}

Arquivos recentes no Google Drive:
${listaArqs}

Gere de 3 a 5 sugestões operacionais práticas para os proprietários com base nos arquivos encontrados. Foque em: contratos que precisam de ação, documentos que deveriam estar no sistema ERP, oportunidades de otimização.

Retorne APENAS um JSON array de objetos: [{"titulo":"...","descricao":"...","prioridade":"alta|media|baixa"}]`,
      }],
    });

    const texto = msg.content[0]?.text || '[]';
    const match = texto.match(/\[[\s\S]*\]/);
    const sugestoes = match ? JSON.parse(match[0]) : [];

    res.json({ ok: true, sugestoes, arquivos_analisados: arquivos.length });
  } catch (e) {
    console.error('[Drive] Erro sugestões:', e.message);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

module.exports = router;
