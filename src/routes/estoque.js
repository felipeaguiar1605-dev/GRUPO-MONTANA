const express = require('express');
const router = express.Router();

// GET /api/estoque/itens — listar itens com estoque atual
router.get('/itens', (req, res) => {
  try {
    const db = req.db;
    const { categoria, busca, baixo_estoque } = req.query;
    let sql = `SELECT * FROM estoque_itens WHERE ativo = 1`;
    const params = [];
    if (categoria) { sql += ` AND categoria = ?`; params.push(categoria); }
    if (busca) { sql += ` AND (nome LIKE ? OR codigo LIKE ? OR descricao LIKE ?)`; params.push(`%${busca}%`,`%${busca}%`,`%${busca}%`); }
    if (baixo_estoque === '1') sql += ` AND estoque_atual <= estoque_minimo AND estoque_minimo > 0`;
    sql += ` ORDER BY categoria, nome`;
    const itens = db.prepare(sql).all(...params);
    res.json(itens);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/estoque/itens/:id — detalhe + histórico de movimentos
router.get('/itens/:id', (req, res) => {
  try {
    const db = req.db;
    const item = db.prepare(`SELECT * FROM estoque_itens WHERE id = ?`).get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item não encontrado' });
    const movimentos = db.prepare(`
      SELECT * FROM estoque_movimentos WHERE item_id = ?
      ORDER BY data_movimento DESC, id DESC LIMIT 100
    `).all(req.params.id);
    res.json({ item, movimentos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/estoque/itens — cadastrar item
router.post('/itens', (req, res) => {
  try {
    const db = req.db;
    const { codigo, nome, categoria, descricao, unidade, estoque_minimo, valor_unitario, localizacao } = req.body;
    if (!nome || !categoria) return res.status(400).json({ error: 'nome e categoria obrigatórios' });
    const CATS = ['EQUIPAMENTO','MAQUINARIO','EPI','CONSUMIVEL'];
    if (!CATS.includes(categoria)) return res.status(400).json({ error: 'Categoria inválida' });
    const r = db.prepare(`
      INSERT INTO estoque_itens (codigo,nome,categoria,descricao,unidade,estoque_minimo,valor_unitario,localizacao,estoque_atual)
      VALUES (?,?,?,?,?,?,?,?,0)
    `).run(codigo||null, nome, categoria, descricao||null, unidade||'UN', estoque_minimo||0, valor_unitario||0, localizacao||null);
    res.json({ id: r.lastInsertRowid, message: 'Item cadastrado' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/estoque/itens/:id — editar item
router.put('/itens/:id', (req, res) => {
  try {
    const db = req.db;
    const { codigo, nome, categoria, descricao, unidade, estoque_minimo, valor_unitario, localizacao, ativo } = req.body;
    db.prepare(`
      UPDATE estoque_itens SET codigo=?,nome=?,categoria=?,descricao=?,unidade=?,
        estoque_minimo=?,valor_unitario=?,localizacao=?,ativo=?,
        updated_at=datetime('now','localtime')
      WHERE id=?
    `).run(codigo||null, nome, categoria, descricao||null, unidade||'UN',
           estoque_minimo||0, valor_unitario||0, localizacao||null, ativo!==undefined?ativo:1, req.params.id);
    res.json({ message: 'Item atualizado' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/estoque/movimentos — registrar entrada ou saída
router.post('/movimentos', (req, res) => {
  try {
    const db = req.db;
    const { item_id, tipo, quantidade, valor_unitario, data_movimento, motivo, fornecedor, nota_fiscal, responsavel, destino, obs } = req.body;
    if (!item_id || !tipo || !quantidade || !data_movimento)
      return res.status(400).json({ error: 'item_id, tipo, quantidade e data_movimento obrigatórios' });
    const TIPOS = ['ENTRADA','SAIDA','AJUSTE','TRANSFERENCIA'];
    if (!TIPOS.includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });

    const item = db.prepare(`SELECT * FROM estoque_itens WHERE id = ?`).get(item_id);
    if (!item) return res.status(404).json({ error: 'Item não encontrado' });

    const qtd = parseFloat(quantidade);
    const vunit = parseFloat(valor_unitario) || item.valor_unitario || 0;
    const total = qtd * vunit;

    // Calcular novo estoque
    let novoEstoque = item.estoque_atual;
    if (tipo === 'ENTRADA') novoEstoque += qtd;
    else if (tipo === 'SAIDA') novoEstoque -= qtd;
    else if (tipo === 'AJUSTE') novoEstoque = qtd;
    else if (tipo === 'TRANSFERENCIA') novoEstoque -= qtd;

    if (novoEstoque < 0 && tipo !== 'AJUSTE')
      return res.status(400).json({ error: `Estoque insuficiente. Atual: ${item.estoque_atual}, solicitado: ${qtd}` });

    const registrar = db.transaction(() => {
      db.prepare(`
        INSERT INTO estoque_movimentos (item_id,tipo,quantidade,valor_unitario,total,data_movimento,motivo,fornecedor,nota_fiscal,responsavel,destino,obs)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(item_id, tipo, qtd, vunit, total, data_movimento, motivo||null, fornecedor||null, nota_fiscal||null, responsavel||null, destino||null, obs||null);

      db.prepare(`UPDATE estoque_itens SET estoque_atual=?, valor_unitario=CASE WHEN ?>0 THEN ? ELSE valor_unitario END, updated_at=datetime('now','localtime') WHERE id=?`)
        .run(novoEstoque, vunit, vunit, item_id);
    });
    registrar();

    res.json({ message: 'Movimento registrado', estoque_atual: novoEstoque });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/estoque/resumo — dashboard: totais por categoria + alertas
router.get('/resumo', (req, res) => {
  try {
    const db = req.db;
    const cats = db.prepare(`
      SELECT categoria,
        COUNT(*) as total_itens,
        SUM(CASE WHEN estoque_atual <= estoque_minimo AND estoque_minimo > 0 THEN 1 ELSE 0 END) as alertas,
        ROUND(SUM(estoque_atual * valor_unitario),2) as valor_total
      FROM estoque_itens WHERE ativo=1
      GROUP BY categoria
    `).all();

    const alertas = db.prepare(`
      SELECT id, nome, categoria, estoque_atual, estoque_minimo, unidade
      FROM estoque_itens
      WHERE ativo=1 AND estoque_atual <= estoque_minimo AND estoque_minimo > 0
      ORDER BY categoria, nome
    `).all();

    const ultimos = db.prepare(`
      SELECT m.*, i.nome as item_nome, i.categoria, i.unidade
      FROM estoque_movimentos m JOIN estoque_itens i ON m.item_id=i.id
      ORDER BY m.created_at DESC LIMIT 10
    `).all();

    res.json({ por_categoria: cats, alertas, ultimos_movimentos: ultimos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/estoque/relatorio — movimentos filtrados
router.get('/relatorio', (req, res) => {
  try {
    const db = req.db;
    const { data_ini, data_fim, tipo, categoria } = req.query;
    let sql = `
      SELECT m.*, i.nome as item_nome, i.categoria, i.unidade, i.codigo
      FROM estoque_movimentos m JOIN estoque_itens i ON m.item_id=i.id
      WHERE 1=1
    `;
    const params = [];
    if (data_ini) { sql += ` AND m.data_movimento >= ?`; params.push(data_ini); }
    if (data_fim) { sql += ` AND m.data_movimento <= ?`; params.push(data_fim); }
    if (tipo) { sql += ` AND m.tipo = ?`; params.push(tipo); }
    if (categoria) { sql += ` AND i.categoria = ?`; params.push(categoria); }
    sql += ` ORDER BY m.data_movimento DESC, m.id DESC`;
    res.json(db.prepare(sql).all(...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
