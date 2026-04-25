/**
 * Montana — Módulo Volus (Vale Alimentação / Benefícios)
 *
 * GET  /api/volus/status          — situação atual (cartões, crédito)
 * POST /api/volus/pedidos         — importa pedidos de crédito (JSON)
 * GET  /api/volus/resumo          — resumo por departamento/mês
 * GET  /api/volus/funcionarios    — lista de beneficiários
 * POST /api/volus/funcionarios    — importa/atualiza funcionários
 * POST /api/volus/auto-categorizar — categoriza débitos bancários como VA
 */
'use strict';

const express   = require('express');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

// Mapeamento departamento Volus → contrato_ref Montana
const DEPT_CONTRATO = {
  'UFT':                 'UFT 16/2025',
  'UFNT':                'UFNT 30/2022',
  'DETRAN':              'DETRAN 41/2023',
  'SEDUC':               'SEDUC 016/2023',
  'SESAU':               'SESAU 178/2022',
  'UNITINS':             'UNITINS 022/2022',
  'UNTINS':              'UNITINS 022/2022',  // typo normalizado
  'TCE':                 'TCE 117/2024',
  'TJ':                  'TJ 440/2024',
  'SEMARH':              'SEMARH 32/2024',
  'PREV PALMAS':         'PREVI PALMAS 03/2024',
  'PREVIPALMAS':         'PREVI PALMAS 03/2024', // duplicata normalizada
  'CORPO DE BOMBEIROS':  'CBMTO 011/2023',
  'SEPLAD':              'SEPLAD',
  'PREFEITURA DE PALMAS':'PREFEITURA PALMAS',
};

// ─── Ensure tables ─────────────────────────────────────────────────────────

async function ensureTables(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS volus_pedidos (
    id              BIGSERIAL PRIMARY KEY,
    departamento    TEXT NOT NULL,
    contrato_ref    TEXT DEFAULT '',
    competencia     TEXT NOT NULL,
    data_pedido     TEXT DEFAULT '',
    valor_total     REAL DEFAULT 0,
    num_cartoes     INTEGER DEFAULT 0,
    num_ativos      INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'PAGO',
    obs             TEXT DEFAULT '',
    created_at      TIMESTAMP DEFAULT NOW()
  )`).run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS volus_funcionarios (
    id              BIGSERIAL PRIMARY KEY,
    nome            TEXT NOT NULL,
    cpf             TEXT DEFAULT '',
    departamento    TEXT DEFAULT '',
    contrato_ref    TEXT DEFAULT '',
    valor_va        REAL DEFAULT 0,
    valor_vr        REAL DEFAULT 0,
    status          TEXT DEFAULT 'ATIVO',
    data_cadastro   TEXT DEFAULT '',
    updated_at      TIMESTAMP DEFAULT NOW(),
    UNIQUE(cpf, departamento)
  )`).run();
}

// ─── GET /api/volus/status ─────────────────────────────────────────────────

router.get('/status', async (req, res) => {
  await ensureTables(req.db);
  const pedidos = await req.db.prepare(`
    SELECT COUNT(*) cnt, COALESCE(SUM(valor_total),0) total,
           MAX(competencia) ultima_comp
    FROM volus_pedidos
  `).get();
  const funcs = await req.db.prepare(`
    SELECT COUNT(*) total,
           SUM(CASE WHEN status='ATIVO' THEN 1 ELSE 0 END) ativos
    FROM volus_funcionarios
  `).get();
  const porDept = await req.db.prepare(`
    SELECT departamento, contrato_ref,
           COUNT(*) pedidos, COALESCE(SUM(valor_total),0) total
    FROM volus_pedidos
    GROUP BY departamento ORDER BY total DESC
  `).all();
  res.json({
    ok: true,
    pedidos_total: pedidos.cnt,
    valor_total: +(pedidos.total || 0).toFixed(2),
    ultima_competencia: pedidos.ultima_comp,
    funcionarios: funcs,
    por_departamento: porDept,
  });
});

// ─── POST /api/volus/pedidos — importa batch de pedidos ───────────────────
// Body: { pedidos: [{ departamento, competencia, data_pedido, valor_total, num_cartoes, num_ativos, status }] }

router.post('/pedidos', async (req, res) => {
  await ensureTables(req.db);
  const { pedidos } = req.body;
  if (!Array.isArray(pedidos) || pedidos.length === 0) {
    return res.status(400).json({ error: 'pedidos deve ser array não vazio' });
  }

  const ins = req.db.prepare(`
    INSERT INTO volus_pedidos
      (departamento, contrato_ref, competencia, data_pedido, valor_total, num_cartoes, num_ativos, status, obs)
    VALUES
      (@departamento, @contrato_ref, @competencia, @data_pedido, @valor_total, @num_cartoes, @num_ativos, @status, @obs)
  `);

  let imported = 0;
  req.db.transaction(async () => {
    for (const p of pedidos) {
      const dept = (p.departamento || '').toUpperCase().trim();
      ins.run({
        departamento: dept,
        contrato_ref: DEPT_CONTRATO[dept] || p.contrato_ref || '',
        competencia:  p.competencia || '',
        data_pedido:  p.data_pedido || '',
        valor_total:  parseFloat(p.valor_total) || 0,
        num_cartoes:  parseInt(p.num_cartoes) || 0,
        num_ativos:   parseInt(p.num_ativos) || 0,
        status:       p.status || 'PAGO',
        obs:          p.obs || '',
      });
      imported++;
    }
  })();

  res.json({ ok: true, imported, message: `${imported} pedidos importados` });
});

// ─── GET /api/volus/resumo — resumo por departamento e competência ────────

router.get('/resumo', async (req, res) => {
  await ensureTables(req.db);
  const { ano, mes } = req.query;
  let where = '1=1';
  const params = {};
  if (ano && mes) {
    where = `competencia = @comp`;
    params.comp = `${ano}-${String(mes).padStart(2,'0')}`;
  } else if (ano) {
    where = `competencia LIKE @comp`;
    params.comp = `${ano}-%`;
  }

  const porDept = await req.db.prepare(`
    SELECT departamento, contrato_ref, competencia,
           COALESCE(SUM(valor_total),0) valor_total,
           COALESCE(SUM(num_cartoes),0) num_cartoes,
           COALESCE(SUM(num_ativos),0)  num_ativos
    FROM volus_pedidos
    WHERE ${where}
    GROUP BY departamento, contrato_ref, competencia
    ORDER BY competencia DESC, valor_total DESC
  `).all(params);

  const porMes = await req.db.prepare(`
    SELECT competencia,
           COALESCE(SUM(valor_total),0) total,
           COUNT(DISTINCT departamento) contratos
    FROM volus_pedidos
    WHERE ${where}
    GROUP BY competencia ORDER BY competencia
  `).all(params);

  const totais = await req.db.prepare(`
    SELECT COALESCE(SUM(valor_total),0) total,
           COALESCE(SUM(num_ativos),0) beneficiarios
    FROM volus_pedidos WHERE ${where}
  `).get(params);

  res.json({ ok: true, por_departamento: porDept, por_mes: porMes, totais });
});

// ─── POST /api/volus/funcionarios — importa lista de beneficiários ────────

router.post('/funcionarios', async (req, res) => {
  await ensureTables(req.db);
  const { funcionarios } = req.body;
  if (!Array.isArray(funcionarios) || funcionarios.length === 0) {
    return res.status(400).json({ error: 'funcionarios deve ser array não vazio' });
  }

  const ins = req.db.prepare(`
    INSERT INTO volus_funcionarios
      (nome, cpf, departamento, contrato_ref, valor_va, valor_vr, status, data_cadastro)
    VALUES
      (@nome, @cpf, @departamento, @contrato_ref, @valor_va, @valor_vr, @status, @data_cadastro)
  `);

  let imported = 0;
  req.db.transaction(async () => {
    for (const f of funcionarios) {
      const dept = (f.departamento || '').toUpperCase().trim();
      ins.run({
        nome:          f.nome || '',
        cpf:           (f.cpf || '').replace(/\D/g,''),
        departamento:  dept,
        contrato_ref:  DEPT_CONTRATO[dept] || f.contrato_ref || '',
        valor_va:      parseFloat(f.valor_va) || 0,
        valor_vr:      parseFloat(f.valor_vr) || 0,
        status:        f.status || 'ATIVO',
        data_cadastro: f.data_cadastro || '',
      });
      imported++;
    }
  })();

  res.json({ ok: true, imported });
});

// ─── GET /api/volus/funcionarios ──────────────────────────────────────────

router.get('/funcionarios', async (req, res) => {
  await ensureTables(req.db);
  const { departamento, contrato } = req.query;
  let where = '1=1';
  const params = {};
  if (departamento) { where += ` AND departamento=@dep`; params.dep = departamento.toUpperCase(); }
  if (contrato)     { where += ` AND contrato_ref LIKE @ctr`; params.ctr = `%${contrato}%`; }

  const rows = await req.db.prepare(`
    SELECT * FROM volus_funcionarios WHERE ${where} ORDER BY departamento, nome
  `).all(params);

  const totais = await req.db.prepare(`
    SELECT departamento, contrato_ref,
           COUNT(*) total,
           SUM(CASE WHEN status='ATIVO' THEN 1 ELSE 0 END) ativos,
           COALESCE(SUM(valor_va),0) custo_va_mensal
    FROM volus_funcionarios
    GROUP BY departamento ORDER BY custo_va_mensal DESC
  `).all();

  res.json({ ok: true, funcionarios: rows, total: rows.length, por_departamento: totais });
});

// ─── POST /api/volus/auto-categorizar — categoriza débitos bancários ──────
// Busca débitos com "VOLUS" no histórico e os categoriza como Vale Alimentação

router.post('/auto-categorizar', async (req, res) => {
  await ensureTables(req.db);

  // Encontra débitos não categorizados com Volus no histórico
  const debitos = await req.db.prepare(`
    SELECT e.id, e.data_iso, e.debito, e.historico,
           e.status_conciliacao
    FROM extratos e
    WHERE e.debito > 0
      AND (UPPER(e.historico) LIKE '%VOLUS%' OR UPPER(e.historico) LIKE '%V%LUS%')
      AND e.status_conciliacao = 'PENDENTE'
    ORDER BY e.data_iso DESC
  `).all();

  if (debitos.length === 0) {
    return res.json({ ok: true, categorizados: 0, message: 'Nenhum débito Volus pendente encontrado' });
  }

  // Para cada débito, tenta identificar o departamento pelo valor no mês
  const updExt = req.db.prepare(`
    UPDATE extratos
    SET status_conciliacao='INTERNO', obs=@obs, contrato_vinculado=@contrato
    WHERE id=@id
  `);

  let categorizados = 0;
  const detalhes = [];

  req.db.transaction(async () => {
    for (const deb of debitos) {
      const comp = deb.data_iso.substring(0, 7);
      // Tenta casar com pedido Volus do mesmo mês pelo valor
      const pedido = await req.db.prepare(`
        SELECT departamento, contrato_ref, valor_total
        FROM volus_pedidos
        WHERE competencia = ?
          AND ABS(valor_total - ?) / ? < 0.02
        ORDER BY ABS(valor_total - ?) LIMIT 1
      `).get(comp, deb.debito, deb.debito || 1, deb.debito);

      const obs      = pedido ? `Vale Alimentação - ${pedido.departamento} (${comp})` : `Vale Alimentação Volus (${comp})`;
      const contrato = pedido ? pedido.contrato_ref : '';

      updExt.run({ obs, contrato, id: deb.id });
      categorizados++;
      detalhes.push({ data: deb.data_iso, valor: deb.debito, obs, contrato });
    }
  })();

  res.json({ ok: true, categorizados, detalhes });
});

module.exports = router;
