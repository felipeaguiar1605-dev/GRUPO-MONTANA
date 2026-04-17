'use strict';
/**
 * Importador Portal Transparência Prefeitura de Palmas (Prodata SIG) — Sprint 4.
 *
 * Arquitetura (conforme relatório técnico 2026-04-16):
 *   AngularJS SPA → Spring REST em /sig/rest/
 *   Entrypoint: https://prodata.palmas.to.gov.br/sig/app.html
 *   Endpoints:
 *     sigController/getDadosIniciaisDoModulo?modulo=servicosonline
 *     loginController/validarLoginParaModuloPublico
 *     notaPagamentoController/getGestoesComDadosAMostrar
 *     notaPagamentoController/getFontesComDadosAMostrar
 *     notaPagamentoController/(endpoint de pesquisa)     ← confirmação via DevTools pendente
 *
 * ⚠️  Este importador **ainda está em modo de descoberta**: o payload exato do endpoint
 *     de pesquisa e o token de sessão (ProdataHttpInterceptor) precisam ser capturados
 *     via DevTools (F12 → Network) executando uma pesquisa real na SPA.
 *
 * Uso:
 *   node scripts/importar_transparencia_palmas.js --discovery       # testa endpoints conhecidos
 *   node scripts/importar_transparencia_palmas.js --bootstrap       # busca token pela SPA
 *   node scripts/importar_transparencia_palmas.js --cnpj=... --apply (futuro)
 */
const path = require('path');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ARG = process.argv.slice(2);
const DISC = ARG.includes('--discovery');
const BOOT = ARG.includes('--bootstrap');

const BASE_HOST = 'prodata.palmas.to.gov.br';
const BASE_PATH = '/sig/rest';
const UA = 'MontanaERP/1.0 (+conciliacao_robusta; montana-unificado)';

function httpReq({ method = 'GET', path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: BASE_HOST, port: 443, path, method,
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', ...headers },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function discovery() {
  console.log('🔬 Modo DISCOVERY — testando endpoints públicos conhecidos\n');
  const endpoints = [
    { name: 'getDadosObrigatorios',            path: '/sigController/getDadosObrigatorios',              method: 'POST', body: '{}' },
    { name: 'getDadosIniciaisDoModulo',        path: '/sigController/getDadosIniciaisDoModulo?modulo=servicosonline', method: 'POST', body: '{}' },
    { name: 'validarLoginParaModuloPublico',   path: '/loginController/validarLoginParaModuloPublico',   method: 'POST', body: '{}' },
    { name: 'isModuloHabilitado',              path: '/loginController/isModuloHabilitado?modulo=TRANSPARENCIA', method: 'POST', body: '{}' },
    { name: 'notaPgto.carregarAtributos',      path: '/notaPagamentoController/carregarAtributos',       method: 'POST', body: '{}' },
    { name: 'notaPgto.getGestoes',             path: '/notaPagamentoController/getGestoesComDadosAMostrar', method: 'POST', body: '{}' },
    { name: 'notaPgto.getFontes',              path: '/notaPagamentoController/getFontesComDadosAMostrar', method: 'POST', body: '{}' },
  ];

  for (const e of endpoints) {
    try {
      const r = await httpReq({
        method: e.method,
        path: BASE_PATH + e.path,
        headers: { 'Content-Type': 'application/json' },
        body: e.body,
      });
      const preview = r.body.substring(0, 120).replace(/\s+/g, ' ');
      console.log(`  ${r.status}  ${e.name.padEnd(30)}  ${preview}...`);
    } catch (err) {
      console.log(`  ERR  ${e.name.padEnd(30)}  ${err.message}`);
    }
  }
}

async function bootstrap() {
  console.log('🔑 Modo BOOTSTRAP — tentando obter token ProdataHttpInterceptor\n');
  // 1) Carrega index (pode setar cookies de sessão)
  const idx = await httpReq({ path: '/sig/app.html', method: 'GET' });
  console.log(`  GET /sig/app.html → ${idx.status}`);
  const cookies = (idx.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  console.log(`  Cookies recebidos: ${cookies || '(nenhum)'}`);

  // 2) Tenta chamada autenticada com o cookie
  const r = await httpReq({
    method: 'POST',
    path: BASE_PATH + '/notaPagamentoController/getGestoesComDadosAMostrar',
    headers: { 'Content-Type': 'application/json', Cookie: cookies },
    body: '{}',
  });
  console.log(`  POST getGestoes → ${r.status}`);
  console.log(`  Body (primeiros 300 chars): ${r.body.substring(0, 300)}`);

  if (r.status === 200) {
    console.log('\n✅ Funcionou com cookie puro — não precisa de interceptor token.');
  } else if (r.status === 401) {
    console.log('\n⚠️  Retornou 401. Precisamos do header que o ProdataHttpInterceptor injeta.');
    console.log('    Capture via DevTools: abra a SPA, F12 → Network, clique em "Pesquisar"');
    console.log('    e copie os headers da request getlistaDeLiquidacoes (em especial');
    console.log('    "X-ProdataToken" ou similar — nome exato varia por release).');
    console.log('    Cole o valor em .env como PALMAS_TOKEN=... e re-rode --bootstrap.');
  }
}

async function main() {
  if (DISC) return discovery();
  if (BOOT) return bootstrap();
  console.log(`
Uso:
  --discovery   Testa endpoints REST conhecidos (sem cookie)
  --bootstrap   Tenta obter cookie/token via carregamento da SPA

Próximos passos (manual):
  1. Abra https://prodata.palmas.to.gov.br/sig/app.html no Chrome
  2. Navegue até Transparência → Pagamentos por Ordem Cronológica
  3. DevTools (F12) → Network → filtrar XHR
  4. Clique "Pesquisar" preenchendo CNPJ Montana (14092519000151)
  5. Copie request headers + request body da chamada principal
  6. Cole o conteúdo num arquivo 'scripts/_palmas_sample.json' para referência

Depois implementaremos a função principal de pesquisa usando esses valores.
`);
}

main().catch(e => { console.error('❌', e); process.exit(1); });
