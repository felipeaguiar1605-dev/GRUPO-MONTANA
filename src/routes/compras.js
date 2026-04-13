const express = require('express');
const router = express.Router();
const db = require('../../config/database');

// GET / - Listar compras com filtros e paginacao
router.get('/', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const offset = (page - 1) * limit;

    const { data_inicio, data_fim, fornecedor_id, status } = req.query;

    let where = 'WHERE c.empresa_id = ?';
    const params = [empresaId];

    if (data_inicio) {
        where += ' AND c.data_compra >= ?';
        params.push(data_inicio);
    }
    if (data_fim) {
        where += ' AND c.data_compra <= ?';
        params.push(data_fim + ' 23:59:59');
    }
    if (fornecedor_id) {
        where += ' AND c.fornecedor_id = ?';
        params.push(parseInt(fornecedor_id));
    }
    if (status) {
        where += ' AND c.status = ?';
        params.push(status);
    }

    const total = db.prepare(`SELECT COUNT(*) as total FROM compras c ${where}`).get(...params).total;
    const totalPages = Math.ceil(total / limit);

    const compras = db.prepare(`
        SELECT c.*, f.razao_social AS fornecedor_nome, f.nome_fantasia AS fornecedor_fantasia
        FROM compras c
        LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
        ${where}
        ORDER BY c.data_compra DESC
        LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const fornecedores = db.prepare(
        'SELECT id, razao_social, nome_fantasia FROM fornecedores WHERE empresa_id = ? AND ativo = 1 ORDER BY razao_social'
    ).all(empresaId);

    res.render('compras/index', {
        title: 'Compras',
        compras,
        fornecedores,
        filtros: { data_inicio, data_fim, fornecedor_id, status },
        page,
        totalPages,
        total,
        msg: req.query.msg || null,
        erro: req.query.erro || null
    });
});

// GET /nova - Formulario de nova compra
router.get('/nova', (req, res) => {
    const empresaId = req.session.empresaAtual.id;

    const fornecedores = db.prepare(
        'SELECT id, razao_social, nome_fantasia FROM fornecedores WHERE empresa_id = ? AND ativo = 1 ORDER BY razao_social'
    ).all(empresaId);

    const produtos = db.prepare(
        'SELECT id, codigo, nome, preco_custo, preco_venda FROM produtos WHERE empresa_id = ? AND ativo = 1 ORDER BY nome'
    ).all(empresaId);

    res.render('compras/form', {
        title: 'Nova Compra',
        compra: null,
        fornecedores,
        produtos,
        erro: req.query.erro || null
    });
});

// POST /nova - Criar compra
router.post('/nova', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const usuarioId = req.session.usuario.id;
    const {
        fornecedor_id, data_compra, data_entrega, forma_pagamento, parcelas,
        status, observacoes, nfe_chave, frete, desconto,
        produto_id, quantidade, preco_unitario, desconto_item
    } = req.body;

    if (!fornecedor_id) {
        return res.redirect('/compras/nova?erro=Selecione+um+fornecedor');
    }

    // Normalizar itens para arrays
    const produtoIds = Array.isArray(produto_id) ? produto_id : (produto_id ? [produto_id] : []);
    const quantidades = Array.isArray(quantidade) ? quantidade : (quantidade ? [quantidade] : []);
    const precos = Array.isArray(preco_unitario) ? preco_unitario : (preco_unitario ? [preco_unitario] : []);
    const descontos = Array.isArray(desconto_item) ? desconto_item : (desconto_item ? [desconto_item] : []);

    if (produtoIds.length === 0) {
        return res.redirect('/compras/nova?erro=Adicione+pelo+menos+um+item');
    }

    try {
        const inserirCompra = db.transaction(() => {
            // Calcular subtotal
            let subtotal = 0;
            const itens = [];
            for (let i = 0; i < produtoIds.length; i++) {
                if (!produtoIds[i]) continue;
                const qty = parseFloat(quantidades[i]) || 0;
                const preco = parseFloat(precos[i]) || 0;
                const desc = parseFloat(descontos[i]) || 0;
                const totalItem = (qty * preco) - desc;
                subtotal += totalItem;
                itens.push({
                    produto_id: parseInt(produtoIds[i]),
                    quantidade: qty,
                    preco_unitario: preco,
                    desconto: desc,
                    total: totalItem
                });
            }

            const freteVal = parseFloat(frete) || 0;
            const descontoVal = parseFloat(desconto) || 0;
            const totalCompra = subtotal - descontoVal + freteVal;

            // Gerar numero
            const hoje = new Date();
            const dataStr = hoje.getFullYear().toString() +
                String(hoje.getMonth() + 1).padStart(2, '0') +
                String(hoje.getDate()).padStart(2, '0');

            const seqRow = db.prepare(`
                SELECT COUNT(*) + 1 AS seq FROM compras
                WHERE empresa_id = ? AND numero LIKE ?
            `).get(empresaId, `CP-${dataStr}-%`);
            const numero = `CP-${dataStr}-${String(seqRow.seq).padStart(3, '0')}`;

            // Inserir compra
            const result = db.prepare(`
                INSERT INTO compras (
                    empresa_id, numero, fornecedor_id, usuario_id, data_compra, data_entrega,
                    subtotal, desconto, frete, total, forma_pagamento, parcelas,
                    status, observacoes, nfe_chave
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                empresaId, numero, parseInt(fornecedor_id), usuarioId,
                data_compra || new Date().toISOString().split('T')[0],
                data_entrega || null,
                subtotal, descontoVal, freteVal, totalCompra,
                forma_pagamento || 'boleto',
                parseInt(parcelas) || 1,
                status || 'pedido',
                observacoes || null,
                nfe_chave || null
            );
            const compraId = result.lastInsertRowid;

            // Inserir itens
            const insertItem = db.prepare(`
                INSERT INTO compra_itens (compra_id, produto_id, quantidade, preco_unitario, desconto, total)
                VALUES (?, ?, ?, ?, ?, ?)
            `);
            for (const item of itens) {
                insertItem.run(compraId, item.produto_id, item.quantidade, item.preco_unitario, item.desconto, item.total);
            }

            // Se status = recebida, atualizar estoque
            const statusFinal = status || 'pedido';
            if (statusFinal === 'recebida') {
                atualizarEstoqueRecebimento(empresaId, usuarioId, compraId, itens);
            }

            // Criar contas a pagar
            const numParcelas = parseInt(parcelas) || 1;
            const valorParcela = totalCompra / numParcelas;
            const dataBase = data_compra ? new Date(data_compra + 'T00:00:00') : new Date();

            const insertConta = db.prepare(`
                INSERT INTO contas_pagar (
                    empresa_id, fornecedor_id, compra_id, descricao, categoria,
                    valor, data_emissao, data_vencimento, forma_pagamento,
                    parcela, total_parcelas, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            for (let p = 0; p < numParcelas; p++) {
                const vencimento = new Date(dataBase);
                vencimento.setDate(vencimento.getDate() + (30 * (p + 1)));
                const vencStr = vencimento.toISOString().split('T')[0];

                insertConta.run(
                    empresaId,
                    parseInt(fornecedor_id),
                    compraId,
                    `Compra ${numero} - Parcela ${p + 1}/${numParcelas}`,
                    'compras',
                    Math.round(valorParcela * 100) / 100,
                    (data_compra || new Date().toISOString().split('T')[0]),
                    vencStr,
                    forma_pagamento || 'boleto',
                    p + 1,
                    numParcelas,
                    'pendente'
                );
            }

            // Criar fluxo de caixa
            db.prepare(`
                INSERT INTO fluxo_caixa (
                    empresa_id, tipo, categoria, descricao, valor,
                    data_movimento, forma_pagamento, documento_tipo, documento_id, usuario_id
                ) VALUES (?, 'saida', 'compras', ?, ?, ?, ?, 'compra', ?, ?)
            `).run(
                empresaId,
                `Compra ${numero}`,
                totalCompra,
                data_compra || new Date().toISOString().split('T')[0],
                forma_pagamento || 'boleto',
                compraId,
                usuarioId
            );

            return compraId;
        });

        inserirCompra();
        res.redirect('/compras?msg=Compra+registrada+com+sucesso');
    } catch (err) {
        console.error('Erro ao criar compra:', err);
        res.redirect('/compras/nova?erro=Erro+ao+registrar+compra');
    }
});

// GET /ver/:id - Ver detalhes da compra
router.get('/ver/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const compraId = parseInt(req.params.id);

    const compra = db.prepare(`
        SELECT c.*, f.razao_social AS fornecedor_nome, f.nome_fantasia AS fornecedor_fantasia,
               f.cnpj AS fornecedor_cnpj, f.telefone AS fornecedor_telefone,
               u.nome AS usuario_nome
        FROM compras c
        LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
        LEFT JOIN usuarios u ON u.id = c.usuario_id
        WHERE c.id = ? AND c.empresa_id = ?
    `).get(compraId, empresaId);

    if (!compra) {
        return res.redirect('/compras?erro=Compra+nao+encontrada');
    }

    const itens = db.prepare(`
        SELECT ci.*, p.nome AS produto_nome, p.codigo AS produto_codigo
        FROM compra_itens ci
        JOIN produtos p ON p.id = ci.produto_id
        WHERE ci.compra_id = ?
    `).all(compraId);

    const contasPagar = db.prepare(`
        SELECT * FROM contas_pagar
        WHERE compra_id = ? AND empresa_id = ?
        ORDER BY parcela
    `).all(compraId, empresaId);

    res.render('compras/ver', {
        title: `Compra ${compra.numero}`,
        compra,
        itens,
        contasPagar,
        msg: req.query.msg || null
    });
});

// POST /receber/:id - Marcar como recebida
router.post('/receber/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const usuarioId = req.session.usuario.id;
    const compraId = parseInt(req.params.id);

    try {
        const compra = db.prepare(
            'SELECT * FROM compras WHERE id = ? AND empresa_id = ? AND status = ?'
        ).get(compraId, empresaId, 'pedido');

        if (!compra) {
            return res.redirect('/compras?erro=Compra+nao+encontrada+ou+ja+recebida');
        }

        const itens = db.prepare('SELECT * FROM compra_itens WHERE compra_id = ?').all(compraId);

        const receber = db.transaction(() => {
            db.prepare('UPDATE compras SET status = ?, data_entrega = CURRENT_TIMESTAMP WHERE id = ?')
                .run('recebida', compraId);

            atualizarEstoqueRecebimento(empresaId, usuarioId, compraId, itens);
        });

        receber();
        res.redirect(`/compras/ver/${compraId}?msg=Compra+recebida+com+sucesso`);
    } catch (err) {
        console.error('Erro ao receber compra:', err);
        res.redirect(`/compras/ver/${compraId}?erro=Erro+ao+receber+compra`);
    }
});

// GET /cancelar/:id - Cancelar compra
router.get('/cancelar/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const usuarioId = req.session.usuario.id;
    const compraId = parseInt(req.params.id);

    try {
        const compra = db.prepare(
            'SELECT * FROM compras WHERE id = ? AND empresa_id = ? AND status != ?'
        ).get(compraId, empresaId, 'cancelada');

        if (!compra) {
            return res.redirect('/compras?erro=Compra+nao+encontrada+ou+ja+cancelada');
        }

        const cancelar = db.transaction(() => {
            // Se estava recebida, reverter estoque
            if (compra.status === 'recebida') {
                const itens = db.prepare('SELECT * FROM compra_itens WHERE compra_id = ?').all(compraId);
                for (const item of itens) {
                    const estoqueAtual = db.prepare(
                        'SELECT quantidade FROM estoque WHERE empresa_id = ? AND produto_id = ?'
                    ).get(empresaId, item.produto_id);

                    const qtyAnterior = estoqueAtual ? estoqueAtual.quantidade : 0;
                    const qtyPosterior = qtyAnterior - item.quantidade;

                    db.prepare(`
                        UPDATE estoque SET quantidade = ?, updated_at = CURRENT_TIMESTAMP
                        WHERE empresa_id = ? AND produto_id = ?
                    `).run(qtyPosterior, empresaId, item.produto_id);

                    db.prepare(`
                        INSERT INTO estoque_movimentacoes (
                            empresa_id, produto_id, tipo, quantidade, quantidade_anterior,
                            quantidade_posterior, custo_unitario, documento_tipo, documento_id,
                            observacao, usuario_id
                        ) VALUES (?, ?, 'saida', ?, ?, ?, ?, 'compra_cancelamento', ?, ?, ?)
                    `).run(
                        empresaId, item.produto_id, item.quantidade,
                        qtyAnterior, qtyPosterior, item.preco_unitario,
                        compraId, 'Cancelamento da compra ' + compra.numero, usuarioId
                    );
                }
            }

            // Cancelar compra
            db.prepare('UPDATE compras SET status = ? WHERE id = ?').run('cancelada', compraId);

            // Cancelar contas a pagar pendentes
            db.prepare(`
                UPDATE contas_pagar SET status = 'cancelada'
                WHERE compra_id = ? AND empresa_id = ? AND status = 'pendente'
            `).run(compraId, empresaId);
        });

        cancelar();
        res.redirect('/compras?msg=Compra+cancelada+com+sucesso');
    } catch (err) {
        console.error('Erro ao cancelar compra:', err);
        res.redirect('/compras?erro=Erro+ao+cancelar+compra');
    }
});

// Funcao auxiliar para atualizar estoque no recebimento
function atualizarEstoqueRecebimento(empresaId, usuarioId, compraId, itens) {
    for (const item of itens) {
        // Garantir registro de estoque existe
        db.prepare(`
            INSERT OR IGNORE INTO estoque (empresa_id, produto_id, quantidade)
            VALUES (?, ?, 0)
        `).run(empresaId, item.produto_id);

        const estoqueAtual = db.prepare(
            'SELECT quantidade FROM estoque WHERE empresa_id = ? AND produto_id = ?'
        ).get(empresaId, item.produto_id);

        const qtyAnterior = estoqueAtual ? estoqueAtual.quantidade : 0;
        const qtyPosterior = qtyAnterior + item.quantidade;

        db.prepare(`
            UPDATE estoque SET quantidade = ?, updated_at = CURRENT_TIMESTAMP
            WHERE empresa_id = ? AND produto_id = ?
        `).run(qtyPosterior, empresaId, item.produto_id);

        db.prepare(`
            INSERT INTO estoque_movimentacoes (
                empresa_id, produto_id, tipo, quantidade, quantidade_anterior,
                quantidade_posterior, custo_unitario, documento_tipo, documento_id,
                observacao, usuario_id
            ) VALUES (?, ?, 'entrada', ?, ?, ?, ?, 'compra', ?, ?, ?)
        `).run(
            empresaId, item.produto_id, item.quantidade,
            qtyAnterior, qtyPosterior, item.preco_unitario,
            compraId, 'Recebimento de compra', usuarioId
        );

        // Atualizar preco de custo do produto
        db.prepare('UPDATE produtos SET preco_custo = ? WHERE id = ? AND empresa_id = ?')
            .run(item.preco_unitario, item.produto_id, empresaId);
    }
}

module.exports = router;
