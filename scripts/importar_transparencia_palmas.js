'use strict';
/**
 * Importador Portal Transparência Prefeitura de Palmas (Prodata SIG) — Sprint 4.
 *
 * Portal: https://prodata.palmas.to.gov.br/sig/app.html#/transparencia/transparencia-pagamentos-ordem-cronologica/
 *
 * Endpoint descoberto (captura via sniffer na extensão Claude — 2026-04-16):
 *   POST https://prodata.palmas.to.gov.br/sig/rest/notaPagamentoController/getPagamentosPortalTransparencia
 *
 *   Headers obrigatórios ("ProdataHttpInterceptor" — não é Bearer token, são headers de origem):
 *     x-id:     "sig"
 *     x-origin: "https://prodata.palmas.to.gov.br"
 *     x-url:    "https://prodata.palmas.to.gov.br/sig/app.html#/transparencia/transparencia-pagamentos-ordem-cronologica/"
 *     Content-Type: application/json;charset=utf-8
 *
 *   Body:
 *     { limiteRegistros: 1000, formatoArquivoRelatorio: "PDF",
 *       data_inicial: "2026-04-01T15:00:00.000Z",
 *       data_final:   "2026-04-16T15:00:00.000Z",
 *       tabela: {}, isConsultaText: false,
 *       nomeTelaAtualAutocomplete: null,
 *       propriedadeValor: "nr_cadnp", propriedadeDescricao: "nr_cadnp",
 *       moduloAtual: "TRANSPARENCIA", descricaoModuloAtual: "transparencia" }
 *
 *   Response: array de objetos com { contador, nr_cgc_cpf, rz_social, valor_pago,
 *                                    data (pagamento), data_emp, data_liq, gestao,
 *                                    elem_desp, fonte, nome_fonte, ficha, ... }
 *
 * Uso:
 *   node scripts/importar_transparencia_palmas.js --ini=2026-04-01 --fim=2026-04-16
 *   node scripts/importar_transparencia_palmas.js --ini=2026-04-01 --fim=2026-04-16 --cnpj=14092519 --apply
 *   node scripts/importar_transparencia_palmas.js --ano=2026 --mes=3   # conveniência: mês inteiro
 */
const path = require('path');
const https = require('https');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const ARG = process.argv.slice(2);
const APLICAR = ARG.includes('--apply');
const arg = (k, def = '') => (ARG.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || def;
const empresa = arg('empresa', 'assessoria');
const cnpjArg = (arg('cnpj') || '').replace(/\D/g, '');
let   iniArg  = arg('ini', '');
let   fimArg  = arg('fim', '');
const anoArg  = arg('ano', '');
const mesArg  = arg('mes', '');
const limite  = parseInt(arg('limite', '5000')) || 5000;

// Conveniência: --ano + --mes geram ini/fim
if (!iniArg && anoArg && mesArg) {
  const y = parseInt(anoArg), m = parseInt(mesArg);
  iniArg = `${y}-${String(m).padStart(2,'0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  fimArg = `${y}-${String(m).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
} else if (!iniArg && anoArg && !mesArg) {
  iniArg = `${anoArg}-01-01`;
  fimArg = `${anoArg}-12-31`;
}

if (!iniArg || !fimArg) {
  console.error('Uso: --ini=AAAA-MM-DD --fim=AAAA-MM-DD  (ou --ano=AAAA [--mes=M])');
  process.exit(1);
}

const HOST = 'prodata.palmas.to.gov.br';
const PATH = '/sig/rest/notaPagamentoController/getPagamentosPortalTransparencia';

function toIsoUtc(ymd) {
  // 2026-04-01 → "2026-04-01T15:00:00.000Z" (meio-dia Brasília, para evitar
  // cair em dia anterior por timezone). Tocantins = UTC-3.
  return `${ymd}T15:00:00.000Z`;
}

function postJson(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: HOST, port: 443, path: PATH, method: 'POST',
      headers: {
        'Accept':        'application/json, text/plain, */*',
        'Content-Type':  'application/json;charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        'x-id':      'sig',
        'x-origin':  'https://prodata.palmas.to.gov.br',
        'x-url':     'https://prodata.palmas.to.gov.br/sig/app.html#/transparencia/transparencia-pagamentos-ordem-cronologica/',
        'User-Agent': 'Mozilla/5.0 MontanaERP',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: txt });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function buscar({ ini, fim, limiteRegistros }) {
  const body = {
    limiteRegistros,
    formatoArquivoRelatorio: 'PDF',
    data_inicial: toIsoUtc(ini),
    data_final:   toIsoUtc(fim),
    tabela: {},
    isConsultaText: false,
    nomeTelaAtualAutocomplete: null,
    propriedadeValor: 'nr_cadnp',
    propriedadeDescricao: 'nr_cadnp',
    moduloAtual: 'TRANSPARENCIA',
    descricaoModuloAtual: 'transparencia',
  };
  const r = await postJson(body);
  if (r.status !== 200) return { status: r.status, rows: [], err: r.body.substring(0, 200) };
  try {
    const json = JSON.parse(r.body);
    const rows = Array.isArray(json) ? json : (json.results || json.data || []);
    return { status: 200, rows };
  } catch (e) {
    return { status: 200, rows: [], err: 'JSON inválido: ' + e.message };
  }
}

function normalizarCnpj(nr) {
  // API retorna número inteiro: 58050946000142 → "58050946000142"
  // Alguns vêm com 11 dígitos (CPF), padding com 0 à esquerda se <11
  const s = String(nr || '').replace(/\D/g, '');
  if (!s) return '';
  if (s.length === 13) return '0' + s;   // CNPJ truncado
  if (s.length === 10) return '0' + s;   // CPF truncado
  return s;
}

async function main() {
  console.log(`\n🏛️  Import Palmas (Prodata) — empresa=${empresa} ini=${iniArg} fim=${fimArg}${cnpjArg?' cnpj='+cnpjArg:''}`);
  console.log(`  Modo: ${APLICAR ? 'APLICAR' : 'DRY-RUN'}  limite=${limite}\n`);

  const db = getDb(empresa);

  process.stdout.write('  Consultando portal... ');
  const { status, rows, err } = await buscar({ ini: iniArg, fim: fimArg, limiteRegistros: limite });
  if (status !== 200) {
    console.log(`HTTP ${status}${err?' · '+err:''}`);
    return;
  }
  if (err) { console.log(`⚠️  ${err}`); return; }
  console.log(`${rows.length} registros recebidos.`);

  // Filtro por CNPJ
  const filtrados = cnpjArg
    ? rows.filter(r => normalizarCnpj(r.nr_cgc_cpf).substring(0, cnpjArg.length) === cnpjArg)
    : rows;
  if (cnpjArg) console.log(`  Filtro CNPJ raiz=${cnpjArg}: ${filtrados.length} registros.`);

  // Top 10 fornecedores
  const porForn = {};
  for (const r of filtrados) {
    const cnpj = normalizarCnpj(r.nr_cgc_cpf);
    const k = cnpj || r.rz_social || 'DESCONHECIDO';
    if (!porForn[k]) porForn[k] = { nome: r.rz_social || '', cnpj, qtd: 0, total: 0 };
    porForn[k].qtd++;
    porForn[k].total += Number(r.valor_pago) || 0;
  }
  const top = Object.values(porForn).sort((a,b) => b.total - a.total).slice(0, 10);
  console.log('\n  Top 10 fornecedores:');
  top.forEach(f => {
    console.log(`    ${(f.cnpj||'').padEnd(14)} ${String(f.qtd).padStart(4)}x  R$ ${f.total.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(16)}  ${(f.nome||'').substring(0,50)}`);
  });

  // Total geral + gestão
  const totalGeral = filtrados.reduce((a, r) => a + (Number(r.valor_pago) || 0), 0);
  const porGestao = {};
  for (const r of filtrados) {
    const g = r.gestao || 'SEM GESTÃO';
    porGestao[g] = (porGestao[g] || 0) + (Number(r.valor_pago) || 0);
  }
  console.log(`\n  Total ${filtrados.length} registros = R$ ${totalGeral.toLocaleString('pt-BR',{minimumFractionDigits:2})}`);
  console.log('\n  Por gestão (top 5):');
  Object.entries(porGestao).sort((a,b) => b[1]-a[1]).slice(0, 5).forEach(([g, v]) => {
    console.log(`    R$ ${v.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(16)}  ${g}`);
  });

  // Insert em pagamentos_portal
  if (APLICAR && filtrados.length > 0) {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO pagamentos_portal
        (portal, gestao, fornecedor, cnpj, cnpj_raiz, empenho,
         data_empenho_iso, data_liquidacao_iso, data_pagamento_iso,
         valor_pago, elemento_desp, fonte, hash_unico, raw_json)
      VALUES ('palmas', @gestao, @fornecedor, @cnpj, @cnpj_raiz, @empenho,
              @dtEmp, @dtLiq, @dtPg, @valor, @elemento, @fonte, @hash, @raw)
    `);
    let inseridos = 0;
    const trx = db.transaction(lista => {
      for (const r of lista) {
        const cnpj = normalizarCnpj(r.nr_cgc_cpf);
        const valor = Number(r.valor_pago) || 0;
        const dtPg = r.data || '';
        const empenho = String(r.ficha || r.nr_pre_empenho || '');
        const hash = crypto.createHash('md5')
          .update(`palmas|${r.gestao||''}|${empenho}|${dtPg}|${valor}|${cnpj}|${r.contador||''}`)
          .digest('hex');
        const resp = stmt.run({
          gestao: r.gestao || '',
          fornecedor: r.rz_social || '',
          cnpj,
          cnpj_raiz: cnpj.substring(0, 8),
          empenho,
          dtEmp: r.data_emp || '',
          dtLiq: r.data_liq || '',
          dtPg,
          valor,
          elemento: r.elem_desp || r.sub_elem_desp || '',
          fonte: r.nome_fonte || r.fonte || '',
          hash,
          raw: JSON.stringify(r),
        });
        if (resp.changes > 0) inseridos++;
      }
    });
    trx(filtrados);
    console.log(`\n  ✅ Inseridos em pagamentos_portal: ${inseridos} (ignorados duplicatas: ${filtrados.length - inseridos})`);
  } else if (!APLICAR) {
    console.log(`\n  (dry-run — use --apply para gravar em pagamentos_portal)`);
  }

  console.log('\n✔️  Concluído.');
}

main().catch(e => { console.error('❌', e); process.exit(1); });
