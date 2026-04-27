/**
 * Conciliação Financeira — Montana Segurança Patrimonial Ltda
 *
 * Particularidades:
 * - Palmas paga por Ordem Bancária individual (1 extrato ≈ 1 NF) — até 240 dias de atraso
 * - Estado (SEDUC/MP) paga via TED CNPJ 01786029000103 — às vezes em lote (N NFs → 1 TED)
 * - UFT paga via Pix CNPJ 05149726000104
 * - DB importou 2 CSVs (pipe e sem-pipe) — deduplicamos por (data_iso, credito)
 * - NFs contaminadas (Assessoria): UNITINS, DETRAN, TCE, CBMTO, FUNJURIS — marcadas ASSESSORIA
 * - Extratos internos (Montana própria CNPJ 19200109) e BB Rende Fácil → marcados INTERNO/INVESTIMENTO
 *
 * Uso:
 *   node scripts/conciliacao_seguranca.js          (executa)
 *   node scripts/conciliacao_seguranca.js --dry-run (analisa, não salva)
 */

'use strict';
const path = require('path');
const Database = require('better-sqlite3');

const DRY_RUN = process.argv.includes('--dry-run');
const db = new Database(path.join(__dirname, '../data/seguranca/montana.db'));

// Normaliza acentos para comparação insensível a diacríticos
function semAcento(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

console.log('');
console.log('══════════════════════════════════════════════════════════');
console.log('  CONCILIAÇÃO — Montana Segurança Patrimonial Ltda');
console.log(`  Modo: ${DRY_RUN ? 'DRY RUN (sem alterações)' : 'EXECUÇÃO REAL'}`);
console.log('══════════════════════════════════════════════════════════\n');

// ── 1. CORRIGIR data_emissao VAZIA ────────────────────────────────
console.log('1. CORRIGIR data_emissao VAZIA\n' + '─'.repeat(50));
const MESES_BR = {jan:'01',fev:'02',mar:'03',abr:'04',mai:'05',jun:'06',jul:'07',ago:'08',set:'09',out:'10',nov:'11',dez:'12'};

function compParaData(comp) {
  if (!comp) return null;
  const s = comp.trim().toLowerCase();
  const m1 = s.match(/^([a-z]{3})\/(\d{2})$/);
  if (m1 && MESES_BR[m1[1]]) { const a = parseInt(m1[2])<50?'20'+m1[2]:'19'+m1[2]; return `${a}-${MESES_BR[m1[1]]}-15`; }
  const m2 = s.match(/^([a-z]{3})\/(\d{4})$/);
  if (m2 && MESES_BR[m2[1]]) return `${m2[2]}-${MESES_BR[m2[1]]}-15`;
  const m3 = s.match(/^(\d{2})\/(\d{4})$/);
  if (m3) return `${m3[2]}-${m3[1]}-15`;
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-15`;
  return null;
}

const nfsSemData = db.prepare("SELECT id, competencia FROM notas_fiscais WHERE data_emissao IS NULL OR data_emissao=''").all();
let corrigidas = 0;
const updData = db.prepare("UPDATE notas_fiscais SET data_emissao=? WHERE id=?");
for (const nf of nfsSemData) {
  const dt = compParaData(nf.competencia);
  if (dt) { if (!DRY_RUN) updData.run(dt, nf.id); corrigidas++; }
}
console.log(`  Corrigidas: ${corrigidas} | Sem competência: ${nfsSemData.length - corrigidas}\n`);

// ── 2. NORMALIZAR TOMADORES ────────────────────────────────────────
console.log('2. NORMALIZAÇÃO DE TOMADORES\n' + '─'.repeat(50));

// ILIKE por semAcento — busca via LIKE com versão sem acento
// Para executar no SQLite precisamos buscar todos e comparar em JS
const NORM_RULES = [
  // Palmas e órgãos municipais — variantes com/sem acento e grafia alternativa
  [t => semAcento(t) === 'MUNICIPIO DE PALMAS',                             'MUNICIPIO DE PALMAS'],
  [t => semAcento(t).includes('AGENCIA DE TRANSPORTE COLETIVO DE PALMAS'),  'AGENCIA DE TRANSPORTE COLETIVO DE PALMAS (ATCP)'],
  [t => semAcento(t).includes('AGENCIA MUNICIPAL DE TURISMO'),              'PMP-AGENCIA MUNICIPAL DE TURISMO'],
  [t => semAcento(t).startsWith('PMP-AGENCIA MUNICIPAL DE TURISMO'),       'PMP-AGENCIA MUNICIPAL DE TURISMO'],
  [t => semAcento(t).includes('INSTITUTO DE PREVIDENCIA SOCIAL DO MUNICIPIO') || semAcento(t).includes('PREVIDENCIA SOCIAL DO MUNICIPIO DE PALMAS'), 'PREVIDENCIA SOCIAL DO MUNICIPIO DE PALMAS - PREVIPALMAS'],
  [t => semAcento(t).includes('FUNDACAO MUNICIPAL DE MEIO AMBIENTE'),      'FUNDACAO MUNICIPAL DE MEIO AMBIENTE DE PALMAS - FMA'],
  // DETRAN — variantes com/sem acento, com/sem prefixo estado
  [t => semAcento(t).includes('DEPARTAMENTO ESTADUAL DE TRANSITO'),         'DEPARTAMENTO ESTADUAL DE TRANSITO'],
  // SEDUC — Estado do Tocantins
  [t => semAcento(t).includes('SECRETARIA DA EDUCACAO DO ESTADO DE TOCANTINS'), 'SECRETARIA DA EDUCACAO'],
  // MP/TO — variantes
  [t => ['TOCANTINS PROCURADORIA GERAL DA JUSTICA',
         'MINISTERIO PUBLICO ESTADUAL',
         'PROCURADORIA GERAL DE JUSTICA'].includes(semAcento(t)),            'MINISTERIO PUBLICO DO ESTADO DO TOCANTINS - MP/TO'],
  // UNITINS
  [t => semAcento(t).startsWith('UNIVERSIDADE ESTADUAL DO TOCANTINS') && t.endsWith('.'), 'UNIVERSIDADE ESTADUAL DO TOCANTINS - UNITINS'],
];

const todasNFsParaNorm = db.prepare('SELECT id, tomador FROM notas_fiscais WHERE tomador IS NOT NULL').all();
let normCount = 0;
const updTomador = db.prepare('UPDATE notas_fiscais SET tomador=? WHERE id=?');
for (const nf of todasNFsParaNorm) {
  for (const [testFn, alvo] of NORM_RULES) {
    if (nf.tomador !== alvo && testFn(nf.tomador)) {
      if (!DRY_RUN) updTomador.run(alvo, nf.id);
      normCount++;
      break;
    }
  }
}
console.log(`  Tomadores normalizados: ${normCount} NFs atualizadas\n`);

// ── 3. TOMADORES CONTAMINADOS (clientes da Assessoria) ─────────────
// Marcados como status_conciliacao='ASSESSORIA' para exclusão da conciliação
console.log('3. MARCAR NFs CONTAMINADAS → ASSESSORIA\n' + '─'.repeat(50));

// Prefixos (sem acento, comparados com semAcento(tomador))
const CONTAMINADOS_PREFIXOS_SA = [
  'UNIVERSIDADE ESTADUAL DO TOCANTINS', // UNITINS — contrato Assessoria
  'DEPARTAMENTO ESTADUAL DE TRANSITO',  // DETRAN — contrato Assessoria
  'TRIBUNAL DE CONTAS',                 // TCE — contrato Assessoria
  'CORPO DE BOMBEIROS',                 // CBMTO — contrato Assessoria
  'FUNDO ESPECIAL DE MODERNIZACAO',     // FUNJURIS/TJ — contrato Assessoria
  'PODER JUDICIARIO',
];
const isContaminado = t => CONTAMINADOS_PREFIXOS_SA.some(p => semAcento(t || '').includes(p));

// Marcar como ASSESSORIA as que ainda estão PENDENTE
const nfsContPend = db.prepare(
  "SELECT id, tomador FROM notas_fiscais WHERE (status_conciliacao IS NULL OR status_conciliacao='PENDENTE')"
).all().filter(n => isContaminado(n.tomador));

const updAssessoria = db.prepare("UPDATE notas_fiscais SET status_conciliacao='ASSESSORIA' WHERE id=?");
if (!DRY_RUN) {
  for (const nf of nfsContPend) updAssessoria.run(nf.id);
}
console.log(`  Marcadas ASSESSORIA agora: ${nfsContPend.length}`);

const totalAssessoria = db.prepare("SELECT COUNT(*) n FROM notas_fiscais WHERE status_conciliacao='ASSESSORIA'").get().n;
console.log(`  Total ASSESSORIA no banco: ${totalAssessoria}\n`);

// ── 4. MARCAR EXTRATOS INTERNOS / INVESTIMENTO ─────────────────────
console.log('4. CLASSIFICAR EXTRATOS INTERNOS\n' + '─'.repeat(50));

// Montana Segurança própria CNPJ: 19200109000109 → INTERNO (transferência entre contas)
// BB Rende Fácil → INVESTIMENTO (aplicação financeira)
// TED Devolvida → INTERNO
const updExtStatus = db.prepare("UPDATE extratos SET status_conciliacao=? WHERE id=?");
const extIntervos = db.prepare(
  "SELECT id, historico FROM extratos WHERE (status_conciliacao IS NULL OR status_conciliacao='PENDENTE') AND credito > 0"
).all();

let marcadosInterno = 0, marcadosInvest = 0;
for (const e of extIntervos) {
  const h = (e.historico || '').toUpperCase();
  // Transferências internas (Montana própria, outras empresas do grupo)
  if (h.includes('19200109000109') ||  // Montana Segurança própria
      h.includes('14092519000151') ||  // Montana Assessoria
      h.includes('MONTANA ASSESS') ||  // Montana Assessoria (nome)
      h.includes('MONTANA SERVIC') ||  // Montana Serviços
      h.includes('TED DEVOLVIDA') ||
      h.includes('DEPOSITO GARANTIA') ||
      h.includes('RESGATE DEP')) {
    if (!DRY_RUN) updExtStatus.run('INTERNO', e.id);
    marcadosInterno++;
  } else if (h.includes('BB RENDE') || h.includes('RENDE FACIL') || h.includes('RENDE FÁCIL') ||
             h.includes('POUPANCA') || h.includes('POUPANÇA') || h.includes('RESGATE DEPOSITO')) {
    if (!DRY_RUN) updExtStatus.run('INVESTIMENTO', e.id);
    marcadosInvest++;
  }
}
console.log(`  Marcados INTERNO:      ${marcadosInterno}`);
console.log(`  Marcados INVESTIMENTO: ${marcadosInvest}\n`);

// ── 5. CARREGAR DADOS PARA CONCILIAÇÃO ─────────────────────────────
console.log('5. CONCILIAÇÃO INDIVIDUAL NF → EXTRATO\n' + '─'.repeat(50));

const todasNFs = db.prepare(`
  SELECT id, numero, tomador, valor_bruto, valor_liquido, data_emissao
  FROM notas_fiscais
  WHERE (status_conciliacao IS NULL OR status_conciliacao = 'PENDENTE')
    AND valor_bruto > 10
    AND data_emissao IS NOT NULL AND data_emissao != ''
  ORDER BY data_emissao ASC
`).all();

// Extratos de receita — DEDUPLICA por (data_iso, credito) mantendo o menor id
const extCredsRaw = db.prepare(`
  SELECT MIN(id) id, data_iso, credito, MIN(historico) historico, status_conciliacao
  FROM extratos
  WHERE credito > 100
    AND data_iso IS NOT NULL
    AND (status_conciliacao IS NULL
         OR status_conciliacao NOT IN ('CONCILIADO','INTERNO','INVESTIMENTO','TRANSFERENCIA'))
  GROUP BY data_iso, credito
  ORDER BY data_iso ASC
`).all();

// IDs originais de cada grupo de duplicata — para atualizar TODOS ao conciliar
const extIdsPorDedupKey = {};
const extRawAll = db.prepare(`
  SELECT id, data_iso, credito, status_conciliacao
  FROM extratos
  WHERE credito > 100 AND data_iso IS NOT NULL
    AND (status_conciliacao IS NULL
         OR status_conciliacao NOT IN ('CONCILIADO','INTERNO','INVESTIMENTO','TRANSFERENCIA'))
`).all();
for (const e of extRawAll) {
  const key = `${e.data_iso}|${e.credito}`;
  if (!extIdsPorDedupKey[key]) extIdsPorDedupKey[key] = [];
  extIdsPorDedupKey[key].push(e.id);
}

console.log(`  NFs pendentes: ${todasNFs.length}`);
console.log(`  Extratos livres (deduplicados): ${extCredsRaw.length}\n`);

const updNF  = db.prepare("UPDATE notas_fiscais SET status_conciliacao='CONCILIADO' WHERE id=?");
const updExt = db.prepare("UPDATE extratos SET status_conciliacao='CONCILIADO' WHERE id=?");

const extUsados = new Set();
const nfUsadas  = new Set();
let totalConc = 0;
let totalSkip = 0;

function marcaMatch(nf, ext) {
  const key = `${ext.data_iso}|${ext.credito}`;
  extUsados.add(ext.id);
  nfUsadas.add(nf.id);
  if (!DRY_RUN) {
    updNF.run(nf.id);
    for (const eid of (extIdsPorDedupKey[key] || [ext.id])) updExt.run(eid);
  }
  totalConc++;
}

// Helper de matching individual (reutilizado nos passos 1, 2, 3)
function matchNFsAoExtratos(nfs, exts, tolPct, janelaDias, label) {
  let conc = 0;
  for (const nf of nfs) {
    if (isContaminado(nf.tomador)) { totalSkip++; continue; }
    if (nfUsadas.has(nf.id)) continue;
    const liq = nf.valor_liquido || nf.valor_bruto;
    const nfDate = new Date(nf.data_emissao).getTime();
    const tol = Math.max(liq * tolPct, 5);
    let best = null, bestDiff = Infinity;
    for (const ext of exts) {
      if (extUsados.has(ext.id)) continue;
      const diff = Math.abs(ext.credito - liq);
      if (diff > tol) continue;
      const extDate = new Date(ext.data_iso).getTime();
      if (extDate < nfDate - 30 * 86400000) continue;
      if (extDate > nfDate + janelaDias * 86400000) continue;
      if (diff < bestDiff) { best = ext; bestDiff = diff; }
    }
    if (best) {
      marcaMatch(nf, best);
      conc++;
      const pct = (bestDiff / liq * 100).toFixed(2);
      console.log(`    ✅ NF ${String(nf.id).padStart(5)} ${nf.data_emissao} ${(nf.tomador||'').slice(0,32).padEnd(32)} liq=${liq.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(13)}  ext=${best.data_iso} R$${best.credito.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(13)}  diff=${pct}%`);
    }
  }
  return conc;
}

// ── Passo 1: Matching individual exato (≤0.5%, janela 150 dias) ─────
console.log('  Passo 1 — Matching individual exato (≤0.5%, 150d)');
const conc1 = matchNFsAoExtratos(todasNFs, extCredsRaw, 0.005, 150, 'P1');
console.log(`  → Passo 1: ${conc1} NFs conciliadas\n`);

// ── Passo 2: Matching individual ampliado (≤5%, janela 240 dias) ────
console.log('  Passo 2 — Matching individual ampliado (≤5%, 240d)');
const conc2 = matchNFsAoExtratos(todasNFs, extCredsRaw, 0.05, 240, 'P2');
console.log(`  → Passo 2: ${conc2} NFs conciliadas\n`);

// ── Passo 3: Matching por pagador identificado (≤10%, 300 dias) ─────
console.log('  Passo 3 — Matching por pagador identificado (≤10%, 300d)');

const GRUPOS = [
  {
    key: 'MUNICIPIO_PALMAS',
    label: 'Município de Palmas',
    filtroExt: h => h.includes('MUNICIPIO DE PALMAS') || h.includes('ORDENS BANCARIAS') ||
                    (h.includes('ORDEM BANC') && (h.includes('PALMAS') || h.includes('ORDENS'))),
    filtroNF:  t => {
      const u = semAcento(t);
      return u.includes('MUNICIPIO DE PALMAS') || u.includes('PREFEITURA') ||
             u.includes('FCP') || u.includes('FUNDACAO CULTURAL') ||
             u.includes('ATCP') || u.includes('AGENCIA DE TRANSPORTE') ||
             u.includes('ARCES') || u.includes('PREVI') ||
             u.includes('FUNDACAO MUNICIPAL') || u.includes('MEIO AMBIENTE') ||
             u.includes('REGULACAO') || u.includes('TECNOLOGIA DA INFORMACAO') ||
             u.includes('TURISMO') || u.includes('ASSISTENCIA SOCIAL') ||
             u.includes('AGENCIA MUNICIPAL') ||
             u.includes('PREVIDENCIA SOCIAL DO MUNI') ||
             u.includes('INSTITUTO 20 DE MAIO') ||
             u.includes('FUNDO MUNICIPAL') || u.includes('JUVENTUDE DE PALMAS');
    },
  },
  {
    key: 'ESTADO_TO',
    label: 'Estado do Tocantins (SEDUC/outros)',
    filtroExt: h => h.includes('01786029') || h.includes('070 0380') ||
                    h.includes('GOVERNO DO EST') || h.includes('ESTADO DO TOCANTINS'),
    filtroNF:  t => {
      const u = semAcento(t);
      return u.includes('SECRETARIA DA EDUCACAO') || u.includes('SEDUC') ||
             u.includes('SECRETARIA DA INFRA') || u.includes('SEINF');
      // MP/TO excluído aqui — tem passo próprio abaixo
    },
  },
  {
    key: 'MP_TO',
    label: 'Ministério Público do Tocantins',
    // MP paga via Estado OU via seu próprio CNPJ
    filtroExt: h => h.includes('01786029') || h.includes('01786078') ||
                    h.includes('MINISTERIO PUBLICO') || h.includes('MP/TO'),
    filtroNF:  t => semAcento(t).includes('MINISTERIO PUBLICO') || t.includes('MP/TO'),
  },
  {
    key: 'UFT',
    label: 'UFT — Fundação Univ. Federal do Tocantins',
    filtroExt: h => h.includes('05149726') || h.includes('FUNDACAO UNIVER') ||
                    h.includes('UNIV FEDERAL') || h.includes('UFT'),
    filtroNF:  t => semAcento(t).includes('FUNDACAO UNIVERSIDADE FEDERAL') || t.toUpperCase().includes('UFT'),
  },
];

// Recarregar NFs pendentes após passos 1 e 2
const nfsPendentes3 = db.prepare(`
  SELECT id, numero, tomador, valor_bruto, valor_liquido, data_emissao
  FROM notas_fiscais
  WHERE (status_conciliacao IS NULL OR status_conciliacao = 'PENDENTE')
    AND valor_bruto > 10
    AND data_emissao IS NOT NULL AND data_emissao != ''
  ORDER BY data_emissao ASC
`).all();

let conc3 = 0;
for (const grupo of GRUPOS) {
  const extGrupo = extCredsRaw.filter(e =>
    !extUsados.has(e.id) && grupo.filtroExt((e.historico || '').toUpperCase())
  );
  if (extGrupo.length === 0) { console.log(`    ⏭️  ${grupo.key}: sem extratos disponíveis`); continue; }

  const nfsGrupo = nfsPendentes3.filter(n =>
    !nfUsadas.has(n.id) && !isContaminado(n.tomador) && grupo.filtroNF(n.tomador)
  );
  if (nfsGrupo.length === 0) { console.log(`    ⏭️  ${grupo.key}: sem NFs pendentes`); continue; }

  console.log(`    ${grupo.key}: ${extGrupo.length} extratos × ${nfsGrupo.length} NFs`);
  const concGrupo = matchNFsAoExtratos(nfsGrupo, extGrupo, 0.10, 300, grupo.key);
  conc3 += concGrupo;
  console.log(`     → ${grupo.label}: ${concGrupo} NFs conciliadas\n`);
}
console.log(`  → Passo 3: ${conc3} NFs conciliadas\n`);

// ── Passo 4: Batch matching Estado TED → N NFs (SEDUC + MP) ─────────
// Estado paga várias NFs em uma TED. Ex: R$259K = 2 meses × (R$51K + R$76K) SEDUC
// Algoritmo greedy: para cada TED livre, acumula NFs (ordenadas por data) até soma ≈ TED
console.log('  Passo 4 — Batch matching Estado TED → N NFs (≤8%, 365d)');

const nfsPendentes4 = db.prepare(`
  SELECT id, numero, tomador, valor_bruto, valor_liquido, data_emissao
  FROM notas_fiscais
  WHERE (status_conciliacao IS NULL OR status_conciliacao = 'PENDENTE')
    AND valor_bruto > 10
    AND data_emissao IS NOT NULL AND data_emissao != ''
  ORDER BY data_emissao ASC
`).all();

// Extratos Estado TED livres
const extEstadoLivres = extCredsRaw.filter(e =>
  !extUsados.has(e.id) &&
  e.credito > 5000 &&
  ((e.historico || '').toUpperCase().includes('01786029') ||
   (e.historico || '').toUpperCase().includes('070 0380') ||
   (e.historico || '').toUpperCase().includes('GOVERNO DO EST'))
).sort((a, b) => a.data_iso.localeCompare(b.data_iso));

// Grupos de tomadores para batch — Estado paga cada grupo separado
const BATCH_GRUPOS = [
  {
    label: 'SEDUC',
    filtroNF: t => semAcento(t).includes('SECRETARIA DA EDUCACAO') || semAcento(t).includes('SEDUC'),
  },
  {
    label: 'MP/TO',
    filtroNF: t => semAcento(t).includes('MINISTERIO PUBLICO') || t.includes('MP/TO'),
  },
  {
    label: 'SEINF',
    filtroNF: t => semAcento(t).includes('SECRETARIA DA INFRA'),
  },
];

let conc4 = 0;

for (const tedExt of extEstadoLivres) {
  if (extUsados.has(tedExt.id)) continue;
  const tedDate = new Date(tedExt.data_iso).getTime();
  const TARGET = tedExt.credito;
  const TOL_PCT = 0.08;

  for (const grp of BATCH_GRUPOS) {
    if (extUsados.has(tedExt.id)) break; // já usado por grupo anterior

    // NFs elegíveis: deste grupo, não usadas, emitidas até 30d APÓS o TED (tolerância), dentro de 365d
    const eligible = nfsPendentes4.filter(n =>
      !nfUsadas.has(n.id) &&
      !isContaminado(n.tomador) &&
      grp.filtroNF(n.tomador) &&
      new Date(n.data_emissao).getTime() <= tedDate + 30 * 86400000 &&
      new Date(n.data_emissao).getTime() >= tedDate - 365 * 86400000
    ).sort((a, b) => a.data_emissao.localeCompare(b.data_emissao)); // oldest first

    if (eligible.length === 0) continue;

    // Greedy: acumula até soma entrar na janela [TARGET*(1-TOL), TARGET*(1+TOL)]
    let soma = 0;
    const batch = [];
    let found = false;
    for (const nf of eligible) {
      const liq = nf.valor_liquido || nf.valor_bruto;
      soma += liq;
      batch.push(nf);
      const lo = TARGET * (1 - TOL_PCT);
      const hi = TARGET * (1 + TOL_PCT);
      if (soma >= lo && soma <= hi) { found = true; break; }
      if (soma > hi) break; // ultrapassou — não vai melhorar
    }

    if (found && batch.length >= 2) { // mínimo 2 NFs para ser um lote válido
      const diffPct = (Math.abs(soma - TARGET) / TARGET * 100).toFixed(2);
      console.log(`    🔀 BATCH ${grp.label} → TED ${tedExt.data_iso} R$${TARGET.toLocaleString('pt-BR',{minimumFractionDigits:2})} (${batch.length} NFs, soma=R$${soma.toLocaleString('pt-BR',{minimumFractionDigits:2})}, diff=${diffPct}%)`);
      for (const nf of batch) {
        marcaMatch(nf, tedExt);
        console.log(`      ✅ NF ${nf.id} ${nf.data_emissao} R$${(nf.valor_liquido||nf.valor_bruto).toLocaleString('pt-BR',{minimumFractionDigits:2})} ${(nf.tomador||'').slice(0,40)}`);
      }
      conc4 += batch.length;
      break; // TED usado — próxima TED
    }
  }
}

console.log(`  → Passo 4: ${conc4} NFs conciliadas (batch Estado)\n`);

// ── 6. RESUMO FINAL ────────────────────────────────────────────────
console.log('═'.repeat(60));
console.log(`  CONCILIADAS NESTE RUN: ${totalConc} NFs (contaminadas ignoradas: ${totalSkip})`);

if (!DRY_RUN) {
  const res = {
    conc: db.prepare("SELECT COUNT(*) n, COALESCE(SUM(valor_bruto),0) s FROM notas_fiscais WHERE status_conciliacao='CONCILIADO'").get(),
    pend: db.prepare("SELECT COUNT(*) n, COALESCE(SUM(valor_bruto),0) s FROM notas_fiscais WHERE status_conciliacao IS NULL OR status_conciliacao='PENDENTE'").get(),
    asse: db.prepare("SELECT COUNT(*) n FROM notas_fiscais WHERE status_conciliacao='ASSESSORIA'").get(),
    extC: db.prepare("SELECT COUNT(*) n, COALESCE(SUM(credito),0) s FROM extratos WHERE status_conciliacao='CONCILIADO' AND credito>0").get(),
    extL: db.prepare("SELECT COUNT(*) n, COALESCE(SUM(credito),0) s FROM (SELECT MIN(id) id, credito FROM extratos WHERE credito>100 AND (status_conciliacao IS NULL OR status_conciliacao='PENDENTE') GROUP BY data_iso,credito)").get(),
  };
  console.log(`\n  NFs CONCILIADAS:  ${res.conc.n.toString().padStart(5)} | R$ ${res.conc.s.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(18)}`);
  console.log(`  NFs PENDENTES:    ${res.pend.n.toString().padStart(5)} | R$ ${res.pend.s.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(18)}`);
  console.log(`  NFs ASSESSORIA:   ${res.asse.n.toString().padStart(5)}`);
  console.log(`  Extratos CONC.:   ${res.extC.n.toString().padStart(5)} | R$ ${res.extC.s.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(18)}`);
  console.log(`  Extratos LIVRES:  ${res.extL.n.toString().padStart(5)} | R$ ${res.extL.s.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(18)}`);

  console.log('\n  Conciliadas por tomador (top 15):');
  db.prepare("SELECT tomador, COUNT(*) n, SUM(valor_bruto) tot FROM notas_fiscais WHERE status_conciliacao='CONCILIADO' GROUP BY tomador ORDER BY tot DESC LIMIT 15").all()
    .forEach(r => console.log(`    ${(r.tomador||'').slice(0,50).padEnd(50)} n=${String(r.n).padStart(4)} | R$${r.tot.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(16)}`));

  console.log('\n  NFs pendentes por tomador (top 12):');
  db.prepare("SELECT tomador, COUNT(*) n, SUM(valor_bruto) tot FROM notas_fiscais WHERE status_conciliacao IS NULL OR status_conciliacao='PENDENTE' GROUP BY tomador ORDER BY tot DESC LIMIT 12").all()
    .forEach(r => console.log(`    ${(r.tomador||'').slice(0,50).padEnd(50)} n=${String(r.n).padStart(4)} | R$${r.tot.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(16)}`));

  console.log('\n  Extratos livres (top 10 por valor):');
  db.prepare("SELECT MIN(id) id, data_iso, credito, MIN(historico) h FROM extratos WHERE credito>500 AND (status_conciliacao IS NULL OR status_conciliacao='PENDENTE') GROUP BY data_iso,credito ORDER BY credito DESC LIMIT 10").all()
    .forEach(r => console.log(`    ${r.data_iso} R$${r.credito.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(14)}  ${(r.h||'').slice(0,55)}`));
} else {
  console.log(`\n⚠️  DRY RUN — banco não alterado.`);
}

db.close();
console.log('\n  ✅ Conciliação concluída!\n');
