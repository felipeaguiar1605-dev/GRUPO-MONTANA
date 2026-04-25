'use strict';
/**
 * Popula `data_pagamento` e `extrato_id` nas NFs status=CONCILIADO
 * que foram conciliadas no passado mas não tiveram esses campos gravados.
 *
 * Algoritmo (idêntico ao matching da conciliação):
 *   Passo A — 1:1 exato: extrato.credito ≈ NF.valor_liquido (±R$0,10), janela [emissão, emissão+90d]
 *   Passo B — tolerância 0,5%: ±0,5% sobre valor_liquido
 *   Passo C — tolerância 2%: ±2% (captura ajustes de ISS/retenção/glosa menor)
 *
 * Só grava se match é ÚNICO (evita falso positivo).
 *
 * Uso:
 *   node scripts/popular_data_pagamento.js [empresa]          (dry-run)
 *   node scripts/popular_data_pagamento.js [empresa] --apply  (grava)
 *
 * empresa = assessoria | seguranca | todas (default: todas)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APPLY = process.argv.includes('--apply');
// process.argv: [node.exe, script.js, ...]
const argsLimpos = process.argv.slice(2).filter(a => !a.startsWith('--'));
const empArg = (argsLimpos[0] || 'todas').toLowerCase();

// Dedup extratos (mesma lógica do relatório)
function dedupExtratos(exts) {
  const seen = new Set();
  const out = [];
  for (const e of exts) {
    const hist = (e.historico || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 30);
    const k = `${e.data_iso}|${(e.credito||0).toFixed(2)}|${hist}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

function addDias(iso, dias) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function processar(empresa) {
  const db = getDb(empresa);
  console.log('\n' + '═'.repeat(80));
  console.log(`  ${empresa.toUpperCase()} — Popular data_pagamento das NFs CONCILIADO`);
  console.log('═'.repeat(80));

  // NFs CONCILIADO sem data_pagamento
  const nfs = db.prepare(`
    SELECT id, numero, data_emissao, tomador, valor_bruto, valor_liquido, extrato_id, data_pagamento
    FROM notas_fiscais
    WHERE status_conciliacao = 'CONCILIADO'
      AND (data_pagamento IS NULL OR data_pagamento = '')
  `).all();
  console.log(`\n  NFs CONCILIADO sem data_pagamento: ${nfs.length}`);
  if (nfs.length === 0) { db.close(); return { matched: 0, total: 0 }; }

  // Todos os extratos com crédito (dedup)
  const extsRaw = db.prepare(`
    SELECT id, data_iso, historico, credito, status_conciliacao
    FROM extratos
    WHERE credito > 0 AND data_iso IS NOT NULL AND data_iso != ''
  `).all();
  const exts = dedupExtratos(extsRaw);
  console.log(`  Extratos únicos (dedup): ${exts.length} (brutos: ${extsRaw.length})`);

  // Indexar extratos usados (1 extrato → 1 NF idealmente)
  const extUsados = new Set();
  const matches = []; // {nf_id, extrato_id, data_pagamento, passo, dif_pct}

  const tolerancias = [
    { nome: 'A (exato)', max: 0.10, pct: false },
    { nome: 'B (0,5%)',  max: 0.005, pct: true },
    { nome: 'C (2%)',    max: 0.02,  pct: true },
  ];

  for (const tol of tolerancias) {
    for (const nf of nfs) {
      if (nf._matched) continue;
      if (!nf.data_emissao) continue;
      const janIni = nf.data_emissao;
      const janFim = addDias(nf.data_emissao, 90);

      const diff = (ext) => Math.abs(ext.credito - nf.valor_liquido);
      const limite = tol.pct ? nf.valor_liquido * tol.max : tol.max;

      const cands = exts.filter(e =>
        !extUsados.has(e.id) &&
        e.data_iso >= janIni && e.data_iso <= janFim &&
        diff(e) <= limite
      );

      // Só aceita match único (ou múltiplos mas todos mesma data e valor)
      if (cands.length === 1) {
        const ext = cands[0];
        extUsados.add(ext.id);
        nf._matched = true;
        matches.push({
          nf_id: nf.id,
          nf_numero: nf.numero,
          nf_valor: nf.valor_liquido,
          extrato_id: ext.id,
          data_pagamento: ext.data_iso,
          ext_credito: ext.credito,
          passo: tol.nome,
          dif: (ext.credito - nf.valor_liquido).toFixed(2),
        });
      }
    }
  }

  const porPasso = matches.reduce((acc, m) => { acc[m.passo] = (acc[m.passo]||0)+1; return acc; }, {});
  console.log(`\n  ✅ Matches únicos encontrados: ${matches.length} / ${nfs.length}`);
  for (const [p, q] of Object.entries(porPasso)) console.log(`     Passo ${p}: ${q}`);

  const semMatch = nfs.length - matches.length;
  console.log(`  ⚠️  Sem match único: ${semMatch}`);

  if (matches.length > 0) {
    console.log('\n  Amostra primeiros 5 matches:');
    for (const m of matches.slice(0, 5)) {
      console.log(`     NF ${m.nf_numero} | R$ ${m.nf_valor.toFixed(2)} → extrato ${m.extrato_id} | ${m.data_pagamento} | R$ ${m.ext_credito.toFixed(2)} | dif ${m.dif} | ${m.passo}`);
    }
  }

  if (!APPLY) {
    console.log('\n  ⚠️  Dry-run. Rode com --apply para gravar.');
    db.close();
    return { matched: matches.length, total: nfs.length };
  }

  // Gravar
  const upd = db.prepare(`UPDATE notas_fiscais SET extrato_id = ?, data_pagamento = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    let n = 0;
    for (const m of matches) {
      upd.run(m.extrato_id, m.data_pagamento, m.nf_id);
      n++;
    }
    console.log(`\n  ✅ ${n} NFs atualizadas (extrato_id + data_pagamento)`);
  });
  tx();
  db.close();
  return { matched: matches.length, total: nfs.length };
}

console.log('\n🔧 POPULAR data_pagamento nas NFs CONCILIADO');
const empresas = empArg === 'todas' ? ['assessoria', 'seguranca'] : [empArg];
const totais = { matched: 0, total: 0 };
for (const e of empresas) {
  const r = processar(e);
  totais.matched += r.matched;
  totais.total += r.total;
}
console.log('\n' + '═'.repeat(80));
console.log(`  TOTAL: ${totais.matched} / ${totais.total} NFs resolvidas ${APPLY ? '(GRAVADO)' : '(dry-run)'}`);
console.log('═'.repeat(80));
