#!/usr/bin/env node
/**
 * Montana — Relatório semanal de exposição intragrupo (NFs em aberto entre empresas do grupo)
 *
 * Gera CSV + resumo em console listando:
 *   - Despesas classificadas como fornecedor intragrupo (Nevada, Montreal, Porto do Vau, Mustang, Montana Seg/Assessoria)
 *   - Agrupado por (empresa_devedora, empresa_credora)
 *   - Total em aberto, quantidade, maior atraso em dias
 *
 * Uso:
 *   node scripts/relatorio_intragrupo.js                  # imprime no console
 *   node scripts/relatorio_intragrupo.js --csv            # grava em /opt/montana/logs/intragrupo_AAAA-MM-DD.csv
 *
 * Cron (toda segunda-feira 08h):
 *   0 8 * * 1 cd /opt/montana/app_unificado && node scripts/relatorio_intragrupo.js --csv >> /opt/montana/logs/intragrupo.log 2>&1
 */
'use strict';
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb, COMPANIES } = require('../src/db');

const args = process.argv.slice(2);
const WRITE_CSV = args.includes('--csv');

const GRUPO = [
  { pat: /NEVADA/i,           nome: 'Nevada (M Limpeza / Embalagens)' },
  { pat: /MONTREAL/i,         nome: 'Montreal (Máquinas/Ferramentas)' },
  { pat: /PORTO\s*(V\s*S|DO\s*VAU|VAU)/i, nome: 'Porto do Vau' },
  { pat: /MUSTANG/i,          nome: 'Mustang G E EIRELI' },
  { pat: /MONTANA\s*SEG/i,    nome: 'Montana Segurança' },
  { pat: /MONTANA\s*ASS/i,    nome: 'Montana Assessoria' },
];

const HOJE = new Date();

function diasDe(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(+d)) return null;
  return Math.floor((HOJE - d) / 86400000);
}

function fmt(v) { return (v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

const linhas = []; // {empresa_dev, grupo_cred, qtd, valor_aberto, max_atraso}

for (const empresaKey of Object.keys(COMPANIES)) {
  let db;
  try { db = getDb(empresaKey); } catch (e) { continue; }
  const selfNome = COMPANIES[empresaKey]?.label || empresaKey;

  let despesas = [];
  try {
    despesas = db.prepare(`
      SELECT fornecedor, descricao, valor_bruto, data_iso, status
      FROM despesas
      WHERE COALESCE(status,'') NOT IN ('PAGO', 'CONCILIADO', 'CONCILIADA')
        AND (valor_bruto > 0)
    `).all();
  } catch (e) { db.close(); continue; }

  for (const grp of GRUPO) {
    if (grp.pat.test(selfNome)) continue; // pula auto-relacionamento
    const match = despesas.filter(d => grp.pat.test((d.fornecedor || '') + ' ' + (d.descricao || '')));
    if (match.length === 0) continue;
    const valor = match.reduce((s, d) => s + (d.valor_bruto || 0), 0);
    const atrasos = match.map(d => diasDe(d.data_iso)).filter(x => x != null);
    const maxAtr = atrasos.length ? Math.max(...atrasos) : 0;
    linhas.push({
      empresa_dev: selfNome,
      grupo_cred: grp.nome,
      qtd: match.length,
      valor_aberto: valor,
      max_atraso: maxAtr,
    });
  }
  db.close();
}

linhas.sort((a, b) => b.valor_aberto - a.valor_aberto);

console.log('\n═'.repeat(100));
console.log(`  Relatório Exposição Intragrupo — ${HOJE.toISOString().slice(0, 10)}`);
console.log('═'.repeat(100));
console.log('  ' + 'Devedor'.padEnd(28) + ' → ' + 'Credor'.padEnd(32) + ' | ' + 'Qtd'.padStart(4) + ' | ' + 'Valor em aberto'.padStart(18) + ' | ' + 'Atraso (d)'.padStart(10));
console.log('─'.repeat(100));

let totGeral = 0;
for (const l of linhas) {
  console.log(
    '  ' + l.empresa_dev.slice(0, 28).padEnd(28) + ' → ' +
    l.grupo_cred.slice(0, 32).padEnd(32) + ' | ' +
    String(l.qtd).padStart(4) + ' | ' +
    ('R$ ' + fmt(l.valor_aberto)).padStart(18) + ' | ' +
    String(l.max_atraso).padStart(10)
  );
  totGeral += l.valor_aberto;
}
console.log('─'.repeat(100));
console.log(`  TOTAL GERAL EM ABERTO: R$ ${fmt(totGeral)}  |  ${linhas.length} relações devedor→credor`);

// Alertas
const CRITICO = linhas.filter(l => l.max_atraso > 60);
const ATENCAO = linhas.filter(l => l.max_atraso > 30 && l.max_atraso <= 60);
if (CRITICO.length) {
  console.log('\n🔴 CRÍTICO (>60 dias de atraso):');
  for (const l of CRITICO) console.log(`   ${l.empresa_dev} → ${l.grupo_cred}: ${l.max_atraso} dias | R$ ${fmt(l.valor_aberto)}`);
}
if (ATENCAO.length) {
  console.log('\n🟡 ATENÇÃO (30-60 dias):');
  for (const l of ATENCAO) console.log(`   ${l.empresa_dev} → ${l.grupo_cred}: ${l.max_atraso} dias | R$ ${fmt(l.valor_aberto)}`);
}

if (WRITE_CSV) {
  const data = HOJE.toISOString().slice(0, 10);
  const logsDir = process.env.LOGS_DIR || '/opt/montana/logs';
  const csvPath = path.join(logsDir, `intragrupo_${data}.csv`);
  try {
    const header = 'data;empresa_devedora;grupo_credor;qtd;valor_aberto;max_atraso_dias\n';
    const csv = linhas.map(l => `${data};${l.empresa_dev};${l.grupo_cred};${l.qtd};${l.valor_aberto.toFixed(2)};${l.max_atraso}`).join('\n');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(csvPath, header + csv + '\n', 'utf8');
    console.log(`\n📄 CSV gravado em: ${csvPath}`);
  } catch (e) {
    console.log(`\n⚠️  Erro ao gravar CSV: ${e.message}`);
  }
}

console.log('');
