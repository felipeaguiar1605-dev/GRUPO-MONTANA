const XLSX = require('xlsx');
const path = process.argv[2] || 'C:\\Users\\Avell\\Downloads\\relatorio_apuracao_pis_cofins_ASSESSORIA_MAR2026.xlsx';
const wb = XLSX.readFile(path);

// Dump completo do Resumo Executivo (aba de contratos)
console.log('\n========== RESUMO EXECUTIVO (TODAS AS LINHAS) ==========');
const rows = XLSX.utils.sheet_to_json(wb.Sheets['Resumo Executivo'], { header: 1, defval: '' });
rows.forEach((r, i) => {
  console.log(String(i + 1).padStart(3), '|', r.map(c => String(c).padEnd(38)).join(' | '));
});

// Créditos bancários não identificados
console.log('\n\n========== CRÉDITOS BANCÁRIOS — NÃO IDENTIFICADOS ==========');
const rows2 = XLSX.utils.sheet_to_json(wb.Sheets['Créditos Bancários MAR2026'], { defval: '' });
const naoId = rows2.filter(r => String(r['Tomador / Observação'] || '').toLowerCase().includes('não identific') || String(r['Classificação'] || '').toLowerCase().includes('não identific'));
console.log('Total não identificados:', naoId.length);
let total = 0;
for (const r of naoId) {
  total += Number(r['Valor (R$)'] || 0);
  console.log(' ', r['Data'], '| R$', Number(r['Valor (R$)'] || 0).toFixed(2).padStart(12), '|', String(r['Histórico Bancário'] || '').slice(0, 80));
}
console.log('TOTAL não identificado: R$', total.toFixed(2));
