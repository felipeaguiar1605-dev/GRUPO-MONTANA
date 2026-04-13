const express = require('express');
const router = express.Router();
const db = require('../../config/database');

// GET / - Listar produtos com busca, filtro por categoria e paginacao
router.get('/', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const busca = req.query.busca || '';
    const categoriaFiltro = req.query.categoria_id || '';
    const pagina = parseInt(req.query.pagina) || 1;
    const porPagina = 20;
    const offset = (pagina - 1) * porPagina;

    let where = 'WHERE p.empresa_id = ?';
    const params = [empresaId];

    if (busca) {
        where += ' AND (p.nome LIKE ? OR p.codigo LIKE ?)';
        params.push(`%${busca}%`, `%${busca}%`);
    }

    if (categoriaFiltro) {
        where += ' AND p.categoria_id = ?';
        params.push(parseInt(categoriaFiltro));
    }

    // Total para paginacao
    const totalRow = db.prepare(`
        SELECT COUNT(*) AS total FROM produtos p ${where}
    `).get(...params);
    const total = totalRow ? totalRow.total : 0;
    const totalPaginas = Math.ceil(total / porPagina);

    // Buscar produtos com joins
    const produtos = db.prepare(`
        SELECT p.*,
               c.nome AS categoria_nome,
               u.sigla AS unidade_sigla,
               COALESCE(e.quantidade, 0) AS estoque
        FROM produtos p
        LEFT JOIN categorias c ON c.id = p.categoria_id
        LEFT JOIN unidades u ON u.id = p.unidade_id
        LEFT JOIN estoque e ON e.produto_id = p.id AND e.empresa_id = p.empresa_id
        ${where}
        ORDER BY p.nome ASC
        LIMIT ? OFFSET ?
    `).all(...params, porPagina, offset);

    // Categorias para o filtro
    const categorias = db.prepare(
        'SELECT id, nome FROM categorias WHERE empresa_id = ? AND ativa = 1 ORDER BY nome'
    ).all(empresaId);

    res.render('produtos/index', {
        title: 'Produtos',
        produtos,
        categorias,
        busca,
        categoriaFiltro,
        pagina,
        totalPaginas,
        total,
        msg: req.query.msg || null,
        erro: req.query.erro || null
    });
});

// GET /novo - Formulario de criacao
router.get('/novo', (req, res) => {
    const empresaId = req.session.empresaAtual.id;

    const categorias = db.prepare(
        'SELECT id, nome FROM categorias WHERE empresa_id = ? AND ativa = 1 ORDER BY nome'
    ).all(empresaId);

    const unidades = db.prepare(
        'SELECT id, sigla, descricao FROM unidades ORDER BY sigla'
    ).all();

    res.render('produtos/form', {
        title: 'Novo Produto',
        produto: null,
        categorias,
        unidades,
        erro: req.query.erro || null
    });
});

// POST /novo - Criar produto
router.post('/novo', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const {
        codigo, codigo_barras, nome, descricao,
        categoria_id, unidade_id, ncm, cfop_venda,
        preco_custo, margem_lucro, preco_venda, preco_atacado,
        estoque_minimo, estoque_maximo, localizacao, peso, ativo
    } = req.body;

    if (!nome || !nome.trim()) {
        return res.redirect('/produtos/novo?erro=Nome+do+produto+é+obrigatório');
    }

    try {
        const result = db.prepare(`
            INSERT INTO produtos (
                empresa_id, codigo, codigo_barras, nome, descricao,
                categoria_id, unidade_id, ncm, cfop_venda,
                preco_custo, margem_lucro, preco_venda, preco_atacado,
                estoque_minimo, estoque_maximo, localizacao, peso, ativo
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            empresaId,
            codigo || null,
            codigo_barras || null,
            nome.trim(),
            descricao || null,
            categoria_id || null,
            unidade_id || null,
            ncm || null,
            cfop_venda || null,
            parseFloat(preco_custo) || 0,
            parseFloat(margem_lucro) || 0,
            parseFloat(preco_venda) || 0,
            parseFloat(preco_atacado) || 0,
            parseFloat(estoque_minimo) || 0,
            parseFloat(estoque_maximo) || 0,
            localizacao || null,
            parseFloat(peso) || 0,
            ativo ? 1 : 0
        );

        // Criar registro de estoque com quantidade 0
        db.prepare(`
            INSERT INTO estoque (empresa_id, produto_id, quantidade)
            VALUES (?, ?, 0)
        `).run(empresaId, result.lastInsertRowid);

        res.redirect('/produtos?msg=Produto+criado+com+sucesso');
    } catch (err) {
        console.error('Erro ao criar produto:', err);
        res.redirect('/produtos/novo?erro=Erro+ao+criar+produto');
    }
});

// GET /editar/:id - Formulario de edicao
router.get('/editar/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const produtoId = parseInt(req.params.id);

    const produto = db.prepare(
        'SELECT * FROM produtos WHERE id = ? AND empresa_id = ?'
    ).get(produtoId, empresaId);

    if (!produto) {
        return res.redirect('/produtos?erro=Produto+não+encontrado');
    }

    const categorias = db.prepare(
        'SELECT id, nome FROM categorias WHERE empresa_id = ? AND ativa = 1 ORDER BY nome'
    ).all(empresaId);

    const unidades = db.prepare(
        'SELECT id, sigla, descricao FROM unidades ORDER BY sigla'
    ).all();

    res.render('produtos/form', {
        title: 'Editar Produto',
        produto,
        categorias,
        unidades,
        erro: req.query.erro || null
    });
});

// POST /editar/:id - Atualizar produto
router.post('/editar/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const produtoId = parseInt(req.params.id);
    const {
        codigo, codigo_barras, nome, descricao,
        categoria_id, unidade_id, ncm, cfop_venda,
        preco_custo, margem_lucro, preco_venda, preco_atacado,
        estoque_minimo, estoque_maximo, localizacao, peso, ativo
    } = req.body;

    if (!nome || !nome.trim()) {
        return res.redirect(`/produtos/editar/${produtoId}?erro=Nome+do+produto+é+obrigatório`);
    }

    try {
        db.prepare(`
            UPDATE produtos SET
                codigo = ?, codigo_barras = ?, nome = ?, descricao = ?,
                categoria_id = ?, unidade_id = ?, ncm = ?, cfop_venda = ?,
                preco_custo = ?, margem_lucro = ?, preco_venda = ?, preco_atacado = ?,
                estoque_minimo = ?, estoque_maximo = ?, localizacao = ?, peso = ?,
                ativo = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND empresa_id = ?
        `).run(
            codigo || null,
            codigo_barras || null,
            nome.trim(),
            descricao || null,
            categoria_id || null,
            unidade_id || null,
            ncm || null,
            cfop_venda || null,
            parseFloat(preco_custo) || 0,
            parseFloat(margem_lucro) || 0,
            parseFloat(preco_venda) || 0,
            parseFloat(preco_atacado) || 0,
            parseFloat(estoque_minimo) || 0,
            parseFloat(estoque_maximo) || 0,
            localizacao || null,
            parseFloat(peso) || 0,
            ativo ? 1 : 0,
            produtoId,
            empresaId
        );

        res.redirect('/produtos?msg=Produto+atualizado+com+sucesso');
    } catch (err) {
        console.error('Erro ao atualizar produto:', err);
        res.redirect(`/produtos/editar/${produtoId}?erro=Erro+ao+atualizar+produto`);
    }
});

// GET /excluir/:id - Soft delete (ativo=0)
router.get('/excluir/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const produtoId = parseInt(req.params.id);

    try {
        db.prepare(
            'UPDATE produtos SET ativo = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND empresa_id = ?'
        ).run(produtoId, empresaId);

        res.redirect('/produtos?msg=Produto+desativado+com+sucesso');
    } catch (err) {
        console.error('Erro ao desativar produto:', err);
        res.redirect('/produtos?erro=Erro+ao+desativar+produto');
    }
});

// GET /ativar/:id - Reativar produto
router.get('/ativar/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const produtoId = parseInt(req.params.id);

    try {
        db.prepare(
            'UPDATE produtos SET ativo = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND empresa_id = ?'
        ).run(produtoId, empresaId);

        res.redirect('/produtos?msg=Produto+reativado+com+sucesso');
    } catch (err) {
        console.error('Erro ao reativar produto:', err);
        res.redirect('/produtos?erro=Erro+ao+reativar+produto');
    }
});

module.exports = router;
