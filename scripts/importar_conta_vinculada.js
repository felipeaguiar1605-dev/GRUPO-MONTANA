'use strict';
/**
 * Importa extratos PDF de conta vinculada (IN SEGES/MP 05/2017) — Assessoria.
 *
 * Origem: PDFs do BB (módulo conta vinculada convenente/garantidor)
 *   Cabeçalho: CNPJ Convenente, Nome, Conta Vinculada, Período
 *   Linhas: DATA | HISTÓRICO | VALOR (C/D) | SALDO
 *
 * Estrutura da pasta:
 *   C:\Users\Avell\Downloads\EXTRATO CONTA VINCULADA MONTANA ASSESSORIA\
 *     TJTO-16001129486832\  ...64 PDFs (1 por mês 2021-2026)
 *     TJTO-2600119613154\   ...16 PDFs
 *     UFNT-3400110982478\   ...10 PDFs
 *     UFT-3400110982478\    ...26 PDFs (CNPJ convenente = 38178825000173 UFNT)
 *     UFT-3400128315175\    ...13 PDFs
 *     UFT-4900102210431\    ...40 PDFs
 *
 * Uso:
 *   node scripts/importar_conta_vinculada.js                       # dry-run
 *   node scripts/importar_conta_vinculada.js --apply
 *   node scripts/importar_conta_vinculada.js --pasta=TJTO-16001129486832 --apply
 *
 * Cria tabela `extratos_conta_vinculada` em data/assessoria/montana.db.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PDFParse } = require('pdf-parse');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const ARG = process.argv.slice(2);
const APPLY = ARG.includes('--apply');
const arg = (k, def = '') => (ARG.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || def;
const PASTA_FILTRO = arg('pasta', '');
const BASE = arg('base', 'C:\\Users\\Avell\\Downloads\\EXTRATO CONTA VINCULADA MONTANA ASSESSORIA');

const empresa = 'assessoria';

// ─────────────────────────────────────────────────────────
// Schema
function ensureSchema(db) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS extratos_conta_vinculada (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conta TEXT NOT NULL,
      cnpj_convenente TEXT,
      nome_convenente TEXT,
      cnpj_garantidor TEXT,
      pasta TEXT,
      data_iso TEXT NOT NULL,
      historico TEXT,
      valor REAL,
      tipo_valor TEXT,           -- 'C' crédito | 'D' débito
      saldo REAL,
      is_saldo INTEGER DEFAULT 0, -- 1 para Saldo Inicial/Final
      pdf_origem TEXT,
      hash_unico TEXT UNIQUE,
      raw_line TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_ecv_conta ON extratos_conta_vinculada(conta)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_ecv_data ON extratos_conta_vinculada(data_iso)`).run();
}

// ─────────────────────────────────────────────────────────
// Parser
function parseBr(s) { return parseFloat(String(s || '0').replace(/\./g, '').replace(',', '.')) || 0; }

function ymdFromBr(br) {
  const m = String(br || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
}

async function parsePdf(filePath) {
  const buf = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buf });
  const d = await parser.getText();
  const text = d.text;

  // Header
  const grab = (label) => {
    const re = new RegExp(label.replace(/\s+/g, '\\s+') + '\\s*\\n+([^\\n]+)', 'i');
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };

  const header = {
    cnpj_convenente: grab('CNPJ do Convenente'),
    nome_convenente: grab('Nome do Convenente'),
    cnpj_garantidor: grab('CNPJ do Garantidor'),
    nome_garantidor: grab('Nome do Garantidor'),
    conta:           grab('Conta Vinculada'),
  };

  // Linhas de movimentação
  // Formato: "DD/MM/YYYY HISTORICO VALOR C|D SALDO R$ R$"
  // ou:      "D/M/YYYY Saldo Inicial VALOR C VALOR R$ R$"
  const linhas = [];
  const lineRe = /^(\d{1,2}\/\d{1,2}\/\d{4})\s+(.+?)\s+([\d.]+,\d{2})\s+([CD])\s+([\d.]+,\d{2})/;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim().replace(/\s+R\$\s+R\$$/, '').replace(/\s+R\$$/, '');
    const m = line.match(lineRe);
    if (!m) continue;
    const [, dtBr, historico, valorBr, tipo, saldoBr] = m;
    const dataIso = ymdFromBr(dtBr);
    if (!dataIso) continue;
    const hist = historico.trim();
    linhas.push({
      data_iso: dataIso,
      historico: hist,
      valor: parseBr(valorBr),
      tipo_valor: tipo,
      saldo: parseBr(saldoBr),
      is_saldo: /^Saldo\s+(Inicial|Final)/i.test(hist) ? 1 : 0,
      raw_line: rawLine.trim(),
    });
  }

  return { header, linhas };
}

// ─────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🏦 Importando Conta Vinculada — ${APPLY ? '🔥 APPLY' : '💡 DRY-RUN'}`);
  console.log(`  Base: ${BASE}\n`);

  if (!fs.existsSync(BASE)) { console.error('❌ Pasta não encontrada:', BASE); process.exit(1); }
  const db = getDb(empresa);
  ensureSchema(db);

  const pastas = fs.readdirSync(BASE, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(n => !PASTA_FILTRO || n === PASTA_FILTRO);

  const ins = db.prepare(`
    INSERT OR IGNORE INTO extratos_conta_vinculada
      (conta, cnpj_convenente, nome_convenente, cnpj_garantidor, pasta,
       data_iso, historico, valor, tipo_valor, saldo, is_saldo,
       pdf_origem, hash_unico, raw_line)
    VALUES (@conta, @cnpj_c, @nome_c, @cnpj_g, @pasta,
            @data_iso, @historico, @valor, @tipo, @saldo, @is_saldo,
            @pdf, @hash, @raw)
  `);

  let totalPdfs = 0, totalLinhas = 0, totalInseridos = 0, falhas = 0;
  const porPasta = {};

  for (const pasta of pastas) {
    const dir = path.join(BASE, pasta);
    const pdfs = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf'));
    porPasta[pasta] = { pdfs: pdfs.length, linhas: 0, inseridos: 0 };

    for (const pdf of pdfs) {
      totalPdfs++;
      const full = path.join(dir, pdf);
      let parsed;
      try { parsed = await parsePdf(full); } catch (e) { falhas++; console.log('  ⚠️', pdf, '→', e.message); continue; }
      const { header, linhas } = parsed;
      porPasta[pasta].linhas += linhas.length;
      totalLinhas += linhas.length;

      if (APPLY) {
        const trx = db.transaction(ls => {
          for (const l of ls) {
            const hash = crypto.createHash('md5')
              .update(`${header.conta}|${l.data_iso}|${l.historico}|${l.valor}|${l.tipo_valor}|${l.saldo}`)
              .digest('hex');
            const r = ins.run({
              conta: header.conta, cnpj_c: header.cnpj_convenente, nome_c: header.nome_convenente,
              cnpj_g: header.cnpj_garantidor, pasta,
              data_iso: l.data_iso, historico: l.historico, valor: l.valor,
              tipo: l.tipo_valor, saldo: l.saldo, is_saldo: l.is_saldo,
              pdf, hash, raw: l.raw_line,
            });
            if (r.changes > 0) { porPasta[pasta].inseridos++; totalInseridos++; }
          }
        });
        trx(linhas);
      }
    }
  }

  // Relatório
  console.log('\n  ═══ Resumo por pasta ═══');
  for (const [p, v] of Object.entries(porPasta)) {
    console.log(`    ${p.padEnd(26)}  PDFs=${String(v.pdfs).padStart(3)}  Linhas=${String(v.linhas).padStart(5)}  Inseridos=${String(v.inseridos).padStart(5)}`);
  }
  console.log(`\n  Total: ${totalPdfs} PDFs · ${totalLinhas} linhas · ${totalInseridos} inseridos${falhas?' · '+falhas+' falhas':''}`);

  // Checagem final: saldos por conta (últimos)
  if (APPLY) {
    const saldos = db.prepare(`
      SELECT conta, nome_convenente, MAX(data_iso) ultima, saldo
      FROM (
        SELECT conta, nome_convenente, data_iso, saldo,
               ROW_NUMBER() OVER (PARTITION BY conta ORDER BY data_iso DESC, id DESC) rn
        FROM extratos_conta_vinculada
        WHERE is_saldo = 1 AND historico LIKE '%Final%'
      ) WHERE rn = 1
      GROUP BY conta
      ORDER BY saldo DESC
    `).all();
    let totalSaldo = 0;
    console.log('\n  ═══ Saldo Final mais recente por conta ═══');
    saldos.forEach(s => {
      console.log(`    ${s.conta.padEnd(16)}  ${s.ultima}  R$ ${Number(s.saldo).toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(14)}  ${(s.nome_convenente||'').substring(0,40)}`);
      totalSaldo += Number(s.saldo || 0);
    });
    console.log(`    ${''.padEnd(16)}  ${''.padEnd(10)}  ${''.padEnd(14)}  ─────────────`);
    console.log(`    ${'TOTAL'.padEnd(16)}              R$ ${totalSaldo.toLocaleString('pt-BR',{minimumFractionDigits:2}).padStart(14)}`);
  }

  if (!APPLY) console.log('\n  💡 dry-run — use --apply para gravar em extratos_conta_vinculada');
}

main().catch(e => { console.error('❌', e); process.exit(1); });
