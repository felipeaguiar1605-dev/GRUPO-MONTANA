'use strict';
/**
 * Gera SQL com UPDATEs de discriminação preenchidos localmente
 * para aplicar em produção sem sobrescrever o banco.
 *
 * Saída: arquivo .sql por empresa em scripts/_out/
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const OUT_DIR = path.join(__dirname, '_out');
fs.mkdirSync(OUT_DIR, { recursive: true });

function escapeSql(s) {
  return String(s).replace(/'/g, "''");
}

function gerar(empresa) {
  const db = getDb(empresa);
  const nfs = db.prepare(`
    SELECT numero, discriminacao
    FROM notas_fiscais
    WHERE discriminacao IS NOT NULL AND TRIM(discriminacao) <> ''
  `).all();

  const lines = [
    `-- ${empresa}: ${nfs.length} NFs com discriminação preenchida`,
    `BEGIN TRANSACTION;`,
  ];
  for (const nf of nfs) {
    lines.push(
      `UPDATE notas_fiscais SET discriminacao='${escapeSql(nf.discriminacao)}' ` +
      `WHERE numero='${escapeSql(nf.numero)}' AND (discriminacao IS NULL OR TRIM(discriminacao)='');`
    );
  }
  lines.push(`COMMIT;`);

  const file = path.join(OUT_DIR, `discriminacao_${empresa}.sql`);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  console.log(`  ✓ ${empresa}: ${nfs.length} UPDATEs gerados → ${file}`);
}

console.log('Gerando SQL de sincronização de discriminação...\n');
['assessoria', 'seguranca'].forEach(gerar);
console.log('\n✔️  Pronto.');
