#!/usr/bin/env node
/**
 * Checa validade dos certificados A1 (.pfx) de todas as empresas.
 * Lê a passphrase do DB (chaves: bb_pfx_passphrase, webiss_cert_senha).
 *
 * Uso:
 *   node scripts/check_certificados_validade.js
 */
'use strict';
const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
// Carrega .env (sem dependência externa — leitura simples)
try {
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    fs.readFileSync(envFile, 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
  }
} catch {}
const EMPRESAS = ['assessoria', 'seguranca', 'portodovau', 'mustang'];

function getCfg(db, chave) {
  try {
    const r = db.prepare('SELECT valor FROM configuracoes WHERE chave=?').get(chave);
    return r?.valor || '';
  } catch { return ''; }
}

function pfxExpiry(pfxPath, passphrase) {
  // A1 antigos usam RC2-40/SHA1 (legacy em OpenSSL 3). Tenta normal primeiro, depois -legacy.
  const crypto = require('crypto');
  const tmpPem = path.join(require('os').tmpdir(), `cert_${Date.now()}_${Math.random().toString(36).slice(2)}.pem`);
  const base = `openssl pkcs12 -in "${pfxPath}" -nokeys -clcerts -passin pass:${JSON.stringify(passphrase)} -out "${tmpPem}"`;
  let lastErr = '';
  for (const cmd of [base, base + ' -legacy']) {
    try {
      execSync(cmd, { stdio: 'pipe' });
      const pem = fs.readFileSync(tmpPem, 'utf8');
      if (!pem.includes('-----BEGIN CERTIFICATE-----')) { lastErr = 'pem sem cert'; continue; }
      const cert = new crypto.X509Certificate(pem);
      fs.unlinkSync(tmpPem);
      return {
        notAfter: new Date(cert.validTo),
        subject:  cert.subject.replace(/\n/g, ' / '),
        issuer:   cert.issuer.replace(/\n/g, ' / '),
      };
    } catch (e) {
      lastErr = (e.stderr?.toString() || e.message).split('\n').find(l => l.toLowerCase().includes('error') || l.toLowerCase().includes('failure')) || e.message;
      lastErr = lastErr.substring(0, 100);
    }
  }
  try { fs.unlinkSync(tmpPem); } catch {}
  return { error: `openssl falhou: ${lastErr}` };
}

function diasRestantes(d) {
  if (!d) return null;
  return Math.floor((d - new Date()) / (1000 * 60 * 60 * 24));
}

function statusEmoji(dias) {
  if (dias === null) return '❓';
  if (dias < 0)      return '❌ VENCIDO';
  if (dias < 15)     return '🚨 CRÍTICO';
  if (dias < 30)     return '⚠️  ATENÇÃO';
  if (dias < 60)     return '🟡 MONITORAR';
  return '✅';
}

console.log('\n  === Certificados A1 — validade ===\n');

const resumo = [];
for (const emp of EMPRESAS) {
  const pfx   = path.join(ROOT, 'certificados', `${emp}.pfx`);
  const db    = path.join(ROOT, 'data', emp, 'montana.db');
  if (!fs.existsSync(pfx)) {
    console.log(`  ${emp.padEnd(12)} — ❌ PFX não existe (${pfx})`);
    continue;
  }
  const size = fs.statSync(pfx).size;
  let passphrase = '';
  // 1) tenta .env (formato WEBISS_CERT_SENHA_<EMPRESA>)
  passphrase = process.env[`WEBISS_CERT_SENHA_${emp.toUpperCase()}`] || '';
  // 2) fallback: DB configuracoes
  if (!passphrase && fs.existsSync(db)) {
    const d = new Database(db, { readonly: true });
    passphrase = getCfg(d, 'bb_pfx_passphrase') ||
                 getCfg(d, 'webiss_cert_senha') ||
                 getCfg(d, 'webiss_pfx_pass')  ||
                 getCfg(d, 'cert_pfx_senha')   || '';
    d.close();
  }

  const info = pfxExpiry(pfx, passphrase);
  if (info.error) {
    console.log(`  ${emp.padEnd(12)} — ${info.error} (${size} bytes, passphrase ${passphrase ? 'configurada' : 'VAZIA no DB'})`);
    resumo.push({ empresa: emp, status: 'pass-err' });
    continue;
  }
  const dias = diasRestantes(info.notAfter);
  const stat = statusEmoji(dias);
  console.log(`  ${emp.padEnd(12)} ${stat}  vence em ${dias} dia(s) — ${info.notAfter.toISOString().substring(0,10)}`);
  console.log(`    subject: ${info.subject.substring(0, 100)}`);
  resumo.push({ empresa: emp, dias, validade: info.notAfter, subject: info.subject });
}

console.log('\n  === Resumo ===');
const criticos = resumo.filter(r => r.dias !== undefined && r.dias !== null && r.dias < 30);
if (criticos.length === 0) {
  console.log('  ✅ Nenhum certificado vencendo em menos de 30 dias.');
} else {
  console.log(`  ⚠️  ${criticos.length} certificado(s) críticos:`);
  criticos.forEach(c => console.log(`     - ${c.empresa}: ${c.dias} dia(s)`));
}
console.log();
