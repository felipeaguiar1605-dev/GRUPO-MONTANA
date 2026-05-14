#!/usr/bin/env node
// Popula PREVI Palmas — Instituto de Previdência Social do Município de Palmas.
// Autarquia MUNICIPAL. ISS 5% retido (Palmas substituto). INSS 11%. IRRF 4,80%
// (atípico — não é 1,2% como os outros estaduais; ver discriminação da NF).
// Sem PIS/COFINS/CSLL. Mês calendário.
//
// ⚠ A alíquota IRRF de 4,80% observada nos XMLs (R$ 935,86 sobre R$ 19.497,03
// na NF 38 jan/2026) é a tabela pra "locação de mão de obra" da IN 1234,
// não 1,2% de "serviços em geral". Confirmar com contador antes de emitir.
const path = require('node:path');
process.chdir(path.join(__dirname, '..'));
require('dotenv').config();
const { getDb } = require('../src/db_pg');

const CONFIG = {
  contrato_ref: '03/2024',
  numero_contrato: '03/2024',
  orgao: 'INSTITUTO DE PREVIDENCIA SOCIAL DO MUNICIPIO DE PALMAS - PREVIPALMAS',
  insc_municipal: '05278848000194',
  processo: '',
  pregao: '03/2023',
  item_lista_servico: '0710',
  codigo_tributacao_municipal: '0710',
  codigo_cnae: '8111700',
  codigo_nbs: '118031000',
  aliquota_iss_padrao: 0.05,
  iss_retido_padrao: true,
  optante_simples_nacional: 2,
  incentivo_fiscal: 2,
  inss_aliquota: 0.11,
  inss_base_reduzida: false,
  irrf_aliquota: 0.048,  // 4,80% — atípico (locação MdO)
  pis_aliquota: 0,
  cofins_aliquota: 0,
  csll_aliquota: 0,
  ciclo_dia_inicio: null,
  dados_bancarios: 'BANCO DO BRASIL\nAGENCIA No 1505-9\nCONTA CORRENTE No 109043-7.',
  template_discriminacao:
    'PRESTACAO DE SERVICOS CONTINUADOS NAS AREAS DE LIMPEZA, ASSEIO E ' +
    'CONSERVACAO, NAS INSTALACOES DO INSTITUTO DE PREVIDENCIA SOCIAL DO ' +
    'MUNICIPIO DE PALMAS - TO. CONSIDERANDO OS SERVICOS DE COPEIRAGEM, ' +
    'JARDINAGEM E SERVICOS GERAIS. COM FORNECIMENTO DE TODO MATERIAL E ' +
    'EQUIPAMENTOS QUE SE FIZEREM NECESSARIOS A EXECUCAO DOS SERVICOS. ' +
    'CONFORME O PREGAO ELETRONICO No {PREGAO}, CONTRATO {CONTRATO}. ' +
    'REFERENTE AO MES DE {MES_FIM} DE {ANO_FIM}.',
};

(async () => {
  const db = getDb('assessoria');
  const c = await db.prepare(`SELECT id, nome FROM bol_contratos WHERE nome ILIKE '%PREVI%PALMAS%' LIMIT 1`).get();
  if (!c) { console.error('PREVI PALMAS não encontrado'); process.exit(2); }
  const fields = Object.entries(CONFIG);
  const setSql = fields.map(([k]) => `${k}=?`).join(', ');
  const setVals = fields.map(([_, v]) => v);
  await db.prepare(`UPDATE bol_contratos SET ${setSql}, updated_at=NOW() WHERE id=?`).run(...setVals, c.id);
  console.log(`✓ id=${c.id} ${c.nome} → ${fields.length} campos`);

  const postos = await db.prepare(`SELECT id, campus_nome, municipio FROM bol_postos WHERE contrato_id=?`).all(c.id);
  for (const p of postos) {
    await db.prepare(`UPDATE bol_postos SET codigo_municipio_ibge='1721000' WHERE id=?`).run(p.id);
    console.log(`  posto ${p.id} ${p.campus_nome} → IBGE 1721000 (Palmas)`);
  }
})().catch(e => { console.error(e); process.exit(1); });
