'use strict';
/**
 * Relatório para Receita Federal — NFs Pagas por Competência
 * Identifica nota por nota qual mês de serviço cada recebimento representa.
 *
 * Uso:
 *   node scripts/gerar_relatorio_receita_federal.js [--mes=03] [--ano=2026] [--empresa=assessoria|seguranca|todas]
 *
 * Saída: relatorios/receita_federal_<empresa>_<ano>-<mes>.xlsx
 *
 * Abas:
 *   1. Resumo          — totais por empresa × competência × situação tributária
 *   2. Assessoria      — NFs pagas no mês, nota a nota, ordenado por competência
 *   3. Segurança       — idem
 *   4. PIS-COFINS Calc — apuração PIS/COFINS Assessoria (Lucro Real, regime de caixa)
 *   5. Créditos s/ NF  — créditos bancários do mês sem NF correspondente identificada
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs   = require('fs');
const XLSX = require('xlsx');
const { getDb } = require('../src/db');

// ── Parâmetros ─────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k,v] = a.slice(2).split('='); return [k, v||true]; })
);
const MES_ARG    = String(args.mes  || '03').padStart(2, '0');
const ANO_ARG    = String(args.ano  || '2026');
const EMPRESA_ARG = args.empresa || 'todas';
const MES_LABEL  = `${ANO_ARG}-${MES_ARG}`;
const DATA_INI   = `${ANO_ARG}-${MES_ARG}-01`;
const DATA_FIM   = `${ANO_ARG}-${MES_ARG}-31`;

console.log(`\n  📑 Relatório Receita Federal — recebimentos ${MES_LABEL}`);

// ── Helpers ───────────────────────────────────────────────────────────────────
const R    = v  => Number(v || 0);
const fmtD = iso => iso ? iso.replace(/(\d{4})-(\d{2})-(\d{2})/, '$3/$2/$1') : '';
const fmtR = v  => R(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
const pct  = (v, base) => base > 0 ? (v / base * 100).toFixed(2) + '%' : '0,00%';

// Identifica ano da competência a partir de "2025-03" ou "03/2025"
function anoCompetencia(comp) {
  if (!comp) return '';
  const m = comp.match(/(\d{4})/);
  return m ? m[1] : '';
}

// ── Extrai palavra-chave do nome de contrato para matching fuzzy ──────────────
// Ex: "DETRAN 41/2023 + 2°TA" → "DETRAN"
//     "SEDUC Limpeza/Copeiragem" → "SEDUC"
const PALAVRAS_CONTRATO = ['DETRAN','UNITINS','SESAU','SEDUC','UFT','UFNT','TCE','SEMARH',
  'CBMTO','FUNJURIS','TJ','PREFEITURA','PREVI','MUNICIPIO'];
function kwContrato(s) {
  const up = (s||'').toUpperCase();
  return PALAVRAS_CONTRATO.find(kw => up.includes(kw)) || '';
}

// ── Lógica central: NFs pagas no mês ─────────────────────────────────────────
// Etapa 1: matching individual por valor exato (Pix UFT/UFNT)
// Etapa 2: matching em lote por contrato keyword + janela de data (TEDs Estado)
// Deduplicação prévia dos extratos (mesmo TED importado 2× — pipe e nopipe)
function nfsPagasNoMes(db, dataIni, dataFim) {
  // Extratos CONCILIADOS no mês — deduplicados por (data_iso, credito arredondado)
  // Quando há duplicata, prioriza o que tem contrato_vinculado preenchido
  const extRaw = db.prepare(`
    SELECT id, data_iso, credito, historico, contrato_vinculado
    FROM extratos
    WHERE status_conciliacao = 'CONCILIADO'
      AND credito > 0
      AND data_iso >= ? AND data_iso <= ?
    ORDER BY data_iso, (contrato_vinculado <> '') DESC
  `).all(dataIni, dataFim);

  const extDedup = new Map(); // "data|valor" → extrato
  for (const e of extRaw) {
    const k = `${e.data_iso}|${R(e.credito).toFixed(2)}`;
    if (!extDedup.has(k) || (!extDedup.get(k).contrato_vinculado && e.contrato_vinculado)) {
      extDedup.set(k, e);
    }
  }
  const extMes = [...extDedup.values()].sort((a, b) => new Date(a.data_iso) - new Date(b.data_iso));

  // NFs CONCILIADAS emitidas nos últimos 9 meses
  const janelaIni = new Date(dataFim);
  janelaIni.setMonth(janelaIni.getMonth() - 9);
  const janelaIniStr = janelaIni.toISOString().substring(0, 10);

  const nfsConcil = db.prepare(`
    SELECT id, numero, tomador, cnpj_tomador, competencia,
           data_emissao, valor_bruto, valor_liquido,
           inss, ir, iss, csll, pis, cofins, retencao,
           contrato_ref, discriminacao
    FROM notas_fiscais
    WHERE status_conciliacao = 'CONCILIADO'
      AND data_emissao >= ?
    ORDER BY contrato_ref, competencia, data_emissao
  `).all(janelaIniStr);

  const pareados  = [];
  const usadosExt = new Set();
  const usadosNf  = new Set();

  // ── Etapa 1: matching individual por valor exato ───────────────────────────
  const extPorValor = new Map(); // valor → [extrato]
  for (const e of extMes) {
    const k = R(e.credito).toFixed(2);
    if (!extPorValor.has(k)) extPorValor.set(k, []);
    extPorValor.get(k).push(e);
  }

  for (const nf of nfsConcil) {
    const vliq  = R(nf.valor_liquido || nf.valor_bruto);
    const cands = (extPorValor.get(vliq.toFixed(2)) || []).filter(e => !usadosExt.has(e.id));
    if (!cands.length) continue;
    const emMs = nf.data_emissao ? new Date(nf.data_emissao).getTime() : 0;
    let melhor = cands[0], menorDif = Infinity;
    for (const e of cands) {
      const d = Math.abs(new Date(e.data_iso).getTime() - emMs);
      if (d < menorDif) { melhor = e; menorDif = d; }
    }
    usadosExt.add(melhor.id);
    usadosNf.add(nf.id);
    pareados.push({ nf, extrato: melhor, tipo: 'individual' });
  }

  // ── Etapa 2: TEDs em lote — matching por keyword de contrato + janela ──────
  // Não exige que a soma das NFs iguale o TED; usa keyword do contrato_vinculado
  // para identificar quais NFs do mesmo contrato foram cobertas por esse TED.
  const semNf = [];

  for (const ext of extMes.filter(e => !usadosExt.has(e.id))) {
    const kwExt = kwContrato(ext.contrato_vinculado) || kwContrato(ext.historico);
    if (!kwExt) { semNf.push(ext); continue; }

    const extDt = new Date(ext.data_iso);
    const dtMin = new Date(extDt); dtMin.setDate(dtMin.getDate() - 90);
    const dtMax = new Date(extDt); dtMax.setDate(dtMax.getDate() + 30);
    const dtMinS = dtMin.toISOString().substring(0, 10);
    const dtMaxS = dtMax.toISOString().substring(0, 10);

    // NFs com mesma keyword de contrato na janela, ainda não pareadas
    const nfsMatch = nfsConcil.filter(nf =>
      !usadosNf.has(nf.id) &&
      kwContrato(nf.contrato_ref) === kwExt &&
      nf.data_emissao >= dtMinS &&
      nf.data_emissao <= dtMaxS
    );

    if (!nfsMatch.length) { semNf.push(ext); continue; }

    for (const nf of nfsMatch) {
      usadosNf.add(nf.id);
      pareados.push({ nf, extrato: ext, tipo: 'lote-TED' });
    }
    usadosExt.add(ext.id);
  }

  return { pareados, extSemNf: semNf };
}

// ── Processa uma empresa ───────────────────────────────────────────────────────
function processarEmpresa(nomeEmpresa, regime) {
  let db;
  try { db = getDb(nomeEmpresa); } catch (_) { return null; }

  console.log(`\n  🏢 ${nomeEmpresa.toUpperCase()} (${regime})`);

  const { pareados, extSemNf } = nfsPagasNoMes(db, DATA_INI, DATA_FIM);

  // Monta linhas do relatório
  const linhas = pareados.map(({ nf, extrato, tipo }) => {
    // Competência: usa campo direto ou infere da data de emissão
    const compFinal = nf.competencia || (nf.data_emissao ? nf.data_emissao.substring(0, 7) : '');
    const anoComp   = anoCompetencia(compFinal);
    const jaTribt   = anoComp && anoComp < ANO_ARG ? 'SIM — já tributado em ' + anoComp : 'NÃO — tributar em ' + ANO_ARG;
    const vbruto    = R(nf.valor_bruto);
    const vliq      = R(nf.valor_liquido || nf.valor_bruto);
    const retTotal  = R(nf.retencao) || (R(nf.ir) + R(nf.csll) + R(nf.pis) + R(nf.cofins) + R(nf.inss) + R(nf.iss));
    const diferenca = R(extrato.credito) - vliq;

    // PIS/COFINS a apurar (só Assessoria / Lucro Real / regime de caixa)
    let pisProprio = 0, cofinsPropria = 0, pisLiq = 0, cofinsLiq = 0;
    if (regime === 'Lucro Real') {
      pisProprio  = vliq * 0.0165;
      cofinsPropria = vliq * 0.0760;
      pisLiq      = pisProprio  - R(nf.pis);   // deduz retenção já retida
      cofinsLiq   = cofinsPropria - R(nf.cofins);
    }

    return {
      // Identificação
      'Empresa':           nomeEmpresa.charAt(0).toUpperCase() + nomeEmpresa.slice(1),
      'Regime':            regime,
      'Contrato Ref':      nf.contrato_ref || '(sem contrato)',
      'NF Nº':             nf.numero || '',
      'Tomador':           nf.tomador || '',
      'CNPJ Tomador':      nf.cnpj_tomador || '',
      // Datas e competência — ponto central para a Receita
      'Competência NF':    compFinal,
      'Ano Competência':   anoComp,
      'Data Emissão NF':   fmtD(nf.data_emissao),
      'Data Pagamento':    fmtD(extrato.data_iso),
      'Tipo Match':        tipo || 'individual',
      'Já Tributado?':     jaTribt,
      // Valores
      'Valor Bruto (R$)':  fmtR(vbruto),
      'ISS Retido (R$)':   fmtR(nf.iss),
      'IR Retido (R$)':    fmtR(nf.ir),
      'CSLL Retido (R$)':  fmtR(nf.csll),
      'PIS Retido (R$)':   fmtR(nf.pis),
      'COFINS Retido (R$)':fmtR(nf.cofins),
      'INSS Retido (R$)':  fmtR(nf.inss),
      'Total Retenções (R$)': fmtR(retTotal),
      'Valor Líq. Recebido (R$)': fmtR(vliq),
      'Valor Extrato (R$)': fmtR(extrato.credito),
      'Diferença (R$)':    fmtR(diferenca),
      // PIS/COFINS (só Assessoria)
      ...(regime === 'Lucro Real' ? {
        'PIS 1,65% s/VL (R$)':     fmtR(pisProprio),
        'COFINS 7,60% s/VL (R$)':  fmtR(cofinsPropria),
        'PIS Líq. a Pagar (R$)':   fmtR(Math.max(0, pisLiq)),
        'COFINS Líq. a Pagar (R$)':fmtR(Math.max(0, cofinsLiq)),
      } : {}),
      'Histórico Banco':   (extrato.historico || '').substring(0, 100),
      'Discriminação NF':  (nf.discriminacao || '').substring(0, 100),
    };
  });

  // Categoriza créditos sem NF para o contador
  function categorizarCredito(e) {
    const h = (e.historico || '').toUpperCase();
    const c = (e.contrato_vinculado || '').toUpperCase();
    if (c.includes('CONTA VINCULADA') || c.includes('VINCULADA'))
      return '🔒 CONTA VINCULADA — depósito escrow (não tributável, não emite NF)';
    if (h.includes('RESGATE') && h.includes('GARANTIA'))
      return '🔒 RESGATE DEPÓSITO GARANTIA — devolução de caução (não tributável)';
    if (h.includes('MONTANA') || h.includes('TRANSFERÊNCIA INTERNA') || h.includes('0151'))
      return '🔄 TRANSFERÊNCIA INTERNA — entre contas Montana (não tributável)';
    if (h.includes('BACEN') || h.includes('JUDICIAL'))
      return '⚖️ DESBLOQUEIO JUDICIAL — verificar NF correspondente';
    return '⚠️  VERIFICAR — possível NF não importada ou pagamento sem NF emitida';
  }

  const linhasSemNf = extSemNf.map(e => ({
    'Data Crédito':    fmtD(e.data_iso),
    'Valor (R$)':      fmtR(e.credito),
    'Contrato':        e.contrato_vinculado || '',
    'Histórico':       (e.historico || '').substring(0, 120),
    'Categorização':   categorizarCredito(e),
  }));

  // Sumário
  const nfAno = (ano) => linhas.filter(l => l['Ano Competência'] === ano);
  const soma  = (lista, campo) => lista.reduce((s, l) => s + R(parseFloat((l[campo]||'0').replace(/\./g,'').replace(',','.'))), 0);

  const anos = [...new Set(linhas.map(l => l['Ano Competência']).filter(Boolean))].sort();

  console.log(`  → ${linhas.length} NFs pagas em ${MES_LABEL} | ${extSemNf.length} créditos sem NF individual`);
  anos.forEach(ano => {
    const nfs = nfAno(ano);
    console.log(`     Competência ${ano}: ${nfs.length} NFs (${ano < ANO_ARG ? 'já tributado' : 'tributar agora'})`);
  });

  return { linhas, linhasSemNf, nomeEmpresa, regime };
}

// ── Empresas a processar ──────────────────────────────────────────────────────
const CONFIG_EMPRESAS = {
  assessoria: 'Lucro Real',
  seguranca:  'Simples Nacional',
};

const empresasAlvo = EMPRESA_ARG === 'todas'
  ? Object.keys(CONFIG_EMPRESAS)
  : [EMPRESA_ARG];

const resultados = empresasAlvo
  .map(e => processarEmpresa(e, CONFIG_EMPRESAS[e] || 'Simples Nacional'))
  .filter(Boolean);

// ── Montagem do XLSX ──────────────────────────────────────────────────────────
const wb = XLSX.utils.book_new();

function addSheet(wb, data, name) {
  if (!data || data.length === 0) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['(sem dados)']]), name);
    return;
  }
  const ws = XLSX.utils.json_to_sheet(data);
  const cols = Object.keys(data[0]).map(k => ({ wch: Math.max(k.length, 14) }));
  ws['!cols'] = cols;
  XLSX.utils.book_append_sheet(wb, ws, name);
}

// ── Aba 1: Resumo ─────────────────────────────────────────────────────────────
const resumoLinhas = [
  [`RELATÓRIO FISCAL — NFs PAGAS EM ${MES_LABEL.toUpperCase()}`],
  [`Gerado em: ${new Date().toLocaleString('pt-BR')}`],
  [`Base legal: Lucro Real, regime de caixa (Lei 10.833/2003 art. 10 §2°)`],
  [],
  ['EMPRESA', 'REGIME', 'COMPETÊNCIA NF', 'QTD NFs', 'VALOR BRUTO (R$)', 'VALOR LÍQ. (R$)', 'SITUAÇÃO TRIBUTÁRIA'],
];

for (const res of resultados) {
  // Agrupa por competência
  const porComp = new Map();
  for (const l of res.linhas) {
    const comp = l['Competência NF'] || '(sem comp.)';
    const anoC = l['Ano Competência'] || '';
    if (!porComp.has(comp)) porComp.set(comp, { qtd: 0, bruto: 0, liq: 0, anoC });
    const c = porComp.get(comp);
    c.qtd++;
    c.bruto += R(parseFloat((l['Valor Bruto (R$)']||'0').replace(/\./g,'').replace(',','.')));
    c.liq   += R(parseFloat((l['Valor Líq. Recebido (R$)']||'0').replace(/\./g,'').replace(',','.')));
  }

  for (const [comp, v] of [...porComp.entries()].sort()) {
    const situacao = v.anoC && v.anoC < ANO_ARG
      ? `✅ JÁ TRIBUTADO (${v.anoC})`
      : `⚠️  TRIBUTAR AGORA (${ANO_ARG})`;
    resumoLinhas.push([
      res.nomeEmpresa.toUpperCase(), res.regime, comp,
      v.qtd, fmtR(v.bruto), fmtR(v.liq), situacao,
    ]);
  }

  if (res.linhasSemNf.length) {
    resumoLinhas.push([
      res.nomeEmpresa.toUpperCase(), res.regime,
      '(TED em lote — sem NF individual)', res.linhasSemNf.length,
      fmtR(res.linhasSemNf.reduce((s,l) => s + R(parseFloat((l['Valor (R$)']||'0').replace(/\./g,'').replace(',','.'))), 0)),
      '', '⚠️  VERIFICAR MANUALMENTE',
    ]);
  }
  resumoLinhas.push([]);
}

const wsResumo = XLSX.utils.aoa_to_sheet(resumoLinhas);
wsResumo['!cols'] = [{ wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 10 }, { wch: 22 }, { wch: 22 }, { wch: 35 }];
XLSX.utils.book_append_sheet(wb, wsResumo, '1. Resumo');

// ── Abas por empresa ──────────────────────────────────────────────────────────
resultados.forEach((res, i) => {
  const abaNum = i + 2;
  const nome   = res.nomeEmpresa.charAt(0).toUpperCase() + res.nomeEmpresa.slice(1);
  addSheet(wb, res.linhas, `${abaNum}. ${nome}`);
});

// ── Aba PIS/COFINS Assessoria ─────────────────────────────────────────────────
const resAssessoria = resultados.find(r => r.nomeEmpresa === 'assessoria');
if (resAssessoria && resAssessoria.regime === 'Lucro Real') {
  const calcLinhas = [
    ['APURAÇÃO PIS/COFINS — ASSESSORIA (Lucro Real, Regime de Caixa)'],
    [`Mês de recebimento: ${MES_LABEL}`],
    [`Alíquotas próprias: PIS 1,65% | COFINS 7,60%`],
    [`Retenções dedutíveis: PIS 0,65% (tomadores federais) | COFINS 3,00% (tomadores federais)`],
    [],
  ];

  // Agrupar por situação tributária
  const grupos = [
    { label: `COMPETÊNCIA ${ANO_ARG} — TRIBUTAR AGORA`, filtro: l => l['Ano Competência'] === ANO_ARG },
    { label: 'COMPETÊNCIA ANOS ANTERIORES — JÁ TRIBUTADO (verificar se havia retenção)', filtro: l => l['Ano Competência'] && l['Ano Competência'] < ANO_ARG },
  ];

  let totalPisAPagar = 0, totalCofinsAPagar = 0, totalBaseCalculo = 0;

  for (const grupo of grupos) {
    const nfs = resAssessoria.linhas.filter(grupo.filtro);
    if (!nfs.length) continue;

    calcLinhas.push([grupo.label]);
    calcLinhas.push(['NF Nº', 'Tomador', 'Competência', 'Data Pgto', 'Valor Líq. (R$)', 'PIS Ret. (R$)', 'COFINS Ret. (R$)', 'PIS 1,65% (R$)', 'COFINS 7,60% (R$)', 'PIS Líq. (R$)', 'COFINS Líq. (R$)']);

    let subPis = 0, subCofins = 0, subBase = 0;
    for (const l of nfs) {
      const vl     = R(parseFloat((l['Valor Líq. Recebido (R$)']||'0').replace(/\./g,'').replace(',','.')));
      const pRet   = R(parseFloat((l['PIS Retido (R$)']||'0').replace(/\./g,'').replace(',','.')));
      const cRet   = R(parseFloat((l['COFINS Retido (R$)']||'0').replace(/\./g,'').replace(',','.')));
      const pProp  = vl * 0.0165;
      const cProp  = vl * 0.0760;
      const pLiq   = Math.max(0, pProp - pRet);
      const cLiq   = Math.max(0, cProp - cRet);
      subPis   += pLiq;
      subCofins += cLiq;
      subBase  += vl;
      calcLinhas.push([l['NF Nº'], l['Tomador'], l['Competência NF'], l['Data Pagamento'],
        fmtR(vl), fmtR(pRet), fmtR(cRet), fmtR(pProp), fmtR(cProp), fmtR(pLiq), fmtR(cLiq)]);
    }
    calcLinhas.push(['SUBTOTAL', '', '', '', fmtR(subBase), '', '', fmtR(subBase*0.0165), fmtR(subBase*0.0760), fmtR(subPis), fmtR(subCofins)]);
    calcLinhas.push([]);

    // Acumula total apenas para NFs do ano corrente (tributar agora)
    if (grupo.label.includes(ANO_ARG) && grupo.label.includes('TRIBUTAR')) {
      totalBaseCalculo += subBase;
      totalPisAPagar   += subPis;
      totalCofinsAPagar += subCofins;
    }
  }

  calcLinhas.push(['TOTAL A APURAR (competência ' + ANO_ARG + ')', '', '', '', fmtR(totalBaseCalculo), '', '', fmtR(totalBaseCalculo*0.0165), fmtR(totalBaseCalculo*0.0760), fmtR(totalPisAPagar), fmtR(totalCofinsAPagar)]);

  const wsPis = XLSX.utils.aoa_to_sheet(calcLinhas);
  wsPis['!cols'] = [{ wch: 16 }, { wch: 40 }, { wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 14 }, { wch: 16 }, { wch: 18 }, { wch: 20 }, { wch: 18 }, { wch: 20 }];
  XLSX.utils.book_append_sheet(wb, wsPis, `${resultados.length + 2}. PIS-COFINS Assessoria`);
}

// ── Aba créditos sem NF ───────────────────────────────────────────────────────
const todasSemNf = resultados.flatMap(r =>
  r.linhasSemNf.map(l => ({ 'Empresa': r.nomeEmpresa, ...l }))
);
if (todasSemNf.length) {
  addSheet(wb, todasSemNf, `${resultados.length + 3}. Creditos sem NF`);
}

// ── Salvar ─────────────────────────────────────────────────────────────────────
const outDir = path.join(__dirname, '..', 'relatorios');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const suffix  = EMPRESA_ARG === 'todas' ? 'todas' : EMPRESA_ARG;
const outFile = path.join(outDir, `receita_federal_${suffix}_${ANO_ARG}-${MES_ARG}.xlsx`);
XLSX.writeFile(wb, outFile);

console.log(`\n  ✅ Arquivo: relatorios/receita_federal_${suffix}_${ANO_ARG}-${MES_ARG}.xlsx\n`);
