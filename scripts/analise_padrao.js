const Database = require('better-sqlite3');
const db = new Database('data/seguranca/montana.db', {readonly:true});

// 1. Todos os créditos > R$5k, não conciliados, agrupados por valor e data
console.log('=== CRÉDITOS PENDENTES GRANDES (>5k) ===');
const creditos = db.prepare(`
  SELECT data_iso, round(credito,2) c, historico
  FROM extratos
  WHERE credito > 5000 AND tipo='C'
    AND status_conciliacao NOT IN ('CONCILIADO','INTERNO')
  ORDER BY data_iso, credito DESC
`).all();
// Desduplicar por (data_iso, credito) - sabemos que há importações duplicadas
const seen = new Set();
const uniqCreditos = creditos.filter(r => {
  const k = r.data_iso + '_' + r.c;
  if (seen.has(k)) return false;
  seen.add(k); return true;
});
console.log(`Total únicos: ${uniqCreditos.length}`);
uniqCreditos.forEach(r => console.log(r.data_iso, String(r.c).padStart(14), r.historico?.substring(0,60)));

// 2. NFs pendentes por tomador e mês - para cruzar com os créditos
console.log('\n=== NFs PENDENTES POR TOMADOR×MÊS (top 30) ===');
db.prepare(`
  SELECT substr(tomador,1,30) t, substr(data_emissao,1,7) mes,
         count(*) n, round(sum(valor_liquido),2) soma
  FROM notas_fiscais
  WHERE status='PENDENTE'
  GROUP BY t, mes
  ORDER BY mes DESC, soma DESC
  LIMIT 40
`).all().forEach(r =>
  console.log(r.mes, r.n.toString().padStart(4), String(r.soma).padStart(14), r.t)
);

db.close();
