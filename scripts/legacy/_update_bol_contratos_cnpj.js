/**
 * Popula contrato_ref + insc_municipal em bol_contratos
 * Montana Assessoria — dados extraídos dos PDFs e da tabela contratos
 * Execute: node scripts/_update_bol_contratos_cnpj.js
 */
const Database = require('better-sqlite3');
const path     = require('path');

const db = new Database(path.join(__dirname, '../data/assessoria/montana.db'));

// ─── 1. Garante colunas existem ───────────────────────────────────────────────
for (const col of ['contrato_ref TEXT', 'insc_municipal TEXT', 'orgao TEXT']) {
  try { db.prepare(`ALTER TABLE bol_contratos ADD COLUMN ${col}`).run(); }
  catch (_) {}                          // já existe — ignorar
}

// ─── 2. Mapa: numero_contrato → { contrato_ref, insc_municipal }
//    contrato_ref  = numContrato exato na tabela contratos (para JOIN automático)
//    insc_municipal = CNPJ do tomador (usado na emissão NFS-e)
const updates = [
  // id | numero_contrato | contrato_ref                  | CNPJ tomador
  { id:  1, contrato_ref: 'UFT 16/2025',              insc_municipal: '05.149.726/0001-04' },  // UFT Limpeza
  { id:  2, contrato_ref: 'DETRAN 41/2023 + 2°TA',    insc_municipal: '26.752.857/0001-51' },  // DETRAN
  { id:  3, contrato_ref: 'SEMARH 32/2024',           insc_municipal: '05.016.202/0001-45' },  // SEMARH
  { id:  4, contrato_ref: 'PREVI PALMAS — em vigor',   insc_municipal: '05.278.848/0001-09' },  // Previ Palmas
  { id:  5, contrato_ref: 'SEDUC 016/2023',            insc_municipal: '25.053.083/0001-08' },  // SEDUC
  { id:  6, contrato_ref: 'TCE 26/2025',              insc_municipal: '25.053.133/0001-57' },  // TCE (encerrado)
  { id:  7, contrato_ref: 'SESAU 178/2022',            insc_municipal: '25.053.117/0001-64' },  // SESAU
  { id:  8, contrato_ref: 'UFNT 30/2022',             insc_municipal: '05.149.726/0001-04' },  // UFNT
  { id:  9, contrato_ref: 'UFT MOTORISTA 05/2025',    insc_municipal: '05.149.726/0001-04' },  // UFT Motoristas
  { id: 10, contrato_ref: 'UNITINS 003/2023 + 3°TA',  insc_municipal: '01.637.536/0001-85' },  // UNITINS
  { id: 11, contrato_ref: 'CBMTO 011/2023 + 5°TA',   insc_municipal: '07.180.650/0001-58' },  // CBMTO (encerrado)
  { id: 12, contrato_ref: 'SEPLAD 002/2024 — encerrado', insc_municipal: '24.851.511/0022-00' }, // SEPLAD (sub-rogação SECAD)
];

const stmt = db.prepare(`
  UPDATE bol_contratos
     SET contrato_ref  = ?,
         insc_municipal = ?
   WHERE id = ?
`);

const updateMany = db.transaction((rows) => {
  for (const r of rows) {
    const changes = stmt.run(r.contrato_ref, r.insc_municipal, r.id);
    const bc = db.prepare('SELECT nome, numero_contrato FROM bol_contratos WHERE id=?').get(r.id);
    if (changes.changes > 0) {
      console.log(`  ✅ id=${r.id.toString().padStart(2)} [${bc?.nome || '?'}]`);
      console.log(`        contrato_ref  → ${r.contrato_ref}`);
      console.log(`        insc_municipal → ${r.insc_municipal}`);
    } else {
      console.log(`  ⚠️  id=${r.id} — não encontrado (ignorado)`);
    }
  }
});

console.log('\n📋 Atualizando bol_contratos...\n');
updateMany(updates);

// ─── 3. Verifica resolução via JOIN ───────────────────────────────────────────
console.log('\n🔍 Verificação: JOIN bol_contratos → contratos\n');
const check = db.prepare(`
  SELECT bc.id, bc.nome,
         bc.contrato_ref, bc.insc_municipal,
         COALESCE(
           (SELECT c1.numContrato FROM contratos c1 WHERE c1.numContrato = bc.contrato_ref LIMIT 1),
           (SELECT c2.numContrato FROM contratos c2 WHERE c2.numContrato LIKE '%' || bc.numero_contrato LIMIT 1)
         ) AS resolve_ok
  FROM bol_contratos bc
  ORDER BY bc.id
`).all();

let semCnpj = 0, semContrato = 0;
for (const r of check) {
  const cnpjOk     = r.insc_municipal ? '✅' : '❌';
  const contratoOk = r.resolve_ok     ? '✅' : '⚠️ ';
  if (!r.insc_municipal) semCnpj++;
  if (!r.resolve_ok)     semContrato++;
  console.log(
    ` ${cnpjOk}${contratoOk} id=${String(r.id).padStart(2)} [${(r.nome||'').padEnd(42)}]` +
    `  CNPJ:${(r.insc_municipal||'—').padEnd(20)}  contrato_ref:${r.resolve_ok || '—'}`
  );
}

console.log(`\n📊 Resultado: ${check.length} registros | sem CNPJ: ${semCnpj} | sem resolve_contrato: ${semContrato}`);

db.close();
console.log('\n✅ Concluído.\n');
