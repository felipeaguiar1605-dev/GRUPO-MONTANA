#!/usr/bin/env node
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

for (const emp of ['assessoria','seguranca','portodovau','mustang']) {
  try {
    const db = getDb(emp);
    console.log('\n=== ' + emp + ' ===');
    const rows = db.prepare(`
      SELECT substr(data_iso,1,7) as mes, COUNT(*) qtd,
             COALESCE(SUM(credito),0) cred, COALESCE(SUM(debito),0) deb
      FROM extratos
      WHERE data_iso >= '2026-01-01'
      GROUP BY substr(data_iso,1,7)
      ORDER BY mes DESC
    `).all();
    for (const r of rows) console.log('  ', r.mes, '|', r.qtd, 'lancs | C:', Math.round(r.cred), '| D:', Math.round(r.deb));
    // Ultimo registro importado
    const last = db.prepare(`SELECT data_iso, historico, credito, debito, created_at FROM extratos ORDER BY id DESC LIMIT 3`).all();
    console.log('  Ultimos 3 registros (por id desc):');
    for (const r of last) console.log('    ', r.data_iso, '|', (r.historico||'').slice(0,40), '| C:', r.credito, '| D:', r.debito, '| at:', r.created_at);
  } catch(e) { console.log(emp, 'ERR', e.message); }
}
