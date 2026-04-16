#!/usr/bin/env node
/**
 * Configura credenciais Banco do Brasil para Montana Segurança
 * Executar no servidor: node scripts/setup_bb_seguranca.js
 */
'use strict';
const path = require('path');
const Database = require('better-sqlite3');

const ROOT    = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'seguranca', 'montana.db');
const CERT    = path.join(ROOT, 'certificados', 'seguranca_cert.pem');
const KEY     = path.join(ROOT, 'certificados', 'seguranca_key.pem');

const db = new Database(DB_PATH);

const set = (k, v) => db.prepare(`
  INSERT INTO configuracoes(chave, valor) VALUES(?, ?)
  ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor, updated_at=datetime('now')
`).run(k, v || '');

// Credenciais BB Produção — arquivo setup_bb_seguranca.js
set('bb_app_key',       process.env.BB_APP_KEY       || '');
set('bb_client_id',     process.env.BB_CLIENT_ID     || '');
set('bb_client_secret', process.env.BB_CLIENT_SECRET || '');
set('bb_agencia',       process.env.BB_AGENCIA       || '');
set('bb_conta',         process.env.BB_CONTA         || '');
set('bb_ambiente',      'producao');
set('bb_scope',         'extrato-info');
set('bb_cert_path',     CERT);
set('bb_key_path',      KEY);

db.close();

// Verificação
const db2 = new Database(DB_PATH, { readonly: true });
const rows = db2.prepare(`SELECT chave, valor FROM configuracoes WHERE chave LIKE 'bb_%' ORDER BY chave`).all();
db2.close();

console.log('\n  Configurações BB salvas:\n');
for (const r of rows) {
  const mask = ['bb_client_id','bb_client_secret','bb_app_key'].includes(r.chave);
  const val  = mask && r.valor.length > 12
    ? r.valor.substring(0, 8) + '...' + r.valor.slice(-4)
    : r.valor;
  const ok   = r.valor ? '✅' : '⚠️ ';
  console.log(`  ${ok}  ${r.chave}: ${val}`);
}
console.log();
