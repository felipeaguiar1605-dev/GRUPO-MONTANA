/**
 * Montana ERP — Validador semântico de importação OFX
 *
 * Função pura que recebe array de lançamentos parseados do OFX e
 * retorna array com flags de pré-classificação + warnings.
 *
 * Uso (em routes/ofx.js):
 *   const validator = require('../jobs/ofx-import-validator');
 *   const { lancamentos, warnings } = validator.preprocess(lancamentosOfx);
 *
 * Aplica automaticamente:
 *   - status_conciliacao = 'SALDO' pra "S A L D O"
 *   - inverte sinal pra "Pix Recebido" em débito
 *   - status_conciliacao = 'INTERNO' pra intragrupo conhecido
 *   - status_conciliacao = 'FINANCEIRA' pra PARCELA PROGIRO
 *   - status_conciliacao = 'RETIRADA_SOCIO' pra Ch.Avulso/sócios
 *   - flag warning pra duplicata suspeita
 */

const NOMES_INTRAGRUPO = [
  'MONTANA ASS','MONTANA S LTDA','MONTANA SERVICOS','MONTANA SEG','MONTANA EMP',
  'MONTANA ASSESSORIA','MONTANA SEGURANCA',
  'NEVADA','MUSTANG','PORTO DO VAU','PORTODOVAU','MONTREAL','OHIO MED'
];
const CNPJS_INTRAGRUPO = ['14092519','01786029','19200109'];
const NOMES_SOCIOS = ['FELIPE MARIO PINHEIR','FELIPE AGUIAR'];

const RE_RECEBIDO = /(RECEBIDO|CRÉDITO EM CONTA|CREDITO EM CONTA|ORDEM BANC|TRANSFER.*RECEBID)/i;
const RE_SALDO    = /(S A L D O|SALDO DO DIA)/i;
const RE_PROGIRO  = /(PARCELA PROGIRO|PARC\s+00\d\s+014|PROGIRO)/i;
const RE_AVULSO   = /(CH\.AVULSO|CH AVULSO|CHEQUE.*AVULSO)/i;

function isIntragrupo(historico) {
  const h = (historico || '').toUpperCase();
  return NOMES_INTRAGRUPO.some(n => h.includes(n)) || CNPJS_INTRAGRUPO.some(c => h.includes(c));
}

function isSocio(historico) {
  const h = (historico || '').toUpperCase();
  return NOMES_SOCIOS.some(n => h.includes(n));
}

/**
 * Pre-processa um array de lançamentos.
 * Cada lançamento deve ter: { data_iso, debito, credito, historico, conta }
 * Retorna { lancamentos: [...mutated], warnings: [...] }
 */
function preprocess(lancamentos = []) {
  const warnings = [];
  const out = [];

  // Mapa de duplicatas (mesmo data + valor) pra detectar batch duplicado
  const seen = new Map();

  for (let idx = 0; idx < lancamentos.length; idx++) {
    const l = { ...lancamentos[idx] };
    const hist = (l.historico || '').toUpperCase();
    const debito  = parseFloat(l.debito)  || 0;
    const credito = parseFloat(l.credito) || 0;

    // 1. SALDO
    if (RE_SALDO.test(hist)) {
      l.status_conciliacao = 'SALDO';
      l._auto_classificado = 'SALDO';
    }
    // 2. SINAL INVERTIDO (recebido em débito)
    else if (debito > 0 && credito === 0 && RE_RECEBIDO.test(hist)) {
      l.credito = debito;
      l.debito = 0;
      l._auto_classificado = 'SINAL_CORRIGIDO';
      l.historico = (l.historico || '') + ' [AUTO-SINAL]';
      warnings.push({
        idx, severity: 'info',
        msg: `Lançamento ${idx}: "${(l.historico||'').slice(0,50)}" tinha sinal invertido (debito > 0 em recebimento) — corrigido automaticamente`
      });
    }
    // 3. PROGIRO
    else if (debito > 0 && RE_PROGIRO.test(hist)) {
      l.status_conciliacao = 'FINANCEIRA';
      l._auto_classificado = 'FINANCEIRA';
    }
    // 4. RETIRADA SÓCIO
    else if (debito > 0 && (RE_AVULSO.test(hist) || isSocio(hist))) {
      l.status_conciliacao = 'RETIRADA_SOCIO';
      l._auto_classificado = 'RETIRADA_SOCIO';
    }
    // 5. INTRAGRUPO (só se não cair em FUNC/EMPREG/FOLHA)
    else if (debito > 0 && isIntragrupo(hist)
             && !/(FUNC|EMPREG|FOLHA)/i.test(hist)) {
      l.status_conciliacao = 'INTERNO';
      l._auto_classificado = 'INTERNO';
    }

    // Detector de duplicata no próprio batch
    const key = `${l.data_iso}|${(debito || credito).toFixed(2)}|${(hist || '').slice(0,40)}`;
    if (seen.has(key)) {
      warnings.push({
        idx, severity: 'warn',
        msg: `Lançamento ${idx}: duplicata literal de #${seen.get(key)} (mesma data + valor + histórico) — possível importação repetida`
      });
      l._suspect_duplicate = seen.get(key);
    } else {
      seen.set(key, idx);
    }

    out.push(l);
  }

  // Total auto-classificados
  const stats = out.reduce((s, l) => {
    if (l._auto_classificado) s[l._auto_classificado] = (s[l._auto_classificado] || 0) + 1;
    return s;
  }, {});
  if (Object.keys(stats).length > 0) {
    warnings.unshift({
      idx: -1, severity: 'info',
      msg: `Auto-classificação aplicada: ${Object.entries(stats).map(([k,v]) => `${k}=${v}`).join(', ')}`
    });
  }

  return { lancamentos: out, warnings, stats };
}

/**
 * Valida ANTES de importar — se o batch como um todo é suspeito,
 * sinaliza pra UI mostrar warning ao usuário.
 */
function validateBatch(lancamentos) {
  const issues = [];
  if (lancamentos.length === 0) {
    issues.push({ severity: 'error', msg: 'Batch vazio' });
  }
  // Duplicatas internas
  const valKeys = new Set();
  let dups = 0;
  for (const l of lancamentos) {
    const k = `${l.data_iso}|${parseFloat(l.debito||l.credito).toFixed(2)}|${(l.historico||'').slice(0,40)}`;
    if (valKeys.has(k)) dups++;
    valKeys.add(k);
  }
  if (dups > 0) {
    issues.push({
      severity: 'warn',
      msg: `${dups} duplicatas literais detectadas no próprio batch — confirmar antes de importar`
    });
  }
  return issues;
}

module.exports = { preprocess, validateBatch, isIntragrupo, isSocio };
