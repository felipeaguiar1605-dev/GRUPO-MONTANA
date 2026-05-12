'use strict';
/**
 * Check 03 — Pagamentos por Contrato (painel-pgto).
 */

module.exports = async function checkPagamentos({ api, runner, config }) {
  runner.setModule('Pagamentos');

  const mes = config.competenciaTeste; // ex: '2026-03'

  const res = await api.get(`/api/pagamentos-contrato/resumo?mes=${mes}`);
  runner.expect(res.status, '===', 200,
    `GET /api/pagamentos-contrato/resumo?mes=${mes} retorna 200`
  );
  if (!res.ok || !res.json) {
    runner.fail('Resposta válida de pagamentos-contrato', { error: res.error || res.text?.slice(0, 200) });
    return;
  }
  const d = res.json;
  runner.assert(typeof d.kpis === 'object' && d.kpis,
    'KPIs presentes na resposta',
    { note: `faturado=${d.kpis?.total_faturado} recebido=${d.kpis?.total_recebido} aberto=${d.kpis?.total_em_aberto}` }
  );
  runner.assert(Array.isArray(d.tomadores) && d.tomadores.length > 0,
    'Lista de tomadores não vazia',
    { note: 'qtd=' + (d.tomadores?.length ?? 0) }
  );

  // Status válidos
  const validStatus = new Set(['ABERTO', 'PARCIAL', 'VENCIDO', 'PAGO']);
  const invalidos = (d.tomadores || []).filter(t => !validStatus.has(t.status));
  runner.expect(invalidos.length, '===', 0,
    'Todos os tomadores têm status válido (ABERTO/PARCIAL/VENCIDO/PAGO)',
    { note: invalidos.length ? 'inválidos: ' + invalidos.map(i => i.status).join(',') : 'OK' }
  );

  // Inadimplentes (90d)
  const inad = await api.get('/api/pagamentos-contrato/inadimplentes');
  runner.expect(inad.status, '===', 200, 'GET /api/pagamentos-contrato/inadimplentes retorna 200');
  if (inad.ok && inad.json) {
    runner.ok('Lista de inadimplentes carregada',
      { note: `total=${inad.json.total} tomadores=${inad.json.inadimplentes?.length}` });
  }
};
