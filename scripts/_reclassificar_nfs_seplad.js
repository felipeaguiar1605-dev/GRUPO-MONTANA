/**
 * Reclassifica NFs do MUNICIPIO DE PALMAS que foram rotuladas incorretamente
 * como contrato_ref = 'PREFEITURA 062/2024'.
 *
 * Evidência (coletada em auditoria):
 *   - CNPJ 24.851.511/0019-04 → SEPLAD (sub-unidade) — valores R$ 60-77k/mês
 *     (bate com SEPLAD 002/2024 — encerrado, R$ 77.702,70/mês após reajuste)
 *   - CNPJ 24.851.511/0013-19 → PREFEITURA INFRAESTRUTURA — valores R$ 3-4M/mês
 *     (bate com PREFEITURA 062/2024 REAL, R$ 3,5M/mês no DB)
 *   - CNPJ 24.851.511/0001-85 → CNPJ raiz da Prefeitura (1 NF pequena R$ 62k = SEPLAD,
 *     1 NF de R$ 0,01 = cancelamento)
 *
 * Estratégia:
 *   DRY-RUN por default. Passe --apply para aplicar as mudanças.
 */
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const db = new Database('data/assessoria/montana.db');

const nfs = db.prepare(`
  SELECT id, numero, data_emissao, valor_bruto, cnpj_tomador, contrato_ref, status_conciliacao
  FROM notas_fiscais
  WHERE contrato_ref = 'PREFEITURA 062/2024'
    AND REPLACE(REPLACE(REPLACE(cnpj_tomador,'.',''),'/',''),'-','') LIKE '%24851511%'
  ORDER BY data_emissao
`).all();

console.log(`\n📋 Auditoria — ${nfs.length} NFs encontradas com contrato_ref='PREFEITURA 062/2024' e CNPJ MUNICIPIO DE PALMAS\n`);

const plan = { paraSeplad: [], manterPrefeitura: [], investigar: [] };

for (const n of nfs) {
  const cnpjClean = String(n.cnpj_tomador).replace(/\D/g, '');
  const sub = cnpjClean.slice(8);      // últimos 6 dígitos = filial + dv

  // /0019-04 = sub 001904, /0013-19 = sub 001319, /0001-85 = sub 000185
  if (sub === '001904') {
    plan.paraSeplad.push(n);
  } else if (sub === '001319') {
    plan.manterPrefeitura.push(n);
  } else if (sub === '000185' && n.valor_bruto < 100000) {
    plan.paraSeplad.push(n);  // valor pequeno = SEPLAD provável
  } else if (sub === '000185' && n.valor_bruto < 1) {
    // R$ 0.01 — cancelamento, manter como está
    plan.investigar.push(n);
  } else {
    plan.investigar.push(n);
  }
}

console.log(`→ ${plan.paraSeplad.length} NFs serão reclassificadas para 'SEPLAD 002/2024 — encerrado'`);
plan.paraSeplad.forEach(n => console.log(`    [${n.id}] ${n.data_emissao} R$ ${n.valor_bruto.toFixed(2).padStart(12)} NF ${n.numero} (CNPJ ...${String(n.cnpj_tomador).slice(-7)})`));

console.log(`\n→ ${plan.manterPrefeitura.length} NFs mantêm 'PREFEITURA 062/2024' (contrato INFRAESTRUTURA)`);
plan.manterPrefeitura.forEach(n => console.log(`    [${n.id}] ${n.data_emissao} R$ ${n.valor_bruto.toFixed(2).padStart(14)} NF ${n.numero}`));

if (plan.investigar.length) {
  console.log(`\n⚠ ${plan.investigar.length} NFs precisam de investigação manual`);
  plan.investigar.forEach(n => console.log(`    [${n.id}] ${n.data_emissao} R$ ${n.valor_bruto.toFixed(2).padStart(12)} NF ${n.numero} (CNPJ ${n.cnpj_tomador})`));
}

if (!APPLY) {
  console.log(`\n💡 DRY-RUN — use --apply para efetivar as mudanças`);
  db.close();
  return;
}

console.log(`\n✏️ Aplicando mudanças...`);
db.pragma('foreign_keys = OFF');

const upd = db.prepare(`UPDATE notas_fiscais SET contrato_ref = ? WHERE id = ?`);

let n = 0;
for (const nf of plan.paraSeplad) {
  upd.run('SEPLAD 002/2024 — encerrado', nf.id);
  n++;
}

db.pragma('foreign_keys = ON');
console.log(`✓ ${n} NFs reclassificadas para SEPLAD 002/2024 — encerrado`);

// Re-check counts
const countSeplad = db.prepare(`SELECT COUNT(*) c, SUM(valor_bruto) total FROM notas_fiscais WHERE contrato_ref = 'SEPLAD 002/2024 — encerrado'`).get();
const countPref = db.prepare(`SELECT COUNT(*) c, SUM(valor_bruto) total FROM notas_fiscais WHERE contrato_ref = 'PREFEITURA 062/2024'`).get();
console.log(`\nTotais pós-reclassificação:`);
console.log(`  SEPLAD 002/2024 — encerrado: ${countSeplad.c} NFs, R$ ${Number(countSeplad.total).toFixed(2)}`);
console.log(`  PREFEITURA 062/2024        : ${countPref.c} NFs, R$ ${Number(countPref.total).toFixed(2)}`);

db.close();
