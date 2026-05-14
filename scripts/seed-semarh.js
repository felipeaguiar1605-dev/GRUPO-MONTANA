#!/usr/bin/env node
// Popula SEMARH — Secretaria do Meio Ambiente e Recursos Hídricos (estadual TO).
// Contrato 32/2024. ISS 5% retido, INSS 11%, IRRF 1,2%, sem ciclo (mês calendário).
const path = require('node:path');
process.chdir(path.join(__dirname, '..'));
require('dotenv').config();
const { getDb } = require('../src/db_pg');

const CONFIG = {
  contrato_ref: '32/2024',
  numero_contrato: '32/2024',
  orgao: 'SECRETARIA DO MEIO AMBIENTE E RECURSOS HIDRICOS - SEMARH',
  insc_municipal: '05016202000145',
  processo: '',
  pregao: '',
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
  irrf_aliquota: 0.012,
  pis_aliquota: 0,
  cofins_aliquota: 0,
  csll_aliquota: 0,
  ciclo_dia_inicio: null,  // mês calendário
  dados_bancarios: 'BANCO DO BRASIL\nAGENCIA No 1505-9\nCONTA CORRENTE No 109043-7.',
  template_discriminacao:
    'PRESTACAO DE SERVICOS NAS AREAS DE LIMPEZA, ASSEIO E CONSERVACAO, ' +
    'NAS INSTALACOES DA SECRETARIA DO MEIO AMBIENTE E RECURSOS HIDRICOS - ' +
    'SEMARH. CONSIDERANDO OS SERVICOS DE JARDINAGEM E SERVICOS GERAIS. ' +
    'CONFORME CONTRATO No {CONTRATO}. ' +
    'REFERENTE AO MES DE {MES_FIM} DE {ANO_FIM}.',
};

(async () => {
  const db = getDb('assessoria');
  const c = await db.prepare(`SELECT id, nome FROM bol_contratos WHERE nome ILIKE '%SEMARH%' LIMIT 1`).get();
  if (!c) { console.error('SEMARH não encontrado'); process.exit(2); }
  const fields = Object.entries(CONFIG);
  const setSql = fields.map(([k]) => `${k}=?`).join(', ');
  const setVals = fields.map(([_, v]) => v);
  await db.prepare(`UPDATE bol_contratos SET ${setSql}, updated_at=NOW() WHERE id=?`).run(...setVals, c.id);
  console.log(`✓ id=${c.id} ${c.nome} → ${fields.length} campos`);

  // Posto SEMARH é em Palmas
  const postos = await db.prepare(`SELECT id, campus_nome, municipio FROM bol_postos WHERE contrato_id=?`).all(c.id);
  for (const p of postos) {
    await db.prepare(`UPDATE bol_postos SET codigo_municipio_ibge='1721000' WHERE id=?`).run(p.id);
    console.log(`  posto ${p.id} ${p.campus_nome} → IBGE 1721000 (Palmas)`);
  }
})().catch(e => { console.error(e); process.exit(1); });
