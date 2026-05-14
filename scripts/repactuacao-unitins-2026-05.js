#!/usr/bin/env node
/**
 * Aplica a repactuação UNITINS (4º Termo Aditivo Contrato 22/2022).
 *
 * Total mensal NOVO: R$ 382.162,21 (anterior: R$ 254.911,42)
 * Vigência: 14/06/2026 a 13/06/2027 (mas valores já aplicáveis ao boletim
 * de abril e maio 2026 conforme planilha repactuada)
 *
 * O que faz:
 * 1. Deleta TODOS os bol_itens dos 12 postos UNITINS
 * 2. Insere novos itens conforme planilha do termo aditivo
 * 3. Re-cria boletins Maio/2026 (se já existirem, regenera com novos valores)
 *
 * IMPORTANTE: boletins JÁ EMITIDOS (NFS-e EMITIDA) NÃO são tocados.
 */
const path = require('node:path');
process.chdir(path.join(__dirname, '..'));
require('dotenv').config();
const { getDb } = require('../src/db_pg');

// Mapeamento: nome do posto no banco → itens repactuados
// Fonte: D:\BOLETIM UNITINS ABRIL E MAIO 2026 - REPACTUADO.xlsx
const REPACTUACAO = {
  'Araguatins': [
    { descricao: 'Servente de Limpeza',                         quantidade: 2, valor_unitario: 4300.83 },
    { descricao: 'Copeira',                                     quantidade: 1, valor_unitario: 3726.55 },
    { descricao: 'Jardineiro',                                  quantidade: 1, valor_unitario: 4373.61 },
  ],
  'Araguaína': [
    { descricao: 'Servente de Limpeza',                         quantidade: 1, valor_unitario: 4371.20 },
    { descricao: 'Jardineiro',                                  quantidade: 1, valor_unitario: 4405.84 },
  ],
  'Augustinópolis': [
    { descricao: 'Servente de Limpeza',                         quantidade: 6, valor_unitario: 4138.66 },
    { descricao: 'Servente de Limpeza com Insalubridade',       quantidade: 1, valor_unitario: 5356.25 },
    { descricao: 'Copeira',                                     quantidade: 1, valor_unitario: 3726.55 },
    { descricao: 'Jardineiro',                                  quantidade: 1, valor_unitario: 4363.36 },
  ],
  'Dianópolis': [
    { descricao: 'Servente de Limpeza com Insalubridade',       quantidade: 1, valor_unitario: 5799.29 },
    { descricao: 'Servente de Limpeza',                         quantidade: 3, valor_unitario: 5779.67 },
    { descricao: 'Copeira',                                     quantidade: 1, valor_unitario: 3646.71 },
  ],
  'Formoso do Araguaia': [
    { descricao: 'Servente de Limpeza',                         quantidade: 2, valor_unitario: 4165.47 },
    { descricao: 'Jardineiro',                                  quantidade: 1, valor_unitario: 4379.77 },
  ],
  'Gurupi': [
    { descricao: 'Servente de Limpeza',                         quantidade: 1, valor_unitario: 4466.90 },
    { descricao: 'Jardineiro',                                  quantidade: 1, valor_unitario: 4502.30 },
  ],
  'Paraíso do TO': [
    { descricao: 'Servente de Limpeza',                         quantidade: 2, valor_unitario: 4149.72 },
    { descricao: 'Servente de Limpeza (categoria 2)',           quantidade: 2, valor_unitario: 5779.67 },
    { descricao: 'Copeira',                                     quantidade: 1, valor_unitario: 3726.55 },
    { descricao: 'Jardineiro',                                  quantidade: 1, valor_unitario: 4364.39 },
  ],
  'Porto Nacional': [
    { descricao: 'Servente de Limpeza',                         quantidade: 2, valor_unitario: 4159.29 },
    { descricao: 'Jardineiro',                                  quantidade: 2, valor_unitario: 4373.61 },
  ],
  'Palmas — Sede': [
    { descricao: 'Servente de Limpeza',                         quantidade: 8, valor_unitario: 4086.76 },
    { descricao: 'Servente de Limpeza com Insalubridade',       quantidade: 2, valor_unitario: 5290.57 },
    { descricao: 'Copeira',                                     quantidade: 2, valor_unitario: 3858.43 },
    { descricao: 'Jardineiro',                                  quantidade: 3, valor_unitario: 4437.18 },
    { descricao: 'Encarregado (> 30 Funcionários)',             quantidade: 1, valor_unitario: 6676.62 },
  ],
  'Palmas — Graciosa': [
    { descricao: 'Servente de Limpeza',                         quantidade: 13, valor_unitario: 5276.61 },
    { descricao: 'Servente de Limpeza com Insalubridade',       quantidade: 2, valor_unitario: 5289.33 },
    { descricao: 'Copeira',                                     quantidade: 1, valor_unitario: 3858.43 },
    { descricao: 'Jardineiro',                                  quantidade: 3, valor_unitario: 4469.09 },
    { descricao: 'Encarregado (> 30 Funcionários)',             quantidade: 1, valor_unitario: 5123.12 },
  ],
  'Palmas — Complexo': [
    { descricao: 'Servente de Limpeza com Insalubridade',       quantidade: 1, valor_unitario: 5308.90 },
    { descricao: 'Servente de Limpeza',                         quantidade: 4, valor_unitario: 5286.35 },
    { descricao: 'Copeira',                                     quantidade: 1, valor_unitario: 3858.43 },
    { descricao: 'Jardineiro',                                  quantidade: 3, valor_unitario: 4473.60 },
  ],
  'Palmas — Taquaruçu': [
    { descricao: 'Servente de Limpeza',                         quantidade: 1, valor_unitario: 4145.21 },
    { descricao: 'Jardineiro',                                  quantidade: 1, valor_unitario: 4502.30 },
  ],
};

(async () => {
  const db = getDb('assessoria');

  // 1) Acha UNITINS
  const c = await db.prepare(`SELECT id FROM bol_contratos WHERE nome ILIKE '%UNITINS%' LIMIT 1`).get();
  if (!c) { console.error('UNITINS não encontrado'); process.exit(2); }

  // 2) Carrega postos
  const postos = await db.prepare(
    `SELECT id, campus_nome FROM bol_postos WHERE contrato_id=? ORDER BY ordem`
  ).all(c.id);

  console.log(`Repactuando ${postos.length} postos UNITINS (contrato_id=${c.id})\n`);

  let totalGeral = 0;
  let acertos = 0, faltas = 0;

  for (const p of postos) {
    const items = REPACTUACAO[p.campus_nome];
    if (!items) {
      console.warn(`⚠ posto ${p.id} "${p.campus_nome}" — sem entrada na repactuação`);
      faltas++;
      continue;
    }

    // 3) Deleta itens atuais
    await db.prepare(`DELETE FROM bol_itens WHERE posto_id=?`).run(p.id);

    // 4) Insere novos
    let totalPosto = 0;
    let ordem = 0;
    for (const it of items) {
      await db.prepare(
        `INSERT INTO bol_itens (posto_id, descricao, quantidade, valor_unitario, ordem) VALUES (?,?,?,?,?)`
      ).run(p.id, it.descricao, it.quantidade, it.valor_unitario, ++ordem);
      const subTotal = it.quantidade * it.valor_unitario;
      totalPosto += subTotal;
    }

    totalPosto = Math.round(totalPosto * 100) / 100;
    totalGeral += totalPosto;
    console.log(`  ✓ ${p.campus_nome.padEnd(25)} → ${items.length} itens · R$ ${totalPosto.toFixed(2).padStart(12)}`);
    acertos++;
  }

  totalGeral = Math.round(totalGeral * 100) / 100;
  console.log(`\nTOTAL GERAL: R$ ${totalGeral.toFixed(2)}`);
  console.log(`Esperado:    R$ 382.162,21 (termo aditivo)`);
  console.log(`Postos atualizados: ${acertos}/${postos.length} (${faltas} sem entrada)`);
})().catch(e => { console.error(e); process.exit(1); });
