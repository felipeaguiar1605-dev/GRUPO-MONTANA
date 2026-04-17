'use strict';
/**
 * Conciliação OBs federais (portal='federal', fase=Pagamento) × extratos bancários.
 *
 * Estratégia:
 *   1) Dedupe extratos por (data_iso, credito, historico) — evita double-match quando
 *      o mesmo CSV foi importado 2×.
 *   2) Para cada OB (valor_pago > 0):
 *        match 1 — valor ± 0.5% e data ± 5 dias
 *        match 2 — valor ± 3% e data ± 10 dias
 *        match 3 — soma de OBs do mesmo UG no mesmo dia ≈ crédito (tolerância 5%)
 *   3) Marca extratos.status_conciliacao como `FEDERAL_<UG>_<doc>` e grava
 *      a referência em extratos.obs (mantendo o que já havia).
 *   4) Relatório: quantas OBs conciliadas, R$ total, top 10 UGs conciliadas,
 *      pendências por mês.
 *
 * Uso:
 *   node scripts/conciliacao_federal.js --empresa=assessoria
 *   node scripts/conciliacao_federal.js --empresa=assessoria --apply
 *   node scripts/conciliacao_federal.js --empresa=assessoria --ano=2025 --apply
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const ARG = process.argv.slice(2);
const APLICAR = ARG.includes('--apply');
const arg = (k, def = '') => (ARG.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || def;
const empresa = arg('empresa', 'assessoria');
const anoFilter = arg('ano', '');

function addDias(isoDt, n) {
  const d = new Date(isoDt + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().substring(0, 10);
}

function diffDias(a, b) {
  const da = new Date(a + 'T12:00:00');
  const db = new Date(b + 'T12:00:00');
  return Math.round((db - da) / 86400000);
}

function fmt(n) { return Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 }); }

function main() {
  console.log(`\n🔗 Conciliação OBs federais × extratos — empresa=${empresa}${anoFilter ? ' ano=' + anoFilter : ''}`);
  console.log(`   Modo: ${APLICAR ? 'APLICAR (marca status_conciliacao)' : 'DRY-RUN'}\n`);

  const db = getDb(empresa);

  // Puxa OBs (fase=Pagamento) com valor > 0.
  // EXCLUI documentos DF* (retenções IR/INSS/PIS/COFINS/CSLL — nunca tocam o caixa da empresa)
  const whereAno = anoFilter ? ` AND substr(data_pagamento_iso,1,4)='${anoFilter}'` : '';
  const obsAll = db.prepare(`
    SELECT id, empenho, gestao, fornecedor, cnpj, valor_pago, data_pagamento_iso
    FROM pagamentos_portal
    WHERE portal='federal' AND data_pagamento_iso <> '' AND valor_pago > 0 ${whereAno}
    ORDER BY data_pagamento_iso, valor_pago DESC
  `).all();
  // EXCLUI DF (retenções IR/INSS/PIS/COFINS) e DR (DARFs de IR sobre rendimentos)
  // Ambos são recolhidos diretamente pelo Tesouro/UG; nunca tocam contas da empresa.
  const obs           = obsAll.filter(r => !String(r.empenho).match(/D[FR]\d/));
  const retencoesDF   = obsAll.filter(r =>  String(r.empenho).match(/DF\d/));
  const retencoesDR   = obsAll.filter(r =>  String(r.empenho).match(/DR\d/));
  console.log(`  OBs principais (pagamentos efetivos): ${obs.length} (R$ ${fmt(obs.reduce((a, r) => a + r.valor_pago, 0))})`);
  console.log(`  DF retenções tributárias (Tesouro): ${retencoesDF.length} (R$ ${fmt(retencoesDF.reduce((a, r) => a + r.valor_pago, 0))})`);
  console.log(`  DR DARF IR rendimentos (Tesouro):   ${retencoesDR.length} (R$ ${fmt(retencoesDR.reduce((a, r) => a + r.valor_pago, 0))})\n`);

  // Puxa extratos dedupados + indexa por chave
  const extRaw = db.prepare(`
    SELECT MIN(id) id, data_iso, credito, historico, status_conciliacao, obs
    FROM extratos
    WHERE credito > 0 ${anoFilter ? ` AND substr(data_iso,1,4)='${anoFilter}'` : ''}
    GROUP BY data_iso, credito, historico
  `).all();
  // PLUS: extratos da conta vinculada
  //   - Para OBs comuns: bater com CRÉDITOS (depósitos do tomador / rendimentos)
  //   - Para DR (retenções/resgates): bater com DÉBITOS (resgate na conta vinculada)
  let extVincC = [], extVincD = [];
  try {
    extVincC = db.prepare(`
      SELECT id, data_iso, credito as valor, historico, conta_vinculada, nome_convenente
      FROM extratos_vinculada
      WHERE credito > 0 AND tipo='CREDITO'
        ${anoFilter ? ` AND substr(data_iso,1,4)='${anoFilter}'` : ''}
    `).all();
    extVincD = db.prepare(`
      SELECT id, data_iso, debito as valor, historico, conta_vinculada, nome_convenente
      FROM extratos_vinculada
      WHERE debito > 0 AND tipo='DEBITO'
        ${anoFilter ? ` AND substr(data_iso,1,4)='${anoFilter}'` : ''}
    `).all();
  } catch (e) { /* tabela pode não existir */ }
  console.log(`  Extratos candidatos: ${extRaw.length} bancários + ${extVincC.length} créditos vinc + ${extVincD.length} débitos vinc\n`);

  // Indexa por data → [extratos] (origem='ext' bancário, 'vincC' crédito vinc, 'vincD' débito vinc)
  // Para a busca, normalizamos para field `credito` (mesmo que seja débito da conta vinculada)
  const extByDate = new Map();
  for (const e of extRaw) {
    e._origem = 'ext';
    if (!extByDate.has(e.data_iso)) extByDate.set(e.data_iso, []);
    extByDate.get(e.data_iso).push(e);
  }
  for (const e of extVincC) {
    e._origem = 'vincC';
    e.credito = e.valor;
    if (!extByDate.has(e.data_iso)) extByDate.set(e.data_iso, []);
    extByDate.get(e.data_iso).push(e);
  }
  for (const e of extVincD) {
    e._origem = 'vincD';
    e.credito = e.valor;
    if (!extByDate.has(e.data_iso)) extByDate.set(e.data_iso, []);
    extByDate.get(e.data_iso).push(e);
  }

  // Passo 1: match 1-a-1 com tolerância 0.5% em ±5 dias
  // Passo 2: tolerância 3% em ±10 dias
  const usados = new Set();
  const matches = [];
  const pendentes = [];

  function tentarMatch(ob, toleranciaPct, janelaDias) {
    const vTarget = ob.valor_pago;
    // OBs reais batem com extrato bancário OU crédito da conta vinculada (depósitos do tomador)
    const origensValidas = new Set(['ext', 'vincC']);
    let melhor = null;
    for (let d = -janelaDias; d <= janelaDias; d++) {
      const dt = addDias(ob.data_pagamento_iso, d);
      const cands = extByDate.get(dt) || [];
      for (const e of cands) {
        if (!origensValidas.has(e._origem)) continue;
        const usadoKey = `${e._origem}-${e.id}`;
        if (usados.has(usadoKey)) continue;
        const diff = Math.abs(e.credito - vTarget);
        const pct = diff / vTarget;
        if (pct > toleranciaPct) continue;
        if (!melhor || pct < melhor.pct || (pct === melhor.pct && Math.abs(d) < Math.abs(melhor.diasDiff))) {
          melhor = { ext: e, pct, diasDiff: d, key: usadoKey };
        }
      }
    }
    return melhor;
  }

  console.log('  Passo 1: valor ± 0.5% em ±5 dias...');
  for (const ob of obs) {
    const m = tentarMatch(ob, 0.005, 5);
    if (m) {
      usados.add(m.key);
      matches.push({ ob, ext: m.ext, regra: 'P1', pct: m.pct, diasDiff: m.diasDiff });
    } else pendentes.push(ob);
  }
  console.log(`    Matches P1: ${matches.length}`);

  console.log('  Passo 2: valor ± 3% em ±10 dias (nos pendentes)...');
  const ainda = [];
  for (const ob of pendentes) {
    const m = tentarMatch(ob, 0.03, 10);
    if (m) {
      usados.add(m.key);
      matches.push({ ob, ext: m.ext, regra: 'P2', pct: m.pct, diasDiff: m.diasDiff });
    } else ainda.push(ob);
  }
  console.log(`    Matches P2: ${matches.filter(m => m.regra === 'P2').length}`);
  console.log(`    Pendentes após P1+P2: ${ainda.length}\n`);

  // Relatório
  const totMatch = matches.reduce((a, m) => a + m.ob.valor_pago, 0);
  const totPend = ainda.reduce((a, o) => a + o.valor_pago, 0);
  console.log(`  ═══ Resultado ═══`);
  console.log(`    Conciliadas: ${matches.length} OBs | R$ ${fmt(totMatch)}`);
  console.log(`    Pendentes:   ${ainda.length} OBs | R$ ${fmt(totPend)}`);
  console.log(`    Taxa:        ${(matches.length / obs.length * 100).toFixed(1)}%`);

  // Top UGs conciliadas
  const porUg = {};
  matches.forEach(m => {
    const k = m.ob.gestao || 'SEM UG';
    if (!porUg[k]) porUg[k] = { qtd: 0, total: 0 };
    porUg[k].qtd++;
    porUg[k].total += m.ob.valor_pago;
  });
  console.log('\n  Top UGs conciliadas:');
  Object.entries(porUg).sort((a, b) => b[1].total - a[1].total).slice(0, 10).forEach(([ug, v]) => {
    console.log(`    ${String(v.qtd).padStart(4)}x R$ ${fmt(v.total).padStart(16)} ${ug.substring(0, 60)}`);
  });

  // Pendentes por UG (top 10)
  const pendUg = {};
  ainda.forEach(o => {
    const k = o.gestao || 'SEM UG';
    if (!pendUg[k]) pendUg[k] = { qtd: 0, total: 0 };
    pendUg[k].qtd++;
    pendUg[k].total += o.valor_pago;
  });
  console.log('\n  Top UGs pendentes (sem match):');
  Object.entries(pendUg).sort((a, b) => b[1].total - a[1].total).slice(0, 10).forEach(([ug, v]) => {
    console.log(`    ${String(v.qtd).padStart(4)}x R$ ${fmt(v.total).padStart(16)} ${ug.substring(0, 60)}`);
  });

  // Breakdown matches por origem
  const porOrigem = matches.reduce((a, m) => {
    a[m.ext._origem || 'ext'] = (a[m.ext._origem || 'ext'] || { qtd: 0, total: 0 });
    a[m.ext._origem || 'ext'].qtd++;
    a[m.ext._origem || 'ext'].total += m.ob.valor_pago;
    return a;
  }, {});
  console.log('\n  Matches por origem:');
  Object.entries(porOrigem).forEach(([o, v]) => {
    const nome = o === 'vincC' ? 'Vinculada (crédito)'
               : o === 'vincD' ? 'Vinculada (débito DR)'
               : 'Extrato Bancário';
    console.log(`    ${nome.padEnd(22)} ${String(v.qtd).padStart(4)}x | R$ ${fmt(v.total).padStart(15)}`);
  });

  // Apply
  if (APLICAR) {
    console.log('\n  💾 Aplicando status_conciliacao...');
    const updExt = db.prepare(`
      UPDATE extratos
      SET status_conciliacao = ?,
          obs = CASE WHEN obs IS NULL OR obs='' THEN ? ELSE obs || ' | ' || ? END
      WHERE id = ?
    `);
    const updVinc = db.prepare(`
      UPDATE extratos_vinculada
      SET status_conciliacao = ?
      WHERE id = ?
    `);
    let appliedExt = 0, appliedVinc = 0;
    db.transaction(() => {
      for (const m of matches) {
        const status = `FEDERAL_${m.ob.empenho || 'OB'}`.substring(0, 60);
        if (m.ext._origem === 'vincC' || m.ext._origem === 'vincD') {
          const r = updVinc.run(status, m.ext.id);
          if (r.changes > 0) appliedVinc++;
        } else {
          const tag = `FED ${m.ob.empenho || ''} UG ${String(m.ob.gestao || '').substring(0, 40)} ${m.regra} Δ${m.diasDiff}d`;
          const r = updExt.run(status, tag, tag, m.ext.id);
          if (r.changes > 0) appliedExt++;
        }
      }
    })();
    console.log(`  ✅ ${appliedExt} extratos bancários + ${appliedVinc} extratos conta vinculada marcados.`);
  } else {
    console.log('\n  (dry-run — use --apply para marcar status_conciliacao)');
  }

  console.log('\n✔️  Concluído.\n');
}

main();
