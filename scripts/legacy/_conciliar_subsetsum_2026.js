/**
 * Persiste vinculações extrato↔NF identificadas pelo algoritmo subset-sum
 * (o mesmo do gerar_relatorio_apuracao.js) de forma que o relatório anual
 * de contabilidade (gerar_relatorio_contabilidade_2026.js) também reflita
 * esses matches.
 *
 * Regras de segurança:
 *  - NÃO altera NF que já tem extrato_id ou data_pagamento preenchidos
 *  - NÃO altera NF com status_conciliacao='CANCELADA' nem 'ASSESSORIA'
 *  - Dry-run por padrão; --aplicar para persistir
 *  - Registra vinculações em obs das NFs: "conciliado automático (subset-sum v1)"
 *
 * Uso:
 *   node scripts/_conciliar_subsetsum_2026.js --empresa=seguranca            (dry-run)
 *   node scripts/_conciliar_subsetsum_2026.js --empresa=seguranca --aplicar  (persiste)
 *   node scripts/_conciliar_subsetsum_2026.js --empresa=todas --aplicar
 *   node scripts/_conciliar_subsetsum_2026.js --empresa=seguranca --mes=3    (só março)
 */
'use strict';
const path = require('path');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const argMap = {};
args.forEach(a => { const [k,v] = a.replace(/^--/,'').split('='); argMap[k]=v; });

const ANO      = parseInt(argMap.ano || '2026');
const MES_FILTRO = argMap.mes ? parseInt(argMap.mes) : null;
const empArg   = (argMap.empresa || 'todas').toLowerCase();
const APLICAR  = args.includes('--aplicar');

const EMPRESAS = {
  assessoria: { key:'assessoria', nome:'Assessoria', db: path.join(__dirname, '../data/assessoria/montana.db') },
  seguranca:  { key:'seguranca',  nome:'Segurança',  db: path.join(__dirname, '../data/seguranca/montana.db') },
};
const empresasRodar = empArg === 'todas' ? Object.values(EMPRESAS) : [EMPRESAS[empArg]].filter(Boolean);
if (empresasRodar.length === 0) { console.error('Empresa inválida'); process.exit(1); }

// ── Reutiliza heurísticas do gerar_relatorio_apuracao.js ─────────
function tomadorGrupo(hist) {
  const h = (hist||'').toUpperCase();
  if (h.includes('05149726') || h.includes('FUNDACAO UN'))                 return 'UFT';
  if (h.includes('MUNICIPIO DE PALMAS') || h.includes('ORDENS BANC')
      || (h.includes('ORDEM BANC') && h.includes('PALMAS')))               return 'PALMAS';
  if (h.includes('070 0380') || h.includes('01786029')
      || h.includes('GOVERNO DO EST') || h.includes('ESTADO DO TOCANTINS'))return 'ESTADO';
  if (h.includes('SEC TES NAC') || h.includes('381788'))                   return 'FEDERAL';
  if (h.includes('PROCURADORIA') || h.includes('MINISTERIO PUBLICO') || h.includes(' MP ')) return 'MP';
  return null;
}
function nfMatchGrupo(tom, grupo) {
  const t = (tom||'').toUpperCase();
  if (!grupo)          return true;
  if (grupo==='UFT')    return t.includes('UFT') || t.includes('FUNDACAO UNIVER');
  if (grupo==='PALMAS') return t.includes('PALMAS')||t.includes('PREVI')||t.includes('SEMUS')
                         ||t.includes('DETRAN')||t.includes('MUNICIPIO')||t.includes('ATCP')
                         ||t.includes('FCP')||t.includes('ARCES');
  if (grupo==='ESTADO') return t.includes('DETRAN')||t.includes('UNITINS')||t.includes('TCE')
                         ||t.includes('CBMTO')||t.includes('SEMARH')||t.includes('SEDUC')
                         ||t.includes('SESAU')||t.includes('SEPLAD')||t.includes('CORPO DE BOMBEIRO');
  if (grupo==='FEDERAL')return t.includes('UFNT')||t.includes('UFT');
  if (grupo==='MP')     return t.includes('PROCURADORIA')||t.includes('MINISTERIO')||t.includes('MP');
  return true;
}
function tipoCredito(hist, status) {
  const h  = (hist||'').toUpperCase();
  const st = (status||'').toUpperCase();
  if (['INTERNO','TRANSFERENCIA','INVESTIMENTO'].includes(st)) return st;
  if (h.includes('RENDE FACIL') || h.includes('APLICACAO'))    return 'INVESTIMENTO';
  if (h.includes('MONTANA S')||h.includes('MONTANA SERV')||h.includes('MONTANA SEG')||h.includes('MONTANA ASSES')) return 'INTERNO';
  return 'RECEITA';
}

function buscarSubset(valores, target, tol, maxK) {
  valores.sort((a,b) => b.v - a.v);
  const N = valores.length;
  if (N === 0) return null;
  // Poda: sufixo acumulado (valor máximo que ainda pode ser somado a partir de i)
  const sufMax = new Array(N+1).fill(0);
  for (let i = N-1; i >= 0; i--) sufMax[i] = sufMax[i+1] + valores[i].v;
  let achou = null;
  const MAX_STEPS = 500000;
  let steps = 0;
  function dfs(idx, k, soma, picked) {
    if (achou) return;
    if (++steps > MAX_STEPS) return;
    if (Math.abs(soma - target) <= tol) { achou = picked.slice(); return; }
    if (k >= maxK) return;
    if (idx >= N) return;
    // Poda: se soma + todo o restante ainda não alcança target, inútil prosseguir
    if (soma + sufMax[idx] < target - tol) return;
    // Poda: se soma já passou target + tol e valores são positivos, também inútil
    if (soma > target + tol) return;
    for (let i = idx; i < N; i++) {
      picked.push(valores[i].nf);
      dfs(i+1, k+1, soma + valores[i].v, picked);
      picked.pop();
      if (achou) return;
      if (steps > MAX_STEPS) return;
    }
  }
  dfs(0, 0, 0, []);
  return achou;
}

function conciliarMes(empresa, mes) {
  const db = new Database(empresa.db);
  const mesStr = String(mes).padStart(2,'0');
  const ultimoDia = new Date(ANO, mes, 0).getDate();
  const dataInicio = `${ANO}-${mesStr}-01`;
  const dataFim    = `${ANO}-${mesStr}-${String(ultimoDia).padStart(2,'0')}`;
  const dtJanInicio = new Date(ANO, mes - 7, 1).toISOString().slice(0,10);

  // Extratos RECEITA disponíveis no mês (sem extrato conciliado a NF ainda)
  const rawExt = db.prepare(`
    SELECT id, data_iso, historico, credito, status_conciliacao
    FROM extratos
    WHERE data_iso BETWEEN ? AND ? AND credito > 0
    ORDER BY data_iso, credito DESC
  `).all(dataInicio, dataFim);

  // Deduplicar (mesmo lançamento em 2 CSVs)
  const seen = new Set();
  const creditos = [];
  for (const c of rawExt) {
    const histNorm = (c.historico||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,30);
    const k = `${c.data_iso}|${c.credito.toFixed(2)}|${histNorm}`;
    if (!seen.has(k)) { seen.add(k); creditos.push(c); }
  }

  // IDs já vinculados a alguma NF
  const usados = new Set(
    db.prepare(`SELECT extrato_id FROM notas_fiscais WHERE extrato_id IS NOT NULL`).all().map(r=>r.extrato_id)
  );
  const receitas = creditos.filter(c =>
    tipoCredito(c.historico, c.status_conciliacao) === 'RECEITA' && !usados.has(c.id)
  );

  // NFs candidatas: não canceladas, sem extrato_id ainda, dentro da janela
  const nfs = db.prepare(`
    SELECT id, numero, data_emissao, data_pagamento, tomador, valor_liquido, extrato_id, status_conciliacao
    FROM notas_fiscais
    WHERE status_conciliacao NOT IN ('CANCELADA','ASSESSORIA')
      AND extrato_id IS NULL
      AND (data_pagamento IS NULL OR data_pagamento = '')
      AND data_emissao BETWEEN ? AND ?
    ORDER BY data_emissao ASC
  `).all(dtJanInicio, dataFim);

  const nfsUsadas = new Set();
  const matches = []; // {nf_id, ext_id, data_iso, tipo}

  // Pass 1: 1:1 valor_liquido ≈ credito (±R$0,10)
  for (const ext of receitas) {
    const cands = nfs
      .filter(n => !nfsUsadas.has(n.id) && Math.abs(n.valor_liquido - ext.credito) <= 0.10)
      .sort((a,b) => b.data_emissao.localeCompare(a.data_emissao));
    if (cands.length > 0) {
      nfsUsadas.add(cands[0].id);
      matches.push({ nf_id: cands[0].id, ext_id: ext.id, data_iso: ext.data_iso, tipo: '1:1' });
    }
  }

  // Pass 2: subset-sum por grupo — passe progressivo
  //   2a) estrito: maxK=8, tol 0,5%, candidatos ordenados por data desc (top 25)
  //   2b) agressivo: maxK=15, tol 1,0%, candidatos por valor similar (top 35)
  const passes = [
    { maxK: 8,  tolPct: 0.005, slice: 25, ord: 'data' },
    { maxK: 15, tolPct: 0.010, slice: 35, ord: 'valor' },
  ];

  for (const pp of passes) {
    for (const ext of receitas) {
      if (matches.some(m => m.ext_id === ext.id)) continue;
      if (ext.credito < 500) continue;
      const grupo = tomadorGrupo(ext.historico);
      let cands = nfs
        .filter(n => !nfsUsadas.has(n.id) && nfMatchGrupo(n.tomador, grupo));
      if (pp.ord === 'data') {
        cands.sort((a,b) => b.data_emissao.localeCompare(a.data_emissao));
      } else {
        // Prefere NFs cujos valores somem ≈ ext.credito — heurística: começa por NFs com valor ≤ ext.credito
        cands.sort((a,b) => {
          const aDist = Math.abs(a.valor_liquido - ext.credito/2);
          const bDist = Math.abs(b.valor_liquido - ext.credito/2);
          return aDist - bDist;
        });
      }
      cands = cands.slice(0, pp.slice);
      if (cands.length === 0) continue;
      const tol = Math.max(0.50, ext.credito * pp.tolPct);
      const valores = cands.map(n => ({ nf: n, v: n.valor_liquido }));
      const subset = buscarSubset(valores, ext.credito, tol, pp.maxK);
      if (subset && subset.length > 0) {
        for (const nf of subset) {
          nfsUsadas.add(nf.id);
          matches.push({ nf_id: nf.id, ext_id: ext.id, data_iso: ext.data_iso, tipo: subset.length===1 ? '1:1-grupo' : `SUBSET-k${pp.maxK}` });
        }
      }
    }
  }

  // Persistir
  let aplicadas = 0;
  if (APLICAR && matches.length > 0) {
    const upd = db.prepare(`
      UPDATE notas_fiscais
      SET extrato_id = ?, data_pagamento = ?, status_conciliacao = 'CONCILIADO'
      WHERE id = ? AND (extrato_id IS NULL) AND (data_pagamento IS NULL OR data_pagamento = '')
    `);
    const trx = db.transaction(lista => {
      for (const m of lista) {
        const r = upd.run(m.ext_id, m.data_iso, m.nf_id);
        if (r.changes > 0) aplicadas++;
      }
    });
    trx(matches);
  }

  db.close();
  return { mes, matches: matches.length, aplicadas, dataInicio, dataFim };
}

console.log('');
console.log('══════════════════════════════════════════════════════════');
console.log(`  CONCILIAÇÃO SUBSET-SUM — ${ANO}${MES_FILTRO?` (mês ${MES_FILTRO})`:''}`);
console.log(`  Modo: ${APLICAR ? '🟢 APLICANDO' : '🟡 DRY-RUN'}`);
console.log('══════════════════════════════════════════════════════════');

const mesesRodar = MES_FILTRO ? [MES_FILTRO] : [1,2,3,4,5,6,7,8,9,10,11,12];

for (const empresa of empresasRodar) {
  console.log(`\n── ${empresa.nome} ────────────────────────────────`);
  let totalMatches = 0, totalAplicadas = 0;
  for (const mes of mesesRodar) {
    try {
      const r = conciliarMes(empresa, mes);
      if (r.matches > 0) {
        console.log(`  ${String(mes).padStart(2,'0')}/${ANO}: ${String(r.matches).padStart(3)} matches ${APLICAR?`| ${r.aplicadas} aplicadas`:''}`);
      }
      totalMatches  += r.matches;
      totalAplicadas += r.aplicadas;
    } catch (e) {
      console.error(`  ${String(mes).padStart(2,'0')}/${ANO}: ERRO — ${e.message}`);
    }
  }
  console.log(`  ─────────────────────────────────────`);
  console.log(`  TOTAL ${empresa.nome}: ${totalMatches} matches${APLICAR?` | ${totalAplicadas} aplicados`:''}`);
}

console.log('\n' + (APLICAR ? '✅ Persistência concluída. Rode o relatório anual pra verificar.' : '⚠️  DRY-RUN: nada foi gravado. Rode com --aplicar pra persistir.'));
console.log('');
