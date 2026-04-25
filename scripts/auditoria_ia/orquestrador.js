#!/usr/bin/env node
'use strict';
/**
 * Montana ERP — Orquestrador de Auditoria IA
 *
 * Executa os agentes de auditoria em paralelo (por padrao todo sabado via
 * cron) e consolida o relatorio em output/auditoria_ia_YYYY-MM-DD.md.
 *
 * Uso:
 *   node scripts/auditoria_ia/orquestrador.js
 *   node scripts/auditoria_ia/orquestrador.js --empresas=assessoria,seguranca
 *   node scripts/auditoria_ia/orquestrador.js --dias=14
 *   node scripts/auditoria_ia/orquestrador.js --somente=contabil_fiscal
 *   node scripts/auditoria_ia/orquestrador.js --teto-brl=5     # aborta se passar
 *
 * Agendamento sugerido (sabado 04h):
 *   0 4 * * 6  cd /opt/montana/app_unificado && /usr/bin/node scripts/auditoria_ia/orquestrador.js >> /var/log/montana/auditoria_ia.log 2>&1
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const {
  EMPRESAS_DEFAULT,
  coletarContabilFiscal,
  coletarConciliacao,
  coletarLogicaSistemica,
} = require('./lib/coleta');
const { gerarRelatorio } = require('./lib/relatorio');

const contabilFiscal   = require('./agentes/contabil_fiscal');
const conciliacao      = require('./agentes/conciliacao');
const logicaSistemica  = require('./agentes/logica_sistemica');

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const empresas = (args.empresas ? String(args.empresas).split(',') : EMPRESAS_DEFAULT)
    .map(s => s.trim()).filter(Boolean);
  const diasJanela = Number(args.dias || 7);
  const somente = args.somente ? String(args.somente).split(',').map(s => s.trim()) : null;
  const tetoBRL = args['teto-brl'] ? Number(args['teto-brl']) : 10;

  console.log('═'.repeat(70));
  console.log('  MONTANA ERP — AUDITORIA IA');
  console.log('═'.repeat(70));
  console.log(`  Empresas   : ${empresas.join(', ')}`);
  console.log(`  Janela     : ${diasJanela} dias`);
  console.log(`  Agentes    : ${somente ? somente.join(', ') : 'todos'}`);
  console.log(`  Teto custo : R$ ${tetoBRL.toFixed(2)}`);
  console.log('');

  // ── Coleta (local, barato) ──────────────────────────────────────────
  const dadosColetados = {
    contabil_fiscal: {},
    conciliacao: {},
    logica_sistemica: coletarLogicaSistemica(),
  };
  for (const emp of empresas) {
    try {
      dadosColetados.contabil_fiscal[emp] = coletarContabilFiscal(emp, { diasJanela });
      dadosColetados.conciliacao[emp]     = coletarConciliacao(emp, { diasJanela });
    } catch (e) {
      console.error(`  ⚠️  Falha ao coletar ${emp}: ${e.message}`);
    }
  }
  console.log('  ✅ Coleta concluida');

  // ── Execucao dos agentes em paralelo ───────────────────────────────
  const execucoesPlanejadas = [];
  if (!somente || somente.includes('contabil_fiscal')) {
    execucoesPlanejadas.push(
      contabilFiscal.executar({ dados: dadosColetados.contabil_fiscal })
    );
  }
  if (!somente || somente.includes('conciliacao')) {
    execucoesPlanejadas.push(
      conciliacao.executar({ dados: dadosColetados.conciliacao })
    );
  }
  if (!somente || somente.includes('logica_sistemica')) {
    execucoesPlanejadas.push(
      logicaSistemica.executar({ dados: dadosColetados.logica_sistemica })
    );
  }

  console.log(`  🚀 Invocando ${execucoesPlanejadas.length} agentes em paralelo...`);
  const resultados = await Promise.allSettled(execucoesPlanejadas);

  const execucoes = [];
  for (const r of resultados) {
    if (r.status === 'fulfilled') {
      execucoes.push(r.value);
      console.log(`  ✅ ${r.value.agente.padEnd(20)} R$ ${r.value.custo_brl.toFixed(4)}  (${r.value.ms}ms)`);
    } else {
      console.error(`  ❌ Agente falhou: ${r.reason && r.reason.message}`);
      execucoes.push({
        agente: 'falha',
        modelo: '-', ms: 0,
        input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0,
        custo_brl: 0,
        texto: `**Erro:** ${r.reason && r.reason.message}`,
      });
    }
  }

  // ── Relatorio ──────────────────────────────────────────────────────
  const { arquivo, totalCusto } = gerarRelatorio({
    titulo: 'Montana ERP — Auditoria IA',
    execucoes,
    dadosColetados,
  });

  console.log('');
  console.log(`  📄 Relatorio : ${arquivo}`);
  console.log(`  💰 Custo     : R$ ${totalCusto.toFixed(4)}`);

  if (totalCusto > tetoBRL) {
    console.error(`  ⚠️  CUSTO EXCEDEU TETO (R$ ${tetoBRL.toFixed(2)}) — investigue prompts / janela.`);
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('ERRO FATAL:', err);
    process.exit(1);
  });
}
