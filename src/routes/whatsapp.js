/**
 * Montana — Alertas via WhatsApp (Z-API ou Evolution API)
 * Envia mensagens de alerta para número configurado.
 * Suporta Z-API (mais comum no Brasil) e Evolution API (open source).
 */
const express = require('express');
const companyMw = require('../companyMiddleware');
const router = express.Router();
router.use(companyMw);

async function getConfig(db) {
  try {
    const rows = await db.prepare("SELECT chave, valor FROM configuracoes WHERE chave LIKE 'whatsapp_%'").all();
    const cfg = {};
    rows.forEach(r => { cfg[r.chave.replace('whatsapp_', '')] = r.valor; });
    return cfg;
  } catch(e) { return {}; }
}

async function enviarMensagem(cfg, numero, mensagem) {
  if (!cfg.provider || !cfg.instance_id || !cfg.token || !numero) {
    throw new Error('WhatsApp não configurado');
  }

  // Normalizar número: apenas dígitos, com 55 na frente
  const num = numero.replace(/\D/g, '');
  const numFull = num.startsWith('55') ? num : '55' + num;

  let url, body, headers;

  if (cfg.provider === 'zapi') {
    // Z-API: https://api.z-api.io/instances/{id}/token/{token}/send-text
    url = `https://api.z-api.io/instances/${cfg.instance_id}/token/${cfg.token}/send-text`;
    body = JSON.stringify({ phone: numFull, message: mensagem });
    headers = { 'Content-Type': 'application/json', 'Client-Token': cfg.client_token || '' };
  } else {
    // Evolution API: POST /message/sendText/{instance}
    url = `${cfg.api_url}/message/sendText/${cfg.instance_id}`;
    body = JSON.stringify({ number: numFull + '@s.whatsapp.net', text: mensagem });
    headers = { 'Content-Type': 'application/json', 'apikey': cfg.token };
  }

  const resp = await fetch(url, { method: 'POST', headers, body });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`WhatsApp API ${resp.status}: ${txt.substring(0,200)}`);
  }
  return await resp.json();
}

// GET /api/whatsapp/config
router.get('/config', async (req, res) => {
  const cfg = getConfig(req.db);
  if (cfg.token) cfg.token = '••••••••';
  res.json(cfg);
});

// PUT /api/whatsapp/config
router.put('/config', async (req, res) => {
  const { provider, instance_id, token, client_token, api_url, numero_destino } = req.body;
  // Garantir que tabela configuracoes existe
  try {
    await req.db.prepare(`CREATE TABLE IF NOT EXISTS configuracoes (
      id BIGSERIAL PRIMARY KEY,
      chave TEXT UNIQUE NOT NULL,
      valor TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )`).run();
  } catch(e) {}
  const upsert = req.db.prepare("INSERT INTO configuracoes (chave,valor,updated_at) VALUES (@chave,@valor,NOW())");
  const t = req.db.transaction(async () => {
    if (provider)        upsert.run({ chave:'whatsapp_provider',       valor: provider });
    if (instance_id)     upsert.run({ chave:'whatsapp_instance_id',    valor: instance_id });
    if (token && token !== '••••••••') upsert.run({ chave:'whatsapp_token', valor: token });
    if (client_token)    upsert.run({ chave:'whatsapp_client_token',   valor: client_token });
    if (api_url)         upsert.run({ chave:'whatsapp_api_url',        valor: api_url });
    if (numero_destino)  upsert.run({ chave:'whatsapp_numero_destino', valor: numero_destino });
  });
  t();
  res.json({ ok: true });
});

// POST /api/whatsapp/testar
router.post('/testar', async (req, res) => {
  const cfg = getConfig(req.db);
  const numero = cfg.numero_destino || req.body.numero;
  if (!numero) return res.status(400).json({ error: 'Número destino não configurado' });
  try {
    const r = await enviarMensagem(cfg, numero, `*Montana ERP* — Teste de conexão WhatsApp.\nEmpresa: ${req.company?.nome||'Montana'}\n${new Date().toLocaleString('pt-BR')}`);
    res.json({ ok: true, result: r });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/enviar-alertas
router.post('/enviar-alertas', async (req, res) => {
  const db = req.db;
  const cfg = getConfig(db);
  const numero = cfg.numero_destino;
  if (!numero || !cfg.token) return res.status(400).json({ error: 'WhatsApp não configurado' });

  const hoje = new Date().toISOString().split('T')[0];
  const em15 = new Date(Date.now() + 15*86400000).toISOString().split('T')[0];
  const em30 = new Date(Date.now() + 30*86400000).toISOString().split('T')[0];

  let certidoes = [];
  let contratos = [];
  try { certidoes = await db.prepare("SELECT tipo, data_validade FROM certidoes WHERE data_validade<=? AND data_validade>=? ORDER BY data_validade").all(em15, hoje); } catch(e) {}
  try { contratos = await db.prepare("SELECT numContrato, vigencia_fim FROM contratos WHERE vigencia_fim<=? AND vigencia_fim>=? ORDER BY vigencia_fim").all(em30, hoje); } catch(e) {}

  if (certidoes.length === 0 && contratos.length === 0) {
    return res.json({ ok: true, enviado: false, message: 'Sem alertas pendentes' });
  }

  let msg = `*Alertas Montana — ${req.company?.nomeAbrev||'Montana'}*\n${new Date().toLocaleDateString('pt-BR')}\n\n`;

  if (certidoes.length > 0) {
    msg += `*Certidoes Vencendo (${certidoes.length}):*\n`;
    certidoes.forEach(c => { msg += `• ${c.tipo} -> ${c.data_validade}\n`; });
    msg += '\n';
  }
  if (contratos.length > 0) {
    msg += `*Contratos Vencendo (${contratos.length}):*\n`;
    contratos.forEach(c => { msg += `• ${c.numContrato} -> ${c.vigencia_fim}\n`; });
  }

  try {
    await enviarMensagem(cfg, numero, msg);
    // Log
    try { await db.prepare("INSERT INTO notificacoes_log (tipo,destinatario,assunto,corpo,status) VALUES ('whatsapp',?,?,?,'enviado')").run(numero, 'Alertas Montana', msg); } catch(e2) {}
    res.json({ ok: true, enviado: true, numero, certidoes: certidoes.length, contratos: contratos.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
