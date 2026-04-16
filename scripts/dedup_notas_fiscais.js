'use strict';
/**
 * Deduplicação de notas_fiscais + remoção de lixo (numero='0' ou NULL).
 *
 * Regra dedup: quando há múltiplas linhas com o mesmo numero,
 *   mantém a que tem MAIS campos preenchidos (discriminacao, status_conciliacao).
 *   Em caso de empate, preserva a de maior id.
 *
 * Também remove NFs com numero='0', NULL, vazio ou curto demais.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const ARG = process.argv.slice(2);
const APLICAR = ARG.includes('--apply');
const EMPRESAS = ARG.filter(a => !a.startsWith('--'));
const ALVO = EMPRESAS.length ? EMPRESAS : ['assessoria', 'seguranca'];

function score(nf) {
  let s = 0;
  if (nf.discriminacao && nf.discriminacao.trim() !== '') s += 10;
  if (nf.status_conciliacao && nf.status_conciliacao !== 'PENDENTE') s += 5;
  if (nf.contrato && nf.contrato.trim() !== '') s += 3;
  if (nf.data_pagamento) s += 2;
  return s;
}

function processar(empresa) {
  console.log(`\n━━━ ${empresa.toUpperCase()} ━━━`);
  const db = getDb(empresa);

  // 1) Remover lixo (numero='0', NULL, vazio)
  const lixoCount = db.prepare(
    "SELECT COUNT(*) c FROM notas_fiscais WHERE numero IS NULL OR TRIM(numero)='' OR TRIM(numero)='0'"
  ).get().c;
  console.log(`  NFs lixo (numero vazio/0): ${lixoCount}`);
  if (APLICAR && lixoCount > 0) {
    db.prepare(
      "DELETE FROM notas_fiscais WHERE numero IS NULL OR TRIM(numero)='' OR TRIM(numero)='0'"
    ).run();
    console.log(`    ✓ Removidas ${lixoCount} NFs lixo`);
  }

  // 2) Deduplicar por numero
  const dups = db.prepare(`
    SELECT numero, COUNT(*) cnt
    FROM notas_fiscais
    WHERE numero IS NOT NULL AND TRIM(numero)<>'' AND TRIM(numero)<>'0'
    GROUP BY numero
    HAVING cnt > 1
  `).all();
  console.log(`  Números duplicados: ${dups.length}`);

  let totalRemover = 0;
  let manter = [];
  let remover = [];

  for (const d of dups) {
    const linhas = db.prepare(
      'SELECT * FROM notas_fiscais WHERE numero = ?'
    ).all(d.numero);
    const ordenadas = [...linhas].sort((a, b) => {
      const ds = score(b) - score(a);
      if (ds !== 0) return ds;
      return b.id - a.id;
    });
    const keep = ordenadas[0];
    const drop = ordenadas.slice(1);
    manter.push(keep.id);
    remover.push(...drop.map(r => r.id));
    totalRemover += drop.length;
  }

  console.log(`  Linhas a remover: ${totalRemover}`);
  if (APLICAR && remover.length > 0) {
    const stmt = db.prepare('DELETE FROM notas_fiscais WHERE id = ?');
    const trx = db.transaction(ids => {
      for (const id of ids) stmt.run(id);
    });
    trx(remover);
    console.log(`    ✓ ${remover.length} duplicatas removidas (mantida a com mais dados)`);
  }

  // 3) Estatística final
  const total = db.prepare('SELECT COUNT(*) c FROM notas_fiscais').get().c;
  const distintas = db.prepare('SELECT COUNT(DISTINCT numero) c FROM notas_fiscais').get().c;
  console.log(`  Pós-operação: ${total} NFs | ${distintas} distintas | ${total - distintas} duplicatas restantes`);
}

console.log(`🧹 Dedup NFs — modo: ${APLICAR ? 'APLICAR' : 'DRY-RUN (use --apply para efetivar)'}`);
ALVO.forEach(processar);
console.log('\n✔️  Concluído.');
