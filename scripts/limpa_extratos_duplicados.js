'use strict';
/**
 * Remove extratos verdadeiramente duplicados.
 *
 * Duplicata = mesma (data_iso, credito, debito, historico) aparecendo >1x.
 * Dois lançamentos reais com mesmo valor/data mas horários/contrapartes
 * diferentes APARECEM no histórico — NÃO são duplicatas.
 *
 * Mantém o de menor id (mais antigo importado).
 * Segurança: checa que não há FK externa antes de deletar.
 *
 * Uso:
 *   node scripts/limpa_extratos_duplicados.js                    # dry-run
 *   node scripts/limpa_extratos_duplicados.js --apply            # todas empresas
 *   node scripts/limpa_extratos_duplicados.js --empresa=seguranca --apply
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const empArg = (process.argv.find(a => a.startsWith('--empresa=')) || '').split('=')[1];
const EMPRESAS = empArg ? [empArg] : ['assessoria', 'seguranca'];

const TABS_REF = [
  ['notas_fiscais', 'extrato_id'],
  ['comprovante_vinculos', 'extrato_id'],
  ['pagamentos_portal', 'extrato_id'],
  ['despesas', 'extrato_id'],
];

console.log('\n🧹 Limpa extratos duplicados —', APPLY ? '🔥 APPLY' : '💡 DRY-RUN', '\n');

let totalGlobal = 0;

for (const empresa of EMPRESAS) {
  const db = getDb(empresa);

  // Prefer manter quem tem status_conciliacao diferente de PENDENTE
  const grupos = db.prepare(`
    SELECT data_iso, credito, debito, historico, GROUP_CONCAT(id) ids
    FROM extratos
    WHERE (credito > 0 OR debito > 0)
      AND historico IS NOT NULL AND historico <> ''
    GROUP BY data_iso, credito, debito, historico
    HAVING COUNT(*) > 1
  `).all();

  const idsDeletar = [];
  for (const g of grupos) {
    const ids = g.ids.split(',').map(Number);
    const rows = db.prepare(`SELECT id, status_conciliacao FROM extratos WHERE id IN (${ids.join(',')})`).all();
    const conciliados = rows.filter(r => r.status_conciliacao && !['PENDENTE','',null].includes(r.status_conciliacao));
    const keeper = (conciliados[0]?.id) || Math.min(...ids);
    ids.forEach(i => { if (i !== keeper) idsDeletar.push(i); });
  }

  console.log(`═══ ${empresa.toUpperCase()} ═══`);
  console.log(`  Grupos de duplicatas: ${grupos.length}`);
  console.log(`  Ids a deletar: ${idsDeletar.length}`);

  if (idsDeletar.length === 0) { console.log('  (nada a fazer)\n'); continue; }

  // Checa FKs externas
  let bloqueios = 0;
  for (const [t, col] of TABS_REF) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all();
      if (!cols.some(c => c.name === col)) continue;
      for (let i = 0; i < idsDeletar.length; i += 900) {
        const chunk = idsDeletar.slice(i, i + 900);
        const ph = chunk.map(() => '?').join(',');
        const c = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${col} IN (${ph})`).get(...chunk).c;
        bloqueios += c;
      }
    } catch (_) {}
  }
  if (bloqueios > 0) {
    console.log(`  ⚠️  ABORTADO: ${bloqueios} referência(s) externa(s) a ids que seriam deletados`);
    continue;
  }
  console.log(`  ✓ Nenhuma FK externa aponta pros ids a deletar.`);

  if (APPLY) {
    const del = db.prepare(`DELETE FROM extratos WHERE id = ?`);
    const trx = db.transaction((ids) => { for (const id of ids) del.run(id); });
    trx(idsDeletar);
    console.log(`  ✅ ${idsDeletar.length} extrato(s) removido(s).`);
  } else {
    console.log(`  (dry-run — use --apply para efetivar)`);
  }
  console.log();
  totalGlobal += idsDeletar.length;
}

console.log(`══ Total: ${totalGlobal} linha(s) ${APPLY ? 'removida(s)' : 'seria(m) removida(s)'} ══\n`);
