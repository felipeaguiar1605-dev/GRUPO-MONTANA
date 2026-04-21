'use strict';
/**
 * Atualiza SESAU 178/2022 com 7° TA (25-26/09/2025)
 * - Acréscimo 10,28% = R$ 280.030,08/ano (posto imunização Araguaína + copeira LSPA)
 * - Valor anterior R$ 2.724.316,56/ano
 * - Valor novo: R$ 3.004.346,64/ano = R$ 250.362,22/mês
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const db = getDb('assessoria');

const row = db.prepare(`SELECT * FROM contratos WHERE numContrato='SESAU 178/2022'`).get();
if (!row) { console.error('❌ SESAU 178/2022 não encontrado'); process.exit(1); }

console.log('Antes:');
console.log('  valor_mensal_bruto:', row.valor_mensal_bruto);
console.log('  data_ultimo_reajuste:', row.data_ultimo_reajuste);
console.log('  obs:', row.obs);

const novaObs = [
  row.obs || '',
  '7° TA (25-26/09/2025): acréscimo 10,28% = R$ 280.030,08/ano',
  '  Motivação: inclusão Posto Imunização Araguaína + copeira LSPA',
  '  Processo SGD 2025/30559/298826 · SOLICITAÇÃO 11/2025/SES/SVPPS/DGVS',
  '  Valor anual: R$ 2.724.316,56 → R$ 3.004.346,64 | Mensal: R$ 250.362,22',
  '1° TA (27/09/2023): Repactuação',
].join('\n').trim();

if (APPLY) {
  db.prepare(`
    UPDATE contratos SET
      valor_mensal_bruto = 250362.22,
      data_ultimo_reajuste = '2025-09-26',
      pct_reajuste_ultimo = 10.28,
      indice_reajuste = 'ACRÉSCIMO (Posto Imunização Araguaína)',
      obs = ?,
      updated_at = datetime('now')
    WHERE numContrato = 'SESAU 178/2022'
  `).run(novaObs);
  console.log('\n✅ SESAU 178/2022 atualizado (valor mensal R$ 250.362,22 · reajuste 26/09/2025)');
} else {
  console.log('\n💡 dry-run — use --apply');
  console.log('\nNova obs:\n' + novaObs);
}
