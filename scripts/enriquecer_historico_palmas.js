'use strict';
/**
 * Enriquecer pagamentos_portal com "histórico do pagamento" do Prodata SIG.
 *
 * Endpoint secundário (descoberto 2026-04-21 testando getHistoricoPagamento):
 *   POST https://prodata.palmas.to.gov.br/sig/rest/notaPagamentoController/getHistoricoPagamento
 *   Query: ?ficha=X&contador=Y&nr_pre_empenho=Z&nr_cadnp=A&nr_cadnl=B&codigo_fonte=C
 *   Response: texto puro JSON — ex: "PAGAMENTO REFERENTE A DEZEMBRO/2025."
 *
 * Uso:
 *   node scripts/enriquecer_historico_palmas.js --empresa=seguranca
 *   node scripts/enriquecer_historico_palmas.js --empresa=seguranca --force  (re-busca mesmo se já tem)
 *   node scripts/enriquecer_historico_palmas.js --empresa=assessoria --limit=10  (teste)
 *
 * Cria coluna `historico` em pagamentos_portal se não existir.
 */
const path = require('path');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const ARG = process.argv.slice(2);
const arg = (k, def = '') => (ARG.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || def;
const empresa = arg('empresa', 'seguranca');
const FORCE   = ARG.includes('--force');
const LIMIT   = parseInt(arg('limit', '0')) || 0;
const SLEEP_MS = parseInt(arg('sleep', '150')) || 150; // gentil com o servidor

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getAuthToken(db) {
  if (process.env.PRODATA_AUTH_TOKEN) return process.env.PRODATA_AUTH_TOKEN;
  try {
    const r = db.prepare("SELECT valor FROM configuracoes WHERE chave='prodata_auth_token'").get();
    return r?.valor || '';
  } catch (_) { return ''; }
}

function postHistorico({ ficha, contador, nr_pre_empenho, nr_cadnp, nr_cadnl, codigo_fonte }, authToken) {
  return new Promise((resolve) => {
    const qs = new URLSearchParams({ ficha, contador, nr_pre_empenho, nr_cadnp, nr_cadnl, codigo_fonte }).toString();
    const pathReq = '/sig/rest/notaPagamentoController/getHistoricoPagamento?' + qs;
    const req = https.request({
      hostname: 'prodata.palmas.to.gov.br', port: 443, path: pathReq, method: 'POST',
      headers: {
        'Accept':        'application/json, text/plain, */*',
        'Content-Type':  'application/json;charset=utf-8',
        'Content-Length': 0,
        'x-auth-token':   authToken,
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
    req.on('error', e => resolve({ status: 'ERR', body: e.message }));
    req.end();
  });
}

async function main() {
  console.log(`\n📜 Enriquecer histórico Palmas — empresa=${empresa}${FORCE?' [FORCE]':''}${LIMIT?' limit='+LIMIT:''}`);
  const db = getDb(empresa);

  // Garante coluna `historico`
  const cols = db.prepare("PRAGMA table_info(pagamentos_portal)").all().map(c => c.name);
  if (!cols.includes('historico')) {
    console.log('  ➕ Criando coluna `historico`...');
    db.prepare("ALTER TABLE pagamentos_portal ADD COLUMN historico TEXT").run();
  }

  const authToken = getAuthToken(db);
  if (!authToken) {
    console.error('❌ Token ausente. Rode: node scripts/importar_transparencia_palmas.js --token=eyJ... --save-all');
    process.exit(1);
  }

  const whereForce = FORCE ? '' : "AND (historico IS NULL OR historico = '')";
  const sqlLimit   = LIMIT ? `LIMIT ${LIMIT}` : '';
  const rows = db.prepare(`
    SELECT id, raw_json FROM pagamentos_portal
    WHERE portal = 'palmas' ${whereForce}
    ORDER BY data_pagamento_iso DESC
    ${sqlLimit}
  `).all();

  console.log(`  ${rows.length} registro(s) a enriquecer.\n`);

  const upd = db.prepare("UPDATE pagamentos_portal SET historico = ? WHERE id = ?");
  let ok = 0, fail = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let reg;
    try { reg = JSON.parse(r.raw_json); } catch (_) { fail++; continue; }

    const params = {
      ficha:          reg.ficha,
      contador:       reg.contador,
      nr_pre_empenho: reg.nr_pre_empenho,
      nr_cadnp:       reg.nr_cadnp,
      nr_cadnl:       reg.nr_cadnl,
      codigo_fonte:   reg.codigo_fonte,
    };
    if (Object.values(params).some(v => v == null || v === '')) {
      fail++;
      continue;
    }

    const res = await postHistorico(params, authToken);
    if (res.status === 200) {
      // Body vem como string JSON: '"PAGAMENTO REFERENTE..."'
      let historico = res.body.trim();
      try { historico = JSON.parse(historico); } catch (_) {}
      historico = String(historico || '').trim();
      upd.run(historico, r.id);
      ok++;
      if ((i + 1) % 20 === 0 || i === rows.length - 1) {
        process.stdout.write(`\r  ${i+1}/${rows.length} · OK=${ok} · Falhas=${fail}`);
      }
    } else {
      fail++;
      if (fail <= 3) console.log(`\n  ⚠️  HTTP ${res.status} para id=${r.id}: ${res.body.substring(0,120)}`);
    }
    if (SLEEP_MS > 0) await sleep(SLEEP_MS);
  }

  console.log(`\n\n✔️  Concluído. OK=${ok} · Falhas=${fail}`);

  // Amostra do resultado
  const amostra = db.prepare(`
    SELECT fornecedor, data_pagamento_iso, valor_pago, gestao, historico
    FROM pagamentos_portal
    WHERE portal='palmas' AND historico IS NOT NULL AND historico <> ''
    ORDER BY data_pagamento_iso DESC LIMIT 5
  `).all();
  if (amostra.length) {
    console.log('\n  Amostra:');
    amostra.forEach(a => {
      console.log(`    ${a.data_pagamento_iso} · R$ ${Number(a.valor_pago).toLocaleString('pt-BR',{minimumFractionDigits:2})}`);
      console.log(`      ${(a.fornecedor||'').substring(0,50)}  [${(a.gestao||'').substring(0,40)}]`);
      console.log(`      → ${a.historico}`);
    });
  }
}

main().catch(e => { console.error('❌', e); process.exit(1); });
