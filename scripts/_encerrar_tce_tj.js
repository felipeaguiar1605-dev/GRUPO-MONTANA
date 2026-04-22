/**
 * Marca TCE 117/2024, TCE 26/2025, TJ 73/2020 e TJ 440/2024 como Encerrado
 * na Assessoria. TJ ainda tem valores a receber via conta vinculada — anotar
 * no obs para não perder contexto.
 *
 * Idempotente: pode ser rodado várias vezes sem duplicar.
 */
'use strict';
const { getDb } = require('../src/db');

const db = getDb('assessoria');
const hoje = new Date().toISOString().substring(0, 10);

const ENCERRAMENTOS = [
  {
    numContrato: 'TCE 117/2024',
    motivo: 'Contrato encerrado.',
  },
  {
    numContrato: 'TCE 26/2025',
    motivo: 'Contrato emergencial encerrado.',
  },
  {
    numContrato: 'TJ 73/2020',
    motivo: 'Contrato encerrado — restam valores a receber via CONTA VINCULADA (provisões IN SEGES/MP 05/2017).',
  },
  {
    numContrato: 'TJ 440/2024',
    motivo: 'Contrato encerrado — restam valores a receber via CONTA VINCULADA (provisões IN SEGES/MP 05/2017).',
  },
];

const stmt = db.prepare(`
  UPDATE contratos
  SET status = 'Encerrado',
      obs = CASE
        WHEN COALESCE(obs,'') = '' THEN ?
        WHEN obs LIKE '%[encerrado em%' THEN obs
        ELSE obs || CHAR(10) || ?
      END
  WHERE numContrato = ?
`);

let total = 0;
for (const e of ENCERRAMENTOS) {
  const linha = `[encerrado em ${hoje}] ${e.motivo}`;
  const info = stmt.run(linha, linha, e.numContrato);
  console.log(`  ${info.changes ? '✅' : '×'} ${e.numContrato.padEnd(20)} (${info.changes} linha alterada)`);
  total += info.changes;
}

console.log(`\n${total} contrato(s) marcado(s) como Encerrado.`);

// Verifica estado pós-update
console.log('\nDEPOIS:');
const rows = db.prepare(`
  SELECT numContrato, status, SUBSTR(COALESCE(obs,''), 1, 100) AS obs_preview
  FROM contratos
  WHERE numContrato IN ('TCE 117/2024','TCE 26/2025','TJ 73/2020','TJ 440/2024')
`).all();
for (const r of rows) {
  console.log(`  ${r.numContrato.padEnd(20)} status=${r.status}`);
  if (r.obs_preview) console.log(`     obs: ${r.obs_preview}${r.obs_preview.length >= 100 ? '...' : ''}`);
}
