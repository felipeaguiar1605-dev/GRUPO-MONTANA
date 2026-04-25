'use strict';
/**
 * Montana — Auditoria IA: coletores de dados pre-agregados.
 *
 * Cada coletor retorna um objeto compacto (JSON-serializable) com os
 * numeros / anomalias que os agentes precisam analisar. O objetivo e
 * enviar o MINIMO de tokens ao modelo — deixamos o SQL fazer o trabalho
 * pesado e a IA so julga o que o banco destacou como suspeito.
 */
const { getDb, COMPANIES } = require('../../../src/db');

const EMPRESAS_DEFAULT = Object.keys(COMPANIES).filter(k =>
  COMPANIES[k] && COMPANIES[k].dbPath
);

function hasTable(db, name) {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

// ────────────────────────────────────────────────────────────────────
// Coleta CONTABIL / FISCAL
// ────────────────────────────────────────────────────────────────────
function coletarContabilFiscal(empresa, { diasJanela = 7 } = {}) {
  const db = getDb(empresa);
  const out = { empresa, janela_dias: diasJanela, achados: {} };

  if (hasTable(db, 'notas_fiscais')) {
    // NFs com retenção aparentemente incorreta (IRRF fora de 1,20%/4,80%)
    out.achados.nfs_ir_suspeito = db.prepare(`
      SELECT numero, tomador, competencia, valor_bruto, ir, iss, pis, cofins, csll,
             ROUND(100.0 * ir / NULLIF(valor_bruto,0), 3) AS pct_ir
      FROM notas_fiscais
      WHERE valor_bruto > 0
        AND ir > 0
        AND ABS(100.0*ir/valor_bruto - 1.20) > 0.30
        AND ABS(100.0*ir/valor_bruto - 4.80) > 0.30
      ORDER BY data_emissao DESC
      LIMIT 30
    `).all();

    // NFs sem retenção federal quando deveria ter (tomador publico + bruto > 5000)
    out.achados.nfs_sem_retencao_federal = db.prepare(`
      SELECT numero, tomador, competencia, valor_bruto, ir, pis, cofins, csll
      FROM notas_fiscais
      WHERE valor_bruto > 5000
        AND (ir + pis + cofins + csll) = 0
        AND (UPPER(tomador) LIKE '%MUNICIPIO%'
          OR UPPER(tomador) LIKE '%ESTADO%'
          OR UPPER(tomador) LIKE '%UNIAO%'
          OR UPPER(tomador) LIKE '%UF%'
          OR UPPER(tomador) LIKE '%PREFEITURA%')
      ORDER BY data_emissao DESC
      LIMIT 30
    `).all();

    // Soma fiscal do mes corrente
    out.achados.totais_mes = db.prepare(`
      SELECT COUNT(*) qtd,
             ROUND(SUM(valor_bruto),2)  bruto,
             ROUND(SUM(valor_liquido),2) liquido,
             ROUND(SUM(ir),2) ir, ROUND(SUM(iss),2) iss,
             ROUND(SUM(pis),2) pis, ROUND(SUM(cofins),2) cofins, ROUND(SUM(csll),2) csll
      FROM notas_fiscais
      WHERE substr(COALESCE(data_emissao,''),1,7) = strftime('%Y-%m','now')
    `).get();
  }

  // Retenções pagas vs. devidas (cruza pagamentos_portal com NFs)
  if (hasTable(db, 'pagamentos_portal') && hasTable(db, 'notas_fiscais')) {
    out.achados.divergencias_portal = db.prepare(`
      SELECT p.portal, p.fornecedor, p.empenho, p.data_pagamento_iso,
             p.valor_pago,
             n.numero AS nf_numero, n.valor_bruto AS nf_bruto, n.valor_liquido AS nf_liquido,
             ROUND(n.valor_bruto - p.valor_pago, 2) AS divergencia_bruta
      FROM pagamentos_portal p
      LEFT JOIN notas_fiscais n ON n.id = p.nf_id
      WHERE p.status_match IN ('DIVERGENCIA','SEM_NF')
        AND p.data_pagamento_iso >= date('now', '-${Number(diasJanela)} days')
      ORDER BY ABS(divergencia_bruta) DESC
      LIMIT 20
    `).all();
  }

  return out;
}

// ────────────────────────────────────────────────────────────────────
// Coleta CONCILIACAO / FLUXO DE CAIXA
// ────────────────────────────────────────────────────────────────────
function coletarConciliacao(empresa, { diasJanela = 7 } = {}) {
  const db = getDb(empresa);
  const out = { empresa, janela_dias: diasJanela, achados: {} };

  if (hasTable(db, 'extratos')) {
    out.achados.extratos_nao_conciliados = db.prepare(`
      SELECT COUNT(*) qtd,
             ROUND(SUM(COALESCE(credito,0) - COALESCE(debito,0)),2) saldo_liquido
      FROM extratos
      WHERE status_conciliacao = 'PENDENTE'
        AND data_iso >= date('now', '-${Number(diasJanela)} days')
    `).get();

    out.achados.extratos_sem_pagador = db.prepare(`
      SELECT id, data_iso, historico, credito, debito
      FROM extratos
      WHERE COALESCE(pagador_identificado,'') = ''
        AND credito > 1000
        AND data_iso >= date('now', '-${Number(diasJanela)} days')
      ORDER BY credito DESC
      LIMIT 20
    `).all();

    out.achados.extratos_duplicados_candidatos = db.prepare(`
      SELECT data_iso, historico, credito, debito, COUNT(*) repetido
      FROM extratos
      WHERE data_iso >= date('now', '-${Number(diasJanela * 4)} days')
      GROUP BY data_iso, historico, credito, debito
      HAVING COUNT(*) > 1
      ORDER BY repetido DESC
      LIMIT 15
    `).all();
  }

  if (hasTable(db, 'pagamentos_portal')) {
    out.achados.pagamentos_portal_sem_match = db.prepare(`
      SELECT portal, fornecedor, empenho, data_pagamento_iso, valor_pago
      FROM pagamentos_portal
      WHERE status_match = 'SEM_NF'
        AND data_pagamento_iso >= date('now', '-30 days')
      ORDER BY valor_pago DESC
      LIMIT 20
    `).all();
  }

  if (hasTable(db, 'parcelas')) {
    out.achados.parcelas_em_aberto_vencidas = db.prepare(`
      SELECT contrato_num, competencia, valor_liquido, data_pagamento, status
      FROM parcelas
      WHERE COALESCE(status,'') NOT IN ('PAGO','LIQUIDADO')
        AND valor_liquido > 0
      ORDER BY competencia DESC
      LIMIT 25
    `).all();
  }

  return out;
}

// ────────────────────────────────────────────────────────────────────
// Coleta LOGICA SISTEMICA (codigo, nao banco)
// ────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

function coletarLogicaSistemica() {
  const out = { achados: {} };
  const rotasDir = path.join(__dirname, '..', '..', '..', 'src', 'routes');
  if (!fs.existsSync(rotasDir)) return out;

  const arquivos = fs.readdirSync(rotasDir).filter(f => f.endsWith('.js'));
  const semCompanyMw = [];
  const semAuditLog  = [];
  const queriesSemFiltroEmpresa = [];

  for (const nome of arquivos) {
    const caminho = path.join(rotasDir, nome);
    const src = fs.readFileSync(caminho, 'utf8');

    if (!/companyMiddleware|companyMw/.test(src)) {
      semCompanyMw.push(nome);
    }
    const temWrite = /\b(INSERT|UPDATE|DELETE)\b/i.test(src);
    if (temWrite && !/auditLog|audit_log/i.test(src)) {
      semAuditLog.push(nome);
    }
    // Heuristica: getDb() chamada sem receber company key
    const matches = src.match(/getDb\(\s*\)/g);
    if (matches) {
      queriesSemFiltroEmpresa.push({ arquivo: nome, ocorrencias: matches.length });
    }
  }

  out.achados = {
    total_rotas: arquivos.length,
    rotas_sem_company_middleware: semCompanyMw,
    rotas_write_sem_audit_log: semAuditLog,
    getdb_sem_empresa: queriesSemFiltroEmpresa,
  };
  return out;
}

module.exports = {
  EMPRESAS_DEFAULT,
  coletarContabilFiscal,
  coletarConciliacao,
  coletarLogicaSistemica,
};
