#!/usr/bin/env node
/**
 * Verificação rápida dos novos campos do /dashboard:
 *   - debito_aplicacoes
 *   - debito_intragrupo
 *   - despesa_operacional
 *
 * Uso:
 *   node scripts/verificar_despesa_operacional.js [empresa] [ano] [mes]
 *   default: assessoria 2026 3
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const empresa = (process.argv[2] || 'assessoria').toLowerCase();
const ano = parseInt(process.argv[3] || '2026', 10);
const mes = parseInt(process.argv[4] || '3', 10);

const from = `${ano}-${String(mes).padStart(2,'0')}-01`;
const lastDay = new Date(ano, mes, 0).getDate();
const to = `${ano}-${String(mes).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

const DEBITO_APLICACAO = `(
  UPPER(historico) LIKE '%BB RENDE%' OR
  UPPER(historico) LIKE '%RENDE FACIL%' OR
  UPPER(historico) LIKE '%RENDE F_CIL%' OR
  UPPER(historico) LIKE '%CDB%' OR
  UPPER(historico) LIKE '%LCI%' OR
  UPPER(historico) LIKE '%LCA%' OR
  UPPER(historico) LIKE '%POUPAN%' OR
  UPPER(historico) LIKE '%APLICAC%' OR
  UPPER(historico) LIKE '%APLICA_%'
)`;

const DEBITO_INTRAGRUPO = `(
  (
    UPPER(historico) LIKE '%MONTANA ASS%' OR
    UPPER(historico) LIKE '%MONTANA S LTDA%' OR
    UPPER(historico) LIKE '%MONTANA SERVICOS%' OR
    UPPER(historico) LIKE '%MONTANA SEG%' OR
    UPPER(historico) LIKE '%MONTREAL%' OR
    UPPER(historico) LIKE '%NEVADA%' OR
    UPPER(historico) LIKE '%PORTO DO VAU%' OR
    UPPER(historico) LIKE '%PORTODOVAU%' OR
    UPPER(historico) LIKE '%MUSTANG%' OR
    UPPER(historico) LIKE '%OHIO MED%' OR
    UPPER(historico) LIKE '%MESMA TITULARIDADE%' OR
    UPPER(historico) LIKE '%CH.AVULSO ENTRE AG%' OR
    UPPER(historico) LIKE '%TED MESMA TITUL%'
  )
  AND NOT (UPPER(historico) LIKE '%FUNC%' OR UPPER(historico) LIKE '%EMPREG%')
)`;

const db = getDb(empresa);
const row = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN debito > 0 THEN debito END), 0) as total_debitos,
    COALESCE(SUM(CASE WHEN debito > 0 AND ${DEBITO_APLICACAO} THEN debito END), 0) as debito_aplicacoes,
    COALESCE(SUM(CASE WHEN debito > 0 AND ${DEBITO_INTRAGRUPO} THEN debito END), 0) as debito_intragrupo,
    COALESCE(SUM(CASE
      WHEN debito > 0
       AND NOT ${DEBITO_APLICACAO}
       AND NOT ${DEBITO_INTRAGRUPO}
      THEN debito END), 0) as despesa_operacional,
    COUNT(CASE WHEN debito > 0 THEN 1 END) as qtd_debitos
  FROM extratos
  WHERE data_iso BETWEEN ? AND ?
`).get(from, to);

const fmt = v => (v||0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

console.log('');
console.log('═'.repeat(80));
console.log(`  VERIFICAÇÃO — ${empresa.toUpperCase()}  ${from} → ${to}`);
console.log('═'.repeat(80));
console.log(`  Total débitos         : R$ ${fmt(row.total_debitos).padStart(18)}   (${row.qtd_debitos} lanç.)`);
console.log(`    ─ Aplicações fin.   : R$ ${fmt(row.debito_aplicacoes).padStart(18)}`);
console.log(`    ─ Intragrupo        : R$ ${fmt(row.debito_intragrupo).padStart(18)}`);
console.log(`  ✅ Despesa operacional: R$ ${fmt(row.despesa_operacional).padStart(18)}`);
console.log('═'.repeat(80));
console.log('');

// Sanidade matemática
const delta = row.total_debitos - row.debito_aplicacoes - row.debito_intragrupo - row.despesa_operacional;
if (Math.abs(delta) > 0.01) {
  console.log(`⚠️  DIVERGÊNCIA: total − aplic − intra − operacional = ${fmt(delta)}`);
  process.exit(1);
} else {
  console.log(`✔  Sanidade: total = aplicações + intragrupo + operacional`);
}
