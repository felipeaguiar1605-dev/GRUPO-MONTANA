'use strict';
/**
 * Limpeza de extratos bancários:
 *  1. Deduplicar — remove cópias do mesmo lançamento importadas com encodings/separadores diferentes
 *  2. Auto-categorizar — marca créditos não-tributáveis (BB Rende Fácil, transferências internas, etc.)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

function normalizeHist(h) {
  return (h || '')
    .replace(/ \| /g, ' ')
    .replace(/ — /g, ' ')
    .replace(/ - /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 60);
}

function deduplicar(db, empresa) {
  // Verifica se existe coluna status_conciliacao (usada pela conciliação)
  const cols = db.prepare(`PRAGMA table_info(extratos)`).all().map(c => c.name);
  const temStConc = cols.includes('status_conciliacao');

  const todos = db.prepare(
    `SELECT id, data_iso, credito, debito, historico, status${temStConc ? ', status_conciliacao' : ''} FROM extratos ORDER BY id`
  ).all();

  const visto = new Map();
  const deletar = [];

  function isConciliado(r) {
    return r.status === 'CONCILIADO' || (temStConc && r.status_conciliacao === 'CONCILIADO');
  }

  for (const r of todos) {
    if (!r.id) continue; // segurança: pula linhas sem id
    const chave = `${r.data_iso}|${Number(r.credito||0).toFixed(2)}|${Number(r.debito||0).toFixed(2)}|${normalizeHist(r.historico)}`;
    if (!visto.has(chave)) {
      visto.set(chave, r);
    } else {
      const existente = visto.get(chave);
      // Prefere o CONCILIADO (em qualquer das colunas de status); caso contrário mantém o menor id
      if (isConciliado(r) && !isConciliado(existente)) {
        deletar.push(existente.id);
        visto.set(chave, r);
      } else {
        deletar.push(r.id);
      }
    }
  }

  const idsValidos = deletar.filter(id => id != null);

  if (idsValidos.length > 0) {
    db.pragma('foreign_keys = OFF');
    const chunk = 500;
    let total = 0;
    for (let i = 0; i < idsValidos.length; i += chunk) {
      const ids = idsValidos.slice(i, i + chunk).join(',');
      const res = db.prepare(`DELETE FROM extratos WHERE id IN (${ids})`).run();
      total += res.changes;
    }
    db.pragma('foreign_keys = ON');
    console.log(`  [${empresa}] Deduplicação: ${total} duplicatas removidas (${todos.length} → ${todos.length - total} únicos)`);
  } else {
    console.log(`  [${empresa}] Deduplicação: nenhuma duplicata encontrada`);
  }
}

function autocategorizar(db, empresa) {
  const regras = [
    {
      label: 'BB Rende Fácil → INTERNO',
      status: 'INTERNO',
      where: `(historico LIKE '%BB Rende%' OR historico LIKE '%Rende Facil%')
              AND (status IS NULL OR status NOT IN ('CONCILIADO','INTERNO'))`,
    },
    {
      label: 'Montana Serviços/Seg → INTERNO',
      status: 'INTERNO',
      where: `credito > 0
              AND (historico LIKE '%MONTANA S%LTDA%'
                OR historico LIKE '%MONTANA SEG%'
                OR historico LIKE '%MONTANA SERVICOS%'
                OR historico LIKE '%MONTANA SERV%'
                OR historico LIKE '% 19200109%')
              AND (status IS NULL OR status NOT IN ('CONCILIADO','INTERNO'))`,
    },
    {
      label: 'Resgate Depósito Garantia → GARANTIA',
      status: 'GARANTIA',
      where: `(historico LIKE '%Resgate%Dep%sit%Garantia%'
             OR historico LIKE '%Resgate Dep%Garantia%')
              AND (status IS NULL OR status NOT IN ('CONCILIADO','GARANTIA'))`,
    },
    {
      label: 'Transferência poupança pessoal → INTERNO',
      status: 'INTERNO',
      where: `historico LIKE '%Transferido da poupan%'
              AND (status IS NULL OR status NOT IN ('CONCILIADO','INTERNO'))`,
    },
    {
      label: 'Desbloqueio Judicial → JUDICIAL',
      status: 'JUDICIAL',
      where: `(historico LIKE '%Desbl Judicial%' OR historico LIKE '%Bacen Jud%')
              AND (status IS NULL OR status NOT IN ('CONCILIADO','JUDICIAL'))`,
    },
  ];

  let totalGeral = 0;
  for (const r of regras) {
    const res = db.prepare(`UPDATE extratos SET status=? WHERE ${r.where}`).run(r.status);
    if (res.changes > 0) {
      console.log(`  [${empresa}] ${r.label}: ${res.changes} lançamentos`);
      totalGeral += res.changes;
    }
  }
  if (totalGeral === 0) {
    console.log(`  [${empresa}] Auto-categorização: nenhuma alteração necessária`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
console.log('\n🧹 Limpeza de Extratos — Montana ERP\n');

const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k,v] = a.slice(2).split('='); return [k, v||true]; })
);
const empresas = args.empresa ? [args.empresa] : ['assessoria', 'seguranca'];

for (const emp of empresas) {
  const db = getDb(emp);
  deduplicar(db, emp);
  autocategorizar(db, emp);
  console.log('');
}

console.log('✔️  Concluído.\n');
