const D = require('better-sqlite3');
const db = new D('data/assessoria/montana.db');
const r = db.prepare("SELECT numContrato, orgao, valor_mensal_bruto FROM contratos WHERE orgao LIKE '%CIDADES%' OR orgao LIKE '%SEPLAD%' OR orgao LIKE '%PLANEJAMENTO%' OR numContrato LIKE '%SECCIDADES%' OR numContrato LIKE '%SEPLAD%'").all();
console.log(JSON.stringify(r, null, 2));
db.close();
