const ExcelJS = require('exceljs');
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Funcionarios RH Seguranca');

ws.columns = [
  { header: 'nome',            key: 'nome',            width: 30 },
  { header: 'cpf',             key: 'cpf',             width: 16 },
  { header: 'rg',              key: 'rg',              width: 14 },
  { header: 'data_nascimento', key: 'data_nascimento', width: 14 },
  { header: 'data_admissao',   key: 'data_admissao',   width: 14 },
  { header: 'salario_base',    key: 'salario_base',    width: 14 },
  { header: 'contrato_ref',    key: 'contrato_ref',    width: 30 },
  { header: 'lotacao',         key: 'lotacao',         width: 30 },
  { header: 'pis',             key: 'pis',             width: 14 },
  { header: 'ctps_numero',     key: 'ctps_numero',     width: 14 },
  { header: 'banco',           key: 'banco',           width: 10 },
  { header: 'agencia',         key: 'agencia',         width: 12 },
  { header: 'conta_banco',     key: 'conta_banco',     width: 16 },
  { header: 'email',           key: 'email',           width: 28 },
  { header: 'telefone',        key: 'telefone',        width: 16 },
  { header: 'obs',             key: 'obs',             width: 30 },
];

// Estilo do cabeçalho
ws.getRow(1).eachCell(cell => {
  cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  cell.alignment = { horizontal: 'center' };
});

// Exemplos
const exemplos = [
  {
    nome: 'JOAO DA SILVA',
    cpf: '000.000.000-00',
    rg: '000000',
    data_nascimento: '1985-03-15',
    data_admissao: '2024-01-01',
    salario_base: 2000,
    contrato_ref: 'SEDUC 11/2023 + 3 TA',
    lotacao: 'Escola Estadual X - Palmas',
    pis: '',
    ctps_numero: '',
    banco: 'BB',
    agencia: '0001-7',
    conta_banco: '12345-6',
    email: '',
    telefone: '(63) 99999-0001',
    obs: 'Exemplo - apagar'
  },
  {
    nome: 'MARIA SOUZA',
    cpf: '111.111.111-11',
    rg: '',
    data_nascimento: '',
    data_admissao: '2024-02-01',
    salario_base: 2000,
    contrato_ref: 'SEDUC 070/2023 + 3 TA',
    lotacao: 'Escola Estadual Y - Palmas',
    pis: '',
    ctps_numero: '',
    banco: '',
    agencia: '',
    conta_banco: '',
    email: '',
    telefone: '',
    obs: 'Exemplo - apagar'
  },
];

exemplos.forEach(e => {
  const row = ws.addRow(e);
  row.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FDF4' } };
  });
});

// Linhas em branco para preenchimento
for (let i = 0; i < 30; i++) {
  const row = ws.addRow({});
  row.eachCell(cell => {
    cell.border = { bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } } };
  });
}

// Aba instrucoes
const ws2 = wb.addWorksheet('INSTRUCOES');
ws2.getColumn(1).width = 90;

const linhas = [
  'TEMPLATE DE IMPORTACAO - RH / FUNCIONARIOS - MONTANA SEGURANCA',
  '',
  'CAMPOS OBRIGATORIOS:',
  '  nome          - nome completo em maiusculas',
  '  data_admissao - formato AAAA-MM-DD (ex: 2024-01-15)',
  '  salario_base  - valor numerico sem R$ (ex: 1518.00)',
  '',
  'CONTRATOS VALIDOS PARA SEGURANCA (copie exatamente):',
  '  SEDUC 11/2023 + 3 TA',
  '  SEDUC 070/2023 + 3 TA',
  '  Prefeitura Palmas 077/2025 (SRP)',
  '  MP 007/2026',
  '  UFT - Seguranca Privada',
  '',
  'COMO IMPORTAR:',
  '  1. Preencha este arquivo com todos os funcionarios',
  '  2. Delete as linhas de exemplo (verdes)',
  '  3. Salve como .xlsx',
  '  4. No sistema: aba RH/DP > sub-aba Folhas > botao Excel em qualquer folha',
  '',
  'IMPORTANTE:',
  '  - O campo contrato_ref deve ser identico ao numContrato cadastrado no sistema',
  '  - O campo salario_base deve usar ponto como decimal (ex: 1518.00)',
  '  - Datas devem estar no formato AAAA-MM-DD',
];

linhas.forEach((linha, i) => {
  const r = ws2.addRow([linha]);
  if (i === 0) {
    r.getCell(1).font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  }
  if (linha.startsWith('  SEDUC') || linha.startsWith('  Prefeitura') || linha.startsWith('  MP') || linha.startsWith('  UFT')) {
    r.getCell(1).font = { color: { argb: 'FF0369A1' }, bold: true };
  }
});

wb.xlsx.writeFile('template_funcionarios_seguranca.xlsx')
  .then(() => console.log('OK: template_funcionarios_seguranca.xlsx criado com sucesso!'))
  .catch(e => console.error('ERRO:', e));
