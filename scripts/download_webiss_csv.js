/**
 * Download NFS-e CSV da Montana Assessoria via WebISS portal
 * Faz login, navega até exportação e baixa CSVs por ano (2023-2026).
 * Uso: node scripts/download_webiss_csv.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const qs    = require('querystring');

const LOGIN    = process.env.WEBISS_LOGIN_ASSESSORIA    || '023.498.351-54';
const SENHA    = process.env.WEBISS_SENHA_ASSESSORIA    || 'sr33q';
const BASE_URL = 'https://palmasto.webiss.com.br';
const OUT_DIR  = path.join('C:/Users/Avell/Downloads/NFS-e_Montana_ERP_Import');

let sessionCookies = {};

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function parseCookies(headers) {
  const raw = headers['set-cookie'] || [];
  const out = {};
  for (const c of raw) {
    const [kv] = c.split(';');
    const [k, v] = kv.trim().split('=');
    out[k.trim()] = v?.trim() || '';
  }
  return out;
}

function cookieHeader() {
  return Object.entries(sessionCookies).map(([k,v]) => `${k}=${v}`).join('; ');
}

function request(method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const postData = body ? (typeof body === 'string' ? body : qs.stringify(body)) : null;
    const opts = {
      hostname: 'palmasto.webiss.com.br',
      path: urlPath,
      method,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Cookie':          cookieHeader(),
        ...(postData ? {
          'Content-Type':   'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
        } : {}),
        ...extraHeaders,
      },
    };
    const req = https.request(opts, res => {
      // Salva cookies
      const newCookies = parseCookies(res.headers);
      Object.assign(sessionCookies, newCookies);

      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // 1. GET página inicial (para pegar cookies de sessão)
  console.log('🔐 Iniciando login no WebISS...');
  const home = await request('GET', '/');
  console.log(`   Home status: ${home.status} | Cookies: ${Object.keys(sessionCookies).join(', ')}`);

  // 2. POST login
  const loginResp = await request('POST', '/autenticacao/autenticar', {
    Login:                        LOGIN,
    Senha:                        SENHA,
    IndicaAcessoComCertificado:   'false',
  }, { Referer: BASE_URL + '/' });

  console.log(`   Login status: ${loginResp.status} | Location: ${loginResp.headers.location || '(none)'}`);

  if (loginResp.status !== 302 && loginResp.status !== 200) {
    const snippet = loginResp.body.toString().substring(0, 300);
    console.error('❌ Login falhou. Resposta:', snippet);
    process.exit(1);
  }

  // Segue redirect se houver
  let redirectTo = loginResp.headers.location;
  if (redirectTo) {
    const redir = await request('GET', redirectTo);
    console.log(`   Redirect -> ${redirectTo} | status: ${redir.status}`);
    redirectTo = redir.headers.location || null;
    if (redirectTo) {
      await request('GET', redirectTo);
    }
  }

  console.log(`   ✅ Sessão estabelecida | Cookies: ${Object.keys(sessionCookies).join(', ')}\n`);

  // 3. Descobre página de exportação de NFS-e
  const nfsePage = await request('GET', '/nfse/prestado');
  console.log(`   /nfse/prestado: ${nfsePage.status}`);

  // Tenta outros caminhos se 404
  let nfseBody = nfsePage.body.toString();
  let nfsePath = '/nfse/prestado';

  if (nfsePage.status === 404) {
    for (const p of ['/nfse', '/prestador/nfse', '/nfse/emitidas', '/NfseConsulta', '/consulta']) {
      const r = await request('GET', p);
      console.log(`   ${p}: ${r.status}`);
      if (r.status === 200) { nfsePath = p; nfseBody = r.body.toString(); break; }
      await sleep(500);
    }
  }

  // Mostra links de exportação disponíveis
  const exportLinks = [...nfseBody.matchAll(/href="([^"]*(?:export|csv|excel|planilha|download)[^"]*)"/gi)].map(m => m[1]);
  console.log('\n📎 Links de exportação encontrados:', exportLinks);

  // Busca formulário de filtro
  const formAction = nfseBody.match(/<form[^>]+action="([^"]+)"/i)?.[1];
  console.log('📋 Form action:', formAction);

  // Mostra trecho da página para diagnóstico
  const bodyTrimmed = nfseBody.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  console.log('\n📄 Conteúdo (texto):', bodyTrimmed.substring(0, 500));
}

main().catch(e => { console.error('\n❌ ERRO:', e.message); process.exit(1); });
