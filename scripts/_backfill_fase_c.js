/**
 * Fase C — backfill do status_conciliacao + retencao_efetiva
 *
 * Varre todas as NFs (ou subset por empresa/competência) e chama recalcularNF
 * em cada uma pra alinhar o banco com o modelo novo:
 *   - status derivado de (extrato_id, comprovantes ENTRADA)
 *   - retencao_efetiva = valor_bruto - soma(comprovantes) quando CONCILIADO
 *
 * Uso:
 *   node scripts/_backfill_fase_c.js                  → todas as empresas
 *   node scripts/_backfill_fase_c.js --empresa=seg    → só segurança
 *   node scripts/_backfill_fase_c.js --dry            → não grava (preview)
 *   node scripts/_backfill_fase_c.js --empresa=seg --competencia=2026-03
 *
 * Idempotente: pode rodar quantas vezes quiser.
 */
'use strict';
const { getDb, COMPANIES } = require('../src/db');
const { recalcularNF, STATUS } = require('../src/status-nf');

const args = process.argv.slice(2);
const getArg = (k, def) => {
  const hit = args.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.split('=')[1] : def;
};
const DRY = args.includes('--dry');
const empresaArg = getArg('empresa');
const compArg = getArg('competencia'); // YYYY-MM

const alvos = empresaArg ? [empresaArg] : Object.keys(COMPANIES);

function processar(empresaKey) {
  const c = COMPANIES[empresaKey];
  if (!c) { console.log(`× Empresa "${empresaKey}" desconhecida`); return; }
  const db = getDb(empresaKey);

  // NFs candidatas: com extrato OU com vínculo de comprovante
  const sqlWhere = compArg
    ? `WHERE substr(data_emissao,1,7) = ?`
    : ``;
  const params = compArg ? [compArg] : [];

  const nfs = db.prepare(`
    SELECT id, numero, status_conciliacao, valor_bruto, extrato_id
    FROM notas_fiscais
    ${sqlWhere}
  `).all(...params);

  let mudou = 0, idem = 0, conciliados = 0, pagosSemComp = 0, pagosComComp = 0;
  let retEfetivaTotal = 0;

  const trx = db.transaction(() => {
    for (const nf of nfs) {
      const before = { status: nf.status_conciliacao };
      // Em dry-run, não grava — simula calculando o que derivaria
      if (DRY) {
        // Replica lógica sem UPDATE
        const recebidoRow = db.prepare(`
          SELECT COALESCE(SUM(cv.valor_vinculado),0) recebido
          FROM comprovante_vinculos cv
          JOIN comprovantes_pagamento c ON c.id = cv.comprovante_id
          WHERE cv.tipo_destino='NF' AND cv.destino_id=? AND c.direcao='ENTRADA'
        `).get(String(nf.id));
        const recebido = Number(recebidoRow?.recebido || 0);
        const temExt = !!nf.extrato_id;
        const temComp = recebido > 0;
        const { derivarStatus } = require('../src/status-nf');
        const novo = derivarStatus({
          temExtratoVinculado: temExt,
          temComprovanteVinculado: temComp,
          statusAtual: nf.status_conciliacao,
        });
        if (novo !== before.status) mudou++; else idem++;
        if (novo === STATUS.CONCILIADO) { conciliados++; if (recebido > 0) retEfetivaTotal += Math.max(0, nf.valor_bruto - recebido); }
        if (novo === STATUS.PAGO_SEM_COMPROVANTE) pagosSemComp++;
        if (novo === STATUS.PAGO_COM_COMPROVANTE) pagosComComp++;
      } else {
        const out = recalcularNF(db, nf.id);
        if (!out) continue;
        if (out.status !== out.status_anterior) mudou++; else idem++;
        if (out.status === STATUS.CONCILIADO)           { conciliados++; if (out.retencao_efetiva) retEfetivaTotal += out.retencao_efetiva; }
        if (out.status === STATUS.PAGO_SEM_COMPROVANTE)  pagosSemComp++;
        if (out.status === STATUS.PAGO_COM_COMPROVANTE)  pagosComComp++;
      }
    }
  });
  trx();

  console.log(`\n── ${c.nome} (${empresaKey})${compArg ? ` [${compArg}]` : ''}${DRY ? ' [DRY]' : ''} ──`);
  console.log(`  NFs varridas:            ${nfs.length}`);
  console.log(`  Status alterado:         ${mudou}`);
  console.log(`  Já coerente:             ${idem}`);
  console.log(`  → CONCILIADO:            ${conciliados}`);
  console.log(`  → PAGO_SEM_COMPROVANTE:  ${pagosSemComp}`);
  console.log(`  → PAGO_COM_COMPROVANTE:  ${pagosComComp}`);
  console.log(`  Retenção efetiva total:  R$ ${retEfetivaTotal.toLocaleString('pt-BR',{minimumFractionDigits:2})}`);
}

console.log(`Backfill Fase C ${DRY ? '(DRY-RUN)' : '(APLICANDO)'}`);
for (const emp of alvos) {
  try { processar(emp); }
  catch (e) { console.error(`× Erro em ${emp}: ${e.message}`); }
}
console.log('\nOK.');
