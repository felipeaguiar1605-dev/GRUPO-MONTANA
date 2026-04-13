const express = require('express');
const router = express.Router();
const db = require('../../config/database');

// GET / - Visao geral do estoque
router.get('/', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const busca = req.query.busca || '';
    const pagina = parseInt(req.query.pagina) || 1;
    const limit = 20;
    const offset = (pagina - 1) * limit;

    let where = 'WHERE p.empresa_id = ? AND p.ativo = 1';
    const params = [empresaId];

    if (busca) {
        where += ' AND (p.nome LIKE ? OR p.codigo LIKE ?)';
        params.push(`%${busca}%`, `%${busca}%`);
    }

    const total = db.prepare(`
        SELECT COUNT(*) as total FROM produtos p
        LEFT JOIN estoque e ON e.produto_id = p.id AND e.empresa_id = p.empresa_id
        ${where}
    `).get(...params).total;
    const totalPaginas = Math.ceil(total / limit);

    const produtos = db.prepare(`
        SELECT p.id, p.codigo, p.nome, p.preco_custo, p.preco_venda,
               p.estoque_minimo, p.estoque_maximo,
               c.nome AS categoria_nome,
               COALESCE(e.quantidade, 0) AS quantidade
        FROM produtos p
        LEFT JOIN categorias c ON c.id = p.categoria_id
        LEFT JOIN estoque e ON e.produto_id = p.id AND e.empresa_id = p.empresa_id
        ${where}
        ORDER BY p.nome ASC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    // Resumo (view expects resumo.total_itens, resumo.abaixo_minimo, resumo.valor_total)
    const resumo = db.prepare(`
        SELECT
            COUNT(*) AS total_itens,
            COALESCE(SUM(COALESCE(e.quantidade, 0) * p.preco_custo), 0) AS valor_total,
            SUM(CASE WHEN p.estoque_minimo > 0 AND COALESCE(e.quantidade, 0) <= p.estoque_minimo THEN 1 ELSE 0 END) AS abaixo_minimo,
            SUM(CASE WHEN p.estoque_maximo > 0 AND COALESCE(e.quantidade, 0) >= p.estoque_maximo THEN 1 ELSE 0 END) AS acima_maximo
        FROM produtos p
        LEFT JOIN estoque e ON e.produto_id = p.id AND e.empresa_id = p.empresa_id
        WHERE p.empresa_id = ? AND p.ativo = 1
    `).get(empresaId);

    res.render('estoque/index', {
        title: 'Estoque',
        produtos,
        resumo,
        busca,
        pagina,
        totalPaginas,
        total,
        msg: req.query.msg || null,
        erro: req.query.erro || null
    });
});

// GET /movimentacoes - Historico de movimentacoes
router.get('/movimentacoes', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const pagina = parseInt(req.query.pagina) || 1;
    const limit = 20;
    const offset = (pagina - 1) * limit;

    const { produto_id, tipo, data_inicio, data_fim } = req.query;

    let where = 'WHERE em.empresa_id = ?';
    const params = [empresaId];

    if (produto_id) {
        where += ' AND em.produto_id = ?';
        params.push(parseInt(produto_id));
    }
    if (tipo) {
        where += ' AND em.tipo = ?';
        params.push(tipo);
    }
    if (data_inicio) {
        where += ' AND em.created_at >= ?';
        params.push(data_inicio);
    }
    if (data_fim) {
        where += ' AND em.created_at <= ?';
        params.push(data_fim + ' 23:59:59');
    }

    const total = db.prepare(`
        SELECT COUNT(*) as total FROM estoque_movimentacoes em ${where}
    `).get(...params).total;
    const totalPaginas = Math.ceil(total / limit);

    const movimentacoes = db.prepare(`
        SELECT em.*, p.nome AS produto_nome, p.codigo AS produto_codigo,
               u.nome AS usuario_nome
        FROM estoque_movimentacoes em
        JOIN produtos p ON p.id = em.produto_id
        LEFT JOIN usuarios u ON u.id = em.usuario_id
        ${where}
        ORDER BY em.created_at DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const produtos = db.prepare(
        'SELECT id, codigo, nome FROM produtos WHERE empresa_id = ? AND ativo = 1 ORDER BY nome'
    ).all(empresaId);

    res.render('estoque/movimentacoes', {
        title: 'Movimentacoes de Estoque',
        movimentacoes,
        produtos,
        filtros: { produto_id, tipo, data_inicio, data_fim },
        pagina,
        totalPaginas,
        total
    });
});

// GET /ajuste - Formulario de ajuste
router.get('/ajuste', (req, res) => {
    const empresaId = req.session.empresaAtual.id;

    const produtos = db.prepare(`
        SELECT p.id, p.codigo, p.nome, COALESCE(e.quantidade, 0) AS quantidade
        FROM produtos p
        LEFT JOIN estoque e ON e.produto_id = p.id AND e.empresa_id = p.empresa_id
        WHERE p.empresa_id = ? AND p.ativo = 1
        ORDER BY p.nome
    `).all(empresaId);

    res.render('estoque/ajuste', {
        title: 'Ajuste de Estoque',
        produtos,
        erro: req.query.erro || null,
        msg: req.query.msg || null
    });
});

// POST /ajuste - Processar ajuste de estoque
router.post('/ajuste', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const usuarioId = req.session.usuario.id;
    const { produto_id, nova_quantidade, observacao } = req.body;

    if (!produto_id || nova_quantidade === undefined || nova_quantidade === '') {
        return res.redirect('/estoque/ajuste?erro=Preencha+todos+os+campos+obrigatorios');
    }

    try {
        const ajustar = db.transaction(() => {
            const prodId = parseInt(produto_id);
            const novaQty = parseFloat(nova_quantidade);

            // Garantir registro de estoque existe
            db.prepare(`
                INSERT OR IGNORE INTO estoque (empresa_id, produto_id, quantidade)
                VALUES (?, ?, 0)
            `).run(empresaId, prodId);

            const estoqueAtual = db.prepare(
                'SELECT quantidade FROM estoque WHERE empresa_id = ? AND produto_id = ?'
            ).get(empresaId, prodId);

            const qtyAnterior = estoqueAtual ? estoqueAtual.quantidade : 0;

            db.prepare(`
                UPDATE estoque SET quantidade = ?, updated_at = CURRENT_TIMESTAMP
                WHERE empresa_id = ? AND produto_id = ?
            `).run(novaQty, empresaId, prodId);

            db.prepare(`
                INSERT INTO estoque_movimentacoes (
                    empresa_id, produto_id, tipo, quantidade, quantidade_anterior,
                    quantidade_posterior, documento_tipo, observacao, usuario_id
                ) VALUES (?, ?, 'ajuste', ?, ?, ?, 'ajuste_manual', ?, ?)
            `).run(
                empresaId, prodId,
                Math.abs(novaQty - qtyAnterior),
                qtyAnterior, novaQty,
                observacao || 'Ajuste manual de estoque',
                usuarioId
            );
        });

        ajustar();
        res.redirect('/estoque?msg=Ajuste+realizado+com+sucesso');
    } catch (err) {
        console.error('Erro ao ajustar estoque:', err);
        res.redirect('/estoque/ajuste?erro=Erro+ao+ajustar+estoque');
    }
});

// GET /transferencia - Formulario de transferencia entre empresas
router.get('/transferencia', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const empresas = req.session.empresas || [];

    // Somente se o usuario tem acesso a mais de uma empresa
    if (empresas.length < 2) {
        return res.redirect('/estoque?erro=Voce+precisa+ter+acesso+a+mais+de+uma+empresa+para+transferir');
    }

    const produtos = db.prepare(`
        SELECT p.id, p.codigo, p.nome, COALESCE(e.quantidade, 0) AS quantidade
        FROM produtos p
        LEFT JOIN estoque e ON e.produto_id = p.id AND e.empresa_id = p.empresa_id
        WHERE p.empresa_id = ? AND p.ativo = 1
        ORDER BY p.nome
    `).all(empresaId);

    const outrasEmpresas = empresas.filter(e => e.id !== empresaId);

    res.render('estoque/transferencia', {
        title: 'Transferencia de Estoque',
        produtos,
        outrasEmpresas,
        erro: req.query.erro || null,
        msg: req.query.msg || null
    });
});

// POST /transferencia - Processar transferencia
router.post('/transferencia', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const usuarioId = req.session.usuario.id;
    const { produto_id, empresa_destino_id, quantidade, observacao } = req.body;

    if (!produto_id || !empresa_destino_id || !quantidade) {
        return res.redirect('/estoque/transferencia?erro=Preencha+todos+os+campos+obrigatorios');
    }

    const empresas = req.session.empresas || [];
    const destino = empresas.find(e => e.id === parseInt(empresa_destino_id));
    if (!destino) {
        return res.redirect('/estoque/transferencia?erro=Empresa+destino+invalida');
    }

    try {
        const transferir = db.transaction(() => {
            const prodId = parseInt(produto_id);
            const qty = parseFloat(quantidade);
            const destId = parseInt(empresa_destino_id);

            // Verificar estoque de origem
            const estoqueOrigem = db.prepare(
                'SELECT quantidade FROM estoque WHERE empresa_id = ? AND produto_id = ?'
            ).get(empresaId, prodId);

            const qtyOrigem = estoqueOrigem ? estoqueOrigem.quantidade : 0;
            if (qtyOrigem < qty) {
                throw new Error('Estoque insuficiente para transferencia');
            }

            // Diminuir no origem
            db.prepare(`
                UPDATE estoque SET quantidade = quantidade - ?, updated_at = CURRENT_TIMESTAMP
                WHERE empresa_id = ? AND produto_id = ?
            `).run(qty, empresaId, prodId);

            db.prepare(`
                INSERT INTO estoque_movimentacoes (
                    empresa_id, produto_id, tipo, quantidade, quantidade_anterior,
                    quantidade_posterior, documento_tipo, observacao, usuario_id
                ) VALUES (?, ?, 'transferencia', ?, ?, ?, 'transferencia_saida', ?, ?)
            `).run(
                empresaId, prodId, qty, qtyOrigem, qtyOrigem - qty,
                observacao || 'Transferencia para ' + destino.nome_fantasia,
                usuarioId
            );

            // Garantir produto e estoque existem no destino
            const produtoOrigem = db.prepare('SELECT * FROM produtos WHERE id = ? AND empresa_id = ?').get(prodId, empresaId);

            // Verificar se produto existe no destino (por codigo)
            let produtoDestino = null;
            if (produtoOrigem.codigo) {
                produtoDestino = db.prepare(
                    'SELECT id FROM produtos WHERE codigo = ? AND empresa_id = ?'
                ).get(produtoOrigem.codigo, destId);
            }

            let destProdId;
            if (produtoDestino) {
                destProdId = produtoDestino.id;
            } else {
                // Criar produto no destino
                const r = db.prepare(`
                    INSERT INTO produtos (empresa_id, codigo, nome, descricao, preco_custo, preco_venda, ativo)
                    VALUES (?, ?, ?, ?, ?, ?, 1)
                `).run(destId, produtoOrigem.codigo, produtoOrigem.nome, produtoOrigem.descricao, produtoOrigem.preco_custo, produtoOrigem.preco_venda);
                destProdId = r.lastInsertRowid;
            }

            // Garantir registro de estoque no destino
            db.prepare(`
                INSERT OR IGNORE INTO estoque (empresa_id, produto_id, quantidade)
                VALUES (?, ?, 0)
            `).run(destId, destProdId);

            const estoqueDestino = db.prepare(
                'SELECT quantidade FROM estoque WHERE empresa_id = ? AND produto_id = ?'
            ).get(destId, destProdId);
            const qtyDestino = estoqueDestino ? estoqueDestino.quantidade : 0;

            // Aumentar no destino
            db.prepare(`
                UPDATE estoque SET quantidade = quantidade + ?, updated_at = CURRENT_TIMESTAMP
                WHERE empresa_id = ? AND produto_id = ?
            `).run(qty, destId, destProdId);

            db.prepare(`
                INSERT INTO estoque_movimentacoes (
                    empresa_id, produto_id, tipo, quantidade, quantidade_anterior,
                    quantidade_posterior, documento_tipo, observacao, usuario_id
                ) VALUES (?, ?, 'transferencia', ?, ?, ?, 'transferencia_entrada', ?, ?)
            `).run(
                destId, destProdId, qty, qtyDestino, qtyDestino + qty,
                observacao || 'Transferencia de ' + req.session.empresaAtual.nome_fantasia,
                usuarioId
            );
        });

        transferir();
        res.redirect('/estoque?msg=Transferencia+realizada+com+sucesso');
    } catch (err) {
        console.error('Erro ao transferir estoque:', err);
        const msg = err.message === 'Estoque insuficiente para transferencia'
            ? 'Estoque+insuficiente+para+transferencia'
            : 'Erro+ao+realizar+transferencia';
        res.redirect('/estoque/transferencia?erro=' + msg);
    }
});

module.exports = router;
