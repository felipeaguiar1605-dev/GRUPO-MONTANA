#!/usr/bin/env node
/**
 * Preview da NFS-e que SERIA enviada ao WebISS — sem emitir.
 * Conecta direto no PG (sem HTTP, sem auth).
 *
 * Uso: NODE_PATH=/opt/montana/app_unificado/node_modules \
 *      node /tmp/preview-nfse.js <empresa> <boletim_id>
 *
 * Exemplo:
 *      ... node /tmp/preview-nfse.js assessoria 616
 */
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const [, , empresa, boletimIdRaw] = process.argv;
if (!empresa || !boletimIdRaw) {
  console.error('Uso: node preview-nfse.js <empresa> <boletim_id>');
  process.exit(1);
}
const boletim_id = parseInt(boletimIdRaw, 10);

const pool = new Pool({
  host:     process.env.PG_HOST     || '35.247.208.7',
  port:     +(process.env.PG_PORT   || 5432),
  user:     process.env.PG_USER     || 'montana',
  password: process.env.PG_PASSWORD || 'montana2026',
  database: process.env.PG_DB       || 'montana_erp',
});

async function main() {
  const c = await pool.connect();
  try {
    await c.query(`SET search_path TO ${empresa}, public`);
    const bol = (await c.query(`
      SELECT b.*,
             COALESCE(b.valor_total, b.total_geral, 0) AS valor_efetivo,
             bc.contrato_ref, bc.contratante AS bc_contratante,
             bc.orgao AS bc_orgao, bc.descricao_servico AS bc_descricao,
             bc.insc_municipal AS insc_contratante,
             bc.numero_contrato,
             COALESCE(
               (SELECT c1.orgao FROM contratos c1 WHERE bc.contrato_ref != '' AND c1.numContrato = bc.contrato_ref LIMIT 1),
               (SELECT c2.orgao FROM contratos c2 WHERE c2.numContrato LIKE '%' || bc.numero_contrato LIMIT 1)
             ) AS cnpj_tomador_contrato,
             COALESCE(
               (SELECT c1.numContrato FROM contratos c1 WHERE bc.contrato_ref != '' AND c1.numContrato = bc.contrato_ref LIMIT 1),
               (SELECT c2.numContrato FROM contratos c2 WHERE c2.numContrato LIKE '%' || bc.numero_contrato LIMIT 1)
             ) AS num_contrato_encontrado
      FROM bol_boletins b
      JOIN bol_contratos bc ON b.contrato_id = bc.id
      WHERE b.id=$1`, [boletim_id])).rows[0];

    if (!bol) { console.error(`Boletim ${boletim_id} não encontrado`); process.exit(2); }

    const today = new Date().toISOString().substring(0, 10);
    const competenciaData = bol.competencia.length === 7 ? `${bol.competencia}-01` : bol.competencia;
    const aliqISS = 0.02;
    const valorISS = Math.round(bol.valor_efetivo * aliqISS * 100) / 100;
    const tomadorCnpj  = (bol.insc_contratante || bol.cnpj_tomador_contrato || '').replace(/\D/g, '');
    const tomadorRazao = bol.bc_contratante || bol.bc_orgao || 'TOMADOR NÃO CONFIGURADO';
    const rpsNum = bol.rps_numero || String(bol.id).padStart(10, '0');

    const inscPrestadora = process.env[`WEBISS_INSC_${empresa.toUpperCase()}`] || '';
    const certPath = `/opt/montana/app_unificado/certificados/${empresa}.pfx`;
    const certExiste = fs.existsSync(certPath);
    const certSenha = process.env[`WEBISS_CERT_SENHA_${empresa.toUpperCase()}`];

    const rpsBody = {
      rps: {
        numero:      rpsNum, serie: 'A', tipo: 1,
        dataEmissao: today, competencia: competenciaData,
        servico: {
          valorServicos: Number(bol.valor_efetivo),
          valorDeducoes: 0, valorPis: 0, valorCofins: 0,
          valorInss: 0, valorIr: 0, valorCsll: 0,
          issRetido: false, valorIss: valorISS, aliquota: aliqISS,
          itemLista: '07.17', codTributacao: '070700',
          discriminacao: (bol.discriminacao || 'PRESTAÇÃO DE SERVIÇOS').substring(0, 2000),
          exigibilidadeIss: 1,
        },
        tomador: { cnpj: tomadorCnpj || null, razaoSocial: tomadorRazao, email: '' },
      },
    };

    const pendencias = [];
    if (bol.nfse_status === 'EMITIDA') pendencias.push(`NFS-e ${bol.nfse_numero} já emitida`);
    if (bol.status !== 'aprovado')     pendencias.push(`Status do boletim deve ser 'aprovado' (atual: '${bol.status}')`);
    if (!bol.valor_efetivo || bol.valor_efetivo <= 0) pendencias.push('Valor zero/negativo');
    if (!tomadorCnpj)                  pendencias.push('CNPJ do tomador NÃO configurado');
    if (!inscPrestadora)               pendencias.push(`WEBISS_INSC_${empresa.toUpperCase()} não no .env`);
    if (!certExiste)                   pendencias.push(`Certificado A1 não encontrado: ${certPath}`);
    if (!certSenha)                    pendencias.push(`WEBISS_CERT_SENHA_${empresa.toUpperCase()} não no .env`);

    console.log('\n═══ PENDÊNCIAS ═══');
    if (pendencias.length === 0) {
      console.log('  ✅ Nenhuma — pode emitir!');
    } else {
      pendencias.forEach(p => console.log(`  ⚠ ${p}`));
    }

    console.log('\n═══ BOLETIM ═══');
    console.log(`  ID:           ${bol.id}`);
    console.log(`  Posto ID:     ${bol.posto_id || '(NULL — modelo legado)'}`);
    console.log(`  Competência:  ${bol.competencia}`);
    console.log(`  Status:       ${bol.status}`);
    console.log(`  NFS-e Status: ${bol.nfse_status}`);
    console.log(`  Valor:        R$ ${Number(bol.valor_efetivo).toFixed(2)}`);

    console.log('\n═══ TOMADOR (DETRAN) ═══');
    console.log(`  CNPJ:           ${tomadorCnpj || '(VAZIO!)'}`);
    console.log(`  Razão Social:   ${tomadorRazao}`);
    console.log(`  Contrato Ref:   ${bol.contrato_ref || '(vazio)'}`);
    console.log(`  Num. Contrato:  ${bol.numero_contrato || '(vazio)'}`);
    console.log(`  Encontrado em contratos: ${bol.num_contrato_encontrado || '(NÃO encontrado!)'}`);

    console.log('\n═══ PRESTADORA (Montana) ═══');
    console.log(`  Empresa:               ${empresa}`);
    console.log(`  Inscrição Municipal:   ${inscPrestadora || '(NÃO CONFIGURADA)'}`);
    console.log(`  Certificado A1:        ${certExiste ? '✅ ' + certPath : '❌ NÃO existe em ' + certPath}`);
    console.log(`  Senha do certificado:  ${certSenha ? '✅ configurada' : '❌ NÃO configurada'}`);

    console.log('\n═══ TRIBUTAÇÃO ═══');
    console.log(`  Item Lista Serviços:   07.17`);
    console.log(`  Código Trib. Município: 070700`);
    console.log(`  Alíquota ISS:           ${aliqISS} (${(aliqISS*100).toFixed(2)}%)`);
    console.log(`  Valor ISS:              R$ ${valorISS.toFixed(2)}`);
    console.log(`  ISS Retido:             false`);

    console.log('\n═══ DISCRIMINAÇÃO ═══');
    console.log(`  ${bol.discriminacao || '(vazio)'}`);

    console.log('\n═══ PAYLOAD WEBISS ═══');
    console.log(JSON.stringify(rpsBody, null, 2));

  } finally {
    c.release();
    await pool.end();
  }
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
