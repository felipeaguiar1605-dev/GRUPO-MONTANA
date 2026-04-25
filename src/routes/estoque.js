const express = require('express');
const router = express.Router();
const companyMw = require('../companyMiddleware');
router.use(companyMw);

const CATS = ['EQUIPAMENTO','MAQUINARIO','EPI','UNIFORME','CONSUMIVEL','MATERIAL'];

// Garante tabela ficha_epi existe
async function await ensureFichaTable(db) {
  db.prepare(`CREATE TABLE IF NOT EXISTS estoque_ficha_epi (
    id BIGSERIAL PRIMARY KEY,
    funcionario_id INTEGER,
    funcionario_nome TEXT NOT NULL,
    funcionario_matricula TEXT,
    item_id INTEGER NOT NULL,
    quantidade REAL NOT NULL DEFAULT 1,
    tamanho TEXT,
    data_entrega TEXT NOT NULL,
    data_devolucao TEXT,
    data_validade TEXT,
    contrato_ref TEXT,
    posto TEXT,
    assinatura TEXT,
    responsavel TEXT,
    obs TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  )`).run();
  // Migração: adicionar colunas se não existirem
  const cols = await db.prepare(`SELECT column_name as name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='estoque_ficha_epi' ORDER BY ordinal_position`).all().map(c => c.name);
  if (!cols.includes('data_validade')) await db.prepare(`ALTER TABLE estoque_ficha_epi ADD COLUMN data_validade TEXT`).run();
  if (!cols.includes('contrato_ref'))  await db.prepare(`ALTER TABLE estoque_ficha_epi ADD COLUMN contrato_ref TEXT`).run();
  if (!cols.includes('posto'))         await db.prepare(`ALTER TABLE estoque_ficha_epi ADD COLUMN posto TEXT`).run();
  if (!cols.includes('assinatura'))    await db.prepare(`ALTER TABLE estoque_ficha_epi ADD COLUMN assinatura TEXT`).run();
}

async function ensureItemCols(db) {
  const cols = await db.prepare(`SELECT column_name as name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='estoque_itens' ORDER BY ordinal_position`).all().map(c => c.name);
  if (!cols.includes('ca_numero'))         await db.prepare(`ALTER TABLE estoque_itens ADD COLUMN ca_numero TEXT`).run();
  if (!cols.includes('ca_validade'))       await db.prepare(`ALTER TABLE estoque_itens ADD COLUMN ca_validade TEXT`).run();
  if (!cols.includes('vida_util_meses'))   await db.prepare(`ALTER TABLE estoque_itens ADD COLUMN vida_util_meses INTEGER`).run();
  if (!cols.includes('fabricante'))        await db.prepare(`ALTER TABLE estoque_itens ADD COLUMN fabricante TEXT`).run();
  if (!cols.includes('contrato_ref'))      await db.prepare(`ALTER TABLE estoque_itens ADD COLUMN contrato_ref TEXT`).run();
  if (!cols.includes('empresa_restrita'))  await db.prepare(`ALTER TABLE estoque_itens ADD COLUMN empresa_restrita TEXT`).run();
}

// Regras de compatibilidade empresa ↔ item
const EMPRESA_KEYWORDS = {
  seguranca: [
    'colete','balístico','balistico','coturno','algema','bastão','bastao',
    'detector','rádio comunicador','radio comunicador','radiotransmissor',
    'lanterna tática','lanterna tatica','cinto tático','cinto tatico',
    'armamento','vigilante','segurança privada','seguranca privada',
    'capacete balístico','gilet','sprays','spray de pimenta','tonfa'
  ],
  assessoria: [
    'enceradeira','aspirador','lavadora','esfregão','esfregao','mop','rodo',
    'cera piso','cera de piso','detergente','desinfetante','papel toalha',
    'vassoura','pá de lixo','pa de lixo','lixeira','saco de lixo',
    'caneta','grampeador','perfurador','pasta','arquivo','resma','impressora',
    'copiadora','tonner','toner','cartucho'
  ],
};

function detectarEmpresaItem(nome, categoria) {
  const n = (nome || '').toLowerCase();
  for (const [empresa, keywords] of Object.entries(EMPRESA_KEYWORDS)) {
    if (keywords.some(k => n.includes(k))) return empresa;
  }
  // Heurística por categoria
  if (categoria === 'EPI' && n.match(/colete|balíst|coturno|algema/)) return 'seguranca';
  if (categoria === 'MAQUINARIO' && n.match(/enceradeira|lavadora|aspirador/)) return 'assessoria';
  return null;
}

async function ensureMovCols(db) {
  const cols = await db.prepare(`SELECT column_name as name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='estoque_movimentos' ORDER BY ordinal_position`).all().map(c => c.name);
  if (!cols.includes('contrato_ref')) await db.prepare(`ALTER TABLE estoque_movimentos ADD COLUMN contrato_ref TEXT`).run();
  if (!cols.includes('posto'))        await db.prepare(`ALTER TABLE estoque_movimentos ADD COLUMN posto TEXT`).run();
}

// GET /api/estoque/itens — listar itens com estoque atual
router.get('/itens', async (req, res) => {
  try {
    const db = req.db;
    ensureItemCols(db);
    const { categoria, busca, baixo_estoque, todos, contrato_ref } = req.query;
    let sql = todos === '1' ? `SELECT * FROM estoque_itens WHERE 1=1` : `SELECT * FROM estoque_itens WHERE ativo = 1`;
    const params = [];
    if (categoria)    { sql += ` AND categoria = ?`; params.push(categoria); }
    if (busca)        { sql += ` AND (nome LIKE ? OR codigo LIKE ? OR descricao LIKE ? OR fabricante LIKE ?)`; params.push(`%${busca}%`,`%${busca}%`,`%${busca}%`,`%${busca}%`); }
    if (baixo_estoque === '1') sql += ` AND estoque_atual <= estoque_minimo AND estoque_minimo > 0`;
    if (contrato_ref) { sql += ` AND contrato_ref = ?`; params.push(contrato_ref); }
    sql += ` ORDER BY categoria, nome`;
    const itens = await db.prepare(sql).all(...params);
    // Marcar itens incompatíveis com a empresa atual
    const empresaAtual = req.companyKey;
    const result = itens.map(it => ({
      ...it,
      empresa_mismatch: it.empresa_restrita && it.empresa_restrita !== empresaAtual ? it.empresa_restrita : null
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/estoque/itens/:id — detalhe + histórico de movimentos
router.get('/itens/:id', async (req, res) => {
  try {
    const db = req.db;
    const item = await db.prepare(`SELECT * FROM estoque_itens WHERE id = ?`).get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item não encontrado' });
    const movimentos = await db.prepare(`
      SELECT * FROM estoque_movimentos WHERE item_id = ?
      ORDER BY data_movimento DESC, id DESC LIMIT 100
    `).all(req.params.id);
    res.json({ item, movimentos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/estoque/itens — cadastrar item
router.post('/itens', async (req, res) => {
  try {
    const db = req.db;
    ensureItemCols(db);
    const { codigo, nome, categoria, descricao, unidade, estoque_minimo, valor_unitario, localizacao,
            ca_numero, ca_validade, vida_util_meses, fabricante, contrato_ref, empresa_restrita } = req.body;
    if (!nome || !categoria) return res.status(400).json({ error: 'nome e categoria obrigatórios' });
    if (!CATS.includes(categoria)) return res.status(400).json({ error: 'Categoria inválida' });
    // Auto-detectar empresa se não informada
    const empRestrita = empresa_restrita !== undefined ? (empresa_restrita || null) : detectarEmpresaItem(nome, categoria);
    const r = await db.prepare(`
      INSERT INTO estoque_itens
        (codigo,nome,categoria,descricao,unidade,estoque_minimo,valor_unitario,localizacao,estoque_atual,
         ca_numero,ca_validade,vida_util_meses,fabricante,contrato_ref,empresa_restrita)
      VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)
    `).run(codigo||null, nome, categoria, descricao||null, unidade||'UN',
           estoque_minimo||0, valor_unitario||0, localizacao||null,
           ca_numero||null, ca_validade||null, vida_util_meses||null, fabricante||null,
           contrato_ref||null, empRestrita);
    const aviso = empRestrita && empRestrita !== req.companyKey
      ? `Atenção: item detectado como típico de "${empRestrita}"`
      : null;
    res.json({ id: r.lastInsertRowid, message: 'Item cadastrado', empresa_sugerida: empRestrita, aviso });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/estoque/itens/:id — editar item
router.put('/itens/:id', async (req, res) => {
  try {
    const db = req.db;
    ensureItemCols(db);
    const { codigo, nome, categoria, descricao, unidade, estoque_minimo, valor_unitario, localizacao, ativo,
            ca_numero, ca_validade, vida_util_meses, fabricante, contrato_ref, empresa_restrita } = req.body;
    const empRestrita = empresa_restrita !== undefined ? (empresa_restrita || null) : detectarEmpresaItem(nome, categoria);
    await db.prepare(`
      UPDATE estoque_itens SET
        codigo=?,nome=?,categoria=?,descricao=?,unidade=?,
        estoque_minimo=?,valor_unitario=?,localizacao=?,ativo=?,
        ca_numero=?,ca_validade=?,vida_util_meses=?,fabricante=?,contrato_ref=?,empresa_restrita=?,
        updated_at=NOW()
      WHERE id=?
    `).run(codigo||null, nome, categoria, descricao||null, unidade||'UN',
           estoque_minimo||0, valor_unitario||0, localizacao||null, ativo!==undefined?ativo:1,
           ca_numero||null, ca_validade||null, vida_util_meses||null, fabricante||null,
           contrato_ref||null, empRestrita,
           req.params.id);
    res.json({ message: 'Item atualizado' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/estoque/movimentos — registrar entrada ou saída
router.post('/movimentos', async (req, res) => {
  try {
    const db = req.db;
    ensureMovCols(db);
    const { item_id, tipo, quantidade, valor_unitario, data_movimento, motivo, fornecedor, nota_fiscal,
            responsavel, destino, obs, contrato_ref, posto } = req.body;
    if (!item_id || !tipo || !quantidade || !data_movimento)
      return res.status(400).json({ error: 'item_id, tipo, quantidade e data_movimento obrigatórios' });
    const TIPOS = ['ENTRADA','SAIDA','AJUSTE','TRANSFERENCIA'];
    if (!TIPOS.includes(tipo)) return res.status(400).json({ error: 'Tipo inválido' });

    const item = await db.prepare(`SELECT * FROM estoque_itens WHERE id = ?`).get(item_id);
    if (!item) return res.status(404).json({ error: 'Item não encontrado' });

    const qtd = parseFloat(quantidade);
    const vunit = parseFloat(valor_unitario) || item.valor_unitario || 0;
    const total = qtd * vunit;

    let novoEstoque = item.estoque_atual;
    if (tipo === 'ENTRADA') novoEstoque += qtd;
    else if (tipo === 'SAIDA') novoEstoque -= qtd;
    else if (tipo === 'AJUSTE') novoEstoque = qtd;
    else if (tipo === 'TRANSFERENCIA') novoEstoque -= qtd;

    if (novoEstoque < 0 && tipo !== 'AJUSTE')
      return res.status(400).json({ error: `Estoque insuficiente. Atual: ${item.estoque_atual}, solicitado: ${qtd}` });

    const registrar = db.transaction(async () => {
      await db.prepare(`
        INSERT INTO estoque_movimentos
          (item_id,tipo,quantidade,valor_unitario,total,data_movimento,motivo,fornecedor,nota_fiscal,responsavel,destino,obs,contrato_ref,posto)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(item_id, tipo, qtd, vunit, total, data_movimento, motivo||null, fornecedor||null,
             nota_fiscal||null, responsavel||null, destino||null, obs||null,
             contrato_ref||item.contrato_ref||null, posto||null);

      await db.prepare(`UPDATE estoque_itens SET estoque_atual=?, valor_unitario=CASE WHEN ?>0 THEN ? ELSE valor_unitario END, updated_at=NOW() WHERE id=?`)
        .run(novoEstoque, vunit, vunit, item_id);
    });
    await registrar();

    res.json({ message: 'Movimento registrado', estoque_atual: novoEstoque });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/estoque/resumo — dashboard: totais por categoria + alertas
router.get('/resumo', async (req, res) => {
  try {
    const db = req.db;
    ensureItemCols(db);
    const cats = await db.prepare(`
      SELECT categoria,
        COUNT(*) as total_itens,
        SUM(CASE WHEN estoque_atual <= estoque_minimo AND estoque_minimo > 0 THEN 1 ELSE 0 END) as alertas,
        ROUND(SUM(estoque_atual * valor_unitario),2) as valor_total
      FROM estoque_itens WHERE ativo=1
      GROUP BY categoria
    `).all();

    const alertas = await db.prepare(`
      SELECT id, nome, categoria, estoque_atual, estoque_minimo, unidade
      FROM estoque_itens
      WHERE ativo=1 AND estoque_atual <= estoque_minimo AND estoque_minimo > 0
      ORDER BY categoria, nome
    `).all();

    const ultimos = await db.prepare(`
      SELECT m.*, i.nome as item_nome, i.categoria, i.unidade
      FROM estoque_movimentos m JOIN estoque_itens i ON m.item_id=i.id
      ORDER BY m.created_at DESC LIMIT 10
    `).all();

    res.json({ por_categoria: cats, alertas, ultimos_movimentos: ultimos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/estoque/alertas — CA vencido/vencendo, EPI p/ substituir, estoque baixo
router.get('/alertas', async (req, res) => {
  try {
    const db = req.db;
    ensureItemCols(db);
    const hoje = new Date().toISOString().split('T')[0];
    const em30 = new Date(Date.now() + 30*86400000).toISOString().split('T')[0];

    // CA vencido ou vencendo em 30 dias (EPI/UNIFORME)
    const ca_alertas = await db.prepare(`
      SELECT id, nome, categoria, ca_numero, ca_validade, estoque_atual, unidade
      FROM estoque_itens
      WHERE ativo=1 AND ca_validade IS NOT NULL AND ca_validade != ''
        AND (categoria='EPI' OR categoria='UNIFORME')
        AND ca_validade <= ?
      ORDER BY ca_validade ASC
    `).all(em30);

    // EPIs com vida_util_meses — verificar fichas com data_validade vencida/vencendo
    await ensureFichaTable(db);
    const epi_vencidos = await db.prepare(`
      SELECT f.id, f.funcionario_nome, f.funcionario_matricula, f.data_entrega,
             f.data_validade, f.contrato_ref, f.posto,
             i.nome as item_nome, i.categoria, i.ca_numero
      FROM estoque_ficha_epi f
      JOIN estoque_itens i ON f.item_id = i.id
      WHERE f.data_devolucao IS NULL
        AND f.data_validade IS NOT NULL AND f.data_validade != ''
        AND f.data_validade <= ?
      ORDER BY f.data_validade ASC
    `).all(em30);

    // Estoque baixo
    const estoque_baixo = await db.prepare(`
      SELECT id, nome, categoria, estoque_atual, estoque_minimo, unidade, contrato_ref
      FROM estoque_itens
      WHERE ativo=1 AND estoque_atual <= estoque_minimo AND estoque_minimo > 0
      ORDER BY (CAST(estoque_atual AS REAL) / estoque_minimo) ASC
    `).all();

    // Resumo contagem
    const total_ca_vencidos = ca_alertas.filter(a => a.ca_validade < hoje).length;
    const total_ca_vencendo = ca_alertas.filter(a => a.ca_validade >= hoje).length;
    const total_epi_vencidos = epi_vencidos.filter(e => e.data_validade < hoje).length;
    const total_epi_vencendo = epi_vencidos.filter(e => e.data_validade >= hoje).length;

    res.json({
      resumo: {
        ca_vencidos: total_ca_vencidos,
        ca_vencendo_30d: total_ca_vencendo,
        epi_vencidos: total_epi_vencidos,
        epi_vencendo_30d: total_epi_vencendo,
        estoque_baixo: estoque_baixo.length
      },
      ca_alertas,
      epi_vencidos,
      estoque_baixo
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/estoque/custo-contrato — custo de materiais por contrato/mês
router.get('/custo-contrato', async (req, res) => {
  try {
    const db = req.db;
    ensureMovCols(db);
    const { ano, mes, contrato_ref } = req.query;
    let sql = `
      SELECT
        COALESCE(NULLIF(TRIM(m.contrato_ref),''), NULLIF(TRIM(i.contrato_ref),''), 'SEM CONTRATO') as contrato,
        i.categoria,
        to_char((m.data_movimento)::date, 'YYYY-MM') as mes,
        SUM(CASE WHEN m.tipo IN ('SAIDA','TRANSFERENCIA') THEN m.total ELSE 0 END) as custo_saida,
        SUM(CASE WHEN m.tipo = 'ENTRADA' THEN m.total ELSE 0 END) as valor_entrada,
        COUNT(CASE WHEN m.tipo IN ('SAIDA','TRANSFERENCIA') THEN 1 END) as qtd_saidas
      FROM estoque_movimentos m
      JOIN estoque_itens i ON m.item_id = i.id
      WHERE 1=1
    `;
    const params = [];
    if (ano) { sql += ` AND to_char((m.data_movimento)::date, 'YYYY') = ?`; params.push(String(ano)); }
    if (mes) { sql += ` AND to_char((m.data_movimento)::date, 'MM') = ?`; params.push(String(mes).padStart(2,'0')); }
    if (contrato_ref) { sql += ` AND (m.contrato_ref = ? OR i.contrato_ref = ?)`; params.push(contrato_ref, contrato_ref); }
    sql += ` GROUP BY contrato, i.categoria, to_char((m.data_movimento)::date, 'YYYY-MM')
             ORDER BY mes DESC, contrato, i.categoria`;
    const rows = await db.prepare(sql).all(...params);

    // Agregar por contrato
    const porContrato = {};
    for (const r of rows) {
      if (!porContrato[r.contrato]) porContrato[r.contrato] = { contrato: r.contrato, total_custo: 0, por_categoria: {}, meses: {} };
      porContrato[r.contrato].total_custo += r.custo_saida;
      porContrato[r.contrato].por_categoria[r.categoria] = (porContrato[r.contrato].por_categoria[r.categoria]||0) + r.custo_saida;
      if (!porContrato[r.contrato].meses[r.mes]) porContrato[r.contrato].meses[r.mes] = 0;
      porContrato[r.contrato].meses[r.mes] += r.custo_saida;
    }

    res.json({ por_contrato: Object.values(porContrato), detalhes: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/estoque/relatorio — movimentos filtrados
router.get('/relatorio', async (req, res) => {
  try {
    const db = req.db;
    const { data_ini, data_fim, tipo, categoria, contrato_ref } = req.query;
    let sql = `
      SELECT m.*, i.nome as item_nome, i.categoria, i.unidade, i.codigo
      FROM estoque_movimentos m JOIN estoque_itens i ON m.item_id=i.id
      WHERE 1=1
    `;
    const params = [];
    if (data_ini)    { sql += ` AND m.data_movimento >= ?`; params.push(data_ini); }
    if (data_fim)    { sql += ` AND m.data_movimento <= ?`; params.push(data_fim); }
    if (tipo)        { sql += ` AND m.tipo = ?`; params.push(tipo); }
    if (categoria)   { sql += ` AND i.categoria = ?`; params.push(categoria); }
    if (contrato_ref){ sql += ` AND (m.contrato_ref = ? OR i.contrato_ref = ?)`; params.push(contrato_ref, contrato_ref); }
    sql += ` ORDER BY m.data_movimento DESC, m.id DESC`;
    res.json(await db.prepare(sql).all(...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/estoque/itens/:id/ativo — ativar/inativar item
router.patch('/itens/:id/ativo', async (req, res) => {
  try {
    const db = req.db;
    const { ativo } = req.body;
    await db.prepare(`UPDATE estoque_itens SET ativo=?, updated_at=NOW() WHERE id=?`).run(ativo ? 1 : 0, req.params.id);
    res.json({ message: ativo ? 'Item ativado' : 'Item inativado' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── FICHA DE EPI / UNIFORME ─────────────────────────────────────

// GET /api/estoque/ficha-epi — listar entregas
router.get('/ficha-epi', async (req, res) => {
  try {
    const db = req.db;
    await ensureFichaTable(db);
    const { funcionario_id, item_id, pendente, busca, contrato_ref, vencendo } = req.query;
    const hoje = new Date().toISOString().split('T')[0];
    const em30 = new Date(Date.now() + 30*86400000).toISOString().split('T')[0];
    let sql = `
      SELECT f.*, i.nome as item_nome, i.categoria, i.unidade, i.codigo, i.ca_numero, i.vida_util_meses
      FROM estoque_ficha_epi f
      JOIN estoque_itens i ON f.item_id = i.id
      WHERE 1=1
    `;
    const params = [];
    if (funcionario_id) { sql += ` AND f.funcionario_id = ?`; params.push(funcionario_id); }
    if (item_id)        { sql += ` AND f.item_id = ?`; params.push(item_id); }
    if (pendente === '1') sql += ` AND (f.data_devolucao IS NULL OR f.data_devolucao = '')`;
    if (busca)          { sql += ` AND (f.funcionario_nome LIKE ? OR f.funcionario_matricula LIKE ? OR f.posto LIKE ?)`; params.push(`%${busca}%`,`%${busca}%`,`%${busca}%`); }
    if (contrato_ref)   { sql += ` AND f.contrato_ref = ?`; params.push(contrato_ref); }
    if (vencendo === '1') {
      sql += ` AND f.data_validade IS NOT NULL AND f.data_validade != '' AND f.data_validade <= ? AND (f.data_devolucao IS NULL OR f.data_devolucao = '')`;
      params.push(em30);
    }
    sql += ` ORDER BY f.data_entrega DESC, f.id DESC`;
    res.json(await db.prepare(sql).all(...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/estoque/ficha-epi/funcionario/:id — histórico completo por funcionário (NR-6)
router.get('/ficha-epi/funcionario/:id', async (req, res) => {
  try {
    const db = req.db;
    await ensureFichaTable(db);
    const fichas = await db.prepare(`
      SELECT f.*, i.nome as item_nome, i.categoria, i.unidade, i.codigo, i.ca_numero, i.ca_validade,
             i.fabricante, i.vida_util_meses
      FROM estoque_ficha_epi f
      JOIN estoque_itens i ON f.item_id = i.id
      WHERE f.funcionario_id = ?
      ORDER BY f.data_entrega DESC
    `).all(req.params.id);

    // Busca dados do funcionário se tabela existir
    let funcionario = null;
    try {
      funcionario = await db.prepare(`SELECT id, nome, matricula, cargo, lotacao FROM rh_funcionarios WHERE id = ?`).get(req.params.id);
    } catch (_) {}

    const pendentes = fichas.filter(f => !f.data_devolucao);
    const devolvidos = fichas.filter(f => f.data_devolucao);

    res.json({ funcionario, fichas_pendentes: pendentes, fichas_devolvidas: devolvidos, total: fichas.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/estoque/ficha-epi/funcionarios — lista funcionários p/ autocomplete
router.get('/ficha-epi/funcionarios', async (req, res) => {
  try {
    const db = req.db;
    const { busca } = req.query;
    let sql = `SELECT id, nome, matricula, lotacao FROM rh_funcionarios WHERE status='ATIVO'`;
    const params = [];
    if (busca) { sql += ` AND nome LIKE ?`; params.push(`%${busca}%`); }
    sql += ` ORDER BY nome LIMIT 50`;
    const funcs = await db.prepare(sql).all(...params);
    res.json(funcs);
  } catch (e) { res.json([]); } // tabela pode não existir em alguma empresa
});

// POST /api/estoque/ficha-epi — registrar entrega de EPI/Uniforme
router.post('/ficha-epi', async (req, res) => {
  try {
    const db = req.db;
    await ensureFichaTable(db);
    const { funcionario_id, funcionario_nome, funcionario_matricula, item_id, quantidade,
            tamanho, data_entrega, responsavel, obs, contrato_ref, posto, assinatura } = req.body;
    if (!funcionario_nome || !item_id || !data_entrega)
      return res.status(400).json({ error: 'funcionario_nome, item_id e data_entrega são obrigatórios' });

    const item = await db.prepare(`SELECT * FROM estoque_itens WHERE id=?`).get(item_id);
    if (!item) return res.status(404).json({ error: 'Item não encontrado' });

    // Aviso de empresa incompatível
    const avisoEmpresa = item.empresa_restrita && item.empresa_restrita !== req.companyKey
      ? `⚠️ Este item é tipicamente de "${item.empresa_restrita}", não de "${req.companyKey}"`
      : null;

    const qtd = parseFloat(quantidade) || 1;

    // Calcular data_validade a partir de vida_util_meses
    let data_validade = null;
    if (item.vida_util_meses && data_entrega) {
      const d = new Date(data_entrega);
      d.setMonth(d.getMonth() + item.vida_util_meses);
      data_validade = d.toISOString().split('T')[0];
    }

    const cref = contrato_ref || item.contrato_ref || null;

    const registrar = db.transaction(async () => {
      const r = await db.prepare(`
        INSERT INTO estoque_ficha_epi
          (funcionario_id,funcionario_nome,funcionario_matricula,item_id,quantidade,tamanho,
           data_entrega,data_validade,contrato_ref,posto,assinatura,responsavel,obs)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(funcionario_id||null, funcionario_nome, funcionario_matricula||null,
             item_id, qtd, tamanho||null, data_entrega, data_validade,
             cref, posto||null, assinatura||null, responsavel||null, obs||null);

      const novoEstoque = item.estoque_atual - qtd;
      if (novoEstoque < 0) throw new Error(`Estoque insuficiente: ${item.estoque_atual} ${item.unidade} disponíveis`);

      ensureMovCols(db);
      await db.prepare(`
        INSERT INTO estoque_movimentos
          (item_id,tipo,quantidade,valor_unitario,total,data_movimento,motivo,responsavel,destino,contrato_ref,posto)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(item_id,'SAIDA',qtd,item.valor_unitario,qtd*item.valor_unitario,data_entrega,
             `Entrega EPI/Uniforme — ${funcionario_nome}`,responsavel||null,funcionario_nome,
             cref, posto||null);
      await db.prepare(`UPDATE estoque_itens SET estoque_atual=?, updated_at=NOW() WHERE id=?`).run(novoEstoque, item_id);
      return r.lastInsertRowid;
    });

    const id = await registrar();
    res.json({ id, message: 'Entrega registrada com sucesso', data_validade, aviso_empresa: avisoEmpresa });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/estoque/ficha-epi/:id/devolucao — registrar devolução
router.patch('/ficha-epi/:id/devolucao', async (req, res) => {
  try {
    const db = req.db;
    await ensureFichaTable(db);
    const { data_devolucao, obs } = req.body;
    if (!data_devolucao) return res.status(400).json({ error: 'data_devolucao obrigatória' });

    const ficha = await db.prepare(`SELECT f.*, i.valor_unitario, i.estoque_atual FROM estoque_ficha_epi f JOIN estoque_itens i ON f.item_id=i.id WHERE f.id=?`).get(req.params.id);
    if (!ficha) return res.status(404).json({ error: 'Ficha não encontrada' });
    if (ficha.data_devolucao) return res.status(400).json({ error: 'Item já devolvido' });

    const registrar = db.transaction(async () => {
      await db.prepare(`UPDATE estoque_ficha_epi SET data_devolucao=?, obs=COALESCE(obs||' | ','')|| ? WHERE id=?`)
        .run(data_devolucao, obs ? `Devolução: ${obs}` : 'Devolvido', req.params.id);
      ensureMovCols(db);
      await db.prepare(`
        INSERT INTO estoque_movimentos
          (item_id,tipo,quantidade,valor_unitario,total,data_movimento,motivo,destino,contrato_ref,posto)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(ficha.item_id,'ENTRADA',ficha.quantidade,ficha.valor_unitario,
             ficha.quantidade*ficha.valor_unitario,data_devolucao,
             `Devolução EPI/Uniforme — ${ficha.funcionario_nome}`,null,
             ficha.contrato_ref||null, ficha.posto||null);
      await db.prepare(`UPDATE estoque_itens SET estoque_atual=estoque_atual+?, updated_at=NOW() WHERE id=?`).run(ficha.quantidade, ficha.item_id);
    });
    await registrar();
    res.json({ message: 'Devolução registrada' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
