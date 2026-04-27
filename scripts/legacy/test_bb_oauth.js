#!/usr/bin/env node
/**
 * Testa conexão OAuth com a API do Banco do Brasil
 * Usa credenciais já salvas no banco da Segurança
 */
'use strict';
const path  = require('path');
const https = require('https');
const fs    = require('fs');
const Database = require('better-sqlite3');

const ROOT    = path.join(__dirname, '..');
const db      = new Database(path.join(ROOT, 'data', 'seguranca', 'montana.db'), { readonly: true });

const get = k => { const r = db.prepare('SELECT valor FROM configuracoes WHERE chave=?').get(k); return r?.valor || ''; };

const clientId     = get('bb_client_id');
const clientSecret = get('bb_client_secret');
const appKey       = get('bb_app_key');
const ambiente     = get('bb_ambiente');
const certPath     = get('bb_cert_path');
const keyPath      = get('bb_key_path');
const agencia      = get('bb_agencia');
const conta        = get('bb_conta');
db.close();

console.log('\n  Configuração carregada:');
console.log(`  ambiente:  ${ambiente}`);
console.log(`  app_key:   ${appKey.substring(0,8)}...`);
console.log(`  client_id: ${clientId.substring(0,12)}...`);
console.log(`  cert:      ${fs.existsSync(certPath) ? '✅ ' + certPath : '❌ não encontrado'}`);
console.log(`  key:       ${fs.existsSync(keyPath)  ? '✅ ' + keyPath  : '❌ não encontrado'}`);
console.log(`  agencia:   ${agencia || '⚠️  não configurada'}`);
console.log(`  conta:     ${conta   || '⚠️  não configurada'}`);
console.log();

if (!clientId || !clientSecret || !appKey) {
  console.error('  ❌ Credenciais incompletas. Execute setup_bb_seguranca.js primeiro.');
  process.exit(1);
}

const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
const body  = 'grant_type=client_credentials&scope=extrato-info';

const tlsOpts = {};
if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  tlsOpts.cert = fs.readFileSync(certPath);
  tlsOpts.key  = fs.readFileSync(keyPath);
  console.log('  🔒 mTLS ativado');
} else {
  console.log('  ⚠️  Sem mTLS — tentando sem certificado');
}

const oauthBase = ambiente === 'producao' ? 'oauth.bb.com.br' : 'oauth.sandbox.bb.com.br';
console.log(`  🔑 Testando OAuth em ${oauthBase}...\n`);

const req = https.request({
  hostname: oauthBase, port: 443,
  path: '/oauth/token', method: 'POST',
  ...tlsOpts,
  headers: {
    'Authorization':  `Basic ${basic}`,
    'Content-Type':   'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body),
  },
}, res => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    try {
      const r = JSON.parse(data);
      if (r.access_token) {
        console.log(`  ✅ OAuth OK! Token obtido (${r.token_type}, expira em ${r.expires_in}s)`);
        console.log(`  Token: ${r.access_token.substring(0, 30)}...`);

        if (!agencia || !conta) {
          console.log('\n  ⚠️  Falta agência e conta para fazer o sync de extratos.');
          console.log('  Configure com: node scripts/setup_bb_seguranca.js (passando BB_AGENCIA e BB_CONTA)');
        } else {
          console.log(`\n  ✅ Pronto para sync! Agência ${agencia} · Conta ${conta}`);
        }
      } else {
        console.log(`  ❌ OAuth falhou (HTTP ${res.statusCode}):`);
        console.log('  ', JSON.stringify(r, null, 2));
      }
    } catch (e) {
      console.log(`  ❌ Resposta inválida (${res.statusCode}):`, data.substring(0, 200));
    }
  });
});

req.on('error', e => {
  console.error('  ❌ Erro de conexão:', e.message);
  if (e.code === 'ECONNRESET' || e.message.includes('certificate')) {
    console.log('  💡 Dica: o endpoint de produção pode exigir mTLS. Verifique os caminhos do certificado.');
  }
});

req.write(body);
req.end();
