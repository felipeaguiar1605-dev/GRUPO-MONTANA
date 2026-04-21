/**
 * Atualiza TJ 440/2024 com dados do 1° e 2° Termos Aditivos (ZIP Semear).
 *
 * 1° TA (26/05/2025): prorrogação excepcional 01/06/2025 → 30/11/2025 (6 meses)
 *                     art. 57 §4° Lei 8.666/93
 * 2° TA (08-09/08/2025): repactuação CCT 2025/2026 (+10,53%)
 *   — valor mensal: R$ 261.381,64 → R$ 278.957,21
 *   — 61 postos totais, 11 comarcas interior, processo 24.0.000022805-9
 *   — retroativo jan-jun/2025: R$ 98.252,79
 *   — dotação: 060100 (Funjuris — CNPJ 03.173.154/0001-73)
 */
const Database = require('better-sqlite3');
const db = new Database('data/assessoria/montana.db');

const NEW_MENSAL = 278957.21;

const obs = `Contratação de REMANESCENTE DE SERVIÇO (Dispensa de Licitação vinculada ao PE 02/2020). Objeto: limpeza + conservação + copeiragem + recepção + jardinagem nas 11 Comarcas do INTERIOR do Estado (Região Central): Colinas, Guaraí, Miracema, Paraíso, Pedro Afonso, Colmeia, Cristalândia, Miranorte, Araguacema, Itacajá, Novo Acordo. 61 postos totais. CNPJ tomador: 25.053.190/0001-36. NFs são emitidas à Funjuris (CNPJ 03.173.154/0001-73). Processo SEI 24.0.000022805-9.

1° TERMO ADITIVO (26/05/2025): prorrogação excepcional de 6 meses (01/06/2025 → 30/11/2025), art. 57 §4° Lei 8.666/93.

2° TERMO ADITIVO (08-09/08/2025): REPACTUAÇÃO CCT 2025/2026 (+10,53%: 7,5% salário + 3,03% auxílio alimentação). Valor mensal passou de R$ 261.381,64 para R$ 278.957,21. Retroativo jan-jun/2025: R$ 98.252,79.

PDFs: contratos/assessoria/tj-440-2024/`;

const r = db.prepare(`
  UPDATE contratos
  SET valor_mensal_bruto = ?,
      vigencia_inicio = '2024-12-01',
      vigencia_fim = '2025-11-30',
      data_ultimo_reajuste = '2025-08-08',
      status = '✅ EM VIGOR',
      obs = ?,
      updated_at = datetime('now')
  WHERE numContrato = 'TJ 440/2024'
`).run(NEW_MENSAL, obs);

console.log('✓ TJ 440/2024 atualizado:', r.changes, 'linha(s)');
console.log('  Valor mensal: R$', NEW_MENSAL.toLocaleString('pt-BR', { minimumFractionDigits: 2 }));
console.log('  Vigência: 01/12/2024 → 30/11/2025 (prorrog. pelo 1° TA)');
console.log('  Último reajuste: 08/08/2025 (2° TA — CCT 2025/2026 +10,53%)');

const c = db.prepare(`SELECT numContrato, valor_mensal_bruto, vigencia_inicio, vigencia_fim, status, data_ultimo_reajuste FROM contratos WHERE numContrato = 'TJ 440/2024'`).get();
console.log(JSON.stringify(c, null, 2));

db.close();
