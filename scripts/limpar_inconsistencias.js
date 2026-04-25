#!/usr/bin/env node
/**
 * Montana — Limpar inconsistências detectadas pela auditoria
 *
 * Alvos (dry-run por padrão — use --apply para gravar):
 *  1. Deduplicar NFs idênticas (numero + competencia + tomador) — mantém a mais antiga (menor id)
 *  2. Deduplicar extratos (data_iso + credito|debito + conta) — mantém menor id
 *  3. Reconciliar CONCILIADOs órfãos:
 *     - NF CONCILIADO sem extrato_id  → tentar matching (±5%, ±90d). Se não achar, rebaixar a PENDENTE
 *     - Extrato CONCILIADO sem NF apontando → manter (extratos não têm FK reversa; status CONCILIADO só indica que houve vínculo em algum momento)
 *  4. NFs com data_pagamento < data_emissao  → NULL em data_pagamento (inconsistente, reverter)
 *
 * Uso:
 *   node scripts/limpar_inconsistencias.js [empresa]           # dry-run
 *   node scripts/limpar_inconsistencias.js [empresa] --apply   # grava
 *   node scripts/limpar_inconsistencias.js todas --apply
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const posArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));
const empArg = (posArgs[0] || 'todas').toLowerCase();

function fmt(v) { return (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 }); }

function processar(empresa) {
  const db = getDb(empresa);
  console.log('\n' + '═'.repeat(90));
  console.log(`  LIMPAR INCONSISTÊNCIAS — ${empresa.toUpperCase()}  ${APPLY ? '[APLLY]' : '[dry-run]'}`);
  console.log('═'.repeat(90));

  // ── 1. Dedup NFs
  console.log('\n── 1. Deduplicar NFs (numero + competencia + tomador) ──');
  const dups = db.prepare(`
    SELECT numero, competencia, tomador, COUNT(*) AS qtd, GROUP_CONCAT(id) AS ids
    FROM notas_fiscais
    WHERE numero IS NOT NULL AND numero <> ''
    GROUP BY numero, competencia, tomador
    HAVING qtd > 1
  `).all();
  let nfRemovidas = 0;
  if (dups.length === 0) console.log('   ✅ nenhuma duplicata');
  for (const d of dups) {
    const ids = d.ids.split(',').map(Number).sort((a, b) => a - b);
    const manter = ids[0];
    const descartar = ids.slice(1);
    console.log(`   NF ${d.numero} | ${d.competencia} | ${(d.tomador || '').slice(0, 30)} — manter [${manter}], descartar [${descartar.join(',')}]`);
    if (APPLY) {
      const del = db.prepare('DELETE FROM notas_fiscais WHERE id = ?');
      for (const id of descartar) { del.run(id); nfRemovidas++; }
    } else {
      nfRemovidas += descartar.length;
    }
  }
  console.log(`   → ${nfRemovidas} NF(s) duplicada(s) ${APPLY ? 'removida(s)' : 'seriam removidas'}`);

  // ── 2. Dedup extratos (chave: data + valor + conta + histórico normalizado OU ofx_fitid/bb_hash)
  console.log('\n── 2. Deduplicar extratos (data + valor + conta + histórico) ──');
  let extRemovidos = 0;
  // Tenta primeiro por fitid/hash (mais confiável); depois por histórico normalizado
  // Critério: mesma data + valor + conta + histórico = duplicata
  // (fitid/hash não entram — importações de fontes diferentes podem ter fitids distintos para a mesma transação)
  const dupCr = db.prepare(`
    SELECT data_iso, credito AS v, COALESCE(conta,'') AS conta,
           TRIM(COALESCE(historico,'')) AS hist,
           COUNT(*) AS qtd, GROUP_CONCAT(id) AS ids
    FROM extratos
    WHERE credito > 0 AND data_iso IS NOT NULL
    GROUP BY data_iso, credito, COALESCE(conta,''), TRIM(COALESCE(historico,''))
    HAVING qtd > 1
  `).all();
  const dupDb = db.prepare(`
    SELECT data_iso, debito AS v, COALESCE(conta,'') AS conta,
           TRIM(COALESCE(historico,'')) AS hist,
           COUNT(*) AS qtd, GROUP_CONCAT(id) AS ids
    FROM extratos
    WHERE debito > 0 AND data_iso IS NOT NULL
    GROUP BY data_iso, debito, COALESCE(conta,''), TRIM(COALESCE(historico,''))
    HAVING qtd > 1
  `).all();
  const todosDup = [...dupCr, ...dupDb];
  if (todosDup.length === 0) console.log('   ✅ nenhuma duplicata');
  if (APPLY && todosDup.length > 0) db.pragma('foreign_keys = OFF');
  for (const d of todosDup) {
    const ids = d.ids.split(',').map(Number).sort((a, b) => a - b);
    const manter = ids[0];
    const descartar = ids.slice(1);
    console.log(`   ${d.data_iso} R$ ${fmt(d.v)} | ${d.conta.slice(0, 20)} — manter [${manter}], descartar [${descartar.join(',')}]`);
    if (APPLY) {
      // Antes de apagar, reapontar NFs/despesas que apontem para o descartado para apontar para o que fica
      const upNf = db.prepare('UPDATE notas_fiscais SET extrato_id = ? WHERE extrato_id = ?');
      let upDesp = null;
      try { upDesp = db.prepare('UPDATE despesas SET extrato_id = ? WHERE extrato_id = ?'); } catch (e) {}
      const del = db.prepare('DELETE FROM extratos WHERE id = ?');
      for (const id of descartar) {
        try { upNf.run(manter, id); } catch (e) {}
        if (upDesp) { try { upDesp.run(manter, id); } catch (e) {} }
        try { del.run(id); extRemovidos++; } catch (e) { console.log(`      ⚠️ skip id=${id}: ${e.message}`); }
      }
    } else {
      extRemovidos += descartar.length;
    }
  }
  if (APPLY && todosDup.length > 0) db.pragma('foreign_keys = ON');
  console.log(`   → ${extRemovidos} extrato(s) duplicado(s) ${APPLY ? 'removido(s)' : 'seriam removidos'}`);

  // ── 3. NFs CONCILIADO órfãs
  console.log('\n── 3. NFs marcadas CONCILIADO sem extrato_id ──');
  const orfas = db.prepare(`
    SELECT id, numero, tomador, valor_liquido, data_pagamento, data_emissao
    FROM notas_fiscais
    WHERE COALESCE(status_conciliacao,'') IN ('CONCILIADO','CONCILIADA')
      AND extrato_id IS NULL
      AND valor_liquido > 0
  `).all();
  console.log(`   ${orfas.length} NFs órfãs (CONCILIADO sem FK)`);
  let relinked = 0;
  let rebaixadas = 0;
  for (const nf of orfas) {
    // Tentar re-linkagem: buscar extrato na mesma conta com valor próximo (±0.5%) e data próxima (±30d)
    const base = nf.data_pagamento || nf.data_emissao;
    if (!base) { rebaixadas++; continue; }
    const match = db.prepare(`
      SELECT id FROM extratos
      WHERE credito > 0
        AND ABS(credito - ?) < ?
        AND data_iso BETWEEN date(?, '-30 days') AND date(?, '+90 days')
        AND COALESCE(status_conciliacao,'PENDENTE') <> 'CONCILIADO'
      ORDER BY ABS(julianday(data_iso) - julianday(?)) ASC
      LIMIT 1
    `).get(nf.valor_liquido, nf.valor_liquido * 0.005, base, base, base);
    if (match) {
      if (APPLY) {
        db.prepare('UPDATE notas_fiscais SET extrato_id = ? WHERE id = ?').run(match.id, nf.id);
        db.prepare('UPDATE extratos SET status_conciliacao = ?, status = ? WHERE id = ?').run('CONCILIADO', 'CONCILIADO', match.id);
      }
      relinked++;
    } else {
      if (APPLY) {
        db.prepare("UPDATE notas_fiscais SET status_conciliacao = 'PENDENTE' WHERE id = ?").run(nf.id);
      }
      rebaixadas++;
    }
  }
  console.log(`   → ${relinked} NFs re-linkadas ${APPLY ? '' : '(estimadas)'}`);
  console.log(`   → ${rebaixadas} NFs rebaixadas para PENDENTE ${APPLY ? '' : '(estimadas)'}`);

  // ── 4. NFs com data_pagamento anterior à emissão
  console.log('\n── 4. NFs com data_pagamento < data_emissao (impossível) ──');
  const invDate = db.prepare(`
    SELECT id, numero, tomador, data_emissao, data_pagamento
    FROM notas_fiscais
    WHERE data_pagamento IS NOT NULL
      AND data_emissao IS NOT NULL
      AND date(data_pagamento) < date(data_emissao)
  `).all();
  console.log(`   ${invDate.length} NFs com datas invertidas`);
  for (const nf of invDate) {
    console.log(`      NF ${nf.numero} emissao=${nf.data_emissao} pagamento=${nf.data_pagamento}`);
    if (APPLY) {
      // Limpa data_pagamento (preserva o registro, só anula o pagamento suspeito)
      db.prepare('UPDATE notas_fiscais SET data_pagamento = NULL WHERE id = ?').run(nf.id);
    }
  }

  db.close();
  return { nfRemovidas, extRemovidos, relinked, rebaixadas, invDate: invDate.length };
}

const empresas = empArg === 'todas' ? ['assessoria', 'seguranca'] : [empArg];
const totais = { nfRemovidas: 0, extRemovidos: 0, relinked: 0, rebaixadas: 0, invDate: 0 };
for (const e of empresas) {
  const r = processar(e);
  for (const k of Object.keys(totais)) totais[k] += r[k];
}

console.log('\n' + '═'.repeat(90));
console.log(`  RESUMO GERAL ${APPLY ? '[APLICADO]' : '[DRY-RUN]'}`);
console.log('═'.repeat(90));
console.log(`  NFs duplicadas removidas  : ${totais.nfRemovidas}`);
console.log(`  Extratos duplicados remov : ${totais.extRemovidos}`);
console.log(`  NFs re-linkadas           : ${totais.relinked}`);
console.log(`  NFs rebaixadas → PENDENTE : ${totais.rebaixadas}`);
console.log(`  NFs c/ data invertida     : ${totais.invDate}`);
if (!APPLY) console.log('\n  ⚠️  Nada foi gravado. Execute com --apply para aplicar.');
