/**
 * Importação NFS-e Montana Assessoria — direto do portal WebISS via JSON
 * Faz login HTTP, pagina /issqn/nfse/listar/json e insere no banco.
 * Uso: node scripts/import_webiss_portal_assessoria.js [--dry-run]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const https = require('https');
const qs    = require('querystring');
const { getDb } = require('../src/db');

const LOGIN   = process.env.WEBISS_LOGIN_ASSESSORIA    || '023.498.351-54';
const SENHA   = process.env.WEBISS_SENHA_ASSESSORIA    || 'sr33q';
const DRY_RUN = process.argv.includes('--dry-run');
const PG_SIZE = 1000;  // máximo por página (miDataTable relatorio mode)
const DELAY   = 2500;  // ms entre páginas

// ── HTTP helpers ──────────────────────────────────────────────────────────────

let cookies = {};

function parseCookies(h) {
  const out = {};
  for (const c of (h['set-cookie'] || [])) {
    const [kv] = c.split(';');
    const [k, v] = kv.trim().split('=');
    out[k.trim()] = v?.trim() || '';
  }
  return out;
}

function cookieHdr() {
  return Object.entries(cookies).map(([k,v]) => `${k}=${v}`).join('; ');
}

function httpPost(urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = qs.stringify(body);
    const opts = {
      hostname: 'palmasto.webiss.com.br',
      path: urlPath, method: 'POST',
      headers: {
        'User-Agent':        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120',
        'Cookie':            cookieHdr(),
        'Accept':            'application/json, text/javascript, */*',
        'X-Requested-With':  'XMLHttpRequest',
        'Referer':           'https://palmasto.webiss.com.br/issqn/nfse/notas-fiscais',
        'Content-Type':      'application/x-www-form-urlencoded',
        'Content-Length':    Buffer.byteLength(data),
      },
    };
    const req = https.request(opts, res => {
      Object.assign(cookies, parseCookies(res.headers));
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(text), raw: text }); }
        catch (_) { resolve({ status: res.statusCode, headers: res.headers, data: null, raw: text }); }
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
    const opts = {
      hostname: 'palmasto.webiss.com.br',
      path: urlPath, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookieHdr() },
    };
    const req = https.request(opts, res => {
      Object.assign(cookies, parseCookies(res.headers));
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Mapeamento de colunas WebISS JSON → DB ────────────────────────────────────
// Colunas JSON (23):
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
  // "20/12/2024" → "2024-12-20" or "-" → ""
  if (!val || val === '-') return '';
  const parts = val.split('/');
  if (parts.length !== 3) return '';
  const [d, m, y] = parts;
  return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

function formatCompetencia(val) {
  // "8/2024" → "ago/24"
  if (!val || val === '-') return '';
  const meses = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  const [m, y] = String(val).split('/');
  const idx = parseInt(m, 10) - 1;
  if (idx < 0 || idx > 11 || !y) return val;
  return `${meses[idx]}/${y.slice(-2)}`;
}

function mapRow(row) {
  const situacao   = row[0];
  const cnpjTom    = row[1];
  const razaoSoc   = row[2];
  const numero     = row[4];
  const totalBruto = parseBR(row[10]);
  const issqn      = parseBR(row[12]);
  const retido     = row[13] === 'SIM';
  const retencao   = retido ? issqn : 0;
  const emissao    = parseDate(row[14]);
  const competencia= formatCompetencia(row[15]);
  const incidencia = row[17];
  const webissId   = row[22];

  return {
    numero,
    competencia,
    cidade:             incidencia || 'Palmas/TO',
    tomador:            razaoSoc || '',
    cnpj_tomador:       cnpjTom  || '',
    valor_bruto:        totalBruto,
    valor_liquido:      +(totalBruto - retencao).toFixed(2),
    iss:                issqn,
    retencao:           +retencao.toFixed(2),
    inss:               0,
    ir:                 0,
    csll:               0,
    pis:                0,
    cofins:             0,
    data_emissao:       emissao,
    status_conciliacao: situacao === 'Cancelada' ? 'CANCELADA' : 'PENDENTE',
    webiss_numero_nfse: webissId || null,
    discriminacao:      null,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Login
  console.log('🔐 Fazendo login no WebISS...');
  await httpGet('/');
  const loginResp = await httpPost('/autenticacao/autenticar', {
    Login: LOGIN, Senha: SENHA, IndicaAcessoComCertificado: 'false',
  });
  if (loginResp.status !== 302 && loginResp.status !== 200) {
    throw new Error(`Login falhou: HTTP ${loginResp.status}`);
  }
  await httpGet('/inicio');
  console.log(`✅ Sessão OK | Cookies: ${Object.keys(cookies).join(', ')}\n`);

  // 2. Busca primeira página para saber o total
  const first = await httpPost('/issqn/nfse/listar/json', {
    draw: 1, start: 0, length: 1,
  });
  if (!first.data || first.data.recordsTotal === undefined) {
    throw new Error('Resposta inesperada do WebISS: ' + first.raw.substring(0, 200));
  }
  const total = first.data.recordsTotal;
  const pages = Math.ceil(total / PG_SIZE);
  console.log(`📊 Total NFS-e no WebISS: ${total} | Páginas (${PG_SIZE}/pág): ${pages}\n`);

  // 3. Busca todas as páginas
  const allRows = [];
  for (let page = 0; page < pages; page++) {
    const start = page * PG_SIZE;
    process.stdout.write(`  📥 Página ${page+1}/${pages} (${start}–${Math.min(start+PG_SIZE-1, total-1)}): `);

    if (page > 0) await sleep(DELAY);

    const resp = await httpPost('/issqn/nfse/listar/json', {
      draw:   page + 1,
      start:  start,
      length: PG_SIZE,
    });

    if (!resp.data || !resp.data.data) {
      console.log(`❌ Erro: ${resp.raw.substring(0, 150)}`);
      continue;
    }

    allRows.push(...resp.data.data);
    console.log(`${resp.data.data.length} registros`);
  }

  console.log(`\n✅ Total baixado: ${allRows.length} registros`);

  // 4. Filtra somente NFs com número (não rascunhos com número "0")
  const comNumero = allRows.filter(r => r[4] && r[4] !== '0' && r[4] !== '-');
  const rascunhos = allRows.length - comNumero.length;
  console.log(`   Com número emitido: ${comNumero.length} | Rascunhos/sem número: ${rascunhos}\n`);

  // 5. Prepara banco
  const db = getDb('assessoria');
  for (const [col, type] of [['webiss_numero_nfse','TEXT'],['discriminacao','TEXT']]) {
    try { db.prepare(`ALTER TABLE notas_fiscais ADD COLUMN ${col} ${type}`).run(); } catch(_) {}
  }

  // IDs e números já existentes
  const existIds  = new Set(db.prepare('SELECT webiss_numero_nfse FROM notas_fiscais WHERE webiss_numero_nfse IS NOT NULL').all().map(r => r.webiss_numero_nfse));
  const existNums = new Set(db.prepare('SELECT numero FROM notas_fiscais').all().map(r => r.numero));

  // 6. Processa e deduplicar
  const inserir = [];
  const pulados = [];

  for (const row of comNumero) {
    const webissId = row[22];
    const numero   = row[4];
    if (existIds.has(webissId) || existNums.has(numero)) {
      pulados.push(numero);
      continue;
    }
    inserir.push(mapRow(row));
  }

  console.log(`📋 Resultado:`);
  console.log(`   Para importar: ${inserir.length}`);
  console.log(`   Pulados (duplic): ${pulados.length}`);

  // Por ano
  const porAno = {};
  for (const r of inserir) {
    const ano = r.data_emissao?.substring(0,4) || r.competencia?.split('/')[1] || 'sem data';
    porAno[ano] = (porAno[ano]||0) + 1;
  }
  console.log(`   Por ano:`, porAno);
  const totalBruto = inserir.reduce((s,r) => s + r.valor_bruto, 0);
  console.log(`   Total bruto: R$ ${totalBruto.toLocaleString('pt-BR', {minimumFractionDigits:2})}`);

  if (DRY_RUN) {
    console.log('\n⚠️  DRY RUN — nenhuma alteração feita.');
    return;
  }

  // 7. Insere em transação
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
      catch(e) { err++; console.error(`  ❌ ${row.numero}:`, e.message); }
    }
    return { ok, err };
  })(inserir);

  const totalFinal = db.prepare('SELECT COUNT(*) n FROM notas_fiscais').get();
  const byYearFinal = db.prepare("SELECT strftime('%Y',data_emissao) ano, COUNT(*) n FROM notas_fiscais GROUP BY 1 ORDER BY 1").all();

  console.log('\n══════════════════════════════════════════');
  console.log('✅ IMPORTAÇÃO CONCLUÍDA — Montana Assessoria');
  console.log('══════════════════════════════════════════');
  console.log(`  Inseridas: ${ok} | Erros: ${err}`);
  console.log(`  Total no banco: ${totalFinal.n}`);
  console.log('\n  Por ano no banco:');
  for (const r of byYearFinal) {
    console.log(`    ${r.ano || 'sem data'}: ${r.n} NFs`);
  }
}

main().catch(e => { console.error('\n❌ ERRO FATAL:', e.message, e.stack); process.exit(1); });
