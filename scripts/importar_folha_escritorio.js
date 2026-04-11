/**
 * Importação da Folha de Pagamento Escritório → módulo RH
 * Fonte: RELATÓRIO DA FOLHA DE PAGAMENTO ESCRITÓRIO.xlsx
 * Competência: Fevereiro/2026
 */

const path = require('path');
const ExcelJS = require('exceljs');
const Database = require('better-sqlite3');
const fs = require('fs');

const XLSX_PATH = path.join(
  process.env.USERPROFILE,
  'OneDrive', 'Área de Trabalho', 'PROJETO M',
  'RELATÓRIO DA FOLHA DE PAGAMENTO ESCRITÓRIO.xlsx'
);

const COMPETENCIA = '2026-02'; // fevereiro/2026

// Mapeamento empresa (coluna Excel → chave do sistema)
const EMPRESA_MAP = {
  'MUSTANG':    'mustang',
  'ASSESSORIA': 'assessoria',
  'SEGURANÇA':  'seguranca',
  'SEGURANCA':  'seguranca',
  'NEVADA':     null,  // fora do sistema
};

const DB_PATHS = {
  mustang:    'data/mustang/montana.db',
  assessoria: 'data/assessoria/montana.db',
  seguranca:  'data/seguranca/montana.db',
};

// Abre/cacheia conexões
const dbs = {};
function getDb(key) {
  if (!dbs[key]) {
    const p = path.resolve(DB_PATHS[key]);
    if (!fs.existsSync(p)) throw new Error(`DB não encontrado: ${p}`);
    dbs[key] = new Database(p);
  }
  return dbs[key];
}

function r2(cellValue) {
  if (cellValue === null || cellValue === undefined) return 0;
  // Fórmulas retornam objeto {formula, result}
  const v = (typeof cellValue === 'object' && cellValue.result !== undefined) ? cellValue.result : cellValue;
  const n = parseFloat(String(v).replace(',', '.'));
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

async function run() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX_PATH);
  const ws = wb.worksheets[0];

  console.log(`\n📂 Lendo: ${path.basename(XLSX_PATH)}`);
  console.log(`   Planilha: "${ws.name}"  |  Linhas: ${ws.rowCount}\n`);

  // Agrupa por empresa
  const porEmpresa = {};
  let skippedNevada = 0;
  let skippedVazio = 0;

  ws.eachRow((row, rowNum) => {
    // Pula linhas de cabeçalho/total (sem nome ou empresa)
    const cv = (i) => { const v = row.getCell(i).value; return (v === null || v === undefined) ? '' : String(v); };
    const nome    = cv(2).trim();
    const funcao  = cv(3).trim();
    const posto   = cv(4).trim();
    const empRaw  = cv(5).trim().toUpperCase();
    const valeRef = r2(row.getCell(6).value);  // pode ser texto "LIÇ/MATERNIDADE" → 0
    const valeTr  = r2(row.getCell(7).value);
    const salario = r2(row.getCell(8).value);
    const gratif  = r2(row.getCell(9).value);
    const bruto   = r2(row.getCell(10).value);
    // Detecta afastamento por maternidade/licença na coluna de vale refeição
    const valeRefText = cv(6).toUpperCase();
    const emLicenca   = valeRefText.includes('LIÇ') || valeRefText.includes('LIC') || valeRefText.includes('LICEN');

    if (!nome || !salario) { skippedVazio++; return; }
    if (nome.toUpperCase().includes('TOTAL') || nome.toUpperCase().includes('SUBTOTAL')) { skippedVazio++; return; }
    if (nome.toUpperCase() === 'NOME' || nome.toUpperCase() === 'FUNCIONÁRIO') { skippedVazio++; return; }

    // Resolve empresa
    let empKey = null;
    for (const [k, v] of Object.entries(EMPRESA_MAP)) {
      if (empRaw.includes(k)) { empKey = v; break; }
    }

    if (empKey === null && empRaw.includes('NEVADA')) {
      skippedNevada++;
      console.log(`  ⏭  NEVADA (sem sistema): ${nome}`);
      return;
    }
    if (!empKey) {
      // Tenta detectar pelo padrão de célula vazia (empresa continua da linha anterior)
      // Deixa para tratar no loop com lastEmpKey
      empKey = '__DESCONHECIDA__';
    }

    if (!porEmpresa[empKey]) porEmpresa[empKey] = [];
    porEmpresa[empKey].push({ nome, funcao, posto, valeRef, valeTr, salario, gratif, bruto, emLicenca });
  });

  // Se caiu em desconhecida, avisa
  if (porEmpresa['__DESCONHECIDA__']) {
    console.warn(`\n⚠  ${porEmpresa['__DESCONHECIDA__'].length} linhas sem empresa reconhecida — ignoradas.`);
    console.warn('   Nomes:', porEmpresa['__DESCONHECIDA__'].map(x => x.nome).join(', '));
    delete porEmpresa['__DESCONHECIDA__'];
  }

  console.log(`📊 Pulados (cabeçalho/vazio): ${skippedVazio}  |  Nevada (sem sistema): ${skippedNevada}\n`);

  // ── Importa por empresa ────────────────────────────────────────────
  for (const [empKey, funcionarios] of Object.entries(porEmpresa)) {
    if (!DB_PATHS[empKey]) { console.warn(`⚠  Empresa "${empKey}" sem DB mapeado.`); continue; }
    const db = getDb(empKey);

    console.log(`\n🏢 ${empKey.toUpperCase()} — ${funcionarios.length} funcionário(s)`);

    // Garante cargos e retorna IDs
    const getOuCriarCargo = (nomeCargo) => {
      if (!nomeCargo) return null;
      const exists = db.prepare('SELECT id FROM rh_cargos WHERE nome = ?').get(nomeCargo);
      if (exists) return exists.id;
      const info = db.prepare('INSERT INTO rh_cargos (nome) VALUES (?)').run(nomeCargo);
      return info.lastInsertRowid;
    };

    // Insert funcionários (ignora duplicatas pelo nome)
    const stmtFun = db.prepare(`
      INSERT OR IGNORE INTO rh_funcionarios
        (nome, cargo_id, lotacao, salario_base, status, data_admissao)
      VALUES
        (@nome, @cargo_id, @lotacao, @salario_base, 'ATIVO', @data_admissao)
    `);

    const insertMany = db.transaction((lista) => {
      for (const f of lista) {
        const cargoId = getOuCriarCargo(f.funcao);
        stmtFun.run({
          nome: f.nome,
          cargo_id: cargoId,
          lotacao: f.posto || null,
          salario_base: f.salario,
          data_admissao: '2026-01-01', // data padrão — ajustar individualmente depois
        });
        const obs = f.emLicenca ? ' [LICENÇA/MATERNIDADE]' : '';
        console.log(`   ✅ ${f.nome} | ${f.funcao || '-'} | R$ ${f.salario.toFixed(2)}${obs}`);
      }
    });

    insertMany(funcionarios);

    // ── Cria folha de competência ──────────────────────────────────
    const folhaExiste = db.prepare(
      'SELECT id FROM rh_folha WHERE competencia = ?'
    ).get(COMPETENCIA);

    let folhaId;
    if (folhaExiste) {
      folhaId = folhaExiste.id;
      console.log(`   📋 Folha ${COMPETENCIA} já existe (id=${folhaId})`);
    } else {
      const fi = db.prepare(`
        INSERT INTO rh_folha (competencia, status, obs)
        VALUES (?, 'RASCUNHO', 'Importada da planilha escritório')
      `).run(COMPETENCIA);
      folhaId = fi.lastInsertRowid;
      console.log(`   📋 Folha ${COMPETENCIA} criada (id=${folhaId})`);
    }

    // ── Cria itens da folha ───────────────────────────────────────
    const funcionariosDb = db.prepare(
      "SELECT id, nome, salario_base FROM rh_funcionarios WHERE status = 'ATIVO'"
    ).all();

    const stmtItem = db.prepare(`
      INSERT OR IGNORE INTO rh_folha_itens
        (folha_id, funcionario_id, salario_base, outros_proventos, vale_transporte, vale_alimentacao, total_bruto)
      VALUES
        (@folha_id, @funcionario_id, @salario_base, @gratif, @vale_transporte, @vale_alimentacao, @total_bruto)
    `);

    // Mapeia nome → dados da planilha para cruzar com o DB
    const dadosPlan = {};
    for (const f of funcionarios) dadosPlan[f.nome.toUpperCase()] = f;

    const insertItens = db.transaction((lista) => {
      for (const fun of lista) {
        const plan = dadosPlan[fun.nome.toUpperCase()];
        if (!plan) continue;
        stmtItem.run({
          folha_id: folhaId,
          funcionario_id: fun.id,
          salario_base: plan.salario,
          gratif: plan.gratif || 0,
          vale_transporte: plan.valeTr,
          vale_alimentacao: plan.valeRef,
          total_bruto: plan.bruto || plan.salario + (plan.gratif || 0),
        });
      }
    });

    insertItens(funcionariosDb);
    console.log(`   📝 Itens da folha inseridos.`);
  }

  // Fecha DBs
  for (const db of Object.values(dbs)) db.close();

  console.log('\n✅ Importação concluída!\n');
  console.log('Próximos passos:');
  console.log('  1. Acesse a aba 👥 RH / DP no sistema');
  console.log('  2. Confira os funcionários importados');
  console.log('  3. Ajuste datas de admissão individuais');
  console.log('  4. Use "Calcular" na folha fev/2026 para aplicar INSS/IRRF automático\n');
}

run().catch(e => { console.error('❌ Erro:', e.message); process.exit(1); });
