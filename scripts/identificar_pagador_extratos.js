'use strict';
/**
 * Identifica o pagador em cada linha de extrato bancário — Sprint 2.
 *
 * Estratégia em 3 passes (por prioridade):
 *   1. Match por CNPJ completo (14 dígitos) encontrado no historico
 *   2. Match por CNPJ raiz (8 dígitos) — cobre filiais
 *   3. Match por padrão regex/LIKE no texto do historico
 *
 * Resultado escrito em:
 *   extratos.pagador_identificado (nome canônico)
 *   extratos.pagador_cnpj (CNPJ encontrado)
 *   extratos.pagador_metodo ('cnpj' | 'cnpj_raiz' | 'regex')
 *
 * Uso:
 *   node scripts/identificar_pagador_extratos.js                         # dry-run, ambas empresas
 *   node scripts/identificar_pagador_extratos.js --apply
 *   node scripts/identificar_pagador_extratos.js --apply --empresa=seguranca
 *   node scripts/identificar_pagador_extratos.js --apply --reprocessar   # limpa e refaz tudo
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const ARG = process.argv.slice(2);
const APLICAR = ARG.includes('--apply');
const REPROCESSAR = ARG.includes('--reprocessar');
const empresaArg = (ARG.find(a => a.startsWith('--empresa=')) || '').split('=')[1];
const EMPRESAS = empresaArg ? [empresaArg] : ['assessoria', 'seguranca'];

const semAcento = s => (s || '')
  .toString()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toUpperCase();

// Extrai todos os CNPJs (14 dígitos contíguos OU formatados) de um texto
function extrairCnpjs(texto) {
  if (!texto) return [];
  const t = String(texto);
  const out = new Set();
  // padrão com ou sem máscara: 14 dígitos, opcional pontos/barra/traço
  const re = /(?:\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}|\d{14})/g;
  const matches = t.match(re) || [];
  for (const m of matches) {
    const somente = m.replace(/\D/g, '');
    if (somente.length === 14) out.add(somente);
  }
  return [...out];
}

function processar(empresa) {
  console.log(`\n━━━ ${empresa.toUpperCase()} ━━━`);
  const db = getDb(empresa);

  const aliases = db.prepare(`
    SELECT id, cnpj, cnpj_raiz, padrao_historico, nome_canonico, empresa_dono
    FROM pagador_alias
    WHERE ativo = 1
    ORDER BY prioridade ASC, id ASC
  `).all();

  if (aliases.length === 0) {
    console.log(`  ⚠️  Nenhum alias na tabela — rode seed_pagador_alias.js --apply primeiro.`);
    return;
  }
  console.log(`  Aliases carregados: ${aliases.length}`);

  // Índices em memória para lookups rápidos
  const porCnpj = new Map();
  const porRaiz = new Map();
  const regexes = [];
  for (const a of aliases) {
    if (a.cnpj) porCnpj.set(a.cnpj, a);
    if (a.cnpj_raiz && !porRaiz.has(a.cnpj_raiz)) porRaiz.set(a.cnpj_raiz, a);
    if (a.padrao_historico) {
      try {
        regexes.push({ alias: a, re: new RegExp(a.padrao_historico, 'i') });
      } catch (_) { /* regex inválida — ignora */ }
    }
  }

  // Busca extratos
  const where = REPROCESSAR
    ? `(credito > 0 OR debito > 0)`
    : `(credito > 0 OR debito > 0) AND (pagador_identificado IS NULL OR pagador_identificado = '')`;

  const lancs = db.prepare(`
    SELECT id, data_iso, historico, credito, debito
    FROM extratos
    WHERE ${where}
  `).all();
  console.log(`  Lançamentos a processar: ${lancs.length}`);

  const stats = { cnpj: 0, cnpj_raiz: 0, regex: 0, nada: 0 };
  const updates = [];

  for (const l of lancs) {
    const hist = semAcento(l.historico);
    let achado = null;
    let metodo = '';
    let cnpjEncontrado = '';

    // 1) Por CNPJ completo
    const cnpjs = extrairCnpjs(l.historico);
    for (const c of cnpjs) {
      if (porCnpj.has(c)) {
        achado = porCnpj.get(c);
        metodo = 'cnpj';
        cnpjEncontrado = c;
        break;
      }
    }

    // 2) Por raiz (8 dígitos)
    if (!achado) {
      for (const c of cnpjs) {
        const raiz = c.substring(0, 8);
        if (porRaiz.has(raiz)) {
          achado = porRaiz.get(raiz);
          metodo = 'cnpj_raiz';
          cnpjEncontrado = c;
          break;
        }
      }
    }

    // 3) Por regex no histórico
    if (!achado) {
      for (const { alias, re } of regexes) {
        if (re.test(hist)) {
          achado = alias;
          metodo = 'regex';
          break;
        }
      }
    }

    if (!achado) { stats.nada++; continue; }
    stats[metodo]++;
    updates.push({
      id: l.id,
      nome: achado.nome_canonico,
      cnpj: cnpjEncontrado,
      metodo
    });
  }

  console.log(`  → por CNPJ:       ${stats.cnpj}`);
  console.log(`  → por CNPJ raiz:  ${stats.cnpj_raiz}`);
  console.log(`  → por regex:      ${stats.regex}`);
  console.log(`  → não identif.:   ${stats.nada}`);

  if (!APLICAR) {
    console.log(`  (dry-run) — use --apply para gravar`);
    return;
  }

  const stmt = db.prepare(`
    UPDATE extratos
    SET pagador_identificado = ?, pagador_cnpj = ?, pagador_metodo = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `);
  const trx = db.transaction(us => {
    for (const u of us) stmt.run(u.nome, u.cnpj, u.metodo, u.id);
  });
  trx(updates);
  console.log(`  ✓ ${updates.length} extratos atualizados`);

  // Top 10 pagadores
  const top = db.prepare(`
    SELECT pagador_identificado p, COUNT(*) n, ROUND(SUM(credito),2) tot
    FROM extratos
    WHERE pagador_identificado <> ''
    GROUP BY pagador_identificado
    ORDER BY tot DESC
    LIMIT 10
  `).all();
  console.log(`\n  Top 10 pagadores (por valor creditado):`);
  for (const r of top) {
    const val = (r.tot || 0).toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2});
    console.log(`    ${String(r.n).padStart(4)}x  R$ ${val.padStart(14)}  ${r.p}`);
  }
}

console.log(`🔎 Identificação de pagador em extratos — modo: ${APLICAR ? 'APLICAR' : 'DRY-RUN'}${REPROCESSAR ? ' + REPROCESSAR' : ''}`);
EMPRESAS.forEach(processar);
console.log('\n✔️  Concluído.');
