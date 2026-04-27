#!/usr/bin/env node
/**
 * Configura credenciais Banco do Brasil para Porto do Vau Segurança Privada.
 *
 * Uso (passando via env):
 *   BB_APP_KEY=xxx BB_CLIENT_ID=xxx BB_CLIENT_SECRET=xxx \
 *   BB_AGENCIA=1234 BB_CONTA=56789 \
 *   node scripts/setup_bb_portodovau.js
 *
 * Certificado esperado em:
 *   app_unificado/certificados/portodovau_cert.pem  (chain: leaf+intermediários)
 *   app_unificado/certificados/portodovau_key.pem   (chave privada)
 *
 * Para extrair cert+key de uma .pfx:
 *   openssl pkcs12 -in "Porto do Vau.pfx" -nocerts -out portodovau_key.pem -nodes
 *   openssl pkcs12 -in "Porto do Vau.pfx" -clcerts -nokeys -out portodovau_cert.pem
 */
'use strict';
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const ROOT    = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'portodovau', 'montana.db');
// Preferência: usar .pfx direto (já existe no repo). Fallback para cert.pem/key.pem
const PFX     = path.join(ROOT, 'certificados', 'portodovau.pfx');
const CERT    = path.join(ROOT, 'certificados', 'portodovau_cert.pem');
const KEY     = path.join(ROOT, 'certificados', 'portodovau_key.pem');

if (!fs.existsSync(DB_PATH)) {
  console.error('❌ DB não encontrado em', DB_PATH);
  process.exit(1);
}

const db = new Database(DB_PATH);

// garante tabela configuracoes
db.prepare(`
  CREATE TABLE IF NOT EXISTS configuracoes (
    chave TEXT PRIMARY KEY,
    valor TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )
`).run();

const set = (k, v) => db.prepare(`
  INSERT INTO configuracoes(chave, valor) VALUES(?, ?)
  ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor, updated_at=datetime('now')
`).run(k, v || '');

set('bb_app_key',       process.env.BB_APP_KEY       || '');
set('bb_client_id',     process.env.BB_CLIENT_ID     || '');
set('bb_client_secret', process.env.BB_CLIENT_SECRET || '');
set('bb_agencia',       process.env.BB_AGENCIA       || '');
set('bb_conta',         process.env.BB_CONTA         || '');
set('bb_ambiente',      'producao');
set('bb_scope',         'extrato-info');

// Se .pfx existe, usamos ele direto (mais simples); senão, cert.pem + key.pem
if (fs.existsSync(PFX)) {
  set('bb_pfx_path',       PFX);
  set('bb_pfx_passphrase', process.env.BB_PFX_PASSPHRASE || '');
} else {
  set('bb_cert_path',      CERT);
  set('bb_key_path',       KEY);
}

db.close();

// Verificação
const db2 = new Database(DB_PATH, { readonly: true });
const rows = db2.prepare(`SELECT chave, valor FROM configuracoes WHERE chave LIKE 'bb_%' ORDER BY chave`).all();
db2.close();

console.log('\n  Configurações BB (Porto do Vau) salvas:\n');
for (const r of rows) {
  const mask = ['bb_client_id','bb_client_secret','bb_app_key'].includes(r.chave);
  const val  = mask && r.valor.length > 12
    ? r.valor.substring(0, 8) + '...' + r.valor.slice(-4)
    : r.valor;
  const ok   = r.valor ? '✅' : '⚠️ ';
  console.log(`  ${ok}  ${r.chave}: ${val}`);
}
console.log();
if (fs.existsSync(PFX)) {
  console.log(`  pfx:   ✅ ${PFX}`);
  console.log(`  pass:  ${process.env.BB_PFX_PASSPHRASE ? '✅ definida' : '⚠️  vazia (se .pfx tem senha, passe BB_PFX_PASSPHRASE)'}`);
} else {
  console.log(`  cert:  ${fs.existsSync(CERT) ? '✅ ' + CERT : '❌ NÃO EXISTE ' + CERT}`);
  console.log(`  key:   ${fs.existsSync(KEY)  ? '✅ ' + KEY  : '❌ NÃO EXISTE ' + KEY}`);
}
console.log();
