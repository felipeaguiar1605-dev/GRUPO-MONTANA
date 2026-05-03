'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

function analisa(empresa, mes) {
  const db = getDb(empresa);
  const ini = `${mes}-01`, fim = `${mes}-31`;
  const rows = db.prepare(`
    SELECT data_iso, historico, credito, contrato_vinculado, status
    FROM extratos
    WHERE data_iso BETWEEN ? AND ?
      AND credito > 0
      AND status NOT IN ('CONCILIADO','INTERNO','CONTA_VINCULADA','GARANTIA','JUDICIAL')
    ORDER BY credito DESC
  `).all(ini, fim);
  
  const total = rows.reduce((s,r) => s + Number(r.credito), 0);
  console.log(`\n=== ${empresa.toUpperCase()} — Creditos sem NF (${mes}) — ${rows.length} lancamentos | R$ ${total.toLocaleString('pt-BR',{minimumFractionDigits:2})} ===`);
  rows.forEach(r => {
    const hist = (r.historico||'').substring(0,70);
    const val  = Number(r.credito).toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(18);
    console.log(`  ${r.data_iso}  ${val}  ${hist}`);
  });
}

analisa('assessoria', '2026-03');
analisa('seguranca',  '2026-03');
