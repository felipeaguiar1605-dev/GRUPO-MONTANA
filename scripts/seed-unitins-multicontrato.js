#!/usr/bin/env node
/**
 * Popula a configuração multi-contrato para UNITINS (assessoria).
 *
 * - bol_contratos.id=10 (UNITINS Limpeza/Copeiragem/Jardinagem) ganha:
 *   processo, pregão, item_lista, CNAE, NBS, alíquotas (ISS 5% retido, INSS 11%,
 *   IRRF 1,2%), ciclo 14→13, dados bancários, template discriminação.
 *
 * - 9 postos de bol_postos ganham codigo_municipio_ibge (Araguaína 1702109,
 *   Palmas 1721000, etc.).
 *
 * Não emite NFs. Pode ser rodado várias vezes (UPDATE idempotente).
 *
 * Uso: node scripts/seed-unitins-multicontrato.js
 */
const path = require('node:path');
process.chdir(path.join(__dirname, '..'));
require('dotenv').config();

const { getDb } = require('../src/db_pg');

const UNITINS_CONFIG = {
  // Identificação
  contrato_ref: '022/2022',
  numero_contrato: '022/2022',
  insc_municipal: '01637536000185',   // CNPJ tomador UNITINS (sem formatação — vai pro WebISS)
  orgao: 'UNIVERSIDADE ESTADUAL DO TOCANTINS - UNITINS',
  processo: '2022/20321/000361',
  pregao: '009/2022',
  // Item de serviço (limpeza/copeiragem/jardinagem)
  item_lista_servico: '0710',
  codigo_tributacao_municipal: '0710',
  codigo_cnae: '8111700',
  codigo_nbs: '118031000',
  // Fiscal
  aliquota_iss_padrao: 0.05,
  iss_retido_padrao: true,
  optante_simples_nacional: 2,
  incentivo_fiscal: 2,
  inss_aliquota: 0.11,
  inss_base_reduzida: false,
  irrf_aliquota: 0.012,
  pis_aliquota: 0,    // UNITINS estadual: federais não retidos
  cofins_aliquota: 0,
  csll_aliquota: 0,
  // Ciclo de faturamento: 14/M-1 → 13/M
  ciclo_dia_inicio: 14,
  // Dados bancários (entram no rodapé da discriminação)
  dados_bancarios: 'BANCO DO BRASIL\nAGENCIA No 1505-9\nCONTA CORRENTE No 109043-7.',
  // Template (placeholders: {DIA_INI}, {MES_INI}, {ANO_INI}, etc.)
  template_discriminacao:
    'PRESTACAO DE SERVICOS CONTINUADOS DE LIMPEZA, ASSEIO E CONSERVACAO, ' +
    'COPEIRAGEM E JARDINAGEM NAS INSTALACOES DA UNIVERSIDADE ESTADUAL DO ' +
    'TOCANTINS. CONSIDERANDO SERVENTES DE LIMPEZA, COPEIRAS, JARDINEIROS ' +
    'E ENCARREGADOS. COM FORNECIMENTO DE TODO MATERIAL, INSUMOS E ' +
    'EQUIPAMENTOS QUE SE FIZEREM NECESSARIOS A EXECUCAO DOS SERVICOS. ' +
    'CONFORME CONTRATO: {CONTRATO}, PROCESSO No {PROCESSO}, ' +
    'PREGAO ELETRONICO: {PREGAO} - REFERENTE AO PERIODO DE ' +
    '{DIA_INI} DE {MES_INI} DE {ANO_INI} A ' +
    '{DIA_FIM} DE {MES_FIM} DE {ANO_FIM}.',
};

// Códigos IBGE TO para postos UNITINS (coletados em webiss_palmas.md)
const POSTOS_IBGE = {
  'araguatins': '1702208',
  'araguaina': '1702109',
  'augustinopolis': '1702604',
  'augustinópolis': '1702604',
  'dianopolis': '1707009',
  'dianópolis': '1707009',
  'formoso do araguaia': '1708205',
  'gurupi': '1709500',
  'palmas': '1721000',
  'paraiso do tocantins': '1716109',
  'paraíso do tocantins': '1716109',
  'paraiso do to': '1716109',
  'paraíso do to': '1716109',
  'porto nacional': '1718204',
};

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\/.*$/, '').trim();
}

async function seedAssessoria() {
  const db = getDb('assessoria');

  // 1) Acha UNITINS
  const unitins = await db.prepare(
    `SELECT id, nome FROM bol_contratos WHERE nome ILIKE '%UNITINS%' LIMIT 1`
  ).get();
  if (!unitins) {
    console.error('UNITINS não encontrado em bol_contratos (assessoria)');
    process.exit(2);
  }
  console.log(`Achei UNITINS id=${unitins.id} (${unitins.nome})`);

  // 2) Update do contrato
  const fields = Object.entries(UNITINS_CONFIG);
  const setSql = fields.map(([k]) => `${k}=?`).join(', ');
  const setVals = fields.map(([_, v]) => v);
  await db.prepare(`UPDATE bol_contratos SET ${setSql}, updated_at=NOW() WHERE id=?`).run(...setVals, unitins.id);
  console.log(`UPDATE bol_contratos id=${unitins.id} (${fields.length} campos)`);

  // 3) Postos
  const postos = await db.prepare(
    `SELECT id, campus_nome, municipio FROM bol_postos WHERE contrato_id=? ORDER BY ordem`
  ).all(unitins.id);
  console.log(`Postos UNITINS encontrados: ${postos.length}`);

  let acertos = 0, faltas = 0;
  for (const p of postos) {
    const key = normalize(p.municipio || p.campus_nome);
    const ibge = POSTOS_IBGE[key];
    if (!ibge) {
      console.warn(`  ⚠ posto ${p.id} (${p.campus_nome}, mun=${p.municipio}) — sem IBGE no mapping (key="${key}")`);
      faltas++;
      continue;
    }
    await db.prepare(
      `UPDATE bol_postos SET codigo_municipio_ibge=? WHERE id=?`
    ).run(ibge, p.id);
    console.log(`  OK posto ${p.id} ${p.campus_nome} → IBGE ${ibge}`);
    acertos++;
  }
  console.log(`\nResumo: ${acertos} postos com IBGE | ${faltas} sem`);
}

seedAssessoria().catch(e => { console.error(e); process.exit(1); });
