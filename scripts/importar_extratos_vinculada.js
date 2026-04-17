'use strict';
/**
 * Importador de extratos de Conta Vinculada (IN SEGES/MP 05/2017).
 *
 * Lê todos os PDFs da pasta `EXTRATO CONTA VINCULADA MONTANA ASSESSORIA/<orgao>/*.pdf`
 * e grava cada lançamento (Saldo Inicial, Rendimentos, Resgate, Depósito, Saldo Final)
 * em uma tabela `extratos_vinculada`.
 *
 * Estrutura típica de cada linha PDF:
 *   1/12/2025 Saldo Inicial 32.542,74 C 32.542,74
 *   30/12/2025 Rendimentos Pro-rata 211,2 C 32.753,94
 *   30/12/2025 Resgate 32.753,94 D 0
 *   31/12/2025 Saldo Final 0 0
 *
 * Uso:
 *   node scripts/importar_extratos_vinculada.js                  # dry-run
 *   node scripts/importar_extratos_vinculada.js --apply
 *   node scripts/importar_extratos_vinculada.js --pasta="C:\..." # pasta custom
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PDFParse } = require('pdf-parse');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const ARG = process.argv.slice(2);
const APLICAR = ARG.includes('--apply');
const arg = (k, def = '') => (ARG.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || def;
const empresa = arg('empresa', 'assessoria');
const PASTA = arg('pasta',
  'C:/Users/Avell/Downloads/EXTRATO CONTA VINCULADA MONTANA ASSESSORIA');

function parseValor(s) {
  if (!s) return 0;
  const x = String(s).replace(/\./g, '').replace(',', '.').replace(/[^\d.\-]/g, '');
  const n = parseFloat(x);
  return isNaN(n) ? 0 : n;
}

function dmy2iso(dmy) {
  const m = String(dmy).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return '';
  return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

function parsePdf(texto, pdfNome) {
  // Cabeçalho
  const cnpjConv = (texto.match(/CNPJ do Convenente\s*\n(\d{14})/) || [])[1] || '';
  const nomeConv = (texto.match(/Nome do Convenente\s*\n(.+)/) || [])[1] || '';
  const conta    = (texto.match(/Conta Vinculada\s*\n(\d+)/) || [])[1] || '';
  const dtIni    = (texto.match(/Data Inicio\s*\n(\d{2}\/\d{2}\/\d{4})/) || [])[1] || '';
  const dtFim    = (texto.match(/Data Final\s*\n(\d{2}\/\d{2}\/\d{4})/) || [])[1] || '';

  // Lançamentos: regex captura DATA HISTÓRICO VALOR (C|D|nada) SALDO
  // Histórico pode ter múltiplas palavras
  const linhas = texto.split('\n');
  const lancs = [];
  for (const linha of linhas) {
    // Pattern: data + qualquer texto + valor + (C ou D opcional) + saldo
    const m = linha.match(/^(\d{1,2}\/\d{1,2}\/\d{4})\s+(.+?)\s+([\d.]+(?:,\d+)?)\s*(C|D)?\s+([\d.]+(?:,\d+)?|0)\b/);
    if (!m) continue;
    const [, data, hist, valor, sinal, saldo] = m;
    const histClean = hist.trim();
    // Detecta tipo
    const tipo = histClean.match(/Saldo Inicial/i) ? 'SALDO_INICIAL'
               : histClean.match(/Saldo Final/i)   ? 'SALDO_FINAL'
               : sinal === 'C' ? 'CREDITO'
               : sinal === 'D' ? 'DEBITO'
               : 'OUTRO';
    const v = parseValor(valor);
    lancs.push({
      data_iso: dmy2iso(data),
      historico: histClean,
      tipo,
      credito: (tipo === 'CREDITO' || tipo === 'SALDO_INICIAL' || tipo === 'SALDO_FINAL') ? v : 0,
      debito:  tipo === 'DEBITO' ? v : 0,
      saldo:   parseValor(saldo),
    });
  }

  return {
    pdf: pdfNome,
    conta_vinculada: conta,
    cnpj_convenente: cnpjConv,
    nome_convenente: nomeConv.trim(),
    periodo_ini: dmy2iso(dtIni),
    periodo_fim: dmy2iso(dtFim),
    lancamentos: lancs,
  };
}

function listarPdfs(base) {
  const out = [];
  for (const sub of fs.readdirSync(base)) {
    const subPath = path.join(base, sub);
    if (!fs.statSync(subPath).isDirectory()) continue;
    for (const f of fs.readdirSync(subPath)) {
      if (f.toLowerCase().endsWith('.pdf')) out.push(path.join(subPath, f));
    }
  }
  return out;
}

async function main() {
  console.log(`\n📂 Importador Extratos Conta Vinculada — empresa=${empresa}`);
  console.log(`   Pasta: ${PASTA}`);
  console.log(`   Modo: ${APLICAR ? 'APLICAR' : 'DRY-RUN'}\n`);

  if (!fs.existsSync(PASTA)) {
    console.error('❌ Pasta não existe.');
    process.exit(1);
  }

  const pdfs = listarPdfs(PASTA);
  console.log(`  ${pdfs.length} PDFs encontrados.`);

  const db = getDb(empresa);

  // Cria tabela se não existir
  db.exec(`
    CREATE TABLE IF NOT EXISTS extratos_vinculada (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conta_vinculada TEXT NOT NULL,
      cnpj_convenente TEXT,
      nome_convenente TEXT,
      data_iso TEXT NOT NULL,
      historico TEXT,
      tipo TEXT,                   -- CREDITO | DEBITO | SALDO_INICIAL | SALDO_FINAL
      credito REAL DEFAULT 0,
      debito  REAL DEFAULT 0,
      saldo   REAL DEFAULT 0,
      pdf_origem TEXT,
      hash_unico TEXT UNIQUE,
      status_conciliacao TEXT,     -- vinculado a OB federal quando conciliado
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ev_conta ON extratos_vinculada(conta_vinculada);
    CREATE INDEX IF NOT EXISTS idx_ev_data  ON extratos_vinculada(data_iso);
    CREATE INDEX IF NOT EXISTS idx_ev_tipo  ON extratos_vinculada(tipo);
  `);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO extratos_vinculada
      (conta_vinculada, cnpj_convenente, nome_convenente, data_iso,
       historico, tipo, credito, debito, saldo, pdf_origem, hash_unico)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Resumo por conta + período
  const porConta = {};
  let totalLanc = 0, totalErros = 0, totalInseridos = 0;

  // Processa todos os PDFs em paralelo (limite 4)
  const limite = 4;
  for (let i = 0; i < pdfs.length; i += limite) {
    const lote = pdfs.slice(i, i + limite);
    const parsed = await Promise.all(lote.map(async pdfPath => {
      try {
        const buf = fs.readFileSync(pdfPath);
        const p = new PDFParse({ data: buf });
        const r = await p.getText();
        return { pdfPath, parsed: parsePdf(r.text, path.basename(pdfPath)) };
      } catch (e) {
        return { pdfPath, err: e.message };
      }
    }));
    for (const item of parsed) {
      if (item.err) {
        totalErros++;
        console.log(`  ❌ ${path.basename(item.pdfPath)}: ${item.err}`);
        continue;
      }
      const { parsed: data } = item;
      const k = data.conta_vinculada || 'SEM_CONTA';
      if (!porConta[k]) porConta[k] = { conv: data.nome_convenente, lanc: 0, mov: 0 };
      porConta[k].lanc += data.lancamentos.length;
      // movimentação = soma de credito + debito (excluindo Saldo Inicial/Final)
      const mov = data.lancamentos
        .filter(l => l.tipo === 'CREDITO' || l.tipo === 'DEBITO')
        .reduce((a, l) => a + l.credito + l.debito, 0);
      porConta[k].mov += mov;
      totalLanc += data.lancamentos.length;

      if (APLICAR) {
        db.transaction(() => {
          for (const l of data.lancamentos) {
            const hash = crypto.createHash('md5')
              .update(`${data.conta_vinculada}|${l.data_iso}|${l.historico}|${l.credito}|${l.debito}|${l.saldo}`)
              .digest('hex');
            const r = stmt.run(
              data.conta_vinculada, data.cnpj_convenente, data.nome_convenente,
              l.data_iso, l.historico, l.tipo,
              l.credito, l.debito, l.saldo, data.pdf, hash
            );
            if (r.changes > 0) totalInseridos++;
          }
        })();
      }
    }
    process.stdout.write(`\r  Processado ${Math.min(i + limite, pdfs.length)}/${pdfs.length} PDFs...`);
  }
  process.stdout.write('\r                                                       \r');

  console.log(`\n  Resumo por conta vinculada:`);
  Object.entries(porConta).sort((a, b) => b[1].mov - a[1].mov).forEach(([conta, v]) => {
    console.log(`    ${conta.padEnd(15)} ${(v.conv || '').substring(0, 30).padEnd(30)} ${String(v.lanc).padStart(4)} lançs | mov R$ ${v.mov.toLocaleString('pt-BR', { minimumFractionDigits: 2 }).padStart(15)}`);
  });

  console.log(`\n  Total: ${totalLanc} lançamentos, ${totalErros} erros.`);
  if (APLICAR) {
    console.log(`  ✅ Inseridos no banco: ${totalInseridos} (ignorados duplicatas: ${totalLanc - totalInseridos})`);
  } else {
    console.log(`  (dry-run — use --apply para gravar)`);
  }
  console.log('\n✔️  Concluído.\n');
}

main().catch(e => { console.error('❌', e); process.exit(1); });
