'use strict';
/**
 * Check 05 — PIS/COFINS (Segurança).
 */

module.exports = async function checkPisCofins({ api, runner, config }) {
  runner.setModule('PIS-COFINS');
  const comp = config.competenciaTeste; // '2026-03'

  const res = await api.get(`/api/piscofins-seguranca/${comp}`);
  runner.expect(res.status, '===', 200, `GET /api/piscofins-seguranca/${comp} retorna 200`);
  if (!res.ok || !res.json) {
    runner.fail('Resposta válida de PIS/COFINS', { error: res.error || res.text?.slice(0, 200) });
    return;
  }
  const d = res.json.dados || res.json;

  runner.assert(d.aplicavel, 'Apuração marcada como aplicável', { note: 'aplicavel=' + d.aplicavel });
  runner.expect(d.aliq_pis,    '===', 0.0065, 'Alíquota PIS = 0.65%');
  runner.expect(d.aliq_cofins, '===', 0.03,   'Alíquota COFINS = 3.00%');

  // Verifica fórmula: pis = base * 0.0065
  if (d.base_tributavel != null) {
    const expectedPis    = +(d.base_tributavel * 0.0065).toFixed(2);
    const expectedCofins = +(d.base_tributavel * 0.03).toFixed(2);
    runner.expect(Math.abs(d.pis - expectedPis), 'lt', 0.05,
      'PIS calculado = base × 0.65%',
      { note: `pis=${d.pis} esperado=${expectedPis}` }
    );
    runner.expect(Math.abs(d.cofins - expectedCofins), 'lt', 0.05,
      'COFINS calculado = base × 3%',
      { note: `cofins=${d.cofins} esperado=${expectedCofins}` }
    );
    runner.expect(Math.abs(d.total_darf - (expectedPis + expectedCofins)), 'lt', 0.05,
      'Total DARF = PIS + COFINS',
      { note: `total=${d.total_darf}` }
    );
  }

  // Validação de input ruim — backend deve responder 400 para formato errado.
  const bad = await api.get(`/api/piscofins-seguranca/2026`);
  runner.expect(bad.status, '===', 400,
    'Backend valida formato AAAA-MM (rejeita só ano)',
    { note: 'status=' + bad.status }
  );
};
