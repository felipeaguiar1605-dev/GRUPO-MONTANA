'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'data', 'seguranca', 'montana.db'));
const set = (k, v) => db.prepare(`
  INSERT INTO configuracoes(chave, valor) VALUES(?, ?)
  ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor, updated_at=datetime('now')
`).run(k, v);
set('bb_agencia', '1505');
set('bb_conta',   '66620');
db.close();
console.log('OK — agencia 1505 / conta 66620 salvas');
