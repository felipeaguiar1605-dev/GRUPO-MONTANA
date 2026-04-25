/**
 * Montana ERP — Rotas REST para Alertas Operacionais
 *
 * GET  /api/alertas-operacionais              → relatório consolidado (3 checks)
 * GET  /api/alertas-operacionais/faturamento  → só #1
 * GET  /api/alertas-operacionais/cobrancas    → só #2
 * GET  /api/alertas-operacionais/folha        → só #3
 * POST /api/alertas-operacionais/enviar-email → dispara email (usa SMTP da empresa)
 */

const express   = require('express');
const companyMw = require('../companyMiddleware');
const alertas   = require('../alertas-operacionais');

const router = express.Router();
router.use(companyMw);

// ─── Consolidado ──────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const opcoes = {};
    if (req.query.competencia) {
      opcoes.faturamento = { competencia: req.query.competencia };
    }
    const rel = alertas.rodarTodos(req.db, req.company, opcoes);
    res.json({ ok: true, ...rel });
  } catch (e) {
    console.error('[alertas-operacionais]', e);
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ─── Endpoints individuais ────────────────────────────────────────────────────

router.get('/faturamento', (req, res) => {
  try {
    const r = alertas.faturamentoNaoEmitido(req.db, req.company, {
      competencia: req.query.competencia,
      dia_corte:   req.query.dia_corte ? Number(req.query.dia_corte) : undefined,
    });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

router.get('/cobrancas', (req, res) => {
  try {
    const r = alertas.cobrancasAtrasadas(req.db, req.company, {
      min_amostras: req.query.min_amostras ? Number(req.query.min_amostras) : undefined,
      sla_padrao:   req.query.sla_padrao   ? Number(req.query.sla_padrao)   : undefined,
      atraso_extra: req.query.atraso_extra ? Number(req.query.atraso_extra) : undefined,
    });
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

router.get('/folha', (req, res) => {
  try {
    const opts = {};
    if (req.query.competencias) opts.competencias = String(req.query.competencias).split(',');
    const r = alertas.folhaSemContrapartida(req.db, req.company, opts);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ─── Envio manual de email ────────────────────────────────────────────────────

router.post('/enviar-email', async (req, res) => {
  try {
    const rel = alertas.rodarTodos(req.db, req.company, req.body?.opcoes || {});
    if (rel.total_geral === 0) {
      return res.json({ ok: true, enviado: false, motivo: 'nenhum alerta operacional' });
    }

    // Busca SMTP da empresa
    const smtpRows = req.db.prepare(`SELECT chave, valor FROM configuracoes WHERE chave LIKE 'smtp_%'`).all();
    const smtp = {};
    smtpRows.forEach(r => { smtp[r.chave.replace('smtp_', '')] = r.valor; });

    if (!smtp.host || !smtp.user || !smtp.to) {
      return res.status(400).json({ ok: false, erro: 'SMTP não configurado' });
    }

    let nodemailer;
    try { nodemailer = require('nodemailer'); }
    catch (_) { return res.status(500).json({ ok: false, erro: 'nodemailer não instalado' }); }

    const html    = alertas.formatarHTML(rel);
    const assunto = `⚠ ${rel.total_geral} Alerta(s) Operacional(is) — ${req.company.nomeAbrev || req.company.nome} — ${new Date().toLocaleDateString('pt-BR')}`;

    const transporter = nodemailer.createTransport({
      host:   smtp.host,
      port:   parseInt(smtp.port) || 587,
      secure: parseInt(smtp.port) === 465,
      auth:   { user: smtp.user, pass: smtp.pass },
    });

    await transporter.sendMail({
      from:    smtp.from || smtp.user,
      to:      smtp.to,
      subject: assunto,
      html,
    });

    try {
      req.db.prepare(`INSERT INTO notificacoes_log (tipo,destinatario,assunto,corpo,status)
                      VALUES ('email',?,?,?,'enviado')`).run(smtp.to, assunto, html);
    } catch (_) {}

    res.json({ ok: true, enviado: true, total: rel.total_geral, destino: smtp.to });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

module.exports = router;
