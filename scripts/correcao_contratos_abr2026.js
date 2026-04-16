/**
 * Correção de contratos — Abril/2026
 *
 * 1. ASSESSORIA id=17 CBMTO (limpeza)   → ENCERRADO + remove parcela mar/26 FUTURO
 * 2. ASSESSORIA id=25 SEMUS             → ENCERRADO (contrato real é da Segurança id=29)
 * 3. ASSESSORIA TJ 73/2020              → ENCERRADO (vigência_fim = última NF)
 * 4. ASSESSORIA TJ 440/2024             → ENCERRADO (vigência_fim = última NF)
 *
 * Uso:
 *   node scripts/correcao_contratos_abr2026.js              # executa
 *   node scripts/correcao_contratos_abr2026.js --dry-run    # apenas mostra
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const DRY_RUN = process.argv.includes('--dry-run');

console.log('\n══════════════════════════════════════════════════');
console.log('  Correção de Contratos — Abril/2026');
console.log('══════════════════════════════════════════════════');
if (DRY_RUN) console.log('  ⚠️  DRY RUN — nenhuma alteração será feita\n');

const db = getDb('assessoria');

// ── Helper ───────────────────────────────────────────────────────────────────
function encerrarContrato(contId, motivo) {
  const c = db.prepare('SELECT id, contrato, numContrato, orgao, status FROM contratos WHERE id = ?').get(contId);
  if (!c) {
    console.log(`  ❌ Contrato id=${contId} não encontrado`);
    return;
  }
  const nome = c.contrato || c.numContrato;
  console.log(`\n  📄 [id=${c.id}] ${nome}`);
  console.log(`     Órgão: ${c.orgao || '-'}`);
  console.log(`     Status atual: ${c.status}`);
  console.log(`     Motivo: ${motivo}`);

  // Buscar última NF como vigência_fim
  let ultimaNF = null;
  // Tenta por contrato_ref
  const porRef = db.prepare('SELECT MAX(data_emissao) dt FROM notas_fiscais WHERE contrato_ref = ?').get(nome);
  if (porRef?.dt) ultimaNF = porRef.dt;

  // Tenta por tomador se não achou
  if (!ultimaNF) {
    const patterns = {
      17: '%BOMBEIRO%',      // CBMTO
      25: '%SEMUS%',         // SEMUS
    };
    if (patterns[contId]) {
      const porTom = db.prepare('SELECT MAX(data_emissao) dt FROM notas_fiscais WHERE tomador LIKE ?').get(patterns[contId]);
      if (porTom?.dt) ultimaNF = porTom.dt;
    }
  }

  const dataFim = ultimaNF || new Date().toISOString().slice(0, 10);
  console.log(`     Última NF: ${ultimaNF || 'não encontrada'}`);
  console.log(`     vigência_fim: ${dataFim}`);

  if (!DRY_RUN) {
    db.prepare('UPDATE contratos SET status = ?, vigencia_fim = ? WHERE id = ?')
      .run('ENCERRADO', dataFim, contId);
    console.log('     ✅ Encerrado!');
  } else {
    console.log('     ⚠️  Seria encerrado');
  }
}

// ── 1. CBMTO Limpeza (id=17) ────────────────────────────────────────────────
console.log('\n─── 1. CBMTO Limpeza (Assessoria id=17) ───');
encerrarContrato(17, 'Contrato de limpeza encerrado — apenas Segurança permanece no CBMTO');

// Remover parcela mar/26 FUTURO
const parcelasFuturo = db.prepare(
  "SELECT id, competencia, status FROM parcelas WHERE contrato_id = 17 AND status = 'FUTURO'"
).all();
if (parcelasFuturo.length > 0) {
  console.log(`\n     Parcelas FUTURO encontradas: ${parcelasFuturo.length}`);
  for (const p of parcelasFuturo) {
    console.log(`       - id=${p.id} ${p.competencia} (${p.status})`);
    if (!DRY_RUN) {
      db.prepare('DELETE FROM parcelas WHERE id = ?').run(p.id);
      console.log('         ✅ Removida');
    } else {
      console.log('         ⚠️  Seria removida');
    }
  }
} else {
  console.log('     Nenhuma parcela FUTURO para remover');
}

// ── 2. SEMUS Assessoria (id=25) ──────────────────────────────────────────────
console.log('\n─── 2. SEMUS (Assessoria id=25) ───');
encerrarContrato(25, 'Contrato pertence à Segurança (id=29) — encerrado na Assessoria');

// ── 3 & 4. Contratos TJ ─────────────────────────────────────────────────────
console.log('\n─── 3. Contratos TJ (Assessoria) ───');
const tjContratos = db.prepare(
  "SELECT id, contrato, numContrato, status FROM contratos WHERE contrato LIKE '%TJ%' OR contrato LIKE '%Tribunal de Justi%'"
).all();

if (tjContratos.length === 0) {
  console.log('  Nenhum contrato TJ encontrado por nome. Tentando por órgão...');
  const tjPorOrgao = db.prepare(
    "SELECT id, contrato, numContrato, orgao, status FROM contratos WHERE orgao LIKE '%FUNDO ESPECIAL%' OR orgao LIKE '%MODERNIZACAO%' OR orgao LIKE '%25.053.190%'"
  ).all();
  for (const c of tjPorOrgao) {
    encerrarContrato(c.id, 'Contrato TJ encerrado');
  }
} else {
  for (const c of tjContratos) {
    encerrarContrato(c.id, 'Contrato TJ encerrado');
  }
}

// ── Resumo final ─────────────────────────────────────────────────────────────
const statusFinal = db.prepare(
  "SELECT status, COUNT(*) n FROM contratos GROUP BY status ORDER BY n DESC"
).all();

console.log('\n══════════════════════════════════════════════════');
console.log('  RESUMO — Status dos contratos Assessoria');
console.log('══════════════════════════════════════════════════');
for (const s of statusFinal) {
  console.log(`  ${s.status}: ${s.n}`);
}
console.log(DRY_RUN ? '\n  ⚠️  DRY RUN — nada foi alterado' : '\n  ✅ Correções aplicadas');
console.log('');
