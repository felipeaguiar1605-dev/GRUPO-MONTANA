'use strict';
/**
 * Probe para descobrir o endpoint do Prodata que retorna os DOCUMENTOS FISCAIS
 * vinculados a um pagamento (o popup "Nota fiscal" com Nº Documento + Dt.Emissão
 * + Valor NF que aparece ao clicar o ícone numa linha do Portal Transparência).
 *
 * Testa uma série de candidatos com os parâmetros já conhecidos (ficha/contador/
 * nr_pre_empenho/nr_cadnp/nr_cadnl/codigo_fonte) e imprime status/body resumido
 * para identificar qual retorna os campos de NF.
 */
const path = require('path');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const ARG = process.argv.slice(2);
const arg = (k, def = '') => (ARG.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || def;
const empresa = arg('empresa', 'seguranca');
const method  = (arg('method', 'POST') || 'POST').toUpperCase();

const db = getDb(empresa);
const tok = (process.env.PRODATA_AUTH_TOKEN ||
  db.prepare("SELECT valor FROM configuracoes WHERE chave='prodata_auth_token'").get()?.valor || '');
if (!tok) { console.error('sem token'); process.exit(1); }

// Pega 1 pagamento conhecido (ex.: R$ 31.006,19 — o que o user mostrou no print)
const amostra = db.prepare(`
  SELECT raw_json FROM pagamentos_portal
  WHERE portal='palmas' AND valor_pago BETWEEN 31006 AND 31007
  ORDER BY data_pagamento_iso DESC
  LIMIT 1
`).get() || db.prepare(`
  SELECT raw_json FROM pagamentos_portal
  WHERE portal='palmas'
  ORDER BY data_pagamento_iso DESC LIMIT 1
`).get();

if (!amostra) { console.error('sem amostra de pagamento'); process.exit(1); }
const reg = JSON.parse(amostra.raw_json);
console.log('Amostra:', JSON.stringify({
  ficha: reg.ficha, contador: reg.contador, nr_pre_empenho: reg.nr_pre_empenho,
  nr_cadnp: reg.nr_cadnp, nr_cadnl: reg.nr_cadnl, codigo_fonte: reg.codigo_fonte,
  valor: reg.valor_pago, data: reg.data, fornecedor: reg.rz_social
}, null, 2));
console.log('');

const qs = new URLSearchParams({
  ficha: reg.ficha,
  contador: reg.contador,
  nr_pre_empenho: reg.nr_pre_empenho,
  nr_cadnp: reg.nr_cadnp,
  nr_cadnl: reg.nr_cadnl,
  codigo_fonte: reg.codigo_fonte,
}).toString();

// Candidatos — controller + método. Tentamos ambos GET e POST (sem body).
const candidatos = [
  '/sig/rest/notaPagamentoController/getDocumentosPagamento',
  '/sig/rest/notaPagamentoController/getDocumentos',
  '/sig/rest/notaPagamentoController/getDocumentosFiscaisPagamento',
  '/sig/rest/notaPagamentoController/getNotasFiscaisPagamento',
  '/sig/rest/notaPagamentoController/getNotaFiscalPagamento',
  '/sig/rest/notaPagamentoController/getDocumentoFiscalPagamento',
  '/sig/rest/notaPagamentoController/getDocumentosFiscais',
  '/sig/rest/notaPagamentoController/getNfsePagamento',
  '/sig/rest/notaPagamentoController/getDocumentosFiscaisPortalTransparencia',
  '/sig/rest/notaPagamentoController/getDocsFiscaisPagamento',
  '/sig/rest/notaFiscalController/getDocumentosPagamento',
  '/sig/rest/notaFiscalController/getNotasFiscaisPagamento',
  '/sig/rest/notaFiscalController/getPorPagamento',
  '/sig/rest/documentoFiscalController/getPorPagamento',
  '/sig/rest/documentoFiscalController/getByPagamento',
  '/sig/rest/documentoFiscalController/getDocumentos',
];

function req(p, m) {
  return new Promise(resolve => {
    const pathReq = p + '?' + qs;
    const r = https.request({
      hostname: 'prodata.palmas.to.gov.br', port: 443, path: pathReq, method: m,
      headers: {
        'Accept':        'application/json, text/plain, */*',
        'Content-Type':  'application/json;charset=utf-8',
        'Content-Length': 0,
        'x-auth-token':   tok,
        'x-client-id':    'sig-frontend',
        'x-id':           'sig',
        'x-modulo':       'TRANSPARENCIA',
        'x-origin':       'https://prodata.palmas.to.gov.br',
        'x-url':          'https://prodata.palmas.to.gov.br/sig/app.html#/transparencia/transparencia-pagamentos-ordem-cronologica/',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', e => resolve({ status: 'ERR', body: e.message }));
    r.end();
  });
}

(async () => {
  for (const c of candidatos) {
    for (const m of ['POST', 'GET']) {
      const r = await req(c, m);
      const snip = r.body.substring(0, 200).replace(/\s+/g,' ');
      const interessante = r.status === 200 && /docum|nfse|nfs-e|emissa|serie|chave|valor|numero/i.test(snip);
      const marker = interessante ? '🎯 ' : (r.status === 200 ? '✓ ' : '  ');
      console.log(`${marker}[${m} ${r.status}] ${c}`);
      if (r.status === 200 && snip.length > 2) console.log(`     ${snip}`);
    }
  }
})();
