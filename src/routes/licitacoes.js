/**
 * Montana — Módulo de Licitações
 * CRUD completo + KPIs + pipeline de status.
 */
const express = require('express');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

// GET /api/licitacoes
router.get('/', async (req, res) => {
  const { status, modalidade, orgao } = req.query;
  let where = '1=1';
  const p = {};
  if (status)    { where += ' AND status=@status';          p.status    = status; }
  if (modalidade){ where += ' AND modalidade=@modalidade';  p.modalidade= modalidade; }
  if (orgao)     { where += ' AND orgao LIKE @orgao';       p.orgao     = '%'+orgao+'%'; }

  const rows = await req.db.prepare(`SELECT * FROM licitacoes WHERE ${where} ORDER BY data_abertura DESC`).all(p);
  res.json({ data: rows, total: rows.length });
});

// GET /api/licitacoes/kpis
router.get('/kpis', async (req, res) => {
  const total    = await req.db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(valor_proposta),0) v FROM licitacoes`).get();
  const ganhou   = await req.db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(valor_proposta),0) v FROM licitacoes WHERE status='ganhou'`).get();
  const perdeu   = await req.db.prepare(`SELECT COUNT(*) n FROM licitacoes WHERE status='perdeu'`).get();
  const desistiu = await req.db.prepare(`SELECT COUNT(*) n FROM licitacoes WHERE status='desistiu'`).get();
  const disputa  = await req.db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(valor_estimado),0) v FROM licitacoes WHERE status IN ('em análise','proposta enviada','recurso')`).get();
  const proximas = await req.db.prepare(`
    SELECT * FROM licitacoes
    WHERE safe_date(data_abertura) >= CURRENT_DATE AND status IN ('em análise','proposta enviada')
    ORDER BY data_abertura ASC LIMIT 5
  `).all();
  const porStatus = await req.db.prepare(`SELECT status, COUNT(*) n FROM licitacoes GROUP BY status`).all();

  const finalizadas = ganhou.n + perdeu.n + desistiu.n;
  const taxa = finalizadas > 0 ? +((ganhou.n / finalizadas) * 100).toFixed(1) : 0;

  res.json({
    total: total.n, total_valor: +total.v.toFixed(2),
    ganhou: ganhou.n, ganhou_valor: +ganhou.v.toFixed(2),
    perdeu: perdeu.n, desistiu: desistiu.n,
    em_disputa: disputa.n, em_disputa_valor: +disputa.v.toFixed(2),
    taxa_aproveitamento: taxa,
    proximas_aberturas: proximas,
    por_status: porStatus
  });
});

// POST /api/licitacoes
router.post('/', async (req, res) => {
  const { orgao, numero_edital, modalidade, objeto, data_abertura, data_encerramento, valor_estimado, valor_proposta, status, resultado, observacoes } = req.body;
  const r = await req.db.prepare(`
    INSERT INTO licitacoes (orgao,numero_edital,modalidade,objeto,data_abertura,data_encerramento,valor_estimado,valor_proposta,status,resultado,observacoes)
    VALUES (@orgao,@numero_edital,@modalidade,@objeto,@data_abertura,@data_encerramento,@valor_estimado,@valor_proposta,@status,@resultado,@observacoes)
  `).run({
    orgao:orgao||'', numero_edital:numero_edital||'', modalidade:modalidade||'pregão',
    objeto:objeto||'', data_abertura:data_abertura||'', data_encerramento:data_encerramento||'',
    valor_estimado:parseFloat(valor_estimado)||0, valor_proposta:parseFloat(valor_proposta)||0,
    status:status||'em análise', resultado:resultado||'', observacoes:observacoes||''
  });
  res.json({ ok: true, id: r.lastInsertRowid });
});

// PUT /api/licitacoes/:id
router.put('/:id', async (req, res) => {
  const { orgao, numero_edital, modalidade, objeto, data_abertura, data_encerramento, valor_estimado, valor_proposta, status, resultado, observacoes } = req.body;
  await req.db.prepare(`
    UPDATE licitacoes SET orgao=@orgao,numero_edital=@numero_edital,modalidade=@modalidade,
    objeto=@objeto,data_abertura=@data_abertura,data_encerramento=@data_encerramento,
    valor_estimado=@valor_estimado,valor_proposta=@valor_proposta,status=@status,
    resultado=@resultado,observacoes=@observacoes,updated_at=NOW()
    WHERE id=@id
  `).run({
    orgao:orgao||'', numero_edital:numero_edital||'', modalidade:modalidade||'pregão',
    objeto:objeto||'', data_abertura:data_abertura||'', data_encerramento:data_encerramento||'',
    valor_estimado:parseFloat(valor_estimado)||0, valor_proposta:parseFloat(valor_proposta)||0,
    status:status||'em análise', resultado:resultado||'', observacoes:observacoes||'',
    id: req.params.id
  });
  res.json({ ok: true });
});

// DELETE /api/licitacoes/:id
router.delete('/:id', async (req, res) => {
  await req.db.prepare('DELETE FROM licitacoes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
