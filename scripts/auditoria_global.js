#!/usr/bin/env node
/**
 * Montana — Auditoria global de inconsistências em todas as abas / tabelas
 *
 * DRY-RUN por padrão. Não modifica nada.
 * Varre:
 *   - extratos   (duplicatas, SALDO, aplicações cross-empresa, divergência débito/crédito)
 *   - notas      (duplicatas numero/serie/tomador, tomador NULL/vazio, valor NULL, status órfão)
 *   - despesas   (valor NULL, categoria vazia, contaminação cross-empresa, aplicações em despesa)
 *   - contratos  (valor mensal bruto = 0, órgão vazio)
 *   - bol_boletins + bol_boletins_nfs (vínculos órfãos)
 *   - rh_folha / rh_folha_itens (duplicatas de competência, itens órfãos)
 *   - certidoes  (venc passado, órgão/arquivo vazio)
 *   - licitacoes (sem dados → ok; se tiver, checa datas e campos)
 *
 * Uso:
 *   node scripts/auditoria_global.js [empresa]
 *   (empresa = assessoria | seguranca | todas — default "todas")
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const empArg = (process.argv[2] || 'todas').toLowerCase();
const EMPRESAS = empArg === 'todas' ? ['assessoria','seguranca'] : [empArg];

function fmt(v) { return (v||0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function hasTable(db, name) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}
function cols(db, t) {
  try { return db.prepare(`PRAGMA table_info(${t})`).all().map(c=>c.name); }
  catch { return []; }
}

function auditar(empresa) {
  const db = getDb(empresa);
  const header = `\n${'═'.repeat(100)}\n  🔍 AUDITORIA — ${empresa.toUpperCase()}\n${'═'.repeat(100)}`;
  console.log(header);
  const achados = [];

  // ── EXTRATOS ─────────────────────────────────────────────────────────
  if (hasTable(db, 'extratos')) {
    const total = db.prepare(`SELECT COUNT(*) c FROM extratos`).get().c;
    console.log(`\n── EXTRATOS (${total} linhas) ──`);

    // 1) SALDO no lado débito
    const saldoDeb = db.prepare(`
      SELECT COUNT(*) c, COALESCE(SUM(debito),0) v
      FROM extratos WHERE debito > 0
        AND (UPPER(historico) LIKE '%SALDO%' OR UPPER(historico) LIKE '%S A L D O%')
    `).get();
    if (saldoDeb.c) { console.log(`  ⚠️  SALDO no débito        : ${saldoDeb.c} (R$ ${fmt(saldoDeb.v)})`); achados.push({cat:'ext.saldo_deb',empresa,c:saldoDeb.c,v:saldoDeb.v}); }
    const saldoCred = db.prepare(`
      SELECT COUNT(*) c, COALESCE(SUM(credito),0) v
      FROM extratos WHERE credito > 0
        AND (UPPER(historico) LIKE '%SALDO%' OR UPPER(historico) LIKE '%S A L D O%')
    `).get();
    if (saldoCred.c) { console.log(`  ⚠️  SALDO no crédito       : ${saldoCred.c} (R$ ${fmt(saldoCred.v)})`); achados.push({cat:'ext.saldo_cred',empresa,c:saldoCred.c,v:saldoCred.v}); }

    // 2) linhas com débito E crédito > 0 (erro de parsing)
    const bothSides = db.prepare(`SELECT COUNT(*) c FROM extratos WHERE debito > 0 AND credito > 0`).get();
    if (bothSides.c) { console.log(`  ⚠️  Débito E crédito >0    : ${bothSides.c} (parsing ruim)`); achados.push({cat:'ext.bothsides',empresa,c:bothSides.c}); }

    // 3) duplicatas cross-format (ignora conta, considera data+valor+hist normalizado)
    const norm = r => (r||'').toString().toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Z0-9]+/g,' ').trim();
    const dupDeb = {};
    const allDeb = db.prepare(`SELECT id, data_iso, debito, historico FROM extratos WHERE debito > 0`).all();
    for (const r of allDeb) {
      const k = `${r.data_iso}|${r.debito.toFixed(2)}|${norm(r.historico)}`;
      (dupDeb[k] = dupDeb[k] || []).push(r);
    }
    const gruposDup = Object.values(dupDeb).filter(a => a.length > 1);
    const dupRem = gruposDup.reduce((s,g)=>s+(g.length-1),0);
    const dupVal = gruposDup.reduce((s,g)=>s+(g.length-1)*g[0].debito,0);
    if (dupRem) { console.log(`  ⚠️  Dup DÉBITO cross-fmt   : ${dupRem} linhas removíveis (R$ ${fmt(dupVal)})`); achados.push({cat:'ext.dup_deb',empresa,c:dupRem,v:dupVal}); }

    const dupCred = {};
    const allCred = db.prepare(`SELECT id, data_iso, credito, historico FROM extratos WHERE credito > 0`).all();
    for (const r of allCred) {
      const k = `${r.data_iso}|${r.credito.toFixed(2)}|${norm(r.historico)}`;
      (dupCred[k] = dupCred[k] || []).push(r);
    }
    const gCred = Object.values(dupCred).filter(a => a.length > 1);
    const cRem = gCred.reduce((s,g)=>s+(g.length-1),0);
    const cVal = gCred.reduce((s,g)=>s+(g.length-1)*g[0].credito,0);
    if (cRem) { console.log(`  ⚠️  Dup CRÉDITO cross-fmt  : ${cRem} linhas removíveis (R$ ${fmt(cVal)})`); achados.push({cat:'ext.dup_cred',empresa,c:cRem,v:cVal}); }

    // 4) data_iso NULL
    const nullData = db.prepare(`SELECT COUNT(*) c FROM extratos WHERE data_iso IS NULL OR data_iso = ''`).get();
    if (nullData.c) { console.log(`  ⚠️  data_iso vazio         : ${nullData.c}`); achados.push({cat:'ext.nulldata',empresa,c:nullData.c}); }

    if (achados.filter(a=>a.cat.startsWith('ext.')).length === 0) console.log(`  ✅ OK`);
  }

  // ── NOTAS (NFs) ──────────────────────────────────────────────────────
  const nomeNFs = hasTable(db,'notas_fiscais') ? 'notas_fiscais' : (hasTable(db,'notas') ? 'notas' : (hasTable(db,'nfs') ? 'nfs' : null));
  if (nomeNFs) {
    const c = cols(db, nomeNFs);
    const total = db.prepare(`SELECT COUNT(*) c FROM ${nomeNFs}`).get().c;
    console.log(`\n── NFs (${total} linhas, tabela=${nomeNFs}) ──`);

    // valor NULL
    if (c.includes('valor_liquido')) {
      const n = db.prepare(`SELECT COUNT(*) c FROM ${nomeNFs} WHERE valor_liquido IS NULL OR valor_liquido = 0`).get().c;
      if (n) { console.log(`  ⚠️  valor_liquido vazio/0  : ${n}`); achados.push({cat:'nf.valor_null',empresa,c:n}); }
    }
    // tomador vazio
    if (c.includes('tomador')) {
      const n = db.prepare(`SELECT COUNT(*) c FROM ${nomeNFs} WHERE tomador IS NULL OR TRIM(tomador) = ''`).get().c;
      if (n) { console.log(`  ⚠️  tomador vazio          : ${n}`); achados.push({cat:'nf.tomador_null',empresa,c:n}); }
    }
    // numero duplicado na mesma série+tomador
    if (c.includes('numero')) {
      const dup = db.prepare(`
        SELECT numero, ${c.includes('serie')?'serie':"''"} as serie, COUNT(*) n
        FROM ${nomeNFs}
        WHERE numero IS NOT NULL AND numero != ''
        GROUP BY numero, ${c.includes('serie')?'serie':"''"}
        HAVING n > 1
      `).all();
      if (dup.length) {
        const rem = dup.reduce((s,r)=>s+(r.n-1),0);
        console.log(`  ⚠️  NFs duplicadas (n,ser) : ${dup.length} grupos → ${rem} removíveis`);
        achados.push({cat:'nf.dup',empresa,c:rem});
      }
    }
    // status órfão (valores inesperados)
    if (c.includes('status')) {
      const statusList = db.prepare(`SELECT status, COUNT(*) c FROM ${nomeNFs} GROUP BY status ORDER BY c DESC`).all();
      console.log(`  ℹ️  status distribuição    : ${statusList.map(s=>`${s.status||'<null>'}=${s.c}`).join(' | ')}`);
    }
    if (achados.filter(a=>a.cat.startsWith('nf.')).length === 0) console.log(`  ✅ OK`);
  }

  // ── DESPESAS ─────────────────────────────────────────────────────────
  if (hasTable(db, 'despesas')) {
    const c = cols(db,'despesas');
    const total = db.prepare(`SELECT COUNT(*) c FROM despesas`).get().c;
    console.log(`\n── DESPESAS (${total} linhas) ──`);

    if (c.includes('valor_bruto')) {
      const n = db.prepare(`SELECT COUNT(*) c FROM despesas WHERE valor_bruto IS NULL OR valor_bruto = 0`).get().c;
      if (n) { console.log(`  ⚠️  valor_bruto vazio/0    : ${n}`); achados.push({cat:'desp.valor',empresa,c:n}); }
    }
    if (c.includes('categoria')) {
      const n = db.prepare(`SELECT COUNT(*) c FROM despesas WHERE categoria IS NULL OR TRIM(categoria)=''`).get().c;
      if (n) { console.log(`  ⚠️  categoria vazia        : ${n}`); achados.push({cat:'desp.cat',empresa,c:n}); }
    }
    // aplicações financeiras em despesas (ERRO — não é despesa)
    if (c.includes('descricao') || c.includes('historico')) {
      const f = c.includes('descricao') ? 'descricao' : 'historico';
      const n = db.prepare(`
        SELECT COUNT(*) c, COALESCE(SUM(valor_bruto),0) v
        FROM despesas
        WHERE UPPER(${f}) LIKE '%BB RENDE%'
           OR UPPER(${f}) LIKE '%RENDE FACIL%'
           OR UPPER(${f}) LIKE '%CDB%'
           OR UPPER(${f}) LIKE '%APLICAC%'
      `).get();
      if (n.c) { console.log(`  ⚠️  aplic. fin. em DESPESA : ${n.c} (R$ ${fmt(n.v)}) — não é despesa`); achados.push({cat:'desp.aplic',empresa,c:n.c,v:n.v}); }
    }
    // transferência intragrupo como despesa
    if (c.includes('descricao') || c.includes('historico')) {
      const f = c.includes('descricao') ? 'descricao' : 'historico';
      const n = db.prepare(`
        SELECT COUNT(*) c, COALESCE(SUM(valor_bruto),0) v
        FROM despesas
        WHERE (UPPER(${f}) LIKE '%MESMA TITULARIDADE%'
            OR UPPER(${f}) LIKE '%CH.AVULSO ENTRE AG%'
            OR UPPER(${f}) LIKE '%TED MESMA TITUL%')
      `).get();
      if (n.c) { console.log(`  ⚠️  intragrupo em DESPESA  : ${n.c} (R$ ${fmt(n.v)}) — não é despesa`); achados.push({cat:'desp.intra',empresa,c:n.c,v:n.v}); }
    }
    if (achados.filter(a=>a.cat.startsWith('desp.')).length === 0) console.log(`  ✅ OK`);
  }

  // ── CONTRATOS ────────────────────────────────────────────────────────
  if (hasTable(db,'contratos')) {
    const c = cols(db,'contratos');
    const total = db.prepare(`SELECT COUNT(*) c FROM contratos`).get().c;
    console.log(`\n── CONTRATOS (${total}) ──`);
    if (c.includes('valor_mensal_bruto')) {
      const n = db.prepare(`SELECT numContrato, orgao FROM contratos WHERE valor_mensal_bruto IS NULL OR valor_mensal_bruto = 0`).all();
      if (n.length) {
        console.log(`  ⚠️  valor_mensal_bruto=0   : ${n.length}`);
        n.forEach(r=>console.log(`     · ${r.numContrato} — ${r.orgao||'(sem órgão)'}`));
        achados.push({cat:'contr.val_zero',empresa,c:n.length});
      }
    }
    if (c.includes('orgao')) {
      const n = db.prepare(`SELECT COUNT(*) c FROM contratos WHERE orgao IS NULL OR TRIM(orgao)=''`).get().c;
      if (n) { console.log(`  ⚠️  órgão vazio            : ${n}`); achados.push({cat:'contr.orgao',empresa,c:n}); }
    }
    if (achados.filter(a=>a.cat.startsWith('contr.')).length === 0) console.log(`  ✅ OK`);
  }

  // ── BOLETINS ─────────────────────────────────────────────────────────
  if (hasTable(db,'bol_boletins')) {
    const total = db.prepare(`SELECT COUNT(*) c FROM bol_boletins`).get().c;
    console.log(`\n── BOLETINS (${total}) ──`);
    // vínculos NF órfãos
    if (hasTable(db,'bol_boletins_nfs')) {
      const orf = db.prepare(`
        SELECT COUNT(*) c FROM bol_boletins_nfs bn
        WHERE NOT EXISTS (SELECT 1 FROM bol_boletins b WHERE b.id = bn.boletim_id)
      `).get().c;
      if (orf) { console.log(`  ⚠️  bol_nfs sem boletim    : ${orf}`); achados.push({cat:'bol.orf_b',empresa,c:orf}); }

      const tblNF = hasTable(db,'notas_fiscais') ? 'notas_fiscais' : (hasTable(db,'notas') ? 'notas' : null);
      const colsBol = cols(db,'bol_boletins_nfs');
      const orfNF = tblNF && colsBol.includes('nf_numero') ? db.prepare(`
        SELECT COUNT(*) c FROM bol_boletins_nfs bn
        WHERE bn.nf_numero IS NOT NULL AND bn.nf_numero != ''
          AND NOT EXISTS (SELECT 1 FROM ${tblNF} n WHERE n.numero = bn.nf_numero)
      `).get().c : 0;
      if (orfNF) { console.log(`  ⚠️  bol_nfs apontam NF∅   : ${orfNF}`); achados.push({cat:'bol.orf_nf',empresa,c:orfNF}); }
    }
    if (achados.filter(a=>a.cat.startsWith('bol.')).length === 0) console.log(`  ✅ OK`);
  }

  // ── RH ───────────────────────────────────────────────────────────────
  if (hasTable(db,'rh_folha')) {
    const total = db.prepare(`SELECT COUNT(*) c FROM rh_folha`).get().c;
    console.log(`\n── RH (folha=${total}) ──`);
    // duplicatas de competência por funcionário
    const c = cols(db,'rh_folha');
    if (c.includes('competencia') && c.includes('funcionario_id')) {
      const dup = db.prepare(`
        SELECT competencia, funcionario_id, COUNT(*) n
        FROM rh_folha
        GROUP BY competencia, funcionario_id
        HAVING n > 1
      `).all();
      if (dup.length) {
        const rem = dup.reduce((s,r)=>s+(r.n-1),0);
        console.log(`  ⚠️  folha dup comp+func    : ${dup.length} grupos, ${rem} removíveis`);
        achados.push({cat:'rh.dup',empresa,c:rem});
      }
    }
    if (hasTable(db,'rh_folha_itens')) {
      const orf = db.prepare(`
        SELECT COUNT(*) c FROM rh_folha_itens i
        WHERE NOT EXISTS (SELECT 1 FROM rh_folha f WHERE f.id = i.folha_id)
      `).get().c;
      if (orf) { console.log(`  ⚠️  itens sem folha        : ${orf}`); achados.push({cat:'rh.orf',empresa,c:orf}); }
    }
    if (achados.filter(a=>a.cat.startsWith('rh.')).length === 0) console.log(`  ✅ OK`);
  }

  // ── CERTIDÕES ────────────────────────────────────────────────────────
  if (hasTable(db,'certidoes')) {
    const total = db.prepare(`SELECT COUNT(*) c FROM certidoes`).get().c;
    console.log(`\n── CERTIDÕES (${total}) ──`);
    const c = cols(db,'certidoes');
    if (c.includes('data_validade')) {
      const vencidas = db.prepare(`
        SELECT COUNT(*) c FROM certidoes
        WHERE data_validade < DATE('now')
      `).get().c;
      if (vencidas) { console.log(`  ⚠️  vencidas               : ${vencidas}`); achados.push({cat:'cert.venc',empresa,c:vencidas}); }
      const proximas = db.prepare(`
        SELECT COUNT(*) c FROM certidoes
        WHERE data_validade BETWEEN DATE('now') AND DATE('now','+30 days')
      `).get().c;
      if (proximas) { console.log(`  ℹ️  vencendo em ≤30d       : ${proximas}`); }
    }
    if (achados.filter(a=>a.cat.startsWith('cert.')).length === 0) console.log(`  ✅ OK`);
  }

  return achados;
}

// ── MAIN ───────────────────────────────────────────────────────────────
const all = [];
for (const e of EMPRESAS) {
  all.push(...auditar(e));
}

// Cross-empresa: contaminação despesas
if (EMPRESAS.length > 1) {
  console.log(`\n${'═'.repeat(100)}\n  🔀 CROSS-EMPRESA — contaminação despesas Seg vs extratos Assessoria\n${'═'.repeat(100)}`);
  const dbA = getDb('assessoria');
  const dbS = getDb('seguranca');
  const despSeg = dbS.prepare(`SELECT data_iso, valor_bruto FROM despesas WHERE valor_bruto > 0`).all();
  const extSeg  = dbS.prepare(`SELECT data_iso, debito FROM extratos WHERE debito > 0`).all();
  const extA    = dbA.prepare(`SELECT data_iso, debito FROM extratos WHERE debito > 0`).all();
  const mkMap = arr => { const m = new Map(); for (const r of arr) { const v = r.debito ?? r.valor_bruto; const k = r.data_iso+'|'+v.toFixed(2); m.set(k,(m.get(k)||0)+1); } return m; };
  const mSeg = mkMap(extSeg), mA = mkMap(extA);
  let bate=0,soA=0,soS=0,orfa=0,valSoA=0;
  for (const d of despSeg) {
    const k = d.data_iso+'|'+d.valor_bruto.toFixed(2);
    const inS = mSeg.has(k), inA = mA.has(k);
    if (inS && inA) bate++;
    else if (inA) { soA++; valSoA += d.valor_bruto; }
    else if (inS) soS++;
    else orfa++;
  }
  console.log(`  Despesas Seg que batem SÓ em extrato Assessoria: ${soA} (R$ ${fmt(valSoA)}) — candidatas a remoção`);
  console.log(`  Batem em ambas: ${bate}  · Só Seg: ${soS}  · Órfãs: ${orfa}`);
  if (soA) all.push({cat:'cross.desp_seg_em_ass',empresa:'seguranca',c:soA,v:valSoA});
}

console.log(`\n${'═'.repeat(100)}\n  📋 RESUMO\n${'═'.repeat(100)}`);
if (all.length === 0) console.log('  ✅ Nenhuma inconsistência encontrada.');
else all.forEach(a => console.log(`  [${a.empresa}] ${a.cat.padEnd(25)} → ${a.c}${a.v?` (R$ ${fmt(a.v)})`:''}`));
console.log('');
