const xlsx = require('xlsx');
const BASE = 'C:\\Users\\Avell\\Downloads\\BOLETINS DE MEDIÇÃO MONTANA ASSESSORIA';
const files = [
  'BOLETIM DETRAN ABRIL 2026.xls',
  'BOLETIM MEDIÇÃO UFT ABRIL 2026.xls',
  'BOLETIM PREVIPALMAS ABRIL 2026.xls',
  'BOLETIM SEDUC ABRIL 2026.xls'
];
files.forEach(f => {
  try {
    const wb = xlsx.readFile(BASE + '\\' + f);
    console.log('=== ' + f + ' ===');
    wb.SheetNames.forEach(sn => {
      const ws = wb.Sheets[sn];
      const range = xlsx.utils.decode_range(ws['!ref'] || 'A1:A1');
      console.log('  Sheet: ' + sn + ' rows:' + (range.e.r+1) + ' cols:' + (range.e.c+1));
      // Print last 20 rows to find totals
      const startRow = Math.max(0, range.e.r - 20);
      for (let r = startRow; r <= range.e.r; r++) {
        let rowData = [];
        for (let c = 0; c <= range.e.c; c++) {
          const addr = xlsx.utils.encode_cell({r,c});
          const cell = ws[addr];
          if (cell && cell.v !== undefined && cell.v !== '') {
            rowData.push(c + ':' + (cell.w || cell.v));
          }
        }
        if (rowData.length > 0) console.log('    row' + r + ': ' + rowData.join(' | '));
      }
    });
  } catch(e) { console.log('ERRO ' + f + ': ' + e.message); }
});
