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
 *   Capa             — KPIs, índice, observação fiscal
 *   1. Resumo        — sumário por ano + por contrato + por competência de serviço + box DARF
 *   2. NFs Pagas     — nota a nota com mês ref serviço + subtotais por contrato + AutoFilter
 *   3. Apuração Fiscal — box DARF + seções tributar/já tributado + AutoFilter
 *   4. Créditos sem NF — categorias agrupadas + AutoFilter + Ação Recomendada
 *   5. NFs a Receber — NFs em aberto dos últimos 6 meses, >60 dias em vermelho
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
const _hoje    = new Date();
const _mesAnt  = new Date(_hoje.getFullYear(), _hoje.getMonth() - 1, 1);
const MES_ARG  = String(args.mes || (_mesAnt.getMonth() + 1)).padStart(2, '0');
const ANO_ARG  = String(args.ano || _mesAnt.getFullYear());
const EMPRESA_ARG = args.empresa || 'todas';
const MES_LABEL   = `${ANO_ARG}-${MES_ARG}`;
const DATA_INI    = `${ANO_ARG}-${MES_ARG}-01`;
const DATA_FIM    = `${ANO_ARG}-${MES_ARG}-31`;

// Data de vencimento: dia 25 do mês seguinte
const _dtVenc = new Date(Number(ANO_ARG), Number(MES_ARG), 25); // mês+1 (0-indexed)
const VENCTO_DARF = `25/${String(_dtVenc.getMonth()+1).padStart(2,'0')}/${_dtVenc.getFullYear()}`;
const PERIODO_APURACAO = `${MES_ARG}/${ANO_ARG}`;

// Nome por extenso do mês
const MESES_PT = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const MES_EXTENSO = MESES_PT[Number(MES_ARG)-1];

console.log(`\n  Relatorio Receita Federal — recebimentos ${MES_LABEL}`);

// ── Configuração de empresas ───────────────────────────────────────────────────
const CONFIG_EMPRESAS = {
  assessoria: {
    regime: 'Lucro Real',
    pisCofinsRegime: 'não-cumulativo',
    pisPct: 0.0165,
    cofinsPct: 0.0760,
    label: 'Montana Assessoria Empresarial Ltda',
    cnpj: '14.092.519/0001-51',
    codigoDarfPis: '6912',    // PIS não-cumulativo
    codigoDarfCofins: '5856', // COFINS não-cumulativo
  },
  seguranca: {
    regime: 'Lucro Real',
    pisCofinsRegime: 'cumulativo',
    pisPct: 0.0065,
    cofinsPct: 0.0300,
    label: 'Montana Segurança e Vigilância Ltda',
    cnpj: '19.200.109/0001-09',
    codigoDarfPis: '8109',    // PIS cumulativo
    codigoDarfCofins: '2172', // COFINS cumulativo
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const R    = v  => Number(v || 0);
const fmtD = iso => iso ? iso.replace(/(\d{4})-(\d{2})-(\d{2})/, '$3/$2/$1') : '';
const fmtR = v  => R(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num  = v  => R(v);

function anoCompetencia(comp) {
  if (!comp) return '';
  const m = comp.match(/(\d{4})/);
  return m ? m[1] : '';
}

// Extrai "Mês Referência de Serviço" da discriminacao
// "Serv. ref. Outubro/2025 — Prefeitura de Palmas" → "Outubro/2025"
function extrairMesRefServico(discriminacao, competencia) {
  const disc = discriminacao || '';
  const m = disc.match(/[Ss]erv\.?\s*ref\.?\s+([^—\-–\n]+)/);
  if (m) return m[1].trim().replace(/\.$/, '');
  // fallback: formata competência AAAA-MM → Mês/AAAA
  if (competencia && competencia.match(/^\d{4}-\d{2}$/)) {
    const [ano, mes] = competencia.split('-');
    return `${MESES_PT[Number(mes)-1]}/${ano}`;
  }
  return competencia || '';
}

// ── Matching: keyword de contrato para batch TEDs ─────────────────────────────
const KWS = ['DETRAN','UNITINS','SESAU','SEDUC','UFT','UFNT','TCE','SEMARH',
             'CBMTO','FUNJURIS','TJ','PREFEITURA','PREVI','MUNICIPIO','MINISTERIO'];

const CNPJ_KW = {
  '01786029': 'SEDUC',
  '01786078': 'MINISTERIO',
  '01786011': 'SEDUC',
  '24851511': 'MUNICIPIO',
  '05149726': 'UFT',
  '25053083': 'SEDUC',
};

function kwContrato(s) {
  const up = (s||'').toUpperCase();
  for (const [cnpj, kw] of Object.entries(CNPJ_KW)) {
    if (up.includes(cnpj)) return kw;
  }
  return KWS.find(kw => up.includes(kw)) || '';
}

// ── Categorização de créditos sem NF ─────────────────────────────────────────
function categorizarCredito(e) {
  const h = (e.historico||'').toUpperCase();
  const c = (e.contrato_vinculado||'').toUpperCase();
  if (c.includes('CONTA VINCULADA') || c.includes('VINCULADA'))
    return 'CONTA VINCULADA';
  if (h.includes('RESGATE') && (h.includes('GARANTIA') || h.includes('DEP')))
    return 'RESGATE GARANTIA';
  if (h.includes('MONTANA') || h.includes('TRANSFERÊNCIA INTERNA') || h.includes('0151'))
    return 'INTERNO';
  if (h.includes('BACEN') || h.includes('JUDICIAL') || h.includes('DESBL'))
    return 'DESBLOQUEIO JUDICIAL';
  if (h.includes('RESGATE') || h.includes('RENDE') || h.includes('APLICACAO'))
    return 'INVESTIMENTO';
  return 'VERIFICAR';
}

function acaoRecomendada(categoria) {
  switch (categoria) {
    case 'CONTA VINCULADA':       return 'Nao tributavel — escrow contrato federal';
    case 'RESGATE GARANTIA':      return 'Nao tributavel — devolucao de caucao';
    case 'INTERNO':               return 'Nao tributavel — transferencia entre contas Montana';
    case 'DESBLOQUEIO JUDICIAL':  return 'Verificar NF correspondente ao processo';
    case 'INVESTIMENTO':          return 'Nao tributavel — resgate de aplicacao financeira';
    default:                      return 'Localizar NF correspondente ou emitir NF retroativa';
  }
}

// ── Core: NFs pagas no mês ────────────────────────────────────────────────────
function nfsPagasNoMes(db, dataIni, dataFim) {
  const extRaw = db.prepare(`
    SELECT id, data_iso, credito, historico, contrato_vinculado
    FROM extratos
    WHERE status_conciliacao = 'CONCILIADO' AND credito > 0
      AND data_iso >= ? AND data_iso <= ?
    ORDER BY data_iso, (contrato_vinculado <> '') DESC
  `).all(dataIni, dataFim);

  const extDedup = new Map();
  for (const e of extRaw) {
    const histPfx = (e.historico||'').substring(0,30).replace(/\s+/g,' ').trim();
    const k = `${e.data_iso}|${R(e.credito).toFixed(2)}|${histPfx}`;
    if (!extDedup.has(k) || (!extDedup.get(k).contrato_vinculado && e.contrato_vinculado))
      extDedup.set(k, e);
  }
  const extMes = [...extDedup.values()].sort((a,b) => new Date(a.data_iso)-new Date(b.data_iso));

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

// ── NFs em aberto (últimos 6 meses, não conciliadas) ─────────────────────────
function nfsAReceber(db) {
  try {
    return db.prepare(`
      SELECT numero, tomador, competencia, data_emissao, valor_bruto, valor_liquido,
             status_conciliacao, contrato_ref
      FROM notas_fiscais
      WHERE (status_conciliacao IS NULL OR status_conciliacao NOT IN ('CONCILIADO','ASSESSORIA','CANCELADA'))
        AND data_emissao >= date('now', '-6 months')
      ORDER BY valor_liquido DESC
      LIMIT 200
    `).all();
  } catch (_) { return []; }
}

// ── Monta dados de uma empresa ────────────────────────────────────────────────
function buildEmpresaData(nomeEmpresa, cfg) {
  let db;
  try { db = getDb(nomeEmpresa); } catch(_){ return null; }
  const { pareados, extSemNf } = nfsPagasNoMes(db, DATA_INI, DATA_FIM);
  const nfsAberto = nfsAReceber(db);

  const rows = pareados.map(({ nf, extrato, tipo }) => {
    const compFinal  = nf.competencia || (nf.data_emissao ? nf.data_emissao.substring(0,7) : '');
    const anoEmissao = nf.data_emissao ? nf.data_emissao.substring(0, 4) : '';
    const jaTribt    = anoEmissao !== '' && anoEmissao < ANO_ARG;
    const vbruto     = num(nf.valor_bruto);
    const vliq       = num(nf.valor_liquido || nf.valor_bruto);
    const retTotal   = num(nf.retencao) || (num(nf.ir)+num(nf.csll)+num(nf.pis)+num(nf.cofins)+num(nf.inss)+num(nf.iss));
    const pisProprio = vliq * cfg.pisPct;
    const cofinsProp = vliq * cfg.cofinsPct;
    const pisLiq     = Math.max(0, pisProprio  - num(nf.pis));
    const cofinsLiq  = Math.max(0, cofinsProp - num(nf.cofins));
    const mesRefServ = extrairMesRefServico(nf.discriminacao, compFinal);
    return {
      contrato_ref:  nf.contrato_ref || '(sem contrato)',
      nf_num:        nf.numero || '',
      tomador:       nf.tomador || '',
      cnpj_tomador:  nf.cnpj_tomador || '',
      competencia:   compFinal,
      mes_ref_serv:  mesRefServ,
      ano_emissao:   anoEmissao,
      ja_tributado:  jaTribt ? 'SIM' : 'NAO',
      data_emissao:  fmtD(nf.data_emissao),
      data_pagto:    fmtD(extrato.data_iso),
      tipo_match:    tipo,
      vbruto, vliq,
      viss: num(nf.iss), vir: num(nf.ir), vcsll: num(nf.csll),
      vpis_ret: num(nf.pis), vcofins_ret: num(nf.cofins), vinss: num(nf.inss),
      ret_total: retTotal,
      pis_proprio: pisProprio, cofins_prop: cofinsProp,
      pis_liq: pisLiq, cofins_liq: cofinsLiq,
      historico:     (extrato.historico||'').substring(0,80),
      discriminacao: (nf.discriminacao||'').substring(0,80),
    };
  });

  const semNfRows = extSemNf.map(e => ({
    data:      fmtD(e.data_iso),
    valor:     num(e.credito),
    contrato:  e.contrato_vinculado || '',
    historico: (e.historico||'').substring(0,100),
    categoria: categorizarCredito(e),
    acao:      acaoRecomendada(categorizarCredito(e)),
  }));

  const hoje = new Date();
  const aReceberRows = nfsAberto.map(nf => {
    const emissaoDate = nf.data_emissao ? new Date(nf.data_emissao) : null;
    const diasAberto  = emissaoDate ? Math.floor((hoje - emissaoDate) / 86400000) : null;
    return {
      nf_num:       nf.numero || '',
      tomador:      nf.tomador || '',
      competencia:  nf.competencia || '',
      data_emissao: fmtD(nf.data_emissao),
      contrato_ref: nf.contrato_ref || '',
      vbruto:       num(nf.valor_bruto),
      vliq:         num(nf.valor_liquido || nf.valor_bruto),
      status:       nf.status_conciliacao || 'PENDENTE',
      dias_aberto:  diasAberto,
      em_atraso:    diasAberto !== null && diasAberto > 60,
    };
  });

  console.log(`\n  ${cfg.label} (${cfg.regime} — PIS/COFINS ${cfg.pisCofinsRegime})`);
  console.log(`     ${rows.length} NFs identificadas | ${extSemNf.length} creditos sem NF | ${aReceberRows.length} NFs a receber`);
  const anos = [...new Set(rows.map(r=>r.ano_emissao).filter(Boolean))].sort();
  anos.forEach(a => {
    const n = rows.filter(r=>r.ano_emissao===a);
    console.log(`     NFs emitidas em ${a}: ${n.length} NFs -> R$${fmtR(n.reduce((s,r)=>s+r.vliq,0))} (${a<ANO_ARG?'ja tributado':'tributar agora'})`);
  });
  return { rows, semNfRows, aReceberRows, cfg, nomeEmpresa };
}

// ── ExcelJS: paleta de cores ──────────────────────────────────────────────────
const COR = {
  // Cabeçalhos
  header_azul:     '1565C0',  // azul escuro principal
  header_cinza:    '546E7A',  // cabeçalho cinza
  header_laranja:  'E65100',  // laranja (aba NFs a Receber)
  header_txt:      'FFFFFF',
  // Fundos de dados
  tributar_fundo:  'E8F5E9',  // verde suave — tributar agora
  tributado_fundo: 'FFF9C4',  // amarelo suave — já tributado
  alt_row:         'F5F7FA',  // linha alternada
  total_fundo:     'E3F2FD',  // azul claro — totais
  subtotal_fundo:  'BBDEFB',  // azul médio — subtotal por contrato
  // KPI boxes
  kpi_azul:        '1565C0',
  kpi_verde:       '2E7D32',
  kpi_laranja:     'E65100',
  kpi_vermelho:    'C62828',
  // Bordas
  borda:           'B0BEC5',
  borda_grossa:    '1565C0',
  // NFs em atraso
  atraso_fundo:    'FFCDD2',  // vermelho claro
  atraso_txt:      'B71C1C',
};

function borderAll(color) {
  const c = color || COR.borda;
  const s = { style: 'thin', color: { argb: c } };
  return { top: s, left: s, bottom: s, right: s };
}

function borderThick(color) {
  const c = color || COR.borda_grossa;
  const s = { style: 'medium', color: { argb: c } };
  return { top: s, left: s, bottom: s, right: s };
}

function styleHeader(row, bgColor) {
  const bg = bgColor || COR.header_azul;
  row.font = { bold: true, color: { argb: COR.header_txt }, size: 10, name: 'Calibri' };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.height = 30;
  row.eachCell(c => { c.border = borderAll(); });
}

function applyRowStyle(row, bgColor, fontSize) {
  const fs = fontSize || 9;
  row.font = { size: fs, name: 'Calibri' };
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

function addSubtotalRow(ws, label, cols, data) {
  const totRow = ws.addRow([]);
  cols.forEach((col, i) => {
    const cell = totRow.getCell(i+1);
    if (i === 0) {
      cell.value = label;
      cell.font = { bold: true, size: 9, name: 'Calibri', italic: true };
    } else if (col.sum) {
      cell.value = data.reduce((s, r) => s + (r[col.key] || 0), 0);
      cell.numFmt = '#,##0.00';
      cell.font = { bold: true, size: 9, name: 'Calibri', italic: true };
    }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.subtotal_fundo } };
    cell.border = borderAll();
    cell.alignment = { horizontal: i > 0 && col.sum ? 'right' : 'left', vertical: 'middle' };
  });
  return totRow;
}

// ── Coloca KPI box (merge de células) ─────────────────────────────────────────
function addKpiBox(ws, startRow, startCol, endRow, endCol, titulo, valor, bgColor) {
  // Merge
  const startCell = `${colLetter(startCol)}${startRow}`;
  const endCell   = `${colLetter(endCol)}${endRow}`;
  ws.mergeCells(`${startCell}:${endCell}`);

  const cell = ws.getCell(startCell);
  cell.value = `${titulo}\n${valor}`;
  cell.font  = { bold: true, color: { argb: COR.header_txt }, size: 11, name: 'Calibri' };
  cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
  cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  cell.border = borderThick(bgColor);
}

function colLetter(n) {
  let result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

// ── Gera XLSX de uma empresa ──────────────────────────────────────────────────
async function gerarXlsxEmpresa(empData) {
  const { rows, semNfRows, aReceberRows, cfg, nomeEmpresa } = empData;
  const wb = new ExcelJS.Workbook();
  wb.creator  = 'Montana ERP';
  wb.created  = new Date();
  wb.modified = new Date();

  // Totais gerais calculados antecipadamente para a capa
  const rowsTritutar = rows.filter(r => r.ja_tributado === 'NAO');
  const totalRecebido = rows.reduce((s,r) => s + r.vliq, 0);
  const totalPisRecolher   = rowsTritutar.reduce((s,r) => s + r.pis_liq, 0);
  const totalCofinsRecolher= rowsTritutar.reduce((s,r) => s + r.cofins_liq, 0);
  const qtdNFs = rows.length;

  // ════════════════════════════════════════════════════════════════════════════
  // CAPA
  // ════════════════════════════════════════════════════════════════════════════
  const wsCapa = wb.addWorksheet('Capa');
  wsCapa.views = [{ showGridLines: false }];

  // Configurar larguras das colunas A–L
  for (let c = 1; c <= 12; c++) {
    wsCapa.getColumn(c).width = 16;
  }

  // -- Cabeçalho principal (A1:L3) --
  wsCapa.mergeCells('A1:L3');
  const cellTitulo = wsCapa.getCell('A1');
  cellTitulo.value = cfg.label.toUpperCase();
  cellTitulo.font  = { bold: true, size: 18, color: { argb: COR.header_txt }, name: 'Calibri' };
  cellTitulo.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.header_azul } };
  cellTitulo.alignment = { horizontal: 'center', vertical: 'middle' };
  wsCapa.getRow(1).height = 60;
  wsCapa.getRow(2).height = 1;
  wsCapa.getRow(3).height = 1;

  // -- Informações (linhas 4–7, col B–K) --
  const infoLines = [
    `CNPJ: ${cfg.cnpj}`,
    `Regime Tributario: ${cfg.regime} — PIS/COFINS ${cfg.pisCofinsRegime}`,
    `Periodo de Referencia: ${MES_EXTENSO} / ${ANO_ARG}  (recebimentos de ${DATA_INI} a ${DATA_FIM})`,
    `Gerado em: ${new Date().toLocaleString('pt-BR')}`,
  ];
  infoLines.forEach((line, idx) => {
    const rowNum = 4 + idx;
    wsCapa.mergeCells(`A${rowNum}:L${rowNum}`);
    const c = wsCapa.getCell(`A${rowNum}`);
    c.value = line;
    c.font = { size: 11, name: 'Calibri', color: { argb: '263238' } };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
    wsCapa.getRow(rowNum).height = 20;
  });

  // -- Linha separadora --
  wsCapa.getRow(8).height = 12;

  // -- KPI Boxes (linhas 9–14, 4 boxes lado a lado) --
  // Box 1: Total Recebido (azul) — A9:C14
  // Box 2: NFs Identificadas (verde) — D9:F14
  // Box 3: PIS a Recolher (laranja) — G9:I14
  // Box 4: COFINS a Recolher (vermelho) — J9:L14
  for (let r = 9; r <= 14; r++) wsCapa.getRow(r).height = 22;

  addKpiBox(wsCapa, 9, 1, 14, 3,
    'TOTAL RECEBIDO',
    `R$ ${fmtR(totalRecebido)}`,
    COR.kpi_azul);

  addKpiBox(wsCapa, 9, 4, 14, 6,
    'NFs IDENTIFICADAS',
    `${qtdNFs} notas fiscais`,
    COR.kpi_verde);

  addKpiBox(wsCapa, 9, 7, 14, 9,
    `PIS A RECOLHER\nDARF ${cfg.codigoDarfPis}`,
    `R$ ${fmtR(totalPisRecolher)}`,
    COR.kpi_laranja);

  addKpiBox(wsCapa, 9, 10, 14, 12,
    `COFINS A RECOLHER\nDARF ${cfg.codigoDarfCofins}`,
    `R$ ${fmtR(totalCofinsRecolher)}`,
    COR.kpi_vermelho);

  // -- Linha separadora --
  wsCapa.getRow(15).height = 16;

  // -- Índice de abas (linha 16 em diante) --
  wsCapa.mergeCells('A16:L16');
  const cellIndice = wsCapa.getCell('A16');
  cellIndice.value = 'ÍNDICE DAS ABAS';
  cellIndice.font  = { bold: true, size: 12, name: 'Calibri', color: { argb: COR.header_azul } };
  cellIndice.alignment = { horizontal: 'center', vertical: 'middle' };
  cellIndice.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E3F2FD' } };
  wsCapa.getRow(16).height = 24;

  const abas = [
    ['1. Resumo',          'Totais por ano de emissao, por contrato, por competencia de servico e box DARF'],
    ['2. NFs Pagas',       'Detalhamento nota a nota com mes referencia, subtotais por contrato e filtros'],
    ['3. Apuracao Fiscal', 'Calculo PIS/COFINS com box DARF pronto para preenchimento'],
    ['4. Creditos sem NF', 'Creditos bancarios nao vinculados a NF, categorizados com acao recomendada'],
    ['5. NFs a Receber',   'NFs em aberto emitidas nos ultimos 6 meses (status nao conciliado)'],
  ];
  abas.forEach(([aba, desc], idx) => {
    const rowNum = 17 + idx;
    wsCapa.mergeCells(`A${rowNum}:C${rowNum}`);
    wsCapa.mergeCells(`D${rowNum}:L${rowNum}`);
    const c1 = wsCapa.getCell(`A${rowNum}`);
    const c2 = wsCapa.getCell(`D${rowNum}`);
    c1.value = aba;
    c1.font  = { bold: true, size: 10, name: 'Calibri', color: { argb: COR.header_azul } };
    c1.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: idx%2===0 ? 'F5F7FA' : 'FFFFFF' } };
    c1.border = borderAll();
    c2.value = desc;
    c2.font  = { size: 10, name: 'Calibri' };
    c2.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: idx%2===0 ? 'F5F7FA' : 'FFFFFF' } };
    c2.border = borderAll();
    wsCapa.getRow(rowNum).height = 18;
  });

  // -- Observação fiscal --
  const rowObs = 17 + abas.length + 1;
  wsCapa.mergeCells(`A${rowObs}:L${rowObs}`);
  const cellObs = wsCapa.getCell(`A${rowObs}`);
  cellObs.value = 'OBSERVACAO FISCAL IMPORTANTE: Base de calculo PIS/COFINS = regime de caixa (Lei 10.833/2003 art.10 §2°). '
    + 'Apenas NFs efetivamente recebidas no periodo sao tributadas. '
    + 'NFs emitidas em ano anterior ja constam na apuracao daquele exercicio e nao geram novo DARF.';
  cellObs.font = { italic: true, size: 9, name: 'Calibri', color: { argb: '37474F' } };
  cellObs.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE7' } };
  cellObs.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
  cellObs.border = borderAll('F9A825');
  wsCapa.getRow(rowObs).height = 44;

  // -- Rodapé --
  const rowFoot = rowObs + 1;
  wsCapa.mergeCells(`A${rowFoot}:L${rowFoot}`);
  const cellFoot = wsCapa.getCell(`A${rowFoot}`);
  cellFoot.value = `Documento gerado automaticamente pelo sistema Montana ERP em ${new Date().toLocaleString('pt-BR')} | Confidencial`;
  cellFoot.font  = { size: 8, name: 'Calibri', color: { argb: '90A4AE' }, italic: true };
  cellFoot.alignment = { horizontal: 'center', vertical: 'middle' };
  wsCapa.getRow(rowFoot).height = 16;

  // ════════════════════════════════════════════════════════════════════════════
  // ABA 1: RESUMO
  // ════════════════════════════════════════════════════════════════════════════
  const wsRes = wb.addWorksheet('1. Resumo', { pageSetup: { fitToPage: true } });
  wsRes.views = [{ showGridLines: false }];

  // Título
  wsRes.mergeCells('A1:F1');
  const titulo = wsRes.getCell('A1');
  titulo.value = `RELATÓRIO FISCAL — ${cfg.label.toUpperCase()} — ${MES_EXTENSO.toUpperCase()}/${ANO_ARG}`;
  titulo.font  = { bold: true, size: 13, color: { argb: COR.header_txt }, name: 'Calibri' };
  titulo.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.header_azul } };
  titulo.alignment = { horizontal: 'center', vertical: 'middle' };
  wsRes.getRow(1).height = 36;

  const info = [
    ['Regime tributário:', `${cfg.regime} — PIS/COFINS ${cfg.pisCofinsRegime}`],
    ['CNPJ:', cfg.cnpj],
    ['Período de recebimento:', MES_LABEL],
    ['PIS próprio:', `${(cfg.pisPct*100).toFixed(2)}%   (cód. DARF ${cfg.codigoDarfPis})`],
    ['COFINS própria:', `${(cfg.cofinsPct*100).toFixed(2)}%   (cód. DARF ${cfg.codigoDarfCofins})`],
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

  // ── Tabela 1: Por Ano de Emissão ──
  {
    const rSub = wsRes.addRow(['', 'TOTAIS POR ANO DE EMISSÃO DA NF', '', '', '', '']);
    wsRes.mergeCells(`B${rSub.number}:F${rSub.number}`);
    rSub.font = { bold: true, size: 11, name: 'Calibri', color: { argb: COR.header_azul } };
    rSub.height = 22;

    const rObs = wsRes.addRow(['', 'Base fiscal: ano de emissão da NF (não a competência do serviço).', '', '', '', '']);
    wsRes.mergeCells(`B${rObs.number}:F${rObs.number}`);
    rObs.getCell(2).font = { italic: true, size: 9, name: 'Calibri', color: { argb: '546E7A' } };
    rObs.height = 16;

    const rHdr = wsRes.addRow(['', 'Ano Emissão NF', 'Qtd NFs', 'Valor Líq. Recebido (R$)', 'PIS (R$)', 'COFINS (R$)']);
    styleHeader(rHdr, COR.header_cinza);

    const porAnoEmissao = new Map();
    for (const r of rows) {
      const k = r.ano_emissao || '(sem data emissão)';
      if (!porAnoEmissao.has(k)) porAnoEmissao.set(k, { qtd: 0, vliq: 0, pis: 0, cofins: 0 });
      const c = porAnoEmissao.get(k);
      c.qtd++; c.vliq += r.vliq;
      if (r.ja_tributado === 'NAO') { c.pis += r.pis_liq; c.cofins += r.cofins_liq; }
    }
    let totQtd = 0, totVliq = 0, totPis = 0, totCofins = 0;
    for (const [ano, v] of [...porAnoEmissao.entries()].sort()) {
      const jaT = ano !== '(sem data emissão)' && ano < ANO_ARG;
      const rr  = wsRes.addRow(['', ano + (jaT ? ' (ja tributado)' : ' (tributar agora)'), v.qtd, v.vliq, jaT ? 0 : v.pis, jaT ? 0 : v.cofins]);
      ['D','E','F'].forEach(col => {
        const cell = rr.getCell(col === 'D' ? 4 : col === 'E' ? 5 : 6);
        cell.numFmt = '#,##0.00';
        cell.alignment = { horizontal: 'right' };
      });
      applyRowStyle(rr, jaT ? COR.tributado_fundo : COR.tributar_fundo, 10);
      totQtd += v.qtd; totVliq += v.vliq;
      if (!jaT) { totPis += v.pis; totCofins += v.cofins; }
    }
    const rTot = wsRes.addRow(['', 'TOTAL', totQtd, totVliq, totPis, totCofins]);
    [4,5,6].forEach(ci => { rTot.getCell(ci).numFmt = '#,##0.00'; rTot.getCell(ci).alignment = { horizontal: 'right' }; });
    rTot.font = { bold: true, size: 10, name: 'Calibri' };
    rTot.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.total_fundo } };
    rTot.eachCell(c => { c.border = borderAll(); });
  }

  wsRes.addRow([]);

  // ── Tabela 2: Totais por Contrato ──
  {
    const rSub = wsRes.addRow(['', 'TOTAIS POR CONTRATO', '', '', '', '']);
    wsRes.mergeCells(`B${rSub.number}:F${rSub.number}`);
    rSub.font = { bold: true, size: 11, name: 'Calibri', color: { argb: COR.header_azul } };
    rSub.height = 22;

    const rHdr = wsRes.addRow(['', 'Contrato Ref', 'Qtd NFs', 'Valor Líq. Recebido (R$)', 'PIS Tributar (R$)', 'COFINS Tributar (R$)']);
    styleHeader(rHdr, COR.header_cinza);

    const porContrato = new Map();
    for (const r of rows) {
      const k = r.contrato_ref || '(sem contrato)';
      if (!porContrato.has(k)) porContrato.set(k, { qtd: 0, vliq: 0, pis: 0, cofins: 0 });
      const c = porContrato.get(k);
      c.qtd++; c.vliq += r.vliq;
      if (r.ja_tributado === 'NAO') { c.pis += r.pis_liq; c.cofins += r.cofins_liq; }
    }
    let totQtd = 0, totVliq = 0, totPis = 0, totCofins = 0;
    for (const [cont, v] of [...porContrato.entries()].sort()) {
      const rr = wsRes.addRow(['', cont, v.qtd, v.vliq, v.pis, v.cofins]);
      [4,5,6].forEach(ci => { rr.getCell(ci).numFmt = '#,##0.00'; rr.getCell(ci).alignment = { horizontal: 'right' }; });
      applyRowStyle(rr, COR.alt_row, 9);
      totQtd += v.qtd; totVliq += v.vliq; totPis += v.pis; totCofins += v.cofins;
    }
    const rTot = wsRes.addRow(['', 'TOTAL', totQtd, totVliq, totPis, totCofins]);
    [4,5,6].forEach(ci => { rTot.getCell(ci).numFmt = '#,##0.00'; rTot.getCell(ci).alignment = { horizontal: 'right' }; });
    rTot.font = { bold: true, size: 10, name: 'Calibri' };
    rTot.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.total_fundo } };
    rTot.eachCell(c => { c.border = borderAll(); });
  }

  wsRes.addRow([]);

  // ── Tabela 3: Totais por Competência do Serviço ──
  {
    const rSub = wsRes.addRow(['', 'TOTAIS POR COMPETÊNCIA DO SERVIÇO', '', '', '', '']);
    wsRes.mergeCells(`B${rSub.number}:F${rSub.number}`);
    rSub.font = { bold: true, size: 11, name: 'Calibri', color: { argb: COR.header_azul } };
    rSub.height = 22;

    const rHdr = wsRes.addRow(['', 'Mês Referência Serviço', 'Qtd NFs', 'Valor Líq. Recebido (R$)', 'PIS Tributar (R$)', 'COFINS Tributar (R$)']);
    styleHeader(rHdr, COR.header_cinza);

    const porComp = new Map();
    for (const r of rows) {
      const k = r.mes_ref_serv || r.competencia || '(sem competência)';
      if (!porComp.has(k)) porComp.set(k, { qtd: 0, vliq: 0, pis: 0, cofins: 0 });
      const c = porComp.get(k);
      c.qtd++; c.vliq += r.vliq;
      if (r.ja_tributado === 'NAO') { c.pis += r.pis_liq; c.cofins += r.cofins_liq; }
    }
    let totQtd = 0, totVliq = 0, totPis = 0, totCofins = 0;
    for (const [comp, v] of [...porComp.entries()].sort()) {
      const rr = wsRes.addRow(['', comp, v.qtd, v.vliq, v.pis, v.cofins]);
      [4,5,6].forEach(ci => { rr.getCell(ci).numFmt = '#,##0.00'; rr.getCell(ci).alignment = { horizontal: 'right' }; });
      applyRowStyle(rr, COR.alt_row, 9);
      totQtd += v.qtd; totVliq += v.vliq; totPis += v.pis; totCofins += v.cofins;
    }
    const rTot = wsRes.addRow(['', 'TOTAL', totQtd, totVliq, totPis, totCofins]);
    [4,5,6].forEach(ci => { rTot.getCell(ci).numFmt = '#,##0.00'; rTot.getCell(ci).alignment = { horizontal: 'right' }; });
    rTot.font = { bold: true, size: 10, name: 'Calibri' };
    rTot.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.total_fundo } };
    rTot.eachCell(c => { c.border = borderAll(); });
  }

  wsRes.addRow([]);

  // ── Box DARF (Resumo) ──
  {
    const rowIni = wsRes.lastRow.number + 1;
    wsRes.mergeCells(`B${rowIni}:F${rowIni}`);
    const cellDarfTit = wsRes.getCell(`B${rowIni}`);
    cellDarfTit.value = 'RESUMO DARF — VALORES A RECOLHER';
    cellDarfTit.font  = { bold: true, size: 12, name: 'Calibri', color: { argb: COR.header_txt } };
    cellDarfTit.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.header_azul } };
    cellDarfTit.alignment = { horizontal: 'center', vertical: 'middle' };
    wsRes.getRow(rowIni).height = 26;

    const darfLinhas = [
      [`PIS  — Código DARF ${cfg.codigoDarfPis}`, `R$ ${fmtR(totalPisRecolher)}`],
      [`COFINS — Código DARF ${cfg.codigoDarfCofins}`, `R$ ${fmtR(totalCofinsRecolher)}`],
      [`Período de apuração`, PERIODO_APURACAO],
      [`Data de vencimento`, VENCTO_DARF],
    ];
    darfLinhas.forEach(([label, val]) => {
      const rowNum = wsRes.lastRow.number + 1;
      wsRes.mergeCells(`B${rowNum}:C${rowNum}`);
      wsRes.mergeCells(`D${rowNum}:F${rowNum}`);
      const c1 = wsRes.getCell(`B${rowNum}`);
      const c2 = wsRes.getCell(`D${rowNum}`);
      c1.value = label;
      c2.value = val;
      c1.font = { bold: true, size: 11, name: 'Calibri' };
      c2.font = { bold: true, size: 11, name: 'Calibri', color: { argb: COR.kpi_vermelho } };
      c1.fill = c2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9E6' } };
      c1.border = c2.border = borderAll('F9A825');
      c1.alignment = { vertical: 'middle' };
      c2.alignment = { vertical: 'middle', horizontal: 'right' };
      wsRes.getRow(rowNum).height = 22;
    });
  }

  // Créditos sem NF no resumo
  if (semNfRows.length) {
    wsRes.addRow([]);
    const rSub2 = wsRes.addRow(['', 'CRÉDITOS SEM NF IDENTIFICADA', '', '', '', '']);
    rSub2.font = { bold: true, size: 11, name: 'Calibri' };
    wsRes.mergeCells(`B${rSub2.number}:F${rSub2.number}`);
    const rSemHdr = wsRes.addRow(['', 'Data', 'Valor (R$)', 'Contrato', 'Categoria', '']);
    styleHeader(rSemHdr, COR.header_cinza);
    semNfRows.forEach((s, i) => {
      const rr = wsRes.addRow(['', s.data, s.valor, s.contrato, s.categoria, '']);
      rr.getCell(3).numFmt = '#,##0.00';
      rr.getCell(3).alignment = { horizontal: 'right' };
      applyRowStyle(rr, i%2===0 ? COR.alt_row : 'FFFFFF', 9);
    });
    const totSem = semNfRows.reduce((s,r)=>s+r.valor,0);
    const rTotSem = wsRes.addRow(['', 'TOTAL SEM NF', totSem, '', '', '']);
    rTotSem.getCell(3).numFmt = '#,##0.00';
    rTotSem.font = { bold: true, size: 10, name: 'Calibri' };
    rTotSem.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.total_fundo } };
    rTotSem.eachCell(c => { c.border = borderAll(); });
  }

  wsRes.getColumn(2).width = 38;
  wsRes.getColumn(3).width = 14;
  wsRes.getColumn(4).width = 26;
  wsRes.getColumn(5).width = 22;
  wsRes.getColumn(6).width = 22;

  // ════════════════════════════════════════════════════════════════════════════
  // ABA 2: NFs PAGAS (com subtotais por contrato + Mês Ref Serviço + AutoFilter)
  // ════════════════════════════════════════════════════════════════════════════
  const wsNfs = wb.addWorksheet('2. NFs Pagas');
  freezeHeader(wsNfs);

  const colsNf = [
    { key: 'contrato_ref',   header: 'Contrato Ref',          width: 28 },
    { key: 'nf_num',         header: 'NF No',                 width: 14 },
    { key: 'tomador',        header: 'Tomador / Cliente',      width: 38 },
    { key: 'cnpj_tomador',   header: 'CNPJ Tomador',          width: 18 },
    { key: 'competencia',    header: 'Competencia NF',         width: 16 },
    { key: 'mes_ref_serv',   header: 'Mes Ref. Servico',       width: 18 },
    { key: 'data_emissao',   header: 'Data Emissao',           width: 14 },
    { key: 'data_pagto',     header: 'Data Pagamento',         width: 16 },
    { key: 'ja_tributado',   header: 'Ja Tributado?',          width: 14 },
    { key: 'vbruto',         header: 'Valor Bruto (R$)',       width: 18, sum: true, numFmt: '#,##0.00' },
    { key: 'viss',           header: 'ISS Retido (R$)',        width: 16, sum: true, numFmt: '#,##0.00' },
    { key: 'vir',            header: 'IR Retido (R$)',         width: 15, sum: true, numFmt: '#,##0.00' },
    { key: 'vcsll',          header: 'CSLL Retido (R$)',       width: 16, sum: true, numFmt: '#,##0.00' },
    { key: 'vpis_ret',       header: 'PIS Retido (R$)',        width: 15, sum: true, numFmt: '#,##0.00' },
    { key: 'vcofins_ret',    header: 'COFINS Retida (R$)',     width: 18, sum: true, numFmt: '#,##0.00' },
    { key: 'vinss',          header: 'INSS Retido (R$)',       width: 16, sum: true, numFmt: '#,##0.00' },
    { key: 'ret_total',      header: 'Total Retencoes (R$)',   width: 20, sum: true, numFmt: '#,##0.00' },
    { key: 'vliq',           header: 'Vlr Liq. Recebido (R$)',width: 22, sum: true, numFmt: '#,##0.00' },
    { key: 'pis_proprio',    header: `PIS ${(cfg.pisPct*100).toFixed(2)}% (R$)`,        width: 18, sum: true, numFmt: '#,##0.00' },
    { key: 'cofins_prop',    header: `COFINS ${(cfg.cofinsPct*100).toFixed(2)}% (R$)`,  width: 20, sum: true, numFmt: '#,##0.00' },
    { key: 'pis_liq',        header: 'PIS Liq. a Pagar (R$)',    width: 20, sum: true, numFmt: '#,##0.00' },
    { key: 'cofins_liq',     header: 'COFINS Liq. a Pagar (R$)', width: 22, sum: true, numFmt: '#,##0.00' },
    { key: 'tipo_match',     header: 'Tipo Vinculacao',        width: 20 },
    { key: 'historico',      header: 'Historico Banco',        width: 40 },
    { key: 'discriminacao',  header: 'Discriminacao NF',       width: 40 },
  ];
  autoWidth(wsNfs, colsNf);

  const hdrNf = wsNfs.addRow(colsNf.map(c => c.header));
  styleHeader(hdrNf);
  wsNfs.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: colsNf.length } };

  // Ordena por contrato_ref → data_pagto
  const rowsOrdenadosNf = [...rows].sort((a,b) =>
    (a.contrato_ref||'').localeCompare(b.contrato_ref||'') ||
    (a.data_pagto||'').localeCompare(b.data_pagto||''));

  let lastContrato = null;
  let grupoRows = [];
  let grupoLabel = '';

  function flushGrupo() {
    if (!grupoRows.length) return;
    // Adicionar linha de subtotal
    addSubtotalRow(wsNfs, `  Subtotal: ${grupoLabel}`, colsNf, grupoRows);
    grupoRows = [];
  }

  rowsOrdenadosNf.forEach((r, i) => {
    if (r.contrato_ref !== lastContrato) {
      flushGrupo();
      lastContrato = r.contrato_ref;
      grupoLabel   = r.contrato_ref;
    }
    const rr = wsNfs.addRow(colsNf.map(c => r[c.key]));
    colsNf.forEach((c, ci) => {
      if (c.numFmt) { rr.getCell(ci+1).numFmt = c.numFmt; rr.getCell(ci+1).alignment = { horizontal: 'right', vertical: 'middle' }; }
    });
    const bg = r.ja_tributado === 'SIM' ? COR.tributado_fundo : (i%2===0 ? COR.tributar_fundo : 'E1F5E3');
    applyRowStyle(rr, bg, 9);
    const cellTribt = rr.getCell(9); // coluna ja_tributado
    cellTribt.font = { bold: true, size: 9, name: 'Calibri', color: { argb: r.ja_tributado === 'SIM' ? '7B6000' : '1B5E20' } };
    grupoRows.push(r);
  });
  flushGrupo();

  if (rows.length) addTotalRow(wsNfs, 'TOTAL GERAL', colsNf, rows);

  // ════════════════════════════════════════════════════════════════════════════
  // ABA 3: APURAÇÃO FISCAL (box DARF no topo + seções + AutoFilter)
  // ════════════════════════════════════════════════════════════════════════════
  const wsCalc = wb.addWorksheet('3. Apuracao Fiscal');

  // Box DARF no topo (antes do freeze)
  const darfLinhas3 = [
    { label: `PIS  — Codigo DARF ${cfg.codigoDarfPis}`,   valor: `R$ ${fmtR(totalPisRecolher)}` },
    { label: `COFINS — Codigo DARF ${cfg.codigoDarfCofins}`, valor: `R$ ${fmtR(totalCofinsRecolher)}` },
    { label: 'Periodo de apuracao', valor: PERIODO_APURACAO },
    { label: 'Data de vencimento', valor: VENCTO_DARF },
  ];

  // Título box DARF
  wsCalc.mergeCells('A1:N1');
  const cellBoxTit = wsCalc.getCell('A1');
  cellBoxTit.value = 'DARF — VALORES A RECOLHER';
  cellBoxTit.font  = { bold: true, size: 12, color: { argb: COR.header_txt }, name: 'Calibri' };
  cellBoxTit.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.header_azul } };
  cellBoxTit.alignment = { horizontal: 'center', vertical: 'middle' };
  wsCalc.getRow(1).height = 28;

  darfLinhas3.forEach((linha, idx) => {
    const rowNum = 2 + idx;
    wsCalc.mergeCells(`A${rowNum}:G${rowNum}`);
    wsCalc.mergeCells(`H${rowNum}:N${rowNum}`);
    const c1 = wsCalc.getCell(`A${rowNum}`);
    const c2 = wsCalc.getCell(`H${rowNum}`);
    c1.value = linha.label;
    c2.value = linha.valor;
    c1.font  = { bold: true, size: 11, name: 'Calibri' };
    c2.font  = { bold: true, size: 11, name: 'Calibri', color: { argb: COR.kpi_vermelho } };
    c1.fill  = c2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9E6' } };
    c1.border = c2.border = borderAll('F9A825');
    c1.alignment = { vertical: 'middle', horizontal: 'left' };
    c2.alignment = { vertical: 'middle', horizontal: 'right' };
    wsCalc.getRow(rowNum).height = 22;
  });

  // Linha separadora
  wsCalc.addRow([]);

  // Header da tabela na linha 7
  const colsCalc = [
    { key: 'competencia',  header: 'Competencia NF',       width: 16 },
    { key: 'mes_ref_serv', header: 'Mes Ref. Servico',     width: 18 },
    { key: 'contrato_ref', header: 'Contrato',              width: 26 },
    { key: 'nf_num',       header: 'NF No',                 width: 14 },
    { key: 'tomador',      header: 'Tomador',               width: 35 },
    { key: 'data_pagto',   header: 'Data Recebimento',      width: 18 },
    { key: 'vliq',         header: 'Base de Calculo (R$)',       width: 22, sum: true, numFmt: '#,##0.00' },
    { key: 'vpis_ret',     header: 'PIS Retido Tomador (R$)',    width: 24, sum: true, numFmt: '#,##0.00' },
    { key: 'vcofins_ret',  header: 'COFINS Retida Tomador (R$)', width: 28, sum: true, numFmt: '#,##0.00' },
    { key: 'pis_proprio',  header: `PIS ${(cfg.pisPct*100).toFixed(2)}% s/ Base (R$)`,     width: 24, sum: true, numFmt: '#,##0.00' },
    { key: 'cofins_prop',  header: `COFINS ${(cfg.cofinsPct*100).toFixed(2)}% s/ Base (R$)`, width: 26, sum: true, numFmt: '#,##0.00' },
    { key: 'pis_liq',      header: 'PIS Liq. a Recolher (R$)',    width: 24, sum: true, numFmt: '#,##0.00' },
    { key: 'cofins_liq',   header: 'COFINS Liq. a Recolher (R$)', width: 26, sum: true, numFmt: '#,##0.00' },
    { key: 'ja_tributado', header: 'Situacao',               width: 16 },
  ];
  autoWidth(wsCalc, colsCalc);

  const hdrCalc = wsCalc.addRow(colsCalc.map(c => c.header));
  styleHeader(hdrCalc);

  // Congelar a partir da linha do header (linha 7)
  wsCalc.views = [{ state: 'frozen', ySplit: hdrCalc.number, xSplit: 0, activeCell: `A${hdrCalc.number+1}` }];
  wsCalc.autoFilter = { from: { row: hdrCalc.number, column: 1 }, to: { row: hdrCalc.number, column: colsCalc.length } };

  const rowsOrdenados = [...rows].sort((a,b) => {
    if (a.ja_tributado !== b.ja_tributado) return a.ja_tributado === 'SIM' ? 1 : -1;
    return (a.ano_emissao||'').localeCompare(b.ano_emissao||'') || (a.contrato_ref||'').localeCompare(b.contrato_ref||'');
  });

  let secaoAtual = null;
  rowsOrdenados.forEach((r, i) => {
    const secao = r.ja_tributado === 'SIM' ? 'JA TRIBUTADO' : 'TRIBUTAR AGORA';
    if (secao !== secaoAtual) {
      secaoAtual = secao;
      const labelSec = r.ja_tributado === 'SIM'
        ? `NF EMITIDA EM ANO ANTERIOR — JA TRIBUTADO (imposto declarado em ${r.ano_emissao || 'ano anterior'})`
        : `NF EMITIDA EM ${ANO_ARG} — TRIBUTAR AGORA (incluir no DARF de ${MES_LABEL})`;
      const rSec = wsCalc.addRow([labelSec]);
      wsCalc.mergeCells(`A${rSec.number}:N${rSec.number}`);
      rSec.font   = { bold: true, size: 10, name: 'Calibri', color: { argb: r.ja_tributado === 'SIM' ? '6B4F0C' : '1A5722' } };
      rSec.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: r.ja_tributado === 'SIM' ? 'FFF8E1' : 'E8F5E9' } };
      rSec.height = 24;
    }
    const rr = wsCalc.addRow(colsCalc.map(c => r[c.key]));
    colsCalc.forEach((c, ci) => {
      if (c.numFmt) { rr.getCell(ci+1).numFmt = c.numFmt; rr.getCell(ci+1).alignment = { horizontal: 'right', vertical: 'middle' }; }
    });
    const bg = r.ja_tributado === 'SIM' ? COR.tributado_fundo : (i%2===0 ? COR.tributar_fundo : 'E1F5E3');
    applyRowStyle(rr, bg, 9);
    const cellSit = rr.getCell(14);
    cellSit.font = { bold: true, size: 9, name: 'Calibri', color: { argb: r.ja_tributado === 'SIM' ? '7B6000' : '1B5E20' } };
  });

  if (rows.length) addTotalRow(wsCalc, 'TOTAL GERAL', colsCalc, rows);

  // ════════════════════════════════════════════════════════════════════════════
  // ABA 4: CRÉDITOS SEM NF (com AutoFilter + Ação Recomendada + agrupamento por categoria)
  // ════════════════════════════════════════════════════════════════════════════
  const wsSem = wb.addWorksheet('4. Creditos sem NF');
  freezeHeader(wsSem);

  const colsSem = [
    { key: 'categoria',  header: 'Categoria',         width: 22 },
    { key: 'data',       header: 'Data',               width: 14 },
    { key: 'valor',      header: 'Valor (R$)',          width: 18, sum: true, numFmt: '#,##0.00' },
    { key: 'contrato',   header: 'Contrato',            width: 35 },
    { key: 'historico',  header: 'Historico Banco',     width: 60 },
    { key: 'acao',       header: 'Acao Recomendada',    width: 50 },
  ];
  autoWidth(wsSem, colsSem);
  const hdrSem = wsSem.addRow(colsSem.map(c => c.header));
  styleHeader(hdrSem, COR.header_cinza);
  wsSem.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: colsSem.length } };

  // Agrupar por categoria
  const categoriaOrder = ['CONTA VINCULADA','RESGATE GARANTIA','INVESTIMENTO','INTERNO','DESBLOQUEIO JUDICIAL','VERIFICAR'];
  const porCat = new Map();
  for (const r of semNfRows) {
    const k = r.categoria;
    if (!porCat.has(k)) porCat.set(k, []);
    porCat.get(k).push(r);
  }

  const ordemCat = [...categoriaOrder, ...[...porCat.keys()].filter(k => !categoriaOrder.includes(k))];
  let rowIndexSem = 0;
  for (const cat of ordemCat) {
    if (!porCat.has(cat)) continue;
    const catRows = porCat.get(cat);
    // Label de categoria
    const rCatLbl = wsSem.addRow([`  ${cat} (${catRows.length} lançamentos)`]);
    wsSem.mergeCells(`A${rCatLbl.number}:F${rCatLbl.number}`);
    rCatLbl.font = { bold: true, size: 10, name: 'Calibri', color: { argb: '263238' } };
    rCatLbl.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'CFD8DC' } };
    rCatLbl.height = 20;

    catRows.forEach((r, i) => {
      const rr = wsSem.addRow(colsSem.map(c => r[c.key]));
      colsSem.forEach((c, ci) => {
        if (c.numFmt) { rr.getCell(ci+1).numFmt = c.numFmt; rr.getCell(ci+1).alignment = { horizontal: 'right', vertical: 'middle' }; }
      });
      applyRowStyle(rr, i%2===0 ? COR.alt_row : 'FFFFFF', 9);
      rowIndexSem++;
    });
  }
  if (semNfRows.length) addTotalRow(wsSem, 'TOTAL', colsSem, semNfRows);

  // ════════════════════════════════════════════════════════════════════════════
  // ABA 5: NFs A RECEBER
  // ════════════════════════════════════════════════════════════════════════════
  const wsRec = wb.addWorksheet('5. NFs a Receber');
  freezeHeader(wsRec);

  const colsRec = [
    { key: 'nf_num',       header: 'NF No',             width: 14 },
    { key: 'tomador',      header: 'Tomador',            width: 38 },
    { key: 'contrato_ref', header: 'Contrato',           width: 28 },
    { key: 'competencia',  header: 'Competencia',        width: 16 },
    { key: 'data_emissao', header: 'Data Emissao',       width: 14 },
    { key: 'vbruto',       header: 'Valor Bruto (R$)',   width: 18, sum: true, numFmt: '#,##0.00' },
    { key: 'vliq',         header: 'Valor Liq. (R$)',    width: 18, sum: true, numFmt: '#,##0.00' },
    { key: 'status',       header: 'Status',             width: 16 },
    { key: 'dias_aberto',  header: 'Dias em Aberto',     width: 16 },
  ];
  autoWidth(wsRec, colsRec);

  const hdrRec = wsRec.addRow(colsRec.map(c => c.header));
  styleHeader(hdrRec, COR.header_laranja);
  wsRec.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: colsRec.length } };

  aReceberRows.forEach((r, i) => {
    const rr = wsRec.addRow(colsRec.map(c => r[c.key]));
    colsRec.forEach((c, ci) => {
      if (c.numFmt) { rr.getCell(ci+1).numFmt = c.numFmt; rr.getCell(ci+1).alignment = { horizontal: 'right', vertical: 'middle' }; }
    });
    if (r.em_atraso) {
      // NF com > 60 dias em aberto: linha vermelha
      rr.font = { size: 9, name: 'Calibri', color: { argb: COR.atraso_txt }, bold: true };
      rr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.atraso_fundo } };
      rr.eachCell(c => { c.border = borderAll('EF9A9A'); });
    } else {
      applyRowStyle(rr, i%2===0 ? COR.alt_row : 'FFFFFF', 9);
    }
  });

  if (aReceberRows.length) {
    addTotalRow(wsRec, 'TOTAL A RECEBER', colsRec, aReceberRows);
  } else {
    const rVazio = wsRec.addRow(['Nenhuma NF em aberto nos últimos 6 meses.']);
    wsRec.mergeCells(`A${rVazio.number}:I${rVazio.number}`);
    rVazio.font = { italic: true, size: 10, name: 'Calibri', color: { argb: '78909C' } };
    rVazio.height = 24;
  }

  // ── Salvar ─────────────────────────────────────────────────────────────────
  const outDir  = path.join(__dirname, '..', 'relatorios');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `receita_federal_${nomeEmpresa}_${ANO_ARG}-${MES_ARG}.xlsx`);
  await wb.xlsx.writeFile(outFile);
  console.log(`  OK: relatorios/receita_federal_${nomeEmpresa}_${ANO_ARG}-${MES_ARG}.xlsx`);
  return outFile;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const empresasAlvo = EMPRESA_ARG === 'todas'
    ? Object.keys(CONFIG_EMPRESAS)
    : [EMPRESA_ARG];

  for (const emp of empresasAlvo) {
    const cfg = CONFIG_EMPRESAS[emp];
    if (!cfg) { console.log(`  AVISO: Empresa desconhecida: ${emp}`); continue; }
    const data = buildEmpresaData(emp, cfg);
    if (data) await gerarXlsxEmpresa(data);
  }

  console.log('\n  Concluido.\n');
})();
