/**
 * Montana ERP — /api/ciclo
 *
 * Retorna o funil do ciclo completo por competência (YYYY-MM):
 *   Contratos ativos → Boletins → NFs emitidas → NFs com pagamento
 *   identificado → NFs com comprovante anexado → Conciliadas (triplo match)
 *   → Retenções (declarado × apurado)
 *
 * Filosofia: SQL agregado simples (1 query por etapa), nenhum cálculo pesado.
 * UI consome esse endpoint e renderiza gaps com links de ação para cada passo.
 *
 * GET /api/ciclo?competencia=YYYY-MM  (default = mês atual)
 */
const express = require('express');
const companyMw = require('../companyMiddleware');
const { STATUS } = require('../status-nf');

const router = express.Router();
router.use(companyMw);

function hojeMes() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Alguns status contam como "NF paga" para fins de conciliação
const STATUS_NF_PAGA = [
  STATUS.PAGO_SEM_COMPROVANTE,
  STATUS.PAGO_COM_COMPROVANTE,
  STATUS.CONCILIADO,
];

router.get('/', (req, res) => {
  try {
    const db = req.db;
    const competencia = (req.query.competencia || hojeMes()).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(competencia)) {
      return res.status(400).json({ error: 'competencia deve ser YYYY-MM' });
    }

    // ───────── ETAPA 1: Contratos ativos com faturamento esperado ─────────
    const contratosAtivos = db.prepare(`
      SELECT numContrato, contrato, orgao, valor_mensal_bruto
      FROM contratos
      WHERE COALESCE(status,'') != 'encerrado'
        AND COALESCE(valor_mensal_bruto, 0) > 0
    `).all();

    // ───────── ETAPA 2: Boletins da competência ─────────
    let boletinsMes = [];
    try {
      boletinsMes = db.prepare(`
        SELECT b.id, b.contrato_id, b.competencia, b.valor_total,
               b.status AS status_boletim, b.nfse_numero, b.nfse_status,
               bc.contrato_ref, bc.orgao
        FROM bol_boletins b
        JOIN bol_contratos bc ON bc.id = b.contrato_id
        WHERE b.competencia = ? OR b.competencia LIKE ?
      `).all(competencia, `%${competencia}%`);
    } catch (_) { /* módulo boletins não disponível */ }

    const boletinsPorContrato = new Map();
    for (const b of boletinsMes) {
      const k = (b.contrato_ref || '').trim();
      if (k) boletinsPorContrato.set(k, b);
    }

    // ───────── ETAPA 3: NFs emitidas na competência ─────────
    const nfsMes = db.prepare(`
      SELECT id, numero, tomador, contrato_ref, data_emissao, data_pagamento,
             valor_bruto, valor_liquido, status_conciliacao, extrato_id,
             inss, ir, iss, csll, pis, cofins, COALESCE(retencao, 0) AS retencao
      FROM notas_fiscais
      WHERE strftime('%Y-%m', data_emissao) = ?
        AND COALESCE(valor_bruto, 0) > 0
        AND COALESCE(status_conciliacao,'') NOT IN ('ASSESSORIA','IGNORAR','CANCELADA')
    `).all(competencia);

    // ───────── ETAPA 4+5+6: cruzar NF com comprovantes ─────────
    let nfsComComprovante = new Set();
    try {
      const rows = db.prepare(`
        SELECT DISTINCT destino_id
        FROM comprovante_vinculos
        WHERE tipo_destino = 'NF'
      `).all();
      for (const r of rows) nfsComComprovante.add(String(r.destino_id));
    } catch (_) { /* tabela pode não existir em ambiente muito antigo */ }

    let nfsEmitidas = 0, valorEmitido = 0;
    let nfsComExtrato = 0, valorComExtrato = 0;
    let nfsComComprovanteAnexado = 0, valorComComprovante = 0;
    let nfsConciliadas = 0, valorConciliado = 0;
    let nfsAbertas = 0, valorAbertas = 0;
    let retencaoDeclaradaNFs = 0;

    const nfsSemComprovante = [];
    for (const nf of nfsMes) {
      nfsEmitidas++;
      valorEmitido += Number(nf.valor_bruto || 0);
      retencaoDeclaradaNFs += Number(nf.retencao || 0) +
        Number(nf.inss || 0) + Number(nf.ir || 0) + Number(nf.iss || 0) +
        Number(nf.csll || 0) + Number(nf.pis || 0) + Number(nf.cofins || 0);

      const temExtrato = !!nf.extrato_id || STATUS_NF_PAGA.includes(nf.status_conciliacao);
      const temComprovante = nfsComComprovante.has(String(nf.id));

      if (temExtrato) { nfsComExtrato++; valorComExtrato += Number(nf.valor_bruto || 0); }
      if (temComprovante) { nfsComComprovanteAnexado++; valorComComprovante += Number(nf.valor_bruto || 0); }
      if (temExtrato && temComprovante) {
        nfsConciliadas++; valorConciliado += Number(nf.valor_bruto || 0);
      }
      if (temExtrato && !temComprovante) {
        // Pago mas sem comprovante anexado — oportunidade de ação imediata
        nfsSemComprovante.push({
          id: nf.id, numero: nf.numero, tomador: nf.tomador,
          valor_bruto: Number(nf.valor_bruto || 0),
          data_pagamento: nf.data_pagamento, data_emissao: nf.data_emissao,
        });
      }
      if (!temExtrato) { nfsAbertas++; valorAbertas += Number(nf.valor_bruto || 0); }
    }

    // Contratos sem NF emitida este mês (oportunidade: boletim→NF)
    const contratosComNfMes = new Set(
      nfsMes.map(n => (n.contrato_ref || '').trim()).filter(Boolean)
    );
    const contratosSemNf = contratosAtivos.filter(c => !contratosComNfMes.has(c.numContrato));

    // Boletins aprovados sem NFS-e emitida
    const boletinsAprovadosSemNfse = boletinsMes.filter(b =>
      ['aprovado', 'aprovada'].includes(String(b.status_boletim || '').toLowerCase()) &&
      !b.nfse_numero
    );

    // ───────── ETAPA 7: Retenções apuradas (via comprovantes) ─────────
    // Heurística: se existe comprovante TIPO='ENTRADA' vinculado a NF,
    // diferença entre NF.valor_bruto e comprovante.valor ≈ retenção efetiva
    let retencaoApuradaComprovantes = 0;
    let nfsComRetencaoApurada = 0;
    try {
      const rows = db.prepare(`
        SELECT cv.destino_id AS nf_id,
               SUM(cv.valor_vinculado) AS valor_recebido
        FROM comprovante_vinculos cv
        JOIN comprovantes_pagamento c ON c.id = cv.comprovante_id
        WHERE cv.tipo_destino = 'NF'
          AND c.direcao = 'ENTRADA'
        GROUP BY cv.destino_id
      `).all();
      const recebidosMap = new Map(rows.map(r => [String(r.nf_id), Number(r.valor_recebido || 0)]));
      for (const nf of nfsMes) {
        const recebido = recebidosMap.get(String(nf.id));
        if (recebido && recebido > 0) {
          const ret = Math.max(0, Number(nf.valor_bruto || 0) - recebido);
          retencaoApuradaComprovantes += ret;
          nfsComRetencaoApurada++;
        }
      }
    } catch (_) {}

    // ───────── MONTA PAYLOAD ─────────
    const payload = {
      empresa: req.company?.nome || req.companyKey,
      competencia,
      gerado_em: new Date().toISOString(),

      // Funil principal (6 barras)
      funil: [
        { etapa: 1, nome: 'Contratos ativos',          total: contratosAtivos.length,  valor: contratosAtivos.reduce((s,c)=>s+Number(c.valor_mensal_bruto||0),0) },
        { etapa: 2, nome: 'Com boletim no mês',        total: boletinsPorContrato.size, valor: Array.from(boletinsPorContrato.values()).reduce((s,b)=>s+Number(b.valor_total||0),0) },
        { etapa: 3, nome: 'Com NF emitida',            total: contratosAtivos.length - contratosSemNf.length, valor: valorEmitido },
        { etapa: 4, nome: 'Com pagamento identificado',total: nfsComExtrato,           valor: valorComExtrato },
        { etapa: 5, nome: 'Com comprovante anexado',   total: nfsComComprovanteAnexado, valor: valorComComprovante },
        { etapa: 6, nome: 'Conciliadas (triplo match)',total: nfsConciliadas,          valor: valorConciliado },
      ],

      // Gaps acionáveis
      acoes: {
        contratos_sem_nf: contratosSemNf.map(c => ({
          numContrato: c.numContrato, orgao: c.orgao,
          valor_esperado: Number(c.valor_mensal_bruto || 0),
          tem_boletim: boletinsPorContrato.has(c.numContrato),
          boletim_id: boletinsPorContrato.get(c.numContrato)?.id || null,
        })),
        boletins_aprovados_sem_nfse: boletinsAprovadosSemNfse.map(b => ({
          id: b.id, contrato_ref: b.contrato_ref, orgao: b.orgao,
          valor_total: Number(b.valor_total || 0),
        })),
        nfs_abertas: {
          total: nfsAbertas,
          valor: valorAbertas,
        },
        nfs_pagas_sem_comprovante: nfsSemComprovante
          .sort((a, b) => b.valor_bruto - a.valor_bruto)
          .slice(0, 20),
      },

      // Box de retenções / DRE
      retencoes: {
        declarada_nfs:      retencaoDeclaradaNFs,
        apurada_comprovantes: retencaoApuradaComprovantes,
        nfs_com_retencao_apurada: nfsComRetencaoApurada,
        divergencia_pct: retencaoDeclaradaNFs > 0
          ? +((retencaoApuradaComprovantes - retencaoDeclaradaNFs) / retencaoDeclaradaNFs * 100).toFixed(1)
          : null,
      },

      // Meta
      meta: {
        total_nfs_mes: nfsEmitidas,
        valor_total_emitido: valorEmitido,
      },
    };

    res.json(payload);
  } catch (err) {
    console.error('[ciclo] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
