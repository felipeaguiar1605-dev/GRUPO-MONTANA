/**
 * Concilia NFs 206 e 299 — UFT Motoristas Reitoria fev/mar 2026
 *
 * Padrão idêntico ao NF 122 (jan/2026):
 *   NF 206 (fev/2026): extrato BRB id=510028584 | 2026-03-11 | R$28.644,51
 *   NF 299 (abr/2026): extrato BRB id=689645454 | 2026-04-15 | R$28.644,51
 *
 * Ambos os extratos estão PENDENTE e diferença = 0.00 (match exato).
 */
const Database = require('better-sqlite3');
const db = new Database('data/assessoria/montana.db');

const FIXES = [
  { nf_id: 841, extrato_id: 510028584, data_pag: '2026-03-11', label: 'NF 206 (fev/2026)' },
  { nf_id: 719, extrato_id: 689645454, data_pag: '2026-04-15', label: 'NF 299 (abr/2026)' },
];

// ─── Verificação pré-update ───────────────────────────────────────────────────
console.log('PRÉ-UPDATE:');
for (const f of FIXES) {
  const nf  = db.prepare('SELECT id, numero, valor_liquido, status_conciliacao, extrato_id FROM notas_fiscais WHERE id = ?').get(f.nf_id);
  const ext = db.prepare('SELECT id, data_iso, credito, status_conciliacao FROM extratos WHERE id = ?').get(f.extrato_id);
  console.log(`  ${f.label}:`);
  console.log(`    NF:     ${JSON.stringify(nf)}`);
  console.log(`    Extrato:${JSON.stringify(ext)}`);
  if (!nf)  { console.error(`❌ NF id=${f.nf_id} não encontrada`);  db.close(); process.exit(1); }
  if (!ext) { console.error(`❌ Extrato id=${f.extrato_id} não encontrado`); db.close(); process.exit(1); }
  if (nf.status_conciliacao === 'CONCILIADO') {
    console.log(`  ⚠  ${f.label} já CONCILIADO — pulando`);
  }
}

// ─── Aplicar em transação ─────────────────────────────────────────────────────
const apply = db.transaction(() => {
  let total = 0;
  for (const f of FIXES) {
    const nf = db.prepare('SELECT status_conciliacao FROM notas_fiscais WHERE id = ?').get(f.nf_id);
    if (nf.status_conciliacao === 'CONCILIADO') continue;

    db.prepare(`
      UPDATE notas_fiscais
      SET status_conciliacao = 'CONCILIADO',
          extrato_id         = ?,
          data_pagamento     = ?
      WHERE id = ?
    `).run(f.extrato_id, f.data_pag, f.nf_id);

    db.prepare(`
      UPDATE extratos
      SET status_conciliacao = 'CONCILIADO'
      WHERE id = ?
    `).run(f.extrato_id);

    total++;
    console.log(`  ✅ ${f.label} conciliada`);
  }
  return total;
});

console.log('\nAplicando...');
const n = apply();
console.log(`\n✅ ${n} NF(s) conciliadas`);

// ─── Estado final das 3 NFs Reitoria ─────────────────────────────────────────
console.log('\n=== Estado final — NFs Reitoria UFT Motoristas ===');
db.prepare(`
  SELECT id, numero, data_emissao, data_pagamento, valor_bruto, valor_liquido,
         status_conciliacao, extrato_id
  FROM notas_fiscais
  WHERE id IN (905, 841, 719)
  ORDER BY id DESC
`).all().forEach(r => console.log(JSON.stringify(r)));

// ─── Extratos BRB Reitoria conciliados ───────────────────────────────────────
console.log('\n=== Extratos BRB Reitoria conciliados ===');
db.prepare(`
  SELECT id, data_iso, credito, status_conciliacao
  FROM extratos
  WHERE id IN (510028574, 510028584, 689645454)
  ORDER BY data_iso
`).all().forEach(e => console.log(JSON.stringify(e)));

db.close();
