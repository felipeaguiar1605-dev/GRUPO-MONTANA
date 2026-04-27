'use strict';
/**
 * Corrige NFs UFT MOTORISTA 05/2025 — Janeiro e Fevereiro 2026
 *
 * Problema: valor_liquido importado via WebISS = bruto - ISS (apenas).
 *           Correto = bruto - ISS - INSS(11%) - IRRF(4,8%) - PIS/COFINS/CSLL(4,65%)
 *           Além disso, a conciliação automática linkou NFs a extratos BB errados
 *           (pagamentos de limpeza/batch UFT) em vez dos BRB corretos.
 *
 * NFs de Janeiro (serviço 03/01 a 02/02/2026) — pagas via BRB 13/02/2026:
 *   NF 118 Arraias       id=909 → BRB 510028570 (R$16.428,01, diff 214,61 aceito)
 *   NF 119 Gurupi        id=908 → BRB 510028571 (R$20.902,16) ✓
 *   NF 120 Miracema      id=907 → BRB 510028572 (R$16.225,88) ✓
 *   NF 121 Palmas        id=906 → BRB 510028573 (R$39.862,12) ✓
 *   NF 122 Reitoria      id=905 → PENDENTE (liq=60.219,33 ≠ OB=28.644,51)
 *   NF 123 Porto Nacional id=904 → BRB 510028575 (R$21.491,95) ✓
 *
 * NFs de Fevereiro (serviço 03/02 a 02/03/2026) — pagas via BRB 11/03/2026:
 *   NF 202 Arraias       id=845 → BRB 510028582 (R$16.428,01, diff 214,61 aceito)
 *   NF 203 Gurupi        id=844 → BRB 510028583 (R$20.902,16) ✓
 *   NF 204 Miracema      id=843 → BRB 510028587 (R$16.225,88) ✓
 *   NF 205 Palmas        id=842 → BRB 510028585 (R$39.862,12) ✓
 *   NF 206 Reitoria      id=841 → PENDENTE (liq=60.219,33 ≠ OB=28.644,51)
 *   NF 207 Porto Nacional id=840 → BRB 510028586 (R$21.491,95) ✓
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');
const db = getDb('assessoria');

// ─── Dados das NFs (verificados nos PDFs) ────────────────────────────────────
const FIXES = [
  // Janeiro — BRB 13/02/2026
  { id: 909, num: '118', campus: 'Arraias',          liq: 16213.40, pis: 139.49,  cofins: 643.81,   brbId: 510028570, pagto: '2026-02-13' },
  { id: 908, num: '119', campus: 'Gurupi',           liq: 20902.16, pis: 182.25,  cofins: 841.13,   brbId: 510028571, pagto: '2026-02-13' },
  { id: 907, num: '120', campus: 'Miracema',         liq: 16225.88, pis: 137.78,  cofins: 635.89,   brbId: 510028572, pagto: '2026-02-13' },
  { id: 906, num: '121', campus: 'Palmas',           liq: 39862.12, pis: 347.56,  cofins: 1604.11,  brbId: 510028573, pagto: '2026-02-13' },
  { id: 905, num: '122', campus: 'Palmas-Reitoria',  liq: 60219.33, pis: 525.05,  cofins: 2423.31,  brbId: null,      pagto: null         }, // PENDENTE
  { id: 904, num: '123', campus: 'Porto Nacional',   liq: 21491.95, pis: 187.39,  cofins: 864.87,   brbId: 510028575, pagto: '2026-02-13' },
  // Fevereiro — BRB 11/03/2026
  { id: 845, num: '202', campus: 'Arraias',          liq: 16213.40, pis: 139.49,  cofins: 643.81,   brbId: 510028582, pagto: '2026-03-11' },
  { id: 844, num: '203', campus: 'Gurupi',           liq: 20902.16, pis: 182.25,  cofins: 841.13,   brbId: 510028583, pagto: '2026-03-11' },
  { id: 843, num: '204', campus: 'Miracema',         liq: 16225.88, pis: 137.78,  cofins: 635.89,   brbId: 510028587, pagto: '2026-03-11' },
  { id: 842, num: '205', campus: 'Palmas',           liq: 39862.12, pis: 347.56,  cofins: 1604.11,  brbId: 510028585, pagto: '2026-03-11' },
  { id: 841, num: '206', campus: 'Palmas-Reitoria',  liq: 60219.33, pis: 525.05,  cofins: 2423.31,  brbId: null,      pagto: null         }, // PENDENTE
  { id: 840, num: '207', campus: 'Porto Nacional',   liq: 21491.95, pis: 187.39,  cofins: 864.87,   brbId: 510028586, pagto: '2026-03-11' },
];

console.log('=== FIX UFT MOTORISTA — BRB Jan/Fev 2026 ===\n');

db.transaction(() => {

  for (const nf of FIXES) {
    const before = db.prepare(
      'SELECT valor_liquido, status_conciliacao, extrato_id FROM notas_fiscais WHERE id = ?'
    ).get(nf.id);

    if (!before) { console.log(`⚠️  NF id=${nf.id} não encontrada`); continue; }

    if (nf.brbId) {
      // ── Caso com match BRB ──────────────────────────────────────────────────
      // 1. Atualizar NF: liq correto + vincula BRB + CONCILIADO
      db.prepare(`
        UPDATE notas_fiscais
        SET valor_liquido = ?, pis = ?, cofins = ?,
            extrato_id = ?, data_pagamento = ?,
            status_conciliacao = 'CONCILIADO'
        WHERE id = ?
      `).run(nf.liq, nf.pis, nf.cofins, nf.brbId, nf.pagto, nf.id);

      // 2. Marcar extrato BRB como CONCILIADO
      db.prepare(`
        UPDATE extratos SET status_conciliacao = 'CONCILIADO', updated_at = datetime('now')
        WHERE id = ? AND status_conciliacao = 'PENDENTE'
      `).run(nf.brbId);

      console.log(`✅ NF ${nf.num} ${nf.campus.padEnd(16)} liq: ${before.valor_liquido} → ${nf.liq} | extrato: ${before.extrato_id ?? 'null'} → BRB ${nf.brbId} [CONCILIADO]`);

    } else {
      // ── Caso Palmas-Reitoria (sem match BRB) ────────────────────────────────
      // Só corrige liq e PIS/COFINS. Desvincula do extrato BB errado. Status = PENDENTE.
      db.prepare(`
        UPDATE notas_fiscais
        SET valor_liquido = ?, pis = ?, cofins = ?,
            extrato_id = NULL, data_pagamento = NULL,
            status_conciliacao = 'PENDENTE'
        WHERE id = ?
      `).run(nf.liq, nf.pis, nf.cofins, nf.id);

      console.log(`⏳ NF ${nf.num} ${nf.campus.padEnd(16)} liq: ${before.valor_liquido} → ${nf.liq} | extrato: ${before.extrato_id ?? 'null'} → NULL [PENDENTE — aguarda confirmação OB BRB]`);
    }
  }

})();

// ─── Verificação final ───────────────────────────────────────────────────────
console.log('\n=== VERIFICAÇÃO FINAL ===\n');

console.log('NFs Janeiro 2026 (BRB Feb 13):');
[909, 908, 907, 906, 905, 904].forEach(id => {
  const r = db.prepare(
    'SELECT id, numero, valor_liquido, pis, cofins, status_conciliacao, extrato_id, data_pagamento FROM notas_fiscais WHERE id = ?'
  ).get(id);
  const e = r.extrato_id
    ? db.prepare('SELECT id, data_iso, credito, banco, status_conciliacao FROM extratos WHERE id = ?').get(r.extrato_id)
    : null;
  const eStr = e ? `→ extrato ${e.id} ${e.banco} ${e.data_iso} R$${e.credito} [${e.status_conciliacao}]` : '→ sem extrato';
  console.log(`  NF ${r.numero.slice(-3)} liq=${r.valor_liquido} pis=${r.pis} [${r.status_conciliacao}] ${eStr}`);
});

console.log('\nNFs Fevereiro 2026 (BRB Mar 11):');
[845, 844, 843, 842, 841, 840].forEach(id => {
  const r = db.prepare(
    'SELECT id, numero, valor_liquido, pis, cofins, status_conciliacao, extrato_id, data_pagamento FROM notas_fiscais WHERE id = ?'
  ).get(id);
  const e = r.extrato_id
    ? db.prepare('SELECT id, data_iso, credito, banco, status_conciliacao FROM extratos WHERE id = ?').get(r.extrato_id)
    : null;
  const eStr = e ? `→ extrato ${e.id} ${e.banco} ${e.data_iso} R$${e.credito} [${e.status_conciliacao}]` : '→ sem extrato';
  console.log(`  NF ${r.numero.slice(-3)} liq=${r.valor_liquido} pis=${r.pis} [${r.status_conciliacao}] ${eStr}`);
});

console.log('\nBRB Feb 13 status:');
db.prepare("SELECT id, credito, status_conciliacao FROM extratos WHERE data_iso='2026-02-13' AND banco='BRB' AND credito > 0 ORDER BY credito DESC")
  .all().forEach(r => console.log(`  id=${r.id} R$${r.credito} [${r.status_conciliacao}]`));

console.log('\nBRB Mar 11 status:');
db.prepare("SELECT id, credito, status_conciliacao FROM extratos WHERE data_iso='2026-03-11' AND banco='BRB' AND credito > 0 ORDER BY credito DESC")
  .all().forEach(r => console.log(`  id=${r.id} R$${r.credito} [${r.status_conciliacao}]`));

// Base PIS/COFINS impactada
console.log('\n=== IMPACTO NA BASE PIS/COFINS ===');
const base = db.prepare(`
  SELECT SUM(nf.valor_bruto) bruto, SUM(nf.pis) pis_ret, SUM(nf.cofins) cofins_ret
  FROM notas_fiscais nf
  JOIN extratos e ON e.id = nf.extrato_id
  WHERE e.banco = 'BRB'
    AND e.data_iso BETWEEN '2026-02-01' AND '2026-03-31'
    AND nf.data_emissao >= '2026-01-01'
    AND nf.status_conciliacao = 'CONCILIADO'
    AND nf.contrato_ref = 'UFT MOTORISTA 05/2025'
`).get();
console.log(`  UFT MOTORISTA conciliado (BRB Fev+Mar): bruto=R$${base?.bruto?.toFixed(2)} | pis_ret=R$${base?.pis_ret?.toFixed(2)} | cofins_ret=R$${base?.cofins_ret?.toFixed(2)}`);

console.log('\n✔️  Concluído.');
