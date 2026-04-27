/**
 * Atualiza SEMARH 32/2024 (Assessoria — Limpeza/Conservação):
 * - orgao: CNPJ → nome oficial
 * - vigencia: datas precisas (26/12/2024 → 26/12/2026 após 1º TA)
 * - valor_mensal_bruto: R$ 37.516,00 (pós-reajuste 1ºTA, R$ 450.192,00/ano)
 * - ata_registro_precos: Adesão Pregão Eletrônico 084/2023 (DETRAN/TO)
 * - status: Ativo
 * - obs: histórico completo
 */
const Database = require('better-sqlite3');
const db = new Database('data/assessoria/montana.db');

db.prepare(`
  UPDATE contratos
  SET orgao = 'SECRETARIA DO MEIO AMBIENTE E RECURSOS HIDRICOS - SEMARH/TO',
      status = 'Ativo',
      vigencia_inicio = '2024-12-26',
      vigencia_fim = '2026-12-26',
      valor_mensal_bruto = 37516.00,
      ata_registro_precos = 'ADESÃO à ATA de Registro de Preços do Pregão Eletrônico nº 084/2023 (oriunda do DETRAN/TO — Processo 2022/32470/01078). Processo SEMARH 2024.39000.000133. (contratos/assessoria/semarh-32-2024/)',
      data_ultimo_reajuste = '2025-12-19',
      indice_reajuste = 'IPCA — Cláusula Décima Primeira (1º TA efeitos a partir 20/04/2025)',
      obs = 'Contrato 32/2024 — Limpeza/Conservação/Copa/Jardinagem/Controle de Pragas SEMARH/TO. Objeto original: 4 serventes + 1 artífice jardinagem + materiais sob demanda. Valor anual inicial R$ 353.655,36 (mensal ~R$ 29.471,28). 1º TERMO ADITIVO (19/12/2025, SGD 2025.39009.16029): prorrogação 12 meses (26/12/2025 a 26/12/2026) + repactuação IPCA efeitos retroativos 20/04/2025 (diferença acumulada fev-dez/2025: R$ 66.858,02). Novo valor anual: R$ 450.192,00 (mensal R$ 37.516,00). Assessoria representada por Felipe Mario Pinheiro Aguiar. PDFs: contratos/assessoria/semarh-32-2024/',
      updated_at = datetime('now')
  WHERE numContrato = 'SEMARH 32/2024'
`).run();

const r = db.prepare(`
  SELECT numContrato, valor_mensal_bruto, orgao, status, vigencia_inicio, vigencia_fim,
         ata_registro_precos, data_ultimo_reajuste, indice_reajuste
  FROM contratos WHERE numContrato = 'SEMARH 32/2024'
`).get();
console.log('SEMARH 32/2024 atualizado:');
console.log(JSON.stringify(r, null, 2));
db.close();
