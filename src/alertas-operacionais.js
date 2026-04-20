/**
 * Montana ERP — Alertas Operacionais (lógica de negócio proativa)
 *
 * 3 lógicas deterministas (sem LLM) que fecham ciclos de feedback:
 *   1. Faturamento esperado × realizado por contrato
 *   2. Cobrança: NFs emitidas com atraso acima do SLA do tomador
 *   3. Folha RH sem contrapartida no extrato bancário
 *
 * Cada função recebe (db, company, opcoes) e retorna { itens: [...], total: N }.
 * Consumo: cron 08h em routes/notificacoes.js e endpoints em routes/alertas-operacionais.js
 */

const TOLERANCIA_FATURAMENTO = 0.10;   // 10% → se realizado < esperado*(1-tol), alerta
const TOLERANCIA_FOLHA       = 0.05;   // 5%  → débito no extrato ≈ total_liquido da folha
const ATRASO_EXTRA_DIAS      = 15;     // NF é "atrasada" se passou (SLA médio + 15d)
const SLA_MIN_AMOSTRAS       = 3;      // mínimo de NFs pagas para calcular SLA confiável
const SLA_PADRAO_DIAS        = 30;     // fallback quando não há histórico suficiente
const COBRANCA_JANELA_DIAS   = 180;    // só alerta NFs emitidas nos últimos N dias (NFs antigas são ruído)
const COBRANCA_LIMITE_ITENS  = 50;     // top N NFs mais valiosas no relatório detalhado

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtBRL(v) {
  return `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function competenciaAtual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function diffDias(dataISO) {
  if (!dataISO) return null;
  const ms = Date.now() - new Date(dataISO + 'T00:00:00').getTime();
  return Math.floor(ms / 86400000);
}

// ─────────────────────────────────────────────────────────────────────────────
// #1 — Faturamento esperado × realizado por contrato
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Para cada contrato ativo:
 *   esperado = total_geral do boletim do mês (se existir) OU valor_mensal_bruto
 *   realizado = SUM(valor_bruto) de NFs emitidas no mês com contrato_ref = numContrato
 *   Se esperado > 0 E (realizado < esperado*(1-tol) OU realizado == 0):
 *     gera alerta.
 *
 * Opções:
 *   - competencia: 'YYYY-MM' (default = mês atual)
 *   - dia_corte:   só alerta se hoje >= dia do mês (default 25 — boletim geralmente emitido até dia 20)
 */
function faturamentoNaoEmitido(db, company, opcoes = {}) {
  const competencia = opcoes.competencia || competenciaAtual();
  const diaCorte    = opcoes.dia_corte ?? 25;
  const hoje        = new Date();
  const hojeComp    = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;

  // Se a competência pedida é a atual e o mês ainda não passou do dia de corte, não gera alerta
  if (competencia === hojeComp && hoje.getDate() < diaCorte) {
    return { itens: [], total: 0, motivo: `aguardando dia ${diaCorte} do mês` };
  }

  let contratos;
  try {
    contratos = db.prepare(`
      SELECT numContrato, contrato, orgao, valor_mensal_bruto
      FROM contratos
      WHERE COALESCE(status,'') != 'encerrado'
        AND COALESCE(valor_mensal_bruto, 0) > 0
    `).all();
  } catch (_) { return { itens: [], total: 0, erro: 'tabela contratos indisponível' }; }

  const itens = [];

  for (const c of contratos) {
    // Tenta boletim do mês — usa LIKE na competência (aceita 'YYYY-MM' ou '01/MM/YYYY')
    let esperado = Number(c.valor_mensal_bruto || 0);
    let origemEsperado = 'contrato.valor_mensal_bruto';
    try {
      const bol = db.prepare(`
        SELECT b.total_geral
        FROM bol_boletins b
        JOIN bol_contratos bc ON bc.id = b.contrato_id
        WHERE bc.num_contrato = ?
          AND (b.competencia = ? OR b.competencia LIKE ?)
        ORDER BY b.id DESC LIMIT 1
      `).get(c.numContrato, competencia, `%${competencia}%`);
      if (bol && bol.total_geral > 0) {
        esperado = Number(bol.total_geral);
        origemEsperado = 'boletim';
      }
    } catch (_) {}

    if (esperado <= 0) continue;

    // Realizado: NFs emitidas no mês com contrato_ref matching
    const realizadoRow = db.prepare(`
      SELECT COALESCE(SUM(valor_bruto),0) v, COUNT(*) n
      FROM notas_fiscais
      WHERE strftime('%Y-%m', data_emissao) = ?
        AND (contrato_ref = ? OR contrato_ref LIKE ?)
    `).get(competencia, c.numContrato, `%${c.numContrato}%`);

    const realizado = Number(realizadoRow?.v || 0);
    const pctCoberto = esperado > 0 ? realizado / esperado : 0;

    if (realizado === 0 || pctCoberto < (1 - TOLERANCIA_FATURAMENTO)) {
      itens.push({
        numContrato: c.numContrato,
        contrato:    c.contrato,
        orgao:       c.orgao,
        competencia,
        esperado,
        realizado,
        faltante:    esperado - realizado,
        pct_coberto: +(pctCoberto * 100).toFixed(1),
        nfs_emitidas: realizadoRow?.n || 0,
        origem_esperado: origemEsperado,
        severidade: realizado === 0 ? 'critica' : (pctCoberto < 0.5 ? 'alta' : 'media'),
      });
    }
  }

  // Ordena por faltante (maior primeiro)
  itens.sort((a, b) => b.faltante - a.faltante);

  return { itens, total: itens.length, competencia };
}

// ─────────────────────────────────────────────────────────────────────────────
// #2 — Cobrança: NFs emitidas com atraso acima do SLA do tomador
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Calcula SLA médio de recebimento por tomador a partir do histórico:
 *   - NFs com status_conciliacao='CONCILIADO' e data_pagamento preenchida
 *   - dias = data_pagamento - data_emissao
 *
 * Marca NFs em aberto (não conciliadas) cujo tempo desde emissão passou SLA+15.
 *
 * Opções:
 *   - min_amostras: mínimo de NFs pagas por tomador para usar SLA próprio (default 3)
 *   - sla_padrao:   dias a usar quando amostras < min (default 30)
 *   - atraso_extra: margem sobre o SLA antes de considerar atrasada (default 15)
 */
function cobrancasAtrasadas(db, company, opcoes = {}) {
  const minAmostras = opcoes.min_amostras ?? SLA_MIN_AMOSTRAS;
  const slaPadrao   = opcoes.sla_padrao   ?? SLA_PADRAO_DIAS;
  const atrasoExtra = opcoes.atraso_extra ?? ATRASO_EXTRA_DIAS;
  const janelaDias  = opcoes.janela_dias  ?? COBRANCA_JANELA_DIAS;
  const limiteItens = opcoes.limite_itens ?? COBRANCA_LIMITE_ITENS;

  // Calcula SLA médio por tomador (apenas NFs pagas com ambas as datas)
  const slaRows = db.prepare(`
    SELECT tomador,
           AVG(julianday(data_pagamento) - julianday(data_emissao)) AS dias_medio,
           COUNT(*) AS amostras
    FROM notas_fiscais
    WHERE data_emissao IS NOT NULL
      AND data_pagamento IS NOT NULL
      AND data_pagamento > data_emissao
      AND (julianday(data_pagamento) - julianday(data_emissao)) BETWEEN 1 AND 365
    GROUP BY tomador
  `).all();

  const slaMap = new Map();
  for (const r of slaRows) {
    if (r.amostras >= minAmostras) {
      slaMap.set(r.tomador, Math.round(r.dias_medio));
    }
  }

  // Data limite: só considerar NFs emitidas nos últimos janelaDias
  const dataLimite = new Date(Date.now() - janelaDias * 86400000).toISOString().split('T')[0];

  // NFs em aberto: sem data_pagamento, não CONCILIADAS, e dentro da janela
  const abertas = db.prepare(`
    SELECT numero, tomador, valor_bruto, valor_liquido, data_emissao, contrato_ref,
           status_conciliacao
    FROM notas_fiscais
    WHERE (data_pagamento IS NULL OR data_pagamento = '')
      AND COALESCE(status_conciliacao,'') NOT IN ('CONCILIADO','ASSESSORIA','IGNORAR')
      AND data_emissao IS NOT NULL
      AND data_emissao <= date('now')
      AND data_emissao >= ?
      AND COALESCE(valor_bruto, 0) > 0
  `).all(dataLimite);

  const itens = [];
  for (const nf of abertas) {
    const dias = diffDias(nf.data_emissao);
    if (dias === null) continue;

    const slaTomador = slaMap.get(nf.tomador) ?? slaPadrao;
    const origemSLA  = slaMap.has(nf.tomador) ? 'histórico' : 'padrão';
    const limite     = slaTomador + atrasoExtra;

    if (dias > limite) {
      itens.push({
        numero:       nf.numero,
        tomador:      nf.tomador,
        contrato_ref: nf.contrato_ref,
        valor_bruto:  Number(nf.valor_bruto || 0),
        valor_liquido: Number(nf.valor_liquido || 0),
        data_emissao: nf.data_emissao,
        dias_em_aberto: dias,
        sla_tomador:  slaTomador,
        origem_sla:   origemSLA,
        dias_atraso:  dias - slaTomador,
        severidade:   dias > slaTomador * 2 ? 'critica' : (dias > slaTomador * 1.5 ? 'alta' : 'media'),
      });
    }
  }

  // Ordena por valor_bruto desc (maior rombo primeiro)
  itens.sort((a, b) => b.valor_bruto - a.valor_bruto);

  // Agrega por tomador (resumo executivo)
  const porTomador = new Map();
  for (const i of itens) {
    const t = i.tomador || '(desconhecido)';
    if (!porTomador.has(t)) porTomador.set(t, { tomador: t, nfs: 0, valor_bruto: 0, mais_antiga: i.data_emissao, sla: i.sla_tomador, origem_sla: i.origem_sla });
    const g = porTomador.get(t);
    g.nfs += 1;
    g.valor_bruto += i.valor_bruto;
    if (i.data_emissao < g.mais_antiga) g.mais_antiga = i.data_emissao;
  }
  const resumoPorTomador = Array.from(porTomador.values()).sort((a, b) => b.valor_bruto - a.valor_bruto);

  const totalValor = itens.reduce((s, i) => s + i.valor_bruto, 0);
  return {
    itens:              itens.slice(0, limiteItens),    // top N detalhado
    total:              itens.length,
    valor_total:        totalValor,
    janela_dias:        janelaDias,
    por_tomador:        resumoPorTomador,
    slas_por_tomador:   Object.fromEntries(slaMap),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// #3 — Folha RH sem contrapartida no extrato bancário
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Para cada folha (rh_folha) não vinculada a débito do extrato:
 *   - Janela de busca: dia 1 a dia 15 do mês seguinte à competência
 *   - Procura débitos cuja soma ≈ total_liquido (± 5%) com histórico de folha/salário
 *   - Se não encontrar, gera alerta
 *
 * Opções:
 *   - competencias: array de 'YYYY-MM' a verificar (default = últimos 3 meses fechados)
 */
function folhaSemContrapartida(db, company, opcoes = {}) {
  // Determina competências a checar: default = 3 últimos meses fechados
  let competencias = opcoes.competencias;
  if (!competencias) {
    competencias = [];
    const hoje = new Date();
    for (let i = 1; i <= 3; i++) {
      const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
      competencias.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
  }

  let folhas;
  try {
    folhas = db.prepare(`
      SELECT competencia, data_pagamento, total_liquido, status
      FROM rh_folha
      WHERE competencia IN (${competencias.map(() => '?').join(',')})
        AND COALESCE(total_liquido, 0) > 0
    `).all(...competencias);
  } catch (_) { return { itens: [], total: 0, erro: 'tabela rh_folha indisponível' }; }

  const itens = [];

  for (const f of folhas) {
    const [ano, mes] = f.competencia.split('-').map(Number);
    // Janela: dia 1 ao dia 15 do mês SEGUINTE
    const proxMes   = mes === 12 ? 1 : mes + 1;
    const proxAno   = mes === 12 ? ano + 1 : ano;
    const janelaIni = `${proxAno}-${String(proxMes).padStart(2, '0')}-01`;
    const janelaFim = `${proxAno}-${String(proxMes).padStart(2, '0')}-15`;

    const esperado = Number(f.total_liquido || 0);
    const minVal   = esperado * (1 - TOLERANCIA_FOLHA);
    const maxVal   = esperado * (1 + TOLERANCIA_FOLHA);

    // Busca débitos na janela que batem com total ou candidatos a compor folha
    const candidatos = db.prepare(`
      SELECT id, data_iso, historico, debito
      FROM extratos
      WHERE data_iso >= ? AND data_iso <= ?
        AND COALESCE(debito, 0) > 0
        AND (
          debito BETWEEN ? AND ?
          OR lower(historico) LIKE '%folha%'
          OR lower(historico) LIKE '%salario%'
          OR lower(historico) LIKE '%salário%'
          OR lower(historico) LIKE '%pgto %'
        )
    `).all(janelaIni, janelaFim, minVal, maxVal);

    // Caso 1: existe um único lançamento que bate
    const match = candidatos.find(c => c.debito >= minVal && c.debito <= maxVal);
    if (match) continue; // folha paga e identificada

    // Caso 2: soma de lançamentos "folha/salário" na janela bate
    const lancFolha = candidatos.filter(c =>
      /folha|salario|salário|pgto /i.test(c.historico || '')
    );
    const somaFolha = lancFolha.reduce((s, c) => s + Number(c.debito), 0);
    if (somaFolha >= minVal && somaFolha <= maxVal) continue;

    // Nada bateu — gera alerta
    itens.push({
      competencia: f.competencia,
      data_pagamento_declarada: f.data_pagamento,
      total_liquido: esperado,
      janela_busca: `${janelaIni} a ${janelaFim}`,
      candidatos_encontrados: candidatos.length,
      soma_candidatos_folha: somaFolha,
      status_folha: f.status,
      severidade: candidatos.length === 0 ? 'critica' : 'alta',
    });
  }

  itens.sort((a, b) => b.total_liquido - a.total_liquido);
  return { itens, total: itens.length, competencias_verificadas: competencias };
}

// ─────────────────────────────────────────────────────────────────────────────
// Agregador — chama as 3 lógicas e retorna tudo num relatório
// ─────────────────────────────────────────────────────────────────────────────
function rodarTodos(db, company, opcoes = {}) {
  const resultado = {
    empresa:     company?.nome || '(?)',
    gerado_em:   new Date().toISOString(),
    faturamento: { itens: [], total: 0 },
    cobrancas:   { itens: [], total: 0 },
    folha:       { itens: [], total: 0 },
    total_geral: 0,
  };

  try { resultado.faturamento = faturamentoNaoEmitido(db, company, opcoes.faturamento || {}); }
  catch (e) { resultado.faturamento.erro = e.message; }

  try { resultado.cobrancas = cobrancasAtrasadas(db, company, opcoes.cobrancas || {}); }
  catch (e) { resultado.cobrancas.erro = e.message; }

  try { resultado.folha = folhaSemContrapartida(db, company, opcoes.folha || {}); }
  catch (e) { resultado.folha.erro = e.message; }

  resultado.total_geral = resultado.faturamento.total + resultado.cobrancas.total + resultado.folha.total;
  return resultado;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatação para email (HTML)
// ─────────────────────────────────────────────────────────────────────────────
function formatarHTML(rel) {
  const cor = { critica: '#c92a2a', alta: '#e8590c', media: '#f08c00' };
  let html = `<h2>⚠ Alertas Operacionais — ${rel.empresa}</h2>`;
  html += `<p>Gerado em ${new Date(rel.gerado_em).toLocaleString('pt-BR')}</p>`;

  // #1 Faturamento
  html += `<h3>1) Faturamento não emitido (${rel.faturamento.total})</h3>`;
  if (rel.faturamento.total === 0) {
    html += `<p>✅ Todos os contratos ativos com faturamento em dia${rel.faturamento.motivo ? ` (${rel.faturamento.motivo})` : ''}.</p>`;
  } else {
    html += `<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;font-size:13px">`;
    html += `<tr style="background:#f1f3f5"><th>Contrato</th><th>Órgão</th><th>Esperado</th><th>Emitido</th><th>Faltante</th><th>%</th></tr>`;
    for (const i of rel.faturamento.itens.slice(0, 20)) {
      html += `<tr style="background:${cor[i.severidade]}10">`;
      html += `<td>${i.numContrato}</td><td>${i.orgao || ''}</td>`;
      html += `<td>${fmtBRL(i.esperado)}</td><td>${fmtBRL(i.realizado)}</td>`;
      html += `<td style="color:${cor[i.severidade]};font-weight:bold">${fmtBRL(i.faltante)}</td>`;
      html += `<td>${i.pct_coberto}%</td></tr>`;
    }
    html += `</table>`;
  }

  // #2 Cobranças (resumo por tomador + top NFs)
  html += `<h3>2) Cobranças em atraso (${rel.cobrancas.total} NFs — últimos ${rel.cobrancas.janela_dias || 180} dias)</h3>`;
  if (rel.cobrancas.total === 0) {
    html += `<p>✅ Nenhuma NF em aberto além do SLA dos tomadores.</p>`;
  } else {
    html += `<p><b>Valor total atrasado: ${fmtBRL(rel.cobrancas.valor_total)}</b></p>`;
    // Resumo por tomador (visão gerencial)
    html += `<h4 style="margin-top:12px">Resumo por tomador</h4>`;
    html += `<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;font-size:13px;width:100%">`;
    html += `<tr style="background:#f1f3f5"><th>Tomador</th><th>NFs</th><th>Valor total</th><th>Mais antiga</th><th>SLA</th></tr>`;
    for (const t of (rel.cobrancas.por_tomador || []).slice(0, 15)) {
      html += `<tr><td>${t.tomador}</td><td style="text-align:center">${t.nfs}</td>`;
      html += `<td style="text-align:right"><b>${fmtBRL(t.valor_bruto)}</b></td>`;
      html += `<td>${t.mais_antiga}</td><td>${t.sla}d (${t.origem_sla})</td></tr>`;
    }
    html += `</table>`;
    // Top NFs individuais (maiores valores)
    html += `<h4 style="margin-top:12px">Top NFs individuais (maiores valores)</h4>`;
    html += `<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;font-size:12px">`;
    html += `<tr style="background:#f1f3f5"><th>NF</th><th>Tomador</th><th>Valor</th><th>Emissão</th><th>Dias</th><th>Atraso</th></tr>`;
    for (const i of rel.cobrancas.itens.slice(0, 10)) {
      html += `<tr style="background:${cor[i.severidade]}10">`;
      html += `<td>${i.numero}</td><td>${(i.tomador || '').slice(0, 45)}</td>`;
      html += `<td style="text-align:right">${fmtBRL(i.valor_bruto)}</td><td>${i.data_emissao}</td>`;
      html += `<td>${i.dias_em_aberto}d</td>`;
      html += `<td style="color:${cor[i.severidade]};font-weight:bold">+${i.dias_atraso}d</td></tr>`;
    }
    html += `</table>`;
  }

  // #3 Folha
  html += `<h3>3) Folhas sem contrapartida no extrato (${rel.folha.total})</h3>`;
  if (rel.folha.total === 0) {
    html += `<p>✅ Todas as folhas dos últimos 3 meses identificadas nos extratos.</p>`;
  } else {
    html += `<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;font-size:13px">`;
    html += `<tr style="background:#f1f3f5"><th>Competência</th><th>Valor</th><th>Janela busca</th><th>Candidatos</th></tr>`;
    for (const i of rel.folha.itens) {
      html += `<tr style="background:${cor[i.severidade]}10">`;
      html += `<td>${i.competencia}</td><td>${fmtBRL(i.total_liquido)}</td>`;
      html += `<td>${i.janela_busca}</td><td>${i.candidatos_encontrados}</td></tr>`;
    }
    html += `</table>`;
  }

  return html;
}

module.exports = {
  faturamentoNaoEmitido,
  cobrancasAtrasadas,
  folhaSemContrapartida,
  rodarTodos,
  formatarHTML,
};
