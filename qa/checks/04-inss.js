'use strict';
/**
 * Check 04 — INSS Retido S-1300.
 * Inclui validação cruzada entre /apuracao e /relatorio (mesmo dado, mesmo
 * resultado), que é a divergência crítica detectada na rodada anterior.
 */

module.exports = async function checkINSS({ api, runner, config }) {
  runner.setModule('INSS-Retido');
  const comp = config.competenciaTeste; // ex: '2026-03'

  const competencias = await api.get('/api/inss-retido/competencias');
  runner.expect(competencias.status, '===', 200, 'GET /api/inss-retido/competencias retorna 200');

  const apur = await api.get(`/api/inss-retido/apuracao?competencia=${comp}`);
  runner.expect(apur.status, '===', 200, `GET /api/inss-retido/apuracao?competencia=${comp} retorna 200`);

  const relat = await api.get(`/api/inss-retido/relatorio?competencia=${comp}`);
  runner.expect(relat.status, '===', 200, `GET /api/inss-retido/relatorio?competencia=${comp} retorna 200`);

  if (!apur.ok || !relat.ok) {
    runner.fail('Endpoints de INSS responderam com erro', {
      error: `apuracao=${apur.status} relatorio=${relat.status}`,
    });
    return;
  }

  // Consistência entre os dois endpoints (issue 1.1 do relatório anterior).
  const apurNFs = (apur.json?.nfs || []).length;
  const apurBruto = (apur.json?.nfs || []).reduce((s, n) => s + (n.valor_bruto || 0), 0);
  const apurInss  = (apur.json?.nfs || []).reduce((s, n) => s + (n.inss || 0), 0);

  const relNFs   = relat.json?.total_nfs || 0;
  const relBruto = relat.json?.total_bruto || 0;
  const relInss  = relat.json?.total_inss || 0;

  runner.expect(apurNFs, '===', relNFs,
    'Qtd NFs em /apuracao = total_nfs em /relatorio',
    { note: `apuracao=${apurNFs} relatorio=${relNFs}` }
  );
  runner.expect(Math.abs(apurBruto - relBruto), 'lt', 1,
    'Soma valor_bruto em /apuracao = total_bruto em /relatorio',
    { note: `apuracao=${apurBruto.toFixed(2)} relatorio=${relBruto.toFixed(2)}` }
  );
  runner.expect(Math.abs(apurInss - relInss), 'lt', 1,
    'Soma INSS em /apuracao = total_inss em /relatorio',
    { note: `apuracao=${apurInss.toFixed(2)} relatorio=${relInss.toFixed(2)}` }
  );

  // KPIs mínimos presentes.
  runner.assert(relNFs > 0, 'Relatório retorna pelo menos 1 NF', { note: 'qtd=' + relNFs });
  runner.assert(typeof relat.json?.gap === 'number',
    'Campo gap (INSS − DCTFWeb) presente no relatório',
    { note: 'gap=' + relat.json?.gap }
  );
};
