#!/usr/bin/env node
/**
 * Popula a configuração multi-contrato pra todos os principais contratos da
 * Assessoria que já têm boletins-por-posto cadastrados.
 *
 * Cobertura nesta versão:
 *   - UFT - Limpeza e ATOP            (id contém "UFT" + "limpeza|atop")
 *   - UFT - Motoristas e Tratoristas  (id contém "UFT" + "motorista|tratorista")
 *   - UFNT - Limpeza e ATOP           (id contém "UFNT")
 *   - DETRAN/TO                       (id contém "DETRAN")
 *   - SESAU                            (id contém "SESAU")
 *
 * NÃO toca em UNITINS (já populado por seed-unitins-multicontrato.js) nem em
 * SEMARH/SEDUC/PREVI (casos especiais — emissão pontual, não recorrente).
 *
 * Idempotente. Pode rodar várias vezes.
 *
 * Uso: node scripts/seed-contratos-multi.js
 */
const path = require('node:path');
process.chdir(path.join(__dirname, '..'));
require('dotenv').config();

const { getDb } = require('../src/db_pg');

// ─── Configs por contrato ─────────────────────────────────────
// Match pelo nome do contrato em bol_contratos.nome (ILIKE)

const TEMPLATE_UFT_LIMPEZA =
  'CONTRATACAO DE PESSOA JURIDICA ESPECIALIZADA NA PRESTACAO DE SERVICOS ' +
  'CONTINUADOS DE LIMPEZA, ASSEIO E CONSERVACAO INTERNA E EXTERNA, ' +
  'FORNECIMENTO INTEGRAL DE MATERIAIS DE CONSUMO, INSUMOS, IMPLEMENTOS, ' +
  'EQUIPAMENTOS E MAQUINARIOS NECESSARIOS A UNIVERSIDADE FEDERAL DO ' +
  'TOCANTINS. NO PERIODO DE {DIA_INI} DE {MES_INI} DE {ANO_INI} A ' +
  '{DIA_FIM} DE {MES_FIM} DE {ANO_FIM}. ' +
  'PROCESSO No {PROCESSO} - PREGAO ELETRONICO: {PREGAO}.';

const TEMPLATE_UFT_MOTORISTAS =
  'PRESTACAO DE SERVICOS DE ENCARREGADOS, MOTORISTAS, MOTOCICLISTAS E ' +
  'TRATORISTAS PARA A FUNDACAO UNIVERSIDADE FEDERAL DO TOCANTINS NO ' +
  'CAMPUS UFT EM {CIDADE}, PREGAO ELETRONICO No {PREGAO}, ' +
  'PROCESSO No {PROCESSO}. CONTRATO No {CONTRATO}. ' +
  'REFERENTE AO PERIODO DE {DIA_INI}/{MES_INI}/{ANO_INI} A ' +
  '{DIA_FIM}/{MES_FIM}/{ANO_FIM}.';

const TEMPLATE_UFNT_LIMPEZA =
  'CONTRATACAO DE PESSOA JURIDICA ESPECIALIZADA NA PRESTACAO DE SERVICOS ' +
  'CONTINUADOS DE LIMPEZA, ASSEIO E CONSERVACAO INTERNA E EXTERNA, ' +
  'FORNECIMENTO INTEGRAL DE MATERIAIS DE CONSUMO, INSUMOS, FERRAMENTAS, ' +
  'ACESSORIOS, IMPLEMENTOS, EQUIPAMENTOS E MAQUINARIOS NECESSARIOS A ' +
  'UNIVERSIDADE FEDERAL DO NORTE DO TOCANTINS/{CIDADE} CCS. ' +
  'NO PERIODO DE {DIA_INI} DE {MES_INI} DE {ANO_INI} A ' +
  '{DIA_FIM} DE {MES_FIM} DE {ANO_FIM}. ' +
  'PROCESSO No {PROCESSO} - PREGAO ELETRONICO: {PREGAO}.';

const TEMPLATE_UFNT_MOTORISTAS =
  'CONTRATACAO DE PESSOA JURIDICA ESPECIALIZADA NA PRESTACAO DE SERVICOS ' +
  'DE APOIO ADMINISTRATIVO, TECNICO E OPERACIONAL, COM DEDICACAO EXCLUSIVA ' +
  'DE MAO DE OBRA, FORNECIMENTO INTEGRAL DE FERRAMENTAS, ACESSORIOS, ' +
  'IMPLEMENTOS, EQUIPAMENTOS E MAQUINARIOS NECESSARIOS A UNIVERSIDADE ' +
  'FEDERAL DO NORTE DO TOCANTINS/{CIDADE} CCS. ' +
  'PROCESSO No {PROCESSO} - PREGAO ELETRONICO: {PREGAO}. ' +
  'NO PERIODO DE {DIA_INI} DE {MES_INI} DE {ANO_INI} A ' +
  '{DIA_FIM} DE {MES_FIM} DE {ANO_FIM}.';

const TEMPLATE_DETRAN =
  'PRESTACAO DE SERVICOS CONTINUADOS NAS AREAS DE LIMPEZA, ASSEIO E ' +
  'CONSERVACAO, NAS INSTALACOES DO DEPARTAMENTO ESTADUAL DE TRANSITO DO ' +
  'ESTADO DO TOCANTINS. CONSIDERANDO OS SERVICOS DE COPEIRAGEM, ' +
  'JARDINAGEM, ARTIFICE DE MANUTENCAO, SERVICOS GERAIS E ENCARREGADO. ' +
  'COM FORNECIMENTO DE TODO MATERIAL, INSUMOS E EQUIPAMENTOS QUE SE ' +
  'FIZEREM NECESSARIOS A EXECUCAO DOS SERVICOS, NAS DEPENDENCIAS DA ' +
  'CIDADE DE {CIDADE}. CONFORME O CONTRATO No {CONTRATO}. ' +
  'REFERENTE AO MES DE {MES_FIM} DE {ANO_FIM}.';

const TEMPLATE_SESAU =
  'SERVICO DE LIMPEZA, CONSERVACAO, HIGIENIZACAO, REALIZADO NOS ' +
  'ESTABELECIMENTOS DA SECRETARIA DE ESTADO DA SAUDE SENDO NO: {POSTO}. ' +
  'CONTRATO No {CONTRATO}, PROCESSO No {PROCESSO}. ' +
  'REFERENTE AO MES DE {MES_FIM} DE {ANO_FIM}.';

const DADOS_BANCARIOS_PADRAO =
  'BANCO DO BRASIL\nAGENCIA No 1505-9\nCONTA CORRENTE No 109043-7.';

const CONTRATOS = [
  {
    nome_match: 'UFT — Limpeza e ATOP',  // ou similar
    config: {
      orgao: 'FUNDACAO UNIVERSIDADE FEDERAL DO TOCANTINS',
      insc_municipal: '05149726000104',
      contrato_ref: '10/2022',
      numero_contrato: '10/2022',
      processo: '23101.004080/2022-53',
      pregao: '10/2022',
      item_lista_servico: '0710',
      codigo_tributacao_municipal: '0710',
      codigo_cnae: '8111700',
      codigo_nbs: '118031000',
      aliquota_iss_padrao: 0.05,
      iss_retido_padrao: true,
      optante_simples_nacional: 2,
      incentivo_fiscal: 2,
      inss_aliquota: 0.11,
      inss_base_reduzida: true,  // UFT: subtrai vale-alim + materiais
      irrf_aliquota: 0.012,
      pis_aliquota: 0.0065,
      cofins_aliquota: 0.03,
      csll_aliquota: 0.01,
      ciclo_dia_inicio: 5,  // 5/M-1 → 4/M
      dados_bancarios: DADOS_BANCARIOS_PADRAO,
      template_discriminacao: TEMPLATE_UFT_LIMPEZA,
    },
  },
  {
    nome_match: 'UFT — Motoristas e Tratoristas',
    config: {
      orgao: 'FUNDACAO UNIVERSIDADE FEDERAL DO TOCANTINS',
      insc_municipal: '05149726000104',
      contrato_ref: '05/2025',
      numero_contrato: '05/2025',
      processo: '23101.006799/2024-91',
      pregao: '90015/2024',
      item_lista_servico: '1705',
      codigo_tributacao_municipal: '1705',
      codigo_cnae: '7820500',
      codigo_nbs: '118012100',
      aliquota_iss_padrao: 0.05,
      iss_retido_padrao: true,
      optante_simples_nacional: 2,
      incentivo_fiscal: 2,
      inss_aliquota: 0.11,
      inss_base_reduzida: false,  // Motoristas: INSS sobre bruto (sem deduções no padrão)
      irrf_aliquota: 0.012,
      pis_aliquota: 0.0065,
      cofins_aliquota: 0.03,
      csll_aliquota: 0.01,
      ciclo_dia_inicio: 3,  // 3/M-1 → 2/M (observado nos XMLs)
      dados_bancarios: DADOS_BANCARIOS_PADRAO,
      template_discriminacao: TEMPLATE_UFT_MOTORISTAS,
    },
  },
  {
    nome_match: 'UFNT — Limpeza e ATOP',
    config: {
      orgao: 'UNIVERSIDADE FEDERAL DO NORTE DO TOCANTINS - UFNT',
      insc_municipal: '38178825000173',
      contrato_ref: '10/2022',
      numero_contrato: '10/2022',
      processo: '23101.004080/2022-53',
      pregao: '10/2022',
      item_lista_servico: '0710',
      codigo_tributacao_municipal: '0710',
      codigo_cnae: '8111700',
      codigo_nbs: '118031000',
      aliquota_iss_padrao: 0.05,
      iss_retido_padrao: true,
      optante_simples_nacional: 2,
      incentivo_fiscal: 2,
      inss_aliquota: 0.11,
      inss_base_reduzida: true,
      irrf_aliquota: 0.012,
      pis_aliquota: 0.0065,
      cofins_aliquota: 0.03,
      csll_aliquota: 0.01,
      ciclo_dia_inicio: 5,
      dados_bancarios: DADOS_BANCARIOS_PADRAO,
      template_discriminacao: TEMPLATE_UFNT_LIMPEZA,
    },
  },
  {
    nome_match: 'UFNT — Motoristas',  // Pode não existir ainda
    config: {
      orgao: 'UNIVERSIDADE FEDERAL DO NORTE DO TOCANTINS - UFNT',
      insc_municipal: '38178825000173',
      item_lista_servico: '1705',
      codigo_tributacao_municipal: '1705',
      codigo_cnae: '7820500',
      codigo_nbs: '118012100',
      aliquota_iss_padrao: 0.05,
      iss_retido_padrao: true,
      optante_simples_nacional: 2,
      incentivo_fiscal: 2,
      inss_aliquota: 0.11,
      inss_base_reduzida: false,
      irrf_aliquota: 0.012,
      pis_aliquota: 0.0065,
      cofins_aliquota: 0.03,
      csll_aliquota: 0.01,
      ciclo_dia_inicio: 5,
      dados_bancarios: DADOS_BANCARIOS_PADRAO,
      template_discriminacao: TEMPLATE_UFNT_MOTORISTAS,
    },
  },
  {
    nome_match: 'DETRAN',
    config: {
      orgao: 'DEPARTAMENTO ESTADUAL DE TRANSITO - DETRAN/TO',
      insc_municipal: '26752857000151',
      contrato_ref: '02/2024',
      numero_contrato: '02/2024',
      item_lista_servico: '0710',
      codigo_tributacao_municipal: '0710',
      codigo_cnae: '8111700',
      codigo_nbs: '118031000',
      aliquota_iss_padrao: 0.05,
      iss_retido_padrao: false,  // ⚠ DETRAN NÃO retém ISS
      optante_simples_nacional: 2,
      incentivo_fiscal: 2,
      inss_aliquota: 0,   // Estadual ñ federal: NÃO retém INSS/IRRF/PCC
      inss_base_reduzida: false,
      irrf_aliquota: 0,
      pis_aliquota: 0,
      cofins_aliquota: 0,
      csll_aliquota: 0,
      ciclo_dia_inicio: null,  // mês calendário
      dados_bancarios: DADOS_BANCARIOS_PADRAO,
      template_discriminacao: TEMPLATE_DETRAN,
    },
  },
  {
    nome_match: 'SESAU',
    config: {
      orgao: 'TOCANTINS SECRETARIA DE ESTADO DE SAUDE',
      insc_municipal: '25053117000164',
      contrato_ref: '178/2022',
      numero_contrato: '178/2022',
      processo: '2020/30550/007573',
      item_lista_servico: '0710',
      codigo_tributacao_municipal: '0710',
      codigo_cnae: '8111700',
      codigo_nbs: '118031000',
      aliquota_iss_padrao: 0.05,
      iss_retido_padrao: true,
      optante_simples_nacional: 2,
      incentivo_fiscal: 2,
      inss_aliquota: 0.11,  // SESAU retém INSS+IRRF (estadual)
      inss_base_reduzida: false,
      irrf_aliquota: 0.012,
      pis_aliquota: 0,
      cofins_aliquota: 0,
      csll_aliquota: 0,
      ciclo_dia_inicio: null,  // mês calendário
      dados_bancarios: DADOS_BANCARIOS_PADRAO,
      template_discriminacao: TEMPLATE_SESAU,
    },
  },
];

// IBGE mapping por município (TO)
const IBGE_TO = {
  'aliança do tocantins': '1701051',
  'alianca do tocantins': '1701051',
  'alianca do to': '1701051',
  'aliança do to': '1701051',
  'alvorada': '1701309',
  'ananas': '1702000',
  'ananás': '1702000',
  'araguacema': '1701903',
  'araguacu': '1702059',
  'araguaçu': '1702059',
  'araguaina': '1702109',
  'araguaína': '1702109',
  'araguatins': '1702208',
  'arapoema': '1702307',
  'arraias': '1702406',
  'augustinopolis': '1702604',
  'augustinópolis': '1702604',
  'colinas do tocantins': '1705508',
  'colinas do to': '1705508',
  'colmeia': '1716703',
  'colméia': '1716703',
  'combinado': '1706001',
  'cristalandia': '1706258',
  'cristalândia': '1706258',
  'dianopolis': '1707009',
  'dianópolis': '1707009',
  'figueiropolis': '1708007',
  'figueirópolis': '1708007',
  'filadelfia': '1708106',
  'filadélfia': '1708106',
  'formoso do araguaia': '1708205',
  'goiatins': '1709302',
  'guarai': '1709500',  // (Guaraí, ñ Gurupi)
  'guaraí': '1709500',
  'gurupi': '1709500',
  'itacaja': '1710003',
  'itacajá': '1710003',
  'itaguatins': '1710102',
  'lagoa da confusao': '1711506',
  'lagoa da confusão': '1711506',
  'miracema do tocantins': '1713304',
  'miracema do to': '1713304',
  'miranorte': '1713601',
  'natividade': '1715101',
  'novo acordo': '1715507',
  'palmas': '1721000',
  'palmeiropolis': '1716000',
  'palmeirópolis': '1716000',
  'parana': '1716109',
  'paraná': '1716109',
  'paraiso do tocantins': '1716109',
  'paraíso do tocantins': '1716109',
  'paraiso do to': '1716109',
  'paraíso do to': '1716109',
  'pedro afonso': '1716703',
  'peixe': '1717009',
  'ponte alta do tocantins': '1718105',
  'porto nacional': '1718204',
  'sitio novo do tocantins': '1719901',
  'sítio novo do tocantins': '1719901',
  'taguatinga': '1720903',
  'tocantinopolis': '1721208',
  'tocantinópolis': '1721208',
  'wanderlandia': '1722206',
  'wanderlândia': '1722206',
  'xambioa': '1722800',
  'xambioá': '1722800',
};

function normalize(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\/.*$/, '').trim();
}

async function aplicar(db, contratoCfg) {
  const c = await db.prepare(`SELECT id, nome FROM bol_contratos WHERE nome ILIKE ? LIMIT 1`)
    .get(`%${contratoCfg.nome_match}%`);
  if (!c) {
    console.warn(`⊘ ${contratoCfg.nome_match}: contrato não encontrado em bol_contratos`);
    return;
  }
  const fields = Object.entries(contratoCfg.config);
  const setSql = fields.map(([k]) => `${k}=?`).join(', ');
  const setVals = fields.map(([_, v]) => v);
  await db.prepare(`UPDATE bol_contratos SET ${setSql}, updated_at=NOW() WHERE id=?`)
    .run(...setVals, c.id);
  console.log(`✓ id=${c.id} ${c.nome}  →  ${fields.length} campos atualizados`);

  // Postos
  const postos = await db.prepare(`SELECT id, campus_nome, municipio FROM bol_postos WHERE contrato_id=?`).all(c.id);
  let ok = 0, miss = 0;
  for (const p of postos) {
    const k = normalize(p.municipio || p.campus_nome);
    const ibge = IBGE_TO[k];
    if (!ibge) { miss++; console.warn(`  ⚠ posto ${p.id} (${p.municipio}) sem IBGE [key="${k}"]`); continue; }
    await db.prepare(`UPDATE bol_postos SET codigo_municipio_ibge=? WHERE id=?`).run(ibge, p.id);
    ok++;
  }
  console.log(`  postos: ${ok} com IBGE, ${miss} sem`);
}

(async () => {
  const db = getDb('assessoria');
  for (const c of CONTRATOS) {
    await aplicar(db, c);
  }
  console.log('\nFim.');
})().catch(e => { console.error(e); process.exit(1); });
