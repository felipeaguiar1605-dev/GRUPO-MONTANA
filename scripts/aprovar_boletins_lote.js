'use strict';
/**
 * Aprova boletins em lote (rascunho → aprovado).
 *
 * Replica o critério do endpoint POST /api/boletins/aprovar-lote
 * (src/routes/boletins.js:1827) com filtros adicionais por contrato.
 *
 * Critérios para aprovar:
 *   - status = 'rascunho'
 *   - valor_total (ou total_geral) > 0
 *   - bol_contratos.insc_municipal preenchido OU
 *     contratos.orgao localizado via numContrato/contrato_ref
 *
 * Uso:
 *   node scripts/aprovar_boletins_lote.js \
 *     --empresa=assessoria \
 *     --competencia=2026-05 \
 *     [--contrato=2] \
 *     [--dry-run]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db_pg');

function arg(name, def = null) {
  const m = process.argv.find(a => a.startsWith(`--${name}=`));
  return m ? m.split('=').slice(1).join('=') : def;
}

const EMPRESA     = arg('empresa');
const COMPETENCIA = arg('competencia');
const CONTRATO_ID = arg('contrato');
const DRY_RUN     = process.argv.includes('--dry-run');

if (!EMPRESA || !COMPETENCIA) {
  console.error('Uso: node scripts/aprovar_boletins_lote.js --empresa=<key> --competencia=YYYY-MM [--contrato=<id>] [--dry-run]');
  process.exit(1);
}
if (!/^\d{4}-\d{2}$/.test(COMPETENCIA)) {
  console.error(`Competência inválida: "${COMPETENCIA}" — esperado YYYY-MM`);
  process.exit(1);
}

const fmtR = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

async function main() {
  const db = getDb(EMPRESA);

  const params = [COMPETENCIA];
  let filtroContrato = '';
  if (CONTRATO_ID) {
    filtroContrato = ' AND b.contrato_id = ?';
    params.push(CONTRATO_ID);
  }

  const rascunhos = await db.prepare(`
    SELECT b.id,
           b.posto_id,
           b.contrato_id,
           COALESCE(b.valor_total, b.total_geral, 0) AS valor_efetivo,
           bc.insc_municipal,
           bc.contrato_ref,
           bc.numero_contrato,
           COALESCE(
             (SELECT c1.orgao FROM contratos c1
                WHERE bc.contrato_ref != '' AND c1.numContrato = bc.contrato_ref LIMIT 1),
             (SELECT c1.orgao FROM contratos c1
                WHERE bc.contrato_ref != '' AND c1.numContrato LIKE '%' || bc.contrato_ref || '%' LIMIT 1),
             (SELECT c2.orgao FROM contratos c2
                WHERE c2.numContrato LIKE '%' || bc.numero_contrato LIMIT 1),
             ''
           ) AS cnpj_tomador_contrato
      FROM bol_boletins b
      JOIN bol_contratos bc ON b.contrato_id = bc.id
     WHERE b.status = 'rascunho'
       AND b.competencia = ?
       ${filtroContrato}
     ORDER BY b.contrato_id, b.posto_id
  `).all(...params);

  console.log(`\nEmpresa:     ${EMPRESA}`);
  console.log(`Competência: ${COMPETENCIA}`);
  if (CONTRATO_ID) console.log(`Contrato:    ${CONTRATO_ID}`);
  console.log(`Modo:        ${DRY_RUN ? 'DRY-RUN (nada será gravado)' : 'APLICAR'}`);
  console.log(`Rascunhos encontrados: ${rascunhos.length}\n`);

  if (!rascunhos.length) {
    console.log('Nada a fazer.');
    process.exit(0);
  }

  let aprovados = 0;
  let totalAprovado = 0;
  const pulados = [];

  for (const bol of rascunhos) {
    if (!bol.valor_efetivo || bol.valor_efetivo <= 0) {
      pulados.push({ id: bol.id, motivo: 'valor zerado' });
      continue;
    }
    const temCnpj = (bol.insc_municipal && String(bol.insc_municipal).trim()) ||
                    (bol.cnpj_tomador_contrato && String(bol.cnpj_tomador_contrato).trim());
    if (!temCnpj) {
      pulados.push({ id: bol.id, motivo: 'sem CNPJ tomador (insc_municipal e contratos.orgao vazios)' });
      continue;
    }

    if (!DRY_RUN) {
      await db.prepare(`UPDATE bol_boletins SET status='aprovado', updated_at=NOW() WHERE id=?`).run(bol.id);
    }
    console.log(`  ✓ #${bol.id} (posto ${bol.posto_id}) — ${fmtR(bol.valor_efetivo)}`);
    aprovados++;
    totalAprovado += Number(bol.valor_efetivo);
  }

  console.log(`\nAprovados: ${aprovados} — Total: ${fmtR(totalAprovado)}`);
  if (pulados.length) {
    console.log(`Pulados:   ${pulados.length}`);
    pulados.forEach(p => console.log(`  ✗ #${p.id} — ${p.motivo}`));
  }
  if (DRY_RUN) console.log('\n[DRY-RUN] Nada foi gravado. Remova --dry-run para aplicar.');

  process.exit(0);
}

main().catch(e => {
  console.error('Erro:', e);
  process.exit(1);
});
