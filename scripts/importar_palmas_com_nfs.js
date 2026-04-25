'use strict';
/**
 * Importa pagamentos Prodata Palmas + NFs vinculadas — Montana Segurança
 *
 * Descobre endpoint real: prodata.prodataweb.inf.br/rest/
 *   - getPagamentosPortalTransparencia  → lista pagamentos por período
 *   - liquidacoesAPagarOrdemCronologicaController/getDadosNotaFiscalDaLiquidacao
 *                                       → NFs de cada pagamento
 *
 * Uso:
 *   node scripts/importar_palmas_com_nfs.js --ini=2025-01-01 --fim=2025-12-31
 *   node scripts/importar_palmas_com_nfs.js --ini=2026-03-01 --fim=2026-03-31
 *   node scripts/importar_palmas_com_nfs.js --ini=2025-01-01 --fim=2026-03-31 --apply
 *   node scripts/importar_palmas_com_nfs.js --buscar-nfs-existentes --apply   (só busca NFs dos já importados)
 *
 * --apply  : grava no banco (sem = dry-run)
 * --cnpj=19200109  : filtra por CNPJ raiz (default: 19200109 = Montana Segurança)
 */
const path  = require('path');
const https = require('https');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname,'..', '.env') });
const { getDb } = require('../src/db');

const ARG    = process.argv.slice(2);
const APPLY  = ARG.includes('--apply');
const BUS_NF_EXIST = ARG.includes('--buscar-nfs-existentes');
const arg    = (k, def='') => (ARG.find(a => a.startsWith('--'+k+'='))||'').split('=')[1] || def;
const empresa     = arg('empresa', 'seguranca');
const cnpjRaiz    = arg('cnpj', '19200109');
let   iniArg      = arg('ini', '');
let   fimArg      = arg('fim', '');
const anoArg      = arg('ano', '');
const mesArg      = arg('mes', '');

if (!iniArg && anoArg && mesArg) {
  const y=parseInt(anoArg), m=parseInt(mesArg);
  iniArg = `${y}-${String(m).padStart(2,'0')}-01`;
  fimArg = `${y}-${String(m).padStart(2,'0')}-${new Date(y,m,0).getDate()}`;
} else if (!iniArg && anoArg) {
  iniArg = `${anoArg}-01-01`; fimArg = `${anoArg}-12-31`;
}

// ── API ──────────────────────────────────────────────────────────
const HOST_API  = 'prodata.prodataweb.inf.br';
const HOST_PROX = 'prodata.palmas.to.gov.br';   // fallback proxy
const EP_PAGTOS = '/rest/notaPagamentoController/getPagamentosPortalTransparencia';
const EP_NF     = '/rest/liquidacoesAPagarOrdemCronologicaController/getDadosNotaFiscalDaLiquidacao';

const db = getDb(empresa);

function getToken() {
  if (process.env.PRODATA_AUTH_TOKEN) return process.env.PRODATA_AUTH_TOKEN;
  return db.prepare("SELECT valor FROM configuracoes WHERE chave='prodata_auth_token'").get()?.valor || '';
}

function httpPost(host, pathReq, body, token) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: host, port: 443, path: pathReq, method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'Accept':        'application/json, text/plain, */*',
        'Content-Type':  'application/json;charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        'x-auth-token': token,
        'x-client-id':  'sig-frontend',
        'x-id':         'sig',
        'x-modulo':     'TRANSPARENCIA',
        'x-origin':     'https://prodata.palmas.to.gov.br',
        'x-url':        'https://prodata.palmas.to.gov.br/sig/app.html#/transparencia/transparencia-pagamentos-ordem-cronologica/',
        'Referer':      'https://prodata.palmas.to.gov.br/',
        'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MontanaERP',
        'Origin':       'https://prodata.palmas.to.gov.br',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', e => resolve({ status: 'ERR', body: e.message }));
    req.write(payload); req.end();
  });
}

async function buscarPagamentos(ini, fim, token) {
  // Tenta host direto, depois proxy
  for (const host of [HOST_API, HOST_PROX]) {
    const pathReq = host === HOST_PROX ? '/sig' + EP_PAGTOS : EP_PAGTOS;
    const r = await httpPost(host, pathReq, {
      limiteRegistros: 5000,
      formatoArquivoRelatorio: 'PDF',
      data_inicial: `${ini}T15:00:00.000Z`,
      data_final:   `${fim}T15:00:00.000Z`,
      tabela: {}, isConsultaText: false,
      nomeTelaAtualAutocomplete: null,
      propriedadeValor: 'nr_cadnp', propriedadeDescricao: 'nr_cadnp',
      moduloAtual: 'TRANSPARENCIA', descricaoModuloAtual: 'transparencia',
    }, token);
    if (r.status === 200) {
      try {
        const parsed = JSON.parse(r.body);
        const rows = Array.isArray(parsed) ? parsed : (parsed.results || parsed.data || []);
        if (rows.length > 0) { console.log(`  API host: ${host} → ${rows.length} registros`); return rows; }
      } catch(e) { /* continua */ }
    }
    console.log(`  ${host} → ${r.status} (tentando próximo...)`);
  }
  return [];
}

async function buscarNFsDoPagamento(reg, token) {
  const body = {
    contador:        reg.contador,
    idetcmgo_codigo: reg.idetcmgo_codigo,
    ficha:           reg.ficha,
    nr_pre_empenho:  reg.nr_pre_empenho,
    nr_cadnl:        reg.nr_cadnl,
    nr_cadnp:        reg.nr_cadnp,
    elem_desp:       reg.elem_desp,
    sub_elem_desp:   reg.sub_elem_desp || '',
    arquivo:         null,
    data_emp:        reg.data_emp || reg.data || '',
  };
  for (const host of [HOST_API, HOST_PROX]) {
    const pathReq = host === HOST_PROX ? '/sig' + EP_NF : EP_NF;
    const r = await httpPost(host, pathReq, body, token);
    if (r.status === 200 && r.body.length > 2) {
      try {
        const parsed = JSON.parse(r.body);
        const nfs = Array.isArray(parsed) ? parsed : (parsed.results || parsed.data || []);
        return nfs;
      } catch(e) { /* continua */ }
    }
  }
  return [];
}

function normCnpj(v) {
  const s = String(v||'').replace(/\D/g,'');
  if (s.length === 13) return '0'+s;
  if (s.length === 10) return '0'+s;
  return s;
}

// ── Garante colunas extras na pagamentos_portal ───────────────────
function migrarColunas() {
  const cols = db.prepare('PRAGMA table_info(pagamentos_portal)').all().map(c=>c.name);
  if (!cols.includes('nf_numero'))     db.prepare("ALTER TABLE pagamentos_portal ADD COLUMN nf_numero TEXT").run();
  if (!cols.includes('nf_tipo'))       db.prepare("ALTER TABLE pagamentos_portal ADD COLUMN nf_tipo TEXT").run();
  if (!cols.includes('nf_data_emissao')) db.prepare("ALTER TABLE pagamentos_portal ADD COLUMN nf_data_emissao TEXT").run();
  if (!cols.includes('nf_valor'))      db.prepare("ALTER TABLE pagamentos_portal ADD COLUMN nf_valor REAL").run();
  if (!cols.includes('nf_raw'))        db.prepare("ALTER TABLE pagamentos_portal ADD COLUMN nf_raw TEXT").run();
}

const stmtInsert = () => db.prepare(`
  INSERT OR IGNORE INTO pagamentos_portal
    (portal, gestao, gestao_codigo, fornecedor, cnpj, cnpj_raiz,
     processo, empenho, data_empenho_iso, data_liquidacao_iso, data_pagamento_iso,
     valor_pago, fonte, fonte_det, elemento_desp, subnatureza, pronto_pgto,
     status_match, hash_unico, raw_json, historico)
  VALUES ('palmas',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDENTE',?,?,?)
`);

const stmtUpdNF = () => db.prepare(`
  UPDATE pagamentos_portal
  SET nf_numero=?, nf_tipo=?, nf_data_emissao=?, nf_valor=?, nf_raw=?, status_match='CONCILIADO_NF'
  WHERE id=? AND (nf_numero IS NULL OR nf_numero='')
`);

async function main() {
  const token = getToken();
  if (!token) { console.error('❌ Token Prodata não encontrado'); process.exit(1); }
  const exp = (() => { try { return JSON.parse(Buffer.from(token.split('.')[1],'base64').toString('utf8')).data; } catch(_){return '?';}})();
  console.log(`\n🏛️  Importar Palmas + NFs — empresa=${empresa} CNPJ raiz=${cnpjRaiz}`);
  console.log(`   Token expira: ${exp} | Modo: ${APPLY?'APLICAR':'DRY-RUN'}\n`);

  migrarColunas();

  // ── Modo: só busca NFs dos já importados ────────────────────────
  if (BUS_NF_EXIST) {
    const semNF = db.prepare(`
      SELECT id, raw_json FROM pagamentos_portal
      WHERE portal='palmas' AND (nf_numero IS NULL OR nf_numero='')
        AND cnpj_raiz LIKE ? || '%'
      ORDER BY data_pagamento_iso
    `).all(cnpjRaiz);
    console.log(`  Registros sem NF: ${semNF.length}`);

    let ok=0, sem=0;
    const updNF = stmtUpdNF();
    for (const row of semNF) {
      const reg = JSON.parse(row.raw_json);
      const nfs = await buscarNFsDoPagamento(reg, token);
      if (nfs.length > 0) {
        const nf = nfs[0];
        const numero = nf.nr_documento || nf.numero || nf.nrDocumento || '';
        const tipo   = nf.ds_tipo_documento || nf.tipo || '';
        const dtEm   = nf.dt_emissao_documento || nf.data_emissao || '';
        const valor  = parseFloat(nf.vl_documento || nf.valor || 0);
        if (APPLY) updNF.run(numero, tipo, dtEm, valor, JSON.stringify(nfs), row.id);
        console.log(`  ✅ id=${row.id} → NF ${numero} (${tipo}) ${dtEm} R$${valor.toFixed(2)}`);
        ok++;
      } else {
        sem++;
      }
      await new Promise(r => setTimeout(r, 120)); // 120ms entre chamadas
    }
    console.log(`\n  NFs encontradas: ${ok} | Sem NF: ${sem}`);
    if (!APPLY) console.log('  ⚠️  DRY-RUN — adicione --apply para gravar');
    return;
  }

  // ── Modo normal: importa período ─────────────────────────────────
  if (!iniArg || !fimArg) {
    console.error('Uso: --ini=AAAA-MM-DD --fim=AAAA-MM-DD  OU  --ano=AAAA [--mes=M]');
    process.exit(1);
  }

  console.log(`  Período: ${iniArg} → ${fimArg}`);
  const pagamentos = await buscarPagamentos(iniArg, fimArg, token);
  if (!pagamentos.length) { console.log('  Nenhum pagamento encontrado.'); return; }

  // Filtra pelo CNPJ raiz
  const montana = pagamentos.filter(p => {
    const c = normCnpj(p.nr_cgc_cpf || p.cnpj || '');
    return c.startsWith(cnpjRaiz);
  });
  console.log(`  Total Palmas: ${pagamentos.length} | Montana (${cnpjRaiz}): ${montana.length}`);

  // Agrupa por mês para relatório
  const porMes = {};
  montana.forEach(p => {
    const mes = (p.data||p.dt_pagamento||'').slice(0,7);
    if (!porMes[mes]) porMes[mes] = {n:0,total:0};
    porMes[mes].n++; porMes[mes].total += parseFloat(p.valor_pago||p.vl_liquidacao||0);
  });
  console.log('\n  Por mês:');
  Object.entries(porMes).sort().forEach(([m,v]) =>
    console.log(`    ${m}: ${v.n} pagamentos  R$${v.total.toLocaleString('pt-BR',{minimumFractionDigits:2})}`));

  const ins = stmtInsert();
  const updNF = stmtUpdNF();
  let inseridos=0, dups=0, nfsOk=0, nfsSem=0;

  for (const p of montana) {
    const cnpj     = normCnpj(p.nr_cgc_cpf || p.cnpj || '');
    const dataPg   = (p.data||p.dt_pagamento||'').slice(0,10);
    const dataEmp  = (p.data_emp||p.data_empenho||'').slice(0,10);
    const dataLiq  = (p.data_liq||p.data_liquidacao||'').slice(0,10);
    const valor    = parseFloat(p.valor_pago||p.vl_liquidacao||0);
    const hash     = crypto.createHash('md5').update(`${p.contador||''}|${p.ficha||''}|${dataPg}|${valor}`).digest('hex');
    const gestao   = p.gestao_nome || p.gestao || '';
    const gestCod  = String(p.idetcmgo_codigo||p.gestao_codigo||'');
    const forn     = p.rz_social || p.fornecedor || '';
    const processo = p.nr_processo || '';
    const empenho  = String(p.ficha||p.empenho||'');
    const fonte    = p.nome_fonte || '';
    const fonteDet = String(p.codigo_fonte||'');
    const elDesp   = String(p.elem_desp||'');
    const subNat   = String(p.sub_elem_desp||p.subnatureza||'');
    const prontoPg = p.pronto_pgto || '';
    const historico= `Palmas OB ${empenho} ${forn} ${dataPg}`;

    if (APPLY) {
      const r = ins.run(gestao, gestCod, forn, cnpj, cnpjRaiz,
                        processo, empenho, dataEmp, dataLiq, dataPg,
                        valor, fonte, fonteDet, elDesp, subNat, prontoPg,
                        hash, JSON.stringify(p), historico);
      if (r.changes === 0) { dups++; continue; }
      const newId = r.lastInsertRowid;
      inseridos++;

      // Busca NFs deste pagamento
      const nfs = await buscarNFsDoPagamento(p, token);
      if (nfs.length > 0) {
        const nf = nfs[0];
        const numero = nf.nr_documento || nf.numero || nf.nrDocumento || '';
        const tipo   = nf.ds_tipo_documento || nf.tipo || nf.tp_documento || '';
        const dtEm   = nf.dt_emissao_documento || nf.dt_emissao || '';
        const valNF  = parseFloat(nf.vl_documento || nf.valor_nf || 0);
        updNF.run(numero, tipo, dtEm, valNF, JSON.stringify(nfs), newId);
        nfsOk++;
        console.log(`  ✅ ${dataPg} R$${valor.toFixed(2)} → NF ${numero} (${tipo}) em ${dtEm}`);
      } else {
        nfsSem++;
        console.log(`  ⚠️  ${dataPg} R$${valor.toFixed(2)} ${forn.slice(0,30)} → sem NF`);
      }
      await new Promise(r => setTimeout(r, 150));
    } else {
      inseridos++;
      console.log(`  [DRY] ${dataPg} R$${valor.toFixed(2)} ${forn.slice(0,30)}`);
    }
  }

  console.log(`\n  ✅ Inseridos: ${inseridos} | Duplicados: ${dups} | NFs: ${nfsOk} | Sem NF: ${nfsSem}`);
  if (!APPLY) console.log('  ⚠️  DRY-RUN — adicione --apply para gravar');

  // ── Conciliação automática: liga pagamentos_portal → notas_fiscais ──
  if (APPLY && nfsOk > 0) {
    console.log('\n  🔗 Conciliando NFs com notas_fiscais...');
    const portComNF = db.prepare(`
      SELECT pp.id, pp.nf_numero, pp.valor_pago, pp.data_pagamento_iso, pp.nf_data_emissao
      FROM pagamentos_portal pp
      WHERE pp.portal='palmas' AND pp.nf_numero IS NOT NULL AND pp.nf_id IS NULL
        AND pp.cnpj_raiz LIKE ? || '%'
    `).all(cnpjRaiz);

    let ligados=0;
    const stmtLigar = db.prepare(`
      UPDATE pagamentos_portal SET nf_id=?, status_match='CONCILIADO_NF_LINKED' WHERE id=?
    `);
    const stmtUpdNfStatus = db.prepare(`
      UPDATE notas_fiscais SET status_conciliacao='CONCILIADO', data_pagamento=?
      WHERE id=? AND status_conciliacao IN ('PENDENTE','PAGO_SEM_COMPROVANTE')
    `);

    for (const pp of portComNF) {
      // Busca NF pelo número
      const nfMatch = db.prepare(`
        SELECT id FROM notas_fiscais
        WHERE numero = ? OR numero LIKE ? || '%' OR numero LIKE '%' || ?
        LIMIT 1
      `).get(pp.nf_numero, pp.nf_numero, pp.nf_numero);
      if (nfMatch) {
        if (APPLY) {
          stmtLigar.run(nfMatch.id, pp.id);
          stmtUpdNfStatus.run(pp.data_pagamento_iso, nfMatch.id);
        }
        ligados++;
        console.log(`    ✅ NF ${pp.nf_numero} → id=${nfMatch.id}`);
      }
    }
    console.log(`  Ligações NF↔pagamentos_portal: ${ligados}`);
  }
}

main().catch(e => { console.error('❌', e.message, e.stack); process.exit(1); });
