/**
 * Montana ERP — Auto-classificação de extratos bancários
 *
 * Roda diariamente às 04:00 (após sync OFX/BB).
 * Aplica regras automáticas para reduzir o volume de PENDENTE manual.
 *
 * Aplica em todas as 4 empresas:
 *   1. SALDO        — linhas tipo "S A L D O" / "SALDO DO DIA"
 *   2. SINAL_INVERTIDO — recebimentos com débito > 0 (move pra crédito)
 *   3. FINANCEIRA   — PROGIRO/parcelas de empréstimo
 *   4. INTERNO      — TED/Transfer com nomes de empresas do grupo
 *   5. DUPLICATA    — pares cruzados entre 2 contas (off-by-cent)
 *   6. RETIRADA_SOCIO — Ch.Avulso e PIX a Felipe Mario Pinheir
 *
 * Uso:
 *   node src/jobs/auto-classify.js                  # roda em todas empresas, dry-run
 *   node src/jobs/auto-classify.js --apply          # aplica de fato
 *   node src/jobs/auto-classify.js --empresa=seguranca --apply
 *   node src/jobs/auto-classify.js --since=2026-01-01 --apply
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { getDb, COMPANIES } = require('../db');

// Lista de nomes/CNPJs do grupo Montana (extensível)
const NOMES_INTRAGRUPO = [
  'MONTANA ASS','MONTANA S LTDA','MONTANA SERVICOS','MONTANA SEG','MONTANA EMP',
  'MONTANA ASSESSORIA','MONTANA SEGURANCA',
  'NEVADA','MUSTANG','PORTO DO VAU','PORTODOVAU','MONTREAL','OHIO MED'
];
const CNPJS_INTRAGRUPO = [
  '14092519',  // Montana Assessoria Empresarial
  '01786029',  // Montana Segurança
  '19200109',  // Montana ?
];

const NOMES_SOCIOS = [
  'FELIPE MARIO PINHEIR',
  'FELIPE AGUIAR'
];

function parseArgs() {
  const args = { apply: false, empresa: null, since: null };
  for (const a of process.argv.slice(2)) {
    if (a === '--apply') args.apply = true;
    else if (a.startsWith('--empresa=')) args.empresa = a.split('=')[1];
    else if (a.startsWith('--since=')) args.since = a.split('=')[1];
  }
  return args;
}

async function classifyEmpresa(key, opts) {
  const db = getDb(key);
  const stats = { saldo: 0, sinal_invertido: 0, financeira: 0, intragrupo: 0, retirada_socio: 0, duplicata: 0 };
  const dateFilter = opts.since ? `AND data_iso >= '${opts.since}'` : '';
  const sufix = opts.apply ? '' : ' (DRY-RUN)';

  // Tabela "extratos" usa o schema da empresa via search_path do db_pg
  const log = (...m) => console.log(`  [${key}]`, ...m);

  // ── 1. SALDO ──────────────────────────────────────────────────
  const saldoSql = `
    UPDATE extratos
    SET status_conciliacao = 'SALDO',
        historico = historico || ' [AUTO-SALDO]'
    WHERE (UPPER(historico) LIKE '%S A L D O%'
        OR UPPER(historico) LIKE '%SALDO DO DIA%')
      AND (status_conciliacao IS NULL OR status_conciliacao NOT IN ('SALDO','CONCILIADO'))
      ${dateFilter}`;
  if (opts.apply) {
    const r = await db.prepare(saldoSql).run();
    stats.saldo = r.changes || 0;
  } else {
    const c = await db.prepare(`SELECT COUNT(*) as n FROM extratos
      WHERE (UPPER(historico) LIKE '%S A L D O%' OR UPPER(historico) LIKE '%SALDO DO DIA%')
        AND (status_conciliacao IS NULL OR status_conciliacao NOT IN ('SALDO','CONCILIADO'))
        ${dateFilter}`).get();
    stats.saldo = c.n;
  }
  log(`SALDO: ${stats.saldo}${sufix}`);

  // ── 2. SINAL INVERTIDO ────────────────────────────────────────
  const sinalSql = `
    UPDATE extratos
    SET credito = debito, debito = 0,
        historico = historico || ' [AUTO-SINAL_CORRIGIDO]'
    WHERE debito > 0 AND (credito IS NULL OR credito = 0)
      AND (UPPER(historico) LIKE '%RECEBIDO%'
        OR UPPER(historico) LIKE '%CRÉDITO EM CONTA%'
        OR UPPER(historico) LIKE '%CREDITO EM CONTA%'
        OR UPPER(historico) LIKE '%ORDEM BANC%'
        OR UPPER(historico) LIKE '%TRANSFER%RECEBID%')
      ${dateFilter}`;
  if (opts.apply) {
    const r = await db.prepare(sinalSql).run();
    stats.sinal_invertido = r.changes || 0;
  } else {
    const c = await db.prepare(`SELECT COUNT(*) as n FROM extratos
      WHERE debito > 0 AND (credito IS NULL OR credito = 0)
        AND (UPPER(historico) LIKE '%RECEBIDO%'
          OR UPPER(historico) LIKE '%CRÉDITO EM CONTA%'
          OR UPPER(historico) LIKE '%CREDITO EM CONTA%'
          OR UPPER(historico) LIKE '%ORDEM BANC%'
          OR UPPER(historico) LIKE '%TRANSFER%RECEBID%')
        ${dateFilter}`).get();
    stats.sinal_invertido = c.n;
  }
  log(`SINAL_INVERTIDO: ${stats.sinal_invertido}${sufix}`);

  // ── 3. FINANCEIRA (PROGIRO) ───────────────────────────────────
  const finSql = `
    UPDATE extratos
    SET status_conciliacao = 'FINANCEIRA',
        historico = historico || ' [AUTO-FINANCEIRA]'
    WHERE debito > 0
      AND (UPPER(historico) LIKE '%PARCELA PROGIRO%'
        OR historico ~ 'PARC\\s+00[0-9]\\s+014'
        OR UPPER(historico) LIKE '%PROGIRO%')
      AND (status_conciliacao IS NULL OR status_conciliacao NOT IN ('FINANCEIRA','SALDO','DUPLICATA','RETIRADA_SOCIO'))
      ${dateFilter}`;
  if (opts.apply) {
    const r = await db.prepare(finSql).run();
    stats.financeira = r.changes || 0;
  }
  log(`FINANCEIRA: ${stats.financeira}${sufix}`);

  // ── 4. INTRAGRUPO ────────────────────────────────────────────
  const nomePattern = NOMES_INTRAGRUPO.map(n => `UPPER(historico) LIKE '%${n}%'`).join(' OR ');
  const cnpjPattern = CNPJS_INTRAGRUPO.map(c => `UPPER(historico) LIKE '%${c}%'`).join(' OR ');
  const intraSql = `
    UPDATE extratos
    SET status_conciliacao = 'INTERNO',
        historico = historico || ' [AUTO-INTRAGRUPO]'
    WHERE debito > 0
      AND (${nomePattern} OR ${cnpjPattern})
      AND NOT (UPPER(historico) LIKE '%FUNC%' OR UPPER(historico) LIKE '%EMPREG%' OR UPPER(historico) LIKE '%FOLHA%')
      AND (status_conciliacao IS NULL OR status_conciliacao NOT IN ('INTERNO','SALDO','DUPLICATA','FINANCEIRA','RETIRADA_SOCIO'))
      ${dateFilter}`;
  if (opts.apply) {
    const r = await db.prepare(intraSql).run();
    stats.intragrupo = r.changes || 0;
  }
  log(`INTRAGRUPO: ${stats.intragrupo}${sufix}`);

  // ── 5. RETIRADA_SOCIO ────────────────────────────────────────
  const sociosPattern = NOMES_SOCIOS.map(n => `UPPER(historico) LIKE '%${n}%'`).join(' OR ');
  const retSql = `
    UPDATE extratos
    SET status_conciliacao = 'RETIRADA_SOCIO',
        historico = historico || ' [AUTO-RETIRADA_SOCIO]'
    WHERE debito > 0
      AND (UPPER(historico) LIKE '%CH.AVULSO%' OR ${sociosPattern})
      AND (status_conciliacao IS NULL OR status_conciliacao NOT IN ('RETIRADA_SOCIO','SALDO','DUPLICATA','FINANCEIRA'))
      ${dateFilter}`;
  if (opts.apply) {
    const r = await db.prepare(retSql).run();
    stats.retirada_socio = r.changes || 0;
  }
  log(`RETIRADA_SOCIO: ${stats.retirada_socio}${sufix}`);

  // ── 6. DUPLICATA cruzada (Apenas detecta — UPDATE só se --apply) ─
  // Conservador: só marca como DUPLICATA se houver par com off-by-cent (<R$ 1) na MESMA DATA
  const dupSql = `
    UPDATE extratos
    SET status_conciliacao = 'DUPLICATA',
        historico = historico || ' [AUTO-DUP]'
    WHERE id IN (
      SELECT a.id FROM extratos a
      WHERE EXISTS (
        SELECT 1 FROM extratos b
        WHERE b.id < a.id
          AND b.data_iso = a.data_iso
          AND b.conta != a.conta
          AND ABS(COALESCE(b.debito,0) - COALESCE(a.debito,0)) < 1
          AND ABS(COALESCE(b.credito,0) - COALESCE(a.credito,0)) < 1
          AND COALESCE(a.debito,0) + COALESCE(a.credito,0) > 1000
          AND b.conta != ''  -- evita duplicata de conta vazia
      )
      AND (a.status_conciliacao IS NULL OR a.status_conciliacao NOT IN ('DUPLICATA','SALDO','CONCILIADO_AUTO'))
      ${dateFilter}
    )`;
  if (opts.apply) {
    const r = await db.prepare(dupSql).run();
    stats.duplicata = r.changes || 0;
  }
  log(`DUPLICATA: ${stats.duplicata}${sufix}`);

  return stats;
}

async function main() {
  const opts = parseArgs();
  const empresas = opts.empresa ? [opts.empresa] : Object.keys(COMPANIES);
  const start = Date.now();

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Montana ERP — Auto-classify ${opts.apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  Empresas: ${empresas.join(', ')}`);
  console.log(`  Período: ${opts.since || 'todos'}`);
  console.log('═══════════════════════════════════════════════════════════');

  const total = { saldo: 0, sinal_invertido: 0, financeira: 0, intragrupo: 0, retirada_socio: 0, duplicata: 0 };
  for (const key of empresas) {
    if (!COMPANIES[key]) {
      console.warn(`  ⚠ Empresa desconhecida: ${key}`);
      continue;
    }
    try {
      const s = await classifyEmpresa(key, opts);
      for (const k of Object.keys(total)) total[k] += s[k] || 0;
    } catch (e) {
      console.error(`  ✗ ERRO [${key}]:`, e.message);
    }
  }

  console.log('');
  console.log(`  TOTAL: SALDO=${total.saldo} SINAL=${total.sinal_invertido} FINANCEIRA=${total.financeira} INTRAGRUPO=${total.intragrupo} RETIRADA=${total.retirada_socio} DUP=${total.duplicata}`);
  console.log(`  Tempo: ${Math.round((Date.now() - start) / 1000)}s`);
  if (!opts.apply) console.log(`  ℹ DRY-RUN — adicione --apply pra executar`);

  process.exit(0);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { classifyEmpresa };
