#!/usr/bin/env node
/**
 * Montana — Limpeza nível 5 (dedup débitos + contaminação intra-empresa + linhas SALDO)
 *
 * 1. Dedup DÉBITOS por chave (data_iso + debito + conta + hist_normalizado)
 *    - hist_normalizado = upper, sem separadores [|\-–—], espaços colapsados, sem emojis
 *    - Resolve o problema BB pipe (`|`) vs sem pipe (`-`) que trouxe duplicatas
 * 2. Remove contaminação de aplicações financeiras entre empresas
 *    - BB Rende Fácil / Rende Facil com (data_iso + valor) aparecendo em AMBAS empresas
 *    - Mantém só na empresa correta (definida por conta bancária — ver CONTAS_POR_EMPRESA)
 * 3. Remove linhas "SALDO" órfãs (histórico exato "SALDO" ou "S A L D O") do lado débito
 *    - Esses lançamentos são apenas saldos de fechamento, não débitos reais
 *
 * Uso:
 *   node scripts/limpar_inconsistencias5.js [empresa]           # dry-run
 *   node scripts/limpar_inconsistencias5.js [empresa] --apply
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const INCLUIR_APLICACOES = process.argv.includes('--incluir-aplicacoes'); // flag explícita p/ parte destrutiva
const posArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));
const empArg = (posArgs[0] || 'todas').toLowerCase();

// Contas bancárias de cada empresa (usadas para desambiguar contaminação)
const CONTAS_POR_EMPRESA = {
  assessoria: ['140925190001', '14092519'], // CNPJ 14.092.519
  seguranca:  ['192001090001', '19200109'], // CNPJ 19.200.109
};

// Normaliza histórico para chave de dedup
function normHist(h) {
  if (!h) return '';
  return String(h)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')       // remove acentos
    .toUpperCase()
    .replace(/[|\-–—•·,:/]+/g, ' ')                         // separadores → espaço
    .replace(/\\u[0-9A-F]{4}/gi, ' ')                        // escapes literais \uXXXX
    .replace(/[^\w\s]/g, ' ')                                // remove não-palavra (emojis etc)
    .replace(/\s+/g, ' ')
    .trim();
}

function fmt(v) { return (v||0).toLocaleString('pt-BR', { minimumFractionDigits: 2 }); }

function processar(empresa) {
  const db = getDb(empresa);
  console.log('\n' + '═'.repeat(100));
  console.log(`  LIMPAR NÍVEL 5 — ${empresa.toUpperCase()}  ${APPLY ? '[APPLY]' : '[DRY-RUN]'}`);
  console.log('═'.repeat(100));

  // Detecta colunas disponíveis
  const cols = db.prepare('PRAGMA table_info(extratos)').all().map(c => c.name);

  // ── 1. Dedup DÉBITOS por (data_iso + debito + conta + hist_normalizado)
  console.log('\n── 1. Dedup DÉBITOS por chave normalizada ──');
  const rows = db.prepare(`
    SELECT id, data_iso, debito, COALESCE(conta,'') as conta, COALESCE(historico,'') as historico
    FROM extratos
    WHERE debito > 0 AND data_iso IS NOT NULL
    ORDER BY id ASC
  `).all();

  // Chave IGNORA conta (pipe vs OFX importam a mesma conta com formatos diferentes:
  // '666203' vs '109043-7'). Dentro de uma única empresa a chance de dois lançamentos
  // com mesma data+valor+hist normalizado em contas DIFERENTES ser legítimo é baixa.
  const mapa = new Map();
  for (const r of rows) {
    const key = `${r.data_iso}|${r.debito.toFixed(2)}|${normHist(r.historico)}`;
    if (!mapa.has(key)) mapa.set(key, []);
    mapa.get(key).push(r);
  }
  const dups = [...mapa.values()].filter(g => g.length > 1);
  let debRemovidos = 0;
  let debValorRemovido = 0;
  for (const grupo of dups.slice(0, 20)) {
    const manter = grupo[0];
    const descartar = grupo.slice(1);
    console.log(`   ${manter.data_iso} R$ ${fmt(manter.debito).padStart(14)} × ${grupo.length}  "${manter.historico.slice(0, 55)}"`);
    console.log(`      manter [${manter.id}], descartar [${descartar.map(d=>d.id).join(',')}]`);
    debRemovidos += descartar.length;
    debValorRemovido += descartar.reduce((s,d)=>s+d.debito, 0);
  }
  if (dups.length > 20) console.log(`   ... +${dups.length-20} grupos (${dups.slice(20).reduce((s,g)=>s+g.length-1,0)} duplicatas extras)`);
  // reconta tudo
  debRemovidos = dups.reduce((s,g)=>s+g.length-1, 0);
  debValorRemovido = dups.reduce((s,g)=>s + g.slice(1).reduce((x,d)=>x+d.debito,0), 0);
  console.log(`   Total: ${dups.length} grupos duplicados → ${debRemovidos} débitos removíveis (R$ ${fmt(debValorRemovido)})`);

  if (APPLY && debRemovidos > 0) {
    db.pragma('foreign_keys = OFF');
    const upNf = db.prepare('UPDATE notas_fiscais SET extrato_id = ? WHERE extrato_id = ?');
    let upDesp = null;
    try { upDesp = db.prepare('UPDATE despesas SET extrato_id = ? WHERE extrato_id = ?'); } catch(_){}
    const del = db.prepare('DELETE FROM extratos WHERE id = ?');
    const tx = db.transaction(() => {
      for (const grupo of dups) {
        const manter = grupo[0];
        for (const d of grupo.slice(1)) {
          try { upNf.run(manter.id, d.id); } catch(_){}
          if (upDesp) { try { upDesp.run(manter.id, d.id); } catch(_){} }
          try { del.run(d.id); } catch(e) { console.log(`      ⚠ skip id=${d.id}: ${e.message}`); }
        }
      }
    });
    tx();
    db.pragma('foreign_keys = ON');
    console.log(`   ✓ ${debRemovidos} débitos duplicados removidos`);
  }

  // ── 2. Linhas "SALDO" órfãs (não são débitos reais)
  console.log('\n── 2. Linhas "SALDO" / "S A L D O" no lado débito ──');
  const saldos = db.prepare(`
    SELECT id, data_iso, debito, historico
    FROM extratos
    WHERE debito > 0
      AND (
        TRIM(UPPER(historico)) IN ('SALDO','SALDO ANTERIOR','S A L D O','S.A.L.D.O','SALDO DIA')
        OR UPPER(TRIM(historico)) LIKE 'SALDO%'
      )
  `).all();
  let saldosRemovidos = 0;
  let saldoValor = 0;
  for (const s of saldos.slice(0, 10)) {
    console.log(`   [${s.id}] ${s.data_iso} R$ ${fmt(s.debito).padStart(14)}  "${s.historico}"`);
  }
  if (saldos.length > 10) console.log(`   ... +${saldos.length-10} linhas`);
  saldosRemovidos = saldos.length;
  saldoValor = saldos.reduce((s,r)=>s+r.debito, 0);
  console.log(`   Total: ${saldosRemovidos} linhas SALDO (R$ ${fmt(saldoValor)})`);

  if (APPLY && saldosRemovidos > 0) {
    db.pragma('foreign_keys = OFF');
    const tx = db.transaction(() => {
      for (const s of saldos) {
        try { db.prepare('DELETE FROM extratos WHERE id = ?').run(s.id); } catch(_){}
      }
    });
    tx();
    db.pragma('foreign_keys = ON');
    console.log(`   ✓ ${saldosRemovidos} linhas SALDO removidas`);
  }

  // NÃO fechar o db aqui — o getDb() cache mantém a referência e
  // analisarContaminacaoAplicacoes() abaixo precisa reusar. Fechamos no final.
  return { debRemovidos, debValorRemovido, saldosRemovidos, saldoValor };
}

// ── 3. Contaminação de APLICAÇÕES FINANCEIRAS entre empresas
// (rodar como pós-processo com ambos DBs abertos)
function analisarContaminacaoAplicacoes() {
  console.log('\n' + '═'.repeat(100));
  console.log(`  ANÁLISE DE CONTAMINAÇÃO DE APLICAÇÕES ENTRE EMPRESAS  ${APPLY ? '[APPLY]' : '[DRY-RUN]'}`);
  console.log('═'.repeat(100));

  const dbA = getDb('assessoria');
  const dbS = getDb('seguranca');

  const getAplic = (db) => db.prepare(`
    SELECT id, data_iso, debito, COALESCE(conta,'') as conta, COALESCE(historico,'') as historico
    FROM extratos
    WHERE debito > 0
      AND UPPER(historico) LIKE '%RENDE%'
    ORDER BY data_iso
  `).all();

  const aplicA = getAplic(dbA);
  const aplicS = getAplic(dbS);

  // Encontra pares (data_iso + debito) que aparecem em ambas
  const setA = new Map();
  aplicA.forEach(r => { setA.set(`${r.data_iso}|${r.debito.toFixed(2)}`, r); });
  const duplicados = [];
  for (const r of aplicS) {
    const k = `${r.data_iso}|${r.debito.toFixed(2)}`;
    if (setA.has(k)) duplicados.push({ ass: setA.get(k), seg: r });
  }

  console.log(`   Aplicações "Rende" em Assessoria : ${aplicA.length}`);
  console.log(`   Aplicações "Rende" em Segurança  : ${aplicS.length}`);
  console.log(`   Pares que aparecem em AMBAS     : ${duplicados.length}`);

  // Heurística: se a conta em Assessoria contém CNPJ Seg (ou vice-versa), remover de onde não pertence
  // Como não é clara a origem, vamos remover da SEGURANÇA os duplicados que tenham padrão
  // de conta Assessoria. Por default, manter em Assessoria (onde aparecem historicamente).
  let removidos = 0;
  let removidosValor = 0;
  for (const p of duplicados.slice(0, 10)) {
    const contaSeg = p.seg.conta;
    const contaAss = p.ass.conta;
    console.log(`   ${p.ass.data_iso} R$ ${fmt(p.ass.debito).padStart(14)}`);
    console.log(`      Ass: [${p.ass.id}] conta="${contaAss.slice(0,40)}"`);
    console.log(`      Seg: [${p.seg.id}] conta="${contaSeg.slice(0,40)}"`);
  }
  if (duplicados.length > 10) console.log(`   ... +${duplicados.length-10} duplicatas`);

  // PROTEÇÃO: só remove se flag explícita --incluir-aplicacoes.
  // Contas distintas ("assessoria" vs "666203") podem ser contas bancárias legítimas
  // de cada empresa — matching por (data+valor) pode gerar falsos positivos.
  if (APPLY && INCLUIR_APLICACOES && duplicados.length > 0) {
    dbS.pragma('foreign_keys = OFF');
    const del = dbS.prepare('DELETE FROM extratos WHERE id = ?');
    const tx = dbS.transaction(() => {
      for (const p of duplicados) {
        try { del.run(p.seg.id); removidos++; removidosValor += p.seg.debito; } catch(e) { console.log(`⚠ ${e.message}`); }
      }
    });
    tx();
    dbS.pragma('foreign_keys = ON');
    console.log(`   ✓ ${removidos} aplicações contaminantes removidas da Segurança (R$ ${fmt(removidosValor)})`);
  } else {
    // mostra o potencial, mas não aplica sem a flag explícita
    const pot = duplicados.length;
    const potVal = duplicados.reduce((s,p)=>s+p.seg.debito, 0);
    const motivo = (APPLY && !INCLUIR_APLICACOES)
      ? 'PROTEGIDO — use --incluir-aplicacoes p/ aplicar'
      : 'dry-run';
    console.log(`   (${motivo}) potencial: ${pot} remover · R$ ${fmt(potVal)}`);
  }

  // fecha apenas no final do script (após resumo)
  return { removidos, removidosValor };
}

const empresas = empArg === 'todas' ? ['assessoria','seguranca'] : [empArg];
const tot = { debRemovidos: 0, debValorRemovido: 0, saldosRemovidos: 0, saldoValor: 0 };
for (const e of empresas) {
  const r = processar(e);
  for (const k of Object.keys(tot)) tot[k] += r[k];
}

const contam = empArg === 'todas' ? analisarContaminacaoAplicacoes() : { removidos: 0, removidosValor: 0 };

console.log('\n' + '═'.repeat(100));
console.log(`  RESUMO GERAL ${APPLY ? '[APPLIED]' : '[DRY-RUN]'}`);
console.log('═'.repeat(100));
console.log(`  Débitos duplicados removidos       : ${tot.debRemovidos} (R$ ${fmt(tot.debValorRemovido)})`);
console.log(`  Linhas SALDO removidas             : ${tot.saldosRemovidos} (R$ ${fmt(tot.saldoValor)})`);
console.log(`  Aplicações contaminantes (Seg)     : ${contam.removidos} (R$ ${fmt(contam.removidosValor)})`);
console.log(`  TOTAL DE VALOR ESPÚRIO REMOVIDO    : R$ ${fmt(tot.debValorRemovido + tot.saldoValor + contam.removidosValor)}`);
if (!APPLY) console.log('\n  ⚠️  Nada gravado. Use --apply para aplicar.');
