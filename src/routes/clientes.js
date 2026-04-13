const express = require('express');
const router = express.Router();
const db = require('../../config/database');

// GET / - Listar clientes com busca e paginacao
router.get('/', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const busca = req.query.busca || '';
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    let where = 'WHERE empresa_id = ?';
    const params = [empresaId];

    if (busca) {
        where += ' AND (nome LIKE ? OR cpf_cnpj LIKE ?)';
        params.push(`%${busca}%`, `%${busca}%`);
    }

    const total = db.prepare(`SELECT COUNT(*) as total FROM clientes ${where}`).get(...params).total;
    const totalPages = Math.ceil(total / limit);

    const clientes = db.prepare(`
        SELECT * FROM clientes ${where}
        ORDER BY nome ASC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.render('clientes/index', {
        title: 'Clientes',
        clientes,
        busca,
        page,
        totalPages,
        total,
        msg: req.query.msg || null
    });
});

// GET /novo - Formulario de criacao
router.get('/novo', (req, res) => {
    res.render('clientes/form', {
        title: 'Novo Cliente',
        cliente: {},
        erro: null
    });
});

// POST /novo - Criar cliente
router.post('/novo', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const {
        tipo_pessoa, nome, cpf_cnpj, rg_ie, email, telefone, celular,
        endereco, numero, complemento, bairro, cidade, estado, cep,
        limite_credito, observacoes
    } = req.body;

    if (!nome || !nome.trim()) {
        return res.render('clientes/form', {
            title: 'Novo Cliente',
            cliente: req.body,
            erro: 'O nome do cliente e obrigatorio.'
        });
    }

    try {
        db.prepare(`
            INSERT INTO clientes (
                empresa_id, tipo_pessoa, nome, cpf_cnpj, rg_ie, email, telefone, celular,
                endereco, numero, complemento, bairro, cidade, estado, cep,
                limite_credito, observacoes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            empresaId,
            tipo_pessoa || 'PF',
            nome.trim(),
            cpf_cnpj || null,
            rg_ie || null,
            email || null,
            telefone || null,
            celular || null,
            endereco || null,
            numero || null,
            complemento || null,
            bairro || null,
            cidade || null,
            estado || null,
            cep || null,
            parseFloat(limite_credito) || 0,
            observacoes || null
        );

        res.redirect('/clientes?msg=Cliente cadastrado com sucesso!');
    } catch (err) {
        console.error('Erro ao criar cliente:', err);
        res.render('clientes/form', {
            title: 'Novo Cliente',
            cliente: req.body,
            erro: 'Erro ao cadastrar cliente. Tente novamente.'
        });
    }
});

// GET /editar/:id - Formulario de edicao
router.get('/editar/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ? AND empresa_id = ?').get(req.params.id, empresaId);

    if (!cliente) {
        return res.redirect('/clientes?msg=Cliente nao encontrado.');
    }

    res.render('clientes/form', {
        title: 'Editar Cliente',
        cliente,
        erro: null
    });
});

// POST /editar/:id - Atualizar cliente
router.post('/editar/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const {
        tipo_pessoa, nome, cpf_cnpj, rg_ie, email, telefone, celular,
        endereco, numero, complemento, bairro, cidade, estado, cep,
        limite_credito, observacoes
    } = req.body;

    if (!nome || !nome.trim()) {
        return res.render('clientes/form', {
            title: 'Editar Cliente',
            cliente: { ...req.body, id: req.params.id },
            erro: 'O nome do cliente e obrigatorio.'
        });
    }

    try {
        const result = db.prepare(`
            UPDATE clientes SET
                tipo_pessoa = ?, nome = ?, cpf_cnpj = ?, rg_ie = ?, email = ?,
                telefone = ?, celular = ?, endereco = ?, numero = ?, complemento = ?,
                bairro = ?, cidade = ?, estado = ?, cep = ?,
                limite_credito = ?, observacoes = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND empresa_id = ?
        `).run(
            tipo_pessoa || 'PF',
            nome.trim(),
            cpf_cnpj || null,
            rg_ie || null,
            email || null,
            telefone || null,
            celular || null,
            endereco || null,
            numero || null,
            complemento || null,
            bairro || null,
            cidade || null,
            estado || null,
            cep || null,
            parseFloat(limite_credito) || 0,
            observacoes || null,
            req.params.id,
            empresaId
        );

        if (result.changes === 0) {
            return res.redirect('/clientes?msg=Cliente nao encontrado.');
        }

        res.redirect('/clientes?msg=Cliente atualizado com sucesso!');
    } catch (err) {
        console.error('Erro ao atualizar cliente:', err);
        res.render('clientes/form', {
            title: 'Editar Cliente',
            cliente: { ...req.body, id: req.params.id },
            erro: 'Erro ao atualizar cliente. Tente novamente.'
        });
    }
});

// GET /excluir/:id - Soft delete
router.get('/excluir/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;

    try {
        db.prepare('UPDATE clientes SET ativo = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND empresa_id = ?')
            .run(req.params.id, empresaId);
        res.redirect('/clientes?msg=Cliente excluido com sucesso!');
    } catch (err) {
        console.error('Erro ao excluir cliente:', err);
        res.redirect('/clientes?msg=Erro ao excluir cliente.');
    }
});

module.exports = router;
