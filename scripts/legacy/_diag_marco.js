'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');
const db = getDb('assessoria');

console.log('\n=== EXTRATOS MARÇO 2026 ===');
const ext = db.prepare(`
  SELECT status_conciliacao, COUNT(*) qtd, ROUND(SUM(credito),2) total
  FROM extratos WHERE credito > 0 AND data_iso BETWEEN '2026-03-01' AND '2026-03-31'
  GROUP BY status_conciliacao ORDER BY total DESC
`).all();
ext.forEach(r => console.log(JSON.stringify(r)));

console.log('\n=== EXTRATOS MARÇO 2026 CONCILIADOS (top 20) ===');
const extConc = db.prepare(`
  SELECT id, data_iso, credito, historico, contrato_vinculado, status_conciliacao
  FROM extratos WHERE credito > 0 AND data_iso BETWEEN '2026-03-01' AND '2026-03-31'
    AND status_conciliacao = 'CONCILIADO'
  ORDER BY credito DESC LIMIT 20
`).all();
extConc.forEach(r => console.log(JSON.stringify(r)));

console.log('\n=== NFs CONCILIADAS com data_emissao em jan-mar/2026 ===');
const nfs = db.prepare(`
  SELECT contrato_ref, substr(data_emissao,1,7) mes, COUNT(*) qtd, ROUND(SUM(valor_liquido),2) soma
  FROM notas_fiscais WHERE status_conciliacao='CONCILIADO' AND data_emissao BETWEEN '2026-01-01' AND '2026-03-31'
  GROUP BY contrato_ref, mes ORDER BY contrato_ref, mes
`).all();
nfs.forEach(r => console.log(JSON.stringify(r)));
