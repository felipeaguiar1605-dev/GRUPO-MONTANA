'use strict';
/**
 * CONFRONTAÇÃO DE RETENÇÕES NA FONTE
 *
 * Objetivo: Descobrir, a partir dos pagamentos efetivos do tomador (Tesouro
 * Nacional / Tesouro Estadual / Prefeitura), QUAL alíquota de IRRF foi
 * efetivamente usada nas notas fiscais — confrontando:
 *
 *   valor_bruto faturado (NF)  −  valor_pago efetivo (Portal Transparência)
 *   = retenção total (ISS + federal IRRF + federal PIS+COFINS+CSLL)
 *
 * Decompondo:
 *   retenção_total = ISS_municipal + IRRF + 4,65% (PIS+COFINS+CSLL juntos)
 *   retenção_federal = retenção_total − ISS = IRRF + 4,65%
 *   alíquota_IRRF_implícita = (retenção_federal / bruto) − 4,65%
 *
 * Códigos DARF da IN RFB 1.234/2012 Anexo I:
 *   6147 → IR 1,20% (limpeza, conservação, vigilância, segurança, motoristas, mão-de-obra)
 *   6190 → IR 4,80% (serviços profissionais — consultoria, advocacia, etc.)
 *
 * Uso:
 *   node scripts/confrontar_retencoes_pagamentos.js                   # ambas
 *   node scripts/confrontar_retencoes_pagamentos.js --empresa=seguranca
 *   node scripts/confrontar_retencoes_pagamentos.js --tomador=UFT
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const ARG = process.argv.slice(2);
const arg = (k, def = '') => (ARG.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || def;
const empresaArg = arg('empresa', 'todas');
const tomadorFiltro = arg('tomador', '').toUpperCase();

const PIS_COFINS_CSLL_FED = 4.65;  // % — agregado retido junto pela fonte pagadora federal
const IRRF_VIGILANCIA = 1.20;       // código 6147
const IRRF_PROFISSIONAL = 4.80;     // código 6190

const ord = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
const MES_PT = { jan:1, fev:2, mar:3, abr:4, mai:5, jun:6, jul:7, ago:8, set:9, out:10, nov:11, dez:12 };

function compToYM(c) {
  if (!c) return null;
  const m = String(c).toLowerCase().match(/^([a-zç]{3})\/(\d{2,4})$/);
  if (!m) return null;
  const ano = m[2].length === 2 ? 2000 + parseInt(m[2]) : parseInt(m[2]);
  return { ano, mes: MES_PT[m[1]] };
}

function brl(n) { return Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function classificarIRRF(aliqIRRF) {
  if (aliqIRRF == null || isNaN(aliqIRRF)) return '?';
  if (Math.abs(aliqIRRF - IRRF_VIGILANCIA) < 0.30) return '✅ 1,20% (6147)';
  if (Math.abs(aliqIRRF - IRRF_PROFISSIONAL) < 0.50) return '⚠️  4,80% (6190)';
  if (aliqIRRF < 0.20) return '⚠️  ~0% (não reteve IRRF)';
  return `?  ${aliqIRRF.toFixed(2)}%`;
}

function analisarEmpresa(emp) {
  console.log(`\n${'═'.repeat(110)}`);
  console.log(`  CONFRONTAÇÃO RETENÇÕES — ${emp.toUpperCase()}`);
  console.log('═'.repeat(110));

  const db = getDb(emp);

  // 1. Listar NFs federais (UFT/UFNT) por competência
  const sqlNFs = `
    SELECT competencia, tomador,
           COUNT(*) qtd_nf,
           SUM(valor_bruto) bruto,
           SUM(iss) iss_nf,
           SUM(retencao) ret_nf
    FROM notas_fiscais
    WHERE (tomador LIKE '%UFT%' OR tomador LIKE '%UFNT%' OR tomador LIKE '%FUND%UNIVERSIDADE%FEDERAL%')
      AND (competencia LIKE '%/24' OR competencia LIKE '%/2024'
        OR competencia LIKE '%/25' OR competencia LIKE '%/2025'
        OR competencia LIKE '%/26' OR competencia LIKE '%/2026')
      AND valor_bruto > 215.05
    GROUP BY competencia, tomador
  `;
  let nfs = db.prepare(sqlNFs).all();
  if (tomadorFiltro) nfs = nfs.filter(n => (n.tomador || '').toUpperCase().includes(tomadorFiltro));
  if (!nfs.length) { console.log('   (sem NFs federais para esta empresa)'); return; }

  // 2. Listar pagamentos federais (Portal Transparência) — agrupado por mês de pagamento
  // tabela pagamentos_portal pode ter data_pagamento_iso vazio → uso liquidacao ou empenho como fallback
  const pagFed = db.prepare(`
    SELECT
      COALESCE(NULLIF(data_pagamento_iso,''), NULLIF(data_liquidacao_iso,''), NULLIF(data_empenho_iso,'')) dt,
      gestao,
      SUM(valor_pago) total_pago,
      COUNT(*) qtd_pag
    FROM pagamentos_portal
    WHERE (portal LIKE 'federal%' OR portal='federal')
      AND valor_pago > 0
    GROUP BY substr(dt,1,7), gestao
  `).all();

  // index por (ym, gestao_normalizada)
  const idxPag = {};
  for (const p of pagFed) {
    if (!p.dt || p.dt.length < 7) continue;
    const ym = p.dt.substr(0, 7); // YYYY-MM
    const k = ym + '|' + (p.gestao || '').toUpperCase().substr(0, 30);
    idxPag[k] = (idxPag[k] || { total: 0, qtd: 0 });
    idxPag[k].total += p.total_pago;
    idxPag[k].qtd += p.qtd_pag;
  }

  console.log(`\n  📋 NFs FEDERAIS (UFT/UFNT) confrontadas com pagamentos do Tesouro Federal:`);
  console.log(`     Período: 2024-2026  |  Modelo: NF mês M → pagamento mês M ou M+1`);
  console.log('');
  console.log('     comp.   | tomador             | NFs | bruto         | ISS NF       | pago Tesouro      | ret_total    | ret_fed     | %IRRF impl. | classif.');
  console.log('     ' + '─'.repeat(170));

  let totalAlertasExcesso = 0;
  let totalCreditoExcesso = 0;
  const linhasOrdenadas = nfs.sort((a, b) => {
    const ay = compToYM(a.competencia), by = compToYM(b.competencia);
    if (!ay || !by) return 0;
    return (ay.ano - by.ano) || (ay.mes - by.mes) || (a.tomador || '').localeCompare(b.tomador || '');
  });

  for (const nf of linhasOrdenadas) {
    const ym = compToYM(nf.competencia);
    if (!ym) continue;
    // Pagamento esperado no mês seguinte (M+1) ou mesmo mês (M)
    const tentativas = [
      `${ym.ano}-${String(ym.mes).padStart(2, '0')}`,
      `${ym.mes === 12 ? ym.ano + 1 : ym.ano}-${String(ym.mes === 12 ? 1 : ym.mes + 1).padStart(2, '0')}`,
      `${ym.mes >= 11 ? ym.ano + 1 : ym.ano}-${String(ym.mes >= 11 ? (ym.mes + 2 - 12) : ym.mes + 2).padStart(2, '0')}`,
    ];
    const tomadorKey = (nf.tomador || '').toUpperCase().substr(0, 30);
    let pago = 0;
    for (const ymTent of tentativas) {
      const k = ymTent + '|' + tomadorKey;
      if (idxPag[k]) { pago += idxPag[k].total; }
    }

    const retTotal = nf.bruto - pago;             // retenção implícita = diferença
    const retFed = retTotal - (nf.iss_nf || 0);   // tira ISS municipal
    const aliqRetFed = pago > 0 ? (retFed * 100 / nf.bruto) : null;
    const aliqIRRF = aliqRetFed != null ? (aliqRetFed - PIS_COFINS_CSLL_FED) : null;
    const classif = pago > 0 ? classificarIRRF(aliqIRRF) : 'sem pagto';

    // Calcular excesso de retenção se IRRF foi 4,80% (devia ser 1,20%)
    let creditoExcesso = 0;
    if (aliqIRRF != null && aliqIRRF > 3.0) {
      creditoExcesso = +(nf.bruto * (IRRF_PROFISSIONAL - IRRF_VIGILANCIA) / 100).toFixed(2);
      totalAlertasExcesso++;
      totalCreditoExcesso += creditoExcesso;
    }

    console.log(
      '     ' + (nf.competencia || '').padEnd(7) +
      ' | ' + (nf.tomador || '').substr(0, 19).padEnd(19) +
      ' | ' + String(nf.qtd_nf).padStart(3) +
      ' | R$ ' + brl(nf.bruto).padStart(12) +
      ' | R$ ' + brl(nf.iss_nf || 0).padStart(10) +
      ' | R$ ' + brl(pago).padStart(15) +
      ' | R$ ' + brl(retTotal).padStart(10) +
      ' | R$ ' + brl(retFed).padStart(10) +
      ' | ' + (aliqIRRF != null ? aliqIRRF.toFixed(3).padStart(7) + '%' : '   —    ') +
      ' | ' + classif
    );
  }

  console.log('     ' + '─'.repeat(170));
  if (totalAlertasExcesso > 0) {
    console.log(`\n  💰 EXCESSO DE RETENÇÃO IRRF identificado em ${totalAlertasExcesso} competências.`);
    console.log(`     Crédito recuperável estimado: R$ ${brl(totalCreditoExcesso)}`);
    console.log(`     (assumindo correção 4,80% → 1,20%, conforme IN RFB 1.234/2012 código 6147)`);
  }
}

console.log('\n🔍 CONFRONTAÇÃO RETENÇÕES NA FONTE — TESOURO vs NFs');
console.log('   (calcula alíquota IRRF implícita a partir de pagamentos efetivos)');

const empresas = empresaArg === 'todas' ? ['assessoria', 'seguranca'] : [empresaArg];
for (const emp of empresas) analisarEmpresa(emp);
console.log('\n✔️  Concluído.\n');
