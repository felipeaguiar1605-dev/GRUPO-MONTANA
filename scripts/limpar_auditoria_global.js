#!/usr/bin/env node
/**
 * Montana — Limpeza global baseada em auditoria_global.js
 *
 * Corrige:
 *   1. extratos: SALDO no lado débito
 *   2. extratos: SALDO no lado crédito
 *   3. extratos: duplicatas CRÉDITO cross-format (mantém menor id)
 *   4. notas_fiscais: NFs duplicadas (numero+serie) — mantém menor id
 *   5. despesas: transferências intragrupo (não são despesa)
 *   6. rh_folha_itens: itens órfãos (sem folha correspondente)
 *
 * Uso:
 *   node scripts/limpar_auditoria_global.js [empresa]             # dry-run
 *   node scripts/limpar_auditoria_global.js [empresa] --apply     # aplicar
 *     empresa = assessoria | seguranca | todas (default "todas")
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const empArg = (process.argv.find(a=>!a.startsWith('--') && !a.includes('node') && !a.endsWith('.js')) || 'todas').toLowerCase();
const EMPRESAS = empArg === 'todas' ? ['assessoria','seguranca'] : [empArg];

function fmt(v) { return (v||0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function hasTable(db, name) { return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name); }
function cols(db, t) { try { return db.prepare(`PRAGMA table_info(${t})`).all().map(c=>c.name); } catch { return []; } }
function normHist(r){ return (r||'').toString().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Z0-9]+/g,' ').trim(); }

console.log('═'.repeat(100));
console.log(`  LIMPEZA GLOBAL ${APPLY ? '[APPLY]' : '[DRY-RUN]'}  —  empresas: ${EMPRESAS.join(', ')}`);
console.log('═'.repeat(100));

const totais = { saldoDeb:0, saldoCred:0, dupCred:0, nfDup:0, despIntra:0, rhOrf:0, totVal:0 };

for (const empresa of EMPRESAS) {
  const db = getDb(empresa);
  console.log(`\n${'─'.repeat(100)}\n  📌 ${empresa.toUpperCase()}\n${'─'.repeat(100)}`);

  // ── 1. SALDO no débito ──────────────────────────────────────────────
  const saldoDeb = hasTable(db,'extratos') ? db.prepare(`
    SELECT id, data_iso, debito, historico FROM extratos
    WHERE debito > 0 AND (UPPER(historico) LIKE '%SALDO%' OR UPPER(historico) LIKE '%S A L D O%')
  `).all() : [];
  const valSaldoDeb = saldoDeb.reduce((s,r)=>s+r.debito,0);
  console.log(`  [1] SALDO no débito        : ${saldoDeb.length} (R$ ${fmt(valSaldoDeb)})`);

  // ── 2. SALDO no crédito ─────────────────────────────────────────────
  const saldoCred = hasTable(db,'extratos') ? db.prepare(`
    SELECT id, data_iso, credito, historico FROM extratos
    WHERE credito > 0 AND (UPPER(historico) LIKE '%SALDO%' OR UPPER(historico) LIKE '%S A L D O%')
  `).all() : [];
  const valSaldoCred = saldoCred.reduce((s,r)=>s+r.credito,0);
  console.log(`  [2] SALDO no crédito       : ${saldoCred.length} (R$ ${fmt(valSaldoCred)})`);

  // ── 3. Dup CRÉDITO cross-format ─────────────────────────────────────
  const allCred = hasTable(db,'extratos') ? db.prepare(`
    SELECT id, data_iso, credito, historico FROM extratos WHERE credito > 0
  `).all() : [];
  const mapCred = new Map();
  for (const r of allCred) {
    const k = `${r.data_iso}|${r.credito.toFixed(2)}|${normHist(r.historico)}`;
    (mapCred.get(k) || mapCred.set(k, []).get(k)).push(r);
  }
  const dupCredRemover = [];
  let dupCredVal = 0;
  for (const arr of mapCred.values()) {
    if (arr.length > 1) {
      arr.sort((a,b)=>a.id-b.id);
      for (let i=1;i<arr.length;i++) { dupCredRemover.push(arr[i]); dupCredVal += arr[i].credito; }
    }
  }
  console.log(`  [3] Dup CRÉDITO cross-fmt  : ${dupCredRemover.length} (R$ ${fmt(dupCredVal)})`);

  // ── 4. NFs duplicadas ───────────────────────────────────────────────
  const tblNF = hasTable(db,'notas_fiscais') ? 'notas_fiscais' : (hasTable(db,'notas') ? 'notas' : null);
  const nfRemover = [];
  if (tblNF) {
    const colsNF = cols(db, tblNF);
    if (colsNF.includes('numero')) {
      const temSerie = colsNF.includes('serie');
      const rows = db.prepare(`
        SELECT id, numero, ${temSerie?'serie':"'' as serie"}, valor_liquido
        FROM ${tblNF}
        WHERE numero IS NOT NULL AND numero != ''
      `).all();
      const map = new Map();
      for (const r of rows) {
        const k = `${r.numero}|${r.serie||''}`;
        (map.get(k) || map.set(k,[]).get(k)).push(r);
      }
      for (const arr of map.values()) {
        if (arr.length > 1) {
          arr.sort((a,b)=>a.id-b.id);
          for (let i=1;i<arr.length;i++) nfRemover.push(arr[i]);
        }
      }
    }
  }
  console.log(`  [4] NFs duplicadas         : ${nfRemover.length}`);

  // ── 5. Intragrupo em despesas ───────────────────────────────────────
  const colsD = cols(db,'despesas');
  const campoDesc = colsD.includes('descricao') ? 'descricao' : (colsD.includes('historico') ? 'historico' : null);
  const despIntra = (hasTable(db,'despesas') && campoDesc) ? db.prepare(`
    SELECT id, data_iso, valor_bruto, ${campoDesc} as d FROM despesas
    WHERE UPPER(${campoDesc}) LIKE '%MESMA TITULARIDADE%'
       OR UPPER(${campoDesc}) LIKE '%CH.AVULSO ENTRE AG%'
       OR UPPER(${campoDesc}) LIKE '%TED MESMA TITUL%'
  `).all() : [];
  const despIntraVal = despIntra.reduce((s,r)=>s+(r.valor_bruto||0),0);
  console.log(`  [5] Intragrupo em DESPESA  : ${despIntra.length} (R$ ${fmt(despIntraVal)})`);

  // ── 6. rh_folha_itens órfãos ────────────────────────────────────────
  const rhOrf = hasTable(db,'rh_folha_itens') && hasTable(db,'rh_folha') ? db.prepare(`
    SELECT i.id FROM rh_folha_itens i
    WHERE NOT EXISTS (SELECT 1 FROM rh_folha f WHERE f.id = i.folha_id)
  `).all() : [];
  console.log(`  [6] RH itens órfãos        : ${rhOrf.length}`);

  if (APPLY) {
    db.pragma('foreign_keys = OFF');
    const tx = db.transaction(() => {
      if (saldoDeb.length) {
        const del = db.prepare(`DELETE FROM extratos WHERE id = ?`);
        for (const r of saldoDeb) del.run(r.id);
      }
      if (saldoCred.length) {
        const del = db.prepare(`DELETE FROM extratos WHERE id = ?`);
        for (const r of saldoCred) del.run(r.id);
      }
      if (dupCredRemover.length) {
        const del = db.prepare(`DELETE FROM extratos WHERE id = ?`);
        for (const r of dupCredRemover) del.run(r.id);
      }
      if (nfRemover.length) {
        const del = db.prepare(`DELETE FROM ${tblNF} WHERE id = ?`);
        for (const r of nfRemover) del.run(r.id);
      }
      if (despIntra.length) {
        const del = db.prepare(`DELETE FROM despesas WHERE id = ?`);
        for (const r of despIntra) del.run(r.id);
      }
      if (rhOrf.length) {
        const del = db.prepare(`DELETE FROM rh_folha_itens WHERE id = ?`);
        for (const r of rhOrf) del.run(r.id);
      }
    });
    tx();
    db.pragma('foreign_keys = ON');
    console.log(`  ✅ APPLY concluído: removidos ${saldoDeb.length+saldoCred.length+dupCredRemover.length+nfRemover.length+despIntra.length+rhOrf.length} registros`);
  }

  totais.saldoDeb  += saldoDeb.length;
  totais.saldoCred += saldoCred.length;
  totais.dupCred   += dupCredRemover.length;
  totais.nfDup     += nfRemover.length;
  totais.despIntra += despIntra.length;
  totais.rhOrf     += rhOrf.length;
  totais.totVal    += valSaldoDeb + valSaldoCred + dupCredVal + despIntraVal;
}

console.log(`\n${'═'.repeat(100)}\n  📊 RESUMO GLOBAL ${APPLY ? '[APPLY]' : '[DRY-RUN]'}\n${'═'.repeat(100)}`);
console.log(`  SALDO no débito       : ${totais.saldoDeb}`);
console.log(`  SALDO no crédito      : ${totais.saldoCred}`);
console.log(`  Dup CRÉDITO cross-fmt : ${totais.dupCred}`);
console.log(`  NFs duplicadas        : ${totais.nfDup}`);
console.log(`  Intragrupo em desp.   : ${totais.despIntra}`);
console.log(`  RH itens órfãos       : ${totais.rhOrf}`);
console.log(`  Total registros       : ${totais.saldoDeb+totais.saldoCred+totais.dupCred+totais.nfDup+totais.despIntra+totais.rhOrf}`);
console.log(`  Valor espúrio total   : R$ ${fmt(totais.totVal)}`);
if (!APPLY) console.log(`\n  ⚠️  DRY-RUN — nada foi gravado. Use --apply para aplicar.`);
console.log('');
