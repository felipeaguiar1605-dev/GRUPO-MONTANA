/**
 * Conciliação Financeira — Montana Segurança Patrimonial Ltda
 * Estratégia: matching INDIVIDUAL NF→Extrato por valor_liquido ≈ extrato.credito
 *
 * Particularidades da Segurança:
 * - Palmas paga por Ordem Bancária individual (1 extrato ≈ 1 NF)
 * - Estado (SEDUC) paga via TED (1 extrato ≈ 1 ou mais NFs)
 * - UFT paga via Pix parcelado (1 extrato ≈ 1 posto)
 * - O banco importou 2 CSVs (pipe e sem-pipe) — deduplicamos por (data_iso, credito)
 * - 569 NFs contaminadas de clientes da Assessoria presentes no banco (excluídas)
 *
 * Uso:
 *   node scripts/conciliacao_seguranca.js          (executa)
 *   node scripts/conciliacao_seguranca.js --dry-run (analisa, não salva)
 */

const path = require('path');
const Database = require('better-sqlite3');

const DRY_RUN = process.argv.includes('--dry-run');
const db = new Database(path.join(__dirname, '../data/seguranca/montana.db'));

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
const norm = [
  ['MUNICÍPIO DE PALMAS',                                     'MUNICIPIO DE PALMAS'],
  ['UNIVERSIDADE ESTADUAL DO TOCANTINS - UNITINS.',           'UNIVERSIDADE ESTADUAL DO TOCANTINS - UNITINS'],
  ['DEPARTAMENTO ESTADUAL DE TRANSITO - DETRAN - TO',         'DEPARTAMENTO ESTADUAL DE TRANSITO'],
  ['DEPARTAMENTO ESTADUAL DE TRANSITO - DETRAN/TO',           'DEPARTAMENTO ESTADUAL DE TRANSITO'],
  ['TOCANTINS PROCURADORIA GERAL DA JUSTICA',                 'MINISTERIO PUBLICO DO ESTADO DO TOCANTINS - MP/TO'],
];
for (const [de, para] of norm) {
  const c = db.prepare('SELECT COUNT(*) c FROM notas_fiscais WHERE tomador=?').get(de).c;
  if (c === 0) { console.log(`  ⏭️  Sem ocorrências: ${de.slice(0, 55)}`); continue; }
  if (!DRY_RUN) db.prepare('UPDATE notas_fiscais SET tomador=? WHERE tomador=?').run(para, de);
  console.log(`  ✅ ${c}x "${de.slice(0, 45)}" → "${para.slice(0, 45)}"`);
}

// ── 3. TOMADORES CONTAMINADOS (clientes da Assessoria no banco Segurança) ─
// Esses tomadores pertencem a contratos da Montana Assessoria, não Segurança.
// Foram importados erroneamente via WebISS (NFS-e Palmas/TO em conta conjunta).
// São EXCLUÍDOS da conciliação mas NÃO apagados do banco.
const CONTAMINADOS_PREFIXOS = [
  'UNIVERSIDADE ESTADUAL DO TOCANTINS', // UNITINS — contrato Assessoria
  'DEPARTAMENTO ESTADUAL DE TRANSITO',  // DETRAN — contrato Assessoria
  'TRIBUNAL DE CONTAS',                 // TCE — contrato Assessoria
  'CORPO DE BOMBEIROS',                 // CBMTO — contrato Assessoria
  'FUNDO ESPECIAL DE MODERNIZACAO',     // FUNJURIS/TJ — contrato Assessoria
  'PODER JUDICIARIO',
];
const isContaminado = t => CONTAMINADOS_PREFIXOS.some(p => (t || '').toUpperCase().includes(p));

const contaminadasCount = db.prepare("SELECT COUNT(*) n FROM notas_fiscais WHERE status_conciliacao IS NULL OR status_conciliacao='PENDENTE'").get().n;
console.log('\n  (NFs contaminadas serão ignoradas na conciliação — ver relatório final)\n');

// ── 4. CARREGAR DADOS ──────────────────────────────────────────────
console.log('3. CONCILIAÇÃO INDIVIDUAL NF → EXTRATO\n' + '─'.repeat(50));

// NFs pendentes após corrigir data_emissao (recarregar)
const todasNFs = db.prepare(`
  SELECT id, numero, tomador, valor_bruto, valor_liquido, data_emissao
  FROM notas_fiscais
  WHERE (status_conciliacao IS NULL OR status_conciliacao = 'PENDENTE')
    AND valor_bruto > 10
    AND data_emissao IS NOT NULL AND data_emissao != ''
  ORDER BY data_emissao ASC
`).all();

// Extratos de receita — DEDUPLICA por (data_iso, credito) mantendo o menor id
// Razão: banco importou 2 CSVs (uma conta com pipe, outra sem) com os mesmos lançamentos
const extCredsRaw = db.prepare(`
  SELECT MIN(id) id, data_iso, credito, MIN(historico) historico, status_conciliacao
  FROM extratos
  WHERE credito > 100
    AND data_iso IS NOT NULL
    AND (status_conciliacao IS NULL
         OR status_conciliacao NOT IN ('INTERNO','INVESTIMENTO','TRANSFERENCIA'))
  GROUP BY data_iso, credito
  ORDER BY data_iso ASC
`).all();

// IDs originais de cada grupo de duplicata — para atualizar TODOS ao conciliar
const extIdsPorDedupKey = {};
const extRawAll = db.prepare(`
  SELECT id, data_iso, credito, status_conciliacao
  FROM extratos
  WHERE credito > 100
    AND data_iso IS NOT NULL
    AND (status_conciliacao IS NULL
         OR status_conciliacao NOT IN ('INTERNO','INVESTIMENTO','TRANSFERENCIA'))
`).all();
for (const e of extRawAll) {
  const key = `${e.data_iso}|${e.credito}`;
  if (!extIdsPorDedupKey[key]) extIdsPorDedupKey[key] = [];
  extIdsPorDedupKey[key].push(e.id);
}

console.log(`  NFs pendentes: ${todasNFs.length} | Legítimas: ${todasNFs.filter(n => !isContaminado(n.tomador)).length} | Contaminadas: ${todasNFs.filter(n => isContaminado(n.tomador)).length}`);
console.log(`  Extratos (deduplicados): ${extCredsRaw.length}\n`);

const updNF  = db.prepare("UPDATE notas_fiscais SET status_conciliacao='CONCILIADO' WHERE id=?");
const updExt = db.prepare("UPDATE extratos SET status_conciliacao='CONCILIADO' WHERE id=?");

const extUsados = new Set(); // IDs dos extratos já usados (pós-dedup)
const nfUsadas  = new Set(); // IDs das NFs já conciliadas (evita match duplo entre passos)
let totalConc = 0;
let totalSkip = 0;

// ── 5. PASSO 1: Matching individual exato (tolerância 0.5%) ───────
// Alta confiança: valores muito próximos → correspondência direta
console.log('  Passo 1 — Matching individual exato (≤0.5%)');
let conc1 = 0;

for (const nf of todasNFs) {
  if (isContaminado(nf.tomador)) { totalSkip++; continue; }
  if (nfUsadas.has(nf.id)) continue;

  const liq = nf.valor_liquido || nf.valor_bruto;
  const nfDate = new Date(nf.data_emissao).getTime();
  const tol05 = Math.max(liq * 0.005, 5);

  let best = null, bestDiff = Infinity;
  for (const ext of extCredsRaw) {
    if (extUsados.has(ext.id)) continue;
    const diff = Math.abs(ext.credito - liq);
    if (diff > tol05) continue;
    const extDate = new Date(ext.data_iso).getTime();
    if (extDate < nfDate - 30 * 86400000) continue;  // até 30 dias antes
    if (extDate > nfDate + 90 * 86400000) continue;  // até 90 dias depois
    if (diff < bestDiff) { best = ext; bestDiff = diff; }
  }

  if (best) {
    const key = `${best.data_iso}|${best.credito}`;
    extUsados.add(best.id);
    nfUsadas.add(nf.id);
    if (!DRY_RUN) {
      updNF.run(nf.id);
      for (const eid of (extIdsPorDedupKey[key] || [best.id])) updExt.run(eid);
    }
    conc1++;
    totalConc++;
    const pct = (bestDiff / liq * 100).toFixed(2);
    console.log(`    ✅ NF ${String(nf.id).padStart(5)} ${nf.data_emissao} ${(nf.tomador || '').slice(0, 32).padEnd(32)} liq=${liq.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(13)}  ext=${best.data_iso} R$${best.credito.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(13)}  diff=${pct}%`);
  }
}
console.log(`  → Passo 1: ${conc1} NFs conciliadas\n`);

// ── 6. PASSO 2: Matching individual ampliado (tolerância 5%) ──────
// Captura NFs com pequenas variações (descontos ISS, ajustes de retenção)
console.log('  Passo 2 — Matching individual ampliado (≤5%)');
let conc2 = 0;

for (const nf of todasNFs) {
  if (isContaminado(nf.tomador)) continue;
  if (nfUsadas.has(nf.id)) continue;

  const liq = nf.valor_liquido || nf.valor_bruto;
  const nfDate = new Date(nf.data_emissao).getTime();
  const tol5 = Math.max(liq * 0.05, 20);

  let best = null, bestDiff = Infinity;
  for (const ext of extCredsRaw) {
    if (extUsados.has(ext.id)) continue;
    const diff = Math.abs(ext.credito - liq);
    if (diff > tol5) continue;
    const extDate = new Date(ext.data_iso).getTime();
    if (extDate < nfDate - 30 * 86400000) continue;
    if (extDate > nfDate + 90 * 86400000) continue;
    if (diff < bestDiff) { best = ext; bestDiff = diff; }
  }

  if (best) {
    const key = `${best.data_iso}|${best.credito}`;
    extUsados.add(best.id);
    nfUsadas.add(nf.id);
    if (!DRY_RUN) {
      updNF.run(nf.id);
      for (const eid of (extIdsPorDedupKey[key] || [best.id])) updExt.run(eid);
    }
    conc2++;
    totalConc++;
    const pct = (Math.abs(best.credito - liq) / liq * 100).toFixed(2);
    console.log(`    ✅ NF ${String(nf.id).padStart(5)} ${nf.data_emissao} ${(nf.tomador || '').slice(0, 32).padEnd(32)} liq=${liq.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(13)}  ext=${best.data_iso} R$${best.credito.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(13)}  diff=${pct}%`);
  }
}
console.log(`  → Passo 2: ${conc2} NFs conciliadas\n`);

// ── 7. PASSO 3: Extratos restantes por grupo × mês ────────────────
// Para extratos que não casaram individualmente com nenhuma NF,
// tentamos match de LOTE: soma de NFs do grupo no mês ≈ soma de extratos do grupo no mês
console.log('  Passo 3 — Matching por lote (grupo × mês)');

const GRUPOS = [
  {
    key: 'ESTADO_SEDUC',
    label: 'Estado — SEDUC',
    filtroExt: e => {
      const h = (e.historico || '').toUpperCase();
      return h.includes('070 0380') || h.includes('01786029') ||
             h.includes('GOVERNO DO EST') || h.includes('ESTADO DO TOCANTINS');
    },
    filtroNF: t => {
      const u = t.toUpperCase();
      return u.includes('SEDUC') || u.includes('SECRETARIA DA EDUCACAO') ||
             u.includes('SECRETARIA MUNICIPAL DE EDUC');
    },
  },
  {
    key: 'MUNICIPIO_PALMAS',
    label: 'Município de Palmas',
    filtroExt: e => {
      const h = (e.historico || '').toUpperCase();
      return h.includes('MUNICIPIO DE PALMAS') || h.includes('ORDENS BANCARIAS') ||
             (h.includes('ORDEM BANC') && (h.includes('PALMAS') || h.includes('ORDENS')));
    },
    filtroNF: t => {
      const u = t.toUpperCase();
      return u.includes('MUNICIPIO DE PALMAS') || u.includes('PALMAS') ||
             u.includes('FCP') || u.includes('FUNDACAO CULTURAL') ||
             u.includes('ATCP') || u.includes('AGENCIA DE TRANSPORTE') ||
             u.includes('ARCES') || u.includes('PREVI') ||
             u.includes('FUNDACAO MUNICIPAL') || u.includes('MEIO AMBIENTE') ||
             u.includes('REGULACAO') || u.includes('TECNOLOGIA DA INFORMACAO') ||
             u.includes('TURISMO') || u.includes('ASSISTENCIA SOCIAL') ||
             u.includes('PREVIDENCIA SOCIAL DO MUNI');
    },
  },
  {
    key: 'UFT',
    label: 'UFT — Univ. Federal do Tocantins',
    filtroExt: e => {
      const h = (e.historico || '').toUpperCase();
      return h.includes('05149726') || h.includes('FUNDACAO UNIVER') ||
             h.includes('SEC TES NAC');
    },
    filtroNF: t => {
      const u = t.toUpperCase();
      return u.includes('FUNDACAO UNIVERSIDADE FEDERAL') || u.includes('UFT');
    },
  },
];

// Para o passo 3, recarregamos NFs ainda pendentes
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
  const nfsGrupo = nfsPendentes3.filter(n => !isContaminado(n.tomador) && grupo.filtroNF(n.tomador));
  if (nfsGrupo.length === 0) continue;

  const extGrupo = extCredsRaw.filter(e => !extUsados.has(e.id) && grupo.filtroExt(e));
  if (extGrupo.length === 0) {
    console.log(`    ⏭️  ${grupo.key}: extratos esgotados`);
    continue;
  }

  // Agrupar NFs por mês
  const nfPorMes = {};
  for (const nf of nfsGrupo) {
    const mes = nf.data_emissao.slice(0, 7);
    if (!nfPorMes[mes]) nfPorMes[mes] = [];
    nfPorMes[mes].push(nf);
  }

  let concGrupo = 0;
  for (const [mes, nfsMes] of Object.entries(nfPorMes).sort()) {
    const somaLiq = nfsMes.reduce((s, n) => s + (n.valor_liquido || n.valor_bruto), 0);
    const mesStart = new Date(mes + '-01').getTime();
    const mesEnd   = mesStart + (90 * 24 * 60 * 60 * 1000);

    // Acumular todos os extratos do grupo dentro da janela temporal
    const extJanela = extGrupo.filter(e => {
      if (extUsados.has(e.id)) return false;
      const t = new Date(e.data_iso).getTime();
      return t >= mesStart - (15 * 86400000) && t <= mesEnd;
    });
    if (extJanela.length === 0) continue;

    const somaExt = extJanela.reduce((s, e) => s + e.credito, 0);
    const tol = Math.max(somaLiq * 0.15, 500); // 15% tolerância no lote
    const diff = Math.abs(somaExt - somaLiq);

    if (diff <= tol) {
      for (const ext of extJanela) {
        const key = `${ext.data_iso}|${ext.credito}`;
        extUsados.add(ext.id);
        if (!DRY_RUN) for (const eid of (extIdsPorDedupKey[key] || [ext.id])) updExt.run(eid);
      }
      if (!DRY_RUN) for (const nf of nfsMes) updNF.run(nf.id);
      concGrupo += nfsMes.length;
      conc3 += nfsMes.length;
      totalConc += nfsMes.length;
      const pct = (diff / somaLiq * 100).toFixed(1);
      console.log(`    ✅ ${grupo.key.padEnd(18)} ${mes}  ${String(nfsMes.length).padStart(3)} NFs  liq=R$${somaLiq.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(14)}  exts=${extJanela.length} R$${somaExt.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(14)}  diff=${pct}%`);
    } else {
      const pct = (diff / somaLiq * 100).toFixed(1);
      console.log(`    ❌ ${grupo.key.padEnd(18)} ${mes}  ${String(nfsMes.length).padStart(3)} NFs  liq=R$${somaLiq.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(14)}  exts=${extJanela.length} R$${somaExt.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(14)}  diff=${pct}% (sem match)`);
    }
  }
  if (concGrupo > 0) console.log(`     → ${grupo.label}: ${concGrupo} NFs conciliadas\n`);
}
console.log(`  → Passo 3: ${conc3} NFs conciliadas\n`);

// ── 8. RESUMO FINAL ────────────────────────────────────────────────
console.log('═'.repeat(60));
console.log(`  TOTAL CONCILIADAS AGORA: ${totalConc} NFs (contaminadas ignoradas: ${totalSkip})`);

if (!DRY_RUN) {
  const res = {
    conc:  db.prepare("SELECT COUNT(*) n, COALESCE(SUM(valor_bruto),0) s FROM notas_fiscais WHERE status_conciliacao='CONCILIADO'").get(),
    pend:  db.prepare("SELECT COUNT(*) n FROM notas_fiscais WHERE status_conciliacao IS NULL OR status_conciliacao='PENDENTE'").get(),
    extC:  db.prepare("SELECT COUNT(*) n, COALESCE(SUM(credito),0) s FROM extratos WHERE status_conciliacao='CONCILIADO' AND credito>0").get(),
  };
  console.log(`  NFs conciliadas total: ${res.conc.n} | R$ ${res.conc.s.toLocaleString('pt-BR', {minimumFractionDigits:2})}`);
  console.log(`  NFs pendentes:         ${res.pend.n}`);
  console.log(`  Extratos conciliados:  ${res.extC.n} | R$ ${res.extC.s.toLocaleString('pt-BR', {minimumFractionDigits:2})}`);

  console.log('\n  Conciliadas por tomador (top 12):');
  db.prepare("SELECT tomador, COUNT(*) n, SUM(valor_bruto) tot FROM notas_fiscais WHERE status_conciliacao='CONCILIADO' GROUP BY tomador ORDER BY tot DESC LIMIT 12").all()
    .forEach(r => console.log(`    ${(r.tomador||'').slice(0, 50).padEnd(50)} n=${String(r.n).padStart(4)} | R$${r.tot.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(16)}`));

  console.log('\n  NFs pendentes por tomador (top 10):');
  db.prepare("SELECT tomador, COUNT(*) n, SUM(valor_bruto) tot FROM notas_fiscais WHERE status_conciliacao IS NULL OR status_conciliacao='PENDENTE' GROUP BY tomador ORDER BY tot DESC LIMIT 10").all()
    .forEach(r => console.log(`    ${(r.tomador||'').slice(0, 50).padEnd(50)} n=${String(r.n).padStart(4)} | R$${r.tot.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(16)}`));

  console.log('\n  Extratos sem NF conciliada (fonte):');
  const extSemNF = db.prepare("SELECT substr(historico,1,50) h, COUNT(*) n, SUM(credito) s FROM extratos WHERE status_conciliacao='CONCILIADO' AND credito>100 AND historico NOT LIKE '%|%' GROUP BY h ORDER BY s DESC LIMIT 10").all();
  // Contar quantos foram usados vs total conciliados
  const totalExtConc = db.prepare("SELECT COUNT(*) n FROM extratos WHERE status_conciliacao='CONCILIADO' AND credito>100 AND historico NOT LIKE '%|%'").get().n;
  console.log(`    Total extratos CONCILIADO (não-dup): ${totalExtConc}`);
} else {
  console.log(`\n⚠️  DRY RUN — banco não alterado. ${totalConc} NFs seriam conciliadas.`);

  // Mostrar extratos ainda livres
  const livres = extCredsRaw.filter(e => !extUsados.has(e.id));
  if (livres.length > 0) {
    console.log(`\n  Extratos não utilizados: ${livres.length}`);
    livres.slice(0, 15).forEach(e => console.log(`    ${e.data_iso} ${(e.status_conciliacao||'null').padEnd(12)} R$${e.credito.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(14)} ${(e.historico||'').replace('|','').trim().slice(0,50)}`));
  }
}

db.close();
