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
        SELECT COUNT(*) AS quantidade_vendas, COALESCE(SUM(total), 0) AS total_vendas
        FROM vendas
        WHERE empresa_id = ? AND status != 'cancelada'
          AND data_venda >= ? AND data_venda <= ?
    `).get(empresaId, data_inicio, data_fim + ' 23:59:59');

    // Ticket medio
    const ticketMedio = totalVendas.quantidade_vendas > 0 ? totalVendas.total_vendas / totalVendas.quantidade_vendas : 0;

    // Resumo object for linted view
    const resumo = {
        total_vendas: totalVendas.total_vendas,
        quantidade_vendas: totalVendas.quantidade_vendas,
        ticket_medio: ticketMedio
    };

    // Por forma de pagamento
    const porFormaPagamento = db.prepare(`
        SELECT forma_pagamento, COUNT(*) AS quantidade, COALESCE(SUM(total), 0) AS total
        FROM vendas
        WHERE empresa_id = ? AND status != 'cancelada'
          AND data_venda >= ? AND data_venda <= ?
        GROUP BY forma_pagamento
        ORDER BY total DESC
    `).all(empresaId, data_inicio, data_fim + ' 23:59:59');

    // Por vendedor
    const porVendedor = db.prepare(`
        SELECT v.nome AS vendedor_nome, COUNT(*) AS quantidade, COALESCE(SUM(vd.total), 0) AS total
        FROM vendas vd
        LEFT JOIN vendedores v ON v.id = vd.vendedor_id
        WHERE vd.empresa_id = ? AND vd.status != 'cancelada'
          AND vd.data_venda >= ? AND vd.data_venda <= ?
        GROUP BY vd.vendedor_id
        ORDER BY total DESC
    `).all(empresaId, data_inicio, data_fim + ' 23:59:59');

    res.render('relatorios/vendas', {
        title: 'Relatorio de Vendas',
        resumo,
        porFormaPagamento,
        porVendedor,
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
            COALESCE(SUM(COALESCE(e.quantidade, 0) * p.preco_custo), 0) AS valor_total_estoque
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
               MAX(em.created_at) AS ultimo_movimento
        FROM produtos p
        LEFT JOIN estoque e ON e.produto_id = p.id AND e.empresa_id = p.empresa_id
        LEFT JOIN categorias c ON c.id = p.categoria_id
        LEFT JOIN estoque_movimentacoes em ON em.produto_id = p.id AND em.empresa_id = p.empresa_id
        WHERE p.empresa_id = ? AND p.ativo = 1
        GROUP BY p.id
        HAVING ultimo_movimento IS NULL OR ultimo_movimento < ?
        ORDER BY ultimo_movimento ASC
    `).all(empresaId, trintaDiasStr);

    // Build resumo object for linted view
    const resumo = {
        valor_total_estoque: valorEstoque.valor_total_estoque,
        total_itens: valorEstoque.total_itens,
        abaixo_minimo: abaixoMinimo.length,
        sem_movimento: semMovimento.length
    };

    res.render('relatorios/estoque', {
        title: 'Relatorio de Estoque',
        resumo,
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

    // Total receitas
    const totalReceitas = db.prepare(`
        SELECT COALESCE(SUM(valor), 0) AS total
        FROM fluxo_caixa
        WHERE empresa_id = ? AND tipo = 'entrada'
          AND data_movimento >= ? AND data_movimento <= ?
    `).get(empresaId, data_inicio, data_fim).total;

    // Total despesas
    const totalDespesas = db.prepare(`
        SELECT COALESCE(SUM(valor), 0) AS total
        FROM fluxo_caixa
        WHERE empresa_id = ? AND tipo = 'saida'
          AND data_movimento >= ? AND data_movimento <= ?
    `).get(empresaId, data_inicio, data_fim).total;

    const lucro = totalReceitas - totalDespesas;

    // DRE por mes
    const dre = db.prepare(`
        SELECT
            strftime('%Y-%m', data_movimento) AS mes,
            COALESCE(SUM(CASE WHEN tipo = 'entrada' THEN valor ELSE 0 END), 0) AS receitas,
            COALESCE(SUM(CASE WHEN tipo = 'saida' THEN valor ELSE 0 END), 0) AS despesas
        FROM fluxo_caixa
        WHERE empresa_id = ? AND data_movimento >= ? AND data_movimento <= ?
        GROUP BY mes
        ORDER BY mes DESC
    `).all(empresaId, data_inicio, data_fim);

    // Projecao - proximos 3 meses
    const hojeStr = hoje.toISOString().split('T')[0];
    const projecao = [];
    for (let m = 0; m < 3; m++) {
        const mesInicio = new Date(hoje.getFullYear(), hoje.getMonth() + m, 1);
        const mesFim = new Date(hoje.getFullYear(), hoje.getMonth() + m + 1, 0);
        const mesInicioStr = mesInicio.toISOString().split('T')[0];
        const mesFimStr = mesFim.toISOString().split('T')[0];
        const mesLabel = mesInicio.toISOString().substring(0, 7);

        const recPrev = db.prepare(`
            SELECT COALESCE(SUM(valor), 0) AS total FROM contas_receber
            WHERE empresa_id = ? AND status IN ('pendente', 'vencida')
              AND data_vencimento >= ? AND data_vencimento <= ?
        `).get(empresaId, mesInicioStr, mesFimStr).total;

        const despPrev = db.prepare(`
            SELECT COALESCE(SUM(valor), 0) AS total FROM contas_pagar
            WHERE empresa_id = ? AND status IN ('pendente', 'vencida')
              AND data_vencimento >= ? AND data_vencimento <= ?
        `).get(empresaId, mesInicioStr, mesFimStr).total;

        projecao.push({
            mes: mesLabel,
            receitas_previstas: recPrev,
            despesas_previstas: despPrev
        });
    }

    res.render('relatorios/financeiro', {
        title: 'Relatorio Financeiro',
        resumo: {
            total_receitas: totalReceitas,
            total_despesas: totalDespesas,
            lucro: lucro
        },
        dre,
        projecao,
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

    // Comissoes por vendedor (linted view expects: vendedor_nome, total_vendas, total_comissao, comissoes_pagas, comissoes_pendentes)
    const comissoes = db.prepare(`
        SELECT v.nome AS vendedor_nome, v.id AS vendedor_id,
               COALESCE(SUM(vd.total), 0) AS total_vendas,
               COALESCE(SUM(c.valor), 0) AS total_comissao,
               COALESCE(SUM(CASE WHEN c.status = 'paga' THEN c.valor ELSE 0 END), 0) AS comissoes_pagas,
               COALESCE(SUM(CASE WHEN c.status = 'pendente' THEN c.valor ELSE 0 END), 0) AS comissoes_pendentes
        FROM comissoes c
        JOIN vendedores v ON v.id = c.vendedor_id
        LEFT JOIN vendas vd ON vd.id = c.venda_id
        ${where}
        GROUP BY c.vendedor_id
        ORDER BY total_comissao DESC
    `).all(...params);

    const vendedores = db.prepare(
        'SELECT id, nome FROM vendedores WHERE empresa_id = ? AND ativo = 1 ORDER BY nome'
    ).all(empresaId);

    res.render('relatorios/comissoes', {
        title: 'Relatorio de Comissoes',
        comissoes,
        vendedores,
        filtros: { data_inicio, data_fim, vendedor_id }
    });
});

module.exports = router;
