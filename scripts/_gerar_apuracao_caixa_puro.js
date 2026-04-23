'use strict';
/**
 * Apuração PIS/COFINS — Regime de Caixa PURO
 * Metodologia: apenas NFs com extrato_id linkado a créditos do mês
 * Lei 10.833/2003 art. 10 §2° — contratos com entes públicos
 *
 * Uso:
 *   node scripts/_gerar_apuracao_caixa_puro.js --mes=3 --ano=2026
 *   node scripts/_gerar_apuracao_caixa_puro.js --mes=3 --ano=2026 --empresa=seguranca
 */
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const Database = require('better-sqlite3');
const ExcelJS  = require('exceljs');

const args   = process.argv.slice(2);
const argMap = {};
args.forEach(a => { const [k,v] = a.replace(/^--/,'').split('='); argMap[k]=v; });

const hoje   = new Date();
const MES    = argMap.mes ? parseInt(argMap.mes) : hoje.getMonth();
const ANO    = argMap.ano ? parseInt(argMap.ano) : hoje.getFullYear();
const empArg = (argMap.empresa || 'todas').toLowerCase();

const MES_NOMES = ['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO',
                   'JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];
const MES_ABREV = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];

const EMPRESAS = {
  assessoria: {
    key: 'assessoria', nome: 'Montana Assessoria Empresarial Ltda',
    cnpj: '14.092.519/0001-51',
    db: path.join(__dirname,'..','data','assessoria','montana.db'),
    regime: 'Lucro Real — Não Cumulativo',
    pis_aliq: 0.0165, cofins_aliq: 0.0760,
    darf_pis: '6912', darf_cofins: '5856',
  },
  seguranca: {
    key: 'seguranca', nome: 'Montana Segurança Patrimonial Ltda',
    cnpj: '19.200.109/0001-09',
    db: path.join(__dirname,'..','data','seguranca','montana.db'),
    regime: 'Lucro Real Anual — Cumulativo',
    pis_aliq: 0.0065, cofins_aliq: 0.03,
    darf_pis: '8109', darf_cofins: '2172',
  },
};

const empresasRodar = empArg === 'todas'
  ? Object.values(EMPRESAS)
  : [EMPRESAS[empArg]].filter(Boolean);

// ── Cores / helpers ──────────────────────────────────────────────
const BRL = '#,##0.00';
const BLUE='FF1D4ED8', GRAY='FF475569', GREEN='FF15803D', AMBER='FFD97706', RED='FFB91C1C';
const WHITE='FFFFFFFF', LBLUE='FFDBEAFE', LGREEN='FFF0FDF4', LGRAY='FFF1F5F9';
const LYELLOW='FFFEF9C3', LRED='FFFEE2E2';
const bdr = { style:'thin', color:{argb:'FFE2E8F0'} };
const BORDER = { top:bdr, left:bdr, bottom:bdr, right:bdr };

function fmtDt(d) { return d ? d.slice(8,10)+'/'+d.slice(5,7)+'/'+d.slice(0,4) : ''; }
function brl(v)   { return v != null ? v.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}) : '0,00'; }
const R2 = v => Math.round((v||0)*100)/100;

function cell(ws, row, col, val, numFmt, bg, fg='FF1E293B', bold=false, align='left') {
  const c = ws.getRow(row).getCell(col);
  c.value = val; if (numFmt) c.numFmt = numFmt;
  if (bg) c.fill = {type:'pattern',pattern:'solid',fgColor:{argb:bg}};
  c.font = {size:9,color:{argb:fg},bold};
  c.alignment = {horizontal:align,vertical:'middle',wrapText:true};
  c.border = BORDER;
}
function money(ws,row,col,val,bg,fg='FF1E293B',bold=false) {
  cell(ws,row,col,R2(val),BRL,bg,fg,bold,'right');
}
function hdr(ws,row,cols,bg=BLUE,fg=WHITE) {
  cols.forEach((v,i) => {
    const c = ws.getRow(row).getCell(i+1);
    c.value=v; c.font={bold:true,size:9,color:{argb:fg}};
    c.fill={type:'pattern',pattern:'solid',fgColor:{argb:bg}};
    c.alignment={horizontal:'center',vertical:'middle',wrapText:true};
    c.border=BORDER;
  });
  ws.getRow(row).height = 28;
}

async function gerarEmpresa(emp, wb) {
  const d0 = `${ANO}-${String(MES).padStart(2,'0')}-01`;
  const d1 = `${ANO}-${String(MES).padStart(2,'0')}-${new Date(ANO,MES,0).getDate()}`;
  const COMP = `${MES_NOMES[MES-1]}/${ANO}`;
  const COMP_A = `${MES_ABREV[MES-1]}${ANO}`;
  const mesVenc = MES===12?1:MES+1, anoVenc = MES===12?ANO+1:ANO;
  const dataVenc = `25/${String(mesVenc).padStart(2,'0')}/${anoVenc}`;

  const db = new Database(emp.db);

  // ── NFs com extrato_id → crédito do mês (caixa BB puro) ──────────
  // REGRA: somente NFs EMITIDAS no mês de competência (d0..d1)
  const nfsBBAll = db.prepare(`
    SELECT nf.id, nf.numero, nf.data_emissao, e.data_iso AS data_pagamento,
           nf.tomador, nf.cnpj_tomador, nf.contrato_ref, nf.status_conciliacao,
           nf.valor_bruto, nf.valor_liquido, nf.retencao,
           nf.pis, nf.cofins, nf.inss, nf.ir, nf.iss, nf.csll,
           'BB_EXTRATO' AS fonte
    FROM notas_fiscais nf
    JOIN extratos e ON e.id = nf.extrato_id
    WHERE e.data_iso BETWEEN ? AND ?
      AND e.credito > 0
      AND nf.status_conciliacao NOT IN ('CANCELADA','ASSESSORIA')
    ORDER BY e.data_iso, nf.tomador
  `).all(d0, d1);

  // ── NFs CONCILIADO via Prodata/Portal (sem extrato_id, data_pagamento no mês) ─
  const nfsPortalAll = db.prepare(`
    SELECT nf.id, nf.numero, nf.data_emissao, nf.data_pagamento,
           nf.tomador, nf.cnpj_tomador, nf.contrato_ref, nf.status_conciliacao,
           nf.valor_bruto, nf.valor_liquido, nf.retencao,
           nf.pis, nf.cofins, nf.inss, nf.ir, nf.iss, nf.csll,
           'PRODATA_BRB' AS fonte
    FROM notas_fiscais nf
    WHERE nf.data_pagamento BETWEEN ? AND ?
      AND nf.extrato_id IS NULL
      AND nf.status_conciliacao = 'CONCILIADO'
    ORDER BY nf.data_pagamento, nf.tomador
  `).all(d0, d1);

  // Dedup portal (BB tem prioridade)
  const idsBBAll = new Set(nfsBBAll.map(n => n.id));
  const nfsPortalAllDedup = nfsPortalAll.filter(n => !idsBBAll.has(n.id));
  const todasNFsMes = [...nfsBBAll, ...nfsPortalAllDedup];

  // ── Separar: emitidas em 2026 (base tributável) vs 2025/anteriores (excluídas) ──
  // Regra: 2026 → regime de caixa (inclui jan/fev/mar... emitidas em 2026, pagas em mar/2026)
  //        2025 e antes → regime de competência já apurado → excluir para evitar bitributação
  const anoInicio = `${ANO}-01-01`;
  const isCompetencia = n => n.data_emissao && n.data_emissao >= anoInicio;
  const nfsBB         = nfsBBAll.filter(isCompetencia);
  const nfsPortalDedup = nfsPortalAllDedup.filter(isCompetencia);
  const nfs = [...nfsBB, ...nfsPortalDedup];                    // base tributável
  const nfsOutrasComp = todasNFsMes.filter(n => !isCompetencia(n)); // excluídas (2025/anteriores)

  // ── Extrato créditos do mês ──────────────────────────────────
  const rawCreds = db.prepare(`
    SELECT id, data_iso, historico, credito, status_conciliacao
    FROM extratos WHERE data_iso BETWEEN ? AND ? AND credito > 0
    ORDER BY data_iso, credito DESC
  `).all(d0, d1);

  // Dedup extrato
  const seen = new Set();
  const credsDed = [];
  for (const c of rawCreds) {
    const k = `${c.data_iso}|${c.credito.toFixed(2)}|${(c.historico||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,30)}`;
    if (!seen.has(k)) { seen.add(k); credsDed.push(c); }
  }

  function tipoC(h, st) {
    h = (h||'').toUpperCase(); st = (st||'').toUpperCase();
    if (['INTERNO','TRANSFERENCIA','INVESTIMENTO'].includes(st)) return st;
    if (h.includes('RENDE FACIL')||h.includes('APLICACAO')||h.includes('RESGATE')) return 'INVESTIMENTO';
    if (h.includes('MONTANA S')||h.includes('MONTANA SERV')||h.includes('MONTANA SEG')||h.includes('MONTANA ASSES')) return 'INTERNO';
    return 'RECEITA';
  }
  const receitas = credsDed.filter(c => tipoC(c.historico, c.status_conciliacao) === 'RECEITA');
  const invest   = credsDed.filter(c => tipoC(c.historico, c.status_conciliacao) === 'INVESTIMENTO');
  const internos = credsDed.filter(c => tipoC(c.historico, c.status_conciliacao) === 'INTERNO');

  const sumRec = receitas.reduce((s,c)=>s+c.credito,0);
  const sumInv = invest.reduce((s,c)=>s+c.credito,0);
  const sumInt = internos.reduce((s,c)=>s+c.credito,0);
  const totalEnt = credsDed.reduce((s,c)=>s+c.credito,0);

  // ── Totalizações NFs ─────────────────────────────────────────
  const totNF = nfs.reduce((a,n) => {
    a.bruto+=n.valor_bruto||0; a.liq+=n.valor_liquido||0;
    a.pis+=n.pis||0; a.cofins+=n.cofins||0; a.inss+=n.inss||0;
    a.ir+=n.ir||0; a.iss+=n.iss||0; a.csll+=n.csll||0; a.ret+=n.retencao||0;
    return a;
  }, {bruto:0,liq:0,pis:0,cofins:0,inss:0,ir:0,iss:0,csll:0,ret:0});

  const pisBruto    = R2(totNF.bruto * emp.pis_aliq);
  const cofBruto    = R2(totNF.bruto * emp.cofins_aliq);
  const pisLiq      = Math.max(R2(pisBruto  - totNF.pis),   0);
  const cofLiq      = Math.max(R2(cofBruto  - totNF.cofins), 0);
  const totalDARF   = R2(pisLiq + cofLiq);
  const semNF       = R2(Math.max(sumRec - totNF.liq, 0));

  // ── Por contrato ─────────────────────────────────────────────
  const porContrato = {};
  for (const n of nfs) {
    const k = n.contrato_ref || 'Sem contrato';
    if (!porContrato[k]) porContrato[k]={n:0,bruto:0,liq:0,ret:0,pis:0,cofins:0,inss:0,ir:0,iss:0,csll:0};
    const g=porContrato[k]; g.n++; g.bruto+=n.valor_bruto||0; g.liq+=n.valor_liquido||0;
    g.ret+=n.retencao||0; g.pis+=n.pis||0; g.cofins+=n.cofins||0;
    g.inss+=n.inss||0; g.ir+=n.ir||0; g.iss+=n.iss||0; g.csll+=n.csll||0;
  }

  const totOC = nfsOutrasComp.reduce((a,n)=>{ a.c++; a.s+=n.valor_bruto||0; return a; },{c:0,s:0});
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${emp.nome}`);
  console.log(`  ${COMP} — Apuração Regime de Caixa (emissão = competência)`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  NFs emitidas em ${COMP} (base):`)
  console.log(`    BB extrato             : ${nfsBB.length} NFs`);
  console.log(`    Prodata/BRB confirmado : ${nfsPortalDedup.length} NFs`);
  console.log(`    TOTAL BASE             : ${nfs.length} NFs`);
  console.log(`  NFs outras competências (EXCLUÍDAS): ${totOC.c} NFs | R$ ${brl(totOC.s)}`);
  console.log(`  Base tributária (NF bruto)  : R$ ${brl(totNF.bruto)}`);
  console.log(`  PIS a pagar (DARF ${emp.darf_pis})   : R$ ${brl(pisLiq)}`);
  console.log(`  COFINS a pagar (DARF ${emp.darf_cofins}) : R$ ${brl(cofLiq)}`);
  console.log(`  TOTAL DARF venc. ${dataVenc}   : R$ ${brl(totalDARF)}`);
  if (semNF > 500) console.log(`  ⚠️  R$ ${brl(semNF)} em créditos sem NF linkada`);

  // ══════════ WORKBOOK ═════════════════════════════════════════
  const shNome = emp.key === 'assessoria' ? 'Assessoria' : 'Segurança';

  // ── ABA 1 — RESUMO ──────────────────────────────────────────
  const ws1 = wb.addWorksheet(`Resumo ${shNome}`);
  ws1.columns = [{width:52},{width:18},{width:18},{width:18}];
  let r = 1;

  ws1.mergeCells(r,1,r,4);
  const t=ws1.getRow(r).getCell(1);
  t.value='APURAÇÃO PIS/COFINS — REGIME DE CAIXA'; t.font={bold:true,size:13,color:{argb:WHITE}};
  t.fill={type:'pattern',pattern:'solid',fgColor:{argb:BLUE}};
  t.alignment={horizontal:'center',vertical:'middle'}; ws1.getRow(r).height=36; r++;

  ws1.mergeCells(r,1,r,4);
  const s=ws1.getRow(r).getCell(1);
  s.value=`${emp.nome}  —  CNPJ ${emp.cnpj}  |  Competência: ${COMP}`;
  s.font={size:10,color:{argb:GRAY}}; s.alignment={horizontal:'center'}; ws1.getRow(r).height=20; r++;

  ws1.mergeCells(r,1,r,4);
  const rg=ws1.getRow(r).getCell(1);
  rg.value=`${emp.regime}  |  PIS ${(emp.pis_aliq*100).toFixed(2).replace('.',',')}% DARF ${emp.darf_pis} + COFINS ${(emp.cofins_aliq*100).toFixed(2).replace('.',',')}% DARF ${emp.darf_cofins}  |  Lei 10.833/2003 art. 10 §2°`;
  rg.font={size:9,italic:true,color:{argb:GRAY}}; rg.alignment={horizontal:'center'}; ws1.getRow(r).height=18; r+=2;

  // Nota metodológica
  ws1.mergeCells(r,1,r,4);
  const nota=ws1.getRow(r).getCell(1);
  nota.value=`📌  METODOLOGIA: Regime de Caixa a partir de ${ANO}. Base tributável = NFs EMITIDAS em ${ANO} com pagamento recebido em ${COMP} (inclui jan/fev/mar-${ANO}). NFs de ${ANO-1} e anteriores são EXCLUÍDAS (aba "Outras Comp.") pois já foram apuradas por regime de competência — incluí-las geraria bitributação. Fontes: BB Extrato (extrato_id) + Prodata/BRB (portal municipal Palmas).`;
  nota.font={size:9,color:{argb:'FF1E3A5F'}};
  nota.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFE0F0FF'}};
  nota.alignment={wrapText:true,vertical:'middle'}; nota.border=BORDER;
  ws1.getRow(r).height=48; r+=2;

  // Extrato resumo
  hdr(ws1,r,['EXTRATO BB — ENTRADAS MARÇO/2026','','Valor (R$)',''],GRAY,WHITE); r++;
  const extSumData = [
    ['Total entradas bancárias (BB)',   totalEnt, null, GRAY,  false],
    ['(-) Resgates / Investimentos',  -sumInv,   null, GRAY,  false],
    ['(-) Transferências internas',   -sumInt,   null, GRAY,  false],
    ['= Receita de clientes (BB)',      sumRec,   LGREEN, GREEN, true],
  ];
  for (const [label,val,bg,fc,bold] of extSumData) {
    cell(ws1,r,1,label,null,bg,fc,bold);
    cell(ws1,r,2,'',null,bg); money(ws1,r,3,val,bg,fc,bold); cell(ws1,r,4,'',null,bg); r++;
  }
  r++;

  // NFs por contrato
  hdr(ws1,r,['NFs RECEBIDAS (BB + Prodata) — BASE TRIBUTÁRIA','NFs','Valor Bruto (R$)','Retenções (R$)'],BLUE); r++;
  Object.entries(porContrato).sort((a,b)=>b[1].bruto-a[1].bruto).forEach(([k,v]) => {
    cell(ws1,r,1,`  ${k}`); cell(ws1,r,2,`${v.n}`,null,null,GRAY,false,'center');
    money(ws1,r,3,v.bruto); money(ws1,r,4,v.ret); r++;
  });
  cell(ws1,r,1,'BASE TRIBUTÁRIA TOTAL',null,LBLUE,BLUE,true);
  cell(ws1,r,2,`${nfs.length}`,null,LBLUE,BLUE,true,'center');
  money(ws1,r,3,totNF.bruto,LBLUE,BLUE,true);
  money(ws1,r,4,totNF.ret,LBLUE,BLUE,true); r+=2;

  if (semNF > 500) {
    ws1.mergeCells(r,1,r,4);
    const w=ws1.getRow(r).getCell(1);
    w.value=`⚠️  R$ ${brl(semNF)} em créditos bancários de clientes SEM NF linkada — verifique se há NFs não importadas (ex: Palmas OBs agrupadas). Se tributável, este valor deve ser acrescido à base.`;
    w.font={size:9,color:{argb:'FF92400E'}}; w.fill={type:'pattern',pattern:'solid',fgColor:{argb:LYELLOW}};
    w.alignment={wrapText:true,vertical:'middle'}; w.border=BORDER; ws1.getRow(r).height=40; r+=2;
  }

  // Apuração
  hdr(ws1,r,['APURAÇÃO',`PIS ${(emp.pis_aliq*100).toFixed(2).replace('.',',')}% (R$)`,`COFINS ${(emp.cofins_aliq*100).toFixed(2).replace('.',',')}% (R$)`,'Total (R$)'],GREEN,WHITE); r++;
  const apRows = [
    [`Base — NFs recebidas em ${COMP}`,totNF.bruto,totNF.bruto,totNF.bruto,null,GRAY],
    ['(×) Alíquota',pisBruto,cofBruto,R2(pisBruto+cofBruto),null,GRAY],
    ['(-) Retenções sofridas na fonte',-totNF.pis,-totNF.cofins,-R2(totNF.pis+totNF.cofins),null,GRAY],
    [`(=) A RECOLHER — DARF venc. ${dataVenc}`,pisLiq,cofLiq,totalDARF,LGREEN,GREEN],
  ];
  for (const [desc,p,c,tot,bg,fc] of apRows) {
    const bold = bg===LGREEN;
    cell(ws1,r,1,'  '+desc,null,bg,fc,bold);
    money(ws1,r,2,p,bg,fc,bold); money(ws1,r,3,c,bg,fc,bold); money(ws1,r,4,tot,bg,fc,bold); r++;
  }
  cell(ws1,r,1,`  DARF: PIS cód. ${emp.darf_pis}  |  COFINS cód. ${emp.darf_cofins}  |  Vencimento: ${dataVenc}`,null,LGREEN,GREEN,true);
  [2,3,4].forEach(c2=>cell(ws1,r,c2,'',null,LGREEN)); r+=2;

  // Retenções sofridas
  hdr(ws1,r,['RETENÇÕES SOFRIDAS NA FONTE (informativo)','Alíquota','Valor (R$)','Observação'],GRAY,WHITE); r++;
  const retRows = [
    ['INSS — Previdência Social','Variável',totNF.inss,'Retido pelo tomador de serviço'],
    ['IRRF — Imposto de Renda Retido','1,20% (vigil.) / 1,50% (outros)',totNF.ir,'DARF 6147 / 6190'],
    ['ISS — Imp. sobre Serviços','Variável por município',totNF.iss,'Palmas: 5% (vigilância), 2% (limpeza)'],
    ['CSLL — Contrib. Social','1,00%',totNF.csll,'Tomadores federais (IN RFB 1.234/2012)'],
    ['PIS retido na fonte (crédito)','0,65%',totNF.pis,'Tomadores federais — deduzido acima'],
    ['COFINS retida na fonte (crédito)','3,00%',totNF.cofins,'Tomadores federais — deduzido acima'],
  ];
  for (const [desc,aliq,val,obs] of retRows) {
    cell(ws1,r,1,'  '+desc); cell(ws1,r,2,aliq,null,null,GRAY);
    money(ws1,r,3,val); cell(ws1,r,4,obs,null,null,GRAY); r++;
  }
  cell(ws1,r,1,'TOTAL RETENÇÕES SOFRIDAS',null,LGRAY,GRAY,true);
  cell(ws1,r,2,'',null,LGRAY); money(ws1,r,3,totNF.ret,LGRAY,GRAY,true); cell(ws1,r,4,'',null,LGRAY);

  // ── ABA 2 — NFs detalhadas ────────────────────────────────────
  const ws2 = wb.addWorksheet(`NFs ${COMP_A} ${shNome}`);
  ws2.columns = [{width:8},{width:14},{width:11},{width:11},{width:38},{width:24},{width:14},{width:14},{width:12},{width:10},{width:10},{width:10},{width:10},{width:10},{width:10},{width:13}];
  hdr(ws2,1,['#','NF Nº','Emissão','Pgto/Caixa','Tomador','Contrato','V. Bruto','V. Líquido','Ret. Total','INSS','IRRF','ISS','CSLL','PIS','COFINS','Fonte'],BLUE);
  nfs.forEach((n,i) => {
    const rw=i+2;
    const isBB = n.fonte === 'BB_EXTRATO';
    const bg = isBB ? (i%2===0?null:LGRAY) : (i%2===0?LYELLOW:LRED);
    cell(ws2,rw,1,i+1,null,bg,GRAY,false,'center');
    cell(ws2,rw,2,n.numero,null,bg); cell(ws2,rw,3,fmtDt(n.data_emissao),null,bg);
    cell(ws2,rw,4,fmtDt(n.data_pagamento),null,bg); cell(ws2,rw,5,n.tomador,null,bg);
    cell(ws2,rw,6,n.contrato_ref||'',null,bg);
    money(ws2,rw,7,n.valor_bruto,bg); money(ws2,rw,8,n.valor_liquido,bg);
    money(ws2,rw,9,n.retencao,bg); money(ws2,rw,10,n.inss,bg); money(ws2,rw,11,n.ir,bg);
    money(ws2,rw,12,n.iss,bg); money(ws2,rw,13,n.csll,bg);
    money(ws2,rw,14,n.pis,bg); money(ws2,rw,15,n.cofins,bg);
    cell(ws2,rw,16,isBB?'BB Extrato':'Prodata/BRB',null,isBB?LGREEN:LYELLOW,isBB?GREEN:AMBER,true,'center');
  });
  const tr=nfs.length+2;
  cell(ws2,tr,1,'',null,LBLUE); cell(ws2,tr,2,'TOTAL',null,LBLUE,BLUE,true);
  cell(ws2,tr,3,`${nfs.length} NFs (${nfsBB.length} BB + ${nfsPortalDedup.length} Prodata)`,null,LBLUE,BLUE,true);
  [3,4,5].forEach(c2=>cell(ws2,tr,c2+1,'',null,LBLUE));
  [[7,'valor_bruto'],[8,'valor_liquido'],[9,'retencao'],[10,'inss'],[11,'ir'],[12,'iss'],[13,'csll'],[14,'pis'],[15,'cofins']]
    .forEach(([col,f]) => money(ws2,tr,col,nfs.reduce((s,n)=>s+(n[f]||0),0),LBLUE,BLUE,true));

  // ── ABA 3 — Extrato créditos ──────────────────────────────────
  const ws3 = wb.addWorksheet(`Extrato ${COMP_A} ${shNome}`);
  ws3.columns = [{width:11},{width:55},{width:16},{width:20}];
  hdr(ws3,1,['Data','Histórico Bancário','Valor BB (R$)','Classificação'],BLUE);
  let rr=2;
  for (const sec of [
    {list:receitas, label:'RECEITAS DE CLIENTES', bg:LGREEN, fg:GREEN},
    {list:invest,   label:'RESGATES/INVESTIMENTOS (não tributável)', bg:LGRAY, fg:GRAY},
    {list:internos, label:'TRANSFERÊNCIAS INTERNAS (não tributável)', bg:LYELLOW, fg:AMBER},
  ]) {
    ws3.mergeCells(rr,1,rr,4);
    const h=ws3.getRow(rr).getCell(1);
    h.value=`— ${sec.label} —`; h.font={bold:true,size:9,color:{argb:WHITE}};
    h.fill={type:'pattern',pattern:'solid',fgColor:{argb:sec.fg}}; h.alignment={horizontal:'center'}; rr++;
    for (const c of sec.list) {
      cell(ws3,rr,1,fmtDt(c.data_iso),null,sec.bg);
      cell(ws3,rr,2,(c.historico||'').slice(0,100),null,sec.bg);
      money(ws3,rr,3,c.credito,sec.bg); cell(ws3,rr,4,sec.label.split(' ')[0],null,sec.bg,sec.fg); rr++;
    }
    rr++;
  }
  // Totais
  hdr(ws3,rr,['CONCILIAÇÃO','','R$',''],BLUE); rr++;
  for (const [label,val,bg,fc,bold] of [
    ['Total entradas BB',totalEnt,LBLUE,BLUE,true],
    ['(-) Invest./Resgates',-sumInv,LGRAY,GRAY,false],
    ['(-) Internos',-sumInt,LYELLOW,AMBER,false],
    ['= Receita de clientes BB',sumRec,LGREEN,GREEN,true],
    ['NFs linkadas (caixa puro)',totNF.liq,LGREEN,GREEN,false],
    ['Créditos sem NF linkada',R2(Math.max(sumRec-totNF.liq,0)),semNF>500?LYELLOW:LGRAY,semNF>500?AMBER:GRAY,false],
  ]) {
    cell(ws3,rr,1,label,null,bg,fc,bold); cell(ws3,rr,2,'',null,bg);
    money(ws3,rr,3,val,bg,fc,bold); cell(ws3,rr,4,'',null,bg); rr++;
  }

  // ── ABA 4 — NFs de outras competências (excluídas) ─────────────
  if (nfsOutrasComp.length > 0) {
    const ws4 = wb.addWorksheet(`Outras Comp. ${COMP_A} ${shNome}`);
    ws4.columns = [{width:8},{width:14},{width:11},{width:11},{width:38},{width:24},{width:14},{width:14},{width:13},{width:13}];
    // Header com aviso
    ws4.mergeCells(1,1,1,10);
    const warn = ws4.getRow(1).getCell(1);
    warn.value = `⚠️  NFs EXCLUÍDAS DA BASE TRIBUTÁRIA — emitidas em competências anteriores a ${COMP} (2025 ou meses anteriores de 2026), pagas em ${COMP}. Não entram no PIS/COFINS deste mês.`;
    warn.font = {bold:true, size:9, color:{argb:'FF92400E'}};
    warn.fill = {type:'pattern',pattern:'solid',fgColor:{argb:LYELLOW}};
    warn.alignment = {wrapText:true,vertical:'middle'}; warn.border = BORDER;
    ws4.getRow(1).height = 32;
    hdr(ws4,2,['#','NF Nº','Emissão','Pgto/Caixa','Tomador','Contrato','V. Bruto','V. Líquido','Fonte','Motivo Exclusão'],AMBER,'FF1C1917');
    nfsOutrasComp.forEach((n,i) => {
      const rw = i+3;
      const emAno = n.data_emissao ? n.data_emissao.substring(0,4) : '?';
      const emMes = n.data_emissao ? n.data_emissao.substring(5,7) : '?';
      const motivo = n.data_emissao
        ? (emAno < String(ANO) ? `NF de ${emAno} — tributada em ${emAno}` : `NF emitida em ${emMes}/${emAno} — outra competência`)
        : 'Data de emissão não identificada';
      const tNome = n.tomador || 'Tomador não identificado';
      const bg = i%2===0 ? LYELLOW : 'FFFEF3C7';
      cell(ws4,rw,1,i+1,null,bg,AMBER,false,'center');
      cell(ws4,rw,2,n.numero||'Não identificado',null,bg);
      cell(ws4,rw,3,n.data_emissao?fmtDt(n.data_emissao):'Não identificada',null,bg);
      cell(ws4,rw,4,fmtDt(n.data_pagamento),null,bg);
      cell(ws4,rw,5,tNome,null,bg);
      cell(ws4,rw,6,n.contrato_ref||'',null,bg);
      money(ws4,rw,7,n.valor_bruto,bg,AMBER); money(ws4,rw,8,n.valor_liquido,bg,AMBER);
      cell(ws4,rw,9,n.fonte==='BB_EXTRATO'?'BB Extrato':'Prodata/BRB',null,bg,AMBER);
      cell(ws4,rw,10,motivo,null,bg,AMBER);
    });
    const trocOC = nfsOutrasComp.length+3;
    cell(ws4,trocOC,1,'',null,LRED); cell(ws4,trocOC,2,'TOTAL EXCLUÍDO',null,LRED,RED,true);
    cell(ws4,trocOC,3,`${nfsOutrasComp.length} NFs`,null,LRED,RED,true);
    [4,5,6].forEach(c2=>cell(ws4,trocOC,c2,'',null,LRED));
    money(ws4,trocOC,7,nfsOutrasComp.reduce((s,n)=>s+(n.valor_bruto||0),0),LRED,RED,true);
    money(ws4,trocOC,8,nfsOutrasComp.reduce((s,n)=>s+(n.valor_liquido||0),0),LRED,RED,true);
  }

  db.close();
  return { empresa: emp.key, nfs: nfs.length, nfsExcl: nfsOutrasComp.length, bruto: totNF.bruto, pisLiq, cofLiq, totalDARF, semNF };
}

(async () => {
  const COMP_A = `${MES_ABREV[MES-1]}${ANO}`;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Montana ERP — Apuração Caixa Puro'; wb.created = new Date();

  const resultados = [];
  for (const emp of empresasRodar) {
    try {
      const r = await gerarEmpresa(emp, wb);
      resultados.push(r);
    } catch(e) {
      console.error(`Erro em ${emp.key}:`, e.message, e.stack);
    }
  }

  const outName = `Apuracao_PISCOFINS_${empArg==='todas'?'GRUPO':empArg.toUpperCase()}_${COMP_A}_CAIXA_PURO.xlsx`;
  const outPath = path.join(__dirname,'..', outName);
  await wb.xlsx.writeFile(outPath);
  console.log(`\n  ✅ Salvo: ${outName}`);
  try {
    fs.copyFileSync(outPath, path.join(os.homedir(),'Downloads',outName));
    console.log(`  📁 Copiado para Downloads\\${outName}`);
  } catch(e) { console.log(`  ⚠️  Cópia Downloads: ${e.code}`); }

  // Sumário consolidado
  const MES_NOMES2 = ['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO','JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];
  console.log(`\n${'═'.repeat(65)}`);
  console.log(`  SUMÁRIO — ${MES_NOMES2[MES-1]}/${ANO}`);
  console.log(`${'═'.repeat(65)}`);
  let totBase=0, totPIS=0, totCOF=0, totDARF=0;
  for (const r of resultados) {
    console.log(`  ${r.empresa.padEnd(14)} | ${String(r.nfs).padStart(3)} NFs (${r.nfsExcl} excl.) | Base: R$ ${r.bruto.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(16)} | PIS: R$ ${r.pisLiq.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(12)} | COFINS: R$ ${r.cofLiq.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(12)}`);
    totBase+=r.bruto; totPIS+=r.pisLiq; totCOF+=r.cofLiq; totDARF+=r.totalDARF;
  }
  if (resultados.length>1) {
    console.log(`  ${'GRUPO'.padEnd(14)} |         | Base: R$ ${totBase.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(16)} | PIS: R$ ${totPIS.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(12)} | COFINS: R$ ${totCOF.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(12)}`);
  }
  console.log(`  TOTAL DARF GRUPO: R$ ${totDARF.toLocaleString('pt-BR',{minimumFractionDigits:2})}`);
  const mesV=MES===12?1:MES+1, anoV=MES===12?ANO+1:ANO;
  console.log(`  Vencimento: 25/${String(mesV).padStart(2,'0')}/${anoV}`);
})();
