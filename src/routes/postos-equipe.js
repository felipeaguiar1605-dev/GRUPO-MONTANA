/**
 * Montana ERP — Postos & Equipes
 *
 * Visão consolidada da operação:
 *   - Lista de postos por contrato
 *   - Funcionários alocados em cada posto (via rh_funcionarios.lotacao OU posto_id)
 *   - Indicadores: total funcionários, salário total, % de cobertura, vagas
 *
 * Endpoints:
 *   GET  /api/postos-equipe                — lista de postos com sumário de equipe
 *   GET  /api/postos-equipe/:posto_id      — detalhe + lista funcionários
 *   GET  /api/postos-equipe/sem-posto      — funcionários sem posto definido
 *   POST /api/postos-equipe/:funcionario_id/atribuir-posto  { posto_id }
 *
 * Mount em src/server.js:
 *   app.use('/api/postos-equipe', require('./routes/postos-equipe'));
 */
const express = require('express');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

// ─── Helper: tenta casar funcionário ↔ posto via lotacao texto ─────────
// Heurística usada quando posto_id em rh_funcionarios é NULL
function buildLotacaoMatchSql() {
  return `
    COALESCE(
      f.posto_id,
      (
        SELECT p.id FROM bol_postos p
        WHERE UPPER(f.lotacao) LIKE '%' || UPPER(p.campus_nome) || '%'
           OR UPPER(f.lotacao) LIKE '%' || UPPER(p.descricao_posto) || '%'
           OR UPPER(p.campus_nome) LIKE '%' || UPPER(f.lotacao) || '%'
        LIMIT 1
      )
    )
  `;
}

// ─── GET / — lista postos com sumário de equipe ────────────────────────
router.get('/', async (req, res) => {
  try {
    const lotacaoMatch = buildLotacaoMatchSql();

    const postos = await req.db.prepare(`
      WITH func_alocados AS (
        SELECT
          f.id,
          f.nome,
          f.salario_base,
          f.status,
          ${lotacaoMatch} AS posto_resolvido
        FROM rh_funcionarios f
        WHERE f.status = 'ATIVO'
      )
      SELECT
        p.id,
        p.campus_nome,
        p.municipio,
        p.descricao_posto,
        p.label_resumo,
        p.contrato_id,
        bc.nome AS contrato_nome,
        bc.numero_contrato,
        bc.contratante,
        COUNT(fa.id) AS qtd_funcionarios,
        COALESCE(SUM(fa.salario_base), 0)::numeric(15,2) AS salario_total
      FROM bol_postos p
      LEFT JOIN bol_contratos bc ON bc.id = p.contrato_id
      LEFT JOIN func_alocados fa ON fa.posto_resolvido = p.id
      GROUP BY p.id, p.campus_nome, p.municipio, p.descricao_posto,
               p.label_resumo, p.contrato_id, bc.nome, bc.numero_contrato, bc.contratante
      ORDER BY bc.nome, p.ordem, p.campus_nome
    `).all();

    // Sumário top-level
    const totais = await req.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM bol_postos) AS total_postos,
        (SELECT COUNT(*) FROM rh_funcionarios WHERE status = 'ATIVO') AS total_funcionarios_ativos,
        (SELECT COUNT(*) FROM rh_funcionarios WHERE status = 'ATIVO' AND posto_id IS NULL) AS sem_posto_id,
        (SELECT COALESCE(SUM(salario_base),0) FROM rh_funcionarios WHERE status = 'ATIVO')::numeric(15,2) AS folha_total_estimada,
        (SELECT COUNT(*) FROM bol_contratos WHERE ativo = 1) AS contratos_ativos
    `).get();

    res.json({
      ok: true,
      sumario: totais,
      postos: Array.isArray(postos) ? postos : []
    });
  } catch (e) {
    console.error('[GET /postos-equipe]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /:posto_id — detalhe + lista funcionários ─────────────────────
router.get('/:posto_id([0-9]+)', async (req, res) => {
  try {
    const lotacaoMatch = buildLotacaoMatchSql();

    const posto = await req.db.prepare(`
      SELECT p.*, bc.nome AS contrato_nome, bc.numero_contrato, bc.contratante,
             bc.escala
      FROM bol_postos p
      LEFT JOIN bol_contratos bc ON bc.id = p.contrato_id
      WHERE p.id = ?
    `).get(req.params.posto_id);

    if (!posto) return res.status(404).json({ error: 'Posto não encontrado' });

    const funcionarios = await req.db.prepare(`
      SELECT
        f.id, f.nome, f.cpf, f.lotacao, f.salario_base, f.status,
        f.data_admissao, f.cargo_id,
        c.nome AS cargo_nome,
        f.posto_id AS posto_id_explicito,
        ${lotacaoMatch} AS posto_resolvido
      FROM rh_funcionarios f
      LEFT JOIN rh_cargos c ON c.id = f.cargo_id
      WHERE f.status = 'ATIVO'
        AND ${lotacaoMatch} = ?
      ORDER BY f.nome
    `).all(req.params.posto_id);

    res.json({
      ok: true,
      posto,
      funcionarios: Array.isArray(funcionarios) ? funcionarios : [],
      sumario: {
        total: Array.isArray(funcionarios) ? funcionarios.length : 0,
        salario_total: (Array.isArray(funcionarios) ? funcionarios : [])
          .reduce((s, f) => s + (parseFloat(f.salario_base) || 0), 0)
      }
    });
  } catch (e) {
    console.error('[GET /postos-equipe/:id]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /sem-posto — funcionários sem posto definido ─────────────────
router.get('/sem-posto', async (req, res) => {
  try {
    const lotacaoMatch = buildLotacaoMatchSql();

    const funcionarios = await req.db.prepare(`
      SELECT
        f.id, f.nome, f.lotacao, f.salario_base, f.cargo_id,
        c.nome AS cargo_nome
      FROM rh_funcionarios f
      LEFT JOIN rh_cargos c ON c.id = f.cargo_id
      WHERE f.status = 'ATIVO'
        AND ${lotacaoMatch} IS NULL
      ORDER BY f.lotacao, f.nome
      LIMIT 500
    `).all();

    // Agrupa por lotacao pra facilitar revisão
    const porLotacao = {};
    (Array.isArray(funcionarios) ? funcionarios : []).forEach(f => {
      const k = f.lotacao || '(sem lotacao)';
      if (!porLotacao[k]) porLotacao[k] = [];
      porLotacao[k].push(f);
    });

    res.json({
      ok: true,
      total: Array.isArray(funcionarios) ? funcionarios.length : 0,
      por_lotacao: porLotacao
    });
  } catch (e) {
    console.error('[GET /postos-equipe/sem-posto]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /:funcionario_id/atribuir-posto ────────────────────────────
router.post('/:funcionario_id([0-9]+)/atribuir-posto', async (req, res) => {
  try {
    const role = req.usuario && req.usuario.role;
    if (role && !['admin', 'financeiro'].includes(role)) {
      return res.status(403).json({ error: 'Apenas admin ou financeiro' });
    }
    const { posto_id } = req.body || {};
    if (!posto_id) return res.status(400).json({ error: 'posto_id obrigatório' });

    const r = await req.db.prepare(`
      UPDATE rh_funcionarios SET posto_id = ?, updated_at = NOW()
      WHERE id = ?
    `).run(posto_id, req.params.funcionario_id);

    res.json({ ok: true, atualizado: r && r.changes > 0 });
  } catch (e) {
    console.error('[POST atribuir-posto]', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
