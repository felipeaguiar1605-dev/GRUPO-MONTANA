/**
 * Montana ERP — Caixa Livre Consolidado
 *
 * Conceito: caixa real disponível por empresa, separando obrigações operacionais
 * (folha + despesas) e impostos estimados das entradas brutas.
 *
 *   Caixa Operacional = Entradas (créditos) − Folha − Despesas
 *   Caixa Livre       = Caixa Operacional − Impostos estimados − Depreciação
 *
 * Endpoints:
 *   GET  /api/caixa-livre/mensal?empresa=X&meses=6
 *   GET  /api/caixa-livre/consolidado?meses=3
 *   GET  /api/caixa-livre/posicao-atual?empresa=X
 *   GET  /api/caixa-livre/parametros?empresa=X
 *   PUT  /api/caixa-livre/parametros
 */
'use strict';

const express = require('express');
const { getDb, COMPANIES } = require('../db_pg');

const router = express.Router();

// ── Parâmetros default (Lucro Presumido — alíquotas heurísticas) ───
const DEFAULT_PARAMS = {
  pis_cofins_pct: 3.00,
  csll_pct:       2.88,
  irpj_pct:       4.80,
  iss_pct:        5.00,
};

function num(v) { return Math.round((parseFloat(v || 0)) * 100) / 100; }
function pct(v) { return Math.round((parseFloat(v || 0)) * 10) / 10; }

// ── Cria tabela caixa_parametros se não existir ─────────────────
async function ensureParamsTable(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS caixa_parametros (
      empresa         TEXT PRIMARY KEY,
      pis_cofins_pct  NUMERIC(6,3) DEFAULT 3.00,
      csll_pct        NUMERIC(6,3) DEFAULT 2.88,
      irpj_pct        NUMERIC(6,3) DEFAULT 4.80,
      iss_pct         NUMERIC(6,3) DEFAULT 5.00,
      atualizado_em   TIMESTAMP DEFAULT NOW()
    )
  `).run();
}

async function carregarParams(db, empresa) {
  await ensureParamsTable(db);
  const row = await db.prepare(
    `SELECT pis_cofins_pct, csll_pct, irpj_pct, iss_pct
     FROM caixa_parametros WHERE empresa = @empresa`
  ).get({ empresa });
  if (!row) return { ...DEFAULT_PARAMS };
  return {
    pis_cofins_pct: parseFloat(row.pis_cofins_pct || DEFAULT_PARAMS.pis_cofins_pct),
    csll_pct:       parseFloat(row.csll_pct       || DEFAULT_PARAMS.csll_pct),
    irpj_pct:       parseFloat(row.irpj_pct       || DEFAULT_PARAMS.irpj_pct),
    iss_pct:        parseFloat(row.iss_pct        || DEFAULT_PARAMS.iss_pct),
  };
}

// ── Lista de meses YYYY-MM (mais antigo → mais recente) ────────────
function mesesSerie(qtd) {
  const out = [];
  const hoje = new Date();
  for (let i = qtd - 1; i >= 0; i--) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

function rangeDoMes(mes) {
  const [ano, m] = mes.split('-').map(Number);
  const ultimo = new Date(ano, m, 0).getDate();
  return {
    from: `${mes}-01`,
    to:   `${mes}-${String(ultimo).padStart(2, '0')}`,
  };
}

// ── Calcula caixa livre de UM mês para UMA empresa ─────────────────
async function calcularMes(db, mes, params) {
  const { from, to } = rangeDoMes(mes);
  const p = { from, to };

  // Entradas: créditos do extrato (regime caixa real)
  let entradas = 0;
  try {
    const r = await db.prepare(
      `SELECT COALESCE(SUM(credito), 0) AS total
         FROM extratos WHERE data_iso >= @from AND data_iso <= @to`
    ).get(p);
    entradas = parseFloat(r?.total || 0);
  } catch (_) { entradas = 0; }

  // Receita bruta para base dos impostos: NFs emitidas no mês
  let receitaBruta = 0, qtdNfs = 0;
  try {
    const r = await db.prepare(
      `SELECT COALESCE(SUM(valor_bruto), 0) AS bruto, COUNT(*) AS qtd
         FROM notas_fiscais
        WHERE (WHERE.status_conciliacao IS NULL OR WHERE.status_conciliacao != 'CANCELADA') AND data_emissao >= @from AND data_emissao <= @to`
    ).get(p);
    receitaBruta = parseFloat(r?.bruto || 0);
    qtdNfs = parseInt(r?.qtd || 0);
  } catch (_) { receitaBruta = 0; qtdNfs = 0; }

  // Folha: soma das folhas pagas naquela competência (rh_folha_itens.total_bruto)
  let saidasFolha = 0;
  try {
    const r = await db.prepare(
      `SELECT COALESCE(SUM(i.total_bruto), 0) AS total
         FROM rh_folha_itens i
         JOIN rh_folha f ON f.id = i.folha_id
        WHERE f.competencia = @comp`
    ).get({ comp: mes });
    saidasFolha = parseFloat(r?.total || 0);
  } catch (_) { saidasFolha = 0; }

  // Despesas operacionais: exclui aplicações e transferências intragrupo
  let saidasDespesas = 0;
  try {
    const r = await db.prepare(`
      SELECT COALESCE(SUM(valor_bruto), 0) AS total
        FROM despesas
       WHERE data_iso >= @from AND data_iso <= @to
         AND NOT (
           UPPER(COALESCE(descricao,'')) LIKE '%BB RENDE%'
        OR UPPER(COALESCE(descricao,'')) LIKE '%RENDE FACIL%'
        OR UPPER(COALESCE(descricao,'')) LIKE '%CDB%'
        OR UPPER(COALESCE(descricao,'')) LIKE '%APLICAC%'
        OR UPPER(COALESCE(descricao,'')) LIKE '%MESMA TITULARIDADE%'
         )
    `).get(p);
    saidasDespesas = parseFloat(r?.total || 0);
  } catch (_) { saidasDespesas = 0; }

  // Depreciação (módulo patrimônio — opcional)
  // Coluna depreciacao_mensal não existe na tabela; calculamos dinamicamente:
  // (valor_aquisicao - valor_residual) / vida_util_meses, apenas para status='ativo'.
  let depreciacao = 0;
  try {
    const r = await db.prepare(
      `SELECT COALESCE(SUM(
                (valor_aquisicao - COALESCE(valor_residual, 0))
                / NULLIF(vida_util_meses, 0)
              ), 0) AS total
         FROM patrimonio
        WHERE COALESCE(status, 'ativo') = 'ativo'`
    ).get();
    depreciacao = parseFloat(r?.total || 0);
  } catch (_) { depreciacao = 0; }

  // Impostos estimados sobre receita bruta
  const impPisCof = receitaBruta * (params.pis_cofins_pct / 100);
  const impCsll   = receitaBruta * (params.csll_pct / 100);
  const impIrpj   = receitaBruta * (params.irpj_pct / 100);
  const impIss    = receitaBruta * (params.iss_pct / 100);
  const impostos  = impPisCof + impCsll + impIrpj + impIss;
  const totalAliq = params.pis_cofins_pct + params.csll_pct + params.irpj_pct + params.iss_pct;

  const caixaOperacional = entradas - saidasFolha - saidasDespesas;
  const caixaLivre       = caixaOperacional - impostos - depreciacao;
  const margem           = entradas > 0 ? (caixaLivre / entradas) * 100 : 0;

  return {
    mes,
    entradas:           num(entradas),
    receita_bruta:      num(receitaBruta),
    qtd_nfs:            qtdNfs,
    saidas_folha:       num(saidasFolha),
    saidas_despesas:    num(saidasDespesas),
    impostos_estimados: num(impostos),
    impostos_detalhe: {
      pis_cofins: num(impPisCof),
      csll:       num(impCsll),
      irpj:       num(impIrpj),
      iss:        num(impIss),
    },
    aliquota_total_pct: pct(totalAliq),
    depreciacao:        num(depreciacao),
    caixa_operacional:  num(caixaOperacional),
    caixa_livre:        num(caixaLivre),
    margem_pct:         pct(margem),
  };
}

// ── Soma totais de uma série de meses ───────────────────────────────
function totalizarSerie(meses) {
  const t = {
    entradas: 0, receita_bruta: 0, qtd_nfs: 0,
    saidas_folha: 0, saidas_despesas: 0,
    impostos_estimados: 0, depreciacao: 0,
    caixa_operacional: 0, caixa_livre: 0,
  };
  for (const m of meses) {
    t.entradas           += m.entradas;
    t.receita_bruta      += m.receita_bruta;
    t.qtd_nfs            += m.qtd_nfs;
    t.saidas_folha       += m.saidas_folha;
    t.saidas_despesas    += m.saidas_despesas;
    t.impostos_estimados += m.impostos_estimados;
    t.depreciacao        += m.depreciacao;
    t.caixa_operacional  += m.caixa_operacional;
    t.caixa_livre        += m.caixa_livre;
  }
  for (const k of Object.keys(t)) {
    if (k !== 'qtd_nfs') t[k] = num(t[k]);
  }
  t.margem_pct = t.entradas > 0 ? pct((t.caixa_livre / t.entradas) * 100) : 0;
  return t;
}

// ─── GET /api/caixa-livre/mensal ─────────────────────────────────
// ?empresa=assessoria&meses=6
router.get('/mensal', async (req, res) => {
  try {
    const empresa = (req.query.empresa || 'assessoria').toLowerCase();
    if (!COMPANIES[empresa]) return res.status(400).json({ erro: 'Empresa inválida: ' + empresa });

    const qtd = Math.max(1, Math.min(parseInt(req.query.meses || '6', 10) || 6, 24));
    const db = getDb(empresa);
    const params = await carregarParams(db, empresa);

    const lista = mesesSerie(qtd);
    const meses = [];
    for (const m of lista) meses.push(await calcularMes(db, m, params));
    const totais = totalizarSerie(meses);

    res.json({
      ok: true,
      empresa,
      empresa_nome: COMPANIES[empresa].nomeAbrev || COMPANIES[empresa].nome,
      meses_solicitados: qtd,
      parametros: params,
      meses,
      totais,
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── GET /api/caixa-livre/consolidado ───────────────────────────
// ?meses=3 → todas as empresas + grupo
router.get('/consolidado', async (req, res) => {
  try {
    const qtd = Math.max(1, Math.min(parseInt(req.query.meses || '3', 10) || 3, 24));
    const lista = mesesSerie(qtd);

    const empresas = [];
    const grupoMesesMap = {};
    for (const m of lista) {
      grupoMesesMap[m] = {
        mes: m, entradas: 0, receita_bruta: 0, qtd_nfs: 0,
        saidas_folha: 0, saidas_despesas: 0,
        impostos_estimados: 0, depreciacao: 0,
        caixa_operacional: 0, caixa_livre: 0,
      };
    }

    for (const [key, company] of Object.entries(COMPANIES)) {
      try {
        const db = getDb(key);
        const params = await carregarParams(db, key);
        const meses = [];
        for (const m of lista) meses.push(await calcularMes(db, m, params));
        const totais = totalizarSerie(meses);

        // Ignora empresas sem entradas em todo o período
        if (totais.entradas <= 0) continue;

        // Melhor / pior mês (por caixa_livre)
        const ordenado = [...meses].sort((a, b) => b.caixa_livre - a.caixa_livre);
        const melhor = ordenado[0];
        const pior   = ordenado[ordenado.length - 1];

        empresas.push({
          empresa: key,
          nome: company.nomeAbrev || company.nome,
          cor: company.cor,
          icone: company.icone,
          parametros: params,
          meses,
          totais,
          melhor_mes: melhor ? { mes: melhor.mes, caixa_livre: melhor.caixa_livre, margem_pct: melhor.margem_pct } : null,
          pior_mes:   pior   ? { mes: pior.mes,   caixa_livre: pior.caixa_livre,   margem_pct: pior.margem_pct }   : null,
        });

        // Acumula para o grupo
        for (const m of meses) {
          const g = grupoMesesMap[m.mes];
          g.entradas           += m.entradas;
          g.receita_bruta      += m.receita_bruta;
          g.qtd_nfs            += m.qtd_nfs;
          g.saidas_folha       += m.saidas_folha;
          g.saidas_despesas    += m.saidas_despesas;
          g.impostos_estimados += m.impostos_estimados;
          g.depreciacao        += m.depreciacao;
          g.caixa_operacional  += m.caixa_operacional;
          g.caixa_livre        += m.caixa_livre;
        }
      } catch (e) {
        // Empresa sem dados ou tabela ausente → ignora silenciosamente
        continue;
      }
    }

    // Finaliza meses do grupo (arredonda + margem)
    const grupoMeses = lista.map(m => {
      const g = grupoMesesMap[m];
      for (const k of Object.keys(g)) {
        if (k !== 'mes' && k !== 'qtd_nfs') g[k] = num(g[k]);
      }
      g.margem_pct = g.entradas > 0 ? pct((g.caixa_livre / g.entradas) * 100) : 0;
      return g;
    });
    const grupoTotais = totalizarSerie(grupoMeses);

    res.json({
      ok: true,
      meses_solicitados: qtd,
      empresas,
      grupo: { meses: grupoMeses, totais: grupoTotais },
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── GET /api/caixa-livre/posicao-atual ─────────────────────────
// ?empresa=assessoria — snapshot hoje + projeção 30 dias
router.get('/posicao-atual', async (req, res) => {
  try {
    const empresa = (req.query.empresa || 'assessoria').toLowerCase();
    if (!COMPANIES[empresa]) return res.status(400).json({ erro: 'Empresa inválida: ' + empresa });

    const db = getDb(empresa);
    const params = await carregarParams(db, empresa);

    // 1. Saldo atual: soma líquida do extrato (último mês com movimentação)
    let saldoAtual = 0, ultimaData = null;
    try {
      const r = await db.prepare(`
        SELECT COALESCE(SUM(credito), 0) - COALESCE(SUM(debito), 0) AS saldo,
               MAX(data_iso) AS ultima
          FROM extratos
         WHERE data_iso <= to_char(CURRENT_DATE, 'YYYY-MM-DD')
      `).get();
      saldoAtual = parseFloat(r?.saldo || 0);
      ultimaData = r?.ultima || null;
    } catch (_) {}

    // 2. Entradas projetadas próximos 30 dias: contratos ativos × valor_mensal_liquido
    let projEntradas = 0;
    let projContratos = 0;
    try {
      const r = await db.prepare(`
        SELECT COUNT(*) AS qtd,
               COALESCE(SUM(COALESCE(valor_mensal_liquido, valor_mensal_bruto, 0)), 0) AS total
          FROM contratos
         WHERE COALESCE(vigencia_fim,'') = ''
            OR vigencia_fim >= to_char(CURRENT_DATE, 'YYYY-MM-DD')
      `).get();
      projContratos = parseInt(r?.qtd || 0);
      projEntradas  = parseFloat(r?.total || 0);
    } catch (_) {}

    // 3. Compromissos próximos 30 dias: média folha + despesas dos últimos 3 meses
    const ultimos3 = mesesSerie(3);
    let folha3 = 0, desp3 = 0, recBruta3 = 0;
    for (const m of ultimos3) {
      const calc = await calcularMes(db, m, params);
      folha3    += calc.saidas_folha;
      desp3     += calc.saidas_despesas;
      recBruta3 += calc.receita_bruta;
    }
    const mediaFolha    = folha3 / 3;
    const mediaDespesas = desp3 / 3;
    const mediaImpostos = (recBruta3 / 3) *
      ((params.pis_cofins_pct + params.csll_pct + params.irpj_pct + params.iss_pct) / 100);
    const projSaidas    = mediaFolha + mediaDespesas + mediaImpostos;
    const caixaLivreProj = saldoAtual + projEntradas - projSaidas;

    // 4. Dias de caixa: saldo / (compromissos diários)
    const compromissoDiario = projSaidas / 30;
    const diasDeCaixa = compromissoDiario > 0
      ? Math.floor((saldoAtual + projEntradas) / compromissoDiario)
      : 999;

    // 5. Semáforo
    let semaforo, semaforoTexto;
    if (diasDeCaixa > 30)       { semaforo = 'verde';    semaforoTexto = 'Caixa saudável (>30 dias)'; }
    else if (diasDeCaixa >= 15) { semaforo = 'amarelo';  semaforoTexto = 'Atenção: caixa apertado (15–30 dias)'; }
    else                        { semaforo = 'vermelho'; semaforoTexto = 'Crítico: menos de 15 dias de caixa'; }

    res.json({
      ok: true,
      empresa,
      empresa_nome: COMPANIES[empresa].nomeAbrev || COMPANIES[empresa].nome,
      hoje: new Date().toISOString().slice(0, 10),
      saldo_atual:           num(saldoAtual),
      saldo_ultima_data:     ultimaData,
      projecao_entradas:     num(projEntradas),
      projecao_contratos:    projContratos,
      projecao_saidas:       num(projSaidas),
      projecao_detalhe: {
        media_folha:    num(mediaFolha),
        media_despesas: num(mediaDespesas),
        media_impostos: num(mediaImpostos),
      },
      caixa_livre_projetado: num(caixaLivreProj),
      dias_de_caixa:         diasDeCaixa,
      semaforo,
      semaforo_texto: semaforoTexto,
      parametros: params,
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── GET /api/caixa-livre/parametros?empresa=X ───────────────────
router.get('/parametros', async (req, res) => {
  try {
    const empresa = (req.query.empresa || 'assessoria').toLowerCase();
    if (!COMPANIES[empresa]) return res.status(400).json({ erro: 'Empresa inválida: ' + empresa });
    const db = getDb(empresa);
    const params = await carregarParams(db, empresa);
    res.json({ ok: true, empresa, parametros: params, defaults: DEFAULT_PARAMS });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── PUT /api/caixa-livre/parametros ─────────────────────────────
// body: { empresa, pis_cofins_pct, csll_pct, irpj_pct, iss_pct }
router.put('/parametros', async (req, res) => {
  try {
    const empresa = (req.body.empresa || '').toLowerCase();
    if (!COMPANIES[empresa]) return res.status(400).json({ erro: 'Empresa inválida: ' + empresa });

    const valida = (v, def) => {
      const n = parseFloat(v);
      if (!isFinite(n) || n < 0 || n > 100) return def;
      return Math.round(n * 1000) / 1000;
    };
    const novo = {
      pis_cofins_pct: valida(req.body.pis_cofins_pct, DEFAULT_PARAMS.pis_cofins_pct),
      csll_pct:       valida(req.body.csll_pct,       DEFAULT_PARAMS.csll_pct),
      irpj_pct:       valida(req.body.irpj_pct,       DEFAULT_PARAMS.irpj_pct),
      iss_pct:        valida(req.body.iss_pct,        DEFAULT_PARAMS.iss_pct),
    };

    const db = getDb(empresa);
    await ensureParamsTable(db);

    // Upsert manual (PG): tenta UPDATE; se 0 linhas, INSERT
    const upd = await db.prepare(`
      UPDATE caixa_parametros
         SET pis_cofins_pct = @pis_cofins_pct,
             csll_pct       = @csll_pct,
             irpj_pct       = @irpj_pct,
             iss_pct        = @iss_pct,
             atualizado_em  = NOW()
       WHERE empresa = @empresa
    `).run({ empresa, ...novo });

    if (!upd.changes) {
      await db.prepare(`
        INSERT INTO caixa_parametros (empresa, pis_cofins_pct, csll_pct, irpj_pct, iss_pct)
        VALUES (@empresa, @pis_cofins_pct, @csll_pct, @irpj_pct, @iss_pct)
      `).run({ empresa, ...novo });
    }

    res.json({ ok: true, empresa, parametros: novo });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

module.exports = router;
