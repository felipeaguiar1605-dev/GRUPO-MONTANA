/**
 * Atualiza SEDUC 11/2023 (Segurança) com 4º Apostilamento + 3º TA.
 * - valor_mensal_bruto: 51.003,98 (por posto) → 637.723,15 (total mensal pós-repactuação 30/12/2025)
 * - vigência: 31/03/2026 → 31/03/2027 (3ºTA assinado 06/03/2026)
 * - orgao: CNPJ errado → nome oficial
 * - ata_registro_precos: pendente (usuário vai localizar)
 * - obs: histórico completo (original, repactuação, reajuste por posto)
 */
const Database = require('better-sqlite3');
const db = new Database('data/seguranca/montana.db');

db.prepare(`
  UPDATE contratos
  SET valor_mensal_bruto = 637723.15,
      valor_mensal_liquido = NULL,
      orgao = 'SECRETARIA DA EDUCACAO DO ESTADO DO TOCANTINS',
      status = 'Ativo',
      vigencia_inicio = '2026-03-31',
      vigencia_fim = '2027-03-31',
      ata_registro_precos = 'ATA de origem pendente de localização (contrato 011/2023 derivado de licitação). Processo Originário 2022/27000/005515, Traslado 2024/27000/004671',
      obs = 'Contrato 011/2023 — Vigilância Patrimonial Armada SEDUC/TO. 12 postos de vigilância. Valor original: R$ 612.148,46/mês (R$ 51.003,98/posto). 4º Apostilamento (30/12/2025): repactuação baseada em CCT Sintivisto-TO 17/2024, aumento de R$ 25.675,42/mês → total atual R$ 637.723,15/mês (R$ 53.143,60/posto). 3º Termo Aditivo (06/03/2026): prorrogação de vigência 31/03/2026 a 31/03/2027 com pedido de nova repactuação pendente. Faturamento: 1 NF por posto/mês. SEDUC atrasa empenhos frequentemente — NFs emitidas em bloco. PDFs arquivados em contratos/seguranca/seduc-011-2023/',
      data_ultimo_reajuste = '2025-12-30',
      indice_reajuste = 'CCT Sintivisto-TO 17/2024',
      pct_reajuste_ultimo = 4.19,
      updated_at = datetime('now')
  WHERE numContrato = 'SEDUC 11/2023 + 3°TA'
`).run();

const r = db.prepare(`
  SELECT numContrato, valor_mensal_bruto, orgao, status, vigencia_inicio, vigencia_fim,
         ata_registro_precos, data_ultimo_reajuste, indice_reajuste, pct_reajuste_ultimo
  FROM contratos WHERE numContrato = 'SEDUC 11/2023 + 3°TA'
`).get();
console.log('Segurança DB atualizado:');
console.log(JSON.stringify(r, null, 2));
db.close();
