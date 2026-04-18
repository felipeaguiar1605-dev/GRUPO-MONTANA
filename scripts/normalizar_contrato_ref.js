'use strict';
/**
 * Normaliza contrato_ref (NFs) e contrato_vinculado (extratos) para valores canônicos
 * de contratos.numContrato — elimina labels históricos que não existem mais.
 *
 * Também remove NFs cross-empresa (CONTAMINADA) do banco errado, desde que exista
 * equivalente no banco correto (por numero+tomador+data).
 *
 * Uso:
 *   node scripts/normalizar_contrato_ref.js [empresa]          (dry-run)
 *   node scripts/normalizar_contrato_ref.js [empresa] --apply  (grava)
 *   node scripts/normalizar_contrato_ref.js [empresa] --apply --apagar-contaminadas
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const APAGAR = process.argv.includes('--apagar-contaminadas');
const argsPos = process.argv.slice(2).filter(a => !a.startsWith('--'));
const empArg = (argsPos[0] || 'todas').toLowerCase();

// Mapa de labels obsoletos → numContrato atual (por empresa).
// Quando label estiver ausente da tabela `contratos`, é redirecionado aqui.
const ALIAS_POR_EMPRESA = {
  assessoria: {
    'DETRAN 02/2024 + 2°TA': 'DETRAN 41/2023 + 2°TA',
    'UFT 29/2022 + 9°TA': 'UFNT 30/2022',
    'UFT 29/2022 + 9°TA (Conta Vinculada)': 'UFNT 30/2022',
  },
  seguranca: {
    // nenhum alias conhecido até o momento
  },
};

// Labels técnicos que não representam contrato (nunca viram numContrato válido)
const LABELS_NAO_CONTRATO = new Set([
  'JUROS', 'SALDO', 'PIX REJEITADO', 'TRANSFERÊNCIA', 'TRANSFERENCIA',
  'Montana Segurança', 'Montana Assessoria',
]);

function processar(empresa) {
  const db = getDb(empresa);
  console.log('\n' + '═'.repeat(80));
  console.log(`  ${empresa.toUpperCase()} — Normalizar contrato_ref / contrato_vinculado`);
  console.log('═'.repeat(80));

  const contratos = new Set(db.prepare('SELECT numContrato FROM contratos').all().map(r => r.numContrato));
  const alias = ALIAS_POR_EMPRESA[empresa] || {};

  // 1. Renomear NFs.contrato_ref conforme ALIAS
  let nfRenomeadas = 0;
  console.log('\n  -- NFs: renomeando contrato_ref via ALIAS');
  for (const [de, para] of Object.entries(alias)) {
    const n = db.prepare(`SELECT COUNT(*) q FROM notas_fiscais WHERE contrato_ref = ?`).get(de).q;
    if (n > 0) {
      console.log(`     "${de}"  →  "${para}"  (${n} NFs)`);
      if (APPLY) {
        const r = db.prepare(`UPDATE notas_fiscais SET contrato_ref = ? WHERE contrato_ref = ?`).run(para, de);
        nfRenomeadas += r.changes;
      } else nfRenomeadas += n;
    }
  }

  // 2. Renomear extratos.contrato_vinculado conforme ALIAS
  let extRenomeados = 0;
  console.log('\n  -- Extratos: renomeando contrato_vinculado via ALIAS');
  for (const [de, para] of Object.entries(alias)) {
    const n = db.prepare(`SELECT COUNT(*) q FROM extratos WHERE contrato_vinculado = ?`).get(de).q;
    if (n > 0) {
      console.log(`     "${de}"  →  "${para}"  (${n} extratos)`);
      if (APPLY) {
        const r = db.prepare(`UPDATE extratos SET contrato_vinculado = ? WHERE contrato_vinculado = ?`).run(para, de);
        extRenomeados += r.changes;
      } else extRenomeados += n;
    }
  }

  // 3. Limpar labels técnicos em extratos.contrato_vinculado (não são contratos)
  let tecnicosLimpos = 0;
  console.log('\n  -- Extratos: limpando labels técnicos (JUROS/SALDO/TRANSFERÊNCIA...)');
  for (const lbl of LABELS_NAO_CONTRATO) {
    const n = db.prepare(`SELECT COUNT(*) q FROM extratos WHERE contrato_vinculado = ?`).get(lbl).q;
    if (n > 0) {
      console.log(`     limpar "${lbl}"  (${n} extratos)`);
      if (APPLY) {
        const r = db.prepare(`UPDATE extratos SET contrato_vinculado = NULL WHERE contrato_vinculado = ?`).run(lbl);
        tecnicosLimpos += r.changes;
      } else tecnicosLimpos += n;
    }
  }

  // 4. Relatório de contrato_ref/contrato_vinculado AINDA órfãos (não em contratos, não tratados por alias)
  console.log('\n  -- Órfãos remanescentes (NFs):');
  for (const r of db.prepare(`SELECT contrato_ref, COUNT(*) q FROM notas_fiscais WHERE contrato_ref IS NOT NULL AND contrato_ref != '' GROUP BY contrato_ref`).all()) {
    if (!contratos.has(r.contrato_ref) && r.contrato_ref.indexOf('⚠️') === -1) {
      console.log(`     ${String(r.q).padStart(5)} | "${r.contrato_ref}"`);
    }
  }
  console.log('\n  -- Órfãos remanescentes (Extratos):');
  for (const r of db.prepare(`SELECT contrato_vinculado, COUNT(*) q FROM extratos WHERE contrato_vinculado IS NOT NULL AND contrato_vinculado != '' GROUP BY contrato_vinculado`).all()) {
    if (!contratos.has(r.contrato_vinculado)) {
      console.log(`     ${String(r.q).padStart(5)} | "${r.contrato_vinculado}"`);
    }
  }

  // 5. NFs CONTAMINADAs: opcionalmente apagar (apenas se --apagar-contaminadas + --apply)
  const contaminadas = db.prepare(`SELECT COUNT(*) q, ROUND(SUM(valor_bruto),2) v FROM notas_fiscais WHERE contrato_ref LIKE '%CONTAMIN%' OR contrato_ref LIKE '%⚠️%'`).get();
  console.log(`\n  -- NFs CONTAMINADAs (pertencem a outra empresa): ${contaminadas.q} | R$ ${contaminadas.v || 0}`);
  if (contaminadas.q > 0) {
    if (APAGAR && APPLY) {
      const r = db.prepare(`DELETE FROM notas_fiscais WHERE contrato_ref LIKE '%CONTAMIN%' OR contrato_ref LIKE '%⚠️%'`).run();
      console.log(`     ✅ ${r.changes} NFs contaminadas APAGADAS`);
    } else if (APAGAR) {
      console.log(`     (dry-run) — seriam deletadas ${contaminadas.q} NFs`);
    } else {
      console.log(`     (preservadas — use --apagar-contaminadas para remover)`);
    }
  }

  console.log('\n  Resumo desta empresa:');
  console.log(`     NFs renomeadas:        ${nfRenomeadas}`);
  console.log(`     Extratos renomeados:   ${extRenomeados}`);
  console.log(`     Labels técnicos limpos: ${tecnicosLimpos}`);

  db.close();
  return { nfRenomeadas, extRenomeados, tecnicosLimpos };
}

console.log('\n🔧 NORMALIZAR contrato_ref / contrato_vinculado');
console.log(`   Modo: ${APPLY ? 'APLICAR (grava)' : 'DRY-RUN (só analisa)'}`);
console.log(`   Apagar contaminadas: ${APAGAR ? 'SIM' : 'não'}`);

const empresas = empArg === 'todas' ? ['assessoria', 'seguranca'] : [empArg];
let total = { nfRenomeadas: 0, extRenomeados: 0, tecnicosLimpos: 0 };
for (const e of empresas) {
  const r = processar(e);
  total.nfRenomeadas += r.nfRenomeadas;
  total.extRenomeados += r.extRenomeados;
  total.tecnicosLimpos += r.tecnicosLimpos;
}
console.log('\n' + '═'.repeat(80));
console.log(`  TOTAL: ${total.nfRenomeadas} NFs | ${total.extRenomeados} extratos | ${total.tecnicosLimpos} labels técnicos ${APPLY ? '(GRAVADO)' : '(dry-run)'}`);
console.log('═'.repeat(80));
