'use strict';
/**
 * Importa extrato BRB a partir de texto copiado do PDF ou arquivo .txt/.csv
 *
 * Formatos suportados:
 *  A) Texto copiado do PDF BRB (extrato conta corrente):
 *       02/03/2026  000000  SALDO ANTERIOR                              0,00        10.000,00
 *       03/03/2026  160512  ORDEM BANCARIA UFNT                                     358.943,33
 *       ...
 *
 *  B) CSV BRB exportado (separado por ; ou tab):
 *       Data;Documento;Histórico;Débito;Crédito
 *       02/03/2026;000000;ORDEM BANCARIA;0,00;358.943,33
 *
 * Uso:
 *   node scripts/importar_extrato_brb_txt.js --arquivo="C:\...\extrato_brb.txt" --empresa=assessoria --mes=2026-03
 *   node scripts/importar_extrato_brb_txt.js --arquivo="C:\...\extrato_brb.txt" --empresa=seguranca --mes=2026-04
 *   node scripts/importar_extrato_brb_txt.js --arquivo="..." --empresa=assessoria --mes=2026-03 --dry-run
 *
 * Conta BRB Assessoria (UFNT): preencher --conta=<numero>
 * Conta BRB Segurança:         preencher --conta=031.015.474-0
 */
const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

// ── Args ────────────────────────────────────────────────────────────────────
const ARG     = process.argv.slice(2);
const arg     = (k, def = '') => {
  const found = ARG.find(a => a.startsWith(`--${k}=`));
  return found ? found.slice(k.length + 3) : def;
};
const ARQUIVO = arg('arquivo');
const EMPRESA = arg('empresa', 'assessoria');
const MES     = arg('mes', '');         // ex: 2026-03
const CONTA   = arg('conta', 'BRB');
const DRY     = ARG.includes('--dry-run');
const FORCE   = ARG.includes('--force'); // importa mesmo duplicatas (ignora hash)

if (!ARQUIVO) {
  console.error('❌  Informe --arquivo="caminho/extrato.txt"');
  console.error('    Uso: node scripts/importar_extrato_brb_txt.js --arquivo="..." --empresa=assessoria --mes=2026-03');
  process.exit(1);
}
if (!fs.existsSync(ARQUIVO)) {
  console.error('❌  Arquivo não encontrado:', ARQUIVO);
  process.exit(1);
}

// ── Utilitários ──────────────────────────────────────────────────────────────
const MESES_PT = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

function parseBRL(s) {
  if (!s || !s.trim()) return null;
  // Remove separador de milhar (.) e troca vírgula por ponto
  const v = s.trim().replace(/\./g, '').replace(',', '.');
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function dataBR2ISO(dataBR) {
  // aceita DD/MM/AAAA ou DD/MM/AA
  const parts = dataBR.trim().split('/');
  if (parts.length < 3) return null;
  let [d, m, a] = parts;
  if (a.length === 2) a = '20' + a;
  return `${a}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

function derivarMes(iso) {
  const p = iso.split('-');
  return `${MESES_PT[parseInt(p[1]) - 1]}/${p[0]}`;
}

// ── Parser ───────────────────────────────────────────────────────────────────
function parsearLinhas(texto) {
  const lancamentos = [];
  const linhas = texto.split(/\r?\n/);

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i].trim();
    if (!linha) continue;

    // ── Formato CSV (separado por ; ou \t) ─────────────────────────────────
    if (linha.includes(';') || linha.includes('\t')) {
      const sep = linha.includes(';') ? ';' : '\t';
      const cols = linha.split(sep).map(s => s.trim());
      // Cabeçalho?
      if (/data/i.test(cols[0]) || /^\s*$/.test(cols[0])) continue;
      // cols: [data, doc, historico, debito, credito]  ou  [data, historico, debito, credito]
      let dataStr, historico, debStr, creStr;
      if (cols.length >= 5) {
        [dataStr, , historico, debStr, creStr] = cols;
      } else if (cols.length === 4) {
        [dataStr, historico, debStr, creStr] = cols;
      } else continue;

      const data_iso = dataBR2ISO(dataStr);
      if (!data_iso) continue;
      const debito  = parseBRL(debStr);
      const credito = parseBRL(creStr);
      if (debito == null && credito == null) continue;
      lancamentos.push({ data_iso, historico: historico || '', debito, credito });
      continue;
    }

    // ── Formato texto livre (PDF copiado) ──────────────────────────────────
    // Padrão BRB: DD/MM/AAAA  [DOC]  HISTORICO  [DEBITO]  [CREDITO]  [SALDO]
    // Os valores podem estar na mesma linha ou em subcampos
    // Regex: captura data + resto
    const mData = linha.match(/^(\d{2}\/\d{2}\/\d{4})\s+(.*)/);
    if (!mData) {
      // Tenta DD/MM sem ano (BRB às vezes omite o ano)
      const mData2 = linha.match(/^(\d{2}\/\d{2})\s+(.*)/);
      if (mData2 && MES) {
        const ano = MES.split('-')[0];
        const mm  = MES.split('-')[1];
        const dataBR = `${mData2[1]}/${ano}`;
        // só inclui se o mês confere
        const mCheck = mData2[1].split('/')[1];
        if (mCheck !== mm) continue;
        processarRestoLinha(`${dataBR} ${mData2[2]}`, dataBR2ISO(dataBR), lancamentos);
        continue;
      }
      continue;
    }

    const data_iso = dataBR2ISO(mData[1]);
    if (!data_iso) continue;
    if (MES && !data_iso.startsWith(MES)) continue; // filtra mês se informado

    processarRestoLinha(mData[2], data_iso, lancamentos);
  }

  return lancamentos;
}

/**
 * Processa a parte depois da data numa linha de extrato BRB texto livre.
 * Tenta extrair: [doc/num]  HISTORICO  [debito]  [credito]  [saldo]
 */
function processarRestoLinha(resto, data_iso, lancamentos) {
  // Remove número de documento inicial (6+ dígitos ou "-")
  const semDoc = resto.replace(/^\d{5,10}\s+/, '').replace(/^-\s+/, '');

  // Encontra números monetários no formato BRL no final da linha
  // Ex: "ORDEM BANCARIA UFT    0,00    358.943,33    400.000,00"
  const numPattern = /(\d{1,3}(?:\.\d{3})*,\d{2})/g;
  const nums = [];
  let m;
  let lastIdx = 0;
  while ((m = numPattern.exec(semDoc)) !== null) {
    nums.push({ val: parseBRL(m[1]), idx: m.index });
    lastIdx = m.index + m[0].length;
  }

  if (nums.length === 0) return; // linha sem valor monetário

  // Historico = tudo antes do primeiro número
  const historico = semDoc.slice(0, nums[0].idx).trim().replace(/\s{2,}/g, ' ');

  // Ignore linhas de saldo/totais
  if (/saldo anterior|saldo final|total|resumo|encerramento/i.test(historico)) return;

  let debito = null, credito = null;

  if (nums.length === 1) {
    // Só 1 número: detecta pela posição na linha ou pelo histórico
    // Créditos BRB costumam ter keywords
    if (/RESGATE|CRED|RECEB|ORD BAN|OB |ORDEM BANC|PIX CR|DOC CR|TED CR|DEPOSIT/i.test(historico)) {
      credito = nums[0].val;
    } else {
      debito = nums[0].val;
    }
  } else if (nums.length === 2) {
    // [debito, credito] ou [credito, saldo] — heurística: se 1º = 0 → crédito no 2º
    if (nums[0].val === 0) {
      credito = nums[1].val;
    } else if (nums[1].val === 0) {
      debito = nums[0].val;
    } else {
      // Dois valores reais: 1º=débito, 2º=crédito (padrão BRB extrato conta corrente)
      if (nums[0].val > 0) debito = nums[0].val;
      if (nums[1].val > 0) credito = nums[1].val;
    }
  } else if (nums.length >= 3) {
    // [debito, credito, saldo] — padrão BRB
    if (nums[0].val > 0) debito  = nums[0].val;
    if (nums[1].val > 0) credito = nums[1].val;
    // nums[2] = saldo (ignora)
  }

  if (debito == null && credito == null) return;
  lancamentos.push({ data_iso, historico, debito, credito });
}

// ── Execução ─────────────────────────────────────────────────────────────────
const texto = fs.readFileSync(ARQUIVO, { encoding: 'utf8' });
const lancamentos = parsearLinhas(texto);

console.log(`\n📋  Importar Extrato BRB — empresa=${EMPRESA} | conta=${CONTA}${DRY ? ' [DRY-RUN]' : ''}`);
console.log(`    Arquivo: ${path.basename(ARQUIVO)}`);
console.log(`    Lançamentos parseados: ${lancamentos.length}\n`);

// Preview
const creditos = lancamentos.filter(l => l.credito > 0);
const debitos  = lancamentos.filter(l => l.debito  > 0);
console.log(`    Créditos: ${creditos.length} — R$ ${creditos.reduce((s,l) => s + (l.credito||0), 0).toLocaleString('pt-BR',{minimumFractionDigits:2})}`);
console.log(`    Débitos : ${debitos.length} — R$ ${debitos.reduce((s,l) => s + (l.debito||0), 0).toLocaleString('pt-BR',{minimumFractionDigits:2})}`);

console.log('\n    Prévia (primeiros 15):');
lancamentos.slice(0, 15).forEach(l => {
  const val = l.credito ? `CR R$${l.credito.toLocaleString('pt-BR',{minimumFractionDigits:2})}` :
                          `DB R$${l.debito.toLocaleString('pt-BR',{minimumFractionDigits:2})}`;
  console.log(`      ${l.data_iso}  ${val.padEnd(25)}  ${l.historico}`);
});
if (lancamentos.length > 15) console.log(`      ... (${lancamentos.length - 15} mais)`);

if (DRY || lancamentos.length === 0) {
  if (lancamentos.length === 0) console.log('\n  ⚠️  Nenhum lançamento encontrado. Verifique o formato do arquivo.');
  else console.log('\n  ⚠️  Modo DRY-RUN — nada gravado. Remova --dry-run para importar.');
  process.exit(0);
}

// ── Gravar ───────────────────────────────────────────────────────────────────
const db = getDb(EMPRESA);

// Garante coluna banco se não existir
try { db.exec('ALTER TABLE extratos ADD COLUMN banco TEXT DEFAULT "BB"'); } catch (_) {}
try { db.exec('ALTER TABLE extratos ADD COLUMN conta TEXT DEFAULT ""'); } catch (_) {}
try { db.exec('ALTER TABLE extratos ADD COLUMN bb_hash TEXT'); } catch (_) {}

const stmtIns = db.prepare(`
  INSERT OR IGNORE INTO extratos
    (mes, data, data_iso, tipo, historico, debito, credito,
     banco, conta, status_conciliacao, bb_hash, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'BRB', ?, 'PENDENTE', ?, datetime('now'), datetime('now'))
`);

let importados = 0, duplicatas = 0;

db.transaction(() => {
  for (const l of lancamentos) {
    const p       = l.data_iso.split('-');
    const dataBR  = `${p[2]}/${p[1]}/${p[0]}`;
    const mes     = derivarMes(l.data_iso);
    const tipo    = l.credito ? 'C' : 'D';
    // hash simples para dedup (data + valor + historico)
    const hashStr = `${l.data_iso}|${l.historico}|${l.debito ?? ''}|${l.credito ?? ''}`;
    const { createHash } = require('crypto');
    const hashVal = createHash('md5').update(hashStr).digest('hex');

    const r = stmtIns.run(
      mes, dataBR, l.data_iso, tipo, l.historico,
      l.debito, l.credito,
      CONTA,
      FORCE ? null : hashVal   // null = não dedup se --force
    );
    if (r.changes > 0) {
      importados++;
      const val = l.credito ? `CR R$${l.credito.toLocaleString('pt-BR',{minimumFractionDigits:2})}` :
                              `DB R$${l.debito.toLocaleString('pt-BR',{minimumFractionDigits:2})}`;
      console.log(`  ✅ ${l.data_iso}  ${val.padEnd(25)}  ${l.historico}`);
    } else {
      duplicatas++;
    }
  }
})();

console.log(`\n${'─'.repeat(60)}`);
console.log(`  ✅ Importados : ${importados}`);
console.log(`  ⏭️  Duplicatas : ${duplicatas}`);

if (importados > 0) {
  const total = db.prepare(
    `SELECT COUNT(*) c, SUM(credito) cr FROM extratos WHERE banco='BRB' AND data_iso LIKE '${MES || '%'}%'`
  ).get();
  console.log(`\n  BRB no banco (${MES || 'todos meses'}): ${total.c} lançamentos | R$${(total.cr||0).toLocaleString('pt-BR',{minimumFractionDigits:2})} créditos`);
}

console.log('\n✔️  Concluído.');
