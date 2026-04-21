/**
 * Cadastra contrato TCE 26/2025 — Assessoria
 * Fonte: CONTRATO 26-2025 TCE.pdf (ZIP Semear)
 *
 * Contratação EMERGENCIAL de serviços continuados (limpeza, manutenção,
 * copeiragem, garçom, jardinagem, recepção, portaria) para os 3 edifícios TCE/TO.
 * Portaria de Dispensa nº 23/2025 — Processo SEI 25.003983-4.
 * CNPJ TCE: 25.053.133/0001-57 | Valor anual R$ 4.307.319,96 (mensal ~R$ 358.943,33)
 * 65 postos totais (30 servente limpeza, 5 ?, 8 copeira, 4 garçom, 6 porteiro,
 *  4 manutenção, 2 encarregado, 4 recepcionista, 2 jardineiro).
 */
const Database = require('better-sqlite3');
const db = new Database('data/assessoria/montana.db');

const VALOR_ANUAL = 4307319.96;
const VALOR_MENSAL = +(VALOR_ANUAL / 12).toFixed(2); // 358943.33

const numContrato = 'TCE 26/2025';

// Verifica se já existe
const ex = db.prepare('SELECT numContrato FROM contratos WHERE numContrato = ?').get(numContrato);
if (ex) {
  console.log('⚠ Já existe contrato', numContrato, '— não vou sobrescrever.');
  console.log('Para atualizar, rode um script UPDATE específico.');
  db.close();
  process.exit(0);
}

const stmt = db.prepare(`
  INSERT INTO contratos (
    numContrato, contrato, orgao, valor_mensal_bruto, status,
    vigencia_inicio, vigencia_fim,
    ata_registro_precos, obs, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
`);

const r = stmt.run(
  numContrato,
  numContrato,  // campo 'contrato' (NOT NULL) — mesmo valor de numContrato
  'TRIBUNAL DE CONTAS DO ESTADO DO TOCANTINS - TCE/TO',
  VALOR_MENSAL,
  'EMERGENCIAL',
  '',  // vigência início (não parseada do PDF ainda)
  '',  // vigência fim (contrato emergencial — tipicamente 180d)
  'Portaria de Dispensa nº 23/2025 — Processo SEI 25.003983-4 (contratação emergencial Lei 14.133/2021)',
  `Contrato 26/2025 TCE/TO — Emergencial. CNPJ tomador: 25.053.133/0001-57. Valor anual R$ ${VALOR_ANUAL.toLocaleString('pt-BR',{minimumFractionDigits:2})}; mensal R$ ${VALOR_MENSAL.toLocaleString('pt-BR',{minimumFractionDigits:2})}. 65 postos: 30 serventes de limpeza, 5 manutenção (auxiliares), 8 copeiras, 4 garçons, 6 porteiros, 4 manutenção, 2 encarregados, 4 recepcionistas, 2 jardineiros. Objeto: limpeza + copeiragem + garçom + jardinagem + recepção + portaria + manutenção predial para os 3 edifícios do TCE. PDFs: contratos/assessoria/tce-26-2025/`
);

console.log('✓ Contrato inserido (id=' + r.lastInsertRowid + '):', numContrato);
console.log('  Valor mensal bruto:', 'R$', VALOR_MENSAL.toLocaleString('pt-BR',{minimumFractionDigits:2}));
console.log('  Valor anual:', 'R$', VALOR_ANUAL.toLocaleString('pt-BR',{minimumFractionDigits:2}));

db.close();
