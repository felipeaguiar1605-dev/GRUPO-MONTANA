#!/usr/bin/env node
/**
 * Montana — Análise de débitos mensais (jan/fev/mar 2026)
 *
 * Replica a metodologia da análise anterior (Assessoria/Segurança):
 *  1. Total de débitos no mês
 *  2. Quebra por categorias:
 *     - Aplicações financeiras (BB Rende Fácil / CDB) — NÃO é despesa
 *     - Transferências intragrupo (Montana, Nevada, Porto Vau, Mustang, Montreal) — NÃO é despesa
 *     - Impostos (DARF, DAM, INSS, FGTS, ISS, etc.)
 *     - Folha de pagamento (salário, vale, adiant.)
 *     - Fornecedores operacionais (demais lançamentos)
 *  3. Saldo de "despesa real" = total - aplicações - transferências intragrupo
 *
 * Uso:
 *   node scripts/analise_debitos_mensal_2026.js [empresa]
 *   (empresa = assessoria | seguranca | todas — default "todas")
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const empArg = (process.argv[2] || 'todas').toLowerCase();
const MESES = [
  { label: 'Janeiro/2026',  from: '2026-01-01', to: '2026-01-31' },
  { label: 'Fevereiro/2026', from: '2026-02-01', to: '2026-02-28' },
  { label: 'Março/2026',    from: '2026-03-01', to: '2026-03-31' },
];

function fmt(v) {
  return (v||0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pct(v, total) { return total>0 ? ((v/total)*100).toFixed(1)+'%' : '—'; }

// Classifica um lançamento pelo histórico
function classificar(histNorm) {
  const h = (histNorm || '').toUpperCase();

  // 1. Aplicações financeiras — NÃO são despesa
  if (/BB RENDE|RENDE FACIL|CDB|LCI|LCA|POUPAN|APLICAC/.test(h))
    return { cat: 'APLIC_FIN', desc: 'Aplicação financeira' };

  // 2. Transferências intragrupo — NÃO são despesa
  if (/MONTANA|NEVADA|PORTO.*VAU|PORTODOVAU|MUSTANG|MONTREAL|OHIO.*MED/.test(h) &&
      !/MONTANASEG.*FUNC|EMPREG|MONTANA MED/.test(h))
    return { cat: 'INTRAGRUPO', desc: 'Transferência intragrupo' };
  if (/TED.*MESMA.*TITUL|MESMA TITULARIDADE|ENTRE.*AG|CH\.AVULSO ENTRE AG/.test(h))
    return { cat: 'INTRAGRUPO', desc: 'Transferência entre agências' };

  // 3. Impostos (DARF/DAM/INSS/FGTS/etc.)
  if (/DARF|DAM |DAM-|SIMPLES|IRRF|CSLL|COFINS|PIS |ISS |ISSQN|IPTU|IPVA|TRIBUT/.test(h))
    return { cat: 'IMPOSTOS', desc: 'Imposto (DARF/DAM/tributo)' };
  if (/FGTS|GRFGTS|CAIXA.*ECONOMIC|GPS|INSS|PREVIDENC/.test(h))
    return { cat: 'IMPOSTOS', desc: 'FGTS/INSS/Previdência' };

  // 4. Folha de pagamento
  if (/FOLHA|SALARIO|SAL\. |VALE|ADIANT|RESCIS|13. SAL|FERIAS/.test(h))
    return { cat: 'FOLHA', desc: 'Folha de pagamento' };

  // 5. Tarifas bancárias
  if (/TARIFA|TAR\.|CESTA|JUROS.*CH.*ESP|IOF|MANUT.*CONTA/.test(h))
    return { cat: 'TARIFAS', desc: 'Tarifa bancária' };

  return { cat: 'OUTROS', desc: 'Outros' };
}

function analisarEmpresa(empresa) {
  const db = getDb(empresa);

  console.log('\n' + '═'.repeat(100));
  console.log(`  📊 ANÁLISE DE DÉBITOS MENSAIS — ${empresa.toUpperCase()}`);
  console.log('═'.repeat(100));

  const resumos = [];

  for (const mes of MESES) {
    const cols = db.prepare('PRAGMA table_info(extratos)').all().map(c => c.name);
    const hasContraparte = cols.includes('contraparte');
    const sel = hasContraparte
      ? `id, data_iso, debito, historico, conta, COALESCE(contraparte,'') as contraparte`
      : `id, data_iso, debito, historico, conta, '' as contraparte`;
    const rows = db.prepare(`
      SELECT ${sel}
      FROM extratos
      WHERE debito > 0
        AND data_iso >= ? AND data_iso <= ?
      ORDER BY debito DESC
    `).all(mes.from, mes.to);

    const buckets = { APLIC_FIN: 0, INTRAGRUPO: 0, IMPOSTOS: 0, FOLHA: 0, TARIFAS: 0, OUTROS: 0 };
    const contagem = { APLIC_FIN: 0, INTRAGRUPO: 0, IMPOSTOS: 0, FOLHA: 0, TARIFAS: 0, OUTROS: 0 };
    const topPorCat = {}; // para listar maiores

    let total = 0;
    for (const r of rows) {
      const h = (r.historico || '') + ' ' + (r.contraparte || '');
      const { cat } = classificar(h);
      buckets[cat] += r.debito;
      contagem[cat]++;
      total += r.debito;
      if (!topPorCat[cat]) topPorCat[cat] = [];
      if (topPorCat[cat].length < 3) topPorCat[cat].push(r);
    }

    const despesaReal = total - buckets.APLIC_FIN - buckets.INTRAGRUPO;

    console.log(`\n──── ${mes.label} ─────────────────────────────────────────────────────────`);
    console.log(`  Total débitos              : R$ ${fmt(total).padStart(18)}    (${rows.length} lançamentos)`);
    console.log(`  ─────────────────────────────────────────────`);
    console.log(`  Aplicações financeiras     : R$ ${fmt(buckets.APLIC_FIN).padStart(18)}    ${pct(buckets.APLIC_FIN,total).padStart(7)}   [${contagem.APLIC_FIN} lanç.]  ❌ não é despesa`);
    console.log(`  Transf. intragrupo         : R$ ${fmt(buckets.INTRAGRUPO).padStart(18)}    ${pct(buckets.INTRAGRUPO,total).padStart(7)}   [${contagem.INTRAGRUPO} lanç.]  ❌ não é despesa`);
    console.log(`  Impostos (DARF/INSS/FGTS…) : R$ ${fmt(buckets.IMPOSTOS).padStart(18)}    ${pct(buckets.IMPOSTOS,total).padStart(7)}   [${contagem.IMPOSTOS} lanç.]`);
    console.log(`  Folha de pagamento         : R$ ${fmt(buckets.FOLHA).padStart(18)}    ${pct(buckets.FOLHA,total).padStart(7)}   [${contagem.FOLHA} lanç.]`);
    console.log(`  Tarifas bancárias          : R$ ${fmt(buckets.TARIFAS).padStart(18)}    ${pct(buckets.TARIFAS,total).padStart(7)}   [${contagem.TARIFAS} lanç.]`);
    console.log(`  Fornec./outros             : R$ ${fmt(buckets.OUTROS).padStart(18)}    ${pct(buckets.OUTROS,total).padStart(7)}   [${contagem.OUTROS} lanç.]`);
    console.log(`  ─────────────────────────────────────────────`);
    console.log(`  ✅ DESPESA REAL (operacional) : R$ ${fmt(despesaReal).padStart(18)}   (total – aplic. – intragrupo)`);

    // Top 5 maiores do mês (qualquer categoria)
    console.log(`\n  Top 5 maiores débitos do mês:`);
    rows.slice(0, 5).forEach((r, i) => {
      const { cat } = classificar((r.historico||'') + ' ' + (r.contraparte||''));
      const hist = (r.historico||'').slice(0, 70);
      console.log(`    ${(i+1)}. R$ ${fmt(r.debito).padStart(14)}  [${cat.padEnd(11)}] ${r.data_iso}  ${hist}`);
    });

    resumos.push({
      mes: mes.label,
      total, despesaReal,
      aplic: buckets.APLIC_FIN, intra: buckets.INTRAGRUPO,
      impostos: buckets.IMPOSTOS, folha: buckets.FOLHA,
      tarifas: buckets.TARIFAS, outros: buckets.OUTROS,
      qtd: rows.length,
    });
  }

  // Resumo consolidado do trimestre
  console.log('\n' + '─'.repeat(100));
  console.log(`  📈 CONSOLIDADO Q1 2026 (jan+fev+mar)`);
  console.log('─'.repeat(100));
  const sum = k => resumos.reduce((s,r)=>s+r[k],0);
  const totalQ = sum('total');
  console.log(`  Total débitos trimestre    : R$ ${fmt(totalQ).padStart(18)}    (${sum('qtd')} lançamentos)`);
  console.log(`    Aplicações financeiras   : R$ ${fmt(sum('aplic')).padStart(18)}    ${pct(sum('aplic'),totalQ)}`);
  console.log(`    Transf. intragrupo       : R$ ${fmt(sum('intra')).padStart(18)}    ${pct(sum('intra'),totalQ)}`);
  console.log(`    Impostos                 : R$ ${fmt(sum('impostos')).padStart(18)}    ${pct(sum('impostos'),totalQ)}`);
  console.log(`    Folha                    : R$ ${fmt(sum('folha')).padStart(18)}    ${pct(sum('folha'),totalQ)}`);
  console.log(`    Tarifas                  : R$ ${fmt(sum('tarifas')).padStart(18)}    ${pct(sum('tarifas'),totalQ)}`);
  console.log(`    Outros/fornec.           : R$ ${fmt(sum('outros')).padStart(18)}    ${pct(sum('outros'),totalQ)}`);
  console.log(`  ✅ DESPESA REAL trimestre   : R$ ${fmt(sum('despesaReal')).padStart(18)}   (média R$ ${fmt(sum('despesaReal')/3)}/mês)`);

  db.close();
  return resumos;
}

const empresas = empArg === 'todas' ? ['assessoria','seguranca'] : [empArg];
const all = {};
for (const e of empresas) {
  all[e] = analisarEmpresa(e);
}

if (empresas.length > 1) {
  console.log('\n' + '═'.repeat(100));
  console.log(`  🏢 COMPARATIVO ASSESSORIA × SEGURANÇA — Q1 2026`);
  console.log('═'.repeat(100));
  console.log(`  ${'Mês'.padEnd(18)}  ${'Assessoria (total)'.padStart(22)}  ${'Assessoria (real)'.padStart(22)}  ${'Segurança (total)'.padStart(22)}  ${'Segurança (real)'.padStart(22)}`);
  for (let i = 0; i < MESES.length; i++) {
    const a = all.assessoria[i], s = all.seguranca[i];
    console.log(`  ${MESES[i].label.padEnd(18)}  R$ ${fmt(a.total).padStart(18)}  R$ ${fmt(a.despesaReal).padStart(18)}  R$ ${fmt(s.total).padStart(18)}  R$ ${fmt(s.despesaReal).padStart(18)}`);
  }
  const aT = all.assessoria.reduce((x,r)=>x+r.total,0);
  const aR = all.assessoria.reduce((x,r)=>x+r.despesaReal,0);
  const sT = all.seguranca.reduce((x,r)=>x+r.total,0);
  const sR = all.seguranca.reduce((x,r)=>x+r.despesaReal,0);
  console.log(`  ${'TRIMESTRE'.padEnd(18)}  R$ ${fmt(aT).padStart(18)}  R$ ${fmt(aR).padStart(18)}  R$ ${fmt(sT).padStart(18)}  R$ ${fmt(sR).padStart(18)}`);
}
console.log('');
