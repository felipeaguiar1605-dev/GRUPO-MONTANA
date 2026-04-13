const express = require('express');
const router = express.Router();
const db = require('../../config/database');

// GET / - Listar categorias
router.get('/', (req, res) => {
    const empresaId = req.session.empresaAtual.id;

    const categorias = db.prepare(`
        SELECT c.*,
               (SELECT COUNT(*) FROM produtos p WHERE p.categoria_id = c.id AND p.empresa_id = c.empresa_id) AS total_produtos
        FROM categorias c
        WHERE c.empresa_id = ?
        ORDER BY c.nome ASC
    `).all(empresaId);

    res.render('categorias/index', {
        title: 'Categorias',
        categorias,
        msg: req.query.msg || null,
        erro: req.query.erro || null
    });
});

// POST /novo - Criar categoria
router.post('/novo', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const { nome, descricao } = req.body;

    if (!nome || !nome.trim()) {
        return res.redirect('/categorias?erro=Nome+da+categoria+é+obrigatório');
    }

    try {
        db.prepare(`
            INSERT INTO categorias (empresa_id, nome, descricao, ativa)
            VALUES (?, ?, ?, 1)
        `).run(empresaId, nome.trim(), descricao || null);

        res.redirect('/categorias?msg=Categoria+criada+com+sucesso');
    } catch (err) {
        console.error('Erro ao criar categoria:', err);
        res.redirect('/categorias?erro=Erro+ao+criar+categoria');
    }
});

// POST /editar/:id - Atualizar categoria
router.post('/editar/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const categoriaId = parseInt(req.params.id);
    const { nome, descricao } = req.body;

    if (!nome || !nome.trim()) {
        return res.redirect('/categorias?erro=Nome+da+categoria+é+obrigatório');
    }

    try {
        db.prepare(`
            UPDATE categorias SET nome = ?, descricao = ?
            WHERE id = ? AND empresa_id = ?
        `).run(nome.trim(), descricao || null, categoriaId, empresaId);

        res.redirect('/categorias?msg=Categoria+atualizada+com+sucesso');
    } catch (err) {
        console.error('Erro ao atualizar categoria:', err);
        res.redirect('/categorias?erro=Erro+ao+atualizar+categoria');
    }
});

// GET /excluir/:id - Excluir categoria (somente se nao houver produtos)
router.get('/excluir/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const categoriaId = parseInt(req.params.id);

    // Verificar se ha produtos usando esta categoria
    const produtosUsando = db.prepare(
        'SELECT COUNT(*) AS total FROM produtos WHERE categoria_id = ? AND empresa_id = ?'
    ).get(categoriaId, empresaId);

    if (produtosUsando && produtosUsando.total > 0) {
        return res.redirect('/categorias?erro=Não+é+possível+excluir.+Existem+' + produtosUsando.total + '+produtos+nesta+categoria');
    }

    try {
        db.prepare(
            'DELETE FROM categorias WHERE id = ? AND empresa_id = ?'
        ).run(categoriaId, empresaId);

        res.redirect('/categorias?msg=Categoria+excluída+com+sucesso');
    } catch (err) {
        console.error('Erro ao excluir categoria:', err);
        res.redirect('/categorias?erro=Erro+ao+excluir+categoria');
    }
});

module.exports = router;
