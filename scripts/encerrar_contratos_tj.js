/**
 * Encerra contratos do Tribunal de Justiça (FUNJURIS/TJ)
 * - Assessoria: TJ 73/2020 e TJ 440/2024
 * - Segurança: contrato TJ (se existir)
 *
 * Define status='ENCERRADO' e vigencia_fim = data da última NF emitida.
 *
 * Uso:
 *   node scripts/encerrar_contratos_tj.js              # executa
 *   node scripts/encerrar_contratos_tj.js --dry-run    # apenas mostra
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const DRY_RUN = process.argv.includes('--dry-run');

function encerrarTJ(empresaKey, empresaNome) {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  ${empresaNome} (${empresaKey})`);
  console.log(`${'═'.repeat(50)}`);

  const db = getDb(empresaKey);

  // Buscar contratos do TJ por nome/contrato
  const contratos = db.prepare(`
    SELECT id, numContrato, contrato, orgao, status, vigencia_fim
    FROM contratos
    WHERE contrato LIKE '%TJ%'
       OR contrato LIKE '%FUNJURIS%'
       OR orgao LIKE '%FUNDO ESPECIAL%'
       OR orgao LIKE '%MODERNIZACAO%'
       OR orgao LIKE '%PODER JUDICIARIO%'
       OR orgao LIKE '%TRIBUNAL DE JUSTI%'
       OR contrato LIKE '%TRIBUNAL DE JUSTI%'
  `).all();

  if (contratos.length === 0) {
    console.log('  Nenhum contrato do TJ encontrado na tabela contratos.');

    // Verificar NFs do FUNDO ESPECIAL para referência
    const nfsTJ = db.prepare(`
      SELECT COUNT(*) n, MAX(data_emissao) ultima, MIN(data_emissao) primeira
      FROM notas_fiscais
      WHERE tomador LIKE '%FUNDO ESPECIAL%' OR tomador LIKE '%MODERNIZACAO%'
    `).get();

    if (nfsTJ.n > 0) {
      console.log(`  📋 NFs do FUNDO ESPECIAL/TJ: ${nfsTJ.n} (${nfsTJ.primeira} → ${nfsTJ.ultima})`);
    }
    return;
  }

  for (const c of contratos) {
    console.log(`\n  📄 Contrato: ${c.contrato || c.numContrato}`);
    console.log(`     Órgão: ${c.orgao || '(não informado)'}`);
    console.log(`     Status atual: ${c.status}`);
    console.log(`     Vigência fim: ${c.vigencia_fim || '(não definida)'}`);

    if (c.status === 'ENCERRADO') {
      console.log('     ✅ Já está encerrado. Pulando.');
      continue;
    }

    // Buscar última NF emitida para este contrato
    let ultimaNF = null;

    // Tenta pelo contrato_ref
    if (c.contrato || c.numContrato) {
      const ref = c.contrato || c.numContrato;
      ultimaNF = db.prepare(`
        SELECT MAX(data_emissao) dt FROM notas_fiscais WHERE contrato_ref = ?
      `).get(ref);
    }

    // Se não encontrou, tenta pelo tomador
    if (!ultimaNF?.dt) {
      ultimaNF = db.prepare(`
        SELECT MAX(data_emissao) dt FROM notas_fiscais
        WHERE tomador LIKE '%FUNDO ESPECIAL%' OR tomador LIKE '%MODERNIZACAO%'
      `).get();
    }

    const dataFim = ultimaNF?.dt || new Date().toISOString().slice(0, 10);
    console.log(`     Última NF: ${dataFim}`);

    if (DRY_RUN) {
      console.log(`     ⚠️  DRY RUN — seria encerrado com vigência_fim=${dataFim}`);
    } else {
      db.prepare(`
        UPDATE contratos SET status = 'ENCERRADO', vigencia_fim = ? WHERE id = ?
      `).run(dataFim, c.id);
      console.log(`     ✅ Encerrado! vigência_fim = ${dataFim}`);
    }
  }
}

// Rodar para as duas empresas
encerrarTJ('assessoria', 'Montana Assessoria');
encerrarTJ('seguranca', 'Montana Segurança');

console.log(`\n${'═'.repeat(50)}`);
console.log(DRY_RUN ? '  ⚠️  DRY RUN — nenhuma alteração feita' : '  ✅ Concluído');
console.log(`${'═'.repeat(50)}\n`);
