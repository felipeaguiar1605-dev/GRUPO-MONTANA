'use strict';
/**
 * Conciliação Financeira Montana Assessoria — v2 (2024-2026)
 * Melhorias sobre conciliacao_2025_2026.js:
 *   - semAcento() para normalização tolerante a acentos
 *   - Normalização estendida a 2024 (não só 2025+)
 *   - Passo 1: matching individual valor ±3%, janela -30d→+270d
 *   - Passo 2: matching individual valor ±10%, janela -60d→+365d
 *   - Passo 3: batch N NFs → 1 TED (Estado, ±10%, janela 365d)
 *   - Passo 4: greedy para grandes TEDs anônimos
 *   - Marca SALDO / INTERNO (0151) / DEVOLVIDO / GARANTIA
 *
 * Uso: node scripts/conciliacao_assessoria.js [--dry-run]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const DRY_RUN = process.argv.includes('--dry-run');
const db = getDb('assessoria');

function semAcento(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

function fmtR(v) {
  return 'R$' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. MARCAR EXTRATOS NÃO-OPERACIONAIS
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════');
console.log('0. MARCAÇÃO EXTRATOS ESPECIAIS');
console.log('═══════════════════════════════════════════════');

// Saldo (erros de importação de CSV — linha de saldo virou lançamento)
{
  const q = "SELECT COUNT(*) n FROM extratos WHERE historico LIKE 'S A L D O%' AND (status_conciliacao='PENDENTE' OR status_conciliacao IS NULL)";
  const n = DRY_RUN
    ? db.prepare(q).get().n
    : db.prepare("UPDATE extratos SET status_conciliacao='SALDO' WHERE historico LIKE 'S A L D O%' AND (status_conciliacao='PENDENTE' OR status_conciliacao IS NULL)").run().changes;
  console.log(`  SALDO:           ${n} marcados`);
}

// Resgate automático de investimento
{
  const n = DRY_RUN ? 0
    : db.prepare("UPDATE extratos SET status_conciliacao='INVESTIMENTO' WHERE historico LIKE 'Invest.%Resgate%' AND (status_conciliacao='PENDENTE' OR status_conciliacao IS NULL)").run().changes;
  console.log(`  Invest.Resgate:  ${n} → INVESTIMENTO`);
}

// Transferências internas (CNPJ próprio 14092519000151 → sufixo "0151")
{
  const n = DRY_RUN ? 0
    : db.prepare("UPDATE extratos SET status_conciliacao='INTERNO' WHERE historico LIKE '%0151' AND credito > 0 AND (status_conciliacao='PENDENTE' OR status_conciliacao IS NULL)").run().changes;
  console.log(`  0151 (interno):  ${n} → INTERNO`);
}

// Pix rejeitado = devolução
{
  const n = DRY_RUN ? 0
    : db.prepare("UPDATE extratos SET status_conciliacao='DEVOLVIDO' WHERE historico LIKE 'Pix - Rejeitado%' AND (status_conciliacao='PENDENTE' OR status_conciliacao IS NULL)").run().changes;
  console.log(`  Pix Rejeitado:   ${n} → DEVOLVIDO`);
}

// Resgate de garantia bancária
{
  const n = DRY_RUN ? 0
    : db.prepare("UPDATE extratos SET status_conciliacao='GARANTIA' WHERE (historico LIKE 'Resgate Dep%Garantia%' OR historico LIKE 'Desbl Judicial%') AND (status_conciliacao='PENDENTE' OR status_conciliacao IS NULL)").run().changes;
  console.log(`  Garantia/Desbl:  ${n} → GARANTIA`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. NORMALIZAÇÃO DE TOMADORES (2024+, semAcento)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════');
console.log('1. NORMALIZAÇÃO DE TOMADORES (2024+)');
console.log('═══════════════════════════════════════════════');

const NORM_RULES = [
  // ─ DETRAN ─
  { de: 'DEPARTAMENTO ESTADUAL DE TRANSITO - DETRAN - TO',
    para: 'DEPARTAMENTO ESTADUAL DE TRANSITO - DETRAN/TO' },
  { de: 'DEPARTAMENTO ESTADUAL DE TRANSITO - DETRAN',
    para: 'DEPARTAMENTO ESTADUAL DE TRANSITO - DETRAN/TO' },
  { de: 'DEPARTAMENTO ESTADUAL DE TRANSITO',
    para: 'DEPARTAMENTO ESTADUAL DE TRANSITO - DETRAN/TO' },
  // ─ UNITINS ─
  { de: 'UNIVERSIDADE ESTADUAL DO TOCANTINS - UNITINS.',
    para: 'UNIVERSIDADE ESTADUAL DO TOCANTINS - UNITINS' },
  // ─ SESAU ─
  { de: 'TOCANTINS SECRETARIA DE ESTADO DE SAUDE',
    para: 'SECRETARIA DE ESTADO DA SAUDE DO TOCANTINS - SESAU' },
  { de: 'TOCANTINS SECRETARIA DE ESTADO DE SA\u00daDE',  // com acento Ú
    para: 'SECRETARIA DE ESTADO DA SAUDE DO TOCANTINS - SESAU' },
  { de: 'SECRETARIA DA SA\u00daDE',
    para: 'SECRETARIA DE ESTADO DA SAUDE DO TOCANTINS - SESAU' },
  { de: 'SECRETARIA DA SAUDE',
    para: 'SECRETARIA DE ESTADO DA SAUDE DO TOCANTINS - SESAU' },
  // ─ PREVIPALMAS ─
  { de: 'INSTITUTO DE PREVIDENCIA SOCIAL DO MUNIC',
    para: 'PREVIDENCIA SOCIAL DO MUNICIPIO DE PALMAS - PREVIPALMAS' },
  { de: 'INSTITUTO DE PREVIDENCIA SOCIAL DO MUNICIPIO DE PALMAS - PRE',
    para: 'PREVIDENCIA SOCIAL DO MUNICIPIO DE PALMAS - PREVIPALMAS' },
  { de: 'INSTITUTO DE PREVIDENCIA SOCIAL DO MUNICIPIO DE PALMAS - PREVIPALMAS',
    para: 'PREVIDENCIA SOCIAL DO MUNICIPIO DE PALMAS - PREVIPALMAS' },
  // ─ FUNJURIS/TJ ─
  { de: 'FUNDO ESPECIAL DE MODERNIZACAO E APRIMORAMENTO DO PODER JUDICIARIO - FUNJURIS-TO',
    para: 'FUNDO ESPECIAL DE MODERNIZACAO E APRIMORAMENTO DO PODER JUDICIARIO' },
  // ─ SESAU alternativo ─
  { de: 'SECRETARIA DE ESTADO DA SA\u00daDE DO TOCANTINS - SESAU',
    para: 'SECRETARIA DE ESTADO DA SAUDE DO TOCANTINS - SESAU' },
];

const updTom = db.prepare('UPDATE notas_fiscais SET tomador=? WHERE tomador=? AND data_emissao>=?');
for (const r of NORM_RULES) {
  const cnt = db.prepare('SELECT COUNT(*) c FROM notas_fiscais WHERE tomador=? AND data_emissao>=?').get(r.de, '2024-01-01');
  if (cnt.c === 0) { console.log(`  ⏭️  Sem ocorrências: ${r.de.substring(0, 55)}`); continue; }
  if (!DRY_RUN) updTom.run(r.para, r.de, '2024-01-01');
  console.log(`  ✅ ${cnt.c}× "${r.de.substring(0, 45)}" → "${r.para.substring(0, 45)}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Carrega extratos e NFs em memória para matching
// ─────────────────────────────────────────────────────────────────────────────

// Extratos crédito livres (PENDENTE ou NULL)
const extratosLivres = db.prepare(`
  SELECT id, data_iso, credito, historico
  FROM extratos
  WHERE credito > 100
    AND (status_conciliacao = 'PENDENTE' OR status_conciliacao IS NULL)
  ORDER BY data_iso
`).all();

// NFs pendentes 2024+ (não canceladas, não ASSESSORIA, valor > R$100)
const nfsPendentes = db.prepare(`
  SELECT id, numero, tomador, valor_bruto, valor_liquido, data_emissao, competencia
  FROM notas_fiscais
  WHERE data_emissao >= '2024-01-01'
    AND (status_conciliacao = 'PENDENTE' OR status_conciliacao IS NULL)
    AND valor_bruto > 100
  ORDER BY data_emissao
`).all();

const usadosExt = new Set();
const usadosNF  = new Set();

const updNF  = db.prepare("UPDATE notas_fiscais SET status_conciliacao='CONCILIADO' WHERE id=?");
const updExt = db.prepare("UPDATE extratos SET status_conciliacao='CONCILIADO' WHERE id=?");

let p1=0, p2=0, p3=0, p4=0;

// ─────────────────────────────────────────────────────────────────────────────
// PASSO 1 — Individual NF→extrato, ±3%, janela -30d→+270d
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════');
console.log('PASSO 1 — Individual NF→Extrato (±3%, 270d)');
console.log('═══════════════════════════════════════════════');

function matchIndividual(tol, janelaMin, janelaMax) {
  let matched = 0;
  for (const nf of nfsPendentes) {
    if (usadosNF.has(nf.id)) continue;
    const valor = nf.valor_liquido || nf.valor_bruto;
    const tolAbs = Math.max(valor * tol, 20);
    const emMs = new Date(nf.data_emissao).getTime();
    const winMin = emMs + janelaMin * 86400000;
    const winMax = emMs + janelaMax * 86400000;

    let melhor = null, menorDiff = Infinity;
    for (const ext of extratosLivres) {
      if (usadosExt.has(ext.id)) continue;
      if (!ext.data_iso) continue;
      const extMs = new Date(ext.data_iso).getTime();
      if (extMs < winMin || extMs > winMax) continue;
      const diff = Math.abs(ext.credito - valor);
      if (diff <= tolAbs && diff < menorDiff) { melhor = ext; menorDiff = diff; }
    }
    if (melhor) {
      usadosExt.add(melhor.id);
      usadosNF.add(nf.id);
      if (!DRY_RUN) { updNF.run(nf.id); updExt.run(melhor.id); }
      matched++;
    }
  }
  return matched;
}

p1 = matchIndividual(0.03, -30, 270);
console.log(`  Conciliados: ${p1}`);

// ─────────────────────────────────────────────────────────────────────────────
// PASSO 2 — Individual NF→extrato, ±10%, janela -60d→+365d
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════');
console.log('PASSO 2 — Individual NF→Extrato (±10%, 365d)');
console.log('═══════════════════════════════════════════════');

p2 = matchIndividual(0.10, -60, 365);
console.log(`  Conciliados: ${p2}`);

// ─────────────────────────────────────────────────────────────────────────────
// PASSO 3 — Batch: N NFs mesmo payer×mês → 1 TED Estado TO
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════');
console.log('PASSO 3 — Batch N NFs × mês → TED Estado (±12%)');
console.log('═══════════════════════════════════════════════');

// Extratos de Estado do Tocantins livres
const extEstado = extratosLivres.filter(e =>
  !usadosExt.has(e.id) &&
  (semAcento(e.historico).includes('ESTADO DO TOCANTINS') ||
   semAcento(e.historico).includes('GOVERNO DO ESTADO') ||
   (e.historico || '').includes('01786029000103'))
).sort((a, b) => b.credito - a.credito);

// Tomadores Estado (contratos estaduais Assessoria)
const TOMADORES_ESTADO = [
  'DEPARTAMENTO ESTADUAL DE TRANSITO - DETRAN/TO',
  'SECRETARIA DE ESTADO DA SAUDE DO TOCANTINS - SESAU',
  'SECRETARIA DA EDUCACAO',
  'SECRETARIA DO MEIO AMBIENTE E RECURSOS HIDRICOS',
  'TRIBUNAL DE CONTAS DO ESTADO DO TOCANTINS',
  'UNIVERSIDADE ESTADUAL DO TOCANTINS - UNITINS',
  'CORPO DE BOMBEIROS MILITAR DO ESTADO DO TOCANTINS',
  'FUNDO ESPECIAL DE MODERNIZACAO E APRIMORAMENTO DO PODER JUDICIARIO',
];

for (const tedExt of extEstado) {
  if (usadosExt.has(tedExt.id)) continue;
  const TARGET = tedExt.credito;
  const TOL = 0.12;

  // Coleta NFs livres de tomadores Estado, janela -60d→+365d
  const baseMs = new Date(tedExt.data_iso).getTime();
  const candidatas = nfsPendentes.filter(nf =>
    !usadosNF.has(nf.id) &&
    TOMADORES_ESTADO.some(t => semAcento(nf.tomador).includes(semAcento(t).substring(0, 20))) &&
    new Date(nf.data_emissao).getTime() >= baseMs - 365 * 86400000 &&
    new Date(nf.data_emissao).getTime() <= baseMs + 60 * 86400000
  ).sort((a, b) => (b.valor_liquido || b.valor_bruto) - (a.valor_liquido || a.valor_bruto));

  if (candidatas.length === 0) continue;

  // Tenta combinações por tomador-único primeiros, depois multi-tomador
  let found = false;
  const tomadoresDistintos = [...new Set(candidatas.map(n => n.tomador))];

  for (const tomador of tomadoresDistintos) {
    const grupo = candidatas.filter(n => n.tomador === tomador);
    let soma = 0; const batch = [];
    for (const nf of grupo) {
      const v = nf.valor_liquido || nf.valor_bruto;
      soma += v; batch.push(nf);
      if (soma >= TARGET * (1 - TOL) && soma <= TARGET * (1 + TOL)) { found = true; break; }
      if (soma > TARGET * (1 + TOL)) break;
    }
    if (found) {
      usadosExt.add(tedExt.id);
      batch.forEach(n => usadosNF.add(n.id));
      if (!DRY_RUN) {
        updExt.run(tedExt.id);
        batch.forEach(n => updNF.run(n.id));
      }
      p3 += batch.length;
      console.log(`  ✅ TED ${fmtR(TARGET)} ↔ ${batch.length} NFs ${tomador.substring(0, 40)} soma=${fmtR(soma)}`);
      break;
    }
  }

  // Multi-tomador greedy se não encontrou
  if (!found) {
    let soma = 0; const batch = [];
    for (const nf of candidatas) {
      const v = nf.valor_liquido || nf.valor_bruto;
      soma += v; batch.push(nf);
      if (soma >= TARGET * (1 - TOL) && soma <= TARGET * (1 + TOL)) { found = true; break; }
      if (soma > TARGET * (1 + TOL)) break;
    }
    if (found && batch.length >= 2) {
      usadosExt.add(tedExt.id);
      batch.forEach(n => usadosNF.add(n.id));
      if (!DRY_RUN) {
        updExt.run(tedExt.id);
        batch.forEach(n => updNF.run(n.id));
      }
      p3 += batch.length;
      console.log(`  ✅ TED ${fmtR(TARGET)} ↔ ${batch.length} NFs multi-tomador soma=${fmtR(soma)}`);
    } else {
      console.log(`  ⚠️  TED ${fmtR(TARGET)} sem match (${candidatas.length} candidatas, maior soma=${fmtR(candidatas.reduce((s,n)=>s+(n.valor_liquido||n.valor_bruto),0))})`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PASSO 4 — Greedy para grandes TEDs anônimos (sem historico, >R$400K)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════');
console.log('PASSO 4 — Grandes TEDs anônimos (±10%)');
console.log('═══════════════════════════════════════════════');

// Extratos grandes sem historico ainda livres
const extAnonimos = extratosLivres.filter(e =>
  !usadosExt.has(e.id) &&
  e.credito > 400000 &&
  (!e.historico || e.historico.trim() === '' || e.historico === '(sem historico)')
).sort((a, b) => b.credito - a.credito);

for (const ext of extAnonimos) {
  if (usadosExt.has(ext.id)) continue;
  const TARGET = ext.credito;
  const TOL = 0.10;
  const baseMs = new Date(ext.data_iso).getTime();

  // NFs livres dentro de janela -365d→+60d
  const elegíveis = nfsPendentes.filter(nf =>
    !usadosNF.has(nf.id) &&
    new Date(nf.data_emissao).getTime() >= baseMs - 365 * 86400000 &&
    new Date(nf.data_emissao).getTime() <= baseMs + 60 * 86400000
  ).sort((a, b) => (b.valor_liquido || b.valor_bruto) - (a.valor_liquido || a.valor_bruto));

  if (elegíveis.length === 0) { console.log(`  ⏭️  ${ext.data_iso} ${fmtR(TARGET)} — sem NFs no período`); continue; }

  let found = false;
  const tomadoresDistintos = [...new Set(elegíveis.map(n => n.tomador))];

  // 1. Tenta single NF
  for (const nf of elegíveis) {
    const v = nf.valor_liquido || nf.valor_bruto;
    if (Math.abs(v - TARGET) / TARGET <= TOL) {
      usadosExt.add(ext.id);
      usadosNF.add(nf.id);
      if (!DRY_RUN) { updExt.run(ext.id); updNF.run(nf.id); }
      p4++;
      console.log(`  ✅ ${ext.data_iso} ${fmtR(TARGET)} ↔ NF 1:1 R$${fmtR(v)} [${nf.tomador.substring(0,40)}]`);
      found = true; break;
    }
  }
  if (found) continue;

  // 2. Tenta batch por tomador
  for (const tomador of tomadoresDistintos) {
    const grupo = elegíveis.filter(n => n.tomador === tomador);
    let soma = 0; const batch = [];
    for (const nf of grupo) {
      const v = nf.valor_liquido || nf.valor_bruto;
      soma += v; batch.push(nf);
      if (soma >= TARGET * (1 - TOL) && soma <= TARGET * (1 + TOL)) { found = true; break; }
      if (soma > TARGET * (1 + TOL)) break;
    }
    if (found) {
      usadosExt.add(ext.id);
      batch.forEach(n => usadosNF.add(n.id));
      if (!DRY_RUN) { updExt.run(ext.id); batch.forEach(n => updNF.run(n.id)); }
      p4 += batch.length;
      console.log(`  ✅ ${ext.data_iso} ${fmtR(TARGET)} ↔ ${batch.length} NFs ${tomador.substring(0,40)} soma=${fmtR(soma)}`);
      break;
    }
  }

  // 3. Tenta batch multi-tomador
  if (!found) {
    let soma = 0; const batch = [];
    for (const nf of elegíveis) {
      const v = nf.valor_liquido || nf.valor_bruto;
      soma += v; batch.push(nf);
      if (soma >= TARGET * (1 - TOL) && soma <= TARGET * (1 + TOL)) { found = true; break; }
      if (soma > TARGET * (1 + TOL)) break;
    }
    if (found && batch.length >= 2) {
      usadosExt.add(ext.id);
      batch.forEach(n => usadosNF.add(n.id));
      if (!DRY_RUN) { updExt.run(ext.id); batch.forEach(n => updNF.run(n.id)); }
      p4 += batch.length;
      const toms = [...new Set(batch.map(n => n.tomador.substring(0, 25)))].join(' + ');
      console.log(`  ✅ ${ext.data_iso} ${fmtR(TARGET)} ↔ ${batch.length} NFs multi-tom soma=${fmtR(soma)} [${toms}]`);
    } else {
      const top3 = elegíveis.slice(0, 3).map(n => `${n.tomador.substring(0,20)} ${fmtR(n.valor_liquido||n.valor_bruto)}`).join('; ');
      console.log(`  ❌ ${ext.data_iso} ${fmtR(TARGET)} — sem match | top NFs: ${top3}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. RESUMO FINAL
// ─────────────────────────────────────────────────────────────────────────────
const totalNovos = p1 + p2 + p3 + p4;

if (!DRY_RUN) {
  const totNfConc  = db.prepare("SELECT COUNT(*) n, SUM(valor_liquido) s FROM notas_fiscais WHERE status_conciliacao='CONCILIADO'").get();
  const totNfPend  = db.prepare("SELECT COUNT(*) n FROM notas_fiscais WHERE status_conciliacao='PENDENTE'").get().n;
  const totExtConc = db.prepare("SELECT COUNT(*) n, SUM(credito) s FROM extratos WHERE status_conciliacao='CONCILIADO' AND credito>0").get();
  const totExtPend = db.prepare("SELECT COUNT(*) n, SUM(credito) s FROM extratos WHERE (status_conciliacao='PENDENTE' OR status_conciliacao IS NULL) AND credito>100").get();

  console.log('\n═══════════════════════════════════════════════');
  console.log('✅  CONCILIAÇÃO ASSESSORIA — RESUMO');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Novas conciliações: +${totalNovos} (P1:${p1} P2:${p2} P3:${p3} P4:${p4})`);
  console.log(`  NFs CONCILIADO:  ${totNfConc.n}  (${fmtR(totNfConc.s)})`);
  console.log(`  NFs PENDENTE:    ${totNfPend}`);
  console.log(`  Ext CONCILIADO:  ${totExtConc.n}  (${fmtR(totExtConc.s)})`);
  console.log(`  Ext PENDENTE:    ${totExtPend.n}  (${fmtR(totExtPend.s)})`);

  // Resumo por tomador (NFs conciliadas)
  console.log('\n  NFs conciliadas por tomador (2024+):');
  const byTom = db.prepare(`
    SELECT tomador, COUNT(*) n, SUM(valor_liquido) s
    FROM notas_fiscais
    WHERE status_conciliacao='CONCILIADO' AND data_emissao>='2024-01-01'
    GROUP BY tomador ORDER BY SUM(valor_liquido) DESC LIMIT 15
  `).all();
  byTom.forEach(r =>
    console.log(`    ${r.tomador.substring(0, 55).padEnd(55)} ${String(r.n).padStart(4)} NFs  ${fmtR(r.s)}`)
  );
} else {
  console.log(`\n  ⚠️  DRY RUN — nenhuma alteração gravada`);
  console.log(`  Estimativa: +${totalNovos} NFs conciliáveis (P1:${p1} P2:${p2} P3:${p3} P4:${p4})`);
}
