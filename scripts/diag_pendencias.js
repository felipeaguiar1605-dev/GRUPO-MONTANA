'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

for (const emp of ['assessoria','seguranca']) {
  const db = getDb(emp);

  // Créditos sem NF em março/2026 por categoria
  const ext = db.prepare(`
    SELECT 
      CASE 
        WHEN historico LIKE '%BB Rende%' OR historico LIKE '%Rende Facil%' OR historico LIKE '%Invest%' THEN 'BB Rende Fácil (aplicação)'
        WHEN historico LIKE '%MONTANA%' OR historico LIKE '%19200109%' THEN 'Transferência interna'
        WHEN historico LIKE '%Resgate%Garantia%' THEN 'Resgate Garantia'
        WHEN historico LIKE '%Desbl Judicial%' OR historico LIKE '%Bacen Jud%' THEN 'Judicial'
        WHEN historico LIKE '%GOVERNO DO EST%' OR historico LIKE '%01786029%' THEN 'Governo Estado (SEDUC/SEMARH)'
        WHEN historico LIKE '%UFT%' OR historico LIKE '%05149726%' OR historico LIKE '%FUNDACAO UN%' THEN 'UFT'
        WHEN historico LIKE '%PALMAS%' OR historico LIKE '%24851511%' OR historico LIKE '%Ordem Banc%' THEN 'Município de Palmas'
        WHEN historico LIKE '%S A L D O%' OR historico LIKE '%SALDO%' THEN 'Saldo (ignorar)'
        ELSE 'Outros / sem identificação'
      END categoria,
      COUNT(*) n,
      ROUND(SUM(credito),2) total
    FROM extratos
    WHERE data_iso BETWEEN '2026-03-01' AND '2026-03-31'
      AND credito > 0
      AND (status IS NULL OR status NOT IN ('CONCILIADO','INTERNO','GARANTIA','JUDICIAL'))
      AND (status_conciliacao IS NULL OR status_conciliacao != 'CONCILIADO')
    GROUP BY 1 ORDER BY total DESC
  `).all();

  // NFs pendentes com pagamentos mais antigos
  const nfAntigas = db.prepare(`
    SELECT 
      SUBSTR(data_emissao,1,7) ano_mes,
      COUNT(*) n,
      ROUND(SUM(valor_liquido),2) total
    FROM notas_fiscais
    WHERE status_conciliacao = 'PENDENTE'
      AND data_emissao < '2026-01-01'
    GROUP BY 1 ORDER BY 1 DESC
    LIMIT 10
  `).all();

  console.log('\n' + emp.toUpperCase() + ' — Créditos sem NF em março/2026:');
  let totExt = 0;
  ext.forEach(r => {
    totExt += r.total;
    const bar = r.total > 0 ? '█'.repeat(Math.min(20, Math.round(r.total/50000))) : '';
    console.log('  ' + r.categoria.padEnd(34) + String(r.n).padStart(3) + ' lçtos  R$ ' + r.total.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(15) + '  ' + bar);
  });
  console.log('  ' + 'TOTAL'.padEnd(34) + '     ' + '  R$ ' + totExt.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(15));

  if (nfAntigas.length > 0) {
    console.log('\n' + emp.toUpperCase() + ' — NFs PENDENTES emitidas ANTES de 2026 (pagamentos antigos chegando):');
    nfAntigas.forEach(r => console.log('  ' + r.ano_mes + '   ' + String(r.n).padStart(4) + ' NFs   R$ ' + r.total.toLocaleString('pt-BR',{minimumFractionDigits:2})));
  }
}
