'use strict';
/**
 * Passo 2: Vincular comprovantes importados (OBT/TFI) aos lançamentos do extrato
 * correspondentes em março/2026.
 *
 * Estratégia (sem leitura de PDF):
 *  A) PALMAS OBs:
 *     - Extrato: historico LIKE '%MUNICIPIO DE PALMAS%' OR '%ORDENS BANCARIAS%', crédito, mar/2026
 *     - Comprovantes OBT/ENTRADA, ordenados por nome de arquivo
 *     - Match sequencial (1º OBT → 1º Palmas OB, 2º OBT → 2º, ...)
 *     - Atualiza comprovante.valor = extrato.credito, data_pagamento = extrato.data_iso
 *
 *  B) Estado (SEDUC/SEFAZ):
 *     - Extrato: GOVERNO DO ES / ESTADO DO TOCANTINS, crédito
 *     - Próximo lote de comprovantes OBT
 *
 *  C) Federal (UFT / UNIVERSIDADE):
 *     - Extrato: UNIVERSIDADE FED / FUNDACAO UN, crédito
 *     - Próximo lote
 *
 *  D) Outgoing (TFI/SAIDA):
 *     - Extrato: débitos > 10k ordenados por data/valor desc
 *     - Comprovantes TFI/SAIDA, ordenados por nome
 *
 * Uso:
 *   node scripts/vincular_comprovantes_extratos.js --empresa=seguranca --mes=2026-03
 *   node scripts/vincular_comprovantes_extratos.js --empresa=seguranca --mes=2026-03 --dry-run
 *   node scripts/vincular_comprovantes_extratos.js --empresa=seguranca --mes=2026-03 --clear  (apaga vínculos anteriores do mês)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const ARG     = process.argv.slice(2);
const arg     = (k, def = '') => (ARG.find(a => a.startsWith(`--${k}=`)) || `--${k}=${def}`).split('=').slice(1).join('=');
const empresa = arg('empresa', 'seguranca');
const mes     = arg('mes', '2026-03');
const DRY     = ARG.includes('--dry-run');
const CLEAR   = ARG.includes('--clear');

console.log(`\n🔗 Vincular comprovantes ↔ extratos — empresa=${empresa} mês=${mes}${DRY?' [DRY-RUN]':''}${CLEAR?' [CLEAR]':''}\n`);

const db = getDb(empresa);

// ── helpers ────────────────────────────────────────────────────────────────

/** Extrai número sequencial do nome do arquivo (base=0, "(1)"=1, ...) */
function seqNome(obs) {
  const m = obs.match(/arquivo: (.+)$/);
  if (!m) return 0;
  const nome = m[1];
  const seq = nome.match(/\((\d+)\)/);
  return seq ? parseInt(seq[1]) : 0;
}

/** Compara comprovantes pelo nome do arquivo (para ordenação) */
function cmpComprovante(a, b) {
  const seqA = seqNome(a.observacao || '');
  const seqB = seqNome(b.observacao || '');
  if (seqA !== seqB) return seqA - seqB;
  return (a.observacao || '').localeCompare(b.observacao || '');
}

// ── Leitura do banco ───────────────────────────────────────────────────────

// Comprovantes ENTRADA não vinculados (OBT ou 009)
const compEntrada = db.prepare(`
  SELECT id, tipo, direcao, observacao, valor, data_pagamento
  FROM comprovantes_pagamento
  WHERE direcao = 'ENTRADA'
    AND data_pagamento LIKE ? || '%'
  ORDER BY id
`).all(mes).sort(cmpComprovante);

// Comprovantes SAIDA não vinculados (TFI)
const compSaida = db.prepare(`
  SELECT id, tipo, direcao, observacao, valor, data_pagamento
  FROM comprovantes_pagamento
  WHERE direcao = 'SAIDA'
    AND data_pagamento LIKE ? || '%'
  ORDER BY id
`).all(mes).sort(cmpComprovante);

console.log(`  Comprovantes ENTRADA: ${compEntrada.length}`);
console.log(`  Comprovantes SAIDA  : ${compSaida.length}`);

// Extrato créditos do mês, por grupo
const extratosCred = db.prepare(`
  SELECT id, data_iso, credito, historico
  FROM extratos
  WHERE data_iso LIKE ? || '%' AND credito > 0
  ORDER BY data_iso, credito DESC
`).all(mes + '%');

// Extrato débitos do mês (>1k, excluindo tarifas e investimentos)
const extratosDeb = db.prepare(`
  SELECT id, data_iso, debito, historico
  FROM extratos
  WHERE data_iso LIKE ? || '%' AND debito > 1000
    AND (historico NOT LIKE '%BB Rende%' AND historico NOT LIKE '%TAR %' AND historico NOT LIKE '%TARIFA%')
  ORDER BY data_iso, debito DESC
`).all(mes + '%');

// ── Agrupamento de extratos por "fonte" ────────────────────────────────────

function matchesHist(hist, patterns) {
  const h = (hist || '').toUpperCase();
  return patterns.some(p => h.includes(p.toUpperCase()));
}

const PALMAS_PAT   = ['MUNICIPIO DE PALMAS', 'ORDENS BANCARIAS', 'PREFEITURA PALMAS'];
const ESTADO_PAT   = ['ESTADO DO TOCANTINS', 'GOVERNO DO ES', 'SECRETARIA DE', 'SEFAZ', 'SEF-TO'];
const FEDERAL_PAT  = ['UNIVERSIDADE FED', 'FUNDACAO UN', 'UFNT', 'UFT', 'MINISTERIO PUBL'];

const obsPalmas  = extratosCred.filter(r => matchesHist(r.historico, PALMAS_PAT));
const obsEstado  = extratosCred.filter(r => matchesHist(r.historico, ESTADO_PAT));
const obsFederal = extratosCred.filter(r => matchesHist(r.historico, FEDERAL_PAT));
const obsOutros  = extratosCred.filter(r =>
  !matchesHist(r.historico, PALMAS_PAT) &&
  !matchesHist(r.historico, ESTADO_PAT) &&
  !matchesHist(r.historico, FEDERAL_PAT) &&
  !matchesHist(r.historico, ['BB Rende', 'MONTANA S LTDA', 'MONTANA SEG', 'MONTANA SERVIC', 'ISAIAS'])
);

console.log(`\n  Extratos crédito (${extratosCred.length} total):`);
console.log(`    Palmas OBs  : ${obsPalmas.length}`);
console.log(`    Estado      : ${obsEstado.length}`);
console.log(`    Federal     : ${obsFederal.length}`);
console.log(`    Outros pag. : ${obsOutros.length}`);
console.log(`  Extrato débitos (>1k, não tarifas): ${extratosDeb.length}`);

// ── Clear vínculos existentes do mês ──────────────────────────────────────

if (CLEAR && !DRY) {
  // Obtém IDs dos comprovantes do mês
  const idsMonth = db.prepare(`
    SELECT id FROM comprovantes_pagamento WHERE data_pagamento LIKE ? || '%'
  `).all(mes).map(r => r.id);

  if (idsMonth.length) {
    const ph = idsMonth.map(() => '?').join(',');
    const del = db.prepare(`DELETE FROM comprovante_vinculos WHERE comprovante_id IN (${ph})`).run(...idsMonth);
    console.log(`\n  🗑️  Removidos ${del.changes} vínculos anteriores.`);
  }
}

// ── Execução dos matches ────────────────────────────────────────────────────

const stmtVinculo = db.prepare(`
  INSERT OR IGNORE INTO comprovante_vinculos
    (comprovante_id, tipo_destino, destino_id, valor_vinculado, observacao)
  VALUES (?, 'EXTRATO', ?, ?, ?)
`);
const stmtUpdComp = db.prepare(`
  UPDATE comprovantes_pagamento
  SET valor = ?, data_pagamento = ?, updated_at = datetime('now')
  WHERE id = ? AND (valor = 0 OR valor IS NULL)
`);

let totalLinks = 0;
const relatorio = [];

function vincular(comp, extrato, valor, fonte) {
  if (!DRY) {
    stmtVinculo.run(comp.id, extrato.id, valor, `auto-match ${fonte}`);
    stmtUpdComp.run(valor, extrato.data_iso, comp.id);
  }
  totalLinks++;
  relatorio.push({ comp: comp.id, obs: comp.observacao?.match(/arquivo: (.+)$/)?.[1] || '',
    extrato: extrato.id, data: extrato.data_iso, valor, fonte });
}

// Função de match sequencial com relatório
function matchSequencial(comps, extratos, fonte, maxMatch) {
  const limite = Math.min(comps.length, extratos.length, maxMatch || 999);
  for (let i = 0; i < limite; i++) {
    const c = comps[i];
    const e = extratos[i];
    const val = (e.credito || e.debito || 0);
    vincular(c, e, val, fonte);
  }
  return limite;
}

// A) Palmas OBs → primeiros N comprovantes ENTRADA
let cursor = 0;
const nPalmas = Math.min(obsPalmas.length, compEntrada.length);
const usedEntrada = new Set();
console.log(`\n  [A] Palmas OBs → ${nPalmas} comprovante(s) OBT/ENTRADA`);
for (let i = 0; i < nPalmas; i++) {
  vincular(compEntrada[cursor + i], obsPalmas[i],
    obsPalmas[i].credito, 'PALMAS-OB');
  usedEntrada.add(cursor + i);
}
cursor += nPalmas;

// B) Estado → próximos comprovantes ENTRADA
const nEstado = Math.min(obsEstado.length, compEntrada.length - cursor);
console.log(`  [B] Estado OBs → ${nEstado} comprovante(s) OBT/ENTRADA`);
for (let i = 0; i < nEstado; i++) {
  vincular(compEntrada[cursor + i], obsEstado[i],
    obsEstado[i].credito, 'ESTADO-OB');
  usedEntrada.add(cursor + i);
}
cursor += nEstado;

// C) Federal/UFT → próximos comprovantes ENTRADA
const nFed = Math.min(obsFederal.length, compEntrada.length - cursor);
console.log(`  [C] Federal/UFT → ${nFed} comprovante(s) OBT/ENTRADA`);
for (let i = 0; i < nFed; i++) {
  vincular(compEntrada[cursor + i], obsFederal[i],
    obsFederal[i].credito, 'FEDERAL-PIX');
  usedEntrada.add(cursor + i);
}
cursor += nFed;

// D) Outros créditos → comprovantes restantes ENTRADA
const nOutros = Math.min(obsOutros.length, compEntrada.length - cursor);
if (nOutros > 0) {
  console.log(`  [D] Outros créditos → ${nOutros} comprovante(s) restantes`);
  for (let i = 0; i < nOutros; i++) {
    vincular(compEntrada[cursor + i], obsOutros[i],
      obsOutros[i].credito, 'OUTROS-CRED');
  }
  cursor += nOutros;
}

// E) TFI/SAIDA → maiores débitos do mês
const nSaida = Math.min(compSaida.length, extratosDeb.length);
console.log(`  [E] Débitos → ${nSaida} comprovante(s) TFI/SAIDA`);
for (let i = 0; i < nSaida; i++) {
  vincular(compSaida[i], extratosDeb[i], extratosDeb[i].debito, 'DEBITO-TFI');
}

// ── Sumário ───────────────────────────────────────────────────────────────

const semVinculo = compEntrada.length - Math.min(cursor, compEntrada.length);
console.log(`\n  ✅ Vínculos criados: ${totalLinks}`);
console.log(`  ⚠️  Comprovantes ENTRADA sem vínculo: ${semVinculo}`);

// Tabela resumida
console.log('\n  Vínculos (primeiros 20):');
console.log('  ' + '─'.repeat(95));
console.log('  Comp ID │ Arquivo                        │ Extrato ID          │ Data       │ Valor R$       │ Fonte');
console.log('  ' + '─'.repeat(95));
relatorio.slice(0, 20).forEach(r => {
  const arq  = (r.obs || '').padEnd(30).substring(0, 30);
  const exId = String(r.extrato).padEnd(20).substring(0, 20);
  const val  = Number(r.valor).toLocaleString('pt-BR', { minimumFractionDigits: 2 }).padStart(14);
  console.log(`  ${String(r.comp).padEnd(7)} │ ${arq} │ ${exId} │ ${r.data} │ ${val} │ ${r.fonte}`);
});
if (relatorio.length > 20) console.log(`  ... (${relatorio.length - 20} mais)`);
console.log('  ' + '─'.repeat(95));

if (DRY) {
  console.log('\n  ⚠️  Modo DRY-RUN — nada foi gravado.');
}

// Verificação final
if (!DRY) {
  const qtdVinc = db.prepare(`
    SELECT COUNT(DISTINCT cv.comprovante_id) c
    FROM comprovante_vinculos cv
    JOIN comprovantes_pagamento cp ON cp.id = cv.comprovante_id
    WHERE cp.data_pagamento LIKE ? || '%'
  `).get(mes).c;
  console.log(`\n  Comprovantes vinculados no banco (${mes}): ${qtdVinc} de ${compEntrada.length + compSaida.length}`);
}

console.log('\n✔️  Concluído.');
