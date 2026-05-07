/**
 * Montana ERP — 2FA TOTP
 * Instalar: npm install --save speakeasy qrcode
 */
let speakeasy = null;
let QRCode = null;
try { speakeasy = require('speakeasy'); } catch(_) {}
try { QRCode    = require('qrcode');    } catch(_) {}

const ISSUER = process.env.TOTP_ISSUER || 'Montana ERP';

function isAvailable() { return !!(speakeasy && QRCode); }

async function generateSecret(label) {
  if (!isAvailable()) throw new Error('speakeasy/qrcode não instalados (`npm i speakeasy qrcode`)');
  const sec = speakeasy.generateSecret({ length: 20, name: `${ISSUER}:${label}`, issuer: ISSUER });
  const qrDataUrl = await QRCode.toDataURL(sec.otpauth_url);
  return { secret: sec.base32, otpauthUrl: sec.otpauth_url, qrDataUrl };
}

function verify(secret, token) {
  if (!isAvailable() || !secret || !token) return false;
  return speakeasy.totp.verify({
    secret, encoding: 'base32',
    token: String(token).replace(/\s+/g,''),
    window: 1
  });
}

function generateBackupCodes(n = 10) {
  const codes = [];
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < n; i++) {
    let c = '';
    for (let j = 0; j < 8; j++) c += chars[Math.floor(Math.random() * chars.length)];
    codes.push(c.match(/.{4}/g).join('-'));
  }
  return codes;
}

module.exports = { isAvailable, generateSecret, verify, generateBackupCodes };
