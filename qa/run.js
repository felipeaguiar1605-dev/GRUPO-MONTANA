#!/usr/bin/env node
'use strict';
/**
 * qa/run.js
 * Entrypoint da rotina de QA noturno do sistema Montana Unificado.
 *
 * Execução:
 *   npm run qa:noturno
 *   node qa/run.js
 *   QA_COMPETENCIA=2026-02 node qa/run.js
 *
 * Variáveis de ambiente reconhecidas (ver qa/config.js):
 *   QA_BASE_URL, QA_USER, QA_PASS, QA_COMPETENCIA, QA_ANO,
 *   QA_OUT_DIR, QA_OUT_FILE, QA_TIMEOUT_MS,
 *   QA_RECEITA_MIN_ASSESSORIA, QA_RECEITA_MIN_SEGURANCA
 *
 * Exit codes:
 *   0 — todos checks passaram (apenas WARN é tolerado)
 *   1 — pelo menos 1 FAIL
 *   2 — falha de infraestrutura (login, baseUrl, etc.)
 */

const fs = require('fs');
const path = require('path');

// Carrega .env do app_unificado se existir.
(function loadEnv() {
  const envFile = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();

const config = require('./config');
const { createClient } = require('./lib/api');
const { createRunner } = require('./lib/checks');
const { buildMarkdown, saveReport } = require('./lib/report');

// Carrega todos os módulos de check em ordem alfabética.
function loadChecks() {
  const dir = path.join(__dirname, 'checks');
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.js'))
    .sort()
    .map(f => ({ name: f, fn: require(path.join(dir, f)) }));
}

function header() {
  console.log('━'.repeat(60));
  console.log('  QA Noturno — Sistema Montana Unificado');
  console.log('━'.repeat(60));
  console.log(`  baseUrl:       ${config.baseUrl}`);
  console.log(`  competência:   ${config.competenciaTeste}`);
  console.log(`  ano:           ${config.anoTeste}`);
  console.log(`  outDir:        ${config.outDir}`);
  console.log(`  outFile:       ${config.outFile}`);
  console.log('━'.repeat(60));
  console.log('');
}

async function main() {
  header();
  const startedAt = Date.now();

  let api;
  try {
    api = await createClient({
      baseUrl: config.baseUrl,
      usuario: config.usuario,
      senha:   config.senha,
      timeoutMs: config.timeoutMs,
    });
  } catch (e) {
    console.error('❌ Falha de infraestrutura no login:', e.message);
    process.exitCode = 2;
    return;
  }

  const runner = createRunner();

  // Rotina principal: roda cada arquivo de check.
  for (const { name, fn } of loadChecks()) {
    try {
      console.log(`\n── ${name} ──`);
      await fn({ api, runner, config });
    } catch (e) {
      runner.fail(`Crash inesperado em ${name}`, { error: e.message, stack: e.stack?.split('\n').slice(0, 4).join(' | ') });
    }
  }

  const finishedAt = Date.now();
  const summary = runner.summary();

  // Itens críticos detectados a partir das observações estruturais (FAIL).
  const fails = runner.results.filter(r => r.status === 'FAIL');
  const criticalIssues = fails.slice(0, 5).map(f => ({
    title: `[${f.module}] ${f.name}`,
    body: [
      f.details?.error    ? `Erro: \`${f.details.error}\`` : null,
      f.details?.actual !== undefined   ? `Recebido: \`${f.details.actual}\`` : null,
      f.details?.expected !== undefined ? `Esperado: \`${f.details.expected}\` (\`${f.details.op}\`)` : null,
      f.details?.note     ? `Nota: ${f.details.note}` : null,
    ].filter(Boolean).join('\n\n') || 'Sem detalhes adicionais.',
  }));

  // Heurísticas de usabilidade que essa suíte ainda não testa via API.
  const usabilityNotes = [
    'Header de KPIs (Extratos/NFs/Contratos/Pagamentos/Vinculados) precisa atualizar ao trocar empresa — checar handler de `btn-{empresa}.click()`.',
    'Console do navegador costuma registrar erro de JSON inválido quando algum endpoint da aba Despesas retorna HTML (404). Verificar via DevTools → Network.',
    'Padronizar status de contratos para uma única taxonomia (texto puro + label com emoji) facilita exportação para Excel.',
    'Considerar criar tela executiva consolidando: Adimplência + INSS gap + DARFs vencendo + Saldo grupo. Hoje a informação está espalhada em 4 abas.',
  ];

  const untested = [
    'CRUD (inserção/edição/exclusão) — esta suíte é só leitura.',
    'Upload de arquivos (extratos OFX/NFs).',
    'Conciliação automática / IA.',
    'Permissões de papéis ≠ admin.',
    'Performance sob carga.',
    'Compatibilidade móvel.',
    'Fluxo de logout.',
    'Geração efetiva de PDF/Excel pelos botões de exportação.',
  ];

  const md = buildMarkdown({
    baseUrl: config.baseUrl,
    usuario: config.usuario,
    startedAt,
    finishedAt,
    summary,
    results: runner.results,
    criticalIssues,
    usabilityNotes,
    untested,
  });

  const outPath = path.join(config.outDir, config.outFile);
  saveReport(outPath, md);

  console.log('');
  console.log('━'.repeat(60));
  console.log(`  Total: ${summary.total}  ·  ✅ ${summary.counts.OK}  ·  ⚠️  ${summary.counts.WARN}  ·  ❌ ${summary.counts.FAIL}`);
  console.log(`  Duração: ${((finishedAt - startedAt) / 1000).toFixed(1)}s`);
  console.log(`  Relatório: ${outPath}`);
  console.log('━'.repeat(60));

  process.exitCode = summary.passed ? 0 : 1;
}

main().catch(e => {
  console.error('Crash não-recuperável:', e);
  process.exitCode = 2;
});
