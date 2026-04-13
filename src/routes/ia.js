/**
 * Montana ERP — Assistente Financeiro IA (Claude)
 *
 * GET  /ia/status  — verifica se a IA está configurada
 * POST /ia/chat    — envia mensagem e recebe resposta contextualizada
 */

const express    = require('express');
const { getDb, COMPANIES } = require('../db');
const companyMw  = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

const MODELO = 'claude-haiku-4-5';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function buildContexto(db, company) {
  try {
    const ano  = new Date().getFullYear();
    const mes  = String(new Date().getMonth() + 1).padStart(2, '0');
    const from = `${ano}-${mes}-01`;
    const to   = `${ano}-${mes}-31`;

    const fat  = db.prepare(`SELECT COALESCE(SUM(valor_bruto),0) v FROM notas_fiscais WHERE (data_emissao>=? AND data_emissao<=?)`).get(from, to);
    const desp = db.prepare(`SELECT COALESCE(SUM(valor_bruto),0) v FROM despesas WHERE data_iso>=? AND data_iso<=?`).get(from, to);
    const pend = db.prepare(`SELECT COUNT(*) n FROM extratos WHERE status_conciliacao='PENDENTE'`).get();
    const ctrs = db.prepare(`SELECT numContrato, contrato, valor_mensal_bruto FROM contratos WHERE status!='encerrado' LIMIT 5`).all();
    const certs= db.prepare(`SELECT tipo, data_validade FROM certidoes WHERE data_validade <= date('now','+30 days') AND data_validade >= date('now') LIMIT 5`).all().catch?.() ?? [];

    const fmt = v => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

    let ctx = `Empresa: ${company.nome} (CNPJ: ${company.cnpj})\n`;
    ctx += `Mês atual: ${mes}/${ano}\n`;
    ctx += `Faturamento NFs no mês: ${fmt(fat.v)}\n`;
    ctx += `Despesas no mês: ${fmt(desp.v)}\n`;
    ctx += `Extratos pendentes de conciliação: ${pend.n}\n`;

    if (ctrs.length) {
      ctx += `\nContratos ativos:\n`;
      ctrs.forEach(c => { ctx += `  - ${c.numContrato}: ${c.contrato} — ${fmt(c.valor_mensal_bruto || 0)}/mês\n`; });
    }

    try {
      const certsRows = db.prepare(`SELECT tipo, data_validade FROM certidoes WHERE data_validade <= date('now','+30 days') AND data_validade >= date('now') LIMIT 5`).all();
      if (certsRows.length) {
        ctx += `\nCertidões vencendo em 30 dias:\n`;
        certsRows.forEach(c => { ctx += `  - ${c.tipo}: vence ${c.data_validade}\n`; });
      }
    } catch (_) {}

    return ctx;
  } catch (e) {
    return `Empresa: ${company.nome} (CNPJ: ${company.cnpj})\n[Erro ao carregar contexto: ${e.message}]`;
  }
}

// ─── GET /status ──────────────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  const configurado = !!process.env.ANTHROPIC_API_KEY;
  res.json({
    ok: true,
    configurado,
    modelo: configurado ? MODELO : null,
    mensagem: configurado
      ? `IA ativa (${MODELO})`
      : 'IA não configurada — adicione ANTHROPIC_API_KEY no arquivo .env',
  });
});

// ─── POST /chat ───────────────────────────────────────────────────────────────

router.post('/chat', async (req, res) => {
  const client = getClient();
  if (!client) {
    return res.json({
      ok: false,
      configurado: false,
      resposta: '⚙️ Assistente IA não está configurado ainda.\n\nPara ativar, o administrador precisa adicionar a chave `ANTHROPIC_API_KEY` no arquivo `.env` do servidor.',
    });
  }

  const { mensagem, historico = [] } = req.body;
  if (!mensagem?.trim()) return res.status(400).json({ error: 'mensagem obrigatória' });

  const db      = req.db;
  const company = req.company || COMPANIES[req.companyKey];

  // Monta messages para a API
  const messages = [
    ...historico.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: mensagem.trim() },
  ];

  // System prompt com contexto financeiro
  let systemPrompt = `Você é o assistente financeiro do Montana ERP, um sistema de gestão para empresas de terceirização de mão de obra em Palmas-TO. Responda sempre em português brasileiro de forma objetiva e prática.\n\n`;
  systemPrompt += `=== CONTEXTO ATUAL ===\n`;
  if (db && company) {
    systemPrompt += buildContexto(db, company);
  }
  systemPrompt += `\n=====================\n`;
  systemPrompt += `Use os dados acima para responder perguntas sobre finanças, contratos, fluxo de caixa e operações. Para perguntas fora do escopo do sistema, responda brevemente e redirecione para o que pode ajudar.`;

  try {
    const response = await client.messages.create({
      model:      MODELO,
      max_tokens: 1024,
      system:     systemPrompt,
      messages,
    });

    const resposta = response.content[0]?.text || '(sem resposta)';
    res.json({ ok: true, resposta, tokens: response.usage });
  } catch (e) {
    console.error('[IA] Erro Claude API:', e.message);
    res.status(502).json({ ok: false, erro: e.message });
  }
});

module.exports = router;
