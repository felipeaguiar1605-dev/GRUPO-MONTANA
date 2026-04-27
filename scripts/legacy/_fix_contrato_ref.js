'use strict';
/**
 * Corrige contrato_ref vazio em notas_fiscais baseado no tomador.
 * Aplica somente nas NFs sem contrato_ref definido (contrato_ref = '').
 * Usa: node scripts/_fix_contrato_ref.js [--empresa=assessoria] [--dry-run]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k,v] = a.slice(2).split('='); return [k, v||true]; })
);
const EMPRESA = args.empresa || 'assessoria';
const DRY     = args['dry-run'] === true || args['dry-run'] === 'true';

const db = getDb(EMPRESA);
console.log(`\n  🔧 Fix contrato_ref — ${EMPRESA.toUpperCase()}${DRY ? ' [DRY-RUN]' : ''}\n`);

// Mapeamento: regex do tomador → { ref, comentario }
// Ordem importa: mais específico primeiro
const REGRAS = [
  // FUNJURIS / TJ  — contratos diferentes por período
  { pat: /FUNDO ESPECIAL DE MODERNIZACAO|FUNJURIS/i,
    resolver: (nf) => nf.data_emissao < '2024-01-01' ? 'TJ 73/2020' : 'TJ 440/2024' },

  // SESAU
  { pat: /SECRETARIA.*SAUDE.*TOCANTINS|TOCANTINS.*SECRETARIA.*SAUDE/i,
    ref: 'SESAU 178/2022' },

  // UNITINS
  { pat: /UNIVERSIDADE ESTADUAL DO TOCANTINS|UNITINS/i,
    ref: 'UNITINS 003/2023 + 3°TA' },

  // UFT (motorista vs limpeza não distinguível aqui, usa contrato principal)
  { pat: /FUNDACAO UNIVERSIDADE FEDERAL DO TOCANTINS|UFT/i,
    resolver: (nf) => nf.data_emissao >= '2025-01-01' ? 'UFT 16/2025' : 'UFT MOTORISTA 05/2025' },

  // UFNT
  { pat: /UNIVERSIDADE FEDERAL DO NORTE DO TOCANTINS|UFNT/i,
    ref: 'UFNT 30/2022' },

  // DETRAN
  { pat: /DEPARTAMENTO ESTADUAL DE TRANSITO|DETRAN/i,
    ref: 'DETRAN 41/2023 + 2°TA' },

  // MUNICIPIO DE PALMAS / PREFEITURA PALMAS
  { pat: /MUNICIPIO DE PALMAS|PREFEITURA.*PALMAS|PALMAS.*PREFEITURA/i,
    ref: 'PREFEITURA 062/2024' },

  // TCE
  { pat: /TRIBUNAL DE CONTAS DO ESTADO|TCE.TO/i,
    ref: 'TCE 117/2024' },

  // CBMTO
  { pat: /CORPO DE BOMBEIROS MILITAR/i,
    ref: 'CBMTO 011/2023 + 5°TA' },

  // SEMARH
  { pat: /SECRETARIA DO MEIO AMBIENTE|SEMARH/i,
    ref: 'SEMARH 32/2024' },

  // SEDUC
  { pat: /SECRETARIA DA EDUCACAO|SECRETARIA DE ESTADO DA EDUCACAO|SEDUC/i,
    ref: 'SEDUC Limpeza/Copeiragem' },

  // PREVIPALMAS
  { pat: /PREVIDENCIA SOCIAL DO MUNICIPIO|PREVIPALMAS|INSTITUTO DE PREVIDENCIA/i,
    ref: 'PREVI PALMAS — em vigor' },
];

// Busca NFs sem contrato_ref
const nfsSemRef = db.prepare(`
  SELECT id, tomador, data_emissao, numero, valor_bruto
  FROM notas_fiscais
  WHERE (contrato_ref = '' OR contrato_ref IS NULL)
  ORDER BY tomador, data_emissao
`).all();

console.log(`  Total NFs sem contrato_ref: ${nfsSemRef.length}`);

// Atualiza
const stmt = db.prepare(`UPDATE notas_fiscais SET contrato_ref=? WHERE id=?`);
const stats = new Map();
let atualizadas = 0, semMatch = 0;

for (const nf of nfsSemRef) {
  const tom = nf.tomador || '';
  let refFinal = null;

  for (const regra of REGRAS) {
    if (regra.pat.test(tom)) {
      refFinal = regra.resolver ? regra.resolver(nf) : regra.ref;
      break;
    }
  }

  if (refFinal) {
    if (!stats.has(refFinal)) stats.set(refFinal, 0);
    stats.set(refFinal, stats.get(refFinal) + 1);
    if (!DRY) stmt.run(refFinal, nf.id);
    atualizadas++;
  } else {
    semMatch++;
    if (semMatch <= 5) console.log(`  ⚠️  Sem match: "${tom}" (NF ${nf.numero}, R$${nf.valor_bruto})`);
  }
}

console.log(`\n  ✅ Atualizadas: ${atualizadas} | Sem match: ${semMatch}\n`);
console.log('  Por contrato:');
[...stats.entries()].sort((a,b)=>b[1]-a[1]).forEach(([ref, n]) => {
  console.log(`    ${ref.padEnd(40)} ${n} NFs`);
});
console.log('');
