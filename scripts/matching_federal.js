'use strict';
/**
 * Matching Federal — cruza pagamentos_portal (federal/Tesouro) com extratos UFT/UFNT.
 *
 * Algoritmo:
 *   Para cada pagamento federal com valor > 0 e data dentro do período:
 *     1. Procurar extrato com credito ≈ valor_pago (±R$0,10)
 *        janela [data_pagamento − 1d, data_pagamento + 7d] (crédito cai até 1 semana depois)
 *     2. Se único match, gravar extrato_id em pagamentos_portal
 *     3. Tentar casar o mesmo extrato a uma NF (valor_liquido ≈ credito, tolerância 0,5%)
 *
 * Uso:
 *   node scripts/matching_federal.js [empresa] [--mes=M --ano=A]          (dry-run)
 *   node scripts/matching_federal.js [empresa] [--mes=M --ano=A] --apply  (grava)
 *
 * Padrão: empresa=todas, período = últimos 6 meses
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const argMap = {};
process.argv.slice(2).forEach(a => {
  if (a.startsWith('--') && a.includes('=')) {
    const [k, v] = a.replace(/^--/, '').split('=');
    argMap[k] = v;
  }
});
const argsPos = process.argv.slice(2).filter(a => !a.startsWith('--'));
const empArg = (argsPos[0] || 'todas').toLowerCase();

function brl(n) { return (n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function addDias(iso, dias) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function processar(empresa, periodo) {
  const db = getDb(empresa);
  console.log('\n' + '═'.repeat(80));
  console.log(`  ${empresa.toUpperCase()} — Matching FEDERAL (${periodo.inicio} → ${periodo.fim})`);
  console.log('═'.repeat(80));

  // 1. Pagamentos federais com valor > 0 no período (sem extrato_id ainda)
  const pagsFed = db.prepare(`
    SELECT id, valor_pago, gestao, fornecedor, empenho,
      COALESCE(NULLIF(data_pagamento_iso,''), NULLIF(data_liquidacao_iso,''), NULLIF(data_empenho_iso,'')) dt
    FROM pagamentos_portal
    WHERE (portal LIKE 'federal%' OR portal='federal')
      AND valor_pago > 0
      AND (extrato_id IS NULL OR extrato_id = '')
      AND COALESCE(NULLIF(data_pagamento_iso,''), NULLIF(data_liquidacao_iso,''), NULLIF(data_empenho_iso,'')) BETWEEN ? AND ?
    ORDER BY dt, valor_pago DESC
  `).all(periodo.inicio, periodo.fim);
  console.log(`  Pagamentos federais sem extrato_id: ${pagsFed.length}`);
  if (pagsFed.length === 0) { db.close(); return { pag: 0, ext: 0, nf: 0 }; }

  // 2. Extratos crédito UFT/UFNT sem NF vinculada no período (janela ampliada ±15d)
  const extIni = addDias(periodo.inicio, -2);
  const extFim = addDias(periodo.fim, 15);
  const exts = db.prepare(`
    SELECT id, data_iso, historico, credito
    FROM extratos
    WHERE data_iso BETWEEN ? AND ?
      AND credito > 0
      AND (
        upper(historico) LIKE '%FUNDACAO UN%' OR
        upper(historico) LIKE '%FUNDA__O UN%' OR
        upper(historico) LIKE '%UFT%' OR
        upper(historico) LIKE '%UFNT%' OR
        upper(historico) LIKE '%05149726%' OR
        upper(historico) LIKE '%381788%' OR
        upper(historico) LIKE '%SEC TES NAC%' OR
        upper(historico) LIKE '%TESOURO NAC%'
      )
  `).all(extIni, extFim);
  // Dedup extratos (chave normalizada)
  const seen = new Set();
  const extsDedup = [];
  for (const e of exts) {
    const h = (e.historico || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 30);
    const k = `${e.data_iso}|${e.credito.toFixed(2)}|${h}`;
    if (seen.has(k)) continue;
    seen.add(k);
    extsDedup.push(e);
  }
  console.log(`  Extratos UFT/UFNT crédito no período (dedup): ${extsDedup.length}`);

  // 3. IDs já vinculados a NFs (pular)
  const idsComNf = new Set(
    db.prepare(`SELECT DISTINCT extrato_id FROM notas_fiscais WHERE extrato_id IS NOT NULL AND extrato_id != ''`)
      .all().map(r => String(r.extrato_id))
  );
  // 4. IDs já vinculados a pagamentos_portal
  const idsComPag = new Set(
    db.prepare(`SELECT DISTINCT extrato_id FROM pagamentos_portal WHERE extrato_id IS NOT NULL AND extrato_id != ''`)
      .all().map(r => String(r.extrato_id))
  );

  // 5. Matching: pagamento → extrato
  const matches = []; // {pag_id, ext_id, dt_pag, dt_ext, valor}
  const extUsados = new Set();

  for (const tolN of [{ nome: 'A (exato)', max: 0.10, pct: false },
                       { nome: 'B (0,5%)', max: 0.005, pct: true }]) {
    for (const p of pagsFed) {
      if (p._matched) continue;
      if (!p.dt) continue;
      const limite = tolN.pct ? p.valor_pago * tolN.max : tolN.max;
      const janIni = addDias(p.dt, -2);
      const janFim = addDias(p.dt, 15);
      const cands = extsDedup.filter(e =>
        !extUsados.has(e.id) &&
        !idsComNf.has(String(e.id)) &&
        !idsComPag.has(String(e.id)) &&
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
          gestao: p.gestao, passo: tolN.nome,
        });
      }
    }
  }

  console.log(`\n  ✅ Matches pag→ext: ${matches.length}`);
  if (matches.length > 0) {
    console.log('  Amostra (top 10 por valor):');
    for (const m of matches.sort((a, b) => b.valor_pag - a.valor_pag).slice(0, 10)) {
      console.log(`     pag ${String(m.pag_id).padStart(6)} | ${m.dt_pag} → ext ${String(m.ext_id).padStart(8)} | ${m.dt_ext} | R$ ${brl(m.valor_pag).padStart(14)} | ${m.passo}`);
    }
  }

  // 6. Tentar também linkar NF para cada extrato matchado
  const nfLinks = []; // {ext_id, nf_id, nf_numero}
  for (const m of matches) {
    const ext = extsDedup.find(e => e.id === m.ext_id);
    if (!ext) continue;
    // Buscar NF valor_liquido ≈ credito, tomador UFT/UFNT, status != CANCELADA, sem data_pagamento
    const cand = db.prepare(`
      SELECT id, numero, valor_liquido
      FROM notas_fiscais
      WHERE status_conciliacao != 'CANCELADA'
        AND (data_pagamento IS NULL OR data_pagamento = '')
        AND (upper(tomador) LIKE '%UFT%' OR upper(tomador) LIKE '%UFNT%' OR upper(tomador) LIKE '%FUNDACAO UNIVERSIDADE FEDERAL%' OR upper(tomador) LIKE '%FUNDA__O UNIVERSIDADE FEDERAL%')
        AND ABS(valor_liquido - ?) <= 0.10
      LIMIT 2
    `).all(ext.credito);
    if (cand.length === 1) {
      nfLinks.push({ ext_id: ext.id, nf_id: cand[0].id, nf_numero: cand[0].numero, data_pag: ext.data_iso, valor: ext.credito });
    }
  }
  console.log(`  ✅ Matches ext→NF (bônus): ${nfLinks.length}`);

  const totalValor = matches.reduce((s, m) => s + m.valor_pag, 0);
  console.log(`\n  💰 Valor total conciliado: R$ ${brl(totalValor)}`);

  if (!APPLY) {
    console.log('\n  ⚠️  Dry-run. Rode com --apply para gravar.');
    db.close();
    return { pag: matches.length, ext: matches.length, nf: nfLinks.length };
  }

  // 7. Gravar
  const updPag = db.prepare(`UPDATE pagamentos_portal SET extrato_id = ?, status_match = 'MATCHED_FED', nf_id = COALESCE(?, nf_id) WHERE id = ?`);
  const updNf = db.prepare(`UPDATE notas_fiscais SET extrato_id = ?, data_pagamento = ?, status_conciliacao = 'CONCILIADO' WHERE id = ?`);
  const tx = db.transaction(() => {
    let nPag = 0, nNf = 0;
    for (const m of matches) {
      const nfLink = nfLinks.find(n => n.ext_id === m.ext_id);
      updPag.run(String(m.ext_id), nfLink ? nfLink.nf_id : null, m.pag_id);
      nPag++;
      if (nfLink) {
        updNf.run(String(nfLink.ext_id), nfLink.data_pag, nfLink.nf_id);
        nNf++;
      }
    }
    console.log(`\n  ✅ ${nPag} pagamentos federais vinculados a extrato`);
    console.log(`  ✅ ${nNf} NFs UFT/UFNT também vinculadas (bônus)`);
  });
  tx();
  db.close();
  return { pag: matches.length, ext: matches.length, nf: nfLinks.length };
}

// ── EXECUÇÃO ─────────────────────────────────────────────────────
const hoje = new Date();
const mes = argMap.mes ? parseInt(argMap.mes) : null;
const ano = argMap.ano ? parseInt(argMap.ano) : null;
let periodo;
if (mes && ano) {
  const dI = `${ano}-${String(mes).padStart(2, '0')}-01`;
  const ultimoDia = new Date(ano, mes, 0).getDate();
  const dF = `${ano}-${String(mes).padStart(2, '0')}-${String(ultimoDia).padStart(2, '0')}`;
  periodo = { inicio: dI, fim: dF };
} else {
  // Últimos 6 meses
  const seis = new Date(hoje); seis.setMonth(seis.getMonth() - 6);
  periodo = { inicio: seis.toISOString().slice(0, 10), fim: hoje.toISOString().slice(0, 10) };
}

console.log('\n🔗 MATCHING FEDERAL — pagamentos_portal × extratos UFT/UFNT');
const empresas = empArg === 'todas' ? ['assessoria', 'seguranca'] : [empArg];
const tot = { pag: 0, ext: 0, nf: 0 };
for (const e of empresas) {
  const r = processar(e, periodo);
  tot.pag += r.pag; tot.nf += r.nf;
}
console.log('\n' + '═'.repeat(80));
console.log(`  TOTAL: ${tot.pag} pagamentos vinculados | ${tot.nf} NFs extras conciliadas ${APPLY ? '(GRAVADO)' : '(dry-run)'}`);
console.log('═'.repeat(80));
