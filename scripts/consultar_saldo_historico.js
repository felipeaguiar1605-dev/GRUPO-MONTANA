'use strict';
/**
 * Calcula saldo bancário em datas históricas para Montana Assessoria.
 *
 * Método: saldo atual (via BB API) − lançamentos após a data alvo = saldo na data alvo.
 *
 * Uso:
 *   node scripts/consultar_saldo_historico.js
 *   node scripts/consultar_saldo_historico.js --conta=1090437 --empresa=assessoria
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { getDb } = require('../src/db');

const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k,v] = a.slice(2).split('='); return [k, v||true]; })
);
const EMPRESA = args.empresa || 'assessoria';
const CONTA_FILTER = args.conta || null; // filtra conta específica se informado

// Datas de interesse
const DATAS_ALVO = [
  '2024-01-01',
  '2024-12-31',
  '2025-01-01',
  '2025-12-31',
];

// ── Helpers ─────────────────────────────────────────────────────────────────
function getCfg(db, chave) {
  try {
    const row = db.prepare(`SELECT valor FROM configuracoes WHERE chave=? LIMIT 1`).get(chave);
    return row ? row.valor : null;
  } catch { return null; }
}

function getBBContas(db) {
  const agencia = getCfg(db, 'bb_agencia');
  const conta   = getCfg(db, 'bb_conta');
  const contas  = [];
  if (agencia && conta) contas.push({ agencia, conta, descricao: 'Conta principal' });
  try {
    const extra = JSON.parse(getCfg(db, 'bb_contas_extra') || '[]');
    contas.push(...extra);
  } catch (_) {}
  return contas;
}

function httpsReq(urlStr, { method = 'GET', headers = {}, body = null, cert, key } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search, method, headers,
      ...(cert && key ? { cert, key } : {}),
      rejectUnauthorized: true,
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(data), text: () => data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getBBToken(cfg) {
  const base  = cfg.ambiente === 'producao' ? 'https://oauth.bb.com.br' : 'https://oauth.sandbox.bb.com.br';
  const basic = Buffer.from(`${cfg.client_id}:${cfg.client_secret}`).toString('base64');
  const tlsOpts = {};
  if (cfg.ambiente === 'producao' && cfg.cert_path && cfg.key_path &&
      fs.existsSync(cfg.cert_path) && fs.existsSync(cfg.key_path)) {
    tlsOpts.cert = fs.readFileSync(cfg.cert_path);
    tlsOpts.key  = fs.readFileSync(cfg.key_path);
  }
  const body = `grant_type=client_credentials&scope=extrato-info`;
  const resp = await httpsReq(`${base}/oauth/token`, {
    method: 'POST',
    headers: {
      'Authorization':  `Basic ${basic}`,
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
    body, ...tlsOpts,
  });
  const data = resp.json();
  if (!data.access_token) throw new Error(`OAuth falhou: ${JSON.stringify(data)}`);
  return data.access_token;
}

// Busca o saldo no início de um dia consultando o "SALDO ANTERIOR" que o BB
// retorna como primeiro lançamento de qualquer período.
// Para saldo ao FINAL do dia D → consultar o dia D+1 e pegar o SALDO ANTERIOR.
async function getSaldoDia(cfg, token, agencia, conta, dataIso) {
  const base = cfg.ambiente === 'producao'
    ? 'https://api-extratos.bb.com.br'
    : 'https://api.sandbox.bb.com.br';

  function toDateBB(iso) {
    const [y, m, d] = iso.split('-');
    return `${parseInt(d)}${m}${y}`;
  }

  const params = new URLSearchParams({
    'gw-dev-app-key':              cfg.app_key,
    dataInicioSolicitacao:         toDateBB(dataIso),
    dataFimSolicitacao:            toDateBB(dataIso),
    numeroPaginaSolicitacao:       '1',
    quantidadeRegistroPaginaSolicitacao: '50',
  });

  const url = `${base}/extratos/v1/conta-corrente/agencia/${agencia}/conta/${conta}?${params}`;
  const tlsOpts = {};
  if (cfg.ambiente === 'producao' && cfg.cert_path && cfg.key_path &&
      fs.existsSync(cfg.cert_path) && fs.existsSync(cfg.key_path)) {
    tlsOpts.cert = fs.readFileSync(cfg.cert_path);
    tlsOpts.key  = fs.readFileSync(cfg.key_path);
  }
  const resp = await httpsReq(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    ...tlsOpts,
  });

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`BB API ${resp.status}: ${resp.text().substring(0, 200)}`);
  }

  const data = resp.json();
  const lista = data.listaLancamento || [];

  // O BB insere "SALDO ANTERIOR" como primeiro item — é o saldo no início do dia
  const saldoEntry = lista.find(l =>
    (l.textoDescricaoHistorico || '').toUpperCase().includes('SALDO ANTERIOR')
  );

  if (!saldoEntry) return null; // API não retornou saldo (período sem dados)

  const valor = parseFloat(saldoEntry.valorLancamento || 0);
  const sinal = (saldoEntry.indicadorSinalLancamento || 'C').toUpperCase();
  return sinal === 'D' ? -Math.abs(valor) : Math.abs(valor);
}

// Saldo no FINAL do dia D = SALDO ANTERIOR do dia D+1
async function getSaldoFinalDia(cfg, token, agencia, conta, dataIso) {
  const d = new Date(dataIso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  const proximo = d.toISOString().substring(0, 10);
  return getSaldoDia(cfg, token, agencia, conta, proximo);
}

// placeholder — lógica movida para o main (consulta direta à API por data)


// ── Formata valor em BRL ──────────────────────────────────────────────────────
function brl(v) {
  return (v < 0 ? '−' : '') + 'R$ ' + Math.abs(v).toLocaleString('pt-BR', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const db = getDb(EMPRESA);

  const cfg = {
    client_id:     getCfg(db, 'bb_client_id'),
    client_secret: getCfg(db, 'bb_client_secret'),
    app_key:       getCfg(db, 'bb_app_key'),
    ambiente:      getCfg(db, 'bb_ambiente') || 'producao',
    cert_path:     getCfg(db, 'bb_cert_path'),
    key_path:      getCfg(db, 'bb_key_path'),
  };

  if (!cfg.client_id || !cfg.client_secret || !cfg.app_key) {
    console.error('  ❌ Credenciais BB não configuradas para', EMPRESA);
    process.exit(1);
  }

  const contas = getBBContas(db).filter(c => !CONTA_FILTER || c.conta === CONTA_FILTER);
  if (!contas.length) { console.error('  ❌ Nenhuma conta configurada'); process.exit(1); }

  const hoje = new Date().toISOString().substring(0, 10);
  console.log(`\n  📊 Saldo Histórico — Montana ${EMPRESA.toUpperCase()}`);
  console.log(`  Data base: ${hoje}\n`);

  let token;
  try {
    token = await getBBToken(cfg);
    console.log('  ✅ Token BB obtido\n');
  } catch (e) {
    console.error('  ❌ Erro OAuth:', e.message);
    process.exit(1);
  }

  // Definição das consultas: label, data de consulta à API, interpretação
  // Para saldo no INÍCIO de 01/01/XXXX → SALDO ANTERIOR do dia 01/01 = saldo em 31/12 anterior
  // Para saldo no FINAL de 31/12/XXXX  → SALDO ANTERIOR do dia 01/01 do ano seguinte
  const CONSULTAS = [
    { label: 'Saldo em 01/01/2024 (abertura)',  consultarDia: '2024-01-01', tipo: 'inicio' },
    { label: 'Saldo em 31/12/2024 (fechamento)', consultarDia: '2025-01-01', tipo: 'saldo_anterior' },
    { label: 'Saldo em 01/01/2025 (abertura)',  consultarDia: '2025-01-01', tipo: 'inicio' },
    { label: 'Saldo em 31/12/2025 (fechamento)', consultarDia: '2026-01-01', tipo: 'saldo_anterior' },
    { label: `Saldo atual (${hoje})`,            consultarDia: hoje,         tipo: 'inicio' },
  ];

  // Cria tabela de saldos se não existir
  db.exec(`CREATE TABLE IF NOT EXISTS saldos_bancarios (
    conta TEXT, data_iso TEXT, saldo REAL, origem TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (conta, data_iso)
  )`);
  const insSaldo = db.prepare(`INSERT OR REPLACE INTO saldos_bancarios(conta, data_iso, saldo, origem) VALUES(?,?,?,?)`);

  for (const c of contas) {
    console.log(`  ─── Conta ${c.conta} — ${c.descricao} ───`);
    console.log(`  ${'Referência'.padEnd(38)} ${'Saldo (R$)'.padStart(20)}`);
    console.log(`  ${'─'.repeat(60)}`);

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    for (const q of CONSULTAS) {
      try {
        const saldo = await getSaldoDia(cfg, token, c.agencia, c.conta, q.consultarDia);
        if (saldo === null) {
          console.log(`  ${q.label.padEnd(38)} ${'(sem dados)'.padStart(20)}`);
        } else {
          console.log(`  ${q.label.padEnd(38)} ${brl(saldo).padStart(20)}`);
          // Salva a data de referência real (não a data consultada)
          const dataRef = q.tipo === 'saldo_anterior'
            ? q.consultarDia.replace(/^(\d{4})-01-01$/, (_, y) => `${parseInt(y)-1}-12-31`)
            : q.consultarDia;
          insSaldo.run(c.conta, dataRef, saldo, 'api');
        }
      } catch (e) {
        console.log(`  ${q.label.padEnd(38)} ${'ERRO: '+e.message.substring(0,30)}`);
      }
      await sleep(1200); // pausa entre chamadas (rate limit BB)
    }
    console.log('');
  }

  console.log('  ✔️  Concluído.\n');
})();
