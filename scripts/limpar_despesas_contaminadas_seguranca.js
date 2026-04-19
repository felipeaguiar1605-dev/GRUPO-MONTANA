#!/usr/bin/env node
/**
 * Montana — limpeza de despesas contaminadas em Segurança
 *
 * Problema detectado (2026-04-18):
 *  A tabela `despesas` do banco Segurança Q1/2026 contém registros que NÃO pertencem
 *  a Segurança. 100% das 762 despesas Q1 coincidem com despesas em Assessoria;
 *  502 delas (R$ 4.7M) batem SÓ no extrato Assessoria (não há débito correspondente
 *  no extrato Segurança). Estas são importações erradas e devem ser removidas.
 *
 *  Heurística usada:
 *   - Para cada despesa em Segurança (janela configurável), checa se há débito
 *     (data_iso, valor_bruto) no extrato Segurança.
 *   - Se NÃO bate em Segurança mas bate em Assessoria → remove.
 *   - Se bate em AMBAS → mantém (ambíguo; pode ser legítima de Seg e coincidência).
 *   - Se bate só em Segurança → mantém (correta).
 *
 * Uso:
 *   node scripts/limpar_despesas_contaminadas_seguranca.js                 # dry-run Q1/2026
 *   node scripts/limpar_despesas_contaminadas_seguranca.js --from=... --to=...
 *   node scripts/limpar_despesas_contaminadas_seguranca.js --apply
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const arg = (n) => {
  const a = process.argv.find(x => x.startsWith('--' + n + '='));
  return a ? a.split('=').slice(1).join('=') : null;
};
const FROM = arg('from') || '2026-01-01';
const TO   = arg('to')   || '2026-03-31';

function fmt(v) { return (v||0).toLocaleString('pt-BR', { minimumFractionDigits: 2 }); }

console.log('═'.repeat(100));
console.log(`  LIMPEZA DE DESPESAS CONTAMINADAS — SEGURANÇA (${FROM} → ${TO})  ${APPLY ? '[APPLY]' : '[DRY-RUN]'}`);
console.log('═'.repeat(100));

const dbA = getDb('assessoria');
const dbS = getDb('seguranca');

const despesasSeg = dbS.prepare(`
  SELECT id, data_iso, valor_bruto, categoria, descricao, fornecedor
  FROM despesas
  WHERE data_iso BETWEEN ? AND ?
  ORDER BY data_iso, id
`).all(FROM, TO);

const extSeg = dbS.prepare(`
  SELECT data_iso, debito FROM extratos
  WHERE debito > 0 AND data_iso BETWEEN ? AND ?
`).all(FROM, TO);

const extAss = dbA.prepare(`
  SELECT data_iso, debito FROM extratos
  WHERE debito > 0 AND data_iso BETWEEN ? AND ?
`).all(FROM, TO);

function mkMap(arr) {
  const m = new Map();
  for (const r of arr) {
    const k = r.data_iso + '|' + r.debito.toFixed(2);
    m.set(k, (m.get(k)||0) + 1);
  }
  return m;
}
const segMap = mkMap(extSeg);
const assMap = mkMap(extAss);

const toRemove = [];
let bothCount = 0, bothVal = 0;
let onlySegCount = 0, onlySegVal = 0;
let orphans = 0, orphansVal = 0;

for (const d of despesasSeg) {
  const k = d.data_iso + '|' + d.valor_bruto.toFixed(2);
  const inSeg = segMap.has(k);
  const inAss = assMap.has(k);
  if (!inSeg && inAss) { toRemove.push(d); }
  else if (inSeg && inAss) { bothCount++; bothVal += d.valor_bruto; }
  else if (inSeg && !inAss) { onlySegCount++; onlySegVal += d.valor_bruto; }
  else { orphans++; orphansVal += d.valor_bruto; }
}

const totalRem = toRemove.reduce((s,r)=>s+r.valor_bruto, 0);

console.log(`\nDespesas em Segurança no período: ${despesasSeg.length} (R$ ${fmt(despesasSeg.reduce((s,d)=>s+d.valor_bruto,0))})`);
console.log(`  ✓ Só batem em Seg (reais)        : ${onlySegCount} (R$ ${fmt(onlySegVal)})`);
console.log(`  ? Batem em AMBAS (mantidas)      : ${bothCount} (R$ ${fmt(bothVal)})`);
console.log(`  ⚠️ Só batem em Ass (A REMOVER)    : ${toRemove.length} (R$ ${fmt(totalRem)})`);
console.log(`  · Órfãs (sem débito em nenhuma)  : ${orphans} (R$ ${fmt(orphansVal)})`);

console.log(`\nExemplos (top 15 a remover):`);
toRemove.sort((a,b)=>b.valor_bruto-a.valor_bruto).slice(0,15).forEach(r=>{
  console.log(`  [${r.id}] ${r.data_iso}  R$ ${fmt(r.valor_bruto).padStart(14)}  ${(r.categoria||'').padEnd(14)} ${(r.descricao||'').slice(0,50)}`);
});

if (APPLY && toRemove.length > 0) {
  dbS.pragma('foreign_keys = OFF');
  const del = dbS.prepare('DELETE FROM despesas WHERE id = ?');
  const tx = dbS.transaction(() => {
    for (const r of toRemove) {
      try { del.run(r.id); } catch(e) { console.log(`  ⚠ skip id=${r.id}: ${e.message}`); }
    }
  });
  tx();
  dbS.pragma('foreign_keys = ON');
  console.log(`\n✅ Aplicado: ${toRemove.length} despesas removidas de Segurança (R$ ${fmt(totalRem)})`);
} else if (!APPLY) {
  console.log(`\n⚠️  Nada gravado. Use --apply para aplicar.`);
}
