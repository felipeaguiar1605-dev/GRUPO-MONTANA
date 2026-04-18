'use strict';
/**
 * Matching Estadual/TO — cruza pagamentos_portal (portal='estadual-to-cge')
 * com extratos bancários (TED-Crédito do Tesouro Estadual / Ordem Bancária).
 *
 * Algoritmo (similar a matching_federal.js):
 *   Para cada pagamento CGE sem extrato_id:
 *     1. Janela [data_pagamento − 2d, data_pagamento + 15d]
 *     2. Tolerância A: ±R$0,10 (exato)
 *     3. Tolerância B: ±0,5%
 *     4. Filtro de histórico: TED/OB com GOVERNO / TESOURO / DETRAN / SECR / TOCANTINS
 *     5. Só aceita match único
 *
 * Uso:
 *   node scripts/matching_cge_estadual.js [empresa]          (dry-run)
 *   node scripts/matching_cge_estadual.js [empresa] --apply  (grava)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const argsPos = process.argv.slice(2).filter(a => !a.startsWith('--'));
const empArg = (argsPos[0] || 'todas').toLowerCase();

function brl(n) { return (n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function addDias(iso, dias) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function processar(empresa) {
  const db = getDb(empresa);
  console.log('\n' + '═'.repeat(80));
  console.log(`  ${empresa.toUpperCase()} — Matching ESTADUAL/TO CGE × extratos`);
  console.log('═'.repeat(80));

  // 1. Pagamentos CGE estaduais sem extrato_id
  const pagsCge = db.prepare(`
    SELECT id, valor_pago, gestao, fornecedor, empenho,
      COALESCE(NULLIF(data_pagamento_iso,''), NULLIF(data_liquidacao_iso,''), NULLIF(data_empenho_iso,'')) dt
    FROM pagamentos_portal
    WHERE portal = 'estadual-to-cge'
      AND valor_pago > 0
      AND (extrato_id IS NULL OR extrato_id = '')
    ORDER BY dt, valor_pago DESC
  `).all();
  console.log(`  Pagamentos CGE sem extrato_id: ${pagsCge.length}`);
  if (pagsCge.length === 0) { db.close(); return { pag: 0 }; }

  // 2. Janela período
  const dts = pagsCge.map(p => p.dt).filter(Boolean).sort();
  const extIni = addDias(dts[0], -2);
  const extFim = addDias(dts[dts.length - 1], 15);

  const exts = db.prepare(`
    SELECT id, data_iso, historico, credito
    FROM extratos
    WHERE data_iso BETWEEN ? AND ?
      AND credito > 0
      AND (
        upper(historico) LIKE '%GOVERNO%' OR
        upper(historico) LIKE '%TESOURO%' OR
        upper(historico) LIKE '%TOCANTINS%' OR
        upper(historico) LIKE '%DETRAN%' OR
        upper(historico) LIKE '%UNITINS%' OR
        upper(historico) LIKE '%SECR%' OR
        upper(historico) LIKE '%ORDEM BANC%' OR
        upper(historico) LIKE '%ORDENS BANC%' OR
        upper(historico) LIKE '%01786029%' OR
        upper(historico) LIKE '%MUNICIPIO%' OR
        upper(historico) LIKE '%PALMAS%'
      )
  `).all(extIni, extFim);

  // Dedup
  const seen = new Set();
  const extsDedup = [];
  for (const e of exts) {
    const h = (e.historico || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 30);
    const k = `${e.data_iso}|${e.credito.toFixed(2)}|${h}`;
    if (seen.has(k)) continue;
    seen.add(k);
    extsDedup.push(e);
  }
  console.log(`  Extratos candidatos no período (dedup): ${extsDedup.length}`);

  // IDs já usados
  const idsUsados = new Set();
  const addU = (sql) => {
    try { for (const r of db.prepare(sql).all()) if (r.extrato_id) idsUsados.add(String(r.extrato_id)); }
    catch (e) { /* ok */ }
  };
  addU(`SELECT DISTINCT extrato_id FROM notas_fiscais WHERE extrato_id IS NOT NULL AND extrato_id != ''`);
  addU(`SELECT DISTINCT extrato_id FROM pagamentos_portal WHERE extrato_id IS NOT NULL AND extrato_id != ''`);

  // 3. Matching
  const matches = [];
  const extUsados = new Set();

  for (const tol of [
    { nome: 'A (exato)', max: 0.10, pct: false },
    { nome: 'B (0,5%)', max: 0.005, pct: true },
    { nome: 'C (2%)', max: 0.02, pct: true },
  ]) {
    for (const p of pagsCge) {
      if (p._matched) continue;
      if (!p.dt) continue;
      const limite = tol.pct ? p.valor_pago * tol.max : tol.max;
      const janIni = addDias(p.dt, -2);
      const janFim = addDias(p.dt, 15);
      const cands = extsDedup.filter(e =>
        !extUsados.has(e.id) &&
        !idsUsados.has(String(e.id)) &&
        e.data_iso >= janIni && e.data_iso <= janFim &&
        Math.abs(e.credito - p.valor_pago) <= limite
      );
      if (cands.length === 1) {
        const ext = cands[0];
        extUsados.add(ext.id);
        p._matched = true;
        matches.push({
          pag_id: p.id, ext_id: ext.id, dt_pag: p.dt, dt_ext: ext.data_iso,
          valor_pag: p.valor_pago, valor_ext: ext.credito,
          gestao: p.gestao, passo: tol.nome,
        });
      }
    }
  }

  console.log(`\n  ✅ Matches pag→ext: ${matches.length} / ${pagsCge.length}`);
  const naoMatch = pagsCge.filter(p => !p._matched);
  if (naoMatch.length > 0) {
    console.log(`  ⚠️  Sem match: ${naoMatch.length}`);
    console.log('  Pagamentos CGE sem extrato correspondente (top 10 por valor):');
    for (const p of naoMatch.sort((a, b) => b.valor_pago - a.valor_pago).slice(0, 10)) {
      console.log(`     pag ${String(p.id).padStart(6)} | ${p.dt} | R$ ${brl(p.valor_pago).padStart(14)} | ${(p.gestao||'').slice(0, 40)}`);
    }
  }
  if (matches.length > 0) {
    console.log('\n  Amostra matches (top 10 por valor):');
    for (const m of matches.sort((a, b) => b.valor_pag - a.valor_pag).slice(0, 10)) {
      console.log(`     pag ${String(m.pag_id).padStart(6)} | ${m.dt_pag} → ext ${String(m.ext_id).padStart(8)} | ${m.dt_ext} | R$ ${brl(m.valor_pag).padStart(14)} | ${m.passo}`);
    }
  }

  const totalValor = matches.reduce((s, m) => s + m.valor_pag, 0);
  console.log(`\n  💰 Valor total conciliado: R$ ${brl(totalValor)}`);

  if (!APPLY) {
    console.log('\n  ⚠️  Dry-run. Rode com --apply para gravar.');
    db.close();
    return { pag: matches.length };
  }

  const updPag = db.prepare(`UPDATE pagamentos_portal SET extrato_id = ?, status_match = 'MATCHED_CGE' WHERE id = ?`);
  const tx = db.transaction(() => {
    let n = 0;
    for (const m of matches) { updPag.run(String(m.ext_id), m.pag_id); n++; }
    console.log(`\n  ✅ ${n} pagamentos CGE vinculados a extrato`);
  });
  tx();
  db.close();
  return { pag: matches.length };
}

console.log('\n🔗 MATCHING ESTADUAL/TO — pagamentos_portal CGE × extratos');
const empresas = empArg === 'todas' ? ['assessoria', 'seguranca'] : [empArg];
let tot = 0;
for (const e of empresas) tot += processar(e).pag;
console.log('\n' + '═'.repeat(80));
console.log(`  TOTAL: ${tot} pagamentos vinculados ${APPLY ? '(GRAVADO)' : '(dry-run)'}`);
console.log('═'.repeat(80));
