/**
 * Relatório de Apuração PIS/COFINS — Regime de Caixa
 * Lei 10.833/2003 art. 10 §2° — contratos com entes públicos
 *
 * Uso:
 *   node scripts/gerar_relatorio_apuracao.js --mes=3 --ano=2026
 *   node scripts/gerar_relatorio_apuracao.js --mes=4 --ano=2026 --empresa=seguranca
 *   node scripts/gerar_relatorio_apuracao.js --mes=3 --ano=2026 --empresa=todas
 *
 * --empresa: assessoria (padrão) | seguranca | todas
 * Sem argumentos = mês anterior ao atual, empresa assessoria
 */

const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const Database = require('better-sqlite3');
const ExcelJS  = require('exceljs');

// ── PARÂMETROS ───────────────────────────────────────────────────
const args = process.argv.slice(2);
const argMap = {};
args.forEach(a => { const [k,v] = a.replace(/^--/,'').split('='); argMap[k]=v; });

const hoje  = new Date();
const mesArg = argMap.mes ? parseInt(argMap.mes) : (hoje.getMonth() === 0 ? 12 : hoje.getMonth());
const anoArg = argMap.ano ? parseInt(argMap.ano) : (hoje.getMonth() === 0 ? hoje.getFullYear()-1 : hoje.getFullYear());
const empArg = (argMap.empresa || 'assessoria').toLowerCase();

if (mesArg < 1 || mesArg > 12) { console.error('Mês inválido. Use --mes=1..12'); process.exit(1); }

// ── CADASTRO DE EMPRESAS ─────────────────────────────────────────
const EMPRESAS = {
  assessoria: {
    key:  'assessoria',
    nome: 'Montana Assessoria Empresarial Ltda',
    cnpj: '14.092.519/0001-51',
    db:   path.join(__dirname, '../data/assessoria/montana.db'),
    simples_cnpjs: new Set(['32062391000165','39775237000180']), // Nevada, Montreal
    regime: 'Lucro Real — Não Cumulativo',
    pis_aliq:    0.0165,   // 1,65%
    cofins_aliq: 0.0760,   // 7,60%
    darf_pis:    '6912',   // PIS não-cumulativo
    darf_cofins: '5856',   // COFINS não-cumulativo
    gera_credito_fornecedor: true,   // pode creditar PIS/COFINS de fornecedores não-Simples
  },
  seguranca: {
    key:  'seguranca',
    nome: 'Montana Segurança Patrimonial Ltda',
    cnpj: '19.200.109/0001-09',
    db:   path.join(__dirname, '../data/seguranca/montana.db'),
    simples_cnpjs: new Set(),
    regime: 'Lucro Real Anual — Cumulativo',
    pis_aliq:    0.0065,   // 0,65%
    cofins_aliq: 0.03,     // 3,00%
    darf_pis:    '8109',   // PIS cumulativo
    darf_cofins: '2172',   // COFINS cumulativo
    gera_credito_fornecedor: false,  // cumulativo → não há crédito de PIS/COFINS
  },
};

const empresasRodar = empArg === 'todas'
  ? Object.values(EMPRESAS)
  : [EMPRESAS[empArg]].filter(Boolean);

if (empresasRodar.length === 0) {
  console.error('Empresa inválida. Use: assessoria | seguranca | todas');
  process.exit(1);
}

// ── HELPERS ──────────────────────────────────────────────────────
const MES_NOMES = ['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO',
                   'JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];
const MES_ABREV = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];

const BRL = '#,##0.00';
const BLUE='FF1D4ED8', GRAY='FF475569', GREEN='FF15803D', AMBER='FFD97706', RED='FFB91C1C';
const WHITE='FFFFFFFF', LBLUE='FFDBEAFE', LGREEN='FFF0FDF4', LGRAY='FFF1F5F9';
const LYELLOW='FFFEF9C3', LRED='FFFEE2E2';
const bdr = { style:'thin', color:{argb:'FFE2E8F0'} };
const BORDER = { top:bdr, left:bdr, bottom:bdr, right:bdr };

function fmtDt(d)    { return d ? d.slice(8,10)+'/'+d.slice(5,7)+'/'+d.slice(0,4) : ''; }
function brl_fmt(v)  { return v != null ? v.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}) : '0,00'; }

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
  row.height = 28;
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
  // Arredonda defensivamente para 2 casas — evita resíduos de ponto flutuante (ex: 968386.5800000002)
  const v = (typeof val === 'number' && !Number.isNaN(val)) ? Math.round(val * 100) / 100 : val;
  setCell(ws, rowNum, colNum, v, BRL, bgColor, fontColor, bold, 'right');
}

// ── FUNÇÃO PRINCIPAL ─────────────────────────────────────────────
async function gerarRelatorio(empresa) {
  const dataInicio = `${anoArg}-${String(mesArg).padStart(2,'0')}-01`;
  const ultimoDia  = new Date(anoArg, mesArg, 0).getDate();
  const dataFim    = `${anoArg}-${String(mesArg).padStart(2,'0')}-${String(ultimoDia).padStart(2,'0')}`;
  const mesVenc    = mesArg === 12 ? 1 : mesArg + 1;
  const anoVenc    = mesArg === 12 ? anoArg + 1 : anoArg;
  const dataVenc   = `25/${String(mesVenc).padStart(2,'0')}/${anoVenc}`;
  const COMP_LABEL = `${MES_NOMES[mesArg-1]}/${anoArg}`;
  const COMP_ABREV = `${MES_ABREV[mesArg-1]}${anoArg}`;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${empresa.nome}`);
  console.log(`  ${COMP_LABEL} — Regime de Caixa (Lei 10.833/2003 art. 10 §2°)`);
  console.log(`${'═'.repeat(60)}`);

  const db = new Database(empresa.db);

  // ── EXTRATOS DO MÊS ──────────────────────────────────────────
  const rawCreditos = db.prepare(`
    SELECT id, data_iso, historico, credito, status_conciliacao, contrato_vinculado,
           pagador_identificado, pagador_cnpj, pagador_metodo
    FROM extratos
    WHERE data_iso BETWEEN ? AND ? AND credito > 0
    ORDER BY data_iso, credito DESC
  `).all(dataInicio, dataFim);

  // Deduplicar (mesmo lançamento em 2 CSVs — um com pipe `|`, outro sem)
  // Chave robusta: remove TODO caractere não-alfanumérico ANTES de slice, para que "Ordem Bancária | MUNI..."
  // e "Ordem Bancária MUNICIPIO..." gerem a mesma chave normalizada.
  const chavesSeen = new Set();
  const creditosUnicos = [];
  for (const c of rawCreditos) {
    const histNorm = (c.historico||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,30);
    const chave = `${c.data_iso}|${c.credito.toFixed(2)}|${histNorm}`;
    if (!chavesSeen.has(chave)) { chavesSeen.add(chave); creditosUnicos.push(c); }
  }

  function tipoCredito(c) {
    const h  = (c.historico||'').toUpperCase();
    const st = (c.status_conciliacao||'').toUpperCase();
    if (['INTERNO','TRANSFERENCIA','INVESTIMENTO'].includes(st)) return st;
    if (h.includes('RENDE FACIL') || h.includes('APLICACAO'))    return 'INVESTIMENTO';
    if (h.includes('MONTANA S') || h.includes('MONTANA SERV') || h.includes('MONTANA SEG') || h.includes('MONTANA ASSES')) return 'INTERNO';
    if (h.includes(empresa.cnpj.replace(/\D/g,''))) return 'INTERNO';
    return 'RECEITA';
  }

  // Identificação de tomador em 3 camadas:
  //  1) Se NF(s) foram vinculadas ao extrato → usa tomador das NFs (fonte confiável)
  //  2) Campo pagador_identificado/pagador_cnpj (pré-classificado no extrato)
  //  3) Heurística por histórico
  const nfsPorExtratoMap = new Map(); // ext_id → [tomadores únicos]
  {
    const rows = db.prepare(`
      SELECT extrato_id, tomador, cnpj_tomador FROM notas_fiscais
      WHERE extrato_id IS NOT NULL AND status_conciliacao NOT IN ('CANCELADA','ASSESSORIA')
    `).all();
    for (const r of rows) {
      if (!nfsPorExtratoMap.has(r.extrato_id)) nfsPorExtratoMap.set(r.extrato_id, new Set());
      nfsPorExtratoMap.get(r.extrato_id).add(r.tomador || '?');
    }
  }

  function identificarTomador(c) {
    // Camada 1: NFs vinculadas (mais confiável)
    const tomadoresNFs = nfsPorExtratoMap.get(c.id);
    if (tomadoresNFs && tomadoresNFs.size > 0) {
      const arr = [...tomadoresNFs];
      if (arr.length === 1) return arr[0];
      return arr.slice(0,2).join(' + ') + (arr.length>2 ? ` +${arr.length-2}` : '');
    }
    // Camada 2: pagador_identificado pré-classificado
    if (c.pagador_identificado) {
      return c.pagador_cnpj
        ? `${c.pagador_identificado} (${c.pagador_cnpj})`
        : c.pagador_identificado;
    }
    // Camada 3: heurística por histórico
    const h = (c.historico||'').toUpperCase();
    if (h.includes('05149726') || h.includes('FUNDACAO UN'))           return 'UFT — Fundação Univ. Federal do Tocantins';
    if (h.includes('TCE') || h.includes('TRIBUNAL DE CONTAS'))         return 'TCE/TO — Tribunal de Contas';
    if (h.includes('MUNICIPIO DE PALMAS') || h.includes('ORDENS BANC'))return 'Município de Palmas';
    if (h.includes('GOVERNO DO EST') || h.includes('070 0380') || h.includes('01786029')) return 'Governo do Estado do Tocantins';
    if (h.includes('SEC TES NAC') || h.includes('381788'))             return 'Secretaria do Tesouro Nacional (Federal)';
    if (h.includes('BACEN') || h.includes('JUDICIAL'))                 return 'Desbloqueio Judicial — BacenJud';
    if (h.includes('MINISTERIO PUBLICO') || h.includes('PROCURADORIA'))return 'MP/TO — Ministério Público';
    if (c.contrato_vinculado) return c.contrato_vinculado;
    return 'Não identificado';
  }

  const receitas = creditosUnicos.filter(c => tipoCredito(c) === 'RECEITA');
  const internos = creditosUnicos.filter(c => tipoCredito(c) === 'INTERNO');
  const invest   = creditosUnicos.filter(c => tipoCredito(c) === 'INVESTIMENTO');
  const sumCaixaBruto = receitas.reduce((s,c) => s+c.credito, 0);

  // ── MATCHING NFs → PAGAMENTOS ────────────────────────────────
  // Tenta usar apenas CONCILIADO; se poucos, usa todas as NFs
  // Janela temporal: NFs emitidas nos 6 meses anteriores + mês corrente
  // (evita falso-positivo de NFs antigas sendo "re-conciliadas" com pagamentos de meses posteriores
  // que na verdade pagam NFs de períodos diferentes)
  const dtJanInicio = new Date(anoArg, mesArg - 7, 1).toISOString().slice(0,10);
  const dtJanFim    = dataFim;

  const nfsConciliadas = db.prepare(`
    SELECT id, numero, data_emissao, data_pagamento, tomador, contrato_ref, status_conciliacao,
           valor_bruto, valor_liquido, retencao, pis, cofins, inss, ir, iss, csll
    FROM notas_fiscais
    WHERE status_conciliacao = 'CONCILIADO'
      AND data_emissao BETWEEN ? AND ?
    ORDER BY data_emissao ASC
  `).all(dtJanInicio, dtJanFim);

  // Usa TODAS as não-canceladas (conciliadas + pendentes) para permitir matching amplo.
  // Subset-sum escolhe apenas as que batem com os créditos do mês.
  // Excluir ASSESSORIA (contaminação WebISS — NFs que pertencem à Assessoria, importadas no banco Segurança).
  const todasNFs = db.prepare(`
    SELECT id, numero, data_emissao, data_pagamento, tomador, contrato_ref, status_conciliacao,
           valor_bruto, valor_liquido, retencao, pis, cofins, inss, ir, iss, csll
    FROM notas_fiscais
    WHERE status_conciliacao NOT IN ('CANCELADA','ASSESSORIA')
      AND data_emissao BETWEEN ? AND ?
    ORDER BY data_emissao ASC
  `).all(dtJanInicio, dtJanFim);

  const usouTodasNFs = nfsConciliadas.length === 0;
  const qtdConciliadas = nfsConciliadas.length;
  const qtdPendentes   = todasNFs.length - qtdConciliadas;
  console.log(`  NFs disponíveis para matching: ${todasNFs.length} (${qtdConciliadas} conciliadas + ${qtdPendentes} pendentes na janela)`);

  function tomadorGrupo(hist) {
    const h = (hist||'').toUpperCase();
    if (h.includes('05149726') || h.includes('FUNDACAO UN'))           return 'UFT';
    if (h.includes('MUNICIPIO DE PALMAS') || h.includes('ORDENS BANC')|| (h.includes('ORDEM BANC') && h.includes('PALMAS'))) return 'PALMAS';
    if (h.includes('070 0380') || h.includes('01786029') || h.includes('GOVERNO DO EST') || h.includes('ESTADO DO TOCANTINS')) return 'ESTADO';
    if (h.includes('SEC TES NAC') || h.includes('381788'))             return 'FEDERAL';
    if (h.includes('PROCURADORIA') || h.includes('MINISTERIO PUBLICO') || h.includes(' MP ')) return 'MP';
    return null;
  }

  function nfMatchGrupo(tom, grupo) {
    const t = (tom||'').toUpperCase();
    if (!grupo)         return true;
    if (grupo==='UFT')   return t.includes('UFT') || t.includes('FUNDACAO UNIVER');
    if (grupo==='PALMAS')return t.includes('PALMAS') || t.includes('PREVI') || t.includes('SEMUS') || t.includes('DETRAN') || t.includes('MUNICIPIO') || t.includes('ATCP') || t.includes('FCP') || t.includes('ARCES');
    if (grupo==='ESTADO')return t.includes('DETRAN') || t.includes('UNITINS') || t.includes('TCE') || t.includes('CBMTO') || t.includes('SEMARH') || t.includes('SEDUC') || t.includes('SESAU') || t.includes('SEPLAD') || t.includes('CORPO DE BOMBEIRO');
    if (grupo==='FEDERAL')return t.includes('UFNT') || t.includes('UFT');
    if (grupo==='MP')    return t.includes('PROCURADORIA') || t.includes('MINISTERIO') || t.includes('MP');
    return true;
  }

  const extReceita = receitas.sort((a,b) => a.data_iso.localeCompare(b.data_iso));
  const nfsPagas   = [];
  const nfsUsadas  = new Set();

  // Pass 0: NFs cuja data_pagamento JÁ cai no mês de apuração — match direto sem heurística
  for (const n of todasNFs) {
    if (nfsUsadas.has(n.id)) continue;
    if (!n.data_pagamento) continue;
    if (n.data_pagamento < dataInicio || n.data_pagamento > dataFim) continue;
    nfsUsadas.add(n.id);
    nfsPagas.push({...n, data_pagamento: n.data_pagamento, match_tipo: 'PAG'});
  }

  // Pass 1: match 1:1 por valor_liquido ≈ extrato.credito (±R$0,10)
  // Preferir NFs recentes (mais próximas do mês de apuração) — evita re-conciliar NFs antigas
  for (const ext of extReceita) {
    const cands = todasNFs
      .filter(n => !nfsUsadas.has(n.id) && Math.abs(n.valor_liquido - ext.credito) <= 0.10)
      .sort((a,b) => b.data_emissao.localeCompare(a.data_emissao));
    if (cands.length > 0) {
      nfsUsadas.add(cands[0].id);
      nfsPagas.push({...cands[0], data_pagamento: ext.data_iso, match_tipo: '1:1'});
    }
  }

  // Pass 2: SUBSET-SUM — tenta achar combinação de 2..6 NFs cuja soma ≈ crédito (±0,5%)
  // Exemplo típico: Palmas OB de R$558.111,42 = 3 × R$186.037,14 (3 competências pagas juntas)
  //                 MP/TO OB de R$ 82.058,25 = 15 × R$ 5.470,55 (15 postos no mesmo dia)
  function buscarSubset(valores, target, tol, maxK) {
    // valores = array de {nf, v}. Retorna array de nfs encontrado ou null
    const N = valores.length;
    if (N === 0) return null;
    // Primeiro: testa se algum combinado de 1..maxK valores bate com target
    // Usa DFS com poda (ordenar desc ajuda)
    valores.sort((a,b) => b.v - a.v);
    let achou = null;
    function dfs(idx, k, soma, picked) {
      if (achou) return;
      if (Math.abs(soma - target) <= tol) { achou = picked.slice(); return; }
      if (k >= maxK) return;
      if (idx >= N) return;
      // Poda: se soma já passou target + tol, sem sentido continuar (valores positivos, desc)
      for (let i = idx; i < N; i++) {
        const novoSoma = soma + valores[i].v;
        // Se já ultrapassou o target + tolerância, próximos (menores) podem completar — mas pulamos só se DEMASIADO além
        if (novoSoma > target + tol && (k+1) < maxK) {
          // Ainda podemos complementar com valores menores? Não — com valores positivos, adicionar mais só aumenta
          // Mas como estão ordenados desc, próximo i terá v menor, pode caber. NÃO podamos aqui.
        }
        picked.push(valores[i].nf);
        dfs(i+1, k+1, novoSoma, picked);
        picked.pop();
        if (achou) return;
      }
    }
    dfs(0, 0, 0, []);
    return achou;
  }

  const naoMatchados = extReceita.filter(ext =>
    !nfsPagas.some(n => (n.match_tipo==='1:1' || n.match_tipo==='PAG') &&
                        Math.abs(n.valor_liquido - ext.credito) <= 0.10 &&
                        n.data_pagamento === ext.data_iso)
  );

  for (const ext of naoMatchados) {
    if (ext.credito < 500) continue; // ignora valores pequenos
    const grupo = tomadorGrupo(ext.historico);
    // NFs candidatas: do grupo (ou todas se grupo null) — até 25 mais recentes
    const cands = todasNFs
      .filter(n => !nfsUsadas.has(n.id) && nfMatchGrupo(n.tomador, grupo))
      .sort((a,b) => b.data_emissao.localeCompare(a.data_emissao))
      .slice(0, 25);

    if (cands.length === 0) continue;

    const tol = Math.max(0.50, ext.credito * 0.005); // 0,5% ou R$0,50
    const valores = cands.map(n => ({ nf: n, v: n.valor_liquido }));

    // Tenta achar subset exato
    let subset = buscarSubset(valores, ext.credito, tol, 8);

    if (subset && subset.length > 0) {
      for (const nf of subset) {
        nfsUsadas.add(nf.id);
        nfsPagas.push({...nf, data_pagamento: ext.data_iso, match_tipo: subset.length===1 ? '1:1' : 'LOTE'});
      }
    } else {
      // Fallback gulosa: consome NFs em ordem decrescente de valor enquanto cabe
      let saldo = ext.credito;
      const ordenadas = cands.filter(n => !nfsUsadas.has(n.id)).sort((a,b) => b.valor_liquido - a.valor_liquido);
      for (const nf of ordenadas) {
        if (saldo < nf.valor_liquido * 0.50) continue;
        if (saldo < nf.valor_liquido - tol) continue; // não pode pegar NF maior que saldo
        nfsUsadas.add(nf.id);
        nfsPagas.push({...nf, data_pagamento: ext.data_iso, match_tipo: 'LOTE_APROX'});
        saldo -= nf.valor_liquido;
        if (saldo < 0.10) break;
      }
    }
  }

  const matchPag    = nfsPagas.filter(n => n.match_tipo === 'PAG').length;
  const match1a1    = nfsPagas.filter(n => n.match_tipo === '1:1').length;
  const matchLote   = nfsPagas.filter(n => n.match_tipo === 'LOTE').length;
  const matchAprox  = nfsPagas.filter(n => n.match_tipo === 'LOTE_APROX').length;

  // ── BASE TRIBUTÁRIA ──────────────────────────────────────────
  const sumNFsPagasBruto   = nfsPagas.reduce((s,n) => s+(n.valor_bruto||0), 0);
  const sumNFsPagasLiquido = nfsPagas.reduce((s,n) => s+(n.valor_liquido||0), 0);

  const ret = nfsPagas.reduce((acc,n) => {
    acc.inss+=n.inss||0; acc.ir+=n.ir||0; acc.iss+=n.iss||0; acc.csll+=n.csll||0;
    acc.pis+=n.pis||0;   acc.cofins+=n.cofins||0; acc.total+=n.retencao||0;
    return acc;
  }, {inss:0,ir:0,iss:0,csll:0,pis:0,cofins:0,total:0});

  const pisBruto    = +(sumNFsPagasBruto * empresa.pis_aliq).toFixed(2);
  const cofinsBruto = +(sumNFsPagasBruto * empresa.cofins_aliq).toFixed(2);
  const pisLiq      = Math.max(+(pisBruto  - ret.pis).toFixed(2), 0);
  const cofinsLiq   = Math.max(+(cofinsBruto - ret.cofins).toFixed(2), 0);

  const nfsPagasLiqTotal = nfsPagas.reduce((s,n) => s+(n.valor_recebido_liq||n.valor_liquido||0), 0);
  const semConciliacao   = Math.max(sumCaixaBruto - nfsPagasLiqTotal, 0);

  // Agrupar NFs por contrato
  const nfPorContrato = {};
  nfsPagas.forEach(n => {
    const k = n.contrato_ref || 'Sem contrato';
    if (!nfPorContrato[k]) nfPorContrato[k] = {n:0,bruto:0,liq:0,ret:0,pis:0,cofins:0,inss:0,ir:0,iss:0,csll:0};
    const g = nfPorContrato[k];
    g.n++; g.bruto+=n.valor_bruto||0; g.liq+=n.valor_liquido||0; g.ret+=n.retencao||0;
    g.pis+=n.pis||0; g.cofins+=n.cofins||0; g.inss+=n.inss||0; g.ir+=n.ir||0; g.iss+=n.iss||0; g.csll+=n.csll||0;
  });

  // Despesas do período
  const despesasPagas = db.prepare(`
    SELECT id, data_iso, cnpj_fornecedor, fornecedor, nf_numero, valor_bruto, competencia, status
    FROM despesas WHERE data_iso BETWEEN ? AND ? AND status IN ('PAGO','DESPESA')
    ORDER BY cnpj_fornecedor, data_iso
  `).all(dataInicio, dataFim);

  const despPorForn = {};
  despesasPagas.forEach(d => {
    const k = d.cnpj_fornecedor || 'sem-cnpj';
    if (!despPorForn[k]) despPorForn[k] = {
      nome: d.fornecedor || k, cnpj: d.cnpj_fornecedor,
      isSimples: empresa.simples_cnpjs.has(d.cnpj_fornecedor),
      n: 0, total: 0, itens: []
    };
    despPorForn[k].n++;
    despPorForn[k].total += d.valor_bruto||0;
    despPorForn[k].itens.push(d);
  });
  const fornOrdenados = Object.values(despPorForn).sort((a,b) => b.total - a.total);

  console.log(`  Match data_pag: ${matchPag} | 1:1: ${match1a1} | Lote subset: ${matchLote} | Lote aprox: ${matchAprox} | Total: ${nfsPagas.length} NFs`);
  console.log(`  Base tributária: R$ ${brl_fmt(sumNFsPagasBruto)} | Retenções: R$ ${brl_fmt(ret.total)}`);
  console.log(`  PIS: R$ ${brl_fmt(pisLiq)} | COFINS: R$ ${brl_fmt(cofinsLiq)}`);
  if (semConciliacao > 500) console.log(`  ⚠️  Não identificados: R$ ${brl_fmt(semConciliacao)}`);

  // ── WORKBOOK ────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Montana ERP'; wb.created = new Date();

  // ── ABA 1 — RESUMO EXECUTIVO ─────────────────────────────────
  const ws1 = wb.addWorksheet('Resumo Executivo');
  ws1.columns = [{width:50},{width:20},{width:20},{width:20}];
  let r = 1;

  ws1.mergeCells(r,1,r,4);
  const tCell = ws1.getRow(r).getCell(1);
  tCell.value = 'RELATÓRIO DE APURAÇÃO PIS/COFINS — REGIME DE CAIXA';
  tCell.font  = {bold:true, size:14, color:{argb:WHITE}};
  tCell.fill  = {type:'pattern', pattern:'solid', fgColor:{argb:BLUE}};
  tCell.alignment = {horizontal:'center', vertical:'middle'};
  ws1.getRow(r).height = 36; r++;

  ws1.mergeCells(r,1,r,4);
  const sCell = ws1.getRow(r).getCell(1);
  sCell.value = `${empresa.nome}  —  CNPJ ${empresa.cnpj}  |  Competência: ${COMP_LABEL}`;
  sCell.font  = {size:10, color:{argb:GRAY}};
  sCell.alignment = {horizontal:'center'};
  ws1.getRow(r).height = 20; r++;

  ws1.mergeCells(r,1,r,4);
  const rCell = ws1.getRow(r).getCell(1);
  rCell.value = `Regime: ${empresa.regime}  |  PIS ${(empresa.pis_aliq*100).toFixed(2).replace('.',',')}% + COFINS ${(empresa.cofins_aliq*100).toFixed(2).replace('.',',')}%  |  Base: NFs PAGAS em ${COMP_LABEL} — Lei 10.833/2003 art. 10 §2°${usouTodasNFs ? '  |  ⚠️ Sem conciliação — NFs emitidas usadas como proxy' : ''}`;
  rCell.font  = {size:9, italic:true, color:{argb:GRAY}};
  rCell.alignment = {horizontal:'center'};
  ws1.getRow(r).height = 18; r += 2;

  // Alerta sem conciliação
  if (usouTodasNFs) {
    ws1.mergeCells(r,1,r,4);
    const alertCell = ws1.getRow(r).getCell(1);
    alertCell.value = `⚠️  ATENÇÃO: ${empresa.nome} não possui NFs conciliadas com extratos bancários. ` +
      `O matching foi realizado usando TODAS as NFs (não canceladas), o que pode incluir NFs de períodos diferentes. ` +
      `Recomenda-se realizar a conciliação bancária para obter a base tributária exata.`;
    alertCell.font  = {size:9, color:{argb:'FF92400E'}};
    alertCell.fill  = {type:'pattern', pattern:'solid', fgColor:{argb:LYELLOW}};
    alertCell.alignment = {wrapText:true, vertical:'middle'};
    alertCell.border = BORDER;
    ws1.getRow(r).height = 48; r += 2;
  }

  // Receita por contrato
  hdrRow(ws1, r, [`RECEITA POR CONTRATO — NFs PAGAS EM ${COMP_LABEL}`, 'Valor Bruto (R$)', 'Retenções (R$)', 'Valor Líquido (R$)'], BLUE); r++;
  Object.entries(nfPorContrato).sort((a,b) => b[1].bruto - a[1].bruto).forEach(([k,v]) => {
    setCell(ws1,r,1,`  ${k}  (${v.n} NF${v.n>1?'s':''})`);
    setMoney(ws1,r,2,v.bruto); setMoney(ws1,r,3,v.ret); setMoney(ws1,r,4,v.liq); r++;
  });
  setCell(ws1,r,1,`TOTAL NFs PAGAS — BASE TRIBUTÁRIA`, null, LBLUE, BLUE, true);
  setMoney(ws1,r,2,sumNFsPagasBruto,LBLUE,BLUE,true);
  setMoney(ws1,r,3,ret.total,LBLUE,BLUE,true);
  setMoney(ws1,r,4,sumNFsPagasLiquido,LBLUE,BLUE,true); r++;

  if (semConciliacao > 500) {
    ws1.mergeCells(r,1,r,4);
    const wCell = ws1.getRow(r).getCell(1);
    wCell.value = `⚠️  R$ ${brl_fmt(semConciliacao)} em créditos bancários de clientes não foram vinculados a NFs — verifique NFs não importadas (ex: contratos sem NF cadastrada). Se houver obrigação tributária nesses valores, a base está subestimada.`;
    wCell.font  = {size:9, color:{argb:'FF92400E'}};
    wCell.fill  = {type:'pattern', pattern:'solid', fgColor:{argb:LYELLOW}};
    wCell.alignment = {wrapText:true, vertical:'middle'};
    wCell.border = BORDER;
    ws1.getRow(r).height = 32; r++;
  }
  r++;

  // Retenções
  hdrRow(ws1, r, [`RETENÇÕES NA FONTE — NFs pagas em ${COMP_LABEL}`, 'Alíquota', 'Valor Retido (R$)', 'Observação'], GRAY); r++;
  [
    ['INSS — Previdência Social',              'Variável', ret.inss,  'Retido pelo tomador — alíquota efetiva varia por contrato'],
    ['IRRF — Imposto de Renda Retido na Fonte','Variável', ret.ir,    'DARF 6147 (1,20% vigilância/limpeza) ou 6190 (4,80% profissional)'],
    ['ISS — Imposto sobre Serviços',           'Variável', ret.iss,   'Município de Palmas / outros — depende do código de serviço'],
    ['CSLL',                                   '1,00%',    ret.csll,  'Tomadores federais (IN RFB 1.234/2012)'],
    ['PIS — crédito retido na fonte',          '0,65%',    ret.pis,   'Tomadores federais — deduz da apuração própria'],
    ['COFINS — crédito retido na fonte',       '3,00%',    ret.cofins,'Tomadores federais — deduz da apuração própria'],
  ].forEach(([desc,aliq,val,obs]) => {
    setCell(ws1,r,1,'  '+desc); setCell(ws1,r,2,aliq,null,null,GRAY);
    setMoney(ws1,r,3,val); setCell(ws1,r,4,obs,null,null,GRAY); r++;
  });
  setCell(ws1,r,1,'TOTAL RETENÇÕES',null,LGRAY,GRAY,true);
  setCell(ws1,r,2,'',null,LGRAY); setMoney(ws1,r,3,ret.total,LGRAY,GRAY,true); setCell(ws1,r,4,'',null,LGRAY); r+=2;

  // Apuração
  hdrRow(ws1,r,['APURAÇÃO PIS/COFINS PRÓPRIOS',`PIS ${(empresa.pis_aliq*100).toFixed(2).replace('.',',')}% (R$)`,`COFINS ${(empresa.cofins_aliq*100).toFixed(2).replace('.',',')}% (R$)`,'Total (R$)'],GREEN,WHITE); r++;
  [
    [`Base — NFs pagas em ${COMP_LABEL}`, sumNFsPagasBruto, sumNFsPagasBruto, sumNFsPagasBruto],
    ['(×) Alíquota',                      pisBruto, cofinsBruto, pisBruto+cofinsBruto],
    ['(-) Crédito retenções na fonte',   -ret.pis, -ret.cofins, -(ret.pis+ret.cofins)],
    [`(=) A PAGAR — Venc. ${dataVenc}`,   pisLiq,   cofinsLiq,   pisLiq+cofinsLiq],
  ].forEach(([desc,p,c,tot],i) => {
    const isT = i===3, bg = isT?LGREEN:null, fc = isT?GREEN:'FF1E293B';
    setCell(ws1,r,1,'  '+desc,null,bg,fc,isT);
    setMoney(ws1,r,2,p,bg,fc,isT); setMoney(ws1,r,3,c,bg,fc,isT); setMoney(ws1,r,4,tot,bg,fc,isT); r++;
  });
  if (pisLiq>0||cofinsLiq>0) {
    setCell(ws1,r,1,`  Código DARF — PIS: ${empresa.darf_pis}  |  COFINS: ${empresa.darf_cofins}`,null,LGREEN,GREEN);
    setCell(ws1,r,2,'',null,LGREEN); setCell(ws1,r,3,'',null,LGREEN); setCell(ws1,r,4,'',null,LGREEN); r++;
  }
  r++;

  // Fornecedores
  hdrRow(ws1,r,['FORNECEDORES — ELEGIBILIDADE CRÉDITO PIS/COFINS','Regime','Total Pago (R$)','Gera Crédito?'],RED,WHITE); r++;
  if (fornOrdenados.length === 0) {
    ws1.mergeCells(r,1,r,4); setCell(ws1,r,1,'  Nenhuma despesa registrada no período',null,LGRAY,GRAY); r++;
  } else {
    fornOrdenados.forEach(f => {
      // No regime cumulativo (Segurança) NENHUM fornecedor gera crédito PIS/COFINS
      const geraCredito = empresa.gera_credito_fornecedor && !f.isSimples;
      const bg  = geraCredito ? LGREEN : LRED;
      const fc  = geraCredito ? GREEN  : RED;
      const motivo = !empresa.gera_credito_fornecedor
        ? '❌ NÃO — regime cumulativo'
        : (f.isSimples ? '❌ NÃO — art. 23 LC 123/2006' : '✅ Verificar NF');
      setCell(ws1,r,1,`  ${f.nome}  (CNPJ ${f.cnpj||'—'})`,null,bg,fc);
      setCell(ws1,r,2,f.isSimples?'Simples Nacional':'Verificar',null,bg,fc);
      setMoney(ws1,r,3,f.total,bg,fc);
      setCell(ws1,r,4,motivo,null,bg,fc,true); r++;
    });
  }
  ws1.mergeCells(r,1,r,4);
  const simplesNote = ws1.getRow(r).getCell(1);
  simplesNote.value = 'Simples Nacional (art. 23 LC 123/2006): fornecedores optantes NÃO geram crédito de PIS/COFINS para o tomador, independentemente do valor ou período.';
  simplesNote.font  = {size:9, color:{argb:'FF1E3A5F'}};
  simplesNote.fill  = {type:'pattern', pattern:'solid', fgColor:{argb:'FFE0F0FF'}};
  simplesNote.alignment = {wrapText:true, vertical:'middle'};
  simplesNote.border = BORDER;
  ws1.getRow(r).height = 32;

  // ── ABA 2 — NFs PAGAS ────────────────────────────────────────
  const ws2 = wb.addWorksheet(`NFs Pagas ${COMP_ABREV}`);
  ws2.columns = [{width:8},{width:14},{width:11},{width:11},{width:38},{width:25},{width:15},{width:15},{width:13},{width:10},{width:10},{width:10},{width:10},{width:10},{width:10}];
  hdrRow(ws2,1,['#','NF Nº','Emissão','Pagamento','Tomador','Contrato','Valor Bruto','Valor Líquido','Ret. Total','INSS','IRRF','ISS','CSLL','PIS','COFINS'],BLUE);

  nfsPagas.forEach((n,i) => {
    const rw = i+2, bg = i%2===0 ? null : LGRAY;
    setCell(ws2,rw,1,  i+1,                          null,bg,GRAY,false,'center');
    setCell(ws2,rw,2,  n.numero,                     null,bg);
    setCell(ws2,rw,3,  fmtDt(n.data_emissao),        null,bg);
    setCell(ws2,rw,4,  fmtDt(n.data_pagamento),      null,bg);
    setCell(ws2,rw,5,  n.tomador,                    null,bg);
    setCell(ws2,rw,6,  n.contrato_ref||'',           null,bg);
    setMoney(ws2,rw,7, n.valor_bruto||0,             bg);
    setMoney(ws2,rw,8, n.valor_liquido||0,           bg);
    setMoney(ws2,rw,9, n.retencao||0,                bg);
    setMoney(ws2,rw,10,n.inss||0,                    bg);
    setMoney(ws2,rw,11,n.ir||0,                      bg);
    setMoney(ws2,rw,12,n.iss||0,                     bg);
    setMoney(ws2,rw,13,n.csll||0,                    bg);
    setMoney(ws2,rw,14,n.pis||0,                     bg);
    setMoney(ws2,rw,15,n.cofins||0,                  bg);
  });
  const tr2 = nfsPagas.length+2;
  setCell(ws2,tr2,1,'',null,LBLUE); setCell(ws2,tr2,2,'TOTAL',null,LBLUE,BLUE,true);
  setCell(ws2,tr2,3,`${nfsPagas.length} NFs`,null,LBLUE,BLUE,true);
  [3,4,5].forEach(c=>setCell(ws2,tr2,c+1,'',null,LBLUE));
  [[7,'valor_bruto'],[8,'valor_liquido'],[9,'retencao'],[10,'inss'],[11,'ir'],[12,'iss'],[13,'csll'],[14,'pis'],[15,'cofins']]
    .forEach(([col,f]) => setMoney(ws2,tr2,col, nfsPagas.reduce((s,n)=>s+(n[f]||0),0), LBLUE,BLUE,true));

  // ── ABA 3 — CRÉDITOS BANCÁRIOS ───────────────────────────────
  const ws3 = wb.addWorksheet(`Créditos Bancários ${COMP_ABREV}`);
  ws3.columns = [{width:12},{width:52},{width:16},{width:20},{width:40},{width:22}];
  hdrRow(ws3,1,['Data','Histórico Bancário','Valor (R$)','Classificação','Tomador identificado','CNPJ pagador'],BLUE);
  let row3 = 2;

  hdrRow(ws3,row3,['','— RECEITAS DE CLIENTES —','','','',''],GREEN,WHITE); row3++;
  receitas.forEach((c,i) => {
    const bg = i%2===0?LGREEN:null;
    const tomadorNome = identificarTomador(c);
    const ehIdentificado = tomadorNome !== 'Não identificado';
    setCell(ws3,row3,1,fmtDt(c.data_iso),null,bg);
    setCell(ws3,row3,2,(c.historico||'').slice(0,100),null,bg);
    setMoney(ws3,row3,3,c.credito,bg);
    setCell(ws3,row3,4,'Receita de cliente',null,LGREEN,GREEN);
    setCell(ws3,row3,5,tomadorNome,null, ehIdentificado ? bg : LYELLOW, ehIdentificado ? '' : AMBER, !ehIdentificado);
    setCell(ws3,row3,6,c.pagador_cnpj || '',null,bg,GRAY);
    row3++;
  });
  setCell(ws3,row3,1,'Subtotal Receitas',null,LGREEN,GREEN,true);
  setCell(ws3,row3,2,'',null,LGREEN); setMoney(ws3,row3,3,sumCaixaBruto,LGREEN,GREEN,true);
  setCell(ws3,row3,4,'',null,LGREEN); setCell(ws3,row3,5,'',null,LGREEN); setCell(ws3,row3,6,'',null,LGREEN); row3+=2;

  hdrRow(ws3,row3,['','— TRANSFERÊNCIAS INTERNAS / REPASSES (não tributável) —','','','',''],AMBER,WHITE); row3++;
  internos.forEach((c,i) => {
    const bg = i%2===0?LYELLOW:null;
    setCell(ws3,row3,1,fmtDt(c.data_iso),null,bg);
    setCell(ws3,row3,2,(c.historico||'').slice(0,100),null,bg);
    setMoney(ws3,row3,3,c.credito,bg);
    setCell(ws3,row3,4,'Interno',null,LYELLOW,AMBER);
    setCell(ws3,row3,5,'Repasse grupo Montana',null,bg);
    setCell(ws3,row3,6,c.pagador_cnpj || '',null,bg,GRAY); row3++;
  });
  const sumInt = internos.reduce((s,c)=>s+c.credito,0);
  setCell(ws3,row3,1,'Subtotal Internos',null,LYELLOW,AMBER,true);
  setCell(ws3,row3,2,'',null,LYELLOW); setMoney(ws3,row3,3,sumInt,LYELLOW,AMBER,true);
  setCell(ws3,row3,4,'',null,LYELLOW); setCell(ws3,row3,5,'',null,LYELLOW); setCell(ws3,row3,6,'',null,LYELLOW); row3+=2;

  hdrRow(ws3,row3,['','— RESGATES DE INVESTIMENTO (não tributável) —','','','',''],GRAY,WHITE); row3++;
  invest.forEach((c,i) => {
    setCell(ws3,row3,1,fmtDt(c.data_iso),null,LGRAY);
    setCell(ws3,row3,2,(c.historico||'').slice(0,100),null,LGRAY);
    setMoney(ws3,row3,3,c.credito,LGRAY);
    setCell(ws3,row3,4,'BB Rende Fácil',null,LGRAY,GRAY);
    setCell(ws3,row3,5,'Não compõe receita',null,LGRAY);
    setCell(ws3,row3,6,'',null,LGRAY); row3++;
  });
  const sumInv = invest.reduce((s,c)=>s+c.credito,0);
  setCell(ws3,row3,1,'Subtotal Investimentos',null,LGRAY,GRAY,true);
  setCell(ws3,row3,2,'',null,LGRAY); setMoney(ws3,row3,3,sumInv,LGRAY,GRAY,true);
  setCell(ws3,row3,4,'',null,LGRAY); setCell(ws3,row3,5,'',null,LGRAY); setCell(ws3,row3,6,'',null,LGRAY); row3+=2;

  // Conciliação resumo
  const totalGeral = creditosUnicos.reduce((s,c)=>s+c.credito,0);
  hdrRow(ws3,row3,[`CONCILIAÇÃO — ${COMP_LABEL}`,'','','','',''],BLUE); row3++;
  [
    ['Total entradas bancárias',             totalGeral,             LBLUE,  BLUE,  true],
    ['(-) Internos + Investimentos',        -(sumInt+sumInv),        LGRAY,  GRAY,  false],
    ['= Receita líquida (caixa bancário)',   sumCaixaBruto,          LGREEN, GREEN, true],
    ['(+) Retenções sofridas',               ret.total,             LGREEN, GREEN, false],
    ['= Base tributária bruta',              sumNFsPagasBruto,       LGREEN, GREEN, true],
  ].forEach(([label,val,bg,fc,bold]) => {
    setCell(ws3,row3,1,label,null,bg,fc,bold);
    setCell(ws3,row3,2,'',null,bg); setMoney(ws3,row3,3,val,bg,fc,bold);
    setCell(ws3,row3,4,'',null,bg); setCell(ws3,row3,5,'',null,bg); setCell(ws3,row3,6,'',null,bg); row3++;
  });

  // ── ABA 4 — AGREGADO POR TOMADOR ────────────────────────────
  const ws4 = wb.addWorksheet(`Tomadores ${COMP_ABREV}`);
  ws4.columns = [{width:48},{width:22},{width:14},{width:18},{width:18},{width:18}];
  hdrRow(ws4,1,['Tomador identificado','CNPJ (se houver)','Qtd créditos','Total bruto recebido (R$)','Total NFs vinculadas (R$)','% conciliado'],BLUE);

  // Agrupar receitas por tomador
  const agregado = new Map(); // tomador → {cnpj, qtd, totalCredito, ids[]}
  for (const c of receitas) {
    const nome = identificarTomador(c);
    if (!agregado.has(nome)) agregado.set(nome, { cnpj: c.pagador_cnpj||'', qtd:0, totalCredito:0, ids:[] });
    const g = agregado.get(nome);
    g.qtd++;
    g.totalCredito += c.credito;
    g.ids.push(c.id);
    if (!g.cnpj && c.pagador_cnpj) g.cnpj = c.pagador_cnpj;
  }
  // Calcular NF liquida vinculada por tomador
  const nfLiqPorExt = new Map();
  for (const n of nfsPagas) {
    // data_pagamento setada artificialmente pelo matching — achar extrato por data_iso é aproximado;
    // melhor usar extrato_id real da NF (presente em n.extrato_id quando persistido)
    if (n.extrato_id != null) {
      if (!nfLiqPorExt.has(n.extrato_id)) nfLiqPorExt.set(n.extrato_id, 0);
      nfLiqPorExt.set(n.extrato_id, nfLiqPorExt.get(n.extrato_id) + (n.valor_liquido||0));
    }
  }
  let r4 = 2;
  const agregadoArr = [...agregado.entries()].sort((a,b) => b[1].totalCredito - a[1].totalCredito);
  for (const [nome, g] of agregadoArr) {
    const bg = (r4 % 2 === 0) ? null : LGRAY;
    let liqVinc = 0;
    for (const extId of g.ids) liqVinc += (nfLiqPorExt.get(extId) || 0);
    const pctConc = g.totalCredito > 0 ? (liqVinc / g.totalCredito) : 0;
    const ehNaoIdent = nome === 'Não identificado';
    setCell(ws4,r4,1, nome, null, ehNaoIdent?LYELLOW:bg, ehNaoIdent?AMBER:'', ehNaoIdent);
    setCell(ws4,r4,2, g.cnpj || '—', null, bg, GRAY);
    setCell(ws4,r4,3, g.qtd, null, bg, '', false, 'center');
    setMoney(ws4,r4,4, g.totalCredito, bg);
    setMoney(ws4,r4,5, liqVinc, bg);
    const pctCell = ws4.getRow(r4).getCell(6);
    pctCell.value = pctConc;
    pctCell.numFmt = '0.0%';
    pctCell.alignment = { horizontal:'right', vertical:'middle' };
    pctCell.border = BORDER;
    pctCell.font = { size: 9, color: { argb: pctConc >= 0.90 ? GREEN : pctConc >= 0.50 ? AMBER : RED }, bold: true };
    if (bg) pctCell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: bg }};
    r4++;
  }
  const totCred = agregadoArr.reduce((s,[_,g]) => s + g.totalCredito, 0);
  const totLiq  = [...nfLiqPorExt.values()].reduce((s,v) => s+v, 0);
  setCell(ws4,r4,1,'TOTAL', null, LBLUE, BLUE, true);
  setCell(ws4,r4,2,'', null, LBLUE);
  setCell(ws4,r4,3, agregadoArr.reduce((s,[_,g]) => s+g.qtd, 0), null, LBLUE, BLUE, true, 'center');
  setMoney(ws4,r4,4, totCred, LBLUE, BLUE, true);
  setMoney(ws4,r4,5, totLiq,  LBLUE, BLUE, true);
  const pctT = ws4.getRow(r4).getCell(6);
  pctT.value = totCred > 0 ? (totLiq/totCred) : 0;
  pctT.numFmt = '0.0%';
  pctT.alignment = { horizontal:'right' };
  pctT.border = BORDER;
  pctT.font = { bold:true, size:9, color:{argb: BLUE }};
  pctT.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: LBLUE }};

  // ── SALVAR ──────────────────────────────────────────────────
  const outName = `relatorio_apuracao_pis_cofins_${empresa.key.toUpperCase()}_${COMP_ABREV}.xlsx`;
  const outPath = path.join(__dirname, '..', outName);

  await wb.xlsx.writeFile(outPath);
  let copiadoMsg = '';
  try {
    const downloadPath = path.join(os.homedir(), 'Downloads', outName);
    fs.copyFileSync(outPath, downloadPath);
    copiadoMsg = `  📁 Downloads\\${outName}`;
  } catch(e) {
    copiadoMsg = `  ⚠️  Cópia Downloads falhou (feche Excel): ${e.code} — arquivo em: ${outName}`;
  }
  console.log(copiadoMsg);

  db.close();
  return { empresa: empresa.key, nfs: nfsPagas.length, base: sumNFsPagasBruto, pis: pisLiq, cofins: cofinsLiq, semConciliacao };
}

// ── EXECUÇÃO ─────────────────────────────────────────────────────
(async () => {
  const resultados = [];
  for (const emp of empresasRodar) {
    try {
      const res = await gerarRelatorio(emp);
      resultados.push(res);
    } catch(e) {
      console.error(`\nErro em ${emp.key}:`, e.message);
    }
  }

  if (resultados.length > 1) {
    const MES = MES_NOMES[mesArg-1];
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  CONSOLIDADO — ${MES}/${anoArg}`);
    console.log(`${'═'.repeat(60)}`);
    let totBase=0, totPis=0, totCofins=0;
    resultados.forEach(r => {
      console.log(`  ${r.empresa.padEnd(14)} | ${r.nfs} NFs | Base: R$${brl_fmt(r.base).padStart(16)} | PIS: R$${brl_fmt(r.pis).padStart(13)} | COFINS: R$${brl_fmt(r.cofins).padStart(13)}`);
      totBase+=r.base; totPis+=r.pis; totCofins+=r.cofins;
    });
    console.log(`  ${'TOTAL'.padEnd(14)} | ${''.padStart(6)}  | Base: R$${brl_fmt(totBase).padStart(16)} | PIS: R$${brl_fmt(totPis).padStart(13)} | COFINS: R$${brl_fmt(totCofins).padStart(13)}`);
    console.log(`  Vencimento DARFs: 25/${String(mesArg===12?1:mesArg+1).padStart(2,'0')}/${mesArg===12?anoArg+1:anoArg}`);
  }
})();
