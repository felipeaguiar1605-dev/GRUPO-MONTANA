/**
 * Relatório de Apuração PIS/COFINS — Regime de Caixa — Março/2026
 * Montana Assessoria Empresarial Ltda
 *
 * Uso: node scripts/gerar_relatorio_apuracao_mar2026.js
 */

const path = require('path');
const Database = require('better-sqlite3');
const ExcelJS = require('exceljs');

const db = new Database(path.join(__dirname, '../data/assessoria/montana.db'));

// ── HELPERS ──────────────────────────────────────────────────────
const BRL = '#,##0.00';
const BLUE='FF1D4ED8', GRAY='FF475569', GREEN='FF15803D', AMBER='FFD97706';
const WHITE='FFFFFFFF', LBLUE='FFDBEAFE', LGREEN='FFF0FDF4', LGRAY='FFF1F5F9';
const LYELLOW='FFFEF9C3', LRED='FFFEE2E2';
const bdr = { style:'thin', color:{argb:'FFE2E8F0'} };
const BORDER = { top:bdr, left:bdr, bottom:bdr, right:bdr };

function fmtDt(d) { return d ? d.slice(8,10)+'/'+d.slice(5,7)+'/'+d.slice(0,4) : ''; }
function brl_fmt(v) { return v != null ? v.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}) : '0,00'; }

function hdrRow(ws, rowNum, cols, bg=BLUE, fc=WHITE) {
  const row = ws.getRow(rowNum);
  cols.forEach((v,i) => {
    const c = row.getCell(i+1);
    c.value = v;
    c.font = {bold:true, size:9, color:{argb:fc}};
    c.fill = {type:'pattern', pattern:'solid', fgColor:{argb:bg}};
    c.alignment = {horizontal:'center', vertical:'middle', wrapText:true};
    c.border = BORDER;
  });
  row.height = 28;
}

function setCell(ws, rowNum, colNum, val, numFmt, bgColor, fontColor='FF1E293B', bold=false, align='left') {
  const c = ws.getRow(rowNum).getCell(colNum);
  c.value = val;
  if (numFmt) c.numFmt = numFmt;
  if (bgColor) c.fill = {type:'pattern', pattern:'solid', fgColor:{argb:bgColor}};
  c.font = {size:9, color:{argb:fontColor}, bold};
  c.alignment = {horizontal:align, vertical:'middle', wrapText:true};
  c.border = BORDER;
}

function setMoney(ws, rowNum, colNum, val, bgColor, fontColor='FF1E293B', bold=false) {
  setCell(ws, rowNum, colNum, val, BRL, bgColor, fontColor, bold, 'right');
}

// ── DADOS ────────────────────────────────────────────────────────

// 1. Créditos março/2026 — deduplicar entradas duplicadas entre contas
const rawCreditos = db.prepare(`
  SELECT id, data_iso, historico, credito, status_conciliacao, contrato_vinculado
  FROM extratos
  WHERE data_iso BETWEEN '2026-03-01' AND '2026-03-31' AND credito > 0
  ORDER BY data_iso, credito DESC
`).all();

const chavesSeen = new Set();
const creditosUnicos = [];
for (const c of rawCreditos) {
  const chave = `${c.data_iso}|${c.credito.toFixed(2)}|${(c.historico||'').slice(0,20).replace(/\s+/g,' ').trim().toUpperCase().replace(/[^A-Z0-9]/g,'')}`;
  if (!chavesSeen.has(chave)) { chavesSeen.add(chave); creditosUnicos.push(c); }
}

function tipoCredito(c) {
  const h = (c.historico||'').toUpperCase();
  const st = (c.status_conciliacao||'').toUpperCase();
  if (st === 'INTERNO' || st === 'TRANSFERENCIA') return 'INTERNO';
  if (h.includes('RENDE FACIL') || h.includes('APLICACAO') || st === 'INVESTIMENTO') return 'INVESTIMENTO';
  if (h.includes('MONTANA S') || h.includes('MONTANA SERV') || h.includes('MONTANA SEG') || h.includes('MONTANA ASSES')) return 'INTERNO';
  return 'RECEITA';
}

function identificarTomador(c) {
  const h = (c.historico||'').toUpperCase();
  if (h.includes('05149726') || h.includes('FUNDACAO UN') || h.includes('FUNDACAO UNIVER')) return 'UFT — Fundação Univ. Federal do Tocantins';
  if (h.includes('TCE') || h.includes('TRIBUNAL DE CONTAS')) return 'TCE/TO — Tribunal de Contas';
  if (h.includes('MUNICIPIO DE PALMAS') || h.includes('ORDENS BANCARIAS')) return 'Município de Palmas (SEMUS/PREVI/DETRAN)';
  if (h.includes('GOVERNO DO EST') || h.includes('ESTADO DO TOCANTINS') || h.includes('070 0380')) return 'Governo do Estado do Tocantins';
  if (h.includes('BACEN') || h.includes('JUDICIAL')) return 'Desbloqueio Judicial — BacenJud';
  if (c.contrato_vinculado) return c.contrato_vinculado;
  return 'Não identificado';
}

const receitas = creditosUnicos.filter(c => tipoCredito(c) === 'RECEITA');
const internos  = creditosUnicos.filter(c => tipoCredito(c) === 'INTERNO');
const invest    = creditosUnicos.filter(c => tipoCredito(c) === 'INVESTIMENTO');

const sumCaixaReceita = receitas.reduce((s,c) => s+c.credito, 0);

// 2. NFs emitidas em março/2026 (base tributária correta)
const nfsMar2026 = db.prepare(`
  SELECT numero, data_emissao, tomador, contrato_ref,
         valor_bruto, valor_liquido, retencao, pis, cofins, inss, ir, iss, csll
  FROM notas_fiscais
  WHERE data_emissao BETWEEN '2026-03-01' AND '2026-03-31'
  ORDER BY data_emissao, contrato_ref
`).all();

const sumNFsBruto   = nfsMar2026.reduce((s,n) => s+(n.valor_bruto||0), 0);
const sumNFsLiquido = nfsMar2026.reduce((s,n) => s+(n.valor_liquido||0), 0);

// Retenções totais
const ret = nfsMar2026.reduce((acc,n) => {
  acc.inss   += n.inss||0;
  acc.ir     += n.ir||0;
  acc.iss    += n.iss||0;
  acc.csll   += n.csll||0;
  acc.pis    += n.pis||0;
  acc.cofins += n.cofins||0;
  acc.total  += n.retencao||0;
  return acc;
}, {inss:0, ir:0, iss:0, csll:0, pis:0, cofins:0, total:0});

// PIS/COFINS próprios — base = NFs emitidas março/2026
const pisBruto    = +(sumNFsBruto * 0.0165).toFixed(2);
const cofinsBruto = +(sumNFsBruto * 0.076).toFixed(2);
const pisLiq      = Math.max(+(pisBruto  - ret.pis).toFixed(2),    0);
const cofinsLiq   = Math.max(+(cofinsBruto - ret.cofins).toFixed(2), 0);

// Estimativa de caixa recebido relativo a NFs de anos anteriores
const estimativaAnosAnt = Math.max(sumCaixaReceita - sumNFsBruto, 0);

// Agrupar NFs por contrato
const nfPorContrato = {};
nfsMar2026.forEach(n => {
  const k = n.contrato_ref || 'Não identificado';
  if (!nfPorContrato[k]) nfPorContrato[k] = {n:0,bruto:0,liq:0,ret:0,pis:0,cofins:0,inss:0,ir:0,iss:0,csll:0};
  const g = nfPorContrato[k];
  g.n++; g.bruto+=n.valor_bruto||0; g.liq+=n.valor_liquido||0; g.ret+=n.retencao||0;
  g.pis+=n.pis||0; g.cofins+=n.cofins||0; g.inss+=n.inss||0; g.ir+=n.ir||0; g.iss+=n.iss||0; g.csll+=n.csll||0;
});

// ── WORKBOOK ─────────────────────────────────────────────────────
const wb = new ExcelJS.Workbook();
wb.creator = 'Montana ERP';
wb.created = new Date();

// ═══════════════════════════════════════════════════════════════
// ABA 1 — RESUMO EXECUTIVO
// ═══════════════════════════════════════════════════════════════
const ws1 = wb.addWorksheet('Resumo Executivo');
ws1.columns = [{width:46},{width:20},{width:20},{width:20}];

let r = 1;

// Título
ws1.mergeCells(r,1,r,4);
const tCell = ws1.getRow(r).getCell(1);
tCell.value = 'RELATÓRIO DE APURAÇÃO PIS/COFINS — REGIME DE CAIXA';
tCell.font = {bold:true, size:14, color:{argb:WHITE}};
tCell.fill = {type:'pattern', pattern:'solid', fgColor:{argb:BLUE}};
tCell.alignment = {horizontal:'center', vertical:'middle'};
ws1.getRow(r).height = 36; r++;

ws1.mergeCells(r,1,r,4);
const sCell = ws1.getRow(r).getCell(1);
sCell.value = 'Montana Assessoria Empresarial Ltda  —  CNPJ 14.092.519/0001-51  |  Competência: MARÇO/2026';
sCell.font = {size:10, color:{argb:GRAY}};
sCell.alignment = {horizontal:'center'};
ws1.getRow(r).height = 20; r++;

ws1.mergeCells(r,1,r,4);
const rCell = ws1.getRow(r).getCell(1);
rCell.value = 'Regime: Lucro Real — Não Cumulativo  |  PIS 1,65% + COFINS 7,60%  |  Base: NFs emitidas em março/2026 (competência)';
rCell.font = {size:9, italic:true, color:{argb:GRAY}};
rCell.alignment = {horizontal:'center'};
ws1.getRow(r).height = 18; r += 2;

// Bloco receita por contrato
hdrRow(ws1, r, ['RECEITA POR CONTRATO — NFs EMITIDAS EM MARÇO/2026', 'Valor Bruto (R$)', 'Retenções (R$)', 'Valor Líquido (R$)'], BLUE); r++;

Object.entries(nfPorContrato)
  .sort((a,b) => b[1].bruto - a[1].bruto)
  .forEach(([k,v]) => {
    setCell(ws1,r,1,`  ${k}  (${v.n} NF${v.n>1?'s':''})`);
    setMoney(ws1,r,2,v.bruto); setMoney(ws1,r,3,v.ret); setMoney(ws1,r,4,v.liq);
    r++;
  });

// Total NFs
setCell(ws1,r,1,'TOTAL NFs EMITIDAS EM MARÇO/2026', null, LBLUE, BLUE, true);
setMoney(ws1,r,2, sumNFsBruto, LBLUE, BLUE, true);
setMoney(ws1,r,3, ret.total,   LBLUE, BLUE, true);
setMoney(ws1,r,4, sumNFsLiquido, LBLUE, BLUE, true);
r += 2;

// Bloco retenções
hdrRow(ws1, r, ['DETALHAMENTO DAS RETENÇÕES NA FONTE (NFs março/2026)', 'Alíquota', 'Valor Retido (R$)', 'Observação'], GRAY); r++;

const retRows = [
  ['INSS — Previdência Social',            '11,00%', ret.inss,   'Federal/Estadual — sobre Módulo 1'],
  ['IRRF — Imposto de Renda Retido na Fonte','1,50%', ret.ir,    'Tomadores federais (UFT, UFNT)'],
  ['ISS — Imposto sobre Serviços',          'Variável',ret.iss,  'Município de Palmas'],
  ['CSLL — Contrib. Social s/ Lucro Líquido','1,00%', ret.csll,  'Tomadores federais (UFT, UFNT)'],
  ['PIS — Crédito retido na fonte',         '0,65%',  ret.pis,   'Tomadores federais — abate apuração própria'],
  ['COFINS — Crédito retido na fonte',      '3,00%',  ret.cofins,'Tomadores federais — abate apuração própria'],
];
retRows.forEach(([desc, aliq, val, obs]) => {
  setCell(ws1,r,1,'  '+desc);
  setCell(ws1,r,2, aliq, null, null, GRAY);
  setMoney(ws1,r,3, val);
  setCell(ws1,r,4, obs, null, null, GRAY);
  r++;
});
setCell(ws1,r,1,'TOTAL RETENÇÕES', null, LGRAY, GRAY, true);
setCell(ws1,r,2,'', null, LGRAY);
setMoney(ws1,r,3, ret.total, LGRAY, GRAY, true);
setCell(ws1,r,4,'', null, LGRAY);
r += 2;

// Bloco Apuração PIS/COFINS
hdrRow(ws1, r, ['APURAÇÃO PIS/COFINS PRÓPRIOS', 'PIS 1,65% (R$)', 'COFINS 7,60% (R$)', 'Total (R$)'], GREEN, WHITE); r++;

const apRows = [
  ['Base de cálculo — NFs emitidas março/2026', sumNFsBruto, sumNFsBruto, sumNFsBruto],
  ['(×) Alíquota sobre receita bruta', pisBruto, cofinsBruto, pisBruto+cofinsBruto],
  ['(-) Crédito — retenções na fonte sofridas', -ret.pis, -ret.cofins, -(ret.pis+ret.cofins)],
  ['(=) IMPOSTO A PAGAR — Venc. 25/04/2026', pisLiq, cofinsLiq, pisLiq+cofinsLiq],
];
apRows.forEach(([desc, p, c, tot], i) => {
  const isTotal = i === 3;
  const bg  = isTotal ? LGREEN : null;
  const fc  = isTotal ? GREEN  : 'FF1E293B';
  setCell(ws1, r, 1, '  '+desc, null, bg, fc, isTotal);
  setMoney(ws1, r, 2, p,   bg, fc, isTotal);
  setMoney(ws1, r, 3, c,   bg, fc, isTotal);
  setMoney(ws1, r, 4, tot, bg, fc, isTotal);
  r++;
});

if (pisLiq > 0 || cofinsLiq > 0) {
  setCell(ws1, r, 1, '  Código DARF — PIS: 6912  |  COFINS: 2172', null, LGREEN, GREEN, false);
  setCell(ws1, r, 2, '', null, LGREEN); setCell(ws1, r, 3, '', null, LGREEN); setCell(ws1, r, 4, '', null, LGREEN);
  r++;
}
r++;

// Nota sobre anos anteriores
hdrRow(ws1, r, ['⚠️  NOTA — PAGAMENTOS DE NFs DE ANOS ANTERIORES RECEBIDOS EM MARÇO/2026','','',''], AMBER, WHITE); r++;
ws1.mergeCells(r,1,r,4);
const notaCell = ws1.getRow(r).getCell(1);
notaCell.value =
  `Total recebido de clientes em março/2026 (caixa): R$ ${brl_fmt(sumCaixaReceita)}\n` +
  `NFs emitidas em março/2026 (base tributária): R$ ${brl_fmt(sumNFsBruto)}\n` +
  `Diferença estimada: R$ ${brl_fmt(estimativaAnosAnt)} — Refere-se a pagamentos de NFs emitidas em 2025 e exercícios anteriores,\n` +
  `cujos tributos PIS/COFINS já foram apurados e recolhidos nos respectivos períodos de competência.\n` +
  `Esses valores NÃO integram a base de cálculo de março/2026. Ver detalhes na aba "Créditos Bancários".`;
notaCell.font = {size:9, color:{argb:'FF92400E'}};
notaCell.fill = {type:'pattern', pattern:'solid', fgColor:{argb:LYELLOW}};
notaCell.alignment = {wrapText:true, vertical:'middle'};
notaCell.border = BORDER;
ws1.getRow(r).height = 72;

// ═══════════════════════════════════════════════════════════════
// ABA 2 — NFs EMITIDAS MARÇO/2026
// ═══════════════════════════════════════════════════════════════
const ws2 = wb.addWorksheet('NFs Emitidas Mar-2026');
ws2.columns = [
  {width:14},{width:11},{width:44},{width:30},
  {width:16},{width:16},{width:14},{width:11},
  {width:11},{width:11},{width:11},{width:11},{width:11}
];

hdrRow(ws2, 1, [
  'NF Nº','Emissão','Tomador','Contrato',
  'Valor Bruto','Valor Líquido','Ret. Total',
  'INSS','IRRF','ISS','CSLL','PIS','COFINS'
], BLUE);

nfsMar2026.forEach((n,i) => {
  const row = i+2;
  const bg = i%2===0 ? null : LGRAY;
  setCell(ws2,row,1, n.numero,              null, bg);
  setCell(ws2,row,2, fmtDt(n.data_emissao), null, bg);
  setCell(ws2,row,3, n.tomador,             null, bg);
  setCell(ws2,row,4, n.contrato_ref||'',    null, bg);
  setMoney(ws2,row,5, n.valor_bruto||0,    bg);
  setMoney(ws2,row,6, n.valor_liquido||0,  bg);
  setMoney(ws2,row,7, n.retencao||0,       bg);
  setMoney(ws2,row,8, n.inss||0,           bg);
  setMoney(ws2,row,9, n.ir||0,             bg);
  setMoney(ws2,row,10,n.iss||0,            bg);
  setMoney(ws2,row,11,n.csll||0,           bg);
  setMoney(ws2,row,12,n.pis||0,            bg);
  setMoney(ws2,row,13,n.cofins||0,         bg);
});

// Linha total
const tr2 = nfsMar2026.length + 2;
setCell(ws2,tr2,1,'TOTAL', null, LBLUE, BLUE, true);
setCell(ws2,tr2,2,`${nfsMar2026.length} NFs`, null, LBLUE, BLUE, true);
setCell(ws2,tr2,3,'', null, LBLUE);
setCell(ws2,tr2,4,'', null, LBLUE);
[['valor_bruto',5],['valor_liquido',6],['retencao',7],['inss',8],['ir',9],['iss',10],['csll',11],['pis',12],['cofins',13]]
  .forEach(([field,col]) => setMoney(ws2,tr2,col, nfsMar2026.reduce((s,n)=>s+(n[field]||0),0), LBLUE, BLUE, true));

// ═══════════════════════════════════════════════════════════════
// ABA 3 — CRÉDITOS BANCÁRIOS MARÇO/2026
// ═══════════════════════════════════════════════════════════════
const ws3 = wb.addWorksheet('Créditos Bancários Mar-2026');
ws3.columns = [{width:12},{width:56},{width:18},{width:25},{width:28}];

hdrRow(ws3, 1, ['Data','Histórico Bancário','Valor (R$)','Classificação','Tomador / Observação'], BLUE);

let row3 = 2;

// Receitas
hdrRow(ws3, row3, ['','— RECEITAS DE CLIENTES (tributável) —','','',''], GREEN, WHITE); row3++;
receitas.forEach((c,i) => {
  const bg = i%2===0 ? LGREEN : null;
  setCell(ws3,row3,1, fmtDt(c.data_iso), null, bg);
  setCell(ws3,row3,2, (c.historico||'').slice(0,100), null, bg);
  setMoney(ws3,row3,3, c.credito, bg);
  setCell(ws3,row3,4, 'Receita de cliente', null, LGREEN, GREEN);
  setCell(ws3,row3,5, identificarTomador(c), null, bg);
  row3++;
});
// Subtotal receitas
setCell(ws3,row3,1,'Subtotal Receitas',null,LGREEN,GREEN,true);
setCell(ws3,row3,2,'',null,LGREEN); setMoney(ws3,row3,3,sumCaixaReceita,LGREEN,GREEN,true);
setCell(ws3,row3,4,'',null,LGREEN); setCell(ws3,row3,5,'',null,LGREEN);
row3 += 2;

// Internos
hdrRow(ws3, row3, ['','— TRANSFERÊNCIAS INTERNAS / REPASSES (não tributável) —','','',''], AMBER, WHITE); row3++;
internos.forEach((c,i) => {
  const bg = i%2===0 ? LYELLOW : null;
  setCell(ws3,row3,1, fmtDt(c.data_iso), null, bg);
  setCell(ws3,row3,2, (c.historico||'').slice(0,100), null, bg);
  setMoney(ws3,row3,3, c.credito, bg);
  setCell(ws3,row3,4, 'Interno — não tributável', null, LYELLOW, AMBER, false);
  setCell(ws3,row3,5, 'Repasse entre empresas do grupo Montana', null, bg);
  row3++;
});
const sumInt = internos.reduce((s,c)=>s+c.credito,0);
setCell(ws3,row3,1,'Subtotal Internos',null,LYELLOW,AMBER,true);
setCell(ws3,row3,2,'',null,LYELLOW); setMoney(ws3,row3,3,sumInt,LYELLOW,AMBER,true);
setCell(ws3,row3,4,'',null,LYELLOW); setCell(ws3,row3,5,'',null,LYELLOW);
row3 += 2;

// Investimentos
hdrRow(ws3, row3, ['','— RESGATES DE INVESTIMENTO (não tributável) —','','',''], GRAY, WHITE); row3++;
invest.forEach((c,i) => {
  const bg = LGRAY;
  setCell(ws3,row3,1, fmtDt(c.data_iso), null, bg);
  setCell(ws3,row3,2, (c.historico||'').slice(0,100), null, bg);
  setMoney(ws3,row3,3, c.credito, bg);
  setCell(ws3,row3,4, 'Resgate investimento', null, LGRAY, GRAY, false);
  setCell(ws3,row3,5, 'BB Rende Fácil — não compõe receita', null, bg);
  row3++;
});
const sumInv = invest.reduce((s,c)=>s+c.credito,0);
setCell(ws3,row3,1,'Subtotal Investimentos',null,LGRAY,GRAY,true);
setCell(ws3,row3,2,'',null,LGRAY); setMoney(ws3,row3,3,sumInv,LGRAY,GRAY,true);
setCell(ws3,row3,4,'',null,LGRAY); setCell(ws3,row3,5,'',null,LGRAY);
row3 += 2;

// Totais gerais
hdrRow(ws3, row3, ['TOTAL GERAL — MARÇO/2026','','','',''], BLUE); row3++;
const totalGeral = creditosUnicos.reduce((s,c)=>s+c.credito,0);
setCell(ws3,row3,1,'Total entradas (bruto)',null,LBLUE,BLUE,true);
setCell(ws3,row3,2,'',null,LBLUE); setMoney(ws3,row3,3,totalGeral,LBLUE,BLUE,true);
setCell(ws3,row3,4,'',null,LBLUE); setCell(ws3,row3,5,'',null,LBLUE); row3++;
setCell(ws3,row3,1,'(-) Internos + Investimentos',null,LGRAY,GRAY,false);
setCell(ws3,row3,2,'',null,LGRAY); setMoney(ws3,row3,3,-(sumInt+sumInv),LGRAY,GRAY,false);
setCell(ws3,row3,4,'',null,LGRAY); setCell(ws3,row3,5,'',null,LGRAY); row3++;
setCell(ws3,row3,1,'= Receita de clientes (caixa)',null,LGREEN,GREEN,true);
setCell(ws3,row3,2,'',null,LGREEN); setMoney(ws3,row3,3,sumCaixaReceita,LGREEN,GREEN,true);
setCell(ws3,row3,4,'',null,LGREEN); setCell(ws3,row3,5,'',null,LGREEN); row3++;
setCell(ws3,row3,1,'(-) Pagamentos de NFs de anos anteriores (estimado)',null,LYELLOW,'FF92400E',false);
setCell(ws3,row3,2,'Ver observação abaixo',null,LYELLOW,'FF92400E');
setMoney(ws3,row3,3,-estimativaAnosAnt,LYELLOW,'FF92400E',false);
setCell(ws3,row3,4,'⚠️ Excluir da base PIS/COFINS março',null,LYELLOW,'FF92400E',false);
setCell(ws3,row3,5,'Já apurados em 2025 e anteriores',null,LYELLOW,'FF92400E',false); row3++;
setCell(ws3,row3,1,'= BASE PIS/COFINS — NFs emitidas março/2026',null,LGREEN,GREEN,true);
setCell(ws3,row3,2,'Método competência (correto)',null,LGREEN,GREEN,false);
setMoney(ws3,row3,3,sumNFsBruto,LGREEN,GREEN,true);
setCell(ws3,row3,4,'✅ Base oficial para apuração',null,LGREEN,GREEN,true);
setCell(ws3,row3,5,'PIS a pagar: R$'+brl_fmt(pisLiq)+'  |  COFINS: R$'+brl_fmt(cofinsLiq),null,LGREEN,GREEN,false);

// ── SALVAR ───────────────────────────────────────────────────────
const outPath = path.join(__dirname, '../relatorio_apuracao_pis_cofins_MAR2026.xlsx');
wb.xlsx.writeFile(outPath).then(() => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  ✅ RELATÓRIO GERADO COM SUCESSO                     ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('  Arquivo: relatorio_apuracao_pis_cofins_MAR2026.xlsx');
  console.log('');
  console.log('  RESUMO MARÇO/2026:');
  console.log(`  NFs emitidas:       ${nfsMar2026.length} NFs | R$ ${brl_fmt(sumNFsBruto)}`);
  console.log(`  Retenções totais:   R$ ${brl_fmt(ret.total)}`);
  console.log(`  Receita líquida:    R$ ${brl_fmt(sumNFsLiquido)}`);
  console.log(`  PIS a pagar:        R$ ${brl_fmt(pisLiq)}  (DARF 6912 — venc. 25/04/2026)`);
  console.log(`  COFINS a pagar:     R$ ${brl_fmt(cofinsLiq)}  (DARF 2172 — venc. 25/04/2026)`);
  console.log(`  Caixa recebido:     R$ ${brl_fmt(sumCaixaReceita)}`);
  console.log(`  NFs anos anteriores:R$ ${brl_fmt(estimativaAnosAnt)} (estimado — excluído da base)`);
  console.log('');
  db.close();
}).catch(e => {
  console.error('Erro ao gerar relatório:', e.message);
  db.close();
});
