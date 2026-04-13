const express = require('express');
const router = express.Router();
const db = require('../../config/database');

// GET / - Menu de relatorios
router.get('/', (req, res) => {
    res.render('relatorios/index', {
        title: 'Relatorios'
    });
});

// GET /vendas - Relatorio de vendas
router.get('/vendas', (req, res) => {
    const empresaId = req.session.empresaAtual.id;

    // Datas padrao: ultimo mes
    const hoje = new Date();
    const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    const data_inicio = req.query.data_inicio || inicioMes.toISOString().split('T')[0];
    const data_fim = req.query.data_fim || hoje.toISOString().split('T')[0];
    const agrupar = req.query.agrupar || 'dia';

    // Total de vendas no periodo
    const totalVendas = db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
        FROM vendas
        WHERE empresa_id = ? AND status != 'cancelada'
          AND data_venda >= ? AND data_venda <= ?
    `).get(empresaId, data_inicio, data_fim + ' 23:59:59');

    // Ticket medio
    const ticketMedio = totalVendas.count > 0 ? totalVendas.total / totalVendas.count : 0;

    // Por forma de pagamento
    const porFormaPagamento = db.prepare(`
        SELECT forma_pagamento, COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
        FROM vendas
        WHERE empresa_id = ? AND status != 'cancelada'
          AND data_venda >= ? AND data_venda <= ?
        GROUP BY forma_pagamento
        ORDER BY total DESC
    `).all(empresaId, data_inicio, data_fim + ' 23:59:59');

    // Por vendedor
    const porVendedor = db.prepare(`
        SELECT v.nome AS vendedor_nome, COUNT(*) AS count, COALESCE(SUM(vd.total), 0) AS total
        FROM vendas vd
        LEFT JOIN vendedores v ON v.id = vd.vendedor_id
        WHERE vd.empresa_id = ? AND vd.status != 'cancelada'
          AND vd.data_venda >= ? AND vd.data_venda <= ?
        GROUP BY vd.vendedor_id
        ORDER BY total DESC
    `).all(empresaId, data_inicio, data_fim + ' 23:59:59');

    // Vendas agrupadas
    let groupBy, selectDate;
    if (agrupar === 'mes') {
        groupBy = "strftime('%Y-%m', data_venda)";
        selectDate = "strftime('%Y-%m', data_venda) AS periodo";
    } else {
        groupBy = "date(data_venda)";
        selectDate = "date(data_venda) AS periodo";
    }

    const vendasAgrupadas = db.prepare(`
        SELECT ${selectDate}, COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
        FROM vendas
        WHERE empresa_id = ? AND status != 'cancelada'
          AND data_venda >= ? AND data_venda <= ?
        GROUP BY ${groupBy}
        ORDER BY periodo DESC
    `).all(empresaId, data_inicio, data_fim + ' 23:59:59');

    res.render('relatorios/vendas', {
        title: 'Relatorio de Vendas',
        totalVendas,
        ticketMedio,
        porFormaPagamento,
        porVendedor,
        vendasAgrupadas,
        filtros: { data_inicio, data_fim, agrupar }
    });
});

// GET /estoque - Relatorio de estoque
router.get('/estoque', (req, res) => {
    const empresaId = req.session.empresaAtual.id;

    // Valor total do estoque
    const valorEstoque = db.prepare(`
        SELECT
            COUNT(*) AS total_itens,
            COALESCE(SUM(COALESCE(e.quantidade, 0) * p.preco_custo), 0) AS valor_custo,
            COALESCE(SUM(COALESCE(e.quantidade, 0) * p.preco_venda), 0) AS valor_venda
        FROM produtos p
        LEFT JOIN estoque e ON e.produto_id = p.id AND e.empresa_id = p.empresa_id
        WHERE p.empresa_id = ? AND p.ativo = 1
    `).get(empresaId);

    // Itens abaixo do minimo
    const abaixoMinimo = db.prepare(`
        SELECT p.id, p.codigo, p.nome, p.estoque_minimo,
               COALESCE(e.quantidade, 0) AS quantidade,
               c.nome AS categoria_nome
        FROM produtos p
        LEFT JOIN estoque e ON e.produto_id = p.id AND e.empresa_id = p.empresa_id
        LEFT JOIN categorias c ON c.id = p.categoria_id
        WHERE p.empresa_id = ? AND p.ativo = 1
          AND p.estoque_minimo > 0 AND COALESCE(e.quantidade, 0) <= p.estoque_minimo
        ORDER BY (COALESCE(e.quantidade, 0) - p.estoque_minimo) ASC
    `).all(empresaId);

    // Itens sem movimentacao em 30 dias
    const trintaDiasAtras = new Date();
    trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30);
    const trintaDiasStr = trintaDiasAtras.toISOString().split('T')[0];

    const semMovimento = db.prepare(`
        SELECT p.id, p.codigo, p.nome, COALESCE(e.quantidade, 0) AS quantidade,
               p.preco_custo,
               c.nome AS categoria_nome,
               MAX(em.created_at) AS ultima_movimentacao
        FROM produtos p
        LEFT JOIN estoque e ON e.produto_id = p.id AND e.empresa_id = p.empresa_id
        LEFT JOIN categorias c ON c.id = p.categoria_id
        LEFT JOIN estoque_movimentacoes em ON em.produto_id = p.id AND em.empresa_id = p.empresa_id
        WHERE p.empresa_id = ? AND p.ativo = 1
        GROUP BY p.id
        HAVING ultima_movimentacao IS NULL OR ultima_movimentacao < ?
        ORDER BY ultima_movimentacao ASC
    `).all(empresaId, trintaDiasStr);

    res.render('relatorios/estoque', {
        title: 'Relatorio de Estoque',
        valorEstoque,
        abaixoMinimo,
        semMovimento
    });
});

// GET /financeiro - Relatorio financeiro
router.get('/financeiro', (req, res) => {
    const empresaId = req.session.empresaAtual.id;

    const hoje = new Date();
    const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    const data_inicio = req.query.data_inicio || inicioMes.toISOString().split('T')[0];
    const data_fim = req.query.data_fim || hoje.toISOString().split('T')[0];

    // DRE simplificado - Receitas
    const receitas = db.prepare(`
        SELECT categoria, COALESCE(SUM(valor), 0) AS total
        FROM fluxo_caixa
        WHERE empresa_id = ? AND tipo = 'entrada'
          AND data_movimento >= ? AND data_movimento <= ?
        GROUP BY categoria
        ORDER BY total DESC
    `).all(empresaId, data_inicio, data_fim);

    const totalReceitas = receitas.reduce((sum, r) => sum + r.total, 0);

    // DRE simplificado - Despesas
    const despesas = db.prepare(`
        SELECT categoria, COALESCE(SUM(valor), 0) AS total
        FROM fluxo_caixa
        WHERE empresa_id = ? AND tipo = 'saida'
          AND data_movimento >= ? AND data_movimento <= ?
        GROUP BY categoria
        ORDER BY total DESC
    `).all(empresaId, data_inicio, data_fim);

    const totalDespesas = despesas.reduce((sum, d) => sum + d.total, 0);

    // Resultado
    const resultado = totalReceitas - totalDespesas;

    // Projecao do fluxo de caixa (proximos 30 dias)
    const prox30 = new Date();
    prox30.setDate(prox30.getDate() + 30);
    const prox30Str = prox30.toISOString().split('T')[0];
    const hojeStr = hoje.toISOString().split('T')[0];

    const projecaoReceber = db.prepare(`
        SELECT COALESCE(SUM(valor), 0) AS total
        FROM contas_receber
        WHERE empresa_id = ? AND status IN ('pendente', 'vencida')
          AND data_vencimento >= ? AND data_vencimento <= ?
    `).get(empresaId, hojeStr, prox30Str);

    const projecaoPagar = db.prepare(`
        SELECT COALESCE(SUM(valor), 0) AS total
        FROM contas_pagar
        WHERE empresa_id = ? AND status IN ('pendente', 'vencida')
          AND data_vencimento >= ? AND data_vencimento <= ?
    `).get(empresaId, hojeStr, prox30Str);

    res.render('relatorios/financeiro', {
        title: 'Relatorio Financeiro',
        receitas,
        totalReceitas,
        despesas,
        totalDespesas,
        resultado,
        projecaoReceber: projecaoReceber.total,
        projecaoPagar: projecaoPagar.total,
        filtros: { data_inicio, data_fim }
    });
});

// GET /comissoes - Relatorio de comissoes
router.get('/comissoes', (req, res) => {
    const empresaId = req.session.empresaAtual.id;

    const hoje = new Date();
    const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    const data_inicio = req.query.data_inicio || inicioMes.toISOString().split('T')[0];
    const data_fim = req.query.data_fim || hoje.toISOString().split('T')[0];
    const vendedor_id = req.query.vendedor_id || '';

    let where = 'WHERE c.empresa_id = ? AND c.created_at >= ? AND c.created_at <= ?';
    const params = [empresaId, data_inicio, data_fim + ' 23:59:59'];

    if (vendedor_id) {
        where += ' AND c.vendedor_id = ?';
        params.push(parseInt(vendedor_id));
    }

    // Comissoes por vendedor
    const comissoesPorVendedor = db.prepare(`
        SELECT v.nome AS vendedor_nome, v.id AS vendedor_id,
               COUNT(*) AS total_vendas,
               COALESCE(SUM(c.valor), 0) AS total_comissao,
               COALESCE(AVG(c.percentual), 0) AS percentual_medio,
               SUM(CASE WHEN c.status = 'pendente' THEN c.valor ELSE 0 END) AS pendente,
               SUM(CASE WHEN c.status = 'paga' THEN c.valor ELSE 0 END) AS paga
        FROM comissoes c
        JOIN vendedores v ON v.id = c.vendedor_id
        ${where}
        GROUP BY c.vendedor_id
        ORDER BY total_comissao DESC
    `).all(...params);

    // Detalhes das comissoes
    const comissoes = db.prepare(`
        SELECT c.*, v.nome AS vendedor_nome, vd.numero AS venda_numero, vd.total AS venda_total
        FROM comissoes c
        JOIN vendedores v ON v.id = c.vendedor_id
        LEFT JOIN vendas vd ON vd.id = c.venda_id
        ${where}
        ORDER BY c.created_at DESC
    `).all(...params);

    const vendedores = db.prepare(
        'SELECT id, nome FROM vendedores WHERE empresa_id = ? AND ativo = 1 ORDER BY nome'
    ).all(empresaId);

    res.render('relatorios/comissoes', {
        title: 'Relatorio de Comissoes',
        comissoesPorVendedor,
        comissoes,
        vendedores,
        filtros: { data_inicio, data_fim, vendedor_id }
    });
});

module.exports = router;
