const xlsx = require('xlsx');
const path = require('path');

const filePath = path.join('C:', 'Users', 'Avell', 'Downloads', 'Extratos_Comprovantes', 'ABRIL MONTANA SEGURANÇA', 'EXTRATO MONTANA SEGURANCA 1 A 22 04 2026.csv.xls');
console.log('Reading:', filePath);

try {
  const wb = xlsx.readFile(filePath);
  console.log('Sheets:', wb.SheetNames);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const range = xlsx.utils.decode_range(ws['!ref'] || 'A1:A1');
  console.log('Range:', ws['!ref'], '| rows:', range.e.r+1, '| cols:', range.e.c+1);

  // Print first 25 rows
  console.log('\n--- Primeiras 25 linhas ---');
  for (let r = 0; r <= Math.min(range.e.r, 24); r++) {
    let row = [];
    for (let c = 0; c <= range.e.c; c++) {
      const cell = ws[xlsx.utils.encode_cell({r, c})];
      if (cell && cell.v !== undefined && cell.v !== '') {
        row.push(c + ':' + String(cell.w || cell.v).trim().slice(0, 50));
      }
    }
    if (row.length) console.log('r' + r + ': ' + row.join(' | '));
  }

  // Print last 5 rows
  console.log('\n--- Últimas 5 linhas ---');
  for (let r = Math.max(0, range.e.r - 4); r <= range.e.r; r++) {
    let row = [];
    for (let c = 0; c <= range.e.c; c++) {
      const cell = ws[xlsx.utils.encode_cell({r, c})];
      if (cell && cell.v !== undefined && cell.v !== '') {
        row.push(c + ':' + String(cell.w || cell.v).trim().slice(0, 50));
      }
    }
    if (row.length) console.log('r' + r + ': ' + row.join(' | '));
  }
} catch(e) {
  console.error('ERRO:', e.message);
  // Try reading as CSV text
  const fs = require('fs');
  try {
    const content = fs.readFileSync(filePath, 'latin1');
    console.log('\nCONTEÚDO (primeiras 50 linhas, CSV):');
    content.split('\n').slice(0, 50).forEach((l, i) => console.log(i + ': ' + l.slice(0, 100)));
  } catch(e2) {
    console.error('Falha CSV também:', e2.message);
  }
}
