'use strict';
/**
 * Importa arquivos OFX para a Segurança (ou Assessoria) direto no DB.
 * Reusa o parser de src/routes/ofx.js.
 *
 * Uso:
 *   node scripts/importar_ofx_seguranca.js <pasta> [empresa]
 *   ex: node scripts/importar_ofx_seguranca.js fontes/seguranca/extratos_1090437_ofx seguranca
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const argsPos = process.argv.slice(2).filter(a => !a.startsWith('--'));
const pasta = argsPos[0];
const empresa = (argsPos[1] || 'seguranca').toLowerCase();
if (!pasta) {
  console.error('Uso: node scripts/importar_ofx_seguranca.js <pasta> [empresa]');
  process.exit(1);
}

function parseDataOFX(dt) { return `${dt.slice(0,4)}-${dt.slice(4,6)}-${dt.slice(6,8)}`; }
function derivarMes(iso) {
  const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const p = iso.split('-');
  return `${meses[parseInt(p[1])-1]}/${p[0]}`;
}

function detectarBanco(texto) {
  const fid = texto.match(/<FID>\s*(\d+)/i);
  if (fid) {
    const n = parseInt(fid[1]);
    if (n === 1)   return 'BB';
    if (n === 70)  return 'BRB';
    if (n === 104) return 'CEF';
  }
  const org = texto.match(/<ORG>\s*([^\r\n<]+)/i);
  if (org) {
    const o = org[1].toLowerCase();
    if (o.includes('brasil') || o.includes('bb')) return 'BB';
    if (o.includes('brb')) return 'BRB';
    if (o.includes('caixa') || o.includes('cef')) return 'CEF';
  }
  return 'BB';
}

function parsearOFX(texto) {
  const trs = [];
  const c = texto.replace(/\r\n/g, '\n');
  const re = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let m;
  while ((m = re.exec(c)) !== null) {
    const b = m[1];
    const fitid = (b.match(/<FITID>\s*([^\r\n<]+)/i) || [])[1];
    const dt = (b.match(/<DTPOSTED>\s*([^\r\n<]+)/i) || [])[1];
    const vl = (b.match(/<TRNAMT>\s*([^\r\n<]+)/i) || [])[1];
    const memo = (b.match(/<MEMO>\s*([^\r\n<]+)/i) || [])[1];
    const name = (b.match(/<NAME>\s*([^\r\n<]+)/i) || [])[1];
    if (!fitid || !dt || vl === undefined) continue;
    const v = parseFloat(String(vl).replace(',', '.'));
    if (isNaN(v)) continue;
    trs.push({
      fitid: fitid.trim(), dataIso: parseDataOFX(dt),
      historico: (memo || name || '').trim(),
      credito: v > 0 ? v : null,
      debito: v < 0 ? Math.abs(v) : null,
    });
  }
  return trs;
}

function ensureFitidColumn(db) {
  const cols = db.prepare('PRAGMA table_info(extratos)').all();
  if (!cols.some(c => c.name === 'ofx_fitid')) {
    db.exec('ALTER TABLE extratos ADD COLUMN ofx_fitid TEXT');
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_extratos_fitid ON extratos(ofx_fitid)'); } catch (_) {}
  }
}

const db = getDb(empresa);
ensureFitidColumn(db);
const pastaAbs = path.isAbsolute(pasta) ? pasta : path.join(__dirname, '..', pasta);
const files = fs.readdirSync(pastaAbs).filter(f => f.toLowerCase().endsWith('.ofx'));
console.log(`\n📂 ${pastaAbs}\n  Arquivos OFX: ${files.length}`);

const stmtInsert = db.prepare(`
  INSERT OR IGNORE INTO extratos
    (mes, data, data_iso, tipo, historico, debito, credito, status_conciliacao, banco, conta, ofx_fitid, created_at, updated_at)
  VALUES (@mes, @data, @data_iso, @tipo, @historico, @debito, @credito, 'PENDENTE', @banco, @conta, @ofx_fitid, datetime('now'), datetime('now'))
`);
const checkFitid = db.prepare(`SELECT 1 FROM extratos WHERE ofx_fitid=? AND ofx_fitid!='' LIMIT 1`);

let totalImp = 0, totalDup = 0, totalTrs = 0;
for (const f of files) {
  const abs = path.join(pastaAbs, f);
  const buf = fs.readFileSync(abs);
  const header = buf.slice(0, 200).toString('ascii');
  const texto = /CHARSET:\s*1252/i.test(header) ? buf.toString('latin1') : buf.toString('utf8');
  const banco = detectarBanco(texto);
  const contaMatch = texto.match(/<ACCTID>\s*([^\r\n<]+)/i);
  const conta = contaMatch ? contaMatch[1].trim() : '';
  const trs = parsearOFX(texto);
  totalTrs += trs.length;

  let imp = 0, dup = 0;
  const tx = db.transaction(() => {
    for (const t of trs) {
      if (checkFitid.get(t.fitid)) { dup++; continue; }
      const p = t.dataIso.split('-');
      const r = stmtInsert.run({
        mes: derivarMes(t.dataIso),
        data: `${p[2]}/${p[1]}/${p[0]}`,
        data_iso: t.dataIso,
        tipo: t.credito ? 'C' : 'D',
        historico: t.historico,
        debito: t.debito,
        credito: t.credito,
        banco, conta,
        ofx_fitid: t.fitid,
      });
      if (r.changes > 0) imp++; else dup++;
    }
  });
  tx();
  totalImp += imp; totalDup += dup;
  console.log(`  ✔ ${f} [${banco} ${conta}] ${trs.length} tr | ${imp} imp | ${dup} dup`);
}
console.log(`\n✅ Total: ${totalTrs} trs | ${totalImp} importados | ${totalDup} duplicatas`);
db.close();
