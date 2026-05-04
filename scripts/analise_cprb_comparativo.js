/**
 * Análise Comparativa CPRB × Folha Cheia — Grupo Montana
 *
 * Lê folha bruta (rh_folha) e receita bruta (notas_fiscais) das duas empresas
 * e calcula 3 cenários para os últimos 12 meses fechados:
 *   A — Folha cheia (sem CPRB):  20% patronal + RAT + Terceiros
 *   B — CPRB transição 2026:     60% × 4,5% sobre receita + 50% × 20% folha + RAT + Terceiros
 *   C — CPRB regime cheio (ref): 4,5% sobre receita + RAT + Terceiros (sem patronal)
 *
 * Saídas:
 *   - output/CPRB_Comparativo_<periodo>.xlsx (memória mensal + sumário)
 *   - resumo no console
 *   - atualização das seções 5.x do CPRB_ANALISE_COMPARATIVA_2026.md
 *
 * Uso:
 *   node scripts/analise_cprb_comparativo.js
 *   node scripts/analise_cprb_comparativo.js --periodo=2025-04..2026-03
 *   node scripts/analise_cprb_comparativo.js --rat-seguranca=3 --rat-assessoria=2
 *
 * Premissas (Lei 12.546/2011 + Lei 14.973/2024) — confirmar com contabilidade.
 */

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');
const ExcelJS  = require('exceljs');

// ── ARGUMENTOS ────────────────────────────────────────────────────
const args   = process.argv.slice(2);
const argMap = {};
args.forEach(a => { const [k,v] = a.replace(/^--/,'').split('='); argMap[k] = v ?? true; });

// Período default: últimos 12 meses fechados a partir do mês anterior
function defaultPeriodo() {
  const hoje = new Date();
  const fim  = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);   // mês anterior
  const ini  = new Date(fim.getFullYear(), fim.getMonth() - 11, 1);    // 12 meses atrás
  const fmt  = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  return `${fmt(ini)}..${fmt(fim)}`;
}

const periodo = argMap.periodo || defaultPeriodo();
const [iniStr, fimStr] = periodo.split('..');
if (!/^\d{4}-\d{2}$/.test(iniStr) || !/^\d{4}-\d{2}$/.test(fimStr)) {
  console.error(`Período inválido: ${periodo}. Use AAAA-MM..AAAA-MM (ex: 2025-04..2026-03)`);
  process.exit(1);
}

// ── PARÂMETROS TRIBUTÁRIOS ────────────────────────────────────────
// Confirmar com contabilidade antes de qualquer recolhimento.
const PARAMS = {
  aliq_cprb_base:       0.045,   // Lei 12.546/2011, art. 7º — vigilância e limpeza: 4,5%
  inss_patronal_cheio:  0.20,    // Lei 8.212/91, art. 22, I e III
  terceiros_sistema_s:  0.058,   // INCRA + SENAI + SESI + SEBRAE + Sal-Educ (~5,8%)
  // Lei 14.973/2024 — regime de transição (CONFIRMAR redação atual):
  transicao: {
    2024: { pct_cprb: 1.00, pct_patronal: 0.00 },
    2025: { pct_cprb: 0.80, pct_patronal: 0.25 },
    2026: { pct_cprb: 0.60, pct_patronal: 0.50 },
    2027: { pct_cprb: 0.40, pct_patronal: 0.75 },
    2028: { pct_cprb: 0.00, pct_patronal: 1.00 },
  },
};

// ── EMPRESAS ──────────────────────────────────────────────────────
const EMPRESAS = [
  {
    key:   'assessoria',
    nome:  'Montana Assessoria Empresarial Ltda',
    cnpj:  '14.092.519/0001-51',
    db:    path.join(__dirname, '..', 'data', 'assessoria', 'montana.db'),
    rat:   parseFloat(argMap['rat-assessoria'] ?? '2.0') / 100, // CNAE 8121 — risco médio
    cor:   'FF0D6EFD',
  },
  {
    key:   'seguranca',
    nome:  'Montana Segurança Privada Ltda',
    cnpj:  '19.200.109/0001-09',
    db:    path.join(__dirname, '..', 'data', 'seguranca', 'montana.db'),
    rat:   parseFloat(argMap['rat-seguranca']  ?? '3.0') / 100, // CNAE 8011/8012 — risco grave
    cor:   'FFDC3545',
  },
];

// ── HELPERS ───────────────────────────────────────────────────────
const BRL_FMT = '#,##0.00';
const PCT_FMT = '0.00%';

function brl(v) {
  if (v == null || isNaN(v)) return 'R$ 0,00';
  return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function r2(v) { return Math.round((v || 0) * 100) / 100; }

function listarCompetencias(ini, fim) {
  const [ay, am] = ini.split('-').map(Number);
  const [by, bm] = fim.split('-').map(Number);
  const out = [];
  let y = ay, m = am;
  while (y < by || (y === by && m <= bm)) {
    out.push(`${y}-${String(m).padStart(2,'0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

function transicaoDoAno(ano) {
  return PARAMS.transicao[ano] || PARAMS.transicao[2026];
}

// ── EXTRAÇÃO DE DADOS ─────────────────────────────────────────────
function extrairDados(empresa, competencias) {
  if (!fs.existsSync(empresa.db)) {
    console.warn(`⚠  DB não encontrado: ${empresa.db} (rode no servidor)`);
    return competencias.map(c => ({ competencia: c, receita: 0, folha: 0, faltando: true }));
  }

  const db = new Database(empresa.db, { readonly: true, fileMustExist: true });

  const stmtReceita = db.prepare(`
    SELECT COALESCE(SUM(valor_bruto), 0) AS receita
    FROM notas_fiscais
    WHERE substr(COALESCE(NULLIF(competencia,''), data_emissao), 1, 7) = ?
  `);

  const stmtFolha = db.prepare(`
    SELECT COALESCE(SUM(total_bruto), 0) AS folha
    FROM rh_folha
    WHERE competencia = ?
  `);

  const linhas = competencias.map(c => {
    const receita = stmtReceita.get(c)?.receita || 0;
    const folha   = stmtFolha.get(c)?.folha     || 0;
    return {
      competencia: c,
      receita: r2(receita),
      folha:   r2(folha),
      faltando: receita === 0 && folha === 0,
    };
  });

  db.close();
  return linhas;
}

// ── CÁLCULO DOS CENÁRIOS ──────────────────────────────────────────
function calcularLinha(empresa, linha) {
  const ano = parseInt(linha.competencia.slice(0, 4));
  const t   = transicaoDoAno(ano);

  const inss_cheio = linha.folha * PARAMS.inss_patronal_cheio;
  const rat        = linha.folha * empresa.rat;
  const terceiros  = linha.folha * PARAMS.terceiros_sistema_s;

  // A — Folha cheia
  const A = inss_cheio + rat + terceiros;

  // B — CPRB transição (ano da competência)
  const cprb_B          = linha.receita * PARAMS.aliq_cprb_base * t.pct_cprb;
  const inss_residual_B = inss_cheio * t.pct_patronal;
  const B               = cprb_B + inss_residual_B + rat + terceiros;

  // C — CPRB cheio (referência)
  const cprb_C = linha.receita * PARAMS.aliq_cprb_base;
  const C      = cprb_C + rat + terceiros;

  return {
    ...linha,
    inss_cheio: r2(inss_cheio),
    rat:        r2(rat),
    terceiros:  r2(terceiros),
    cprb_B:     r2(cprb_B),
    inss_residual_B: r2(inss_residual_B),
    cprb_C:     r2(cprb_C),
    A: r2(A),
    B: r2(B),
    C: r2(C),
    economia_B: r2(A - B),
    economia_C: r2(A - C),
  };
}

function totalizar(linhas) {
  const acc = { receita:0, folha:0, A:0, B:0, C:0, economia_B:0, economia_C:0 };
  linhas.forEach(l => {
    acc.receita    += l.receita;
    acc.folha      += l.folha;
    acc.A          += l.A;
    acc.B          += l.B;
    acc.C          += l.C;
    acc.economia_B += l.economia_B;
    acc.economia_C += l.economia_C;
  });
  Object.keys(acc).forEach(k => acc[k] = r2(acc[k]));
  acc.folha_sobre_receita = acc.receita > 0 ? acc.folha / acc.receita : 0;
  return acc;
}

// ── XLSX ──────────────────────────────────────────────────────────
async function gerarXlsx(dadosPorEmpresa, periodoStr) {
  const wb = new ExcelJS.Workbook();
  wb.creator  = 'Grupo Montana — Análise CPRB';
  wb.created  = new Date();

  // Aba Sumário
  const wsS = wb.addWorksheet('Sumário', { views:[{state:'frozen', ySplit:1}] });
  wsS.columns = [
    { header:'Indicador',                key:'ind',  width:38 },
    { header:'Assessoria',               key:'asse', width:22, style:{numFmt:BRL_FMT} },
    { header:'Segurança',                key:'seg',  width:22, style:{numFmt:BRL_FMT} },
    { header:'Consolidado',              key:'tot',  width:22, style:{numFmt:BRL_FMT} },
  ];
  wsS.getRow(1).font = { bold:true, color:{argb:'FFFFFFFF'} };
  wsS.getRow(1).fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FF1D4ED8'} };

  const tA = totalizar(dadosPorEmpresa.assessoria);
  const tS = totalizar(dadosPorEmpresa.seguranca);
  const tot = (k) => r2((tA[k] || 0) + (tS[k] || 0));

  const linhasS = [
    ['Receita bruta 12m',                       tA.receita,    tS.receita,    tot('receita')],
    ['Folha bruta 12m',                         tA.folha,      tS.folha,      tot('folha')],
    ['Folha / Receita',                         tA.folha_sobre_receita, tS.folha_sobre_receita, (tot('receita')>0 ? tot('folha')/tot('receita') : 0)],
    [],
    ['A — Folha cheia (INSS+RAT+Terceiros)',    tA.A,          tS.A,          tot('A')],
    ['B — CPRB transição 2026 (60/50)',         tA.B,          tS.B,          tot('B')],
    ['C — CPRB regime cheio (referência)',      tA.C,          tS.C,          tot('C')],
    [],
    ['CAIXA EM JOGO 2026 (A − B)',              tA.economia_B, tS.economia_B, tot('economia_B')],
    ['CAIXA TEÓRICO regime cheio (A − C)',      tA.economia_C, tS.economia_C, tot('economia_C')],
  ];

  linhasS.forEach((row, i) => {
    if (row.length === 0) { wsS.addRow([]); return; }
    const r = wsS.addRow(row);
    if (row[0].startsWith('Folha / Receita')) {
      r.getCell(2).numFmt = PCT_FMT;
      r.getCell(3).numFmt = PCT_FMT;
      r.getCell(4).numFmt = PCT_FMT;
    }
    if (row[0].startsWith('CAIXA EM JOGO') || row[0].startsWith('CAIXA TEÓRICO')) {
      r.font = { bold:true };
      r.fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FFF0FDF4'} };
    }
    if (row[0].startsWith('A —') || row[0].startsWith('B —') || row[0].startsWith('C —')) {
      r.font = { bold:true };
    }
  });

  // Aba parâmetros
  const wsP = wb.addWorksheet('Parâmetros');
  wsP.columns = [{ header:'Parâmetro', key:'p', width:48 }, { header:'Valor', key:'v', width:18 }];
  wsP.getRow(1).font = { bold:true };
  [
    ['Período',                                       periodoStr],
    ['Alíquota CPRB base (Lei 12.546/2011, art. 7º)',  `${(PARAMS.aliq_cprb_base*100).toFixed(2)}%`],
    ['INSS patronal cheio',                            `${(PARAMS.inss_patronal_cheio*100).toFixed(2)}%`],
    ['Terceiros (Sistema S)',                          `${(PARAMS.terceiros_sistema_s*100).toFixed(2)}%`],
    ['RAT/FAP — Assessoria',                           `${(EMPRESAS[0].rat*100).toFixed(2)}%`],
    ['RAT/FAP — Segurança',                            `${(EMPRESAS[1].rat*100).toFixed(2)}%`],
    ['Transição 2026 — % CPRB',                        `${(PARAMS.transicao[2026].pct_cprb*100).toFixed(0)}%`],
    ['Transição 2026 — % patronal',                    `${(PARAMS.transicao[2026].pct_patronal*100).toFixed(0)}%`],
  ].forEach(r => wsP.addRow(r));

  // Abas detalhadas por empresa
  for (const emp of EMPRESAS) {
    const ws = wb.addWorksheet(emp.nome.split(' ')[1].slice(0,16), { views:[{state:'frozen', ySplit:1}] });
    ws.columns = [
      { header:'Competência',          key:'c', width:13 },
      { header:'Receita bruta',        key:'r', width:18, style:{numFmt:BRL_FMT} },
      { header:'Folha bruta',          key:'f', width:18, style:{numFmt:BRL_FMT} },
      { header:'INSS patr. (20%)',     key:'i', width:16, style:{numFmt:BRL_FMT} },
      { header:'RAT',                  key:'rat', width:14, style:{numFmt:BRL_FMT} },
      { header:'Terceiros (5,8%)',     key:'t', width:16, style:{numFmt:BRL_FMT} },
      { header:'CPRB transição (B)',   key:'cb', width:18, style:{numFmt:BRL_FMT} },
      { header:'INSS resid. (B)',      key:'ib', width:16, style:{numFmt:BRL_FMT} },
      { header:'CPRB cheio (C)',       key:'cc', width:16, style:{numFmt:BRL_FMT} },
      { header:'Total A — Folha cheia',key:'A', width:20, style:{numFmt:BRL_FMT} },
      { header:'Total B — CPRB 2026',  key:'B', width:20, style:{numFmt:BRL_FMT} },
      { header:'Total C — CPRB cheio', key:'C', width:20, style:{numFmt:BRL_FMT} },
      { header:'Economia A−B',         key:'eb',width:18, style:{numFmt:BRL_FMT} },
      { header:'Economia A−C',         key:'ec',width:18, style:{numFmt:BRL_FMT} },
    ];
    ws.getRow(1).font = { bold:true, color:{argb:'FFFFFFFF'} };
    ws.getRow(1).fill = { type:'pattern', pattern:'solid', fgColor:{argb:emp.cor} };

    const linhas = dadosPorEmpresa[emp.key];
    linhas.forEach(l => {
      const r = ws.addRow({
        c: l.competencia,
        r: l.receita, f: l.folha,
        i: l.inss_cheio, rat: l.rat, t: l.terceiros,
        cb: l.cprb_B, ib: l.inss_residual_B, cc: l.cprb_C,
        A: l.A, B: l.B, C: l.C,
        eb: l.economia_B, ec: l.economia_C,
      });
      if (l.faltando) {
        r.font = { italic:true, color:{argb:'FFB91C1C'} };
      }
    });

    const t = totalizar(linhas);
    const rt = ws.addRow({
      c:'TOTAL 12m', r:t.receita, f:t.folha,
      i:r2(t.folha*PARAMS.inss_patronal_cheio), rat:r2(t.folha*emp.rat),
      t:r2(t.folha*PARAMS.terceiros_sistema_s),
      cb:'', ib:'', cc:'',
      A:t.A, B:t.B, C:t.C, eb:t.economia_B, ec:t.economia_C,
    });
    rt.font = { bold:true };
    rt.fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FFF1F5F9'} };
  }

  const outDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive:true });
  const file = path.join(outDir, `CPRB_Comparativo_${iniStr}_${fimStr}.xlsx`);
  await wb.xlsx.writeFile(file);
  return file;
}

// ── ATUALIZAÇÃO DO MARKDOWN ───────────────────────────────────────
function blocoEmpresa(emp, t) {
  const venceB = t.economia_B > 0 ? 'CPRB' : 'folha cheia';
  const venceC = t.economia_C > 0 ? 'CPRB' : 'folha cheia';
  const fr     = t.folha_sobre_receita ? (t.folha_sobre_receita*100).toFixed(1) + '%' : '—';
  return [
    '```',
    `Receita bruta 12m:                  ${brl(t.receita)}`,
    `Folha bruta 12m:                    ${brl(t.folha)}`,
    `Folha / Receita:                    ${fr}`,
    ``,
    `Cenário A — Folha cheia 12m:        ${brl(t.A)}`,
    `Cenário B — CPRB 2026 12m:          ${brl(t.B)}`,
    `Cenário C — CPRB cheio (ref) 12m:   ${brl(t.C)}`,
    ``,
    `CAIXA EM JOGO 2026 (A − B):         ${brl(t.economia_B)} (vence ${venceB})`,
    `CAIXA TEÓRICO (A − C):              ${brl(t.economia_C)} (vence ${venceC})`,
    '```',
  ].join('\n');
}

function atualizarMarkdown(dadosPorEmpresa) {
  const mdPath = path.join(__dirname, '..', 'CPRB_ANALISE_COMPARATIVA_2026.md');
  if (!fs.existsSync(mdPath)) return;

  const tA = totalizar(dadosPorEmpresa.assessoria);
  const tS = totalizar(dadosPorEmpresa.seguranca);
  const tot = {
    economia_B: r2(tA.economia_B + tS.economia_B),
    economia_C: r2(tA.economia_C + tS.economia_C),
  };

  let md = fs.readFileSync(mdPath, 'utf8');

  // Substitui blocos das seções 5.1, 5.2 e 5.3
  md = md.replace(
    /### 5\.1\. Montana Assessoria Empresarial Ltda\n\n```[\s\S]*?```/,
    `### 5.1. Montana Assessoria Empresarial Ltda\n\n${blocoEmpresa(EMPRESAS[0], tA)}`
  );
  md = md.replace(
    /### 5\.2\. Montana Segurança Privada Ltda\n\n```[\s\S]*?```/,
    `### 5.2. Montana Segurança Privada Ltda\n\n${blocoEmpresa(EMPRESAS[1], tS)}`
  );
  md = md.replace(
    /### 5\.3\. Consolidado Grupo Montana\n\n```[\s\S]*?```/,
    `### 5.3. Consolidado Grupo Montana\n\n\`\`\`\nCaixa anual em jogo (A − B):        ${brl(tot.economia_B)}\nCaixa anual teórico (A − C):        ${brl(tot.economia_C)}\n\`\`\``
  );

  fs.writeFileSync(mdPath, md, 'utf8');
}

// ── MAIN ──────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  ANÁLISE COMPARATIVA CPRB × FOLHA CHEIA — Grupo Montana');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Período: ${iniStr} até ${fimStr}`);
  console.log(`Premissa transição 2026: CPRB ${PARAMS.transicao[2026].pct_cprb*100}% + patronal ${PARAMS.transicao[2026].pct_patronal*100}% (Lei 14.973/2024 — confirmar)`);
  console.log('');

  const competencias = listarCompetencias(iniStr, fimStr);
  const dadosPorEmpresa = {};

  for (const emp of EMPRESAS) {
    console.log(`▸ ${emp.nome} (${emp.cnpj})`);
    const linhasBrutas = extrairDados(emp, competencias);
    const linhas       = linhasBrutas.map(l => calcularLinha(emp, l));
    dadosPorEmpresa[emp.key] = linhas;

    const t = totalizar(linhas);
    const fr = t.folha_sobre_receita ? (t.folha_sobre_receita*100).toFixed(1) + '%' : '—';
    console.log(`    Receita 12m: ${brl(t.receita)}`);
    console.log(`    Folha   12m: ${brl(t.folha)}  (${fr} da receita)`);
    console.log(`    A — Folha cheia:       ${brl(t.A)}`);
    console.log(`    B — CPRB 2026 (60/50): ${brl(t.B)}`);
    console.log(`    C — CPRB cheio (ref):  ${brl(t.C)}`);
    console.log(`    ⇒ Caixa em jogo 2026:  ${brl(t.economia_B)}  ${t.economia_B>0 ? '(CPRB vence)' : '(folha cheia vence)'}`);
    console.log(`    ⇒ Caixa teórico cheio: ${brl(t.economia_C)}  ${t.economia_C>0 ? '(CPRB vence)' : '(folha cheia vence)'}`);
    console.log('');
  }

  const xlsx = await gerarXlsx(dadosPorEmpresa, periodo);
  console.log(`✓ XLSX: ${xlsx}`);

  atualizarMarkdown(dadosPorEmpresa);
  console.log('✓ Markdown atualizado: CPRB_ANALISE_COMPARATIVA_2026.md (seções 5.x)');
  console.log('');
  console.log('IMPORTANTE: confirmar com a contabilidade alíquota RAT/FAP de cada CNPJ');
  console.log('e a redação atual da Lei 14.973/2024 antes de qualquer recolhimento.');
}

main().catch(e => { console.error(e); process.exit(1); });
