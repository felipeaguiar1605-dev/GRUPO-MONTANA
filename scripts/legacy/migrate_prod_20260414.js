#!/usr/bin/env node
/**
 * Migração produção 2026-04-14
 * Executa correções no banco Assessoria que foram feitas localmente:
 *   1. Remove duplicata rh_folha (RASCUNHO fev/2026)
 *   2. Remove NF duplicada 202400000001216
 *   3. Corrige contrato PREFEITURA MUNICIPAL (id=33) — orgao + nome
 *   4. Renomeia SEDUC Limpeza/Copeiragem → SEDUC 016/2023
 *   5. Renomeia Sec. Saúde Palmas 192/2025 → SEMUS 192/2025
 *   6. Cascateia renomes nas parcelas
 *
 * Uso: node scripts/migrate_prod_20260414.js [--empresa assessoria]
 */

'use strict';
const path    = require('path');
const Database = require('better-sqlite3');

const ROOT     = path.join(__dirname, '..');
const EMPRESA  = (process.argv.find(a => a.startsWith('--empresa=')) || '--empresa=assessoria').split('=')[1];
const DB_PATH  = path.join(ROOT, 'data', EMPRESA, 'montana.db');

console.log(`\n  Migração produção — ${EMPRESA}`);
console.log(`  DB: ${DB_PATH}\n`);

const db = new Database(DB_PATH);
db.pragma('foreign_keys = OFF');

let alteracoes = 0;

// ── 1. Remove duplicata rh_folha (status=RASCUNHO, competencia=2026-02) ────
const rhDup = db.prepare(`
  SELECT id FROM rh_folha
  WHERE competencia='2026-02' AND status='RASCUNHO'
  ORDER BY id ASC LIMIT 1
`).get();
if (rhDup) {
  console.log(`  [1] Removendo rh_folha id=${rhDup.id} (RASCUNHO fev/2026)`);
  // rh_itens pode não existir em produção — tenta e ignora erro
  try { db.prepare(`DELETE FROM rh_itens WHERE folha_id=?`).run(rhDup.id); } catch (_) {}
  db.prepare(`DELETE FROM rh_folha WHERE id=?`).run(rhDup.id);
  alteracoes++;
} else {
  console.log(`  [1] rh_folha RASCUNHO fev/2026 não encontrado — ok`);
}

// ── 2. Remove NF duplicada 202400000001216 (mantém o de id menor) ───────────
// Detecta coluna correta: 'numero_nf' (local) ou 'numero' (produção)
const nfCols = db.prepare(`PRAGMA table_info(notas_fiscais)`).all().map(c => c.name);
const nfNumCol = nfCols.includes('numero_nf') ? 'numero_nf' : 'numero';

const nfDups = db.prepare(`
  SELECT id, ${nfNumCol} as nr FROM notas_fiscais
  WHERE ${nfNumCol}='202400000001216'
  ORDER BY id ASC
`).all();
if (nfDups.length > 1) {
  const toDelete = nfDups.slice(1);
  for (const nf of toDelete) {
    console.log(`  [2] Removendo NF duplicada id=${nf.id} (${nf.nr})`);
    db.prepare(`DELETE FROM notas_fiscais WHERE id=?`).run(nf.id);
    alteracoes++;
  }
} else {
  console.log(`  [2] NF 202400000001216 sem duplicatas — ok`);
}

// ── 3. Corrige contrato PREFEITURA MUNICIPAL (id=33 ou busca por orgao) ─────
// numContrato pode já estar correto em produção; atualiza apenas campos divergentes
const prefRow = db.prepare(`SELECT id, numContrato, orgao FROM contratos WHERE numContrato LIKE 'PREFEITURA%' OR orgao LIKE '%062/2024%' OR (orgao IS NULL AND numContrato LIKE '%PALMAS%') LIMIT 1`).get();
if (prefRow) {
  console.log(`  [3] Atualizando contrato PREFEITURA (id=${prefRow.id}): orgao + descricao`);
  db.prepare(`UPDATE contratos SET orgao='PREFEITURA MUNICIPAL DE PALMAS', obs='Contrato 062/2024 — Serviços de limpeza/copeiragem' WHERE id=?`).run(prefRow.id);
  alteracoes++;
} else {
  // Busca pelo id direto se o banco de prod tiver a mesma estrutura
  const byId = db.prepare(`SELECT id, numContrato FROM contratos WHERE id=33`).get();
  if (byId) {
    console.log(`  [3] Atualizando contrato id=33 (${byId.numContrato})`);
    db.prepare(`UPDATE contratos SET orgao='PREFEITURA MUNICIPAL DE PALMAS', obs='Contrato 062/2024 — Serviços de limpeza/copeiragem' WHERE id=33`).run();
    alteracoes++;
  } else {
    console.log(`  [3] Contrato PREFEITURA não encontrado — pulando`);
  }
}

// ── 4. SEDUC Limpeza/Copeiragem → SEDUC 016/2023 ────────────────────────────
const seducOld = db.prepare(`SELECT id, numContrato FROM contratos WHERE numContrato='SEDUC Limpeza/Copeiragem' LIMIT 1`).get();
if (seducOld) {
  console.log(`  [4] Renomeando SEDUC Limpeza/Copeiragem → SEDUC 016/2023 (id=${seducOld.id})`);
  db.prepare(`UPDATE parcelas SET contrato_num='SEDUC 016/2023' WHERE contrato_num='SEDUC Limpeza/Copeiragem'`).run();
  db.prepare(`UPDATE contratos SET numContrato='SEDUC 016/2023' WHERE id=?`).run(seducOld.id);
  alteracoes++;
} else {
  console.log(`  [4] SEDUC Limpeza/Copeiragem não encontrado (já renomeado ou inexistente) — ok`);
}

// ── 5. Sec. Saúde Palmas 192/2025 → SEMUS 192/2025 ──────────────────────────
const semusOld = db.prepare(`SELECT id, numContrato FROM contratos WHERE numContrato='Sec. Saúde Palmas 192/2025' LIMIT 1`).get();
if (semusOld) {
  console.log(`  [5] Renomeando Sec. Saúde Palmas 192/2025 → SEMUS 192/2025 (id=${semusOld.id})`);
  db.prepare(`UPDATE parcelas SET contrato_num='SEMUS 192/2025' WHERE contrato_num='Sec. Saúde Palmas 192/2025'`).run();
  db.prepare(`UPDATE contratos SET numContrato='SEMUS 192/2025' WHERE id=?`).run(semusOld.id);
  alteracoes++;
} else {
  console.log(`  [5] Sec. Saúde Palmas 192/2025 não encontrado (já renomeado ou inexistente) — ok`);
}

db.pragma('foreign_keys = ON');
db.close();

console.log(`\n  ✅ Migração concluída — ${alteracoes} alteração(ões) aplicada(s)\n`);
