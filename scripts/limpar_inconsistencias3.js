#!/usr/bin/env node
/**
 * Montana — Limpeza nível 3 (status + extratos órfãos)
 *
 * 1. Normalizar campo extratos.status:
 *    - Limpa escapes \u0000 e emojis não-canônicos
 *    - Mapeia variações (✅ CONCILIADO, 🔄 TRANSFERÊNCIA INTERNA, etc) para valores padronizados
 *    Canônicos: '', CONCILIADO, PENDENTE, INVESTIMENTO, INTERNO, DEVOLVIDO,
 *               CONTA_VINCULADA, TRANSFERENCIA, RETENCAO_IMPOSTOS
 *
 * 2. Extratos CONCILIADO (status_conciliacao) sem NF apontando:
 *    - Tentar re-match com NF por valor+data (±0.5%, ±30d)
 *    - Se não achar, rebaixar status_conciliacao para PENDENTE
 *
 * Uso:
 *   node scripts/limpar_inconsistencias3.js [empresa]           # dry-run
 *   node scripts/limpar_inconsistencias3.js [empresa] --apply
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const posArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));
const empArg = (posArgs[0] || 'todas').toLowerCase();

// Normaliza status: remove emojis, escapes, maiúsculas
function normStatus(raw) {
  if (!raw) return '';
  // Decodifica escapes JS \uXXXX
  let s = raw.replace(/\\u([0-9a-fA-F]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16)));
  // Remove emojis, acentos, espaços extras
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[^\w\s\-_]/g, '').trim().toUpperCase();
  // Mapeamento para formas canônicas
  if (/CONCILIAD/.test(s)) return 'CONCILIADO';
  if (/PENDENTE/.test(s)) return 'PENDENTE';
  if (/INVESTI/.test(s)) return 'INVESTIMENTO';
  if (/INTERN/.test(s)) return 'INTERNO';
  if (/DEVOLVI/.test(s)) return 'DEVOLVIDO';
  if (/CONTA.*VINCUL|VINCUL/.test(s)) return 'CONTA_VINCULADA';
  if (/TRANSFER/.test(s)) return 'TRANSFERENCIA';
  if (/RETENC.*IMPOST|IMPOST/.test(s)) return 'RETENCAO_IMPOSTOS';
  if (/DEBITO|DBITO/.test(s)) return '';
  if (/BOLETO.*DEVOLV/.test(s)) return 'DEVOLVIDO';
  if (/NEVADA|MUSTANG|MONTREAL|PORTO/.test(s)) return 'INTERNO'; // intragrupo
  if (/ESTADO.*TO/.test(s)) return 'CONCILIADO'; // pagamentos estaduais
  return s;
}

function processar(empresa) {
  const db = getDb(empresa);
  console.log('\n' + '═'.repeat(90));
  console.log(`  LIMPAR NÍVEL 3 — ${empresa.toUpperCase()}  ${APPLY ? '[APPLY]' : '[dry-run]'}`);
  console.log('═'.repeat(90));

  // ── 1. Normalizar status
  console.log('\n── 1. Normalizar extratos.status ──');
  const todos = db.prepare('SELECT id, status FROM extratos WHERE status IS NOT NULL AND TRIM(status) <> \'\'').all();
  const changes = {};
  let normCount = 0;
  for (const r of todos) {
    const novo = normStatus(r.status);
    if (novo !== r.status) {
      if (!changes[r.status]) changes[r.status] = { novo, q: 0 };
      changes[r.status].q++;
      normCount++;
    }
  }
  for (const [de, { novo, q }] of Object.entries(changes)) {
    console.log(`   "${de.slice(0, 40)}" → "${novo}" | ${q} extratos`);
  }
  if (normCount === 0) console.log('   ✅ nenhuma normalização necessária');
  if (APPLY && normCount > 0) {
    const up = db.prepare('UPDATE extratos SET status = ? WHERE id = ?');
    const tx = db.transaction(() => {
      for (const r of todos) {
        const novo = normStatus(r.status);
        if (novo !== r.status) up.run(novo, r.id);
      }
    });
    tx();
  }

  // ── 2. Extratos CONCILIADO órfãos
  console.log('\n── 2. Extratos CONCILIADO sem NF apontando ──');
  const orfaos = db.prepare(`
    SELECT id, data_iso, credito FROM extratos
    WHERE status_conciliacao = 'CONCILIADO'
      AND credito > 0
      AND NOT EXISTS(SELECT 1 FROM notas_fiscais WHERE extrato_id = extratos.id)
  `).all();
  console.log(`   ${orfaos.length} extratos CONCILIADO sem NF`);

  let relinked = 0;
  let rebaixados = 0;
  for (const ex of orfaos) {
    // Tenta re-match com NF por valor+data
    const match = db.prepare(`
      SELECT id FROM notas_fiscais
      WHERE extrato_id IS NULL
        AND valor_liquido > 0
        AND ABS(valor_liquido - ?) < ?
        AND (
          (data_pagamento IS NOT NULL AND date(data_pagamento) BETWEEN date(?, '-30 days') AND date(?, '+30 days'))
          OR
          (data_pagamento IS NULL AND date(data_emissao) BETWEEN date(?, '-90 days') AND date(?, '+30 days'))
        )
      ORDER BY ABS(julianday(COALESCE(data_pagamento, data_emissao)) - julianday(?)) ASC
      LIMIT 1
    `).get(ex.credito, ex.credito * 0.005, ex.data_iso, ex.data_iso, ex.data_iso, ex.data_iso, ex.data_iso);

    if (match) {
      if (APPLY) {
        db.prepare('UPDATE notas_fiscais SET extrato_id = ?, status_conciliacao = ? WHERE id = ?').run(ex.id, 'CONCILIADO', match.id);
      }
      relinked++;
    } else {
      if (APPLY) {
        db.prepare("UPDATE extratos SET status_conciliacao = 'PENDENTE' WHERE id = ?").run(ex.id);
      }
      rebaixados++;
    }
  }
  console.log(`   → ${relinked} extratos re-linkados com NF`);
  console.log(`   → ${rebaixados} extratos rebaixados CONCILIADO → PENDENTE`);

  db.close();
  return { normCount, relinked, rebaixados };
}

const empresas = empArg === 'todas' ? ['assessoria', 'seguranca'] : [empArg];
const tot = { normCount: 0, relinked: 0, rebaixados: 0 };
for (const e of empresas) {
  const r = processar(e);
  for (const k of Object.keys(tot)) tot[k] += r[k];
}

console.log('\n' + '═'.repeat(90));
console.log(`  RESUMO GERAL ${APPLY ? '[APPLIED]' : '[DRY-RUN]'}`);
console.log('═'.repeat(90));
console.log(`  extratos.status normalizados      : ${tot.normCount}`);
console.log(`  Extratos re-linkados a NF         : ${tot.relinked}`);
console.log(`  Extratos rebaixados a PENDENTE    : ${tot.rebaixados}`);
if (!APPLY) console.log('\n  ⚠️  Nada gravado. Use --apply.');
