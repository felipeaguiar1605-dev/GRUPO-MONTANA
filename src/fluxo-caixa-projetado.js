/**
 * Montana ERP — Fluxo de Caixa Projetado (30 / 60 / 90 dias)
 *
 * Gera projeção de caixa usando três fontes:
 *   ENTRADAS (a receber):
 *     - NFs emitidas não pagas, com data prevista = data_emissao + SLA médio do tomador
 *     - Probabilidade baseada em idade da NF (NF fresca = alta, NF muito antiga = baixa)
 *
 *   SAÍDAS (a pagar):
 *     - Folha RH recorrente (média dos últimos 3 meses), paga dia 5 do mês seguinte
 *     - Despesas recorrentes por categoria (média mensal histórica)
 *     - Impostos (apuração PIS/COFINS/IRPJ se tabela apuracao_mensal tiver dados)
 *
 *   SALDO INICIAL:
 *     - Soma líquida dos extratos até hoje (credito - debito)
 *
 * API principal:
 *   projecaoFluxoCaixa(db, company, { dias = 90, buckets = 'semanal'|'mensal' })
 *   => { saldo_inicial, buckets: [{ini, fim, entradas, saidas, saldo_final, itens_entrada, itens_saida}] }
 */

const SLA_MIN_AMOSTRAS   = 3;
const SLA_PADRAO_DIAS    = 30;
const JANELA_HISTORICA   = 180;     // dias para calcular médias de despesas
const MESES_FOLHA_MEDIA  = 3;       // quantos meses para média de folha
const DIA_PAGAMENTO_FOLHA = 5;      // folha geralmente paga até dia 5 do mês seguinte

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function toISO(d) {
  return d.toISOString().split('T')[0];
}

function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return toISO(d);
}

function firstDayOfMonth(year, month) {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

function lastDayOfMonth(year, month) {
  const d = new Date(year, month, 0);
  return toISO(d);
}

// ────────────────────────────────────────────────────────────────────────────
// SLAs por tomador (mesmo algoritmo de alertas-operacionais.js)
// ────────────────────────────────────────────────────────────────────────────
function calcularSLAs(db) {
  const rows = db.prepare(`
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
  for (const r of rows) {
    if (r.amostras >= SLA_MIN_AMOSTRAS) slaMap.set(r.tomador, Math.round(r.dias_medio));
  }
  return slaMap;
}

// ────────────────────────────────────────────────────────────────────────────
// Saldo inicial — soma líquida dos extratos
// ────────────────────────────────────────────────────────────────────────────
function calcularSaldoInicial(db) {
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(credito), 0) - COALESCE(SUM(debito), 0) AS saldo,
             MAX(data_iso) AS ultima_data
      FROM extratos
      WHERE data_iso <= date('now')
    `).get();
    return {
      saldo:        Number(row?.saldo || 0),
      ultima_data:  row?.ultima_data || null,
    };
  } catch (_) {
    return { saldo: 0, ultima_data: null };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Entradas projetadas — NFs a receber
// ────────────────────────────────────────────────────────────────────────────
function projectarEntradas(db, horizonteDias) {
  const hoje = toISO(new Date());
  const limite = addDays(hoje, horizonteDias);
  const slas = calcularSLAs(db);

  // NFs em aberto
  const abertas = db.prepare(`
    SELECT numero, tomador, valor_liquido, valor_bruto, data_emissao, contrato_ref,
           status_conciliacao
    FROM notas_fiscais
    WHERE (data_pagamento IS NULL OR data_pagamento = '')
      AND COALESCE(status_conciliacao, '') NOT IN ('CONCILIADO', 'ASSESSORIA', 'IGNORAR')
      AND data_emissao IS NOT NULL
      AND COALESCE(valor_bruto, 0) > 0
      AND data_emissao >= date('now', '-365 days')
  `).all();

  const itens = [];
  for (const nf of abertas) {
    const slaDias = slas.get(nf.tomador) ?? SLA_PADRAO_DIAS;
    const dataPrevista = addDays(nf.data_emissao, slaDias);

    // Calcula probabilidade: quanto mais velha a NF, menor a probabilidade
    const diasDesdeEmissao = Math.floor(
      (Date.now() - new Date(nf.data_emissao + 'T00:00:00').getTime()) / 86400000
    );
    let probabilidade;
    if (diasDesdeEmissao <= slaDias) probabilidade = 0.95;
    else if (diasDesdeEmissao <= slaDias * 1.5) probabilidade = 0.80;
    else if (diasDesdeEmissao <= slaDias * 2) probabilidade = 0.60;
    else if (diasDesdeEmissao <= slaDias * 3) probabilidade = 0.40;
    else probabilidade = 0.20;

    // Se data prevista já passou, joga para "próximos 7 dias"
    const dataEfetiva = dataPrevista < hoje ? addDays(hoje, 7) : dataPrevista;

    // Só inclui no horizonte
    if (dataEfetiva > limite) continue;

    const valor = Number(nf.valor_liquido || nf.valor_bruto || 0);
    itens.push({
      tipo:         'nf_a_receber',
      numero:       nf.numero,
      tomador:      nf.tomador,
      contrato:     nf.contrato_ref,
      data_emissao: nf.data_emissao,
      data_prevista: dataEfetiva,
      sla_dias:     slaDias,
      valor_bruto:  Number(nf.valor_bruto || 0),
      valor_liquido: valor,
      probabilidade: +probabilidade.toFixed(2),
      valor_esperado: +(valor * probabilidade).toFixed(2),
      dias_desde_emissao: diasDesdeEmissao,
    });
  }

  itens.sort((a, b) => a.data_prevista.localeCompare(b.data_prevista));
  return itens;
}

// ────────────────────────────────────────────────────────────────────────────
// Saídas projetadas — folha + despesas recorrentes
// ────────────────────────────────────────────────────────────────────────────
function projectarSaidas(db, horizonteDias) {
  const hoje = toISO(new Date());
  const limite = addDays(hoje, horizonteDias);
  const itens = [];

  // 1) Folha recorrente — média dos últimos N meses
  let folhaMedia = 0;
  try {
    const row = db.prepare(`
      SELECT AVG(total_liquido) AS media, COUNT(*) AS n
      FROM rh_folha
      WHERE COALESCE(total_liquido, 0) > 0
        AND competencia >= strftime('%Y-%m', date('now', '-${MESES_FOLHA_MEDIA} months'))
    `).get();
    folhaMedia = Number(row?.media || 0);

    // Fallback: se não houver folha nos últimos N meses, usa média histórica
    if (folhaMedia === 0) {
      const row2 = db.prepare(`
        SELECT AVG(total_liquido) AS media FROM rh_folha WHERE COALESCE(total_liquido, 0) > 0
      `).get();
      folhaMedia = Number(row2?.media || 0);
    }
  } catch (_) {}

  // Se não tem folha em rh_folha, usa média de despesas categoria "Folha Pgto"
  if (folhaMedia === 0) {
    try {
      const row = db.prepare(`
        SELECT SUM(valor_liquido) / 6.0 AS media
        FROM despesas
        WHERE lower(categoria) LIKE '%folha%'
          AND data_iso >= date('now', '-180 days')
      `).get();
      folhaMedia = Number(row?.media || 0);
    } catch (_) {}
  }

  // Projeta folha para próximos meses: paga no dia DIA_PAGAMENTO_FOLHA
  if (folhaMedia > 0) {
    const hojeDate = new Date();
    for (let i = 0; i < 4; i++) {
      const ano = hojeDate.getFullYear();
      const mes = hojeDate.getMonth() + 1 + i; // mês seguinte em diante
      const dNorm = new Date(ano, mes - 1, DIA_PAGAMENTO_FOLHA);
      const data = toISO(dNorm);
      if (data < hoje) continue;
      if (data > limite) break;
      itens.push({
        tipo:          'folha_recorrente',
        descricao:     `Folha de pagamento — ${dNorm.getFullYear()}-${String(dNorm.getMonth() + 1).padStart(2, '0')}`,
        data_prevista: data,
        valor:         +folhaMedia.toFixed(2),
        probabilidade: 0.95,
        categoria:     'Folha Pgto',
      });
    }
  }

  // 2) Despesas recorrentes por categoria (média mensal dos últimos 6 meses)
  let catMedias = [];
  try {
    catMedias = db.prepare(`
      SELECT categoria,
             SUM(valor_liquido) / 6.0 AS media_mensal,
             COUNT(*) AS n
      FROM despesas
      WHERE data_iso >= date('now', '-${JANELA_HISTORICA} days')
        AND COALESCE(valor_liquido, 0) > 0
        AND lower(categoria) NOT LIKE '%folha%'
      GROUP BY categoria
      HAVING COUNT(*) >= 3
      ORDER BY media_mensal DESC
    `).all();
  } catch (_) {}

  // Distribui cada categoria mensalmente no dia 15 dos próximos meses
  for (const cat of catMedias) {
    const media = Number(cat.media_mensal || 0);
    if (media <= 0) continue;
    const hojeDate = new Date();
    for (let i = 0; i < 4; i++) {
      const ano = hojeDate.getFullYear();
      const mes = hojeDate.getMonth() + 1 + i;
      const dNorm = new Date(ano, mes - 1, 15);
      const data = toISO(dNorm);
      if (data < hoje) continue;
      if (data > limite) break;
      itens.push({
        tipo:          'despesa_recorrente',
        descricao:     `${cat.categoria} (média histórica)`,
        data_prevista: data,
        valor:         +media.toFixed(2),
        probabilidade: 0.80,
        categoria:     cat.categoria,
      });
    }
  }

  itens.sort((a, b) => a.data_prevista.localeCompare(b.data_prevista));
  return itens;
}

// ────────────────────────────────────────────────────────────────────────────
// Agrega em buckets (semanal ou mensal)
// ────────────────────────────────────────────────────────────────────────────
function agregarBuckets(saldoInicial, entradas, saidas, dias, periodicidade) {
  const hoje = toISO(new Date());
  const buckets = [];

  if (periodicidade === 'mensal') {
    // Buckets mensais: divide até o fim do Nth mês
    const hojeDate = new Date();
    const tamanhoMeses = Math.ceil(dias / 30);
    for (let i = 0; i < tamanhoMeses; i++) {
      const ano = hojeDate.getFullYear();
      const mes = hojeDate.getMonth() + 1 + i;
      const ini = i === 0 ? hoje : firstDayOfMonth(ano, mes);
      const fim = lastDayOfMonth(ano, mes);
      buckets.push({ ini, fim, label: `${ano}-${String(mes).padStart(2, '0')}` });
    }
  } else {
    // Buckets semanais (7 dias)
    let inicio = hoje;
    let num = 1;
    while (inicio < addDays(hoje, dias)) {
      const fim = addDays(inicio, 6);
      buckets.push({ ini: inicio, fim, label: `S${num} (${inicio.slice(5)} → ${fim.slice(5)})` });
      inicio = addDays(fim, 1);
      num++;
    }
  }

  // Distribui itens nos buckets
  let saldoRolante = saldoInicial;
  for (const b of buckets) {
    b.itens_entrada = entradas.filter(e => e.data_prevista >= b.ini && e.data_prevista <= b.fim);
    b.itens_saida   = saidas.filter(s => s.data_prevista >= b.ini && s.data_prevista <= b.fim);
    b.entradas_bruto    = b.itens_entrada.reduce((s, e) => s + e.valor_liquido, 0);
    b.entradas_esperado = b.itens_entrada.reduce((s, e) => s + e.valor_esperado, 0);
    b.saidas            = b.itens_saida.reduce((s, x) => s + x.valor, 0);
    b.fluxo_liquido     = b.entradas_esperado - b.saidas;
    saldoRolante       += b.fluxo_liquido;
    b.saldo_final       = +saldoRolante.toFixed(2);
    b.entradas_bruto    = +b.entradas_bruto.toFixed(2);
    b.entradas_esperado = +b.entradas_esperado.toFixed(2);
    b.saidas            = +b.saidas.toFixed(2);
    b.fluxo_liquido     = +b.fluxo_liquido.toFixed(2);
    b.qtd_entradas      = b.itens_entrada.length;
    b.qtd_saidas        = b.itens_saida.length;
  }

  return buckets;
}

// ────────────────────────────────────────────────────────────────────────────
// API principal
// ────────────────────────────────────────────────────────────────────────────
function projecaoFluxoCaixa(db, company, opcoes = {}) {
  const dias          = Math.max(7, Math.min(365, Number(opcoes.dias) || 90));
  const periodicidade = opcoes.periodicidade === 'semanal' ? 'semanal' : 'mensal';
  const incluirItens  = opcoes.incluir_itens !== false;

  const saldo     = calcularSaldoInicial(db);
  const entradas  = projectarEntradas(db, dias);
  const saidas    = projectarSaidas(db, dias);
  const buckets   = agregarBuckets(saldo.saldo, entradas, saidas, dias, periodicidade);

  // Totais
  const totalEntradasEsperado = entradas.reduce((s, e) => s + e.valor_esperado, 0);
  const totalEntradasBruto    = entradas.reduce((s, e) => s + e.valor_liquido, 0);
  const totalSaidas           = saidas.reduce((s, x) => s + x.valor, 0);
  const saldoFinalProjetado   = saldo.saldo + totalEntradasEsperado - totalSaidas;

  // Remove itens grandes do payload se não pedido
  const bucketsOut = buckets.map(b => {
    if (!incluirItens) {
      const { itens_entrada, itens_saida, ...resto } = b;
      return resto;
    }
    return b;
  });

  return {
    empresa:               company?.nome || '(?)',
    gerado_em:             new Date().toISOString(),
    horizonte_dias:        dias,
    periodicidade,
    saldo_inicial:         +saldo.saldo.toFixed(2),
    saldo_inicial_data:    saldo.ultima_data,
    total_entradas_bruto:  +totalEntradasBruto.toFixed(2),
    total_entradas_esperado: +totalEntradasEsperado.toFixed(2),
    total_saidas:          +totalSaidas.toFixed(2),
    fluxo_liquido_horizonte: +(totalEntradasEsperado - totalSaidas).toFixed(2),
    saldo_final_projetado: +saldoFinalProjetado.toFixed(2),
    qtd_entradas:          entradas.length,
    qtd_saidas:            saidas.length,
    buckets:               bucketsOut,
    alerta:                saldoFinalProjetado < 0 ? 'SALDO NEGATIVO PROJETADO' : null,
  };
}

module.exports = {
  projecaoFluxoCaixa,
  calcularSaldoInicial,
  projectarEntradas,
  projectarSaidas,
  calcularSLAs,
};
