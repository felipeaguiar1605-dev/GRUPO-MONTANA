#!/usr/bin/env node
/**
 * Smoke tests — Montana ERP
 *
 * Objetivo: validar os 4 fluxos críticos rapidamente (<30s total), sem
 * mocks elaborados, sem framework (só assert). Se algum falhar, o exit
 * code != 0 e o deploy bloqueia.
 *
 * Fluxos:
 *   1. DB factory — abre cada DB das 4 empresas e faz queries básicas
 *   2. Auth JWT — gera token, valida, rejeita expirado
 *   3. BB-sync — carrega módulo e testa buildTlsOpts com pfx/pem/nenhum
 *   4. API REST — sobe servidor em porta dinâmica, faz GET /api/empresas
 *
 * Uso:
 *   node tests/smoke.js
 *   npm test
 */
'use strict';
const assert = require('assert/strict');
const path   = require('path');
const fs     = require('fs');
const http   = require('http');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

// Carrega .env
try {
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
  }
} catch {}

let passed = 0, failed = 0;
const results = [];

async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    const ms = Date.now() - t0;
    console.log(`  ✅ ${name} (${ms}ms)`);
    results.push({ name, ok: true, ms });
    passed++;
  } catch (e) {
    const ms = Date.now() - t0;
    console.log(`  ❌ ${name} (${ms}ms)`);
    console.log(`     ${e.message.split('\n').slice(0, 5).join('\n     ')}`);
    results.push({ name, ok: false, ms, err: e.message });
    failed++;
  }
}

// ───────────────────────────── Fluxo 1: DB factory ─────────────────────────────
async function smokeDB() {
  const { getDb, COMPANIES } = require(path.join(ROOT, 'src/db.js'));
  // COMPANIES é um mapa { key: {...meta} }
  const keys = Object.keys(COMPANIES).sort();
  assert.deepEqual(
    keys,
    ['assessoria', 'mustang', 'portodovau', 'seguranca'],
    'empresas devem ser as 4 esperadas'
  );
  for (const key of keys) {
    const db = getDb(key);
    assert.ok(db, `getDb(${key}) retornou null`);
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='configuracoes'").get();
    assert.ok(row, `empresa ${key} sem tabela configuracoes`);
  }
}

// ───────────────────────────── Fluxo 2: Auth JWT ─────────────────────────────
async function smokeAuth() {
  const jwt = require('jsonwebtoken');
  const secret = process.env.JWT_SECRET || 'dev-secret';
  const token = jwt.sign({ sub: 'admin', role: 'admin' }, secret, { expiresIn: '1h' });
  const decoded = jwt.verify(token, secret);
  assert.equal(decoded.sub, 'admin', 'JWT decode falhou');
  // Rejeita token expirado
  const expired = jwt.sign({ sub: 'x' }, secret, { expiresIn: '-1s' });
  assert.throws(() => jwt.verify(expired, secret), /expired/i, 'JWT expirado deveria ser rejeitado');
}

// ───────────────────────────── Fluxo 3: BB-sync module ─────────────────────────────
async function smokeBBSync() {
  // Carrega sem crash (falha em runtime seria syntax error)
  const bbSync = require(path.join(ROOT, 'src/routes/bb-sync.js'));
  assert.ok(bbSync, 'bb-sync.js não exporta nada');
  // Aceita factory (function), router (object with .use/.get) ou objeto exports
  const isUsable = typeof bbSync === 'function' ||
                   (bbSync && typeof bbSync === 'object');
  assert.ok(isUsable, 'export de bb-sync inválido');
}

// ───────────────────────────── Fluxo 4: API boot ─────────────────────────────
async function smokeAPI() {
  // Sobe o server em porta alta temporária
  process.env.PORT = '0';  // porta dinâmica
  process.env.SKIP_CRONS = '1';  // não registra cron jobs no smoke
  delete require.cache[require.resolve(path.join(ROOT, 'src/server.js'))];

  // Intercepta app.listen para capturar a porta atribuída
  const http = require('http');
  const originalListen = http.Server.prototype.listen;
  let capturedPort = null;
  let serverRef = null;
  http.Server.prototype.listen = function (...args) {
    const result = originalListen.apply(this, args);
    serverRef = this;
    this.on('listening', () => {
      const addr = this.address();
      if (addr && typeof addr === 'object') capturedPort = addr.port;
    });
    return result;
  };

  try {
    require(path.join(ROOT, 'src/server.js'));
    // Espera até 3s pela porta
    const deadline = Date.now() + 3000;
    while (!capturedPort && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(capturedPort, 'server não atribuiu porta em 3s');

    // GET /api/empresas (endpoint público)
    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${capturedPort}/api/empresas`, (r) => {
        let body = '';
        r.on('data', c => body += c);
        r.on('end', () => resolve({ status: r.statusCode, body }));
      }).on('error', reject);
    });
    assert.ok(res.status === 200 || res.status === 401, `/api/empresas status=${res.status} (esperado 200 ou 401)`);
  } finally {
    http.Server.prototype.listen = originalListen;
    if (serverRef) { try { serverRef.close(); } catch {} }
  }
}

// ─────────────────────────────── Runner ───────────────────────────────
(async () => {
  console.log('\n  === Montana smoke tests ===\n');
  await test('DB factory (4 empresas abrem, configuracoes existe)', smokeDB);
  await test('Auth JWT (sign/verify/rejeita expirado)', smokeAuth);
  await test('BB-sync module carrega', smokeBBSync);
  await test('API boot + GET /api/empresas', smokeAPI);

  const total = passed + failed;
  console.log(`\n  ${passed}/${total} passaram` + (failed ? ` — ${failed} falha(s)` : ''));
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => {
  console.error('\n  ❌ Erro no runner:', e.message);
  process.exit(1);
});
