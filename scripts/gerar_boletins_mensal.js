#!/usr/bin/env node
/**
 * Montana — Geração automática mensal de boletins de medição
 *
 * Para cada empresa (assessoria, seguranca, portodovau, mustang) e cada contrato
 * ativo em bol_contratos, garante que existe um boletim na competência alvo.
 * Calcula total_geral via SUM das NFs do mês alvo (fallback: clone do mês
 * anterior se não houver NFs). Idempotente via ON CONFLICT (UPSERT).
 *
 * Uso:
 *   node scripts/gerar_boletins_mensal.js                          (dry-run, mês passado)
 *   node scripts/gerar_boletins_mensal.js --apply                  (aplica)
 *   node scripts/gerar_boletins_mensal.js --mes=2026-04 --apply    (mês específico)
 *   node scripts/gerar_boletins_mensal.js --from=2026-01 --to=2026-04 --apply  (intervalo)
 *   node scripts/gerar_boletins_mensal.js [empresa] --apply        (1 empresa só)
 *
 * UPSERT: idempotente — pode rodar várias vezes pra recalcular total_geral
 * sem duplicar boletins. Usa o índice UNIQUE bol_boletins_contrato_comp_uq.
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

// Parse --mes=YYYY-MM ou --from=YYYY-MM --to=YYYY-MM (intervalo)
function competenciasDoArgs() {
  const mesArg = process.argv.find(a => a.startsWith('--mes='));
  const fromArg = process.argv.find(a => a.startsWith('--from='));
  const toArg   = process.argv.find(a => a.startsWith('--to='));

  if (mesArg) return [mesArg.replace('--mes=', '')];

  if (fromArg && toArg) {
    const from = fromArg.replace('--from=', '');
    const to   = toArg.replace('--to=', '');
    const lista = [];
    const [ya, ma] = from.split('-').map(Number);
    const [yb, mb] = to.split('-').map(Number);
    let cur = new Date(ya, ma - 1, 1);
    const fim = new Date(yb, mb - 1, 1);
    while (cur <= fim) {
      lista.push(`${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}`);
      cur.setMonth(cur.getMonth() + 1);
    }
    return lista;
  }

  // Default: mês passado
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return [d.toISOString().slice(0, 7)];
}

const COMPETENCIAS = competenciasDoArgs();

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

async function processarEmpresa(empresa, comp) {
  const db = getDb(empresa);
  console.log('\n' + '─'.repeat(80));
  console.log(`  ${empresa.toUpperCase()} — Gerar/atualizar boletins de ${comp}`);
  console.log('─'.repeat(80));

  if (!await tableExists(db, empresa, 'bol_contratos') ||
      !await tableExists(db, empresa, 'bol_boletins')) {
    console.log('  ⚠️  bol_contratos ou bol_boletins ausentes — pulando');
    return { criados: 0, atualizados: 0, sem_alteracao: 0, sem_referencia: 0 };
  }

  const ativos = await db.prepare(`SELECT id, nome, numero_contrato FROM bol_contratos WHERE ativo = 1 ORDER BY id`).all();

  if (ativos.length === 0) {
    console.log('  Sem contratos ativos.');
    return { criados: 0, atualizados: 0, sem_alteracao: 0, sem_referencia: 0 };
  }

  const { inicio, fim } = periodoDoMes(comp);
  const compAnt = compAnterior(comp);

  let criados = 0, atualizados = 0, sem_alteracao = 0, sem_referencia = 0;
  const acoes = []; // [{cid, nome, total_geral, origem, existing_id, existing_total}]

  for (const c of ativos) {
    // Estratégia (em ordem de prioridade):
    //  1. SUM das NFs do MÊS ALVO (fonte de verdade — quando NFs foram emitidas)
    //  2. Boletim do mês ANTERIOR (clone — fallback para meses futuros/correntes
    //     ainda sem NF, assumindo continuidade)
    //  3. Zero (com flag sem_referencia) — quando nunca houve faturamento
    //
    // NOTA: removida a "Tentativa 3" (último boletim de qualquer mês) — clonava
    // valor de meses futuros pra meses anteriores onde não houve faturamento,
    // criando boletins fantasmas (ex: UNITINS abr clonado pra jan/fev/mar).
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
      `).get({ pat: `%${c.numero_contrato}%`, ym: `${comp}-%` });
      if (sumRow && sumRow.qtd > 0 && Number(sumRow.total) > 0) {
        total_geral = Number(sumRow.total);
        origem = `sum_nfs(${sumRow.qtd})`;
      }
    }

    // ─ Tentativa 2: boletim do mês anterior (clone — só faz sentido pra continuidade)
    if (!total_geral) {
      const ref = await db.prepare(`
        SELECT total_geral FROM bol_boletins WHERE contrato_id = @cid AND competencia = @comp
      `).get({ cid: c.id, comp: compAnt });
      if (ref && Number(ref.total_geral) > 0) {
        total_geral = Number(ref.total_geral);
        origem = 'boletim_anterior';
      }
    }

    if (!total_geral) sem_referencia++;

    // Buscar boletim existente pra decidir create vs update
    const existing = await db.prepare(`
      SELECT id, total_geral FROM bol_boletins WHERE contrato_id = @cid AND competencia = @comp
    `).get({ cid: c.id, comp });

    acoes.push({
      cid: c.id, nome: c.nome, total_geral, origem,
      existing_id: existing?.id || null,
      existing_total: existing ? Number(existing.total_geral) : null,
    });
  }

  // Mostra resumo
  for (const a of acoes) {
    let tag;
    if (!a.existing_id) tag = '+CREATE';
    else if (Math.abs(a.existing_total - a.total_geral) < 0.01) tag = ' SAME ';
    else tag = `~UPDATE (era ${a.existing_total.toFixed(2)})`;
    console.log(`     [#${a.cid}] ${a.nome.slice(0, 38).padEnd(38)} R$ ${Number(a.total_geral).toFixed(2).padStart(13)}  ${tag}  (${a.origem})`);
  }

  if (APPLY && acoes.length > 0) {
    const trans = db.transaction(async (tx) => {
      // UPSERT: usa o índice UNIQUE bol_boletins_contrato_comp_uq
      // (contrato_id, competencia). Em conflito atualiza apenas total_geral
      // e período — preserva nfse_numero, status, etc.
      for (const a of acoes) {
        const r = await tx.prepare(`
          INSERT INTO bol_boletins
            (contrato_id, competencia, data_emissao, periodo_inicio, periodo_fim,
             status, total_geral, valor_base, glosas, acrescimos, nfse_status)
          VALUES
            (@cid, @comp, @demit, @ini, @fim, 'sem_nf', @tot, 0, 0, 0, 'PENDENTE')
          ON CONFLICT (contrato_id, competencia) DO UPDATE SET
            total_geral    = EXCLUDED.total_geral,
            periodo_inicio = COALESCE(NULLIF(bol_boletins.periodo_inicio, ''), EXCLUDED.periodo_inicio),
            periodo_fim    = COALESCE(NULLIF(bol_boletins.periodo_fim, ''),    EXCLUDED.periodo_fim),
            updated_at     = NOW()
          RETURNING (xmax = 0) AS inserted
        `).run({
          cid: a.cid, comp,
          demit: fim, ini: inicio, fim,
          tot: a.total_geral,
        });
        // RETURNING (xmax = 0) → true se foi INSERT, false se UPDATE.
        // Mas o run() do db_pg.js só retorna lastInsertRowid/changes — não temos acesso a xmax aqui.
        // Então usamos a info pré-checada (existing_id):
        if (!a.existing_id) {
          criados++;
        } else if (Math.abs(a.existing_total - a.total_geral) < 0.01) {
          sem_alteracao++;
        } else {
          atualizados++;
        }
      }
    });
    await trans();
    console.log(`  ✅ ${criados} criados, ${atualizados} atualizados, ${sem_alteracao} sem alteração`);
  } else if (acoes.length > 0) {
    console.log(`  ⚠️  DRY-RUN — use --apply para gravar`);
  }

  return { criados, atualizados, sem_alteracao, sem_referencia };
}

async function main() {
  console.log('\n🤖 Gerador automático de boletins mensais (UPSERT)');
  console.log(`   Competências: ${COMPETENCIAS.length === 1 ? COMPETENCIAS[0] : `${COMPETENCIAS[0]} .. ${COMPETENCIAS[COMPETENCIAS.length-1]} (${COMPETENCIAS.length} meses)`}`);
  console.log(`   Modo: ${APPLY ? 'APPLY (grava)' : 'DRY-RUN'}`);
  console.log(`   Empresas: ${EMPRESAS.join(', ')}`);

  const resultados = [];
  for (const e of EMPRESAS) {
    console.log('\n' + '═'.repeat(80));
    console.log(`  ${e.toUpperCase()}`);
    console.log('═'.repeat(80));
    for (const comp of COMPETENCIAS) {
      try {
        const r = await processarEmpresa(e, comp);
        resultados.push({ empresa: e, comp, ...r });
      } catch (err) {
        console.error(`\n  ❌ ${e} ${comp}: ${err.message}`);
        console.error(err.stack);
      }
    }
  }

  console.log('\n' + '═'.repeat(80));
  console.log('  RESUMO');
  console.log('═'.repeat(80));
  for (const r of resultados) {
    console.log(`  ${r.empresa.padEnd(11)} ${r.comp} | criados: ${String(r.criados).padStart(3)} | atualizados: ${String(r.atualizados || 0).padStart(3)} | sem alt: ${String(r.sem_alteracao || 0).padStart(3)} | sem ref: ${String(r.sem_referencia).padStart(3)}`);
  }
  console.log('═'.repeat(80));

  await closeAll();
}

main().catch(e => {
  console.error('FATAL:', e);
  closeAll().finally(() => process.exit(1));
});
