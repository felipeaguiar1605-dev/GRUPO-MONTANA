'use strict';
/**
 * Conciliação Assessoria — Batch Re-matching Estado TO (Opção A)
 *
 * Problema anterior: o algoritmo individual matchava um TED grande do Estado
 * contra UMA NF de valor similar, deixando dezenas de NFs pequenas (DETRAN,
 * SESAU, FUNJURIS, UNITINS…) sem extrato correspondente.
 *
 * Este script:
 *   1. Reseta os extratos com CNPJ Estado (01786029) de CONCILIADO → PENDENTE
 *   2. Reseta as NFs Estado-cliente (DETRAN, SESAU, SEDUC, SEMARH, CBMTO,
 *      UNITINS, TCE, FUNJURIS) de CONCILIADO → PENDENTE
 *   3. Para cada extrato Estado (PENDENTE), tenta cobrir um GRUPO de NFs
 *      emitidas na janela de -90d a +30d usando algoritmo greedy ±15%
 *   4. Relatório por mês/tomador
 *
 * Uso:  node scripts/conciliacao_assessoria_batch.js [--dry-run]
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

// ─── Tomadores pagos via Estado TO (CNPJ 01786029) ───────────────────────────
// Incluindo autônomos que recebem dotação do Estado (TCE, UNITINS, TJ/FUNJURIS)
const TOMS_ESTADO = [
  'DEPARTAMENTO ESTADUAL DE TRANSITO - DETRAN/TO',
  'SECRETARIA DE ESTADO DA SAUDE DO TOCANTINS - SESAU',
  'SECRETARIA DA EDUCACAO',
  'SECRETARIA DO MEIO AMBIENTE E RECURSOS HIDRICOS',
  'CORPO DE BOMBEIROS MILITAR DO ESTADO DO TOCANTINS',
  'UNIVERSIDADE ESTADUAL DO TOCANTINS - UNITINS',
  'TRIBUNAL DE CONTAS DO ESTADO DO TOCANTINS',
  'FUNDO ESPECIAL DE MODERNIZACAO E APRIMORAMENTO DO PODER JUDICIARIO',
];

// ─── 1. RESET Estado TEDs → PENDENTE ─────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
console.log('1. RESET — Extratos Estado TO → PENDENTE');
console.log('═══════════════════════════════════════════════════════════');

const qEstadoExts = db.prepare(`
  SELECT id, data_iso, credito, historico
  FROM extratos
  WHERE (historico LIKE '%01786029%'
      OR historico LIKE '%ESTADO DO TOCANTINS%'
      OR historico LIKE '%GOVERNO DO ESTADO%')
    AND credito > 100
    AND data_iso >= '2024-01-01'
`).all();

console.log(`  Extratos Estado TO encontrados: ${qEstadoExts.length}`);
const somaExt = qEstadoExts.reduce((s, e) => s + e.credito, 0);
console.log(`  Total: ${fmtR(somaExt)}`);

if (!DRY_RUN) {
  db.prepare(`
    UPDATE extratos
    SET status_conciliacao = 'PENDENTE'
    WHERE (historico LIKE '%01786029%'
        OR historico LIKE '%ESTADO DO TOCANTINS%'
        OR historico LIKE '%GOVERNO DO ESTADO%')
      AND credito > 100
      AND data_iso >= '2024-01-01'
  `).run();
  console.log('  ✅ Resetados para PENDENTE');
}

// ─── 2. RESET NFs Estado-cliente → PENDENTE ──────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
console.log('2. RESET — NFs Estado-cliente CONCILIADO → PENDENTE');
console.log('═══════════════════════════════════════════════════════════');

const ph = TOMS_ESTADO.map(() => '?').join(',');
const nfsParaReset = db.prepare(`
  SELECT id, tomador, valor_liquido, data_emissao
  FROM notas_fiscais
  WHERE status_conciliacao = 'CONCILIADO'
    AND data_emissao >= '2024-01-01'
    AND tomador IN (${ph})
`).all(...TOMS_ESTADO);

console.log(`  NFs CONCILIADO para resetar: ${nfsParaReset.length}`);
const somaReset = nfsParaReset.reduce((s, n) => s + (n.valor_liquido || 0), 0);
console.log(`  Total: ${fmtR(somaReset)}`);

const byTomReset = {};
nfsParaReset.forEach(n => {
  const k = n.tomador.substring(0, 40);
  if (!byTomReset[k]) byTomReset[k] = 0;
  byTomReset[k]++;
});
Object.entries(byTomReset).sort((a, b) => b[1] - a[1]).forEach(([t, n]) =>
  console.log(`    ${t.padEnd(42)} ${n} NFs`)
);

if (!DRY_RUN) {
  db.prepare(`
    UPDATE notas_fiscais
    SET status_conciliacao = 'PENDENTE'
    WHERE status_conciliacao = 'CONCILIADO'
      AND data_emissao >= '2024-01-01'
      AND tomador IN (${ph})
  `).run(...TOMS_ESTADO);
  console.log('  ✅ Resetadas para PENDENTE');
}

// ─── 3. BATCH MATCHING ────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
console.log('3. BATCH MATCHING — Estado TEDs × grupos de NFs por janela');
console.log('═══════════════════════════════════════════════════════════');

// Carrega extratos Estado (agora PENDENTE)
const estadoExts = db.prepare(`
  SELECT id, data_iso, credito, historico
  FROM extratos
  WHERE (historico LIKE '%01786029%'
      OR historico LIKE '%ESTADO DO TOCANTINS%'
      OR historico LIKE '%GOVERNO DO ESTADO%')
    AND credito > 100
    AND (status_conciliacao = 'PENDENTE' OR status_conciliacao IS NULL)
    AND data_iso >= '2024-01-01'
  ORDER BY data_iso, credito DESC
`).all();

// Carrega NFs Estado-cliente (agora PENDENTE)
const estadoNFs = db.prepare(`
  SELECT id, tomador, valor_bruto, valor_liquido, data_emissao
  FROM notas_fiscais
  WHERE (status_conciliacao = 'PENDENTE' OR status_conciliacao IS NULL)
    AND data_emissao >= '2024-01-01'
    AND valor_bruto > 100
    AND tomador IN (${ph})
  ORDER BY data_emissao, valor_liquido DESC
`).all(...TOMS_ESTADO);

console.log(`  Extratos Estado disponíveis: ${estadoExts.length} (${fmtR(estadoExts.reduce((s,e)=>s+e.credito,0))})`);
console.log(`  NFs Estado-cliente disponíveis: ${estadoNFs.length} (${fmtR(estadoNFs.reduce((s,n)=>s+(n.valor_liquido||n.valor_bruto),0))})`);
console.log('');

const usadosExt = new Set();
const usadosNF  = new Set();
const updExt = db.prepare("UPDATE extratos SET status_conciliacao='CONCILIADO' WHERE id=?");
const updNF  = db.prepare("UPDATE notas_fiscais SET status_conciliacao='CONCILIADO' WHERE id=?");

const TOL = 0.15; // 15% tolerância para pagamentos parciais / deduções ISS
const JANELA_ANTES =  90; // dias ANTES do TED: NFs já emitidas
const JANELA_DEPOIS = 30; // dias DEPOIS do TED: NFs emitidas um pouco após (NF pós-liquidação)

let totalMatch = 0;
let byTom = {};
const logMatch = [];
const logNaoMatch = [];

for (const ted of estadoExts) {
  if (usadosExt.has(ted.id)) continue;
  const TARGET = ted.credito;
  const tedMs = new Date(ted.data_iso).getTime();
  const winMin = tedMs - JANELA_ANTES  * 86400000;
  const winMax = tedMs + JANELA_DEPOIS * 86400000;

  // NFs elegíveis: na janela e ainda não usadas
  const candidatas = estadoNFs.filter(nf => {
    if (usadosNF.has(nf.id)) return false;
    const nfMs = new Date(nf.data_emissao).getTime();
    return nfMs >= winMin && nfMs <= winMax;
  });
  if (candidatas.length === 0) {
    logNaoMatch.push(`  ⚠️  ${ted.data_iso} ${fmtR(TARGET).padStart(18)} — sem NFs na janela`);
    continue;
  }

  // ── Tentativa 1: per-tomador greedy (un-tomador específico) ──
  let found = false;
  const tomsDistinct = [...new Set(candidatas.map(n => n.tomador))];

  for (const tomador of tomsDistinct) {
    const grupo = candidatas
      .filter(n => n.tomador === tomador)
      .sort((a, b) => (b.valor_liquido || b.valor_bruto) - (a.valor_liquido || a.valor_bruto));
    let soma = 0; const batch = [];
    for (const nf of grupo) {
      const v = nf.valor_liquido || nf.valor_bruto;
      if (soma + v > TARGET * (1 + TOL)) continue; // pula se ultrapassa
      soma += v; batch.push(nf);
      if (soma >= TARGET * (1 - TOL)) { found = true; break; }
    }
    if (!found && soma < TARGET * (1 - TOL) && batch.length > 0) {
      // tentou mas não chegou ao mínimo — tente adicionar mais
      for (const nf of grupo) {
        if (batch.includes(nf)) continue;
        const v = nf.valor_liquido || nf.valor_bruto;
        if (soma + v <= TARGET * (1 + TOL)) {
          soma += v; batch.push(nf);
          if (soma >= TARGET * (1 - TOL)) { found = true; break; }
        }
      }
    }
    if (found || soma >= TARGET * (1 - TOL)) {
      found = soma >= TARGET * (1 - TOL) && soma <= TARGET * (1 + TOL);
      if (found) {
        usadosExt.add(ted.id);
        batch.forEach(n => { usadosNF.add(n.id); byTom[tomador] = (byTom[tomador] || 0) + 1; });
        if (!DRY_RUN) { updExt.run(ted.id); batch.forEach(n => updNF.run(n.id)); }
        totalMatch += batch.length;
        const pct = ((soma - TARGET) / TARGET * 100).toFixed(1);
        logMatch.push(`  ✅ ${ted.data_iso} ${fmtR(TARGET).padStart(18)} ↔ ${batch.length} NFs ${tomador.replace('DEPARTAMENTO ESTADUAL DE TRANSITO - DETRAN/TO','DETRAN').replace('SECRETARIA DE ESTADO DA SAUDE DO TOCANTINS - SESAU','SESAU').replace('FUNDO ESPECIAL DE MODERNIZACAO E APRIMORAMENTO DO PODER JUDICIARIO','FUNJURIS').replace('UNIVERSIDADE ESTADUAL DO TOCANTINS - UNITINS','UNITINS').replace('TRIBUNAL DE CONTAS DO ESTADO DO TOCANTINS','TCE').replace('SECRETARIA DA EDUCACAO','SEDUC').replace('SECRETARIA DO MEIO AMBIENTE E RECURSOS HIDRICOS','SEMARH').replace('CORPO DE BOMBEIROS MILITAR DO ESTADO DO TOCANTINS','CBMTO').substring(0,12)} soma=${fmtR(soma)} (${pct}%)`);
        break;
      }
    }
  }
  if (found) continue;

  // ── Tentativa 2: multi-tomador greedy ──
  const multiBatch = [];
  let somaMulti = 0;
  for (const nf of candidatas.sort((a, b) => (b.valor_liquido || b.valor_bruto) - (a.valor_liquido || a.valor_bruto))) {
    if (usadosNF.has(nf.id)) continue;
    const v = nf.valor_liquido || nf.valor_bruto;
    if (somaMulti + v > TARGET * (1 + TOL)) continue;
    somaMulti += v; multiBatch.push(nf);
    if (somaMulti >= TARGET * (1 - TOL)) { found = true; break; }
  }
  if (found) {
    usadosExt.add(ted.id);
    multiBatch.forEach(n => { usadosNF.add(n.id); byTom[n.tomador] = (byTom[n.tomador] || 0) + 1; });
    if (!DRY_RUN) { updExt.run(ted.id); multiBatch.forEach(n => updNF.run(n.id)); }
    totalMatch += multiBatch.length;
    const toms = [...new Set(multiBatch.map(n => n.tomador.replace('DEPARTAMENTO ESTADUAL DE TRANSITO - DETRAN/TO','DETRAN').replace('FUNDO ESPECIAL DE MODERNIZACAO E APRIMORAMENTO DO PODER JUDICIARIO','FUNJURIS').replace('UNIVERSIDADE ESTADUAL DO TOCANTINS - UNITINS','UNITINS').substring(0,8)))].join('+');
    const pct = ((somaMulti - TARGET) / TARGET * 100).toFixed(1);
    logMatch.push(`  ✅ ${ted.data_iso} ${fmtR(TARGET).padStart(18)} ↔ ${multiBatch.length} NFs multi[${toms}] soma=${fmtR(somaMulti)} (${pct}%)`);
    continue;
  }

  logNaoMatch.push(`  ❌ ${ted.data_iso} ${fmtR(TARGET).padStart(18)} — sem match (${candidatas.length} NFs cands, soma=${fmtR(candidatas.reduce((s,n)=>s+(n.valor_liquido||n.valor_bruto),0))})`);
}

// Imprime log
logMatch.forEach(l => console.log(l));
if (logNaoMatch.length > 0) {
  console.log('\n  Extratos sem match:');
  logNaoMatch.forEach(l => console.log(l));
}

// ─── 4. RESUMO ────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
if (DRY_RUN) {
  console.log(`  ⚠️  DRY RUN — nenhuma alteração gravada`);
  console.log(`  Estimativa: +${totalMatch} NFs batch-conciliáveis`);
} else {
  const totNfConc = db.prepare("SELECT COUNT(*) n, SUM(valor_liquido) s FROM notas_fiscais WHERE status_conciliacao='CONCILIADO'").get();
  const totNfPend = db.prepare("SELECT COUNT(*) n FROM notas_fiscais WHERE (status_conciliacao='PENDENTE' OR status_conciliacao IS NULL) AND data_emissao>='2024-01-01' AND valor_bruto>100").get().n;
  const totExtConc = db.prepare("SELECT COUNT(*) n, SUM(credito) s FROM extratos WHERE status_conciliacao='CONCILIADO' AND credito>0").get();
  const totExtPend = db.prepare("SELECT COUNT(*) n, SUM(credito) s FROM extratos WHERE (status_conciliacao='PENDENTE' OR status_conciliacao IS NULL) AND credito>100 AND data_iso>='2024-01-01'").get();

  console.log(`✅  BATCH CONCILIAÇÃO ESTADO — RESUMO`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`  Novas via batch:    +${totalMatch} NFs`);
  console.log(`  NFs CONCILIADO:    ${totNfConc.n}  (${fmtR(totNfConc.s)})`);
  console.log(`  NFs PENDENTE 2024+: ${totNfPend}`);
  console.log(`  Ext CONCILIADO:    ${totExtConc.n}  (${fmtR(totExtConc.s)})`);
  console.log(`  Ext Estado livres:  ${totExtPend.n}  (${fmtR(totExtPend.s)})`);

  console.log('\n  Por tomador (novas):');
  Object.entries(byTom)
    .sort((a, b) => b[1] - a[1])
    .forEach(([t, n]) => console.log(`    ${t.substring(0, 55).padEnd(55)} +${n} NFs`));

  console.log('\n  NFs conciliadas por tomador 2024+:');
  db.prepare(`
    SELECT tomador, COUNT(*) n, SUM(valor_liquido) s
    FROM notas_fiscais
    WHERE status_conciliacao='CONCILIADO' AND data_emissao>='2024-01-01'
    GROUP BY tomador ORDER BY SUM(valor_liquido) DESC LIMIT 15
  `).all().forEach(r =>
    console.log(`    ${r.tomador.substring(0, 55).padEnd(55)} ${String(r.n).padStart(4)} NFs  ${fmtR(r.s)}`)
  );
}
