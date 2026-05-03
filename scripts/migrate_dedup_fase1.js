#!/usr/bin/env node
/**
 * Montana ERP — Migração Fase 1: Regras Anti-Duplicação
 * ======================================================
 * Adiciona índices UNIQUE em todas as empresas para evitar duplicações em:
 *   - notas_fiscais  (numero único por empresa, exceto entradas manuais '0'/'')
 *   - extratos       (coluna bb_hash + índice único parcial)
 *   - rh_folha       (competência única por empresa)
 *   - rh_folha_itens (par folha_id + funcionario_id único)
 *   - despesas       (coluna dedup_hash + índice único parcial)
 *   - pagamentos     (coluna hash_unico + índice único parcial)
 *   - liquidacoes    (coluna hash_unico + índice único parcial)
 *
 * Execução: node scripts/migrate_dedup_fase1.js
 * Seguro para rodar múltiplas vezes (idempotente).
 */

require('dotenv').config();
const Database = require('better-sqlite3');
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');

const COMPANIES = require('../src/companies');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function md5(...parts) {
  return crypto.createHash('md5').update(parts.join('|')).digest('hex').slice(0, 32);
}

function colExists(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === col);
}

function indexExists(db, name) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(name);
}

function exec(db, sql, label) {
  try {
    db.exec(sql);
    console.log(`    ✅ ${label}`);
  } catch (e) {
    if (e.message.includes('already exists') || e.message.includes('duplicate column')) {
      console.log(`    ⏭  ${label} (já existia)`);
    } else {
      console.error(`    ❌ ${label}: ${e.message}`);
    }
  }
}

// ─── Etapas por tabela ────────────────────────────────────────────────────────

function migrateNotasFiscais(db, companyKey) {
  console.log('\n  [notas_fiscais]');

  // 1. Remove duplicatas mantendo o registro mais completo (mais campos preenchidos)
  const dupes = db.prepare(`
    SELECT numero, COUNT(*) as cnt
    FROM notas_fiscais
    WHERE numero != '' AND numero != '0'
    GROUP BY numero HAVING cnt > 1
  `).all();

  if (dupes.length > 0) {
    console.log(`    ⚠  Encontradas ${dupes.length} duplicatas — removendo excedentes...`);
    const keepStmt = db.prepare(`
      SELECT id FROM notas_fiscais
      WHERE numero = ?
      ORDER BY
        (LENGTH(COALESCE(discriminacao,'')) + LENGTH(COALESCE(cnpj_tomador,''))
         + (CASE WHEN status_conciliacao='CONCILIADO' THEN 1000 ELSE 0 END)
         + COALESCE(valor_bruto,0)) DESC,
        id ASC
      LIMIT 1
    `);
    const delStmt = db.prepare(`DELETE FROM notas_fiscais WHERE numero = ? AND id != ?`);
    let removed = 0;
    db.transaction(() => {
      for (const d of dupes) {
        const keep = keepStmt.get(d.numero);
        if (keep) {
          const r = delStmt.run(d.numero, keep.id);
          removed += r.changes;
        }
      }
    })();
    console.log(`    🗑  Removidos ${removed} registros duplicados`);
  } else {
    console.log(`    ✅ Sem duplicatas encontradas`);
  }

  // 2. Índice único parcial — protege NFs WebISS reais (exclui '0' e '')
  exec(db,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_nfs_numero_unique
     ON notas_fiscais(numero)
     WHERE numero != '' AND numero != '0'`,
    'UNIQUE INDEX notas_fiscais(numero) parcial'
  );

  // 3. Índice adicional para busca por cnpj_tomador + data (conciliação)
  exec(db,
    `CREATE INDEX IF NOT EXISTS idx_nfs_cnpj_data
     ON notas_fiscais(cnpj_tomador, data_emissao)`,
    'INDEX notas_fiscais(cnpj_tomador, data_emissao)'
  );
}

function migrateExtratos(db, companyKey) {
  console.log('\n  [extratos]');

  // 1. Adiciona coluna bb_hash se não existir
  if (!colExists(db, 'extratos', 'bb_hash')) {
    exec(db, `ALTER TABLE extratos ADD COLUMN bb_hash TEXT DEFAULT ''`, 'ADD COLUMN bb_hash');
  } else {
    console.log('    ⏭  bb_hash já existe');
  }

  // 2. Adiciona coluna ofx_fitid se não existir
  if (!colExists(db, 'extratos', 'ofx_fitid')) {
    exec(db, `ALTER TABLE extratos ADD COLUMN ofx_fitid TEXT DEFAULT ''`, 'ADD COLUMN ofx_fitid');
  } else {
    console.log('    ⏭  ofx_fitid já existe');
  }

  // 3. Popula bb_hash nos registros existentes que ainda não têm
  const semHash = db.prepare(`
    SELECT id, data_iso, tipo, historico,
           COALESCE(debito,0) as debito, COALESCE(credito,0) as credito
    FROM extratos WHERE COALESCE(bb_hash,'') = '' AND COALESCE(ofx_fitid,'') = ''
  `).all();

  if (semHash.length > 0) {
    console.log(`    🔑 Calculando hash para ${semHash.length} extratos sem identificador...`);
    const upd = db.prepare(`UPDATE extratos SET bb_hash = ? WHERE id = ?`);
    // Detecta duplicatas de hash antes de atribuir
    const hashCount = {};
    const toUpdate = semHash.map(r => {
      const h = md5(companyKey, r.data_iso, r.tipo, r.historico, r.debito, r.credito);
      hashCount[h] = (hashCount[h] || 0) + 1;
      return { id: r.id, hash: h, seq: hashCount[h] };
    });
    db.transaction(() => {
      for (const r of toUpdate) {
        // Se hash duplicado (mesmo dia/valor/histórico), adiciona sufixo sequencial
        const finalHash = r.seq > 1 ? `${r.hash}_dup${r.seq}` : r.hash;
        upd.run(finalHash, r.id);
      }
    })();
    console.log(`    ✅ Hash calculado para ${semHash.length} registros`);
  }

  // 4. Índice único parcial no bb_hash (só para registros com hash definido)
  exec(db,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_bb_hash_unique
     ON extratos(bb_hash)
     WHERE bb_hash != '' AND bb_hash NOT LIKE '%_dup%'`,
    'UNIQUE INDEX extratos(bb_hash) parcial'
  );

  // 5. Índice único parcial no ofx_fitid
  exec(db,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_ofx_fitid_unique
     ON extratos(ofx_fitid)
     WHERE ofx_fitid != ''`,
    'UNIQUE INDEX extratos(ofx_fitid) parcial'
  );
}

function migrateRhFolha(db) {
  console.log('\n  [rh_folha]');

  const dupes = db.prepare(`
    SELECT competencia, COUNT(*) cnt FROM rh_folha
    GROUP BY competencia HAVING cnt > 1
  `).all();

  if (dupes.length > 0) {
    console.log(`    ⚠  ${dupes.length} competência(s) duplicadas — mantendo a mais recente...`);
    db.transaction(() => {
      for (const d of dupes) {
        const keep = db.prepare(
          `SELECT id FROM rh_folha WHERE competencia=? ORDER BY id DESC LIMIT 1`
        ).get(d.competencia);
        if (keep) {
          db.prepare(`DELETE FROM rh_folha WHERE competencia=? AND id != ?`)
            .run(d.competencia, keep.id);
        }
      }
    })();
  }

  exec(db,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_rh_folha_competencia_unique
     ON rh_folha(competencia)`,
    'UNIQUE INDEX rh_folha(competencia)'
  );
}

function migrateRhFolhaItens(db) {
  console.log('\n  [rh_folha_itens]');

  const dupes = db.prepare(`
    SELECT folha_id, funcionario_id, COUNT(*) cnt
    FROM rh_folha_itens
    GROUP BY folha_id, funcionario_id HAVING cnt > 1
  `).all();

  if (dupes.length > 0) {
    console.log(`    ⚠  ${dupes.length} par(es) duplicados — mantendo o mais recente...`);
    db.transaction(() => {
      for (const d of dupes) {
        const keep = db.prepare(
          `SELECT id FROM rh_folha_itens WHERE folha_id=? AND funcionario_id=? ORDER BY id DESC LIMIT 1`
        ).get(d.folha_id, d.funcionario_id);
        if (keep) {
          db.prepare(`DELETE FROM rh_folha_itens WHERE folha_id=? AND funcionario_id=? AND id != ?`)
            .run(d.folha_id, d.funcionario_id, keep.id);
        }
      }
    })();
  }

  exec(db,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_rh_folha_itens_uk
     ON rh_folha_itens(folha_id, funcionario_id)`,
    'UNIQUE INDEX rh_folha_itens(folha_id, funcionario_id)'
  );
}

function migrateDespesas(db, companyKey) {
  console.log('\n  [despesas]');

  if (!colExists(db, 'despesas', 'dedup_hash')) {
    exec(db, `ALTER TABLE despesas ADD COLUMN dedup_hash TEXT DEFAULT ''`, 'ADD COLUMN dedup_hash');
  } else {
    console.log('    ⏭  dedup_hash já existe');
  }

  // Popula hash nos registros existentes que tenham nf_numero preenchido
  const semHash = db.prepare(`
    SELECT id, nf_numero, cnpj_fornecedor, data_iso, valor_bruto
    FROM despesas
    WHERE COALESCE(dedup_hash,'') = ''
    AND nf_numero != '' AND cnpj_fornecedor != ''
  `).all();

  if (semHash.length > 0) {
    console.log(`    🔑 Calculando hash para ${semHash.length} despesas com NF...`);
    const hashCount = {};
    const upd = db.prepare(`UPDATE despesas SET dedup_hash = ? WHERE id = ?`);
    db.transaction(() => {
      for (const r of semHash) {
        const base = md5(companyKey, r.nf_numero, r.cnpj_fornecedor, r.data_iso, r.valor_bruto);
        hashCount[base] = (hashCount[base] || 0) + 1;
        const h = hashCount[base] > 1 ? `${base}_dup${hashCount[base]}` : base;
        upd.run(h, r.id);
      }
    })();
    console.log(`    ✅ ${semHash.length} hashes calculados`);
  }

  exec(db,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_despesas_dedup_hash
     ON despesas(dedup_hash)
     WHERE dedup_hash != '' AND dedup_hash NOT LIKE '%_dup%'`,
    'UNIQUE INDEX despesas(dedup_hash) parcial'
  );
}

function migratePagamentos(db, companyKey) {
  console.log('\n  [pagamentos]');

  if (!colExists(db, 'pagamentos', 'hash_unico')) {
    exec(db, `ALTER TABLE pagamentos ADD COLUMN hash_unico TEXT DEFAULT ''`, 'ADD COLUMN hash_unico');
  } else {
    console.log('    ⏭  hash_unico já existe');
  }

  const semHash = db.prepare(`
    SELECT id, ob, gestao, empenho, processo, data_pagamento_iso, valor_pago
    FROM pagamentos WHERE COALESCE(hash_unico,'') = ''
  `).all();

  if (semHash.length > 0) {
    console.log(`    🔑 Calculando hash para ${semHash.length} pagamentos...`);
    const hashCount = {};
    const upd = db.prepare(`UPDATE pagamentos SET hash_unico = ? WHERE id = ?`);
    db.transaction(() => {
      for (const r of semHash) {
        const base = md5(companyKey, r.ob, r.gestao, r.empenho, r.processo, r.data_pagamento_iso, r.valor_pago);
        hashCount[base] = (hashCount[base] || 0) + 1;
        const h = hashCount[base] > 1 ? `${base}_dup${hashCount[base]}` : base;
        upd.run(h, r.id);
      }
    })();
  }

  exec(db,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_pagamentos_hash_unique
     ON pagamentos(hash_unico)
     WHERE hash_unico != '' AND hash_unico NOT LIKE '%_dup%'`,
    'UNIQUE INDEX pagamentos(hash_unico) parcial'
  );
}

function migrateLiquidacoes(db, companyKey) {
  console.log('\n  [liquidacoes]');

  if (!colExists(db, 'liquidacoes', 'hash_unico')) {
    exec(db, `ALTER TABLE liquidacoes ADD COLUMN hash_unico TEXT DEFAULT ''`, 'ADD COLUMN hash_unico');
  } else {
    console.log('    ⏭  hash_unico já existe');
  }

  const semHash = db.prepare(`
    SELECT id, empenho, gestao, favorecido, data_liquidacao_iso, valor
    FROM liquidacoes WHERE COALESCE(hash_unico,'') = ''
  `).all();

  if (semHash.length > 0) {
    console.log(`    🔑 Calculando hash para ${semHash.length} liquidações...`);
    const hashCount = {};
    const upd = db.prepare(`UPDATE liquidacoes SET hash_unico = ? WHERE id = ?`);
    db.transaction(() => {
      for (const r of semHash) {
        const base = md5(companyKey, r.empenho, r.gestao, r.favorecido, r.data_liquidacao_iso, r.valor);
        hashCount[base] = (hashCount[base] || 0) + 1;
        const h = hashCount[base] > 1 ? `${base}_dup${hashCount[base]}` : base;
        upd.run(h, r.id);
      }
    })();
  }

  exec(db,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_liquidacoes_hash_unique
     ON liquidacoes(hash_unico)
     WHERE hash_unico != '' AND hash_unico NOT LIKE '%_dup%'`,
    'UNIQUE INDEX liquidacoes(hash_unico) parcial'
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  Montana ERP — Migração Fase 1: Anti-Duplicação          ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const results = [];

  for (const [companyKey, company] of Object.entries(COMPANIES)) {
    const dbPath = path.join(__dirname, '..', company.dbPath);
    if (!fs.existsSync(dbPath)) {
      console.log(`⚠  [${companyKey}] Banco não encontrado: ${dbPath} — pulando\n`);
      continue;
    }

    console.log(`\n${'═'.repeat(58)}`);
    console.log(`  Empresa: ${companyKey.toUpperCase()} — ${dbPath}`);
    console.log('═'.repeat(58));

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 10000');

    try {
      migrateNotasFiscais(db, companyKey);
      migrateExtratos(db, companyKey);
      migrateRhFolha(db);
      migrateRhFolhaItens(db);
      migrateDespesas(db, companyKey);
      migratePagamentos(db, companyKey);
      migrateLiquidacoes(db, companyKey);

      // Checkpoint WAL para garantir persistência
      db.pragma('wal_checkpoint(TRUNCATE)');
      console.log(`\n  ✅ [${companyKey}] Migração concluída com sucesso`);
      results.push({ company: companyKey, ok: true });
    } catch (e) {
      console.error(`\n  ❌ [${companyKey}] Erro: ${e.message}`);
      results.push({ company: companyKey, ok: false, error: e.message });
    } finally {
      db.close();
    }
  }

  console.log('\n\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  Resultado Final                                          ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.company}: ${r.ok ? 'OK' : r.error}`);
  }
  console.log('\nPróximo passo: reinicie o servidor para aplicar o src/db.js atualizado');
  console.log('  pm2 restart montana\n');
}

main().catch(console.error);
