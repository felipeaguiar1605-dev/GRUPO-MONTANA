'use strict';
/**
 * Confrontação CONSOLIDADA de IRRF — análise anual agregada.
 *
 * Compara, por ANO e gestão (UFT/UFNT):
 *   • Total bruto faturado (NFs)
 *   • Total ISS retido (NFs)
 *   • Total pago pelo Tesouro Federal (Portal Transparência)
 *   • Retenção implícita = bruto − pago
 *   • Retenção federal = retenção implícita − ISS
 *   • Alíquota IRRF implícita = (ret_fed / bruto) − 4,65%
 *
 * Códigos DARF / IN RFB 1.234/2012 Anexo I:
 *   6147 → IR 1,20% (limpeza, conservação, vigilância, segurança, motoristas)
 *   6190 → IR 4,80% (serviços profissionais)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const PIS_COFINS_CSLL = 4.65;
function brl(n) { return Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function extrairAnoCompetencia(c) {
  if (!c) return null;
  // formato pt-BR (jan/26 ou jan/2026)
  let m = String(c).toLowerCase().match(/^[a-zç]{3}\/(\d{2,4})$/);
  if (m) return m[1].length === 2 ? 2000 + parseInt(m[1]) : parseInt(m[1]);
  // formato ISO (2026-03)
  m = String(c).match(/^(\d{4})-\d{2}/);
  return m ? parseInt(m[1]) : null;
}

function analisar(emp) {
  const db = getDb(emp);
  console.log('\n' + '═'.repeat(120));
  console.log(`  ${emp.toUpperCase()} — Confrontação anual UFT/UFNT (NF emitida vs pago Tesouro)`);
  console.log('═'.repeat(120));

  // 1. Sumarizar NFs federais por ano
  const allNFs = db.prepare(`
    SELECT competencia, valor_bruto, iss
    FROM notas_fiscais
    WHERE (tomador LIKE '%UFT%' OR tomador LIKE '%UFNT%' OR tomador LIKE '%FUND%UNIVERSIDADE%FEDERAL%')
      AND valor_bruto > 215.05
  `).all();
  const nfPorAno = {};
  for (const n of allNFs) {
    const ano = extrairAnoCompetencia(n.competencia);
    if (!ano) continue;
    if (!nfPorAno[ano]) nfPorAno[ano] = { qtd: 0, bruto: 0, iss: 0 };
    nfPorAno[ano].qtd++;
    nfPorAno[ano].bruto += n.valor_bruto;
    nfPorAno[ano].iss += (n.iss || 0);
  }

  // 2. Sumarizar pagamentos federais Tesouro por ano (UFT + UFNT)
  const pags = db.prepare(`
    SELECT
      COALESCE(NULLIF(data_pagamento_iso,''), NULLIF(data_liquidacao_iso,''), NULLIF(data_empenho_iso,'')) dt,
      valor_pago, gestao
    FROM pagamentos_portal
    WHERE (portal LIKE 'federal%' OR portal='federal') AND valor_pago > 0
  `).all();
  const pagPorAno = {};
  for (const p of pags) {
    if (!p.dt || p.dt.length < 4) continue;
    const ano = parseInt(p.dt.substr(0, 4));
    if (!ano || ano < 2020) continue;
    if (!pagPorAno[ano]) pagPorAno[ano] = { qtd: 0, total: 0 };
    pagPorAno[ano].qtd++;
    pagPorAno[ano].total += p.valor_pago;
  }

  console.log('\n  ANO  |  NFs | bruto faturado    | ISS NF        | pago Tesouro      | reten.implíc.    | reten.federal    | %IRRF impl.| classif.');
  console.log('  ' + '─'.repeat(135));

  let totalExcesso = 0, anosComExcesso = 0;

  const anos = [...new Set([...Object.keys(nfPorAno), ...Object.keys(pagPorAno)])].sort();
  for (const ano of anos) {
    const n = nfPorAno[ano] || { qtd: 0, bruto: 0, iss: 0 };
    const p = pagPorAno[ano] || { qtd: 0, total: 0 };
    if (n.bruto === 0 || p.total === 0) {
      console.log('  ' + ano + ' | ' + String(n.qtd).padStart(4) + ' | R$ ' + brl(n.bruto).padStart(13) + ' | R$ ' + brl(n.iss).padStart(10) + ' | R$ ' + brl(p.total).padStart(15) + ' | sem dados completos');
      continue;
    }
    const retImp = n.bruto - p.total;
    const retFed = retImp - n.iss;
    const aliqRetFed = (retFed * 100 / n.bruto);
    const aliqIRRF = aliqRetFed - PIS_COFINS_CSLL;
    let classif;
    if (aliqIRRF < -0.5) classif = '⚠️  pago > bruto (defasagem timing — pagto cobre meses anteriores)';
    else if (aliqIRRF < 0.5) classif = '⚠️  ~0% (sem retenção federal aparente)';
    else if (Math.abs(aliqIRRF - 1.20) < 0.40) classif = '✅ ~1,20% (código 6147 — VIGILÂNCIA/LIMPEZA)';
    else if (Math.abs(aliqIRRF - 4.80) < 0.50) classif = '⚠️  ~4,80% (código 6190 — PROFISSIONAL — INCORRETO!)';
    else classif = '?  ' + aliqIRRF.toFixed(2) + '% (verificar)';

    console.log('  ' + ano + ' | ' + String(n.qtd).padStart(4) + ' | R$ ' + brl(n.bruto).padStart(13) + ' | R$ ' + brl(n.iss).padStart(10) + ' | R$ ' + brl(p.total).padStart(15) + ' | R$ ' + brl(retImp).padStart(13) + ' | R$ ' + brl(retFed).padStart(13) + ' | ' + aliqIRRF.toFixed(3).padStart(7) + '%  | ' + classif);

    if (aliqIRRF > 3.0) {
      const exc = +(n.bruto * (4.80 - 1.20) / 100).toFixed(2);
      totalExcesso += exc;
      anosComExcesso++;
    }
  }

  if (totalExcesso > 0) {
    console.log('\n  💰 EXCESSO DE IRRF detectado em ' + anosComExcesso + ' ano(s).');
    console.log('     Crédito recuperável estimado (4,80% → 1,20%): R$ ' + brl(totalExcesso));
    console.log('     Período PER/DCOMP: até 5 anos (Lei 9.430/96 art. 74).');
  }
}

console.log('\n🔍 CONFRONTAÇÃO IRRF CONSOLIDADA — TESOURO vs NFs (anual)\n');
analisar('assessoria');
analisar('seguranca');
console.log('\n✔️  Concluído.\n');
