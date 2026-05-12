'use strict';
/**
 * qa/lib/report.js
 * Geração de relatório Markdown estruturado a partir dos resultados
 * acumulados pelo runner.
 */

const fs = require('fs');
const path = require('path');

function fmtBRL(n) {
  if (n == null || isNaN(n)) return '—';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function statusIcon(s) {
  return s === 'OK' ? '✅' : s === 'WARN' ? '⚠️' : '❌';
}

/**
 * Agrupa resultados por módulo na ordem em que apareceram.
 */
function groupByModule(results) {
  const order = [];
  const map = new Map();
  for (const r of results) {
    if (!map.has(r.module)) {
      map.set(r.module, []);
      order.push(r.module);
    }
    map.get(r.module).push(r);
  }
  return order.map(m => ({ module: m, items: map.get(m) }));
}

/**
 * Gera o conteúdo do relatório.
 */
function buildMarkdown({ baseUrl, usuario, startedAt, finishedAt, summary, results, criticalIssues = [], usabilityNotes = [], untested = [] }) {
  const totalMs = finishedAt - startedAt;
  const dateBR = new Date(startedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  const lines = [];
  lines.push(`# QA Independente — Sistema Montana Unificado`);
  lines.push('');
  lines.push(`**Data da execução:** ${dateBR} (${(totalMs/1000).toFixed(1)}s)`);
  lines.push(`**Sistema:** ${baseUrl}`);
  lines.push(`**Login:** \`${usuario}\``);
  lines.push(`**Origem:** \`qa/run.js\` (rotina migrada do Cowork para o código)`);
  lines.push('');

  // Resumo executivo
  lines.push('---');
  lines.push('');
  lines.push('## 1. Resumo executivo');
  lines.push('');
  lines.push('| Status | Qtd | % |');
  lines.push('|---|---|---|');
  lines.push(`| ✅ OK | ${summary.counts.OK} | ${summary.pct.OK}% |`);
  lines.push(`| ⚠️ Parcial / observações | ${summary.counts.WARN} | ${summary.pct.WARN}% |`);
  lines.push(`| ❌ Falhou | ${summary.counts.FAIL} | ${summary.pct.FAIL}% |`);
  lines.push(`| **Total** | **${summary.total}** | 100% |`);
  lines.push('');
  lines.push(`**Status geral:** ${summary.passed ? '🟢 nenhum FAIL crítico' : '🔴 ' + summary.counts.FAIL + ' falha(s) crítica(s) detectada(s)'}`);
  lines.push('');

  // Itens críticos
  if (criticalIssues.length) {
    lines.push('---');
    lines.push('');
    lines.push('## 2. Itens críticos (priorizados — corrigir amanhã)');
    lines.push('');
    criticalIssues.forEach((iss, i) => {
      lines.push(`### 🔴 ${i + 1}. ${iss.title}`);
      lines.push('');
      lines.push(iss.body);
      lines.push('');
    });
  }

  // Falhas (FAIL) extraídas
  const fails = results.filter(r => r.status === 'FAIL');
  const warns = results.filter(r => r.status === 'WARN');
  if (fails.length || warns.length) {
    lines.push('---');
    lines.push('');
    lines.push('## 3. Itens com observações ou falhas (do runner)');
    lines.push('');
    if (fails.length) {
      lines.push('### ❌ Falhas');
      lines.push('');
      fails.forEach(f => {
        lines.push(`- **[${f.module}]** ${f.name}`);
        if (f.details && Object.keys(f.details).length) {
          const d = f.details;
          if (d.note)     lines.push(`  - Nota: ${d.note}`);
          if (d.error)    lines.push(`  - Erro: \`${d.error}\``);
          if (d.actual !== undefined)   lines.push(`  - Recebido: \`${d.actual}\``);
          if (d.expected !== undefined) lines.push(`  - Esperado: \`${d.expected}\` (op: \`${d.op}\`)`);
        }
      });
      lines.push('');
    }
    if (warns.length) {
      lines.push('### ⚠️ Avisos');
      lines.push('');
      warns.forEach(w => {
        lines.push(`- **[${w.module}]** ${w.name}${w.details?.note ? ' — ' + w.details.note : ''}`);
      });
      lines.push('');
    }
  }

  // Detalhamento por módulo
  lines.push('---');
  lines.push('');
  lines.push('## 4. Detalhamento por módulo');
  lines.push('');
  for (const grp of groupByModule(results)) {
    lines.push(`### 4.${grp.module}`);
    lines.push('');
    lines.push('| Status | Item | Observação |');
    lines.push('|---|---|---|');
    for (const r of grp.items) {
      const note = r.details?.note
        || r.details?.error
        || (r.details?.actual !== undefined ? `recebido=\`${r.details.actual}\`` : '');
      lines.push(`| ${statusIcon(r.status)} | ${r.name} | ${note || ''} |`);
    }
    lines.push('');
  }

  // Observações de usabilidade
  if (usabilityNotes.length) {
    lines.push('---');
    lines.push('');
    lines.push('## 5. Observações de usabilidade');
    lines.push('');
    usabilityNotes.forEach((n, i) => {
      lines.push(`${i + 1}. ${n}`);
    });
    lines.push('');
  }

  // Não testado
  if (untested.length) {
    lines.push('---');
    lines.push('');
    lines.push('## 6. O que NÃO foi testado nesta rodada');
    lines.push('');
    untested.forEach(u => lines.push(`- ${u}`));
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(`*Relatório gerado automaticamente por \`qa/run.js\` em ${dateBR}.*`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Salva o relatório no caminho informado, criando diretórios necessários.
 */
function saveReport(filepath, content) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, content, 'utf8');
  return filepath;
}

module.exports = { buildMarkdown, saveReport, fmtBRL, statusIcon };
