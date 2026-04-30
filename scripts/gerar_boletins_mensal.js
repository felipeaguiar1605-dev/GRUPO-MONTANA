#!/usr/bin/env node
/**
 * Montana — Geração automática mensal de boletins de medição
 *
 * Para cada empresa (assessoria, seguranca, portodovau, mustang) e cada contrato
 * ativo em bol_contratos, garante que existe um boletim na competência alvo.
 * Clona o total_geral do mês anterior (último boletim conhecido) e insere com
 * status 'sem_nf' / nfse_status='PENDENTE'.
 *
 * Idempotente: roda 2x e não duplica (UNIQUE virtual por contrato_id + competencia).
 *
 * Uso:
 *   node scripts/gerar_boletins_mensal.js                       (dry-run, mês passado)
 *   node scripts/gerar_boletins_mensal.js --apply               (aplica)
 *   node scripts/gerar_boletins_mensal.js --mes=2026-04 --apply (mês específico)
 *   node scripts/gerar_boletins_mensal.js [empresa] --apply     (1 empresa só)
 *
 * Designed for cron via PM2 (ecosystem.config.js):
 *   cron_restart: '0 8 5 * *'   (dia 5 de cada mês, 8h)
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb, closeAll } = require('../src/db_pg');

const APPLY = process.argv.includes('--apply');
const argsPos = process.argv.slice(2).filter(a => !a.startsWith('--'));
const empArg = (argsPos[0] || 'todas').toLowerCase();

// Parse --mes=YYYY-MM
const mesArg = process.argv.find(a => a.startsWith('--mes='));
const COMP_ALVO = mesArg
  ? mesArg.replace('--mes=', '')
  : (() => {
      // Default: competência = mês passado (ex: rodando em 5/maio → '2026-04')
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - 1);
      return d.toISOString().slice(0, 7); // YYYY-MM
    })();

const EMPRESAS = empArg === 'todas'
  ? ['assessoria', 'seguranca', 'portodovau', 'mustang']
  : [empArg];

// Calcula período (início e fim do mês)
function periodoDoMes(yyyymm) {
  const [ano, mes] = yyyymm.split('-').map(Number);
  const inicio = `${yyyymm}-01`;
  const ultimoDia = new Date(ano, mes, 0).getDate(); // mes=4 → ultimo dia abr = 30
  const fim = `${yyyymm}-${String(ultimoDia).padStart(2, '0')}`;
  return { inicio, fim };
}

// Calcula competência anterior
function compAnterior(yyyymm) {
  const [ano, mes] = yyyymm.split('-').map(Number);
  const d = new Date(ano, mes - 2, 1); // mes-1 já no JS é 0-indexed; -2 = mês anterior
  return d.toISOString().slice(0, 7);
}

async function tableExists(db, schema, name) {
  const r = await db.prepare(`
    SELECT 1 AS x FROM information_schema.tables
    WHERE table_schema = @schema AND table_name = @name
  `).get({ schema, name });
  return !!r;
}

async function processarEmpresa(empresa) {
  const db = getDb(empresa);
  console.log('\n' + '═'.repeat(80));
  console.log(`  ${empresa.toUpperCase()} — Gerar boletins de ${COMP_ALVO}`);
  console.log('═'.repeat(80));

  if (!await tableExists(db, empresa, 'bol_contratos') ||
      !await tableExists(db, empresa, 'bol_boletins')) {
    console.log('  ⚠️  bol_contratos ou bol_boletins ausentes — pulando');
    return { criados: 0, ja_existiam: 0, sem_referencia: 0 };
  }

  const ativos = await db.prepare(`SELECT id, nome, numero_contrato FROM bol_contratos WHERE ativo = 1 ORDER BY id`).all();
  console.log(`  Contratos ativos: ${ativos.length}`);

  if (ativos.length === 0) return { criados: 0, ja_existiam: 0, sem_referencia: 0 };

  const { inicio, fim } = periodoDoMes(COMP_ALVO);
  const compAnt = compAnterior(COMP_ALVO);

  let criados = 0, ja_existiam = 0, sem_referencia = 0;
  const acoes = []; // [{contrato, total_geral, status}]

  for (const c of ativos) {
    // Já existe?
    const exists = await db.prepare(`
      SELECT id FROM bol_boletins WHERE contrato_id = @cid AND competencia = @comp
    `).get({ cid: c.id, comp: COMP_ALVO });

    if (exists) {
      ja_existiam++;
      continue;
    }

    // Estratégia (em ordem de prioridade):
    //  1. SUM das NFs do MÊS ALVO (fonte de verdade quando NFs já foram emitidas)
    //  2. Boletim do mês anterior (clone, fallback quando não há NFs ainda)
    //  3. Último boletim disponível de qualquer competência
    //  4. Zero (com flag sem_referencia)
    let total_geral = 0;
    let origem = 'sem_ref';

    // ─ Tentativa 1: SUM das NFs do mês alvo
    if (c.numero_contrato && c.numero_contrato !== 'undefined') {
      const sumRow = await db.prepare(`
        SELECT COALESCE(SUM(valor_bruto), 0) AS total, COUNT(*) AS qtd
        FROM notas_fiscais
        WHERE contrato_ref ILIKE @pat
          AND data_emissao LIKE @ym
          AND COALESCE(status_conciliacao, '') NOT IN ('CANCELADA')
      `).get({ pat: `%${c.numero_contrato}%`, ym: `${COMP_ALVO}-%` });
      if (sumRow && sumRow.qtd > 0 && Number(sumRow.total) > 0) {
        total_geral = Number(sumRow.total);
        origem = `sum_nfs(${sumRow.qtd})`;
      }
    }

    // ─ Tentativa 2: boletim do mês anterior (clone)
    if (!total_geral) {
      const ref = await db.prepare(`
        SELECT total_geral FROM bol_boletins WHERE contrato_id = @cid AND competencia = @comp
      `).get({ cid: c.id, comp: compAnt });
      if (ref && Number(ref.total_geral) > 0) {
        total_geral = Number(ref.total_geral);
        origem = 'boletim_anterior';
      }
    }

    // ─ Tentativa 3: último boletim de qualquer competência
    if (!total_geral) {
      const ref2 = await db.prepare(`
        SELECT total_geral FROM bol_boletins WHERE contrato_id = @cid
        ORDER BY competencia DESC LIMIT 1
      `).get({ cid: c.id });
      if (ref2 && Number(ref2.total_geral) > 0) {
        total_geral = Number(ref2.total_geral);
        origem = 'ultimo_boletim';
      }
    }

    if (!total_geral) sem_referencia++;

    acoes.push({ cid: c.id, nome: c.nome, total_geral, origem });
  }

  // Mostra resumo
  console.log(`  Já existem em ${COMP_ALVO}: ${ja_existiam}`);
  console.log(`  A criar (clonando ${compAnt} ou último): ${acoes.length}`);
  if (sem_referencia > 0) console.log(`    ⚠️  ${sem_referencia} sem boletim anterior — usará total_geral=0`);

  for (const a of acoes) {
    console.log(`     [#${a.cid}] ${a.nome.slice(0, 45).padEnd(45)} R$ ${Number(a.total_geral).toFixed(2).padStart(14)}  (${a.origem})`);
  }

  if (APPLY && acoes.length > 0) {
    const trans = db.transaction(async (tx) => {
      for (const a of acoes) {
        await tx.prepare(`
          INSERT INTO bol_boletins
            (contrato_id, competencia, data_emissao, periodo_inicio, periodo_fim,
             status, total_geral, valor_base, glosas, acrescimos, nfse_status)
          VALUES
            (@cid, @comp, @demit, @ini, @fim, 'sem_nf', @tot, 0, 0, 0, 'PENDENTE')
        `).run({
          cid: a.cid,
          comp: COMP_ALVO,
          demit: fim,           // data_emissao = último dia do mês
          ini: inicio,
          fim: fim,
          tot: a.total_geral,
        });
        criados++;
      }
    });
    await trans();
    console.log(`  ✅ ${criados} boletins criados em ${COMP_ALVO}`);
  } else if (acoes.length > 0) {
    console.log(`  ⚠️  DRY-RUN — use --apply para gravar`);
  }

  return { criados, ja_existiam, sem_referencia };
}

async function main() {
  console.log('\n🤖 Gerador automático de boletins mensais');
  console.log(`   Competência alvo: ${COMP_ALVO}`);
  console.log(`   Modo: ${APPLY ? 'APPLY (grava)' : 'DRY-RUN'}`);
  console.log(`   Empresas: ${EMPRESAS.join(', ')}`);

  const resultados = [];
  for (const e of EMPRESAS) {
    try {
      resultados.push({ empresa: e, ...await processarEmpresa(e) });
    } catch (err) {
      console.error(`\n  ❌ ${e}: ${err.message}`);
      console.error(err.stack);
    }
  }

  console.log('\n' + '═'.repeat(80));
  console.log('  RESUMO');
  console.log('═'.repeat(80));
  for (const r of resultados) {
    console.log(`  ${r.empresa.padEnd(11)} | criados: ${String(r.criados).padStart(3)} | ja existiam: ${String(r.ja_existiam).padStart(3)} | sem ref: ${String(r.sem_referencia).padStart(3)}`);
  }
  console.log('═'.repeat(80));

  await closeAll();
}

main().catch(e => {
  console.error('FATAL:', e);
  closeAll().finally(() => process.exit(1));
});
