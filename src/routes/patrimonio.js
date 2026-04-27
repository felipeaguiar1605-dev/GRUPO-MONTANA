/**
 * Montana — Módulo Patrimônio (Ativos Fixos + Depreciação Linear)
 *
 *  GET  /api/patrimonio                         lista com depreciação calculada
 *  GET  /api/patrimonio/resumo                  KPIs do mês (total, valor atual, depr. mensal, por categoria)
 *  GET  /api/patrimonio/por-contrato            depreciação mensal agrupada por contrato
 *  GET  /api/patrimonio/:id                     detalhe + histórico mês a mês
 *  POST /api/patrimonio                         cadastra novo ativo
 *  PUT  /api/patrimonio/:id                     edita / dá baixa
 */
'use strict';

const express   = require('express');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

// ─── Schema ─────────────────────────────────────────────────────────
const _ensured = new Set(); // cache por empresa para não rodar em toda request

async function ensureTable(db, companyKey) {
  const cacheKey = companyKey || db.companyKey || 'default';
  if (_ensured.has(cacheKey)) return;

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS patrimonio (
      id              SERIAL PRIMARY KEY,
      empresa         VARCHAR(50) NOT NULL,
      descricao       TEXT NOT NULL,
      categoria       VARCHAR(100),
      numero_serie    VARCHAR(100),
      contrato_id     INTEGER,
      contrato_ref    VARCHAR(200),
      valor_aquisicao NUMERIC(15,2) NOT NULL,
      data_aquisicao  DATE NOT NULL,
      vida_util_meses INTEGER NOT NULL DEFAULT 60,
      valor_residual  NUMERIC(15,2) DEFAULT 0,
      status          VARCHAR(50) DEFAULT 'ativo',
      data_baixa      DATE,
      motivo_baixa    TEXT,
      observacoes     TEXT,
      created_at      TIMESTAMP DEFAULT NOW(),
      updated_at      TIMESTAMP DEFAULT NOW()
    )
  `).run();

  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_patrimonio_empresa  ON patrimonio(empresa)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_patrimonio_categ    ON patrimonio(categoria)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_patrimonio_contrato ON patrimonio(contrato_id)`).run();
  await db.prepare(`CREATE INDEX IF NOT EXISTS idx_patrimonio_status   ON patrimonio(status)`).run();

  _ensured.add(cacheKey);

  // Seed apenas se a tabela está vazia E é a empresa "assessoria"
  if (cacheKey === 'assessoria') {
    const cnt = await db.prepare(`SELECT COUNT(*)::int AS c FROM patrimonio`).get();
    if (cnt && cnt.c === 0) {
      await seedAssessoria(db);
    }
  }
}

async function seedAssessoria(db) {
  const seeds = [
    // Veículos (vida útil 60m)
    ['assessoria','Fiat Strada Endurance 1.4 Cabine Plus 2023','Veículo','MGE-3F45','Fiat Strada — frota administrativa', 89_500.00, '2023-04-15', 60, 8_950.00],
    ['assessoria','Toyota Hilux SRV 4x4 2.8 Diesel 2024',     'Veículo','HRX-2D71','Toyota Hilux — supervisão de campo',151_900.00, '2024-02-10', 60,15_190.00],
    // Equipamentos de segurança (vida útil 60m)
    ['assessoria','Catraca Eletrônica Henry Hexa II (4 unid.)','Equipamento','HENRY-4X','Catracas portaria UFT', 18_400.00, '2022-11-20', 60, 1_840.00],
    ['assessoria','Câmeras IP Hikvision 4MP (kit 16 canais)',  'Equipamento','HIK-16CH','CFTV instalado SEMARH', 24_750.00, '2023-08-05', 60, 2_475.00],
    // Fardamento (vida útil 24m) alocados a contratos
    ['assessoria','Fardamento Vigilância — lote 40 conjuntos UFT','Fardamento','LOTE-UFT-001','UFT 16/2025', 12_800.00, '2025-01-20', 24, 0],
    ['assessoria','Fardamento Vigilância — lote 25 conjuntos DETRAN','Fardamento','LOTE-DET-002','DETRAN 41/2023', 8_100.00, '2024-09-12', 24, 0],
    // TI (vida útil 48m)
    ['assessoria','Servidor Dell PowerEdge T350 + UPS','TI','DELL-T350-01','Servidor sede — gestão',23_500.00, '2024-06-01', 48, 2_350.00],
    ['assessoria','Notebooks Dell Latitude (5 unidades)','TI','DELL-LAT-2024','Notebooks administrativo', 31_250.00, '2024-03-22', 48, 3_125.00],
    // Mobiliário (vida útil 60m)
    ['assessoria','Mobiliário sede — lote escritório administrativo','Mobiliário','MOB-SEDE-2022', null,           14_800.00, '2022-05-18', 60, 0],
    // Outro
    ['assessoria','Detector de metais portátil (lote 10 unidades)','Outro','DETMET-10', 'UFT 16/2025', 6_400.00, '2025-03-10', 36, 0],
  ];

  for (const s of seeds) {
    await db.prepare(`
      INSERT INTO patrimonio
        (empresa, descricao, categoria, numero_serie, contrato_ref,
         valor_aquisicao, data_aquisicao, vida_util_meses, valor_residual)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(s);
  }

  console.log(`  🏗️  patrimonio [assessoria]: ${seeds.length} ativos de exemplo inseridos`);
}

// ─── Helpers de depreciação ─────────────────────────────────────────

const num = v => parseFloat(v) || 0;

function dataIso(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function diffMeses(de, ate) {
  if (!de || !ate) return 0;
  const d1 = new Date(de);
  const d2 = new Date(ate);
  if (isNaN(d1) || isNaN(d2)) return 0;
  let m = (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth());
  if (d2.getDate() < d1.getDate()) m -= 1;
  return Math.max(m, 0);
}

/**
 * Calcula depreciação acumulada na data-base.
 *  - dataRef = string YYYY-MM-DD (default = hoje)
 *  - se ativo baixado antes da dataRef, congela na data_baixa
 */
function calcularDepreciacao(at, dataRef) {
  const valorAq    = num(at.valor_aquisicao);
  const valorResid = num(at.valor_residual);
  const vida       = parseInt(at.vida_util_meses) || 60;
  const baseDeprec = Math.max(valorAq - valorResid, 0);
  const deprMensal = vida > 0 ? +(baseDeprec / vida).toFixed(2) : 0;

  let refIso = dataIso(dataRef) || new Date().toISOString().slice(0, 10);

  // Se baixado antes da ref → congela na data_baixa
  if (at.status === 'baixado' && at.data_baixa) {
    const baixaIso = dataIso(at.data_baixa);
    if (baixaIso < refIso) refIso = baixaIso;
  }

  const aqIso = dataIso(at.data_aquisicao);
  const meses = Math.min(diffMeses(aqIso, refIso), vida);
  const deprAcum   = +(deprMensal * meses).toFixed(2);
  const valorAtual = +Math.max(valorAq - deprAcum, valorResid).toFixed(2);
  const vidaRest   = Math.max(vida - meses, 0);
  const pctDepr    = baseDeprec > 0 ? +((deprAcum / baseDeprec) * 100).toFixed(1) : 0;

  return {
    valor_aquisicao:        +valorAq.toFixed(2),
    valor_residual:         +valorResid.toFixed(2),
    valor_atual:            valorAtual,
    depreciacao_mensal:     deprMensal,
    depreciacao_acumulada:  deprAcum,
    meses_decorridos:       meses,
    vida_util_meses:        vida,
    vida_util_restante_meses: vidaRest,
    percentual_depreciado:  Math.min(pctDepr, 100),
  };
}

/**
 * Determina se o ativo está vigente (gerando depreciação) na competência YYYY-MM.
 *  Vigente = adquirido até o último dia do mês AND (não baixado OU baixado em mês posterior).
 */
function vigenteNaCompetencia(at, competencia) {
  if (!competencia) return at.status !== 'baixado';
  const [ano, mm] = competencia.split('-');
  const fim = `${ano}-${mm.padStart(2, '0')}-31`;
  const ini = `${ano}-${mm.padStart(2, '0')}-01`;

  const aq = dataIso(at.data_aquisicao);
  if (!aq || aq > fim) return false;

  // Sem vida útil restante na competência? não gera depreciação
  const vida = parseInt(at.vida_util_meses) || 60;
  const mesesAteFim = diffMeses(aq, fim);
  if (mesesAteFim >= vida) return false;

  if (at.status === 'baixado' && at.data_baixa) {
    const baixa = dataIso(at.data_baixa);
    if (baixa < ini) return false;
  }
  return true;
}

function valorParse(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  // aceita "1.234,56" ou "1234.56"
  const s = String(v).replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// ─── 1. GET / — lista com depreciação ───────────────────────────────
router.get('/', async (req, res) => {
  try {
    const db = req.db;
    await ensureTable(db, req.companyKey);

    const { categoria, status, contrato_id } = req.query;

    const where = [`empresa = ?`];
    const params = [req.companyKey];

    if (categoria && categoria !== 'todos') { where.push(`categoria = ?`); params.push(categoria); }
    if (status && status !== 'todos')       { where.push(`status = ?`);    params.push(status); }
    if (contrato_id)                        { where.push(`contrato_id = ?`); params.push(parseInt(contrato_id)); }

    const sql = `
      SELECT id, empresa, descricao, categoria, numero_serie,
             contrato_id, contrato_ref,
             valor_aquisicao, data_aquisicao, vida_util_meses, valor_residual,
             status, data_baixa, motivo_baixa, observacoes,
             created_at, updated_at
      FROM patrimonio
      WHERE ${where.join(' AND ')}
      ORDER BY status, data_aquisicao DESC, id DESC
    `;
    const rows = await db.prepare(sql).all(params);

    const hoje = new Date().toISOString().slice(0, 10);
    const ativos = rows.map(r => ({
      ...r,
      data_aquisicao: dataIso(r.data_aquisicao),
      data_baixa:     dataIso(r.data_baixa),
      ...calcularDepreciacao(r, hoje),
    }));

    res.json({ ok: true, total: ativos.length, ativos });
  } catch (e) {
    console.error('[patrimonio/list]', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ─── 2. GET /resumo — KPIs do mês ───────────────────────────────────
router.get('/resumo', async (req, res) => {
  try {
    const db = req.db;
    await ensureTable(db, req.companyKey);

    const competencia = req.query.competencia || new Date().toISOString().slice(0, 7);
    const [ano, mm] = competencia.split('-');
    const fim = `${ano}-${mm.padStart(2, '0')}-31`;

    const rows = await db.prepare(`
      SELECT * FROM patrimonio WHERE empresa = ?
    `).all(req.companyKey);

    let valor_total_aquisicao = 0;
    let valor_atual_total     = 0;
    let depreciacao_mensal_total = 0;
    let total_ativos          = 0;
    let total_baixados        = 0;
    let total_alienados       = 0;
    const porCategoria = {};

    for (const r of rows) {
      const calc = calcularDepreciacao(r, fim);
      const vig  = vigenteNaCompetencia(r, competencia);

      if (r.status === 'ativo') total_ativos++;
      else if (r.status === 'baixado')  total_baixados++;
      else if (r.status === 'alienado') total_alienados++;

      valor_total_aquisicao += calc.valor_aquisicao;
      valor_atual_total     += calc.valor_atual;
      if (vig) depreciacao_mensal_total += calc.depreciacao_mensal;

      const cat = r.categoria || 'Sem categoria';
      if (!porCategoria[cat]) {
        porCategoria[cat] = { categoria: cat, qtd: 0, valor_aquisicao: 0, valor_atual: 0, depreciacao_mensal: 0 };
      }
      porCategoria[cat].qtd++;
      porCategoria[cat].valor_aquisicao += calc.valor_aquisicao;
      porCategoria[cat].valor_atual     += calc.valor_atual;
      if (vig) porCategoria[cat].depreciacao_mensal += calc.depreciacao_mensal;
    }

    const ativos_por_categoria = Object.values(porCategoria)
      .map(c => ({
        ...c,
        valor_aquisicao:    +c.valor_aquisicao.toFixed(2),
        valor_atual:        +c.valor_atual.toFixed(2),
        depreciacao_mensal: +c.depreciacao_mensal.toFixed(2),
      }))
      .sort((a, b) => b.valor_aquisicao - a.valor_aquisicao);

    res.json({
      ok: true,
      competencia,
      kpis: {
        total_ativos,
        total_baixados,
        total_alienados,
        total_geral: rows.length,
        valor_total_aquisicao:    +valor_total_aquisicao.toFixed(2),
        valor_atual_total:        +valor_atual_total.toFixed(2),
        depreciacao_mensal_total: +depreciacao_mensal_total.toFixed(2),
        depreciacao_anual_estimada: +(depreciacao_mensal_total * 12).toFixed(2),
      },
      ativos_por_categoria,
    });
  } catch (e) {
    console.error('[patrimonio/resumo]', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ─── 3. GET /por-contrato — depreciação alocada por contrato ────────
router.get('/por-contrato', async (req, res) => {
  try {
    const db = req.db;
    await ensureTable(db, req.companyKey);

    const competencia = req.query.competencia || new Date().toISOString().slice(0, 7);
    const [ano, mm] = competencia.split('-');
    const fim = `${ano}-${mm.padStart(2, '0')}-31`;

    const rows = await db.prepare(`
      SELECT * FROM patrimonio WHERE empresa = ?
    `).all(req.companyKey);

    const grupos = {};
    for (const r of rows) {
      const vig = vigenteNaCompetencia(r, competencia);
      if (!vig) continue;
      const calc = calcularDepreciacao(r, fim);

      const chave = r.contrato_id ? `id:${r.contrato_id}` : (r.contrato_ref ? `ref:${r.contrato_ref}` : 'sem');
      if (!grupos[chave]) {
        grupos[chave] = {
          contrato_id:        r.contrato_id || null,
          contrato_ref:       r.contrato_ref || (r.contrato_id ? '' : 'Sem alocação'),
          qtd_ativos:         0,
          valor_aquisicao:    0,
          valor_atual:        0,
          depreciacao_mensal: 0,
        };
      }
      const g = grupos[chave];
      g.qtd_ativos++;
      g.valor_aquisicao    += calc.valor_aquisicao;
      g.valor_atual        += calc.valor_atual;
      g.depreciacao_mensal += calc.depreciacao_mensal;
    }

    const lista = Object.values(grupos)
      .map(g => ({
        ...g,
        valor_aquisicao:    +g.valor_aquisicao.toFixed(2),
        valor_atual:        +g.valor_atual.toFixed(2),
        depreciacao_mensal: +g.depreciacao_mensal.toFixed(2),
      }))
      .sort((a, b) => {
        // "Sem alocação" vai pro fim
        if (!a.contrato_id && !a.contrato_ref) return 1;
        if (!b.contrato_id && !b.contrato_ref) return -1;
        if (a.contrato_ref === 'Sem alocação') return 1;
        if (b.contrato_ref === 'Sem alocação') return -1;
        return b.depreciacao_mensal - a.depreciacao_mensal;
      });

    const total = lista.reduce((s, g) => s + g.depreciacao_mensal, 0);

    res.json({
      ok: true,
      competencia,
      total_depreciacao_mensal: +total.toFixed(2),
      contratos: lista,
    });
  } catch (e) {
    console.error('[patrimonio/por-contrato]', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ─── 4. POST / — cadastrar novo ativo ───────────────────────────────
router.post('/', async (req, res) => {
  try {
    const db = req.db;
    await ensureTable(db, req.companyKey);

    const b = req.body || {};
    if (!b.descricao || !b.descricao.trim()) {
      return res.status(400).json({ erro: 'Descrição é obrigatória' });
    }
    const valorAq = valorParse(b.valor_aquisicao);
    if (valorAq === null || valorAq <= 0) {
      return res.status(400).json({ erro: 'valor_aquisicao deve ser numérico e > 0' });
    }
    const dataAq = dataIso(b.data_aquisicao);
    if (!dataAq || !/^\d{4}-\d{2}-\d{2}$/.test(dataAq)) {
      return res.status(400).json({ erro: 'data_aquisicao deve ser uma data ISO (YYYY-MM-DD)' });
    }
    const vida = parseInt(b.vida_util_meses) || 60;
    if (vida <= 0) return res.status(400).json({ erro: 'vida_util_meses deve ser > 0' });

    const valorResid = valorParse(b.valor_residual) || 0;

    const r = await db.prepare(`
      INSERT INTO patrimonio
        (empresa, descricao, categoria, numero_serie, contrato_id, contrato_ref,
         valor_aquisicao, data_aquisicao, vida_util_meses, valor_residual,
         status, observacoes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).get([
      req.companyKey,
      b.descricao.trim(),
      b.categoria || null,
      b.numero_serie || null,
      b.contrato_id ? parseInt(b.contrato_id) : null,
      b.contrato_ref || null,
      valorAq,
      dataAq,
      vida,
      valorResid,
      b.status || 'ativo',
      b.observacoes || null,
    ]);

    res.json({ ok: true, id: r.id });
  } catch (e) {
    console.error('[patrimonio/POST]', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ─── 5. PUT /:id — editar ou dar baixa ──────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const db = req.db;
    await ensureTable(db, req.companyKey);

    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'id inválido' });

    const cur = await db.prepare(`SELECT * FROM patrimonio WHERE id = ? AND empresa = ?`).get([id, req.companyKey]);
    if (!cur) return res.status(404).json({ erro: 'Ativo não encontrado' });

    const b = req.body || {};

    const novo = {
      descricao:       b.descricao        ?? cur.descricao,
      categoria:       b.categoria        ?? cur.categoria,
      numero_serie:    b.numero_serie     ?? cur.numero_serie,
      contrato_id:     b.contrato_id !== undefined ? (b.contrato_id ? parseInt(b.contrato_id) : null) : cur.contrato_id,
      contrato_ref:    b.contrato_ref     ?? cur.contrato_ref,
      valor_aquisicao: b.valor_aquisicao !== undefined ? valorParse(b.valor_aquisicao) : num(cur.valor_aquisicao),
      data_aquisicao:  b.data_aquisicao   ? dataIso(b.data_aquisicao)   : dataIso(cur.data_aquisicao),
      vida_util_meses: b.vida_util_meses  !== undefined ? parseInt(b.vida_util_meses) : cur.vida_util_meses,
      valor_residual:  b.valor_residual   !== undefined ? valorParse(b.valor_residual) : num(cur.valor_residual),
      status:          b.status           ?? cur.status,
      data_baixa:      b.data_baixa       ? dataIso(b.data_baixa)       : dataIso(cur.data_baixa),
      motivo_baixa:    b.motivo_baixa     ?? cur.motivo_baixa,
      observacoes:     b.observacoes      ?? cur.observacoes,
    };

    // Coerência: se status virou baixado/alienado e não foi passada data_baixa, usa hoje
    if ((novo.status === 'baixado' || novo.status === 'alienado') && !novo.data_baixa) {
      novo.data_baixa = new Date().toISOString().slice(0, 10);
    }
    // Se voltou para ativo, limpa baixa
    if (novo.status === 'ativo') {
      novo.data_baixa = null;
      novo.motivo_baixa = null;
    }

    await db.prepare(`
      UPDATE patrimonio SET
        descricao=?, categoria=?, numero_serie=?, contrato_id=?, contrato_ref=?,
        valor_aquisicao=?, data_aquisicao=?, vida_util_meses=?, valor_residual=?,
        status=?, data_baixa=?, motivo_baixa=?, observacoes=?,
        updated_at = NOW()
      WHERE id = ? AND empresa = ?
    `).run([
      novo.descricao, novo.categoria, novo.numero_serie, novo.contrato_id, novo.contrato_ref,
      novo.valor_aquisicao, novo.data_aquisicao, novo.vida_util_meses, novo.valor_residual,
      novo.status, novo.data_baixa, novo.motivo_baixa, novo.observacoes,
      id, req.companyKey,
    ]);

    res.json({ ok: true, id });
  } catch (e) {
    console.error('[patrimonio/PUT]', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ─── 6. GET /:id — detalhe + histórico mês a mês ────────────────────
router.get('/:id', async (req, res) => {
  try {
    const db = req.db;
    await ensureTable(db, req.companyKey);

    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ erro: 'id inválido' });

    const r = await db.prepare(`SELECT * FROM patrimonio WHERE id = ? AND empresa = ?`).get([id, req.companyKey]);
    if (!r) return res.status(404).json({ erro: 'Ativo não encontrado' });

    const hoje = new Date().toISOString().slice(0, 10);
    const calc = calcularDepreciacao(r, hoje);

    // Histórico: 24 meses passados + projeção até o fim da vida útil (cap 60 pontos)
    const aq = new Date(dataIso(r.data_aquisicao));
    const vida = parseInt(r.vida_util_meses) || 60;
    const mesesAtuais = diffMeses(dataIso(r.data_aquisicao), hoje);

    const inicio = Math.max(mesesAtuais - 24, 0);
    const fim    = Math.min(vida, mesesAtuais + 24);
    const historico = [];
    const valorAq    = num(r.valor_aquisicao);
    const valorResid = num(r.valor_residual);
    const deprMensal = vida > 0 ? (valorAq - valorResid) / vida : 0;

    for (let m = inicio; m <= fim; m++) {
      const d = new Date(aq);
      d.setMonth(d.getMonth() + m);
      const competencia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const acumulado = +Math.min(deprMensal * m, valorAq - valorResid).toFixed(2);
      const valor = +Math.max(valorAq - acumulado, valorResid).toFixed(2);
      historico.push({
        mes: competencia,
        meses_decorridos: m,
        depreciacao_mensal: +deprMensal.toFixed(2),
        depreciacao_acumulada: acumulado,
        valor_contabil: valor,
        projetado: m > mesesAtuais,
      });
    }

    res.json({
      ok: true,
      ativo: {
        ...r,
        data_aquisicao: dataIso(r.data_aquisicao),
        data_baixa:     dataIso(r.data_baixa),
        ...calc,
      },
      historico,
    });
  } catch (e) {
    console.error('[patrimonio/detalhe]', e.message);
    res.status(500).json({ erro: e.message });
  }
});

module.exports = router;
