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
const crypto     = require('crypto');
const companyMw  = require('../companyMiddleware');

/** Gera hash MD5 de 32 chars para deduplicação de extratos */
function bbHash(...parts) {
  return crypto.createHash('md5').update(parts.map(String).join('|')).digest('hex').slice(0, 32);
}

const router = express.Router();
router.use(companyMw);

// ─── Helpers de configuração ──────────────────────────────────────────────────

async function getCfg(db, chave) {
  try {
    const row = await db.prepare(`SELECT valor FROM configuracoes WHERE chave=? LIMIT 1`).get(chave);
    return row ? row.valor : null;
  } catch { return null; }
}

async function setCfg(db, chave, valor) {
  await db.prepare(`
    INSERT INTO configuracoes(chave, valor) VALUES(?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor, updated_at=NOW()
  `).run(chave, valor || '');
}

// P0 fix (2026-04-29): getCfg() é async (retorna Promise) - antes este helper
// devolvia um objeto com Promises não resolvidas, quebrando toda a integração BB.
async function getBBConfig(db) {
  const [
    client_id, client_secret, app_key, agencia, conta,
    ambiente, scope, ultimo_sync,
    cert_path, key_path, pfx_path, pfx_passphrase,
  ] = await Promise.all([
    getCfg(db, 'bb_client_id'),
    getCfg(db, 'bb_client_secret'),
    getCfg(db, 'bb_app_key'),
    getCfg(db, 'bb_agencia'),
    getCfg(db, 'bb_conta'),
    getCfg(db, 'bb_ambiente'),
    getCfg(db, 'bb_scope'),
    getCfg(db, 'bb_ultimo_sync'),
    getCfg(db, 'bb_cert_path'),
    getCfg(db, 'bb_key_path'),
    getCfg(db, 'bb_pfx_path'),
    getCfg(db, 'bb_pfx_passphrase'),
  ]);
  return {
    client_id, client_secret, app_key, agencia, conta,
    ambiente: ambiente || 'producao',
    scope:    scope    || 'extrato-info',
    ultimo_sync, cert_path, key_path, pfx_path, pfx_passphrase,
  };
}

/**
 * Retorna opções de TLS para https.request — aceita .pfx (mais simples)
 * ou o par cert.pem/key.pem tradicional. Se nenhum cert configurado,
 * retorna {} (sem mTLS — só funciona em sandbox/homologação).
 */
function buildTlsOpts(cfg) {
  if (cfg.ambiente !== 'producao') return {};
  // Preferência 1: .pfx direto (menos passos, sem extração openssl)
  if (cfg.pfx_path && fs.existsSync(cfg.pfx_path)) {
    return {
      pfx: fs.readFileSync(cfg.pfx_path),
      passphrase: cfg.pfx_passphrase || undefined,
    };
  }
  // Preferência 2: cert.pem + key.pem
  if (cfg.cert_path && cfg.key_path &&
      fs.existsSync(cfg.cert_path) && fs.existsSync(cfg.key_path)) {
    return {
      cert: fs.readFileSync(cfg.cert_path),
      key:  fs.readFileSync(cfg.key_path),
    };
  }
  return {};
}

// Retorna array de todas as contas: [{agencia, conta, descricao}]
// P0 fix: era sync com getCfg async (Promise leakou para JSON.parse)
async function getBBContas(db, cfg) {
  const contas = [];
  if (cfg.agencia && cfg.conta) {
    contas.push({ agencia: cfg.agencia, conta: cfg.conta, descricao: 'Conta principal' });
  }
  try {
    const extra = await getCfg(db, 'bb_contas_extra');
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

function httpsReq(urlStr, { method = 'GET', headers = {}, body = null, cert, key, pfx, passphrase } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const tls = pfx
      ? { pfx, ...(passphrase ? { passphrase } : {}) }
      : (cert && key ? { cert, key } : {});
    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers,
      ...tls,
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
  const tlsOpts = buildTlsOpts(cfg);

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

  // mTLS em produção — suporta .pfx direto ou cert.pem/key.pem
  const tlsOpts = buildTlsOpts(cfg);

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

// BB API: máximo 31 dias por requisição — divide em blocos de 30 dias
function periodoEmBlocos(dataInicio, dataFim) {
  const blocos = [];
  let cur = new Date(dataInicio + 'T00:00:00Z');
  const fim = new Date(dataFim + 'T00:00:00Z');
  while (cur <= fim) {
    const blkFim = new Date(cur);
    blkFim.setUTCDate(blkFim.getUTCDate() + 29);
    if (blkFim > fim) blkFim.setTime(fim.getTime());
    blocos.push({
      de:  cur.toISOString().split('T')[0],
      ate: blkFim.toISOString().split('T')[0],
    });
    cur = new Date(blkFim);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return blocos;
}

async function syncConta(db, cfg, token, agencia, conta, dataInicio, dataFim, companyKey = '') {
  // P0 fix: prepares movidos para DENTRO da transaction (txIns / txInsByHash)
  // para garantir que rodem no mesmo connection do BEGIN/COMMIT.
  let imported = 0, skipped = 0;
  const blocos = periodoEmBlocos(dataInicio, dataFim);

  for (const bloco of blocos) {
    let pagina = 1, hasMore = true;

    while (hasMore) {
      const data = await getLancamentos(cfg, token, agencia, conta, bloco.de, bloco.ate, pagina);
      let lista = data.listaLancamento || data.lancamentos || data.data || [];
      if (!Array.isArray(lista)) lista = Object.values(lista);

      // P0 fix v2 (2026-04-29 14:00): em PG, try/catch para 23505 (UNIQUE)
      // dentro de transação NÃO funciona — qualquer erro aborta toda a tx
      // ("current transaction is aborted, commands ignored").
      // Solução correta: ON CONFLICT DO NOTHING — Postgres-native upsert.
      // r.changes = 0 quando ja existe, sem precisar try/catch.
      const trans = db.transaction(async (tx) => {
        const txIns       = tx.prepare(`
          INSERT INTO extratos
            (id, mes, data, data_iso, tipo, historico, debito, credito, bb_hash, status_conciliacao)
          VALUES
            (@id, @mes, @data, @data_iso, @tipo, @historico, @debito, @credito, @bb_hash, 'PENDENTE')
          ON CONFLICT DO NOTHING
        `);
        const txInsByHash = tx.prepare(`
          INSERT INTO extratos
            (mes, data, data_iso, tipo, historico, debito, credito, bb_hash, status_conciliacao)
          VALUES
            (@mes, @data, @data_iso, @tipo, @historico, @debito, @credito, @bb_hash, 'PENDENTE')
          ON CONFLICT DO NOTHING
        `);
        for (const l of lista) {
          if (!isLancamentoReal(l)) { skipped++; continue; }
          const ext = lancamentoToExtrato(l);
          const row = {
            mes:       ext.mes,
            data:      ext.data,
            data_iso:  ext.iso,
            tipo:      ext.tipo,
            historico: ext.historico,
            debito:    ext.debito   ?? null,
            credito:   ext.credito  ?? null,
            bb_hash:   bbHash(companyKey, ext.iso, ext.tipo, ext.historico,
                              ext.debito ?? 0, ext.credito ?? 0),
          };
          let r;
          if (ext.id) {
            r = await txIns.run({ id: ext.id, ...row });
          } else {
            r = await txInsByHash.run(row);
          }
          // ON CONFLICT DO NOTHING: r.changes=0 = ja existia
          if (r && r.changes > 0) imported++; else skipped++;
        }
      });
      await trans();

      hasMore = (data.numeroPaginaProximo || 0) > 0 && lista.length > 0;
      pagina++;
      if (pagina > 10) break;
    }
  }

  return { imported, skipped };
}

// ─── Sync principal (todas as contas) ────────────────────────────────────────

async function syncBB(db, cfg, dataInicio, dataFim, companyKey = '') {
  const token  = await getBBToken(cfg);
  const contas = await getBBContas(db, cfg);

  let totalImported = 0, totalSkipped = 0;
  const resultadosPorConta = [];

  for (const c of contas) {
    try {
      const { imported, skipped } = await syncConta(db, cfg, token, c.agencia, c.conta, dataInicio, dataFim, companyKey);
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

router.get('/status', async (req, res) => {
  const cfg    = await getBBConfig(req.db);
  const contas = await getBBContas(req.db, cfg);
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
    tem_cert:     !!((cfg.pfx_path && fs.existsSync(cfg.pfx_path)) ||
                    (cfg.cert_path && cfg.key_path &&
                     fs.existsSync(cfg.cert_path) && fs.existsSync(cfg.key_path))),
    cert_tipo:    cfg.pfx_path && fs.existsSync(cfg.pfx_path) ? 'pfx' :
                  (cfg.cert_path && fs.existsSync(cfg.cert_path) ? 'pem' : null),
  });
});

// ─── POST /bb/config ──────────────────────────────────────────────────────────

router.post('/config', async (req, res) => {
  const { client_id, client_secret, app_key, agencia, conta, ambiente, scope,
          cert_path, key_path, pfx_path, pfx_passphrase } = req.body;

  if (!client_id || !client_secret || !app_key || !agencia || !conta) {
    return res.status(400).json({ error: 'client_id, client_secret, app_key, agencia e conta são obrigatórios' });
  }

  const db = req.db;
  // P0 fix: setCfg é async — sem await criava race condition
  await setCfg(db, 'bb_client_id',     client_id);
  await setCfg(db, 'bb_client_secret', client_secret);
  await setCfg(db, 'bb_app_key',       app_key);
  await setCfg(db, 'bb_agencia',       agencia);
  await setCfg(db, 'bb_conta',         conta);
  await setCfg(db, 'bb_ambiente',      ambiente || 'producao');
  await setCfg(db, 'bb_scope',         scope    || 'extrato-info');
  if (cert_path)      await setCfg(db, 'bb_cert_path',      cert_path);
  if (key_path)       await setCfg(db, 'bb_key_path',       key_path);
  if (pfx_path)       await setCfg(db, 'bb_pfx_path',       pfx_path);
  if (pfx_passphrase) await setCfg(db, 'bb_pfx_passphrase', pfx_passphrase);

  res.json({ ok: true, message: 'Credenciais BB salvas com sucesso' });
});

// ─── POST /bb/config/conta — adiciona conta extra ─────────────────────────────

router.post('/config/conta', async (req, res) => {
  const { agencia, conta, descricao } = req.body;
  if (!agencia || !conta) return res.status(400).json({ error: 'agencia e conta são obrigatórios' });

  const db = req.db;
  let extra = [];
  try {
    const raw = await getCfg(db, 'bb_contas_extra');
    if (raw) extra = JSON.parse(raw);
  } catch (_) {}

  // Evita duplicata
  if (!extra.find(c => c.agencia === agencia && c.conta === conta)) {
    extra.push({ agencia, conta, descricao: descricao || `Conta ${conta}` });
    await setCfg(db, 'bb_contas_extra', JSON.stringify(extra));
  }

  res.json({ ok: true, total: extra.length + 1 });
});

// ─── DELETE /bb/config/conta — remove conta extra ────────────────────────────

router.delete('/config/conta', async (req, res) => {
  const { conta } = req.body;
  if (!conta) return res.status(400).json({ error: 'conta é obrigatório' });

  const db = req.db;
  let extra = [];
  try {
    const raw = await getCfg(db, 'bb_contas_extra');
    if (raw) extra = JSON.parse(raw);
  } catch (_) {}

  extra = extra.filter(c => c.conta !== conta);
  await setCfg(db, 'bb_contas_extra', JSON.stringify(extra));
  res.json({ ok: true });
});

// ─── DELETE /bb/config ────────────────────────────────────────────────────────

router.delete('/config', async (req, res) => {
  const db = req.db;
  // P0 fix: forEach não respeita async — usar for-of pra esperar todos os deletes
  const chaves = ['bb_client_id','bb_client_secret','bb_app_key','bb_agencia','bb_conta',
                  'bb_ambiente','bb_scope','bb_ultimo_sync','bb_cert_path','bb_key_path',
                  'bb_pfx_path','bb_pfx_passphrase','bb_contas_extra'];
  for (const k of chaves) {
    await db.prepare(`DELETE FROM configuracoes WHERE chave=?`).run(k);
  }
  res.json({ ok: true });
});

// ─── POST /bb/sync ────────────────────────────────────────────────────────────

router.post('/sync', async (req, res) => {
  const db  = req.db;
  const cfg = await getBBConfig(db);

  if (!isBBConfigurado(cfg)) {
    return res.status(400).json({ error: 'BB não configurado para esta empresa. Configure as credenciais primeiro.' });
  }

  // Datas em horário local (America/Sao_Paulo) — BB rejeita data futura ("A data final informada é superior a data atual")
  const hoje = new Date();
  const fmtLocal = d => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };
  const hojeStr = fmtLocal(hoje);
  let dataFim    = req.body.dataFim    || hojeStr;
  let dataInicio = req.body.dataInicio || (() => {
    const d = new Date(hoje); d.setDate(d.getDate() - 30); return fmtLocal(d);
  })();
  // Clamp defensivo: BB rejeita futura
  if (dataFim > hojeStr) dataFim = hojeStr;
  if (dataInicio > hojeStr) dataInicio = hojeStr;

  try {
    const { imported, skipped, contas } = await syncBB(db, cfg, dataInicio, dataFim, req.companyKey);

    const agora = new Date().toISOString();
    await setCfg(db, 'bb_ultimo_sync', agora);

    await db.prepare(`INSERT INTO importacoes (tipo, arquivo, registros) VALUES ('bb-sync', ?, ?)`)
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

router.get('/historico', async (req, res) => {
  const rows = await req.db.prepare(`
    SELECT tipo, arquivo, registros, data_importacao as created_at
    FROM importacoes
    WHERE tipo='bb-sync'
    ORDER BY data_importacao DESC LIMIT 20
  `).all();
  res.json({ ok: true, historico: rows });
});

// ─── POST /bb/diag-period ─────────────────────────────────────────────────────
// Endpoint de diagnóstico: tenta buscar lançamentos da API BB DIA A DIA
// dentro de um período, identificando exatamente qual data dispara erro 500.
// Útil quando uma sincronização falha com "Erro Interno do Servidor" do BB.
//
// Body: { agencia, conta, dataInicio: 'YYYY-MM-DD', dataFim: 'YYYY-MM-DD' }
//   - se agencia/conta omitidos, usa a conta principal configurada
//   - dataInicio/dataFim default = ultimos 7 dias
//
// NÃO grava nada no banco. Apenas tenta GET e reporta status por dia.
router.post('/diag-period', async (req, res) => {
  const cfg = await getBBConfig(req.db);
  if (!isBBConfigurado(cfg)) {
    return res.status(400).json({ error: 'BB não configurado' });
  }

  const hoje = new Date();
  const fmtLocal = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const hojeStr = fmtLocal(hoje);

  let { agencia, conta, dataInicio, dataFim } = req.body || {};
  agencia    = agencia || cfg.agencia;
  conta      = conta   || cfg.conta;
  dataFim    = dataFim || hojeStr;
  dataInicio = dataInicio || (() => {
    const d = new Date(hoje); d.setDate(d.getDate() - 7); return fmtLocal(d);
  })();
  if (dataFim    > hojeStr) dataFim    = hojeStr;
  if (dataInicio > hojeStr) dataInicio = hojeStr;

  const dias = [];
  // Gera lista de dias (inclusivo)
  let cur = new Date(dataInicio + 'T00:00:00Z');
  const fim = new Date(dataFim + 'T00:00:00Z');
  while (cur <= fim) {
    dias.push(cur.toISOString().split('T')[0]);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  let token;
  try {
    token = await getBBToken(cfg);
  } catch (e) {
    return res.status(502).json({ error: 'Falha OAuth BB: ' + e.message });
  }

  const resultados = [];
  for (const dia of dias) {
    const t0 = Date.now();
    try {
      const data = await getLancamentos(cfg, token, agencia, conta, dia, dia, 1);
      const lista = data.listaLancamento || data.lancamentos || data.data || [];
      const qtd = Array.isArray(lista) ? lista.length : Object.keys(lista || {}).length;
      resultados.push({
        dia,
        ok: true,
        qtd_lancamentos: qtd,
        elapsed_ms: Date.now() - t0,
      });
    } catch (e) {
      // Tenta extrair codigo/ocorrencia do erro BB
      const msg = e.message || '';
      const codeMatch = msg.match(/"codigo":\s*"(\d+)"/);
      const ocorMatch = msg.match(/"ocorrencia":\s*"([0-9]+)"/);
      resultados.push({
        dia,
        ok: false,
        erro: msg.substring(0, 250),
        codigo_bb: codeMatch ? codeMatch[1] : null,
        ocorrencia_bb: ocorMatch ? ocorMatch[1] : null,
        elapsed_ms: Date.now() - t0,
      });
    }
  }

  const totalDias = resultados.length;
  const okDias    = resultados.filter(r => r.ok).length;
  const erroDias  = resultados.filter(r => !r.ok);

  res.json({
    ok: true,
    agencia,
    conta: conta.toString().replace(/.(?=.{4})/g, '*'),
    periodo: { dataInicio, dataFim },
    total_dias: totalDias,
    ok_dias: okDias,
    erro_dias: erroDias.length,
    dias_com_erro: erroDias.map(r => ({ dia: r.dia, codigo_bb: r.codigo_bb, ocorrencia_bb: r.ocorrencia_bb, erro_resumo: r.erro.substring(0, 120) })),
    resultados,
    sumario: erroDias.length === 0
      ? `✅ Todos os ${totalDias} dias responderam OK.`
      : `❌ ${erroDias.length}/${totalDias} dias falharam. Reporte ao BB com as ocorrencias listadas.`,
  });
});

module.exports = router;
