/**
 * Catálogo de status da NF — representa as etapas do ciclo:
 *   Boletim → NF → Pagamento → Comprovante → Extrato (conciliação)
 *
 * A coluna `notas_fiscais.status_conciliacao` é TEXT sem CHECK constraint,
 * então usar estas constantes em todos os lugares para padronizar.
 *
 * Fluxo esperado (diagrama):
 *   RASCUNHO ──[emitir]──▶ PENDENTE ──[vencimento SLA]──▶ AGUARDANDO_PAGAMENTO
 *                              │                                │
 *                              │                                │
 *                              ▼                                ▼
 *                              (match extrato único, sem comprovante anexado)
 *                              PAGO_SEM_COMPROVANTE
 *                                        │
 *                                        │ [upload comprovante]
 *                                        ▼
 *                              (comprovante anexado mas extrato não conciliado)
 *                              PAGO_COM_COMPROVANTE
 *                                        │
 *                                        │ [triplo vínculo NF⇄extrato⇄comprovante OK]
 *                                        ▼
 *                                   CONCILIADO ✅
 *
 * Estados laterais (não seguem o fluxo):
 *   ASSESSORIA  — NF contaminada importada no banco errado (move pra outro DB)
 *   IGNORAR     — NF decisão manual: não deve conciliar
 *   CANCELADA   — NF cancelada (antes ou após emissão)
 */

const STATUS = Object.freeze({
  RASCUNHO:               'RASCUNHO',
  PENDENTE:               'PENDENTE',
  AGUARDANDO_PAGAMENTO:   'AGUARDANDO_PAGAMENTO',
  PAGO_SEM_COMPROVANTE:   'PAGO_SEM_COMPROVANTE',
  PAGO_COM_COMPROVANTE:   'PAGO_COM_COMPROVANTE',
  CONCILIADO:             'CONCILIADO',
  ASSESSORIA:             'ASSESSORIA',
  IGNORAR:                'IGNORAR',
  CANCELADA:              'CANCELADA',
});

// Estados considerados "em aberto" (entram nas contas de cobrança / receber)
const ABERTOS = new Set([
  STATUS.RASCUNHO,
  STATUS.PENDENTE,
  STATUS.AGUARDANDO_PAGAMENTO,
  STATUS.PAGO_SEM_COMPROVANTE,
  STATUS.PAGO_COM_COMPROVANTE,
]);

// Estados "pagos" (já saíram da fila de cobrança, mas podem não estar conciliados)
const PAGOS = new Set([
  STATUS.PAGO_SEM_COMPROVANTE,
  STATUS.PAGO_COM_COMPROVANTE,
  STATUS.CONCILIADO,
]);

// Estados terminais (sem próxima transição no ciclo principal)
const TERMINAIS = new Set([
  STATUS.CONCILIADO,
  STATUS.ASSESSORIA,
  STATUS.IGNORAR,
  STATUS.CANCELADA,
]);

/**
 * Calcula o próximo status correto da NF a partir dos dados reais:
 *   - temExtratoVinculado: notas_fiscais.extrato_id != null
 *   - temComprovanteVinculado: existe linha em comprovante_vinculos
 *     apontando pra essa NF (tipo_destino='NF' e destino_id=nf.id)
 *
 * Usado em jobs de backfill e em triggers (POST /vincular, POST /comprovantes/vincular)
 * pra manter o status coerente sem depender de update manual.
 */
function derivarStatus({ temExtratoVinculado, temComprovanteVinculado, statusAtual } = {}) {
  // Estados laterais nunca são recalculados automaticamente
  if (statusAtual === STATUS.ASSESSORIA ||
      statusAtual === STATUS.IGNORAR   ||
      statusAtual === STATUS.CANCELADA ||
      statusAtual === STATUS.RASCUNHO) {
    return statusAtual;
  }

  if (temExtratoVinculado && temComprovanteVinculado) return STATUS.CONCILIADO;
  if (temExtratoVinculado)                            return STATUS.PAGO_SEM_COMPROVANTE;
  if (temComprovanteVinculado)                        return STATUS.PAGO_COM_COMPROVANTE;
  // Sem pagamento identificado: mantém AGUARDANDO_PAGAMENTO ou PENDENTE
  return statusAtual || STATUS.PENDENTE;
}

// Ordem de exibição em selects (frontend)
const ORDEM_EXIBICAO = [
  STATUS.RASCUNHO,
  STATUS.PENDENTE,
  STATUS.AGUARDANDO_PAGAMENTO,
  STATUS.PAGO_SEM_COMPROVANTE,
  STATUS.PAGO_COM_COMPROVANTE,
  STATUS.CONCILIADO,
  STATUS.CANCELADA,
  STATUS.ASSESSORIA,
  STATUS.IGNORAR,
];

// Labels humanos (pt-BR)
const LABELS = {
  [STATUS.RASCUNHO]:             'Rascunho',
  [STATUS.PENDENTE]:             'Pendente',
  [STATUS.AGUARDANDO_PAGAMENTO]: 'Aguardando pagamento',
  [STATUS.PAGO_SEM_COMPROVANTE]: 'Pago (sem comprovante)',
  [STATUS.PAGO_COM_COMPROVANTE]: 'Pago (com comprovante)',
  [STATUS.CONCILIADO]:           'Conciliado',
  [STATUS.CANCELADA]:            'Cancelada',
  [STATUS.ASSESSORIA]:           'Pertence à Assessoria',
  [STATUS.IGNORAR]:              'Ignorar',
};

/**
 * Recalcula e persiste o status_conciliacao + retencao_efetiva de uma NF
 * com base nos vínculos reais (extrato_id + comprovante_vinculos ENTRADA).
 *
 * Idempotente. Seguro pra rodar repetidamente em backfills e hooks.
 *
 *   temExtrato     → notas_fiscais.extrato_id != NULL
 *   temComprovante → existe vínculo em comprovante_vinculos (tipo_destino='NF')
 *                    com direcao='ENTRADA' (tomador pagou Montana)
 *
 * retencao_efetiva = valor_bruto - soma(comprovantes ENTRADA vinculados à NF)
 *   → só persiste quando triplo-match (CONCILIADO) e recebido > 0
 *   → caso contrário fica NULL e DRE cai no fallback `retencao` declarada
 */
function recalcularNF(db, nfId) {
  const nf = db.prepare(
    'SELECT id, extrato_id, valor_bruto, status_conciliacao FROM notas_fiscais WHERE id = ?'
  ).get(nfId);
  if (!nf) return null;

  const temExtrato = nf.extrato_id != null;
  let recebido = 0;
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(cv.valor_vinculado), 0) AS recebido
      FROM comprovante_vinculos cv
      JOIN comprovantes_pagamento c ON c.id = cv.comprovante_id
      WHERE cv.tipo_destino = 'NF' AND cv.destino_id = ?
        AND c.direcao = 'ENTRADA'
    `).get(String(nfId));
    recebido = Number(row?.recebido || 0);
  } catch (_) { /* tabelas podem não existir em DB muito antigo */ }
  const temComprovante = recebido > 0;

  const novoStatus = derivarStatus({
    temExtratoVinculado: temExtrato,
    temComprovanteVinculado: temComprovante,
    statusAtual: nf.status_conciliacao,
  });

  let retEfet = null;
  if (novoStatus === STATUS.CONCILIADO && recebido > 0) {
    retEfet = +Math.max(0, Number(nf.valor_bruto || 0) - recebido).toFixed(2);
  }

  try {
    db.prepare('UPDATE notas_fiscais SET status_conciliacao = ?, retencao_efetiva = ? WHERE id = ?')
      .run(novoStatus, retEfet, nfId);
  } catch (_) {
    // Coluna retencao_efetiva ainda não migrada — grava só status
    db.prepare('UPDATE notas_fiscais SET status_conciliacao = ? WHERE id = ?').run(novoStatus, nfId);
  }

  return {
    nfId: nf.id,
    status: novoStatus,
    status_anterior: nf.status_conciliacao,
    retencao_efetiva: retEfet,
    recebido,
    temExtrato,
    temComprovante,
  };
}

module.exports = {
  STATUS,
  ABERTOS,
  PAGOS,
  TERMINAIS,
  ORDEM_EXIBICAO,
  LABELS,
  derivarStatus,
  recalcularNF,
};
