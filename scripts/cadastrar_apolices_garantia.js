'use strict';
/**
 * Cadastra apólices de seguro-garantia (Montana Assessoria como Tomador).
 * Origem: Montana_Docs/Apolices + Montana_Docs/Seguros_Garantia.
 *
 * Uso: node scripts/cadastrar_apolices_garantia.js [--apply]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const db = getDb('assessoria');

// Schema
db.prepare(`
  CREATE TABLE IF NOT EXISTS apolices_garantia (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    apolice_numero TEXT NOT NULL,
    apolice_susep TEXT,
    endosso TEXT,
    seguradora TEXT,
    seguradora_cnpj TEXT,
    tomador_cnpj TEXT,
    segurado TEXT,
    segurado_cnpj TEXT,
    contrato_ref TEXT,
    numContrato TEXT,
    modalidade TEXT,
    importancia_segurada REAL,
    vigencia_inicio TEXT,
    vigencia_fim TEXT,
    processo_susep TEXT,
    status TEXT DEFAULT 'ATIVA',
    pdf_origem TEXT,
    obs TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
  )
`).run();
db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_apol_uk ON apolices_garantia(apolice_numero, endosso)`).run();

// Apólices conhecidas (extraídas dos PDFs)
const APOLICES = [
  {
    apolice_numero: '014142024000507750197728',
    apolice_susep: '014142024000507750197728',
    endosso: '0000001',
    seguradora: 'BERKLEY INTERNATIONAL DO BRASIL SEGUROS SA',
    seguradora_cnpj: '01414',
    tomador_cnpj: '14092519000151',
    segurado: 'FUNDACAO UNIVERSIDADE FEDERAL DO TOCANTINS',
    segurado_cnpj: '05149726000104',
    contrato_ref: 'UFT',
    numContrato: 'UFT 16/2025',
    modalidade: '7519-Executante Prestador Serviços / Obrigações Trabalhistas e Previdenciárias',
    importancia_segurada: 487226.37,
    vigencia_inicio: '2025-06-06',
    vigencia_fim: '2026-02-05',
    processo_susep: '15414.637926/2022-84',
    status: 'VENCIDA',
    pdf_origem: 'Apolice_UFT.pdf',
    obs: 'Apólice UFT Berkley — vencida 05/02/2026, necessária renovação',
  },
  {
    apolice_numero: '014142024000507750197838',
    apolice_susep: '014142024000507750197838',
    endosso: '0000001',
    seguradora: 'BERKLEY INTERNATIONAL DO BRASIL SEGUROS SA',
    seguradora_cnpj: '01414',
    tomador_cnpj: '14092519000151',
    segurado: 'FUNDACAO UNIVERSIDADE FEDERAL DO NORTE DO TOCANTINS',
    segurado_cnpj: '38178825000173',
    contrato_ref: 'UFNT',
    numContrato: 'UFNT 30/2022',
    modalidade: 'Executante Prestador Serviços',
    importancia_segurada: 211645.33,
    vigencia_inicio: '2025-06-06',
    vigencia_fim: '2026-01-05',
    processo_susep: '15414.637925/2022-30',
    status: 'VENCIDA',
    pdf_origem: 'Apolice_UFNT.pdf',
    obs: 'Apólice UFNT Berkley — vencida 05/01/2026, necessária renovação',
  },
  {
    apolice_numero: '1007507019035',
    apolice_susep: '047822025000107757019035',
    endosso: '0000000',
    seguradora: 'NEWE SEGUROS S.A.',
    seguradora_cnpj: '26609195000165',
    tomador_cnpj: '14092519000151',
    segurado: 'FUNDACAO UNIVERSIDADE FEDERAL DO NORTE DO TOCANTINS',
    segurado_cnpj: '38178825000173',
    contrato_ref: 'UFNT 30/2022',
    numContrato: 'UFNT 30/2022',
    modalidade: 'Executante Prestador Serviços / Obrigações Trabalhistas',
    importancia_segurada: null, // não extraído
    vigencia_inicio: null,
    vigencia_fim: null,
    processo_susep: '15414.639283/2022-11',
    status: 'ATIVA',
    pdf_origem: 'Apolice_UFNT_Contrato_30-2022.pdf',
    obs: 'Apólice NEWE UFNT contrato 30/2022 — valores/vigência a extrair manualmente',
  },
  {
    apolice_numero: '1007507019097',
    apolice_susep: '047822025000107757019097',
    endosso: '0000001',
    seguradora: 'NEWE SEGUROS S.A.',
    seguradora_cnpj: '26609195000165',
    tomador_cnpj: '14092519000151',
    segurado: 'FUNDACAO UNIVERSIDADE FEDERAL DO TOCANTINS',
    segurado_cnpj: '05149726000104',
    contrato_ref: 'UFNT 29/2022 9° TA',
    numContrato: 'UFNT 29/2022',
    modalidade: 'Executante Prestador Serviços / Obrigações Trabalhistas',
    importancia_segurada: null,
    vigencia_inicio: null,
    vigencia_fim: null,
    processo_susep: '15414.673131/2025-82',
    status: 'ATIVA',
    pdf_origem: 'Seguro_Garantia_9o_Aditivo_Contrato_29-2022_UFNT.pdf',
    obs: '9° Aditivo ao contrato UFNT 29/2022 — valores/vigência a extrair manualmente',
  },
  // Minutas NEWE: 3 apólices em minuta (não emitidas ainda)
  {
    apolice_numero: 'MINUTA_202500000601022',
    apolice_susep: null,
    endosso: null,
    seguradora: 'NEWE SEGUROS S.A.',
    seguradora_cnpj: '26609195000165',
    tomador_cnpj: '14092519000151',
    segurado: 'FUNDACAO UNIVERSIDADE FEDERAL DO TOCANTINS',
    segurado_cnpj: '05149726000104',
    contrato_ref: 'UFT 8° TA',
    numContrato: 'UFT',
    modalidade: 'Seguro garantia trabalhista',
    importancia_segurada: null,
    status: 'MINUTA',
    pdf_origem: 'NEWE_Minuta_202500000601022.pdf',
    obs: 'Minuta referente ao 8° TA do contrato UFT',
  },
  {
    apolice_numero: 'MINUTA_202500000601310',
    apolice_susep: null,
    endosso: null,
    seguradora: 'NEWE SEGUROS S.A.',
    seguradora_cnpj: '26609195000165',
    tomador_cnpj: '14092519000151',
    segurado: 'FUNDACAO UNIVERSIDADE FEDERAL DO TOCANTINS',
    segurado_cnpj: '05149726000104',
    contrato_ref: 'UFT - RENOVACAO',
    numContrato: 'UFT',
    modalidade: 'Seguro garantia - renovação',
    importancia_segurada: null,
    status: 'MINUTA',
    pdf_origem: 'NEWE_Minuta_202500000601310_Renovacao.pdf',
    obs: 'Minuta de renovação UFT',
  },
  {
    apolice_numero: 'MINUTA_202500000607948',
    apolice_susep: null,
    endosso: null,
    seguradora: 'NEWE SEGUROS S.A.',
    seguradora_cnpj: '26609195000165',
    tomador_cnpj: '14092519000151',
    segurado: 'FUNDACAO UNIVERSIDADE FEDERAL DO NORTE DO TOCANTINS',
    segurado_cnpj: '38178825000173',
    contrato_ref: 'UFNT 6° TA',
    numContrato: 'UFNT',
    modalidade: 'Seguro garantia trabalhista',
    importancia_segurada: null,
    status: 'MINUTA',
    pdf_origem: 'NEWE_Minuta_202500000607948.pdf',
    obs: 'Minuta referente ao 6° TA UFNT',
  },
];

const ins = db.prepare(`
  INSERT OR REPLACE INTO apolices_garantia (
    apolice_numero, apolice_susep, endosso, seguradora, seguradora_cnpj,
    tomador_cnpj, segurado, segurado_cnpj, contrato_ref, numContrato,
    modalidade, importancia_segurada, vigencia_inicio, vigencia_fim,
    processo_susep, status, pdf_origem, obs, updated_at
  ) VALUES (
    @apolice_numero, @apolice_susep, @endosso, @seguradora, @seguradora_cnpj,
    @tomador_cnpj, @segurado, @segurado_cnpj, @contrato_ref, @numContrato,
    @modalidade, @importancia_segurada, @vigencia_inicio, @vigencia_fim,
    @processo_susep, @status, @pdf_origem, @obs, datetime('now')
  )
`);

// Normalize: ensure all keys exist for better-sqlite3 named params
const KEYS = ['apolice_numero','apolice_susep','endosso','seguradora','seguradora_cnpj','tomador_cnpj','segurado','segurado_cnpj','contrato_ref','numContrato','modalidade','importancia_segurada','vigencia_inicio','vigencia_fim','processo_susep','status','pdf_origem','obs'];
for (const a of APOLICES) { for (const k of KEYS) if (a[k] === undefined) a[k] = null; }

console.log(`\n🛡️  Apólices de Garantia — ${APPLY ? '🔥 APPLY' : '💡 DRY-RUN'}\n`);
console.log(`  ${APOLICES.length} apólices a cadastrar:`);
for (const a of APOLICES) {
  const v = a.importancia_segurada ? ` R$ ${a.importancia_segurada.toLocaleString('pt-BR',{minimumFractionDigits:2})}` : '';
  const vig = a.vigencia_fim ? ` | até ${a.vigencia_fim}` : '';
  console.log(`    [${a.status.padEnd(8)}] ${a.seguradora.split(' ')[0].padEnd(8)}  ${a.apolice_numero.padEnd(28)}  ${(a.contrato_ref||'').padEnd(20)}${v}${vig}`);
}

if (APPLY) {
  const trx = db.transaction(list => { for (const a of list) ins.run(a); });
  trx(APOLICES);
  console.log(`\n  ✅ ${APOLICES.length} apólices gravadas em apolices_garantia`);
  const stats = db.prepare(`SELECT status, COUNT(*) c FROM apolices_garantia GROUP BY status`).all();
  console.log('\n  ═══ Status ═══');
  stats.forEach(s => console.log(`    ${s.status.padEnd(10)} ${s.c}`));
} else {
  console.log('\n  💡 dry-run — use --apply');
}
