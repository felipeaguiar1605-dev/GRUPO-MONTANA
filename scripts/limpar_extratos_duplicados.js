'use strict';
/**
 * Remove extratos duplicados (mesmo lançamento importado 2× — com pipe `|` e sem).
 *
 * Estratégia: chave normalizada (data + credito + histórico sem não-alfanum) + (data + debito).
 * Mantém o registro mais antigo (menor id) quando há vínculo de NF a extrato_id (preserva referência).
 *
 * Uso:
 *   node scripts/limpar_extratos_duplicados.js [empresa]          (dry-run)
 *   node scripts/limpar_extratos_duplicados.js [empresa] --apply  (deleta)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const argsLimpos = process.argv.slice(2).filter(a => !a.startsWith('--'));
const empArg = (argsLimpos[0] || 'todas').toLowerCase();

function chaveNorm(e) {
  const hist = (e.historico || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 40);
  const cre = (e.credito || 0).toFixed(2);
  const deb = (e.debito || 0).toFixed(2);
  return `${e.data_iso}|${cre}|${deb}|${hist}`;
}

function processar(empresa) {
  const db = getDb(empresa);
  console.log('\n' + '═'.repeat(80));
  console.log(`  ${empresa.toUpperCase()} — Limpar extratos duplicados`);
  console.log('═'.repeat(80));

  // Todos os extratos
  const exts = db.prepare(`
    SELECT id, data_iso, historico, credito, debito
    FROM extratos
    WHERE data_iso IS NOT NULL AND data_iso != ''
    ORDER BY id ASC
  `).all();
  console.log(`  Total extratos: ${exts.length}`);

  // Agrupar por chave
  const grupos = new Map();
  for (const e of exts) {
    const k = chaveNorm(e);
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(e);
  }

  // IDs referenciados por qualquer tabela (não pode deletar)
  const idsUsados = new Set();
  const addRefs = (sql) => {
    try {
      for (const r of db.prepare(sql).all()) {
        if (r.extrato_id !== null && r.extrato_id !== '') idsUsados.add(String(r.extrato_id));
      }
    } catch (e) { /* tabela pode não existir */ }
  };
  addRefs(`SELECT DISTINCT extrato_id FROM notas_fiscais WHERE extrato_id IS NOT NULL AND extrato_id != ''`);
  addRefs(`SELECT DISTINCT extrato_id FROM pagamentos_portal WHERE extrato_id IS NOT NULL AND extrato_id != ''`);
  addRefs(`SELECT DISTINCT extrato_id FROM transparencia_extrato_link WHERE extrato_id IS NOT NULL AND extrato_id != ''`);
  addRefs(`SELECT DISTINCT extrato_id FROM vinculacoes WHERE extrato_id IS NOT NULL AND extrato_id != ''`);
  addRefs(`SELECT DISTINCT extrato_id FROM despesas WHERE extrato_id IS NOT NULL AND extrato_id != ''`);
  addRefs(`SELECT DISTINCT extrato_id FROM transparencia_pagamentos WHERE extrato_id IS NOT NULL AND extrato_id != ''`);
  addRefs(`SELECT DISTINCT extrato_id FROM emprestimos_parcelas WHERE extrato_id IS NOT NULL AND extrato_id != ''`);

  // Candidatos a deletar: preservar o menor id de cada grupo, deletar os demais.
  // Mas se o menor id não está em idsUsados e algum duplicado está, mantém o referenciado.
  let grpDup = 0, totalDup = 0, aDeletar = [];
  for (const [k, g] of grupos) {
    if (g.length <= 1) continue;
    grpDup++;
    totalDup += g.length - 1;

    // Ordenar: referenciado primeiro, depois menor id
    g.sort((a, b) => {
      const aRef = idsUsados.has(String(a.id)) ? 0 : 1;
      const bRef = idsUsados.has(String(b.id)) ? 0 : 1;
      if (aRef !== bRef) return aRef - bRef;
      return a.id - b.id;
    });
    const manter = g[0];
    const deletar = g.slice(1);
    // Abortar deleção se algum duplicado também está referenciado (improvável, mas seguro)
    const refsNoDeletar = deletar.filter(e => idsUsados.has(String(e.id)));
    if (refsNoDeletar.length > 0) {
      console.log(`  ⚠️  GRUPO com múltiplas referências, pulando: id_mantido=${manter.id}, ids_ref=${refsNoDeletar.map(e=>e.id).join(',')}`);
      continue;
    }
    for (const d of deletar) aDeletar.push(d);
  }

  console.log(`  Grupos com duplicata: ${grpDup}`);
  console.log(`  Linhas redundantes a deletar: ${aDeletar.length}`);
  if (aDeletar.length > 0) {
    console.log('  Amostra (primeiros 5):');
    for (const d of aDeletar.slice(0, 5)) {
      console.log(`     id=${d.id} | ${d.data_iso} | R$ ${(d.credito||d.debito||0).toFixed(2)} | ${(d.historico||'').slice(0,50)}`);
    }
  }

  if (!APPLY) {
    console.log('\n  ⚠️  Dry-run. Rode com --apply para deletar.');
    db.close();
    return aDeletar.length;
  }

  const del = db.prepare(`DELETE FROM extratos WHERE id = ?`);
  const tx = db.transaction(() => {
    let n = 0;
    for (const d of aDeletar) { del.run(d.id); n++; }
    console.log(`\n  ✅ ${n} extratos duplicados removidos.`);
  });
  tx();
  db.close();
  return aDeletar.length;
}

console.log('\n🧹 LIMPAR EXTRATOS DUPLICADOS');
const empresas = empArg === 'todas' ? ['assessoria', 'seguranca'] : [empArg];
let totalDel = 0;
for (const e of empresas) totalDel += processar(e);
console.log('\n' + '═'.repeat(80));
console.log(`  TOTAL: ${totalDel} extratos ${APPLY ? 'DELETADOS' : '(dry-run)'}`);
console.log('═'.repeat(80));
