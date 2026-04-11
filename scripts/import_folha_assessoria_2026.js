/**
 * Importação Folha de Pagamento — Montana Assessoria Jan/Fev 2026
 * Lê os arquivos XLSX e popula rh_funcionarios + rh_folha + rh_folha_itens
 * Uso: node scripts/import_folha_assessoria_2026.js [--dry-run]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const ExcelJS = require('exceljs');
const path    = require('path');
const { getDb } = require('../src/db');

const DRY_RUN = process.argv.includes('--dry-run');
const BASE    = 'D:/ARQUIVO FINANCEIRO MONTANA/FOLHA MENSAL MONTANA/ANO 2026';

const ARQUIVOS = [
  { path: path.join(BASE, 'JANEIRO 2026',   'FOLHA JANEIRO 2026 - UFT, UFNT E LIMPEZA 22.xlsx'),   competencia: '2026-01', label: 'Janeiro/2026'   },
  { path: path.join(BASE, 'FEVEREIRO 2026', 'FOLHA FEVEREIRO 2026 - UFT, UFNT E LIMPEZA 22.xlsx'), competencia: '2026-02', label: 'Fevereiro/2026' },
];

// Abas a ignorar (controle interno, não são listas de funcionários)
const ABAS_IGNORAR = new Set([
  'ALTERAÇÃO INTERNA', 'ALTERAÇÃO JANEIRO 2026', 'ALTERAÇÃO FEVEREIRO 2026',
  'AFASTADOS', 'RESCISÕES FEVEREIRO',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseFaltas(cell) {
  if (!cell) return 0;
  const m = String(cell).match(/^(\d+)\s*FALTA/i);
  return m ? parseInt(m[1]) : 0;
}

function parseValor(cell) {
  if (!cell && cell !== 0) return 0;
  const v = typeof cell === 'object' && cell.result !== undefined ? cell.result : cell;
  const n = parseFloat(String(v).replace(',', '.'));
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

function normalizeName(nome) {
  return String(nome || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

// ── Lê uma sheet e retorna linhas de funcionários ─────────────────────────────

function lerSheet(ws) {
  const funcionarios = [];
  let headerRow = -1;
  let colNome = -1, colFuncao = -1, colFaltas = -1;
  let colVR = -1, colVL = -1, colVT = -1, colSeg = -1, colCons = -1, colObs = -1, colPosto = -1;

  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    const vals = [];
    row.eachCell({ includeEmpty: true }, (cell, colNum) => {
      vals[colNum] = cell.value;
    });

    const rowText = vals.map(v => String(v || '')).join('|').toUpperCase();

    // Detecta linha de cabeçalho
    if (headerRow === -1 && rowText.includes('NOME')) {
      headerRow = rowNum;
      vals.forEach((v, i) => {
        const t = String(v || '').toUpperCase().trim();
        if (t === 'NOME')                                    colNome   = i;
        else if (t === 'FUNÇÃO' || t === 'FUNCAO')          colFuncao = i;
        else if (t === 'FALTAS')                             colFaltas = i;
        else if (t.includes('VALE REFEIÇÃO') || t.includes('VALE REFEICAO') || t.includes('VR')) colVR = i;
        else if (t.includes('VALE LANCHE') || t.includes('VL'))   colVL  = i;
        else if (t.includes('VALE TRANSPORTE') || t.includes('VT')) colVT = i;
        else if (t.includes('SEGURO'))                       colSeg  = i;
        else if (t.includes('CONSIG'))                       colCons = i;
        else if (t.includes('OBSERVA'))                      colObs  = i;
        else if (t === 'POSTO' || t === 'CAMPUS' || t === 'LOTAÇÃO' || t === 'LOTACAO') colPosto = i;
      });
      return;
    }

    if (headerRow === -1) return; // ainda não achou header
    if (colNome === -1) return;

    const nome = normalizeName(vals[colNome]);
    if (!nome || nome.length < 3) return; // linha vazia ou subtotal

    // Ignora linhas que são totais/títulos
    if (/^(TOTAL|SUBTOTAL|QT|QTD|\d+$)/.test(nome)) return;

    const funcao = String(vals[colFuncao] || '').trim().toUpperCase() || 'NÃO INFORMADO';
    const posto  = String(vals[colPosto]  || ws.name || '').trim().toUpperCase();
    const faltas = colFaltas !== -1 ? parseFaltas(vals[colFaltas]) : 0;
    const vr     = colVR  !== -1 ? parseValor(vals[colVR])  : 0;
    const vl     = colVL  !== -1 ? parseValor(vals[colVL])  : 0;
    const vt     = colVT  !== -1 ? parseValor(vals[colVT])  : 0;
    const cons   = colCons !== -1 ? parseValor(vals[colCons]) : 0;
    const obs    = colObs !== -1 ? String(vals[colObs] || '').trim() : '';

    funcionarios.push({ nome, funcao, posto, faltas, vr, vl, vt, cons, obs });
  });

  return funcionarios;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const db = getDb('assessoria');

  // Garante cargos básicos
  const cargosSeed = [
    'ASG', 'COPEIRA', 'JARDINEIRO', 'ENCARREGADO', 'RECEPCIONISTA',
    'MOTORISTA', 'PORTEIRO', 'GARÇOM', 'ARTÍFICE', 'JOVEM APRENDIZ',
    'AUXILIAR ADMINISTRATIVO', 'ASG/PNE', 'NÃO INFORMADO',
  ];
  const insCargo = db.prepare("INSERT OR IGNORE INTO rh_cargos (nome, salario_base) VALUES (?,0)");
  cargosSeed.forEach(c => insCargo.run(c));

  const getCargo = db.prepare("SELECT id FROM rh_cargos WHERE nome = ? LIMIT 1");
  const insCargoDyn = db.prepare("INSERT OR IGNORE INTO rh_cargos (nome, salario_base) VALUES (?,0)");

  function getOrCreateCargo(nome) {
    let r = getCargo.get(nome);
    if (!r) { insCargoDyn.run(nome); r = getCargo.get(nome); }
    return r ? r.id : null;
  }

  // Funcionários já cadastrados
  const getFuncionario = db.prepare("SELECT id FROM rh_funcionarios WHERE nome = ? LIMIT 1");
  const insFuncionario = db.prepare(`
    INSERT OR IGNORE INTO rh_funcionarios
      (nome, cargo_id, contrato_ref, lotacao, salario_base, data_admissao, status)
    VALUES (?, ?, ?, ?, 0, '2024-01-01', 'ATIVO')
  `);

  function getOrCreateFuncionario(nome, funcao, posto) {
    let r = getFuncionario.get(nome);
    if (!r) {
      const cargoId = getOrCreateCargo(funcao);
      insFuncionario.run(nome, cargoId, posto, posto);
      r = getFuncionario.get(nome);
    }
    return r ? r.id : null;
  }

  // Folhas
  const getFolha  = db.prepare("SELECT id FROM rh_folha WHERE competencia = ? LIMIT 1");
  const insFolha  = db.prepare("INSERT OR IGNORE INTO rh_folha (competencia, status) VALUES (?, 'IMPORTADA')");
  const insItem   = db.prepare(`
    INSERT OR REPLACE INTO rh_folha_itens
      (folha_id, funcionario_id, faltas, vale_transporte, vale_alimentacao,
       outros_descontos, total_bruto, total_descontos, total_liquido)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0)
  `);

  let totalFuncs = 0, totalItens = 0;

  for (const arq of ARQUIVOS) {
    console.log(`\n📂 ${arq.label} — ${path.basename(arq.path)}`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(arq.path);

    // Garante folha do mês
    if (!DRY_RUN) {
      insFolha.run(arq.competencia);
    }
    const folha = getFolha.get(arq.competencia);
    const folhaId = folha ? folha.id : 0;

    const funcNaMes = new Set();
    let itensArq = 0;

    for (const ws of wb.worksheets) {
      if (ABAS_IGNORAR.has(ws.name.toUpperCase()) || ABAS_IGNORAR.has(ws.name)) continue;

      const linhas = lerSheet(ws);
      if (linhas.length === 0) continue;

      process.stdout.write(`  📋 ${ws.name}: ${linhas.length} funcionários`);

      if (!DRY_RUN) {
        const insLote = db.transaction(rows => {
          let ok = 0;
          rows.forEach(f => {
            const funcId = getOrCreateFuncionario(f.nome, f.funcao, f.posto);
            if (!funcId) return;
            if (!funcNaMes.has(funcId)) {
              funcNaMes.add(funcId);
              totalFuncs++;
            }
            const descontos = f.cons;
            insItem.run(folhaId, funcId, f.faltas, f.vt, f.vr + f.vl, descontos, descontos);
            ok++;
          });
          return ok;
        });
        itensArq += insLote(linhas);
      } else {
        linhas.forEach(f => funcNaMes.add(f.nome));
        itensArq += linhas.length;
      }
      console.log(` ✓`);
    }

    totalItens += itensArq;
    console.log(`  ✅ ${arq.label}: ${funcNaMes.size} funcionários únicos, ${itensArq} itens de folha`);
  }

  // Resumo final
  const totFuncs  = db.prepare('SELECT COUNT(*) n FROM rh_funcionarios').get().n;
  const totFolhas = db.prepare('SELECT COUNT(*) n FROM rh_folha').get().n;
  const totItens  = db.prepare('SELECT COUNT(*) n FROM rh_folha_itens').get().n;

  console.log('\n══════════════════════════════════════════');
  console.log('✅ FOLHA IMPORTADA — Montana Assessoria');
  console.log('══════════════════════════════════════════');
  if (DRY_RUN) {
    console.log('⚠️  DRY RUN — nenhuma alteração feita');
    console.log(`   Funcionários estimados: ${totalFuncs} | Itens: ${totalItens}`);
  } else {
    console.log(`  Funcionários no banco: ${totFuncs}`);
    console.log(`  Folhas no banco:       ${totFolhas}`);
    console.log(`  Itens de folha:        ${totItens}`);
    db.prepare("SELECT competencia, COUNT(*) n FROM rh_folha_itens fi JOIN rh_folha f ON f.id=fi.folha_id GROUP BY 1 ORDER BY 1").all()
      .forEach(r => console.log(`    ${r.competencia}: ${r.n} funcionários`));
  }
}

main().catch(e => { console.error('\n❌ ERRO:', e.message, e.stack); process.exit(1); });
