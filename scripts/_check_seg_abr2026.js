#!/usr/bin/env node
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const db = getDb('seguranca');
const from = '2026-04-01';
const to   = '2026-04-30';

const fmt = v => (v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});

console.log('═'.repeat(80));
console.log(`  SEGURANÇA — abril/2026 (${from} → ${to})`);
console.log('═'.repeat(80));

// 1) Extratos
const ext = db.prepare(`
  SELECT COUNT(*) qtd,
         COALESCE(SUM(credito),0) cred,
         COALESCE(SUM(debito),0)  deb,
         COUNT(CASE WHEN credito>0 THEN 1 END) qtd_cred,
         COUNT(CASE WHEN debito>0 THEN 1 END)  qtd_deb,
         COUNT(CASE WHEN status_conciliacao='CONCILIADO' THEN 1 END) conciliados,
         COUNT(CASE WHEN status_conciliacao='PENDENTE' THEN 1 END) pendentes
  FROM extratos WHERE data_iso BETWEEN ? AND ?
`).get(from, to);
console.log('\n[1] EXTRATOS');
console.log(`  Total:         ${ext.qtd}  (${ext.qtd_cred} créditos, ${ext.qtd_deb} débitos)`);
console.log(`  Crédito bruto: R$ ${fmt(ext.cred)}`);
console.log(`  Débito bruto:  R$ ${fmt(ext.deb)}`);
console.log(`  Conciliados:   ${ext.conciliados} | Pendentes: ${ext.pendentes}`);

// 2) Exclusões (aplicações + intragrupo)
const excl = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN credito>0 AND (UPPER(historico) LIKE '%BB RENDE%' OR UPPER(historico) LIKE '%RENDE FACIL%' OR UPPER(historico) LIKE '%CDB%' OR UPPER(historico) LIKE '%APLICAC%' OR UPPER(historico) LIKE '%RESGATE%') THEN credito END),0) as cred_aplicacao,
    COALESCE(SUM(CASE WHEN debito>0  AND (UPPER(historico) LIKE '%BB RENDE%' OR UPPER(historico) LIKE '%RENDE FACIL%' OR UPPER(historico) LIKE '%CDB%' OR UPPER(historico) LIKE '%APLICAC%' OR UPPER(historico) LIKE '%INVEST%') THEN debito END),0) as deb_aplicacao,
    COALESCE(SUM(CASE WHEN credito>0 AND (UPPER(historico) LIKE '%MESMA TITULARIDADE%' OR UPPER(historico) LIKE '%MONTANA%' OR UPPER(historico) LIKE '%TED MESMA%') THEN credito END),0) as cred_intragrupo,
    COALESCE(SUM(CASE WHEN debito>0  AND (UPPER(historico) LIKE '%MESMA TITULARIDADE%' OR UPPER(historico) LIKE '%MONTANA%' OR UPPER(historico) LIKE '%TED MESMA%') THEN debito END),0) as deb_intragrupo
  FROM extratos WHERE data_iso BETWEEN ? AND ?
`).get(from, to);
console.log('\n[2] EXCLUSÕES (aplicações + intragrupo)');
console.log(`  Crédito aplicação:  R$ ${fmt(excl.cred_aplicacao)}`);
console.log(`  Débito  aplicação:  R$ ${fmt(excl.deb_aplicacao)}`);
console.log(`  Crédito intragrupo: R$ ${fmt(excl.cred_intragrupo)}`);
console.log(`  Débito  intragrupo: R$ ${fmt(excl.deb_intragrupo)}`);
console.log(`  Receita operacional (cred - excluídos): R$ ${fmt(ext.cred - excl.cred_aplicacao - excl.cred_intragrupo)}`);
console.log(`  Despesa operacional (deb  - excluídos): R$ ${fmt(ext.deb  - excl.deb_aplicacao  - excl.deb_intragrupo)}`);

// 3) Despesas classificadas (tabela `despesas`)
const desp = db.prepare(`
  SELECT COUNT(*) qtd,
         COALESCE(SUM(valor_bruto),0) bruto,
         COALESCE(SUM(valor_liquido),0) liquido
  FROM despesas WHERE data_iso BETWEEN ? AND ?
`).get(from, to);
console.log('\n[3] DESPESAS CLASSIFICADAS (tabela `despesas`)');
console.log(`  Qtd:     ${desp.qtd}`);
console.log(`  Bruto:   R$ ${fmt(desp.bruto)}`);
console.log(`  Líquido: R$ ${fmt(desp.liquido)}`);
if (desp.qtd === 0) console.log('  ⚠️  NENHUMA despesa classificada em abril/2026!');

// 4) NFs
const nfs = db.prepare(`
  SELECT COUNT(*) qtd,
         COALESCE(SUM(valor_bruto),0) bruto,
         COALESCE(SUM(valor_liquido),0) liquido,
         COUNT(CASE WHEN status_conciliacao='CONCILIADO' THEN 1 END) conc,
         COUNT(CASE WHEN status_conciliacao='PENDENTE'   THEN 1 END) pend,
         COUNT(CASE WHEN status_conciliacao='ASSESSORIA' THEN 1 END) assess
  FROM notas_fiscais
  WHERE (data_emissao BETWEEN ? AND ?)
     OR (COALESCE(data_emissao,'')='' AND created_at BETWEEN ? AND ?)
`).get(from, to, from, to);
console.log('\n[4] NFs');
console.log(`  Qtd:        ${nfs.qtd}`);
console.log(`  Bruto:      R$ ${fmt(nfs.bruto)}`);
console.log(`  Líquido:    R$ ${fmt(nfs.liquido)}`);
console.log(`  CONCILIADO: ${nfs.conc} | PENDENTE: ${nfs.pend} | ASSESSORIA: ${nfs.assess}`);

// 5) 44 créditos pendentes sem NF
const pendNoNf = db.prepare(`
  SELECT id, data_iso, credito, substr(historico,1,50) hist
  FROM extratos
  WHERE data_iso BETWEEN ? AND ?
    AND credito > 0
    AND status_conciliacao = 'PENDENTE'
    AND NOT (UPPER(historico) LIKE '%BB RENDE%' OR UPPER(historico) LIKE '%RENDE FACIL%'
          OR UPPER(historico) LIKE '%CDB%' OR UPPER(historico) LIKE '%APLICAC%'
          OR UPPER(historico) LIKE '%RESGATE%' OR UPPER(historico) LIKE '%SALDO%'
          OR UPPER(historico) LIKE '%MESMA TITULARIDADE%' OR UPPER(historico) LIKE '%MONTANA%')
  ORDER BY credito DESC LIMIT 15
`).all(from, to);
console.log('\n[5] CRÉDITOS PENDENTES (top 15 por valor)');
for (const r of pendNoNf) console.log(`  ${r.data_iso} | R$ ${fmt(r.credito).padStart(14)} | ${r.hist}`);
const totPend = db.prepare(`SELECT COUNT(*) cnt, COALESCE(SUM(credito),0) total FROM extratos WHERE data_iso BETWEEN ? AND ? AND credito>0 AND status_conciliacao='PENDENTE' AND NOT (UPPER(historico) LIKE '%BB RENDE%' OR UPPER(historico) LIKE '%RENDE FACIL%' OR UPPER(historico) LIKE '%CDB%' OR UPPER(historico) LIKE '%APLICAC%' OR UPPER(historico) LIKE '%RESGATE%' OR UPPER(historico) LIKE '%SALDO%' OR UPPER(historico) LIKE '%MESMA TITULARIDADE%' OR UPPER(historico) LIKE '%MONTANA%')`).get(from,to);
console.log(`\n  Total: ${totPend.cnt} créditos pendentes · R$ ${fmt(totPend.total)}`);

// 6) Contratos ativos
const contr = db.prepare(`
  SELECT COUNT(*) qtd,
         COALESCE(SUM(valor_mensal_bruto),0) mensal
  FROM contratos
  WHERE COALESCE(vigencia_fim,'')='' OR vigencia_fim >= DATE('now')
`).get();
console.log('\n[6] CONTRATOS ATIVOS');
console.log(`  Qtd: ${contr.qtd} · Mensal total: R$ ${fmt(contr.mensal)}`);

// 7) Impostos/DARF em despesas
const dCols = db.prepare(`PRAGMA table_info(despesas)`).all().map(c=>c.name);
if (dCols.includes('categoria')) {
  const imp = db.prepare(`
    SELECT COUNT(*) qtd, COALESCE(SUM(valor_bruto),0) bruto
    FROM despesas
    WHERE data_iso BETWEEN ? AND ?
      AND UPPER(categoria) LIKE '%IMPOSTO%'
  `).get(from, to);
  console.log('\n[7] IMPOSTOS/DARF (categoria)');
  console.log(`  Qtd: ${imp.qtd} · Bruto: R$ ${fmt(imp.bruto)}`);
  if (imp.qtd === 0) console.log('  ⚠️  NENHUM imposto classificado em abril/2026');
}

// 8) Amostra de débitos que DEVERIAM estar em despesas
console.log('\n[8] DÉBITOS NÃO CLASSIFICADOS (top 10 por valor, fora de aplicações/intragrupo)');
const debExt = db.prepare(`
  SELECT data_iso, debito, substr(historico,1,60) hist
  FROM extratos
  WHERE data_iso BETWEEN ? AND ? AND debito > 0
    AND NOT (UPPER(historico) LIKE '%BB RENDE%' OR UPPER(historico) LIKE '%RENDE FACIL%'
          OR UPPER(historico) LIKE '%CDB%' OR UPPER(historico) LIKE '%APLICAC%'
          OR UPPER(historico) LIKE '%INVEST%' OR UPPER(historico) LIKE '%SALDO%'
          OR UPPER(historico) LIKE '%MESMA TITULARIDADE%' OR UPPER(historico) LIKE '%MONTANA%'
          OR UPPER(historico) LIKE '%TED MESMA%')
  ORDER BY debito DESC LIMIT 10
`).all(from, to);
for (const r of debExt) console.log(`  ${r.data_iso} | R$ ${fmt(r.debito).padStart(14)} | ${r.hist}`);
