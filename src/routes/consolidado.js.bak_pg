/**
 * Montana — Visão Consolidada Multi-Empresa
 *
 * Endpoints:
 *   GET /api/consolidado          → visão de cartões (todas as 4 empresas, ano corrente)
 *   GET /api/consolidado/resumo   → tabela financeira detalhada (com from/to)
 *
 * IMPORTANTE: este router é montado com `app.use('/api', consolidadoRouter)`
 *   ANTES do apiRouter geral (que exige X-Company). Aqui NÃO exigimos X-Company —
 *   cada request percorre todas as empresas internamente.
 */
'use strict';
const express = require('express');
const { getDb, COMPANIES } = require('../db');
const router = express.Router();

function num(v) { return Math.round((v || 0) * 100) / 100; }

// Lê colunas de uma tabela (suporta schemas que podem variar entre local/prod)
function cols(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); }
  catch { return []; }
}
function hasTable(db, name) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

// ─── GET /api/consolidado ─────────────────────────────────────────
// Visão original — cartões das 4 empresas para o ANO corrente.
// Mantido aqui (antes estava em server.js inline) para centralizar.
router.get('/consolidado', (req, res) => {
  try {
    const resultado = {};
    const ano = parseInt(req.query.ano, 10) || new Date().getFullYear();
    // Suporta ?from=&to= (filtro global) com fallback pro ano inteiro
    const from = req.query.from || `${ano}-01-01`;
    const to   = req.query.to   || `${ano}-12-31`;

    for (const [key, company] of Object.entries(COMPANIES)) {
      try {
        const db = getDb(key);
        const extratos = db.prepare(`
          SELECT COUNT(*) cnt,
                 COALESCE(SUM(credito),0) entradas,
                 COALESCE(SUM(debito),0) saidas
            FROM extratos WHERE data_iso >= ? AND data_iso <= ?
        `).get(from, to);
        const nfs = db.prepare(`
          SELECT COUNT(*) cnt, COALESCE(SUM(valor_bruto),0) bruto
            FROM notas_fiscais
           WHERE (data_emissao >= ? AND data_emissao <= ?)
              OR (data_emissao = '' AND created_at >= ? AND created_at <= ?)
        `).get(from, to, from, to);
        const desp = db.prepare(`
          SELECT COALESCE(SUM(valor_bruto),0) total
            FROM despesas WHERE data_iso >= ? AND data_iso <= ?
        `).get(from, to);
        const pend = db.prepare(`SELECT COUNT(*) cnt FROM extratos WHERE status_conciliacao='PENDENTE'`).get();
        const funcs = db.prepare(`SELECT COUNT(*) cnt FROM rh_funcionarios WHERE status='ATIVO'`).get();

        resultado[key] = {
          nome: company.nome, nomeAbrev: company.nomeAbrev, cnpj: company.cnpj,
          cor: company.cor, icone: company.icone,
          extratos_total: extratos.cnt,
          entradas: num(extratos.entradas),
          saidas:   num(extratos.saidas),
          nfs_total: nfs.cnt,
          faturamento: num(nfs.bruto),
          despesas: num(desp.total),
          pendentes: pend.cnt,
          funcionarios: funcs.cnt,
        };
      } catch (e) {
        resultado[key] = { nome: company.nome, erro: e.message };
      }
    }
    res.json({ ok: true, ano, empresas: resultado });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/consolidado/resumo ───────────────────────────────────
// Tabela detalhada com receita bruta/líquida, retenções, despesas,
// resultado e margem — das 4 empresas + total do grupo.
// Aceita ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: ano corrente)
router.get('/consolidado/resumo', (req, res) => {
  try {
    const hoje = new Date();
    const anoC = hoje.getFullYear();
    const from = req.query.from || `${anoC}-01-01`;
    const to   = req.query.to   || `${anoC}-12-31`;

    const empresas = [];
    const totais = {
      receita_bruta: 0, receita_liquida: 0, retencoes: 0,
      despesas: 0, resultado: 0,
      qtd_nfs: 0, contratos_ativos: 0,
    };

    for (const [key, company] of Object.entries(COMPANIES)) {
      try {
        const db = getDb(key);
        const nfCols = new Set(cols(db, 'notas_fiscais'));

        // Monta lista de campos de retenção que realmente existem no schema
        const possRet = ['inss','ir','iss','csll','pis','cofins','retencao','outros_descontos'];
        const camposRet = possRet.filter(c => nfCols.has(c))
          .map(c => `COALESCE(${c},0)`).join('+') || '0';

        // Filtro de soft-delete só se a coluna existir
        const deletedFilter = nfCols.has('deleted_at') ? `AND COALESCE(deleted_at,'') = ''` : '';

        // Receita — notas_fiscais no período (por data_emissao; fallback created_at)
        const nfs = db.prepare(`
          SELECT COUNT(*) qtd,
                 COALESCE(SUM(valor_bruto),   0) bruto,
                 COALESCE(SUM(valor_liquido), 0) liquido,
                 COALESCE(SUM(${camposRet}), 0) retencoes_soma
            FROM notas_fiscais
           WHERE 1=1 ${deletedFilter}
             AND ((data_emissao >= ? AND data_emissao <= ?)
               OR (COALESCE(data_emissao,'') = '' AND created_at >= ? AND created_at <= ?))
        `).get(from, to, from, to);

        // valor_liquido às vezes não é preenchido → derivar de bruto - retenções
        const receita_bruta    = num(nfs.bruto);
        const receita_liquida_calc = receita_bruta - num(nfs.retencoes_soma);
        const receita_liquida  = num(nfs.liquido) > 0 ? num(nfs.liquido) : num(receita_liquida_calc);
        const retencoes        = num(receita_bruta - receita_liquida);

        // Despesas reais no período — exclui aplicações financeiras e intragrupo
        let despesas = 0;
        if (hasTable(db, 'despesas')) {
          const dCols = new Set(cols(db, 'despesas'));
          const campoDesc = dCols.has('descricao') ? 'descricao'
                          : dCols.has('historico')  ? 'historico'
                          : null;
          const filtro = campoDesc ? `
             AND NOT (
               UPPER(COALESCE(${campoDesc},'')) LIKE '%BB RENDE%'
            OR UPPER(COALESCE(${campoDesc},'')) LIKE '%RENDE FACIL%'
            OR UPPER(COALESCE(${campoDesc},'')) LIKE '%CDB%'
            OR UPPER(COALESCE(${campoDesc},'')) LIKE '%APLICAC%'
            OR UPPER(COALESCE(${campoDesc},'')) LIKE '%MESMA TITULARIDADE%'
            OR UPPER(COALESCE(${campoDesc},'')) LIKE '%CH.AVULSO ENTRE AG%'
            OR UPPER(COALESCE(${campoDesc},'')) LIKE '%TED MESMA TITUL%'
             )` : '';
          const desp = db.prepare(`
            SELECT COALESCE(SUM(valor_bruto),0) total
              FROM despesas
             WHERE data_iso >= ? AND data_iso <= ?
               ${filtro}
          `).get(from, to);
          despesas = num(desp.total);
        }

        // Contratos ativos — vigência_fim futura OU nula/vazia
        const ca = hasTable(db,'contratos') ? db.prepare(`
          SELECT COUNT(*) cnt FROM contratos
           WHERE COALESCE(vigencia_fim,'') = ''
              OR vigencia_fim >= DATE('now')
        `).get() : { cnt: 0 };

        const resultado = num(receita_liquida - despesas);
        const margem_pct = receita_liquida > 0
          ? Math.round((resultado / receita_liquida) * 1000) / 10
          : 0;

        empresas.push({
          empresa: key,
          nome: company.nomeAbrev || company.nome,
          cnpj: company.cnpj,
          receita_bruta,
          retencoes,
          receita_liquida,
          despesas,
          resultado,
          margem_pct,
          qtd_nfs: nfs.qtd,
          contratos_ativos: ca.cnt,
        });

        totais.receita_bruta    += receita_bruta;
        totais.retencoes        += retencoes;
        totais.receita_liquida  += receita_liquida;
        totais.despesas         += despesas;
        totais.resultado        += resultado;
        totais.qtd_nfs          += nfs.qtd;
        totais.contratos_ativos += ca.cnt;
      } catch (e) {
        empresas.push({ empresa: key, nome: company.nomeAbrev || company.nome, erro: e.message });
      }
    }

    // Arredonda totais
    for (const k of ['receita_bruta','retencoes','receita_liquida','despesas','resultado']) {
      totais[k] = num(totais[k]);
    }

    res.json({
      ok: true,
      periodo: { from, to },
      empresas,
      totais,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
