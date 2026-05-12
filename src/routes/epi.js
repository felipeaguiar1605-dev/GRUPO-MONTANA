/**
 * Montana Multi-Empresa — Rotas /api/epi/*
 *
 * Wrappers leves sobre estoque_ficha_epi + estoque_itens. O frontend
 * (loadEPIRelatorio em app-extras.js) chama /api/epi/relatorio diretamente,
 * sem passar por /api/estoque/*. Mantém-se compatibilidade exposta nesse path.
 */
'use strict';

const express = require('express');
const router  = express.Router();
const companyMw = require('../companyMiddleware');
router.use(companyMw);

async function tabelasExistem(db) {
  const r = await db.prepare(`
    SELECT COUNT(*)::int n FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name IN ('estoque_ficha_epi', 'estoque_itens')
  `).get();
  return r && r.n >= 2;
}

// GET /api/epi/relatorio
// Resumo agregado de EPIs/Uniformes em uso × devolvidos × custo total.
router.get('/relatorio', async (req, res) => {
  try {
    const db = req.db;
    if (!(await tabelasExistem(db))) {
      return res.json({ por_item: [], total_custo: 0, message: 'Módulo Estoque não inicializado nesta empresa.' });
    }

    const rowsRaw = await db.prepare(`
      SELECT
        i.nome      AS nome_item,
        i.categoria AS tipo,
        COUNT(*) FILTER (WHERE COALESCE(f.data_devolucao,'') = '') AS em_uso,
        COUNT(*) FILTER (WHERE COALESCE(f.data_devolucao,'') <> '') AS devolvidos,
        COALESCE(SUM(f.quantidade * COALESCE(i.valor_unitario, 0))
                 FILTER (WHERE COALESCE(f.data_devolucao,'') = ''), 0) AS custo_total
      FROM estoque_ficha_epi f
      JOIN estoque_itens i ON i.id = f.item_id
      WHERE UPPER(COALESCE(i.categoria,'')) IN ('EPI','UNIFORME','EQUIPAMENTO')
      GROUP BY i.nome, i.categoria
      ORDER BY custo_total DESC
    `).all();
    const rows = Array.isArray(rowsRaw) ? rowsRaw : [];

    const por_item = rows.map(r => ({
      nome_item:   r.nome_item,
      tipo:        r.tipo,
      em_uso:      r.em_uso || 0,
      devolvidos:  r.devolvidos || 0,
      custo_total: +(+r.custo_total).toFixed(2),
    }));
    const total_custo = por_item.reduce((s, r) => s + r.custo_total, 0);

    res.json({ por_item, total_custo: +total_custo.toFixed(2) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/epi/entregar
// Wrapper sobre estoque_ficha_epi (registrar entrega individual). Aceita
// tanto nome_item (cria/reusa item de estoque) quanto item_id direto.
router.post('/entregar', async (req, res) => {
  try {
    const db = req.db;
    const { funcionario_id, nome_item, tipo, valor, tamanho, obs, contrato_ref, posto } = req.body || {};
    if (!funcionario_id || !nome_item) {
      return res.status(400).json({ error: 'funcionario_id e nome_item obrigatórios' });
    }

    // Resolve nome do funcionário (para snapshot histórico em estoque_ficha_epi)
    let funcionarioNome = req.body.funcionario_nome || null;
    if (!funcionarioNome) {
      try {
        const f = await db.prepare(`SELECT nome FROM rh_funcionarios WHERE id = ?`).get(funcionario_id);
        if (f && f.nome) funcionarioNome = f.nome;
      } catch (_) {}
    }
    if (!funcionarioNome) funcionarioNome = `Funcionário #${funcionario_id}`;

    // Busca/cria item em estoque_itens
    let item = await db.prepare(`
      SELECT * FROM estoque_itens WHERE LOWER(nome) = LOWER(?) LIMIT 1
    `).get(nome_item);

    if (!item) {
      const cat = (tipo || 'EPI').toUpperCase();
      const ins = await db.prepare(`
        INSERT INTO estoque_itens (nome, categoria, unidade, valor_unitario, estoque_atual, ativo)
        VALUES (?, ?, 'UN', ?, 0, 1)
        RETURNING *
      `).get(nome_item, cat, parseFloat(valor) || 0);
      item = ins;
    }

    const dataEntrega = new Date().toISOString().slice(0, 10);
    await db.prepare(`
      INSERT INTO estoque_ficha_epi
        (funcionario_id, funcionario_nome, item_id, quantidade, tamanho,
         data_entrega, contrato_ref, posto, obs)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(funcionario_id, funcionarioNome, item.id, tamanho || null,
           dataEntrega, contrato_ref || null, posto || null, obs || null);

    res.json({ ok: true, item_id: item.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
