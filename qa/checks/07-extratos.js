'use strict';
/**
 * Check 07 — Extratos bancários e conciliação.
 */

module.exports = async function checkExtratos({ api, runner, config }) {
  runner.setModule('Extratos');

  for (const empresa of ['assessoria', 'seguranca']) {
    const r = await api.get(
      `/api/extratos?empresa=${empresa}&from=${config.anoTeste}-01-01&to=${config.anoTeste}-12-31&limit=10`
    );
    runner.expect(r.status, '===', 200, `GET /api/extratos (${empresa}) retorna 200`);
    runner.assert(Array.isArray(r.json?.data),
      `Extratos (${empresa}) retornam .data como array`,
      { note: 'qtd=' + (r.json?.data?.length ?? 0) }
    );
    if (r.json?.data?.[0]) {
      runner.assert('status_conciliacao' in r.json.data[0],
        `Cada linha de extrato (${empresa}) tem campo status_conciliacao`,
        { note: 'sample=' + r.json.data[0].status_conciliacao }
      );
    }
  }

  // Existem extratos conciliados?
  const conciliado = await api.get(
    `/api/extratos?empresa=assessoria&status_conciliacao=CONCILIADO&limit=1`
  );
  runner.assert(conciliado.json?.data?.length > 0,
    'Existem créditos com status_conciliacao=CONCILIADO em Assessoria',
    { note: 'usa o filtro como sanidade — banco está sendo conciliado' }
  );
};
