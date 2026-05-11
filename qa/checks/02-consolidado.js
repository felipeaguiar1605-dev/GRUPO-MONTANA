'use strict';
/**
 * Check 02 — Dashboard Consolidado.
 * Valida que a API retorna dados das 4 empresas com receitas plausíveis.
 */

module.exports = async function checkConsolidado({ api, runner, config }) {
  runner.setModule('Consolidado');

  const res = await api.get('/api/consolidado/resumo');
  runner.expect(res.status, '===', 200, 'GET /api/consolidado/resumo retorna 200');
  if (!res.ok || !res.json) {
    runner.fail('Resposta JSON válida do consolidado', { error: res.error || res.text?.slice(0, 200) });
    return;
  }
  const d = res.json;
  runner.assert(Array.isArray(d.empresas) && d.empresas.length === 4,
    'Resposta contém 4 empresas',
    { note: 'qtd=' + (d.empresas?.length ?? 0) }
  );

  const byKey = Object.fromEntries((d.empresas || []).map(e => [e.empresa, e]));

  // Empresas operacionais devem ter receita > sanity threshold.
  const limiar = config.sanidade?.receitaMinAssessoria ?? 10_000_000;
  runner.expect(byKey.assessoria?.receita_bruta || 0, 'gte', limiar,
    `Receita bruta da Assessoria ≥ ${(limiar/1e6).toFixed(0)}M (sanidade)`,
    { note: 'receita_bruta=' + byKey.assessoria?.receita_bruta }
  );
  runner.expect(byKey.seguranca?.receita_bruta || 0, 'gte', config.sanidade?.receitaMinSeguranca ?? 5_000_000,
    'Receita bruta da Segurança acima do piso de sanidade',
    { note: 'receita_bruta=' + byKey.seguranca?.receita_bruta }
  );

  // Porto e Mustang devem estar zerados (bancos vazios).
  for (const k of ['portodovau', 'mustang']) {
    runner.expect(byKey[k]?.receita_bruta, '===', 0,
      `${k} com receita_bruta = 0 (bancos vazios)`,
      { note: 'receita_bruta=' + byKey[k]?.receita_bruta }
    );
  }

  // Total deve ser igual à soma das partes.
  const soma = (d.empresas || []).reduce((acc, e) => acc + (e.receita_bruta || 0), 0);
  const tot = d.totais?.receita_bruta || 0;
  runner.expect(Math.abs(soma - tot), 'lt', 1,
    'Total grupo = soma das 4 empresas (consistência aritmética)',
    { note: `total=${tot} soma=${soma}` }
  );
};
