const Database = require('better-sqlite3');
const db = new Database('data/seguranca/montana.db', {readonly:true});

console.log('=== extratos recentes (mar/2026) ===');
db.prepare(`SELECT data, data_iso, credito, debito, historico, obs, bb_hash
            FROM extratos WHERE data_iso >= '2026-03-01' ORDER BY data_iso DESC LIMIT 15`).all()
  .forEach(r => console.log(JSON.stringify(r)));

console.log('\n=== contagem por mes ===');
db.prepare(`SELECT strftime('%Y-%m', data_iso) m, COUNT(*) n,
            ROUND(SUM(COALESCE(credito,0)),2) cred, ROUND(SUM(COALESCE(debito,0)),2) deb
            FROM extratos GROUP BY m ORDER BY m DESC LIMIT 12`).all()
  .forEach(r => console.log(r));

console.log('\n=== total extratos ===');
const tot = db.prepare(`SELECT COUNT(*) n, MIN(data_iso) min_d, MAX(data_iso) max_d FROM extratos`).get();
console.log(tot);

db.close();
