/**
 * Montana — Módulo de Notificações por E-mail
 * Alertas automáticos: certidões, contratos, pagamentos, licitações.
 */
const express = require('express');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

// ─── Config SMTP ─────────────────────────────────────────────────
async function getSmtp(db) {
  const rows = await db.prepare(`SELECT chave, valor FROM configuracoes WHERE chave LIKE 'smtp_%'`).all();
  const smtp = {};
  rows.forEach(r => { smtp[r.chave.replace('smtp_', '')] = r.valor; });
  return smtp;
}

// GET /api/notificacoes/smtp
router.get('/smtp', async (req, res) => {
  const smtp = getSmtp(req.db);
  // Não retornar a senha em texto puro — mascarar
  if (smtp.pass) smtp.pass = '••••••••';
  res.json(smtp);
});

// PUT /api/notificacoes/smtp
router.put('/smtp', async (req, res) => {
  const { host, port, user, pass, from, to } = req.body;
  const upsert = req.db.prepare(`INSERT INTO configuracoes (chave,valor,updated_at) VALUES (@chave,@valor,NOW())`);
  const trans = req.db.transaction(async () => {
    if (host !== undefined) upsert.run({ chave:'smtp_host',  valor: host       || '' });
    if (port !== undefined) upsert.run({ chave:'smtp_port',  valor: String(port|| 587) });
    if (user !== undefined) upsert.run({ chave:'smtp_user',  valor: user        || '' });
    if (pass !== undefined && pass !== '••••••••') upsert.run({ chave:'smtp_pass', valor: pass || '' });
    if (from !== undefined) upsert.run({ chave:'smtp_from',  valor: from        || '' });
    if (to   !== undefined) upsert.run({ chave:'smtp_to',    valor: to          || '' });
  });
  await trans();
  res.json({ ok: true });
});

// GET /api/notificacoes/log
router.get('/log', async (req, res) => {
  const rows = await req.db.prepare(`SELECT * FROM notificacoes_log ORDER BY created_at DESC LIMIT 100`).all();
  res.json({ data: rows, total: rows.length });
});

// GET /api/notificacoes/preview — lista alertas pendentes sem enviar
router.get('/preview', async (req, res) => {
  const hoje = new Date().toISOString().split('T')[0];
  const em15 = new Date(Date.now() + 15 * 86400000).toISOString().split('T')[0];
  const em30 = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
  const em5  = new Date(Date.now() +  5 * 86400000).toISOString().split('T')[0];
  const ha30 = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

  const ha60 = new Date(Date.now() - 60 * 86400000).toISOString().split('T')[0];

  const certidoes  = await req.db.prepare(`SELECT tipo,numero,data_validade FROM certidoes WHERE data_validade<=@em15 AND data_validade>=@hoje ORDER BY data_validade`).all({ em15, hoje });
  const contratos  = await req.db.prepare(`SELECT numContrato,contrato,vigencia_fim FROM contratos WHERE vigencia_fim<=@em30 AND vigencia_fim>=@hoje ORDER BY vigencia_fim`).all({ em30, hoje });
  const pagAtras   = await req.db.prepare(`SELECT COUNT(*) n FROM despesas WHERE status='PENDENTE' AND data_iso<=@ha30`).get({ ha30 });
  const licitacoes = await req.db.prepare(`SELECT orgao,numero_edital,data_abertura FROM licitacoes WHERE data_abertura>=@hoje AND data_abertura<=@em5 AND status IN ('em análise','proposta enviada') ORDER BY data_abertura`).all({ hoje, em5 });

  // NFs sem pagamento há > 60 dias
  let nfsSemPagamento = [];
  try {
    nfsSemPagamento = await req.db.prepare(`
      SELECT tomador, COUNT(*) cnt, COALESCE(SUM(valor_liquido),0) total,
             MIN(data_emissao) mais_antiga
      FROM notas_fiscais
      WHERE status_conciliacao='PENDENTE'
        AND data_emissao <= @ha60 AND data_emissao != ''
        AND data_emissao >= '2024-01-01'
      GROUP BY tomador ORDER BY total DESC LIMIT 10
    `).all({ ha60 });
  } catch(_) {}

  // Conta vinculada com saldo baixo (< 10% do valor mensal do contrato)
  let contasVinculadasAlerta = [];
  try {
    contasVinculadasAlerta = await req.db.prepare(`
      SELECT cv.convenente, cv.conta_vinculada, cv.saldo, cv.data_referencia,
             c.valor_mensal_bruto
      FROM conta_vinculada_saldos cv
      LEFT JOIN contratos c ON UPPER(cv.convenente) LIKE '%' || UPPER(SUBSTR(c.contrato,1,6)) || '%'
      WHERE cv.data_referencia = (SELECT MAX(data_referencia) FROM conta_vinculada_saldos WHERE conta_vinculada=cv.conta_vinculada)
        AND c.valor_mensal_bruto > 0
        AND cv.saldo < c.valor_mensal_bruto * 0.1
    `).all();
  } catch(_) {}

  res.json({
    certidoes,
    contratos,
    pagamentos_atrasados: pagAtras.n,
    licitacoes,
    nfs_sem_pagamento: nfsSemPagamento,
    contas_vinculadas_alerta: contasVinculadasAlerta,
    tem_alertas: certidoes.length + contratos.length + pagAtras.n + licitacoes.length + nfsSemPagamento.length > 0
  });
});

// POST /api/notificacoes/enviar
router.post('/enviar', async (req, res) => {
  const smtp = getSmtp(req.db);

  if (!smtp.host || !smtp.user) {
    return res.status(400).json({ error: 'Configure as credenciais SMTP antes de enviar.' });
  }

  // Verificar nodemailer
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch(e) { return res.status(500).json({ error: 'nodemailer não instalado. Execute: npm install nodemailer no diretório do app.' }); }

  const hoje = new Date().toISOString().split('T')[0];
  const em15 = new Date(Date.now() + 15 * 86400000).toISOString().split('T')[0];
  const em30 = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
  const em5  = new Date(Date.now() +  5 * 86400000).toISOString().split('T')[0];
  const ha30 = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

  const certidoes  = await req.db.prepare(`SELECT tipo,numero,data_validade FROM certidoes WHERE data_validade<=@em15 AND data_validade>=@hoje`).all({ em15, hoje });
  const contratos  = await req.db.prepare(`SELECT numContrato,contrato,vigencia_fim FROM contratos WHERE vigencia_fim<=@em30 AND vigencia_fim>=@hoje`).all({ em30, hoje });
  const pagAtras   = await req.db.prepare(`SELECT COUNT(*) n FROM despesas WHERE status='PENDENTE' AND data_iso<=@ha30`).get({ ha30 });
  const licitacoes = await req.db.prepare(`SELECT orgao,numero_edital,data_abertura FROM licitacoes WHERE data_abertura>=@hoje AND data_abertura<=@em5 AND status IN ('em análise','proposta enviada')`).all({ hoje, em5 });

  const totalAlertas = certidoes.length + contratos.length + pagAtras.n + licitacoes.length;
  if (totalAlertas === 0) {
    return res.json({ ok: true, enviado: false, message: 'Nenhum alerta encontrado. Nenhum e-mail enviado.' });
  }

  // Montar corpo HTML
  let corpo = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
    <div style="background:#1e293b;color:#fff;padding:20px;border-radius:8px 8px 0 0">
      <h2 style="margin:0">🔔 Alertas — ${req.company.nome}</h2>
      <p style="margin:4px 0 0;opacity:.7;font-size:13px">${new Date().toLocaleDateString('pt-BR',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p>
    </div>
    <div style="border:1px solid #e2e8f0;border-top:none;padding:20px;border-radius:0 0 8px 8px">
  `;

  if (certidoes.length > 0) {
    corpo += `<h3 style="color:#dc2626">📋 Certidões Vencendo nos Próximos 15 Dias (${certidoes.length})</h3><ul>`;
    certidoes.forEach(c => {
      corpo += `<li><strong>${c.tipo}</strong> — N° ${c.numero} — Vence: <strong>${c.data_validade}</strong></li>`;
    });
    corpo += '</ul>';
  }

  if (contratos.length > 0) {
    corpo += `<h3 style="color:#d97706">📄 Contratos Vencendo nos Próximos 30 Dias (${contratos.length})</h3><ul>`;
    contratos.forEach(c => {
      corpo += `<li><strong>${c.numContrato}</strong> — ${c.contrato} — Vence: <strong>${c.vigencia_fim}</strong></li>`;
    });
    corpo += '</ul>';
  }

  if (pagAtras.n > 0) {
    corpo += `<h3 style="color:#7c3aed">💸 Pagamentos Pendentes há mais de 30 dias</h3>
      <p><strong>${pagAtras.n} despesas</strong> com status PENDENTE há mais de 30 dias aguardam pagamento.</p>`;
  }

  if (licitacoes.length > 0) {
    corpo += `<h3 style="color:#0369a1">🏛️ Licitações com Abertura nos Próximos 5 Dias (${licitacoes.length})</h3><ul>`;
    licitacoes.forEach(l => {
      corpo += `<li><strong>${l.orgao}</strong> — Ed. ${l.numero_edital} — Abertura: <strong>${l.data_abertura}</strong></li>`;
    });
    corpo += '</ul>';
  }

  corpo += `</div></div>`;

  const assunto = `🔔 ${totalAlertas} Alerta(s) Montana — ${req.company.nomeAbrev} — ${new Date().toLocaleDateString('pt-BR')}`;

  try {
    const transporter = nodemailer.createTransport({
      host:   smtp.host,
      port:   parseInt(smtp.port) || 587,
      secure: parseInt(smtp.port) === 465,
      auth:   { user: smtp.user, pass: smtp.pass }
    });

    await transporter.sendMail({
      from:    smtp.from || smtp.user,
      to:      smtp.to   || smtp.user,
      subject: assunto,
      html:    corpo
    });

    // Log sucesso
    await req.db.prepare(`INSERT INTO notificacoes_log (tipo,destinatario,assunto,corpo,status) VALUES ('email',@to,@assunto,@corpo,'enviado')`).run({
      to: smtp.to || smtp.user, assunto, corpo
    });

    res.json({
      ok: true, enviado: true,
      message: `E-mail enviado para ${smtp.to || smtp.user}`,
      alertas: { certidoes: certidoes.length, contratos: contratos.length, pagamentos: pagAtras.n, licitacoes: licitacoes.length }
    });
  } catch (err) {
    // Log erro
    try {
      await req.db.prepare(`INSERT INTO notificacoes_log (tipo,destinatario,assunto,corpo,status,erro) VALUES ('email',@to,@assunto,'','erro',@erro)`).run({
        to: smtp.to || smtp.user, assunto, erro: err.message
      });
    } catch(e2) {}
    res.status(500).json({ error: 'Falha ao enviar e-mail: ' + err.message });
  }
});

// ─── Função reutilizável exportada para o cron do server.js ──────
/**
 * enviarAlertasEmpresa(db, company) — verifica alertas e envia email se houver.
 * @param {import('better-sqlite3').Database} db  — instância do banco da empresa
 * @param {{ nome, nomeAbrev }} company            — objeto da empresa (de COMPANIES)
 * @returns {Promise<{ enviado: boolean, total: number }>}
 */
async function enviarAlertasEmpresa(db, company) {
  const smtp = getSmtp(db);
  if (!smtp.host || !smtp.user || !smtp.to) {
    return { enviado: false, total: 0, motivo: 'SMTP não configurado' };
  }

  const hoje = new Date().toISOString().split('T')[0];
  const em15 = new Date(Date.now() + 15 * 86400000).toISOString().split('T')[0];
  const em30 = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
  const em5  = new Date(Date.now() +  5 * 86400000).toISOString().split('T')[0];
  const ha30 = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

  const ha60 = new Date(Date.now() - 60 * 86400000).toISOString().split('T')[0];

  const certidoes  = await db.prepare(`SELECT tipo,numero,data_validade FROM certidoes WHERE data_validade<=? AND data_validade>=? ORDER BY data_validade`).all(em15, hoje);
  const contratos  = await db.prepare(`SELECT numContrato,contrato,vigencia_fim FROM contratos WHERE vigencia_fim<=? AND vigencia_fim>=? ORDER BY vigencia_fim`).all(em30, hoje);
  const pagAtras   = await db.prepare(`SELECT COUNT(*) n FROM despesas WHERE status='PENDENTE' AND data_iso<=?`).get(ha30);
  const licitacoes = await db.prepare(`SELECT orgao,numero_edital,data_abertura FROM licitacoes WHERE data_abertura>=? AND data_abertura<=? AND status IN ('em análise','proposta enviada') ORDER BY data_abertura`).all(hoje, em5);

  let nfsSemPagamento = [];
  try {
    nfsSemPagamento = await db.prepare(`
      SELECT tomador, COUNT(*) cnt, COALESCE(SUM(valor_liquido),0) total, MIN(data_emissao) mais_antiga
      FROM notas_fiscais
      WHERE status_conciliacao='PENDENTE' AND data_emissao<=? AND data_emissao!='' AND data_emissao>='2024-01-01'
      GROUP BY tomador ORDER BY total DESC LIMIT 10
    `).all(ha60);
  } catch(_) {}

  const totalAlertas = certidoes.length + contratos.length + pagAtras.n + licitacoes.length + nfsSemPagamento.length;
  if (totalAlertas === 0) return { enviado: false, total: 0, motivo: 'sem alertas' };

  // Monta corpo HTML
  let corpo = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
    <div style="background:#1e293b;color:#fff;padding:20px;border-radius:8px 8px 0 0">
      <h2 style="margin:0">🔔 Alertas — ${company.nome}</h2>
      <p style="margin:4px 0 0;opacity:.7;font-size:13px">${new Date().toLocaleDateString('pt-BR',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p>
    </div>
    <div style="border:1px solid #e2e8f0;border-top:none;padding:20px;border-radius:0 0 8px 8px">
  `;

  if (certidoes.length) {
    corpo += `<h3 style="color:#dc2626">📋 Certidões Vencendo em 15 Dias (${certidoes.length})</h3><ul>`;
    certidoes.forEach(c => corpo += `<li><strong>${c.tipo}</strong> — N° ${c.numero} — Vence: <strong>${c.data_validade}</strong></li>`);
    corpo += '</ul>';
  }

  if (contratos.length) {
    corpo += `<h3 style="color:#d97706">📄 Contratos Vencendo em 30 Dias (${contratos.length})</h3><ul>`;
    contratos.forEach(c => corpo += `<li><strong>${c.numContrato}</strong> — ${c.contrato} — Vence: <strong>${c.vigencia_fim}</strong></li>`);
    corpo += '</ul>';
  }

  if (pagAtras.n > 0) {
    corpo += `<h3 style="color:#7c3aed">💸 Pagamentos Pendentes há +30 dias: ${pagAtras.n}</h3>`;
  }

  if (licitacoes.length) {
    corpo += `<h3 style="color:#0369a1">🏛️ Licitações Abertura em 5 Dias (${licitacoes.length})</h3><ul>`;
    licitacoes.forEach(l => corpo += `<li><strong>${l.orgao}</strong> — Ed. ${l.numero_edital} — ${l.data_abertura}</li>`);
    corpo += '</ul>';
  }

  if (nfsSemPagamento.length) {
    corpo += `<h3 style="color:#b45309">⏰ NFs sem Recebimento há +60 dias</h3><ul>`;
    nfsSemPagamento.forEach(n => corpo += `<li><strong>${n.tomador}</strong> — ${n.cnt} NF(s) — R$ ${n.total.toLocaleString('pt-BR',{minimumFractionDigits:2})}</li>`);
    corpo += '</ul>';
  }

  // ── Alertas de reajuste ─────────────────────────────────────
  let reajusteAlertas = [];
  try {
    const em60 = new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0];
    reajusteAlertas = await db.prepare(`
      SELECT numContrato, contrato, data_proximo_reajuste, indice_reajuste,
             pct_reajuste_ultimo, valor_mensal_bruto,
             CAST((julianday(data_proximo_reajuste) - julianday('now')) AS INTEGER) as dias_faltam
      FROM contratos
      WHERE data_proximo_reajuste IS NOT NULL
        AND data_proximo_reajuste != ''
        AND data_proximo_reajuste <= ?
        AND data_proximo_reajuste >= ?
      ORDER BY data_proximo_reajuste
    `).all(em60, hoje);
  } catch(_) {}

  if (reajusteAlertas.length) {
    corpo += `<h3 style="color:#0891b2">📈 Contratos com Reajuste nos Próximos 60 Dias (${reajusteAlertas.length})</h3><ul>`;
    reajusteAlertas.forEach(r => {
      const brl = v => `R$ ${(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}`;
      corpo += `<li>
        <strong>${r.numContrato}</strong> — ${r.contrato}<br>
        📅 Reajuste previsto: <strong>${r.data_proximo_reajuste}</strong> (em ${r.dias_faltam} dias)
        ${r.indice_reajuste ? ` — Índice: ${r.indice_reajuste}` : ''}
        ${r.pct_reajuste_ultimo ? ` — Último %: ${r.pct_reajuste_ultimo}%` : ''}
        ${r.valor_mensal_bruto ? ` — Valor mensal atual: ${brl(r.valor_mensal_bruto)}` : ''}
      </li>`;
    });
    corpo += '</ul>';
  }

  corpo += `</div></div>`;

  const total = totalAlertas + reajusteAlertas.length;
  if (total === 0) return { enviado: false, total: 0, motivo: 'sem alertas' };

  const assunto = `🔔 ${total} Alerta(s) — ${company.nomeAbrev || company.nome} — ${new Date().toLocaleDateString('pt-BR')}`;

  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch(e) { return { enviado: false, total, motivo: 'nodemailer não instalado' }; }

  try {
    const transporter = nodemailer.createTransport({
      host:   smtp.host,
      port:   parseInt(smtp.port) || 587,
      secure: parseInt(smtp.port) === 465,
      auth:   { user: smtp.user, pass: smtp.pass }
    });
    await transporter.sendMail({ from: smtp.from || smtp.user, to: smtp.to, subject: assunto, html: corpo });
    try {
      await db.prepare(`INSERT INTO notificacoes_log (tipo,destinatario,assunto,corpo,status) VALUES ('email',?,?,?,'enviado')`).run(smtp.to, assunto, corpo);
    } catch(_) {}
    return { enviado: true, total };
  } catch (e) {
    try {
      await db.prepare(`INSERT INTO notificacoes_log (tipo,destinatario,assunto,corpo,status,erro) VALUES ('email',?,?,'','erro',?)`).run(smtp.to||'', assunto, e.message);
    } catch(_) {}
    return { enviado: false, total, motivo: e.message };
  }
}

// ─── POST /api/notificacoes/alertar-reajustes — disparo manual ────
router.post('/alertar-reajustes', async (req, res) => {
  try {
    const smtp = getSmtp(req.db);
    if (!smtp.host || !smtp.user) return res.status(400).json({ error: 'Configure o SMTP antes.' });

    const hoje = new Date().toISOString().split('T')[0];
    const em60 = new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0];

    const reajustes = await req.db.prepare(`
      SELECT numContrato, contrato, data_proximo_reajuste, indice_reajuste,
             pct_reajuste_ultimo, valor_mensal_bruto,
             CAST((julianday(data_proximo_reajuste) - julianday('now')) AS INTEGER) as dias_faltam
      FROM contratos
      WHERE data_proximo_reajuste IS NOT NULL
        AND data_proximo_reajuste != ''
        AND data_proximo_reajuste <= ?
      ORDER BY data_proximo_reajuste
    `).all(em60);

    if (!reajustes.length) return res.json({ ok: true, enviado: false, message: 'Nenhum contrato com reajuste nos próximos 60 dias.' });

    let nodemailer;
    try { nodemailer = require('nodemailer'); }
    catch(e) { return res.status(500).json({ error: 'nodemailer não instalado.' }); }

    const brl = v => `R$ ${(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}`;
    let corpo = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#0891b2;color:#fff;padding:20px;border-radius:8px 8px 0 0">
        <h2 style="margin:0">📈 Alerta de Reajustes — ${req.company.nome}</h2>
        <p style="margin:4px 0 0;opacity:.8;font-size:13px">${new Date().toLocaleDateString('pt-BR',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p>
      </div>
      <div style="border:1px solid #e2e8f0;border-top:none;padding:20px;border-radius:0 0 8px 8px">
        <p>${reajustes.length} contrato(s) com reajuste previsto nos próximos 60 dias:</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr style="background:#f1f5f9;font-weight:bold">
            <th style="padding:8px;text-align:left;border:1px solid #e2e8f0">Contrato</th>
            <th style="padding:8px;text-align:left;border:1px solid #e2e8f0">Data Reajuste</th>
            <th style="padding:8px;text-align:left;border:1px solid #e2e8f0">Dias</th>
            <th style="padding:8px;text-align:left;border:1px solid #e2e8f0">Índice</th>
            <th style="padding:8px;text-align:right;border:1px solid #e2e8f0">Valor Mensal</th>
          </tr>
          ${reajustes.map(r => `
          <tr style="${r.dias_faltam <= 15 ? 'background:#fef2f2' : r.dias_faltam <= 30 ? 'background:#fffbeb' : ''}">
            <td style="padding:7px 8px;border:1px solid #e2e8f0"><strong>${r.numContrato}</strong><br><span style="font-size:11px;color:#6b7280">${r.contrato}</span></td>
            <td style="padding:7px 8px;border:1px solid #e2e8f0;font-weight:600">${r.data_proximo_reajuste}</td>
            <td style="padding:7px 8px;border:1px solid #e2e8f0;color:${r.dias_faltam<=15?'#dc2626':r.dias_faltam<=30?'#d97706':'#059669'};font-weight:700">${r.dias_faltam}d</td>
            <td style="padding:7px 8px;border:1px solid #e2e8f0">${r.indice_reajuste||'—'}${r.pct_reajuste_ultimo?' ('+r.pct_reajuste_ultimo+'%)':''}</td>
            <td style="padding:7px 8px;border:1px solid #e2e8f0;text-align:right">${r.valor_mensal_bruto?brl(r.valor_mensal_bruto):'—'}</td>
          </tr>`).join('')}
        </table>
        <p style="margin-top:16px;font-size:12px;color:#6b7280">Acesse o sistema para registrar o reajuste e atualizar os valores contratuais.</p>
      </div></div>
    `;

    const assunto = `📈 ${reajustes.length} Reajuste(s) — ${req.company.nomeAbrev} — ${new Date().toLocaleDateString('pt-BR')}`;

    const transporter = nodemailer.createTransport({
      host: smtp.host, port: parseInt(smtp.port)||587,
      secure: parseInt(smtp.port)===465, auth: { user: smtp.user, pass: smtp.pass }
    });
    await transporter.sendMail({ from: smtp.from||smtp.user, to: smtp.to, subject: assunto, html: corpo });

    try {
      await req.db.prepare(`INSERT INTO notificacoes_log (tipo,destinatario,assunto,corpo,status) VALUES ('email',?,?,?,'enviado')`).run(smtp.to, assunto, corpo);
    } catch(_) {}

    res.json({ ok: true, enviado: true, total: reajustes.length, message: `E-mail enviado para ${smtp.to}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── FASE 3: Verificação de Duplicatas ──────────────────────────────────────

/**
 * verificarDuplicatas(db, companyKey)
 * Escaneia o banco em busca de registros duplicados nas tabelas críticas.
 * Retorna objeto com listas de duplicatas encontradas por tabela.
 */
async function verificarDuplicatas(db, companyKey) {
  const resultado = { temDuplicatas: false, extratos: [], notas: [], despesas: [] };

  // ── extratos: mesmo data_iso + historico + valor + tipo sem bb_hash (legados) ──
  // Ignora linhas informativas sem valor (saldo, bloqueio judicial, etc. — val=0)
  // que aparecem múltiplas vezes no extrato BB e não são duplicatas reais.
  try {
    const dupExt = await db.prepare(`
      SELECT data_iso, historico, COALESCE(debito,0) debito, COALESCE(credito,0) credito,
             tipo, COUNT(*) cnt
      FROM extratos
      WHERE (bb_hash IS NULL OR bb_hash = '') AND data_iso != ''
        AND (COALESCE(debito,0) + COALESCE(credito,0)) > 0
      GROUP BY data_iso, historico, debito, credito, tipo
      HAVING cnt > 1
      ORDER BY cnt DESC LIMIT 30
    `).all();
    resultado.extratos = dupExt;
    if (dupExt.length > 0) resultado.temDuplicatas = true;
  } catch(_) {}

  // ── extratos: bb_hash duplicado (mesma hash em dois registros distintos) ──
  try {
    const dupHash = await db.prepare(`
      SELECT bb_hash, COUNT(*) cnt FROM extratos
      WHERE bb_hash != '' AND bb_hash NOT LIKE '%_dup%'
      GROUP BY bb_hash HAVING cnt > 1 LIMIT 20
    `).all();
    if (dupHash.length > 0) {
      resultado.extratos.push(...dupHash.map(r => ({ ...r, tipo_duplic: 'bb_hash' })));
      resultado.temDuplicatas = true;
    }
  } catch(_) {}

  // ── notas_fiscais: numero duplicado (ignora 0 e vazio) ──
  try {
    const dupNfs = await db.prepare(`
      SELECT numero, COUNT(*) cnt, MIN(data_emissao) data_emissao,
             GROUP_CONCAT(tomador, ' / ') tomadores
      FROM notas_fiscais
      WHERE numero != '' AND numero != '0'
      GROUP BY numero HAVING cnt > 1
      ORDER BY cnt DESC LIMIT 20
    `).all();
    resultado.notas = dupNfs;
    if (dupNfs.length > 0) resultado.temDuplicatas = true;
  } catch(_) {}

  // ── despesas: dedup_hash duplicado ──
  try {
    const dupDesp = await db.prepare(`
      SELECT dedup_hash, COUNT(*) cnt,
             MIN(data_iso) data_iso, MIN(fornecedor) fornecedor,
             MIN(valor_bruto) valor_bruto
      FROM despesas
      WHERE dedup_hash != '' AND dedup_hash NOT LIKE '%_dup%'
      GROUP BY dedup_hash HAVING cnt > 1
      ORDER BY cnt DESC LIMIT 20
    `).all();
    resultado.despesas = dupDesp;
    if (dupDesp.length > 0) resultado.temDuplicatas = true;
  } catch(_) {}

  return resultado;
}

/**
 * enviarAlertaDedup(db, company, relatorio)
 * Envia e-mail com relatório de duplicatas para a empresa.
 */
async function enviarAlertaDedup(db, company, relatorio) {
  const smtp = getSmtp(db);
  if (!smtp.host || !smtp.user || !smtp.to) {
    return { enviado: false, motivo: 'SMTP não configurado' };
  }

  const brl = v => `R$ ${Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}`;
  const hoje = new Date().toLocaleDateString('pt-BR',{weekday:'long',year:'numeric',month:'long',day:'numeric'});

  let corpo = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto">
    <div style="background:#7f1d1d;color:#fff;padding:20px;border-radius:8px 8px 0 0">
      <h2 style="margin:0">⚠️ Alerta de Duplicatas — ${company.nome}</h2>
      <p style="margin:4px 0 0;opacity:.8;font-size:13px">${hoje}</p>
    </div>
    <div style="border:1px solid #fca5a5;border-top:none;padding:20px;border-radius:0 0 8px 8px;background:#fff8f8">
    <p style="color:#991b1b">Foram detectados registros duplicados no banco de dados. Verifique e corrija antes da próxima conciliação.</p>
  `;

  if (relatorio.extratos.length > 0) {
    corpo += `<h3 style="color:#b91c1c">💰 Extratos Bancários Duplicados (${relatorio.extratos.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
    <tr style="background:#fee2e2"><th>Data</th><th>Histórico</th><th>Valor</th><th>Ocorrências</th></tr>`;
    relatorio.extratos.slice(0, 10).forEach(e => {
      const val = e.credito > 0 ? brl(e.credito) : brl(e.debito);
      corpo += `<tr style="border-bottom:1px solid #fecaca">
        <td style="padding:4px">${e.data_iso||''}</td>
        <td style="padding:4px">${(e.historico||'').slice(0,50)}</td>
        <td style="padding:4px">${val}</td>
        <td style="padding:4px;text-align:center;color:#dc2626"><strong>${e.cnt}</strong></td>
      </tr>`;
    });
    corpo += '</table>';
  }

  if (relatorio.notas.length > 0) {
    corpo += `<h3 style="color:#b91c1c">🧾 Notas Fiscais Duplicadas (${relatorio.notas.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
    <tr style="background:#fee2e2"><th>Número NF</th><th>Data</th><th>Ocorrências</th></tr>`;
    relatorio.notas.forEach(n => {
      corpo += `<tr style="border-bottom:1px solid #fecaca">
        <td style="padding:4px"><strong>${n.numero}</strong></td>
        <td style="padding:4px">${n.data_emissao||''}</td>
        <td style="padding:4px;text-align:center;color:#dc2626"><strong>${n.cnt}</strong></td>
      </tr>`;
    });
    corpo += '</table>';
  }

  if (relatorio.despesas.length > 0) {
    corpo += `<h3 style="color:#b91c1c">💸 Despesas Duplicadas (${relatorio.despesas.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:12px">
    <tr style="background:#fee2e2"><th>Data</th><th>Fornecedor</th><th>Valor</th><th>Ocorrências</th></tr>`;
    relatorio.despesas.forEach(d => {
      corpo += `<tr style="border-bottom:1px solid #fecaca">
        <td style="padding:4px">${d.data_iso||''}</td>
        <td style="padding:4px">${(d.fornecedor||'').slice(0,40)}</td>
        <td style="padding:4px">${brl(d.valor_bruto)}</td>
        <td style="padding:4px;text-align:center;color:#dc2626"><strong>${d.cnt}</strong></td>
      </tr>`;
    });
    corpo += '</table>';
  }

  const totalItens = relatorio.extratos.length + relatorio.notas.length + relatorio.despesas.length;
  corpo += `<p style="margin-top:16px;font-size:12px;color:#666">
    Acesse o Montana ERP para corrigir estes registros.<br>
    Este alerta é gerado automaticamente pela Fase 3 do sistema Anti-Duplicação.
  </p></div></div>`;

  const assunto = `⚠️ ${totalItens} Duplicata(s) Detectadas — ${company.nomeAbrev || company.nome} — ${new Date().toLocaleDateString('pt-BR')}`;

  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch(e) { return { enviado: false, motivo: 'nodemailer não instalado' }; }

  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host, port: parseInt(smtp.port)||587,
      secure: parseInt(smtp.port)===465, auth: { user: smtp.user, pass: smtp.pass }
    });
    await transporter.sendMail({ from: smtp.from||smtp.user, to: smtp.to, subject: assunto, html: corpo });
    try {
      await db.prepare(`INSERT INTO notificacoes_log (tipo,destinatario,assunto,corpo,status) VALUES ('email',?,?,?,'enviado')`).run(smtp.to, assunto, corpo);
    } catch(_) {}
    return { enviado: true, totalItens };
  } catch(e) {
    try {
      await db.prepare(`INSERT INTO notificacoes_log (tipo,destinatario,assunto,corpo,status,erro) VALUES ('email',?,?,'','erro',?)`).run(smtp.to||'', assunto, e.message);
    } catch(_) {}
    return { enviado: false, motivo: e.message };
  }
}

// POST /api/notificacoes/verificar-dedup — disparo manual
router.post('/verificar-dedup', async (req, res) => {
  try {
    const relatorio = verificarDuplicatas(req.db, req.companyKey);
    if (!relatorio.temDuplicatas) {
      return res.json({ ok: true, temDuplicatas: false, message: 'Nenhuma duplicata encontrada ✅' });
    }
    const envio = await enviarAlertaDedup(req.db, req.company, relatorio);
    res.json({ ok: true, temDuplicatas: true, relatorio, envio });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.enviarAlertasEmpresa = enviarAlertasEmpresa;
module.exports.verificarDuplicatas  = verificarDuplicatas;
module.exports.enviarAlertaDedup    = enviarAlertaDedup;
