#!/usr/bin/env node
/**
 * Montana — Limpeza e Recategorização Automática de Despesas
 *
 * Remove lançamentos que NÃO são despesas operacionais:
 *   - Aplicações financeiras (BB Rende Fácil, CDB, etc.)
 *   - Transferências internas (Montana Serviços, TED entre contas próprias)
 *
 * Recategoriza automaticamente:
 *   - RFB-DARF → Impostos
 *   - PIX/TED CEF MATRIZ → FGTS
 *
 * Uso:
 *   node scripts/limpar_despesas.js [--empresa=assessoria|seguranca|todas] [--dry-run]
 *
 * Cron (mensal, dia 1 às 04h):
 *   0 4 1 * * cd /opt/montana/app_unificado && node scripts/limpar_despesas.js >> /opt/montana/logs/limpar_despesas.log 2>&1
 */

const Database = require('better-sqlite3');
const path = require('path');

const args = process.argv.slice(2);
const empresaArg = (args.find(a => a.startsWith('--empresa=')) || '--empresa=todas').split('=')[1];
const dryRun = args.includes('--dry-run');

const COMPANIES = {
  assessoria: { label: 'Montana Assessoria', db: 'assessoria' },
  seguranca:  { label: 'Montana Segurança',  db: 'seguranca'  },
  mustang:    { label: 'Mustang',            db: 'mustang'    },
};

// ── Regras de REMOÇÃO (não são despesas operacionais) ─────────────────────────
const REMOVER = [
  {
    descricao: 'Aplicação Financeira BB Rende Fácil / CDB',
    pattern: "descricao LIKE 'BB Rende F%' OR descricao LIKE '%Rende Facil%' OR descricao LIKE '%CDB BB%'",
  },
  {
    descricao: 'Transferência intragrupo — Montana Serviços / Assessoria / Segurança / S LTDA',
    pattern: "descricao LIKE '%MONTANA SERVICOS%' OR descricao LIKE '%MONTANA SERVI%' OR descricao LIKE '%MONTANA ASS%' OR descricao LIKE '%MONTANA SEG%' OR descricao LIKE '%MONTANA S LTDA%' OR descricao LIKE '%MONTANA S/ASS%'",
  },
  {
    descricao: 'Transferência intragrupo — Nevada (M Limpeza / Embalagens)',
    pattern: "descricao LIKE '%NEVADA M LIMPEZA%' OR descricao LIKE '%NEVADA EMBALAGENS%' OR descricao LIKE '%NEVADA M LIMP%'",
  },
  {
    descricao: 'Transferência intragrupo — Mustang G E EIRELI',
    pattern: "descricao LIKE '%MUSTANG%'",
  },
  {
    descricao: 'Transferência intragrupo — Porto do Vau Serviços Privados',
    pattern: "descricao LIKE '%PORTO V S PR%' OR descricao LIKE '%PORTO DO VAU%' OR descricao LIKE '%PORTO VAU%'",
  },
  {
    descricao: 'TED para conta própria da empresa',
    pattern: "descricao LIKE 'TED - 070 0031 014092519000151 MONT%' OR descricao LIKE '%TRANSFER.INTERNA%' OR descricao LIKE '%ENTRE CONTAS PROP%' OR descricao LIKE '%TED ENTRE CONTAS%'",
  },
  {
    descricao: 'Resgate de aplicação (crédito de volta)',
    pattern: "descricao LIKE '%Aplicacao%Resgate%' OR descricao LIKE '%Resg Rende%' OR descricao LIKE '%APLIC.AUTOM%' OR descricao LIKE '%RESG.AUTOM%'",
  },
];

// ── Regras de RECATEGORIZAÇÃO ─────────────────────────────────────────────────
const RECATEGORIZAR = [
  {
    descricao: 'Impostos Federais — DARF/RFB',
    pattern: "descricao LIKE 'Impostos  RFB-DARF%' OR descricao LIKE '%RFB DARF%' OR descricao LIKE '%DARF CODIGO%'",
    categoria: 'Impostos',
  },
  {
    descricao: 'FGTS — Caixa Econômica Federal',
    pattern: "descricao LIKE '%CEF MATR%' OR descricao LIKE '%CAIXA ECONOMICA FGTS%' OR descricao LIKE '%FGTS CEF%'",
    categoria: 'FGTS',
  },
  {
    descricao: 'INSS — Guia da Previdência',
    pattern: "descricao LIKE '%GPS PREVIDENCIA%' OR descricao LIKE '%INSS GPS%' OR descricao LIKE '%PREVIDENCIA SOCIAL%'",
    categoria: 'INSS',
  },
  {
    descricao: 'Débito Judicial / Bloqueio',
    pattern: "descricao LIKE '%BLOQ. JUDICIAL%' OR descricao LIKE '%DEBITO JUDICIAL%' OR descricao LIKE '%PENHORA%'",
    categoria: 'Judicial',
  },
];

function processar(empresa) {
  const dbPath = path.join(__dirname, '..', 'data', empresa.db, 'montana.db');
  let db;
  try {
    db = new Database(dbPath);
  } catch (e) {
    console.log(`  ⚠️  Banco não encontrado: ${dbPath}`);
    return;
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${empresa.label}`);
  console.log(`${'═'.repeat(60)}`);

  let totalRemovidos = 0;
  let totalValorRemovido = 0;
  let totalRecategorizados = 0;

  // ── REMOVER ──────────────────────────────────────────────────────────────────
  for (const regra of REMOVER) {
    const sql = `SELECT COUNT(*) as qtd, ROUND(SUM(valor_bruto),2) as total FROM despesas WHERE ${regra.pattern}`;
    const { qtd, total } = db.prepare(sql).get();
    if (qtd > 0) {
      console.log(`\n  🗑️  REMOVER: ${regra.descricao}`);
      console.log(`     ${qtd} lançamento(s) — R$ ${(total||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}`);
      if (!dryRun) {
        db.prepare(`DELETE FROM despesas WHERE ${regra.pattern}`).run();
        console.log(`     ✅ Removidos`);
      } else {
        console.log(`     [DRY-RUN] Não removidos`);
      }
      totalRemovidos += qtd;
      totalValorRemovido += total || 0;
    }
  }

  // ── RECATEGORIZAR ────────────────────────────────────────────────────────────
  for (const regra of RECATEGORIZAR) {
    const sql = `SELECT COUNT(*) as qtd, ROUND(SUM(valor_bruto),2) as total FROM despesas WHERE categoria != '${regra.categoria}' AND (${regra.pattern})`;
    const { qtd, total } = db.prepare(sql).get();
    if (qtd > 0) {
      console.log(`\n  ✏️  RECATEGORIZAR → ${regra.categoria}: ${regra.descricao}`);
      console.log(`     ${qtd} lançamento(s) — R$ ${(total||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}`);
      if (!dryRun) {
        db.prepare(`UPDATE despesas SET categoria='${regra.categoria}' WHERE categoria != '${regra.categoria}' AND (${regra.pattern})`).run();
        console.log(`     ✅ Recategorizados`);
      } else {
        console.log(`     [DRY-RUN] Não alterados`);
      }
      totalRecategorizados += qtd;
    }
  }

  // ── RESUMO ───────────────────────────────────────────────────────────────────
  console.log(`\n  📊 RESUMO ${dryRun ? '(DRY-RUN)' : ''}:`);
  console.log(`     Removidos:        ${totalRemovidos} lançamentos — R$ ${totalValorRemovido.toLocaleString('pt-BR',{minimumFractionDigits:2})}`);
  console.log(`     Recategorizados:  ${totalRecategorizados} lançamentos`);

  // ── ESTADO ATUAL ─────────────────────────────────────────────────────────────
  const estado = db.prepare(`
    SELECT categoria, COUNT(*) as qtd, ROUND(SUM(valor_bruto),2) as total
    FROM despesas
    WHERE data_iso >= date('now','start of year')
    GROUP BY categoria ORDER BY total DESC
  `).all();

  if (estado.length) {
    console.log(`\n  📋 Despesas (ano atual):`);
    for (const row of estado) {
      const bar = '█'.repeat(Math.min(20, Math.round((row.total / estado[0].total) * 20)));
      console.log(`     ${(row.categoria||'SEM CAT').padEnd(18)} ${bar.padEnd(20)} R$ ${row.total.toLocaleString('pt-BR',{minimumFractionDigits:2})} (${row.qtd})`);
    }
  }

  db.close();
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(60)}`);
console.log(`  Montana — Limpeza de Despesas  ${new Date().toLocaleString('pt-BR')}`);
if (dryRun) console.log(`  ⚠️  MODO DRY-RUN — nenhuma alteração será feita`);
console.log(`${'═'.repeat(60)}`);

const empresas = empresaArg === 'todas'
  ? Object.values(COMPANIES)
  : [COMPANIES[empresaArg]].filter(Boolean);

if (!empresas.length) {
  console.error(`Empresa inválida: ${empresaArg}`);
  process.exit(1);
}

for (const emp of empresas) processar(emp);

console.log(`\n✅ Limpeza concluída em ${new Date().toLocaleString('pt-BR')}\n`);
