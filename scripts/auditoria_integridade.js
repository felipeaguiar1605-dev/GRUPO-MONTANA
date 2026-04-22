#!/usr/bin/env node
/**
 * Montana — Auditoria geral de integridade dos dados
 *
 * Roda uma bateria de verificações sem modificar nada:
 *  1. Duplicatas de NFs (numero + tomador + competencia)
 *  2. Duplicatas de extratos (data + credito/debito + conta)
 *  3. NFs CONCILIADAS sem extrato_id vinculado
 *  4. Extratos CONCILIADOs sem NF vinculada
 *  5. Status mistos/esquisitos em extratos
 *  6. Valores divergentes (valor_bruto vs retenções+valor_liquido)
 *  7. FKs quebradas (extrato_id → extratos.id, folha_id, funcionario_id)
 *  8. Contratos órfãos nas NFs (contrato_ref sem match)
 *  9. Despesas com valor zero ou negativo
 * 10. RH funcionários duplicados (mesma matrícula ou CPF)
 *
 * Uso:
 *   node scripts/auditoria_integridade.js [empresa]
 *   node scripts/auditoria_integridade.js todas
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const empArg = (process.argv[2] || 'todas').toLowerCase();

function brl(v) { return (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 }); }
function sec(t) { console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 80 - t.length - 4))); }

function colExists(db, table, col) {
  try { return db.prepare('PRAGMA table_info(' + table + ')').all().some(c => c.name === col); }
  catch (e) { return false; }
}

function auditar(empresa) {
  const db = getDb(empresa);
  console.log('\n' + '═'.repeat(100));
  console.log(`  AUDITORIA — ${empresa.toUpperCase()}`);
  console.log('═'.repeat(100));

  const problemas = [];

  // 1. Duplicatas NFs (numero + competencia + tomador)
  sec('1. Duplicatas de NFs (numero + competencia + tomador)');
  try {
    const dups = db.prepare(`
      SELECT numero, competencia, tomador, COUNT(*) q, ROUND(SUM(valor_liquido),2) v
      FROM notas_fiscais
      WHERE numero IS NOT NULL AND numero != ''
      GROUP BY numero, competencia, tomador
      HAVING COUNT(*) > 1
      ORDER BY q DESC LIMIT 15
    `).all();
    if (dups.length) {
      problemas.push({ t: 'NFs duplicadas', n: dups.length });
      console.log(`   ⚠️  ${dups.length} grupos de NF com duplicata:`);
      for (const d of dups.slice(0, 10)) console.log(`      ${d.numero} | ${d.competencia} | ${(d.tomador || '').slice(0, 30)} × ${d.q} (R$ ${brl(d.v)})`);
    } else console.log('   ✅ nenhuma NF duplicada');
  } catch (e) { console.log('   erro:', e.message); }

  // 2. Duplicatas extratos (data + credito + conta)
  sec('2. Duplicatas de extratos (data + credito + conta)');
  try {
    const hasConta = colExists(db, 'extratos', 'conta');
    const dups = db.prepare(`
      SELECT data_iso, credito, ${hasConta ? 'conta' : "''"} AS conta, historico,
             COUNT(*) q, GROUP_CONCAT(id) ids
      FROM extratos
      WHERE credito > 0
      GROUP BY data_iso, credito, ${hasConta ? 'conta' : "''"}, historico
      HAVING COUNT(*) > 1
      ORDER BY q DESC LIMIT 15
    `).all();
    if (dups.length) {
      problemas.push({ t: 'Extratos duplicados (crédito)', n: dups.length });
      console.log(`   ⚠️  ${dups.length} grupos de extratos com duplicata:`);
      for (const d of dups.slice(0, 8)) console.log(`      ${d.data_iso} R$ ${brl(d.credito)} | ${(d.historico || '').slice(0, 45)} × ${d.q}`);
    } else console.log('   ✅ nenhum extrato crédito duplicado');

    const dupsDeb = db.prepare(`
      SELECT data_iso, debito, ${hasConta ? 'conta' : "''"} AS conta, historico,
             COUNT(*) q
      FROM extratos
      WHERE debito > 0
      GROUP BY data_iso, debito, ${hasConta ? 'conta' : "''"}, historico
      HAVING COUNT(*) > 1
      LIMIT 10
    `).all();
    if (dupsDeb.length) {
      problemas.push({ t: 'Extratos duplicados (débito)', n: dupsDeb.length });
      console.log(`   ⚠️  ${dupsDeb.length} grupos de débitos duplicados`);
    }
  } catch (e) { console.log('   erro:', e.message); }

  // 3. NFs CONCILIADAS sem extrato_id
  sec('3. NFs conciliadas SEM extrato vinculado');
  try {
    const r = db.prepare(`
      SELECT COUNT(*) q, ROUND(SUM(valor_liquido),2) v
      FROM notas_fiscais WHERE status_conciliacao='CONCILIADO' AND (extrato_id IS NULL OR extrato_id=0)
    `).get();
    if (r.q > 0) {
      problemas.push({ t: 'NFs CONCILIADAS sem FK', n: r.q });
      console.log(`   ⚠️  ${r.q} NFs marcadas CONCILIADO sem extrato_id (R$ ${brl(r.v)})`);
    } else console.log('   ✅ todas NFs CONCILIADO tem extrato_id');
  } catch (e) { console.log('   erro:', e.message); }

  // 4. Extratos CONCILIADOs sem NF
  sec('4. Extratos CONCILIADOs sem NF vinculada');
  try {
    const r = db.prepare(`
      SELECT COUNT(*) q, ROUND(SUM(credito),0) v
      FROM extratos e
      WHERE e.status_conciliacao='CONCILIADO' AND credito > 0
        AND NOT EXISTS (SELECT 1 FROM notas_fiscais n WHERE n.extrato_id = e.id)
    `).get();
    if (r.q > 0) {
      problemas.push({ t: 'Extratos CONCILIADO órfãos', n: r.q });
      console.log(`   ⚠️  ${r.q} extratos CONCILIADO sem NF apontando (R$ ${brl(r.v)})`);
      // mostrar exemplos
      const sample = db.prepare(`
        SELECT id, data_iso, credito, historico FROM extratos e
        WHERE e.status_conciliacao='CONCILIADO' AND credito > 0
          AND NOT EXISTS (SELECT 1 FROM notas_fiscais n WHERE n.extrato_id = e.id)
        LIMIT 5
      `).all();
      for (const s of sample) console.log(`      [${s.id}] ${s.data_iso} R$ ${brl(s.credito)} — ${(s.historico || '').slice(0, 50)}`);
    } else console.log('   ✅ todos extratos CONCILIADO tem NF vinculada');
  } catch (e) { console.log('   erro:', e.message); }

  // 5. Status mistos em extratos (valores estranhos)
  sec('5. Status incomuns em extratos (créditos)');
  try {
    const dist = db.prepare(`
      SELECT COALESCE(NULLIF(status_conciliacao,''), '(null/PENDENTE)') s, COUNT(*) q, ROUND(SUM(credito),0) v
      FROM extratos WHERE credito > 0 GROUP BY s ORDER BY q DESC
    `).all();
    for (const d of dist) console.log(`      ${(d.s || '(vazio)').padEnd(25)} | ${String(d.q).padStart(5)} | R$ ${brl(d.v).padStart(15)}`);
    const canonicos = new Set(['CONCILIADO','PENDENTE','INVESTIMENTO','INTERNO','DEVOLVIDO','CONTA_VINCULADA','TRANSFERENCIA','RETENCAO_IMPOSTOS','(null/PENDENTE)']);
    const suspeitos = dist.filter(d => !canonicos.has(d.s));
    if (suspeitos.length) {
      problemas.push({ t: 'Status suspeitos em extratos', n: suspeitos.length });
      console.log(`   ⚠️  ${suspeitos.length} status potencialmente não-canônicos acima`);
    }
  } catch (e) { console.log('   erro:', e.message); }

  // 6. NFs com valor_bruto vs retenções inconsistente
  sec('6. NFs com inconsistência valor_bruto = valor_liquido + retenções');
  try {
    const inc = db.prepare(`
      SELECT COUNT(*) q
      FROM notas_fiscais
      WHERE valor_bruto > 0 AND valor_liquido > 0
        AND ABS(valor_bruto - valor_liquido - COALESCE(inss,0) - COALESCE(ir,0) - COALESCE(iss,0) - COALESCE(csll,0) - COALESCE(pis,0) - COALESCE(cofins,0) - (CASE WHEN (SELECT 1 FROM pragma_table_info('notas_fiscais') WHERE name='outros_descontos') THEN COALESCE(outros_descontos,0) ELSE 0 END)) > 0.50
    `).get();
    if (inc.q > 0) {
      problemas.push({ t: 'NFs com total divergente', n: inc.q });
      console.log(`   ⚠️  ${inc.q} NFs com soma retenções+líquido ≠ bruto (tol > R$0.50)`);
      const sample = db.prepare(`
        SELECT id, numero, tomador, valor_bruto, valor_liquido, inss, ir, iss, csll, pis, cofins
        FROM notas_fiscais
        WHERE valor_bruto > 0 AND valor_liquido > 0
          AND ABS(valor_bruto - valor_liquido - COALESCE(inss,0) - COALESCE(ir,0) - COALESCE(iss,0) - COALESCE(csll,0) - COALESCE(pis,0) - COALESCE(cofins,0) - (CASE WHEN (SELECT 1 FROM pragma_table_info('notas_fiscais') WHERE name='outros_descontos') THEN COALESCE(outros_descontos,0) ELSE 0 END)) > 0.50
        LIMIT 5
      `).all();
      for (const s of sample) {
        const calc = s.valor_liquido + (s.inss || 0) + (s.ir || 0) + (s.iss || 0) + (s.csll || 0) + (s.pis || 0) + (s.cofins || 0);
        console.log(`      NF ${s.numero} | bruto=R$${brl(s.valor_bruto)} | líq+ret=R$${brl(calc)} | diff R$${brl(s.valor_bruto - calc)}`);
      }
    } else console.log('   ✅ todas NFs batem bruto = líquido + retenções');
  } catch (e) { console.log('   erro:', e.message); }

  // 7. FKs quebradas
  sec('7. FKs quebradas');
  try {
    const orfNF = db.prepare(`SELECT COUNT(*) q FROM notas_fiscais WHERE extrato_id IS NOT NULL AND extrato_id > 0 AND NOT EXISTS (SELECT 1 FROM extratos WHERE id=notas_fiscais.extrato_id)`).get();
    if (orfNF.q > 0) {
      problemas.push({ t: 'NF.extrato_id órfão', n: orfNF.q });
      console.log(`   ⚠️  ${orfNF.q} NFs com extrato_id apontando para ID que não existe`);
    } else console.log('   ✅ NF→extratos FKs OK');

    if (colExists(db, 'rh_folha_itens', 'funcionario_id')) {
      const orfFunc = db.prepare(`SELECT COUNT(*) q FROM rh_folha_itens WHERE funcionario_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM rh_funcionarios WHERE id=rh_folha_itens.funcionario_id)`).get();
      if (orfFunc.q > 0) { problemas.push({ t: 'rh_folha_itens→rh_funcionarios órfão', n: orfFunc.q }); console.log(`   ⚠️  ${orfFunc.q} folha_itens sem funcionario`); }
    }
    if (colExists(db, 'despesas', 'extrato_id')) {
      const orfDesp = db.prepare(`SELECT COUNT(*) q FROM despesas WHERE extrato_id IS NOT NULL AND extrato_id > 0 AND NOT EXISTS (SELECT 1 FROM extratos WHERE id=despesas.extrato_id)`).get();
      if (orfDesp.q > 0) { problemas.push({ t: 'despesas→extratos órfão', n: orfDesp.q }); console.log(`   ⚠️  ${orfDesp.q} despesas com extrato_id inválido`); }
    }
  } catch (e) { console.log('   erro:', e.message); }

  // 8. contrato_ref órfão (NFs)
  sec('8. contrato_ref nas NFs sem match em contratos');
  try {
    let contratos = new Set();
    try { contratos = new Set(db.prepare('SELECT numContrato FROM contratos').all().map(r => r.numContrato)); } catch (e) {}
    const refs = db.prepare(`SELECT contrato_ref, COUNT(*) q, ROUND(SUM(valor_liquido),0) v FROM notas_fiscais WHERE contrato_ref IS NOT NULL AND contrato_ref != '' GROUP BY contrato_ref`).all();
    const orfaos = refs.filter(r => !contratos.has(r.contrato_ref));
    if (orfaos.length) {
      problemas.push({ t: 'contrato_ref órfão nas NFs', n: orfaos.length });
      console.log(`   ⚠️  ${orfaos.length} labels em NFs não existem em contratos:`);
      for (const o of orfaos.slice(0, 10)) console.log(`      ${(o.contrato_ref || '').slice(0, 50).padEnd(50)} | ${o.q} NFs | R$ ${brl(o.v)}`);
    } else console.log('   ✅ todos contrato_ref tem match');
  } catch (e) { console.log('   erro:', e.message); }

  // 9. Despesas com valor zero ou negativo
  sec('9. Despesas com valor inválido');
  try {
    const zeroes = db.prepare(`SELECT COUNT(*) q FROM despesas WHERE valor_bruto IS NULL OR valor_bruto <= 0`).get();
    if (zeroes.q > 0) { problemas.push({ t: 'Despesas com valor <= 0', n: zeroes.q }); console.log(`   ⚠️  ${zeroes.q} despesas com valor <= 0`); }
    else console.log('   ✅ todas despesas com valor > 0');
  } catch (e) { console.log('   erro:', e.message); }

  // 10. RH funcionários duplicados (CPF ou matricula)
  sec('10. Funcionários RH duplicados');
  try {
    if (colExists(db, 'rh_funcionarios', 'cpf')) {
      const dups = db.prepare(`SELECT cpf, COUNT(*) q FROM rh_funcionarios WHERE cpf IS NOT NULL AND cpf != '' GROUP BY cpf HAVING COUNT(*) > 1`).all();
      if (dups.length) { problemas.push({ t: 'CPFs duplicados em RH', n: dups.length }); console.log(`   ⚠️  ${dups.length} CPFs duplicados`); for (const d of dups.slice(0, 5)) console.log(`      ${d.cpf} × ${d.q}`); }
    }
    if (colExists(db, 'rh_funcionarios', 'matricula')) {
      const dups = db.prepare(`SELECT matricula, COUNT(*) q FROM rh_funcionarios WHERE matricula IS NOT NULL AND matricula != '' GROUP BY matricula HAVING COUNT(*) > 1`).all();
      if (dups.length) { problemas.push({ t: 'Matrículas duplicadas em RH', n: dups.length }); console.log(`   ⚠️  ${dups.length} matrículas duplicadas`); }
    }
    const nomes = db.prepare(`SELECT nome, COUNT(*) q FROM rh_funcionarios WHERE nome IS NOT NULL GROUP BY nome HAVING COUNT(*) > 1`).all();
    if (nomes.length) { console.log(`   ℹ️  ${nomes.length} nomes iguais (pode ser legítimo)`); }
  } catch (e) { console.log('   erro:', e.message); }

  // 11. NFs com data_pagamento antes de data_emissao
  sec('11. NFs com data_pagamento anterior à emissão');
  try {
    const bad = db.prepare(`SELECT COUNT(*) q FROM notas_fiscais WHERE data_pagamento IS NOT NULL AND data_emissao IS NOT NULL AND date(data_pagamento) < date(data_emissao)`).get();
    if (bad.q > 0) { problemas.push({ t: 'data_pagamento < data_emissao', n: bad.q }); console.log(`   ⚠️  ${bad.q} NFs com pagamento ANTES da emissão`); }
    else console.log('   ✅ datas consistentes');
  } catch (e) { console.log('   erro:', e.message); }

  // Sumário
  sec('SUMÁRIO');
  if (problemas.length === 0) console.log('   ✅ Nenhum problema encontrado.');
  else {
    for (const p of problemas) console.log(`   ⚠️  ${p.t}: ${p.n}`);
  }

  db.close();
  return problemas;
}

const empresas = empArg === 'todas' ? ['assessoria', 'seguranca'] : [empArg];
const totaisPorEmp = {};
for (const e of empresas) totaisPorEmp[e] = auditar(e);

console.log('\n' + '═'.repeat(100));
console.log('  CONSOLIDADO');
console.log('═'.repeat(100));
for (const [emp, probs] of Object.entries(totaisPorEmp)) {
  console.log(`  ${emp.padEnd(12)} — ${probs.length} categoria(s) de problema`);
}
