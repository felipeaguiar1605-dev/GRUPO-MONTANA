'use strict';
/**
 * Vincula NFs da Prefeitura de Palmas (Segurança) aos contratos corretos:
 *   - Serviços ref. até Dezembro/2025 → "Prefeitura Palmas 007/2023"
 *   - Serviços ref. Janeiro/2026 em diante → "Prefeitura Palmas 077/2025 (SRP)"
 *
 * Fontes de mês/ano (em ordem): (1) discriminacao "Serv. ref. MÊS/ANO",
 *                               (2) competencia, (3) data_emissao (proxy).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APLICAR = process.argv.includes('--apply');
const MESES = {
  'janeiro':1,'fevereiro':2,'março':3,'marco':3,'abril':4,'maio':5,'junho':6,
  'julho':7,'agosto':8,'setembro':9,'outubro':10,'novembro':11,'dezembro':12,
};

const CONTRATO_ATE_DEZ2025 = 'Prefeitura Palmas 007/2023';
const CONTRATO_DESDE_JAN2026 = 'Prefeitura Palmas 077/2025 (SRP)';

function extrairReferencia(disc, comp, dataEmi) {
  // Tentativa 1: discriminação "Serv. ref. Outubro/2025"
  if (disc) {
    const m = disc.match(/Serv\.\s*ref\.\s*(\w+)\/(\d{4})/i);
    if (m) {
      const mes = MESES[m[1].toLowerCase()];
      if (mes) return { ano: parseInt(m[2]), mes };
    }
  }
  // Tentativa 2: competência (YYYY-MM ou MM/YYYY)
  if (comp) {
    let m = comp.match(/^(\d{4})-(\d{1,2})/);
    if (m) return { ano: +m[1], mes: +m[2] };
    m = comp.match(/^(\d{1,2})\/(\d{4})/);
    if (m) return { ano: +m[2], mes: +m[1] };
  }
  // Tentativa 3: data_emissão (NFs geralmente emitidas 1-3 meses após serviço)
  if (dataEmi) {
    const m = dataEmi.match(/^(\d{4})-(\d{2})/);
    if (m) {
      // NF emitida em mês M → serviço geralmente foi M-1 (subtrai 1 mês)
      let ano = +m[1], mes = +m[2] - 1;
      if (mes === 0) { mes = 12; ano--; }
      return { ano, mes };
    }
  }
  return null;
}

function decidirContrato(ref) {
  if (!ref) return null;
  // Até dez/2025 (inclusive) → 007/2023; a partir de jan/2026 → 077/2025
  if (ref.ano < 2026 || (ref.ano === 2025 && ref.mes <= 12)) return CONTRATO_ATE_DEZ2025;
  return CONTRATO_DESDE_JAN2026;
}

const db = getDb('seguranca');
const nfs = db.prepare(`
  SELECT id, numero, competencia, data_emissao, discriminacao
  FROM notas_fiscais
  WHERE tomador LIKE '%PALMAS%'
    AND status_conciliacao != 'ASSESSORIA'
    AND (contrato_ref IS NULL OR TRIM(contrato_ref) = '')
`).all();

console.log(`\n🔗 Vincular NFs Palmas Segurança → contrato (modo: ${APLICAR ? 'APLICAR' : 'DRY-RUN'})`);
console.log(`  NFs sem contrato_ref: ${nfs.length}\n`);

const stats = { total: 0, ate2025: 0, desde2026: 0, sem_ref: 0 };
const updates = [];

for (const nf of nfs) {
  const ref = extrairReferencia(nf.discriminacao, nf.competencia, nf.data_emissao);
  const cont = decidirContrato(ref);
  if (!cont) { stats.sem_ref++; continue; }
  stats.total++;
  if (cont === CONTRATO_ATE_DEZ2025) stats.ate2025++; else stats.desde2026++;
  updates.push({ id: nf.id, contrato: cont });
}

console.log(`  → ${CONTRATO_ATE_DEZ2025}:    ${stats.ate2025}`);
console.log(`  → ${CONTRATO_DESDE_JAN2026}:  ${stats.desde2026}`);
console.log(`  → Sem referência (não alterado):           ${stats.sem_ref}\n`);

if (APLICAR && updates.length > 0) {
  const stmt = db.prepare('UPDATE notas_fiscais SET contrato_ref = ? WHERE id = ?');
  const trx = db.transaction(list => { for (const u of list) stmt.run(u.contrato, u.id); });
  trx(updates);
  console.log(`  ✓ ${updates.length} NFs atualizadas.\n`);

  // Recalcular total_pago por contrato (CONCILIADO)
  for (const c of [CONTRATO_ATE_DEZ2025, CONTRATO_DESDE_JAN2026]) {
    const t = db.prepare(`
      SELECT COALESCE(SUM(valor_liquido), 0) t FROM notas_fiscais
      WHERE contrato_ref = ? AND status_conciliacao = 'CONCILIADO'
    `).get(c).t;
    db.prepare('UPDATE contratos SET total_pago = ? WHERE numContrato = ?').run(t, c);
    console.log(`  ✓ ${c}: total_pago recalculado = R$ ${t.toLocaleString('pt-BR', {minimumFractionDigits:2})}`);
  }
}

console.log('\n✔️  Concluído.');
