#!/usr/bin/env node
/**
 * Script standalone: gera 1 boletim por posto para um contrato/competência.
 * Conecta direto no PG (sem precisar de auth HTTP).
 *
 * Uso:
 *   node scripts/gerar-boletins-detran.js <empresa> <contrato_id> <competencia> [--apply]
 *
 * Exemplo:
 *   node scripts/gerar-boletins-detran.js assessoria 2 2026-05            # dry-run
 *   node scripts/gerar-boletins-detran.js assessoria 2 2026-05 --apply    # aplica
 */
const { Pool } = require('pg');

const [, , empresa, contratoIdRaw, competencia, flag] = process.argv;

if (!empresa || !contratoIdRaw || !competencia) {
  console.error('Uso: node gerar-boletins-detran.js <empresa> <contrato_id> <competencia> [--apply]');
  process.exit(1);
}

const contrato_id = parseInt(contratoIdRaw, 10);
const apply = flag === '--apply';

const pool = new Pool({
  host:     process.env.PG_HOST     || '35.247.208.7',
  port:     +(process.env.PG_PORT   || 5432),
  user:     process.env.PG_USER     || 'montana',
  password: process.env.PG_PASSWORD || 'montana2026',
  database: process.env.PG_DB       || 'montana_erp',
});

const MESES = ['', 'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

async function main() {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${empresa}, public`);

    // Postos do contrato
    const postos = (await client.query(`
      SELECT p.id, p.campus_nome, p.municipio, p.descricao_posto,
             COALESCE(SUM(i.quantidade * i.valor_unitario), 0) AS valor_total
      FROM bol_postos p
      LEFT JOIN bol_itens i ON i.posto_id = p.id
      WHERE p.contrato_id = $1
      GROUP BY p.id, p.campus_nome, p.municipio, p.descricao_posto, p.ordem
      ORDER BY p.ordem, p.id
    `, [contrato_id])).rows;

    if (!postos.length) {
      console.error(`Contrato ${contrato_id} não tem postos.`);
      process.exit(2);
    }

    // Boletins existentes
    const existentes = (await client.query(
      `SELECT id, posto_id FROM bol_boletins WHERE contrato_id=$1 AND competencia=$2`,
      [contrato_id, competencia]
    )).rows;

    // Contrato info
    const bcRow = (await client.query(`SELECT * FROM bol_contratos WHERE id=$1`, [contrato_id])).rows[0];
    const ctRow = bcRow ? (await client.query(`SELECT * FROM contratos WHERE numContrato=$1`, [bcRow.contrato_ref])).rows[0] : null;

    const [ano, mes] = competencia.split('-');
    const mesNome = MESES[parseInt(mes)] || mes;
    const tipoServico = bcRow?.descricao_servico || ctRow?.contrato || 'SERVIÇOS';
    const numContrato = bcRow?.contrato_ref || bcRow?.numero_contrato || '';

    const valorTotal = postos.reduce((s, p) => s + Number(p.valor_total || 0), 0);

    console.log('\n═══ PLANO ═══');
    console.log(`Empresa:           ${empresa}`);
    console.log(`Contrato ID:       ${contrato_id}`);
    console.log(`Competência:       ${competencia}`);
    console.log(`Total postos:      ${postos.length}`);
    console.log(`Já existem:        ${existentes.length}`);
    console.log(`Será apagado:      ${existentes.length}`);
    console.log(`Será criado:       ${postos.length}`);
    console.log(`Valor total:       R$ ${valorTotal.toFixed(2).replace('.', ',')}`);

    console.log('\n═══ POSTOS ═══');
    postos.forEach(p => {
      console.log(`  #${String(p.id).padStart(3)} ${p.campus_nome.padEnd(24)} R$ ${Number(p.valor_total).toFixed(2).padStart(12)}`);
    });

    if (!apply) {
      console.log('\n[DRY-RUN] nada foi alterado. Para aplicar: adicione --apply');
      return;
    }

    // Aplicar em transação
    console.log('\n═══ APLICANDO ═══');
    await client.query('BEGIN');
    try {
      let apagados = 0;
      if (existentes.length) {
        const ids = existentes.map(e => e.id);
        const r = await client.query(`DELETE FROM bol_boletins WHERE id = ANY($1::int[])`, [ids]);
        apagados = r.rowCount;
        console.log(`Apagados: ${apagados}`);
      }

      let criados = 0;
      for (const p of postos) {
        const valor = Number(p.valor_total) || 0;
        const labelPosto = (p.descricao_posto || p.campus_nome || '').toUpperCase();
        const discriminacao = `PRESTAÇÃO DE SERVIÇOS DE ${tipoServico.toUpperCase()} CONFORME CONTRATO Nº ${numContrato}, COMPETÊNCIA ${mesNome.toUpperCase()}/${ano}. POSTO: ${labelPosto}.`;

        await client.query(
          `INSERT INTO bol_boletins
            (contrato_id, posto_id, competencia, data_emissao,
             valor_base, valor_total, glosas, acrescimos,
             discriminacao, status, nfse_status)
           VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, 0, 0, $6, 'rascunho', 'PENDENTE')`,
          [contrato_id, p.id, competencia, valor, valor, discriminacao]
        );
        criados++;
        console.log(`  ✓ ${p.campus_nome} (R$ ${valor.toFixed(2)})`);
      }

      await client.query('COMMIT');
      console.log(`\n═══ OK ═══`);
      console.log(`Apagados: ${apagados}`);
      console.log(`Criados:  ${criados}`);
      console.log(`Total:    R$ ${valorTotal.toFixed(2).replace('.', ',')}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('ERRO:', err.message);
  process.exit(1);
});
