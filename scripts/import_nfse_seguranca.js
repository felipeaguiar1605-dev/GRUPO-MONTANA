/**
 * Importação NFS-e Montana Segurança — 2024/2025/2026
 * Fonte: WebISS export CSV
 * Uso: node scripts/import_nfse_seguranca.js [--dry-run]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs   = require('fs');
const path = require('path');
const { getDb } = require('../src/db');

const CSV_PATH = path.join('C:/Users/Avell/Downloads/NFS-e_Montana_ERP_Import/NFS-e_Montana_Seguranca_2024_2025_2026.csv');
const DRY_RUN  = process.argv.includes('--dry-run');

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseBR(val) {
  // "110.129,96" → 110129.96
  if (!val || val.trim() === '' || val.trim() === '0') return 0;
  return parseFloat(val.replace(/\./g, '').replace(',', '.')) || 0;
}

function parseDate(val) {
  // "20/12/2024" → "2024-12-20"
  if (!val || !val.includes('/')) return '';
  const [d, m, y] = val.split('/');
  if (!d || !m || !y) return '';
  return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

function formatCompetencia(val) {
  // "12/2024" → "dez/24"  |  "01/2025" → "jan/25"
  if (!val) return '';
  const meses = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  const [m, y] = val.split('/');
  const idx = parseInt(m, 10) - 1;
  if (idx < 0 || idx > 11 || !y) return val;
  return `${meses[idx]}/${y.slice(-2)}`;
}

function parseCsv(content) {
  const lines = content.trim().split('\n');
  const header = parseLine(lines[0]);
  return lines.slice(1).map(l => {
    const cols = parseLine(l);
    const obj = {};
    header.forEach((h, i) => { obj[h] = (cols[i] || '').trim(); });
    return obj;
  }).filter(r => r['Numero']); // descarta linhas vazias
}

function parseLine(line) {
  const cols = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if (c === ',' && !inQ) { cols.push(cur); cur = ''; }
    else cur += c;
  }
  cols.push(cur);
  return cols;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const db  = getDb('seguranca');
const csv = fs.readFileSync(CSV_PATH, 'utf-8');
const rows = parseCsv(csv);

console.log(`\n📄 CSV lido: ${rows.length} registros`);

// Deduplicação: verifica IDs já existentes (webiss_numero_nfse OU numero WebISS)
const existIds  = new Set(
  db.prepare('SELECT webiss_numero_nfse FROM notas_fiscais WHERE webiss_numero_nfse IS NOT NULL')
    .all().map(r => r.webiss_numero_nfse)
);
const existNums = new Set(
  db.prepare('SELECT numero FROM notas_fiscais').all().map(r => r.numero)
);

console.log(`ℹ️  NFs já existentes no banco: ${db.prepare('SELECT COUNT(*) n FROM notas_fiscais').get().n}`);
console.log(`ℹ️  IDs WebISS já registrados: ${existIds.size}`);

const inserir = [];
const pulados = [];

for (const r of rows) {
  const webissId  = r['ID'];
  const numero    = r['Numero'];

  // Pula se já existe por ID WebISS ou por número
  if (existIds.has(webissId) || existNums.has(numero)) {
    pulados.push(numero);
    continue;
  }

  const valorBruto  = parseBR(r['Total_R$']);
  const issqn       = parseBR(r['ISSQN_R$']);
  const retido      = r['Retido'] === 'SIM';
  const retencao    = retido ? issqn : 0;
  const valorLiq    = valorBruto - retencao;

  inserir.push({
    numero,
    competencia:        formatCompetencia(r['Competencia']),
    cidade:             r['Incidencia']   || '',
    tomador:            r['Razao_Social'] || '',
    cnpj_tomador:       r['CNPJ_Tomador'] || '',
    valor_bruto:        valorBruto,
    valor_liquido:      +valorLiq.toFixed(2),
    iss:                issqn,
    retencao:           +retencao.toFixed(2),
    inss:               0,
    ir:                 0,
    csll:               0,
    pis:                0,
    cofins:             0,
    data_emissao:       parseDate(r['Emissao']),
    discriminacao:      r['Discriminacao'] || '',
    webiss_numero_nfse: webissId || null,
    status_conciliacao: 'PENDENTE',
  });
}

console.log(`\n📊 Resultado da análise:`);
console.log(`  ✅ Para importar:  ${inserir.length}`);
console.log(`  ⏭️  Pulados (duplic): ${pulados.length}`);

// Distribuição por ano
const porAno = {};
inserir.forEach(n => {
  const ano = n.data_emissao?.substring(0,4) || 'sem data';
  porAno[ano] = (porAno[ano]||0) + 1;
});
console.log(`  📅 Por ano:`, porAno);

// Total R$
const totalBruto = inserir.reduce((s,n) => s + n.valor_bruto, 0);
console.log(`  💰 Total bruto: R$ ${totalBruto.toLocaleString('pt-BR', {minimumFractionDigits:2})}`);

if (DRY_RUN) {
  console.log('\n⚠️  DRY RUN — nenhuma alteração feita.');
  process.exit(0);
}

// ── Inserção em transação ─────────────────────────────────────────────────────
const stmt = db.prepare(`
  INSERT INTO notas_fiscais
    (numero, competencia, cidade, tomador, cnpj_tomador,
     valor_bruto, valor_liquido, iss, retencao,
     inss, ir, csll, pis, cofins,
     data_emissao, discriminacao, webiss_numero_nfse, status_conciliacao)
  VALUES
    (@numero, @competencia, @cidade, @tomador, @cnpj_tomador,
     @valor_bruto, @valor_liquido, @iss, @retencao,
     @inss, @ir, @csll, @pis, @cofins,
     @data_emissao, @discriminacao, @webiss_numero_nfse, @status_conciliacao)
`);

const importar = db.transaction((rows) => {
  let ok = 0, err = 0;
  for (const row of rows) {
    try { stmt.run(row); ok++; }
    catch(e) { err++; console.error(`  ❌ Erro na NF ${row.numero}:`, e.message); }
  }
  return { ok, err };
});

console.log('\n⏳ Importando...');
const { ok, err } = importar(inserir);

console.log(`\n✅ Importação concluída:`);
console.log(`  Inseridas: ${ok}`);
console.log(`  Erros:     ${err}`);
const total = db.prepare('SELECT COUNT(*) n FROM notas_fiscais').get();
console.log(`  Total no banco agora: ${total.n}`);
