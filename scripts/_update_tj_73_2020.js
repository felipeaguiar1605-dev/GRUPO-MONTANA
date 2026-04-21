/**
 * Atualiza TJ 73/2020 com dados do 14° e 15° Termos Aditivos (ZIP Semear).
 *
 * Contrato original: PE 12/2019, assinado 01/06/2020.
 * 14° TA (26/05/2025): prorrogação excepcional 01/06/2025 → 30/11/2025
 *                      (6 meses, total 66 meses desde assinatura — art. 57 §4° Lei 8.666/93)
 * 15° TA (12-13/08/2025): repactuação CCT 2025/2026 (+10,53%)
 *   — valor mensal: R$ 1.189.739,77 → R$ 1.287.679,27
 *   — valor global anual: R$ 15.452.151,24
 *   — retroativo jan-jun/2025: R$ 519.576,84
 *   — comarcas abrangidas: Araguaína, Araguatins, Tocantinópolis, Ananás, Arapoema,
 *     Augustinópolis, Filadélfia, Itaguatins, Xambioá, Goiatins, Wanderlândia,
 *     Arraias, Dianópolis, Gurupi, Taguatinga + Comarca de Palmas + Sede TJ.
 */
const Database = require('better-sqlite3');
const db = new Database('data/assessoria/montana.db');

const NEW_MENSAL = 1287679.27;

const obs = `Contrato nº 73/2020 TJ/TO — limpeza + conservação + copeiragem + recepção + jardinagem + marcenaria + carregador + lavador de fachada + encarregado para a Sede do TJ, anexos, Centro de Educação Infantil, Comarca de Palmas, e Comarcas do interior (Araguaína, Araguatins, Tocantinópolis, Ananás, Arapoema, Augustinópolis, Filadélfia, Itaguatins, Xambioá, Goiatins, Wanderlândia, Arraias, Dianópolis, Gurupi, Taguatinga). Origem: PE 12/2019. CNPJ tomador: 25.053.190/0001-36. NFs Funjuris (CNPJ 03.173.154/0001-73).

14° TERMO ADITIVO (26/05/2025): prorrogação excepcional de 6 meses (01/06/2025 → 30/11/2025), totalizando 66 meses desde assinatura original.

15° TERMO ADITIVO (12-13/08/2025): REPACTUAÇÃO CCT 2025/2026 (+10,53%). Valor mensal passou de R$ 1.189.739,77 para R$ 1.287.679,27. Valor global 12 meses: R$ 15.452.151,24. Retroativo jan-jun/2025: R$ 519.576,84.

15 termos aditivos no histórico (2020-2025). PDFs: contratos/assessoria/tj-73-2020/`;

const r = db.prepare(`
  UPDATE contratos
  SET valor_mensal_bruto = ?,
      vigencia_inicio = '2020-06-01',
      vigencia_fim = '2025-11-30',
      data_ultimo_reajuste = '2025-08-12',
      status = '✅ EM VIGOR',
      obs = ?,
      updated_at = datetime('now')
  WHERE numContrato = 'TJ 73/2020'
`).run(NEW_MENSAL, obs);

console.log('✓ TJ 73/2020 atualizado:', r.changes, 'linha(s)');
console.log('  Valor mensal: R$', NEW_MENSAL.toLocaleString('pt-BR', { minimumFractionDigits: 2 }));
console.log('  Vigência: 01/06/2020 → 30/11/2025 (66 meses, 14° TA)');
console.log('  Último reajuste: 12/08/2025 (15° TA — CCT 2025/2026 +10,53%)');

const c = db.prepare(`SELECT numContrato, valor_mensal_bruto, vigencia_inicio, vigencia_fim, status, data_ultimo_reajuste FROM contratos WHERE numContrato = 'TJ 73/2020'`).get();
console.log(JSON.stringify(c, null, 2));

db.close();
