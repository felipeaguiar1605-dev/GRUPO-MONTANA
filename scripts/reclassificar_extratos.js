'use strict';
/**
 * Re-classifica créditos PENDENTE usando patterns expandidos e consolida
 * status espúrios (FEDERAL_*) em CONCILIADO.
 *
 * Padrões identificados em auditoria (dashboard 2026-04-18):
 *   - INTERNO:        transferências grupo (MONTANA S/ASS, NEVADA, PORTO DO VAU, MUSTANG)
 *   - INVESTIMENTO:   aplicações/resgates automáticos BB
 *   - TRANSFERENCIA:  TED/PIX genéricos NÃO identificados como contrato
 *   - DEVOLVIDO:      PIX rejeitado, TED devolvida, boleto devolvido, bacen/desbl. judicial
 *   - CONTA_VINCULADA: conta 031.015.240-2 (BRB — IN SEGES/MP 05/2017)
 *   - CONCILIADO (consolidar): status FEDERAL_* (Ordens Bancárias já vinculadas)
 *
 * Uso:
 *   node scripts/reclassificar_extratos.js [empresa]          (dry-run)
 *   node scripts/reclassificar_extratos.js [empresa] --apply  (grava)
 *   node scripts/reclassificar_extratos.js todas --apply
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const argsPos = process.argv.slice(2).filter(a => !a.startsWith('--'));
const empArg = (argsPos[0] || 'todas').toLowerCase();

const CONTAS_VINCULADAS = new Set(['031.015.240-2']);

// Regras em ordem de prioridade (primeira que bate classifica)
const REGRAS = [
  // DEVOLVIDO (prioritário para não ser confundido com receita)
  { cat: 'DEVOLVIDO', patterns: [
    /TED\s+DEVOLVID/i, /BOLETO\s+DEVOLVID/i, /PIX\s*-?\s*REJEITADO/i, /PIX\s+DEVOLVID/i,
    /ESTORNO/i, /DESBL\s+JUDICIAL/i, /BACEN\s+JUD/i, /DEVOLU[CÇ][AÃ]O/i,
  ]},
  // INTERNO — grupo Montana
  { cat: 'INTERNO', patterns: [
    /MONTANA\s+ASSESSORIA/i, /MONTANA\s+ASSESS/i, /14092519000151/i,
    /MONTANA\s+SEG/i, /MONTANA\s+VIGILANCIA/i, /19200109000109/i,
    /MONTANA\s+S\s+LTDA/i, /MONTANA\s+SERVICOS/i, /MONTANA\s+SERV/i,
    /NEVADA\s+M\s+LIMPEZA/i, /NEVADA\s+EMBALAGENS/i,
    /PORTO\s+(V\s+S\s+PR|DO\s+VAU|VAU)/i,
    /MUSTANG\s+G\s+E/i,
    /TRANSFERENCIA\s+ENTRE\s+CONTAS/i, /ENTRE\s+CONTAS\s+PROP/i, /TED\s+ENTRE\s+CONTAS/i,
    /TRANSFER.INTERNA/i,
    /RESGATE\s+DEP(OSITO)?\s+GARANTIA/i,
    /TRANSFERIDO\s+DA\s+POUPAN/i,
  ]},
  // INVESTIMENTO
  { cat: 'INVESTIMENTO', patterns: [
    /BB\s+RENDE\s+F/i, /RENDE\s+F[AÁ]CIL/i,
    /RESGATE\s+(CDB|LCI|LCA|BB\s+CDB)/i, /CDB\s+DI/i,
    /APLIC(\.|\s)?AUTOM/i, /APLIC(\.|\s)?BB/i,
    /RESG(\.|\s)?AUTOM/i,
  ]},
];

function reclassificar(empresa) {
  const db = getDb(empresa);
  console.log('\n' + '═'.repeat(80));
  console.log(`  ${empresa.toUpperCase()} — Re-classificar extratos`);
  console.log('═'.repeat(80));

  // 1. FEDERAL_* → CONCILIADO (preserva código OB em obs com prefixo "OB:")
  const federais = db.prepare(`
    SELECT id, status_conciliacao, obs
    FROM extratos WHERE credito > 0 AND status_conciliacao LIKE 'FEDERAL_%'
  `).all();
  if (federais.length > 0) {
    const totFed = db.prepare(`SELECT COALESCE(SUM(credito),0) t FROM extratos WHERE status_conciliacao LIKE 'FEDERAL_%' AND credito > 0`).get().t;
    console.log(`\n[1] Consolidar status FEDERAL_* → CONCILIADO (preserva código OB em obs):`);
    console.log(`    ${federais.length} linhas | R$ ${totFed.toLocaleString('pt-BR',{minimumFractionDigits:2})}`);
    if (APPLY) {
      const stmt = db.prepare(`UPDATE extratos SET status_conciliacao='CONCILIADO', obs=? WHERE id=?`);
      const tx = db.transaction((rows) => {
        for (const r of rows) {
          const cod = r.status_conciliacao.replace(/^FEDERAL_/, '');
          const obsNovo = r.obs ? `OB:${cod} | ${r.obs}` : `OB:${cod}`;
          stmt.run(obsNovo, r.id);
        }
      });
      tx(federais);
      console.log(`    ✓ atualizados: ${federais.length} (código OB movido para obs)`);
    }
  } else {
    console.log(`\n[1] Nenhum status FEDERAL_* a consolidar.`);
  }

  // 2. Conta vinculada → CONTA_VINCULADA (prioritário)
  const contas = [...CONTAS_VINCULADAS].map(c => `'${c}'`).join(',');
  const ctaVinc = db.prepare(`
    SELECT COUNT(*) q, COALESCE(SUM(credito),0) tot
    FROM extratos
    WHERE credito > 0 AND conta IN (${contas})
      AND (status_conciliacao IS NULL OR status_conciliacao IN ('PENDENTE',''))
  `).get();
  if (ctaVinc.q > 0) {
    console.log(`\n[2] Créditos em conta vinculada (${contas}) → CONTA_VINCULADA:`);
    console.log(`    ${ctaVinc.q} linhas | R$ ${ctaVinc.tot.toLocaleString('pt-BR',{minimumFractionDigits:2})}`);
    if (APPLY) {
      const r = db.prepare(`
        UPDATE extratos SET status_conciliacao='CONTA_VINCULADA'
        WHERE credito > 0 AND conta IN (${contas})
          AND (status_conciliacao IS NULL OR status_conciliacao IN ('PENDENTE',''))
      `).run();
      console.log(`    ✓ atualizados: ${r.changes}`);
    }
  } else {
    console.log(`\n[2] Nenhum crédito pendente em conta vinculada.`);
  }

  // 3. Regras de histórico nos PENDENTE
  const pendentes = db.prepare(`
    SELECT id, historico, credito, conta
    FROM extratos
    WHERE credito > 0
      AND (status_conciliacao IS NULL OR status_conciliacao IN ('PENDENTE',''))
  `).all();

  const matches = { DEVOLVIDO: [], INTERNO: [], INVESTIMENTO: [] };
  for (const e of pendentes) {
    // Pula conta vinculada (já tratada acima)
    if (CONTAS_VINCULADAS.has(e.conta)) continue;
    const hist = e.historico || '';
    for (const regra of REGRAS) {
      if (regra.patterns.some(r => r.test(hist))) {
        matches[regra.cat].push(e);
        break;
      }
    }
  }

  console.log(`\n[3] Re-classificação de créditos PENDENTE por histórico:`);
  for (const cat of Object.keys(matches)) {
    const arr = matches[cat];
    if (arr.length === 0) {
      console.log(`    ${cat.padEnd(15)} — 0 linhas`);
      continue;
    }
    const total = arr.reduce((s, e) => s + e.credito, 0);
    console.log(`    ${cat.padEnd(15)} — ${String(arr.length).padStart(4)} linhas | R$ ${total.toLocaleString('pt-BR',{minimumFractionDigits:2})}`);
    // Amostra: 3 primeiros
    arr.slice(0, 3).forEach(e => {
      const h = (e.historico || '').slice(0, 70);
      console.log(`      • R$ ${e.credito.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(12)} — ${h}`);
    });
    if (arr.length > 3) console.log(`      ... +${arr.length - 3} linhas`);

    if (APPLY) {
      const stmt = db.prepare(`UPDATE extratos SET status_conciliacao=? WHERE id=? AND (status_conciliacao IS NULL OR status_conciliacao IN ('PENDENTE',''))`);
      const tx = db.transaction((ids) => {
        for (const id of ids) stmt.run(cat, id);
      });
      tx(arr.map(e => e.id));
      console.log(`    ✓ ${arr.length} gravados como ${cat}`);
    }
  }

  // 4. Resumo final
  console.log(`\n[4] Distribuição atual (após ${APPLY ? 'APPLY' : 'dry-run'}):`);
  const dist = db.prepare(`
    SELECT
      CASE
        WHEN status_conciliacao LIKE 'FEDERAL_%' THEN 'FEDERAL_*'
        ELSE COALESCE(NULLIF(status_conciliacao,''), '(null/PENDENTE)')
      END AS s,
      COUNT(*) q, COALESCE(SUM(credito),0) tot
    FROM extratos WHERE credito > 0
    GROUP BY s ORDER BY tot DESC LIMIT 15
  `).all();
  for (const d of dist) {
    console.log(`    ${d.s.padEnd(20)} | ${String(d.q).padStart(5)} | R$ ${d.tot.toLocaleString('pt-BR',{minimumFractionDigits:2})}`);
  }

  db.close();
  return matches;
}

console.log('\n🔄 RE-CLASSIFICAÇÃO DE EXTRATOS');
console.log(`   Modo: ${APPLY ? 'APLICAR (grava)' : 'DRY-RUN (não grava — rode com --apply para gravar)'}`);

const empresas = empArg === 'todas' ? ['assessoria', 'seguranca'] : [empArg];
for (const e of empresas) reclassificar(e);

console.log('\n' + '═'.repeat(80));
console.log(`  ${APPLY ? '✓ GRAVADO' : '(dry-run — sem gravação)'}`);
console.log('═'.repeat(80));
