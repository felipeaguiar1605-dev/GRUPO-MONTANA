#!/usr/bin/env node
/**
 * Popular abril/2026 Segurança a partir dos extratos recém-importados.
 *
 * Etapas (nesta ordem):
 *   1) Marca créditos de aplicação/resgate (BB Rende, CDB, Aplic/Resg Autom) como INVESTIMENTO
 *      e Pix/TED entre contas Montana como INTERNO — só afeta créditos PENDENTE de abril/2026.
 *   2) Popula a tabela `despesas` a partir de débitos dos extratos de abril/2026,
 *      ignorando aplicações, intragrupo e saldos. Auto-categoriza:
 *         - DARF/Imposto             → "Impostos"
 *         - FGTS / CEF MATRIZ        → "FGTS"
 *         - Folha de Pagamento       → "FOLHA"
 *         - Pix Enviado              → "PIX_ENVIADO"
 *         - Pagamento de Boleto      → "BOLETOS"
 *         - TED Transf.Eletr         → "TED"
 *         - Tarifa                   → "TARIFAS"
 *         - default                  → "OUTROS"
 *      INSERT OR IGNORE via dedup_hash (md5 de data+valor+fornecedor+descrição).
 *   3) (Opcional) Chama `conciliacao_seguranca.js` para tentar casar NFs↔extratos do mês.
 *
 * Uso:
 *   node scripts/popular_abril_seguranca.js                     # dry-run (mostra o que faria)
 *   node scripts/popular_abril_seguranca.js --apply             # aplica 1 e 2
 *   node scripts/popular_abril_seguranca.js --apply --conciliar # aplica 1, 2 e 3
 *   node scripts/popular_abril_seguranca.js --empresa=seguranca --de=2026-04-01 --ate=2026-04-30
 */
'use strict';
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const args = process.argv.slice(2);
const APPLY     = args.includes('--apply');
const CONCILIAR = args.includes('--conciliar');
const EMPRESA   = (args.find(a => a.startsWith('--empresa=')) || '--empresa=seguranca').split('=')[1];
const DE        = (args.find(a => a.startsWith('--de='))      || '--de=2026-04-01').split('=')[1];
const ATE       = (args.find(a => a.startsWith('--ate='))     || '--ate=2026-04-30').split('=')[1];

const fmt = v => (v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
const db = getDb(EMPRESA);

console.log('═'.repeat(80));
console.log(`  POPULAR ${EMPRESA.toUpperCase()} — ${DE} → ${ATE}   ${APPLY?'[APPLY]':'[DRY-RUN]'}`);
console.log('═'.repeat(80));

// ──────────────────────────────────────────────────────────────────────────────
// ETAPA 1 — Classificar créditos (INVESTIMENTO / INTERNO)
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n[1] Classificar créditos PENDENTE de aplicação/resgate/intragrupo');

const PAL_INV = ['BB RENDE FACIL','RENDE FACIL','RENDE F','RESGATE CDB','RESGATE LCI','RESGATE LCA',
                 'RESGATE BB CDB','RESGATE DEP','CDB DI BB','CDB DI','APLIC.AUTOM','APLIC AUTOM',
                 'APLIC.BB','APLIC BB','RESG.AUTOM','RESG AUTOM','INVEST. RESGATE AUTOM','INVEST. APLIC'];
const PAL_INT = ['MONTANA SEG','MONTANA ASSESSORIA','MONTANA VIGILANCIA','MONTANA S LTDA','MONTANA SERVICOS',
                 'MONTANA SERV','19200109000109','14092519000151','TRANSFERENCIA ENTRE CONTAS',
                 'ENTRE CONTAS PROPRIAS','TED ENTRE CONTAS','TRANSFERENCIA INTERNA','TRANSFER INTERNA'];

const likeOr   = arr => arr.map(_ => 'UPPER(historico) LIKE ?').join(' OR ');
const likeVals = arr => arr.map(p => `%${p}%`);

const countInv = db.prepare(`
  SELECT COUNT(*) qtd, COALESCE(SUM(credito),0) total FROM extratos
  WHERE credito>0 AND (status_conciliacao IS NULL OR status_conciliacao IN ('PENDENTE',''))
    AND data_iso BETWEEN ? AND ? AND (${likeOr(PAL_INV)})
`).get(DE, ATE, ...likeVals(PAL_INV));
const countInt = db.prepare(`
  SELECT COUNT(*) qtd, COALESCE(SUM(credito),0) total FROM extratos
  WHERE credito>0 AND (status_conciliacao IS NULL OR status_conciliacao IN ('PENDENTE',''))
    AND data_iso BETWEEN ? AND ? AND (${likeOr(PAL_INT)})
`).get(DE, ATE, ...likeVals(PAL_INT));

console.log(`   INVESTIMENTO (aplic/resgate): ${countInv.qtd} créditos · R$ ${fmt(countInv.total)}`);
console.log(`   INTERNO      (intragrupo):    ${countInt.qtd} créditos · R$ ${fmt(countInt.total)}`);

if (APPLY) {
  const rInv = db.prepare(`
    UPDATE extratos SET status_conciliacao='INVESTIMENTO'
    WHERE credito>0 AND (status_conciliacao IS NULL OR status_conciliacao IN ('PENDENTE',''))
      AND data_iso BETWEEN ? AND ? AND (${likeOr(PAL_INV)})
  `).run(DE, ATE, ...likeVals(PAL_INV));
  const rInt = db.prepare(`
    UPDATE extratos SET status_conciliacao='INTERNO'
    WHERE credito>0 AND (status_conciliacao IS NULL OR status_conciliacao IN ('PENDENTE',''))
      AND data_iso BETWEEN ? AND ? AND (${likeOr(PAL_INT)})
  `).run(DE, ATE, ...likeVals(PAL_INT));
  console.log(`   ✅ ${rInv.changes} marcados INVESTIMENTO, ${rInt.changes} marcados INTERNO`);
}

// ──────────────────────────────────────────────────────────────────────────────
// ETAPA 2 — Popular `despesas` a partir de débitos dos extratos
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n[2] Popular despesas a partir dos débitos dos extratos');

// Exclusões: aplicações financeiras, intragrupo, saldos
const EXCLUI_DEB = ['BB RENDE','RENDE FACIL','CDB','APLICAC','APLIC.AUTOM','APLIC BB','INVEST','RESG.AUTOM',
                    'RESG AUTOM','INVEST. APLIC','S A L D O','SALDO ANTERIOR','SALDO DO DIA',
                    'MESMA TITULARIDADE','MONTANA SEG','MONTANA ASSESSORIA','MONTANA S LTDA',
                    'MONTANA SERVICOS','MONTANA VIGILANCIA','19200109000109','14092519000151',
                    'TED MESMA','TRANSFER.INTERNA','ENTRE CONTAS PROPRIAS','TED ENTRE CONTAS',
                    'PORTO V S PR','PORTO DO VAU','PORTO VAU','NEVADA M LIMP','MUSTANG'];

const rowsDeb = db.prepare(`
  SELECT id, data_iso, data, historico, debito
  FROM extratos
  WHERE debito > 0 AND data_iso BETWEEN ? AND ?
    AND NOT (${EXCLUI_DEB.map(_=>'UPPER(historico) LIKE ?').join(' OR ')})
  ORDER BY data_iso, id
`).all(DE, ATE, ...EXCLUI_DEB.map(p=>`%${p}%`));

function categorizar(historico) {
  const h = (historico||'').toUpperCase();
  if (/DARF|RFB|IMPOSTO|RECEITA FEDERAL|ICMS|ISS/.test(h))        return 'Impostos';
  if (/FGTS|CEF MATRIZ|CAIXA ECONOM/.test(h))                     return 'FGTS';
  if (/FOLHA DE PAGAMENTO|PAGAMENTO SALARIO|PAG SALAR/.test(h))   return 'FOLHA';
  if (/PIX.*ENVIADO|PIX ENVIADO/.test(h))                          return 'PIX_ENVIADO';
  if (/PAGAMENTO DE BOLETO|PAG\.? ?BOLETO/.test(h))                return 'BOLETOS';
  if (/TED.*TRANSF|TED TRANSF|TED ENVIADA|TED-DEBIT/.test(h))      return 'TED';
  if (/TARIFA|TAR\. |TAR PAG|TAR DOC/.test(h))                     return 'TARIFAS';
  if (/INSS/.test(h))                                              return 'INSS';
  if (/ENERGIA|TELEFONIA|INTERNET|AGUA|ESGOTO|UTILIDADE/.test(h))  return 'UTILIDADES';
  if (/CONSORCIO/.test(h))                                         return 'CONSORCIO';
  return 'OUTROS';
}

function md5(s){ return crypto.createHash('md5').update(s).digest('hex'); }
function dedupHash(empresa, data_iso, valor, fornecedor, descricao){
  return md5(`${empresa}|${data_iso}|${(+valor).toFixed(2)}|${(fornecedor||'').trim().toUpperCase()}|${(descricao||'').trim().toUpperCase()}`);
}

// Sumário por categoria (preview)
const porCat = {};
for (const r of rowsDeb) {
  const c = categorizar(r.historico);
  if (!porCat[c]) porCat[c] = { qtd:0, total:0 };
  porCat[c].qtd++; porCat[c].total += r.debito;
}
console.log(`   Débitos candidatos: ${rowsDeb.length}`);
for (const [c,v] of Object.entries(porCat).sort((a,b)=>b[1].total-a[1].total))
  console.log(`     ${c.padEnd(14)}  ${String(v.qtd).padStart(4)}×  R$ ${fmt(v.total)}`);

// Checa existência de dedup_hash e cria se necessário
const despCols = db.prepare(`PRAGMA table_info(despesas)`).all().map(c=>c.name);
if (!despCols.includes('dedup_hash')) {
  if (APPLY) db.exec(`ALTER TABLE despesas ADD COLUMN dedup_hash TEXT`);
  console.log('   (+ coluna dedup_hash criada)');
}

if (APPLY) {
  const ins = db.prepare(`
    INSERT OR IGNORE INTO despesas
      (categoria, descricao, fornecedor, cnpj_fornecedor, nf_numero, data_despesa, data_iso, competencia,
       valor_bruto, irrf, csll, pis_retido, cofins_retido, inss_retido, iss_retido, total_retencao,
       valor_liquido, status, obs, contrato_ref, centro_custo, dedup_hash)
    VALUES (@cat, @desc, '', '', '', @data, @iso, @comp,
            @val, 0, 0, 0, 0, 0, 0, 0,
            @val, 'IMPORTADO', @obs, '', '', @hash)
  `);
  let ok = 0, dup = 0;
  const comp = `${['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][+DE.slice(5,7)-1]}/${DE.slice(2,4)}`;
  db.transaction(() => {
    for (const r of rowsDeb) {
      const cat  = categorizar(r.historico);
      const iso  = r.data_iso;
      const hash = dedupHash(EMPRESA, iso, r.debito, '', r.historico||'');
      const info = ins.run({
        cat, desc: r.historico || '', data: r.data || iso, iso, comp,
        val: r.debito, obs: `extrato_id=${r.id}`, hash
      });
      if (info.changes>0) ok++; else dup++;
    }
  })();
  console.log(`   ✅ ${ok} despesas inseridas · ${dup} duplicadas (dedup_hash)`);
}

// ──────────────────────────────────────────────────────────────────────────────
// ETAPA 3 — Conciliação (opcional)
// ──────────────────────────────────────────────────────────────────────────────
if (CONCILIAR && APPLY) {
  console.log('\n[3] Executando conciliacao_seguranca.js');
  const r = spawnSync('node', [path.join(__dirname, 'conciliacao_seguranca.js')],
                      { stdio: 'inherit' });
  if (r.status !== 0) console.log(`   ⚠️ conciliacao terminou com status ${r.status}`);
} else if (CONCILIAR) {
  console.log('\n[3] Conciliação: exige --apply; pulado em dry-run.');
}

console.log('\n' + '═'.repeat(80));
console.log(APPLY ? '  ✅ APPLY concluído' : '  (DRY-RUN — use --apply para gravar)');
console.log('═'.repeat(80));
