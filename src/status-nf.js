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

module.exports = {
  STATUS,
  ABERTOS,
  PAGOS,
  TERMINAIS,
  ORDEM_EXIBICAO,
  LABELS,
  derivarStatus,
};
