/**
 * Aplica conciliação da NF 122 (UFT Motoristas Reitoria Jan/2026)
 *
 * OB SIAFI 2026OB000305 — 13/02/2026 — R$ 28.644,51 via BRB
 * Extrato BRB id=510028574 — MATCH EXATO (diff=0.00)
 *
 * OBSERVAÇÃO: valor_liquido no banco (R$60.219,33) é o valor da NF emitida no
 * WebISS. O pagamento efetivo pelo governo via OB foi R$28.644,51
 * (R$26.848,96 restos a pagar 2025NE000819 + R$1.795,55 novo 2026NE000063).
 * Mantemos os valores WebISS e registramos o pagamento real no extrato_id.
 * NFs 206 e 299 (mesmo padrão — Reitoria fev/abr 2026) aguardam suas OBs.
 */
const Database = require('better-sqlite3');
const DB_PATH  = 'data/assessoria/montana.db';
const db       = new Database(DB_PATH);

const NF_ID      = 905;          // numero 202600000000122
const EXTRATO_ID = 510028574;    // BRB 2026-02-13 R$28.644,51
const DATA_PAG   = '2026-02-13';
const END_TO_END = 'E0039446020260213203022LC0a4cpx0';

// ─── Verificação pré-update ───────────────────────────────────────────────────
const nf = db.prepare('SELECT id, numero, valor_liquido, status_conciliacao, extrato_id FROM notas_fiscais WHERE id = ?').get(NF_ID);
const ext = db.prepare('SELECT id, data_iso, credito, status_conciliacao FROM extratos WHERE id = ?').get(EXTRATO_ID);

console.log('PRÉ-UPDATE:');
console.log('  NF:', JSON.stringify(nf));
console.log('  Extrato:', JSON.stringify(ext));

if (!nf) { console.error('❌ NF id=905 não encontrada!'); db.close(); process.exit(1); }
if (!ext) { console.error('❌ Extrato id=510028574 não encontrado!'); db.close(); process.exit(1); }
if (nf.status_conciliacao === 'CONCILIADO') {
  console.log('⚠  NF já está CONCILIADO — abortando (use --force para sobrescrever)');
  db.close();
  process.exit(0);
}
if (ext.status_conciliacao === 'CONCILIADO') {
  console.log('⚠  Extrato já está CONCILIADO — verificar se está vinculado a outra NF');
}

// ─── Aplicar update em transação ─────────────────────────────────────────────
const apply = db.transaction(() => {
  // 1. Atualiza NF 122
  const r1 = db.prepare(`
    UPDATE notas_fiscais
    SET status_conciliacao = 'CONCILIADO',
        extrato_id         = ?,
        data_pagamento     = ?
    WHERE id = ?
  `).run(EXTRATO_ID, DATA_PAG, NF_ID);

  // 2. Atualiza extrato BRB
  const r2 = db.prepare(`
    UPDATE extratos
    SET status_conciliacao = 'CONCILIADO'
    WHERE id = ?
  `).run(EXTRATO_ID);

  return { nf: r1.changes, ext: r2.changes };
});

const res = apply();
console.log(`\n✅ Update aplicado — NF changes: ${res.nf} | Extrato changes: ${res.ext}`);

// ─── Verificação pós-update ───────────────────────────────────────────────────
const nf2  = db.prepare('SELECT id, numero, valor_bruto, valor_liquido, data_pagamento, status_conciliacao, extrato_id FROM notas_fiscais WHERE id = ?').get(NF_ID);
const ext2 = db.prepare('SELECT id, data_iso, credito, status_conciliacao FROM extratos WHERE id = ?').get(EXTRATO_ID);

console.log('\nPÓS-UPDATE:');
console.log('  NF:', JSON.stringify(nf2));
console.log('  Extrato:', JSON.stringify(ext2));

// ─── Panorama Reitoria (NFs 206 e 299 aguardam) ──────────────────────────────
console.log('\n=== Demais NFs Reitoria (valor_liquido=60219.33) ===');
db.prepare(`
  SELECT id, numero, data_emissao, data_pagamento, valor_liquido, status_conciliacao, extrato_id
  FROM notas_fiscais
  WHERE valor_liquido = 60219.33
    AND tomador LIKE '%FEDERAL DO TOCANTINS%'
  ORDER BY CAST(numero AS TEXT)
`).all().forEach(r => console.log(' ', JSON.stringify(r)));

// ─── Extratos BRB fev-abr/2026 disponíveis para matching ─────────────────────
console.log('\n=== Extratos BRB jan-abr/2026 PENDENTE (para NFs 206 e 299) ===');
db.prepare(`
  SELECT id, data_iso, credito, historico, status_conciliacao
  FROM extratos
  WHERE banco = 'BRB'
    AND data_iso BETWEEN '2026-01-01' AND '2026-04-30'
    AND status_conciliacao = 'PENDENTE'
    AND credito IS NOT NULL
  ORDER BY data_iso
`).all().forEach(e => console.log(' ', JSON.stringify(e)));

db.close();
