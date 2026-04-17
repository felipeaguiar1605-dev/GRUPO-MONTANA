'use strict';
/**
 * Seed da tabela pagador_alias — Sprint 1 da conciliação robusta.
 *
 * Popula aliases de CNPJs conhecidos + padrões de histórico para
 * identificar o pagador em extratos TED/PIX (onde o crédito chega
 * sem o nome completo do tomador, apenas CNPJ e código operacional).
 *
 * Uso:
 *   node scripts/seed_pagador_alias.js               # dry-run
 *   node scripts/seed_pagador_alias.js --apply       # aplica
 *   node scripts/seed_pagador_alias.js --apply --empresa=seguranca
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const ARG = process.argv.slice(2);
const APLICAR = ARG.includes('--apply');
const empresaArg = (ARG.find(a => a.startsWith('--empresa=')) || '').split('=')[1];
const EMPRESAS = empresaArg ? [empresaArg] : ['assessoria', 'seguranca'];

// ─────────────────────────────────────────────────────────────
// Catálogo canônico de pagadores conhecidos (Grupo Montana)
// ─────────────────────────────────────────────────────────────
// Campos: cnpj (só dígitos), cnpj_raiz (8), padrao_historico (regex),
//          nome_canonico, tomador_match (LIKE p/ notas_fiscais.tomador),
//          contrato_default, empresa_dono, janela_dias, tolerancia_pct, prioridade
const ALIASES = [
  // ═══════ MUNICIPIO DE PALMAS ═══════
  // CNPJ Prefeitura 24851511/0001-85 (raiz 24851511 tem várias filiais/secretarias)
  { cnpj: '24851511000185', cnpj_raiz: '24851511',
    nome_canonico: 'MUNICIPIO DE PALMAS',
    tomador_match: '%PALMAS%',
    padrao_historico: '(MUNICIPIO DE PALMAS|PREFEITURA.*PALMAS|PMP)',
    empresa_dono: '', janela_dias: 90, tolerancia_pct: 0.05, prioridade: 10 },

  // SEMUS / Fundo Municipal de Saúde Palmas (secretaria)
  { cnpj: '09542213000146', cnpj_raiz: '09542213',
    nome_canonico: 'FUNDO MUNICIPAL DE SAUDE PALMAS',
    tomador_match: '%SAUDE%PALMAS%',
    padrao_historico: '(FUNDO.*SAUDE.*PALMAS|SEMUS|SESAU.*PALMAS)',
    contrato_default: 'Sec. Saúde Palmas 192/2025',
    empresa_dono: 'assessoria', janela_dias: 90, tolerancia_pct: 0.05, prioridade: 20 },

  // PREVI-PALMAS
  { cnpj: '04403607000128', cnpj_raiz: '04403607',
    nome_canonico: 'PREVIPALMAS',
    tomador_match: '%PREVI%PALMAS%',
    padrao_historico: '(PREVI.?PALMAS|INSTITUTO.*PREVID.*PALMAS)',
    contrato_default: 'PREVI PALMAS 03/2024',
    empresa_dono: 'assessoria', janela_dias: 90, tolerancia_pct: 0.05, prioridade: 20 },

  // ═══════ ESTADO DO TOCANTINS (Tesouro Estadual) ═══════
  // CNPJ 01786029/0001-03 — paga em nome de quase todos os órgãos estaduais
  { cnpj: '01786029000103', cnpj_raiz: '01786029',
    nome_canonico: 'ESTADO DO TOCANTINS',
    tomador_match: '%ESTADO%TOCANTINS%',
    padrao_historico: '(ESTADO.*TOCANTINS|TESOURO.*ESTADUAL|SEFAZ.*TO)',
    empresa_dono: '', janela_dias: 120, tolerancia_pct: 0.08, prioridade: 30 },

  // SEDUC / FUNDEB (paga via Estado mas aparece FUNDEB no histórico)
  { cnpj: '25053117000176', cnpj_raiz: '25053117',
    nome_canonico: 'SEDUC TOCANTINS',
    tomador_match: '%EDUCACAO%TOCANTINS%',
    padrao_historico: '(FUNDEB|SEDUC.*TO|SEC.*EDUCACAO.*TOCANTINS)',
    empresa_dono: '', janela_dias: 90, tolerancia_pct: 0.05, prioridade: 15 },

  // MP/TO — Ministério Público do Tocantins
  { cnpj: '25053132000150', cnpj_raiz: '25053132',
    nome_canonico: 'MINISTERIO PUBLICO TOCANTINS',
    tomador_match: '%MINISTERIO%PUBLICO%',
    padrao_historico: '(MINISTERIO.*PUBLICO|MP.?TO|MPTO)',
    contrato_default: 'MP 007/2026',
    empresa_dono: 'seguranca', janela_dias: 90, tolerancia_pct: 0.05, prioridade: 15 },

  // DETRAN/TO
  { cnpj: '25053083000108', cnpj_raiz: '25053083',
    nome_canonico: 'DETRAN TOCANTINS',
    tomador_match: '%DETRAN%',
    padrao_historico: '(DETRAN.*TO|DEPARTAMENTO.*TRANSITO)',
    contrato_default: 'DETRAN 41/2023 + 2°TA',
    empresa_dono: 'assessoria', janela_dias: 90, tolerancia_pct: 0.05, prioridade: 20 },

  // CBMTO
  { cnpj: '08711697000166', cnpj_raiz: '08711697',
    nome_canonico: 'CORPO DE BOMBEIROS TO',
    tomador_match: '%BOMBEIR%',
    padrao_historico: '(CBMTO|CORPO.*BOMBEIR.*TOCANTINS)',
    contrato_default: 'CBMTO 011/2023 + 5°TA',
    empresa_dono: 'assessoria', janela_dias: 90, tolerancia_pct: 0.05, prioridade: 20 },

  // TCE/TO
  { cnpj: '25053157000145', cnpj_raiz: '25053157',
    nome_canonico: 'TRIBUNAL DE CONTAS TO',
    tomador_match: '%TRIBUNAL%CONTAS%',
    padrao_historico: '(TCE.?TO|TRIBUNAL.*CONTAS.*TOCANTINS)',
    contrato_default: 'TCE 117/2024',
    empresa_dono: 'assessoria', janela_dias: 90, tolerancia_pct: 0.05, prioridade: 20 },

  // UNITINS
  { cnpj: '25089188000165', cnpj_raiz: '25089188',
    nome_canonico: 'UNITINS',
    tomador_match: '%UNITINS%',
    padrao_historico: '(UNITINS|UNIVERSIDADE.*TOCANTINS)',
    contrato_default: 'UNITINS 003/2023 + 3°TA',
    empresa_dono: 'assessoria', janela_dias: 90, tolerancia_pct: 0.05, prioridade: 20 },

  // TJ-TO / FUNJURIS
  { cnpj: '25053190000110', cnpj_raiz: '25053190',
    nome_canonico: 'TJ TOCANTINS',
    tomador_match: '%TJ%TOCANTINS%',
    padrao_historico: '(FUNJURIS|TJ.?TO|TRIBUNAL.*JUSTICA.*TOCANTINS)',
    empresa_dono: '', janela_dias: 120, tolerancia_pct: 0.08, prioridade: 25 },

  // ═══════ FEDERAL ═══════
  // Fundação UFT (Fundação da Universidade Federal do Tocantins)
  { cnpj: '05149726000104', cnpj_raiz: '05149726',
    nome_canonico: 'FUNDACAO UFT',
    tomador_match: '%UFT%',
    padrao_historico: '(FUND.*UFT|FUNDACAO.*UFT|UFT\\b)',
    contrato_default: 'UFT 16/2025',
    empresa_dono: 'assessoria', janela_dias: 60, tolerancia_pct: 0.03, prioridade: 10 },

  // UFT (Universidade Federal do Tocantins — autarquia)
  { cnpj: '05149726000104', cnpj_raiz: '05149726',
    nome_canonico: 'UNIVERSIDADE FEDERAL TOCANTINS',
    tomador_match: '%UNIVERSIDADE%FEDERAL%TOCANTINS%',
    padrao_historico: '(UNIVERSIDADE.*FEDERAL.*TOCANTINS)',
    empresa_dono: 'assessoria', janela_dias: 60, tolerancia_pct: 0.03, prioridade: 11 },

  // UFNT — Universidade Federal do Norte do Tocantins
  { cnpj: '47625495000154', cnpj_raiz: '47625495',
    nome_canonico: 'UFNT',
    tomador_match: '%UFNT%',
    padrao_historico: '(UFNT|UNIV.*NORTE.*TOCANTINS)',
    contrato_default: 'UFNT 30/2022',
    empresa_dono: 'assessoria', janela_dias: 60, tolerancia_pct: 0.03, prioridade: 11 },

  // ═══════ INTERNO MONTANA (transferências entre empresas do grupo) ═══════
  { cnpj: '14092519000151', cnpj_raiz: '14092519',
    nome_canonico: 'MONTANA ASSESSORIA',
    padrao_historico: '(MONTANA.*ASSESSORIA)',
    empresa_dono: '', janela_dias: 30, tolerancia_pct: 0.02, prioridade: 50 },
  { cnpj: '19200109000109', cnpj_raiz: '19200109',
    nome_canonico: 'MONTANA SEGURANCA',
    padrao_historico: '(MONTANA.*SEGURANCA|MONTANA.*SEGURANÇA)',
    empresa_dono: '', janela_dias: 30, tolerancia_pct: 0.02, prioridade: 50 },
  { cnpj: '41034574000168', cnpj_raiz: '41034574',
    nome_canonico: 'PORTO DO VAU',
    padrao_historico: '(PORTO.*VAU)',
    empresa_dono: '', janela_dias: 30, tolerancia_pct: 0.02, prioridade: 50 },
  { cnpj: '26600137000170', cnpj_raiz: '26600137',
    nome_canonico: 'MUSTANG',
    padrao_historico: '(MUSTANG)',
    empresa_dono: '', janela_dias: 30, tolerancia_pct: 0.02, prioridade: 50 },
];

// ─────────────────────────────────────────────────────────────
function upsertAlias(db, a) {
  const existe = db.prepare(`
    SELECT id FROM pagador_alias
    WHERE (cnpj = ? AND cnpj <> '') OR (nome_canonico = ? AND cnpj = '')
  `).get(a.cnpj || '', a.nome_canonico);

  if (existe) {
    db.prepare(`
      UPDATE pagador_alias SET
        cnpj_raiz = ?, padrao_historico = ?, nome_canonico = ?,
        tomador_match = ?, contrato_default = ?, empresa_dono = ?,
        janela_dias = ?, tolerancia_pct = ?, prioridade = ?,
        ativo = 1, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      a.cnpj_raiz || '', a.padrao_historico || '', a.nome_canonico,
      a.tomador_match || '', a.contrato_default || '', a.empresa_dono || '',
      a.janela_dias || 90, a.tolerancia_pct || 0.05, a.prioridade || 100,
      existe.id
    );
    return 'update';
  }

  db.prepare(`
    INSERT INTO pagador_alias
      (cnpj, cnpj_raiz, padrao_historico, nome_canonico, tomador_match,
       contrato_default, empresa_dono, janela_dias, tolerancia_pct, prioridade)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    a.cnpj || '', a.cnpj_raiz || '', a.padrao_historico || '',
    a.nome_canonico, a.tomador_match || '', a.contrato_default || '',
    a.empresa_dono || '', a.janela_dias || 90,
    a.tolerancia_pct || 0.05, a.prioridade || 100
  );
  return 'insert';
}

function processar(empresa) {
  console.log(`\n━━━ ${empresa.toUpperCase()} ━━━`);
  const db = getDb(empresa);

  // Filtra aliases: empresa_dono='' (ambos) ou empresa_dono=empresa
  const paraEsta = ALIASES.filter(a => !a.empresa_dono || a.empresa_dono === empresa);
  console.log(`  Aliases aplicáveis: ${paraEsta.length}`);

  if (!APLICAR) {
    console.log(`  (dry-run) Para aplicar, rode com --apply`);
    paraEsta.slice(0, 5).forEach(a =>
      console.log(`    • ${a.nome_canonico.padEnd(35)} CNPJ ${a.cnpj || '(sem)'}`)
    );
    if (paraEsta.length > 5) console.log(`    ... e +${paraEsta.length - 5}`);
    return;
  }

  let ins = 0, upd = 0;
  const trx = db.transaction(() => {
    for (const a of paraEsta) {
      const r = upsertAlias(db, a);
      if (r === 'insert') ins++; else upd++;
    }
  });
  trx();
  console.log(`  ✓ ${ins} inseridos | ${upd} atualizados`);

  const total = db.prepare('SELECT COUNT(*) c FROM pagador_alias WHERE ativo = 1').get().c;
  console.log(`  Total ativo na tabela: ${total}`);
}

console.log(`🧩 Seed pagador_alias — modo: ${APLICAR ? 'APLICAR' : 'DRY-RUN'}`);
EMPRESAS.forEach(processar);
console.log('\n✔️  Concluído.');
