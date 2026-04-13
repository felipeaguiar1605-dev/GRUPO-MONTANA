const express = require('express');
const router = express.Router();
const db = require('../../config/database');

// GET / - Visao geral financeira
router.get('/', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const hoje = new Date().toISOString().split('T')[0];

    // Atualizar status de contas vencidas
    try {
        db.prepare(`
            UPDATE contas_pagar SET status = 'vencida'
            WHERE empresa_id = ? AND status = 'pendente' AND data_vencimento < ?
        `).run(empresaId, hoje);
        db.prepare(`
            UPDATE contas_receber SET status = 'vencida'
            WHERE empresa_id = ? AND status = 'pendente' AND data_vencimento < ?
        `).run(empresaId, hoje);
    } catch (e) { /* ignore */ }

    // Total a pagar
    const totalPagar = db.prepare(`
        SELECT COALESCE(SUM(valor), 0) AS total, COUNT(*) AS count
        FROM contas_pagar WHERE empresa_id = ? AND status IN ('pendente', 'vencida')
    `).get(empresaId);

    // Total a receber
    const totalReceber = db.prepare(`
        SELECT COALESCE(SUM(valor), 0) AS total, COUNT(*) AS count
        FROM contas_receber WHERE empresa_id = ? AND status IN ('pendente', 'vencida')
    `).get(empresaId);

    // Vencidas a pagar
    const vencidasPagar = db.prepare(`
        SELECT COALESCE(SUM(valor), 0) AS total, COUNT(*) AS count
        FROM contas_pagar WHERE empresa_id = ? AND status = 'vencida'
    `).get(empresaId);

    // Vencidas a receber
    const vencidasReceber = db.prepare(`
        SELECT COALESCE(SUM(valor), 0) AS total, COUNT(*) AS count
        FROM contas_receber WHERE empresa_id = ? AND status = 'vencida'
    `).get(empresaId);

    // Saldo
    const saldo = totalReceber.total - totalPagar.total;

    // Proximas contas a pagar (7 dias)
    const proxSemana = new Date();
    proxSemana.setDate(proxSemana.getDate() + 7);
    const proxSemanaStr = proxSemana.toISOString().split('T')[0];

    const proximasPagar = db.prepare(`
        SELECT cp.*, f.razao_social AS fornecedor_nome
        FROM contas_pagar cp
        LEFT JOIN fornecedores f ON f.id = cp.fornecedor_id
        WHERE cp.empresa_id = ? AND cp.status IN ('pendente', 'vencida')
          AND cp.data_vencimento <= ?
        ORDER BY cp.data_vencimento ASC
        LIMIT 10
    `).all(empresaId, proxSemanaStr);

    // Proximas contas a receber (7 dias)
    const proximasReceber = db.prepare(`
        SELECT cr.*, c.nome AS cliente_nome
        FROM contas_receber cr
        LEFT JOIN clientes c ON c.id = cr.cliente_id
        WHERE cr.empresa_id = ? AND cr.status IN ('pendente', 'vencida')
          AND cr.data_vencimento <= ?
        ORDER BY cr.data_vencimento ASC
        LIMIT 10
    `).all(empresaId, proxSemanaStr);

    res.render('financeiro/index', {
        title: 'Financeiro',
        resumo: {
            total_pagar: totalPagar.total,
            total_receber: totalReceber.total,
            vencidas_pagar: vencidasPagar.count,
            vencidas_receber: vencidasReceber.count,
            saldo: saldo
        },
        proximosPagar: proximasPagar,
        proximosReceber: proximasReceber,
        msg: req.query.msg || null
    });
});

// GET /pagar - Lista de contas a pagar
router.get('/pagar', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const pagina = parseInt(req.query.pagina) || 1;
    const limit = 20;
    const offset = (pagina - 1) * limit;

    const { status, data_inicio, data_fim, fornecedor_id } = req.query;

    let where = 'WHERE cp.empresa_id = ?';
    const params = [empresaId];

    if (status) {
        where += ' AND cp.status = ?';
        params.push(status);
    }
    if (data_inicio) {
        where += ' AND cp.data_vencimento >= ?';
        params.push(data_inicio);
    }
    if (data_fim) {
        where += ' AND cp.data_vencimento <= ?';
        params.push(data_fim);
    }
    if (fornecedor_id) {
        where += ' AND cp.fornecedor_id = ?';
        params.push(parseInt(fornecedor_id));
    }

    const total = db.prepare(`SELECT COUNT(*) as total FROM contas_pagar cp ${where}`).get(...params).total;
    const totalPaginas = Math.ceil(total / limit);

    const contas = db.prepare(`
        SELECT cp.*, f.razao_social AS fornecedor_nome
        FROM contas_pagar cp
        LEFT JOIN fornecedores f ON f.id = cp.fornecedor_id
        ${where}
        ORDER BY cp.data_vencimento ASC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const fornecedores = db.prepare(
        'SELECT id, razao_social FROM fornecedores WHERE empresa_id = ? AND ativo = 1 ORDER BY razao_social'
    ).all(empresaId);

    res.render('financeiro/pagar', {
        title: 'Contas a Pagar',
        contas,
        fornecedores,
        filtros: { status, data_inicio, data_fim, fornecedor_id },
        pagina,
        totalPaginas,
        total,
        msg: req.query.msg || null,
        erro: req.query.erro || null
    });
});

// GET /pagar/nova - Form nova conta a pagar
router.get('/pagar/nova', (req, res) => {
    const empresaId = req.session.empresaAtual.id;

    const fornecedores = db.prepare(
        'SELECT id, razao_social, nome_fantasia FROM fornecedores WHERE empresa_id = ? AND ativo = 1 ORDER BY razao_social'
    ).all(empresaId);

    res.render('financeiro/pagar-form', {
        title: 'Nova Conta a Pagar',
        conta: null,
        fornecedores,
        erro: req.query.erro || null
    });
});

// POST /pagar/nova - Criar conta a pagar
router.post('/pagar/nova', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const {
        fornecedor_id, descricao, categoria, valor, data_emissao,
        data_vencimento, forma_pagamento, parcelas, observacoes
    } = req.body;

    if (!descricao || !valor || !data_vencimento) {
        return res.redirect('/financeiro/pagar/nova?erro=Preencha+os+campos+obrigatorios');
    }

    try {
        const numParcelas = parseInt(parcelas) || 1;
        const valorTotal = parseFloat(valor);
        const valorParcela = valorTotal / numParcelas;
        const dataBase = data_vencimento ? new Date(data_vencimento + 'T00:00:00') : new Date();

        const insertConta = db.prepare(`
            INSERT INTO contas_pagar (
                empresa_id, fornecedor_id, descricao, categoria, valor,
                data_emissao, data_vencimento, forma_pagamento,
                parcela, total_parcelas, status, observacoes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?)
        `);

        const inserir = db.transaction(() => {
            for (let p = 0; p < numParcelas; p++) {
                const vencimento = new Date(dataBase);
                if (p > 0) vencimento.setDate(vencimento.getDate() + (30 * p));
                const vencStr = vencimento.toISOString().split('T')[0];

                insertConta.run(
                    empresaId,
                    fornecedor_id ? parseInt(fornecedor_id) : null,
                    numParcelas > 1 ? `${descricao} - ${p + 1}/${numParcelas}` : descricao,
                    categoria || null,
                    Math.round(valorParcela * 100) / 100,
                    data_emissao || new Date().toISOString().split('T')[0],
                    vencStr,
                    forma_pagamento || null,
                    p + 1,
                    numParcelas,
                    observacoes || null
                );
            }
        });

        inserir();
        res.redirect('/financeiro/pagar?msg=Conta+a+pagar+criada+com+sucesso');
    } catch (err) {
        console.error('Erro ao criar conta a pagar:', err);
        res.redirect('/financeiro/pagar/nova?erro=Erro+ao+criar+conta+a+pagar');
    }
});

// POST /pagar/baixa/:id - Dar baixa em conta a pagar
router.post('/pagar/baixa/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const usuarioId = req.session.usuario.id;
    const contaId = parseInt(req.params.id);
    const { valor_pago, data_pagamento, forma_pagamento } = req.body;

    try {
        const conta = db.prepare(
            'SELECT * FROM contas_pagar WHERE id = ? AND empresa_id = ? AND status IN (?, ?)'
        ).get(contaId, empresaId, 'pendente', 'vencida');

        if (!conta) {
            return res.redirect('/financeiro/pagar?erro=Conta+nao+encontrada+ou+ja+paga');
        }

        const baixa = db.transaction(() => {
            const pago = parseFloat(valor_pago) || conta.valor;
            const dataPag = data_pagamento || new Date().toISOString().split('T')[0];

            db.prepare(`
                UPDATE contas_pagar SET
                    status = 'paga', valor_pago = ?, data_pagamento = ?,
                    forma_pagamento = COALESCE(?, forma_pagamento)
                WHERE id = ?
            `).run(pago, dataPag, forma_pagamento || null, contaId);

            // Criar entrada no fluxo de caixa
            db.prepare(`
                INSERT INTO fluxo_caixa (
                    empresa_id, tipo, categoria, descricao, valor,
                    data_movimento, forma_pagamento, documento_tipo, documento_id, usuario_id
                ) VALUES (?, 'saida', ?, ?, ?, ?, ?, 'conta_pagar', ?, ?)
            `).run(
                empresaId,
                conta.categoria || 'contas_pagar',
                conta.descricao,
                pago,
                dataPag,
                forma_pagamento || conta.forma_pagamento || 'dinheiro',
                contaId,
                usuarioId
            );
        });

        baixa();
        res.redirect('/financeiro/pagar?msg=Pagamento+registrado+com+sucesso');
    } catch (err) {
        console.error('Erro ao dar baixa:', err);
        res.redirect('/financeiro/pagar?erro=Erro+ao+registrar+pagamento');
    }
});

// GET /receber - Lista de contas a receber
router.get('/receber', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const pagina = parseInt(req.query.pagina) || 1;
    const limit = 20;
    const offset = (pagina - 1) * limit;

    const { status, data_inicio, data_fim, cliente_id } = req.query;

    let where = 'WHERE cr.empresa_id = ?';
    const params = [empresaId];

    if (status) {
        where += ' AND cr.status = ?';
        params.push(status);
    }
    if (data_inicio) {
        where += ' AND cr.data_vencimento >= ?';
        params.push(data_inicio);
    }
    if (data_fim) {
        where += ' AND cr.data_vencimento <= ?';
        params.push(data_fim);
    }
    if (cliente_id) {
        where += ' AND cr.cliente_id = ?';
        params.push(parseInt(cliente_id));
    }

    const total = db.prepare(`SELECT COUNT(*) as total FROM contas_receber cr ${where}`).get(...params).total;
    const totalPaginas = Math.ceil(total / limit);

    const contas = db.prepare(`
        SELECT cr.*, c.nome AS cliente_nome
        FROM contas_receber cr
        LEFT JOIN clientes c ON c.id = cr.cliente_id
        ${where}
        ORDER BY cr.data_vencimento ASC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const clientes = db.prepare(
        'SELECT id, nome FROM clientes WHERE empresa_id = ? AND ativo = 1 ORDER BY nome'
    ).all(empresaId);

    res.render('financeiro/receber', {
        title: 'Contas a Receber',
        contas,
        clientes,
        filtros: { status, data_inicio, data_fim, cliente_id },
        pagina,
        totalPaginas,
        total,
        msg: req.query.msg || null,
        erro: req.query.erro || null
    });
});

// GET /receber/nova - Form nova conta a receber
router.get('/receber/nova', (req, res) => {
    const empresaId = req.session.empresaAtual.id;

    const clientes = db.prepare(
        'SELECT id, nome FROM clientes WHERE empresa_id = ? AND ativo = 1 ORDER BY nome'
    ).all(empresaId);

    res.render('financeiro/receber-form', {
        title: 'Nova Conta a Receber',
        conta: null,
        clientes,
        erro: req.query.erro || null
    });
});

// POST /receber/nova - Criar conta a receber
router.post('/receber/nova', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const {
        cliente_id, descricao, categoria, valor, data_emissao,
        data_vencimento, forma_pagamento, parcelas, observacoes
    } = req.body;

    if (!descricao || !valor || !data_vencimento) {
        return res.redirect('/financeiro/receber/nova?erro=Preencha+os+campos+obrigatorios');
    }

    try {
        const numParcelas = parseInt(parcelas) || 1;
        const valorTotal = parseFloat(valor);
        const valorParcela = valorTotal / numParcelas;
        const dataBase = data_vencimento ? new Date(data_vencimento + 'T00:00:00') : new Date();

        const insertConta = db.prepare(`
            INSERT INTO contas_receber (
                empresa_id, cliente_id, descricao, categoria, valor,
                data_emissao, data_vencimento, forma_pagamento,
                parcela, total_parcelas, status, observacoes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?)
        `);

        const inserir = db.transaction(() => {
            for (let p = 0; p < numParcelas; p++) {
                const vencimento = new Date(dataBase);
                if (p > 0) vencimento.setDate(vencimento.getDate() + (30 * p));
                const vencStr = vencimento.toISOString().split('T')[0];

                insertConta.run(
                    empresaId,
                    cliente_id ? parseInt(cliente_id) : null,
                    numParcelas > 1 ? `${descricao} - ${p + 1}/${numParcelas}` : descricao,
                    categoria || null,
                    Math.round(valorParcela * 100) / 100,
                    data_emissao || new Date().toISOString().split('T')[0],
                    vencStr,
                    forma_pagamento || null,
                    p + 1,
                    numParcelas,
                    observacoes || null
                );
            }
        });

        inserir();
        res.redirect('/financeiro/receber?msg=Conta+a+receber+criada+com+sucesso');
    } catch (err) {
        console.error('Erro ao criar conta a receber:', err);
        res.redirect('/financeiro/receber/nova?erro=Erro+ao+criar+conta+a+receber');
    }
});

// POST /receber/baixa/:id - Dar baixa em conta a receber
router.post('/receber/baixa/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const usuarioId = req.session.usuario.id;
    const contaId = parseInt(req.params.id);
    const { valor_recebido, data_recebimento, forma_pagamento } = req.body;

    try {
        const conta = db.prepare(
            'SELECT * FROM contas_receber WHERE id = ? AND empresa_id = ? AND status IN (?, ?)'
        ).get(contaId, empresaId, 'pendente', 'vencida');

        if (!conta) {
            return res.redirect('/financeiro/receber?erro=Conta+nao+encontrada+ou+ja+recebida');
        }

        const baixa = db.transaction(() => {
            const recebido = parseFloat(valor_recebido) || conta.valor;
            const dataRec = data_recebimento || new Date().toISOString().split('T')[0];

            db.prepare(`
                UPDATE contas_receber SET
                    status = 'recebida', valor_recebido = ?, data_recebimento = ?,
                    forma_pagamento = COALESCE(?, forma_pagamento)
                WHERE id = ?
            `).run(recebido, dataRec, forma_pagamento || null, contaId);

            // Criar entrada no fluxo de caixa
            db.prepare(`
                INSERT INTO fluxo_caixa (
                    empresa_id, tipo, categoria, descricao, valor,
                    data_movimento, forma_pagamento, documento_tipo, documento_id, usuario_id
                ) VALUES (?, 'entrada', ?, ?, ?, ?, ?, 'conta_receber', ?, ?)
            `).run(
                empresaId,
                conta.categoria || 'contas_receber',
                conta.descricao,
                recebido,
                dataRec,
                forma_pagamento || conta.forma_pagamento || 'dinheiro',
                contaId,
                usuarioId
            );
        });

        baixa();
        res.redirect('/financeiro/receber?msg=Recebimento+registrado+com+sucesso');
    } catch (err) {
        console.error('Erro ao dar baixa:', err);
        res.redirect('/financeiro/receber?erro=Erro+ao+registrar+recebimento');
    }
});

// GET /fluxo - Fluxo de caixa
router.get('/fluxo', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const pagina = parseInt(req.query.pagina) || 1;
    const limit = 20;
    const offset = (pagina - 1) * limit;

    const { data_inicio, data_fim, tipo } = req.query;

    let where = 'WHERE fc.empresa_id = ?';
    const params = [empresaId];

    if (data_inicio) {
        where += ' AND fc.data_movimento >= ?';
        params.push(data_inicio);
    }
    if (data_fim) {
        where += ' AND fc.data_movimento <= ?';
        params.push(data_fim);
    }
    if (tipo) {
        where += ' AND fc.tipo = ?';
        params.push(tipo);
    }

    const total = db.prepare(`SELECT COUNT(*) as total FROM fluxo_caixa fc ${where}`).get(...params).total;
    const totalPaginas = Math.ceil(total / limit);

    const movimentos = db.prepare(`
        SELECT fc.*, u.nome AS usuario_nome
        FROM fluxo_caixa fc
        LEFT JOIN usuarios u ON u.id = fc.usuario_id
        ${where}
        ORDER BY fc.data_movimento DESC, fc.id DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    // Totais
    const totais = db.prepare(`
        SELECT
            COALESCE(SUM(CASE WHEN fc.tipo = 'entrada' THEN fc.valor ELSE 0 END), 0) AS total_entradas,
            COALESCE(SUM(CASE WHEN fc.tipo = 'saida' THEN fc.valor ELSE 0 END), 0) AS total_saidas
        FROM fluxo_caixa fc ${where}
    `).get(...params);

    res.render('financeiro/fluxo', {
        title: 'Fluxo de Caixa',
        movimentos,
        totais,
        filtros: { data_inicio, data_fim, tipo },
        pagina,
        totalPaginas,
        total
    });
});

module.exports = router;
