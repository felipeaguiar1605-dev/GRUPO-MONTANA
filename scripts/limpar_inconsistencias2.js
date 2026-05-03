#!/usr/bin/env node
/**
 * Montana — Limpeza nível 2 (pós-dedup/reconciliação)
 *
 * 1. Re-mapear contrato_ref órfãos:
 *    - Assessoria "SEDUC Limpeza/Copeiragem" → "SEDUC 016/2023" (mesmo órgão, numeração canônica)
 *    - Segurança "Instituto 20 Maio (avulso)" → NULL (não há contrato formal)
 * 2. Zerar despesas.extrato_id quando FK estiver quebrada (evita crash em joins)
 * 3. Adicionar coluna notas_fiscais.outros_descontos + popular com (bruto - liquido - atomicos)
 *    Isso torna a soma explícita: bruto = liquido + inss+ir+iss+csll+pis+cofins + outros_descontos
 *
 * Uso:
 *   node scripts/limpar_inconsistencias2.js [empresa]           # dry-run
 *   node scripts/limpar_inconsistencias2.js [empresa] --apply   # grava
 *   node scripts/limpar_inconsistencias2.js todas --apply
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const posArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));
const empArg = (posArgs[0] || 'todas').toLowerCase();

const REMAP_CONTRATO_REF = {
  'assessoria': {
    'SEDUC Limpeza/Copeiragem': 'SEDUC 016/2023',
  },
  'seguranca': {
    'Instituto 20 Maio (avulso)': null, // marca como sem contrato (avulso)
  },
};

function processar(empresa) {
  const db = getDb(empresa);
  console.log('\n' + '═'.repeat(90));
  console.log(`  LIMPAR NÍVEL 2 — ${empresa.toUpperCase()}  ${APPLY ? '[APPLY]' : '[dry-run]'}`);
  console.log('═'.repeat(90));

  // ── 1. Re-mapear contrato_ref órfãos
  console.log('\n── 1. Re-mapear contrato_ref órfãos ──');
  const mapa = REMAP_CONTRATO_REF[empresa] || {};
  let remapCount = 0;
  for (const [de, para] of Object.entries(mapa)) {
    const row = db.prepare(`SELECT COUNT(*) q FROM notas_fiscais WHERE contrato_ref = ?`).get(de);
    if (row.q === 0) continue;
    console.log(`   "${de}" → ${para === null ? 'NULL (avulso)' : `"${para}"`} | ${row.q} NFs`);
    if (APPLY) {
      db.prepare(`UPDATE notas_fiscais SET contrato_ref = ? WHERE contrato_ref = ?`).run(para, de);
    }
    remapCount += row.q;
  }
  if (remapCount === 0) console.log('   ✅ nenhum mapeamento aplicável');

  // ── 2. Zerar FK quebrada em despesas
  console.log('\n── 2. Zerar extrato_id inválido em despesas ──');
  let despesasZeradas = 0;
  try {
    const row = db.prepare(`
      SELECT COUNT(*) q FROM despesas
      WHERE extrato_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM extratos WHERE id = despesas.extrato_id)
    `).get();
    despesasZeradas = row.q;
    console.log(`   ${despesasZeradas} despesas com FK quebrada`);
    if (APPLY && despesasZeradas > 0) {
      db.prepare(`
        UPDATE despesas SET extrato_id = NULL
        WHERE extrato_id IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM extratos WHERE id = despesas.extrato_id)
      `).run();
    }
  } catch (e) {
    console.log(`   ⚠️ erro: ${e.message}`);
  }

  // ── 3. Adicionar coluna outros_descontos + popular
  console.log('\n── 3. Coluna notas_fiscais.outros_descontos (computa bruto-liquido-atomicos) ──');
  const cols = db.prepare('PRAGMA table_info(notas_fiscais)').all().map(c => c.name);
  if (!cols.includes('outros_descontos')) {
    console.log('   + adicionando coluna outros_descontos REAL');
    if (APPLY) db.prepare('ALTER TABLE notas_fiscais ADD COLUMN outros_descontos REAL DEFAULT 0').run();
  } else {
    console.log('   (coluna já existe)');
  }

  // Popular: outros = bruto - (liquido + inss + ir + iss + csll + pis + cofins)
  // Arredondar para 2 casas; considerar 0 se próximo de zero
  const divergentes = db.prepare(`
    SELECT id, valor_bruto, valor_liquido,
           COALESCE(inss,0) + COALESCE(ir,0) + COALESCE(iss,0) +
           COALESCE(csll,0) + COALESCE(pis,0) + COALESCE(cofins,0) AS somaret
    FROM notas_fiscais
    WHERE valor_bruto > 0
  `).all();

  let populadas = 0;
  if (APPLY) {
    const up = db.prepare('UPDATE notas_fiscais SET outros_descontos = ? WHERE id = ?');
    const tx = db.transaction(() => {
      for (const r of divergentes) {
        const outros = Math.round((r.valor_bruto - (r.valor_liquido || 0) - (r.somaret || 0)) * 100) / 100;
        const final = Math.abs(outros) < 0.01 ? 0 : outros;
        up.run(final, r.id);
        if (final !== 0) populadas++;
      }
    });
    tx();
    console.log(`   → ${populadas} NFs com outros_descontos preenchido`);
  } else {
    for (const r of divergentes) {
      const outros = Math.round((r.valor_bruto - (r.valor_liquido || 0) - (r.somaret || 0)) * 100) / 100;
      if (Math.abs(outros) >= 0.01) populadas++;
    }
    console.log(`   → ${populadas} NFs teriam outros_descontos preenchido (estimativa)`);
  }

  db.close();
  return { remapCount, despesasZeradas, populadas };
}

const empresas = empArg === 'todas' ? ['assessoria', 'seguranca'] : [empArg];
const tot = { remapCount: 0, despesasZeradas: 0, populadas: 0 };
for (const e of empresas) {
  const r = processar(e);
  for (const k of Object.keys(tot)) tot[k] += r[k];
}

console.log('\n' + '═'.repeat(90));
console.log(`  RESUMO GERAL ${APPLY ? '[APPLIED]' : '[DRY-RUN]'}`);
console.log('═'.repeat(90));
console.log(`  NFs com contrato_ref remapeado     : ${tot.remapCount}`);
console.log(`  Despesas com FK zerada             : ${tot.despesasZeradas}`);
console.log(`  NFs com outros_descontos populado  : ${tot.populadas}`);
if (!APPLY) console.log('\n  ⚠️  Nada gravado. Use --apply para aplicar.');
