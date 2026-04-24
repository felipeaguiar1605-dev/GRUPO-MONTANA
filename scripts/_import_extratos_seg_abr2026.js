/**
 * Importa extrato BB — Montana Segurança — Abril 2026 (01/04 a 22/04)
 *
 * Arquivo: EXTRATO MONTANA SEGURANCA 1 A 22 04 2026.csv.xls
 * Ag: 15059  Conta: 000000666203
 *
 * Encoding de datas: 2 esquemas coexistem no mesmo arquivo:
 *   A) serial - 46024 = dia de abril (serials 46025–46046 → abril 1–22)
 *   B) SSF.m = dia de abril (para Rende Fácil / Pix; SSF devolve {y:2026,m:<dia>,d:3})
 *
 * Valores: armazenados em CENTAVOS → dividir por 100.
 *
 * FIRST RUN: apaga registros anteriores de 2026-04 (se houver) para reimport limpo.
 */
const xlsx    = require('xlsx');
const path    = require('path');
const Database = require('better-sqlite3');

const FILE = path.join('C:', 'Users', 'Avell', 'Downloads', 'Extratos_Comprovantes',
  'ABRIL MONTANA SEGURANÇA', 'EXTRATO MONTANA SEGURANCA 1 A 22 04 2026.csv.xls');
const DB_PATH = 'data/seguranca/montana.db';

const SERIAL_ABRIL_BASE = 46024; // serial 46025 → dia 1 de abril

// ─── helpers ──────────────────────────────────────────────────────────────────
function parseDate(cell) {
  if (!cell) return null;

  if (cell.t === 'n') {
    const intPart = Math.floor(cell.v);
    // Scheme A: offset
    const dayA = intPart - SERIAL_ABRIL_BASE;
    if (dayA >= 1 && dayA <= 22) {
      return mkDate(dayA);
    }
    // Scheme B: SSF month = April day
    try {
      const d = xlsx.SSF.parse_date_code(intPart);
      if (d.y === 2026 && d.m >= 1 && d.m <= 22 && d.d === 3) {
        return mkDate(d.m);
      }
      // generic fallback: might be April entry with standard Excel serial
      if (d.y === 2026 && d.m === 4 && d.d >= 1 && d.d <= 22) {
        return mkDate(d.d);
      }
    } catch(_) {}
    return null;
  }

  // Text: DD.MM.YYYY or similar
  const s = String(cell.v || '').trim();
  const m = s.match(/^(\d{1,2})[.\/\-](\d{2})[.\/\-](\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    return {
      iso: `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`,
      br:  `${d.padStart(2,'0')}/${mo}/${y}`,
    };
  }
  return null;
}

function mkDate(day) {
  const d = String(day).padStart(2,'0');
  return { iso: `2026-04-${d}`, br: `${d}/04/2026` };
}

function parseValor(cell) {
  if (!cell) return 0;
  if (cell.t === 'n') return Math.abs(cell.v) / 100; // centavos → reais
  const s = String(cell.w || cell.v || '').trim()
    .replace(/[^0-9,\-]/g, '')
    .replace(',', '.');
  return Math.abs(parseFloat(s) || 0);
}

// ─── read ──────────────────────────────────────────────────────────────────────
const wb = xlsx.readFile(FILE);
const ws = wb.Sheets[wb.SheetNames[0]];
const range = xlsx.utils.decode_range(ws['!ref']);

const CONTA = '000000666203';
const MES   = 'ABR';  // matches existing convention in extratos (Portuguese abbreviation)
const rows  = [];
let skipped = 0;

for (let r = 0; r <= range.e.r; r++) {
  const get = c => ws[xlsx.utils.encode_cell({r, c})];

  const historico = String(get(9)?.v || '').trim();
  if (!historico || historico === 'S A L D O' || historico === 'Saldo Anterior') {
    skipped++; continue;
  }

  const dateParsed = parseDate(get(3));
  if (!dateParsed) { skipped++; continue; }

  const valor = parseValor(get(10));
  const dc    = String(get(11)?.v || '').trim().toUpperCase();
  if (!dc || valor === 0) { skipped++; continue; }

  const complemento = String(get(12)?.v || '').trim();
  const documento   = String(get(7)?.v || '').trim();
  const codHist     = String(get(6)?.v || '').trim();
  const descFull    = complemento ? `${historico} ${complemento}`.trim() : historico;
  const fitid       = `SEG-ABR26-${r}-${documento || codHist}`;

  rows.push({
    data_iso: dateParsed.iso,
    data_br:  dateParsed.br,
    credito:  dc === 'C' ? valor : null,
    debito:   dc === 'D' ? valor : null,
    historico: descFull,
    fitid,
  });
}

// Stats
const creditos = rows.filter(r => r.credito);
const debitos  = rows.filter(r => r.debito);
const sumC = creditos.reduce((s,r)=>s+r.credito,0);
const sumD = debitos.reduce((s,r)=>s+r.debito,0);
console.log(`\n📋 ${rows.length} lançamentos (${creditos.length}C + ${debitos.length}D) | skipped: ${skipped}`);
console.log(`   Créditos: R$ ${sumC.toLocaleString('pt-BR',{minimumFractionDigits:2})}`);
console.log(`   Débitos:  R$ ${sumD.toLocaleString('pt-BR',{minimumFractionDigits:2})}`);

// Show large credits
console.log('\n🔍 Créditos > R$ 20.000:');
rows.filter(r => r.credito && r.credito > 20000)
  .forEach(r => console.log(`   ${r.data_iso} | R$ ${r.credito.toLocaleString('pt-BR',{minimumFractionDigits:2})} | ${r.historico.slice(0,70)}`));

// Date distribution
const byDate = {};
rows.forEach(r => { byDate[r.data_iso] = (byDate[r.data_iso]||0)+1; });
console.log('\n📅 Distribuição por data:');
Object.entries(byDate).sort().forEach(([d,n]) => console.log(`   ${d}: ${n}`));

// ─── import ────────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);

// Remove any previous April 2026 entries (safe guard)
const deleted = db.prepare(`DELETE FROM extratos WHERE mes = '${MES}' AND data_iso >= '2026-04-01'`).run();
if (deleted.changes > 0) console.log(`\n🗑  Removidos ${deleted.changes} registros anteriores de ${MES}`);

const insertStmt = db.prepare(`
  INSERT INTO extratos
    (mes, data, data_iso, tipo, historico, credito, debito,
     status_conciliacao, banco, conta, ofx_fitid, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDENTE', 'BB', ?, ?, datetime('now'))
`);

const tx = db.transaction(() => {
  let n = 0;
  for (const row of rows) {
    insertStmt.run(
      MES, row.data_br, row.data_iso,
      row.credito ? 'CREDITO' : 'DEBITO',
      row.historico,
      row.credito ?? null,
      row.debito  ?? null,
      CONTA, row.fitid
    );
    n++;
  }
  return n;
});

const n = tx();
console.log(`\n✅ Inseridos: ${n}`);

// Verify
const check = db.prepare(`
  SELECT strftime('%Y-%m', data_iso) m, COUNT(*) n,
         ROUND(SUM(COALESCE(credito,0)),2) cred,
         ROUND(SUM(COALESCE(debito,0)),2) deb
  FROM extratos WHERE data_iso >= '2026-04-01'
  GROUP BY m ORDER BY m
`).all();
console.log('\n📊 Extratos após import:');
check.forEach(r => {
  const fc = r.cred?.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}) || '0';
  const fd = r.deb?.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}) || '0';
  console.log(`   ${r.m}: ${r.n} lançamentos | cred R$${fc} | deb R$${fd}`);
});

db.close();
