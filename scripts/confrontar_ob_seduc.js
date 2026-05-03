'use strict';
/**
 * Confrontação das OBs do SIAFE-TO (SEDUC) com as NFs e extratos do Grupo Montana.
 *
 * Para cada OB lida do JSON (_obs_parseadas.json):
 *   • se categoria = PAGAMENTO   → match na tabela notas_fiscais + extratos
 *   • se categoria = IRRF/INSS/ISS → atualiza a NF correspondente nos campos iss/ir/inss
 *   • grava entry em pagamentos_portal com portal='estadual-to-seduc'
 *   • associa OB → NF → extrato quando possível
 *
 * Uso:
 *   node scripts/confrontar_ob_seduc.js [--apply]
 *     (sem --apply = dry-run, só mostra o relatório; com --apply = grava no DB)
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const JSON_PATH = path.join(__dirname, '..', 'tmp_ob_seduc', '_obs_parseadas.json');

function brl(n) {
  return Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function competenciaToISO(comp) {
  // "08/2025" → "2025-08"
  const m = String(comp).match(/^(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[2]}-${m[1].padStart(2,'0')}`;
}

function dataObToISO(emissao) {
  // "12/08/25" → "2025-08-12"
  const m = String(emissao).match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
  if (!m) return null;
  const yy = m[3].length === 2 ? '20' + m[3] : m[3];
  return `${yy}-${m[2]}-${m[1]}`;
}

function main() {
  if (!fs.existsSync(JSON_PATH)) {
    console.error('❌ JSON de OBs não encontrado. Rode antes: python scripts/parsear_ob_seduc.py');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
  const obs = data.obs;
  console.log(`\n📄 OBs carregadas: ${obs.length} (únicas após dedupe)`);

  // Separa por empresa
  const porEmpresa = { assessoria: [], seguranca: [] };
  for (const ob of obs) {
    const e = ob.empresa;
    if (e && porEmpresa[e]) porEmpresa[e].push(ob);
  }
  console.log(`   Assessoria: ${porEmpresa.assessoria.length}`);
  console.log(`   Segurança:  ${porEmpresa.seguranca.length}\n`);

  const resumo = {};

  for (const emp of ['assessoria','seguranca']) {
    if (porEmpresa[emp].length === 0) continue;
    console.log('═'.repeat(110));
    console.log(`  EMPRESA: ${emp.toUpperCase()}`);
    console.log('═'.repeat(110));

    const db = getDb(emp);

    // Carregar NFs SEDUC de 2025+ ordenadas por número
    const nfs = db.prepare(`
      SELECT id, numero, competencia, valor_bruto, valor_liquido, tomador, discriminacao, iss, ir, inss
      FROM notas_fiscais
      WHERE tomador LIKE '%SEDUC%' OR tomador LIKE '%SECRETARIA%EDUC%'
    `).all();

    const nfPorNumero = {};
    for (const nf of nfs) {
      // extrair últimos 6 dígitos como "número curto"
      const numCurto = (nf.numero || '').replace(/\D/g,'').slice(-6).padStart(6,'0');
      if (!nfPorNumero[numCurto]) nfPorNumero[numCurto] = [];
      nfPorNumero[numCurto].push(nf);
    }
    console.log(`  NFs SEDUC carregadas do DB: ${nfs.length}`);

    // ── Pré-passo: construir índice (emissão+competência) → NFs das RETENÇÕES
    //   Se uma OB PAGAMENTO não cita NF mas há retenção irmã no mesmo lote,
    //   empresta as NFs da retenção (mapeamento "LOTE").
    const loteNFs = {};  // key: `${emissao}|${competencia}` → Set de NFs citadas
    for (const ob of porEmpresa[emp]) {
      if (ob.categoria === 'PAGAMENTO') continue;  // só retenções
      const k = `${ob.emissao}|${ob.competencia || ''}`;
      if (!loteNFs[k]) loteNFs[k] = new Set();
      (ob.nfs || []).forEach(n => loteNFs[k].add(n));
    }

    // ── Para cada OB, tentar mapear
    const stats = { pag_matched: 0, pag_no_nf: 0, pag_lote: 0, ret_matched: 0, ret_no_nf: 0 };
    const linhas = [];

    for (const ob of porEmpresa[emp].sort((a,b) => a.numero_ob.localeCompare(b.numero_ob))) {
      const cat = ob.categoria;
      const dt_iso = dataObToISO(ob.emissao);
      const comp_iso = competenciaToISO(ob.competencia);
      const nfsCitadas = ob.nfs || [];
      // normalizar para 6 dígitos
      const nfsNorm = nfsCitadas
        .map(n => n.replace(/\D/g,'').slice(-6).padStart(6,'0'))
        .filter(n => n !== '000000');
      const nfsUnicas = [...new Set(nfsNorm)];

      // Localizar NFs correspondentes
      let nfsDB = [];
      for (const n of nfsUnicas) {
        const cand = nfPorNumero[n] || [];
        // filtra pela competência OB (se houver)
        const matching = comp_iso
          ? cand.filter(c => c.competencia && (
              c.competencia.startsWith(comp_iso) ||
              c.competencia.replace('/', '-').includes(comp_iso.slice(2)) ||
              c.competencia.toLowerCase().includes(['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][parseInt(comp_iso.slice(5))-1])
            ))
          : cand;
        nfsDB.push(...(matching.length ? matching : cand));
      }

      let nfsDB_unicas = [...new Map(nfsDB.map(n => [n.id, n])).values()];
      let viaLote = false;

      // Fallback: se PAGAMENTO sem NF cita mas há retenção irmã no mesmo emissao|comp → usa NFs do lote
      if (cat === 'PAGAMENTO' && nfsDB_unicas.length === 0) {
        const k = `${ob.emissao}|${ob.competencia || ''}`;
        const nfsLote = loteNFs[k];
        if (nfsLote && nfsLote.size) {
          const nfsLoteNorm = [...nfsLote]
            .map(n => n.replace(/\D/g,'').slice(-6).padStart(6,'0'))
            .filter(n => n !== '000000');
          for (const n of nfsLoteNorm) {
            const cand = nfPorNumero[n] || [];
            nfsDB.push(...cand);
          }
          nfsDB_unicas = [...new Map(nfsDB.map(n => [n.id, n])).values()];
          if (nfsDB_unicas.length) viaLote = true;
        }
      }

      const status = (cat === 'PAGAMENTO')
        ? (nfsDB_unicas.length ? (viaLote ? '🔸 LOTE' : '✅ MATCH') : '⚠️  sem NF')
        : (nfsDB_unicas.length ? '🔹 RET→NF' : '❓ RET s/NF');

      if (cat === 'PAGAMENTO') {
        if (nfsDB_unicas.length) {
          stats.pag_matched++;
          if (viaLote) stats.pag_lote++;
        }
        else stats.pag_no_nf++;
      } else {
        if (nfsDB_unicas.length) stats.ret_matched++;
        else stats.ret_no_nf++;
      }

      linhas.push({
        ob: ob.numero_ob,
        cat,
        dt: ob.emissao,
        valor: ob.valor,
        comp: ob.competencia,
        nfs_citadas: nfsUnicas,
        nfs_db: nfsDB_unicas.map(n => ({ id: n.id, numero: n.numero, bruto: n.valor_bruto, comp: n.competencia })),
        status,
        empenho: ob.empenho_ne,
        nl: ob.nota_liq_nl,
        categoria_ret: cat === 'PAGAMENTO' ? null : cat,
      });

      console.log(
        '  ' + ob.numero_ob.padEnd(14) +
        ' | ' + cat.padEnd(9) +
        ' | ' + ob.emissao.padEnd(9) +
        ' | R$ ' + brl(ob.valor).padStart(14) +
        ' | comp=' + (ob.competencia || '—').padEnd(8) +
        ' | NF_DB=[' + nfsDB_unicas.map(n => n.numero.replace(/\D/g,'').slice(-4)).join(',') + ']'.padEnd(12) +
        ' | ' + status
      );
    }

    console.log('\n  Resumo ' + emp.toUpperCase() + ':');
    console.log(`    Pagamentos com match NF: ${stats.pag_matched}  (${stats.pag_lote} via LOTE/retenção irmã)`);
    console.log(`    Pagamentos sem NF:       ${stats.pag_no_nf}`);
    console.log(`    Retenções com match NF:  ${stats.ret_matched}`);
    console.log(`    Retenções sem NF:        ${stats.ret_no_nf}`);
    resumo[emp] = { stats, linhas };

    // ─── APPLY: gravar em pagamentos_portal + atualizar NFs ─────────
    if (APPLY) {
      const existeHash = db.prepare(`SELECT id FROM pagamentos_portal WHERE hash_unico = ?`);
      const insertPortal = db.prepare(`
        INSERT INTO pagamentos_portal
          (portal, gestao, gestao_codigo, fornecedor, cnpj, cnpj_raiz, processo,
           empenho, data_empenho_iso, data_liquidacao_iso, data_pagamento_iso,
           valor_pago, fonte, fonte_det, elemento_desp, subnatureza, obs,
           nf_id, status_match, hash_unico, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const txn = db.transaction(() => {
        let inseridas = 0, jaExistia = 0;
        for (const l of resumo[emp].linhas) {
          const ob = porEmpresa[emp].find(o => o.numero_ob === l.ob);
          // nf_id: só seta se tiver 1 única NF vinculada (senão LOTE → null, detalhe no raw_json)
          const nf_id = (l.nfs_db.length === 1) ? l.nfs_db[0].id : null;
          let statusMatch;
          if (l.nfs_db.length === 1) statusMatch = 'MATCHED_NF';
          else if (l.nfs_db.length > 1) statusMatch = 'MATCHED_LOTE';
          else statusMatch = 'PENDENTE';
          const hash = require('crypto').createHash('md5')
            .update(`seduc-to|${l.ob}|${l.cat}|${l.valor}`).digest('hex');
          if (existeHash.get(hash)) { jaExistia++; continue; }
          const obEnriquecida = { ...ob, _nfs_db_ids: l.nfs_db.map(n => n.id), _nfs_db_numeros: l.nfs_db.map(n => n.numero) };
          insertPortal.run(
            'estadual-to-seduc',
            '270100 - SECRETARIA DA EDUCACAO',
            '270100',
            ob.credor_nome || '',
            ob.credor_cnpj || '',
            (ob.credor_cnpj || '').substr(0, 8),
            '202327000000120',  // processo (placeholder genérico SEDUC)
            ob.empenho_ne || '',
            '',  // empenho_iso
            '',  // liquidacao_iso
            dataObToISO(ob.emissao),
            ob.valor,
            '573', 'ROYALTIES PETROBRAS',
            '37 - LOCACAO DE MAO-DE-OBRA',
            l.categoria_ret || 'PAGAMENTO',
            (ob.observacao || '').slice(0, 500),
            nf_id,
            statusMatch,
            hash,
            JSON.stringify(obEnriquecida)
          );
          inseridas++;
        }
        console.log(`  💾 Inseridas em pagamentos_portal: ${inseridas} (${jaExistia} já existiam)`);

        // Atualizar retenções nas NFs
        let nfsAtualizadas = 0;
        const updateNF = {
          IRRF: db.prepare(`UPDATE notas_fiscais SET ir = ? WHERE id = ?`),
          INSS: db.prepare(`UPDATE notas_fiscais SET inss = ? WHERE id = ?`),
          ISS:  db.prepare(`UPDATE notas_fiscais SET iss  = ? WHERE id = ?`),
        };

        // Agregar retenções por NF (quando a OB de retenção cobre múltiplas NFs, dividimos proporcional ao bruto)
        for (const l of resumo[emp].linhas) {
          if (!['IRRF','INSS','ISS'].includes(l.cat)) continue;
          const nfs_alvo = l.nfs_db;
          if (!nfs_alvo.length) continue;
          const totalBruto = nfs_alvo.reduce((s, n) => s + (n.bruto || 0), 0);
          if (totalBruto <= 0) continue;
          for (const n of nfs_alvo) {
            const quota = (n.bruto || 0) / totalBruto;
            const valorRet = +(l.valor * quota).toFixed(2);
            updateNF[l.cat].run(valorRet, n.id);
            nfsAtualizadas++;
          }
        }
        console.log(`  💾 Retenções atribuídas a NFs: ${nfsAtualizadas}`);
      });
      txn();
    }
  }

  // Consolidado geral
  console.log('\n' + '═'.repeat(110));
  console.log('  SUMÁRIO CONSOLIDADO');
  console.log('═'.repeat(110));
  for (const emp of Object.keys(resumo)) {
    const s = resumo[emp].stats;
    console.log(`  ${emp.padEnd(12)}  pag.ok=${s.pag_matched}  pag.s/NF=${s.pag_no_nf}  ret.ok=${s.ret_matched}  ret.s/NF=${s.ret_no_nf}`);
  }
  console.log(APPLY ? '\n✅ Aplicado no banco.\n' : '\n⚠️  Dry-run. Rode com --apply para gravar.\n');
}

main();
