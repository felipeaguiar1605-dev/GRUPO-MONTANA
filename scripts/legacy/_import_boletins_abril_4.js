/**
 * Importa 4 boletins de medição — Abril 2026
 * DETRAN, UFT Limpeza+ATOP, PREVI PALMAS, SEDUC
 */
const Database = require('better-sqlite3');
const DB_PATH = 'C:\\Users\\Avell\\OneDrive\\Área de Trabalho\\Montana_Seg_Conciliacao\\app_unificado\\data\\assessoria\\montana.db';
const db = new Database(DB_PATH);

const boletins = [
  {
    contrato_id: 2,
    nome: 'DETRAN-TO — Limpeza',
    competencia: '2026-04',
    total_geral: 527124.19,
    observacao: 'Boletim abr/2026 — 103 postos — Contrato N° 02/2024 — lido de XLS',
  },
  {
    contrato_id: 1,
    nome: 'UFT — Limpeza e ATOP',
    competencia: '2026-04',
    total_geral: 918428.70,
    observacao: 'Boletim abr/2026 — ATOT R$337.266,43 + Limpeza R$581.162,27 — Contrato 29/2022 — lido de XLS',
  },
  {
    contrato_id: 4,
    nome: 'PREVI PALMAS — Limpeza',
    competencia: '2026-04',
    total_geral: 19497.03,
    observacao: 'Boletim abr/2026 — 5 postos — lido de XLS',
  },
  {
    contrato_id: 5,
    nome: 'SEDUC — Limpeza e Copeiragem',
    competencia: '2026-04',
    total_geral: 209815.61,
    observacao: 'Boletim abr/2026 — 42 postos — lido de XLS',
  },
];

// Verifica se já existe (evita duplicatas)
const checkStmt = db.prepare(`
  SELECT id FROM bol_boletins WHERE contrato_id = ? AND competencia = ?
`);

const insertStmt = db.prepare(`
  INSERT INTO bol_boletins (contrato_id, competencia, total_geral, status, data_emissao, created_at)
  VALUES (?, ?, ?, 'aprovado', '2026-04-01', datetime('now'))
`);

const tx = db.transaction(() => {
  let inserted = 0;
  for (const b of boletins) {
    const existing = checkStmt.get(b.contrato_id, b.competencia);
    if (existing) {
      console.log(`  SKIP (já existe bid=${existing.id}): cid=${b.contrato_id} ${b.nome} ${b.competencia}`);
    } else {
      const info = insertStmt.run(b.contrato_id, b.competencia, b.total_geral);
      console.log(`  INSERT bid=${info.lastInsertRowid}: cid=${b.contrato_id} ${b.nome} total=${b.total_geral}`);
      inserted++;
    }
  }
  return inserted;
});

const n = tx();
console.log(`\n✅ ${n} boletins inseridos`);

// Verificação final
console.log('\n=== bol_boletins 2026-04 (todos) ===');
db.prepare(`
  SELECT b.id, b.contrato_id, b.total_geral, b.status, bc.nome
  FROM bol_boletins b JOIN bol_contratos bc ON bc.id=b.contrato_id
  WHERE b.competencia='2026-04' ORDER BY b.id
`).all().forEach(r => {
  const fmt = v => 'R$ ' + Number(v).toLocaleString('pt-BR', {minimumFractionDigits:2});
  console.log(`  bid=${r.id} cid=${r.contrato_id} ${fmt(r.total_geral)} status=${r.status} | ${r.nome}`);
});

db.close();
