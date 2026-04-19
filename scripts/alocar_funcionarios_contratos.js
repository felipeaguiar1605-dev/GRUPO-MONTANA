#!/usr/bin/env node
/**
 * Montana — Alocar funcionários RH a contratos + postos
 *
 * Objetivo: enriquecer `rh_funcionarios` com FKs `bol_contrato_id` e `contrato_id`
 * (e, quando possível, `posto_id`) a partir do texto livre em `lotacao`/`contrato_ref`.
 * Isso permite calcular margem líquida por contrato (receita NF - folha - encargos).
 *
 * Uso:
 *   node scripts/alocar_funcionarios_contratos.js [empresa]          (dry-run)
 *   node scripts/alocar_funcionarios_contratos.js [empresa] --apply  (grava)
 *   node scripts/alocar_funcionarios_contratos.js todas --apply
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const argsPos = process.argv.slice(2).filter(a => !a.startsWith('--'));
const empArg = (argsPos[0] || 'todas').toLowerCase();

// Regras de mapeamento lotacao → {bol_contrato (numero_contrato), contratos.numContrato}
// Primeiro match ganha. Ordem importa (prefixos mais específicos primeiro).
const REGRAS = [
  // PREVI PALMAS (Assessoria — id bol_contrato 4)
  { re: /PREVI\s*PALMAS/i,          bol: '03/2024',   contr: 'PREVI PALMAS — em vigor' },
  // DETRAN (id 2)
  { re: /DETRAN/i,                  bol: '41/2023',   contr: 'DETRAN 41/2023 + 2°TA' },
  // SESAU / LACEN
  { re: /SESAU|LACEN|SVO|IMUNIZA/i, bol: '178/2022',  contr: 'SESAU 178/2022' },
  // SEMARH
  { re: /SEMARH/i,                  bol: '32/2024',   contr: 'SEMARH 32/2024' },
  // SEDUC (id 5)
  { re: /^SEDUC|\/SEDUC|CONSELHO|MADRE\s*BELÉM/i, bol: '016/2023', contr: 'SEDUC 016/2023' },
  // UNITINS (id 10)
  { re: /UNITINS/i,                 bol: '022/2022',  contr: 'UNITINS 003/2023 + 3°TA' },
  // TCE
  { re: /^TCE$/i,                   bol: null,        contr: 'TCE 117/2024' },
  // CBMTO (encerrado id 11)
  { re: /CBMTO|BOMBEIROS/i,         bol: '011/2023',  contr: 'CBMTO 011/2023 + 5°TA' },
  // UFT Motorista (id 9)
  { re: /MOTORISTA|TRATORISTA|MOTOCICL/i, bol: '05/2025', contr: 'UFT MOTORISTA 05/2025' },
  // UFNT (Tocantinópolis, Araguaína CCA/CCS/CIMBA)
  { re: /ARAGUA[IÍ]NA\s*(CCA|CCS|CIMBA)|TOCANTIN[ÓO]POLIS/i, bol: '30/2022', contr: 'UFNT 30/2022' },
  // UFT (demais campus/reitoria — Limpeza ATOP) — id 1
  { re: /REITORIA|CAMPUS|PALMAS|GURUPI|PORTO\s*NACIONAL|MIRACEMA|ARRAIAS|LUZIMANGUES|CANGU[CÇ]U|PARA[IÍ]SO|ARAGUA[IÍ]NA|FORMOSO|DIAN[ÓO]POLIS|AUGUSTIN[ÓO]POLIS|ARAGUATINS|GRACIOSA/i, bol: '16/2025', contr: 'UFT 16/2025' },
  // Escritório interno (não aloca a contrato externo)
  { re: /ESCRIT[ÓO]RIO|MONTANA|ADMINISTRATIVO|FINANCEIRO/i, bol: null, contr: null, interno: true },
];

function ensureColumns(db) {
  const cols = db.prepare('PRAGMA table_info(rh_funcionarios)').all().map(c => c.name);
  if (!cols.includes('bol_contrato_id')) {
    console.log('  + adicionando coluna bol_contrato_id');
    if (APPLY) db.prepare('ALTER TABLE rh_funcionarios ADD COLUMN bol_contrato_id INTEGER').run();
  }
  if (!cols.includes('contrato_id')) {
    console.log('  + adicionando coluna contrato_id');
    if (APPLY) db.prepare('ALTER TABLE rh_funcionarios ADD COLUMN contrato_id INTEGER').run();
  }
  if (!cols.includes('posto_id')) {
    console.log('  + adicionando coluna posto_id');
    if (APPLY) db.prepare('ALTER TABLE rh_funcionarios ADD COLUMN posto_id INTEGER').run();
  }
  if (!cols.includes('interno_flag')) {
    console.log('  + adicionando coluna interno_flag');
    if (APPLY) db.prepare('ALTER TABLE rh_funcionarios ADD COLUMN interno_flag INTEGER DEFAULT 0').run();
  }
}

function alocar(empresa) {
  const db = getDb(empresa);
  console.log('\n' + '═'.repeat(80));
  console.log(`  ${empresa.toUpperCase()} — Alocar funcionários a contratos/postos`);
  console.log('═'.repeat(80));

  ensureColumns(db);

  // Mapeamento reverso bol_contratos por numero_contrato
  const bolByNum = {};
  for (const r of db.prepare('SELECT id, numero_contrato, nome FROM bol_contratos').all()) {
    bolByNum[r.numero_contrato] = r;
  }
  // Mapeamento reverso contratos por numContrato
  let contrByNum = {};
  try {
    for (const r of db.prepare('SELECT id, numContrato FROM contratos').all()) {
      contrByNum[r.numContrato] = r;
    }
  } catch (e) { /* tabela pode não ter mesmo schema em todas empresas */ }

  const funcs = db.prepare(`SELECT id, nome, lotacao, contrato_ref FROM rh_funcionarios`).all();
  const matches = {};
  const semMatch = [];
  const internos = [];

  for (const f of funcs) {
    const chave = (f.lotacao || f.contrato_ref || '').trim();
    if (!chave) { semMatch.push(f); continue; }

    let encontrado = null;
    for (const regra of REGRAS) {
      if (regra.re.test(chave)) { encontrado = regra; break; }
    }
    if (!encontrado) { semMatch.push(f); continue; }
    if (encontrado.interno) { internos.push(f); continue; }

    const bol = encontrado.bol ? bolByNum[encontrado.bol] : null;
    const contr = encontrado.contr ? contrByNum[encontrado.contr] : null;
    const key = (bol?.nome || encontrado.contr || 'DESCONHECIDO');
    if (!matches[key]) matches[key] = { bol, contr, funcs: [] };
    matches[key].funcs.push(f);
  }

  console.log(`\n[1] Resumo da alocação (${funcs.length} funcionários analisados):`);
  console.log(`    ${String(Object.values(matches).reduce((s, m) => s + m.funcs.length, 0)).padStart(4)} alocados em ${Object.keys(matches).length} contratos`);
  console.log(`    ${String(internos.length).padStart(4)} marcados como internos (escritório Montana)`);
  console.log(`    ${String(semMatch.length).padStart(4)} sem match (lotação não reconhecida)`);

  console.log(`\n[2] Detalhe por contrato:`);
  const sorted = Object.entries(matches).sort((a, b) => b[1].funcs.length - a[1].funcs.length);
  for (const [nome, m] of sorted) {
    const bolId = m.bol?.id ?? '—';
    const contrId = m.contr?.id ?? '—';
    console.log(`    ${String(m.funcs.length).padStart(3)} func | bol_contrato_id=${bolId} contrato_id=${contrId} → ${nome.slice(0, 60)}`);
  }

  if (semMatch.length > 0) {
    console.log(`\n[3] Lotações sem match (${semMatch.length}) — primeiros 15:`);
    const amostra = semMatch.slice(0, 15);
    for (const f of amostra) console.log(`    [${f.id}] ${(f.nome || '').slice(0, 28).padEnd(28)} | lot="${(f.lotacao || '').slice(0, 50)}"`);
  }

  if (APPLY) {
    console.log(`\n[4] Aplicando atualizações...`);
    const up = db.prepare(`UPDATE rh_funcionarios SET bol_contrato_id=?, contrato_id=?, interno_flag=0 WHERE id=?`);
    const upInt = db.prepare(`UPDATE rh_funcionarios SET interno_flag=1, bol_contrato_id=NULL, contrato_id=NULL WHERE id=?`);
    const tx = db.transaction(() => {
      for (const m of Object.values(matches)) {
        for (const f of m.funcs) up.run(m.bol?.id ?? null, m.contr?.id ?? null, f.id);
      }
      for (const f of internos) upInt.run(f.id);
    });
    tx();
    console.log(`    ✓ ${funcs.length - semMatch.length} funcionários atualizados`);
  } else {
    console.log(`\n[4] Dry-run — nenhuma gravação. Use --apply para gravar.`);
  }

  db.close();
  return { total: funcs.length, alocados: funcs.length - semMatch.length - internos.length, internos: internos.length, sem_match: semMatch.length };
}

console.log('\n🔄 ALOCAÇÃO FUNCIONÁRIOS → CONTRATOS/POSTOS');
console.log(`   Modo: ${APPLY ? 'APLICAR (grava)' : 'DRY-RUN (não grava)'}`);

const empresas = empArg === 'todas' ? ['assessoria', 'seguranca'] : [empArg];
for (const e of empresas) alocar(e);

console.log('\n' + '═'.repeat(80));
console.log(`  ${APPLY ? '✓ GRAVADO' : '(dry-run — sem gravação)'}`);
console.log('═'.repeat(80));
