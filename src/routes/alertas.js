/**
 * Montana ERP — Módulo de Alertas Operacionais
 * GET /api/alertas — retorna array de alertas para exibir no Dashboard
 *
 * Fontes de alertas:
 *  - Contratos vencidos / vencendo em 30/60/90 dias
 *  - Patrimônio depreciado >90%
 *  - Caixa livre crítico (se tabela existir)
 *
 * Criado: 2026-05-05
 */
'use strict';
const express   = require('express');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

router.get('/', async (req, res) => {
  const db  = req.db;
  const hoje = new Date().toISOString().slice(0, 10);
  const em30 = new Date(Date.now() + 30*86400000).toISOString().slice(0, 10);
  const em60 = new Date(Date.now() + 60*86400000).toISOString().slice(0, 10);
  const em90 = new Date(Date.now() + 90*86400000).toISOString().slice(0, 10);

  const alertas = [];

  try {
    // ── 1. Contratos vencidos ─────────────────────────────────────
    const vencidos = await db.prepare(`
      SELECT numContrato, contrato, vigencia_fim, valor_mensal_bruto
      FROM contratos
      WHERE LOWER(COALESCE(status,'')) NOT LIKE '%encerrad%'
        AND LOWER(COALESCE(status,'')) NOT LIKE '%rescindid%'
        AND vigencia_fim IS NOT NULL AND vigencia_fim != ''
        AND safe_date(vigencia_fim) < CURRENT_DATE
      ORDER BY vigencia_fim ASC LIMIT 10
    `).all();

    vencidos.forEach(c => {
      const diasAtras = Math.abs(Math.floor((new Date(c.vigencia_fim) - new Date()) / 86400000));
      alertas.push({
        tipo: 'contrato_vencido',
        nivel: 'critico',
        titulo: 'Contrato vencido',
        descricao: `${c.contrato || c.numContrato} — venceu há ${diasAtras} dias (${c.vigencia_fim})`,
        link: '#cont',
        valor: c.valor_mensal_bruto || null,
      });
    });

    // ── 2. Contratos vencendo em 30 dias ─────────────────────────
    const vencendo30 = await db.prepare(`
      SELECT numContrato, contrato, vigencia_fim, valor_mensal_bruto
      FROM contratos
      WHERE LOWER(COALESCE(status,'')) NOT LIKE '%encerrad%'
        AND LOWER(COALESCE(status,'')) NOT LIKE '%rescindid%'
        AND vigencia_fim IS NOT NULL AND vigencia_fim != ''
        AND safe_date(vigencia_fim) >= CURRENT_DATE
        AND safe_date(vigencia_fim) <= $1
      ORDER BY vigencia_fim ASC LIMIT 10
    `).all(em30);

    vencendo30.forEach(c => {
      const dias = Math.floor((new Date(c.vigencia_fim) - new Date()) / 86400000);
      alertas.push({
        tipo: 'contrato_vencendo',
        nivel: 'critico',
        titulo: 'Contrato vence em breve',
        descricao: `${c.contrato || c.numContrato} — vence em ${dias} dia(s) (${c.vigencia_fim})`,
        link: '#cont',
        valor: c.valor_mensal_bruto || null,
      });
    });

    // ── 3. Contratos vencendo 30-60 dias ─────────────────────────
    const vencendo60 = await db.prepare(`
      SELECT numContrato, contrato, vigencia_fim, valor_mensal_bruto
      FROM contratos
      WHERE LOWER(COALESCE(status,'')) NOT LIKE '%encerrad%'
        AND LOWER(COALESCE(status,'')) NOT LIKE '%rescindid%'
        AND vigencia_fim IS NOT NULL AND vigencia_fim != ''
        AND safe_date(vigencia_fim) > $1
        AND safe_date(vigencia_fim) <= $2
      ORDER BY vigencia_fim ASC LIMIT 10
    `).all(em30, em60);

    vencendo60.forEach(c => {
      const dias = Math.floor((new Date(c.vigencia_fim) - new Date()) / 86400000);
      alertas.push({
        tipo: 'contrato_vencendo',
        nivel: 'atencao',
        titulo: 'Contrato vence em 60 dias',
        descricao: `${c.contrato || c.numContrato} — vence em ${dias} dias (${c.vigencia_fim})`,
        link: '#cont',
        valor: c.valor_mensal_bruto || null,
      });
    });

    // ── 4. Contratos vencendo 60-90 dias ─────────────────────────
    const vencendo90 = await db.prepare(`
      SELECT numContrato, contrato, vigencia_fim, valor_mensal_bruto
      FROM contratos
      WHERE LOWER(COALESCE(status,'')) NOT LIKE '%encerrad%'
        AND LOWER(COALESCE(status,'')) NOT LIKE '%rescindid%'
        AND vigencia_fim IS NOT NULL AND vigencia_fim != ''
        AND safe_date(vigencia_fim) > $1
        AND safe_date(vigencia_fim) <= $2
      ORDER BY vigencia_fim ASC LIMIT 5
    `).all(em60, em90);

    vencendo90.forEach(c => {
      const dias = Math.floor((new Date(c.vigencia_fim) - new Date()) / 86400000);
      alertas.push({
        tipo: 'contrato_vencendo',
        nivel: 'info',
        titulo: 'Contrato vence em 90 dias',
        descricao: `${c.contrato || c.numContrato} — vence em ${dias} dias`,
        link: '#cont',
        valor: c.valor_mensal_bruto || null,
      });
    });

  } catch(e) {
    console.error('[alertas] contratos:', e.message);
  }

  // ── 5. Patrimônio depreciado >90% ─────────────────────────────
  try {
    const depreciados = await db.prepare(`
      SELECT descricao, valor_aquisicao, valor_atual, categoria
      FROM patrimonio
      WHERE status = 'ATIVO'
        AND valor_aquisicao > 0
        AND valor_atual < valor_aquisicao * 0.10
      ORDER BY valor_atual ASC LIMIT 5
    `).all();

    if (depreciados.length > 0) {
      alertas.push({
        tipo: 'patrimonio_depreciado',
        nivel: 'info',
        titulo: `${depreciados.length} ativo(s) quase depreciados`,
        descricao: depreciados.map(p => p.descricao).join(', '),
        link: '#patrimonio',
        valor: null,
      });
    }
  } catch(e) {
    // tabela pode não existir — ignora silenciosamente
    if (!e.message?.includes('does not exist') && !e.message?.includes('no such table')) {
      console.error('[alertas] patrimônio:', e.message);
    }
  }

  // ── 6. Contas a Pagar — despesas vencidas ────────────────────
  try {
    const cpVencidas = await db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(valor_bruto),0) as total
      FROM despesas
      WHERE status != 'PAGO'
        AND data_iso IS NOT NULL AND data_iso != ''
        AND safe_date(data_iso) < CURRENT_DATE
    `).get();

    const cpSemana = await db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(valor_bruto),0) as total
      FROM despesas
      WHERE status != 'PAGO'
        AND data_iso IS NOT NULL AND data_iso != ''
        AND safe_date(data_iso) >= CURRENT_DATE
        AND safe_date(data_iso) <= CURRENT_DATE + INTERVAL '7 days'
    `).get();

    const brlShort = (v) => {
      if (!v) return 'R$ 0';
      if (v >= 1000000) return 'R$ ' + (v/1000000).toFixed(1) + 'M';
      if (v >= 1000) return 'R$ ' + (v/1000).toFixed(0) + 'k';
      return 'R$ ' + v.toFixed(0);
    };

    if (cpVencidas && cpVencidas.count > 0) {
      alertas.push({
        tipo: 'cp_vencida',
        nivel: 'critico',
        titulo: `${cpVencidas.count} despesa${cpVencidas.count !== 1 ? 's' : ''} vencida${cpVencidas.count !== 1 ? 's' : ''}`,
        descricao: `Total em atraso: ${brlShort(cpVencidas.total)} — clique para ver Contas a Pagar`,
        link: '#contas-pagar',
        valor: null,
      });
    }

    if (cpSemana && cpSemana.count > 0) {
      alertas.push({
        tipo: 'cp_vencendo',
        nivel: 'atencao',
        titulo: `${cpSemana.count} despesa${cpSemana.count !== 1 ? 's' : ''} vence${cpSemana.count !== 1 ? 'm' : ''} esta semana`,
        descricao: `Total: ${brlShort(cpSemana.total)} — vencimento nos próximos 7 dias`,
        link: '#contas-pagar',
        valor: null,
      });
    }
  } catch(e) {
    // tabela pode não existir — ignora
    if (!e.message?.includes('does not exist') && !e.message?.includes('no such table')) {
      console.error('[alertas] contas-pagar:', e.message);
    }
  }

  // ── 7. Caixa livre crítico ────────────────────────────────────
  try {
    const param = await db.prepare(`SELECT dias_cobertura FROM caixa_parametros LIMIT 1`).get();
    if (param && param.dias_cobertura != null) {
      const dias = parseFloat(param.dias_cobertura);
      if (dias < 15) {
        alertas.push({
          tipo: 'caixa_critico',
          nivel: 'critico',
          titulo: 'Caixa livre crítico',
          descricao: `Cobertura estimada: ${dias.toFixed(0)} dias (mínimo recomendado: 30 dias)`,
          link: '#caixa-livre',
          valor: null,
        });
      } else if (dias < 30) {
        alertas.push({
          tipo: 'caixa_critico',
          nivel: 'atencao',
          titulo: 'Caixa livre abaixo do ideal',
          descricao: `Cobertura estimada: ${dias.toFixed(0)} dias (ideal: 30+ dias)`,
          link: '#caixa-livre',
          valor: null,
        });
      }
    }
  } catch(e) {
    // tabela pode não existir — ignora silenciosamente
  }

  // ── 8. Certidões vencidas e próximas do vencimento ───────────
  try {
    const hoje2 = new Date().toISOString().slice(0, 10);
    const em15 = new Date(Date.now() + 15*86400000).toISOString().slice(0, 10);
    const em30b = new Date(Date.now() + 30*86400000).toISOString().slice(0, 10);

    const certVencidas = await db.prepare(`
      SELECT COUNT(*) as count FROM certidoes
      WHERE data_validade IS NOT NULL AND data_validade < $1
    `).get(hoje2);

    const certEm15 = await db.prepare(`
      SELECT COUNT(*) as count FROM certidoes
      WHERE data_validade IS NOT NULL AND data_validade >= $1 AND data_validade <= $2
    `).get(hoje2, em15);

    const certEm30 = await db.prepare(`
      SELECT COUNT(*) as count FROM certidoes
      WHERE data_validade IS NOT NULL AND data_validade > $1 AND data_validade <= $2
    `).get(em15, em30b);

    if (certVencidas && certVencidas.count > 0) {
      alertas.push({
        tipo: 'certidao_vencida',
        nivel: 'critico',
        titulo: `${certVencidas.count} certidão${certVencidas.count !== 1 ? 'ões' : ''} vencida${certVencidas.count !== 1 ? 's' : ''}`,
        descricao: 'Certidões fiscais vencidas podem impedir emissão de NFs e participação em licitações',
        link: '#certidoes',
        valor: null,
      });
    }
    if (certEm15 && certEm15.count > 0) {
      alertas.push({
        tipo: 'certidao_vencendo',
        nivel: 'critico',
        titulo: `${certEm15.count} certidão${certEm15.count !== 1 ? 'ões' : ''} vence${certEm15.count !== 1 ? 'm' : ''} em 15 dias`,
        descricao: 'Renovar urgente para evitar irregularidade fiscal',
        link: '#certidoes',
        valor: null,
      });
    }
    if (certEm30 && certEm30.count > 0) {
      alertas.push({
        tipo: 'certidao_vencendo',
        nivel: 'atencao',
        titulo: `${certEm30.count} certidão${certEm30.count !== 1 ? 'ões' : ''} vence${certEm30.count !== 1 ? 'm' : ''} em 30 dias`,
        descricao: 'Planejar renovação das certidões fiscais',
        link: '#certidoes',
        valor: null,
      });
    }
  } catch(e) {
    // tabela pode não existir — ignora
    if (!e.message?.includes('does not exist') && !e.message?.includes('no such table')) {
      console.error('[alertas] certidões:', e.message);
    }
  }

  res.json({ ok: true, alertas, total: alertas.length });
});

module.exports = router;
