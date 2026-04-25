#!/usr/bin/env node
/**
 * Montana — Limpeza nível 4 (finalizações pontuais)
 *
 * 1. Assessoria: remapear contrato_ref "PREVI PALMAS — em vigor" → nome efetivo em contratos
 *    (ex: "PREVIPALMAS 02/2024 + 2°TA" em prod; ou o que existir em local)
 * 2. Segurança: criar contrato "UFT — Segurança Privada" se não existir (347 NFs referenciam)
 * 3. Normalizar status residuais: PENDENTE-VINCULADO→PENDENTE, GARANTIA→CONTA_VINCULADA, SALDO→''
 *
 * Uso:
 *   node scripts/limpar_inconsistencias4.js [empresa]           # dry-run
 *   node scripts/limpar_inconsistencias4.js [empresa] --apply
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const posArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));
const empArg = (posArgs[0] || 'todas').toLowerCase();

const STATUS_REMAP = {
  'PENDENTE-VINCULADO': 'PENDENTE',
  'GARANTIA': 'CONTA_VINCULADA',
  'SALDO': '',
};

function processar(empresa) {
  const db = getDb(empresa);
  console.log('\n' + '═'.repeat(90));
  console.log(`  LIMPAR NÍVEL 4 — ${empresa.toUpperCase()}  ${APPLY ? '[APPLY]' : '[dry-run]'}`);
  console.log('═'.repeat(90));

  // ── 1. Remapear contrato_ref "PREVI PALMAS — em vigor" para o nome efetivo
  if (empresa === 'assessoria') {
    console.log('\n── 1. Remapear "PREVI PALMAS — em vigor" ──');
    const alvo = db.prepare(`SELECT numContrato FROM contratos WHERE numContrato LIKE '%PREVI%' LIMIT 1`).get();
    if (!alvo) {
      console.log('   ⚠️ nenhum contrato PREVI na tabela contratos — pulando');
    } else {
      const q = db.prepare(`SELECT COUNT(*) q FROM notas_fiscais WHERE contrato_ref = ?`).get('PREVI PALMAS — em vigor');
      console.log(`   ${q.q} NFs | mapear para "${alvo.numContrato}"`);
      if (APPLY && q.q > 0) {
        db.prepare(`UPDATE notas_fiscais SET contrato_ref = ? WHERE contrato_ref = ?`).run(alvo.numContrato, 'PREVI PALMAS — em vigor');
      }
    }
  }

  // ── 2. Seg: criar contrato UFT — Segurança Privada se não existir
  if (empresa === 'seguranca') {
    console.log('\n── 2. Contrato "UFT — Segurança Privada" ──');
    const existe = db.prepare(`SELECT id FROM contratos WHERE numContrato = ?`).get('UFT — Segurança Privada');
    const refs = db.prepare(`SELECT COUNT(*) q FROM notas_fiscais WHERE contrato_ref = ?`).get('UFT — Segurança Privada');
    console.log(`   Contrato já existe? ${existe ? 'SIM' : 'NÃO'} | ${refs.q} NFs referenciam`);
    if (!existe && refs.q > 0) {
      const cols = db.prepare('PRAGMA table_info(contratos)').all().map(c => c.name);
      console.log(`   + criando contrato (colunas: ${cols.slice(0, 5).join(',')}…)`);
      if (APPLY) {
        // Detecta colunas NOT NULL e monta INSERT com valores seguros
        const info = db.prepare('PRAGMA table_info(contratos)').all();
        const nomeContrato = 'UFT — Segurança Privada';
        const campos = []; const vals = [];
        for (const c of info) {
          if (c.name === 'id') continue; // autoincrement
          if (c.name === 'numContrato') { campos.push('numContrato'); vals.push(nomeContrato); continue; }
          if (c.name === 'contrato')    { campos.push('contrato');    vals.push(nomeContrato); continue; }
          if (c.name === 'nome')        { campos.push('nome');        vals.push(nomeContrato); continue; }
          if (c.name === 'orgao')       { campos.push('orgao');       vals.push('UFT'); continue; }
          // Para demais NOT NULL sem default, preenche com valor sentinela
          if (c.notnull && c.dflt_value === null) {
            campos.push(c.name);
            vals.push(c.type.toUpperCase().includes('INT') || c.type.toUpperCase().includes('REAL') ? 0 : '');
          }
        }
        const placeholders = campos.map(() => '?').join(',');
        db.prepare(`INSERT INTO contratos (${campos.join(',')}) VALUES (${placeholders})`).run(...vals);
        console.log(`   ✓ criado com campos: ${campos.join(', ')}`);
      }
    }
  }

  // ── 3. Normalizar status residuais
  console.log('\n── 3. Normalizar status residuais ──');
  let normN = 0;
  for (const [de, para] of Object.entries(STATUS_REMAP)) {
    const r = db.prepare(`SELECT COUNT(*) q FROM extratos WHERE status_conciliacao = ?`).get(de);
    if (r.q === 0) continue;
    console.log(`   "${de}" → "${para || '(vazio)'}" | ${r.q} extratos`);
    if (APPLY) {
      db.prepare(`UPDATE extratos SET status_conciliacao = ? WHERE status_conciliacao = ?`).run(para, de);
    }
    normN += r.q;
  }
  if (normN === 0) console.log('   ✅ nenhum status residual');

  db.close();
}

const empresas = empArg === 'todas' ? ['assessoria', 'seguranca'] : [empArg];
for (const e of empresas) processar(e);

console.log('\n' + '═'.repeat(90));
console.log(`  ${APPLY ? '✓ APLICADO' : '⚠️  dry-run'}`);
console.log('═'.repeat(90));
