'use strict';
/**
 * Limpa contrato_vinculado em extratos onde foi populado indevidamente:
 *   1. "IA-CONCILIADO" — marcador técnico da auto-conciliação IA que vazou pro campo contrato
 *   2. "Prefeitura Palmas 077/2025 (SRP)" na Assessoria em débitos de imposto (Segurança só)
 *   3. Quaisquer labels explicitamente informados via LIXO_TECNICO
 *
 * Preserva status_conciliacao (não reverte auto-conciliação, só limpa campo errado).
 *
 * Uso:
 *   node scripts/limpar_contrato_vinculado_indevido.js [empresa]          (dry-run)
 *   node scripts/limpar_contrato_vinculado_indevido.js [empresa] --apply  (grava)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const argsPos = process.argv.slice(2).filter(a => !a.startsWith('--'));
const empArg = (argsPos[0] || 'todas').toLowerCase();

// Valores que NUNCA devem estar no campo contrato_vinculado
const LIXO_UNIVERSAL = new Set(['IA-CONCILIADO', 'N/A', 'UFT', 'EMPRESTIMO BRB 0396547753']);

// Lixo específico da Assessoria (contratos de Segurança não fazem sentido em extratos da Assessoria)
const LIXO_ASSESSORIA = new Set([
  'Prefeitura Palmas 077/2025 (SRP)',  // contrato Segurança; só aparece em débitos de imposto
  'Prefeitura Palmas 007/2023',
  'MP 007/2026',
  'SEDUC 11/2023 + 3°TA',
  'SEDUC 070/2023 + 3°TA',
]);

// Lixo específico da Segurança (contratos Assessoria não devem estar em extratos Segurança)
const LIXO_SEGURANCA = new Set([
  'DETRAN 41/2023 + 2°TA',
  'UFNT 30/2022',
  'UFT 16/2025',
  'UFT MOTORISTA 05/2025',
  'TCE 117/2024',
  'CBMTO 011/2023 + 5°TA',
  'UNITINS 003/2023 + 3°TA',
  'PREVI PALMAS — em vigor',
  'SESAU 178/2022',
  'SEMARH 32/2024',
]);

function processar(empresa) {
  const db = getDb(empresa);
  console.log('\n' + '═'.repeat(80));
  console.log(`  ${empresa.toUpperCase()} — Limpar contrato_vinculado indevido`);
  console.log('═'.repeat(80));

  const lixoEmpresa = empresa === 'assessoria' ? LIXO_ASSESSORIA : LIXO_SEGURANCA;
  const todosLixo = [...LIXO_UNIVERSAL, ...lixoEmpresa];

  let totalLimpos = 0;
  for (const lbl of todosLixo) {
    const n = db.prepare(`SELECT COUNT(*) q FROM extratos WHERE contrato_vinculado = ?`).get(lbl).q;
    if (n > 0) {
      console.log(`     "${lbl}"  →  NULL  (${n} extratos)`);
      if (APPLY) {
        const r = db.prepare(`UPDATE extratos SET contrato_vinculado = NULL WHERE contrato_vinculado = ?`).run(lbl);
        totalLimpos += r.changes;
      } else totalLimpos += n;
    }
  }

  console.log(`\n  Total extratos limpos: ${totalLimpos}`);
  db.close();
  return totalLimpos;
}

console.log('\n🧹 LIMPAR contrato_vinculado INDEVIDO');
console.log(`   Modo: ${APPLY ? 'APLICAR (grava)' : 'DRY-RUN'}`);
const empresas = empArg === 'todas' ? ['assessoria', 'seguranca'] : [empArg];
let tot = 0;
for (const e of empresas) tot += processar(e);
console.log('\n' + '═'.repeat(80));
console.log(`  TOTAL: ${tot} extratos ${APPLY ? '(GRAVADO)' : '(dry-run)'}`);
console.log('═'.repeat(80));
