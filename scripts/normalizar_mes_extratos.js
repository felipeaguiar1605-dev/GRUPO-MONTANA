#!/usr/bin/env node
/**
 * Normalização da coluna `extratos.mes` em todas as empresas.
 *
 * Contexto: diferentes rotas de importação (CSV BB, OFX, PDF-IA, BRB, Inter)
 * populam `mes` com formatos divergentes — 'ABR', 'abril 2026', '2026-04',
 * e até nome do arquivo CSV. O endpoint /extratos/meses filtrava por
 * length(mes)=3 e só via parte dos registros.
 *
 * Esta normalização:
 *   1. Para TODA linha com data_iso válida → grava mes = 'JAN'..'DEZ'
 *   2. Cria trigger que mantém a consistência em INSERTs futuros, cobrindo
 *      qualquer rota de import que esqueça de popular o campo corretamente.
 *
 * Uso:
 *   node scripts/normalizar_mes_extratos.js            # dry-run (mostra impacto)
 *   node scripts/normalizar_mes_extratos.js --apply    # aplica UPDATE + trigger
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb, COMPANIES } = require('../src/db');

const APPLY = process.argv.includes('--apply');
const EMPRESAS = Object.keys(COMPANIES);

const MES_CASE = `
  CASE substr(data_iso, 6, 2)
    WHEN '01' THEN 'JAN' WHEN '02' THEN 'FEV' WHEN '03' THEN 'MAR'
    WHEN '04' THEN 'ABR' WHEN '05' THEN 'MAI' WHEN '06' THEN 'JUN'
    WHEN '07' THEN 'JUL' WHEN '08' THEN 'AGO' WHEN '09' THEN 'SET'
    WHEN '10' THEN 'OUT' WHEN '11' THEN 'NOV' WHEN '12' THEN 'DEZ'
  END`;

const TRIGGER_NEW = `
  CASE substr(NEW.data_iso, 6, 2)
    WHEN '01' THEN 'JAN' WHEN '02' THEN 'FEV' WHEN '03' THEN 'MAR'
    WHEN '04' THEN 'ABR' WHEN '05' THEN 'MAI' WHEN '06' THEN 'JUN'
    WHEN '07' THEN 'JUL' WHEN '08' THEN 'AGO' WHEN '09' THEN 'SET'
    WHEN '10' THEN 'OUT' WHEN '11' THEN 'NOV' WHEN '12' THEN 'DEZ'
  END`;

console.log('═'.repeat(80));
console.log('  NORMALIZAÇÃO extratos.mes — ' + (APPLY ? '[APPLY]' : '[DRY-RUN]'));
console.log('═'.repeat(80));

let totalNormalizado = 0;

for (const emp of EMPRESAS) {
  const db = getDb(emp);
  try { db.prepare(`SELECT 1 FROM extratos LIMIT 1`).get(); }
  catch(_) { console.log(`\n${emp}: sem tabela extratos, pulando.`); continue; }

  console.log(`\n── ${emp.toUpperCase()} ──`);

  // Registros cujo mes não bate com o derivado de data_iso
  const divergentes = db.prepare(`
    SELECT COUNT(*) cnt FROM extratos
    WHERE data_iso IS NOT NULL AND length(data_iso) >= 7
      AND COALESCE(mes,'') != (${MES_CASE})
  `).get().cnt;
  console.log(`  Divergentes (mes ≠ derivado de data_iso): ${divergentes}`);

  // Breakdown dos formatos atuais
  const breakdown = db.prepare(`
    SELECT mes, COUNT(*) qtd FROM extratos
    WHERE data_iso IS NOT NULL AND length(data_iso) >= 7
    GROUP BY mes ORDER BY qtd DESC LIMIT 8
  `).all();
  console.log(`  Top formatos encontrados em 'mes':`);
  for (const r of breakdown) console.log(`    ${JSON.stringify(r.mes)} — ${r.qtd}`);

  if (APPLY) {
    const tx = db.transaction(() => {
      const upd = db.prepare(`
        UPDATE extratos
           SET mes = (${MES_CASE})
         WHERE data_iso IS NOT NULL AND length(data_iso) >= 7
           AND COALESCE(mes,'') != (${MES_CASE})
      `);
      const info = upd.run();
      totalNormalizado += info.changes;
      console.log(`  ✅ ${info.changes} registros atualizados`);

      // Trigger para manter consistência (INSERT + UPDATE em data_iso)
      db.exec(`DROP TRIGGER IF EXISTS extratos_mes_autofill_ins`);
      db.exec(`DROP TRIGGER IF EXISTS extratos_mes_autofill_upd`);
      db.exec(`
        CREATE TRIGGER extratos_mes_autofill_ins
        AFTER INSERT ON extratos
        WHEN NEW.data_iso IS NOT NULL AND length(NEW.data_iso) >= 7
         AND COALESCE(NEW.mes,'') != (${TRIGGER_NEW})
        BEGIN
          UPDATE extratos SET mes = (${TRIGGER_NEW}) WHERE id = NEW.id;
        END;
      `);
      db.exec(`
        CREATE TRIGGER extratos_mes_autofill_upd
        AFTER UPDATE OF data_iso ON extratos
        WHEN NEW.data_iso IS NOT NULL AND length(NEW.data_iso) >= 7
         AND COALESCE(NEW.mes,'') != (${TRIGGER_NEW})
        BEGIN
          UPDATE extratos SET mes = (${TRIGGER_NEW}) WHERE id = NEW.id;
        END;
      `);
      console.log(`  ✅ Triggers extratos_mes_autofill_ins/upd (re)criadas`);
    });
    tx();
  }
}

console.log('\n' + '═'.repeat(80));
console.log(`  TOTAL: ${totalNormalizado} registros normalizados` + (APPLY ? '' : ' (DRY-RUN)'));
console.log('═'.repeat(80));
if (!APPLY) console.log(`\n  Use --apply para gravar.`);
