#!/usr/bin/env node
// Popula SEDUC — Secretaria da Educação (estadual TO).
// ISS 5% retido. INSS 11% sobre BASE REDUZIDA 50% (= 5,5% efetivo sobre bruto).
// IRRF 1,2%. Sem PIS/COFINS/CSLL. Mês calendário.
//
// ⚠ ATENÇÃO: o uso de "base reduzida 50%" pra SEDUC é distinto do INSS-base
// reduzida da UFT (que subtrai vale-alimentação/materiais). Aqui é literalmente
// 50% do valor bruto. Pra modelar isso sem mudar o schema:
//   - Marcamos inss_base_reduzida=true
//   - No posto SEDUC, setamos deducao_materiais = valor_efetivo × 0.5
//
// Como o valor varia por boletim, deixamos o operador setar a dedução
// manualmente no posto antes de gerar. Por ora, uso inss_aliquota=0.055
// (já calculado: 11% × 50% = 5,5%) com base_reduzida=false. Operador
// pode trocar pra 0.11 + ded 50% se preferir o cálculo explícito.
const path = require('node:path');
process.chdir(path.join(__dirname, '..'));
require('dotenv').config();
const { getDb } = require('../src/db_pg');

const CONFIG = {
  contrato_ref: '',  // não informado nos XMLs
  numero_contrato: '',
  orgao: 'TOCANTINS SECRETARIA DA EDUCACAO, JUVENTUDE E ESPORTES',
  insc_municipal: '25053083000130',
  processo: '2023/27000/000120',
  pregao: '',
  item_lista_servico: '0710',
  codigo_tributacao_municipal: '0710',
  codigo_cnae: '8111700',
  codigo_nbs: '118031000',
  aliquota_iss_padrao: 0.05,
  iss_retido_padrao: true,
  optante_simples_nacional: 2,
  incentivo_fiscal: 2,
  inss_aliquota: 0.055,  // 11% × 50% (base reduzida — uso efetivo aqui)
  inss_base_reduzida: false,
  irrf_aliquota: 0.012,
  pis_aliquota: 0,
  cofins_aliquota: 0,
  csll_aliquota: 0,
  ciclo_dia_inicio: null,
  dados_bancarios: 'BANCO DO BRASIL\nAGENCIA No 1505-9\nCONTA CORRENTE No 109043-7.',
  template_discriminacao:
    'PRESTACAO DE SERVICOS DE COPEIRAGEM, LIMPEZA, CONSERVACAO, ' +
    'HIGIENIZACAO E JARDINAGEM, COM FORNECIMENTO DE MATERIAIS E PRODUTOS ' +
    'DE CONSUMO APROPRIADOS, MAQUINAS E EQUIPAMENTOS A SEREM PRESTADOS NAS ' +
    'DEPENDENCIAS INTERNAS E EXTERNAS DA SECRETARIA DA EDUCACAO, JUVENTUDE ' +
    'E ESPORTES E ANEXOS. PROCESSO No {PROCESSO}. ' +
    'REFERENTE AO MES DE {MES_FIM} DE {ANO_FIM}. ' +
    'INSS 50% (BASE REDUZIDA).',
};

(async () => {
  const db = getDb('assessoria');
  const c = await db.prepare(`SELECT id, nome FROM bol_contratos WHERE nome ILIKE '%SEDUC%' LIMIT 1`).get();
  if (!c) { console.error('SEDUC não encontrado'); process.exit(2); }
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
