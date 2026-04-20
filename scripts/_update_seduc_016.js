/**
 * Adiciona coluna ata_registro_precos nos 4 bancos e atualiza SEDUC 016/2023 (Assessoria)
 * Executa local OU na VM — usa caminhos relativos.
 */
const Database = require('better-sqlite3');

const dbs = [
  'data/assessoria/montana.db',
  'data/seguranca/montana.db',
  'data/portodovau/montana.db',
  'data/mustang/montana.db',
];

for (const p of dbs) {
  try {
    const db = new Database(p);
    const cols = db.prepare('PRAGMA table_info(contratos)').all().map(c => c.name);
    if (!cols.includes('ata_registro_precos')) {
      db.prepare('ALTER TABLE contratos ADD COLUMN ata_registro_precos TEXT').run();
      console.log('+ coluna ata_registro_precos adicionada em', p);
    } else {
      console.log('= coluna ata_registro_precos já existe em', p);
    }
    db.close();
  } catch (e) { console.log('!', p, e.message); }
}

const db = new Database('data/assessoria/montana.db');
db.prepare(`
  UPDATE contratos
  SET valor_mensal_bruto = 209815.61,
      orgao = 'SECRETARIA DA EDUCACAO DO ESTADO DO TOCANTINS',
      status = 'Ativo',
      vigencia_inicio = '2023-04-01',
      ata_registro_precos = 'ARP nº 3/2023 — Pregão Eletrônico 03/2023 — SEDUC/TO (contratos/assessoria/seduc-016-2023/ATA-REGISTRO-PRECOS-3-2023.pdf)',
      obs = 'ATA de Registro de Preços nº 3/2023 — Pregão Eletrônico 03/2023 — Processo 2023/27000/000120. Valor inicial: R$ 163.499,71/mês (42 postos: 24 serventes, 3 jardineiros, 13 copeiras, 2 encarregados). Repactuação set/2025: R$ 209.815,61/mês (+28,3%). SEDUC costuma atrasar empenhos — NFs emitidas em bloco cobrindo competências acumuladas (ex: ago/2025 com 5 NFs = R$ 842k; fev/2026 com 3 NFs).',
      updated_at = datetime('now')
  WHERE numContrato = 'SEDUC 016/2023'
`).run();

const r = db.prepare(`
  SELECT numContrato, valor_mensal_bruto, orgao, status, vigencia_inicio, ata_registro_precos
  FROM contratos WHERE numContrato = 'SEDUC 016/2023'
`).get();
console.log('\nDB atualizado:');
console.log(JSON.stringify(r, null, 2));
db.close();
