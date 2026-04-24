/**
 * Inspeciona datas e valores brutos do extrato Segurança Abril 2026
 */
const xlsx = require('xlsx');
const path = require('path');

const filePath = path.join('C:', 'Users', 'Avell', 'Downloads', 'Extratos_Comprovantes', 'ABRIL MONTANA SEGURANÇA', 'EXTRATO MONTANA SEGURANCA 1 A 22 04 2026.csv.xls');
const wb = xlsx.readFile(filePath);
const ws = wb.Sheets[wb.SheetNames[0]];
const range = xlsx.utils.decode_range(ws['!ref']);

console.log('Total rows:', range.e.r + 1);

// Analyse date column (col 3) — check raw type/value
console.log('\n--- Date column (col 3) raw analysis (first 10 rows) ---');
for (let r = 0; r <= Math.min(range.e.r, 9); r++) {
  const cell = ws[xlsx.utils.encode_cell({r, c: 3})];
  if (cell) {
    console.log(`r${r}: type=${cell.t} | v=${JSON.stringify(cell.v)} | w=${JSON.stringify(cell.w)} | z=${cell.z || 'n/a'}`);
  }
}

// Parse dates intelligently
function parseDate(cell) {
  if (!cell) return null;
  if (cell.t === 'n' && cell.v > 40000 && cell.v < 50000) {
    // Excel serial date — convert properly
    const d = xlsx.SSF.parse_date_code(cell.v);
    return `${String(d.y).padStart(4,'0')}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
  }
  if (cell.t === 's' || (cell.w)) {
    const s = (cell.w || String(cell.v)).trim();
    // DD.MM.YYYY
    let m = s.match(/^(\d{1,2})\.(\d{2})\.(\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    // D/M/YY or M/D/YY — ambiguous. Check month value.
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
    if (m) {
      const a = parseInt(m[1]), b = parseInt(m[2]), y = 2000 + parseInt(m[3]);
      // If a > 12 → day first; if b > 12 → month first (a is month)
      const [day, mon] = a > 12 ? [a, b] : (b > 12 ? [b, a] : [b, a]); // default M/D when ambiguous
      return `${y}-${String(mon).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }
    // D/M/YYYY or M/D/YYYY
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      const a = parseInt(m[1]), b = parseInt(m[2]), y = parseInt(m[3]);
      const [day, mon] = a > 12 ? [a, b] : [b, a];
      return `${y}-${String(mon).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }
  }
  return cell.w || String(cell.v);
}

function parseValor(cell) {
  if (!cell) return 0;
  if (cell.t === 'n') return cell.v;
  const s = String(cell.w || cell.v).trim().replace(/\./g,'').replace(',','.');
  return parseFloat(s) || 0;
}

// Build rows
const rows = [];
for (let r = 0; r <= range.e.r; r++) {
  const get = c => ws[xlsx.utils.encode_cell({r,c})];
  const historico = (get(9)?.v || '').trim();
  if (!historico || historico === 'S A L D O' || historico === 'Saldo Anterior') continue;

  const data = parseDate(get(3));
  const valor = parseValor(get(10));
  const dc = (get(11)?.v || '').trim();
  const complemento = (get(12)?.v || '').trim();

  rows.push({ data, historico, valor, dc, complemento });
}

// Show month distribution
const byMonth = {};
rows.forEach(r => {
  const m = r.data ? r.data.slice(0, 7) : 'unknown';
  byMonth[m] = (byMonth[m] || 0) + 1;
});
console.log('\n--- Distribuição por mês ---');
Object.entries(byMonth).sort().forEach(([m, n]) => console.log(`  ${m}: ${n} lançamentos`));

// Show credit rows (potential NF payments)
const creditos = rows.filter(r => r.dc === 'C' && r.valor > 20000);
console.log('\n--- Créditos > R$20k ---');
creditos.forEach(r => console.log(`  ${r.data} | R$${r.valor.toLocaleString('pt-BR')} | ${r.historico} | ${r.complemento.slice(0,60)}`));

console.log('\nTotal rows processados:', rows.length);
console.log('Total créditos (C):', rows.filter(r => r.dc === 'C').length, '=', rows.filter(r => r.dc === 'C').reduce((s,r) => s+r.valor, 0).toLocaleString('pt-BR'));
console.log('Total débitos  (D):', rows.filter(r => r.dc === 'D').length, '=', rows.filter(r => r.dc === 'D').reduce((s,r) => s+r.valor, 0).toLocaleString('pt-BR'));
