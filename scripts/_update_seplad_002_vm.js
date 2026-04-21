/**
 * Versão VM: na VM o contrato já tem numContrato = 'SEPLAD 002/2024' (sem " — encerrado").
 * Atualiza campos e renomeia para 'SEPLAD 002/2024 — encerrado' (igual ao local).
 */
const Database = require('better-sqlite3');
const db = new Database('data/assessoria/montana.db');

const OLD_NAME_VM = 'SEPLAD 002/2024';
const NEW_NAME = 'SEPLAD 002/2024 — encerrado';

db.pragma('foreign_keys = OFF');

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
`).run(NEW_NAME, OLD_NAME_VM);
console.log('Contrato atualizado:', upContrato.changes, 'linha(s)');

// Atualiza parcelas (caso existam com nome antigo)
const upParcelas = db.prepare(`UPDATE parcelas SET contrato_num = ? WHERE contrato_num IN (?, 'SECCIDADES — encerrado')`).run(NEW_NAME, OLD_NAME_VM);
console.log('Parcelas atualizadas:', upParcelas.changes, 'linha(s)');

// Atualiza bol_contratos (id=12 provavelmente, ou match por numero_contrato antigo)
const upBol = db.prepare(`
  UPDATE bol_contratos
  SET numero_contrato = 'SEPLAD 002/2024',
      contratante = 'SECRETARIA MUNICIPAL DE PLANEJAMENTO E DESENVOLVIMENTO HUMANO - SEPLAD/PALMAS',
      processo = '2023063834',
      pregao = 'Adesão à ATA 03/2023 SEDUC (PE 03/2023)',
      descricao_servico = 'Copeiragem, Limpeza, Conservação, Higienização, Jardinagem e Encarregado — ENCERRADO 26/02/2025',
      updated_at = datetime('now')
  WHERE numero_contrato IN ('SEPLAD/2022', 'SEPLAD 002/2024') OR nome LIKE '%SEPLAD%'
`).run();
console.log('bol_contratos atualizado:', upBol.changes, 'linha(s)');

const r = db.prepare(`SELECT numContrato, valor_mensal_bruto, orgao, status, vigencia_inicio, vigencia_fim FROM contratos WHERE numContrato = ?`).get(NEW_NAME);
console.log('\nContrato após update (VM):');
console.log(JSON.stringify(r, null, 2));

db.pragma('foreign_keys = ON');
db.close();
