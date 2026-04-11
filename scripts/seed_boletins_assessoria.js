/**
 * Seed Boletins de Medição — Montana Assessoria
 * Popula bol_contratos, bol_postos e bol_itens com base nas planilhas XLS
 * Uso: node scripts/seed_boletins_assessoria.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const db = getDb('assessoria');

// ── Limpa dados existentes (safe re-run) ─────────────────────────────────────
db.prepare('DELETE FROM bol_itens').run();
db.prepare('DELETE FROM bol_postos').run();
db.prepare('DELETE FROM bol_contratos').run();
db.prepare("DELETE FROM sqlite_sequence WHERE name IN ('bol_contratos','bol_postos','bol_itens')").run();

// ── Helpers ───────────────────────────────────────────────────────────────────
const insContrato = db.prepare(`
  INSERT INTO bol_contratos (nome, contratante, numero_contrato, descricao_servico, escala,
    empresa_razao, empresa_cnpj)
  VALUES (@nome, @contratante, @numero_contrato, @descricao_servico, @escala,
    @empresa_razao, @empresa_cnpj)
`);

const insPosto = db.prepare(`
  INSERT INTO bol_postos (contrato_id, campus_key, campus_nome, municipio, descricao_posto, ordem, label_resumo)
  VALUES (@contrato_id, @campus_key, @campus_nome, @municipio, @descricao_posto, @ordem, @label_resumo)
`);

const insItem = db.prepare(`
  INSERT INTO bol_itens (posto_id, descricao, quantidade, valor_unitario, ordem)
  VALUES (@posto_id, @descricao, @quantidade, @valor_unitario, @ordem)
`);

const empresa = {
  empresa_razao: 'MONTANA ASSESSORIA EMPRESARIAL LTDA',
  empresa_cnpj: '14.092.519/0001-51',
};

// ═══════════════════════════════════════════════════════════════════════════════
// 1. UFT — Contrato Nº UFT-29/2022 (atual 16/2025)
// Serviços: Limpeza + ATOP (Apoio Técnico Operacional)
// 5 campi: Arraias, Gurupi, Miracema, Porto Nacional, Palmas
// ═══════════════════════════════════════════════════════════════════════════════
const uft = insContrato.run({
  nome: 'UFT — Limpeza e ATOP',
  contratante: 'FUNDAÇÃO UNIVERSIDADE FEDERAL DO TOCANTINS',
  numero_contrato: '16/2025',
  descricao_servico: 'Prestação de Serviços Continuados de Limpeza, Asseio e Conservação e Apoio Técnico Operacional com dedicação exclusiva de Mão de Obra',
  escala: '5x2',
  ...empresa,
});
const uftId = uft.lastInsertRowid;

const uftCampi = [
  { key: 'ARRAIAS',        nome: 'Arraias',        municipio: 'Arraias/TO',        ordem: 1 },
  { key: 'GURUPI',         nome: 'Gurupi',         municipio: 'Gurupi/TO',         ordem: 2 },
  { key: 'MIRACEMA',       nome: 'Miracema',       municipio: 'Miracema do TO/TO', ordem: 3 },
  { key: 'PORTONACIONAL',  nome: 'Porto Nacional', municipio: 'Porto Nacional/TO', ordem: 4 },
  { key: 'PALMAS',         nome: 'Palmas',         municipio: 'Palmas/TO',         ordem: 5 },
];

// Valores de fevereiro/2026 extraídos dos XLS (soma ATOP+Limpeza)
const uftValores = {
  // { ATOP_COM, ATOP_SEM, LIMPEZA_COM }  (valores mensais do posto inteiro)
  ARRAIAS:       { atopCom: 9094.55,   atopSem: 7722.24,   limpCom: 43566.95  },
  GURUPI:        { atopCom: 20976.48,  atopSem: 25089.41,  limpCom: 77638.41  },
  MIRACEMA:      { atopCom: 4153.31,   atopSem: 8466.05,   limpCom: 45546.00  },
  PORTONACIONAL: { atopCom: 0,         atopSem: 11848.83,  limpCom: 78187.74  },
  PALMAS:        { atopCom: 65360.17,  atopSem: 184555.39, limpCom: 336141.53 },
};

for (const c of uftCampi) {
  const posto = insPosto.run({
    contrato_id: uftId,
    campus_key: c.key,
    campus_nome: c.nome,
    municipio: c.municipio,
    descricao_posto: `UFT — Campus ${c.nome}`,
    ordem: c.ordem,
    label_resumo: c.nome,
  });
  const postoId = posto.lastInsertRowid;
  const v = uftValores[c.key];
  let itemOrdem = 1;
  if (v.limpCom > 0)  insItem.run({ posto_id: postoId, descricao: 'Limpeza com Material',           quantidade: 1, valor_unitario: v.limpCom,  ordem: itemOrdem++ });
  if (v.atopCom > 0)  insItem.run({ posto_id: postoId, descricao: 'ATOP com Material',              quantidade: 1, valor_unitario: v.atopCom,  ordem: itemOrdem++ });
  if (v.atopSem > 0)  insItem.run({ posto_id: postoId, descricao: 'ATOP sem Material',              quantidade: 1, valor_unitario: v.atopSem,  ordem: itemOrdem++ });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. DETRAN — Contrato Nº 02/2024 (memória: 41/2023)
// Múltiplas cidades do estado — 5 cargos principais
// ═══════════════════════════════════════════════════════════════════════════════
const detran = insContrato.run({
  nome: 'DETRAN-TO — Limpeza',
  contratante: 'DEPARTAMENTO ESTADUAL DE TRÂNSITO DO TOCANTINS',
  numero_contrato: '41/2023',
  descricao_servico: 'Prestação de Serviços Continuados de Limpeza, Asseio e Conservação nas unidades do DETRAN em todo o estado do Tocantins',
  escala: '5x2',
  ...empresa,
});
const detranId = detran.lastInsertRowid;

// Postos DETRAN = principais cidades atendidas (fevereiro/2026)
const detranCidades = [
  'Aliança do Tocantins', 'Alvorada', 'Araguaína', 'Araguatins', 'Araguaçu',
  'Arraias', 'Augustinópolis', 'Colinas do Tocantins', 'Colméia', 'Combinado',
  'Dianópolis', 'Guaraí', 'Gurupi', 'Miracema do Tocantins', 'Natividade',
  'Palmas', 'Paraíso do Tocantins', 'Pedro Afonso', 'Porto Nacional', 'Tocantinópolis',
];

for (let i = 0; i < detranCidades.length; i++) {
  const cidade = detranCidades[i];
  const posto = insPosto.run({
    contrato_id: detranId,
    campus_key: cidade.toUpperCase().replace(/\s/g,'').replace(/[^A-Z0-9]/g,''),
    campus_nome: cidade,
    municipio: cidade + '/TO',
    descricao_posto: `DETRAN — ${cidade}`,
    ordem: i + 1,
    label_resumo: cidade,
  });
  const postoId = posto.lastInsertRowid;
  // Itens padrão por posto (ajustar conforme cada cidade)
  const cargos = [
    { desc: 'Servente de Limpeza',         qt: 1, vUnit: 5039.00 },
    { desc: 'Copeira',                      qt: 0, vUnit: 4060.53 },
    { desc: 'Jardineiro',                   qt: 0, vUnit: 4812.04 },
    { desc: 'Encarregado',                  qt: 0, vUnit: 5513.62 },
    { desc: 'Artífice de Manutenção',       qt: 0, vUnit: 8113.09 },
    { desc: 'Auxiliar de Serviços Gerais',  qt: 0, vUnit: 4261.54 },
  ];
  cargos.filter(c=>c.qt>0).forEach((c,idx)=>{
    insItem.run({ posto_id: postoId, descricao: c.desc, quantidade: c.qt, valor_unitario: c.vUnit, ordem: idx+1 });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. SEMARH — Contrato Nº 32/2024
// Posto único: SEMARH/Palmas
// ═══════════════════════════════════════════════════════════════════════════════
const semarh = insContrato.run({
  nome: 'SEMARH — Limpeza',
  contratante: 'SECRETARIA DO MEIO AMBIENTE E RECURSOS HÍDRICOS — SEMARH',
  numero_contrato: '32/2024',
  descricao_servico: 'Prestação de Serviços Continuados de Limpeza, Asseio e Conservação na SEMARH',
  escala: '5x2',
  ...empresa,
});
const semarhId = semarh.lastInsertRowid;
const semarhPosto = insPosto.run({
  contrato_id: semarhId, campus_key: 'SEMARH', campus_nome: 'SEMARH',
  municipio: 'Palmas/TO', descricao_posto: 'SEMARH — Palmas/TO', ordem: 1, label_resumo: 'SEMARH',
});
[
  { desc: 'Jardineiro',           qt: 1, vUnit: 5236.03 },
  { desc: 'Servente de Limpeza',  qt: 4, vUnit: 5986.66 },
].forEach((c,i) => insItem.run({ posto_id: semarhPosto.lastInsertRowid, descricao: c.desc, quantidade: c.qt, valor_unitario: c.vUnit, ordem: i+1 }));

// ═══════════════════════════════════════════════════════════════════════════════
// 4. PREVI PALMAS — Contrato Nº 03/2024
// Posto único: PREVIPALMAS/Palmas
// ═══════════════════════════════════════════════════════════════════════════════
const previ = insContrato.run({
  nome: 'PREVI PALMAS — Limpeza',
  contratante: 'INSTITUTO DE PREVIDÊNCIA SOCIAL DO MUNICÍPIO DE PALMAS',
  numero_contrato: '03/2024',
  descricao_servico: 'Prestação de Serviços Continuados de Limpeza, Asseio e Conservação no PREVIPALMAS',
  escala: '5x2',
  ...empresa,
});
const previId = previ.lastInsertRowid;
const previPosto = insPosto.run({
  contrato_id: previId, campus_key: 'PREVIPALMAS', campus_nome: 'PREVIPALMAS',
  municipio: 'Palmas/TO', descricao_posto: 'PREVIPALMAS — Palmas/TO', ordem: 1, label_resumo: 'PREVIPALMAS',
});
[
  { desc: 'Jardineiro',           qt: 1, vUnit: 4261.54 },
  { desc: 'Copeira',              qt: 1, vUnit: 3833.03 },
  { desc: 'Servente de Limpeza',  qt: 3, vUnit: 3800.82 },
].forEach((c,i) => insItem.run({ posto_id: previPosto.lastInsertRowid, descricao: c.desc, quantidade: c.qt, valor_unitario: c.vUnit, ordem: i+1 }));

// ═══════════════════════════════════════════════════════════════════════════════
// 5. SEDUC — Contrato Nº 016/2023
// Posto único: SEDUC/Palmas
// ═══════════════════════════════════════════════════════════════════════════════
const seduc = insContrato.run({
  nome: 'SEDUC — Limpeza e Copeiragem',
  contratante: 'SECRETARIA DA EDUCAÇÃO DO ESTADO DO TOCANTINS',
  numero_contrato: '016/2023',
  descricao_servico: 'Prestação de Serviços Continuados de Limpeza, Asseio, Conservação e Copeiragem na SEDUC',
  escala: '5x2',
  ...empresa,
});
const seducId = seduc.lastInsertRowid;
const seducPosto = insPosto.run({
  contrato_id: seducId, campus_key: 'SEDUCPALMAS', campus_nome: 'SEDUC Palmas',
  municipio: 'Palmas/TO', descricao_posto: 'SEDUC — Palmas/TO', ordem: 1, label_resumo: 'SEDUC',
});
[
  { desc: 'Auxiliar de Serviços Gerais', qt: 24, vUnit: 5481.89 },
  { desc: 'Copeira',                     qt: 13, vUnit: 4060.53 },
  { desc: 'Encarregada',                 qt:  2, vUnit: 5513.62 },
  { desc: 'Jardineiro',                  qt:  3, vUnit: 4812.04 },
].forEach((c,i) => insItem.run({ posto_id: seducPosto.lastInsertRowid, descricao: c.desc, quantidade: c.qt, valor_unitario: c.vUnit, ordem: i+1 }));

// ═══════════════════════════════════════════════════════════════════════════════
// 6. TCE — Contrato Nº 26/2025 (encerrado)
// Posto único: TCE/Palmas
// ═══════════════════════════════════════════════════════════════════════════════
const tce = insContrato.run({
  nome: 'TCE-TO — Limpeza (encerrado)',
  contratante: 'TRIBUNAL DE CONTAS DO ESTADO DO TOCANTINS',
  numero_contrato: '26/2025',
  descricao_servico: 'Prestação de Serviços Continuados de Limpeza, Asseio, Conservação e Serviços Gerais no TCE-TO',
  escala: '5x2',
  ...empresa,
});
// marca como inativo
db.prepare('UPDATE bol_contratos SET ativo=0 WHERE id=?').run(tce.lastInsertRowid);
const tcePosto = insPosto.run({
  contrato_id: tce.lastInsertRowid, campus_key: 'TCETO', campus_nome: 'TCE-TO',
  municipio: 'Palmas/TO', descricao_posto: 'TCE — Palmas/TO', ordem: 1, label_resumo: 'TCE',
});
[
  { desc: 'Servente de Limpeza',                    qt: 30, vUnit: 5190.33 },
  { desc: 'Servente de Limpeza (40% insalubridade)', qt:  5, vUnit: 6524.47 },
  { desc: 'Jardineiro',                              qt:  2, vUnit: 5654.67 },
  { desc: 'Copeira',                                 qt:  8, vUnit: 4606.60 },
  { desc: 'Garçom',                                  qt:  4, vUnit: 5491.61 },
  { desc: 'Porteiro',                                qt:  6, vUnit: 4963.46 },
  { desc: 'Artífice',                                qt:  4, vUnit: 8113.09 },
  { desc: 'Encarregado',                             qt:  2, vUnit: 8229.43 },
  { desc: 'Recepcionista',                           qt:  4, vUnit: 5447.63 },
].forEach((c,i) => insItem.run({ posto_id: tcePosto.lastInsertRowid, descricao: c.desc, quantidade: c.qt, valor_unitario: c.vUnit, ordem: i+1 }));

// ── Resumo ────────────────────────────────────────────────────────────────────
const counts = {
  contratos: db.prepare('SELECT COUNT(*) n FROM bol_contratos').get().n,
  postos:    db.prepare('SELECT COUNT(*) n FROM bol_postos').get().n,
  itens:     db.prepare('SELECT COUNT(*) n FROM bol_itens').get().n,
};

console.log('\n══════════════════════════════════════════');
console.log('✅ BOLETINS SEED — Montana Assessoria');
console.log('══════════════════════════════════════════');
console.log(`  Contratos criados: ${counts.contratos}`);
console.log(`  Postos criados:    ${counts.postos}`);
console.log(`  Itens criados:     ${counts.itens}`);
console.log('\n  Contratos:');
db.prepare('SELECT id, nome, numero_contrato, ativo FROM bol_contratos ORDER BY id').all().forEach(r => {
  console.log(`    [${r.id}] ${r.nome} — ${r.numero_contrato} ${r.ativo ? '' : '(ENCERRADO)'}`);
});
