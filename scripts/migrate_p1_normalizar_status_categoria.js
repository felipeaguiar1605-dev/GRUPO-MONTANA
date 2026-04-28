#!/usr/bin/env node
/**
 * Montana — P1: Normalizar status de contratos e categorias de despesa
 *
 * Itera pelos 4 schemas (assessoria, seguranca, portodovau, mustang) e:
 *   1. contratos.status   → UPPER + TRIM + mapeamento de variantes
 *      ativo / Ativo / ' ATIVO '   → ATIVO
 *      encerrado / Encerrado       → ENCERRADO
 *      rescindido / Rescindido     → RESCINDIDO
 *      em dia / EM_DIA / em-dia    → EM DIA
 *      critico / crítico           → CRÍTICO
 *   2. despesas.categoria → UPPER + TRIM (canonicaliza para o que dre.js espera)
 *
 * Modos:
 *   node scripts/migrate_p1_normalizar_status_categoria.js            (dry-run global)
 *   node scripts/migrate_p1_normalizar_status_categoria.js --apply    (grava em todos os 4 schemas)
 *   node scripts/migrate_p1_normalizar_status_categoria.js --verify   (só relatório pós-aplicação)
 *   node scripts/migrate_p1_normalizar_status_categoria.js [empresa] [--apply|--verify]
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb, closeAll } = require('../src/db_pg');

const APPLY  = process.argv.includes('--apply');
const VERIFY = process.argv.includes('--verify');
const argsPos = process.argv.slice(2).filter(a => !a.startsWith('--'));
const empArg = (argsPos[0] || 'todas').toLowerCase();
const EMPRESAS = empArg === 'todas'
  ? ['assessoria', 'seguranca', 'portodovau', 'mustang']
  : [empArg];

// ── Status canônicos de contratos ────────────────────────────────
// Tudo que NÃO bater abaixo: aplicar UPPER(TRIM(...)) e seguir.
const STATUS_MAP = [
  // [regex sobre UPPER(TRIM(status)), valor canônico]
  [/^ATIVOS?$/,                         'ATIVO'],
  [/^EM[\s_-]?DIA$/,                    'EM DIA'],
  [/^CR[ÍI]TICO$/,                      'CRÍTICO'],
  [/^ENCERRAD[OA]$/,                    'ENCERRADO'],
  [/^RESCINDID[OA]$/,                   'RESCINDIDO'],
  [/^SUSPEND?ID[OA]$/,                  'SUSPENSO'],
  [/^SUSPENSO$/,                        'SUSPENSO'],
  [/^REVISAR$/,                         'REVISAR'],
  [/^CANCELAD[OA]$/,                    'CANCELADO'],
];

function canonicalStatus(raw) {
  if (raw === null || raw === undefined) return null;
  const t = String(raw).trim().toUpperCase();
  if (t === '') return null;
  for (const [rx, canon] of STATUS_MAP) {
    if (rx.test(t)) return canon;
  }
  // Não bate em nada → devolve UPPER+TRIM (canoniza ao menos espaços e caixa)
  return t;
}

function canonicalCategoria(raw) {
  if (raw === null || raw === undefined) return null;
  const t = String(raw).trim().toUpperCase();
  if (t === '') return null;
  // Sem mapeamento de variantes (UPPER+TRIM é suficiente — dre.js já usa essa
  // forma como referência de agrupamento).
  return t;
}

async function tableExists(db, schema, name) {
  const r = await db.prepare(`
    SELECT 1 AS x FROM information_schema.tables
    WHERE table_schema = @schema AND table_name = @name
  `).get({ schema, name });
  return !!r;
}

async function columnExists(db, schema, table, col) {
  const r = await db.prepare(`
    SELECT 1 AS x FROM information_schema.columns
    WHERE table_schema = @schema AND table_name = @table AND column_name = @col
  `).get({ schema, table, col });
  return !!r;
}

async function processarEmpresa(empresa) {
  const db = getDb(empresa);
  console.log('\n' + '═'.repeat(80));
  console.log(`  ${empresa.toUpperCase()} — Normalizar status / categoria`);
  console.log('═'.repeat(80));

  const stats = {
    empresa,
    contratos: { lidos: 0, alterados: 0, distintos_antes: 0, distintos_depois: 0 },
    despesas:  { lidos: 0, alterados: 0, distintos_antes: 0, distintos_depois: 0 },
  };

  // ── 1. CONTRATOS.status ───────────────────────────────────────
  if (await tableExists(db, empresa, 'contratos') &&
      await columnExists(db, empresa, 'contratos', 'status')) {
    const rows = await db.prepare(`SELECT id, status FROM contratos`).all();
    stats.contratos.lidos = rows.length;

    const distintosAntes = new Set(rows.map(r => r.status === null ? '<NULL>' : r.status));
    stats.contratos.distintos_antes = distintosAntes.size;

    const updates = [];
    for (const r of rows) {
      const novo = canonicalStatus(r.status);
      const igual = (r.status === null && novo === null) ||
                    (r.status !== null && novo !== null && r.status === novo);
      if (!igual) updates.push({ id: r.id, de: r.status, para: novo });
    }

    console.log(`\n  contratos: ${rows.length} linhas | ${distintosAntes.size} status distintos`);
    if (updates.length === 0) {
      console.log('     ✓ nada a fazer (já normalizado)');
    } else {
      // Resumir transformações por (de → para)
      const buckets = new Map();
      for (const u of updates) {
        const key = `${u.de === null ? '<NULL>' : `'${u.de}'`} → ${u.para === null ? '<NULL>' : `'${u.para}'`}`;
        buckets.set(key, (buckets.get(key) || 0) + 1);
      }
      console.log(`     ${updates.length} mudanças:`);
      for (const [k, n] of [...buckets.entries()].sort((a,b) => b[1]-a[1])) {
        console.log(`       ${String(n).padStart(5)} × ${k}`);
      }

      if (APPLY) {
        const trans = db.transaction(async (tx) => {
          for (const u of updates) {
            await tx.prepare(`UPDATE contratos SET status = @s WHERE id = @id`)
              .run({ s: u.para, id: u.id });
          }
        });
        await trans();
        stats.contratos.alterados = updates.length;
        console.log(`     ✅ ${updates.length} contratos atualizados`);
      } else {
        stats.contratos.alterados = updates.length;
      }
    }

    // Distintos depois (recalcular)
    const distinctosDepois = await db.prepare(`
      SELECT DISTINCT COALESCE(status, '<NULL>') AS s FROM contratos ORDER BY 1
    `).all();
    stats.contratos.distintos_depois = distinctosDepois.length;

    if (VERIFY || APPLY) {
      console.log(`\n     status distintos pós-normalização (${distinctosDepois.length}):`);
      for (const r of distinctosDepois) {
        const cnt = await db.prepare(
          r.s === '<NULL>'
            ? `SELECT COUNT(*) c FROM contratos WHERE status IS NULL`
            : `SELECT COUNT(*) c FROM contratos WHERE status = @s`
        ).get({ s: r.s });
        console.log(`       ${String(cnt.c).padStart(4)} | ${r.s}`);
      }
    }
  } else {
    console.log('\n  contratos: tabela ou coluna `status` ausente — pulando');
  }

  // ── 2. DESPESAS.categoria ─────────────────────────────────────
  if (await tableExists(db, empresa, 'despesas') &&
      await columnExists(db, empresa, 'despesas', 'categoria')) {
    const rows = await db.prepare(`SELECT id, categoria FROM despesas`).all();
    stats.despesas.lidos = rows.length;

    const distintosAntes = new Set(rows.map(r => r.categoria === null ? '<NULL>' : r.categoria));
    stats.despesas.distintos_antes = distintosAntes.size;

    const updates = [];
    for (const r of rows) {
      const novo = canonicalCategoria(r.categoria);
      const igual = (r.categoria === null && novo === null) ||
                    (r.categoria !== null && novo !== null && r.categoria === novo);
      if (!igual) updates.push({ id: r.id, de: r.categoria, para: novo });
    }

    console.log(`\n  despesas: ${rows.length} linhas | ${distintosAntes.size} categorias distintas`);
    if (updates.length === 0) {
      console.log('     ✓ nada a fazer (já normalizado)');
    } else {
      const buckets = new Map();
      for (const u of updates) {
        const key = `${u.de === null ? '<NULL>' : `'${u.de}'`} → ${u.para === null ? '<NULL>' : `'${u.para}'`}`;
        buckets.set(key, (buckets.get(key) || 0) + 1);
      }
      console.log(`     ${updates.length} mudanças (top 15):`);
      const entries = [...buckets.entries()].sort((a,b) => b[1]-a[1]);
      for (const [k, n] of entries.slice(0, 15)) {
        console.log(`       ${String(n).padStart(5)} × ${k}`);
      }
      if (entries.length > 15) console.log(`       ... +${entries.length - 15} outras combinações`);

      if (APPLY) {
        // Updates em lote por (de → para) — O(N de combinações), não O(N de linhas)
        const trans = db.transaction(async (tx) => {
          for (const [k, _n] of entries) {
            // recupera o par (de, para) original do bucket; mais fácil refazer pela map
          }
          // Em vez disso: agrupar updates pelo `de` real
          const agrupado = new Map(); // de(string|null) → para
          for (const u of updates) agrupado.set(u.de === null ? null : u.de, u.para);
          for (const [de, para] of agrupado.entries()) {
            if (de === null) {
              // categoria IS NULL — em geral canonicalCategoria(null) = null,
              // logo não cai aqui, mas mantemos por completude.
              await tx.prepare(`UPDATE despesas SET categoria = @p WHERE categoria IS NULL`)
                .run({ p: para });
            } else {
              await tx.prepare(`UPDATE despesas SET categoria = @p WHERE categoria = @d`)
                .run({ p: para, d: de });
            }
          }
        });
        await trans();
        stats.despesas.alterados = updates.length;
        console.log(`     ✅ ${updates.length} despesas atualizadas`);
      } else {
        stats.despesas.alterados = updates.length;
      }
    }

    const distinctosDepois = await db.prepare(`
      SELECT DISTINCT COALESCE(categoria, '<NULL>') AS s FROM despesas ORDER BY 1
    `).all();
    stats.despesas.distintos_depois = distinctosDepois.length;

    if (VERIFY || APPLY) {
      console.log(`\n     categorias distintas pós-normalização (${distinctosDepois.length}):`);
      for (const r of distinctosDepois.slice(0, 30)) {
        const cnt = await db.prepare(
          r.s === '<NULL>'
            ? `SELECT COUNT(*) c FROM despesas WHERE categoria IS NULL`
            : `SELECT COUNT(*) c FROM despesas WHERE categoria = @s`
        ).get({ s: r.s });
        console.log(`       ${String(cnt.c).padStart(5)} | ${r.s}`);
      }
      if (distinctosDepois.length > 30) console.log(`       ... +${distinctosDepois.length - 30} outras`);
    }
  } else {
    console.log('\n  despesas: tabela ou coluna `categoria` ausente — pulando');
  }

  return stats;
}

async function main() {
  console.log('\n🔧 P1 — NORMALIZAR contratos.status / despesas.categoria');
  console.log(`   Modo: ${APPLY ? 'APPLY (grava)' : VERIFY ? 'VERIFY (só relatório)' : 'DRY-RUN'}`);
  console.log(`   Empresas: ${EMPRESAS.join(', ')}`);

  const todos = [];
  for (const e of EMPRESAS) {
    try {
      todos.push(await processarEmpresa(e));
    } catch (err) {
      console.error(`\n  ❌ ${e}: ${err.message}`);
      console.error(err.stack);
    }
  }

  // ── Resumo ───────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(80));
  console.log('  RESUMO GLOBAL');
  console.log('═'.repeat(80));
  console.log('  Empresa     | Contratos lidos/alt | Distintos antes→depois | Despesas lidos/alt | Distintos antes→depois');
  console.log('  ' + '-'.repeat(110));
  for (const s of todos) {
    const c = s.contratos, d = s.despesas;
    console.log(
      `  ${s.empresa.padEnd(11)} | ${String(c.lidos).padStart(6)}/${String(c.alterados).padStart(5)}    ` +
      `| ${String(c.distintos_antes).padStart(3)} → ${String(c.distintos_depois).padStart(3)}             ` +
      `| ${String(d.lidos).padStart(6)}/${String(d.alterados).padStart(5)}      ` +
      `| ${String(d.distintos_antes).padStart(3)} → ${String(d.distintos_depois).padStart(3)}`
    );
  }
  console.log('═'.repeat(80));
  console.log(`  ${APPLY ? '✅ Alterações GRAVADAS' : VERIFY ? 'ℹ️ Só relatório (sem alterações)' : '⚠️ DRY-RUN — use --apply para gravar'}`);

  await closeAll();
}

main().catch(e => {
  console.error('FATAL:', e);
  closeAll().finally(() => process.exit(1));
});
