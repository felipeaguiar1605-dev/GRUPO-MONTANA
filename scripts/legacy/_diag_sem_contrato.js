'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');
const db = getDb('assessoria');

const rows = db.prepare(`
  SELECT contrato_ref, tomador, COUNT(*) qtd, ROUND(SUM(valor_liquido),2) total
  FROM notas_fiscais
  WHERE status_conciliacao='CONCILIADO'
    AND (contrato_ref='' OR contrato_ref IS NULL)
    AND data_emissao >= '2024-01-01'
  GROUP BY contrato_ref, tomador
  ORDER BY total DESC
`).all();

console.log('\n  NFs CONCILIADAS sem contrato_ref (2024+):');
rows.forEach(r => console.log(`  ${(r.tomador||'').substring(0,50).padEnd(52)} ${String(r.qtd).padStart(5)} NFs  →  R$${r.total.toLocaleString('pt-BR',{minimumFractionDigits:2})}`));
console.log('');
