'use strict';
/**
 * Relatório de Conciliação Financeira — Montana Assessoria
 * Gera XLSX com 6 abas para auditoria interna e contabilidade.
 *
 * Uso:
 *   node scripts/gerar_relatorio_conciliacao.js [--ano=2025] [--empresa=assessoria]
 *   node scripts/gerar_relatorio_conciliacao.js --ano=2024 --empresa=assessoria
 *   node scripts/gerar_relatorio_conciliacao.js --empresa=seguranca
 *
 * Saída: relatorios/conciliacao_<empresa>_<ano>.xlsx
 *
 * Abas:
 *   1. Resumo          — sumário executivo + breakdown por contrato
 *   2. NFs Conciliadas — por contrato/cliente, com referência extrato e boletim
 *   3. NFs Pendentes   — por contrato/cliente, com dias em aberto
 *   4. Por Contrato    — totais conciliado vs pendente por contrato
 *   5. Extrato Creditos — todos os créditos bancários do ano
 *   6. Por Tomador-Mes  — agrupado por tomador × mês × status
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs   = require('fs');
const XLSX = require('xlsx');
const { getDb } = require('../src/db');

// ── Parâmetros ────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v || true]; })
);
const EMPRESA = args.empresa || 'assessoria';
const ANO     = args.ano     || String(new Date().getFullYear());
const AnoInt  = parseInt(ANO);

const db = getDb(EMPRESA);
console.log(`\n  📊 Relatório Conciliação — ${EMPRESA.toUpperCase()} ${ANO}`);

// ── Helpers ───────────────────────────────────────────────────────────────────
const R    = v  => Number(v || 0);
const fmtD = iso => iso ? iso.replace(/(\d{4})-(\d{2})-(\d{2})/, '$3/$2/$1') : '';
const fmtR = v  => R(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
const today = new Date();
const diasAberto = iso => {
  if (!iso) return '';
  const d = Math.floor((today - new Date(iso)) / 86400000);
  return d >= 0 ? d : '';
};

// ── Período ───────────────────────────────────────────────────────────────────
const dataIni = `${ANO}-01-01`;
const dataFim = `${ANO}-12-31`;

// ── Mapa de contratos (numContrato → { contrato, cnpj }) ─────────────────────
const contratosMap = new Map();
try {
  db.prepare('SELECT numContrato, contrato, orgao FROM contratos').all()
    .forEach(c => contratosMap.set(c.numContrato, { nome: c.contrato, cnpj: c.orgao || '' }));
} catch (_) {}

// Helper para resolver nome e CNPJ do contrato
function resolveContrato(ref) {
  const c = contratosMap.get(ref || '');
  return {
    nomeContrato: c ? c.nome : (ref || '(sem contrato)'),
    cnpjContrato: c ? c.cnpj : '',
  };
}

// ── Mapa de boletins por nf_numero ───────────────────────────────────────────
// bol_boletins_nfs → bol_boletins → bol_contratos
const bolMap = new Map(); // nf_numero → "COMPETENCIA / STATUS"
try {
  const bolRows = db.prepare(`
    SELECT bbn.nf_numero, bb.competencia, bb.status, bc.numero_contrato
    FROM bol_boletins_nfs bbn
    JOIN bol_boletins bb ON bbn.boletim_id = bb.id
    JOIN bol_contratos bc ON bb.contrato_id = bc.id
  `).all();
  for (const b of bolRows) {
    const key = (b.nf_numero || '').trim();
    if (!bolMap.has(key)) {
      bolMap.set(key, `${b.competencia || ''} [${b.status || ''}]`);
    }
  }
} catch (_) {}

// ── Aba 2: NFs CONCILIADAS ────────────────────────────────────────────────────
const nfsConcil = db.prepare(`
  SELECT
    nf.id,
    nf.numero,
    nf.tomador,
    nf.cnpj_tomador,
    nf.data_emissao,
    nf.competencia,
    nf.valor_bruto,
    nf.valor_liquido,
    nf.status_conciliacao,
    nf.discriminacao,
    nf.contrato_ref
  FROM notas_fiscais nf
  WHERE nf.status_conciliacao = 'CONCILIADO'
    AND nf.data_emissao >= ? AND nf.data_emissao <= ?
  ORDER BY nf.contrato_ref, nf.tomador, nf.data_emissao
`).all(dataIni, dataFim);

// Índice extratos conciliados por valor → lista de { id, data_iso, credito, historico }
const extratosConc = db.prepare(`
  SELECT id, data_iso, credito, historico, contrato_vinculado
  FROM extratos
  WHERE status_conciliacao = 'CONCILIADO'
    AND credito > 0
    AND data_iso >= ? AND data_iso <= ?
  ORDER BY data_iso
`).all(`${AnoInt - 1}-10-01`, `${AnoInt + 1}-03-31`);

const extMap = new Map(); // credito.toFixed(2) → [{ id, data_iso, credito, historico }]
for (const e of extratosConc) {
  const k = e.credito.toFixed(2);
  if (!extMap.has(k)) extMap.set(k, []);
  extMap.get(k).push(e);
}

// Para cada NF conciliada, encontra o extrato mais próximo por valor+data
const abaRecebimentos = nfsConcil.map(nf => {
  const vliq = R(nf.valor_liquido || nf.valor_bruto);
  const key  = vliq.toFixed(2);
  const cands = extMap.get(key) || [];
  const emMs  = nf.data_emissao ? new Date(nf.data_emissao).getTime() : 0;
  let melhor = null, menorDif = Infinity;
  for (const e of cands) {
    const d = Math.abs(new Date(e.data_iso).getTime() - emMs);
    if (d < menorDif) { melhor = e; menorDif = d; }
  }
  const { nomeContrato, cnpjContrato } = resolveContrato(nf.contrato_ref);
  const bolRef = bolMap.get((nf.numero || '').trim()) || '';
  return {
    'Contrato Ref':          nf.contrato_ref || '(sem contrato)',
    'Contrato Nome':         nomeContrato,
    'CNPJ Contratante':      cnpjContrato,
    'NF Nº':                 nf.numero || '',
    'Tomador / Cliente':     nf.tomador || '',
    'CNPJ Tomador':          nf.cnpj_tomador || '',
    'Competência':           nf.competencia || '',
    'Data Emissão NF':       fmtD(nf.data_emissao),
    'Valor Bruto NF (R$)':   fmtR(nf.valor_bruto),
    'Valor Líquido NF (R$)': fmtR(nf.valor_liquido || nf.valor_bruto),
    'Data Recebimento':      melhor ? fmtD(melhor.data_iso) : '(a identificar)',
    'Valor Recebido (R$)':   melhor ? fmtR(melhor.credito) : '',
    'Diferença (R$)':        melhor ? fmtR(R(melhor.credito) - vliq) : '',
    'Histórico Banco':       melhor ? (melhor.historico || '').substring(0, 100) : '',
    'ID Extrato':            melhor ? melhor.id : '',
    'Contrato Extrato':      melhor ? (melhor.contrato_vinculado || '') : '',
    'Ref Boletim':           bolRef,
    'Status':                'CONCILIADO',
    'Discriminação NF':      (nf.discriminacao || '').substring(0, 100),
  };
});

// ── Aba 3: NFs PENDENTES ──────────────────────────────────────────────────────
const nfsPend = db.prepare(`
  SELECT numero, tomador, cnpj_tomador, data_emissao, competencia,
         valor_bruto, valor_liquido, discriminacao, contrato_ref
  FROM notas_fiscais
  WHERE (status_conciliacao = 'PENDENTE' OR status_conciliacao IS NULL)
    AND data_emissao >= ? AND data_emissao <= ?
    AND valor_bruto > 100
  ORDER BY contrato_ref, tomador, data_emissao
`).all(dataIni, dataFim);

const abaPendentes = nfsPend.map(nf => {
  const { nomeContrato, cnpjContrato } = resolveContrato(nf.contrato_ref);
  const bolRef = bolMap.get((nf.numero || '').trim()) || '';
  return {
    'Contrato Ref':          nf.contrato_ref || '(sem contrato)',
    'Contrato Nome':         nomeContrato,
    'CNPJ Contratante':      cnpjContrato,
    'NF Nº':                 nf.numero || '',
    'Tomador / Cliente':     nf.tomador || '',
    'CNPJ Tomador':          nf.cnpj_tomador || '',
    'Competência':           nf.competencia || '',
    'Data Emissão':          fmtD(nf.data_emissao),
    'Valor Bruto (R$)':      fmtR(nf.valor_bruto),
    'Valor Líquido (R$)':    fmtR(nf.valor_liquido || nf.valor_bruto),
    'Dias em Aberto':        diasAberto(nf.data_emissao),
    'Ref Boletim':           bolRef,
    'Status':                'PENDENTE',
    'Discriminação NF':      (nf.discriminacao || '').substring(0, 100),
  };
});

// ── Aba 4: POR CONTRATO ───────────────────────────────────────────────────────
// Totais conciliado × pendente por contrato_ref
const porContratoRaw = db.prepare(`
  SELECT
    contrato_ref,
    status_conciliacao,
    COUNT(*) qtd,
    SUM(valor_bruto)   total_bruto,
    SUM(valor_liquido) total_liq
  FROM notas_fiscais
  WHERE data_emissao >= ? AND data_emissao <= ?
    AND valor_bruto > 100
  GROUP BY contrato_ref, status_conciliacao
  ORDER BY contrato_ref, status_conciliacao
`).all(dataIni, dataFim);

// Pivot: contrato_ref → { CONCILIADO: {qtd, bruto, liq}, PENDENTE: ... }
const porContratoMap = new Map();
for (const r of porContratoRaw) {
  const ref = r.contrato_ref || '(sem contrato)';
  if (!porContratoMap.has(ref)) porContratoMap.set(ref, {});
  porContratoMap.get(ref)[r.status_conciliacao || 'PENDENTE'] = {
    qtd: r.qtd, bruto: R(r.total_bruto), liq: R(r.total_liq)
  };
}

const abaPorContrato = [];
for (const [ref, statusMap] of porContratoMap) {
  const { nomeContrato, cnpjContrato } = resolveContrato(ref);
  const conc = statusMap['CONCILIADO'] || { qtd: 0, bruto: 0, liq: 0 };
  const pend = statusMap['PENDENTE']   || { qtd: 0, bruto: 0, liq: 0 };
  const totalQtd   = conc.qtd + pend.qtd;
  const totalBruto = conc.bruto + pend.bruto;
  const pctConc    = totalBruto > 0 ? (conc.bruto / totalBruto * 100).toFixed(1) + '%' : '—';
  abaPorContrato.push({
    'Contrato Ref':             ref,
    'Contrato Nome':            nomeContrato,
    'CNPJ Contratante':         cnpjContrato,
    'Qtd NFs Total':            totalQtd,
    'Qtd NFs Conciliadas':      conc.qtd,
    'Total Líq Conciliado (R$)': fmtR(conc.liq),
    'Total Bruto Conciliado (R$)': fmtR(conc.bruto),
    'Qtd NFs Pendentes':        pend.qtd,
    'Total Líq Pendente (R$)':  fmtR(pend.liq),
    'Total Bruto Pendente (R$)': fmtR(pend.bruto),
    '% Conciliado (bruto)':     pctConc,
  });
}

// ── Aba 5: Extrato Créditos ───────────────────────────────────────────────────
const todosCreditos = db.prepare(`
  SELECT id, data_iso, credito, historico, status_conciliacao, contrato_vinculado
  FROM extratos
  WHERE credito > 0
    AND data_iso >= ? AND data_iso <= ?
  ORDER BY data_iso
`).all(dataIni, dataFim);

const abaExtrato = todosCreditos.map(e => ({
  'Data':              fmtD(e.data_iso),
  'Valor (R$)':        fmtR(e.credito),
  'Histórico':         (e.historico || '').substring(0, 130),
  'Contrato Vinculado': e.contrato_vinculado || '',
  'Status Concil.':    e.status_conciliacao || 'PENDENTE',
  'ID Extrato':        e.id,
}));

// ── Aba 6: Por Tomador × Mês ──────────────────────────────────────────────────
const resumo = db.prepare(`
  SELECT
    contrato_ref,
    tomador,
    substr(data_emissao, 1, 7) mes,
    status_conciliacao,
    COUNT(*) qtd_nfs,
    SUM(valor_liquido) total_liquido,
    SUM(valor_bruto)   total_bruto
  FROM notas_fiscais
  WHERE data_emissao >= ? AND data_emissao <= ?
    AND valor_bruto > 100
  GROUP BY contrato_ref, tomador, mes, status_conciliacao
  ORDER BY contrato_ref, tomador, mes
`).all(dataIni, dataFim);

const abaResumo = resumo.map(r => {
  const { nomeContrato } = resolveContrato(r.contrato_ref);
  return {
    'Contrato Ref':      r.contrato_ref || '(sem contrato)',
    'Contrato Nome':     nomeContrato,
    'Tomador / Cliente': r.tomador || '',
    'Mês':               r.mes || '',
    'Status':            r.status_conciliacao || 'PENDENTE',
    'Qtd NFs':           r.qtd_nfs,
    'Total Líquido (R$)': fmtR(r.total_liquido),
    'Total Bruto (R$)':   fmtR(r.total_bruto),
  };
});

// ── Totais para o resumo executivo ────────────────────────────────────────────
const totConc = nfsConcil.reduce((s, n) => s + R(n.valor_liquido || n.valor_bruto), 0);
const totPend = nfsPend.reduce((s, n)   => s + R(n.valor_liquido || n.valor_bruto), 0);
const totCred = todosCreditos.reduce((s, e) => s + R(e.credito), 0);

// Breakdown de conciliados por contrato (para o resumo)
const concilPorContrato = new Map();
for (const nf of nfsConcil) {
  const ref = nf.contrato_ref || '(sem contrato)';
  if (!concilPorContrato.has(ref)) concilPorContrato.set(ref, { qtd: 0, total: 0 });
  const c = concilPorContrato.get(ref);
  c.qtd++;
  c.total += R(nf.valor_liquido || nf.valor_bruto);
}

// ── Montagem do XLSX ──────────────────────────────────────────────────────────
const wb = XLSX.utils.book_new();

function addSheet(wb, data, name) {
  if (data.length === 0) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['(sem dados)']]), name);
    return;
  }
  const ws = XLSX.utils.json_to_sheet(data);
  // Ajuste de largura de colunas (auto-fit aproximado)
  const cols = Object.keys(data[0]).map(k => ({
    wch: Math.max(k.length, 14)
  }));
  ws['!cols'] = cols;
  XLSX.utils.book_append_sheet(wb, ws, name);
}

// ── Aba 1: Capa / Resumo executivo ────────────────────────────────────────────
const capaDados = [
  ['RELATÓRIO DE CONCILIAÇÃO FINANCEIRA'],
  [`Empresa: MONTANA ${EMPRESA.toUpperCase()}`],
  [`Período: ${ANO}`],
  [`Gerado em: ${new Date().toLocaleString('pt-BR')}`],
  [],
  ['RESUMO EXECUTIVO', '', ''],
  ['Item', 'Qtd NFs', 'Valor Líquido (R$)'],
  ['NFs CONCILIADAS (pagas)',   nfsConcil.length, fmtR(totConc)],
  ['NFs PENDENTES (a receber)', nfsPend.length,   fmtR(totPend)],
  [],
  ['CRÉDITOS BANCÁRIOS NO PERÍODO', '', ''],
  ['Total créditos recebidos', todosCreditos.length, fmtR(totCred)],
  ['  → Conciliados com NF',
    todosCreditos.filter(e => e.status_conciliacao === 'CONCILIADO').length,
    fmtR(todosCreditos.filter(e => e.status_conciliacao === 'CONCILIADO').reduce((s,e) => s+R(e.credito),0))],
  ['  → Transferências internas (INTERNO)',
    todosCreditos.filter(e => e.status_conciliacao === 'INTERNO').length,
    fmtR(todosCreditos.filter(e => e.status_conciliacao === 'INTERNO').reduce((s,e) => s+R(e.credito),0))],
  ['  → Aplicações financeiras (INVESTIMENTO)',
    todosCreditos.filter(e => e.status_conciliacao === 'INVESTIMENTO').length,
    fmtR(todosCreditos.filter(e => e.status_conciliacao === 'INVESTIMENTO').reduce((s,e) => s+R(e.credito),0))],
  ['  → Não identificados (PENDENTE)',
    todosCreditos.filter(e => !e.status_conciliacao || e.status_conciliacao === 'PENDENTE').length,
    fmtR(todosCreditos.filter(e => !e.status_conciliacao || e.status_conciliacao === 'PENDENTE').reduce((s,e) => s+R(e.credito),0))],
  [],
  ['CONCILIADAS POR CONTRATO', '', ''],
  ['Contrato', 'Qtd NFs', 'Total Líquido (R$)'],
  ...[...concilPorContrato.entries()]
      .sort((a,b) => b[1].total - a[1].total)
      .map(([ref, v]) => {
        const { nomeContrato } = resolveContrato(ref);
        return [`${ref} — ${nomeContrato}`, v.qtd, fmtR(v.total)];
      }),
];
const wsCapa = XLSX.utils.aoa_to_sheet(capaDados);
wsCapa['!cols'] = [{ wch: 55 }, { wch: 12 }, { wch: 22 }];
XLSX.utils.book_append_sheet(wb, wsCapa, '1. Resumo');

addSheet(wb, abaRecebimentos, '2. NFs Conciliadas');
addSheet(wb, abaPendentes,    '3. NFs Pendentes');
addSheet(wb, abaPorContrato,  '4. Por Contrato');
addSheet(wb, abaExtrato,      '5. Extrato Creditos');
addSheet(wb, abaResumo,       '6. Por Tomador-Mes');

// ── Salvar ────────────────────────────────────────────────────────────────────
const outDir = path.join(__dirname, '..', 'relatorios');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `conciliacao_${EMPRESA}_${ANO}.xlsx`);
XLSX.writeFile(wb, outFile);

console.log(`\n  ✅ Arquivo: relatorios/conciliacao_${EMPRESA}_${ANO}.xlsx`);
console.log(`\n  📋 RESUMO ${ANO}:`);
console.log(`     NFs conciliadas:  ${nfsConcil.length.toString().padStart(5)}  →  ${fmtR(totConc)}`);
console.log(`     NFs pendentes:    ${nfsPend.length.toString().padStart(5)}  →  ${fmtR(totPend)}`);
console.log(`     Créditos banco:   ${todosCreditos.length.toString().padStart(5)}  →  ${fmtR(totCred)}`);
console.log(`\n  📑 CONCILIADAS POR CONTRATO:`);
[...concilPorContrato.entries()]
  .sort((a,b) => b[1].total - a[1].total)
  .forEach(([ref, v]) => {
    console.log(`     ${ref.padEnd(35)} ${v.qtd.toString().padStart(5)} NFs  →  ${fmtR(v.total)}`);
  });
console.log('');
