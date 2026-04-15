'use strict';
/**
 * Relatório para Receita Federal — NFs Pagas por Competência
 * Identifica nota por nota qual mês de serviço cada recebimento representa.
 *
 * Uso:
 *   node scripts/gerar_relatorio_receita_federal.js [--mes=03] [--ano=2026] [--empresa=assessoria|seguranca|todas]
 *
 * Saída (arquivos separados por empresa):
 *   relatorios/receita_federal_assessoria_<ano>-<mes>.xlsx
 *   relatorios/receita_federal_seguranca_<ano>-<mes>.xlsx
 *
 * Abas por arquivo:
 *   1. Resumo          — sumário executivo + totais por competência
 *   2. NFs Pagas       — nota a nota, ordenado por contrato → competência
 *   3. Apuração Fiscal — PIS/COFINS calculados (Assessoria: Lucro Real não-cumulativo 1,65%+7,60% | Segurança: Lucro Real PIS/COFINS cumulativo 0,65%+3%)
 *   4. Créditos sem NF — créditos bancários não vinculados a NF (categorizados)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path    = require('path');
const fs      = require('fs');
const ExcelJS = require('exceljs');
const { getDb } = require('../src/db');

// ── Parâmetros ─────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k,v] = a.slice(2).split('='); return [k, v||true]; })
);
// Default: mês anterior (ex: rodando em abril/2026 → gera março/2026)
const _hoje    = new Date();
const _mesAnt  = new Date(_hoje.getFullYear(), _hoje.getMonth() - 1, 1);
const MES_ARG  = String(args.mes || (_mesAnt.getMonth() + 1)).padStart(2, '0');
const ANO_ARG  = String(args.ano || _mesAnt.getFullYear());
const EMPRESA_ARG = args.empresa || 'todas';
const MES_LABEL   = `${ANO_ARG}-${MES_ARG}`;
const DATA_INI    = `${ANO_ARG}-${MES_ARG}-01`;
const DATA_FIM    = `${ANO_ARG}-${MES_ARG}-31`;

console.log(`\n  📑 Relatório Receita Federal — recebimentos ${MES_LABEL}`);

// ── Configuração de empresas ───────────────────────────────────────────────────
// regime: 'Lucro Real' | 'Lucro Presumido' | 'Simples Nacional'
// pisCofinsRegime: 'não-cumulativo' (créditos sobre insumos) | 'cumulativo' (sem créditos)
const CONFIG_EMPRESAS = {
  assessoria: { regime: 'Lucro Real', pisCofinsRegime: 'não-cumulativo', pisPct: 0.0165, cofinsPct: 0.0760, label: 'Montana Assessoria Empresarial Ltda' },
  seguranca:  { regime: 'Lucro Real', pisCofinsRegime: 'cumulativo',     pisPct: 0.0065, cofinsPct: 0.0300, label: 'Montana Segurança e Vigilância Ltda' },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const R    = v  => Number(v || 0);
const fmtD = iso => iso ? iso.replace(/(\d{4})-(\d{2})-(\d{2})/, '$3/$2/$1') : '';
const fmtR = v  => R(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num  = v  => R(v);   // valor numérico puro para células ExcelJS

function anoCompetencia(comp) {
  if (!comp) return '';
  const m = comp.match(/(\d{4})/);
  return m ? m[1] : '';
}

// ── Matching: keyword de contrato para batch TEDs ─────────────────────────────
const KWS = ['DETRAN','UNITINS','SESAU','SEDUC','UFT','UFNT','TCE','SEMARH',
             'CBMTO','FUNJURIS','TJ','PREFEITURA','PREVI','MUNICIPIO','MINISTERIO'];

// Mapeamento CNPJ (parcial) → keyword — para extratos cujo histórico traz o CNPJ do pagador
// mas não o nome do contrato (ex: "GOVERNO DO ESTADO 01786029" → SEDUC)
const CNPJ_KW = {
  '01786029': 'SEDUC',      // Estado do Tocantins (paga SEDUC e SEINF)
  '01786078': 'MINISTERIO', // MP/TO
  '01786011': 'SEDUC',      // SEINF Tocantins — tratar como SEDUC para match
  '24851511': 'MUNICIPIO',  // Município de Palmas (vários estabelecimentos)
  '05149726': 'UFT',        // Fundação UFT
  '25053083': 'SEDUC',      // Secretaria da Educação Tocantins
};

function kwContrato(s) {
  const up = (s||'').toUpperCase();
  // 1. Verifica CNPJ no texto (ex: histórico do extrato bancário)
  for (const [cnpj, kw] of Object.entries(CNPJ_KW)) {
    if (up.includes(cnpj)) return kw;
  }
  // 2. Verifica keyword textual no contrato_ref, tomador ou historico
  return KWS.find(kw => up.includes(kw)) || '';
}

// ── Categorização de créditos sem NF ─────────────────────────────────────────
function categorizarCredito(e) {
  const h = (e.historico||'').toUpperCase();
  const c = (e.contrato_vinculado||'').toUpperCase();
  if (c.includes('CONTA VINCULADA') || c.includes('VINCULADA'))
    return '🔒 CONTA VINCULADA — escrow (não tributável)';
  if (h.includes('RESGATE') && (h.includes('GARANTIA') || h.includes('DEP')))
    return '🔒 RESGATE DEPÓSITO GARANTIA — devolução de caução (não tributável)';
  if (h.includes('MONTANA') || h.includes('TRANSFERÊNCIA INTERNA') || h.includes('0151'))
    return '🔄 TRANSFERÊNCIA INTERNA — entre contas Montana (não tributável)';
  if (h.includes('BACEN') || h.includes('JUDICIAL') || h.includes('DESBL'))
    return '⚖️  DESBLOQUEIO JUDICIAL — verificar NF correspondente';
  return '⚠️  VERIFICAR — possível NF não importada ou pagamento sem NF emitida';
}

// ── Core: NFs pagas no mês ────────────────────────────────────────────────────
function nfsPagasNoMes(db, dataIni, dataFim) {
  // Extratos CONCILIADOS no mês
  // Deduplicação: remove re-importações do MESMO lançamento (mesmo valor+data+histórico prefix),
  // mas PRESERVA múltiplos pagamentos legítimos de mesmo valor no mesmo dia (ex: SEDUC pagando
  // várias unidades escolares). Critério: agrupa por (data, credito, primeiros 30 chars do histórico).
  const extRaw = db.prepare(`
    SELECT id, data_iso, credito, historico, contrato_vinculado
    FROM extratos
    WHERE status_conciliacao = 'CONCILIADO' AND credito > 0
      AND data_iso >= ? AND data_iso <= ?
    ORDER BY data_iso, (contrato_vinculado <> '') DESC
  `).all(dataIni, dataFim);

  const extDedup = new Map();
  for (const e of extRaw) {
    // Chave inclui os primeiros 30 chars do histórico para distinguir transações distintas
    const histPfx = (e.historico||'').substring(0,30).replace(/\s+/g,' ').trim();
    const k = `${e.data_iso}|${R(e.credito).toFixed(2)}|${histPfx}`;
    if (!extDedup.has(k) || (!extDedup.get(k).contrato_vinculado && e.contrato_vinculado))
      extDedup.set(k, e);
  }
  const extMes = [...extDedup.values()].sort((a,b) => new Date(a.data_iso)-new Date(b.data_iso));

  // NFs CONCILIADAS — janela de 9 meses para trás
  const jIni = new Date(dataFim); jIni.setMonth(jIni.getMonth()-9);
  const jIniS = jIni.toISOString().substring(0,10);

  const nfsConcil = db.prepare(`
    SELECT id, numero, tomador, cnpj_tomador, competencia, data_emissao,
           valor_bruto, valor_liquido, inss, ir, iss, csll, pis, cofins, retencao,
           contrato_ref, discriminacao
    FROM notas_fiscais
    WHERE status_conciliacao='CONCILIADO' AND data_emissao >= ?
    ORDER BY contrato_ref, competencia, data_emissao
  `).all(jIniS);

  const pareados  = [];
  const usadosExt = new Set();
  const usadosNf  = new Set();

  // Etapa 1: valor exato (Pix individuais)
  const extPorValor = new Map();
  for (const e of extMes) {
    const k = R(e.credito).toFixed(2);
    if (!extPorValor.has(k)) extPorValor.set(k, []);
    extPorValor.get(k).push(e);
  }
  for (const nf of nfsConcil) {
    const vliq  = R(nf.valor_liquido || nf.valor_bruto);
    const cands = (extPorValor.get(vliq.toFixed(2))||[]).filter(e=>!usadosExt.has(e.id));
    if (!cands.length) continue;
    const emMs = nf.data_emissao ? new Date(nf.data_emissao).getTime() : 0;
    let melhor = cands[0], dMin = Infinity;
    for (const e of cands) { const d=Math.abs(new Date(e.data_iso).getTime()-emMs); if(d<dMin){melhor=e;dMin=d;} }
    usadosExt.add(melhor.id); usadosNf.add(nf.id);
    pareados.push({ nf, extrato: melhor, tipo: 'Pix/OB individual' });
  }

  // Etapa 2: TEDs em lote — keyword contrato + janela ±90d/-30d
  const semNf = [];
  for (const ext of extMes.filter(e=>!usadosExt.has(e.id))) {
    const kwExt = kwContrato(ext.contrato_vinculado) || kwContrato(ext.historico);
    if (!kwExt) { semNf.push(ext); continue; }
    const extDt = new Date(ext.data_iso);
    const dtMin = new Date(extDt); dtMin.setDate(dtMin.getDate()-90);
    const dtMax = new Date(extDt); dtMax.setDate(dtMax.getDate()+30);
    const dtMinS = dtMin.toISOString().substring(0,10);
    const dtMaxS = dtMax.toISOString().substring(0,10);
    const nfsMatch = nfsConcil.filter(nf => {
      if (usadosNf.has(nf.id)) return false;
      if (nf.data_emissao < dtMinS || nf.data_emissao > dtMaxS) return false;
      // Keyword da NF: prefere contrato_ref, usa tomador como fallback (ex: Segurança sem contrato_ref)
      const kwNf = kwContrato(nf.contrato_ref) || kwContrato(nf.tomador);
      return kwNf === kwExt;
    });
    if (!nfsMatch.length) { semNf.push(ext); continue; }
    for (const nf of nfsMatch) {
      usadosNf.add(nf.id);
      pareados.push({ nf, extrato: ext, tipo: 'TED/OB em lote' });
    }
    usadosExt.add(ext.id);
  }
  return { pareados, extSemNf: semNf };
}

// ── Monta dados de uma empresa ────────────────────────────────────────────────
function buildEmpresaData(nomeEmpresa, cfg) {
  let db;
  try { db = getDb(nomeEmpresa); } catch(_){ return null; }
  const { pareados, extSemNf } = nfsPagasNoMes(db, DATA_INI, DATA_FIM);

  const rows = pareados.map(({ nf, extrato, tipo }) => {
    // Competência: mês do serviço — usado em Contratos para controle de adimplência
    const compFinal  = nf.competencia || (nf.data_emissao ? nf.data_emissao.substring(0,7) : '');
    // Para efeito FISCAL: o que define "já tributado" é o ANO DA EMISSÃO da NF
    // (não a competência do serviço). NF emitida em 2025 → imposto de 2025.
    const anoEmissao = nf.data_emissao ? nf.data_emissao.substring(0, 4) : '';
    const jaTribt    = anoEmissao !== '' && anoEmissao < ANO_ARG;
    const vbruto     = num(nf.valor_bruto);
    const vliq       = num(nf.valor_liquido || nf.valor_bruto);
    const retTotal   = num(nf.retencao) || (num(nf.ir)+num(nf.csll)+num(nf.pis)+num(nf.cofins)+num(nf.inss)+num(nf.iss));
    const pisProprio = vliq * cfg.pisPct;
    const cofinsProp = vliq * cfg.cofinsPct;
    const pisLiq     = Math.max(0, pisProprio  - num(nf.pis));
    const cofinsLiq  = Math.max(0, cofinsProp - num(nf.cofins));
    return {
      contrato_ref: nf.contrato_ref || '(sem contrato)',
      nf_num:       nf.numero || '',
      tomador:      nf.tomador || '',
      cnpj_tomador: nf.cnpj_tomador || '',
      competencia:  compFinal,          // mês do serviço — controle adimplência
      ano_emissao:  anoEmissao,         // ano fiscal da NF
      ja_tributado: jaTribt ? 'SIM' : 'NÃO',
      data_emissao: fmtD(nf.data_emissao),
      data_pagto:   fmtD(extrato.data_iso),
      tipo_match:   tipo,
      vbruto, vliq, viss: num(nf.iss), vir: num(nf.ir), vcsll: num(nf.csll),
      vpis_ret: num(nf.pis), vcofins_ret: num(nf.cofins), vinss: num(nf.inss),
      ret_total: retTotal,
      pis_proprio: pisProprio, cofins_prop: cofinsProp,
      pis_liq: pisLiq, cofins_liq: cofinsLiq,
      historico: (extrato.historico||'').substring(0,80),
      discriminacao: (nf.discriminacao||'').substring(0,80),
    };
  });

  const semNfRows = extSemNf.map(e => ({
    data:      fmtD(e.data_iso),
    valor:     num(e.credito),
    contrato:  e.contrato_vinculado || '',
    historico: (e.historico||'').substring(0,100),
    categoria: categorizarCredito(e),
  }));

  console.log(`\n  🏢 ${cfg.label} (${cfg.regime} — PIS/COFINS ${cfg.pisCofinsRegime})`);
  console.log(`     ${rows.length} NFs identificadas | ${extSemNf.length} créditos sem NF`);
  const anos = [...new Set(rows.map(r=>r.ano_emissao).filter(Boolean))].sort();
  anos.forEach(a => {
    const n = rows.filter(r=>r.ano_emissao===a);
    console.log(`     NFs emitidas em ${a}: ${n.length} NFs → R$${fmtR(n.reduce((s,r)=>s+r.vliq,0))} (${a<ANO_ARG?'já tributado':'tributar agora'})`);
  });
  return { rows, semNfRows, cfg, nomeEmpresa };
}

// ── ExcelJS: estilos ──────────────────────────────────────────────────────────
const COR = {
  header_azul:    '2E4057',  // fundo cabeçalho azul escuro
  header_txt:     'FFFFFF',  // texto branco
  header_cinza:   '546E7A',  // cabeçalho cinza (abas secundárias)
  tributar_fundo: 'E8F5E9',  // verde claro — tributar agora
  tributado_fundo:'FFF9C4',  // amarelo claro — já tributado
  alt_row:        'F5F5F5',  // linha alternada cinza suave
  total_fundo:    'E3F2FD',  // azul claro — linha de total
  borda:          'B0BEC5',
};

function borderAll(color = COR.borda) {
  const s = { style: 'thin', color: { argb: color } };
  return { top: s, left: s, bottom: s, right: s };
}

function styleHeader(row, bgColor = COR.header_azul) {
  row.font = { bold: true, color: { argb: COR.header_txt }, size: 10, name: 'Calibri' };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.height = 30;
  row.eachCell(c => { c.border = borderAll(); });
}

function applyRowStyle(row, bgColor, fontSize = 9) {
  row.font = { size: fontSize, name: 'Calibri' };
  if (bgColor) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
  row.eachCell(c => { c.border = borderAll(); });
  row.alignment = { vertical: 'middle' };
}

function autoWidth(ws, cols) {
  ws.columns = cols.map(c => ({
    key:   c.key,
    width: Math.min(c.width || 18, 60),
    style: { font: { name: 'Calibri', size: 9 }, alignment: { vertical: 'middle', wrapText: false } },
  }));
}

function freezeHeader(ws) {
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 0, activeCell: 'A2' }];
}

function addTotalRow(ws, label, cols, data) {
  const totRow = ws.addRow([]);
  cols.forEach((col, i) => {
    const cell = totRow.getCell(i+1);
    if (i === 0) { cell.value = label; cell.font = { bold: true, size: 9, name: 'Calibri' }; }
    else if (col.sum) {
      cell.value = data.reduce((s, r) => s + (r[col.key] || 0), 0);
      cell.numFmt = '#,##0.00';
      cell.font = { bold: true, size: 9, name: 'Calibri' };
    }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.total_fundo } };
    cell.border = borderAll();
  });
  return totRow;
}

// ── Gera XLSX de uma empresa ──────────────────────────────────────────────────
async function gerarXlsxEmpresa(empData) {
  const { rows, semNfRows, cfg, nomeEmpresa } = empData;
  const wb = new ExcelJS.Workbook();
  wb.creator  = 'Montana ERP';
  wb.created  = new Date();
  wb.modified = new Date();

  // ── Aba 1: RESUMO ──────────────────────────────────────────────────────────
  const wsRes = wb.addWorksheet('1. Resumo', { pageSetup: { fitToPage: true } });
  wsRes.views = [{ showGridLines: false }];

  // Título
  wsRes.mergeCells('A1:E1');
  const titulo = wsRes.getCell('A1');
  titulo.value = `RELATÓRIO FISCAL — ${cfg.label.toUpperCase()}`;
  titulo.font  = { bold: true, size: 14, color: { argb: COR.header_txt }, name: 'Calibri' };
  titulo.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.header_azul } };
  titulo.alignment = { horizontal: 'center', vertical: 'middle' };
  wsRes.getRow(1).height = 36;

  const info = [
    ['Regime tributário:', `${cfg.regime} — PIS/COFINS ${cfg.pisCofinsRegime}`],
    ['Período de recebimento:', MES_LABEL],
    ['PIS próprio:', `${(cfg.pisPct*100).toFixed(2)}%`],
    ['COFINS própria:', `${(cfg.cofinsPct*100).toFixed(2)}%`],
    ['Base de cálculo:', 'Regime de caixa (data do recebimento bancário)'],
    ['Gerado em:', new Date().toLocaleString('pt-BR')],
  ];
  info.forEach(([k,v]) => {
    const r = wsRes.addRow(['', k, v]);
    r.getCell(2).font = { bold: true, size: 10, name: 'Calibri' };
    r.getCell(3).font = { size: 10, name: 'Calibri' };
    r.height = 18;
  });
  wsRes.addRow([]);

  // Subtítulo
  const rSub = wsRes.addRow(['', 'TOTAIS POR ANO DE EMISSÃO DA NF', '', '', '']);
  wsRes.mergeCells(`B${rSub.number}:E${rSub.number}`);
  rSub.font = { bold: true, size: 11, name: 'Calibri' };
  rSub.height = 22;

  // Nota explicativa
  const rObs = wsRes.addRow(['', '⚠️  Base fiscal: ano de emissão da NF (não a competência do serviço). Competência consta nas abas 2 e 3 para controle de adimplência de contratos.', '', '', '']);
  wsRes.mergeCells(`B${rObs.number}:E${rObs.number}`);
  rObs.getCell(2).font = { italic: true, size: 9, name: 'Calibri', color: { argb: '546E7A' } };
  rObs.height = 16;

  // Cabeçalho tabela resumo
  const rHdr = wsRes.addRow(['', 'Ano Emissão NF', 'Qtd NFs', 'Valor Líq. Recebido (R$)', 'Situação Tributária']);
  styleHeader(rHdr, COR.header_cinza);

  // Agrupa por ano de emissão (critério fiscal)
  const porAnoEmissao = new Map();
  for (const r of rows) {
    const k = r.ano_emissao || '(sem data emissão)';
    if (!porAnoEmissao.has(k)) porAnoEmissao.set(k, { qtd: 0, vliq: 0 });
    const c = porAnoEmissao.get(k); c.qtd++; c.vliq += r.vliq;
  }
  let totQtd = 0, totVliq = 0;
  for (const [ano, v] of [...porAnoEmissao.entries()].sort()) {
    const jaT = ano !== '(sem data emissão)' && ano < ANO_ARG;
    const sit = jaT ? '✅ JÁ TRIBUTADO — NF emitida em '+ano : '⚠️  TRIBUTAR AGORA — NF emitida em '+ano;
    const rr  = wsRes.addRow(['', ano, v.qtd, v.vliq, sit]);
    rr.getCell(4).numFmt = '#,##0.00';
    rr.getCell(4).alignment = { horizontal: 'right' };
    const bg = jaT ? COR.tributado_fundo : COR.tributar_fundo;
    applyRowStyle(rr, bg, 10);
    rr.getCell(5).font = { bold: true, size: 10, name: 'Calibri', color: { argb: jaT ? '7B6000' : '1B5E20' } };
    totQtd += v.qtd; totVliq += v.vliq;
  }
  const rTot = wsRes.addRow(['', 'TOTAL', totQtd, totVliq, '']);
  rTot.getCell(4).numFmt = '#,##0.00';
  rTot.font = { bold: true, size: 10, name: 'Calibri' };
  rTot.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.total_fundo } };
  rTot.eachCell(c => { c.border = borderAll(); });

  wsRes.addRow([]);

  // Créditos sem NF
  if (semNfRows.length) {
    const rSub2 = wsRes.addRow(['', 'CRÉDITOS SEM NF IDENTIFICADA', '', '', '']);
    rSub2.font = { bold: true, size: 11, name: 'Calibri' };
    wsRes.mergeCells(`B${rSub2.number}:E${rSub2.number}`);
    const rSemHdr = wsRes.addRow(['', 'Data', 'Valor (R$)', 'Contrato', 'Categorização']);
    styleHeader(rSemHdr, COR.header_cinza);
    semNfRows.forEach((s, i) => {
      const rr = wsRes.addRow(['', s.data, s.valor, s.contrato, s.categoria]);
      rr.getCell(3).numFmt = '#,##0.00';
      rr.getCell(3).alignment = { horizontal: 'right' };
      applyRowStyle(rr, i%2===0 ? COR.alt_row : 'FFFFFF', 9);
    });
    const totSem = semNfRows.reduce((s,r)=>s+r.valor,0);
    const rTotSem = wsRes.addRow(['', 'TOTAL SEM NF', totSem, '', '']);
    rTotSem.getCell(3).numFmt = '#,##0.00';
    rTotSem.font = { bold: true, size: 10, name: 'Calibri' };
    rTotSem.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.total_fundo } };
    rTotSem.eachCell(c => { c.border = borderAll(); });
  }

  wsRes.getColumn(2).width = 42;
  wsRes.getColumn(3).width = 12;
  wsRes.getColumn(4).width = 28;
  wsRes.getColumn(5).width = 45;

  // ── Aba 2: NFs PAGAS ──────────────────────────────────────────────────────
  const wsNfs = wb.addWorksheet('2. NFs Pagas');
  freezeHeader(wsNfs);

  const colsNf = [
    { key: 'contrato_ref',   header: 'Contrato Ref',         width: 28 },
    { key: 'nf_num',         header: 'NF Nº',                width: 14 },
    { key: 'tomador',        header: 'Tomador / Cliente',     width: 38 },
    { key: 'cnpj_tomador',   header: 'CNPJ Tomador',         width: 18 },
    { key: 'competencia',    header: 'Competência NF',        width: 16 },
    { key: 'data_emissao',   header: 'Data Emissão',         width: 14 },
    { key: 'data_pagto',     header: 'Data Pagamento',       width: 16 },
    { key: 'ja_tributado',   header: 'Já Tributado?',        width: 22 },
    { key: 'vbruto',         header: 'Valor Bruto (R$)',     width: 18, sum: true, numFmt: '#,##0.00' },
    { key: 'viss',           header: 'ISS Retido (R$)',      width: 16, sum: true, numFmt: '#,##0.00' },
    { key: 'vir',            header: 'IR Retido (R$)',       width: 15, sum: true, numFmt: '#,##0.00' },
    { key: 'vcsll',          header: 'CSLL Retido (R$)',     width: 16, sum: true, numFmt: '#,##0.00' },
    { key: 'vpis_ret',       header: 'PIS Retido (R$)',      width: 15, sum: true, numFmt: '#,##0.00' },
    { key: 'vcofins_ret',    header: 'COFINS Retida (R$)',   width: 18, sum: true, numFmt: '#,##0.00' },
    { key: 'vinss',          header: 'INSS Retido (R$)',     width: 16, sum: true, numFmt: '#,##0.00' },
    { key: 'ret_total',      header: 'Total Retenções (R$)', width: 20, sum: true, numFmt: '#,##0.00' },
    { key: 'vliq',           header: 'Vlr Líq. Recebido (R$)',width: 22, sum: true, numFmt: '#,##0.00' },
    { key: 'pis_proprio',    header: `PIS ${(cfg.pisPct*100).toFixed(2)}% (R$)`,   width: 18, sum: true, numFmt: '#,##0.00' },
    { key: 'cofins_prop',    header: `COFINS ${(cfg.cofinsPct*100).toFixed(2)}% (R$)`, width: 20, sum: true, numFmt: '#,##0.00' },
    { key: 'pis_liq',        header: 'PIS Líq. a Pagar (R$)',   width: 20, sum: true, numFmt: '#,##0.00' },
    { key: 'cofins_liq',     header: 'COFINS Líq. a Pagar (R$)',width: 22, sum: true, numFmt: '#,##0.00' },
    { key: 'tipo_match',     header: 'Tipo Vinculação',      width: 20 },
    { key: 'historico',      header: 'Histórico Banco',      width: 40 },
    { key: 'discriminacao',  header: 'Discriminação NF',     width: 40 },
  ];
  autoWidth(wsNfs, colsNf);

  const hdrNf = wsNfs.addRow(colsNf.map(c => c.header));
  styleHeader(hdrNf);

  let lastContrato = null;
  rows.forEach((r, i) => {
    const isNewContrato = r.contrato_ref !== lastContrato;
    lastContrato = r.contrato_ref;
    const rr = wsNfs.addRow(colsNf.map(c => r[c.key]));
    colsNf.forEach((c, ci) => {
      if (c.numFmt) { rr.getCell(ci+1).numFmt = c.numFmt; rr.getCell(ci+1).alignment = { horizontal: 'right' }; }
    });
    const bg = r.ja_tributado === 'SIM' ? COR.tributado_fundo : (i%2===0 ? COR.tributar_fundo : 'E1F5E3');
    applyRowStyle(rr, bg, 9);
    // Destaca coluna "Já Tributado?"
    const cellTribt = rr.getCell(8);
    cellTribt.font = { bold: true, size: 9, name: 'Calibri', color: { argb: r.ja_tributado === 'SIM' ? '7B6000' : '1B5E20' } };
    if (isNewContrato && i > 0) {
      // Linha separadora leve entre contratos
      rr.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'ECEFF1' } };
    }
  });

  if (rows.length) addTotalRow(wsNfs, 'TOTAL GERAL', colsNf, rows);

  // ── Aba 3: APURAÇÃO FISCAL ─────────────────────────────────────────────────
  const wsCalc = wb.addWorksheet('3. Apuração Fiscal');
  freezeHeader(wsCalc);
  wsCalc.views = [{ state: 'frozen', ySplit: 1, xSplit: 0, activeCell: 'A2' }];

  const colsCalc = [
    { key: 'competencia',  header: 'Competência NF',   width: 16 },
    { key: 'contrato_ref', header: 'Contrato',         width: 26 },
    { key: 'nf_num',       header: 'NF Nº',            width: 14 },
    { key: 'tomador',      header: 'Tomador',          width: 35 },
    { key: 'data_pagto',   header: 'Data Recebimento', width: 18 },
    { key: 'vliq',         header: 'Base de Cálculo (R$)',    width: 22, sum: true, numFmt: '#,##0.00' },
    { key: 'vpis_ret',     header: 'PIS Retido p/ Tomador (R$)', width: 24, sum: true, numFmt: '#,##0.00' },
    { key: 'vcofins_ret',  header: 'COFINS Retida p/ Tomador (R$)', width: 28, sum: true, numFmt: '#,##0.00' },
    { key: 'pis_proprio',  header: `PIS ${(cfg.pisPct*100).toFixed(2)}% s/ Base (R$)`, width: 24, sum: true, numFmt: '#,##0.00' },
    { key: 'cofins_prop',  header: `COFINS ${(cfg.cofinsPct*100).toFixed(2)}% s/ Base (R$)`, width: 26, sum: true, numFmt: '#,##0.00' },
    { key: 'pis_liq',      header: 'PIS Líq. a Recolher (R$)',    width: 24, sum: true, numFmt: '#,##0.00' },
    { key: 'cofins_liq',   header: 'COFINS Líq. a Recolher (R$)', width: 26, sum: true, numFmt: '#,##0.00' },
    { key: 'ja_tributado', header: 'Situação',         width: 20 },
  ];
  autoWidth(wsCalc, colsCalc);

  const hdrCalc = wsCalc.addRow(colsCalc.map(c => c.header));
  styleHeader(hdrCalc);

  // Ordenação: tributar agora primeiro, depois já tributados; dentro de cada grupo por ano_emissao → contrato
  const rowsOrdenados = [...rows].sort((a,b) => {
    if (a.ja_tributado !== b.ja_tributado) return a.ja_tributado === 'SIM' ? 1 : -1;
    return (a.ano_emissao||'').localeCompare(b.ano_emissao||'') || (a.contrato_ref||'').localeCompare(b.contrato_ref||'');
  });

  let secaoAtual = null;
  rowsOrdenados.forEach((r, i) => {
    const secao = r.ja_tributado === 'SIM' ? 'JÁ TRIBUTADO' : 'TRIBUTAR AGORA';
    if (secao !== secaoAtual) {
      secaoAtual = secao;
      const rSec = wsCalc.addRow([r.ja_tributado === 'SIM'
        ? `── NF EMITIDA EM ANO ANTERIOR — JÁ TRIBUTADO (imposto declarado em ${r.ano_emissao || 'ano anterior'})`
        : `── NF EMITIDA EM ${ANO_ARG} — TRIBUTAR AGORA (incluir no DARF de ${MES_LABEL})`
      ]);
      wsCalc.mergeCells(`A${rSec.number}:M${rSec.number}`);
      rSec.font   = { bold: true, size: 10, name: 'Calibri', color: { argb: r.ja_tributado === 'SIM' ? '6B4F0C' : '1A5722' } };
      rSec.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: r.ja_tributado === 'SIM' ? 'FFF8E1' : 'E8F5E9' } };
      rSec.height = 24;
    }
    const rr = wsCalc.addRow(colsCalc.map(c => r[c.key]));
    colsCalc.forEach((c, ci) => {
      if (c.numFmt) { rr.getCell(ci+1).numFmt = c.numFmt; rr.getCell(ci+1).alignment = { horizontal: 'right' }; }
    });
    const bg = r.ja_tributado === 'SIM' ? COR.tributado_fundo : (i%2===0 ? COR.tributar_fundo : 'E1F5E3');
    applyRowStyle(rr, bg, 9);
    const cellSit = rr.getCell(13);
    cellSit.font = { bold: true, size: 9, name: 'Calibri', color: { argb: r.ja_tributado === 'SIM' ? '7B6000' : '1B5E20' } };
  });

  if (rows.length) addTotalRow(wsCalc, 'TOTAL GERAL', colsCalc, rows);

  // ── Aba 4: CRÉDITOS SEM NF ────────────────────────────────────────────────
  const wsSem = wb.addWorksheet('4. Créditos sem NF');
  freezeHeader(wsSem);
  const colsSem = [
    { key: 'data',      header: 'Data',           width: 14 },
    { key: 'valor',     header: 'Valor (R$)',      width: 18, sum: true, numFmt: '#,##0.00' },
    { key: 'contrato',  header: 'Contrato',        width: 35 },
    { key: 'historico', header: 'Histórico Banco', width: 60 },
    { key: 'categoria', header: 'Categorização',   width: 55 },
  ];
  autoWidth(wsSem, colsSem);
  const hdrSem = wsSem.addRow(colsSem.map(c => c.header));
  styleHeader(hdrSem, COR.header_cinza);
  semNfRows.forEach((r, i) => {
    const rr = wsSem.addRow(colsSem.map(c => r[c.key]));
    colsSem.forEach((c, ci) => {
      if (c.numFmt) { rr.getCell(ci+1).numFmt = c.numFmt; rr.getCell(ci+1).alignment = { horizontal: 'right' }; }
    });
    applyRowStyle(rr, i%2===0 ? COR.alt_row : 'FFFFFF', 9);
  });
  if (semNfRows.length) addTotalRow(wsSem, 'TOTAL', colsSem, semNfRows);

  // ── Salvar ─────────────────────────────────────────────────────────────────
  const outDir  = path.join(__dirname, '..', 'relatorios');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `receita_federal_${nomeEmpresa}_${ANO_ARG}-${MES_ARG}.xlsx`);
  await wb.xlsx.writeFile(outFile);
  console.log(`  ✅ relatorios/receita_federal_${nomeEmpresa}_${ANO_ARG}-${MES_ARG}.xlsx`);
  return outFile;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const empresasAlvo = EMPRESA_ARG === 'todas'
    ? Object.keys(CONFIG_EMPRESAS)
    : [EMPRESA_ARG];

  for (const emp of empresasAlvo) {
    const cfg = CONFIG_EMPRESAS[emp];
    if (!cfg) { console.log(`  ⚠️  Empresa desconhecida: ${emp}`); continue; }
    const data = buildEmpresaData(emp, cfg);
    if (data) await gerarXlsxEmpresa(data);
  }

  console.log('\n  ✔️  Concluído.\n');
})();
