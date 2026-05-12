'use strict';
/**
 * qa/config.js
 * Configuração da rotina de QA. Carrega de variáveis de ambiente quando
 * possível, com defaults seguros.
 */

const path = require('path');

const ROOT = path.join(__dirname, '..');

function defaultCompetencia() {
  // Mês anterior ao atual no fuso de Brasília — costuma ter dados completos.
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

function todayBR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

module.exports = {
  baseUrl: process.env.QA_BASE_URL || 'https://sistema.grupomontanasec.com',
  usuario: process.env.QA_USER     || 'admin',
  senha:   process.env.QA_PASS     || 'montana2026',
  competenciaTeste: process.env.QA_COMPETENCIA || defaultCompetencia(),
  anoTeste: Number(process.env.QA_ANO || new Date().getFullYear()),
  outDir:  process.env.QA_OUT_DIR  || path.join(ROOT, 'relatorios_qa'),
  outFile: process.env.QA_OUT_FILE || `QA_${todayBR()}.md`,
  timeoutMs: Number(process.env.QA_TIMEOUT_MS || 15000),
  sanidade: {
    receitaMinAssessoria: Number(process.env.QA_RECEITA_MIN_ASSESSORIA || 10_000_000),
    receitaMinSeguranca:  Number(process.env.QA_RECEITA_MIN_SEGURANCA  ||  5_000_000),
  },
};
