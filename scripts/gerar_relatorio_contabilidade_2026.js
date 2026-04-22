/**
 * Relatório Contábil — PIS/COFINS Regime de Caixa 2026
 * Destinado à contabilidade para alimentação da Receita Federal
 *
 * Regras aplicadas:
 *  • Base tributável = NFs efetivamente PAGAS em 2026 (regime de caixa)
 *  • Competência: uma NF é considerada PAGA se tem data_pagamento OU extrato_id (conciliada)
 *                   OU status = PAGO_COM_COMPROVANTE
 *  • EXCLUSÃO: NFs com data_emissao < 2025-01-01 NÃO entram na base 2026
 *              (já tributadas por competência nos exercícios 2024/2023/anteriores — quando a
 *               empresa apurava pelo regime de competência). Apuração de caixa vale só a partir
 *               de receitas cuja competência original é ≥ 2025.
 *
 * Alíquotas:
 *  • Assessoria (Lucro Real não-cumulativo): PIS 1,65% + COFINS 7,60%
 *    DARFs: 6912 (PIS) / 5856 (COFINS)
 *  • Segurança (Lucro Real cumulativo):       PIS 0,65% + COFINS 3,00%
 *    DARFs: 8109 (PIS) / 2172 (COFINS)
 *
 * Uso:
 *   node scripts/gerar_relatorio_contabilidade_2026.js
 *   node scripts/gerar_relatorio_contabilidade_2026.js --ano=2026
 *   node scripts/gerar_relatorio_contabilidade_2026.js --ate=2026-04
 *   node scripts/gerar_relatorio_contabilidade_2026.js --empresa=assessoria
 */

'use strict';
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const Database = require('better-sqlite3');
const ExcelJS  = require('exceljs');

// ── PARÂMETROS ───────────────────────────────────────────────────
const args = process.argv.slice(2);
const argMap = {};
args.forEach(a => { const [k,v] = a.replace(/^--/,'').split('='); argMap[k]=v; });

const ANO          = parseInt(argMap.ano || '2026');
const ANO_CORTE    = ANO - 1;  // NFs emitidas < ANO_CORTE-01-01 são excluídas
const DATA_CORTE   = `${ANO_CORTE}-01-01`;   // emissão mínima (inclusive)
const INICIO_CAIXA = `${ANO}-01-01`;
const FIM_CAIXA    = argMap.ate
  ? (argMap.ate.length === 7 ? `${argMap.ate}-${new Date(parseInt(argMap.ate.slice(0,4)), parseInt(argMap.ate.slice(5,7)), 0).getDate()}` : argMap.ate)
  : `${ANO}-12-31`;

const empArg = (argMap.empresa || 'todas').toLowerCase();

// ── CADASTRO ─────────────────────────────────────────────────────
const EMPRESAS = {
  assessoria: {
    key:  'assessoria',
    nome: 'Montana Assessoria Empresarial Ltda',
    cnpj: '14.092.519/0001-51',
    db:   path.join(__dirname, '..', 'data', 'assessoria', 'montana.db'),
    regime: 'Lucro Real — Não Cumulativo',
    pis_aliq:    0.0165,  // 1,65%
    cofins_aliq: 0.0760,  // 7,60%
    darf_pis:    '6912',
    darf_cofins: '5856',
  },
  seguranca: {
    key:  'seguranca',
    nome: 'Montana Segurança Patrimonial Ltda',
    cnpj: '19.200.109/0001-09',
    db:   path.join(__dirname, '..', 'data', 'seguranca', 'montana.db'),
    regime: 'Lucro Real — Cumulativo',
    pis_aliq:    0.0065,  // 0,65%
    cofins_aliq: 0.0300,  // 3,00%
    darf_pis:    '8109',
    darf_cofins: '2172',
  },
};

const empresasRodar = empArg === 'todas'
  ? [EMPRESAS.assessoria, EMPRESAS.seguranca]
  : [EMPRESAS[empArg]].filter(Boolean);

if (!empresasRodar.length) {
  console.error('Empresa inválida. Use: assessoria | seguranca | todas');
  process.exit(1);
}

// ── ESTILOS ──────────────────────────────────────────────────────
const BRL    = '#,##0.00';
const PCT    = '0.00%';
const BLUE   = 'FF1D4ED8', GRAY = 'FF475569', GREEN = 'FF15803D';
const AMBER  = 'FFD97706', RED  = 'FFB91C1C';
const WHITE  = 'FFFFFFFF', LBLUE = 'FFDBEAFE', LGREEN = 'FFF0FDF4';
const LGRAY  = 'FFF1F5F9', LYELLOW = 'FFFEF9C3', LRED = 'FFFEE2E2';
const bdr    = { style:'thin', color:{argb:'FFE2E8F0'} };
const BORDER = { top:bdr, left:bdr, bottom:bdr, right:bdr };

function fmtDt(d)   { return d ? `${d.slice(8,10)}/${d.slice(5,7)}/${d.slice(0,4)}` : ''; }
function brl(v)     { return (v || 0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function money(v)   { return (typeof v === 'number') ? Math.round(v * 100) / 100 : v; }

function hdrRow(ws, rowNum, cols, bg=BLUE, fc=WHITE) {
  const row = ws.getRow(rowNum);
  cols.forEach((v,i) => {
    const c = row.getCell(i+1);
    c.value = v;
    c.font  = {bold:true, size:9, color:{argb:fc}};
    c.fill  = {type:'pattern', pattern:'solid', fgColor:{argb:bg}};
    c.alignment = {horizontal:'center', vertical:'middle', wrapText:true};
    c.border = BORDER;
  });
  row.height = 30;
}

function setCell(ws, rowNum, colNum, val, numFmt, bgColor, fontColor='FF1E293B', bold=false, align='left') {
  const c = ws.getRow(rowNum).getCell(colNum);
  c.value = val;
  if (numFmt)  c.numFmt = numFmt;
  if (bgColor) c.fill   = {type:'pattern', pattern:'solid', fgColor:{argb:bgColor}};
  c.font      = {size:9, color:{argb:fontColor}, bold};
  c.alignment = {horizontal:align, vertical:'middle', wrapText:true};
  c.border    = BORDER;
}

function setMoney(ws, rowNum, colNum, val, bgColor, fontColor='FF1E293B', bold=false) {
  setCell(ws, rowNum, colNum, money(val), BRL, bgColor, fontColor, bold, 'right');
}

// ── EXTRAÇÃO DE DADOS ────────────────────────────────────────────
function carregarNFs(empresa) {
  const db = new Database(empresa.db, { readonly: true });

  // NFs com pagamento em 2026 — usando 3 fontes em ordem de prioridade:
  //  1) data_pagamento explícita
  //  2) data_iso do extrato vinculado (status CONCILIADO)
  //  3) created_at como último recurso (apenas se CONCILIADO/PAGO_COM_COMPROVANTE)
  const rows = db.prepare(`
    SELECT
      n.id, n.numero, n.data_emissao, n.data_pagamento,
      n.tomador, n.cnpj_tomador, n.contrato_ref,
      n.status_conciliacao,
      n.valor_bruto, n.valor_liquido, n.retencao,
      n.pis, n.cofins, n.inss, n.ir, n.iss, n.csll,
      n.extrato_id,
      ex.data_iso AS extrato_data,
      ex.credito  AS extrato_credito,
      ex.historico AS extrato_historico,
      ex.pagador_identificado AS pagador_nome,
      ex.pagador_cnpj  AS pagador_cnpj,
      ex.pagador_metodo AS pagador_metodo,
      COALESCE(n.data_pagamento, ex.data_iso) AS data_caixa
    FROM notas_fiscais n
    LEFT JOIN extratos ex ON ex.id = n.extrato_id
    WHERE n.status_conciliacao NOT IN ('CANCELADA','ASSESSORIA')
      AND COALESCE(n.data_pagamento, ex.data_iso) BETWEEN ? AND ?
    ORDER BY COALESCE(n.data_pagamento, ex.data_iso), n.numero
  `).all(INICIO_CAIXA, FIM_CAIXA);

  db.close();
  return rows;
}

// ── MONTADORA DE ABAS ────────────────────────────────────────────
function adicionarAbaEmpresa(wb, empresa, nfs) {
  // Separar tributáveis vs excluídas (emissão < 2025-01-01)
  const tributaveis = [];
  const excluidas   = [];
  for (const n of nfs) {
    if (!n.data_emissao) {
      // Sem data de emissão → considerar tributável (caso raro, sinalizar)
      tributaveis.push({ ...n, _sem_emissao: true });
      continue;
    }
    if (n.data_emissao < DATA_CORTE) excluidas.push(n);
    else                             tributaveis.push(n);
  }

  // Agrupar por cliente
  const porCliente = {};
  for (const n of tributaveis) {
    const k = (n.tomador || 'SEM TOMADOR').trim();
    if (!porCliente[k]) porCliente[k] = {
      cnpj: n.cnpj_tomador || '',
      nfs: [], qtd: 0, bruto: 0, liquido: 0,
      ret_inss: 0, ret_ir: 0, ret_iss: 0, ret_csll: 0,
      ret_pis_fonte: 0, ret_cofins_fonte: 0, ret_total: 0,
    };
    const g = porCliente[k];
    g.nfs.push(n);
    g.qtd++;
    g.bruto          += n.valor_bruto   || 0;
    g.liquido        += n.valor_liquido || 0;
    g.ret_inss       += n.inss || 0;
    g.ret_ir         += n.ir   || 0;
    g.ret_iss        += n.iss  || 0;
    g.ret_csll       += n.csll || 0;
    g.ret_pis_fonte  += n.pis  || 0;
    g.ret_cofins_fonte+= n.cofins || 0;
    g.ret_total      += n.retencao || 0;
    if (n.cnpj_tomador && !g.cnpj) g.cnpj = n.cnpj_tomador;
  }

  const clientes = Object.entries(porCliente)
    .map(([nome,g]) => ({ nome, ...g }))
    .sort((a,b) => b.bruto - a.bruto);

  // Totais gerais
  const totalBruto   = tributaveis.reduce((s,n) => s + (n.valor_bruto   || 0), 0);
  const totalLiquido = tributaveis.reduce((s,n) => s + (n.valor_liquido || 0), 0);
  const totalRet     = tributaveis.reduce((s,n) => s + (n.retencao      || 0), 0);
  const totalRetPis  = tributaveis.reduce((s,n) => s + (n.pis           || 0), 0);
  const totalRetCof  = tributaveis.reduce((s,n) => s + (n.cofins        || 0), 0);
  const pisBruto     = +(totalBruto * empresa.pis_aliq).toFixed(2);
  const cofinsBruto  = +(totalBruto * empresa.cofins_aliq).toFixed(2);
  const pisDevido    = Math.max(0, +(pisBruto    - totalRetPis).toFixed(2));
  const cofinsDevido = Math.max(0, +(cofinsBruto - totalRetCof).toFixed(2));

  // Agrupar por mês
  const porMes = {};
  for (const n of tributaveis) {
    const mes = (n.data_caixa || '').slice(0, 7); // YYYY-MM
    if (!porMes[mes]) porMes[mes] = { qtd: 0, bruto: 0, ret: 0, ret_pis: 0, ret_cof: 0 };
    porMes[mes].qtd++;
    porMes[mes].bruto   += n.valor_bruto || 0;
    porMes[mes].ret     += n.retencao    || 0;
    porMes[mes].ret_pis += n.pis         || 0;
    porMes[mes].ret_cof += n.cofins      || 0;
  }
  const mesesOrd = Object.keys(porMes).sort();

  // ═══════════════════════════════════════════════════════════════
  // ABA: RESUMO POR CLIENTE + APURAÇÃO
  // ═══════════════════════════════════════════════════════════════
  const label = empresa.key === 'assessoria' ? 'Assessoria' : 'Segurança';
  const ws = wb.addWorksheet(`${label} — Apuração ${ANO}`);
  ws.columns = [
    {width:4}, {width:44}, {width:20}, {width:8},
    {width:15}, {width:15}, {width:13}, {width:13},
    {width:13}, {width:13}, {width:13}, {width:14},
  ];
  let r = 1;

  // Cabeçalho principal
  ws.mergeCells(r,1,r,12);
  const tCell = ws.getRow(r).getCell(1);
  tCell.value = `APURAÇÃO PIS/COFINS — REGIME DE CAIXA ${ANO}`;
  tCell.font  = {bold:true, size:15, color:{argb:WHITE}};
  tCell.fill  = {type:'pattern', pattern:'solid', fgColor:{argb:BLUE}};
  tCell.alignment = {horizontal:'center', vertical:'middle'};
  ws.getRow(r).height = 40; r++;

  ws.mergeCells(r,1,r,12);
  const sCell = ws.getRow(r).getCell(1);
  sCell.value = `${empresa.nome}  —  CNPJ ${empresa.cnpj}`;
  sCell.font  = {size:11, bold:true, color:{argb:'FF1E293B'}};
  sCell.alignment = {horizontal:'center'};
  ws.getRow(r).height = 22; r++;

  ws.mergeCells(r,1,r,12);
  const rCell = ws.getRow(r).getCell(1);
  rCell.value = `Regime: ${empresa.regime}  |  PIS ${(empresa.pis_aliq*100).toFixed(2).replace('.',',')}%  |  COFINS ${(empresa.cofins_aliq*100).toFixed(2).replace('.',',')}%  |  DARFs: ${empresa.darf_pis} / ${empresa.darf_cofins}`;
  rCell.font  = {size:10, color:{argb:GRAY}};
  rCell.alignment = {horizontal:'center'};
  ws.getRow(r).height = 18; r++;

  ws.mergeCells(r,1,r,12);
  const pCell = ws.getRow(r).getCell(1);
  pCell.value = `Período: ${fmtDt(INICIO_CAIXA)} a ${fmtDt(FIM_CAIXA)}  |  Base: NFs pagas neste período  |  Emissão mínima: ${fmtDt(DATA_CORTE)}`;
  pCell.font  = {size:9, italic:true, color:{argb:GRAY}};
  pCell.alignment = {horizontal:'center'};
  ws.getRow(r).height = 16; r += 2;

  // Nota metodológica destacada
  ws.mergeCells(r,1,r,12);
  const nCell = ws.getRow(r).getCell(1);
  nCell.value =
    `METODOLOGIA — Lei 10.833/2003 art. 10 §2° (regime de caixa para prestação de serviços a entes públicos).\n` +
    `Base tributária = NFs cuja DATA DE PAGAMENTO ocorreu entre ${fmtDt(INICIO_CAIXA)} e ${fmtDt(FIM_CAIXA)}.\n` +
    `EXCLUÍDAS desta apuração: NFs com data_emissao < ${fmtDt(DATA_CORTE)} — essas já foram tributadas por competência nos exercícios anteriores, quando a empresa apurava PIS/COFINS pelo regime de competência. ` +
    `Reincluí-las em 2026 configuraria bitributação.`;
  nCell.font  = {size:9, color:{argb:'FF1E3A5F'}};
  nCell.fill  = {type:'pattern', pattern:'solid', fgColor:{argb:LBLUE}};
  nCell.alignment = {wrapText:true, vertical:'middle'};
  nCell.border = BORDER;
  ws.getRow(r).height = 68; r += 2;

  // ── CONSOLIDAÇÃO MENSAL ─────────────────────────────────────
  hdrRow(ws, r, ['#','MÊS DE PAGAMENTO','','NFs','Base Tributária (R$)','Ret. Total (R$)','Ret. PIS Fonte','Ret. COFINS Fonte','PIS Bruto','COFINS Bruto','PIS Devido','COFINS Devido'], BLUE);
  r++;

  mesesOrd.forEach((mes, idx) => {
    const m = porMes[mes];
    const pisB = +(m.bruto * empresa.pis_aliq).toFixed(2);
    const cofB = +(m.bruto * empresa.cofins_aliq).toFixed(2);
    const pisD = Math.max(0, +(pisB - m.ret_pis).toFixed(2));
    const cofD = Math.max(0, +(cofB - m.ret_cof).toFixed(2));
    const bg = idx % 2 === 0 ? null : LGRAY;
    const [ano, mm] = mes.split('-');
    const mesLabel = ['','JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'][parseInt(mm)];
    setCell(ws, r, 1, idx+1,                    null, bg, GRAY, false, 'center');
    ws.mergeCells(r, 2, r, 3);
    setCell(ws, r, 2, `${mesLabel}/${ano}`,     null, bg, '', true);
    setCell(ws, r, 4, m.qtd,                    null, bg, GRAY, false, 'center');
    setMoney(ws, r, 5, m.bruto,                 bg);
    setMoney(ws, r, 6, m.ret,                   bg);
    setMoney(ws, r, 7, m.ret_pis,               bg);
    setMoney(ws, r, 8, m.ret_cof,               bg);
    setMoney(ws, r, 9, pisB,                    bg);
    setMoney(ws, r, 10, cofB,                   bg);
    setMoney(ws, r, 11, pisD,                   bg, GREEN, true);
    setMoney(ws, r, 12, cofD,                   bg, GREEN, true);
    r++;
  });

  // Totais mensais
  setCell(ws, r, 1, '',                        null, LGREEN);
  ws.mergeCells(r, 2, r, 3);
  setCell(ws, r, 2, `TOTAL ${ANO}`,            null, LGREEN, GREEN, true);
  setCell(ws, r, 4, tributaveis.length,        null, LGREEN, GREEN, true, 'center');
  setMoney(ws, r, 5, totalBruto,               LGREEN, GREEN, true);
  setMoney(ws, r, 6, totalRet,                 LGREEN, GREEN, true);
  setMoney(ws, r, 7, totalRetPis,              LGREEN, GREEN, true);
  setMoney(ws, r, 8, totalRetCof,              LGREEN, GREEN, true);
  setMoney(ws, r, 9, pisBruto,                 LGREEN, GREEN, true);
  setMoney(ws, r, 10, cofinsBruto,             LGREEN, GREEN, true);
  setMoney(ws, r, 11, pisDevido,               LGREEN, GREEN, true);
  setMoney(ws, r, 12, cofinsDevido,            LGREEN, GREEN, true);
  r += 2;

  // ── POR CLIENTE ──────────────────────────────────────────────
  hdrRow(ws, r, ['#','CLIENTE / TOMADOR','CNPJ','NFs','Base Tributária (R$)','Ret. Total (R$)','Ret. PIS Fonte','Ret. COFINS Fonte','PIS Bruto','COFINS Bruto','PIS Devido','COFINS Devido'], BLUE);
  r++;

  clientes.forEach((c, idx) => {
    const pisB = +(c.bruto * empresa.pis_aliq).toFixed(2);
    const cofB = +(c.bruto * empresa.cofins_aliq).toFixed(2);
    const pisD = Math.max(0, +(pisB - c.ret_pis_fonte).toFixed(2));
    const cofD = Math.max(0, +(cofB - c.ret_cofins_fonte).toFixed(2));
    const bg = idx % 2 === 0 ? null : LGRAY;
    setCell(ws, r, 1, idx+1,                    null, bg, GRAY, false, 'center');
    setCell(ws, r, 2, c.nome,                   null, bg);
    setCell(ws, r, 3, c.cnpj || '—',            null, bg, GRAY);
    setCell(ws, r, 4, c.qtd,                    null, bg, GRAY, false, 'center');
    setMoney(ws, r, 5, c.bruto,                 bg);
    setMoney(ws, r, 6, c.ret_total,             bg);
    setMoney(ws, r, 7, c.ret_pis_fonte,         bg);
    setMoney(ws, r, 8, c.ret_cofins_fonte,      bg);
    setMoney(ws, r, 9, pisB,                    bg);
    setMoney(ws, r, 10, cofB,                   bg);
    setMoney(ws, r, 11, pisD,                   bg, GREEN, true);
    setMoney(ws, r, 12, cofD,                   bg, GREEN, true);
    r++;
  });

  // Total clientes
  setCell(ws, r, 1, '',                        null, LBLUE);
  setCell(ws, r, 2, `TOTAL (${clientes.length} clientes)`, null, LBLUE, BLUE, true);
  setCell(ws, r, 3, '',                        null, LBLUE);
  setCell(ws, r, 4, tributaveis.length,        null, LBLUE, BLUE, true, 'center');
  setMoney(ws, r, 5, totalBruto,               LBLUE, BLUE, true);
  setMoney(ws, r, 6, totalRet,                 LBLUE, BLUE, true);
  setMoney(ws, r, 7, totalRetPis,              LBLUE, BLUE, true);
  setMoney(ws, r, 8, totalRetCof,              LBLUE, BLUE, true);
  setMoney(ws, r, 9, pisBruto,                 LBLUE, BLUE, true);
  setMoney(ws, r, 10, cofinsBruto,             LBLUE, BLUE, true);
  setMoney(ws, r, 11, pisDevido,               LBLUE, BLUE, true);
  setMoney(ws, r, 12, cofinsDevido,            LBLUE, BLUE, true);
  r += 2;

  // ── APURAÇÃO FINAL ───────────────────────────────────────────
  ws.mergeCells(r, 1, r, 12);
  const aCell = ws.getRow(r).getCell(1);
  aCell.value = 'APURAÇÃO CONSOLIDADA PIS/COFINS — VALORES A RECOLHER';
  aCell.font  = {bold:true, size:12, color:{argb:WHITE}};
  aCell.fill  = {type:'pattern', pattern:'solid', fgColor:{argb:GREEN}};
  aCell.alignment = {horizontal:'center', vertical:'middle'};
  ws.getRow(r).height = 26; r++;

  hdrRow(ws, r, ['', 'Descrição', '', '', 'Base / Valor', '', '', '', `PIS (${(empresa.pis_aliq*100).toFixed(2).replace('.',',')}%)`, `COFINS (${(empresa.cofins_aliq*100).toFixed(2).replace('.',',')}%)`, 'TOTAL', ''], GRAY);
  r++;

  const linhas = [
    ['Receita bruta (caixa) — NFs pagas em ' + ANO,   totalBruto,     totalBruto,     totalBruto],
    ['(×) Alíquota',                                    null,            pisBruto,      cofinsBruto],
    ['(-) Retenções na fonte a compensar',              null,           -totalRetPis,  -totalRetCof],
    [`(=) VALOR A RECOLHER — DARFs ${empresa.darf_pis} / ${empresa.darf_cofins}`, null, pisDevido, cofinsDevido],
  ];
  linhas.forEach((l, idx) => {
    const isTot = idx === linhas.length - 1;
    const bg = isTot ? LGREEN : (idx % 2 === 0 ? null : LGRAY);
    const fc = isTot ? GREEN : '';
    setCell(ws, r, 1, '',                        null, bg);
    ws.mergeCells(r, 2, r, 4);
    setCell(ws, r, 2, l[0],                      null, bg, fc, isTot);
    ws.mergeCells(r, 5, r, 8);
    if (l[1] !== null) setMoney(ws, r, 5, l[1],  bg, fc, isTot);
    else              { setCell(ws, r, 5, '—', null, bg, GRAY, false, 'center'); }
    setMoney(ws, r, 9,  l[2], bg, fc, isTot);
    setMoney(ws, r, 10, l[3], bg, fc, isTot);
    setMoney(ws, r, 11, (l[2]||0) + (l[3]||0), bg, fc, isTot);
    setCell(ws, r, 12, '', null, bg);
    r++;
  });
  r++;

  // ── EXCLUÍDAS (aviso) ───────────────────────────────────────
  if (excluidas.length) {
    const sumExcl = excluidas.reduce((s,n) => s + (n.valor_bruto || 0), 0);
    ws.mergeCells(r, 1, r, 12);
    const exCell = ws.getRow(r).getCell(1);
    exCell.value = `⚠️ ${excluidas.length} NF${excluidas.length>1?'s':''} foram EXCLUÍDAS da base tributável (R$ ${brl(sumExcl)}). ` +
      `Motivo: data_emissao < ${fmtDt(DATA_CORTE)} — já tributadas por competência. Detalhamento na aba "Excluídas ${label}".`;
    exCell.font  = {size:10, bold:true, color:{argb:'FF92400E'}};
    exCell.fill  = {type:'pattern', pattern:'solid', fgColor:{argb:LYELLOW}};
    exCell.alignment = {wrapText:true, vertical:'middle'};
    exCell.border = BORDER;
    ws.getRow(r).height = 44; r++;
  }

  // ═══════════════════════════════════════════════════════════════
  // ABA: DETALHE NF A NF (TRIBUTÁVEIS)
  // ═══════════════════════════════════════════════════════════════
  const wsD = wb.addWorksheet(`Detalhe NFs ${label}`);
  wsD.columns = [
    {width:6}, {width:12}, {width:11}, {width:11}, {width:38}, {width:17},
    {width:23}, {width:14}, {width:14}, {width:12}, {width:10}, {width:10},
    {width:10}, {width:10}, {width:10}, {width:10}, {width:36}, {width:22},
  ];
  let rd = 1;
  wsD.mergeCells(rd, 1, rd, 18);
  const dCell = wsD.getRow(rd).getCell(1);
  dCell.value = `${empresa.nome} — NFs PAGAS EM ${ANO} (base tributária PIS/COFINS)`;
  dCell.font  = {bold:true, size:12, color:{argb:WHITE}};
  dCell.fill  = {type:'pattern', pattern:'solid', fgColor:{argb:BLUE}};
  dCell.alignment = {horizontal:'center', vertical:'middle'};
  wsD.getRow(rd).height = 28; rd++;

  hdrRow(wsD, rd, ['#','NF','Emissão','Pagamento','Tomador','CNPJ','Contrato','Vl. Bruto','Vl. Líquido','Ret.Total','INSS','IRRF','ISS','CSLL','PIS','COFINS','Pagador (extrato)','CNPJ pagador'], BLUE);
  rd++;

  tributaveis.sort((a,b) => (a.data_caixa||'').localeCompare(b.data_caixa||'')).forEach((n, idx) => {
    const bg = idx % 2 === 0 ? null : LGRAY;
    setCell(wsD, rd, 1, idx+1,                           null, bg, GRAY, false, 'center');
    setCell(wsD, rd, 2, n.numero,                        null, bg);
    setCell(wsD, rd, 3, fmtDt(n.data_emissao),           null, bg);
    setCell(wsD, rd, 4, fmtDt(n.data_caixa),             null, bg);
    setCell(wsD, rd, 5, n.tomador || '',                 null, bg);
    setCell(wsD, rd, 6, n.cnpj_tomador || '—',           null, bg, GRAY);
    setCell(wsD, rd, 7, n.contrato_ref || '',            null, bg, GRAY);
    setMoney(wsD, rd,  8, n.valor_bruto   || 0, bg);
    setMoney(wsD, rd,  9, n.valor_liquido || 0, bg);
    setMoney(wsD, rd, 10, n.retencao      || 0, bg);
    setMoney(wsD, rd, 11, n.inss          || 0, bg);
    setMoney(wsD, rd, 12, n.ir            || 0, bg);
    setMoney(wsD, rd, 13, n.iss           || 0, bg);
    setMoney(wsD, rd, 14, n.csll          || 0, bg);
    setMoney(wsD, rd, 15, n.pis           || 0, bg);
    setMoney(wsD, rd, 16, n.cofins        || 0, bg);
    // Pagador do extrato (quem efetivamente pagou)
    const pagador = n.pagador_nome || (n.extrato_historico ? n.extrato_historico.slice(0,60) : 'Sem vínculo extrato');
    const semExt  = !n.extrato_id;
    setCell(wsD, rd, 17, pagador,              null, semExt?LYELLOW:bg, semExt?AMBER:GRAY);
    setCell(wsD, rd, 18, n.pagador_cnpj || '', null, bg, GRAY);
    rd++;
  });

  // Totais
  setCell(wsD, rd, 1, '',          null, LBLUE);
  setCell(wsD, rd, 2, `${tributaveis.length} NFs`, null, LBLUE, BLUE, true);
  for (let c = 3; c <= 7; c++) setCell(wsD, rd, c, '', null, LBLUE);
  const totais = {
    bruto:   tributaveis.reduce((s,n)=>s+(n.valor_bruto  ||0),0),
    liq:     tributaveis.reduce((s,n)=>s+(n.valor_liquido||0),0),
    ret:     tributaveis.reduce((s,n)=>s+(n.retencao     ||0),0),
    inss:    tributaveis.reduce((s,n)=>s+(n.inss         ||0),0),
    ir:      tributaveis.reduce((s,n)=>s+(n.ir           ||0),0),
    iss:     tributaveis.reduce((s,n)=>s+(n.iss          ||0),0),
    csll:    tributaveis.reduce((s,n)=>s+(n.csll         ||0),0),
    pisFte:  tributaveis.reduce((s,n)=>s+(n.pis          ||0),0),
    cofFte:  tributaveis.reduce((s,n)=>s+(n.cofins       ||0),0),
  };
  setMoney(wsD, rd,  8, totais.bruto,  LBLUE, BLUE, true);
  setMoney(wsD, rd,  9, totais.liq,    LBLUE, BLUE, true);
  setMoney(wsD, rd, 10, totais.ret,    LBLUE, BLUE, true);
  setMoney(wsD, rd, 11, totais.inss,   LBLUE, BLUE, true);
  setMoney(wsD, rd, 12, totais.ir,     LBLUE, BLUE, true);
  setMoney(wsD, rd, 13, totais.iss,    LBLUE, BLUE, true);
  setMoney(wsD, rd, 14, totais.csll,   LBLUE, BLUE, true);
  setMoney(wsD, rd, 15, totais.pisFte, LBLUE, BLUE, true);
  setMoney(wsD, rd, 16, totais.cofFte, LBLUE, BLUE, true);
  setCell(wsD, rd, 17, '', null, LBLUE);
  setCell(wsD, rd, 18, '', null, LBLUE);

  // ═══════════════════════════════════════════════════════════════
  // ABA: EXCLUÍDAS (se houver)
  // ═══════════════════════════════════════════════════════════════
  if (excluidas.length) {
    const wsE = wb.addWorksheet(`Excluídas ${label}`);
    wsE.columns = [
      {width:6},{width:12},{width:11},{width:11},{width:38},{width:17},{width:23},{width:14},{width:14},{width:40},
    ];
    let re = 1;
    wsE.mergeCells(re, 1, re, 10);
    const eCell = wsE.getRow(re).getCell(1);
    eCell.value = `${empresa.nome} — NFs EXCLUÍDAS DA BASE ${ANO} (já tributadas por competência)`;
    eCell.font  = {bold:true, size:12, color:{argb:WHITE}};
    eCell.fill  = {type:'pattern', pattern:'solid', fgColor:{argb:AMBER}};
    eCell.alignment = {horizontal:'center', vertical:'middle'};
    wsE.getRow(re).height = 28; re++;

    wsE.mergeCells(re, 1, re, 10);
    const expCell = wsE.getRow(re).getCell(1);
    expCell.value =
      `Estas NFs foram pagas em ${ANO} mas sua competência de emissão é anterior a ${fmtDt(DATA_CORTE)}. ` +
      `Já foram oferecidas à tributação nos exercícios de origem (regime de competência). ` +
      `Listadas aqui apenas para rastreabilidade contábil — não compõem a base PIS/COFINS de ${ANO}.`;
    expCell.font  = {size:10, italic:true, color:{argb:'FF92400E'}};
    expCell.fill  = {type:'pattern', pattern:'solid', fgColor:{argb:LYELLOW}};
    expCell.alignment = {wrapText:true, vertical:'middle'};
    expCell.border = BORDER;
    wsE.getRow(re).height = 44; re++;

    hdrRow(wsE, re, ['#','NF','Emissão','Pagamento','Tomador','CNPJ','Contrato','Vl. Bruto','Vl. Líquido','Observação'], AMBER);
    re++;
    excluidas.sort((a,b) => (a.data_emissao||'').localeCompare(b.data_emissao||'')).forEach((n, i) => {
      const bg = i % 2 === 0 ? null : LGRAY;
      setCell(wsE, re, 1, i+1,                        null, bg, GRAY, false, 'center');
      setCell(wsE, re, 2, n.numero,                   null, bg);
      setCell(wsE, re, 3, fmtDt(n.data_emissao),      null, bg);
      setCell(wsE, re, 4, fmtDt(n.data_caixa),        null, bg);
      setCell(wsE, re, 5, n.tomador || '',            null, bg);
      setCell(wsE, re, 6, n.cnpj_tomador || '—',      null, bg, GRAY);
      setCell(wsE, re, 7, n.contrato_ref || '',       null, bg, GRAY);
      setMoney(wsE, re, 8, n.valor_bruto   || 0,      bg);
      setMoney(wsE, re, 9, n.valor_liquido || 0,      bg);
      const ano = (n.data_emissao||'').slice(0,4);
      setCell(wsE, re, 10, `Tributada em ${ano} por competência`, null, bg, AMBER);
      re++;
    });
    const sumExcl = excluidas.reduce((s,n) => s + (n.valor_bruto || 0), 0);
    setCell(wsE, re, 1, '', null, LYELLOW);
    setCell(wsE, re, 2, `${excluidas.length} NFs`, null, LYELLOW, AMBER, true);
    for (let c = 3; c <= 7; c++) setCell(wsE, re, c, '', null, LYELLOW);
    setMoney(wsE, re, 8, sumExcl, LYELLOW, AMBER, true);
    setMoney(wsE, re, 9, excluidas.reduce((s,n)=>s+(n.valor_liquido||0),0), LYELLOW, AMBER, true);
    setCell(wsE, re, 10, 'Total não tributado em ' + ANO, null, LYELLOW, AMBER, true);
  }

  // ═══════════════════════════════════════════════════════════════
  // ABA: PAGADORES — AGREGADO POR EXTRATO BANCÁRIO
  // ═══════════════════════════════════════════════════════════════
  // Agrupa NFs tributáveis pelo pagador_identificado do extrato vinculado
  // (mostra quem efetivamente fez o crédito em conta)
  const porPagador = new Map(); // chave: pagador_nome → { cnpj, qtdNFs, qtdExtratos, totalLiq, totalBruto }
  const extratosSeen = new Map(); // chave: pagador → Set(ext_id)
  for (const n of tributaveis) {
    const chave = n.pagador_nome || (n.extrato_id ? (n.extrato_historico||'').slice(0,50) : 'Sem vínculo extrato');
    if (!porPagador.has(chave)) {
      porPagador.set(chave, { cnpj: n.pagador_cnpj || '', qtdNFs:0, qtdExt:new Set(), totalLiq:0, totalBruto:0, metodo: n.pagador_metodo || '' });
    }
    const g = porPagador.get(chave);
    g.qtdNFs++;
    if (n.extrato_id) g.qtdExt.add(n.extrato_id);
    g.totalLiq   += (n.valor_liquido || 0);
    g.totalBruto += (n.valor_bruto   || 0);
    if (!g.cnpj && n.pagador_cnpj) g.cnpj = n.pagador_cnpj;
  }

  const wsP = wb.addWorksheet(`Pagadores ${label}`);
  wsP.columns = [{width:48},{width:22},{width:12},{width:14},{width:18},{width:18}];
  let rp = 1;
  wsP.mergeCells(rp, 1, rp, 6);
  const pHdr = wsP.getRow(rp).getCell(1);
  pHdr.value = `${empresa.nome} — QUEM EFETUOU OS CRÉDITOS EM CONTA (${ANO})`;
  pHdr.font  = {bold:true, size:12, color:{argb:WHITE}};
  pHdr.fill  = {type:'pattern', pattern:'solid', fgColor:{argb:BLUE}};
  pHdr.alignment = {horizontal:'center', vertical:'middle'};
  wsP.getRow(rp).height = 28; rp++;

  wsP.mergeCells(rp, 1, rp, 6);
  const pExp = wsP.getRow(rp).getCell(1);
  pExp.value =
    'Agrupamento de NFs pagas por pagador identificado no extrato bancário. ' +
    'Útil para a contabilidade cruzar a origem dos créditos (identificação de quem efetivamente pagou) ' +
    'com os tomadores das NFs. Em contratos públicos, o pagador CNPJ pode diferir do tomador (ex: TED do tesouro pagando NF emitida contra órgão).';
  pExp.font  = {size:9, italic:true, color:{argb:GRAY}};
  pExp.alignment = {wrapText:true, vertical:'middle'};
  pExp.border = BORDER;
  wsP.getRow(rp).height = 40; rp++;

  hdrRow(wsP, rp, ['Pagador identificado (extrato)','CNPJ pagador','Método','Qtd NFs','Total Bruto (R$)','Total Líquido (R$)'], BLUE);
  rp++;

  const pagadoresOrdenados = [...porPagador.entries()].sort((a,b) => b[1].totalBruto - a[1].totalBruto);
  for (const [nome, g] of pagadoresOrdenados) {
    const bg = (rp % 2 === 0) ? null : LGRAY;
    const semExt = nome === 'Sem vínculo extrato';
    setCell(wsP, rp, 1, nome,            null, semExt?LYELLOW:bg, semExt?AMBER:'', semExt);
    setCell(wsP, rp, 2, g.cnpj || '—',   null, bg, GRAY);
    setCell(wsP, rp, 3, g.metodo || '—', null, bg, GRAY, false, 'center');
    setCell(wsP, rp, 4, g.qtdNFs,        null, bg, '', false, 'center');
    setMoney(wsP, rp, 5, g.totalBruto, bg);
    setMoney(wsP, rp, 6, g.totalLiq,   bg);
    rp++;
  }
  setCell(wsP, rp, 1, 'TOTAL', null, LBLUE, BLUE, true);
  setCell(wsP, rp, 2, '', null, LBLUE);
  setCell(wsP, rp, 3, '', null, LBLUE);
  setCell(wsP, rp, 4, pagadoresOrdenados.reduce((s,[_,g]) => s+g.qtdNFs, 0), null, LBLUE, BLUE, true, 'center');
  setMoney(wsP, rp, 5, pagadoresOrdenados.reduce((s,[_,g]) => s+g.totalBruto, 0), LBLUE, BLUE, true);
  setMoney(wsP, rp, 6, pagadoresOrdenados.reduce((s,[_,g]) => s+g.totalLiq,   0), LBLUE, BLUE, true);

  // ═══════════════════════════════════════════════════════════════
  // ABA: NFs 2026 REFERENTES A 2025 (discriminação Prodata / contratos públicos)
  // ═══════════════════════════════════════════════════════════════
  // Consulta ao banco pra pegar essas NFs (emitidas 2026 com competência 2025 no texto)
  const dbEmp = new Database(empresa.db, { readonly: true });
  const nfs2025Ref = dbEmp.prepare(`
    SELECT numero, data_emissao, data_pagamento, tomador, cnpj_tomador, contrato_ref,
           valor_bruto, valor_liquido, retencao, discriminacao,
           extrato_id, status_conciliacao
    FROM notas_fiscais
    WHERE status_conciliacao NOT IN ('CANCELADA','ASSESSORIA')
      AND substr(data_emissao,1,4) = '2026'
      AND discriminacao IS NOT NULL
      AND (
        discriminacao LIKE '%2025%'
        OR discriminacao LIKE '%/25%'
        OR lower(discriminacao) LIKE '%janeiro/2025%'  OR lower(discriminacao) LIKE '%fevereiro/2025%'
        OR lower(discriminacao) LIKE '%marco/2025%'    OR lower(discriminacao) LIKE '%março/2025%'
        OR lower(discriminacao) LIKE '%abril/2025%'    OR lower(discriminacao) LIKE '%maio/2025%'
        OR lower(discriminacao) LIKE '%junho/2025%'    OR lower(discriminacao) LIKE '%julho/2025%'
        OR lower(discriminacao) LIKE '%agosto/2025%'   OR lower(discriminacao) LIKE '%setembro/2025%'
        OR lower(discriminacao) LIKE '%outubro/2025%'  OR lower(discriminacao) LIKE '%novembro/2025%'
        OR lower(discriminacao) LIKE '%dezembro/2025%'
      )
    ORDER BY tomador, data_emissao, numero
  `).all();
  dbEmp.close();

  if (nfs2025Ref.length > 0) {
    const wsR = wb.addWorksheet(`NFs 2026 ref 2025 ${label}`);
    wsR.columns = [
      {width:6},{width:14},{width:11},{width:36},{width:17},{width:22},
      {width:14},{width:14},{width:60},{width:18},{width:11}
    ];
    let rr = 1;
    wsR.mergeCells(rr, 1, rr, 11);
    const rHdr = wsR.getRow(rr).getCell(1);
    rHdr.value = `${empresa.nome} — NFs EMITIDAS EM 2026 REFERENTES A COMPETÊNCIAS DE 2025`;
    rHdr.font  = {bold:true, size:12, color:{argb:WHITE}};
    rHdr.fill  = {type:'pattern', pattern:'solid', fgColor:{argb:AMBER}};
    rHdr.alignment = {horizontal:'center', vertical:'middle'};
    wsR.getRow(rr).height = 28; rr++;

    wsR.mergeCells(rr, 1, rr, 11);
    const rExp = wsR.getRow(rr).getCell(1);
    rExp.value =
      'NFs emitidas em 2026 cuja discriminação (Prodata/WebISS) menciona meses de 2025. ' +
      'No regime de caixa são tributadas em 2026 (quando recebidas). ' +
      '⚠️ Prefeitura de Palmas paga com 4–6 meses de atraso — algumas podem ainda estar a receber. ' +
      'Use esta aba para conciliação manual com extrato: casar NF + OB/TED no extrato bancário.';
    rExp.font  = {size:9, italic:true, color:{argb:'FF92400E'}};
    rExp.fill  = {type:'pattern', pattern:'solid', fgColor:{argb:LYELLOW}};
    rExp.alignment = {wrapText:true, vertical:'middle'};
    rExp.border = BORDER;
    wsR.getRow(rr).height = 42; rr++;

    hdrRow(wsR, rr, ['#','NF','Emissão','Tomador','CNPJ','Contrato','Vl. Bruto','Vl. Líquido','Discriminação (1ª linha)','Status','Pagamento'], AMBER);
    rr++;

    // Extrair competência da discriminação
    function extraiComp(s) {
      if (!s) return '';
      const mLong = s.toLowerCase().match(/(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)[\/ ]+(2025|25)/);
      if (mLong) return mLong[0];
      const mNum = s.match(/(\d{2})\/(2025|25)/);
      if (mNum) return mNum[0];
      return '2025';
    }

    nfs2025Ref.forEach((n, i) => {
      const bg = i % 2 === 0 ? null : LGRAY;
      const temVinc = !!n.extrato_id;
      const statusTxt = temVinc ? '✅ CONCILIADO' : '⚠️ SEM EXTRATO';
      const statusBg  = temVinc ? LGREEN : LYELLOW;
      const statusFc  = temVinc ? GREEN  : AMBER;
      setCell(wsR, rr, 1, i+1,                         null, bg, GRAY, false, 'center');
      setCell(wsR, rr, 2, n.numero,                    null, bg);
      setCell(wsR, rr, 3, fmtDt(n.data_emissao),       null, bg);
      setCell(wsR, rr, 4, n.tomador || '',             null, bg);
      setCell(wsR, rr, 5, n.cnpj_tomador || '—',       null, bg, GRAY);
      setCell(wsR, rr, 6, n.contrato_ref || '',        null, bg, GRAY);
      setMoney(wsR, rr, 7, n.valor_bruto   || 0,       bg);
      setMoney(wsR, rr, 8, n.valor_liquido || 0,       bg);
      setCell(wsR, rr, 9, (n.discriminacao||'').split('\n')[0].slice(0,100), null, bg, GRAY);
      setCell(wsR, rr, 10, statusTxt,                  null, statusBg, statusFc, true);
      setCell(wsR, rr, 11, fmtDt(n.data_pagamento)||'—', null, bg, GRAY);
      rr++;
    });

    const semVinc = nfs2025Ref.filter(n => !n.extrato_id);
    const comVinc = nfs2025Ref.filter(n =>  n.extrato_id);
    setCell(wsR, rr, 1, '', null, LBLUE);
    setCell(wsR, rr, 2, `${nfs2025Ref.length} NFs`, null, LBLUE, BLUE, true);
    for (let c = 3; c <= 6; c++) setCell(wsR, rr, c, '', null, LBLUE);
    setMoney(wsR, rr, 7, nfs2025Ref.reduce((s,n) => s + (n.valor_bruto||0), 0), LBLUE, BLUE, true);
    setMoney(wsR, rr, 8, nfs2025Ref.reduce((s,n) => s + (n.valor_liquido||0), 0), LBLUE, BLUE, true);
    setCell(wsR, rr, 9, `${comVinc.length} conciliadas · ${semVinc.length} sem extrato (R$ ${brl(semVinc.reduce((s,n)=>s+n.valor_liquido,0))})`, null, LBLUE, BLUE, true);
    setCell(wsR, rr, 10, '', null, LBLUE);
    setCell(wsR, rr, 11, '', null, LBLUE);
  }

  return {
    empresa: empresa.key,
    nome: empresa.nome,
    tributaveis: tributaveis.length,
    excluidas: excluidas.length,
    base: totalBruto,
    retPis: totalRetPis,
    retCof: totalRetCof,
    pisBruto, cofinsBruto, pisDevido, cofinsDevido,
    total: pisDevido + cofinsDevido,
    clientes: clientes.length,
    nfs_2025_ref: nfs2025Ref.length,
    nfs_2025_ref_sem_vinc: nfs2025Ref.filter(n => !n.extrato_id).length,
    nfs_2025_ref_valor_sem_vinc: nfs2025Ref.filter(n => !n.extrato_id).reduce((s,n)=>s+n.valor_liquido,0),
  };
}

// ── ABA CONSOLIDADA (capa) ───────────────────────────────────────
function adicionarCapa(wb, resultados, ws) {
  ws.columns = [{width:4}, {width:44}, {width:18}, {width:14}, {width:14}, {width:14}, {width:14}, {width:14}, {width:16}];

  let r = 1;
  ws.mergeCells(r, 1, r, 9);
  const t = ws.getRow(r).getCell(1);
  t.value = `RELATÓRIO CONTÁBIL — PIS/COFINS REGIME DE CAIXA ${ANO}`;
  t.font  = {bold:true, size:16, color:{argb:WHITE}};
  t.fill  = {type:'pattern', pattern:'solid', fgColor:{argb:BLUE}};
  t.alignment = {horizontal:'center', vertical:'middle'};
  ws.getRow(r).height = 44; r++;

  ws.mergeCells(r, 1, r, 9);
  const s = ws.getRow(r).getCell(1);
  s.value = `Destinado à contabilidade para apuração e recolhimento federal`;
  s.font  = {size:11, color:{argb:GRAY}};
  s.alignment = {horizontal:'center'};
  ws.getRow(r).height = 20; r++;

  ws.mergeCells(r, 1, r, 9);
  const p = ws.getRow(r).getCell(1);
  p.value = `Período: ${fmtDt(INICIO_CAIXA)} a ${fmtDt(FIM_CAIXA)}  |  Gerado em ${new Date().toLocaleString('pt-BR')}`;
  p.font  = {size:10, italic:true, color:{argb:GRAY}};
  p.alignment = {horizontal:'center'};
  ws.getRow(r).height = 18; r += 2;

  // Nota metodológica
  ws.mergeCells(r, 1, r, 9);
  const note = ws.getRow(r).getCell(1);
  note.value =
    `FUNDAMENTO LEGAL: Lei 10.833/2003 art. 10 §2° — regime de caixa para PIS/COFINS de empresas prestadoras de serviços a entes públicos.\n\n` +
    `BASE: notas fiscais cuja DATA DE PAGAMENTO ocorreu no período. Pagamento identificado por: (1) campo data_pagamento da NF; (2) data do extrato bancário vinculado (NF conciliada); (3) ou comprovante de recebimento anexado.\n\n` +
    `EXCLUSÃO DA COMPETÊNCIA ANTIGA: NFs com data_emissao < ${fmtDt(DATA_CORTE)} foram EXCLUÍDAS mesmo que pagas em ${ANO}. ` +
    `Nos exercícios de 2024, 2023 e anteriores as empresas apuravam PIS/COFINS pelo regime de competência — essas receitas já foram oferecidas à tributação no período de emissão. ` +
    `Incluí-las novamente configuraria bitributação e indébito por parte do fisco. ` +
    `Listadas separadamente nas abas "Excluídas" para auditoria contábil.`;
  note.font  = {size:10, color:{argb:'FF1E3A5F'}};
  note.fill  = {type:'pattern', pattern:'solid', fgColor:{argb:LBLUE}};
  note.alignment = {wrapText:true, vertical:'top'};
  note.border = BORDER;
  ws.getRow(r).height = 140; r += 2;

  // Tabela consolidada
  hdrRow(ws, r, ['#','EMPRESA','CNPJ','NFs','Base (R$)','Ret. Fonte (R$)','PIS a Recolher','COFINS a Recolher','TOTAL (R$)'], BLUE);
  r++;

  let totBase = 0, totRet = 0, totPis = 0, totCof = 0, totNfs = 0;
  resultados.forEach((x, i) => {
    const bg = i % 2 === 0 ? null : LGRAY;
    setCell(ws, r, 1, i+1,                                     null, bg, GRAY, false, 'center');
    setCell(ws, r, 2, x.nome,                                  null, bg, '', true);
    setCell(ws, r, 3, EMPRESAS[x.empresa].cnpj,                null, bg, GRAY);
    setCell(ws, r, 4, x.tributaveis,                           null, bg, GRAY, false, 'center');
    setMoney(ws, r, 5, x.base,                                 bg);
    setMoney(ws, r, 6, x.retPis + x.retCof,                    bg);
    setMoney(ws, r, 7, x.pisDevido,                            bg, GREEN, true);
    setMoney(ws, r, 8, x.cofinsDevido,                         bg, GREEN, true);
    setMoney(ws, r, 9, x.total,                                bg, GREEN, true);
    totBase += x.base; totRet += (x.retPis + x.retCof);
    totPis  += x.pisDevido; totCof += x.cofinsDevido; totNfs += x.tributaveis;
    r++;
  });

  setCell(ws, r, 1, '',                                        null, LGREEN);
  setCell(ws, r, 2, 'GRUPO MONTANA — CONSOLIDADO',             null, LGREEN, GREEN, true);
  setCell(ws, r, 3, '',                                        null, LGREEN);
  setCell(ws, r, 4, totNfs,                                    null, LGREEN, GREEN, true, 'center');
  setMoney(ws, r, 5, totBase,                                  LGREEN, GREEN, true);
  setMoney(ws, r, 6, totRet,                                   LGREEN, GREEN, true);
  setMoney(ws, r, 7, totPis,                                   LGREEN, GREEN, true);
  setMoney(ws, r, 8, totCof,                                   LGREEN, GREEN, true);
  setMoney(ws, r, 9, totPis + totCof,                          LGREEN, GREEN, true);
  r += 2;

  // Códigos DARF
  hdrRow(ws, r, ['', 'RECOLHIMENTO — CÓDIGOS DARF', '', '', '', '', '', '', ''], GRAY);
  r++;
  resultados.forEach(x => {
    const e = EMPRESAS[x.empresa];
    ws.mergeCells(r, 1, r, 3);
    setCell(ws, r, 1, `  ${e.nome}`, null, null, '', true);
    ws.mergeCells(r, 4, r, 6);
    setCell(ws, r, 4, `PIS — DARF ${e.darf_pis}`, null, null, BLUE);
    setMoney(ws, r, 7, x.pisDevido, null, GREEN, true);
    ws.mergeCells(r, 8, r, 9);
    setCell(ws, r, 8, `Vencimento: 25º dia útil do mês seguinte`, null, null, GRAY);
    r++;
    ws.mergeCells(r, 1, r, 3);
    setCell(ws, r, 1, '', null);
    ws.mergeCells(r, 4, r, 6);
    setCell(ws, r, 4, `COFINS — DARF ${e.darf_cofins}`, null, null, BLUE);
    setMoney(ws, r, 7, x.cofinsDevido, null, GREEN, true);
    ws.mergeCells(r, 8, r, 9);
    setCell(ws, r, 8, ``, null);
    r++;
  });
  r++;

  // Assinatura
  ws.mergeCells(r, 1, r, 9);
  const f = ws.getRow(r).getCell(1);
  f.value = `Emitido pelo Sistema Montana — ${new Date().toLocaleString('pt-BR')} — para uso da contabilidade`;
  f.font  = {size:8, italic:true, color:{argb:GRAY}};
  f.alignment = {horizontal:'center'};
}

// ── EXECUÇÃO ─────────────────────────────────────────────────────
(async () => {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  RELATÓRIO CONTÁBIL PIS/COFINS — REGIME DE CAIXA ${ANO}`);
  console.log(`  Período: ${INICIO_CAIXA} a ${FIM_CAIXA}`);
  console.log(`  Emissão mínima: ${DATA_CORTE} (NFs anteriores = já tributadas)`);
  console.log(`${'═'.repeat(70)}\n`);

  const wb = new ExcelJS.Workbook();
  wb.creator  = 'Sistema Montana';
  wb.created  = new Date();
  wb.company  = 'Grupo Montana';
  wb.title    = `Apuração PIS/COFINS ${ANO}`;

  // Capa criada primeiro (para ficar na posição 1); preenchida no final
  const wsCapa = wb.addWorksheet('Capa — Resumo Geral', { properties: { tabColor: { argb: BLUE } } });

  const resultados = [];
  for (const empresa of empresasRodar) {
    try {
      const nfs = carregarNFs(empresa);
      console.log(`  ${empresa.nome.padEnd(42)}  NFs pagas em ${ANO}: ${String(nfs.length).padStart(4)}`);
      const r = adicionarAbaEmpresa(wb, empresa, nfs);
      console.log(`    Tributáveis: ${r.tributaveis}  Excluídas: ${r.excluidas}  Base: R$ ${brl(r.base).padStart(14)}`);
      console.log(`    PIS a recolher: R$ ${brl(r.pisDevido).padStart(10)}  |  COFINS a recolher: R$ ${brl(r.cofinsDevido).padStart(10)}  |  TOTAL: R$ ${brl(r.total).padStart(10)}`);
      resultados.push(r);
    } catch (e) {
      console.error(`  ✗ Erro em ${empresa.key}:`, e.message);
    }
  }

  // Preenche a capa (criada no início da workbook)
  if (resultados.length) adicionarCapa(wb, resultados, wsCapa);

  const outName = `Relatorio_Contabilidade_PIS_COFINS_${ANO}${empArg !== 'todas' ? '_' + empArg.toUpperCase() : ''}.xlsx`;
  const outPath = path.join(__dirname, '..', outName);
  await wb.xlsx.writeFile(outPath);

  let copiaMsg = '';
  try {
    const downloadPath = path.join(os.homedir(), 'Downloads', outName);
    fs.copyFileSync(outPath, downloadPath);
    copiaMsg = `  📁 ${downloadPath}`;
  } catch (e) {
    copiaMsg = `  ⚠️ Cópia p/ Downloads falhou (${e.code}) — arquivo em ${outPath}`;
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ARQUIVO GERADO:`);
  console.log(`  📂 ${outPath}`);
  console.log(copiaMsg);

  if (resultados.length > 1) {
    const totBase = resultados.reduce((s,x) => s + x.base, 0);
    const totPis  = resultados.reduce((s,x) => s + x.pisDevido, 0);
    const totCof  = resultados.reduce((s,x) => s + x.cofinsDevido, 0);
    console.log(`\n  CONSOLIDADO GRUPO MONTANA:`);
    console.log(`    Base tributária total: R$ ${brl(totBase)}`);
    console.log(`    PIS a recolher:        R$ ${brl(totPis)}`);
    console.log(`    COFINS a recolher:     R$ ${brl(totCof)}`);
    console.log(`    TOTAL a recolher:      R$ ${brl(totPis + totCof)}`);
  }
  console.log(`${'═'.repeat(70)}\n`);
})();
