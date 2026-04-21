/**
 * Auto-conciliação de TARIFAS BANCÁRIAS
 *
 * Tarifas/IOF/custos bancários são OBVIAMENTE custo bancário mas ficam em
 * status=PENDENTE porque não têm NF correspondente. Este script categoriza
 * automaticamente e marca como CONCILIADO_AUTO — limpa o ruído do extrato
 * sem precisar de NF.
 *
 * Padrões detectados:
 *   - "Tar Pag Salár Créd Conta"      → Tarifa Pag. Salários
 *   - "Tarifa Pagamentos"             → Tarifa Pag. Pagamentos
 *   - "Tarifa Pacote Serviços"        → Tarifa Pacote
 *   - "Cobrança de I.O.F."            → IOF
 *   - "TAR DOC / TED ELET"            → Tarifa DOC/TED
 *   - "Manutenção de Conta"           → Manutenção Conta
 *   - "Anuidade"                      → Anuidade
 *
 * Uso:
 *   node scripts/conciliar_tarifas_bancarias.js               # DRY-RUN ambas as empresas
 *   node scripts/conciliar_tarifas_bancarias.js --apply       # aplica em ambas
 *   node scripts/conciliar_tarifas_bancarias.js --empresa=assessoria --apply
 *
 * Estratégia:
 *   DRY-RUN por default. Idempotente (já tratados não são re-processados
 *   pois filtra status_conciliacao IN ('PENDENTE', '')).
 */
const Database = require('better-sqlite3');

const APPLY   = process.argv.includes('--apply');
const EMPARG  = (process.argv.find(a => a.startsWith('--empresa=')) || '').split('=')[1] || 'todas';
const EMPRESAS = EMPARG === 'todas' ? ['assessoria', 'seguranca'] : [EMPARG];

// Classificador: retorna nome da categoria ou null se não for tarifa
function classificar(historico) {
  if (!historico) return null;
  // Normaliza: upper + remove acentos quebrados (Latin1 encoding bug)
  const h = String(historico).toUpperCase();

  if (/\bI\.?O\.?F\.?\b/.test(h))                              return 'IOF';
  if (/TAR\s*PAG\s*SAL[AÁÂ�R]*\s*CR[EÉ�D]*/.test(h))           return 'Tarifa Pag. Salários';
  if (/TARIFA\s*PAGAMENTO/.test(h))                             return 'Tarifa Pagamentos';
  if (/TAR\s*PAGAMENTO/.test(h))                                return 'Tarifa Pagamentos';
  if (/TARIFA\s*PACOTE|PACOTE\s*(DE\s*)?SERVI/.test(h))         return 'Tarifa Pacote Serviços';
  if (/CESTA\s*(DE\s*)?SERVI/.test(h))                          return 'Tarifa Pacote Serviços';
  if (/MANUT.*(CONTA|CC|CT)/.test(h))                           return 'Manutenção de Conta';
  if (/TAR.*DOC\s*ELET|TARIFA.*DOC/.test(h))                    return 'Tarifa DOC';
  if (/TAR.*TED\s*ELET|TARIFA.*TED/.test(h))                    return 'Tarifa TED';
  if (/ANUIDADE/.test(h))                                       return 'Anuidade';
  if (/TAR.*EXTRATO|TARIFA.*EXTRATO/.test(h))                   return 'Tarifa Extrato';
  if (/TAR.*SMS|SMS.*ALERT/.test(h))                            return 'Tarifa SMS';
  if (/TAR\s*BANC|TARIFA\s*BANC/.test(h))                       return 'Tarifa Bancária';
  return null;
}

console.log(`\n🏦 Auto-conciliação de TARIFAS BANCÁRIAS — ${APPLY ? '🔥 APPLY' : '💡 DRY-RUN'}\n`);

let totalGeralN = 0, totalGeralR = 0;

for (const empresa of EMPRESAS) {
  const dbPath = `data/${empresa}/montana.db`;
  const db = new Database(dbPath);

  const rows = db.prepare(`
    SELECT id, data_iso, historico, debito
    FROM extratos
    WHERE (status_conciliacao IN ('PENDENTE', '') OR status_conciliacao IS NULL)
      AND debito > 0
      AND historico IS NOT NULL
      AND historico <> ''
  `).all();

  const byCategoria = {};
  const paraAtualizar = [];

  for (const r of rows) {
    const cat = classificar(r.historico);
    if (!cat) continue;
    if (!byCategoria[cat]) byCategoria[cat] = { n: 0, total: 0, exemplos: [] };
    byCategoria[cat].n++;
    byCategoria[cat].total += Number(r.debito || 0);
    if (byCategoria[cat].exemplos.length < 2) byCategoria[cat].exemplos.push(r.historico);
    paraAtualizar.push({ id: r.id, cat });
  }

  console.log(`\n═══ ${empresa.toUpperCase()} ═══`);
  if (paraAtualizar.length === 0) {
    console.log('  (nenhuma tarifa pendente encontrada)');
    db.close();
    continue;
  }

  const cats = Object.entries(byCategoria).sort((a, b) => b[1].total - a[1].total);
  for (const [cat, info] of cats) {
    console.log(`  ${info.n.toString().padStart(4)}x  R$ ${info.total.toFixed(2).padStart(10)}  ${cat}`);
    console.log(`         ex: "${info.exemplos[0].slice(0, 70)}${info.exemplos[0].length > 70 ? '…' : ''}"`);
  }
  const totalN = paraAtualizar.length;
  const totalR = cats.reduce((s, [, v]) => s + v.total, 0);
  console.log(`  ─── ${totalN} lançamentos, R$ ${totalR.toFixed(2)} total ───`);

  totalGeralN += totalN;
  totalGeralR += totalR;

  if (APPLY) {
    console.log(`  ✏️ Aplicando...`);
    const upd = db.prepare(`
      UPDATE extratos
      SET status_conciliacao = 'CONCILIADO_AUTO',
          contrato_vinculado = ?,
          obs = COALESCE(NULLIF(obs, ''), '') || CASE WHEN obs IS NULL OR obs='' THEN '' ELSE ' | ' END || 'Custo bancário auto-conciliado (' || ? || ')',
          updated_at = datetime('now')
      WHERE id = ?
    `);
    const tx = db.transaction((items) => {
      for (const it of items) {
        upd.run(`Tarifas Bancárias / ${it.cat}`, it.cat, it.id);
      }
    });
    tx(paraAtualizar);
    console.log(`  ✅ ${totalN} extratos marcados CONCILIADO_AUTO`);
  }

  db.close();
}

console.log(`\n════════════════════════════════════════`);
console.log(`Total ${EMPARG === 'todas' ? 'geral' : EMPARG}: ${totalGeralN} lançamentos, R$ ${totalGeralR.toFixed(2)}`);
if (!APPLY) {
  console.log(`\n💡 DRY-RUN — use --apply para efetivar as mudanças`);
  console.log(`   Ex: node scripts/conciliar_tarifas_bancarias.js --apply`);
}
