'use strict';
/**
 * Check 06 — Despesas: lista, categorias, filtros.
 */

module.exports = async function checkDespesas({ api, runner, config }) {
  runner.setModule('Despesas');

  for (const empresa of ['assessoria', 'seguranca']) {
    const cat = await api.get(`/api/despesas/categorias?empresa=${empresa}`);
    runner.expect(cat.status, '===', 200,
      `GET /api/despesas/categorias?empresa=${empresa} retorna 200`
    );
    runner.assert(Array.isArray(cat.json) && cat.json.length > 0,
      `Categorias de despesas (${empresa}) não vazias`,
      { note: 'qtd=' + (cat.json?.length ?? 0) }
    );

    const lista = await api.get(`/api/despesas?empresa=${empresa}&from=${config.anoTeste}-01-01&to=${config.anoTeste}-12-31`);
    runner.expect(lista.status, '===', 200,
      `GET /api/despesas?empresa=${empresa} (ano ${config.anoTeste}) retorna 200`
    );
    runner.assert(Array.isArray(lista.json?.data),
      `Lista de despesas (${empresa}) retorna array .data`,
      { note: 'qtd=' + (lista.json?.data?.length ?? 0) }
    );
  }
};
