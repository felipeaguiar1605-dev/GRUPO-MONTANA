'use strict';
/**
 * Scraper CGE/TO — www.gestao.cge.to.gov.br/transpgto/consulta_pagamentos_portal
 *
 * Fluxo ScriptCase:
 *   1. GET /        → PHPSESSID + script_case_init
 *   2. POST index.php (ajax_refresh_field) × 3 — descobrir fontes/anos/meses válidos
 *   3. POST /       (nmgp_opcao=busca)         — grava filtro na sessão
 *   4. POST /       (nmgp_opcao=pesq)          — retorna grid HTML
 *   5. [opcional] navegação de páginas via F6
 *
 * Uso:
 *   node scripts/scrape_cge_to.js                        # todas UGs Montana, 2025-10 → 2026-04
 *   node scripts/scrape_cge_to.js --ug=1247 --mes=3 --ano=2026  # single
 *   node scripts/scrape_cge_to.js --apply                 # importa em pagamentos_portal
 */
const https = require('https');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');

const HOST = 'www.gestao.cge.to.gov.br';
const BASE = '/transpgto/consulta_pagamentos_portal';

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-zA-Z_]+)(?:=(.+))?$/);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}
const APPLY = !!args.apply;

// UGs relevantes para Montana (baseado nos contratos conhecidos)
const UGS_MONTANA = [
  { id: '1247', nome: 'Departamento Estadual de Trânsito - DETRAN' },
  { id: '1224', nome: 'Universidade Estadual do Tocantins - UNITINS' },
  { id: '1244', nome: 'Fundo Estadual de Saúde' },
  { id: '1259', nome: 'Secretaria do Meio Ambiente e Recursos Hídricos' },
  { id: '1204', nome: 'Corpo de Bombeiros Militar do Estado do Tocantins - CBMTO' },
  { id: '1205', nome: 'Fundo de Modernização e Aparelhamento do CBMTO' },
  { id: '1208', nome: 'Fundo de Fardamento do Corpo de Bombeiros' },
  { id: '1242', nome: 'Secretaria da Educação' },
  { id: '1245', nome: 'Secretaria da Segurança Pública' },
  { id: '1248', nome: 'Fundo de Segurança Pública do Estado do Tocantins - FUSPTO' },
  { id: '1215', nome: 'Secretaria da Cidadania e Justiça' },
  { id: '1254', nome: 'Secretaria das Cidades, Habitação e Desenvolvimento Urbano' },
  { id: '1201', nome: 'Controladoria-Geral do Estado' },
];

const CATEGORIA = { id: '3', nome: 'Prestação de Serviços' };
const CNPJ_MONTANA = ['14.092.519/0001-51', '19.200.109/0001-09'];

// ── Session / cookie jar ──
const jar = [];
function cookieHeader() { return jar.map(c => `${c.name}=${c.value}`).join('; '); }
function storeCookies(setCookies) {
  if (!setCookies) return;
  for (const sc of setCookies) {
    const [nv] = sc.split(';');
    const idx = nv.indexOf('=');
    if (idx < 0) continue;
    const name = nv.substring(0, idx).trim();
    const value = nv.substring(idx + 1).trim();
    const e = jar.find(c => c.name === name);
    if (e) e.value = value; else jar.push({ name, value });
  }
}

function request(method, p, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'Mozilla/5.0 MontanaERP CGE-Scraper/1.0',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'Cookie': cookieHeader(),
      ...extraHeaders,
    };
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request({ hostname: HOST, port: 443, path: p, method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        storeCookies(res.headers['set-cookie']);
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function initSession() {
  jar.length = 0;
  const r = await request('GET', BASE + '/', null);
  const m = r.body.match(/name="script_case_init"\s+value="(\d+)"/);
  if (!m) throw new Error('script_case_init não encontrado na sessão inicial');
  return m[1];
}

async function refreshField(scinit, fields, parms) {
  const body = querystring.stringify({
    nmgp_opcao: 'ajax_refresh_field',
    script_case_init: scinit,
    NM_fields_refresh: fields,
    NM_parms_refresh: parms,
  });
  const r = await request('POST', BASE + '/index.php', body, {
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': `https://${HOST}${BASE}/`,
  });
  try { return JSON.parse(r.body); }
  catch (e) { throw new Error('Refresh non-JSON: ' + r.body.substring(0, 200)); }
}

function buildParms(vals) {
  return ['id_orgao', 'categoria_pgto', 'fonte_recurso', 'ano_pgto']
    .map(k => `${k}#NMF#${vals[k] || ''}`).join('@NMF@') + '@NMF@';
}

async function submitBusca(scinit, filters) {
  const body = querystring.stringify({
    script_case_init: scinit,
    nmgp_opcao: 'busca',
    id_orgao_cond: 'eq', id_orgao: filters.id_orgao,
    categoria_pgto_cond: 'eq', categoria_pgto: filters.categoria_pgto,
    fonte_recurso_cond: 'eq', fonte_recurso: filters.fonte_recurso || '',
    ano_pgto_cond: 'eq', ano_pgto: filters.ano_pgto,
    mes_pgto_cond: 'eq', mes_pgto: filters.mes_pgto,
    NM_operador: 'and',
    nmgp_tab_label: 'id_orgao?#?Unidade Gestora?@?categoria_pgto?#?Categoria?@?fonte_recurso?#?Fonte de Recurso?@?ano_pgto?#?Ano?@?mes_pgto?#?Mês?@?',
    bprocessa: 'pesq',
  });
  return request('POST', BASE + '/', body, { 'Referer': `https://${HOST}${BASE}/` });
}

async function submitPesq(scinit) {
  const body = querystring.stringify({
    script_case_init: scinit,
    nmgp_opcao: 'pesq',
  });
  return request('POST', BASE + '/', body, { 'Referer': `https://${HOST}${BASE}/` });
}

// Parser: procura rows com span id_sc_field_<campo>_<N>
function parseGrid(html) {
  const rows = {};
  const re = /<span\s+id="id_sc_field_([a-z_]+)_(\d+)"[^>]*>([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const field = m[1], idx = parseInt(m[2]), value = m[3].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
    if (!rows[idx]) rows[idx] = {};
    rows[idx][field] = value;
  }
  return Object.keys(rows).sort((a, b) => parseInt(a) - parseInt(b)).map(k => rows[k]);
}

function parseTotalCount(html) {
  const m = html.match(/sm_counter_total['"]>(\d+)<\/span>/);
  return m ? parseInt(m[1]) : null;
}

// Busca para uma combinação UG × mês
async function buscarUgMes(scinit, ug, ano, mes) {
  // AJAX 1: UG → fontes
  let resp = await refreshField(scinit,
    'fonte_recurso@NMF@ano_pgto@NMF@mes_pgto',
    buildParms({ id_orgao: `${ug.id}##@@${ug.nome}`, categoria_pgto: `${CATEGORIA.id}##@@${CATEGORIA.nome}` }));
  const fonteOpts = (resp.set_option || []).find(o => o.field === 'SC_fonte_recurso');
  const fontes = fonteOpts ? fonteOpts.value.filter(v => v.opt) : [];
  if (fontes.length === 0) return [];

  const rows = [];
  for (const fonte of fontes) {
    // AJAX 2: fonte → ano
    resp = await refreshField(scinit, 'ano_pgto@NMF@mes_pgto',
      buildParms({ id_orgao: `${ug.id}##@@${ug.nome}`, categoria_pgto: `${CATEGORIA.id}##@@${CATEGORIA.nome}`, fonte_recurso: fonte.opt }));
    const anoOpts = (resp.set_option || []).find(o => o.field === 'SC_ano_pgto');
    const anos = anoOpts ? anoOpts.value.filter(v => v.opt) : [];
    const anoMatch = anos.find(a => a.value === String(ano));
    if (!anoMatch) continue;

    // AJAX 3: ano → mes
    resp = await refreshField(scinit, 'mes_pgto',
      buildParms({ id_orgao: `${ug.id}##@@${ug.nome}`, categoria_pgto: `${CATEGORIA.id}##@@${CATEGORIA.nome}`, fonte_recurso: fonte.opt, ano_pgto: anoMatch.opt }));
    const mesOpts = (resp.set_option || []).find(o => o.field === 'SC_mes_pgto');
    const meses = mesOpts ? mesOpts.value.filter(v => v.opt) : [];
    const mesMatch = meses.find(m => m.value === String(mes));
    if (!mesMatch) continue;

    // Submit busca → pesq → grid
    await submitBusca(scinit, {
      id_orgao: `${ug.id}##@@${ug.nome}`,
      categoria_pgto: `${CATEGORIA.id}##@@${CATEGORIA.nome}`,
      fonte_recurso: fonte.opt,
      ano_pgto: anoMatch.opt,
      mes_pgto: mesMatch.opt,
    });
    const grid = await submitPesq(scinit);
    const gridRows = parseGrid(grid.body);
    const total = parseTotalCount(grid.body);
    if (total !== null && total > gridRows.length) {
      // TODO: paginação (por ora, avisa)
      console.log(`     ⚠️  mais registros na paginação: ${gridRows.length}/${total}`);
    }
    const fonteNome = fonte.opt.split('##@@')[1] || '';
    for (const r of gridRows) {
      rows.push({ ...r, ug_id: ug.id, ug_nome: ug.nome, fonte: fonteNome, categoria: CATEGORIA.nome });
    }
  }
  return rows;
}

function isMontana(row) {
  const cnpj = (row.cnpj_credor || '').replace(/\D/g, '');
  return cnpj.startsWith('14092519') || cnpj.startsWith('19200109');
}

function brl(s) {
  if (!s) return 0;
  // "R$ 1.234,56" → 1234.56
  return parseFloat(String(s).replace(/[^\d,]/g, '').replace(',', '.')) || 0;
}

function iso(ddmmyyyy) {
  const m = String(ddmmyyyy || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

async function main() {
  // Define escopo
  let ugsRun, periodos;
  if (args.ug) {
    ugsRun = UGS_MONTANA.filter(u => u.id === args.ug);
    if (!ugsRun.length) ugsRun = [{ id: args.ug, nome: `UG ${args.ug}` }];
  } else {
    ugsRun = UGS_MONTANA;
  }
  if (args.ano && args.mes) {
    periodos = [{ ano: parseInt(args.ano), mes: parseInt(args.mes) }];
  } else {
    // Últimos 6 meses
    periodos = [];
    const hoje = new Date();
    for (let i = 0; i < 6; i++) {
      const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
      periodos.push({ ano: d.getFullYear(), mes: d.getMonth() + 1 });
    }
  }

  console.log('\n🔍 CGE/TO — Scraping pagamentos Montana');
  console.log(`  UGs: ${ugsRun.length} | Meses: ${periodos.length}`);

  const scinit = await initSession();
  console.log(`  Sessão iniciada: script_case_init=${scinit}\n`);

  const todosMontana = [];
  const todasLinhas = [];
  let totalRowsLidos = 0;

  for (const ug of ugsRun) {
    console.log(`📋 ${ug.nome} (UG ${ug.id})`);
    for (const per of periodos) {
      try {
        const rows = await buscarUgMes(scinit, ug, per.ano, per.mes);
        totalRowsLidos += rows.length;
        const mRows = rows.filter(isMontana);
        if (mRows.length > 0 || rows.length > 0) {
          console.log(`  ${String(per.mes).padStart(2, '0')}/${per.ano}: ${rows.length} linhas${mRows.length ? ` | 🏢 ${mRows.length} Montana` : ''}`);
        }
        todasLinhas.push(...rows.map(r => ({ ...r, ano_pgto: String(per.ano), mes_pgto: String(per.mes).padStart(2, '0') })));
        todosMontana.push(...mRows.map(r => ({ ...r, ano_pgto: String(per.ano), mes_pgto: String(per.mes).padStart(2, '0') })));
        // Pausa curta para não abusar do servidor
        await new Promise(r => setTimeout(r, 200));
      } catch (e) {
        console.error(`  ❌ ${per.ano}-${per.mes}: ${e.message}`);
      }
    }
  }

  console.log(`\n✅ Total lido: ${totalRowsLidos} linhas | 🏢 Montana: ${todosMontana.length}`);

  // Salvar dump (inclui TODAS as linhas para debug)
  const outDir = path.join(__dirname, '..', 'tmp_cge_to');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = path.join(outDir, `cge_montana_${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ when: new Date().toISOString(), todas: todasLinhas, montana: todosMontana }, null, 2));
  console.log(`📁 Dump: ${outFile}`);

  if (todosMontana.length > 0) {
    console.log('\nAmostra (primeiros 10):');
    for (const r of todosMontana.slice(0, 10)) {
      console.log(`   ${r.mes_pgto}/${r.ano_pgto} ${r.dt_pagamento || iso(r.dt_liquidacao) || '?'} | R$ ${brl(r.valor_pago).toFixed(2).padStart(14)} | NF ${r.num_doc_fiscal || '?'} | ${(r.razao_social_credor || '').slice(0, 35)} | ${r.ug_nome.slice(0, 40)}`);
    }
  }

  if (!APPLY) {
    console.log('\n⚠️  Dry-run. Rode com --apply para importar em pagamentos_portal.');
    return;
  }

  // Import
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const { getDb } = require('../src/db');
  const crypto = require('crypto');

  const byCnpj = { '14092519': 'assessoria', '19200109': 'seguranca' };
  let insAss = 0, insSeg = 0, skip = 0;

  for (const empresa of ['assessoria', 'seguranca']) {
    const cnpjPrefix = Object.keys(byCnpj).find(k => byCnpj[k] === empresa);
    const rowsEmpresa = todosMontana.filter(r => (r.cnpj_credor || '').replace(/\D/g, '').startsWith(cnpjPrefix));
    if (rowsEmpresa.length === 0) continue;

    const db = getDb(empresa);
    const ins = db.prepare(`INSERT OR IGNORE INTO pagamentos_portal
      (portal, gestao, gestao_codigo, fornecedor, cnpj, cnpj_raiz, empenho, data_empenho_iso, data_liquidacao_iso, data_pagamento_iso, valor_pago, fonte, fonte_det, obs, hash_unico, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const tx = db.transaction(() => {
      let n = 0;
      for (const r of rowsEmpresa) {
        const cnpjRaw = (r.cnpj_credor || '').replace(/\D/g, '');
        const valorPago = brl(r.valor_pago || r.pgto_efetuado || r.valor_a_pagar);
        const hash = crypto.createHash('sha1').update(`cge|${r.ug_id}|${r.nup_ordem_pagamento || r.sequencia_pgto || ''}|${cnpjRaw}|${valorPago.toFixed(2)}|${iso(r.dt_pagamento) || ''}`).digest('hex').slice(0, 32);
        ins.run(
          'estadual-to-cge', r.ug_nome, r.ug_id, r.razao_social_credor || '', r.cnpj_credor || '', cnpjPrefix,
          r.nup_ne_pagamento || r.ne || '', iso(r.dt_empenho), iso(r.dt_liquidacao), iso(r.dt_pagamento) || iso(r.dt_liquidacao),
          valorPago, r.fonte || '', r.fonte || '',
          `OP ${r.nup_ordem_pagamento || r.sequencia_pgto || ''} | NF ${r.num_doc_fiscal || ''} | ${r.categoria}`,
          hash, JSON.stringify(r)
        );
        n++;
      }
      return n;
    });
    const n = tx();
    if (empresa === 'assessoria') insAss = n; else insSeg = n;
    db.close();
  }

  console.log(`\n✅ Importado: Assessoria ${insAss} | Segurança ${insSeg}`);
}

main().catch(e => { console.error('❌', e.stack || e.message); process.exit(1); });
