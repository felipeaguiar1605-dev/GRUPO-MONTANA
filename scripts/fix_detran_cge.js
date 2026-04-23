'use strict';
/**
 * Fix DETRAN conciliation in Montana Assessoria using CGE (Controladoria Geral do Estado)
 * as authoritative source for payment→NF mappings.
 *
 * Problems found:
 *   1. DETRAN NFs matched to Palmas OBs (different payer — Prefeitura de Palmas, not DETRAN)
 *   2. DETRAN NFs matched to Rende Fácil (investment returns, not payments)
 *   3. DETRAN NFs matched to internal Montana transfers
 *   4. Extrato 510028376 (R$430K DETRAN Mar/2026) has wrong NFs (sep/25) — should have fev/26 NFs 84-114
 *
 * CGE confirmed March 2026 DETRAN → Montana Assessoria payments:
 *   seq 175: NFs 84-114  (fev/26 billing), R$430,496.43, paid 18/03/2026 → extrato 510028376 ✓
 *   seq 178: NFs 06-37   (jan/26 billing), R$430,496.43, paid 18/03/2026 → no bank extrato found (import incomplete)
 *   seq 184: NFs 193,195,209-237 (mar/26), R$430,496.43, paid 31/03/2026 → no bank extrato found
 *
 * Uso:
 *   node scripts/fix_detran_cge.js [--dry-run]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const DRY = process.argv.includes('--dry-run');
const db  = getDb('assessoria');

console.log(`\n🔧 Fix DETRAN conciliation (CGE-based)${DRY ? ' [DRY-RUN]' : ''}\n`);

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseValBR(s) {
  if (!s) return 0;
  return parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0;
}

/** Parse NF range string from CGE num_doc_fiscal into array of short numbers */
function parseCgeNfRange(str) {
  const nums = [];
  // Normalise: "84 A 114" / "06 a 37" / "193 e 195, 209 a 237" / "1260 a 1291"
  const parts = str.split(/[,;]/);
  for (const part of parts) {
    const p = part.trim().toUpperCase();
    const range = p.match(/^(\d+)\s+[AE]\s+(\d+)$/);
    if (range) {
      const from = parseInt(range[1]);
      const to   = parseInt(range[2]);
      for (let n = from; n <= to; n++) nums.push(n);
    } else {
      const single = p.match(/^(\d+)$/);
      if (single) nums.push(parseInt(single[1]));
    }
  }
  return nums;
}

/** Find DB NF ids for a list of short numbers and a competencia month */
function findNfsByShortNums(nums, comp2Digit) {
  // NFs can be stored as "202600000000084" (15-digit) or short "84"
  // comp2Digit example: "2026-02" (for fev/26)
  const ids = [];
  for (const n of nums) {
    const padded   = String(n).padStart(6, '0');
    const full2026 = '202600000000' + padded;
    const full2025 = '202500000000' + padded;
    const res = db.prepare(`
      SELECT id, numero, competencia, status_conciliacao, extrato_id
      FROM notas_fiscais
      WHERE tomador LIKE '%DETRAN%'
        AND (
          numero = ?
          OR numero = ?
          OR numero = ?
          OR (CAST(numero AS INT) = ? AND LENGTH(numero) < 10)
        )
      ORDER BY id
    `).all(full2026, full2025, String(n), n);
    ids.push(...res);
  }
  return ids;
}

let totalFixed = 0;
const report = [];

// ─── Step 1: Unlink DETRAN NFs on Palmas OBs ───────────────────────────────
console.log('Step 1: Remove DETRAN NFs from Palmas OBs (extrato 457-468, 583)');

const PALMAS_EXTRATOS = [457, 461, 464, 466, 467, 468, 583];
const nfsOnPalmas = db.prepare(`
  SELECT id, numero, competencia, valor_liquido, extrato_id
  FROM notas_fiscais
  WHERE tomador LIKE '%DETRAN%'
    AND extrato_id IN (${PALMAS_EXTRATOS.join(',')})
`).all();
console.log(`  ${nfsOnPalmas.length} NFs to unlink from Palmas OBs`);

if (!DRY && nfsOnPalmas.length) {
  for (const nf of nfsOnPalmas) {
    db.prepare(`
      UPDATE notas_fiscais
      SET extrato_id=NULL, status_conciliacao='PENDENTE', data_pagamento=NULL
      WHERE id=?
    `).run(nf.id);
    totalFixed++;
    report.push({ step: 1, nf_id: nf.id, numero: nf.numero, comp: nf.competencia, acao: 'PENDENTE ← Palmas OB' });
  }
}

// ─── Step 2: Unlink DETRAN NFs on Rende Fácil / internal transfers ─────────
console.log('\nStep 2: Remove DETRAN NFs from Rende Fácil and Montana internal transfers');

const RENDAS_EXTRATOS = [1865, 2127, 2797, 3913, 510015835, 510016032];
const nfsOnRendas = db.prepare(`
  SELECT n.id, n.numero, n.competencia, n.valor_liquido, n.extrato_id, e.historico
  FROM notas_fiscais n
  JOIN extratos e ON e.id = n.extrato_id
  WHERE n.tomador LIKE '%DETRAN%'
    AND n.extrato_id IN (${RENDAS_EXTRATOS.join(',')})
`).all();
console.log(`  ${nfsOnRendas.length} NFs to unlink from investments/internal`);

if (!DRY && nfsOnRendas.length) {
  for (const nf of nfsOnRendas) {
    db.prepare(`
      UPDATE notas_fiscais
      SET extrato_id=NULL, status_conciliacao='PENDENTE', data_pagamento=NULL
      WHERE id=?
    `).run(nf.id);
    totalFixed++;
    report.push({ step: 2, nf_id: nf.id, numero: nf.numero, comp: nf.competencia, acao: 'PENDENTE ← Rende/Interno' });
  }
}

// ─── Step 3: Fix extrato 510028376 (R$430K DETRAN 18/03/2026) ──────────────
// CGE seq 175: NFs 84-114 (fev/26), R$430,496.43 → extrato 510028376
console.log('\nStep 3: Fix extrato 510028376 (R$430,496.43 DETRAN 18/03/2026)');
console.log('  CGE seq 175: NFs "84 A 114" (fev/26)');

const EXTRATO_DETRAN_MAR18 = 510028376;

// 3a: Unlink wrong NFs from this extrato (sep/25 NFs that don't belong here)
const wrongOnMar18 = db.prepare(`
  SELECT id, numero, competencia FROM notas_fiscais
  WHERE extrato_id = ? AND tomador LIKE '%DETRAN%'
`).all(EXTRATO_DETRAN_MAR18);

console.log(`  Wrong NFs currently on 510028376: ${wrongOnMar18.length}`);
wrongOnMar18.forEach(n => console.log(`    NF ${n.id} ${n.numero} ${n.competencia}`));

if (!DRY && wrongOnMar18.length) {
  for (const nf of wrongOnMar18) {
    db.prepare(`
      UPDATE notas_fiscais
      SET extrato_id=NULL, status_conciliacao='PENDENTE', data_pagamento=NULL
      WHERE id=?
    `).run(nf.id);
    totalFixed++;
    report.push({ step: 3, nf_id: nf.id, numero: nf.numero, comp: nf.competencia, acao: 'PENDENTE ← wrong on 510028376' });
  }
}

// 3b: Link NFs 84-114 (fev/26) to extrato 510028376
// NF number format: YYYY + sequential padded to 11 digits = 15 chars total
// e.g. NF 84 → '202600000000084', NF 1262 → '202500000001262'
function nfFullNum(year, seq) {
  return String(year) + String(seq).padStart(11, '0');
}

const nums84to114 = [];
for (let i = 84; i <= 114; i++) nums84to114.push(i);

const stmtFindNF = db.prepare(`
  SELECT id, numero, competencia, valor_liquido, status_conciliacao, extrato_id
  FROM notas_fiscais
  WHERE tomador LIKE '%DETRAN%'
    AND (numero = ? OR (CAST(numero AS INT) = ? AND LENGTH(numero) < 10))
    AND status_conciliacao != 'CANCELADA'
  ORDER BY id LIMIT 1
`);

const nfsToLink84_114 = [];
for (const n of nums84to114) {
  const full = nfFullNum(2026, n);
  const found = stmtFindNF.get(full, n);
  if (found) nfsToLink84_114.push(found);
}

console.log(`\n  NFs fev/26 (84-114) found in DB: ${nfsToLink84_114.length}`);
nfsToLink84_114.slice(0, 5).forEach(n => console.log(`    ${n.id} ${n.numero} ${n.competencia} R$${n.valor_liquido} [${n.status_conciliacao}]`));
if (nfsToLink84_114.length > 5) console.log(`    ... (${nfsToLink84_114.length - 5} more)`);

if (!DRY && nfsToLink84_114.length) {
  for (const nf of nfsToLink84_114) {
    db.prepare(`
      UPDATE notas_fiscais
      SET extrato_id=?, status_conciliacao='CONCILIADO', data_pagamento='2026-03-18'
      WHERE id=?
    `).run(EXTRATO_DETRAN_MAR18, nf.id);
    totalFixed++;
    report.push({ step: 3, nf_id: nf.id, numero: nf.numero, comp: nf.competencia, acao: 'CONCILIADO → 510028376 (CGE seq 175)' });
  }
  // Update extrato status
  db.prepare(`UPDATE extratos SET status_conciliacao='CONCILIADO', contrato_vinculado='DETRAN 41/2023 + 2°TA' WHERE id=?`).run(EXTRATO_DETRAN_MAR18);
}

// ─── Step 4: NFs 06-37 (jan/26) — CGE seq 178, paid 18/03/2026 ────────────
// Bank extrato not found (incomplete import). Mark as PAGO_SEM_COMPROVANTE.
// Only update NFs that are currently PENDENTE (don't disturb ones already correctly linked).
console.log('\nStep 4: NFs 06-37 (jan/26) — CGE seq 178 paid 18/03/2026');
console.log('  No bank extrato found for this OB. Marking PAGO_SEM_COMPROVANTE on CGE-confirmed date.');

const nums06to37 = [];
for (let i = 6; i <= 37; i++) nums06to37.push(i);

let countSeq178 = 0;
for (const n of nums06to37) {
  const found = stmtFindNF.get(nfFullNum(2026, n), n);
  if (found && (found.status_conciliacao === 'PENDENTE' || found.extrato_id === null)) {
    if (!DRY) {
      db.prepare(`
        UPDATE notas_fiscais
        SET status_conciliacao='PAGO_SEM_COMPROVANTE', data_pagamento='2026-03-18',
            extrato_id=NULL
        WHERE id=?
      `).run(found.id);
    }
    countSeq178++;
    totalFixed++;
    report.push({ step: 4, nf_id: found.id, numero: found.numero, comp: found.competencia, acao: 'PAGO_SEM_COMPROVANTE (CGE seq 178)' });
  }
}
console.log(`  Updated ${countSeq178} NFs to PAGO_SEM_COMPROVANTE`);

// ─── Step 5: NFs 193,195,209-237 (mar/26) — CGE seq 184, paid 31/03/2026 ──
console.log('\nStep 5: NFs 193,195,209-237 (mar/26) — CGE seq 184 paid 31/03/2026');

const numsSeq184 = parseCgeNfRange('193 e 195, 209 a 237');
console.log(`  NF numbers: [${numsSeq184.join(', ')}]`);

// Find the March 31 extrato (R$430K)
const mar31ExtDBEntry = db.prepare(`
  SELECT id, data_iso, credito, historico FROM extratos
  WHERE data_iso = '2026-03-31' AND credito BETWEEN 380000 AND 480000
  LIMIT 1
`).get();
console.log(`  Bank extrato for 31/03: ${mar31ExtDBEntry ? `${mar31ExtDBEntry.id} R$${mar31ExtDBEntry.credito}` : 'NOT FOUND (import incomplete)'}`);

let countSeq184 = 0;
for (const n of numsSeq184) {
  const found = stmtFindNF.get(nfFullNum(2026, n), n);
  if (found) {
    if (mar31ExtDBEntry) {
      // Link to the bank extrato
      if (!DRY) {
        db.prepare(`
          UPDATE notas_fiscais
          SET extrato_id=?, status_conciliacao='CONCILIADO', data_pagamento='2026-03-31'
          WHERE id=?
        `).run(mar31ExtDBEntry.id, found.id);
      }
      report.push({ step: 5, nf_id: found.id, numero: found.numero, comp: found.competencia, acao: `CONCILIADO → ${mar31ExtDBEntry.id} (CGE seq 184)` });
    } else {
      // No extrato found, mark PAGO_SEM_COMPROVANTE
      if (!DRY && (found.status_conciliacao === 'PENDENTE' || found.extrato_id === null)) {
        db.prepare(`
          UPDATE notas_fiscais
          SET status_conciliacao='PAGO_SEM_COMPROVANTE', data_pagamento='2026-03-31',
              extrato_id=NULL
          WHERE id=?
        `).run(found.id);
      }
      report.push({ step: 5, nf_id: found.id, numero: found.numero, comp: found.competencia, acao: 'PAGO_SEM_COMPROVANTE (CGE seq 184, sem extrato)' });
    }
    countSeq184++;
    totalFixed++;
  }
}
console.log(`  Updated ${countSeq184} NFs`);

// ─── Step 6: Fix NFs 06-37 currently on wrong Jan-2026 DETRAN TEDs ────────
// CGE says these were paid in March 2026. If they're currently on Jan/Feb extratos
// from ESTADO DO TOCANTINS (which might actually be UNITINS payments), unlink them.
console.log('\nStep 6: NFs 06-37 on Jan/Feb ESTADO TED extratos — cross-check with CGE');

// These extratos in Jan/Feb 2026 are credited from 070 0380 (GOVERNO DO ESTADO)
// CGE shows UNITINS used extrato 510016171 (R$265K, 28/01) for NFs 1246-1254
// So Jan-2026 state TEDs may be UNITINS, not DETRAN. Cross-check:
const jan26StateTEDs = [141, 308, 510016066, 510016067, 510016170, 510016171];
const nfsOnJan26State = db.prepare(`
  SELECT n.id, n.numero, n.competencia, n.valor_liquido, n.extrato_id, e.historico, e.credito, e.data_iso
  FROM notas_fiscais n
  JOIN extratos e ON e.id = n.extrato_id
  WHERE n.tomador LIKE '%DETRAN%'
    AND n.extrato_id IN (${jan26StateTEDs.join(',')})
    AND n.numero GLOB '2026*0000006'
      OR n.numero GLOB '2026*0000037'
      OR (CAST(n.numero AS INT) BETWEEN 6 AND 37 AND LENGTH(n.numero) < 10)
`).all();

// Simpler: check all DETRAN NFs 06-37 (jan/26) on state TEDs
const nfsJan26q = db.prepare(`
  SELECT n.id, n.numero, n.competencia, n.valor_liquido, n.extrato_id, e.historico, e.credito, e.data_iso
  FROM notas_fiscais n
  JOIN extratos e ON e.id = n.extrato_id
  WHERE n.tomador LIKE '%DETRAN%'
    AND n.extrato_id IN (${jan26StateTEDs.join(',')})
    AND n.competencia LIKE 'jan%'
`).all();
console.log(`  DETRAN jan/26 NFs on state TED extratos: ${nfsJan26q.length}`);
nfsJan26q.forEach(n => console.log(`    NF ${n.id} ${n.numero} → extrato ${n.extrato_id} ${n.data_iso} R$${n.credito}`));

// These are jan/26 NFs but CGE says DETRAN paid them in MARCH 2026 (seq 178).
// They should NOT be on January extratos. Unlink them (they'll get PAGO_SEM_COMPROVANTE from step 4).
if (!DRY && nfsJan26q.length) {
  for (const nf of nfsJan26q) {
    // Check if already fixed by step 4 (should be PAGO_SEM_COMPROVANTE by now)
    const current = db.prepare('SELECT status_conciliacao FROM notas_fiscais WHERE id=?').get(nf.id);
    if (current && current.status_conciliacao === 'CONCILIADO') {
      db.prepare(`
        UPDATE notas_fiscais
        SET extrato_id=NULL, status_conciliacao='PAGO_SEM_COMPROVANTE',
            data_pagamento='2026-03-18'
        WHERE id=?
      `).run(nf.id);
      totalFixed++;
      report.push({ step: 6, nf_id: nf.id, numero: nf.numero, comp: nf.competencia, acao: 'PAGO_SEM_COMPROVANTE (jan/26 NFs moved from state TED to CGE date)' });
    }
  }
}

// ─── Step 7: Fix NFs 209,220-237 on wrong March 2026 extratos ──────────────
// These are currently matched to extratos 510028366 (ESTADO DO TOCANTINS, R$104K, 17/03)
// and 1003 (R$56K, 12/03). But CGE seq 184 says they were paid 31/03/2026.
console.log('\nStep 7: NFs 209-237 (mar/26) on wrong March extratos');

const wrongMar26 = [510028366, 1003];
const nfsWrongMar = db.prepare(`
  SELECT n.id, n.numero, n.competencia, n.valor_liquido, n.extrato_id, e.historico, e.data_iso
  FROM notas_fiscais n
  JOIN extratos e ON e.id = n.extrato_id
  WHERE n.tomador LIKE '%DETRAN%'
    AND n.extrato_id IN (${wrongMar26.join(',')})
    AND (n.numero GLOB '20260000002[0-9][0-9]' OR (CAST(n.numero AS INT) BETWEEN 209 AND 237 AND LENGTH(n.numero) < 10))
`).all();
console.log(`  NFs 209-237 on wrong March extratos: ${nfsWrongMar.length}`);
nfsWrongMar.forEach(n => console.log(`    NF ${n.id} ${n.numero} → extrato ${n.extrato_id} ${n.data_iso}`));

if (!DRY && nfsWrongMar.length) {
  for (const nf of nfsWrongMar) {
    const current = db.prepare('SELECT status_conciliacao FROM notas_fiscais WHERE id=?').get(nf.id);
    if (current && current.status_conciliacao !== 'CANCELADA') {
      if (mar31ExtDBEntry) {
        db.prepare(`
          UPDATE notas_fiscais
          SET extrato_id=?, status_conciliacao='CONCILIADO', data_pagamento='2026-03-31'
          WHERE id=?
        `).run(mar31ExtDBEntry.id, nf.id);
        report.push({ step: 7, nf_id: nf.id, numero: nf.numero, comp: nf.competencia, acao: `CONCILIADO → ${mar31ExtDBEntry.id}` });
      } else {
        db.prepare(`
          UPDATE notas_fiscais
          SET extrato_id=NULL, status_conciliacao='PAGO_SEM_COMPROVANTE',
              data_pagamento='2026-03-31'
          WHERE id=?
        `).run(nf.id);
        report.push({ step: 7, nf_id: nf.id, numero: nf.numero, comp: nf.competencia, acao: 'PAGO_SEM_COMPROVANTE (CGE seq 184)' });
      }
      totalFixed++;
    }
  }
}

// ─── Sumário ─────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(70));
console.log(`✅ Total de NFs corrigidas: ${totalFixed}`);
if (DRY) console.log('⚠️  DRY-RUN — nada gravado.');

// Contagem final
if (!DRY) {
  const st = db.prepare(`
    SELECT status_conciliacao, COUNT(*) c FROM notas_fiscais
    WHERE tomador LIKE '%DETRAN%' GROUP BY status_conciliacao
  `).all();
  console.log('\nStatus DETRAN pós-correção:');
  st.forEach(r => console.log(`  ${r.status_conciliacao}: ${r.c}`));
}

// Detailed report
console.log('\nReport (primeiros 30):');
report.slice(0, 30).forEach(r =>
  console.log(`  [Step ${r.step}] NF ${r.nf_id} ${r.numero} (${r.comp}) → ${r.acao}`)
);
if (report.length > 30) console.log(`  ... (${report.length - 30} more)`);
console.log('\n✔️  Concluído.');
