'use strict';
/**
 * Backfill INSS Retido — Montana Segurança
 *
 * DIAGNÓSTICO: 90% das NFs da Segurança têm inss=0 porque o WebISS exporta
 * apenas o `retencao` total (sem detalhamento por tributo). As NFs de cessão
 * de mão de obra (vigilância/segurança) SÃO sujeitas à retenção de 11% pelo
 * tomador (art. 31 Lei 8.212/91), mas o campo `inss` ficou zerado.
 *
 * Este script (PostgreSQL via db_pg):
 *   1. Exibe diagnóstico das NFs com inss=0
 *   2. Em modo --apply: preenche inss = valor_bruto × 11% onde inss = 0
 *
 * Uso:
 *   node scripts/backfill_inss_seguranca.js                           # diagnóstico geral
 *   node scripts/backfill_inss_seguranca.js --competencia=2026-03     # filtra competência
 *   node scripts/backfill_inss_seguranca.js --apply                   # aplica todas
 *   node scripts/backfill_inss_seguranca.js --competencia=2026-03 --apply
 *   node scripts/backfill_inss_seguranca.js --ano=2026 --apply
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const ARG      = process.argv.slice(2);
const APLICAR  = ARG.includes('--apply');
const arg      = (k, def = '') => (ARG.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || def;
const COMP     = arg('competencia', '');
const ANO_FILT = arg('ano', '');
const ALIQ     = parseFloat(arg('aliq', '11')) / 100;   // default 11%

const MESES_ABREV = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];

function normalizeComp(comp) {
  comp = (comp || '').trim().toLowerCase();
  if (/^\d{4}-\d{2}$/.test(comp)) {
    const [ano, mes] = comp.split('-').map(Number);
    return [`${comp}`, `${MESES_ABREV[mes-1]}/${String(ano).slice(2)}`];
  }
  const m = comp.match(/^([a-z]{3})\/(\d{2,4})$/);
  if (m) {
    const mesIdx = MESES_ABREV.indexOf(m[1]);
    const mes = mesIdx + 1;
    const ano = m[2].length === 2 ? 2000 + parseInt(m[2]) : parseInt(m[2]);
    return [`${ano}-${String(mes).padStart(2,'0')}`, comp];
  }
  return null;
}

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function main() {
  console.log('\n💰 Backfill INSS Retido — Montana Segurança (PostgreSQL)');
  console.log(`   Alíquota: ${(ALIQ * 100).toFixed(0)}%  |  ${APLICAR ? '🔥 APLICAR' : '🧪 DRY-RUN'}`);
  if (COMP)     console.log(`   Filtro competência: ${COMP}`);
  if (ANO_FILT) console.log(`   Filtro ano: ${ANO_FILT}`);
  console.log();

  const db = getDb('seguranca');

  // ── 1. Diagnóstico geral por competência ────────────────────────────────────
  const resumo = await db.prepare(`
    SELECT
      competencia,
      COUNT(*)                                                           AS total,
      COUNT(*) FILTER (WHERE inss = 0 OR inss IS NULL)                  AS sem_inss,
      ROUND(SUM(valor_bruto)::numeric, 2)                               AS total_bruto,
      ROUND(SUM(COALESCE(inss,0))::numeric, 2)                         AS total_inss,
      ROUND((SUM(valor_bruto) * $1)::numeric, 2)                       AS esperado_inss
    FROM notas_fiscais
    WHERE valor_bruto > 0
    GROUP BY competencia
    ORDER BY competencia DESC
    LIMIT 24
  `).all(ALIQ);

  const resumoArr = Array.isArray(resumo) ? resumo : [];
  console.log('📊 Estado atual por competência (Segurança):');
  console.log('  COMP.       │  NFs  │ sem_inss     │ BRUTO             │ INSS atual        │ Esperado (11%)     │ GAP');
  console.log('  ' + '─'.repeat(125));
  let totalGapAll = 0;
  for (const r of resumoArr) {
    const gap = (r.esperado_inss || 0) - (r.total_inss || 0);
    totalGapAll += gap;
    const pctSem = r.total > 0 ? Math.round((r.sem_inss / r.total) * 100) : 0;
    const flag = gap > 1000 ? '⚠️ ' : '   ';
    console.log(`  ${flag}${(r.competencia||'—').padEnd(9)} │ ${String(r.total).padStart(5)} │ ${String(r.sem_inss).padStart(5)} (${String(pctSem).padStart(2)}%) │ R$ ${brl(r.total_bruto).padStart(14)} │ R$ ${brl(r.total_inss).padStart(14)} │ R$ ${brl(r.esperado_inss).padStart(15)} │ R$ ${brl(gap)}`);
  }
  console.log(`\n  GAP total (todas competências): R$ ${brl(totalGapAll)}\n`);

  // ── 2. Monta filtro para NFs a corrigir ─────────────────────────────────────
  let whereExtra = '';
  const qParams = [];   // params para a query de seleção

  if (COMP) {
    const nc = normalizeComp(COMP);
    if (!nc) { console.error(`❌ Formato inválido: ${COMP}. Use 2026-03 ou mar/26`); process.exit(1); }
    whereExtra += ` AND (competencia = $1 OR competencia = $2)`;
    qParams.push(nc[0], nc[1]);
  } else if (ANO_FILT) {
    const yy = ANO_FILT.slice(-2);
    whereExtra += ` AND (competencia LIKE $1 OR competencia LIKE $2)`;
    qParams.push(`%/${yy}`, `%/${ANO_FILT}`);
  }

  // Substitui $1/$2 por $N corretos considerando a posição (qParams já começa em 1)
  // (já estão corretos pois qParams é independente do ALIQ param acima)

  const sqlSel = `
    SELECT id, numero, competencia, tomador, valor_bruto, inss, retencao, valor_liquido
    FROM notas_fiscais
    WHERE (inss = 0 OR inss IS NULL)
      AND valor_bruto > 0
      ${whereExtra}
    ORDER BY competencia DESC, valor_bruto DESC
  `;

  const nfsSemInss = await db.prepare(sqlSel).all(...qParams);
  const nfs = Array.isArray(nfsSemInss) ? nfsSemInss : [];

  if (nfs.length === 0) {
    console.log('✅ Nenhuma NF com inss=0 encontrada para o filtro informado.');
    process.exit(0);
  }

  const totalBruto   = nfs.reduce((s, n) => s + (n.valor_bruto || 0), 0);
  const totalCalc    = nfs.reduce((s, n) => s + Math.round((n.valor_bruto || 0) * ALIQ * 100) / 100, 0);

  console.log(`📋 NFs com inss=0 a corrigir: ${nfs.length}`);
  console.log(`   Total bruto: R$ ${brl(totalBruto)}`);
  console.log(`   INSS a imputar (${(ALIQ*100).toFixed(0)}%): R$ ${brl(totalCalc)}\n`);

  console.log('  Amostra (até 20 maiores):');
  for (const n of nfs.slice(0, 20)) {
    const inssCalc = Math.round((n.valor_bruto || 0) * ALIQ * 100) / 100;
    console.log(`    NF ${(n.numero||'—').padStart(6)}  ${(n.competencia||'—').padEnd(9)}  ${(n.tomador||'—').slice(0,38).padEnd(38)}  bruto R$ ${brl(n.valor_bruto).padStart(14)}  → INSS R$ ${brl(inssCalc)}`);
  }
  if (nfs.length > 20) console.log(`    … e mais ${nfs.length - 20} NFs`);

  if (!APLICAR) {
    console.log('\n🧪 DRY-RUN — nenhum dado alterado.');
    console.log('   Para aplicar: adicione --apply à linha de comando');
    console.log();
    process.exit(0);
  }

  // ── 3. Aplica UPDATE ─────────────────────────────────────────────────────────
  console.log('\n🔧 Aplicando atualizações...');

  let ok = 0, erros = 0;
  for (const nf of nfs) {
    try {
      const inssCalc = Math.round((nf.valor_bruto || 0) * ALIQ * 100) / 100;
      await db.prepare(`
        UPDATE notas_fiscais
        SET inss = $1, updated_at = NOW()
        WHERE id = $2
      `).run(inssCalc, nf.id);
      ok++;
    } catch (e) {
      erros++;
      console.error(`  ❌ NF id=${nf.id} numero=${nf.numero}: ${e.message}`);
    }
  }

  console.log(`\n✅ ${ok} NFs atualizadas com inss = valor_bruto × ${(ALIQ*100).toFixed(0)}%`);
  if (erros > 0) console.log(`   ❌ ${erros} erros`);

  // ── 4. Verificação pós-aplicação ─────────────────────────────────────────────
  // Usa parâmetro posicional separado: ALIQ vem primeiro, depois filtros de competência
  const aliqN = 1;
  let wherePosExtra = '';
  const paramsPos = [ALIQ];
  if (COMP) {
    const nc2 = normalizeComp(COMP);
    wherePosExtra = ` AND (competencia = $2 OR competencia = $3)`;
    paramsPos.push(nc2[0], nc2[1]);
  } else if (ANO_FILT) {
    const yy = ANO_FILT.slice(-2);
    wherePosExtra = ` AND (competencia LIKE $2 OR competencia LIKE $3)`;
    paramsPos.push(`%/${yy}`, `%/${ANO_FILT}`);
  }

  const pos = await db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE inss = 0 OR inss IS NULL) AS restante_sem_inss,
      ROUND(SUM(COALESCE(inss,0))::numeric, 2)         AS total_inss_agora,
      ROUND((SUM(valor_bruto) * $${aliqN})::numeric, 2) AS esperado
    FROM notas_fiscais
    WHERE valor_bruto > 0 ${wherePosExtra}
  `).get(...paramsPos);

  console.log(`\n📊 Verificação pós-aplicação:`);
  console.log(`   INSS total registrado: R$ ${brl(pos?.total_inss_agora)}`);
  console.log(`   INSS esperado (11%):   R$ ${brl(pos?.esperado)}`);
  console.log(`   NFs ainda com inss=0:  ${pos?.restante_sem_inss || 0}`);
  console.log('\n✔️  Concluído.\n');

  process.exit(0);
}

main().catch(e => {
  console.error('❌ Erro fatal:', e.message);
  process.exit(1);
});
