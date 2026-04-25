'use strict';
/**
 * Montana — Auditoria IA: consolida retornos dos agentes em um Markdown
 * unico e grava em output/auditoria_ia_YYYY-MM-DD.md.
 */
const fs = require('fs');
const path = require('path');

function brl(n) {
  return Number(n || 0).toLocaleString('pt-BR', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

function gerarRelatorio({ titulo, execucoes, dadosColetados }) {
  const hoje = new Date().toISOString().slice(0, 10);
  const linhas = [];

  linhas.push(`# ${titulo}`);
  linhas.push('');
  linhas.push(`_Gerado em ${new Date().toISOString()}_`);
  linhas.push('');
  linhas.push('## Resumo de Execução');
  linhas.push('');
  linhas.push('| Agente | Modelo | Tempo (ms) | Tokens IN | Tokens OUT | Cache HIT | Custo R$ |');
  linhas.push('|---|---|---:|---:|---:|---:|---:|');
  let totalCusto = 0;
  for (const e of execucoes) {
    totalCusto += e.custo_brl || 0;
    linhas.push(
      `| ${e.agente} | ${e.modelo} | ${e.ms} | ${e.input_tokens} | ${e.output_tokens} | ${e.cache_read} | ${brl(e.custo_brl)} |`
    );
  }
  linhas.push(`| **TOTAL** | | | | | | **${brl(totalCusto)}** |`);
  linhas.push('');

  for (const e of execucoes) {
    linhas.push(`## Agente: ${e.agente}`);
    linhas.push('');
    linhas.push(e.texto || '_(sem saída)_');
    linhas.push('');
  }

  linhas.push('---');
  linhas.push('## Apêndice: dados enviados aos agentes');
  linhas.push('');
  linhas.push('```json');
  linhas.push(JSON.stringify(dadosColetados, null, 2));
  linhas.push('```');

  const outDir = path.join(__dirname, '..', '..', '..', 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const arquivo = path.join(outDir, `auditoria_ia_${hoje}.md`);
  fs.writeFileSync(arquivo, linhas.join('\n'), 'utf8');
  return { arquivo, totalCusto };
}

module.exports = { gerarRelatorio };
