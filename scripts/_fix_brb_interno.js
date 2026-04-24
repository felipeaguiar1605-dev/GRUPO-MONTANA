'use strict';
/**
 * Corrige lançamentos BRB FUNDACAO UNIVERSIDAD classificados como INTERNO
 * e desfaz vínculos NF↔extrato incorretos.
 *
 * Correções:
 *  1. Extrato BRB Feb 13 (510028570-510028575): INTERNO → PENDENTE
 *  2. Extrato BRB Mar 11 (510028582-510028587): INTERNO/CONCILIADO → PENDENTE
 *  3. NF 874 (UNITINS): desvincula do extrato BRB 510028571 → PENDENTE
 *  4. NF 845 (UFT MOTORISTA Mar 202): desvincula do extrato BRB 510028583 → PENDENTE
 *  5. NF 294 (id=724, UFT MOTORISTA Abr Porto Nacional, liq=21.491,95):
 *     desvincula do extrato BRB Mar 11 510028586 → vincula ao BRB Abr 15 689645455
 *  6. Extrato BRB Apr 15 689645453 (39.862,12): confirma CONCILIADO (já está)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const db = getDb('assessoria');

console.log('=== CORREÇÕES BRB FUNDACAO UNIVERSIDAD ===\n');

db.transaction(() => {

  // 1. BRB Feb 13 → PENDENTE
  const feb13Ids = [510028570, 510028571, 510028572, 510028573, 510028574, 510028575];
  const r1 = db.prepare(
    `UPDATE extratos SET status_conciliacao = 'PENDENTE', updated_at = datetime('now')
     WHERE id IN (${feb13Ids.join(',')}) AND status_conciliacao = 'INTERNO'`
  ).run();
  console.log('1. BRB Feb 13 INTERNO → PENDENTE:', r1.changes, 'extratos');

  // 2. BRB Mar 11 → PENDENTE (os 4 que são INTERNO)
  const mar11InternIds = [510028582, 510028584, 510028585, 510028587];
  const r2 = db.prepare(
    `UPDATE extratos SET status_conciliacao = 'PENDENTE', updated_at = datetime('now')
     WHERE id IN (${mar11InternIds.join(',')}) AND status_conciliacao = 'INTERNO'`
  ).run();
  console.log('2. BRB Mar 11 INTERNO → PENDENTE:', r2.changes, 'extratos');

  // 3. NF 874 (UNITINS) — desvincula do extrato BRB 510028571
  const r3 = db.prepare(
    `UPDATE notas_fiscais SET extrato_id = NULL, status_conciliacao = 'PENDENTE'
     WHERE id = 874`
  ).run();
  console.log('3. NF 874 (UNITINS 166) desvinculada de BRB 510028571 → PENDENTE:', r3.changes);

  // 4. NF 845 (UFT MOTORISTA Mar 202) — desvincula do extrato BRB 510028583
  const r4 = db.prepare(
    `UPDATE notas_fiscais SET extrato_id = NULL, status_conciliacao = 'PENDENTE'
     WHERE id = 845`
  ).run();
  console.log('4. NF 845 (UFT MOTORISTA Mar 202, liq=20.602,05) desvinculada de BRB 510028583 → PENDENTE:', r4.changes);

  // 5a. Extrato BRB Mar 11 510028583 (20.902,16) → PENDENTE (estava CONCILIADO errado)
  const r5a = db.prepare(
    `UPDATE extratos SET status_conciliacao = 'PENDENTE', updated_at = datetime('now')
     WHERE id = 510028583`
  ).run();
  console.log('5a. Extrato BRB Mar 11 510028583 (20.902,16) → PENDENTE:', r5a.changes);

  // 5b. Extrato BRB Mar 11 510028586 (21.491,95) → PENDENTE (estava com NF de abril)
  const r5b = db.prepare(
    `UPDATE extratos SET status_conciliacao = 'PENDENTE', updated_at = datetime('now')
     WHERE id = 510028586`
  ).run();
  console.log('5b. Extrato BRB Mar 11 510028586 (21.491,95) → PENDENTE:', r5b.changes);

  // 5c. NF 294 (id=724, UFT MOTORISTA Apr Porto Nacional, liq=21.491,95):
  //     Liga ao extrato BRB Abr 15 689645455 (exato match)
  const r5c = db.prepare(
    `UPDATE notas_fiscais SET extrato_id = 689645455, status_conciliacao = 'CONCILIADO',
     data_pagamento = '2026-04-15' WHERE id = 724`
  ).run();
  console.log('5c. NF 294 (id=724, Porto Nacional) → BRB Abr 15 extrato 689645455 CONCILIADO:', r5c.changes);

  // 5d. Extrato BRB Abr 15 689645455 (21.491,95) → CONCILIADO
  const r5d = db.prepare(
    `UPDATE extratos SET status_conciliacao = 'CONCILIADO', updated_at = datetime('now')
     WHERE id = 689645455`
  ).run();
  console.log('5d. Extrato BRB Abr 15 689645455 (21.491,95) → CONCILIADO:', r5d.changes);

})();

// ── Verificação ─────────────────────────────────────────────────────────────
console.log('\n=== VERIFICAÇÃO FINAL ===');

console.log('\nBRB Feb 13:');
db.prepare(`SELECT id, credito, historico, status_conciliacao
            FROM extratos WHERE data_iso = '2026-02-13' AND banco = 'BRB' ORDER BY id`
).all().forEach(r => console.log(`  id=${r.id} R$${r.credito} [${r.status_conciliacao}] ${r.historico}`));

console.log('\nBRB Mar 11:');
db.prepare(`SELECT id, credito, historico, status_conciliacao
            FROM extratos WHERE data_iso = '2026-03-11' AND banco = 'BRB' ORDER BY id`
).all().forEach(r => console.log(`  id=${r.id} R$${r.credito} [${r.status_conciliacao}] ${r.historico}`));

console.log('\nBRB Abr 15:');
db.prepare(`SELECT id, credito, historico, status_conciliacao
            FROM extratos WHERE data_iso = '2026-04-15' AND banco = 'BRB' ORDER BY id`
).all().forEach(r => console.log(`  id=${r.id} R$${r.credito} [${r.status_conciliacao}]`));

console.log('\nNFs afetadas:');
[874, 845, 724, 723].forEach(nfId => {
  const r = db.prepare('SELECT id, numero, contrato_ref, valor_liquido, status_conciliacao, extrato_id, data_pagamento FROM notas_fiscais WHERE id = ?').get(nfId);
  console.log(`  id=${r.id} NF=${r.numero} liq=${r.valor_liquido} [${r.status_conciliacao}] extrato=${r.extrato_id} pago=${r.data_pagamento} contrato=${r.contrato_ref}`);
});

// Resumo BRB pendências
console.log('\n=== BRB Resumo por mês/status ===');
db.prepare(`SELECT data_iso, status_conciliacao, COUNT(*) cnt, SUM(credito) total
            FROM extratos WHERE banco = 'BRB' AND credito > 0
            GROUP BY data_iso, status_conciliacao ORDER BY data_iso`
).all().forEach(r => console.log(`  ${r.data_iso} [${r.status_conciliacao}] ${r.cnt}x R$${r.total?.toFixed(2)}`));

console.log('\n✔️  Concluído.');
