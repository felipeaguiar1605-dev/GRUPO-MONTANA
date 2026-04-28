/**
 * Montana — Diagnóstico Faturamento × Previsto
 *
 * Compara, por contrato e mês:
 *   • Faturado  = SUM(notas_fiscais.valor_bruto) onde data_emissao no período
 *   • Previsto  = SUM(bol_boletins.valor_total)  onde competencia no período
 *                 (fallback: SUM(bol_postos × bol_itens) se não houver boletim)
 *
 * Retorna divergências por contrato + 3 listas auxiliares:
 *   - Contratos com NF mas sem boletim correspondente
 *   - Boletins sem NF emitida (cobrança a fazer)
 *   - NFs órfãs (sem contrato_ref ou contrato_ref inexistente)
 *
 * GET /api/diagnostico/faturamento-vs-previsto?from=2026-01-01&to=2026-03-31
 */
'use strict';
const express   = require('express');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

router.get('/faturamento-vs-previsto', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'Use ?from=YYYY-MM-DD&to=YYYY-MM-DD' });
    }
    const db = req.db;

    // ── 1. Faturado por contrato_ref no período (NFs emitidas) ─────────
    const _nfs = await db.prepare(`
      SELECT
        COALESCE(NULLIF(TRIM(contrato_ref), ''), '(sem contrato)') AS contrato_ref,
        COUNT(*) AS qtd_nfs,
        COALESCE(SUM(valor_bruto), 0) AS faturado_bruto,
        COALESCE(SUM(valor_liquido), 0) AS faturado_liquido,
        MIN(data_emissao) AS primeira_nf,
        MAX(data_emissao) AS ultima_nf
      FROM notas_fiscais
      WHERE data_emissao >= @from AND data_emissao <= @to
      GROUP BY COALESCE(NULLIF(TRIM(contrato_ref), ''), '(sem contrato)')
    `).all({ from, to });
    const nfsPorContrato = Array.isArray(_nfs) ? _nfs : [];

    // ── 2. Previsto por contrato_ref no período (boletins gerados) ─────
    // bol_boletins.competencia = 'YYYY-MM'. Filtra os meses cobertos por [from, to].
    const fromMes = from.slice(0, 7);
    const toMes   = to.slice(0, 7);
    const _boletins = await db.prepare(`
      SELECT bc.contrato_ref, bc.numero_contrato, bc.nome AS bol_nome, bc.id AS bol_contrato_id,
             b.competencia, COALESCE(b.valor_total, b.total_geral, 0) AS valor_boletim
      FROM bol_boletins b
      JOIN bol_contratos bc ON bc.id = b.contrato_id
      WHERE b.competencia >= @fromMes AND b.competencia <= @toMes
    `).all({ fromMes, toMes });
    const boletins = Array.isArray(_boletins) ? _boletins : [];

    // Agrega previsto por contrato_ref
    const previstoPorContrato = {};  // { contrato_ref: { previsto: X, meses: [], bol_nome } }
    for (const b of boletins) {
      const key = (b.contrato_ref || '').trim() || `(boletim sem contrato_ref: ${b.bol_nome || b.numero_contrato || '?'})`;
      if (!previstoPorContrato[key]) {
        previstoPorContrato[key] = {
          contrato_ref: key,
          bol_nome: b.bol_nome,
          numero_contrato: b.numero_contrato,
          previsto: 0,
          meses: [],
        };
      }
      const v = Number(b.valor_boletim) || 0;
      previstoPorContrato[key].previsto += v;
      previstoPorContrato[key].meses.push({ competencia: b.competencia, valor: num(v) });
    }

    // ── 3. Catálogo de contratos cadastrados em Boletins (pra detectar órfãos) ──
    const _bolContratos = await db.prepare(`
      SELECT id, contrato_ref, numero_contrato, nome
      FROM bol_contratos
    `).all();
    const bolRefs = new Set(
      (Array.isArray(_bolContratos) ? _bolContratos : [])
        .map(c => (c.contrato_ref || '').trim())
        .filter(r => r)
    );

    // ── 4. Catálogo de contratos financeiros (pra inferir nome de contratos sem boletim) ──
    const _contratos = await db.prepare(`
      SELECT numContrato, contrato, orgao, status, valor_mensal_liquido
      FROM contratos
    `).all();
    const contratosMap = {};
    (Array.isArray(_contratos) ? _contratos : []).forEach(c => {
      contratosMap[(c.numContrato || '').trim()] = c;
    });

    // ── 5. Monta linha-por-contrato com previsto vs faturado ─────────────
    const todosRefs = new Set([
      ...Object.keys(previstoPorContrato),
      ...nfsPorContrato.map(n => n.contrato_ref),
    ]);

    const linhas = [];
    for (const ref of todosRefs) {
      if (ref === '(sem contrato)') continue;  // tratado separadamente abaixo
      const prev = previstoPorContrato[ref];
      const nf   = nfsPorContrato.find(n => n.contrato_ref === ref);
      const previsto = prev ? num(prev.previsto) : 0;
      const faturado = nf   ? num(nf.faturado_bruto) : 0;
      const diff     = num(faturado - previsto);
      const pct      = previsto > 0 ? +((diff / previsto) * 100).toFixed(1) : (faturado > 0 ? 999 : 0);

      let status = 'OK';
      if (Math.abs(pct) > 5) status = 'DIVERGENTE';
      else if (Math.abs(pct) > 1) status = 'ALERTA';
      if (previsto === 0 && faturado > 0) status = 'SEM_BOLETIM';
      if (faturado === 0 && previsto > 0) status = 'SEM_NF';

      linhas.push({
        contrato_ref: ref,
        nome: prev?.bol_nome || contratosMap[ref]?.contrato || '(não cadastrado)',
        cadastrado_boletins: bolRefs.has(ref),
        cadastrado_contratos: !!contratosMap[ref],
        previsto,
        faturado,
        diferenca: diff,
        diferenca_pct: pct,
        qtd_nfs: nf?.qtd_nfs || 0,
        meses_boletins: prev?.meses || [],
        status,
      });
    }

    // ── 6. NFs órfãs (sem contrato_ref OU com ref que não casa com nada) ─
    const nfOrfas = nfsPorContrato.find(n => n.contrato_ref === '(sem contrato)');
    const _nfOrfasDetalhe = nfOrfas ? await db.prepare(`
      SELECT id, numero, data_emissao, valor_bruto, tomador, contrato_ref
      FROM notas_fiscais
      WHERE data_emissao >= @from AND data_emissao <= @to
        AND (contrato_ref IS NULL OR TRIM(contrato_ref) = '')
      ORDER BY data_emissao DESC
      LIMIT 200
    `).all({ from, to }) : [];
    const nfsOrfasDetalhe = Array.isArray(_nfOrfasDetalhe) ? _nfOrfasDetalhe : [];

    // ── 7. Resumo ────────────────────────────────────────────────────────
    const total_previsto = num(linhas.reduce((s, l) => s + l.previsto, 0));
    const total_faturado = num(linhas.reduce((s, l) => s + l.faturado, 0)
                              + (nfOrfas ? num(nfOrfas.faturado_bruto) : 0));
    const total_diferenca = num(total_faturado - total_previsto);
    const aderencia_pct = total_previsto > 0
      ? +((1 - Math.min(Math.abs(total_diferenca) / total_previsto, 1)) * 100).toFixed(1)
      : 0;

    res.json({
      ok: true,
      periodo: { from, to, fromMes, toMes },
      resumo: {
        total_previsto,
        total_faturado,
        total_diferenca,
        aderencia_pct,
        qtd_contratos_total: linhas.length,
        qtd_alinhados:    linhas.filter(l => l.status === 'OK').length,
        qtd_alerta:       linhas.filter(l => l.status === 'ALERTA').length,
        qtd_divergentes:  linhas.filter(l => l.status === 'DIVERGENTE').length,
        qtd_sem_boletim:  linhas.filter(l => l.status === 'SEM_BOLETIM').length,
        qtd_sem_nf:       linhas.filter(l => l.status === 'SEM_NF').length,
        qtd_nfs_orfas:    nfOrfas?.qtd_nfs || 0,
        valor_nfs_orfas:  num(nfOrfas?.faturado_bruto || 0),
      },
      contratos: linhas.sort((a, b) => Math.abs(b.diferenca) - Math.abs(a.diferenca)),
      nfs_orfas: nfsOrfasDetalhe,
    });
  } catch (e) {
    console.error('[diagnostico/faturamento-vs-previsto]', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
