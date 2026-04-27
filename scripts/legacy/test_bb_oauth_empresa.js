#!/usr/bin/env node
/**
 * Testa OAuth + endpoint de extratos do Banco do Brasil para qualquer empresa.
 * Uso:
 *   node scripts/test_bb_oauth_empresa.js --empresa=portodovau
 *   node scripts/test_bb_oauth_empresa.js --empresa=seguranca --dias=7
 */
'use strict';
const path  = require('path');
const https = require('https');
const fs    = require('fs');
const Database = require('better-sqlite3');

const ARG      = process.argv.slice(2);
const arg      = (k, def='') => (ARG.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || def;
const EMPRESA  = arg('empresa', 'portodovau');
const DIAS     = parseInt(arg('dias', '7'), 10);
const VERBOSE  = ARG.includes('--verbose');

const ROOT    = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', EMPRESA, 'montana.db');

if (!fs.existsSync(DB_PATH)) {
  console.error(`❌ DB não encontrado: ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
const get = k => { const r = db.prepare('SELECT valor FROM configuracoes WHERE chave=?').get(k); return r?.valor || ''; };

const cfg = {
  clientId:     get('bb_client_id'),
  clientSecret: get('bb_client_secret'),
  appKey:       get('bb_app_key'),
  ambiente:     get('bb_ambiente') || 'producao',
  scope:        get('bb_scope')    || 'extrato-info',
  certPath:     get('bb_cert_path'),
  keyPath:      get('bb_key_path'),
  pfxPath:      get('bb_pfx_path'),
  pfxPassphrase:get('bb_pfx_passphrase'),
  agencia:      get('bb_agencia'),
  conta:        get('bb_conta'),
};
db.close();

console.log(`\n  🏢 Empresa: ${EMPRESA}`);
console.log(`  Configuração:`);
console.log(`    ambiente:   ${cfg.ambiente}`);
console.log(`    app_key:    ${cfg.appKey ? cfg.appKey.substring(0,8) + '...' : '❌ vazio'}`);
console.log(`    client_id:  ${cfg.clientId ? cfg.clientId.substring(0,12) + '...' : '❌ vazio'}`);
if (cfg.pfxPath && fs.existsSync(cfg.pfxPath)) {
  console.log(`    pfx:        ✅ ${cfg.pfxPath}`);
  console.log(`    pfx_pass:   ${cfg.pfxPassphrase ? '✅ definida' : '⚠️  vazia'}`);
} else {
  console.log(`    cert:       ${cfg.certPath && fs.existsSync(cfg.certPath) ? '✅ ' + cfg.certPath : '❌ não encontrado (' + cfg.certPath + ')'}`);
  console.log(`    key:        ${cfg.keyPath  && fs.existsSync(cfg.keyPath)  ? '✅ ' + cfg.keyPath  : '❌ não encontrado (' + cfg.keyPath  + ')'}`);
}
console.log(`    agencia:    ${cfg.agencia || '⚠️  não configurada'}`);
console.log(`    conta:      ${cfg.conta   || '⚠️  não configurada'}`);
console.log();

if (!cfg.clientId || !cfg.clientSecret || !cfg.appKey) {
  console.error('  ❌ Credenciais incompletas. Rode setup_bb_' + EMPRESA + '.js primeiro.');
  process.exit(1);
}

const tlsOpts = {};
if (cfg.pfxPath && fs.existsSync(cfg.pfxPath)) {
  tlsOpts.pfx = fs.readFileSync(cfg.pfxPath);
  if (cfg.pfxPassphrase) tlsOpts.passphrase = cfg.pfxPassphrase;
  console.log('  🔒 mTLS ativado (PFX)');
} else if (cfg.certPath && cfg.keyPath && fs.existsSync(cfg.certPath) && fs.existsSync(cfg.keyPath)) {
  tlsOpts.cert = fs.readFileSync(cfg.certPath);
  tlsOpts.key  = fs.readFileSync(cfg.keyPath);
  console.log('  🔒 mTLS ativado (PEM)');
} else {
  console.log('  ⚠️  Sem mTLS — produção BB exige certificado, teste pode falhar');
}

const oauthBase = cfg.ambiente === 'producao' ? 'oauth.bb.com.br' : 'oauth.sandbox.bb.com.br';
const apiBase   = cfg.ambiente === 'producao' ? 'api-extratos.bb.com.br' : 'api.sandbox.bb.com.br';

function httpsReq(hostname, pathname, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, port: 443, path: pathname, method, headers, ...tlsOpts,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  // 1) OAuth
  console.log(`\n  🔑 OAuth ${oauthBase}...`);
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const body  = `grant_type=client_credentials&scope=${cfg.scope}`;

  const tokenResp = await httpsReq(oauthBase, '/oauth/token', 'POST', {
    'Authorization':  `Basic ${basic}`,
    'Content-Type':   'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body),
  }, body);

  if (tokenResp.status !== 200) {
    console.log(`  ❌ OAuth HTTP ${tokenResp.status}:`);
    console.log('  ', tokenResp.body.substring(0, 500));
    process.exit(1);
  }
  const tkn = JSON.parse(tokenResp.body);
  console.log(`  ✅ token (${tkn.token_type}, expira ${tkn.expires_in}s): ${tkn.access_token.substring(0,30)}...`);

  // 2) Teste endpoint extratos (últimos N dias)
  if (!cfg.agencia || !cfg.conta) {
    console.log('\n  ⚠️  agencia/conta não configuradas — pulando teste de extratos.');
    return;
  }
  const hoje = new Date();
  const ini  = new Date(hoje); ini.setDate(ini.getDate() - DIAS);
  const toDateBB = d => {
    const day = d.getDate();
    const mm  = String(d.getMonth()+1).padStart(2,'0');
    const yy  = d.getFullYear();
    return `${day}${mm}${yy}`;
  };

  const params = new URLSearchParams({
    'gw-dev-app-key':              cfg.appKey,
    dataInicioSolicitacao:         toDateBB(ini),
    dataFimSolicitacao:            toDateBB(hoje),
    numeroPaginaSolicitacao:       '1',
    quantidadeRegistroPaginaSolicitacao: '50',
  });
  const extPath = `/extratos/v1/conta-corrente/agencia/${cfg.agencia}/conta/${cfg.conta}?${params}`;

  console.log(`\n  📥 GET ${apiBase}${extPath.substring(0, 80)}...`);
  const extResp = await httpsReq(apiBase, extPath, 'GET', {
    'Authorization': `Bearer ${tkn.access_token}`,
  });
  if (extResp.status < 200 || extResp.status >= 300) {
    console.log(`  ❌ Extratos HTTP ${extResp.status}:`);
    console.log('  ', extResp.body.substring(0, 500));
    process.exit(1);
  }
  const extData = JSON.parse(extResp.body);
  const lista   = extData.listaLancamento || extData.lancamentos || [];
  console.log(`  ✅ ${lista.length} lançamento(s) retornado(s) nos últimos ${DIAS} dias`);
  if (VERBOSE && lista.length) {
    console.log('\n  Amostra (primeiros 3):');
    lista.slice(0, 3).forEach(l => {
      const sinal = (l.indicadorSinalLancamento || l.indicadorTipoLancamento || '').toUpperCase();
      console.log(`    ${l.dataLancamento}  ${sinal}  R$ ${l.valorLancamento}  — ${(l.textoDescricaoHistorico||'').substring(0,50)}`);
    });
  }
  console.log('\n  🎉 Porto do Vau pronto para sync automático via API BB.\n');
})().catch(e => { console.error('\n  ❌ Erro:', e.message); process.exit(1); });
