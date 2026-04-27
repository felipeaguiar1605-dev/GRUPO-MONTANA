/**
 * Concilia NF 122 (UFT Motoristas — Reitoria Jan/2026)
 *
 * OB SIAFI 2026OB000305 — 13/02/2026
 * Valor pago via BRB: R$ 28.644,51
 * (R$26.848,96 restos a pagar 2025NE000819 + R$1.795,55 novo 2026NE000063)
 * EndToEndId: E0039446020260213203022LC0a4cpx0
 */
const Database = require('better-sqlite3');
const DB_PATH  = 'data/assessoria/montana.db';
const db       = new Database(DB_PATH);

const VALOR_OB = 28644.51;

// ─── 1. Estado atual da NF 122 ────────────────────────────────────────────────
console.log('=== NF 122 estado atual ===');
const nf = db.prepare(`
  SELECT id, numero, tomador, contrato_ref, data_emissao, data_pagamento,
         valor_bruto, valor_liquido, retencao, status_conciliacao, extrato_id
  FROM notas_fiscais WHERE numero = '122' LIMIT 1
`).get();
console.log(JSON.stringify(nf, null, 2));

// ─── 2. Extrato BRB existente para esse valor ─────────────────────────────────
console.log('\n=== Extratos BRB ~R$28.644 em fev/2026 ===');
const extratos = db.prepare(`
  SELECT id, data_iso, credito, historico, status_conciliacao, ofx_fitid
  FROM extratos
  WHERE banco = 'BRB'
    AND data_iso BETWEEN '2026-02-01' AND '2026-02-28'
    AND credito BETWEEN 28000 AND 29500
  ORDER BY ABS(credito - ?)
`).all(VALOR_OB);
extratos.forEach(e => console.log(JSON.stringify(e)));

// ─── 3. Extrato atualmente vinculado à NF 122 ─────────────────────────────────
if (nf?.extrato_id) {
  const ext = db.prepare('SELECT id, data_iso, credito, historico, status_conciliacao FROM extratos WHERE id = ?').get(nf.extrato_id);
  console.log('\n=== Extrato ATUAL vinculado (id=' + nf.extrato_id + ') ===');
  console.log(JSON.stringify(ext));
}

// ─── 4. DRY RUN — o que será feito ───────────────────────────────────────────
console.log('\n=== PLANO ===');
if (extratos.length === 0) {
  console.log('⚠  Nenhum extrato BRB encontrado para R$28.644. Precisa importar o BRB fev/2026.');
} else {
  const ext = extratos[0];
  const diff = Math.abs(ext.credito - VALOR_OB);
  const pct  = (diff / VALOR_OB * 100).toFixed(2);
  console.log(`Melhor match: id=${ext.id} | ${ext.data_iso} | R$${ext.credito} | diff=${diff.toFixed(2)} (${pct}%)`);
  if (diff < 1) {
    console.log('✅ Match exato — pronto para conciliar');
  } else if (pct < 5) {
    console.log('⚠  Match próximo (<5%) — verificar se é o correto');
  } else {
    console.log('❌ Diferença grande — verificar manualmente');
  }
}

// ─── 5. Verificar NFs adjacentes (outros motoristas Reitoria Jan/2026) ────────
console.log('\n=== NFs UFT Motorista jan/2026 ===');
db.prepare(`
  SELECT id, numero, tomador, valor_bruto, valor_liquido, status_conciliacao, extrato_id
  FROM notas_fiscais
  WHERE contrato_ref LIKE '%UFT%MOTOR%' OR contrato_ref LIKE '%05/2025%'
    OR (numero IN ('118','119','120','121','122','123'))
  ORDER BY CAST(numero AS INTEGER)
`).all().forEach(r => console.log(JSON.stringify(r)));

db.close();
