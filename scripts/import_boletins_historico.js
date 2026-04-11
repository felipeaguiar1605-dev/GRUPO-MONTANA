/**
 * Importação histórica dos Boletins de Medição — Montana Assessoria
 * Lê todos os arquivos Excel nas pastas de boletins e insere em bol_boletins
 *
 * Contratos MONTANA: SESAU (id=7), UFNT (id=8), UFT MOTORISTA (id=9), UNITINS (id=10)
 * Contratos LAÍSE:   UFT limpeza (id=1), DETRAN (id=2), SEMARH (id=3), PREVI (id=4), SEDUC (id=5)
 *
 * Uso: node scripts/import_boletins_historico.js [--dry-run]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const XLSX  = require('xlsx');
const fs    = require('fs');
const path  = require('path');
const { getDb } = require('../src/db');

const DRY_RUN = process.argv.includes('--dry-run');
const db = getDb('assessoria');

// ──────────────────────────────────────────────────────────────
// Configuração das pastas e IDs dos contratos
// ──────────────────────────────────────────────────────────────
const BASE_MONTANA = 'D:/ARQUIVO FINANCEIRO MONTANA/BOLETINS DE MEDIÇÃO/MONTANA';
const BASE_LAISE   = 'D:/ARQUIVO FINANCEIRO/BOLETINS DE MEDIÇÃO LAÍSE';

const CONTRATOS = [
  // MONTANA
  { id: 7,  nome: 'SESAU',         base: BASE_MONTANA, pasta: 'SESAU' },
  { id: 8,  nome: 'UFNT',          base: BASE_MONTANA, pasta: 'UFNT' },
  { id: 9,  nome: 'UFT MOTORISTA', base: BASE_MONTANA, pasta: 'UFT MOTORISTA' },
  { id: 10, nome: 'UNITINS',       base: BASE_MONTANA, pasta: 'UNTINS' },
  // LAÍSE
  { id: 1,  nome: 'UFT',           base: BASE_LAISE,   pasta: 'UFT' },
  { id: 2,  nome: 'DETRAN',        base: BASE_LAISE,   pasta: 'DETRAN' },
  { id: 3,  nome: 'SEMARH',        base: BASE_LAISE,   pasta: 'SEMARH' },
  { id: 4,  nome: 'PREVIPALMAS',   base: BASE_LAISE,   pasta: 'PREVIPALMAS' },
  { id: 5,  nome: 'SEDUC',         base: BASE_LAISE,   pasta: 'SEDUC' },
];

// Meses em português → número
const MESES = {
  JANEIRO:1,FEVEREIRO:2,MARÇO:3,MARCO:3,ABRIL:4,MAIO:5,JUNHO:6,
  JULHO:7,AGOSTO:8,SETEMBRO:9,OUTUBRO:10,OUTRUBRO:10,
  NOVEMBRO:11,DEZEMBRO:12
};

// ──────────────────────────────────────────────────────────────
// Extrai (mes, ano) de um nome de pasta
// Retorna [{ano, mes}] — pode retornar 2 para "JANEIRO E FEVEREIRO"
// ──────────────────────────────────────────────────────────────
function parsePastaMes(pasta) {
  const up = pasta.toUpperCase();
  // Extrai todos os anos encontrados
  const anos = [...up.matchAll(/\b(20\d{2})\b/g)].map(m => parseInt(m[1]));
  const ano  = anos.length ? anos[0] : null;
  if (!ano) return [];

  // Extrai todos os nomes de meses encontrados
  const result = [];
  for (const [nome, num] of Object.entries(MESES)) {
    if (up.includes(nome)) {
      // Evitar duplicatas (OUTUBRO/OUTRUBRO)
      if (!result.find(r => r.mes === num)) {
        result.push({ ano, mes: num });
      }
    }
  }
  // Se encontrou meses de dois anos diferentes (ex: DEZ 2024 E JAN 2025)
  if (anos.length >= 2 && result.length >= 2) {
    result[result.length - 1].ano = anos[anos.length - 1];
  }
  return result;
}

// ──────────────────────────────────────────────────────────────
// Extrai o maior valor numérico de um arquivo Excel
// (heurística: total do boletim costuma ser o maior valor único)
// ──────────────────────────────────────────────────────────────
function extrairTotalExcel(filePath) {
  try {
    const wb = XLSX.readFile(filePath, { type: 'file', cellNF: false, cellText: false });
    const ws  = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

    let maxVal  = 0;
    let totalLabel = null; // valor próximo de "TOTAL"

    for (let r = 0; r < data.length; r++) {
      const row = data[r];
      if (!Array.isArray(row)) continue;

      // Verifica se alguma célula da linha contém "TOTAL"
      const rowStr = row.join(' ').toUpperCase();
      const hasTotalLabel = rowStr.includes('TOTAL') &&
        !rowStr.includes('SUBTOTAL') &&
        !rowStr.includes('VALOR TOTAL MENSAL') === false; // permite "VALOR TOTAL"

      for (let c = 0; c < row.length; c++) {
        const v = row[c];
        if (typeof v === 'number' && v > 1000 && v < 99_000_000) {
          if (v > maxVal) maxVal = v;
          if (hasTotalLabel && v > (totalLabel || 0)) totalLabel = v;
        }
      }
    }

    // Prefere o valor perto do label TOTAL; fallback: maior valor
    const result = totalLabel || maxVal;
    return result > 1000 ? parseFloat(result.toFixed(2)) : null;
  } catch (e) {
    return null;
  }
}

// Pastas a ignorar (repactuação, retroativos, etc.)
const SKIP_DIRS = ['REPACTU', 'RETROAT', 'MODELO', 'NOTA DE DÉBITO', 'CONFERÊNCIA'];

// ──────────────────────────────────────────────────────────────
// Percorre recursivamente uma pasta e coleta todos .xls/.xlsx
// que pareçam boletins (contêm "BOLETIM" ou "EXTRATO" no nome)
// ──────────────────────────────────────────────────────────────
function coletarArquivos(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const up = e.name.toUpperCase();
      // Ignora pastas de repactuação/retroativos
      if (e.isDirectory()) {
        if (SKIP_DIRS.some(s => up.includes(s))) continue;
        results.push(...coletarArquivos(path.join(dir, e.name)));
      } else if (/\.(xls|xlsx)$/i.test(e.name)) {
        // Ignora arquivos que não são boletins/extratos
        if (!up.includes('BOLETIM') && !up.includes('EXTRATO')) continue;
        // Ignora arquivos temporários do Office
        if (e.name.startsWith('~$')) continue;
        results.push(path.join(dir, e.name));
      }
    }
  } catch {}
  return results;
}

// ──────────────────────────────────────────────────────────────
// Determina competência a partir do caminho do arquivo
// ──────────────────────────────────────────────────────────────
function inferirCompetencia(filePath) {
  // Tenta extrair do nome do arquivo primeiro, depois do path
  const parts = filePath.replace(/\\/g, '/').split('/');

  for (let i = parts.length - 1; i >= 0; i--) {
    const meses = parsePastaMes(parts[i]);
    if (meses.length) return meses; // retorna array de {ano, mes}
  }
  return [];
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────
const insStmt = db.prepare(`
  INSERT OR IGNORE INTO bol_boletins
    (contrato_id, competencia, data_emissao, periodo_inicio, periodo_fim, status, total_geral)
  VALUES (?,?,?,?,?,?,?)
`);

const existsStmt = db.prepare(
  'SELECT id FROM bol_boletins WHERE contrato_id=? AND competencia=? LIMIT 1'
);

function ultimoDia(ano, mes) {
  return new Date(ano, mes, 0).toISOString().split('T')[0];
}
function primeiroDia(ano, mes) {
  return `${ano}-${String(mes).padStart(2,'0')}-01`;
}
function compStr(ano, mes) {
  return `${ano}-${String(mes).padStart(2,'0')}`;
}

let totalInserido = 0, totalSkip = 0, totalErro = 0;
const erros = [];

for (const contrato of CONTRATOS) {
  const pastaContrato = path.join(contrato.base, contrato.pasta);
  const arquivos = coletarArquivos(pastaContrato);

  console.log(`\n📂 ${contrato.nome} (id=${contrato.id}) — ${arquivos.length} arquivo(s)`);

  for (const arq of arquivos) {
    const competencias = inferirCompetencia(arq);
    if (!competencias.length) {
      erros.push(`  ⚠️  Sem data: ${path.basename(arq)}`);
      totalErro++;
      continue;
    }

    const total = extrairTotalExcel(arq);
    if (!total) {
      erros.push(`  ⚠️  Sem valor: ${path.basename(arq)}`);
      totalErro++;
      continue;
    }

    for (const { ano, mes } of competencias) {
      const comp = compStr(ano, mes);

      // Pula 2026 — já inserido
      if (ano === 2026) { totalSkip++; continue; }

      const already = existsStmt.get(contrato.id, comp);
      if (already) { totalSkip++; continue; }

      const isAtual = ano === 2026;
      const status  = isAtual ? 'pendente' : 'aprovado';

      if (!DRY_RUN) {
        insStmt.run(
          contrato.id, comp,
          ultimoDia(ano, mes),
          primeiroDia(ano, mes),
          ultimoDia(ano, mes),
          status, total
        );
      }
      console.log(`  ✅ ${comp} — R$ ${total.toLocaleString('pt-BR',{minimumFractionDigits:2})} [${path.basename(arq)}]`);
      totalInserido++;
    }
  }
}

if (erros.length) {
  console.log('\n⚠️  Arquivos sem dados:');
  erros.forEach(e => console.log(e));
}

const totBol = db.prepare('SELECT COUNT(*) n FROM bol_boletins').get().n;
console.log(`\n${'═'.repeat(55)}`);
console.log(`✅ Concluído — Inseridos: ${totalInserido} | Já existiam/2026: ${totalSkip} | Sem dados: ${totalErro}`);
console.log(`📊 Total bol_boletins no banco: ${totBol}`);

// Resumo por contrato e ano
console.log('\nResumo por contrato:');
const resumo = db.prepare(`
  SELECT bc.nome, substr(b.competencia,1,4) ano, COUNT(*) qtd, SUM(b.total_geral) total
  FROM bol_boletins b
  JOIN bol_contratos bc ON bc.id = b.contrato_id
  GROUP BY bc.nome, ano
  ORDER BY bc.nome, ano
`).all();
let lastNome = '';
for (const r of resumo) {
  if (r.nome !== lastNome) { console.log(`\n  ${r.nome}`); lastNome = r.nome; }
  console.log(`    ${r.ano}: ${r.qtd} mês(es) — R$ ${Number(r.total).toLocaleString('pt-BR',{minimumFractionDigits:2})}`);
}
