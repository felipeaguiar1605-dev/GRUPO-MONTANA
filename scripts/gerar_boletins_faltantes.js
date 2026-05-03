/**
 * Montana ERP — Gera 1 boletim por NF emitida que está sem boletim correspondente.
 *
 * Premissa do user (2026-05-02): "temos que ter um boletim por nota fiscal"
 *
 * Estratégia:
 *   - Para cada NF ATIVA (não cancelada) em assessoria.notas_fiscais
 *   - Verificar se já existe boletim com mesmo (contrato_ref, competencia)
 *   - Se NÃO houver, criar boletim em rascunho com valores derivados da NF
 *   - Vincular o nfse_numero ao boletim criado
 *
 * Cuidados:
 *   - SOMENTE NFs com status_conciliacao != 'CANCELADA'
 *   - SOMENTE contratos cadastrados em bol_contratos (match via numero_contrato em contrato_ref)
 *   - Status criado = 'rascunho' pra você revisar antes de aprovar
 *   - --apply pra executar; sem flag = dry-run
 *
 * Uso:
 *   node scripts/gerar_boletins_faltantes.js                # dry-run
 *   node scripts/gerar_boletins_faltantes.js --apply        # aplica
 *   node scripts/gerar_boletins_faltantes.js --empresa=seguranca --apply
 *   node scripts/gerar_boletins_faltantes.js --since=2026-01-01 --apply
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb, COMPANIES } = require('../src/db');

function parseArgs() {
  const a = { apply: false, empresa: null, since: '2026-01-01' };
  for (const arg of process.argv.slice(2)) {
    if (arg === '--apply') a.apply = true;
    else if (arg.startsWith('--empresa=')) a.empresa = arg.split('=')[1];
    else if (arg.startsWith('--since=')) a.since = arg.split('=')[1];
  }
  return a;
}

async function processarEmpresa(key, opts) {
  const db = getDb(key);
  console.log(`\n═══ ${key.toUpperCase()} ═══`);

  // 1. NFs ativas sem boletim correspondente
  const nfsSemBoletim = await db.prepare(`
    SELECT nf.id, nf.numero, nf.data_emissao, nf.competencia, nf.contrato_ref,
           nf.valor_bruto, nf.valor_liquido, nf.tomador, nf.discriminacao,
           SUBSTRING(nf.data_emissao, 1, 7) AS comp_iso,
           bc.id AS bol_contrato_id, bc.nome AS bol_contrato_nome
    FROM notas_fiscais nf
    LEFT JOIN bol_contratos bc ON nf.contrato_ref ILIKE '%' || bc.numero_contrato || '%'
    WHERE nf.data_emissao >= ?
      AND (nf.status_conciliacao IS NULL OR nf.status_conciliacao != 'CANCELADA')
      AND TRIM(COALESCE(nf.contrato_ref, '')) != ''
      AND bc.id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM bol_boletins b
        WHERE b.contrato_id = bc.id
          AND (b.competencia LIKE '%' || SUBSTRING(nf.data_emissao, 1, 7) || '%'
            OR REPLACE(LOWER(b.competencia), ' ', '-') = SUBSTRING(nf.data_emissao, 1, 7)
            OR b.nfse_numero = nf.numero)
      )
    ORDER BY nf.data_emissao, nf.contrato_ref, nf.numero
  `).all(opts.since);

  if (!Array.isArray(nfsSemBoletim) || nfsSemBoletim.length === 0) {
    console.log('  ✓ Nenhuma NF sem boletim — tudo coberto');
    return { criados: 0, ignorados: 0 };
  }

  console.log(`  ${nfsSemBoletim.length} NFs ativas sem boletim correspondente`);

  let criados = 0, ignorados = 0;

  if (!opts.apply) {
    // Dry-run: amostra de 10 + agrupamento por contrato
    const porContrato = {};
    for (const nf of nfsSemBoletim) {
      const k = `${nf.contrato_ref} (${nf.comp_iso})`;
      if (!porContrato[k]) porContrato[k] = { qtd: 0, valor: 0, contrato: nf.bol_contrato_nome };
      porContrato[k].qtd++;
      porContrato[k].valor += parseFloat(nf.valor_bruto) || 0;
    }
    console.log('  [DRY-RUN] Por contrato/competência:');
    for (const [k, v] of Object.entries(porContrato).slice(0, 15)) {
      console.log(`    ${k.padEnd(40)} ${String(v.qtd).padStart(3)} NFs, R$ ${v.valor.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
    }
    if (Object.keys(porContrato).length > 15) {
      console.log(`    ... e mais ${Object.keys(porContrato).length - 15} grupos`);
    }
    return { criados: 0, ignorados: nfsSemBoletim.length };
  }

  // APPLY: cria 1 boletim por NF
  for (const nf of nfsSemBoletim) {
    try {
      const compMes = nf.comp_iso; // YYYY-MM
      const dataEmissao = nf.data_emissao;
      const partes = dataEmissao.split('-');
      const ano = partes[0], mes = partes[1];
      const periodoInicio = `${ano}-${mes}-01`;
      const periodoFim = `${ano}-${mes}-${new Date(parseInt(ano), parseInt(mes), 0).getDate()}`;

      // Tentativa de inserir; se já existe (UNIQUE constraint), pula
      const r = await db.prepare(`
        INSERT INTO bol_boletins
          (contrato_id, posto_id, competencia, data_emissao, periodo_inicio, periodo_fim,
           status, valor_base, valor_total, total_geral,
           nfse_numero, nfse_data_emissao, nfse_status,
           obs, created_at, updated_at)
        VALUES
          (?, NULL, ?, ?, ?, ?,
           'rascunho', ?, ?, ?,
           ?, ?, 'EMITIDA',
           ?, NOW(), NOW())
        ON CONFLICT (contrato_id, COALESCE(posto_id, 0::bigint), competencia) DO NOTHING
      `).run(
        nf.bol_contrato_id,
        compMes,
        dataEmissao,
        periodoInicio,
        periodoFim,
        parseFloat(nf.valor_bruto) || 0,
        parseFloat(nf.valor_bruto) || 0,
        parseFloat(nf.valor_liquido) || 0,
        nf.numero,
        dataEmissao,
        `[AUTO-GERADO 2026-05-03] Boletim criado a partir da NF ${nf.numero} (${nf.tomador || ''})`
      );

      if (r && r.changes > 0) criados++;
      else ignorados++;
    } catch (e) {
      console.warn(`    ⚠ Erro NF ${nf.numero}: ${e.message}`);
      ignorados++;
    }
  }

  console.log(`  ✓ ${criados} boletins criados, ${ignorados} ignorados (já existiam ou erro)`);
  return { criados, ignorados };
}

async function main() {
  const opts = parseArgs();
  const empresas = opts.empresa ? [opts.empresa] : Object.keys(COMPANIES);

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Montana ERP — Gerar boletins faltantes ${opts.apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  Empresas: ${empresas.join(', ')}`);
  console.log(`  Desde: ${opts.since}`);
  console.log('═══════════════════════════════════════════════════════════');

  const total = { criados: 0, ignorados: 0 };
  for (const key of empresas) {
    if (!COMPANIES[key]) continue;
    try {
      const r = await processarEmpresa(key, opts);
      total.criados += r.criados;
      total.ignorados += r.ignorados;
    } catch (e) {
      console.error(`  ✗ Erro [${key}]:`, e.message);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  TOTAL: ${total.criados} boletins criados · ${total.ignorados} ignorados`);
  if (!opts.apply) console.log('  ℹ DRY-RUN — adicione --apply pra criar de verdade');
  console.log('═══════════════════════════════════════════════════════════');
  process.exit(0);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
