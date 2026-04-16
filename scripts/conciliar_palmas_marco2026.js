'use strict';
/**
 * Conciliação NFs Palmas — março/2026
 * NFs 219–310 emitidas em 02/03/2026, referentes a serviços de set/24 a dez/25
 * Fonte: PDFs da pasta "E:\NF EMISSÃO MARÇO PREFEITURA"
 *
 * Ações:
 *  1. Atualiza discriminacao das NFs com o mês de referência real do serviço
 *  2. Marca como CONCILIADO as 72 NFs que têm comprovante de pagamento
 *  3. Gera relatório de quais NFs ainda estão sem comprovante (19 NFs)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const db = getDb('seguranca');

// Dados dos PDFs: [numero, mes_referencia, tem_comprovante, data_pagamento]
const NFS_PDFS = [
  // ── COM COMPROVANTE (72 NFs pagas) ─────────────────────────────────────────
  ['202600000000219','Setembro/2025',true,'2026-03-13'],
  ['202600000000220','Setembro/2025',true,'2026-03-18'],
  ['202600000000221','Setembro/2025',true,'2026-03-18'],
  ['202600000000222','Setembro/2025',true,'2026-03-18'],
  ['202600000000223','Outubro/2025',true,'2026-03-13'],
  ['202600000000224','Outubro/2025',true,'2026-03-13'],
  ['202600000000227','Outubro/2025',true,'2026-03-18'],
  ['202600000000230','Novembro/2025',true,'2026-03-31'],
  ['202600000000231','Novembro/2025',true,'2026-03-13'],
  ['202600000000232','Novembro/2025',true,'2026-03-13'],
  ['202600000000234','Novembro/2025',true,'2026-03-13'],
  ['202600000000235','Novembro/2025',true,'2026-03-13'],
  ['202600000000236','Novembro/2025',true,'2026-03-31'],
  ['202600000000237','Novembro/2025',true,'2026-03-13'],
  ['202600000000238','Novembro/2025',true,'2026-03-13'],
  ['202600000000239','Novembro/2025',true,'2026-03-13'],
  ['202600000000240','Novembro/2025',true,'2026-03-13'],
  ['202600000000241','Novembro/2025',true,'2026-03-13'],
  ['202600000000244','Novembro/2025',true,'2026-03-13'],
  ['202600000000245','Novembro/2025',true,'2026-03-13'],
  ['202600000000246','Novembro/2025',true,'2026-03-31'],
  ['202600000000248','Novembro/2025',true,'2026-03-31'],
  ['202600000000249','Novembro/2025',true,'2026-03-13'],
  ['202600000000250','Novembro/2025',true,'2026-03-13'],
  ['202600000000253','Novembro/2025',true,'2026-03-13'],
  ['202600000000254','Novembro/2025',true,'2026-03-13'],
  ['202600000000255','Novembro/2025',true,'2026-03-31'],
  ['202600000000256','Novembro/2025',true,'2026-03-13'],
  ['202600000000257','Novembro/2025',true,'2026-03-13'],
  ['202600000000258','Novembro/2025',true,'2026-03-31'],
  ['202600000000260','Dezembro/2025',true,'2026-03-13'],
  ['202600000000261','Dezembro/2025',true,'2026-03-13'],
  ['202600000000264','Dezembro/2025',true,'2026-03-13'],
  ['202600000000265','Dezembro/2025',true,'2026-03-13'],
  ['202600000000266','Dezembro/2025',true,'2026-03-31'],
  ['202600000000267','Dezembro/2025',true,'2026-03-13'],
  ['202600000000268','Dezembro/2025',true,'2026-03-13'],
  ['202600000000269','Dezembro/2025',true,'2026-03-13'],
  ['202600000000271','Dezembro/2025',true,'2026-03-13'],
  ['202600000000274','Dezembro/2025',true,'2026-03-13'],
  ['202600000000275','Dezembro/2025',true,'2026-03-13'],
  ['202600000000276','Dezembro/2025',true,'2026-03-13'],
  ['202600000000278','Dezembro/2025',true,'2026-03-13'],
  ['202600000000279','Dezembro/2025',true,'2026-03-13'],
  ['202600000000280','Dezembro/2025',true,'2026-03-13'],
  ['202600000000283','Dezembro/2025',true,'2026-03-13'],
  ['202600000000284','Dezembro/2025',true,'2026-03-13'],
  ['202600000000285','Dezembro/2025',true,'2026-03-13'],
  ['202600000000286','Dezembro/2025',true,'2026-03-13'],
  ['202600000000287','Dezembro/2025',true,'2026-03-13'],
  ['202600000000288','Dezembro/2025',true,'2026-03-13'],
  ['202600000000290','Dezembro/2024',true,'2026-03-13'],
  ['202600000000291','Dezembro/2024',true,'2026-03-13'],
  ['202600000000292','Dezembro/2024',true,'2026-03-13'],
  ['202600000000293','Dezembro/2024',true,'2026-03-18'],
  ['202600000000294','Dezembro/2024',true,'2026-03-25'],
  ['202600000000295','Dezembro/2024',true,'2026-03-16'],
  ['202600000000296','Dezembro/2024',true,'2026-03-13'],
  ['202600000000297','Dezembro/2024',true,'2026-03-13'],
  ['202600000000298','Dezembro/2024',true,'2026-03-13'],
  ['202600000000299','Dezembro/2024',true,'2026-03-13'],
  ['202600000000300','Dezembro/2024',true,'2026-03-31'],
  ['202600000000301','Dezembro/2024',true,'2026-03-13'],
  ['202600000000302','Dezembro/2024',true,'2026-03-13'],
  ['202600000000303','Dezembro/2024',true,'2026-03-13'],
  ['202600000000304','Dezembro/2024',true,'2026-03-31'],
  ['202600000000305','Dezembro/2024',true,'2026-03-31'],
  ['202600000000306','Dezembro/2024',true,'2026-03-13'],
  ['202600000000307','Dezembro/2024',true,'2026-03-13'],
  ['202600000000308','Dezembro/2024',true,'2026-03-31'],
  ['202600000000309','Dezembro/2024',true,'2026-03-13'],
  ['202600000000310','Dezembro/2024',true,'2026-03-13'],
  // ── SEM COMPROVANTE (19 NFs) ────────────────────────────────────────────────
  ['202600000000225','Outubro/2025',false,null],
  ['202600000000226','Outubro/2025',false,null],
  ['202600000000228','Outubro/2025',false,null],
  ['202600000000229','Outubro/2025',false,null],
  ['202600000000233','Novembro/2025',false,null],
  ['202600000000242','Novembro/2025',false,null],
  ['202600000000243','Novembro/2025',false,null],
  ['202600000000247','Novembro/2025',false,null],
  ['202600000000251','Novembro/2025',false,null],
  ['202600000000252','Novembro/2025',false,null],
  ['202600000000259','Novembro/2025',false,null],
  ['202600000000262','Dezembro/2025',false,null],
  ['202600000000263','Dezembro/2025',false,null],
  ['202600000000270','Dezembro/2025',false,null],
  ['202600000000272','Dezembro/2025',false,null],
  ['202600000000273','Dezembro/2025',false,null],
  ['202600000000277','Dezembro/2025',false,null],
  ['202600000000281','Dezembro/2025',false,null],
  ['202600000000282','Dezembro/2025',false,null],
];

console.log('\n🔗 Conciliação NFs Palmas — Março/2026\n');

const stmtGetNf = db.prepare('SELECT id, numero, valor_liquido, status_conciliacao, discriminacao FROM notas_fiscais WHERE numero=?');
const stmtUpdDisc = db.prepare('UPDATE notas_fiscais SET discriminacao=? WHERE numero=?');
const stmtConcilia = db.prepare('UPDATE notas_fiscais SET status_conciliacao=? WHERE numero=?');

let conciliadas = 0, semComprovante = 0, naoEncontradas = 0, jaConc = 0;
const semComp = [];
const naoEnc = [];

for (const [numero, mesRef, temComp, dataPg] of NFS_PDFS) {
  const nf = stmtGetNf.get(numero);
  if (!nf) {
    naoEncontradas++;
    naoEnc.push(numero);
    continue;
  }

  // Atualiza discriminacao com mês de referência do serviço
  const novaDisc = `Serv. ref. ${mesRef} — Prefeitura de Palmas`;
  if (!nf.discriminacao || !nf.discriminacao.includes('ref.')) {
    stmtUpdDisc.run(novaDisc, numero);
  }

  if (!temComp) {
    semComprovante++;
    semComp.push({ numero, mesRef, valor: nf.valor_liquido });
    continue;
  }

  // Já estava conciliada
  if (nf.status_conciliacao === 'CONCILIADO') {
    jaConc++;
    continue;
  }

  // Marcar como CONCILIADO
  stmtConcilia.run('CONCILIADO', numero);
  conciliadas++;
}

console.log(`  ✅ Conciliadas agora:    ${conciliadas}`);
console.log(`  ✓  Já estavam concil.:  ${jaConc}`);
console.log(`  ⏳ Sem comprovante:     ${semComprovante}`);
console.log(`  ❌ Não encontradas:     ${naoEncontradas}`);

if (semComp.length > 0) {
  const totalPend = semComp.reduce((a, b) => a + (b.valor || 0), 0);
  console.log(`\n📋 NFs SEM COMPROVANTE (pendentes de pagamento):`);
  console.log(`   Total: ${semComp.length} NFs | R$ ${totalPend.toFixed(2)}`);
  const byMes = {};
  semComp.forEach(n => {
    if (!byMes[n.mesRef]) byMes[n.mesRef] = { count: 0, total: 0 };
    byMes[n.mesRef].count++;
    byMes[n.mesRef].total += n.valor || 0;
  });
  Object.entries(byMes).forEach(([mes, v]) =>
    console.log(`   ${mes}: ${v.count} NFs | R$ ${v.total.toFixed(2)}`)
  );
  console.log('\n   Detalhes:');
  semComp.forEach(n => console.log(`   NF ${n.numero} | ${n.mesRef} | R$ ${n.valor.toFixed(2)}`));
}

if (naoEnc.length > 0) {
  console.log(`\n⚠️  NFs não encontradas no banco (baixar do WebISS):`);
  naoEnc.forEach(n => console.log(`   ${n}`));
}

// Resumo final das NFs Palmas mar/26
console.log('\n📊 Resumo NFs Palmas (emitidas mar/2026) após conciliação:');
const resumo = db.prepare(`
  SELECT status_conciliacao, COUNT(*) as cnt, SUM(valor_liquido) as total
  FROM notas_fiscais
  WHERE numero LIKE '202600000000%'
    AND CAST(REPLACE(numero,'202600000000','') AS INTEGER) BETWEEN 219 AND 310
  GROUP BY status_conciliacao
`).all();
resumo.forEach(r => console.log(`  ${r.status_conciliacao || 'PENDENTE'}: ${r.cnt} NFs | R$ ${r.total.toFixed(2)}`));

console.log('\n✔️  Concluído.\n');
