/**
 * Montana - Rotas /api/transparencia/mpto/*
 * Consulta, coleta e reconcilia dados do MP-TO (portal Athenas).
 */
const express = require('express');
const mpto = require('../adapters/mpto');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

// GET /status
router.get('/status', async (req, res) => {
  try {
    const meses = await mpto.mesesDisponiveis();
    res.json({
      ok: true,
      portal: 'Athenas - MP-TO',
      url_base: mpto.BASE,
      meses_disponiveis: meses.length,
      amostra: meses.slice(0, 5),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /empenhos?cnpj=19200109000109
router.get('/empenhos', async (req, res) => {
  const cnpj = (req.query.cnpj || '').replace(/\D/g, '');
  if (!cnpj) return res.status(400).json({ error: 'Parametro ?cnpj= obrigatorio' });
  try {
    const empenhos = await mpto.empenhosPorFavorecido(cnpj, 1000);
    const total_empenhado = empenhos.reduce((s, e) => s + (e.pledged_value || 0), 0);
    const total_pago = empenhos.reduce((s, e) => s + (e.amount_paid_until_month || 0), 0);
    res.json({
      cnpj,
      total_registros: empenhos.length,
      total_empenhado: Number(total_empenhado.toFixed(2)),
      total_pago_acumulado: Number(total_pago.toFixed(2)),
      saldo_empenhado: Number((total_empenhado - total_pago).toFixed(2)),
      data: empenhos.map(e => mpto.normalizar(e, req.companyKey)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /coletar body: { cnpj: "..." }
router.post('/coletar', async (req, res) => {
  const cnpj = (req.body && req.body.cnpj ? req.body.cnpj : '').replace(/\D/g, '');
  if (!cnpj) return res.status(400).json({ error: 'cnpj obrigatorio no body' });

  const inicio = Date.now();
  try {
    const empenhos = await mpto.empenhosPorFavorecido(cnpj, 2000);
    const items = empenhos.map(e => mpto.normalizar(e, req.companyKey));

    const stmt = req.db.prepare(`
      INSERT INTO transparencia_pagamentos (
        fonte_portal, empresa_key, numero_empenho, processo,
        data_empenho, valor_empenhado, valor_pago, valor_pago_mes,
        fornecedor_nome, fornecedor_cnpj,
        gestao, gestao_codigo, mes, ano,
        tipo_licitacao, modalidade, objeto, raw_json, status_match,
        coletado_em, atualizado_em
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente',
                datetime('now','localtime'), datetime('now','localtime'))
    `);

    let salvos = 0;
    const trans = req.db.transaction(async (list) => {
      for (const it of list) {
        const r = stmt.run(
          it.fonte_portal || 'athenas-mpto',
          it.empresa_key || 'seguranca',
          it.numero_empenho || '',
          it.processo || '',
          it.data_empenho || null,
          it.valor_empenhado || 0,
          it.valor_pago || 0,
          it.valor_pago_mes || 0,
          it.fornecedor_nome || '',
          it.fornecedor_cnpj || '',
          it.gestao || '',
          it.gestao_codigo || '',
          it.mes || 0,
          it.ano || 0,
          it.tipo_licitacao || '',
          it.modalidade || '',
          it.objeto || '',
          it.raw_json || '{}'
        );
        if (r.changes > 0) salvos++;
      }
    });
    trans(items);

    await req.db.prepare(`
      INSERT INTO transparencia_coletas (filtros_json, total_retornado, novos, duracao_ms)
      VALUES (?, ?, ?, ?)
    `).run(JSON.stringify({ cnpj }), empenhos.length, salvos, Date.now() - inicio);

    res.json({ ok: true, coletados: empenhos.length, salvos, duracao_ms: Date.now() - inicio });
  } catch (e) {
    console.error('[mpto/coletar]', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /resumo
router.get('/resumo', async (req, res) => {
  try {
    const rows = await req.db.prepare(`
      SELECT ano, mes,
             COUNT(*) as qtd,
             ROUND(SUM(valor_empenhado), 2) as empenhado,
             ROUND(SUM(valor_pago), 2) as pago
      FROM transparencia_pagamentos
      WHERE fonte_portal = 'athenas-mpto'
      GROUP BY ano, mes
      ORDER BY ano DESC, mes DESC
    `).all();
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /reconciliar?cnpj=...
router.get('/reconciliar', async (req, res) => {
  const cnpj = (req.query.cnpj || '').replace(/\D/g, '');
  try {
    const empenhosPorMes = await req.db.prepare(`
      SELECT ano, mes,
             COUNT(*) as qtd,
             ROUND(SUM(valor_empenhado), 2) as empenhado,
             ROUND(SUM(valor_pago), 2) as pago
      FROM transparencia_pagamentos
      WHERE fonte_portal = 'athenas-mpto'
      ${cnpj ? 'AND fornecedor_cnpj = ?' : ''}
      GROUP BY ano, mes
      ORDER BY ano, mes
    `).all(...(cnpj ? [cnpj] : []));

    const nfsPorMes = await req.db.prepare(`
      SELECT substr(data_emissao,1,7) as mes,
             COUNT(*) as qtd,
             ROUND(SUM(valor_bruto), 2) as bruto,
             ROUND(SUM(valor_liquido), 2) as liq
      FROM notas_fiscais
      WHERE (tomador LIKE '%MINIST%'
         OR cnpj_tomador LIKE '%01786078%'
         OR cnpj_tomador LIKE '%01.786.078%')
      AND data_emissao >= '2025-01-01'
      GROUP BY mes
    `).all();

    const mpMap = {};
    empenhosPorMes.forEach(e => {
      const k = e.ano + '-' + String(e.mes).padStart(2, '0');
      mpMap[k] = e;
    });
    const nfMap = {};
    nfsPorMes.forEach(n => { nfMap[n.mes] = n; });

    const meses = [...new Set([...Object.keys(mpMap), ...Object.keys(nfMap)])].sort();
    const comparativo = meses.map(mes => {
      const mp = mpMap[mes] || { qtd: 0, empenhado: 0, pago: 0 };
      const nf = nfMap[mes] || { qtd: 0, bruto: 0, liq: 0 };
      return {
        mes,
        mp_empenhos: mp.qtd,
        mp_empenhado: mp.empenhado,
        mp_pago_acumulado: mp.pago,
        nf_qtd: nf.qtd,
        nf_valor_bruto: nf.bruto,
        nf_valor_liquido: nf.liq,
        dif_emp_nf: Number((mp.empenhado - nf.bruto).toFixed(2)),
      };
    });

    const totalEmp = empenhosPorMes.reduce((s, e) => s + (e.empenhado || 0), 0);
    const totalPago = empenhosPorMes.reduce((s, e) => s + (e.pago || 0), 0);
    const totalNfBruto = nfsPorMes.reduce((s, n) => s + (n.bruto || 0), 0);

    res.json({
      cnpj,
      totais: {
        mp_total_empenhado: Number(totalEmp.toFixed(2)),
        mp_total_pago: Number(totalPago.toFixed(2)),
        nf_total_bruto: Number(totalNfBruto.toFixed(2)),
        diferenca_mp_nf: Number((totalEmp - totalNfBruto).toFixed(2)),
      },
      comparativo_mensal: comparativo,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
