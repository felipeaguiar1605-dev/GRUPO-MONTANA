'use strict';
/**
 * Re-importa extratos de março/2026 da Segurança via BB API.
 * Usa as mesmas credenciais configuradas em configuracoes.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const https   = require('https');
const fs      = require('fs');
const { getDb } = require('../src/db');

const db = getDb('seguranca');

function getCfg(chave) {
  const row = db.prepare(`SELECT valor FROM configuracoes WHERE chave=? LIMIT 1`).get(chave);
  return row ? row.valor : null;
}

const cfg = {
  client_id:     getCfg('bb_client_id'),
  client_secret: getCfg('bb_client_secret'),
  app_key:       getCfg('bb_app_key'),
  ambiente:      getCfg('bb_ambiente') || 'producao',
  cert_path:     getCfg('bb_cert_path'),
  key_path:      getCfg('bb_key_path'),
  agencia:       getCfg('bb_agencia'),
  conta:         getCfg('bb_conta'),
};

if (!cfg.client_id) { console.error('❌ Credenciais BB não configuradas para segurança'); process.exit(1); }

function httpsReq(urlStr, { method='GET', headers={}, body=null, cert, key }={}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = { hostname: u.hostname, port: u.port||443, path: u.pathname+u.search, method, headers,
      ...(cert && key ? { cert, key } : {}), rejectUnauthorized: true };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(data), text: () => data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getToken() {
  const base  = cfg.ambiente === 'producao' ? 'https://oauth.bb.com.br' : 'https://oauth.sandbox.bb.com.br';
  const basic = Buffer.from(`${cfg.client_id}:${cfg.client_secret}`).toString('base64');
  const tlsOpts = {};
  if (cfg.cert_path && cfg.key_path && fs.existsSync(cfg.cert_path) && fs.existsSync(cfg.key_path)) {
    tlsOpts.cert = fs.readFileSync(cfg.cert_path);
    tlsOpts.key  = fs.readFileSync(cfg.key_path);
  }
  const body = `grant_type=client_credentials&scope=extrato-info`;
  const resp = await httpsReq(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    body, ...tlsOpts,
  });
  const data = resp.json();
  if (!data.access_token) throw new Error(`OAuth falhou: ${JSON.stringify(data)}`);
  return data.access_token;
}

function toDateBB(iso) {
  const [y,m,d] = iso.split('-');
  return `${parseInt(d)}${m}${y}`;
}

async function fetchExtratos(token, agencia, conta, dataIni, dataFim) {
  const base = cfg.ambiente === 'producao' ? 'https://api-extratos.bb.com.br' : 'https://api.sandbox.bb.com.br';
  const tlsOpts = {};
  if (cfg.cert_path && cfg.key_path && fs.existsSync(cfg.cert_path) && fs.existsSync(cfg.key_path)) {
    tlsOpts.cert = fs.readFileSync(cfg.cert_path);
    tlsOpts.key  = fs.readFileSync(cfg.key_path);
  }
  
  let pagina = 1, todos = [];
  while (true) {
    const params = new URLSearchParams({
      'gw-dev-app-key': cfg.app_key,
      dataInicioSolicitacao: toDateBB(dataIni),
      dataFimSolicitacao:    toDateBB(dataFim),
      numeroPaginaSolicitacao: String(pagina),
      quantidadeRegistroPaginaSolicitacao: '50',
    });
    const url = `${base}/extratos/v1/conta-corrente/agencia/${agencia}/conta/${conta}?${params}`;
    const resp = await httpsReq(url, { headers: { 'Authorization': `Bearer ${token}` }, ...tlsOpts });
    if (resp.status < 200 || resp.status >= 300) {
      console.log(`  BB API ${resp.status}: ${resp.text().substring(0,200)}`);
      break;
    }
    const data = resp.json();
    const lista = (data.listaLancamento || []).filter(l =>
      !(l.textoDescricaoHistorico||'').toUpperCase().includes('SALDO ANTERIOR')
    );
    todos.push(...lista);
    if (!data.indicadorContinuidade || data.indicadorContinuidade === 'N') break;
    pagina++;
    await new Promise(r => setTimeout(r, 800));
  }
  return todos;
}

function sinalParaValor(lancamento) {
  const valor = parseFloat(lancamento.valorLancamento || 0);
  const tipo  = (lancamento.indicadorSinalLancamento || 'C').toUpperCase();
  return tipo === 'D' ? -Math.abs(valor) : Math.abs(valor);
}

(async () => {
  console.log('\n📥 Sync extratos março/2026 — Montana Segurança\n');
  const token = await getToken();
  console.log('  ✅ Token BB obtido');

  // Verifica contas configuradas
  const contas = [{ agencia: cfg.agencia, conta: cfg.conta, desc: 'Conta principal' }];
  try {
    const extra = JSON.parse(getCfg('bb_contas_extra') || '[]');
    contas.push(...extra.map(e => ({ agencia: e.agencia, conta: e.conta, desc: e.descricao||e.conta })));
  } catch(_) {}

  const insExtrato = db.prepare(`
    INSERT OR IGNORE INTO extratos(data_iso, historico, credito, debito, conta, banco, mes)
    VALUES(?,?,?,?,?,?,?)
  `);

  let totalNovos = 0;
  for (const c of contas) {
    console.log(`\n  Conta ${c.conta} (${c.desc}):`);
    const lancamentos = await fetchExtratos(token, c.agencia, c.conta, '2026-03-01', '2026-03-31');
    console.log(`  → ${lancamentos.length} lançamentos recebidos do BB`);

    db.pragma('foreign_keys = OFF');
    const tx = db.transaction(() => {
      for (const l of lancamentos) {
        const valor  = sinalParaValor(l);
        const dataStr = String(l.dataLancamento || '');
        let dataIso = null;
        if (dataStr.length === 8) {
          // formato DDMMAAAA
          dataIso = `${dataStr.slice(4)}−${dataStr.slice(2,4)}-${dataStr.slice(0,2)}`;
        } else if (dataStr.includes('-')) {
          dataIso = dataStr.substring(0, 10);
        }
        if (!dataIso) return;
        const hist = l.textoDescricaoHistorico || '';
        const cred = valor > 0 ? valor  : 0;
        const deb  = valor < 0 ? Math.abs(valor) : 0;
        const res  = insExtrato.run(dataIso, hist, cred, deb, c.conta, 'BB', dataIso.substring(0,7));
        totalNovos += res.changes;
      }
    });
    tx();
    db.pragma('foreign_keys = ON');
  }

  console.log(`\n  ✅ ${totalNovos} novos lançamentos inseridos`);
  console.log('  Agora rode: node scripts/conciliacao_seguranca.js\n');
})();
