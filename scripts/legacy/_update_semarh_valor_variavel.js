/**
 * Ajusta SEMARH 32/2024 — valor_mensal_bruto estava R$ 37.516,00 (incorreto).
 *
 * NATUREZA DO CONTRATO: 4 serventes + 1 artífice jardinagem + MATERIAIS SOB DEMANDA.
 * Materiais variam mês a mês → NFs são flutuantes → valor_mensal_bruto fixo não faz sentido.
 *
 * Decisão (2026-04-20): usar valor-base de mão de obra pós reajuste CCT 2025/2026.
 *   - NFs mar-abr/2026 têm valor bruto: R$ 29.182,67 (sem materiais do mês)
 *   - NFs dez/2025 (antes reajuste): R$ 29.471,28 — ver contrato base R$ 353.655,36/ano ÷ 12
 *   - NFs com materiais podem chegar a R$ 74.902,74 (ex: fev/2026 — 2 meses + materiais)
 *
 * KPIs/relatórios devem usar SUM(valor_bruto) das NFs, não valor_mensal_bruto × 12.
 */
const Database = require('better-sqlite3');
const db = new Database('data/assessoria/montana.db');

const NOVO_VALOR = 29182.67;  // mão de obra pós reajuste CCT 2025/2026

const obs = `Contrato 32/2024 — Limpeza/Conservação/Copa/Jardinagem/Controle de Pragas SEMARH/TO. Objeto original: 4 serventes + 1 artífice jardinagem + MATERIAIS SOB DEMANDA. Valor anual inicial R$ 353.655,36 (média R$ 29.471,28/mês).

⚠️ NFs FLUTUANTES — materiais variam mês a mês. Valor fixo não representa faturamento real. Usar SUM(notas_fiscais.valor_bruto) para KPIs, não valor_mensal_bruto × 12.

REAJUSTE 19/12/2025 (CCT 2025/2026): valor mão de obra base passou para R$ 29.182,67/mês. Com materiais, NFs podem chegar a R$ 74k+ (ex: fev/2026 R$ 74.902,74).

Vigência: 2024-12-26 → 2026-12-26. CNPJ tomador: SEMARH/TO.`;

const r = db.prepare(`
  UPDATE contratos
  SET valor_mensal_bruto = ?,
      obs = ?,
      updated_at = datetime('now')
  WHERE numContrato = 'SEMARH 32/2024'
`).run(NOVO_VALOR, obs);

console.log('✓ SEMARH 32/2024 atualizado:', r.changes, 'linha(s)');
console.log('  valor_mensal_bruto: R$ 37.516,00 → R$ 29.182,67 (mão de obra pós CCT 2025/2026)');
console.log('  obs: documentado que NFs são flutuantes por materiais sob demanda');

// Verificação
const c = db.prepare(`SELECT numContrato, valor_mensal_bruto, vigencia_inicio, vigencia_fim FROM contratos WHERE numContrato = 'SEMARH 32/2024'`).get();
console.log('\nEstado atual:', JSON.stringify(c, null, 2));

db.close();
