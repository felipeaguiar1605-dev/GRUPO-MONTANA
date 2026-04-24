/**
 * Diagnóstico READ-ONLY das NFs contaminadas entre Assessoria e Segurança.
 *
 * Foco desta rodada: limpar a Assessoria (identificar NFs que estão em
 * data/assessoria/montana.db mas provavelmente são receita Segurança).
 *
 * Zero escrita: abre os DBs com readonly:true. Gera CSV + resumo no console.
 * Correção será feita em script separado, somente depois de revisar o CSV.
 *
 * Uso:
 *   node scripts/_diag_nfs_contaminadas.js
 *   node scripts/_diag_nfs_contaminadas.js --empresa=seguranca   (varredura reversa)
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const ALVO = (args.find(a => a.startsWith('--empresa=')) || '--empresa=assessoria').split('=')[1];
const OUTRA = ALVO === 'assessoria' ? 'seguranca' : 'assessoria';

const DB_ALVO = `data/${ALVO}/montana.db`;
const DB_OUTRA = `data/${OUTRA}/montana.db`;

for (const p of [DB_ALVO, DB_OUTRA]) {
  if (!fs.existsSync(p)) {
    console.error(`ERRO: banco não encontrado: ${p}`);
    process.exit(1);
  }
}

const dbAlvo = new Database(DB_ALVO, { readonly: true });
const dbOutra = new Database(DB_OUTRA, { readonly: true });

// Vigilância armada / serviço tipicamente da Segurança.
// Limpeza/copa/motorista / serviço tipicamente da Assessoria.
const REGEX_SEGURANCA = /\b(vigil[âa]nc|seguran[çc]a\s+patrimonial|patrulh|batalh|quart|penitenci|presid|ress?ocializ|agente\s+peniten|pol[ií]cia|\bpm[- ]|ssp\b|sejus|siopen|detran)\b/i;
const REGEX_ASSESSORIA = /\b(limpeza|conserva[çc][ãa]o|copeir|copa|motorist|transport(e)?|jardin|manuten[çc][ãa]o\s+predial|brigad(a|ista))\b/i;

// Contratos existentes em cada DB, por numContrato normalizado
function loadContratos(db) {
  try {
    const rows = db.prepare(`SELECT numContrato, contrato, orgao, status FROM contratos`).all();
    const map = new Map();
    for (const r of rows) {
      if (!r.numContrato) continue;
      map.set(String(r.numContrato).trim().toUpperCase(), r);
    }
    return map;
  } catch {
    return new Map();
  }
}

const contratosAlvo = loadContratos(dbAlvo);
const contratosOutra = loadContratos(dbOutra);

const nfsAlvo = dbAlvo.prepare(`
  SELECT id, numero, data_emissao, competencia, tomador, cnpj_tomador,
         contrato_ref, valor_bruto, valor_liquido, pis, cofins, inss, ir, csll, iss, retencao,
         status_conciliacao
  FROM notas_fiscais
  ORDER BY data_emissao, numero
`).all();

// Index de NFs da OUTRA empresa para detectar duplicatas cross-DB
const idxOutra = new Map();
try {
  const outras = dbOutra.prepare(`
    SELECT numero, competencia, cnpj_tomador, valor_bruto
    FROM notas_fiscais
  `).all();
  for (const n of outras) {
    const k = `${(n.numero||'').trim()}|${n.competencia||''}|${(n.cnpj_tomador||'').replace(/\D/g,'')}|${(n.valor_bruto||0).toFixed(2)}`;
    idxOutra.set(k, n);
  }
} catch {}

const classificadas = { regraA: [], regraB: [], regraC: [], limpa: [] };

for (const n of nfsAlvo) {
  const contratoRef = (n.contrato_ref || '').trim().toUpperCase();
  const tomador = n.tomador || '';
  const chaveDup = `${(n.numero||'').trim()}|${n.competencia||''}|${(n.cnpj_tomador||'').replace(/\D/g,'')}|${(n.valor_bruto||0).toFixed(2)}`;

  const regraA = contratoRef && contratosOutra.has(contratoRef) && !contratosAlvo.has(contratoRef);
  const regraB = idxOutra.has(chaveDup);
  const hitSeg = REGEX_SEGURANCA.test(tomador);
  const hitAss = REGEX_ASSESSORIA.test(tomador);
  const regraC = ALVO === 'assessoria'
    ? (hitSeg && !hitAss)
    : (hitAss && !hitSeg);

  const motivos = [];
  if (regraA) motivos.push(`A:contrato_ref existe em ${OUTRA}`);
  if (regraB) motivos.push('B:duplicata cross-DB');
  if (regraC) motivos.push(`C:tomador bate regex ${OUTRA}`);

  if (motivos.length === 0) {
    classificadas.limpa.push(n);
    continue;
  }

  const registro = { ...n, motivos: motivos.join(' | ') };
  if (regraA) classificadas.regraA.push(registro);
  else if (regraB) classificadas.regraB.push(registro);
  else classificadas.regraC.push(registro);
}

// ---------- Resumo por regra ----------
console.log(`\n=== DIAGNÓSTICO NFs CONTAMINADAS — alvo: ${ALVO.toUpperCase()} ===\n`);
console.log(`Total de NFs em ${ALVO}: ${nfsAlvo.length}`);
console.log(`  Regra A (contrato_ref pertence a ${OUTRA}): ${classificadas.regraA.length}`);
console.log(`  Regra B (duplicata cross-DB ${OUTRA}):     ${classificadas.regraB.length}`);
console.log(`  Regra C (tomador típico de ${OUTRA}):      ${classificadas.regraC.length}`);
console.log(`  Sem sinal de contaminação:                 ${classificadas.limpa.length}`);

const suspeitas = [...classificadas.regraA, ...classificadas.regraB, ...classificadas.regraC];
console.log(`\nTotal de suspeitas: ${suspeitas.length}`);

// ---------- Impacto PIS/COFINS por competência ----------
const porComp = new Map();
for (const s of suspeitas) {
  const c = s.competencia || '(sem competência)';
  const prev = porComp.get(c) || { qtd: 0, bruto: 0, pis: 0, cofins: 0, retencao: 0 };
  prev.qtd += 1;
  prev.bruto += s.valor_bruto || 0;
  prev.pis += s.pis || 0;
  prev.cofins += s.cofins || 0;
  prev.retencao += s.retencao || 0;
  porComp.set(c, prev);
}

const comps = [...porComp.entries()].sort((a,b) => a[0].localeCompare(b[0]));
if (comps.length) {
  console.log(`\n--- Impacto na apuração (suspeitas por competência) ---`);
  console.log('competencia | qtd | valor_bruto | pis | cofins | retencao');
  for (const [c, v] of comps) {
    console.log(`${c} | ${v.qtd} | ${v.bruto.toFixed(2)} | ${v.pis.toFixed(2)} | ${v.cofins.toFixed(2)} | ${v.retencao.toFixed(2)}`);
  }
}

// ---------- CSV ----------
const outDir = path.join(__dirname, '_out');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
const csvPath = path.join(outDir, `nfs_contaminadas_${ALVO}_${stamp}.csv`);

const header = [
  'id','numero','data_emissao','competencia','tomador','cnpj_tomador','contrato_ref',
  'valor_bruto','valor_liquido','pis','cofins','inss','ir','csll','iss','retencao',
  'status_conciliacao','motivos'
];
function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}

const lines = [header.join(';')];
for (const s of suspeitas) {
  lines.push(header.map(h => csvEscape(s[h])).join(';'));
}
fs.writeFileSync(csvPath, lines.join('\n'), 'utf8');

console.log(`\nCSV salvo em: ${csvPath}`);
console.log(`\nPróximo passo: abrir o CSV, validar amostra humana (30-50 linhas),`);
console.log(`revisar os casos da Regra C (mais falsos-positivos esperados) e só`);
console.log(`então construir o script de correção com --apply.\n`);

dbAlvo.close();
dbOutra.close();
