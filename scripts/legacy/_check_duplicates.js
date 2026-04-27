'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');
for (const emp of ['assessoria', 'seguranca']) {
  const db = getDb(emp);
  const total = db.prepare(`SELECT COUNT(*) c FROM pagamentos_portal WHERE portal='palmas'`).get().c;
  const dup = db.prepare(`SELECT hash_unico, COUNT(*) c FROM pagamentos_portal WHERE portal='palmas' GROUP BY hash_unico HAVING c>1`).all();
  const nfDup = db.prepare(`SELECT numero, COUNT(*) c FROM notas_fiscais GROUP BY numero HAVING c>1`).all();
  const extDup = db.prepare(`SELECT data_iso, credito, debito, COUNT(*) c FROM extratos WHERE credito>0 OR debito>0 GROUP BY data_iso,credito,debito HAVING c>1`).all();
  console.log(emp.toUpperCase() + ': pagamentos_portal=' + total + ' (dups:' + dup.length + ') | NFs dup:' + nfDup.length + ' | Ext dup:' + extDup.length);
}
