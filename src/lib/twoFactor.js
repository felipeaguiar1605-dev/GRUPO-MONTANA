/**
 * Montana ERP — 2FA TOTP (Google Authenticator / Authy / 1Password)
 *
 * Instalação:
 *   npm install --save speakeasy qrcode
 *
 * Fluxo:
 *   1. Usuário acessa /api/auth/2fa/setup → gera secret + QR code
 *   2. Usuário escaneia QR no Authenticator app
 *   3. Usuário envia primeiro código para confirmar → /api/auth/2fa/enable
 *   4. Login passa a exigir `totp` no body além de usuario/senha
 *
 * Schema:
 *   ALTER TABLE usuarios ADD COLUMN totp_secret TEXT;
 *   ALTER TABLE usuarios ADD COLUMN totp_enabled BOOLEAN DEFAULT FALSE;
 *   ALTER TABLE usuarios ADD COLUMN totp_backup_codes TEXT;  -- JSON array hashed
 *
 * Uso (em routes/usuarios.js ou auth.js):
 *   const tfa = require('../lib/twoFactor');
 *   const setup = tfa.generateSecret('felipe@montana');
 *   // setup.secret (base32) → salvar em usuarios.totp_secret
 *   // setup.qrDataUrl       → mostrar pro user
 *
 *   const ok = tfa.verify(secret, codigoDigitado);
 */

let speakeasy = null;
let QRCode = null;
try { speakeasy = require('speakeasy'); } catch(_) {}
try { QRCode    = require('qrcode');    } catch(_) {}

const ISSUER = process.env.TOTP_ISSUER || 'Montana ERP';

function isAvailable() {
  return !!(speakeasy && QRCode);
}

/**
 * Gera secret + QR code para enrollment.
 * @param {string} label  Identificador único (ex: 'felipe@assessoria')
 * @returns {Promise<{secret:string, otpauthUrl:string, qrDataUrl:string}>}
 */
async function generateSecret(label) {
  if (!isAvailable()) throw new Error('speakeasy/qrcode não instalados (`npm i speakeasy qrcode`)');
  const sec = speakeasy.generateSecret({
    length: 20,
    name: `${ISSUER}:${label}`,
    issuer: ISSUER
  });
  const qrDataUrl = await QRCode.toDataURL(sec.otpauth_url);
  return {
    secret: sec.base32,
    otpauthUrl: sec.otpauth_url,
    qrDataUrl
  };
}

/**
 * Verifica código TOTP (6 dígitos) — janela de ±1 step (30s antes/depois).
 */
function verify(secret, token) {
  if (!isAvailable() || !secret || !token) return false;
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token: String(token).replace(/\s+/g,''),
    window: 1
  });
}

/**
 * Gera 10 códigos de backup (8 chars cada, alfanuméricos).
 * Retorna array em texto puro — caller deve hashear com bcrypt antes de salvar.
 */
function generateBackupCodes(n = 10) {
  const codes = [];
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I
  for (let i = 0; i < n; i++) {
    let c = '';
    for (let j = 0; j < 8; j++) c += chars[Math.floor(Math.random() * chars.length)];
    codes.push(c.match(/.{4}/g).join('-')); // ABCD-EFGH
  }
  return codes;
}

module.exports = {
  isAvailable,
  generateSecret,
  verify,
  generateBackupCodes
};
