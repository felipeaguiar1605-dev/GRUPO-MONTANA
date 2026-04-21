'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const empresa = (process.argv.find(a => a.startsWith('--empresa=')) || '').split('=')[1] || 'seguranca';
const db = getDb(empresa);

console.log('\n=== AUDIT EXTRATOS DUPLICADOS —', empresa.toUpperCase(), '===\n');

// Grupos de duplicatas — considera também o historico para evitar colapsar lançamentos legítimos
const grupos = db.prepare(`
  SELECT data_iso, credito, debito, historico, COUNT(*) c, GROUP_CONCAT(id) ids
  FROM extratos
  WHERE credito > 0 OR debito > 0
  GROUP BY data_iso, credito, debito, historico
  HAVING c > 1
`).all();

console.log('Grupos de duplicatas (por data+credito+debito+historico):', grupos.length);

let totalLinhas = 0, totalMaisAntiga = 0;
const porStatusKeep = {};
const porStatusDelete = {};

for (const g of grupos) {
  const ids = g.ids.split(',').map(Number).sort((a,b) => a - b);
  totalLinhas += ids.length;
  totalMaisAntiga += 1;
  // Verifica se algum tem status_conciliacao != 'PENDENTE' / NULL
  const rows = db.prepare(`SELECT id, status_conciliacao, contrato_vinculado FROM extratos WHERE id IN (${ids.join(',')})`).all();
  const conciliados = rows.filter(r => r.status_conciliacao && r.status_conciliacao !== 'PENDENTE' && r.status_conciliacao !== '');
  // Estratégia: manter o "mais útil" (conciliado se houver, senão o menor id)
  const keeper = conciliados[0]?.id || ids[0];
  for (const r of rows) {
    if (r.id === keeper) porStatusKeep[r.status_conciliacao || 'PENDENTE'] = (porStatusKeep[r.status_conciliacao||'PENDENTE']||0)+1;
    else porStatusDelete[r.status_conciliacao || 'PENDENTE'] = (porStatusDelete[r.status_conciliacao||'PENDENTE']||0)+1;
  }
}

const aDeletar = totalLinhas - totalMaisAntiga;
console.log('Total de linhas envolvidas:', totalLinhas);
console.log('Linhas que ficam (1 por grupo):', totalMaisAntiga);
console.log('Linhas a deletar:', aDeletar);

console.log('\nStatus das linhas que FICAM:');
Object.entries(porStatusKeep).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log('  '+v.toString().padStart(5)+'  '+k));

console.log('\nStatus das linhas a DELETAR:');
Object.entries(porStatusDelete).sort((a,b)=>b[1]-a[1]).forEach(([k,v]) => console.log('  '+v.toString().padStart(5)+'  '+k));

// Verifica se há referências externas (outras tabelas que apontam pra extrato.id)
// Tabelas conhecidas que podem ter extrato_id
const tabsRef = [
  ['notas_fiscais', 'extrato_id'],
  ['comprovante_vinculos', 'extrato_id'],
  ['pagamentos_portal', 'extrato_id'],
  ['despesas', 'extrato_id'],
];

console.log('\nReferências externas a extratos.id (tabelas que apontam pra extrato que será deletado):');
// Para cada tab, pega os ids que seriam deletados
const idsDeletar = [];
for (const g of grupos) {
  const ids = g.ids.split(',').map(Number);
  const rows = db.prepare(`SELECT id, status_conciliacao FROM extratos WHERE id IN (${ids.join(',')})`).all();
  const conciliados = rows.filter(r => r.status_conciliacao && r.status_conciliacao !== 'PENDENTE' && r.status_conciliacao !== '');
  const keeper = conciliados[0]?.id || ids.sort((a,b)=>a-b)[0];
  ids.forEach(i => { if (i !== keeper) idsDeletar.push(i); });
}

for (const [t, col] of tabsRef) {
  try {
    // Verifica se tabela e coluna existem
    const cols = db.prepare(`PRAGMA table_info(${t})`).all();
    if (!cols.some(c => c.name === col)) { console.log('  '+t+'.'+col+': (não existe)'); continue; }
    const placeholders = idsDeletar.slice(0, 999).map(() => '?').join(',');
    // Usa LIKE se muitos — SQL tem limite 999 params. Divide em chunks
    let total = 0;
    for (let i = 0; i < idsDeletar.length; i += 900) {
      const chunk = idsDeletar.slice(i, i + 900);
      const ph = chunk.map(() => '?').join(',');
      const c = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${col} IN (${ph})`).get(...chunk).c;
      total += c;
    }
    console.log('  '+t+'.'+col+': '+total+' referência(s) aponta(m) para ids que seriam deletados');
  } catch (e) {
    console.log('  '+t+'.'+col+': ERRO '+e.message);
  }
}

console.log('\n  Total ids a deletar:', idsDeletar.length);
