#!/usr/bin/env node
/**
 * Unifica os 4 postos UNITINS de Palmas em 1 único posto "PALMAS — UNITINS".
 *
 *   ANTES: Palmas — Sede / Graciosa / Complexo / Taquaruçu (4 postos, 4 NFs)
 *   DEPOIS: Palmas (1 posto, 1 NF) com soma dos itens
 *
 * Total mensal Palmas = 70.980,26 + 101.563,46 + 43.733,52 + 8.647,51 = 224.924,75
 *
 * Passos:
 * 1. Apaga boletins UNITINS de Maio+Junho/2026 (todos rascunhos)
 * 2. Move itens dos postos 48, 49, 50 para o posto 47 (com origem no nome)
 * 3. Deleta postos 48, 49, 50
 * 4. Renomeia posto 47 "Palmas — Sede" → "Palmas"
 * 5. Re-gera boletins Maio + Junho (9 postos = 9 boletins por mês)
 */
const path = require('node:path');
process.chdir(path.join(__dirname, '..'));
require('dotenv').config();
const { getDb } = require('../src/db_pg');

const POSTOS_PALMAS = {
  47: 'Sede',
  48: 'Graciosa',
  49: 'Complexo',
  50: 'Taquaruçu',
};
const POSTO_FINAL_ID = 47;

(async () => {
  const db = getDb('assessoria');

  // 1) Apaga boletins UNITINS Maio+Junho/2026
  console.log('1) Apagando boletins UNITINS Mai+Jun/2026 ...');
  for (const mes of ['2026-05', '2026-06']) {
    const dels = await db.prepare(
      `DELETE FROM bol_boletins
       WHERE contrato_id=10 AND competencia=? AND nfse_status<>'EMITIDA'
       RETURNING id, posto_id`
    ).all(mes);
    console.log(`   ${mes}: ${dels.length} boletins apagados`);
  }

  // 2) Move itens dos 3 sub-postos pro posto 47, prefixando descrição com a origem
  console.log('\n2) Movendo itens dos postos 48, 49, 50 → 47 ...');
  const maxOrdem = await db.prepare(`SELECT COALESCE(MAX(ordem),0)::int AS m FROM bol_itens WHERE posto_id=?`).get(POSTO_FINAL_ID);
  let ordem = maxOrdem.m;

  for (const [pid, origem] of Object.entries(POSTOS_PALMAS)) {
    if (Number(pid) === POSTO_FINAL_ID) continue;
    const itens = await db.prepare(`SELECT * FROM bol_itens WHERE posto_id=? ORDER BY ordem`).all(Number(pid));
    for (const it of itens) {
      ordem += 1;
      const novaDesc = `${origem}: ${it.descricao}`;
      await db.prepare(
        `UPDATE bol_itens SET posto_id=?, descricao=?, ordem=? WHERE id=?`
      ).run(POSTO_FINAL_ID, novaDesc, ordem, it.id);
    }
    console.log(`   ✓ posto ${pid} (${origem}): ${itens.length} itens movidos`);
  }

  // Também prefixa os itens originais do posto 47 com "Sede:"
  const itensSedeOriginais = await db.prepare(
    `SELECT id, descricao FROM bol_itens WHERE posto_id=? AND descricao NOT LIKE 'Sede:%' AND descricao NOT LIKE 'Graciosa:%' AND descricao NOT LIKE 'Complexo:%' AND descricao NOT LIKE 'Taquaruçu:%'`
  ).all(POSTO_FINAL_ID);
  for (const it of itensSedeOriginais) {
    await db.prepare(`UPDATE bol_itens SET descricao=? WHERE id=?`).run(`Sede: ${it.descricao}`, it.id);
  }
  console.log(`   ✓ itens originais do posto 47 receberam prefixo "Sede: " (${itensSedeOriginais.length})`);

  // 3) Deleta postos 48, 49, 50
  console.log('\n3) Deletando postos 48, 49, 50 ...');
  await db.prepare(`DELETE FROM bol_postos WHERE id IN (48, 49, 50)`).run();

  // 4) Renomeia posto 47
  console.log('4) Renomeando posto 47 "Palmas — Sede" → "Palmas" ...');
  await db.prepare(
    `UPDATE bol_postos SET campus_nome=?, label_resumo=? WHERE id=?`
  ).run('Palmas', 'Palmas (Sede+Graciosa+Complexo+Taquaruçu)', POSTO_FINAL_ID);

  // 5) Verifica totais
  const itensFinais = await db.prepare(`SELECT descricao, quantidade, valor_unitario FROM bol_itens WHERE posto_id=? ORDER BY ordem`).all(POSTO_FINAL_ID);
  let total = 0;
  for (const it of itensFinais) total += it.quantidade * it.valor_unitario;
  console.log(`\n5) Posto 47 "Palmas" agora tem ${itensFinais.length} itens, total R$ ${total.toFixed(2)}`);

  const postosFinais = await db.prepare(`SELECT id, campus_nome FROM bol_postos WHERE contrato_id=10 ORDER BY ordem, id`).all();
  console.log(`\nPostos UNITINS finais (${postosFinais.length}):`);
  for (const p of postosFinais) console.log(`   id=${p.id}  ${p.campus_nome}`);
})().catch(e => { console.error(e); process.exit(1); });
