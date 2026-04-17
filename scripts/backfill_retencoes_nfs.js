'use strict';
/**
 * Backfill de retenções por tributo (PIS/COFINS/IRRF/CSLL/INSS/ISS) em NFs.
 *
 * DESCOBERTA: O WebISS importa apenas o `retencao` total — sem detalhamento.
 * Pior: para tomadores federais (UFT/UFNT, R$ 56M brutos), a retenção total
 * registrada (~R$ 2,5M) coincide com o IRRF 4,80% sozinho — significa que
 * PIS 0,65% + COFINS 3% + CSLL 1% (= ~R$ 2,5M adicionais legais) NEM ESTÃO
 * no `retencao` da NF. Estavam sendo "esquecidos" no crédito de retenção
 * sofrida na apuração caixa.
 *
 * Estado atual (Assessoria):
 *   • IR registrado:  R$    103.952  →  esperado legal: R$ 6.300.000  (60× menor)
 *   • PIS:            R$     16.243  →  esperado legal: R$   766.700  (47× menor)
 *   • COFINS:         R$     74.971  →  esperado legal: R$ 3.538.000  (47× menor)
 *
 * SOLUÇÃO (modos):
 *   --modo=proporcional  : redistribui o `retencao` total entre tributos
 *                          conforme alíquotas legais (preserva total, mas
 *                          subestima PIS/COFINS quando retencao é parcial)
 *   --modo=legal         : aplica alíquotas legais sobre o bruto direto
 *                          (PIS 0,65, COFINS 3, IRRF 4,80 federal / 1,20 outros).
 *                          Preserva `retencao` antigo (campos individuais
 *                          podem somar mais que ele).
 *   --modo=legal-rec     : modo legal + RECALCULA `retencao` total como
 *                          soma dos tributos calculados (mais fiel ao XML
 *                          fiscal real; corrige a subestimação histórica).
 *
 * Uso:
 *   node scripts/backfill_retencoes_nfs.js                          # dry-run modo proporcional
 *   node scripts/backfill_retencoes_nfs.js --modo=legal-rec         # dry-run modo legal+recalc
 *   node scripts/backfill_retencoes_nfs.js --modo=legal-rec --apply # aplica
 *   node scripts/backfill_retencoes_nfs.js --empresa=seguranca      # outra empresa
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const ARG = process.argv.slice(2);
const APLICAR = ARG.includes('--apply');
const arg = (k, def = '') => (ARG.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || def;
const empresa = arg('empresa', 'assessoria');
const MODO = arg('modo', 'proporcional');
if (!['proporcional', 'legal', 'legal-rec'].includes(MODO)) {
  console.error(`❌ --modo inválido: ${MODO}. Use: proporcional | legal | legal-rec`);
  process.exit(1);
}
// Filtro de período: --anos=2025,2026 (default) | --anos=todos
const anosArg = arg('anos', '2025,2026');
const ANOS = anosArg === 'todos' ? null : anosArg.split(',').map(s => s.trim());

// IRRF reduzido (1,2%) para serviços COM material/insumos (limpeza, conservação,
// vigilância, segurança, transporte) — IN RFB 1.234/2012 Anexo I, código DARF 6147.
// Aplicado a partir de --material-desde=MM/AAAA (default: '12/2025').
// Toda carteira Montana é desse tipo (limpeza/vigilância/motoristas/copeiragem),
// mas só passamos a aplicar a alíquota reduzida nas NFs emitidas a partir desta data.
const MATERIAL_DESDE = arg('material-desde', '12/2025');  // formato MM/AAAA
const IRRF_MATERIAL = 1.20;  // % — substitui o 4,80% padrão
const IRRF_PADRAO   = 4.80;  // % — serviços profissionais puros (não aplicável à Montana)

// Parse MM/AAAA → { ano: 2025, mes: 12 }
const matMD = MATERIAL_DESDE.match(/^(\d{1,2})\/(\d{2,4})$/);
const MAT_DESDE_MES = matMD ? parseInt(matMD[1]) : 12;
const MAT_DESDE_ANO = matMD ? (matMD[2].length === 2 ? 2000 + parseInt(matMD[2]) : parseInt(matMD[2])) : 2025;

// Mapa de mês PT-BR (3 letras lowercase) → número
const MES_PT = { jan:1, fev:2, mar:3, abr:4, mai:5, jun:6, jul:7, ago:8, set:9, out:10, nov:11, dez:12 };
function competenciaToYM(competencia) {
  // formatos: 'jan/26', 'fev/2026', 'dez/25'
  if (!competencia) return null;
  const m = String(competencia).toLowerCase().match(/^([a-zç]{3})\/(\d{2,4})$/);
  if (!m) return null;
  const mes = MES_PT[m[1]];
  if (!mes) return null;
  const ano = m[2].length === 2 ? 2000 + parseInt(m[2]) : parseInt(m[2]);
  return { ano, mes };
}
function ehMaterialReduzido(competencia) {
  const ym = competenciaToYM(competencia);
  if (!ym) return false;
  return (ym.ano > MAT_DESDE_ANO) || (ym.ano === MAT_DESDE_ANO && ym.mes >= MAT_DESDE_MES);
}

function filtroAnoSql(prefix = '') {
  if (!ANOS) return '';
  // competencia formats observados: 'jan/26', 'fev/2026', 'jan/25', 'dez/2025'
  const conds = [];
  for (const ano of ANOS) {
    const yy = ano.slice(-2);
    conds.push(`${prefix}competencia LIKE '%/${yy}'`);
    conds.push(`${prefix}competencia LIKE '%/${ano}'`);
  }
  return ' AND (' + conds.join(' OR ') + ')';
}

const REGRAS = {
  federal:   { inss: 11.00, irrf: 4.80, csll: 1.00, pis: 0.65, cofins: 3.00, label: 'Federal' },
  estadual:  { inss: 11.00, irrf: 1.20, csll: 0,    pis: 0,    cofins: 0,    label: 'Estadual' },
  municipal: { inss: 11.00, irrf: 1.20, csll: 0,    pis: 0,    cofins: 0,    label: 'Municipal' },
};

const ISS_MUNICIPIOS = {
  'PALMAS': 5, 'GURUPI': 5, 'ARAGUAINA': 5, 'PARAISO DO TOCANTINS': 5,
  'PARAÍSO DO TOCANTINS': 5, 'PORTO NACIONAL': 5,
  'ARRAIAS': 3, 'DIANOPOLIS': 3, 'DIANÓPOLIS': 3, 'MIRACEMA DO TOCANTINS': 3,
  'FORMOSO DO ARAGUAIA': 3, 'TOCANTINOPOLIS': 3, 'AUGUSTINOPOLIS': 3,
  '_DEFAULT': 5,
};

const TOMADOR_ESFERA = [
  { pattern: /universidade federal|UFT|UFNT|fund.*univ.*federal/i, esfera: 'federal' },
  { pattern: /tribunal de contas/i, esfera: 'estadual' },
  { pattern: /procuradoria.*justi[cç]a|minist[eé]rio p[uú]blico|PGJ/i, esfera: 'estadual' },
  { pattern: /DETRAN|departamento.*tr[aâ]nsito/i, esfera: 'estadual' },
  { pattern: /corpo de bombeiros|CBMTO/i, esfera: 'estadual' },
  { pattern: /SEDUC|secretaria.*educa[cç][aã]o/i, esfera: 'estadual' },
  { pattern: /UNITINS|universidade estadual/i, esfera: 'estadual' },
  { pattern: /SECCIDADES|secret.*cidades/i, esfera: 'estadual' },
  { pattern: /munic[ií]pio|prefeitura|SEMHARH|SESAU|FCP|fund.*cultural|ATCP|ag[eê]ncia.*transporte|PREVI.*PALMAS|instituto.*previd[eê]ncia/i, esfera: 'municipal' },
];

function classificar(tomador) {
  if (!tomador) return 'estadual';
  for (const r of TOMADOR_ESFERA) if (r.pattern.test(tomador)) return r.esfera;
  return 'estadual';
}

// CBS/IBS — Reforma Tributária 2026 (EC 132/2023, LC 214/2025)
// Período de teste: alíquotas simbólicas, COMPENSÁVEIS com PIS/COFINS/ICMS/ISS devidos
// Tomadores NÃO retêm CBS/IBS em 2026 (sem repercussão financeira na fonte)
const CBS_2026 = 0.90; // % federal — substitui PIS+COFINS (transição)
const IBS_2026 = 0.10; // % estadual+municipal — substitui ICMS+ISS (transição)

function isAno2026Plus(competencia) {
  if (!competencia) return false;
  const m = String(competencia).match(/\/(\d{2,4})$/);
  if (!m) return false;
  const ano = m[1].length === 2 ? 2000 + parseInt(m[1]) : parseInt(m[1]);
  return ano >= 2026;
}

function calcularEsperado(bruto, tomador, cidade, competencia) {
  const esfera = classificar(tomador);
  const reg = REGRAS[esfera];
  const cidadeUp = (cidade || '').toUpperCase().trim();
  const issAliq = ISS_MUNICIPIOS[cidadeUp] || ISS_MUNICIPIOS['_DEFAULT'];
  const aplicaCsrf = bruto > 215.05;

  // Override IRRF para FEDERAL com material/insumos (a partir de dez/2025):
  // 4,80% → 1,20%. Estadual/municipal já usam 1,20% por padrão (sem alteração).
  let irrfAliq = reg.irrf;
  let irrfMaterial = false;
  if (esfera === 'federal' && ehMaterialReduzido(competencia)) {
    irrfAliq = IRRF_MATERIAL;
    irrfMaterial = true;
  }

  const ret = {
    esfera,
    irrfMaterial,            // flag — usado p/ relatório
    irrfAliqAplicada: irrfAliq,
    inss:   +(bruto * reg.inss   / 100).toFixed(2),
    irrf:   +(bruto * irrfAliq   / 100).toFixed(2),
    csll:   aplicaCsrf ? +(bruto * reg.csll   / 100).toFixed(2) : 0,
    pis:    aplicaCsrf ? +(bruto * reg.pis    / 100).toFixed(2) : 0,
    cofins: aplicaCsrf ? +(bruto * reg.cofins / 100).toFixed(2) : 0,
    iss:    +(bruto * issAliq    / 100).toFixed(2),
  };
  ret.total = +(ret.inss + ret.irrf + ret.csll + ret.pis + ret.cofins + ret.iss).toFixed(2);
  return ret;
}

function brl(n) { return Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function main() {
  console.log(`\n💰 Backfill Retenções por Tributo — empresa=${empresa}`);
  console.log(`   Modo: ${MODO}  |  ${APLICAR ? '🔥 APLICAR' : '🧪 DRY-RUN'}\n`);

  const db = getDb(empresa);

  // Adiciona colunas cbs/ibs se ainda não existem (Reforma Tributária 2026+).
  // ALTER TABLE é seguro mesmo em dry-run (apenas adiciona coluna, sem alterar dados).
  let cols = db.prepare("PRAGMA table_info(notas_fiscais)").all().map(c => c.name);
  if (!cols.includes('cbs')) {
    db.exec("ALTER TABLE notas_fiscais ADD COLUMN cbs REAL DEFAULT 0");
    console.log('  ➕ Coluna `cbs` criada (CBS — Reforma Tributária)');
  }
  if (!cols.includes('ibs')) {
    db.exec("ALTER TABLE notas_fiscais ADD COLUMN ibs REAL DEFAULT 0");
    console.log('  ➕ Coluna `ibs` criada (IBS — Reforma Tributária)');
  }

  // Para modos legal e legal-rec processamos TODAS as NFs com bruto > 0
  // (mesmo as que já têm pis/cofins/ir parcialmente preenchidos — corrigimos para o legal)
  // Para modo proporcional, só processamos as que têm retencao>0 e pis=0/cofins=0 (sem detalhamento)
  let nfs;
  const fltAno = filtroAnoSql();
  if (MODO === 'proporcional') {
    nfs = db.prepare(`
      SELECT id, numero, competencia, tomador, cidade, valor_bruto,
             inss, ir, iss, csll, pis, cofins, retencao
      FROM notas_fiscais
      WHERE retencao > 0
        AND (pis IS NULL OR pis = 0)
        AND (cofins IS NULL OR cofins = 0)
        AND valor_bruto > 215.05
        ${fltAno}
      ORDER BY valor_bruto DESC
    `).all();
  } else {
    nfs = db.prepare(`
      SELECT id, numero, competencia, tomador, cidade, valor_bruto,
             inss, ir, iss, csll, pis, cofins, retencao
      FROM notas_fiscais
      WHERE valor_bruto > 215.05
        ${fltAno}
      ORDER BY valor_bruto DESC
    `).all();
  }
  console.log(`   Filtro ano: ${ANOS ? ANOS.join(', ') : 'TODOS'}`);

  console.log(`📊 NFs a processar: ${nfs.length}`);
  console.log(`   Total bruto: R$ ${brl(nfs.reduce((s, n) => s + n.valor_bruto, 0))}`);
  console.log(`   Retenção total atual: R$ ${brl(nfs.reduce((s, n) => s + (n.retencao || 0), 0))}\n`);

  const porEsfera = {};
  ['federal', 'estadual', 'municipal'].forEach(e => {
    porEsfera[e] = { qtd: 0, bruto: 0, retAntes: 0, retDepois: 0,
                     ir: 0, pis: 0, cofins: 0, csll: 0, inss: 0, iss: 0 };
  });

  // Update inclui cbs/ibs se a coluna existe (após ALTER TABLE acima)
  const update = db.prepare(`
    UPDATE notas_fiscais
    SET inss=@inss, ir=@ir, iss=@iss, csll=@csll, pis=@pis, cofins=@cofins,
        cbs=@cbs, ibs=@ibs, retencao=@retencao
    WHERE id=@id
  `);

  let processadas = 0, semBase = 0;

  let qtdMaterialReduzido = 0;
  let economiaIRRFmaterial = 0;  // diferença = bruto * (4.80% - 1.20%) — quanto a empresa "deixa de receber" como crédito

  const calcular = () => {
    for (const nf of nfs) {
      const esp = calcularEsperado(nf.valor_bruto, nf.tomador, nf.cidade, nf.competencia);
      if (esp.total <= 0) { semBase++; continue; }
      if (esp.irrfMaterial) {
        qtdMaterialReduzido++;
        economiaIRRFmaterial += +(nf.valor_bruto * (IRRF_PADRAO - IRRF_MATERIAL) / 100).toFixed(2);
      }

      let pisVal, cofinsVal, inssVal, irVal, issVal, csllVal, retencaoFinal;

      if (MODO === 'proporcional') {
        const fator = (nf.retencao || 0) / esp.total;
        inssVal   = +(esp.inss   * fator).toFixed(2);
        irVal     = +(esp.irrf   * fator).toFixed(2);
        issVal    = +(esp.iss    * fator).toFixed(2);
        csllVal   = +(esp.csll   * fator).toFixed(2);
        pisVal    = +(esp.pis    * fator).toFixed(2);
        cofinsVal = +(esp.cofins * fator).toFixed(2);
        retencaoFinal = nf.retencao; // preserva
      } else {
        // legal / legal-rec: aplica alíquotas legais direto sobre bruto
        // Federal retém: PIS + COFINS + CSLL + IRRF (não retém INSS nem ISS no campo `retencao`)
        // Estadual/municipal retém: IRRF + ISS (INSS é GPS separada — não soma na retencao da NF)
        if (esp.esfera === 'federal') {
          pisVal    = esp.pis;
          cofinsVal = esp.cofins;
          csllVal   = esp.csll;
          irVal     = esp.irrf;
          // INSS e ISS: federal não retém na NF (INSS vai pra GPS, ISS é municipal)
          inssVal = nf.inss || 0;  // preserva o que já estava (alguma NF de Palmas pode ter)
          issVal  = nf.iss  || 0;
        } else {
          // estadual/municipal
          irVal   = esp.irrf;   // 1,2% s/ serv. c/ material
          issVal  = esp.iss;    // varia por município
          inssVal = nf.inss || 0;  // preserva original
          pisVal    = nf.pis    || 0;
          cofinsVal = nf.cofins || 0;
          csllVal   = nf.csll   || 0;
        }
        retencaoFinal = MODO === 'legal-rec'
          ? +(pisVal + cofinsVal + csllVal + irVal + inssVal + issVal).toFixed(2)
          : nf.retencao;
      }

      // CBS/IBS — só para NFs de 2026+ (Reforma Tributária)
      // Em 2026 são INFORMATIVOS (compensáveis com PIS/COFINS/ISS) — não retidos pelo tomador
      // → não somam ao `retencao` total da NF
      const ehReforma = isAno2026Plus(nf.competencia);
      const cbsVal = ehReforma ? +(nf.valor_bruto * CBS_2026 / 100).toFixed(2) : 0;
      const ibsVal = ehReforma ? +(nf.valor_bruto * IBS_2026 / 100).toFixed(2) : 0;

      porEsfera[esp.esfera].qtd++;
      porEsfera[esp.esfera].bruto += nf.valor_bruto;
      porEsfera[esp.esfera].retAntes += (nf.retencao || 0);
      porEsfera[esp.esfera].retDepois += retencaoFinal;
      porEsfera[esp.esfera].ir     += irVal;
      porEsfera[esp.esfera].pis    += pisVal;
      porEsfera[esp.esfera].cofins += cofinsVal;
      porEsfera[esp.esfera].csll   += csllVal;
      porEsfera[esp.esfera].inss   += inssVal;
      porEsfera[esp.esfera].iss    += issVal;
      porEsfera[esp.esfera].cbs = (porEsfera[esp.esfera].cbs || 0) + cbsVal;
      porEsfera[esp.esfera].ibs = (porEsfera[esp.esfera].ibs || 0) + ibsVal;

      if (APLICAR) update.run({
        id: nf.id, inss: inssVal, ir: irVal, iss: issVal,
        csll: csllVal, pis: pisVal, cofins: cofinsVal,
        cbs: cbsVal, ibs: ibsVal, retencao: retencaoFinal,
      });
      processadas++;
    }
  };
  if (APLICAR) db.transaction(calcular)(); else calcular();

  console.log('📈 Resumo por esfera:\n');
  console.log('  ESFERA      |  NFs   | BRUTO              | IR backfill        | PIS backfill       | COFINS backfill    | CSLL backfill      | RETENÇÃO antes     | RETENÇÃO depois');
  console.log('  ' + '─'.repeat(170));
  for (const [esfera, v] of Object.entries(porEsfera)) {
    if (v.qtd === 0) continue;
    console.log(`  ${esfera.padEnd(11)} | ${String(v.qtd).padStart(6)} | R$ ${brl(v.bruto).padStart(15)} | R$ ${brl(v.ir).padStart(15)} | R$ ${brl(v.pis).padStart(15)} | R$ ${brl(v.cofins).padStart(15)} | R$ ${brl(v.csll).padStart(15)} | R$ ${brl(v.retAntes).padStart(15)} | R$ ${brl(v.retDepois).padStart(15)}`);
  }

  // Estado projetado vs atual no banco inteiro
  const atual = db.prepare(`
    SELECT ROUND(SUM(ir),2) as ir, ROUND(SUM(pis),2) as pis, ROUND(SUM(cofins),2) as cofins,
           ROUND(SUM(csll),2) as csll, ROUND(SUM(inss),2) as inss, ROUND(SUM(iss),2) as iss,
           ROUND(SUM(retencao),2) as ret
    FROM notas_fiscais
  `).get();

  const totalIR = Object.values(porEsfera).reduce((s, v) => s + v.ir, 0);
  const totalPIS = Object.values(porEsfera).reduce((s, v) => s + v.pis, 0);
  const totalCOFINS = Object.values(porEsfera).reduce((s, v) => s + v.cofins, 0);
  const totalCSLL = Object.values(porEsfera).reduce((s, v) => s + v.csll, 0);
  const totalRet = Object.values(porEsfera).reduce((s, v) => s + v.retDepois, 0);
  const totalRetAntes = Object.values(porEsfera).reduce((s, v) => s + v.retAntes, 0);

  console.log(`\n📦 Estado das somas no banco (todas NFs):`);
  console.log(`                  ATUAL              PROJETADO (NFs do scope)        DIFERENÇA`);
  console.log(`  IR        : R$ ${brl(atual.ir).padStart(15)}   →   R$ ${brl(totalIR).padStart(15)}   (Δ R$ ${brl(totalIR - (atual.ir || 0))})`);
  console.log(`  PIS       : R$ ${brl(atual.pis).padStart(15)}   →   R$ ${brl(totalPIS).padStart(15)}   (Δ R$ ${brl(totalPIS - (atual.pis || 0))})`);
  console.log(`  COFINS    : R$ ${brl(atual.cofins).padStart(15)}   →   R$ ${brl(totalCOFINS).padStart(15)}   (Δ R$ ${brl(totalCOFINS - (atual.cofins || 0))})`);
  console.log(`  CSLL      : R$ ${brl(atual.csll).padStart(15)}   →   R$ ${brl(totalCSLL).padStart(15)}   (Δ R$ ${brl(totalCSLL - (atual.csll || 0))})`);
  if (MODO === 'legal-rec') {
    console.log(`  RETENCAO  : R$ ${brl(totalRetAntes).padStart(15)}   →   R$ ${brl(totalRet).padStart(15)}   (Δ R$ ${brl(totalRet - totalRetAntes)})`);
  }

  // CBS/IBS — Reforma Tributária 2026
  const totalCBS = Object.values(porEsfera).reduce((s, v) => s + (v.cbs || 0), 0);
  const totalIBS = Object.values(porEsfera).reduce((s, v) => s + (v.ibs || 0), 0);
  if (totalCBS > 0 || totalIBS > 0) {
    console.log(`\n📜 Reforma Tributária 2026 (informativo — compensável, não retido):`);
    console.log(`  CBS (0,9%): R$ ${brl(totalCBS).padStart(15)}   |   IBS (0,1%): R$ ${brl(totalIBS).padStart(15)}`);
  }

  // IRRF reduzido — serviços com material/insumos
  if (qtdMaterialReduzido > 0) {
    console.log(`\n🔧 IRRF reduzido 1,2% (serviços c/ material — IN RFB 1.234/2012, código DARF 6147):`);
    console.log(`   A partir de ${String(MAT_DESDE_MES).padStart(2,'0')}/${MAT_DESDE_ANO} — ${qtdMaterialReduzido} NFs federais reclassificadas (4,80% → 1,20%)`);
    console.log(`   Impacto: R$ ${brl(economiaIRRFmaterial)} a MENOS de IRRF retido (= mais R$ a receber líquido nas NFs)`);
    console.log(`   Crédito de retenção próprio diminui no mesmo valor (= menos compensação na apuração IRPJ).`);
  }

  if (APLICAR) {
    console.log(`\n✅ ${processadas} NFs atualizadas no banco. ${semBase} ignoradas (sem regra).`);
  } else {
    console.log(`\n🧪 DRY-RUN: ${processadas} NFs seriam atualizadas. Use --apply para gravar.`);
  }
  console.log('\n✔️  Concluído.\n');
}

main();
