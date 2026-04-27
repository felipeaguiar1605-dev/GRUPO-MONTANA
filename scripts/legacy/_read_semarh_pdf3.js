process.stderr.write = () => {};
const { PDFParse } = require('pdf-parse');
const fs = require('fs');
const buf = fs.readFileSync('C:/Users/Avell/AppData/Local/Temp/boletim_semarh_mar26.pdf');
const parser = new PDFParse();
parser.parse(buf).then(d => {
  fs.writeFileSync('C:/Users/Avell/AppData/Local/Temp/semarh_text.txt', d.text, 'utf8');
  process.stdout.write('OK pages=' + d.numpages + '\n');
}).catch(e => {
  fs.writeFileSync('C:/Users/Avell/AppData/Local/Temp/semarh_err.txt', e.stack || e.message, 'utf8');
  process.stdout.write('ERRO: ' + e.message + '\n');
});
