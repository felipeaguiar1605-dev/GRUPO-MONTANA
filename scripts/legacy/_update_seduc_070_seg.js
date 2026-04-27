/**
 * Atualiza SEDUC 070/2023 (Segurança) com dados das repactuações e 3°TA temporal.
 * - orgao: CNPJ errado → nome oficial
 * - ata_registro_precos: Pregão Eletrônico 019/2022-SRP SEDUC (Processo 2022/27009/149226)
 * - vigencia: 26/09/2025 → 26/09/2026 (3°TA temporal, ofício GABSEC 3749/2025, aceite 27/08/2025)
 * - obs: histórico completo (original, 2° repact, 3° pedido repact 02/05/2025 pendente)
 * - DB mantém valor_mensal_bruto=76706,37 (valor por prédio das NFs emitidas 2025) —
 *   existem 3 prédios (Vbottin/Anexo IV/Madre Belém) e faturamento parece ser 1 NF/prédio/mês.
 */
const Database = require('better-sqlite3');
const db = new Database('data/seguranca/montana.db');

db.prepare(`
  UPDATE contratos
  SET orgao = 'SECRETARIA DA EDUCACAO DO ESTADO DO TOCANTINS',
      status = 'Ativo',
      vigencia_inicio = '2025-09-26',
      vigencia_fim = '2026-09-26',
      ata_registro_precos = 'Pregão Eletrônico 019/2022 - SRP SEDUC (Processo Administrativo SGD 2022/27009/149226). CCT base SINTIVISTO 073/2022 (original) / TO 56/2025 (3° pedido repactuação).',
      obs = 'Contrato 070/2023 — Vigilância Patrimonial Armada SEDUC/TO. 6 postos (3 diurnos + 3 noturnos) distribuídos em 3 prédios (Vbottin, Anexo IV, Madre Belém). Processo originário 2023/27000/019225. Faturamento mensal: 3 NFs (1 por prédio), cada ~R$ 76.706,37. 2° Repactuação aprovada (valor 2024 atualizado para R$ 79.924,15/mês total - base planilha). 3° Pedido de Repactuação enviado 02/05/2025 para CCT TO 56/2025 (+10,7%) — novo valor R$ 86.108,46/mês — PENDENTE DE DEFERIMENTO. 3° TA temporal (prorrogação 12 meses) aceito 27/08/2025 em resposta ao Ofício 3749/2025/GABSEC/SEDUC — vigência estendida até 26/09/2026. Repactuação 2025 segue pendente. PDFs arquivados em contratos/seguranca/seduc-070-2023/',
      data_ultimo_reajuste = '2025-08-27',
      indice_reajuste = '3° TA temporal + 3° pedido repactuação CCT TO 56/2025 pendente',
      updated_at = datetime('now')
  WHERE numContrato = 'SEDUC 070/2023 + 3°TA'
`).run();

const r = db.prepare(`
  SELECT numContrato, valor_mensal_bruto, orgao, status, vigencia_inicio, vigencia_fim,
         ata_registro_precos, data_ultimo_reajuste, indice_reajuste
  FROM contratos WHERE numContrato = 'SEDUC 070/2023 + 3°TA'
`).get();
console.log('Segurança 070/2023 atualizado:');
console.log(JSON.stringify(r, null, 2));
db.close();
