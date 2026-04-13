/**
 * Montana ERP — Integração Banco do Brasil (API de Extratos)
 *
 * GET  /bb/status          — verifica configuração e última sincronização
 * POST /bb/config          — salva credenciais BB para a empresa
 * POST /bb/config/conta    — adiciona conta extra
 * DELETE /bb/config/conta  — remove conta extra
 * POST /bb/sync            — sincronização manual (busca lançamentos)
 * GET  /bb/historico       — histórico de sincronizações
 * DELETE /bb/config        — remove todas as credenciais
 *
 * Ambientes:
 *   sandbox     → oauth.sandbox.bb.com.br / api.sandbox.bb.com.br
 *   homologacao → oauth.hm.bb.com.br / api.hm.bb.com.br
 *   producao    → oauth.bb.com.br / api.bb.com.br (mTLS com cert A1 se disponível)
 */

'use strict';

const express    = require('express');
const https      = require('https');
const fs         = require('fs');
const companyMw  = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

// ─── Helpers de configuração ──────────────────────────────────────────────────

function getCfg(db, chave) {
  try {
    const row = db.prepare(`SELECT valor FROM configuracoes WHERE chave=? LIMIT 1`).get(chave);
    return row ? row.valor : null;
  } catch { return null; }
}

function setCfg(db, chave, valor) {
  db.prepare(`
    INSERT INTO configuracoes(chave, valor) VALUES(?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor, updated_at=datetime('now')
  `).run(chave, valor || '');
}

function getBBConfig(db) {
  return {
    client_id:     getCfg(db, 'bb_client_id'),
    client_secret: getCfg(db, 'bb_client_secret'),
    app_key:       getCfg(db, 'bb_app_key'),
    agencia:       getCfg(db, 'bb_agencia'),
    conta:         getCfg(db, 'bb_conta'),
    ambiente:      getCfg(db, 'bb_ambiente') || 'producao',
    scope:         getCfg(db, 'bb_scope')    || 'extrato-info',
    ultimo_sync:   getCfg(db, 'bb_ultimo_sync'),
    cert_path:     getCfg(db, 'bb_cert_path'),
    key_path:      getCfg(db, 'bb_key_path'),
  };
}

// Retorna array de todas as contas: [{agencia, conta, descricao}]
function getBBContas(db, cfg) {
  const contas = [];
  if (cfg.agencia && cfg.conta) {
    contas.push({ agencia: cfg.agencia, conta: cfg.conta, descricao: 'Conta principal' });
  }
  try {
    const extra = getCfg(db, 'bb_contas_extra');
    if (extra) {
      const arr = JSON.parse(extra);
      if (Array.isArray(arr)) contas.push(...arr);
    }
  } catch (_) {}
  return contas;
}

function isBBConfigurado(cfg) {
  return !!(cfg.client_id && cfg.client_secret && cfg.app_key && cfg.agencia && cfg.conta);
}

// ─── BB API — URL base por ambiente ──────────────────────────────────────────

function getBBOAuthBase(ambiente) {
  if (ambiente === 'producao')    return 'https://oauth.bb.com.br';
  if (ambiente === 'homologacao') return 'https://oauth.hm.bb.com.br';
  return 'https://oauth.sandbox.bb.com.br';
}

function getBBApiBase(ambiente) {
  // Extratos v1 usa domínio api-extratos (com mTLS)
  // Homologação sem mTLS usa api.hm.bb.com.br
  if (ambiente === 'producao')    return 'https://api-extratos.bb.com.br';
  if (ambiente === 'homologacao') return 'https://api.hm.bb.com.br';
  return 'https://api.sandbox.bb.com.br';
}

// ─── Helper: https.request wrapper (suporta mTLS — fetch/undici não suporta) ─

function httpsReq(urlStr, { method = 'GET', headers = {}, body = null, cert, key } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers,
      ...(cert && key ? { cert, key } : {}),
      rejectUnauthorized: true,
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, text: () => data, json: () => JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── BB API — autenticação OAuth2 ────────────────────────────────────────────

async function getBBToken(cfg) {
  const base  = getBBOAuthBase(cfg.ambiente);
  const basic = Buffer.from(`${cfg.client_id}:${cfg.client_secret}`).toString('base64');

  // Tenta lista de scopes possíveis — v1 usa 'extrato-info'
  const scopesToTry = cfg.scope
    ? [cfg.scope, 'extrato-info', '', 'extrato.read']
    : ['extrato-info', '', 'extrato.read'];

  // mTLS: usar https.request — fetch/undici do Node.js v20+ não suporta https.Agent com cert/key
  const tlsOpts = {};
  if (cfg.ambiente === 'producao' && cfg.cert_path && cfg.key_path &&
      fs.existsSync(cfg.cert_path) && fs.existsSync(cfg.key_path)) {
    tlsOpts.cert = fs.readFileSync(cfg.cert_path);
    tlsOpts.key  = fs.readFileSync(cfg.key_path);
  }

  const url = `${base}/oauth/token`;
  let lastError = null;

  for (const scope of scopesToTry) {
    const scopePart = scope ? `&scope=${encodeURIComponent(scope)}` : '';
    const body = `grant_type=client_credentials${scopePart}`;

    const resp = await httpsReq(url, {
      method: 'POST',
      headers: {
        'Authorization':  `Basic ${basic}`,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
      ...tlsOpts,
    });
    const data = resp.json();

    if (data.access_token) {
      console.log(`[BB] OAuth OK com scope="${scope}"`);
      return data.access_token;
    }

    const err = data.error || '';
    lastError = `${resp.status}: ${JSON.stringify(data)}`;

    // Só tenta próximo scope se o erro for de scope
    if (!['invalid_scope','insufficient_scope'].includes(err)) break;
    console.log(`[BB] scope="${scope}" recusado (${err}), tentando próximo...`);
  }

  throw new Error(`BB OAuth falhou — ${lastError}`);
}

// ─── BB API — busca lançamentos de uma conta ──────────────────────────────────

async function getLancamentos(cfg, token, agencia, conta, dataInicio, dataFim, pagina = 1) {
  const base = getBBApiBase(cfg.ambiente);

  // Formato BB Extratos v1: DDMMAAAA omitindo zeros à esquerda do dia
  function toDateBB(iso) {
    const [y, m, d] = iso.split('-');
    const day = parseInt(d, 10);   // remove zero à esquerda
    return `${day}${m}${y}`;
  }

  // Endpoint Extratos v1: path params agencia/conta + query params de data
  const params = new URLSearchParams({
    'gw-dev-app-key':              cfg.app_key,
    dataInicioSolicitacao:         toDateBB(dataInicio),
    dataFimSolicitacao:            toDateBB(dataFim),
    numeroPaginaSolicitacao:       String(pagina),
    quantidadeRegistroPaginaSolicitacao: '200',
  });

  const url = `${base}/extratos/v1/conta-corrente/agencia/${agencia}/conta/${conta}?${params}`;

  const headers = {
    'Authorization': `Bearer ${token}`,
  };

  if (cfg.ambiente === 'homologacao') {
    headers['x-br-com-bb-ipa-mciteste'] = conta;
  }

  // mTLS em produção — usar https.request (fetch/undici não suporta mTLS via https.Agent)
  const tlsOpts = {};
  if (cfg.ambiente === 'producao' && cfg.cert_path && cfg.key_path &&
      fs.existsSync(cfg.cert_path) && fs.existsSync(cfg.key_path)) {
    tlsOpts.cert = fs.readFileSync(cfg.cert_path);
    tlsOpts.key  = fs.readFileSync(cfg.key_path);
  }

  console.log(`[BB] GET ${url}`);
  const resp = await httpsReq(url, { headers, ...tlsOpts });

  if (resp.status < 200 || resp.status >= 300) {
    const err = resp.text();
    throw new Error(`BB API erro ${resp.status}: ${err.substring(0, 300)}`);
  }
  return resp.json();
}

// ─── Filtro: descarta lançamentos que não são transações reais ────────────────

const HISTORICOS_IGNORADOS = [
  /^saldo\s*(do\s*dia|atual|anterior|disponiv|dispon[íi]vel)/i,
  /^limite\s*(contratado|dispon[íi]vel|de\s*cr[eé]dito)?/i,
  /^saldo\s*atual/i,
  /agendamento/i,
  /^pix\s+rejeitado/i,
];

function isLancamentoReal(l) {
  const desc = [l.textoDescricaoHistorico, l.textoInformacaoComplementar]
    .filter(Boolean).join(' ').trim();

  // Descarta lançamentos com data futura (agendamentos)
  const ds = String(l.dataLancamento).padStart(8, '0');
  const iso = `${ds.substring(4, 8)}-${ds.substring(2, 4)}-${ds.substring(0, 2)}`;
  if (iso > new Date().toISOString().split('T')[0]) return false;

  // Descarta por descrição
  for (const pattern of HISTORICOS_IGNORADOS) {
    if (pattern.test(desc)) return false;
  }

  return true;
}

// ─── Conversor de lançamento BB → extrato Montana ────────────────────────────

function lancamentoToExtrato(l) {
  const MESES = ['','JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];

  // BB retorna data como inteiro ddmmaaaa: 12042026
  const ds   = String(l.dataLancamento).padStart(8, '0');
  const d    = ds.substring(0, 2);
  const m    = ds.substring(2, 4);
  const y    = ds.substring(4, 8);
  const iso  = `${y}-${m}-${d}`;
  const data = `${d}/${m}/${y}`;
  const mes  = MESES[parseInt(m)] || m;

  const sinal   = (l.indicadorSinalLancamento || l.indicadorTipoLancamento || '').toUpperCase();
  const valor   = Math.abs(parseFloat(l.valorLancamento) || 0);
  const credito = sinal === 'C' ? valor : 0;
  const debito  = sinal === 'D' ? valor : 0;

  const desc = [l.textoDescricaoHistorico, l.textoInformacaoComplementar]
    .filter(Boolean).join(' — ').trim() || 'LANÇAMENTO BB';

  const idBase = l.numeroDocumento ? parseInt(l.numeroDocumento) : null;

  return { iso, data, mes, tipo: sinal || 'D', historico: desc, debito, credito, id: idBase };
}

// ─── Sync de uma conta específica ────────────────────────────────────────────

async function syncConta(db, cfg, token, agencia, conta, dataInicio, dataFim) {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO extratos
      (id, mes, data, data_iso, tipo, historico, debito, credito, status_conciliacao)
    VALUES
      (@id, @mes, @data, @data_iso, @tipo, @historico, @debito, @credito, 'PENDENTE')
  `);
  const insNoId = db.prepare(`
    INSERT OR IGNORE INTO extratos
      (mes, data, data_iso, tipo, historico, debito, credito, status_conciliacao)
    VALUES
      (@mes, @data, @data_iso, @tipo, @historico, @debito, @credito, 'PENDENTE')
  `);

  let imported = 0, skipped = 0, pagina = 1, hasMore = true;

  while (hasMore) {
    const data = await getLancamentos(cfg, token, agencia, conta, dataInicio, dataFim, pagina);
    // listaLancamento pode ser array ou objeto com items
    let lista = data.listaLancamento || data.lancamentos || data.data || [];
    if (!Array.isArray(lista)) lista = Object.values(lista);

    db.transaction(() => {
      for (const l of lista) {
        if (!isLancamentoReal(l)) { skipped++; continue; }
        const ext = lancamentoToExtrato(l);
        const row = {
          mes:       ext.mes,
          data:      ext.data,
          data_iso:  ext.iso,
          tipo:      ext.tipo,
          historico: ext.historico,
          debito:    ext.debito,
          credito:   ext.credito,
        };
        let r;
        if (ext.id) {
          r = ins.run({ id: ext.id, ...row });
        } else {
          r = insNoId.run(row);
        }
        if (r.changes > 0) imported++; else skipped++;
      }
    })();

    // numeroPaginaProximo = 0 significa última página
    hasMore = (data.numeroPaginaProximo || 0) > 0 && lista.length > 0;
    pagina++;
  }

  return { imported, skipped };
}

// ─── Sync principal (todas as contas) ────────────────────────────────────────

async function syncBB(db, cfg, dataInicio, dataFim) {
  const token  = await getBBToken(cfg);
  const contas = getBBContas(db, cfg);

  let totalImported = 0, totalSkipped = 0;
  const resultadosPorConta = [];

  for (const c of contas) {
    try {
      const { imported, skipped } = await syncConta(db, cfg, token, c.agencia, c.conta, dataInicio, dataFim);
      totalImported += imported;
      totalSkipped  += skipped;
      resultadosPorConta.push({ conta: c.conta, descricao: c.descricao, imported, skipped });
    } catch (err) {
      resultadosPorConta.push({ conta: c.conta, descricao: c.descricao, erro: err.message });
    }
  }

  return { imported: totalImported, skipped: totalSkipped, contas: resultadosPorConta };
}

// ─── GET /bb/status ───────────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  const cfg    = getBBConfig(req.db);
  const contas = getBBContas(req.db, cfg);
  res.json({
    ok:           true,
    configurado:  isBBConfigurado(cfg),
    ambiente:     cfg.ambiente,
    agencia:      cfg.agencia,
    conta:        cfg.conta ? cfg.conta.toString().replace(/.(?=.{4})/g, '*') : null,
    contas:       contas.map(c => ({
      agencia:   c.agencia,
      conta:     c.conta ? c.conta.toString().replace(/.(?=.{4})/g, '*') : null,
      descricao: c.descricao,
    })),
    total_contas: contas.length,
    ultimo_sync:  cfg.ultimo_sync,
    tem_cert:     !!(cfg.cert_path && fs.existsSync(cfg.cert_path || '')),
  });
});

// ─── POST /bb/config ──────────────────────────────────────────────────────────

router.post('/config', (req, res) => {
  const { client_id, client_secret, app_key, agencia, conta, ambiente, scope, cert_path, key_path } = req.body;

  if (!client_id || !client_secret || !app_key || !agencia || !conta) {
    return res.status(400).json({ error: 'client_id, client_secret, app_key, agencia e conta são obrigatórios' });
  }

  const db = req.db;
  setCfg(db, 'bb_client_id',     client_id);
  setCfg(db, 'bb_client_secret', client_secret);
  setCfg(db, 'bb_app_key',       app_key);
  setCfg(db, 'bb_agencia',       agencia);
  setCfg(db, 'bb_conta',         conta);
  setCfg(db, 'bb_ambiente',      ambiente || 'producao');
  setCfg(db, 'bb_scope',         scope    || 'extrato-info');
  if (cert_path) setCfg(db, 'bb_cert_path', cert_path);
  if (key_path)  setCfg(db, 'bb_key_path',  key_path);

  res.json({ ok: true, message: 'Credenciais BB salvas com sucesso' });
});

// ─── POST /bb/config/conta — adiciona conta extra ─────────────────────────────

router.post('/config/conta', (req, res) => {
  const { agencia, conta, descricao } = req.body;
  if (!agencia || !conta) return res.status(400).json({ error: 'agencia e conta são obrigatórios' });

  const db = req.db;
  let extra = [];
  try {
    const raw = getCfg(db, 'bb_contas_extra');
    if (raw) extra = JSON.parse(raw);
  } catch (_) {}

  // Evita duplicata
  if (!extra.find(c => c.agencia === agencia && c.conta === conta)) {
    extra.push({ agencia, conta, descricao: descricao || `Conta ${conta}` });
    setCfg(db, 'bb_contas_extra', JSON.stringify(extra));
  }

  res.json({ ok: true, total: extra.length + 1 });
});

// ─── DELETE /bb/config/conta — remove conta extra ────────────────────────────

router.delete('/config/conta', (req, res) => {
  const { conta } = req.body;
  if (!conta) return res.status(400).json({ error: 'conta é obrigatório' });

  const db = req.db;
  let extra = [];
  try {
    const raw = getCfg(db, 'bb_contas_extra');
    if (raw) extra = JSON.parse(raw);
  } catch (_) {}

  extra = extra.filter(c => c.conta !== conta);
  setCfg(db, 'bb_contas_extra', JSON.stringify(extra));
  res.json({ ok: true });
});

// ─── DELETE /bb/config ────────────────────────────────────────────────────────

router.delete('/config', (req, res) => {
  const db = req.db;
  ['bb_client_id','bb_client_secret','bb_app_key','bb_agencia','bb_conta',
   'bb_ambiente','bb_scope','bb_ultimo_sync','bb_cert_path','bb_key_path','bb_contas_extra']
    .forEach(k => db.prepare(`DELETE FROM configuracoes WHERE chave=?`).run(k));
  res.json({ ok: true });
});

// ─── POST /bb/sync ────────────────────────────────────────────────────────────

router.post('/sync', async (req, res) => {
  const db  = req.db;
  const cfg = getBBConfig(db);

  if (!isBBConfigurado(cfg)) {
    return res.status(400).json({ error: 'BB não configurado para esta empresa. Configure as credenciais primeiro.' });
  }

  const hoje       = new Date();
  const dataFim    = req.body.dataFim    || hoje.toISOString().split('T')[0];
  const dataInicio = req.body.dataInicio || (() => {
    const d = new Date(hoje); d.setDate(d.getDate() - 30); return d.toISOString().split('T')[0];
  })();

  try {
    const { imported, skipped, contas } = await syncBB(db, cfg, dataInicio, dataFim);

    const agora = new Date().toISOString();
    setCfg(db, 'bb_ultimo_sync', agora);

    db.prepare(`INSERT INTO importacoes (tipo, arquivo, registros) VALUES ('bb-sync', ?, ?)`)
      .run(`BB sync ${dataInicio} → ${dataFim}`, imported);

    res.json({
      ok: true,
      imported,
      skipped,
      contas,
      periodo: { dataInicio, dataFim },
      message: `${imported} lançamentos importados` + (skipped ? ` · ${skipped} já existiam` : ''),
    });
  } catch (err) {
    console.error('[BB Sync] erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /bb/historico ────────────────────────────────────────────────────────

router.get('/historico', (req, res) => {
  const rows = req.db.prepare(`
    SELECT tipo, arquivo, registros, data_importacao as created_at
    FROM importacoes
    WHERE tipo='bb-sync'
    ORDER BY data_importacao DESC LIMIT 20
  `).all();
  res.json({ ok: true, historico: rows });
});

module.exports = router;
