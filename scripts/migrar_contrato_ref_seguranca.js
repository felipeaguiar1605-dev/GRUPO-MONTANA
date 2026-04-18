'use strict';
/**
 * Popula a coluna `contrato_ref` das NFs da Segurança com base no tomador.
 *
 * Mapeamento tomador → contrato usa o catálogo de contratos ativo da empresa.
 * Para SEDUC distingue entre contratos 11/2023 (valor ~51k, CMSD) e 070/2023 (~76k, SEDUC sede)
 * pelo valor_bruto da NF.
 *
 * Uso:
 *   node scripts/migrar_contrato_ref_seguranca.js           (dry-run)
 *   node scripts/migrar_contrato_ref_seguranca.js --apply   (grava)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const db = getDb('seguranca');

// ── Mapeamento tomador-prefixo → contrato_ref ──
// Ordem importa: regras mais específicas antes das genéricas.
function resolveContrato(nf) {
  const t = (nf.tomador || '').toUpperCase();
  const comp = nf.competencia || '';
  const bruto = nf.valor_bruto || 0;

  // ── PREFEITURA DE PALMAS (SRP 077/2025 desde ~jul/2025; antes 007/2023) ──
  const ehPalmas =
    t.includes('MUNICIPIO DE PALMAS') ||
    t.includes('MUNICÍPIO DE PALMAS') ||
    t.includes('FUNDACAO CULTURAL DE PALMAS') ||
    t.includes('FUNDAÇÃO CULTURAL DE PALMAS') ||
    t.includes('FCP') ||
    t.includes('ATCP') ||
    t.includes('AGENCIA DE TRANSPORTE COLETIVO') ||
    t.includes('AGÊNCIA DE TRANSPORTE COLETIVO') ||
    t.includes('PMP-') ||
    t.includes('FUNDACAO MUNICIPAL DE MEIO AMBIENTE') ||
    t.includes('FUNDAÇÃO MUNICIPAL DE MEIO AMBIENTE') ||
    t.includes('FMMA') ||
    t.includes('AGENCIA DE REGULACAO') ||
    t.includes('AGÊNCIA DE REGULAÇÃO') ||
    t.includes('INSTITUTO DE PREVIDENCIA SOCIAL DO MUNICIPIO DE PALMAS') ||
    t.includes('INSTITUTO DE PREVIDÊNCIA SOCIAL DO MUNICÍPIO DE PALMAS') ||
    t.includes('PREVIDENCIA SOCIAL DO MUNICIPIO DE PALMAS') ||
    t.includes('PREVIDÊNCIA SOCIAL DO MUNICÍPIO DE PALMAS') ||
    t.includes('PREVIPALMAS') ||
    t.includes('SECRETARIA MUNICIPAL DE ADMINISTRA') ||
    t.includes('FUNDO MUNICIPAL DE ASSISTENCIA SOCIAL') ||
    t.includes('FUNDACAO MUNICIPAL DA JUVENTUDE') ||
    t.includes('FUNDAÇÃO MUNICIPAL DA JUVENTUDE') ||
    t.includes('AGENCIA DE TECNOLOGIA DA INFORMACAO DO MUNICIPIO');

  if (ehPalmas) {
    // Competência ≥ 07/2025 → SRP 077/2025; senão → 007/2023 (encerrado)
    const ano = extrairAnoComp(comp);
    const mes = extrairMesComp(comp);
    if (ano > 2025 || (ano === 2025 && mes >= 7)) return 'Prefeitura Palmas 077/2025 (SRP)';
    return 'Prefeitura Palmas 007/2023';
  }

  // ── MINISTÉRIO PÚBLICO DO TOCANTINS ──
  if (t.includes('MINISTERIO PUBLICO') || t.includes('MINISTÉRIO PÚBLICO') || t.includes('MP/TO') || t.includes('PGJ'))
    return 'MP 007/2026';

  // ── SEDUC (2 contratos: 11/2023 ~51k ou 070/2023 ~76k) ──
  if (t.includes('SECRETARIA DA EDUCACAO') || t.includes('SECRETARIA DA EDUCAÇÃO') || t.includes('SEDUC')) {
    // distingue pelo valor: 070/2023 tem valor mensal maior (76k) e NFs de R$ 47k-77k
    // 11/2023 tem valor menor (51k) e NFs de R$ 51k-53k aprox
    if (bruto >= 70000) return 'SEDUC 070/2023 + 3°TA';
    return 'SEDUC 11/2023 + 3°TA';
  }

  // ── UFT (segurança privada, pode não ter contrato registrado ainda) ──
  if (t.includes('UFT') || t.includes('FUNDACAO UNIVERSIDADE FEDERAL') || t.includes('FUNDAÇÃO UNIVERSIDADE FEDERAL'))
    return 'UFT — Segurança Privada';

  // ── CONTAMINADAS Assessoria (Segurança não tem estes contratos) ──
  if (t.includes('UNITINS') || t.includes('DETRAN') || t.includes('TCE') ||
      t.includes('TRIBUNAL DE CONTAS') || t.includes('CORPO DE BOMBEIROS') || t.includes('CBMTO') ||
      t.includes('FUNDO ESPECIAL DE MODERNIZACAO') || t.includes('FUNJURIS') ||
      t.includes('SESAU') || t.includes('SECRETARIA DA SAUDE') || t.includes('SECRETARIA DA SAÚDE') ||
      t.includes('SEMARH') || t.includes('SEINFRA') || t.includes('SECRETARIA DA INFRA') ||
      t.includes('DEPARTAMENTO ESTADUAL DE TRANSITO') || t.includes('DEPARTAMENTO ESTADUAL DE TRÂNSITO'))
    return '⚠️ CONTAMINADA — Pertence Assessoria';

  // ── OUTROS (Instituto 20 maio etc.) ──
  if (t.includes('INSTITUTO 20 DE MAIO')) return 'Instituto 20 Maio (avulso)';

  return null;  // sem mapeamento
}

function extrairAnoComp(c) {
  let m = String(c).toLowerCase().match(/^[a-zç]{3}\/(\d{2,4})$/);
  if (m) return m[1].length === 2 ? 2000 + parseInt(m[1]) : parseInt(m[1]);
  m = String(c).match(/^(\d{4})-\d{2}/);
  return m ? parseInt(m[1]) : 0;
}
function extrairMesComp(c) {
  const meses = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  let m = String(c).toLowerCase().match(/^([a-zç]{3})\/(\d{2,4})$/);
  if (m) return meses.indexOf(m[1]) + 1;
  m = String(c).match(/^\d{4}-(\d{2})/);
  return m ? parseInt(m[1]) : 0;
}

function main() {
  const nfs = db.prepare(`SELECT id, numero, tomador, competencia, valor_bruto, contrato_ref FROM notas_fiscais`).all();
  console.log(`\n📄 NFs na Segurança: ${nfs.length}`);

  const porContrato = {};
  let semMapa = 0, jaTinha = 0, aAtualizar = 0;

  for (const nf of nfs) {
    const ref = resolveContrato(nf);
    if (!ref) { semMapa++; porContrato['SEM MAPA'] = (porContrato['SEM MAPA']||0)+1; continue; }
    porContrato[ref] = (porContrato[ref]||0)+1;
    if (nf.contrato_ref === ref) jaTinha++;
    else aAtualizar++;
  }

  console.log(`\n  Distribuição por contrato_ref resolvido:`);
  for (const [k, v] of Object.entries(porContrato).sort((a,b) => b[1]-a[1])) {
    console.log(`    ${String(v).padStart(5)}  ${k}`);
  }
  console.log(`\n  → Já estavam corretas: ${jaTinha}`);
  console.log(`  → Precisam atualizar:  ${aAtualizar}`);
  console.log(`  → Sem mapeamento:      ${semMapa}`);

  if (!APPLY) {
    console.log(`\n⚠️  Dry-run. Rode com --apply para gravar.\n`);
    return;
  }

  const upd = db.prepare(`UPDATE notas_fiscais SET contrato_ref = ? WHERE id = ?`);
  const tx = db.transaction(() => {
    let n = 0;
    for (const nf of nfs) {
      const ref = resolveContrato(nf);
      if (ref && nf.contrato_ref !== ref) { upd.run(ref, nf.id); n++; }
    }
    console.log(`\n✅ ${n} NFs atualizadas.`);
  });
  tx();
}

main();
