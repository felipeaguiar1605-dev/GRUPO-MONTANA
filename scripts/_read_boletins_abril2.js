const xlsx = require('xlsx');
const Database = require('better-sqlite3');

// ─── DETRAN: read all rows ───
const BASE = 'C:\\Users\\Avell\\Downloads\\BOLETINS DE MEDIÇÃO MONTANA ASSESSORIA';
const wb = xlsx.readFile(BASE + '\\BOLETIM DETRAN ABRIL 2026.xls');
console.log('=== DETRAN sheets:', wb.SheetNames);
wb.SheetNames.slice(0, 3).forEach(sn => {
  const ws = wb.Sheets[sn];
  const range = xlsx.utils.decode_range(ws['!ref'] || 'A1:A1');
  console.log('\nSheet:', sn, '(rows:', range.e.r+1, 'cols:', range.e.c+1, ')');
  for (let r = 0; r <= range.e.r; r++) {
    let rowData = [];
    for (let c = 0; c <= Math.min(range.e.c, 15); c++) {
      const addr = xlsx.utils.encode_cell({r,c});
      const cell = ws[addr];
      if (cell && cell.v !== undefined && cell.v !== '') {
        const v = cell.w || String(cell.v);
        rowData.push(c + ':' + v.trim().slice(0,40));
      }
    }
    if (rowData.length > 0) console.log('  r' + r + ': ' + rowData.join(' | '));
  }
});

// ─── Query bol_contratos ───
const db = new Database('C:\\Users\\Avell\\OneDrive\\Área de Trabalho\\Montana_Seg_Conciliacao\\app_unificado\\data\\assessoria\\montana.db', { readonly: true });
console.log('\n=== bol_contratos ===');
db.prepare('SELECT id, nome, numero_contrato, contratante FROM bol_contratos ORDER BY id').all()
  .forEach(r => console.log(`  id=${r.id} | nome="${r.nome}" | num="${r.numero_contrato}" | contratante="${r.contratante}"`));

console.log('\n=== bol_boletins 2026-04 ===');
db.prepare(`SELECT b.id, b.contrato_id, b.total_geral, b.status, bc.nome
            FROM bol_boletins b JOIN bol_contratos bc ON bc.id=b.contrato_id
            WHERE b.competencia='2026-04' ORDER BY b.id`).all()
  .forEach(r => console.log(`  bid=${r.id} cid=${r.contrato_id} total=${r.total_geral} status=${r.status} nome=${r.nome}`));
db.close();
