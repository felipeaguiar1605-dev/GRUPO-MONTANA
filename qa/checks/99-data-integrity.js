'use strict';
/**
 * Check 99 — Sanidade geral de dados.
 * Roda checagens cruzadas que costumam pegar regressões silenciosas.
 */

module.exports = async function checkIntegrity({ api, runner }) {
  runner.setModule('Integridade');

  // 1. Dashboard consolidado deve dar resultado positivo no grupo.
  const cons = await api.get('/api/consolidado/resumo');
  if (cons.ok && cons.json?.totais) {
    const t = cons.json.totais;
    runner.expect(t.receita_bruta, 'gt', 0, 'Total receita_bruta do grupo > 0');
    runner.expect(t.receita_liquida, 'lte', t.receita_bruta,
      'receita_liquida ≤ receita_bruta (consistência)',
      { note: `bruta=${t.receita_bruta} liq=${t.receita_liquida}` }
    );
    if (t.resultado < 0) {
      runner.warn('Resultado consolidado negativo', { note: 'R$ ' + t.resultado.toFixed(2) });
    } else {
      runner.ok('Resultado consolidado positivo', { note: 'R$ ' + t.resultado.toFixed(2) });
    }
  }

  // 2. INSS competencias retorna histórico de pelo menos 3 anos.
  const comp = await api.get('/api/inss-retido/competencias');
  if (comp.ok && Array.isArray(comp.json?.competencias)) {
    runner.expect(comp.json.competencias.length, 'gte', 24,
      'Histórico de competências INSS ≥ 24 meses',
      { note: 'qtd=' + comp.json.competencias.length }
    );
  }

  // 3. Endpoints obsoletos NÃO devem responder (sinal de rota fantasma).
  const obsoletos = [
    '/api/inss-retido/resumo',     // não existe (rodada anterior)
    '/api/pis-cofins/apuracao',    // rota errada (correta: /api/piscofins-seguranca/{ano-mes})
    '/api/pagamentos-contrato/tomadores', // sem rota
  ];
  for (const path of obsoletos) {
    const r = await api.get(path);
    if (r.status === 404) {
      runner.ok(`Rota obsoleta ${path} retorna 404 (esperado)`);
    } else {
      runner.warn(`Rota ${path} respondeu ${r.status}`, { note: 'verificar se é rota nova ou stub' });
    }
  }
};
