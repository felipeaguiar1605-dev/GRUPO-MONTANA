/**
 * Importação incremental NFS-e via portal WebISS (todas as empresas)
 *
 * Uso:
 *   node scripts/import_webiss.js                     # importa todas as empresas configuradas
 *   node scripts/import_webiss.js --empresa=assessoria # apenas assessoria
 *   node scripts/import_webiss.js --empresa=seguranca  # apenas segurança
 *   node scripts/import_webiss.js --dry-run            # mostra sem inserir
 *   node scripts/import_webiss.js --completo           # ignora data e importa tudo
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const https = require('https');
const qs    = require('querystring');
const { getDb, COMPANIES } = require('../src/db');

// ── Args ─────────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const DRY_RUN   = args.includes('--dry-run');
const COMPLETO  = args.includes('--completo');
const EMPRESA   = args.find(a => a.startsWith('--empresa='))?.split('=')[1] || null;
const PG_SIZE   = 1000;
const DELAY     = 2500;

// ── Empresas com credenciais configuradas ────────────────────────────────────
function getEmpresasConfiguradas() {
  const empresas = [];
  for (const key of Object.keys(COMPANIES)) {
    const login = process.env[`WEBISS_LOGIN_${key.toUpperCase()}`];
    const senha = process.env[`WEBISS_SENHA_${key.toUpperCase()}`];
    if (login && senha) {
      empresas.push({
        key,
        nome: COMPANIES[key].nomeAbrev || COMPANIES[key].nome,
        login,
        senha,
      });
    }
  }
  return empresas;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function createSession() {
  let cookies = {};

  function parseCookies(h) {
    for (const c of (h['set-cookie'] || [])) {
      const [kv] = c.split(';');
      const [k, v] = kv.trim().split('=');
      cookies[k.trim()] = v?.trim() || '';
    }
  }

  function cookieHdr() {
    return Object.entries(cookies).map(([k,v]) => `${k}=${v}`).join('; ');
  }

  function httpPost(urlPath, body) {
    return new Promise((resolve, reject) => {
      const data = qs.stringify(body);
      const req = https.request({
        hostname: 'palmasto.webiss.com.br',
        path: urlPath, method: 'POST',
        headers: {
          'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
          'Cookie':           cookieHdr(),
          'Accept':           'application/json, text/javascript, */*',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer':          'https://palmasto.webiss.com.br/issqn/nfse/notas-fiscais',
          'Content-Type':     'application/x-www-form-urlencoded',
          'Content-Length':   Buffer.byteLength(data),
        },
      }, res => {
        parseCookies(res.headers);
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          try   { resolve({ status: res.statusCode, data: JSON.parse(text), raw: text }); }
          catch { resolve({ status: res.statusCode, data: null, raw: text }); }
        });
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(data);
      req.end();
    });
  }

  function httpGet(urlPath) {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'palmasto.webiss.com.br',
        path: urlPath, method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookieHdr() },
      }, res => {
        parseCookies(res.headers);
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
  }

  return { httpGet, httpPost, resetCookies: () => { cookies = {}; } };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Parsing ──────────────────────────────────────────────────────────────────
// Colunas JSON WebISS:
// 0=Situacao  1=CNPJ_Tomador  2=Razao_Social  3=Emissor  4=Numero
// 5=RPS       6=Num_RPS       7=Servico_R$    8=Desc_R$  9=BC_R$
// 10=Total_R$ 11=Aliquota_%   12=ISSQN_R$     13=Retido  14=Emissao
// 15=Competencia  16=Exigibilidade  17=Incidencia  18=Atividade
// 19=Tipo     20=Debito       21=CNAE         22=ID_WebISS

function parseBR(val) {
  if (!val || val === '-' || val === '0') return 0;
  return parseFloat(String(val).replace(/\./g, '').replace(',', '.')) || 0;
}

function parseDate(val) {
  if (!val || val === '-') return '';
  const parts = val.split('/');
  if (parts.length !== 3) return '';
  const [d, m, y] = parts;
  return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

function formatCompetencia(val) {
  if (!val || val === '-') return '';
  const meses = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  const [m, y] = String(val).split('/');
  const idx = parseInt(m, 10) - 1;
  if (idx < 0 || idx > 11 || !y) return val;
  return `${meses[idx]}/${y.slice(-2)}`;
}

function mapRow(row) {
  const totalBruto = parseBR(row[10]);
  const issqn      = parseBR(row[12]);
  const retido     = row[13] === 'SIM';
  const retencao   = retido ? issqn : 0;

  return {
    numero:             row[4],
    competencia:        formatCompetencia(row[15]),
    cidade:             row[17] || 'Palmas/TO',
    tomador:            row[2] || '',
    cnpj_tomador:       row[1] || '',
    valor_bruto:        totalBruto,
    valor_liquido:      +(totalBruto - retencao).toFixed(2),
    iss:                issqn,
    retencao:           +retencao.toFixed(2),
    inss: 0, ir: 0, csll: 0, pis: 0, cofins: 0,
    data_emissao:       parseDate(row[14]),
    status_conciliacao: row[0] === 'Cancelada' ? 'CANCELADA' : 'PENDENTE',
    webiss_numero_nfse: row[22] || null,
    discriminacao:      null,
  };
}

// ── Importação de uma empresa ────────────────────────────────────────────────
async function importarEmpresa(empresa, session) {
  const { key, nome, login, senha } = empresa;
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  ${nome} (${key})`);
  console.log(`${'═'.repeat(50)}`);

  // 1. Login
  console.log('  🔐 Fazendo login no WebISS...');
  session.resetCookies();
  await session.httpGet('/');
  const loginResp = await session.httpPost('/autenticacao/autenticar', {
    Login: login, Senha: senha, IndicaAcessoComCertificado: 'false',
  });
  if (loginResp.status !== 302 && loginResp.status !== 200) {
    console.log(`  ❌ Login falhou (HTTP ${loginResp.status}). Pulando.`);
    return null;
  }
  await session.httpGet('/inicio');
  console.log('  ✅ Login OK');

  // 2. Verificar última nota no banco
  const db = getDb(key);
  for (const [col, type] of [['webiss_numero_nfse','TEXT'],['discriminacao','TEXT']]) {
    try { db.prepare(`ALTER TABLE notas_fiscais ADD COLUMN ${col} ${type}`).run(); } catch(_) {}
  }

  const ultima = db.prepare('SELECT MAX(data_emissao) as dt FROM notas_fiscais').get();
  const totalAntes = db.prepare('SELECT COUNT(*) n FROM notas_fiscais').get().n;

  if (ultima.dt && !COMPLETO) {
    console.log(`  📅 Última nota no banco: ${ultima.dt} (${totalAntes} notas)`);
    console.log(`  → Importação incremental: buscando apenas notas novas`);
  } else {
    console.log(`  📅 Banco ${COMPLETO ? '(modo completo)' : 'vazio'}: importação total`);
  }

  // 3. Buscar total no WebISS
  const first = await session.httpPost('/issqn/nfse/listar/json', {
    draw: 1, start: 0, length: 1,
  });
  if (!first.data || first.data.recordsTotal === undefined) {
    console.log(`  ❌ Resposta inesperada: ${first.raw.substring(0, 200)}`);
    return null;
  }
  const total = first.data.recordsTotal;
  const pages = Math.ceil(total / PG_SIZE);
  console.log(`  📊 Total no WebISS: ${total} NFS-e | ${pages} página(s)`);

  // 4. Baixar todas as páginas
  const allRows = [];
  for (let page = 0; page < pages; page++) {
    const start = page * PG_SIZE;
    if (page > 0) await sleep(DELAY);
    process.stdout.write(`  📥 Página ${page+1}/${pages}: `);

    const resp = await session.httpPost('/issqn/nfse/listar/json', {
      draw: page + 1, start, length: PG_SIZE,
    });

    if (!resp.data?.data) {
      console.log(`❌ Erro`);
      continue;
    }
    allRows.push(...resp.data.data);
    console.log(`${resp.data.data.length} registros`);
  }

  // 5. Filtrar e deduplificar
  const comNumero = allRows.filter(r => r[4] && r[4] !== '0' && r[4] !== '-');
  const existNums = new Set(
    db.prepare('SELECT numero FROM notas_fiscais').all().map(r => r.numero)
  );
  const existIds = new Set(
    db.prepare('SELECT webiss_numero_nfse FROM notas_fiscais WHERE webiss_numero_nfse IS NOT NULL').all().map(r => r.webiss_numero_nfse)
  );

  const inserir = [];
  for (const row of comNumero) {
    const numero   = row[4];
    const webissId = row[22];
    if (existNums.has(numero) || existIds.has(webissId)) continue;
    inserir.push(mapRow(row));
  }

  const jaExiste = comNumero.length - inserir.length;
  console.log(`\n  📋 Resultado: ${comNumero.length} NFs no portal`);
  console.log(`     → ${jaExiste} já no banco (ignoradas)`);
  console.log(`     → ${inserir.length} novas para importar`);

  if (inserir.length === 0) {
    console.log('  ✅ Banco já está atualizado!');
    return { key, nome, novas: 0, total: totalAntes };
  }

  if (DRY_RUN) {
    const porAno = {};
    for (const r of inserir) {
      const ano = r.data_emissao?.substring(0,4) || '?';
      porAno[ano] = (porAno[ano]||0) + 1;
    }
    console.log(`     Por ano:`, porAno);
    console.log('  ⚠️  DRY RUN — nenhuma alteração feita.');
    return { key, nome, novas: inserir.length, total: totalAntes, dryRun: true };
  }

  // 6. Inserir
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO notas_fiscais
      (numero, competencia, cidade, tomador, cnpj_tomador,
       valor_bruto, valor_liquido, iss, retencao,
       inss, ir, csll, pis, cofins,
       data_emissao, status_conciliacao, webiss_numero_nfse, discriminacao)
    VALUES
      (@numero, @competencia, @cidade, @tomador, @cnpj_tomador,
       @valor_bruto, @valor_liquido, @iss, @retencao,
       @inss, @ir, @csll, @pis, @cofins,
       @data_emissao, @status_conciliacao, @webiss_numero_nfse, @discriminacao)
  `);

  const { ok, err } = db.transaction(rows => {
    let ok = 0, err = 0;
    for (const row of rows) {
      try { stmt.run(row); ok++; }
      catch(e) { err++; }
    }
    return { ok, err };
  })(inserir);

  const totalDepois = db.prepare('SELECT COUNT(*) n FROM notas_fiscais').get().n;
  console.log(`  ✅ Importadas: ${ok} novas${err ? ` | ${err} erros` : ''}`);
  console.log(`     Total no banco: ${totalAntes} → ${totalDepois}`);

  return { key, nome, novas: ok, erros: err, total: totalDepois };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  let empresas = getEmpresasConfiguradas();

  if (EMPRESA) {
    empresas = empresas.filter(e => e.key === EMPRESA);
    if (empresas.length === 0) {
      console.error(`❌ Empresa "${EMPRESA}" não encontrada ou sem credenciais WebISS.`);
      console.error(`   Configuradas: ${getEmpresasConfiguradas().map(e => e.key).join(', ') || 'nenhuma'}`);
      process.exit(1);
    }
  }

  if (empresas.length === 0) {
    console.error('❌ Nenhuma empresa com credenciais WebISS configuradas no .env');
    process.exit(1);
  }

  console.log(`\n🏢 Empresas: ${empresas.map(e => e.nome).join(', ')}`);
  if (DRY_RUN) console.log('⚠️  Modo DRY RUN — nenhuma alteração será feita');
  if (COMPLETO) console.log('📅 Modo COMPLETO — importa tudo independente do que já existe');

  const session = createSession();
  const resultados = [];

  for (const empresa of empresas) {
    try {
      const r = await importarEmpresa(empresa, session);
      if (r) resultados.push(r);
    } catch (e) {
      console.error(`  ❌ Erro [${empresa.key}]: ${e.message}`);
    }
  }

  // Resumo final
  console.log(`\n${'═'.repeat(50)}`);
  console.log('  RESUMO FINAL');
  console.log(`${'═'.repeat(50)}`);
  for (const r of resultados) {
    const status = r.dryRun ? '(dry run)' : r.novas === 0 ? '✅ atualizado' : `+${r.novas} novas`;
    console.log(`  ${r.nome}: ${status} | Total: ${r.total}`);
  }
}

main().catch(e => { console.error('\n❌ ERRO FATAL:', e.message); process.exit(1); });
