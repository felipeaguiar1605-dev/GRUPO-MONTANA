'use strict';
/**
 * Check 08 — Contratos: lista, valores mensais, status.
 */

module.exports = async function checkContratos({ api, runner }) {
  runner.setModule('Contratos');

  for (const empresa of ['assessoria', 'seguranca']) {
    const r = await api.get(`/api/contratos?empresa=${empresa}`);
    runner.expect(r.status, '===', 200, `GET /api/contratos?empresa=${empresa} retorna 200`);
    if (!r.ok || !Array.isArray(r.json?.data)) {
      runner.fail(`Lista de contratos (${empresa}) inválida`, { error: r.error || r.text?.slice(0, 200) });
      continue;
    }
    const contratos = r.json.data;
    const ativos = contratos.filter(c => !/encerrado/i.test(c.status || ''));
    const semValor = ativos.filter(c => !c.valor_mensal_bruto || c.valor_mensal_bruto === 0);

    runner.assert(contratos.length > 0,
      `Existem contratos cadastrados (${empresa})`,
      { note: 'total=' + contratos.length }
    );
    runner.assert(ativos.length > 0,
      `Existem contratos ativos (${empresa})`,
      { note: 'ativos=' + ativos.length }
    );

    // Soft-fail: contratos ativos sem valor_mensal_bruto é problema de dados, não bug.
    if (semValor.length === 0) {
      runner.ok(`Todos contratos ativos (${empresa}) têm valor_mensal_bruto > 0`);
    } else {
      runner.warn(`Contratos ativos (${empresa}) sem valor_mensal_bruto`, {
        note: `${semValor.length}/${ativos.length} ativos sem valor — ` + semValor.map(c => c.numcontrato || c.id).join(', '),
      });
    }

    // Verificar consistência da taxonomia de status.
    const statusUnicos = [...new Set(contratos.map(c => c.status || '(vazio)'))];
    if (statusUnicos.length > 4) {
      runner.warn(`Taxonomia de status em (${empresa}) com muitos valores`, {
        note: `${statusUnicos.length} valores distintos: ${statusUnicos.join(' | ')}`,
      });
    }
  }
};
