const express = require('express');
const router = express.Router();
const db = require('../../config/database');

// GET / - Listar comissoes com filtros e paginacao
router.get('/', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;
    const { vendedor_id, status, date_from, date_to } = req.query;

    let whereClauses = ['c.empresa_id = ?'];
    const params = [empresaId];

    if (vendedor_id) {
        whereClauses.push('c.vendedor_id = ?');
        params.push(vendedor_id);
    }
    if (status) {
        whereClauses.push('c.status = ?');
        params.push(status);
    }
    if (date_from) {
        whereClauses.push('c.created_at >= ?');
        params.push(date_from);
    }
    if (date_to) {
        whereClauses.push('c.created_at <= ?');
        params.push(date_to + ' 23:59:59');
    }

    const whereSQL = whereClauses.join(' AND ');

    let comissoes = [];
    let total = 0;
    try {
        const countRow = db.prepare(`
            SELECT COUNT(*) AS total
            FROM comissoes c
            WHERE ${whereSQL}
        `).get(...params);
        total = countRow ? countRow.total : 0;
    } catch (e) {
        total = 0;
    }
    const totalPages = Math.ceil(total / limit) || 1;

    try {
        comissoes = db.prepare(`
            SELECT c.*, vd.nome AS vendedor_nome, v.numero AS venda_numero, v.total AS venda_total
            FROM comissoes c
            JOIN vendedores vd ON vd.id = c.vendedor_id
            JOIN vendas v ON v.id = c.venda_id
            WHERE ${whereSQL}
            ORDER BY c.created_at DESC
            LIMIT ? OFFSET ?
        `).all(...params, limit, offset);
    } catch (e) {
        comissoes = [];
    }

    // Load vendedores for filter
    let vendedores = [];
    try {
        vendedores = db.prepare('SELECT id, nome FROM vendedores WHERE empresa_id = ? AND ativo = 1 ORDER BY nome').all(empresaId);
    } catch (e) {
        vendedores = [];
    }

    // Summary totals (across all matching records, not just current page)
    let totalPendente = 0;
    let totalPaga = 0;
    try {
        const sumRow = db.prepare(`
            SELECT
                COALESCE(SUM(CASE WHEN c.status = 'pendente' THEN c.valor ELSE 0 END), 0) AS totalPendente,
                COALESCE(SUM(CASE WHEN c.status = 'paga' THEN c.valor ELSE 0 END), 0) AS totalPaga
            FROM comissoes c
            WHERE ${whereSQL}
        `).get(...params);
        totalPendente = sumRow.totalPendente;
        totalPaga = sumRow.totalPaga;
    } catch (e) { /* ignore */ }

    // Group by vendedor for batch pay (pending only, across all records)
    const pendentePorVendedor = {};
    try {
        const pendentes = db.prepare(`
            SELECT c.vendedor_id, vd.nome AS vendedor_nome, SUM(c.valor) AS total, COUNT(*) AS count
            FROM comissoes c
            JOIN vendedores vd ON vd.id = c.vendedor_id
            WHERE c.empresa_id = ? AND c.status = 'pendente'
            GROUP BY c.vendedor_id
        `).all(empresaId);
        for (const row of pendentes) {
            pendentePorVendedor[row.vendedor_id] = {
                vendedor_nome: row.vendedor_nome,
                total: row.total,
                count: row.count
            };
        }
    } catch (e) { /* ignore */ }

    res.render('comissoes/index', {
        title: 'Comissoes',
        comissoes,
        vendedores,
        filtros: { vendedor_id: vendedor_id || '', status: status || '', date_from: date_from || '', date_to: date_to || '' },
        totalPendente,
        totalPaga,
        pendentePorVendedor,
        pagination: { page, totalPages, total },
        mensagem: req.query.mensagem || null,
        erro: req.query.erro || null
    });
});

// POST /pagar/:id - Marcar comissão individual como paga
router.post('/pagar/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;

    try {
        const result = db.prepare(`
            UPDATE comissoes SET status = 'paga', data_pagamento = CURRENT_TIMESTAMP
            WHERE id = ? AND empresa_id = ? AND status = 'pendente'
        `).run(req.params.id, empresaId);

        if (result.changes === 0) {
            return res.redirect('/comissoes?erro=' + encodeURIComponent('Comissão não encontrada ou já paga'));
        }

        res.redirect('/comissoes?mensagem=' + encodeURIComponent('Comissão paga com sucesso!'));
    } catch (e) {
        res.redirect('/comissoes?erro=' + encodeURIComponent('Erro ao pagar comissão: ' + e.message));
    }
});

// POST /pagar-lote - Pagar comissoes em lote (por vendedor e periodo)
router.post('/pagar-lote', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const { vendedor_id, mes_inicio, mes_fim } = req.body;

    if (!vendedor_id) {
        return res.redirect('/comissoes?erro=' + encodeURIComponent('Selecione um vendedor'));
    }

    try {
        let sql = `
            UPDATE comissoes SET status = 'paga', data_pagamento = CURRENT_TIMESTAMP
            WHERE empresa_id = ? AND vendedor_id = ? AND status = 'pendente'
        `;
        const params = [empresaId, parseInt(vendedor_id)];

        // Filter by month range if provided (format: YYYY-MM)
        if (mes_inicio) {
            sql += ' AND created_at >= ?';
            params.push(mes_inicio + '-01');
        }
        if (mes_fim) {
            // Last day of the month: go to next month day 1, then subtract a second
            const parts = mes_fim.split('-');
            const year = parseInt(parts[0]);
            const month = parseInt(parts[1]);
            const nextMonth = new Date(year, month, 1); // month is 0-indexed so this is actually next month
            const lastDay = new Date(nextMonth - 1).toISOString().split('T')[0];
            sql += ' AND created_at <= ?';
            params.push(lastDay + ' 23:59:59');
        }

        const result = db.prepare(sql).run(...params);

        if (result.changes === 0) {
            return res.redirect('/comissoes?erro=' + encodeURIComponent('Nenhuma comissao pendente encontrada para este vendedor no periodo'));
        }

        res.redirect('/comissoes?mensagem=' + encodeURIComponent(`${result.changes} comissao(oes) paga(s) com sucesso!`));
    } catch (e) {
        res.redirect('/comissoes?erro=' + encodeURIComponent('Erro ao pagar comissoes: ' + e.message));
    }
});

module.exports = router;
