process.stderr.write = () => {};  // suppress stderr from pdf-parse internals
const { PDFParse } = require('pdf-parse');
const fs = require('fs');
const buf = fs.readFileSync('C:/Users/Avell/AppData/Local/Temp/boletim_semarh_mar26.pdf');
const parser = new PDFParse();
parser.parse(buf).then(d => {
  const lines = d.text.split(/[\n\r]+/).map(l => l.trim()).filter(l => l.length > 0);
  process.stdout.write('=== TOTAL LINHAS: ' + lines.length + '\n');
  lines.forEach((l, i) => process.stdout.write(i + ': ' + l + '\n'));
}).catch(e => {
  process.stdout.write('ERRO: ' + e.message + '\n');
});
