const express = require('express');
const router = express.Router();
const db = require('../../config/database');

// GET / - Listar vendas com filtros e paginação
router.get('/', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const page = parseInt(req.query.page) || 1;
    const perPage = 20;
    const offset = (page - 1) * perPage;

    const { date_from, date_to, status, vendedor_id, search } = req.query;

    let whereClauses = ['v.empresa_id = ?'];
    const params = [empresaId];

    if (date_from) {
        whereClauses.push('v.data_venda >= ?');
        params.push(date_from);
    }
    if (date_to) {
        whereClauses.push('v.data_venda <= ?');
        params.push(date_to + ' 23:59:59');
    }
    if (status) {
        whereClauses.push('v.status = ?');
        params.push(status);
    }
    if (vendedor_id) {
        whereClauses.push('v.vendedor_id = ?');
        params.push(vendedor_id);
    }
    if (search) {
        whereClauses.push('(c.nome LIKE ? OR v.numero LIKE ?)');
        const term = `%${search}%`;
        params.push(term, term);
    }

    const whereSQL = whereClauses.join(' AND ');

    // Count total
    let totalRows = 0;
    try {
        const countRow = db.prepare(`
            SELECT COUNT(*) AS total
            FROM vendas v
            LEFT JOIN clientes c ON c.id = v.cliente_id
            WHERE ${whereSQL}
        `).get(...params);
        totalRows = countRow ? countRow.total : 0;
    } catch (e) {
        totalRows = 0;
    }

    const totalPages = Math.ceil(totalRows / perPage) || 1;

    // Fetch vendas
    let vendas = [];
    try {
        vendas = db.prepare(`
            SELECT v.*, c.nome AS cliente_nome, vd.nome AS vendedor_nome
            FROM vendas v
            LEFT JOIN clientes c ON c.id = v.cliente_id
            LEFT JOIN vendedores vd ON vd.id = v.vendedor_id
            WHERE ${whereSQL}
            ORDER BY v.data_venda DESC
            LIMIT ? OFFSET ?
        `).all(...params, perPage, offset);
    } catch (e) {
        vendas = [];
    }

    // Load vendedores for filter
    let vendedores = [];
    try {
        vendedores = db.prepare('SELECT id, nome FROM vendedores WHERE empresa_id = ? AND ativo = 1 ORDER BY nome').all(empresaId);
    } catch (e) {
        vendedores = [];
    }

    res.render('vendas/index', {
        title: 'Vendas',
        vendas,
        vendedores,
        filtros: { date_from: date_from || '', date_to: date_to || '', status: status || '', vendedor_id: vendedor_id || '', search: search || '' },
        pagination: { page, totalPages, totalRows },
        mensagem: req.query.mensagem || null,
        erro: req.query.erro || null
    });
});

// GET /nova - Formulário de nova venda
router.get('/nova', (req, res) => {
    const empresaId = req.session.empresaAtual.id;

    let clientes = [];
    let vendedores = [];
    let produtos = [];

    try {
        clientes = db.prepare('SELECT id, nome FROM clientes WHERE empresa_id = ? AND ativo = 1 ORDER BY nome').all(empresaId);
    } catch (e) { clientes = []; }

    try {
        vendedores = db.prepare('SELECT id, nome, comissao_percentual FROM vendedores WHERE empresa_id = ? AND ativo = 1 ORDER BY nome').all(empresaId);
    } catch (e) { vendedores = []; }

    try {
        produtos = db.prepare(`
            SELECT p.id, p.nome, p.codigo, p.preco_venda, p.preco_atacado, p.preco_custo,
                   COALESCE(e.quantidade, 0) AS estoque
            FROM produtos p
            LEFT JOIN estoque e ON e.produto_id = p.id AND e.empresa_id = p.empresa_id
            WHERE p.empresa_id = ? AND p.ativo = 1
            ORDER BY p.nome
        `).all(empresaId);
    } catch (e) { produtos = []; }

    res.render('vendas/form', {
        title: 'Nova Venda',
        clientes,
        vendedores,
        produtos,
        erro: null
    });
});

// POST /nova - Criar venda
router.post('/nova', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const usuarioId = req.session.usuario.id;
    const {
        cliente_id, vendedor_id, tipo, forma_pagamento, parcelas,
        desconto_percentual, desconto_valor, observacoes,
        produto_id, quantidade, preco_unitario, desconto_item
    } = req.body;

    // Normalize arrays
    const produtoIds = Array.isArray(produto_id) ? produto_id : (produto_id ? [produto_id] : []);
    const quantidades = Array.isArray(quantidade) ? quantidade : (quantidade ? [quantidade] : []);
    const precos = Array.isArray(preco_unitario) ? preco_unitario : (preco_unitario ? [preco_unitario] : []);
    const descontos = Array.isArray(desconto_item) ? desconto_item : (desconto_item ? [desconto_item] : []);

    if (produtoIds.length === 0 || !produtoIds[0]) {
        return res.redirect('/vendas/nova?erro=' + encodeURIComponent('Adicione ao menos um item na venda'));
    }

    const transaction = db.transaction(() => {
        // 1. Generate numero (NV-YYYYMMDD-SEQ)
        const today = new Date();
        const dateStr = today.getFullYear().toString() +
            String(today.getMonth() + 1).padStart(2, '0') +
            String(today.getDate()).padStart(2, '0');
        const prefix = `NV-${dateStr}-`;

        const lastVenda = db.prepare(`
            SELECT numero FROM vendas
            WHERE empresa_id = ? AND numero LIKE ?
            ORDER BY id DESC LIMIT 1
        `).get(empresaId, prefix + '%');

        let seq = 1;
        if (lastVenda && lastVenda.numero) {
            const parts = lastVenda.numero.split('-');
            seq = (parseInt(parts[2]) || 0) + 1;
        }
        const numero = prefix + String(seq).padStart(4, '0');

        // 2. Calculate subtotal from items
        let subtotal = 0;
        const itens = [];
        for (let i = 0; i < produtoIds.length; i++) {
            if (!produtoIds[i]) continue;
            const qty = parseFloat(quantidades[i]) || 0;
            const price = parseFloat(precos[i]) || 0;
            const disc = parseFloat(descontos[i]) || 0;
            const itemTotal = (qty * price) - disc;
            subtotal += itemTotal;
            itens.push({
                produto_id: parseInt(produtoIds[i]),
                quantidade: qty,
                preco_unitario: price,
                desconto: disc,
                total: itemTotal
            });
        }

        if (itens.length === 0) {
            throw new Error('Adicione ao menos um item na venda');
        }

        // 3. Calculate total with discounts
        const descPerc = parseFloat(desconto_percentual) || 0;
        const descVal = parseFloat(desconto_valor) || 0;
        const descontoTotal = descVal + (subtotal * descPerc / 100);
        const total = subtotal - descontoTotal;

        // 4. Insert venda
        const vendaResult = db.prepare(`
            INSERT INTO vendas (empresa_id, numero, cliente_id, vendedor_id, usuario_id, data_venda, tipo, subtotal, desconto_percentual, desconto_valor, total, forma_pagamento, parcelas, status, observacoes)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, 'finalizada', ?)
        `).run(
            empresaId,
            numero,
            cliente_id ? parseInt(cliente_id) : null,
            vendedor_id ? parseInt(vendedor_id) : null,
            usuarioId,
            tipo || 'varejo',
            subtotal,
            descPerc,
            descVal + (subtotal * descPerc / 100),
            total,
            forma_pagamento || 'dinheiro',
            parseInt(parcelas) || 1,
            observacoes || null
        );

        const vendaId = vendaResult.lastInsertRowid;

        // 5. Insert venda_itens and update estoque
        const insertItem = db.prepare(`
            INSERT INTO venda_itens (venda_id, produto_id, quantidade, preco_unitario, desconto, total)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        const getEstoque = db.prepare(`
            SELECT id, quantidade FROM estoque WHERE empresa_id = ? AND produto_id = ?
        `);

        const updateEstoque = db.prepare(`
            UPDATE estoque SET quantidade = quantidade - ?, updated_at = CURRENT_TIMESTAMP
            WHERE empresa_id = ? AND produto_id = ?
        `);

        const insertEstoque = db.prepare(`
            INSERT INTO estoque (empresa_id, produto_id, quantidade) VALUES (?, ?, ?)
        `);

        const insertMovimentacao = db.prepare(`
            INSERT INTO estoque_movimentacoes (empresa_id, produto_id, tipo, quantidade, quantidade_anterior, quantidade_posterior, custo_unitario, documento_tipo, documento_id, observacao, usuario_id)
            VALUES (?, ?, 'saida', ?, ?, ?, ?, 'venda', ?, ?, ?)
        `);

        for (const item of itens) {
            // Insert item
            insertItem.run(vendaId, item.produto_id, item.quantidade, item.preco_unitario, item.desconto, item.total);

            // Update estoque
            const estoqueRow = getEstoque.get(empresaId, item.produto_id);
            const qtdAnterior = estoqueRow ? estoqueRow.quantidade : 0;
            const qtdPosterior = qtdAnterior - item.quantidade;

            if (estoqueRow) {
                updateEstoque.run(item.quantidade, empresaId, item.produto_id);
            } else {
                insertEstoque.run(empresaId, item.produto_id, -item.quantidade);
            }

            // Create movimentação
            insertMovimentacao.run(
                empresaId, item.produto_id, item.quantidade,
                qtdAnterior, qtdPosterior, item.preco_unitario,
                vendaId, `Venda ${numero}`, usuarioId
            );
        }

        // 6. If vendedor, calculate comissão
        if (vendedor_id) {
            const vendedor = db.prepare('SELECT comissao_percentual FROM vendedores WHERE id = ? AND empresa_id = ?').get(vendedor_id, empresaId);
            if (vendedor && vendedor.comissao_percentual > 0) {
                const comissaoValor = total * vendedor.comissao_percentual / 100;
                db.prepare(`
                    INSERT INTO comissoes (empresa_id, vendedor_id, venda_id, valor, percentual, status)
                    VALUES (?, ?, ?, ?, ?, 'pendente')
                `).run(empresaId, parseInt(vendedor_id), vendaId, comissaoValor, vendedor.comissao_percentual);
            }
        }

        // 7. If forma_pagamento is 'prazo', create contas_receber
        const fp = forma_pagamento || 'dinheiro';
        if (fp === 'prazo') {
            const numParcelas = parseInt(parcelas) || 1;
            const valorParcela = Math.round((total / numParcelas) * 100) / 100;
            const hoje = new Date();

            for (let p = 1; p <= numParcelas; p++) {
                const vencimento = new Date(hoje);
                vencimento.setMonth(vencimento.getMonth() + p);
                const vencStr = vencimento.toISOString().split('T')[0];
                const hojeStr = hoje.toISOString().split('T')[0];

                // Adjust last parcela for rounding
                const vlrParcela = (p === numParcelas) ? (total - valorParcela * (numParcelas - 1)) : valorParcela;

                db.prepare(`
                    INSERT INTO contas_receber (empresa_id, cliente_id, venda_id, descricao, categoria, valor, data_emissao, data_vencimento, forma_pagamento, documento, parcela, total_parcelas, status)
                    VALUES (?, ?, ?, ?, 'vendas', ?, ?, ?, ?, ?, ?, ?, 'pendente')
                `).run(
                    empresaId,
                    cliente_id ? parseInt(cliente_id) : null,
                    vendaId,
                    `Venda ${numero} - Parcela ${p}/${numParcelas}`,
                    vlrParcela,
                    hojeStr,
                    vencStr,
                    fp,
                    numero,
                    p,
                    numParcelas
                );
            }
        } else {
            // 8. Create fluxo_caixa entry for immediate payment
            const hojeStr = new Date().toISOString().split('T')[0];
            db.prepare(`
                INSERT INTO fluxo_caixa (empresa_id, tipo, categoria, descricao, valor, data_movimento, forma_pagamento, documento_tipo, documento_id, usuario_id)
                VALUES (?, 'entrada', 'vendas', ?, ?, ?, ?, 'venda', ?, ?)
            `).run(
                empresaId,
                `Venda ${numero}`,
                total,
                hojeStr,
                fp,
                vendaId,
                usuarioId
            );
        }

        return vendaId;
    });

    try {
        const vendaId = transaction();
        res.redirect('/vendas/ver/' + vendaId + '?mensagem=' + encodeURIComponent('Venda realizada com sucesso!'));
    } catch (e) {
        console.error('Erro ao criar venda:', e);
        res.redirect('/vendas/nova?erro=' + encodeURIComponent('Erro ao criar venda: ' + e.message));
    }
});

// GET /ver/:id - Ver detalhes da venda
router.get('/ver/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;

    let venda = null;
    let itens = [];

    try {
        venda = db.prepare(`
            SELECT v.*, c.nome AS cliente_nome, c.cpf_cnpj AS cliente_cpf_cnpj,
                   vd.nome AS vendedor_nome, u.nome AS usuario_nome
            FROM vendas v
            LEFT JOIN clientes c ON c.id = v.cliente_id
            LEFT JOIN vendedores vd ON vd.id = v.vendedor_id
            LEFT JOIN usuarios u ON u.id = v.usuario_id
            WHERE v.id = ? AND v.empresa_id = ?
        `).get(req.params.id, empresaId);
    } catch (e) {
        venda = null;
    }

    if (!venda) {
        return res.redirect('/vendas?erro=' + encodeURIComponent('Venda não encontrada'));
    }

    try {
        itens = db.prepare(`
            SELECT vi.*, p.nome AS produto_nome, p.codigo AS produto_codigo
            FROM venda_itens vi
            JOIN produtos p ON p.id = vi.produto_id
            WHERE vi.venda_id = ?
        `).all(venda.id);
    } catch (e) {
        itens = [];
    }

    // Get comissão if exists
    let comissao = null;
    try {
        comissao = db.prepare('SELECT * FROM comissoes WHERE venda_id = ? AND empresa_id = ?').get(venda.id, empresaId);
    } catch (e) { comissao = null; }

    res.render('vendas/ver', {
        title: 'Venda ' + venda.numero,
        venda,
        itens,
        comissao,
        mensagem: req.query.mensagem || null,
        erro: req.query.erro || null
    });
});

// GET /cancelar/:id - Cancelar venda
router.get('/cancelar/:id', (req, res) => {
    const empresaId = req.session.empresaAtual.id;
    const usuarioId = req.session.usuario.id;

    const transaction = db.transaction(() => {
        // Get venda
        const venda = db.prepare('SELECT * FROM vendas WHERE id = ? AND empresa_id = ?').get(req.params.id, empresaId);
        if (!venda) {
            throw new Error('Venda não encontrada');
        }
        if (venda.status === 'cancelada') {
            throw new Error('Venda já está cancelada');
        }

        // 1. Update venda status
        db.prepare("UPDATE vendas SET status = 'cancelada' WHERE id = ?").run(venda.id);

        // 2. Reverse estoque - get items
        const itens = db.prepare('SELECT * FROM venda_itens WHERE venda_id = ?').all(venda.id);

        const getEstoque = db.prepare('SELECT id, quantidade FROM estoque WHERE empresa_id = ? AND produto_id = ?');
        const updateEstoque = db.prepare('UPDATE estoque SET quantidade = quantidade + ?, updated_at = CURRENT_TIMESTAMP WHERE empresa_id = ? AND produto_id = ?');
        const insertEstoque = db.prepare('INSERT INTO estoque (empresa_id, produto_id, quantidade) VALUES (?, ?, ?)');
        const insertMovimentacao = db.prepare(`
            INSERT INTO estoque_movimentacoes (empresa_id, produto_id, tipo, quantidade, quantidade_anterior, quantidade_posterior, custo_unitario, documento_tipo, documento_id, observacao, usuario_id)
            VALUES (?, ?, 'entrada', ?, ?, ?, ?, 'venda', ?, ?, ?)
        `);

        for (const item of itens) {
            const estoqueRow = getEstoque.get(empresaId, item.produto_id);
            const qtdAnterior = estoqueRow ? estoqueRow.quantidade : 0;
            const qtdPosterior = qtdAnterior + item.quantidade;

            if (estoqueRow) {
                updateEstoque.run(item.quantidade, empresaId, item.produto_id);
            } else {
                insertEstoque.run(empresaId, item.produto_id, item.quantidade);
            }

            insertMovimentacao.run(
                empresaId, item.produto_id, item.quantidade,
                qtdAnterior, qtdPosterior, item.preco_unitario,
                venda.id, `Cancelamento venda ${venda.numero}`, usuarioId
            );
        }

        // 3. Cancel comissões
        db.prepare("UPDATE comissoes SET status = 'cancelada' WHERE venda_id = ? AND empresa_id = ?").run(venda.id, empresaId);

        // 4. Cancel contas_receber
        db.prepare("UPDATE contas_receber SET status = 'cancelada' WHERE venda_id = ? AND empresa_id = ?").run(venda.id, empresaId);

        // 5. If there was a fluxo_caixa entry, create reversal
        const fluxoOriginal = db.prepare("SELECT * FROM fluxo_caixa WHERE documento_tipo = 'venda' AND documento_id = ? AND empresa_id = ? AND tipo = 'entrada'").get(venda.id, empresaId);
        if (fluxoOriginal) {
            const hojeStr = new Date().toISOString().split('T')[0];
            db.prepare(`
                INSERT INTO fluxo_caixa (empresa_id, tipo, categoria, descricao, valor, data_movimento, forma_pagamento, documento_tipo, documento_id, usuario_id)
                VALUES (?, 'saida', 'vendas', ?, ?, ?, ?, 'venda', ?, ?)
            `).run(
                empresaId,
                `Cancelamento venda ${venda.numero}`,
                venda.total,
                hojeStr,
                venda.forma_pagamento,
                venda.id,
                usuarioId
            );
        }

        return venda;
    });

    try {
        transaction();
        res.redirect('/vendas?mensagem=' + encodeURIComponent('Venda cancelada com sucesso!'));
    } catch (e) {
        console.error('Erro ao cancelar venda:', e);
        res.redirect('/vendas?erro=' + encodeURIComponent('Erro ao cancelar venda: ' + e.message));
    }
});

module.exports = router;
