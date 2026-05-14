#!/usr/bin/env node
// Cria contrato "UFNT — Motoristas e Tratoristas" espelhando os postos de UFNT Limpeza.
// Aplica config multi-contrato (item 1705, CNAE 7820500, NBS 118012100, IN 1234, ciclo 5→4).
const path = require('node:path');
process.chdir(path.join(__dirname, '..'));
require('dotenv').config();
const { getDb } = require('../src/db_pg');

const IBGE_TO = {
  'araguaina': '1702109', 'araguaína': '1702109',
  'tocantinopolis': '1721208', 'tocantinópolis': '1721208',
};
function normalize(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\/.*$/, '').trim();
}

(async () => {
  const db = getDb('assessoria');

  // 1) Verifica se já existe
  const existente = await db.prepare(
    `SELECT id FROM bol_contratos WHERE nome ILIKE '%UFNT%motorista%' LIMIT 1`
  ).get();
  if (existente) {
    console.log(`⚠ Já existe: id=${existente.id}. Use seed-contratos-multi.js pra atualizar config.`);
    process.exit(0);
  }

  // 2) Lê postos do UFNT Limpeza pra replicar
  const liso = await db.prepare(`SELECT id FROM bol_contratos WHERE nome ILIKE '%UFNT%limpeza%' LIMIT 1`).get();
  if (!liso) { console.error('UFNT Limpeza não encontrado'); process.exit(2); }
  const postos = await db.prepare(`SELECT campus_key, campus_nome, municipio, descricao_posto, label_resumo, ordem FROM bol_postos WHERE contrato_id=? ORDER BY ordem`).all(liso.id);
  console.log(`UFNT Limpeza (id=${liso.id}) tem ${postos.length} postos pra replicar`);

  // 3) Cria contrato UFNT Motoristas com config completa
  const r = await db.prepare(`INSERT INTO bol_contratos (
    nome, contratante, ativo,
    contrato_ref, numero_contrato, orgao, insc_municipal,
    processo, pregao,
    item_lista_servico, codigo_tributacao_municipal, codigo_cnae, codigo_nbs,
    aliquota_iss_padrao, iss_retido_padrao,
    optante_simples_nacional, incentivo_fiscal,
    inss_aliquota, inss_base_reduzida, irrf_aliquota,
    pis_aliquota, cofins_aliquota, csll_aliquota,
    ciclo_dia_inicio, dados_bancarios, template_discriminacao,
    descricao_servico, escala
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`).run(
    'UFNT — Motoristas e Tratoristas',
    'UNIVERSIDADE FEDERAL DO NORTE DO TOCANTINS - UFNT',
    1,
    '10/2022', '10/2022',
    'UNIVERSIDADE FEDERAL DO NORTE DO TOCANTINS - UFNT',
    '38178825000173',
    '23101.004080/2022-53', '10/2022',
    '1705', '1705', '7820500', '118012100',
    0.05, true,
    2, 2,
    0.11, false, 0.012,
    0.0065, 0.03, 0.01,
    5, 'BANCO DO BRASIL\nAGENCIA No 1505-9\nCONTA CORRENTE No 109043-7.',
    'CONTRATACAO DE PESSOA JURIDICA ESPECIALIZADA NA PRESTACAO DE SERVICOS ' +
    'DE APOIO ADMINISTRATIVO, TECNICO E OPERACIONAL, COM DEDICACAO EXCLUSIVA ' +
    'DE MAO DE OBRA, FORNECIMENTO INTEGRAL DE FERRAMENTAS, ACESSORIOS, ' +
    'IMPLEMENTOS, EQUIPAMENTOS E MAQUINARIOS NECESSARIOS A UNIVERSIDADE ' +
    'FEDERAL DO NORTE DO TOCANTINS/{CIDADE} CCS. ' +
    'PROCESSO No {PROCESSO} - PREGAO ELETRONICO: {PREGAO}. ' +
    'NO PERIODO DE {DIA_INI} DE {MES_INI} DE {ANO_INI} A ' +
    '{DIA_FIM} DE {MES_FIM} DE {ANO_FIM}.',
    'MOTORISTAS E TRATORISTAS', 'CONFORME CONTRATO'
  );
  const novoId = r.lastInsertRowid;
  console.log(`✓ Contrato UFNT Motoristas criado: id=${novoId}`);

  // 4) Replica postos
  for (const p of postos) {
    const ibge = IBGE_TO[normalize(p.municipio || p.campus_nome)] || null;
    await db.prepare(`INSERT INTO bol_postos (
      contrato_id, campus_key, campus_nome, municipio, descricao_posto, label_resumo, ordem, codigo_municipio_ibge
    ) VALUES (?,?,?,?,?,?,?,?)`).run(
      novoId,
      p.campus_key, p.campus_nome, p.municipio, p.descricao_posto, p.label_resumo, p.ordem,
      ibge
    );
    console.log(`  ✓ posto: ${p.campus_nome} (${p.municipio}) [IBGE ${ibge||'?'}]`);
  }

  console.log(`\nDONE — contrato_id=${novoId} com ${postos.length} postos.`);
  console.log('Próximo: cadastrar itens em cada posto (qtd × valor unitário) pelo painel.');
})().catch(e => { console.error(e); process.exit(1); });
