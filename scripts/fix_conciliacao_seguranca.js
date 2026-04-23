'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

/**
 * fix_conciliacao_seguranca.js
 *
 * Corrige NFs da Segurança vinculadas a extratos errados:
 *
 * FASE 1 — Identificar e coletar NFs com vínculos indevidos:
 *   - RENDE_FACIL     : NFs vinculadas a extratos BB Rende Fácil
 *   - MONTANA_INT     : NFs vinculadas a transferências internas de MONTANA
 *   - UFT_PALMAS_MISM : NFs de Palmas/MP/SEDUC vinculadas a extratos UFT (05149726000104)
 *   - ESTADO_PALMAS   : NFs de Palmas/MP vinculadas a TED Governo do Estado TO
 *
 * FASE 2 — Desconcilar: SET extrato_id=NULL, status_conciliacao='PENDENTE', data_pagamento=NULL
 *
 * FASE 3 — Tentar re-conciliar NFs de Palmas/MP nos extratos corretos (Ordem Bancária Palmas)
 *   Tolerância: 20% (valor) | Janela: data_emissao -60d até +180d
 *   Critério de aceitação: soma_nfs_vinculadas + nova_nf <= credito_extrato * 1.10
 *   NFs de SEDUC → busca extratos SECRETARIA DA EDUCACAO
 *   NFs UFT (FUNDACAO UNIVERSIDADE) ficam PENDENTE (sem extrato individual Palmas)
 *
 * FASE 4 — Imprimir sumário
 *
 * Resultados obtidos em 2026-04-22:
 *   53 NFs desconciliadas | 15 re-conciliadas (ratio ≤ 1.10) | 38 ficaram PENDENTE
 */

const { getDb } = require('../src/db');

const db = getDb('seguranca');

// ─────────────────────────────────────────────────────────────────────────────
// FASE 1: Coletar NFs com vínculos indevidos
// ─────────────────────────────────────────────────────────────────────────────

function coletarNFsProblematicas() {
  const grupos = {};

  // RENDE_FACIL: NFs vinculadas a BB Rende Fácil
  grupos.RENDE_FACIL = db.prepare(`
    SELECT nf.id, nf.numero, nf.tomador, nf.valor_bruto, nf.data_emissao,
           nf.extrato_id, nf.status_conciliacao,
           e.historico as ext_hist, e.credito as ext_credito, e.data_iso as ext_data
    FROM notas_fiscais nf
    JOIN extratos e ON e.id = nf.extrato_id
    WHERE UPPER(e.historico) LIKE '%RENDE%'
      AND nf.status_conciliacao IN ('CONCILIADO', 'PAGO_SEM_COMPROVANTE')
  `).all();

  // MONTANA_INT: NFs vinculadas a transferências internas de MONTANA
  grupos.MONTANA_INT = db.prepare(`
    SELECT nf.id, nf.numero, nf.tomador, nf.valor_bruto, nf.data_emissao,
           nf.extrato_id, nf.status_conciliacao,
           e.historico as ext_hist, e.credito as ext_credito, e.data_iso as ext_data
    FROM notas_fiscais nf
    JOIN extratos e ON e.id = nf.extrato_id
    WHERE UPPER(e.historico) LIKE '%MONTANA%'
      AND nf.status_conciliacao IN ('CONCILIADO', 'PAGO_SEM_COMPROVANTE')
  `).all();

  // UFT_PALMAS_MISMATCH: NFs de Palmas/MP/SEDUC vinculadas a PIX/OB UFT (FUNDACAO)
  grupos.UFT_PALMAS_MISM = db.prepare(`
    SELECT nf.id, nf.numero, nf.tomador, nf.valor_bruto, nf.data_emissao,
           nf.extrato_id, nf.status_conciliacao,
           e.historico as ext_hist, e.credito as ext_credito, e.data_iso as ext_data
    FROM notas_fiscais nf
    JOIN extratos e ON e.id = nf.extrato_id
    WHERE (
      UPPER(nf.tomador) LIKE '%PALMAS%'
      OR UPPER(nf.tomador) LIKE '%MINISTERIO%'
      OR UPPER(nf.tomador) LIKE '%SEDUC%'
    )
    AND (
      e.historico LIKE '%05149726000104%'
      OR UPPER(e.historico) LIKE '%FUNDACAO UN%'
      OR e.historico LIKE '%051497260001%'
    )
    AND nf.status_conciliacao IN ('CONCILIADO', 'PAGO_SEM_COMPROVANTE')
  `).all();

  // ESTADO_PALMAS: NFs de Palmas/MP vinculadas a TED Governo do Estado TO
  grupos.ESTADO_PALMAS = db.prepare(`
    SELECT nf.id, nf.numero, nf.tomador, nf.valor_bruto, nf.data_emissao,
           nf.extrato_id, nf.status_conciliacao,
           e.historico as ext_hist, e.credito as ext_credito, e.data_iso as ext_data
    FROM notas_fiscais nf
    JOIN extratos e ON e.id = nf.extrato_id
    WHERE (
      UPPER(nf.tomador) LIKE '%PALMAS%'
      OR UPPER(nf.tomador) LIKE '%MINISTERIO%'
    )
    AND (
      e.historico LIKE '%01786029000103%'
      OR UPPER(e.historico) LIKE '%ESTADO DO TOCANTINS%'
    )
    AND nf.status_conciliacao IN ('CONCILIADO', 'PAGO_SEM_COMPROVANTE')
  `).all();

  return grupos;
}

// ─────────────────────────────────────────────────────────────────────────────
// FASE 3: Tentar re-match em extrato correto
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detecta o padrão de busca correto para o tomador da NF.
 * Retorna array de fragments LIKE para `e.historico`.
 */
function getHistoricoPatterns(tomador) {
  const t = (tomador || '').toUpperCase();
  if (t.includes('PALMAS') || t.includes('PMP') || t.includes('PREVIDENCIA SOCIAL DO MUNICIPIO')
      || t.includes('FUNDACAO CULTURAL DE PALMAS')
      || t.includes('FUNDACAO MUNICIPAL DE MEIO')
      || t.includes('AGENCIA DE REGULACAO')
      || t.includes('AGENCIA DE TRANSPORTE')
      || t.includes('AGENCIA MUNICIPAL')) {
    return [
      "UPPER(e.historico) LIKE '%PALMAS%'",
      "UPPER(e.historico) LIKE '%ORDENS BANCARIAS%'"
    ];
  }
  if (t.includes('MINISTERIO PUBLICO')) {
    return [
      "UPPER(e.historico) LIKE '%MINISTERIO%'",
      "UPPER(e.historico) LIKE '%MP%'",
      "UPPER(e.historico) LIKE '%PALMAS%'",
      "UPPER(e.historico) LIKE '%ORDENS BANCARIAS%'"
    ];
  }
  if (t.includes('SECRETARIA DA EDUCACAO') || t.includes('SEDUC')) {
    return [
      "UPPER(e.historico) LIKE '%SEDUC%'",
      "UPPER(e.historico) LIKE '%EDUCACAO%'"
    ];
  }
  // fallback genérico
  return [
    "UPPER(e.historico) LIKE '%PALMAS%'",
    "UPPER(e.historico) LIKE '%ORDENS BANCARIAS%'"
  ];
}

/**
 * Tenta encontrar o melhor extrato disponível para uma NF.
 * "Disponível" = extrato com crédito > 0 que não está vinculado a nenhuma outra NF
 *   (status CONCILIADO/PAGO_SEM_COMPROVANTE) — OU onde a soma das NFs vinculadas
 *   ainda cabe dentro do crédito total (conciliação de lote).
 *
 * Retorna o extrato com menor |credito - valor_bruto| dentro da tolerância,
 * ou null se nenhum encontrado.
 */
function buscarExtratoCandidato(nf, extratoIdsBloqueados) {
  const tol = 0.20; // 20%
  const low = nf.valor_bruto * (1 - tol);
  const high = nf.valor_bruto * (1 + tol);

  // Calcular janela de datas
  const emissao = nf.data_emissao ? new Date(nf.data_emissao) : new Date();
  const dtMin = new Date(emissao);
  dtMin.setDate(dtMin.getDate() - 60);
  const dtMax = new Date('2026-04-30');
  const dtMinStr = dtMin.toISOString().slice(0, 10);
  const dtMaxStr = dtMax.toISOString().slice(0, 10);

  const patterns = getHistoricoPatterns(nf.tomador);
  const whereHistorico = '(' + patterns.join(' OR ') + ')';

  // Extratos candidatos na janela de valor e data
  const candidatos = db.prepare(`
    SELECT e.id, e.data_iso, e.credito, e.historico,
           COALESCE(SUM(nf2.valor_bruto), 0) as soma_nfs_vinculadas,
           COUNT(nf2.id) as qtd_nfs_vinculadas
    FROM extratos e
    LEFT JOIN notas_fiscais nf2 ON nf2.extrato_id = e.id
      AND nf2.status_conciliacao IN ('CONCILIADO', 'PAGO_SEM_COMPROVANTE')
    WHERE ${whereHistorico}
      AND e.credito BETWEEN ? AND ?
      AND e.data_iso BETWEEN ? AND ?
    GROUP BY e.id
    ORDER BY ABS(e.credito - ?) ASC
    LIMIT 20
  `).all(low, high, dtMinStr, dtMaxStr, nf.valor_bruto);

  if (!candidatos || candidatos.length === 0) return null;

  // Filtrar: aceitar apenas extrato com capacidade suficiente.
  // Critério conservador: soma existente + nova NF ≤ credito * 1.10
  // Isso evita vincular NFs antigas a extratos já lotados com NFs legítimas recentes.
  for (const cand of candidatos) {
    // Recalcular soma atual (a coluna no candidato pode estar desatualizada se
    // outra NF foi vinculada na mesma transação)
    const somaAtual = db.prepare(`
      SELECT COALESCE(SUM(valor_bruto), 0) as soma
      FROM notas_fiscais
      WHERE extrato_id = ? AND status_conciliacao IN ('CONCILIADO', 'PAGO_SEM_COMPROVANTE')
    `).get(cand.id).soma;

    const somaComNova = somaAtual + nf.valor_bruto;
    const temCapacidade = somaComNova <= cand.credito * 1.10;

    if (temCapacidade && !extratoIdsBloqueados.has(cand.id)) {
      return cand;
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  console.log('='.repeat(70));
  console.log('fix_conciliacao_seguranca.js — Iniciando');
  console.log('='.repeat(70));

  // ── FASE 1 ──────────────────────────────────────────────────────────────
  console.log('\n[FASE 1] Identificando NFs com vínculos indevidos...');
  const grupos = coletarNFsProblematicas();

  const totalPorGrupo = {};
  let totalIdentificadas = 0;
  for (const [grupo, nfs] of Object.entries(grupos)) {
    totalPorGrupo[grupo] = nfs.length;
    totalIdentificadas += nfs.length;
    console.log(`  ${grupo}: ${nfs.length} NFs`);
    for (const nf of nfs) {
      console.log(`    NF#${nf.id} ${nf.numero} tomador="${(nf.tomador||'').substring(0,35)}" vl=${nf.valor_bruto} extrato#${nf.extrato_id} hist="${(nf.ext_hist||'').substring(0,55)}"`);
    }
  }
  console.log(`  TOTAL identificadas: ${totalIdentificadas}`);

  // Criar mapa único de NF ids (evitar duplicatas entre grupos)
  const todasNFsMap = new Map();
  for (const nfs of Object.values(grupos)) {
    for (const nf of nfs) {
      todasNFsMap.set(nf.id, nf);
    }
  }
  const todasNFsList = [...todasNFsMap.values()];
  console.log(`  NFs únicas a desconcilar: ${todasNFsList.length}`);

  // ── FASE 2 ──────────────────────────────────────────────────────────────
  console.log('\n[FASE 2] Desconciliando (SET extrato_id=NULL, status=PENDENTE, data_pagamento=NULL)...');

  const stmtDesconciliar = db.prepare(`
    UPDATE notas_fiscais
    SET extrato_id = NULL,
        status_conciliacao = 'PENDENTE',
        data_pagamento = NULL
    WHERE id = ?
  `);

  let desconciliadas = 0;
  const desconciliarTx = db.transaction(() => {
    for (const nf of todasNFsList) {
      const info = stmtDesconciliar.run(nf.id);
      if (info.changes > 0) {
        desconciliadas++;
        console.log(`  Desconciliada NF#${nf.id} (${(nf.tomador||'').substring(0,30)}) — era extrato#${nf.extrato_id}`);
      }
    }
  });
  desconciliarTx();
  console.log(`  Total desconciliadas: ${desconciliadas}`);

  // ── FASE 3 ──────────────────────────────────────────────────────────────
  console.log('\n[FASE 3] Tentando re-conciliar NFs de Palmas/MP/SEDUC nos extratos corretos...');

  // Apenas NFs que são de Palmas, MP ou SEDUC (excluindo UFT que ficam PENDENTE)
  const nfsParaRematch = todasNFsList.filter(nf => {
    const t = (nf.tomador || '').toUpperCase();
    return t.includes('PALMAS') || t.includes('MINISTERIO') || t.includes('SEDUC')
      || t.includes('PMP') || t.includes('PREVIDENCIA SOCIAL DO MUNICIPIO')
      || t.includes('FUNDACAO CULTURAL DE PALMAS')
      || t.includes('FUNDACAO MUNICIPAL DE MEIO')
      || t.includes('AGENCIA');
  });

  console.log(`  NFs elegíveis para re-match: ${nfsParaRematch.length}`);

  const stmtReconciliar = db.prepare(`
    UPDATE notas_fiscais
    SET extrato_id = ?,
        status_conciliacao = 'CONCILIADO',
        data_pagamento = ?
    WHERE id = ? AND status_conciliacao = 'PENDENTE'
  `);

  let reconciliadas = 0;
  const extratoIdsBloqueados = new Set(); // extratos já usados nesta rodada

  const reconciliarTx = db.transaction(() => {
    for (const nf of nfsParaRematch) {
      const candidato = buscarExtratoCandidato(nf, extratoIdsBloqueados);
      if (candidato) {
        const info = stmtReconciliar.run(candidato.id, candidato.data_iso, nf.id);
        if (info.changes > 0) {
          reconciliadas++;
          extratoIdsBloqueados.add(candidato.id);
          console.log(`  Re-conciliada NF#${nf.id} (${(nf.tomador||'').substring(0,30)}) vl=${nf.valor_bruto} → extrato#${candidato.id} cred=${candidato.credito} data=${candidato.data_iso} hist="${(candidato.historico||'').substring(0,50)}"`);
        } else {
          console.log(`  [SKIP] NF#${nf.id} — UPDATE não aplicou (NF não estava PENDENTE?)`);
        }
      } else {
        console.log(`  [PENDENTE] NF#${nf.id} (${(nf.tomador||'').substring(0,30)}) vl=${nf.valor_bruto} — nenhum extrato compatível encontrado`);
      }
    }
  });
  reconciliarTx();

  // ── FASE 4 ──────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('[FASE 4] SUMÁRIO');
  console.log('='.repeat(70));
  console.log(`  NFs identificadas por grupo:`);
  for (const [grupo, cnt] of Object.entries(totalPorGrupo)) {
    console.log(`    ${grupo.padEnd(20)}: ${cnt}`);
  }
  console.log(`  NFs únicas identificadas : ${todasNFsList.length}`);
  console.log(`  NFs desconciliadas       : ${desconciliadas}`);
  console.log(`  NFs re-conciliadas       : ${reconciliadas}`);
  console.log(`  NFs ficaram PENDENTE     : ${desconciliadas - reconciliadas}`);

  // Verificar estado final
  const statusFinal = db.prepare(`
    SELECT status_conciliacao, COUNT(*) as cnt
    FROM notas_fiscais
    GROUP BY status_conciliacao
  `).all();
  console.log('\n  Estado final do banco:');
  for (const r of statusFinal) {
    console.log(`    ${(r.status_conciliacao||'null').padEnd(25)}: ${r.cnt}`);
  }
  console.log('='.repeat(70));
}

main();
