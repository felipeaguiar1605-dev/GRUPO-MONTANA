#!/usr/bin/env node
/**
 * Montana — Conversor automático: better-sqlite3 sync → pg async
 * Uso: node convert_routes.js <arquivo.js>
 *      node convert_routes.js --all   (processa todos em src/)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC_DIR = require('path').resolve(__dirname, 'src');

// ── Transformações de SQL ────────────────────────────────────────
function fixSql(code) {
  return code
    // datetime('now') → NOW()
    .replace(/datetime\('now'\)/g, "NOW()")
    .replace(/datetime\("now"\)/g, "NOW()")
    // updated_at=datetime('now') em UPDATE SET inline
    .replace(/updated_at\s*=\s*NOW\(\)/g, "updated_at=NOW()")
    // INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
    // (feito no db_pg.js runtime, mas limpa no código também)
    .replace(/INSERT OR IGNORE INTO/g, 'INSERT INTO')
    .replace(/INSERT OR REPLACE INTO/g, 'INSERT INTO');
}

// ── Adiciona async em route handlers ────────────────────────────
function makeHandlersAsync(code) {
  // router.get/post/put/patch/delete('...', (req, res) => {
  // router.get/post/put/patch/delete('...', companyMw, (req, res) => {
  // Também: app.get(...)
  return code
    // (req, res) => {  sem async
    .replace(
      /(\brouter\.\w+\s*\([^,)]+(?:,\s*[^,)]+)*,\s*)(\(req,\s*res\)\s*=>)/g,
      (match, prefix, handler) => {
        if (handler.includes('async')) return match;
        return prefix + 'async ' + handler;
      }
    )
    // Também: function(req, res) {  → async function(req, res) {
    .replace(
      /(\brouter\.\w+\s*\([^,)]+(?:,\s*[^,)]+)*,\s*)(function\s*\(req,\s*res\))/g,
      (match, prefix, fn) => {
        if (match.includes('async')) return match;
        return prefix + 'async ' + fn;
      }
    );
}

// ── Adiciona await em chamadas db ────────────────────────────────
function addAwaitToDb(code) {
  // const x = req.db.prepare(...).all/get/run(...)
  // const x = db.prepare(...).all/get/run(...)
  // Não adiciona await se já tem
  return code
    .replace(
      /(?<!await\s)(req\.db|db|req\.db)\s*\.prepare\s*\(/g,
      'await $1.prepare('
    )
    // Corrige duplicação: await await
    .replace(/await\s+await\s+/g, 'await ');
}

// ── Converte transações ─────────────────────────────────────────
function convertTransactions(code) {
  // db.transaction(() => {  → db.transaction(async () => {
  return code
    .replace(
      /\.transaction\s*\(\s*\(\s*\)\s*=>/g,
      '.transaction(async () =>'
    )
    .replace(
      /\.transaction\s*\(\s*function\s*\(\s*\)/g,
      '.transaction(async function()'
    )
    // trans() sem await → await trans()
    // Cuidado: só se a variável é resultado de .transaction()
    // Heurística: linha que termina com trans(); ou trans()  (sem await)
    .replace(
      /^(\s*)(?<!await\s)(trans\s*\(\s*\)\s*;?)$/gm,
      '$1await $2'
    );
}

// ── Adiciona await antes de .run/.get/.all standalone ───────────
function addAwaitToStmt(code) {
  // const r = stmt.run(...)  → await stmt.run(...)
  // Evita reprocessar linhas que já têm await
  return code
    .replace(
      /(?<!=\s*await\s+)([\w.]+\s*\.\s*(?:run|get|all)\s*\()/g,
      (match) => {
        // Só adiciona se parece ser uma chamada de prepared statement
        if (/^(upd|stmt|ins|del|sel|row|r)\s*\./.test(match)) {
          return 'await ' + match;
        }
        return match;
      }
    );
}

// ── Envolve handlers em try/catch se não tiver ──────────────────
// (simplificado — apenas detecta handlers sem try/catch já existentes)
function wrapTryCatch(code) {
  // Não modifica — muito arriscado sem AST parser
  // As rotas existentes geralmente não têm try/catch, mas a conversão não
  // deve quebrar o comportamento de erro do Express (ele já captura com .next())
  return code;
}

// ── Atualiza require('./db') → require('./db_pg') ───────────────
function updateRequire(code, filePath) {
  const relToSrc = path.relative(path.dirname(filePath), SRC_DIR);
  const dbPath = relToSrc ? relToSrc + '/db' : './db';
  const dbPgPath = relToSrc ? relToSrc + '/db_pg' : './db_pg';

  // require('../db') or require('./db') — qualquer caminho que termine em /db
  return code
    .replace(/require\(['"]([^'"]*\/db)['"]\)/g, (match, p) => {
      // Só substitui se não for db_pg já
      if (p.endsWith('db_pg')) return match;
      return match.replace(/\/db(['"])/, '/db_pg$1');
    });
}

// ── Pipeline principal ──────────────────────────────────────────
function convertFile(filePath) {
  let code = fs.readFileSync(filePath, 'utf8');
  const original = code;

  code = fixSql(code);
  code = updateRequire(code, filePath);
  code = makeHandlersAsync(code);
  code = convertTransactions(code);
  code = addAwaitToDb(code);

  if (code === original) {
    console.log(`  ○ ${path.basename(filePath)} — sem alterações`);
    return false;
  }

  // Backup
  fs.writeFileSync(filePath + '.bak_pg', original);
  fs.writeFileSync(filePath, code);
  console.log(`  ✓ ${path.basename(filePath)} — convertido`);
  return true;
}

// ── CLI ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args[0] === '--all') {
  const targets = [
    path.join(SRC_DIR, 'api.js'),
    ...fs.readdirSync(path.join(SRC_DIR, 'routes'))
      .filter(f => f.endsWith('.js') && !f.endsWith('.bak_pg') && !f.includes('.bak'))
      .map(f => path.join(SRC_DIR, 'routes', f)),
    path.join(SRC_DIR, 'companyMiddleware.js'),
  ];

  let changed = 0;
  for (const f of targets) {
    if (fs.existsSync(f)) {
      if (convertFile(f)) changed++;
    }
  }
  console.log(`\nTotal: ${changed} arquivos convertidos de ${targets.length}`);

} else if (args[0]) {
  convertFile(args[0]);
} else {
  console.log('Uso: node convert_routes.js <arquivo> | --all');
}
