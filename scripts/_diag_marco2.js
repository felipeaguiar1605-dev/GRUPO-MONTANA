'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');
const db = getDb('assessoria');

const ext = db.prepare(`
  SELECT credito, historico, contrato_vinculado
  FROM extratos
  WHERE status_conciliacao='CONCILIADO' AND credito>0
    AND data_iso BETWEEN '2026-03-01' AND '2026-03-31'
  ORDER BY credito DESC
`).all();

// Dedup por valor
const seen = new Map();
for (const e of ext) {
  const k = e.credito.toFixed(2);
  if (!seen.has(k) || (!seen.get(k).contrato_vinculado && e.contrato_vinculado)) seen.set(k, e);
}
console.log('\nExtratos MARÇO 2026 únicos por valor:');
[...seen.values()].sort((a,b)=>b.credito-a.credito).forEach(e =>
  console.log(
    String(e.credito.toFixed(2)).padStart(14),
    ' | contrato:', (e.contrato_vinculado||'').padEnd(30),
    ' | hist:', (e.historico||'').substring(0,55)
  )
);
