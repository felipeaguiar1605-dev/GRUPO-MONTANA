const express = require('express');
const router = express.Router();
const db = require('../../config/database');

// GET / - Listar vendedores
router.get('/', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const busca = req.query.busca || '';
    const pagina = parseInt(req.query.pagina) || 1;
    const limit = 20;
    const offset = (pagina - 1) * limit;

    let whereClauses = ['empresa_id = ?'];
    const params = [empresaId];

    if (busca) {
        whereClauses.push('(nome LIKE ? OR cpf LIKE ? OR email LIKE ?)');
        const term = `%${busca}%`;
        params.push(term, term, term);
    }

    const whereSQL = whereClauses.join(' AND ');

    let vendedores = [];
    let totalRows = 0;
    try {
        const countRow = db.prepare(`SELECT COUNT(*) AS total FROM vendedores WHERE ${whereSQL}`).get(...params);
        totalRows = countRow ? countRow.total : 0;
    } catch (e) {
        totalRows = 0;
    }

    const totalPaginas = Math.ceil(totalRows / limit) || 1;

    try {
        vendedores = db.prepare(`SELECT * FROM vendedores WHERE ${whereSQL} ORDER BY nome ASC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    } catch (e) {
        vendedores = [];
    }

    res.render('vendedores/index', {
        title: 'Vendedores',
        vendedores,
        busca,
        pagina,
        totalPaginas,
        mensagem: req.query.mensagem || null,
        erro: req.query.erro || null
    });
});

// GET /novo - Formulário de novo vendedor
router.get('/novo', (req, res) => {
    res.render('vendedores/form', {
        title: 'Novo Vendedor',
        vendedor: null,
        erro: null
    });
});

// POST /novo - Criar vendedor
router.post('/novo', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const { nome, cpf, telefone, email, comissao_percentual, meta_mensal, ativo } = req.body;

    try {
        db.prepare(`
            INSERT INTO vendedores (empresa_id, nome, cpf, telefone, email, comissao_percentual, meta_mensal, ativo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            empresaId,
            nome,
            cpf || null,
            telefone || null,
            email || null,
            parseFloat(comissao_percentual) || 0,
            parseFloat(meta_mensal) || 0,
            ativo ? 1 : 0
        );

        res.redirect('/vendedores?mensagem=' + encodeURIComponent('Vendedor cadastrado com sucesso!'));
    } catch (e) {
        res.render('vendedores/form', {
            title: 'Novo Vendedor',
            vendedor: req.body,
            erro: 'Erro ao cadastrar vendedor: ' + e.message
        });
    }
});

// GET /editar/:id - Formulário de edição
router.get('/editar/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;

    const vendedor = db.prepare('SELECT * FROM vendedores WHERE id = ? AND empresa_id = ?').get(req.params.id, empresaId);
    if (!vendedor) {
        return res.redirect('/vendedores?erro=' + encodeURIComponent('Vendedor não encontrado'));
    }

    res.render('vendedores/form', {
        title: 'Editar Vendedor',
        vendedor,
        erro: null
    });
});

// POST /editar/:id - Atualizar vendedor
router.post('/editar/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const { nome, cpf, telefone, email, comissao_percentual, meta_mensal, ativo } = req.body;

    try {
        const result = db.prepare(`
            UPDATE vendedores
            SET nome = ?, cpf = ?, telefone = ?, email = ?, comissao_percentual = ?, meta_mensal = ?, ativo = ?
            WHERE id = ? AND empresa_id = ?
        `).run(
            nome,
            cpf || null,
            telefone || null,
            email || null,
            parseFloat(comissao_percentual) || 0,
            parseFloat(meta_mensal) || 0,
            ativo ? 1 : 0,
            req.params.id,
            empresaId
        );

        if (result.changes === 0) {
            return res.redirect('/vendedores?erro=' + encodeURIComponent('Vendedor não encontrado'));
        }

        res.redirect('/vendedores?mensagem=' + encodeURIComponent('Vendedor atualizado com sucesso!'));
    } catch (e) {
        res.render('vendedores/form', {
            title: 'Editar Vendedor',
            vendedor: { id: req.params.id, ...req.body },
            erro: 'Erro ao atualizar vendedor: ' + e.message
        });
    }
});

// GET /excluir/:id - Soft delete
router.get('/excluir/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;

    try {
        const result = db.prepare('UPDATE vendedores SET ativo = 0 WHERE id = ? AND empresa_id = ?').run(req.params.id, empresaId);

        if (result.changes === 0) {
            return res.redirect('/vendedores?erro=' + encodeURIComponent('Vendedor não encontrado'));
        }

        res.redirect('/vendedores?mensagem=' + encodeURIComponent('Vendedor desativado com sucesso!'));
    } catch (e) {
        res.redirect('/vendedores?erro=' + encodeURIComponent('Erro ao desativar vendedor: ' + e.message));
    }
});

module.exports = router;
