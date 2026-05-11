'use strict';
/**
 * Normalização de Categorias de Despesas — Montana ERP
 *
 * Problema: categorias duplicadas por ortografia/capitalização divergentes
 * impedem agrupamentos corretos no DRE e relatórios.
 *
 * Mapeamento:
 *   FOLHA PGTO, FOLHA DE PAGAMENTO → FOLHA
 *   OUTRAS                         → OUTROS
 *   (extensível — adicionar em MAPA)
 *
 * Uso:
 *   node scripts/normalizar_categorias_despesas.js                     # dry-run (todas empresas)
 *   node scripts/normalizar_categorias_despesas.js --empresa=seguranca # dry-run 1 empresa
 *   node scripts/normalizar_categorias_despesas.js --apply             # aplica todas
 *   node scripts/normalizar_categorias_despesas.js --empresa=assessoria --apply
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb, COMPANIES } = require('../src/db');

const ARG     = process.argv.slice(2);
const APLICAR = ARG.includes('--apply');
const arg     = (k, def = '') => (ARG.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || def;
const EMPRESA = arg('empresa', '');   // vazio = todas

// ── Mapa de normalização ─────────────────────────────────────────────────────
// Chave: valor ATUAL no banco (case-insensitive via UPPER())
// Valor: valor NORMALIZADO que será gravado
const MAPA = [
  { de: ['FOLHA PGTO', 'FOLHA DE PAGAMENTO', 'FOLHA PAGAMENTO'], para: 'FOLHA' },
  { de: ['OUTRAS'],                                                para: 'OUTROS' },
  { de: ['IMPOSTO', 'IMPOSTOS', 'TRIBUTOS'],                      para: 'TRIBUTO' },
  { de: ['MANUT', 'MANUTENÇÃO', 'MANUTENCAO'],                    para: 'MANUTENÇÃO' },
  { de: ['SERV', 'SERVICOS', 'SERVIÇOS'],                         para: 'SERVIÇOS' },
  { de: ['ALU', 'ALUGUEL', 'ALUGUEIS'],                           para: 'ALUGUEL' },
];

const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function processarEmpresa(empresa) {
  const db = getDb(empresa);

  console.log(`\n🏢 Empresa: ${empresa}`);

  // ── 1. Diagnóstico: distribuição atual de categorias ─────────────────────────
  const cats = await db.prepare(`
    SELECT TRIM(UPPER(COALESCE(categoria, ''))) AS cat_up,
           categoria,
           COUNT(*) AS qty,
           ROUND(SUM(COALESCE(valor_bruto,0))::numeric, 2) AS total
    FROM despesas
    GROUP BY categoria
    ORDER BY qty DESC
    LIMIT 60
  `).all();

  const catsArr = Array.isArray(cats) ? cats : [];
  console.log(`   ${catsArr.length} categorias distintas encontradas`);

  let totalAlterados = 0;

  for (const regra of MAPA) {
    // Busca variantes a normalizar (excluindo já-correto)
    const variantes = regra.de.filter(v => v !== regra.para);
    if (variantes.length === 0) continue;

    // Build cláusula IN com $1, $2, ...
    const placeholders = variantes.map((_, i) => `$${i + 1}`).join(', ');

    const afetadas = await db.prepare(`
      SELECT COUNT(*) AS qty, ROUND(SUM(COALESCE(valor_bruto,0))::numeric, 2) AS total
      FROM despesas
      WHERE TRIM(UPPER(COALESCE(categoria,''))) IN (${placeholders})
    `).get(...variantes);

    const qtd = afetadas?.qty || 0;
    if (qtd === 0) continue;

    console.log(`   📌 ${variantes.join(', ')} → ${regra.para}  (${qtd} registros, R$ ${brl(afetadas?.total)})`);
    totalAlterados += qtd;

    if (APLICAR) {
      await db.prepare(`
        UPDATE despesas
        SET categoria = $${variantes.length + 1}, updated_at = NOW()
        WHERE TRIM(UPPER(COALESCE(categoria,''))) IN (${placeholders})
      `).run(...variantes, regra.para);
    }
  }

  if (totalAlterados === 0) {
    console.log('   ✅ Nenhuma categoria duplicada detectada nesta empresa.');
  } else if (APLICAR) {
    console.log(`   ✅ ${totalAlterados} registros normalizados.`);
  } else {
    console.log(`   🧪 DRY-RUN: ${totalAlterados} registros seriam normalizados.`);
  }

  return totalAlterados;
}

async function main() {
  console.log('\n🗂️  Normalização de Categorias de Despesas — Montana ERP');
  console.log(`   Modo: ${APLICAR ? '🔥 APLICAR' : '🧪 DRY-RUN'}`);
  if (EMPRESA) console.log(`   Empresa: ${EMPRESA}`);

  // Empresas disponíveis — tenta COMPANIES do db_pg, senão usa lista padrão
  let empresas;
  try {
    const { COMPANIES: C } = require('../src/db');
    empresas = Object.keys(C);
  } catch (_) {
    empresas = ['assessoria', 'seguranca', 'porto_do_vau', 'mustang'];
  }

  const lista = EMPRESA ? [EMPRESA] : empresas;
  let totalGeral = 0;

  for (const emp of lista) {
    try {
      const n = await processarEmpresa(emp);
      totalGeral += n;
    } catch (e) {
      if (e.message?.includes('does not exist') || e.message?.includes('connect')) {
        console.log(`   ⚠️  ${emp}: banco indisponível ou empresa não configurada`);
      } else {
        console.error(`   ❌ ${emp}: ${e.message}`);
      }
    }
  }

  console.log(`\n📊 Total geral: ${totalGeral} registros ${APLICAR ? 'normalizados' : 'a normalizar'}`);
  if (!APLICAR && totalGeral > 0) {
    console.log('   Para aplicar: adicione --apply à linha de comando');
  }
  console.log('\n✔️  Concluído.\n');
  process.exit(0);
}

main().catch(e => {
  console.error('❌ Erro fatal:', e.message);
  process.exit(1);
});
