#!/usr/bin/env node
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

for (const emp of ['assessoria','seguranca']) {
  const db = getDb(emp);
  console.log('\n=== ' + emp + ' ===');
  const rows = db.prepare(`
    SELECT substr(data_iso,1,7) as data_mes, mes, COUNT(*) qtd
    FROM extratos
    WHERE data_iso >= '2026-01-01'
    GROUP BY substr(data_iso,1,7), mes
    ORDER BY data_mes DESC, mes
  `).all();
  for (const r of rows) console.log('  data_iso=' + r.data_mes, '| mes=' + JSON.stringify(r.mes), '| qtd=' + r.qtd);
  // Tambem: quantos abril sem mes=ABR
  const bug = db.prepare(`SELECT COUNT(*) cnt FROM extratos WHERE data_iso LIKE '2026-04-%' AND (mes IS NULL OR mes != 'ABR')`).get();
  console.log('  >> April rows sem mes=ABR:', bug.cnt);
  // Schema
  const cols = db.prepare(`PRAGMA table_info(extratos)`).all().map(c => c.name + ':' + c.type);
  console.log('  schema:', cols.join(', '));
}
