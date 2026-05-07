/**
 * Seed — Importa o contrato UFT 16/2026 para o módulo de boletins
 * Roda uma vez: node src/seed-boletins.js
 * Popula bol_contratos, bol_postos e bol_itens para a empresa "seguranca"
 */
const { getDb } = require('./db');

const db = getDb('seguranca');

// Verificar se já existe
const existing = db.prepare("SELECT id FROM bol_contratos WHERE numero_contrato = '16/2026'").get();
if (existing) {
  console.log('⚠ Contrato UFT 16/2026 já cadastrado (id=' + existing.id + '). Seed ignorado.');
  process.exit(0);
}

console.log('Importando contrato UFT 16/2026...\n');

// ─── Contrato ─────────────────────────────────────────────────
const contratoResult = db.prepare(`
  INSERT INTO bol_contratos (nome, contratante, numero_contrato, processo, pregao,
    descricao_servico, escala, empresa_razao, empresa_cnpj, empresa_endereco,
    empresa_email, empresa_telefone)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
`).run(
  'UFT',
  'UNIVERSIDADE FEDERAL DO ESTADO DO TOCANTINS',
  '16/2026',
  '23101.002940/2025-67',
  '90009/2025',
  'Serviços de vigilância físico-patrimonial e humana, armada e desarmada, com fornecimento integral de peças, equipamentos, dispositivos, acessórios, veículos e demais implementos de segurança e mão de obra especializada para o desempenho dos serviços.',
  '12x36',
  'MONTANA SEGURANÇA PRIVADA LTDA',
  '19.200.109/0001-09',
  'Quadra ACSE 1 Rua SE 5, Lote 20, Sala 12, Plano Diretor Sul, CEP: 77.020-018 Palmas/TO',
  'montanaseguranca@gmail.com',
  '(63) 3322-0564'
);

const contratoId = contratoResult.lastInsertRowid;
console.log(`  ✅ Contrato criado (id=${contratoId})`);

// ─── Postos e Itens ───────────────────────────────────────────
const campi = [
  {
    key: 'ARRAIAS', nome: 'CAMPUS UNIVERSITÁRIO DE ARRAIAS/TO',
    municipio: 'ARRAIAS/TO', desc: 'Posto de Vigilância Armada 12x36 de Segunda-feira a Domingo.',
    label: 'ARRAIAS', ordem: 1,
    itens: [
      { desc: 'Posto de Vigilância Armado 12h Noturno. Vigilante Patrimonial.', qtd: 1, valor: 14804.74 },
      { desc: 'Posto de Vigilância Armado 12h Diurno. Vigilante Patrimonial.', qtd: 1, valor: 13437.34 },
    ]
  },
  {
    key: 'GURUPI', nome: 'CAMPUS UNIVERSITÁRIO DE GURUPI/TO',
    municipio: 'GURUPI/TO', desc: 'Posto de Vigilância Armada e Desarmado de Segunda-feira a Domingo.',
    label: 'GURUPI', ordem: 2,
    itens: [
      { desc: 'Posto de Vigilância desarmado 12h Noturno. Vigilante Patrimonial.', qtd: 1, valor: 14712.12 },
      { desc: 'Posto de Vigilância armado 12h Diurno. Vigilante Patrimonial.', qtd: 1, valor: 13437.34 },
      { desc: 'Posto de Vigilância Armado 12h Noturno. Com Motocicleta.', qtd: 1, valor: 15885.52 },
      { desc: 'Posto de Vigilância Armado 12h Diurno. Com Motocicleta.', qtd: 1, valor: 14610.72 },
    ]
  },
  {
    key: 'PORTO NACIONAL', nome: 'CAMPUS UNIVERSITÁRIO DE PORTO NACIONAL/TO',
    municipio: 'PORTO NACIONAL/TO', desc: 'Posto de Vigilância Armada e Desarmado de Segunda-feira a Domingo.',
    label: 'PORTO NACIONAL', ordem: 3,
    itens: [
      { desc: 'Posto de Vigilância Armado 12h Noturno. Vigilante Patrimonial.', qtd: 3, valor: 14804.74 },
      { desc: 'Posto de Vigilância Armado 12h Diurno. Vigilante Patrimonial.', qtd: 2, valor: 13529.94 },
    ]
  },
  {
    key: 'MIRACEMA DO TOCANTINS', nome: 'CAMPUS UNIVERSITÁRIO DE MIRACEMA DO TOCANTINS/TO - CENTRO E CERRADO',
    municipio: 'MIRACEMA/TO', desc: 'Posto de Vigilância Armada 12x36 de Segunda-feira a Domingo.',
    label: 'MIRACEMA CENTRO E CERRADO', ordem: 4,
    itens: [
      { desc: 'Posto de Vigilância Armado 12h Noturno. Vigilante Patrimonial.', qtd: 2, valor: 14804.74 },
      { desc: 'Posto de Vigilância Armado 12h Diurno. Vigilante Patrimonial.', qtd: 2, valor: 13529.94 },
    ]
  },
  {
    key: 'PALMAS', nome: 'CAMPUS UNIVERSITÁRIO DE PALMAS/TO - CAMPUS',
    municipio: 'PALMAS/TO', desc: 'Posto de Vigilância Armada e Desarmado de Segunda-feira a Domingo.',
    label: 'PALMAS CAMPUS', ordem: 5,
    itens: [
      { desc: 'Posto de Vigilância Armado 12h Noturno. Com Motocicleta. (Sem o valor do vale transporte).', qtd: 2, valor: 15885.52 },
      { desc: 'Posto de Vigilância Armado 12h Diurno. Com Motocicleta. (Sem o vale transporte)', qtd: 2, valor: 14610.72 },
      { desc: 'Posto de Vigilância Desarmado 12h Noturno. Operador de Central de Monitoramento. (Sem o valor do vale transporte).', qtd: 1, valor: 16147.12 },
      { desc: 'Posto de Vigilância Desarmado 12h Diurno. Operador de Central de Monitoramento. (Sem o valor do vale transporte).', qtd: 1, valor: 14872.24 },
      { desc: 'Posto de Vigilância armado 12h Diurno. Vigilante patrimonial.', qtd: 1, valor: 14052.26 },
      { desc: 'Posto de Vigilância armado 12h Noturno. Vigilante patrimonial.', qtd: 1, valor: 14804.74 },
      { desc: 'Posto de Vigilância desarmado 12h Diurno. Vigilante patrimonial. Casa do estudante.', qtd: 1, valor: 13437.34 },
      { desc: 'Posto de Vigilância desarmado 12h Noturno. Vigilante patrimonial. Casa do estudante.', qtd: 1, valor: 14712.12 },
    ]
  },
];

const insertPosto = db.prepare(`
  INSERT INTO bol_postos (contrato_id, campus_key, campus_nome, municipio, descricao_posto, label_resumo, ordem)
  VALUES (?,?,?,?,?,?,?)
`);

const insertItem = db.prepare(`
  INSERT INTO bol_itens (posto_id, descricao, quantidade, valor_unitario, ordem)
  VALUES (?,?,?,?,?)
`);

for (const campus of campi) {
  const postoResult = insertPosto.run(contratoId, campus.key, campus.nome, campus.municipio, campus.desc, campus.label, campus.ordem);
  const postoId = postoResult.lastInsertRowid;
  console.log(`  ✅ Posto: ${campus.key} (id=${postoId})`);

  for (let i = 0; i < campus.itens.length; i++) {
    const item = campus.itens[i];
    insertItem.run(postoId, item.desc, item.qtd, item.valor, i + 1);
  }
  console.log(`     └─ ${campus.itens.length} itens inseridos`);
}

console.log('\n✅ Seed completo! Contrato UFT 16/2026 importado com sucesso.');
