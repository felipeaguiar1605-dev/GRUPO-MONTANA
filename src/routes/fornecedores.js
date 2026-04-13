const express = require('express');
const router = express.Router();
const db = require('../../config/database');

// GET / - Listar fornecedores com busca e paginacao
router.get('/', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const busca = req.query.busca || '';
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    let where = 'WHERE empresa_id = ?';
    const params = [empresaId];

    if (busca) {
        where += ' AND (razao_social LIKE ? OR nome_fantasia LIKE ? OR cnpj LIKE ?)';
        params.push(`%${busca}%`, `%${busca}%`, `%${busca}%`);
    }

    const total = db.prepare(`SELECT COUNT(*) as total FROM fornecedores ${where}`).get(...params).total;
    const totalPages = Math.ceil(total / limit);

    const fornecedores = db.prepare(`
        SELECT * FROM fornecedores ${where}
        ORDER BY razao_social ASC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.render('fornecedores/index', {
        title: 'Fornecedores',
        fornecedores,
        busca,
        page,
        totalPages,
        total,
        msg: req.query.msg || null
    });
});

// GET /novo - Formulario de criacao
router.get('/novo', (req, res) => {
    res.render('fornecedores/form', {
        title: 'Novo Fornecedor',
        fornecedor: {},
        erro: null
    });
});

// POST /novo - Criar fornecedor
router.post('/novo', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const {
        razao_social, nome_fantasia, cnpj, inscricao_estadual, contato, email,
        telefone, celular, endereco, numero, complemento, bairro, cidade, estado, cep,
        prazo_entrega, condicao_pagamento, observacoes
    } = req.body;

    if (!razao_social || !razao_social.trim()) {
        return res.render('fornecedores/form', {
            title: 'Novo Fornecedor',
            fornecedor: req.body,
            erro: 'A razao social e obrigatoria.'
        });
    }

    try {
        db.prepare(`
            INSERT INTO fornecedores (
                empresa_id, razao_social, nome_fantasia, cnpj, inscricao_estadual, contato, email,
                telefone, celular, endereco, numero, complemento, bairro, cidade, estado, cep,
                prazo_entrega, condicao_pagamento, observacoes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            empresaId,
            razao_social.trim(),
            nome_fantasia || null,
            cnpj || null,
            inscricao_estadual || null,
            contato || null,
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
            parseInt(prazo_entrega) || 0,
            condicao_pagamento || null,
            observacoes || null
        );

        res.redirect('/fornecedores?msg=Fornecedor cadastrado com sucesso!');
    } catch (err) {
        console.error('Erro ao criar fornecedor:', err);
        res.render('fornecedores/form', {
            title: 'Novo Fornecedor',
            fornecedor: req.body,
            erro: 'Erro ao cadastrar fornecedor. Tente novamente.'
        });
    }
});

// GET /editar/:id - Formulario de edicao
router.get('/editar/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const fornecedor = db.prepare('SELECT * FROM fornecedores WHERE id = ? AND empresa_id = ?').get(req.params.id, empresaId);

    if (!fornecedor) {
        return res.redirect('/fornecedores?msg=Fornecedor nao encontrado.');
    }

    res.render('fornecedores/form', {
        title: 'Editar Fornecedor',
        fornecedor,
        erro: null
    });
});

// POST /editar/:id - Atualizar fornecedor
router.post('/editar/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const {
        razao_social, nome_fantasia, cnpj, inscricao_estadual, contato, email,
        telefone, celular, endereco, numero, complemento, bairro, cidade, estado, cep,
        prazo_entrega, condicao_pagamento, observacoes
    } = req.body;

    if (!razao_social || !razao_social.trim()) {
        return res.render('fornecedores/form', {
            title: 'Editar Fornecedor',
            fornecedor: { ...req.body, id: req.params.id },
            erro: 'A razao social e obrigatoria.'
        });
    }

    try {
        const result = db.prepare(`
            UPDATE fornecedores SET
                razao_social = ?, nome_fantasia = ?, cnpj = ?, inscricao_estadual = ?,
                contato = ?, email = ?, telefone = ?, celular = ?,
                endereco = ?, numero = ?, complemento = ?, bairro = ?,
                cidade = ?, estado = ?, cep = ?,
                prazo_entrega = ?, condicao_pagamento = ?, observacoes = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND empresa_id = ?
        `).run(
            razao_social.trim(),
            nome_fantasia || null,
            cnpj || null,
            inscricao_estadual || null,
            contato || null,
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
            parseInt(prazo_entrega) || 0,
            condicao_pagamento || null,
            observacoes || null,
            req.params.id,
            empresaId
        );

        if (result.changes === 0) {
            return res.redirect('/fornecedores?msg=Fornecedor nao encontrado.');
        }

        res.redirect('/fornecedores?msg=Fornecedor atualizado com sucesso!');
    } catch (err) {
        console.error('Erro ao atualizar fornecedor:', err);
        res.render('fornecedores/form', {
            title: 'Editar Fornecedor',
            fornecedor: { ...req.body, id: req.params.id },
            erro: 'Erro ao atualizar fornecedor. Tente novamente.'
        });
    }
});

// GET /excluir/:id - Soft delete
router.get('/excluir/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;

    try {
        db.prepare('UPDATE fornecedores SET ativo = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND empresa_id = ?')
            .run(req.params.id, empresaId);
        res.redirect('/fornecedores?msg=Fornecedor excluido com sucesso!');
    } catch (err) {
        console.error('Erro ao excluir fornecedor:', err);
        res.redirect('/fornecedores?msg=Erro ao excluir fornecedor.');
    }
});

module.exports = router;
