#!/usr/bin/env node
/**
 * Montana — Margem líquida por contrato
 *
 * Eixo: tabela `contratos` (numContrato). Joins:
 *   - Receita: notas_fiscais.contrato_ref = contratos.numContrato (paga = data_pagamento NOT NULL)
 *   - Folha:  rh_folha_itens JOIN rh_funcionarios ON bol_contrato_id OU contrato_id
 *   - Fallback: bol_contratos (p/ contratos que só existem em bol, ex: SESAU/UFNT/SEMARH)
 *
 * Uso:
 *   node scripts/margem_por_contrato.js [empresa] [--mes=YYYY-MM] [--ano=YYYY]
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const args = process.argv.slice(2);
const empArg = (args.find(a => !a.startsWith('--')) || 'assessoria').toLowerCase();
const mesArg = (args.find(a => a.startsWith('--mes=')) || '').split('=')[1];
const anoArg = (args.find(a => a.startsWith('--ano=')) || '--ano=2026').split('=')[1];

function brl(v) { return (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 }); }

// Tabela de cross-reference manual — mapeia contratos.numContrato → bol_contratos.id
const XREF = {
  // Assessoria — mapping contratos.numContrato → bol_contratos.numero_contrato
  'UFT 16/2025':              { bol_num: '16/2025' },
  'DETRAN 41/2023 + 2°TA':    { bol_num: '41/2023' },
  'UNITINS 003/2023 + 3°TA':  { bol_num: '022/2022' },
  'CBMTO 011/2023 + 5°TA':    { bol_num: '011/2023' },
  'SEDUC 016/2023':           { bol_num: '016/2023' },
  'PREVI PALMAS — em vigor':  { bol_num: '03/2024' },
  'SESAU 178/2022':           { bol_num: '178/2022' },
  'SEMARH 32/2024':           { bol_num: '32/2024' },
  'UFNT 30/2022':             { bol_num: '30/2022' },
  'UFT MOTORISTA 05/2025':    { bol_num: '05/2025' },
  'TCE 117/2024':             { bol_num: null },
  'SEDUC Limpeza/Copeiragem': { bol_num: '016/2023' }, // legado
};

function calcular(empresa) {
  const db = getDb(empresa);
  console.log('\n' + '═'.repeat(110));
  console.log(`  ${empresa.toUpperCase()} — Margem líquida por contrato ${mesArg ? '— ' + mesArg : '— ano ' + anoArg}`);
  console.log('═'.repeat(110));

  const filtroNF    = mesArg ? `AND strftime('%Y-%m', data_pagamento) = '${mesArg}'` : `AND strftime('%Y', data_pagamento) = '${anoArg}'`;
  const filtroFolha = mesArg ? `AND f.competencia = '${mesArg}'` : `AND f.competencia LIKE '${anoArg}-%'`;

  // Carregar contratos e bol_contratos
  let contratos = [];
  try { contratos = db.prepare('SELECT id, numContrato FROM contratos').all(); } catch (e) {}
  const bolRows = db.prepare('SELECT id, numero_contrato, nome FROM bol_contratos').all();
  const bolByNum = {};
  for (const b of bolRows) bolByNum[b.numero_contrato] = b;

  // Receita por numContrato
  const receitaByContr = {};
  try {
    const rows = db.prepare(`
      SELECT contrato_ref AS k, COUNT(*) q, ROUND(SUM(valor_liquido), 2) r
      FROM notas_fiscais
      WHERE data_pagamento IS NOT NULL ${filtroNF}
      GROUP BY contrato_ref
    `).all();
    for (const r of rows) receitaByContr[r.k || '(sem ref)'] = r;
  } catch (e) {}

  // Folha por bol_contrato_id
  const folhaByBol = {};
  const folhaByContr = {};
  try {
    const rows = db.prepare(`
      SELECT rfu.bol_contrato_id AS bol_id, rfu.contrato_id AS contr_id,
             COUNT(DISTINCT rf.funcionario_id) AS func,
             ROUND(SUM(COALESCE(rf.salario_base,0) + COALESCE(rf.valor_he,0) + COALESCE(rf.adicional_noturno,0)
                       + COALESCE(rf.vale_transporte,0) + COALESCE(rf.vale_alimentacao,0) + COALESCE(rf.outros_proventos,0)), 2) AS bruto,
             ROUND(SUM(COALESCE(rf.inss,0) + COALESCE(rf.irrf,0) + COALESCE(rf.outros_descontos,0)), 2) AS descontos
      FROM rh_folha_itens rf
      JOIN rh_folha f          ON f.id = rf.folha_id
      JOIN rh_funcionarios rfu ON rfu.id = rf.funcionario_id
      WHERE 1=1 ${filtroFolha}
      GROUP BY rfu.bol_contrato_id, rfu.contrato_id
    `).all();
    for (const r of rows) {
      if (r.bol_id)   folhaByBol[r.bol_id]     = { func: (folhaByBol[r.bol_id]?.func||0) + r.func, bruto: (folhaByBol[r.bol_id]?.bruto||0) + r.bruto, descontos: (folhaByBol[r.bol_id]?.descontos||0) + r.descontos };
      if (r.contr_id) folhaByContr[r.contr_id] = { func: (folhaByContr[r.contr_id]?.func||0) + r.func, bruto: (folhaByContr[r.contr_id]?.bruto||0) + r.bruto, descontos: (folhaByContr[r.contr_id]?.descontos||0) + r.descontos };
    }
  } catch (e) {}

  // Montar linhas: prioriza `contratos` (contratos existentes), depois bol_contratos sem match
  const linhas = [];
  const bolUsados = new Set();
  for (const c of contratos) {
    const xref = XREF[c.numContrato];
    const bol = xref?.bol_num ? bolByNum[xref.bol_num] : null;
    if (bol) bolUsados.add(bol.id);
    const rec = receitaByContr[c.numContrato];
    const folha = folhaByContr[c.id] || (bol && folhaByBol[bol.id]) || null;
    linhas.push({ nome: c.numContrato, func: folha?.func || 0, receita: rec?.r || 0, q_nf: rec?.q || 0, bruto: folha?.bruto || 0, liquido: (folha?.bruto || 0) - (folha?.descontos || 0) });
  }
  // bol_contratos que não foram usados (sem match em contratos)
  for (const b of bolRows) {
    if (bolUsados.has(b.id)) continue;
    const folha = folhaByBol[b.id];
    if (!folha) continue; // sem folha e sem receita, skip
    linhas.push({ nome: b.nome + ' (só bol)', func: folha.func, receita: 0, q_nf: 0, bruto: folha.bruto, liquido: folha.bruto - folha.descontos });
  }

  console.log('\n' + 'Contrato'.padEnd(42) + ' | Func | ' + 'Receita'.padStart(14) + ' | ' + 'Folha Bruta'.padStart(14) + ' | ' + 'Folha Líq'.padStart(14) + ' | ' + 'Margem R$'.padStart(14) + ' | Margem %');
  console.log('─'.repeat(130));

  let totFunc = 0, totReceita = 0, totBruto = 0, totLiq = 0;
  linhas.sort((a, b) => b.receita - a.receita);
  for (const l of linhas) {
    const margem = l.receita - l.liquido;
    const pct = l.receita > 0 ? (margem / l.receita) * 100 : 0;
    console.log(
      (l.nome || '').slice(0, 42).padEnd(42) + ' | ' +
      String(l.func).padStart(4) + ' | ' +
      brl(l.receita).padStart(14) + ' | ' +
      brl(l.bruto).padStart(14) + ' | ' +
      brl(l.liquido).padStart(14) + ' | ' +
      brl(margem).padStart(14) + ' | ' +
      (pct.toFixed(1) + '%').padStart(7)
    );
    totFunc += l.func; totReceita += l.receita; totBruto += l.bruto; totLiq += l.liquido;
  }
  console.log('─'.repeat(130));
  const totMargem = totReceita - totLiq;
  const totPct = totReceita > 0 ? (totMargem / totReceita) * 100 : 0;
  console.log(
    'TOTAL'.padEnd(42) + ' | ' +
    String(totFunc).padStart(4) + ' | ' +
    brl(totReceita).padStart(14) + ' | ' +
    brl(totBruto).padStart(14) + ' | ' +
    brl(totLiq).padStart(14) + ' | ' +
    brl(totMargem).padStart(14) + ' | ' +
    (totPct.toFixed(1) + '%').padStart(7)
  );

  // Contratos sem receita (órfãos)
  const orfas = Object.keys(receitaByContr).filter(k => !contratos.some(c => c.numContrato === k));
  if (orfas.length) {
    console.log('\n⚠️  NFs com contrato_ref sem match em `contratos`:');
    for (const k of orfas) {
      const r = receitaByContr[k];
      console.log(`    ${k.slice(0, 50).padEnd(50)} | ${r.q} NFs | R$ ${brl(r.r)}`);
    }
  }

  db.close();
}

calcular(empArg);
