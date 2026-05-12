'use strict';
/**
 * Pós-Deploy — Montana ERP — Maio 2026
 *
 * Executa em sequência todas as operações de manutenção pendentes
 * após o deploy de 05/05/2026.
 *
 * ⚠️  Rodar APENAS UMA VEZ após o deploy.
 * ⚠️  Faz --dry-run por padrão. Use --apply para gravar.
 *
 * Uso:
 *   node scripts/pos_deploy_2026_05.js              # mostra o que será feito
 *   node scripts/pos_deploy_2026_05.js --apply       # executa tudo
 *   node scripts/pos_deploy_2026_05.js --apply --pular=3,4  # pula etapas específicas
 *
 * Servidor:
 *   cd /opt/montana/app_unificado
 *   node scripts/pos_deploy_2026_05.js --apply
 */

const path   = require('path');
const { execSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const ARG    = process.argv.slice(2);
const APPLY  = ARG.includes('--apply');
const arg    = (k, def='') => (ARG.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || def;
const PULAR  = (arg('pular','') || '').split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

const brl = (v) => Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});

function header(n, titulo) {
  const skip = PULAR.includes(n) ? ' [PULANDO]' : '';
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  Etapa ${n}: ${titulo}${skip}`);
  console.log('═'.repeat(70));
  return !PULAR.includes(n);
}

// ── Etapa 1: Corrigir datas invertidas — Contrato id=17 (Segurança) ──────────
async function etapa1() {
  if (!header(1, 'Fix Contrato id=17 — datas vigência invertidas (Segurança)')) return;
  const db = getDb('seguranca');
  const c = await db.prepare('SELECT id, vigencia_inicio, vigencia_fim FROM contratos WHERE id = 17').get();
  if (!c) { console.log('  ⚠️  Contrato id=17 não encontrado — pulando.'); return; }

  // Verifica se as datas estão realmente invertidas (início > fim)
  if (c.vigencia_inicio <= c.vigencia_fim) {
    console.log(`  ✅ Datas já corretas: inicio=${c.vigencia_inicio} fim=${c.vigencia_fim}`);
    return;
  }

  console.log(`  Atual:    inicio=${c.vigencia_inicio}  fim=${c.vigencia_fim}  ← INVERTIDO`);
  console.log(`  Corrigir: inicio=${c.vigencia_fim}  fim=${c.vigencia_inicio}`);

  if (!APPLY) { console.log('  🧪 DRY-RUN'); return; }
  await db.prepare('UPDATE contratos SET vigencia_inicio=$1, vigencia_fim=$2, updated_at=NOW() WHERE id=17')
    .run(c.vigencia_fim, c.vigencia_inicio);
  console.log('  ✅ Datas corrigidas.');
}

// ── Etapa 2: Normalizar categorias de despesas (todas as empresas) ────────────
async function etapa2() {
  if (!header(2, 'Normalizar categorias de despesas (FOLHA PGTO→FOLHA, OUTRAS→OUTROS…)')) return;

  const MAPA = [
    { de: ['FOLHA PGTO', 'FOLHA DE PAGAMENTO', 'FOLHA PAGAMENTO'], para: 'FOLHA' },
    { de: ['OUTRAS'],                                                para: 'OUTROS' },
    { de: ['IMPOSTO', 'IMPOSTOS', 'TRIBUTOS'],                      para: 'TRIBUTO' },
  ];
  const EMPRESAS = ['assessoria', 'seguranca', 'portodovau', 'mustang'];

  for (const empresa of EMPRESAS) {
    let totalEmpresa = 0;
    try {
      const db = getDb(empresa);
      for (const regra of MAPA) {
        const variantes = regra.de.filter(v => v !== regra.para);
        if (!variantes.length) continue;
        const ph = variantes.map((_,i) => `$${i+1}`).join(',');
        const aff = await db.prepare(`SELECT COUNT(*) AS n FROM despesas WHERE TRIM(UPPER(COALESCE(categoria,''))) IN (${ph})`).get(...variantes);
        const qtd = aff?.n || 0;
        if (qtd === 0) continue;
        console.log(`  [${empresa}] ${variantes.join('/')} → ${regra.para}: ${qtd} registros`);
        totalEmpresa += qtd;
        if (APPLY) {
          await db.prepare(`UPDATE despesas SET categoria=$${variantes.length+1}, updated_at=NOW() WHERE TRIM(UPPER(COALESCE(categoria,''))) IN (${ph})`).run(...variantes, regra.para);
        }
      }
      if (totalEmpresa === 0) console.log(`  [${empresa}] ✅ Nenhuma categoria duplicada.`);
    } catch(e) {
      console.log(`  [${empresa}] ⚠️  ${e.message}`);
    }
  }
  if (!APPLY) console.log('  🧪 DRY-RUN — nenhum dado alterado.');
  else console.log('  ✅ Normalização concluída.');
}

// ── Etapa 3: Backfill INSS — Segurança (inss=0 → 11% do bruto) ───────────────
async function etapa3() {
  if (!header(3, 'Backfill INSS Retido — Segurança (inss=0 → 11% do bruto)')) return;

  const ALIQ = 0.11;
  const db = getDb('seguranca');

  const resumo = await db.prepare(`
    SELECT COUNT(*) AS sem_inss, ROUND(SUM(valor_bruto)::numeric, 2) AS bruto
    FROM notas_fiscais
    WHERE (inss = 0 OR inss IS NULL) AND valor_bruto > 0
  `).get();

  const qtd = resumo?.sem_inss || 0;
  const totalBruto = resumo?.bruto || 0;
  const totalINSS = Math.round(totalBruto * ALIQ * 100) / 100;

  console.log(`  NFs com inss=0: ${qtd}`);
  console.log(`  Total bruto:    R$ ${brl(totalBruto)}`);
  console.log(`  INSS a imputar: R$ ${brl(totalINSS)} (11%)`);

  if (qtd === 0) { console.log('  ✅ Nenhuma NF com inss=0. Já estava correto.'); return; }
  if (!APPLY)    { console.log('  🧪 DRY-RUN'); return; }

  await db.prepare(`
    UPDATE notas_fiscais
    SET inss = ROUND((valor_bruto * $1)::numeric, 2), updated_at = NOW()
    WHERE (inss = 0 OR inss IS NULL) AND valor_bruto > 0
  `).run(ALIQ);

  const pos = await db.prepare(`SELECT COUNT(*) AS n FROM notas_fiscais WHERE (inss=0 OR inss IS NULL) AND valor_bruto > 0`).get();
  console.log(`  ✅ Backfill aplicado. Restam com inss=0: ${pos?.n || 0}`);
}

// ── Etapa 4: Normalizar status de NFs (sem_inss, ok, divergente) ─────────────
async function etapa4() {
  if (!header(4, 'Normalizar status de despesas — STATUS em maiúsculo')) return;

  const EMPRESAS = ['assessoria', 'seguranca', 'portodovau', 'mustang'];
  const STATUS_MAP = [
    { de: ['pago', 'Pago'], para: 'PAGO' },
    { de: ['pendente', 'Pendente', 'PENDENTE'], para: 'PENDENTE' },
    { de: ['cancelado', 'Cancelado'], para: 'CANCELADO' },
  ];

  for (const empresa of EMPRESAS) {
    try {
      const db = getDb(empresa);
      let totalEmpresa = 0;
      for (const rule of STATUS_MAP) {
        const ph = rule.de.map((_,i) => `$${i+1}`).join(',');
        const aff = await db.prepare(`SELECT COUNT(*) AS n FROM despesas WHERE status IN (${ph})`).get(...rule.de);
        const qtd = aff?.n || 0;
        if (qtd === 0) continue;
        console.log(`  [${empresa}] status="${rule.de.join('/')}" → "${rule.para}": ${qtd} registros`);
        totalEmpresa += qtd;
        if (APPLY) {
          await db.prepare(`UPDATE despesas SET status=$${rule.de.length+1} WHERE status IN (${ph})`).run(...rule.de, rule.para);
        }
      }
      if (totalEmpresa === 0) console.log(`  [${empresa}] ✅ Status já normalizado.`);
    } catch(e) {
      console.log(`  [${empresa}] ⚠️  ${e.message}`);
    }
  }
  if (!APPLY) console.log('  🧪 DRY-RUN — nenhum dado alterado.');
  else console.log('  ✅ Normalização de status concluída.');
}

// ── Etapa 5: Diagnóstico final ────────────────────────────────────────────────
async function etapa5() {
  if (!header(5, 'Diagnóstico final — verificação de integridade')) return;

  const EMPRESAS = ['assessoria', 'seguranca'];
  for (const empresa of EMPRESAS) {
    try {
      const db = getDb(empresa);

      const nfs = await db.prepare(`SELECT COUNT(*) AS n, ROUND(SUM(valor_bruto)::numeric,2) AS bruto FROM notas_fiscais`).get();
      const desp = await db.prepare(`SELECT COUNT(*) AS n FROM despesas`).get();
      const nfsInss = await db.prepare(`SELECT COUNT(*) AS n FROM notas_fiscais WHERE inss > 0`).get();
      const nfsSemInss = await db.prepare(`SELECT COUNT(*) AS n FROM notas_fiscais WHERE (inss=0 OR inss IS NULL) AND valor_bruto > 0`).get();
      const contratos = await db.prepare(`SELECT COUNT(*) AS n FROM contratos`).get();

      console.log(`\n  [${empresa}]`);
      console.log(`    NFs: ${nfs?.n || 0} (bruto R$ ${brl(nfs?.bruto)}) — com INSS: ${nfsInss?.n||0}, sem INSS: ${nfsSemInss?.n||0}`);
      console.log(`    Despesas: ${desp?.n || 0} | Contratos: ${contratos?.n || 0}`);
    } catch(e) {
      console.log(`  [${empresa}] ⚠️  ${e.message}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🚀 Pós-Deploy Montana ERP — Maio 2026');
  console.log(`   Modo: ${APPLY ? '🔥 APLICAR' : '🧪 DRY-RUN (use --apply para gravar)'}`);
  if (PULAR.length) console.log(`   Pulando etapas: ${PULAR.join(', ')}`);
  console.log(`   Data/hora: ${new Date().toLocaleString('pt-BR')}\n`);

  await etapa1();
  await etapa2();
  await etapa3();
  await etapa4();
  await etapa5();

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ✔️  Pós-deploy concluído — ${APPLY ? 'dados gravados' : 'DRY-RUN (sem alterações)'}.`);
  console.log('═'.repeat(70) + '\n');
  process.exit(0);
}

main().catch(e => {
  console.error('❌ Erro fatal:', e.message);
  process.exit(1);
});
