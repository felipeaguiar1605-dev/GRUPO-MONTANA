const express = require('express');
const router = express.Router();
const db = require('../../config/database');

router.get('/', (req, res) => {
    const empresaId = req.session.empresaAtual.id;

    // Current month boundaries
    const now = new Date();
    const inicioMes = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const proximoMes = now.getMonth() === 11
        ? `${now.getFullYear() + 1}-01-01`
        : `${now.getFullYear()}-${String(now.getMonth() + 2).padStart(2, '0')}-01`;

    // --- Total de produtos ---
    let totalProdutos = 0;
    try {
        const row = db.prepare(
            'SELECT COUNT(*) AS total FROM produtos WHERE empresa_id = ? AND ativo = 1'
        ).get(empresaId);
        totalProdutos = row ? row.total : 0;
    } catch (e) { totalProdutos = 0; }

    // --- Total de clientes ---
    let totalClientes = 0;
    try {
        const row = db.prepare(
            'SELECT COUNT(*) AS total FROM clientes WHERE empresa_id = ? AND ativo = 1'
        ).get(empresaId);
        totalClientes = row ? row.total : 0;
    } catch (e) { totalClientes = 0; }

    // --- Vendas do mês ---
    let vendasMesCount = 0;
    let vendasMesTotal = 0;
    try {
        const row = db.prepare(`
            SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
            FROM vendas
            WHERE empresa_id = ? AND status != 'cancelada'
              AND data_venda >= ? AND data_venda < ?
        `).get(empresaId, inicioMes, proximoMes);
        if (row) {
            vendasMesCount = row.count;
            vendasMesTotal = row.total;
        }
    } catch (e) { vendasMesCount = 0; vendasMesTotal = 0; }

    // --- Compras do mês ---
    let comprasMesCount = 0;
    let comprasMesTotal = 0;
    try {
        const row = db.prepare(`
            SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
            FROM compras
            WHERE empresa_id = ? AND status != 'cancelada'
              AND data_compra >= ? AND data_compra < ?
        `).get(empresaId, inicioMes, proximoMes);
        if (row) {
            comprasMesCount = row.count;
            comprasMesTotal = row.total;
        }
    } catch (e) { comprasMesCount = 0; comprasMesTotal = 0; }

    // --- Contas a pagar pendentes ---
    let contasPagarCount = 0;
    let contasPagarTotal = 0;
    try {
        const row = db.prepare(`
            SELECT COUNT(*) AS count, COALESCE(SUM(valor), 0) AS total
            FROM contas_pagar
            WHERE empresa_id = ? AND status IN ('pendente', 'vencida')
        `).get(empresaId);
        if (row) {
            contasPagarCount = row.count;
            contasPagarTotal = row.total;
        }
    } catch (e) { contasPagarCount = 0; contasPagarTotal = 0; }

    // --- Contas a receber pendentes ---
    let contasReceberCount = 0;
    let contasReceberTotal = 0;
    try {
        const row = db.prepare(`
            SELECT COUNT(*) AS count, COALESCE(SUM(valor), 0) AS total
            FROM contas_receber
            WHERE empresa_id = ? AND status IN ('pendente', 'vencida')
        `).get(empresaId);
        if (row) {
            contasReceberCount = row.count;
            contasReceberTotal = row.total;
        }
    } catch (e) { contasReceberCount = 0; contasReceberTotal = 0; }

    // --- Produtos com estoque baixo ---
    let estoqueBaixo = 0;
    try {
        const row = db.prepare(`
            SELECT COUNT(*) AS total
            FROM estoque e
            JOIN produtos p ON p.id = e.produto_id AND p.empresa_id = e.empresa_id
            WHERE e.empresa_id = ? AND p.ativo = 1
              AND p.estoque_minimo > 0 AND e.quantidade <= p.estoque_minimo
        `).get(empresaId);
        estoqueBaixo = row ? row.total : 0;
    } catch (e) { estoqueBaixo = 0; }

    // --- Vendas recentes (últimas 10) ---
    let vendasRecentes = [];
    try {
        vendasRecentes = db.prepare(`
            SELECT v.id, v.numero, v.data_venda, v.total, v.status, v.forma_pagamento,
                   c.nome AS cliente_nome
            FROM vendas v
            LEFT JOIN clientes c ON c.id = v.cliente_id
            WHERE v.empresa_id = ?
            ORDER BY v.data_venda DESC
            LIMIT 10
        `).all(empresaId);
    } catch (e) { vendasRecentes = []; }

    // --- Produtos mais vendidos do mês ---
    let topProdutos = [];
    try {
        topProdutos = db.prepare(`
            SELECT p.nome, SUM(vi.quantidade) AS qtd_vendida, SUM(vi.total) AS total_vendido
            FROM venda_itens vi
            JOIN vendas v ON v.id = vi.venda_id
            JOIN produtos p ON p.id = vi.produto_id
            WHERE v.empresa_id = ? AND v.status != 'cancelada'
              AND v.data_venda >= ? AND v.data_venda < ?
            GROUP BY vi.produto_id
            ORDER BY qtd_vendida DESC
            LIMIT 10
        `).all(empresaId, inicioMes, proximoMes);
    } catch (e) { topProdutos = []; }

    res.render('dashboard', {
        title: 'Dashboard',
        totalProdutos,
        totalClientes,
        vendasMesCount,
        vendasMesTotal,
        comprasMesCount,
        comprasMesTotal,
        contasPagarCount,
        contasPagarTotal,
        contasReceberCount,
        contasReceberTotal,
        estoqueBaixo,
        vendasRecentes,
        topProdutos
    });
});

module.exports = router;
