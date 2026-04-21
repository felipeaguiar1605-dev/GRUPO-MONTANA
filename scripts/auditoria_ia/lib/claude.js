'use strict';
/**
 * Montana — Auditoria IA: wrapper Anthropic SDK com prompt caching.
 *
 * Uso:
 *   const { invocar } = require('./claude');
 *   const res = await invocar({
 *     agente: 'contabil_fiscal',
 *     systemCacheado: 'regras imutaveis...',
 *     systemDinamico: 'data de hoje, empresa...',
 *     usuario: 'JSON dos dados do periodo...',
 *     maxTokens: 4000
 *   });
 *   res => { texto, input_tokens, output_tokens, cache_read, cache_write, custo_brl }
 *
 * Preços (abr/2026, USD→BRL estimado 5.20):
 *   Haiku 4.5: $1/MTok input, $5/MTok output, cache write 1.25x, cache read 0.1x
 *   Sonnet 4.6: $3/MTok input, $15/MTok output, cache write 1.25x, cache read 0.1x
 */
const MODELOS = {
  'claude-haiku-4-5':   { in: 1.00,  out: 5.00  },
  'claude-sonnet-4-6':  { in: 3.00,  out: 15.00 },
};
const USD_BRL = 5.20;

function custoBRL(modelo, inputTok, outputTok, cacheRead, cacheWrite) {
  const p = MODELOS[modelo] || MODELOS['claude-haiku-4-5'];
  const usdIn    = (inputTok / 1e6) * p.in;
  const usdOut   = (outputTok / 1e6) * p.out;
  const usdWrite = (cacheWrite / 1e6) * p.in * 1.25;
  const usdRead  = (cacheRead  / 1e6) * p.in * 0.10;
  return (usdIn + usdOut + usdWrite + usdRead) * USD_BRL;
}

async function invocar({
  agente,
  systemCacheado = '',
  systemDinamico = '',
  usuario,
  modelo = 'claude-haiku-4-5',
  maxTokens = 4000,
}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY ausente no ambiente.');
  }
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

  const system = [];
  if (systemCacheado) {
    system.push({ type: 'text', text: systemCacheado, cache_control: { type: 'ephemeral' } });
  }
  if (systemDinamico) {
    system.push({ type: 'text', text: systemDinamico });
  }

  const t0 = Date.now();
  const resp = await client.messages.create({
    model: modelo,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: usuario }],
  });
  const ms = Date.now() - t0;

  const u = resp.usage || {};
  const inputTok   = u.input_tokens       || 0;
  const outputTok  = u.output_tokens      || 0;
  const cacheRead  = u.cache_read_input_tokens   || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;

  const texto = (resp.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  return {
    agente,
    modelo,
    texto,
    ms,
    input_tokens:  inputTok,
    output_tokens: outputTok,
    cache_read:    cacheRead,
    cache_write:   cacheWrite,
    custo_brl:     custoBRL(modelo, inputTok, outputTok, cacheRead, cacheWrite),
  };
}

module.exports = { invocar, custoBRL, MODELOS };
