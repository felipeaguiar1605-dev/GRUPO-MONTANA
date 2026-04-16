'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const empA = getDb('assessoria');
const empS = getDb('seguranca');

console.log('\n====================================================');
console.log('DIAGNÓSTICO DE CONTAMINAÇÃO — Montana ERP');
console.log('====================================================\n');

// ── 1. NOTAS FISCAIS ────────────────────────────────────────────────────────

// 1a. NFs da Segurança com status=ASSESSORIA (já sabemos que existem)
const nfAssessoria = empS.prepare(`
  SELECT status_conciliacao, tomador, COUNT(*) as cnt, SUM(valor_liquido) as total
  FROM notas_fiscais
  WHERE status_conciliacao = 'ASSESSORIA'
  GROUP BY tomador ORDER BY cnt DESC
`).all();
console.log('=== [SEGURANÇA] NFs marcadas como ASSESSORIA (contaminadas) ===');
console.log('Total tomadores:', nfAssessoria.length);
nfAssessoria.forEach(r => console.log(`  ${r.tomador?.substring(0,40).padEnd(40)} | ${r.cnt} NFs | R$ ${r.total?.toFixed(2)}`));

// 1b. NFs da Assessoria com tomadores que parecem ser da Segurança
const nfSuspA = empA.prepare(`
  SELECT tomador, COUNT(*) as cnt, SUM(valor_liquido) as total,
         MIN(data_emissao) as primeira, MAX(data_emissao) as ultima
  FROM notas_fiscais
  WHERE tomador LIKE '%PALMAS%' OR tomador LIKE '%MUNICIPIO%' OR tomador LIKE '%SEMUS%'
     OR tomador LIKE '%SEDUC%' OR tomador LIKE '%MP%' OR tomador LIKE '%MINISTERIO%'
  GROUP BY tomador ORDER BY cnt DESC
`).all();
console.log('\n=== [ASSESSORIA] NFs com tomadores que podem ser da Segurança ===');
nfSuspA.forEach(r => console.log(`  ${r.tomador?.substring(0,50).padEnd(50)} | ${r.cnt} NFs | R$ ${r.total?.toFixed(2)} | ${r.primeira} → ${r.ultima}`));

// 1c. NFs da Segurança com tomadores que parecem ser da Assessoria
const nfSuspS = empS.prepare(`
  SELECT tomador, COUNT(*) as cnt, SUM(valor_liquido) as total,
         MIN(data_emissao) as primeira, MAX(data_emissao) as ultima
  FROM notas_fiscais
  WHERE status_conciliacao != 'ASSESSORIA'
    AND (tomador LIKE '%UFT%' OR tomador LIKE '%UNITINS%' OR tomador LIKE '%DETRAN%'
         OR tomador LIKE '%TCE%' OR tomador LIKE '%CBMTO%' OR tomador LIKE '%SEMARH%'
         OR tomador LIKE '%FUNJURIS%' OR tomador LIKE '%PREVI%' OR tomador LIKE '%UFNT%')
  GROUP BY tomador ORDER BY cnt DESC
`).all();
console.log('\n=== [SEGURANÇA] NFs com tomadores tipicamente da Assessoria ===');
nfSuspS.forEach(r => console.log(`  ${r.tomador?.substring(0,50).padEnd(50)} | ${r.cnt} NFs | R$ ${r.total?.toFixed(2)} | ${r.primeira} → ${r.ultima}`));

// ── 2. EXTRATOS BANCÁRIOS ────────────────────────────────────────────────────

// 2a. Assessoria: créditos com CNPJ da Segurança (19.200.109)
const extCnpjSeg = empA.prepare(`
  SELECT DISTINCT substr(data_iso,1,7) as mes, COUNT(*) as cnt, SUM(credito) as total
  FROM extratos
  WHERE historico LIKE '%19200109%' AND credito > 0
  GROUP BY mes ORDER BY mes DESC
`).all();
console.log('\n=== [ASSESSORIA] Extratos com CNPJ da Segurança (19200109) ===');
extCnpjSeg.forEach(r => console.log(`  ${r.mes} | ${r.cnt} registros | R$ ${r.total?.toFixed(2)}`));

// 2b. Segurança: créditos com CNPJ da Assessoria (14.092.519)
const extCnpjAss = empS.prepare(`
  SELECT DISTINCT substr(data_iso,1,7) as mes, COUNT(*) as cnt, SUM(credito) as total
  FROM extratos
  WHERE historico LIKE '%14092519%' AND credito > 0
  GROUP BY mes ORDER BY mes DESC
`).all();
console.log('\n=== [SEGURANÇA] Extratos com CNPJ da Assessoria (14092519) ===');
extCnpjAss.forEach(r => console.log(`  ${r.mes} | ${r.cnt} registros | R$ ${r.total?.toFixed(2)}`));

// 2c. Assessoria: débitos com CNPJ da Segurança (pagamentos internos legítimos ou contaminação?)
const debSeg = empA.prepare(`
  SELECT substr(data_iso,1,7) as mes, COUNT(*) as cnt, SUM(debito) as total
  FROM extratos
  WHERE historico LIKE '%19200109%' AND debito > 0
  GROUP BY mes ORDER BY mes DESC
`).all();
console.log('\n=== [ASSESSORIA] Débitos com CNPJ da Segurança ===');
debSeg.forEach(r => console.log(`  ${r.mes} | ${r.cnt} | R$ ${r.total?.toFixed(2)}`));

// 2d. Verificar se os mesmos lançamentos existem em AMBOS os bancos (duplicação de importação)
console.log('\n=== CRUZAMENTO: mesmos valores em datas iguais nos dois bancos ===');
const extA_mar = empA.prepare(`SELECT data_iso, credito FROM extratos WHERE data_iso LIKE '2026-03%' AND credito > 0`).all();
const extS_mar = empS.prepare(`SELECT data_iso, credito FROM extratos WHERE data_iso LIKE '2026-03%' AND credito > 0`).all();
const setS = new Set(extS_mar.map(e => `${e.data_iso}|${Number(e.credito).toFixed(2)}`));
const duplicados = extA_mar.filter(e => setS.has(`${e.data_iso}|${Number(e.credito).toFixed(2)}`));
// Deduplicar
const dupUniq = new Map();
duplicados.forEach(e => { const k = `${e.data_iso}|${Number(e.credito).toFixed(2)}`; dupUniq.set(k, e); });
const dupArr = [...dupUniq.values()];
console.log(`Lançamentos com mesmo data+valor nos dois bancos (mar/26): ${dupArr.length}`);
const totalDup = dupArr.reduce((a,b)=>a+b.credito,0);
console.log(`Valor total: R$ ${totalDup.toFixed(2)}`);
dupArr.slice(0,15).forEach(e => console.log(`  ${e.data_iso} | R$ ${Number(e.credito).toFixed(2)}`));

// ── 3. CONTRATOS ────────────────────────────────────────────────────────────

// 3a. Contratos da Assessoria que parecem ser da Segurança
const contA = empA.prepare(`SELECT * FROM contratos`).all();
console.log('\n=== [ASSESSORIA] Todos os contratos ===');
contA.forEach(c => console.log(`  ${c.id} | ${c.numContrato || c.contrato} | ${c.orgao} | R$ ${(c.valor_mensal_bruto||0).toFixed(2)}`));

// 3b. Contratos da Segurança
const contS = empS.prepare(`SELECT * FROM contratos`).all();
console.log('\n=== [SEGURANÇA] Todos os contratos ===');
contS.forEach(c => console.log(`  ${c.id} | ${c.numContrato || c.contrato} | ${c.orgao} | R$ ${(c.valor_mensal_bruto||0).toFixed(2)}`));

// 3c. Há NFs de contratos da Segurança vinculadas a contratos da Assessoria?
console.log('\n=== NFs da Segurança por contrato_ref ===');
const nfContS = empS.prepare(`
  SELECT contrato_ref, COUNT(*) as cnt, SUM(valor_liquido) as total
  FROM notas_fiscais
  WHERE status_conciliacao != 'ASSESSORIA'
  GROUP BY contrato_ref ORDER BY cnt DESC LIMIT 20
`).all();
nfContS.forEach(r => console.log(`  "${r.contrato_ref}" | ${r.cnt} NFs | R$ ${r.total?.toFixed(2)}`));

// 3d. NFs da Assessoria por contrato_ref
console.log('\n=== NFs da Assessoria por contrato_ref ===');
const nfContA = empA.prepare(`
  SELECT contrato_ref, COUNT(*) as cnt, SUM(valor_liquido) as total
  FROM notas_fiscais
  GROUP BY contrato_ref ORDER BY cnt DESC LIMIT 20
`).all();
nfContA.forEach(r => console.log(`  "${r.contrato_ref}" | ${r.cnt} NFs | R$ ${r.total?.toFixed(2)}`));

// ── 4. EXTRATOS — visão geral de contaminação ────────────────────────────────

// 4a. Pagadores suspeitos no extrato da Assessoria (não são clientes da Assessoria)
const pagadoresSuspA = empA.prepare(`
  SELECT
    CASE
      WHEN historico LIKE '%PALMAS%' OR historico LIKE '%MUNICIPIO%' THEN 'PALMAS'
      WHEN historico LIKE '%19200109%' THEN 'MONTANA SEG (CNPJ)'
      WHEN historico LIKE '%SEDUC%' THEN 'SEDUC'
      WHEN historico LIKE '%MP%TO%' OR historico LIKE '%MINISTERIO%' THEN 'MP/TO'
    END as origem,
    COUNT(*) as cnt, SUM(credito) as total_cred
  FROM extratos
  WHERE credito > 0
    AND (historico LIKE '%PALMAS%' OR historico LIKE '%MUNICIPIO%'
         OR historico LIKE '%19200109%' OR historico LIKE '%MP%TO%')
  GROUP BY origem
`).all();
console.log('\n=== [ASSESSORIA] Créditos por origem suspeita (todos os meses) ===');
pagadoresSuspA.forEach(r => console.log(`  ${r.origem} | ${r.cnt} registros | R$ ${r.total_cred?.toFixed(2)}`));

// 4b. Status conciliação — resumo geral de ambas as empresas
console.log('\n=== STATUS CONCILIAÇÃO — RESUMO GERAL ===');
['assessoria','seguranca'].forEach(emp => {
  const db = emp === 'assessoria' ? empA : empS;
  const res = db.prepare(`
    SELECT status_conciliacao, COUNT(*) as cnt, SUM(valor_liquido) as total
    FROM notas_fiscais GROUP BY status_conciliacao ORDER BY cnt DESC
  `).all();
  console.log(`\n  [${emp.toUpperCase()}] NFs por status:`);
  res.forEach(r => console.log(`    ${(r.status_conciliacao||'null').padEnd(15)} | ${r.cnt} NFs | R$ ${r.total?.toFixed(2)}`));
});

console.log('\n====================================================');
console.log('FIM DO DIAGNÓSTICO');
console.log('====================================================\n');
