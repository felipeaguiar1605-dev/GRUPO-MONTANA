/**
 * Corrige e renomeia "SECCIDADES — encerrado" → "SEPLAD 002/2024 — encerrado" (Assessoria)
 * Contrato veio de ADESÃO à ATA 03/2023 SEDUC (copeiragem).
 *
 * Dados do PDF (CONTRATO 002/2024 — Processo 2023063834):
 * - Órgão: Secretaria Municipal de Planejamento e Desenvolvimento Humano - SEPLAD/PALMAS
 * - CNPJ: 24.851.511/0001-85
 * - Vigência: 26/02/2024 → 26/02/2025
 * - Valor mensal: R$ 77.702,70 | Valor anual: R$ 932.432,48
 * - Objeto: copeiragem, limpeza, conservação, jardinagem (20 postos: 1 jardineiro + 6 copeiros + 12 serventes + 1 encarregado)
 *
 * Atualiza também parcelas (6 linhas) e bol_contratos (id=12).
 */
const Database = require('better-sqlite3');
const db = new Database('data/assessoria/montana.db');

const OLD_NAME = 'SECCIDADES — encerrado';
const NEW_NAME = 'SEPLAD 002/2024 — encerrado';

// Desliga FKs temporariamente para permitir atualizar PK-like contratos.numContrato
db.pragma('foreign_keys = OFF');

// 1. Atualiza contrato principal
const upContrato = db.prepare(`
  UPDATE contratos
  SET numContrato = ?,
      orgao = 'SECRETARIA MUNICIPAL DE PLANEJAMENTO E DESENVOLVIMENTO HUMANO - SEPLAD/PALMAS',
      status = 'Encerrado',
      vigencia_inicio = '2024-02-26',
      vigencia_fim = '2025-02-26',
      valor_mensal_bruto = 77702.70,
      ata_registro_precos = 'ADESÃO à ATA de Registro de Preços nº 03/2023 (SEDUC - Pregão Eletrônico 03/2023 - Copeiragem/Limpeza). Processo SEPLAD 2023063834. (contratos/assessoria/seplad-002-2024/)',
      obs = 'Contrato 002/2024 SEPLAD-Palmas (ENCERRADO em 26/02/2025). Adesão à ATA 03/2023 SEDUC. Objeto: copeiragem + limpeza + jardinagem + encarregado (20 postos totais: 1 jardineiro + 6 copeiros + 12 serventes + 1 encarregado). Valor mensal R$ 77.702,70 (R$ 932.432,48/ano). CNPJ tomador: 24.851.511/0001-85. ATENÇÃO: NFs para este contrato foram historicamente registradas com contrato_ref = "PREFEITURA 062/2024" (mislabel) — verificar e reclassificar NFs com valor_bruto = 77702,70 e CNPJ 24.851.511. PDFs: contratos/assessoria/seplad-002-2024/',
      updated_at = datetime('now')
  WHERE numContrato = ?
`).run(NEW_NAME, OLD_NAME);
console.log('Contrato atualizado:', upContrato.changes, 'linha(s)');

// 2. Atualiza parcelas
const upParcelas = db.prepare(`UPDATE parcelas SET contrato_num = ? WHERE contrato_num = ?`).run(NEW_NAME, OLD_NAME);
console.log('Parcelas atualizadas:', upParcelas.changes, 'linha(s)');

// 3. Atualiza bol_contratos (id=12: SEPLAD/2022 → SEPLAD 002/2024)
const upBol = db.prepare(`
  UPDATE bol_contratos
  SET numero_contrato = 'SEPLAD 002/2024',
      contratante = 'SECRETARIA MUNICIPAL DE PLANEJAMENTO E DESENVOLVIMENTO HUMANO - SEPLAD/PALMAS',
      processo = '2023063834',
      pregao = 'Adesão à ATA 03/2023 SEDUC (PE 03/2023)',
      descricao_servico = 'Copeiragem, Limpeza, Conservação, Higienização, Jardinagem e Encarregado — ENCERRADO 26/02/2025',
      updated_at = datetime('now')
  WHERE id = 12
`).run();
console.log('bol_contratos atualizado:', upBol.changes, 'linha(s)');

// Verificação
const r = db.prepare(`
  SELECT numContrato, valor_mensal_bruto, orgao, status, vigencia_inicio, vigencia_fim
  FROM contratos WHERE numContrato = ?
`).get(NEW_NAME);
console.log('\nContrato após update:');
console.log(JSON.stringify(r, null, 2));

const pc = db.prepare(`SELECT contrato_num, COUNT(*) n FROM parcelas WHERE contrato_num = ? GROUP BY contrato_num`).all(NEW_NAME);
console.log('\nParcelas após update:', pc);

db.pragma('foreign_keys = ON');
db.close();
