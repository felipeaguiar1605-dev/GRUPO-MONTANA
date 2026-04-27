const { PDFParse } = require('pdf-parse');
const fs = require('fs');

const buf = fs.readFileSync('C:/Users/Avell/AppData/Local/Temp/boletim_semarh_mar26.pdf');
const parser = new PDFParse();

parser.parse(buf).then(d => {
  const lines = d.text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  console.log('=== BOLETIM SEMARH MAR/2026 — texto extraído ===');
  lines.forEach((l, i) => console.log(`${i}: ${l}`));
}).catch(err => {
  console.error('Erro parser:', err.message);
  // fallback: raw text
  const raw = buf.toString('latin1');
  const nums = raw.match(/[\d]{1,3}\.[\d]{3},[\d]{2}/g);
  if (nums) {
    console.log('Valores numéricos encontrados (bruto):');
    [...new Set(nums)].sort((a,b) => {
      const va = parseFloat(a.replace('.','').replace(',','.'));
      const vb = parseFloat(b.replace('.','').replace(',','.'));
      return va - vb;
    }).forEach(n => console.log(' ', n));
  }
});
