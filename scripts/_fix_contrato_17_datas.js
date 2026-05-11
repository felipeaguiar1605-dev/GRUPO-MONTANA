'use strict';
/**
 * Fix pontual: Contrato id=17 — vigencia_inicio e vigencia_fim invertidas
 *
 * Diagnóstico: contrato id=17 (Segurança) tem as datas trocadas no banco.
 * vigencia_inicio registrado = data que deveria ser vigencia_fim e vice-versa.
 *
 * Uso:
 *   node scripts/_fix_contrato_17_datas.js               # dry-run (mostra estado atual)
 *   node scripts/_fix_contrato_17_datas.js --apply        # corrige
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APLICAR = process.argv.includes('--apply');
const EMPRESA = process.argv.find(a => a.startsWith('--empresa='))?.split('=')[1] || 'seguranca';

async function main() {
  console.log(`\n🔧 Fix contrato id=17 — datas invertidas (${EMPRESA})`);
  console.log(`   Modo: ${APLICAR ? '🔥 APLICAR' : '🧪 DRY-RUN'}\n`);

  const db = getDb(EMPRESA);

  const c = await db.prepare(`
    SELECT id, numContrato, orgao, vigencia_inicio, vigencia_fim, status
    FROM contratos WHERE id = 17
  `).get();

  if (!c) {
    console.log('❌ Contrato id=17 não encontrado na empresa', EMPRESA);
    process.exit(1);
  }

  console.log('Estado atual:');
  console.log(`  id            : ${c.id}`);
  console.log(`  numContrato   : ${c.numContrato}`);
  console.log(`  orgao         : ${c.orgao}`);
  console.log(`  vigencia_inicio: ${c.vigencia_inicio}  ← ERRADO (deveria ser vigencia_fim)`);
  console.log(`  vigencia_fim  : ${c.vigencia_fim}  ← ERRADO (deveria ser vigencia_inicio)`);
  console.log(`  status        : ${c.status}`);

  const novoInicio = c.vigencia_fim;
  const novoFim    = c.vigencia_inicio;

  console.log('\nCorreção proposta:');
  console.log(`  vigencia_inicio: ${novoInicio}`);
  console.log(`  vigencia_fim  : ${novoFim}`);

  if (!APLICAR) {
    console.log('\n🧪 DRY-RUN — nenhum dado alterado. Use --apply para corrigir.');
    process.exit(0);
  }

  await db.prepare(`
    UPDATE contratos
    SET vigencia_inicio = $1, vigencia_fim = $2, updated_at = NOW()
    WHERE id = 17
  `).run(novoInicio, novoFim);

  const verificacao = await db.prepare(
    `SELECT vigencia_inicio, vigencia_fim FROM contratos WHERE id = 17`
  ).get();

  console.log('\n✅ Atualizado:');
  console.log(`  vigencia_inicio: ${verificacao.vigencia_inicio}`);
  console.log(`  vigencia_fim  : ${verificacao.vigencia_fim}`);
  console.log('\n✔️  Concluído.\n');
  process.exit(0);
}

main().catch(e => {
  console.error('❌ Erro:', e.message);
  process.exit(1);
});
