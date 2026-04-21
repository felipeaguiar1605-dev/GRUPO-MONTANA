/**
 * Atualiza SEPLAD 002/2024 — documenta que houve SUB-ROGAÇÃO SEPLAN → SECAD
 * (descoberto via ZIP Semear: "TERMO ADITIVO Nº 01 DE SUB-ROGAÇÃO. MONTANA_SEPLAN - SECAD.pdf")
 *
 * O aditivo transfere competência processual da Secretaria Municipal de
 * Planejamento (CNPJ 24.851.511/0022-00) para a Secretaria Municipal de
 * Administração e Modernização - SECAD (CNPJ 24.851.511/0045-04).
 * O contrato original (nº 002/2024) permanece o mesmo — processo 2023063834.
 */
const Database = require('better-sqlite3');
const db = new Database('data/assessoria/montana.db');

const numContrato = 'SEPLAD 002/2024 — encerrado';

const obsNova = `Contrato 002/2024 SEPLAD-Palmas (ENCERRADO 26/02/2025). Adesão à ATA 03/2023 SEDUC (PE 03/2023). Objeto: copeiragem + limpeza + jardinagem + encarregado (20 postos: 1 jardineiro + 6 copeiros + 12 serventes + 1 encarregado). Valor mensal R$ 77.702,70 (R$ 932.432,48/ano). CNPJ tomador raiz: 24.851.511/0001-85.

SUB-ROGAÇÃO (Termo Aditivo nº 01): competência processual transferida da SEPLAN (CNPJ 24.851.511/0022-00) para a SECAD - Secretaria Municipal de Administração e Modernização (CNPJ 24.851.511/0045-04) via Medida Provisória nº 01/2025. Contrato original 002/2024 ratificado nas demais cláusulas.

ATENÇÃO: NFs com contrato_ref = "PREFEITURA 062/2024" e valor_bruto = 77702,70 e CNPJ 24.851.511 pertencem a este contrato (mislabel). Verificar e reclassificar.

PDFs: contratos/assessoria/seplad-002-2024/`;

const r = db.prepare(`
  UPDATE contratos
  SET obs = ?,
      updated_at = datetime('now')
  WHERE numContrato = ?
`).run(obsNova, numContrato);

console.log('✓ SEPLAD atualizado:', r.changes, 'linha(s)');

// Print atual
const c = db.prepare(`SELECT numContrato, orgao, status, vigencia_inicio, vigencia_fim, valor_mensal_bruto FROM contratos WHERE numContrato = ?`).get(numContrato);
console.log(JSON.stringify(c, null, 2));

db.close();
