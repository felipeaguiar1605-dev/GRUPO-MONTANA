/**
 * Montana Multi-Empresa — API REST Unificada
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb, COMPANIES } = require('./db');

const router = express.Router();

// ─── CACHE SIMPLES DO DASHBOARD ──────────────────────────────────
const _dashCache = new Map();
const DASH_TTL = 60000; // 60 segundos

function dashCacheGet(key) {
  const e = _dashCache.get(key);
  if (e && Date.now() - e.ts < DASH_TTL) return e.data;
  return null;
}
function dashCacheSet(key, data) {
  _dashCache.set(key, { ts: Date.now(), data });
}
function dashCacheInvalidate(company) {
  for (const k of _dashCache.keys()) {
    if (k.startsWith(company + ':')) _dashCache.delete(k);
  }
}

// ─── AUDITORIA ───────────────────────────────────────────────────
function audit(req, acao, tabela, registroId = '', detalhe = '') {
  try {
    const usuario = req.user?.login || 'anon';
    const ip = req.ip || req.connection?.remoteAddress || '';
    req.db.prepare(
      `INSERT INTO audit_log (usuario, acao, tabela, registro_id, detalhe, ip) VALUES (?,?,?,?,?,?)`
    ).run(usuario, acao, tabela, String(registroId), detalhe, ip);
  } catch (_) { /* auditoria nunca deve quebrar a operação */ }
}

// Helper: valida extensão do arquivo enviado
function validarExtensao(nomeArquivo, extensoesPermitidas) {
  const ext = (nomeArquivo || '').split('.').pop().toLowerCase();
  return extensoesPermitidas.includes(ext) ? null : `Tipo de arquivo inválido (.${ext}). Envie: ${extensoesPermitidas.join(', ')}`;
}

// Helper: loga o erro internamente + arquivo, retorna mensagem genérica ao cliente
const LOG_DIR  = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'erros.log');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function errRes(res, e, contexto = '') {
  const ts      = new Date().toISOString();
  const method  = res.req?.method || '';
  const url     = res.req?.originalUrl || '';
  const company = res.req?.headers?.['x-company'] || '';
  const linha   = `[${ts}] ${method} ${url} (${company}) ${contexto ? '(' + contexto + ') ' : ''}${e.message}\n`;
  console.error('[Montana API]', linha.trim());
  try { fs.appendFileSync(LOG_FILE, linha); } catch (_) {}
  res.status(500).json({ error: 'Erro interno do servidor' });
}

// ─── MIDDLEWARE DE EMPRESA ────────────────────────────────────────
// Resolve qual banco usar baseado no header X-Company ou query ?company=
// Deve ser o PRIMEIRO middleware do router
router.use((req, res, next) => {
  const companyKey = (req.headers['x-company'] || req.query.company || 'seguranca').toLowerCase();
  if (!COMPANIES[companyKey]) {
    return res.status(400).json({ error: 'Empresa inválida: ' + companyKey + '. Use: assessoria | seguranca' });
  }
  req.companyKey = companyKey;
  req.company = COMPANIES[companyKey];
  req.db = getDb(companyKey);
  next();
});

// ─── FILTRO INTELIGENTE DE UPLOAD ────────────────────────────────
// Detecta automaticamente se o arquivo pertence à empresa errada
// ou sugere a empresa correta se detectar a própria empresa

/**
 * @returns {{ bloqueio: string|null, empresaDetectada: string|null }}
 */
function analisarArquivo(conteudo, nomeArquivo, company) {
  const amostra = (nomeArquivo || '') + '\n' + (conteudo || '').substring(0, 8000);
  
  // Verifica se contém padrão da empresa ERRADA
  for (const padrao of company.padroesBloqueados) {
    if (padrao.test(amostra)) {
      // Identifica qual empresa o arquivo pertence
      const outraEmpresa = Object.values(COMPANIES).find(c => c.key !== company.key && 
        c.padroesPropriosNome.some(p => p.test(amostra)));
      const nomeOutra = outraEmpresa ? outraEmpresa.nomeAbrev : 'outra empresa';
      return {
        bloqueio: `⛔ BLOQUEADO — Arquivo pertence à ${nomeOutra}, não à ${company.nomeAbrev} (${company.cnpj}). Use o app correto.`,
        empresaDetectada: outraEmpresa ? outraEmpresa.key : null
      };
    }
  }
  return { bloqueio: null, empresaDetectada: null };
}

// Endpoint de identidade dinâmica
router.get('/identity', (req, res) => {
  res.json({
    empresa: req.company.nome,
    cnpj: req.company.cnpj,
    app: req.companyKey,
    porta: 3002,
    cor: req.company.cor,
    corFundo: req.company.corFundo,
    icone: req.company.icone,
    empresas: Object.values(COMPANIES).map(c => ({ key: c.key, nome: c.nomeAbrev, cnpj: c.cnpj, cor: c.cor, icone: c.icone }))
  });
});

// File upload config
// Upload path dinâmico por empresa (resolvido no middleware)
function getUpload(req) {
  const dest = path.join(__dirname, '..', req.company.uploadsPath);
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  return multer({ dest, limits: { fileSize: 20 * 1024 * 1024 } });
}

// ─── Helpers ─────────────────────────────────────────────────────
function parseDecimalBR(val) {
  if (!val || val === 'null' || val === '') return null;
  return parseFloat(String(val).replace(/\./g, '').replace(',', '.')) || null;
}

const MONTH_MAP = {jan:'01',fev:'02',mar:'03',abr:'04',mai:'05',jun:'06',jul:'07',ago:'08',set:'09',out:'10',nov:'11',dez:'12'};

function parseDateBR(d) {
  if (!d) return '';
  const parts = d.split('/');
  // Formato dd/mm/yyyy
  if (parts.length === 3) return `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
  // Formato mes/yyyy (ex: jan/2026) — converte para primeiro dia do mês
  if (parts.length === 2) {
    const monthStr = parts[0].toLowerCase().substring(0, 3);
    const mm = MONTH_MAP[monthStr];
    if (mm) return `${parts[1]}-${mm}-01`;
  }
  return d;
}

// ─── MOTOR DE REGRAS TRIBUTÁRIAS ─────────────────────────────────
// Legislação brasileira para retenções em serviços de cessão de mão de obra
// (vigilância, segurança, limpeza, assessoria)

const REGRAS_TRIBUTARIAS = {
  // Esfera federal (UFT, universidades federais, autarquias federais)
  // Retenções individualizadas: IR + CSLL + PIS + COFINS separados
  federal: {
    label: 'Federal',
    inss: 11.00,    // IN RFB 2110/2022, art. 121 — cessão de mão de obra
    irrf: 4.80,     // Prática UFT/TO: 4,80% como "IR" (taxa aplicada nos contratos federais)
    csll: 1.00,     // IN SRF 459/2004, art. 1° — retido separadamente em entidades federais
    pis:  0.65,     // IN SRF 459/2004, art. 1° — cumulativo
    cofins: 3.00,   // IN SRF 459/2004, art. 1° — cumulativo
    iss: null,      // Varia por município (2-5%)
    nota: 'Entidades federais (UFT) retêm IR 4,80% + CSLL 1% + PIS 0,65% + COFINS 3% separados = 9,45% tributos federais + INSS 11% + ISS municipal.'
  },
  // Esfera estadual (DETRAN, CBMTO, PGJ, TCE, SEDUC, UNITINS, SECCIDADES)
  // Serviços com emprego de material: IR 1,20% sobre valor bruto
  // INSS 11% incide apenas sobre a parcela de mão de obra
  estadual: {
    label: 'Estadual',
    inss: 11.00,    // IN RFB 2110/2022 — cessão de mão de obra (base = mão de obra)
    irrf: 1.20,     // Serviços com emprego de material — base = valor bruto total
    csll: 0,
    pis:  0,
    cofins: 0,
    iss: null,      // ISS: retido apenas quando tomador é município (UNITINS só Palmas)
    nota: 'Estaduais TO: INSS 11% (base mão de obra) + IR 1,20% (serviços c/ material, base total) + ISS quando municipal.'
  },
  // Esfera municipal (prefeituras, fundações, autarquias municipais)
  // Serviços com emprego de material: IR 1,20% sobre valor bruto total
  // INSS 11% incide apenas sobre a parcela de mão de obra (não sobre o total da nota)
  municipal: {
    label: 'Municipal',
    inss: 11.00,
    irrf: 1.20,     // Serviços com emprego de material (LC Palmas) — base = valor bruto total
    csll: 0,
    pis:  0,
    cofins: 0,
    iss: null,      // Retido na fonte pelo tomador
    nota: 'Prefeituras aplicam: INSS 11% (base mão de obra) + IR 1,20% (serviços c/ material, base total) + ISS local (Palmas 5%).'
  }
};

// ISS por município (Código Tributário Municipal)
const ISS_MUNICIPIOS = {
  'PALMAS':                5.00,  // LC 285/2013 — vigilância/segurança
  'GURUPI':                5.00,
  'ARAGUAINA':             5.00,
  'PARAISO DO TOCANTINS':  5.00,
  'PARAÍSO DO TOCANTINS':  5.00,
  'PORTO NACIONAL':        5.00,
  'ARRAIAS':               3.00,
  'DIANOPOLIS':            3.00,
  'DIANÓPOLIS':            3.00,
  'MIRACEMA DO TOCANTINS': 3.00,
  'FORMOSO DO ARAGUAIA':   3.00,
  'TOCANTINOPOLIS':        3.00,
  'AUGUSTINOPOLIS':        3.00,
  '_DEFAULT':              5.00   // Padrão para municípios não mapeados
};

// Classificação de tomador → esfera
const TOMADOR_ESFERA = [
  { pattern: /universidade federal|UFT|UFNT|fund.*univ.*federal/i, esfera: 'federal' },
  { pattern: /tribunal de contas/i, esfera: 'estadual' },
  { pattern: /procuradoria.*justi[cç]a|minist[eé]rio p[uú]blico|PGJ/i, esfera: 'estadual' },
  { pattern: /DETRAN|departamento.*tr[aâ]nsito/i, esfera: 'estadual' },
  { pattern: /corpo de bombeiros|CBMTO/i, esfera: 'estadual' },
  { pattern: /SEDUC|secretaria.*educa[cç][aã]o/i, esfera: 'estadual' },
  { pattern: /UNITINS|universidade estadual/i, esfera: 'estadual' },
  { pattern: /SECCIDADES|secret.*cidades/i, esfera: 'estadual' },
  { pattern: /munic[ií]pio|prefeitura|SEMHARH|SESAU|FCP|fund.*cultural|ATCP|ag[eê]ncia.*transporte|PREVI.*PALMAS|instituto.*previd[eê]ncia/i, esfera: 'municipal' }
];

function classificarTomador(tomador) {
  if (!tomador) return 'estadual'; // default
  for (const rule of TOMADOR_ESFERA) {
    if (rule.pattern.test(tomador)) return rule.esfera;
  }
  return 'estadual';
}

function calcularRetencoesEsperadas(valorBruto, tomador, cidade, retencaoReal) {
  const esfera = classificarTomador(tomador);
  const regra = REGRAS_TRIBUTARIAS[esfera];
  const cidadeUpper = (cidade || '').toUpperCase().trim();
  const issDefault = ISS_MUNICIPIOS[cidadeUpper] || ISS_MUNICIPIOS['_DEFAULT'];

  const aplicaCsrf = valorBruto > 215.05;

  // Calcula com ISS padrão
  function calc(issAliq) {
    const ret = {
      esfera, esferaLabel: regra.label,
      inss: +(valorBruto * regra.inss / 100).toFixed(2),
      irrf: +(valorBruto * regra.irrf / 100).toFixed(2),
      csll: aplicaCsrf ? +(valorBruto * regra.csll / 100).toFixed(2) : 0,
      pis:  aplicaCsrf ? +(valorBruto * regra.pis / 100).toFixed(2) : 0,
      cofins: aplicaCsrf ? +(valorBruto * regra.cofins / 100).toFixed(2) : 0,
      iss: +(valorBruto * issAliq / 100).toFixed(2),
      issAliquota: issAliq,
      nota: regra.nota,
      aliquotas: { inss: regra.inss, irrf: regra.irrf, csll: aplicaCsrf ? regra.csll : 0, pis: aplicaCsrf ? regra.pis : 0, cofins: aplicaCsrf ? regra.cofins : 0, iss: issAliq }
    };
    ret.totalEsperado = +(ret.inss + ret.irrf + ret.csll + ret.pis + ret.cofins + ret.iss).toFixed(2);
    ret.valorLiquidoEsperado = +(valorBruto - ret.totalEsperado).toFixed(2);
    return ret;
  }

  // Se temos retenção real, testar ISS 0%, 3% e padrão — escolher o mais próximo
  if (retencaoReal && retencaoReal > 0) {
    const opcoes = [calc(issDefault)];
    if (issDefault !== 0) opcoes.push(calc(0));
    if (issDefault !== 3) opcoes.push(calc(3));

    let melhor = opcoes[0];
    let menorDiff = Math.abs(retencaoReal - opcoes[0].totalEsperado);
    for (const op of opcoes) {
      const d = Math.abs(retencaoReal - op.totalEsperado);
      if (d < menorDiff) { menorDiff = d; melhor = op; }
    }
    return melhor;
  }

  return calc(issDefault);
}

// Endpoint: análise de retenções por NF
router.get('/retencoes/analise', (req, res) => {
  const nfs = req.db.prepare(`
    SELECT id, numero, competencia, cidade, tomador, valor_bruto, valor_liquido,
           inss, ir, iss, csll, pis, cofins, retencao, contrato_ref
    FROM notas_fiscais
    ORDER BY id DESC
  `).all();

  const resultado = nfs.map(nf => {
    const retReal = nf.retencao || 0;
    const esperado = calcularRetencoesEsperadas(nf.valor_bruto, nf.tomador, nf.cidade, retReal);
    const diff = +(retReal - esperado.totalEsperado).toFixed(2);
    const pctDiff = esperado.totalEsperado > 0 ? +((diff / esperado.totalEsperado) * 100).toFixed(1) : 0;

    // Status: OK se diferença < 1%, ALERTA se 1-5%, DIVERGENTE se > 5%
    let status = 'OK';
    if (Math.abs(pctDiff) > 5) status = 'DIVERGENTE';
    else if (Math.abs(pctDiff) > 1) status = 'ALERTA';

    // Detalhamento por tributo
    const detalhe = {
      inss:   { real: nf.inss || 0, esperado: esperado.inss, diff: +((nf.inss || 0) - esperado.inss).toFixed(2) },
      irrf:   { real: nf.ir || 0, esperado: esperado.irrf, diff: +((nf.ir || 0) - esperado.irrf).toFixed(2) },
      iss:    { real: nf.iss || 0, esperado: esperado.iss, diff: +((nf.iss || 0) - esperado.iss).toFixed(2) },
      csll:   { real: nf.csll || 0, esperado: esperado.csll, diff: +((nf.csll || 0) - esperado.csll).toFixed(2) },
      pis:    { real: nf.pis || 0, esperado: esperado.pis, diff: +((nf.pis || 0) - esperado.pis).toFixed(2) },
      cofins: { real: nf.cofins || 0, esperado: esperado.cofins, diff: +((nf.cofins || 0) - esperado.cofins).toFixed(2) }
    };

    return {
      id: nf.id, numero: nf.numero, competencia: nf.competencia,
      cidade: nf.cidade, tomador: nf.tomador, contrato_ref: nf.contrato_ref,
      valor_bruto: nf.valor_bruto, valor_liquido: nf.valor_liquido,
      retencao_real: retReal,
      retencao_esperada: esperado.totalEsperado,
      liquido_esperado: esperado.valorLiquidoEsperado,
      diferenca: diff, pct_diferenca: pctDiff, status,
      esfera: esperado.esferaLabel,
      aliquotas: esperado.aliquotas,
      detalhe,
      nota: esperado.nota,
      tem_detalhamento: (nf.inss > 0 || nf.ir > 0)
    };
  });

  // Resumo geral
  const totalBruto = resultado.reduce((s, r) => s + r.valor_bruto, 0);
  const totalRetReal = resultado.reduce((s, r) => s + r.retencao_real, 0);
  const totalRetEsperada = resultado.reduce((s, r) => s + r.retencao_esperada, 0);
  const ok = resultado.filter(r => r.status === 'OK').length;
  const alertas = resultado.filter(r => r.status === 'ALERTA').length;
  const divergentes = resultado.filter(r => r.status === 'DIVERGENTE').length;
  const semDetalhe = resultado.filter(r => !r.tem_detalhamento).length;

  // Resumo por esfera
  const porEsfera = {};
  resultado.forEach(r => {
    if (!porEsfera[r.esfera]) porEsfera[r.esfera] = { nfs: 0, bruto: 0, retReal: 0, retEsperada: 0 };
    porEsfera[r.esfera].nfs++;
    porEsfera[r.esfera].bruto += r.valor_bruto;
    porEsfera[r.esfera].retReal += r.retencao_real;
    porEsfera[r.esfera].retEsperada += r.retencao_esperada;
  });

  // Resumo por tributo
  const porTributo = { inss: { real: 0, esperado: 0 }, irrf: { real: 0, esperado: 0 }, iss: { real: 0, esperado: 0 }, csll: { real: 0, esperado: 0 }, pis: { real: 0, esperado: 0 }, cofins: { real: 0, esperado: 0 } };
  resultado.forEach(r => {
    for (const t of ['inss','irrf','iss','csll','pis','cofins']) {
      porTributo[t].real += r.detalhe[t].real;
      porTributo[t].esperado += r.detalhe[t].esperado;
    }
  });

  res.json({
    resumo: {
      total_nfs: resultado.length,
      total_bruto: +totalBruto.toFixed(2),
      retencao_real: +totalRetReal.toFixed(2),
      retencao_esperada: +totalRetEsperada.toFixed(2),
      diferenca: +(totalRetReal - totalRetEsperada).toFixed(2),
      ok, alertas, divergentes, sem_detalhamento: semDetalhe
    },
    porEsfera,
    porTributo,
    regras: REGRAS_TRIBUTARIAS,
    iss_municipios: ISS_MUNICIPIOS,
    data: resultado
  });
});

// Endpoint: preencher retenções faltantes baseado na legislação
router.post('/retencoes/preencher', (req, res) => {
  const nfs = req.db.prepare(`
    SELECT id, numero, valor_bruto, tomador, cidade, inss, ir, iss, csll, pis, cofins, retencao
    FROM notas_fiscais WHERE (inss = 0 OR inss IS NULL) AND (ir = 0 OR ir IS NULL) AND retencao > 0
  `).all();

  const update = req.db.prepare(`
    UPDATE notas_fiscais SET inss=@inss, ir=@ir, iss=@iss, csll=@csll, pis=@pis, cofins=@cofins
    WHERE id=@id
  `);

  let preenchidas = 0;
  const trans = req.db.transaction(() => {
    for (const nf of nfs) {
      const esp = calcularRetencoesEsperadas(nf.valor_bruto, nf.tomador, nf.cidade, nf.retencao);
      // Ajustar proporcionalmente à retenção real (para fechar o valor)
      const fator = nf.retencao / esp.totalEsperado;
      update.run({
        id: nf.id,
        inss: +(esp.inss * fator).toFixed(2),
        ir: +(esp.irrf * fator).toFixed(2),
        iss: +(esp.iss * fator).toFixed(2),
        csll: +(esp.csll * fator).toFixed(2),
        pis: +(esp.pis * fator).toFixed(2),
        cofins: +(esp.cofins * fator).toFixed(2)
      });
      preenchidas++;
    }
  });
  trans();

  res.json({ ok: true, message: `${preenchidas} NFs tiveram retenções detalhadas preenchidas com base na legislação`, preenchidas });
});

// Endpoint: regras tributárias (consulta)
router.get('/retencoes/regras', (req, res) => {
  res.json({
    regras: REGRAS_TRIBUTARIAS,
    iss_municipios: ISS_MUNICIPIOS,
    tomador_classificacao: TOMADOR_ESFERA.map(r => ({ pattern: r.pattern.toString(), esfera: r.esfera }))
  });
});

// ─── DASHBOARD KPIs ──────────────────────────────────────────────
router.get('/dashboard', (req, res) => {
  try {
  const { from, to } = req.query;

  // Cache: evita recalcular 10 queries em acessos repetidos no mesmo minuto
  const cacheKey = `${req.companyKey}:${from || ''}:${to || ''}`;
  const cached = dashCacheGet(cacheKey);
  if (cached) return res.json(cached);

  let dateFilter = '';
  const params = {};
  if (from) { dateFilter += ' AND e.data_iso >= @from'; params.from = from; }
  if (to) { dateFilter += ' AND e.data_iso <= @to'; params.to = to; }

  // 1. Totais gerais dos extratos
  const totais = req.db.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(credito), 0) as total_creditos,
      COALESCE(SUM(debito), 0) as total_debitos,
      COUNT(CASE WHEN status_conciliacao = 'CONCILIADO' THEN 1 END) as conciliados,
      COUNT(CASE WHEN status_conciliacao = 'PENDENTE' THEN 1 END) as pendentes,
      COUNT(CASE WHEN status_conciliacao = 'PARCIAL' THEN 1 END) as parciais,
      COUNT(CASE WHEN status_conciliacao = 'A_IDENTIFICAR' OR status_conciliacao = '' OR status_conciliacao IS NULL THEN 1 END) as a_identificar,
      COALESCE(SUM(CASE WHEN credito > 0 AND (status_conciliacao IN ('PENDENTE','A_IDENTIFICAR','') OR status_conciliacao IS NULL) THEN credito END), 0) as a_receber
    FROM extratos e WHERE 1=1 ${dateFilter}
  `).get(params);

  // 2. Contratos com resumo financeiro
  const contratos = req.db.prepare(`SELECT COUNT(*) as total, COALESCE(SUM(total_pago),0) as total_pago, COALESCE(SUM(total_aberto),0) as total_aberto FROM contratos`).get();

  // 3. NFs — filtradas pelo mesmo período quando fornecido
  let nfsDateFilter = '';
  const nfsParams = {};
  if (from) { nfsDateFilter += ' AND data_emissao >= @from'; nfsParams.from = from; }
  if (to)   { nfsDateFilter += ' AND data_emissao <= @to';   nfsParams.to = to; }
  const nfs = req.db.prepare(`SELECT COUNT(*) as total, COALESCE(SUM(valor_bruto),0) as total_bruto, COALESCE(SUM(valor_liquido),0) as total_liquido FROM notas_fiscais WHERE 1=1 ${nfsDateFilter}`).get(nfsParams);

  // 4. Pagamentos filtrados por data
  let pgDateFilter = '';
  const pgParams = {};
  if (from) { pgDateFilter += ' AND data_pagamento_iso >= @from'; pgParams.from = from; }
  if (to) { pgDateFilter += ' AND data_pagamento_iso <= @to'; pgParams.to = to; }
  const pgs = req.db.prepare(`SELECT COUNT(*) as total, COALESCE(SUM(valor_pago),0) as total_pago FROM pagamentos WHERE 1=1 ${pgDateFilter}`).get(pgParams);

  // 5. Vinculacoes
  const vincs = req.db.prepare(`SELECT COUNT(*) as total FROM vinculacoes`).get();

  // 6. Despesas — filtradas pelo mesmo período quando fornecido
  let despDateFilter = '';
  const despParams = {};
  if (from) { despDateFilter += ' AND data_iso >= @from'; despParams.from = from; }
  if (to)   { despDateFilter += ' AND data_iso <= @to';   despParams.to = to; }
  const despesas = req.db.prepare(`SELECT COUNT(*) as total, COALESCE(SUM(valor_bruto),0) as total_bruto, COALESCE(SUM(valor_liquido),0) as total_liquido, COALESCE(SUM(CASE WHEN UPPER(categoria) IN ('IMPOSTOS','DARF','FGTS','INSS') THEN valor_bruto ELSE 0 END),0) as total_impostos FROM despesas WHERE 1=1 ${despDateFilter}`).get(despParams);

  // 7. Fluxo mensal — filtrado pelo período quando informado, senão últimos 6 meses
  // Exclui créditos classificados como INTERNO (transferências entre contas) ou INVESTIMENTO (resgates)
  const EXCLUIR_FLUXO = `AND status_conciliacao NOT IN ('INTERNO','INVESTIMENTO')`;
  const fluxoFilter = (from ? ' AND data_iso >= @from' : '') + (to ? ' AND data_iso <= @to' : '');
  const fluxoMensal = from || to
    ? req.db.prepare(`
        SELECT
          substr(data_iso, 1, 7) as mes,
          COALESCE(SUM(CASE WHEN credito>0 ${EXCLUIR_FLUXO} THEN credito END), 0) as creditos,
          COALESCE(SUM(debito), 0) as debitos
        FROM extratos
        WHERE data_iso != '' AND data_iso IS NOT NULL ${fluxoFilter}
        GROUP BY substr(data_iso, 1, 7)
        ORDER BY mes ASC
      `).all(params)
    : req.db.prepare(`
        SELECT
          substr(data_iso, 1, 7) as mes,
          COALESCE(SUM(CASE WHEN credito>0 ${EXCLUIR_FLUXO} THEN credito END), 0) as creditos,
          COALESCE(SUM(debito), 0) as debitos
        FROM extratos
        WHERE data_iso != '' AND data_iso IS NOT NULL
        GROUP BY substr(data_iso, 1, 7)
        ORDER BY mes DESC
        LIMIT 6
      `).all().reverse();

  // 8. Top 5 contratos por valor
  const topContratos = req.db.prepare(`
    SELECT numContrato, contrato, total_pago, total_aberto, status,
      COALESCE((SELECT SUM(d.valor_bruto) FROM despesas d WHERE d.contrato_ref = c.numContrato), 0) as despesas_total
    FROM contratos c
    ORDER BY total_pago DESC
    LIMIT 5
  `).all();

  // 9. Últimos 10 lançamentos (créditos)
  const ultimosCreditos = req.db.prepare(`
    SELECT id, data, historico, credito, posto, status_conciliacao, contrato_vinculado, banco
    FROM extratos
    WHERE credito > 0
    ORDER BY data_iso DESC, id DESC
    LIMIT 10
  `).all();

  // 10. Alertas
  const alertas = [];
  const semVinculo = req.db.prepare(`SELECT COUNT(*) as n FROM extratos WHERE credito > 0 AND (status_conciliacao = 'PENDENTE' OR status_conciliacao = '' OR status_conciliacao IS NULL)`).get();
  if (semVinculo.n > 0) alertas.push({ tipo: 'warning', msg: `${semVinculo.n} créditos sem vínculo a contrato`, icon: '⚠️' });

  const parciais = req.db.prepare(`SELECT COUNT(*) as n FROM extratos WHERE status_conciliacao = 'PARCIAL'`).get();
  if (parciais.n > 0) alertas.push({ tipo: 'info', msg: `${parciais.n} lançamentos com conciliação parcial`, icon: '🔶' });

  const despPendentes = req.db.prepare(`SELECT COUNT(*) as n FROM despesas WHERE status = 'PENDENTE'`).get();
  if (despPendentes.n > 0) alertas.push({ tipo: 'warning', msg: `${despPendentes.n} despesas pendentes de pagamento`, icon: '💸' });

  const contratosVencidos = req.db.prepare(`SELECT COUNT(*) as n FROM contratos WHERE vigencia_fim != '' AND vigencia_fim < date('now')`).get();
  if (contratosVencidos.n > 0) alertas.push({ tipo: 'danger', msg: `${contratosVencidos.n} contratos com vigência vencida`, icon: '🔴' });

  // 11. Conciliação por status (para gráfico donut)
  const concStatus = {
    conciliados: totais.conciliados || 0,
    pendentes: totais.pendentes || 0,
    parciais: totais.parciais || 0,
    a_identificar: totais.a_identificar || 0
  };

  const result = {
    extratos: totais,
    contratos: { total: contratos.total, totalPago: contratos.total_pago, totalAberto: contratos.total_aberto },
    nfs: { total: nfs.total, totalBruto: nfs.total_bruto, totalLiquido: nfs.total_liquido },
    pagamentos: { total: pgs.total, totalPago: pgs.total_pago },
    vinculacoes: { total: vincs.total },
    despesas: { total: despesas.total, totalBruto: despesas.total_bruto, totalLiquido: despesas.total_liquido, totalImpostos: despesas.total_impostos },
    fluxoMensal,
    topContratos,
    ultimosCreditos,
    alertas,
    concStatus
  };
  dashCacheSet(cacheKey, result);
  res.json(result);
  } catch(e) { errRes(res, e); }
});

// ─── EXTRATOS ────────────────────────────────────────────────────
// Meses disponíveis no banco para o período selecionado (para botões dinâmicos)
router.get('/extratos/meses', (req, res) => {
  try {
    const { from, to } = req.query;
    let where = '1=1';
    const params = {};
    if (from) { where += ' AND data_iso >= @from'; params.from = from; }
    if (to)   { where += ' AND data_iso <= @to';   params.to   = to;   }
    const MES_ORDER = ['JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];
    const rows = req.db.prepare(`SELECT DISTINCT mes FROM extratos WHERE ${where} AND length(mes)=3`).all(params);
    const meses = rows.map(r => r.mes).filter(m => MES_ORDER.includes(m))
      .sort((a,b) => MES_ORDER.indexOf(a) - MES_ORDER.indexOf(b));
    res.json({ meses });
  } catch(e) { errRes(res, e); }
});

router.get('/extratos', (req, res) => {
  try {
  const { from, to, status, mes, posto, page = 1, limit = 100 } = req.query;
  let where = '1=1';
  const params = {};
  if (from) { where += ' AND data_iso >= @from'; params.from = from; }
  if (to) { where += ' AND data_iso <= @to'; params.to = to; }
  if (status) { where += ' AND status_conciliacao = @status'; params.status = status; }
  if (mes) { where += ' AND mes = @mes'; params.mes = mes; }
  if (posto) { where += ' AND posto = @posto'; params.posto = posto; }

  const offset = (parseInt(page) - 1) * parseInt(limit);
  params.limit = parseInt(limit);
  params.offset = offset;

  const total = req.db.prepare(`SELECT COUNT(*) as cnt FROM extratos WHERE ${where}`).get(params).cnt;
  const rows = req.db.prepare(`SELECT * FROM extratos WHERE ${where} ORDER BY data_iso DESC, id DESC LIMIT @limit OFFSET @offset`).all(params);

  res.json({ total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)), data: rows });
  } catch(e) { errRes(res, e); }
});

// ─── CONTRATOS ───────────────────────────────────────────────────
router.get('/contratos', (req, res) => {
  try {
    const rows = req.db.prepare(`
      SELECT c.*,
        COALESCE((SELECT SUM(v.valor) FROM vinculacoes v WHERE v.contrato_num = c.numContrato), 0) as total_vinculado,
        COALESCE((SELECT COUNT(*) FROM vinculacoes v WHERE v.contrato_num = c.numContrato), 0) as qtd_vinculacoes,
        COALESCE((SELECT COUNT(*) FROM parcelas p WHERE p.contrato_num = c.numContrato), 0) as qtd_parcelas
      FROM contratos c ORDER BY c.contrato
    `).all();

    const summary = req.db.prepare(`
      SELECT
        COALESCE(SUM(total_pago), 0) as soma_pago,
        COALESCE(SUM(total_aberto), 0) as soma_aberto,
        COUNT(*) as total_contratos
      FROM contratos
    `).get();

    res.json({ data: rows, summary });
  } catch(e) { errRes(res, e); }
});

// ─── SAÚDE DOS CONTRATOS ─────────────────────────────────────────
// NFs e extratos não têm contrato_ref/contrato_vinculado preenchidos na importação,
// então usamos MAPA de tomadores/keywords por contrato para agregar os dados.
router.get('/contratos/saude', (req, res) => {
  try {
    const hoje = new Date().toISOString().slice(0, 10);

    // Mapa: numContrato → { nfLike: [...], extLike: [...] }
    // nfLike: padrões LIKE para coluna `tomador` nas notas_fiscais
    // extLike: padrões LIKE para coluna `historico` nos extratos
    // Mapa: numContrato → condições SQL para NFs
    // nfWhere: fragmento WHERE para notas_fiscais (tomador matching)
    // nfParams: parâmetros para o fragmento
    // Para UFT limpeza vs motorista: usamos discriminacao para diferenciar
    const NF_DATE_FROM = '2024-01-01'; // Só NFs do período relevante (contratos ativos)

    const MAPA_SAUDE = {
      'UFT 16/2025': {
        nfWhere: `tomador LIKE ? AND (discriminacao IS NULL OR (UPPER(discriminacao) NOT LIKE '%MOTORISTA%' AND UPPER(discriminacao) NOT LIKE '%MOTOCICLISTA%' AND UPPER(discriminacao) NOT LIKE '%TRATORISTA%'))`,
        nfParams: ['%FUNDACAO UNIVERSIDADE FEDERAL DO TOCANTINS%'],
      },
      'UFT MOTORISTA 05/2025': {
        nfWhere: `tomador LIKE ? AND (UPPER(discriminacao) LIKE '%MOTORISTA%' OR UPPER(discriminacao) LIKE '%MOTOCICLISTA%' OR UPPER(discriminacao) LIKE '%TRATORISTA%')`,
        nfParams: ['%FUNDACAO UNIVERSIDADE FEDERAL DO TOCANTINS%'],
      },
      'DETRAN 41/2023 + 2°TA': {
        nfWhere: `tomador LIKE ?`,
        nfParams: ['%DEPARTAMENTO ESTADUAL DE TRANSITO%'],
      },
      'SEMARH 32/2024': {
        nfWhere: `tomador LIKE ?`,
        nfParams: ['%SECRETARIA DO MEIO AMBIENTE E RECURSOS HIDRICOS%'],
      },
      'PREVI PALMAS — em vigor': {
        nfWhere: `(tomador LIKE ? OR tomador LIKE ?)`,
        nfParams: ['%PREVIPALMAS%','%PREVIDENCIA SOCIAL DO MUNICIPIO DE PALMAS%'],
      },
      'SEDUC Limpeza/Copeiragem': {
        nfWhere: `tomador LIKE ?`,
        nfParams: ['%SECRETARIA DA EDUCACAO%'],
      },
      'SESAU 178/2022': {
        nfWhere: `tomador LIKE ?`,
        nfParams: ['%SECRETARIA DE ESTADO DA SAUDE DO TOCANTINS%'],
      },
      'UFNT 30/2022': {
        nfWhere: `(tomador LIKE ? OR tomador LIKE ?)`,
        nfParams: ['%UNIVERSIDADE FEDERAL DO NORTE DO TOCANTINS%','%UFNT%'],
      },
      'UNITINS 003/2023 + 3°TA': {
        nfWhere: `tomador LIKE ?`,
        nfParams: ['%UNIVERSIDADE ESTADUAL DO TOCANTINS%'],
      },
      'TCE 117/2024': {
        nfWhere: `tomador LIKE ?`,
        nfParams: ['%TRIBUNAL DE CONTAS DO ESTADO DO TOCANTINS%'],
      },
      'SEMUS 192/2025': {
        nfWhere: `(tomador LIKE ? OR tomador LIKE ?)`,
        nfParams: ['%SECRETARIA MUNICIPAL DE SAUDE%','%SEMUS%'],
      },
      'CBMTO 011/2023 + 5°TA': {
        nfWhere: `(tomador LIKE ? OR tomador LIKE ?)`,
        nfParams: ['%CORPO DE BOMBEIROS%','%CBMTO%'],
      },
    };

    const contratos = req.db.prepare(`
      SELECT numContrato, contrato, orgao, status,
             valor_mensal_bruto, valor_mensal_liquido,
             vigencia_inicio, vigencia_fim, total_pago
      FROM contratos ORDER BY status, contrato
    `).all();

    const resultado = contratos.map(c => {
      const num = c.numContrato;
      const mapa = MAPA_SAUDE[num];

      let totalNFs = 0, qtdNFs = 0, ultimaNfData = null, nfsConciliadas = 0;
      let totalRecebido = 0, qtdPagamentos = 0, ultimoPgto = null;

      if (mapa) {
        // Todas NFs do período relevante para o contrato — 1 query (era 2 N+1)
        const nfRow = req.db.prepare(`
          SELECT COUNT(*) as qtd,
                 COALESCE(SUM(valor_bruto),0) as total,
                 MAX(data_emissao) as ultima,
                 COUNT(CASE WHEN status_conciliacao='CONCILIADO' THEN 1 END) as conc,
                 COALESCE(SUM(CASE WHEN status_conciliacao='CONCILIADO' THEN valor_bruto END),0) as total_conc,
                 MAX(CASE WHEN status_conciliacao='CONCILIADO' THEN data_emissao END) as ultima_conciliada
          FROM notas_fiscais
          WHERE data_emissao >= '${NF_DATE_FROM}'
            AND (${mapa.nfWhere})
        `).get(...mapa.nfParams);
        qtdNFs = nfRow.qtd; totalNFs = nfRow.total;
        ultimaNfData = nfRow.ultima; nfsConciliadas = nfRow.conc;
        totalRecebido = nfRow.total_conc;
        ultimoPgto = nfRow.ultima_conciliada; // eliminada a 2ª query N+1
        qtdPagamentos = nfsConciliadas;
      }

      const saldo = totalNFs - totalRecebido;

      let statusSaude = 'SEM_DADOS';
      if (c.status && (c.status.toUpperCase().includes('ENCERRADO') || c.status.toUpperCase().includes('RESCINDIDO'))) {
        statusSaude = 'ENCERRADO';
      } else if (!mapa) {
        statusSaude = 'SEM_DADOS';
      } else if (totalNFs === 0 && totalRecebido === 0) {
        statusSaude = 'SEM_DADOS';
      } else if (saldo <= 0) {
        statusSaude = 'ADIMPLENTE';
      } else if (ultimoPgto) {
        const dias = Math.floor((new Date(hoje) - new Date(ultimoPgto)) / 86400000);
        statusSaude = dias <= 60 ? 'ADIMPLENTE' : dias <= 120 ? 'A_VENCER' : 'ATRASADO';
      } else {
        statusSaude = saldo > 0 ? 'PENDENTE' : 'ADIMPLENTE';
      }

      let mesesAtivos = 0;
      if (c.vigencia_inicio && c.vigencia_fim) {
        try {
          const ini = new Date(c.vigencia_inicio);
          const fim = new Date(c.vigencia_fim < hoje ? c.vigencia_fim : hoje);
          mesesAtivos = Math.max(0, (fim.getFullYear()-ini.getFullYear())*12 + (fim.getMonth()-ini.getMonth()) + 1);
        } catch(_) {}
      }

      return {
        numContrato: num, contrato: c.contrato, orgao: c.orgao, status: c.status, statusSaude,
        valor_mensal_bruto: c.valor_mensal_bruto||0, valor_mensal_liquido: c.valor_mensal_liquido||0,
        vigencia_inicio: c.vigencia_inicio, vigencia_fim: c.vigencia_fim,
        qtd_nfs: qtdNFs, total_nfs_bruto: +totalNFs.toFixed(2),
        nfs_conciliadas: nfsConciliadas, total_recebido: +totalRecebido.toFixed(2),
        saldo_a_receber: +saldo.toFixed(2), ultima_nf_data: ultimaNfData,
        ultimo_pagamento: ultimoPgto, qtd_pagamentos: qtdPagamentos,
        meses_ativos: mesesAtivos,
        receita_mensal_media: mesesAtivos > 0 ? +(totalRecebido/mesesAtivos).toFixed(2) : 0,
      };
    });

    const ativos = resultado.filter(r => r.statusSaude !== 'ENCERRADO');
    const resumo = {
      total_contratos: resultado.length, contratos_ativos: ativos.length,
      total_nfs:      +resultado.reduce((s,r)=>s+r.total_nfs_bruto,0).toFixed(2),
      total_recebido: +resultado.reduce((s,r)=>s+r.total_recebido,0).toFixed(2),
      total_saldo:    +resultado.reduce((s,r)=>s+r.saldo_a_receber,0).toFixed(2),
      adimplentes:    resultado.filter(r=>r.statusSaude==='ADIMPLENTE').length,
      atrasados:      resultado.filter(r=>r.statusSaude==='ATRASADO').length,
      sem_dados:      resultado.filter(r=>r.statusSaude==='SEM_DADOS').length,
    };
    res.json({ ok: true, data: resultado, resumo });
  } catch(e) { errRes(res, e); }
});

router.get('/contratos/:num/parcelas', (req, res) => {
  try {
    const rows = req.db.prepare(`
      SELECT * FROM parcelas WHERE contrato_num = ? ORDER BY id
    `).all(req.params.num);
    res.json({ data: rows });
  } catch(e) { errRes(res, e); }
});

// ─── CRUD DE CONTRATOS ───────────────────────────────────────────
// POST /contratos — cria um novo contrato
router.post('/contratos', (req, res) => {
  try {
    const {
      numContrato, contrato, orgao = '', vigencia_inicio = '', vigencia_fim = '',
      valor_mensal_bruto = 0, valor_mensal_liquido = 0, status = 'ATIVO', obs = '',
    } = req.body;
    if (!numContrato || !contrato) return res.status(400).json({ error: 'numContrato e contrato são obrigatórios' });
    const existe = req.db.prepare('SELECT id FROM contratos WHERE numContrato = ?').get(numContrato);
    if (existe) return res.status(409).json({ error: `Contrato ${numContrato} já existe` });

    const result = req.db.prepare(`
      INSERT INTO contratos (numContrato, contrato, orgao, vigencia_inicio, vigencia_fim,
        valor_mensal_bruto, valor_mensal_liquido, status, obs, created_at, updated_at)
      VALUES (@numContrato, @contrato, @orgao, @vigencia_inicio, @vigencia_fim,
        @valor_mensal_bruto, @valor_mensal_liquido, @status, @obs, datetime('now'), datetime('now'))
    `).run({ numContrato, contrato, orgao, vigencia_inicio, vigencia_fim,
             valor_mensal_bruto: parseFloat(valor_mensal_bruto) || 0,
             valor_mensal_liquido: parseFloat(valor_mensal_liquido) || 0,
             status, obs });

    audit(req, 'INSERT', 'contratos', numContrato, contrato);
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch(e) { errRes(res, e); }
});

// PUT /contratos/:num — edita campos de um contrato existente
router.put('/contratos/:num', (req, res) => {
  try {
    const { num } = req.params;
    const c = req.db.prepare('SELECT * FROM contratos WHERE numContrato = ?').get(num);
    if (!c) return res.status(404).json({ error: 'Contrato não encontrado' });

    const campos = ['contrato','orgao','vigencia_inicio','vigencia_fim',
                    'valor_mensal_bruto','valor_mensal_liquido','status','obs'];
    const sets = campos
      .filter(f => req.body[f] !== undefined)
      .map(f => `${f} = @${f}`)
      .join(', ');

    if (!sets) return res.status(400).json({ error: 'Nenhum campo para atualizar' });

    const params = { num };
    campos.forEach(f => { if (req.body[f] !== undefined) params[f] = req.body[f]; });

    req.db.prepare(`UPDATE contratos SET ${sets}, updated_at = datetime('now') WHERE numContrato = @num`).run(params);
    audit(req, 'UPDATE', 'contratos', num, sets);
    res.json({ ok: true });
  } catch(e) { errRes(res, e); }
});

// DELETE /contratos/:num — marca como ENCERRADO (soft delete)
router.delete('/contratos/:num', (req, res) => {
  try {
    const { num } = req.params;
    const c = req.db.prepare('SELECT numContrato FROM contratos WHERE numContrato = ?').get(num);
    if (!c) return res.status(404).json({ error: 'Contrato não encontrado' });
    req.db.prepare(`UPDATE contratos SET status = 'ENCERRADO', updated_at = datetime('now') WHERE numContrato = ?`).run(num);
    audit(req, 'DELETE', 'contratos', num, 'marcado ENCERRADO');
    res.json({ ok: true });
  } catch(e) { errRes(res, e); }
});

// POST /contratos/:num/parcelas — cria nova parcela
router.post('/contratos/:num/parcelas', (req, res) => {
  try {
    const { num } = req.params;
    const c = req.db.prepare('SELECT numContrato FROM contratos WHERE numContrato = ?').get(num);
    if (!c) return res.status(404).json({ error: 'Contrato não encontrado' });

    const { competencia, valor_bruto = 0, valor_liquido = 0, valor_pago = 0, data_pagamento = '', status = 'A RECEBER', obs = '' } = req.body;
    if (!competencia) return res.status(400).json({ error: 'competencia é obrigatória (ex: 2025-03)' });

    const result = req.db.prepare(`
      INSERT INTO parcelas (contrato_num, competencia, valor_bruto, valor_liquido, valor_pago, data_pagamento, status, obs, created_at)
      VALUES (@num, @competencia, @valor_bruto, @valor_liquido, @valor_pago, @data_pagamento, @status, @obs, datetime('now'))
    `).run({ num, competencia,
             valor_bruto: parseFloat(valor_bruto) || 0,
             valor_liquido: parseFloat(valor_liquido) || 0,
             valor_pago: parseFloat(valor_pago) || 0,
             data_pagamento: data_pagamento || null, status, obs });

    // Recalcula totais do contrato
    const totals = req.db.prepare(`
      SELECT COALESCE(SUM(valor_pago),0) as total_pago,
             COALESCE(SUM(CASE WHEN valor_pago=0 OR valor_pago IS NULL THEN valor_liquido ELSE 0 END),0) as total_aberto
      FROM parcelas WHERE contrato_num = ?
    `).get(num);
    req.db.prepare(`UPDATE contratos SET total_pago=?, total_aberto=?, updated_at=datetime('now') WHERE numContrato=?`)
      .run(totals.total_pago, totals.total_aberto, num);

    audit(req, 'INSERT', 'parcelas', result.lastInsertRowid, `${num} ${competencia}`);
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch(e) { errRes(res, e); }
});

// DELETE /parcelas/:id — remove parcela
router.delete('/parcelas/:id', (req, res) => {
  try {
    const parcela = req.db.prepare('SELECT * FROM parcelas WHERE id = ?').get(req.params.id);
    if (!parcela) return res.status(404).json({ error: 'Parcela não encontrada' });
    req.db.prepare('DELETE FROM parcelas WHERE id = ?').run(req.params.id);

    // Recalcula totais do contrato
    const totals = req.db.prepare(`
      SELECT COALESCE(SUM(valor_pago),0) as total_pago,
             COALESCE(SUM(CASE WHEN valor_pago=0 OR valor_pago IS NULL THEN valor_liquido ELSE 0 END),0) as total_aberto
      FROM parcelas WHERE contrato_num = ?
    `).get(parcela.contrato_num);
    req.db.prepare(`UPDATE contratos SET total_pago=?, total_aberto=?, updated_at=datetime('now') WHERE numContrato=?`)
      .run(totals.total_pago, totals.total_aberto, parcela.contrato_num);

    audit(req, 'DELETE', 'parcelas', req.params.id, `${parcela.contrato_num} ${parcela.competencia}`);
    res.json({ ok: true });
  } catch(e) { errRes(res, e); }
});

// ─── REAJUSTE CONTRATUAL ─────────────────────────────────────────
router.get('/reajustes', (req, res) => {
  try {
    const hoje = new Date().toISOString().slice(0, 10);
    const contratos = req.db.prepare(`
      SELECT numContrato, contrato, orgao, status, vigencia_fim,
             data_ultimo_reajuste, indice_reajuste, pct_reajuste_ultimo,
             data_proximo_reajuste, obs_reajuste, valor_mensal_bruto
      FROM contratos
      WHERE status NOT LIKE '%ENCERRADO%' AND status NOT LIKE '%RESCINDIDO%'
      ORDER BY data_proximo_reajuste ASC, vigencia_fim ASC
    `).all();

    const data = contratos.map(c => {
      const diasSemReajuste = c.data_ultimo_reajuste
        ? Math.floor((new Date(hoje) - new Date(c.data_ultimo_reajuste)) / 86400000)
        : null;
      const diasParaReajuste = c.data_proximo_reajuste
        ? Math.floor((new Date(c.data_proximo_reajuste) - new Date(hoje)) / 86400000)
        : null;
      const diasParaVencimento = c.vigencia_fim
        ? Math.floor((new Date(c.vigencia_fim) - new Date(hoje)) / 86400000)
        : null;

      let alerta = null;
      if (!c.data_ultimo_reajuste) alerta = 'sem_registro';
      else if (diasSemReajuste > 365) alerta = 'atrasado';
      else if (diasParaReajuste !== null && diasParaReajuste <= 60 && diasParaReajuste >= 0) alerta = 'proximo';

      if (!alerta && diasParaVencimento !== null && diasParaVencimento <= 90 && diasParaVencimento >= 0) alerta = 'vencimento_proximo';

      return { ...c, diasSemReajuste, diasParaReajuste, diasParaVencimento, alerta };
    });

    const resumo = {
      total: data.length,
      sem_registro: data.filter(c => c.alerta === 'sem_registro').length,
      atrasado: data.filter(c => c.alerta === 'atrasado').length,
      proximo: data.filter(c => c.alerta === 'proximo').length,
      vencimento_proximo: data.filter(c => c.alerta === 'vencimento_proximo').length,
    };

    res.json({ data, resumo });
  } catch (e) { errRes(res, e); }
});

router.patch('/reajustes/:num', (req, res) => {
  const { num } = req.params;
  const { data_ultimo_reajuste, indice_reajuste, pct_reajuste_ultimo, data_proximo_reajuste, obs_reajuste } = req.body;
  const c = req.db.prepare('SELECT numContrato FROM contratos WHERE numContrato = ?').get(num);
  if (!c) return res.status(404).json({ error: 'Contrato não encontrado' });

  req.db.prepare(`
    UPDATE contratos SET
      data_ultimo_reajuste  = COALESCE(@data_ultimo_reajuste, data_ultimo_reajuste),
      indice_reajuste       = COALESCE(@indice_reajuste, indice_reajuste),
      pct_reajuste_ultimo   = COALESCE(@pct_reajuste_ultimo, pct_reajuste_ultimo),
      data_proximo_reajuste = COALESCE(@data_proximo_reajuste, data_proximo_reajuste),
      obs_reajuste          = COALESCE(@obs_reajuste, obs_reajuste),
      updated_at = datetime('now')
    WHERE numContrato = @num
  `).run({ num, data_ultimo_reajuste: data_ultimo_reajuste || null, indice_reajuste: indice_reajuste || null,
           pct_reajuste_ultimo: pct_reajuste_ultimo ?? null, data_proximo_reajuste: data_proximo_reajuste || null,
           obs_reajuste: obs_reajuste || null });

  audit(req, 'REAJUSTE', 'contratos', num, `idx=${indice_reajuste} pct=${pct_reajuste_ultimo}`);
  res.json({ ok: true });
});

router.patch('/parcelas/:id', (req, res) => {
  const { id } = req.params;
  const { status, valor_pago, data_pagamento, obs } = req.body;
  const parcela = req.db.prepare('SELECT * FROM parcelas WHERE id = ?').get(id);
  if (!parcela) return res.status(404).json({ error: 'Parcela não encontrada' });

  req.db.prepare(`
    UPDATE parcelas SET
      status = COALESCE(@status, status),
      valor_pago = COALESCE(@valor_pago, valor_pago),
      data_pagamento = COALESCE(@data_pagamento, data_pagamento),
      obs = COALESCE(@obs, obs)
    WHERE id = @id
  `).run({
    id, status: status ?? null, valor_pago: valor_pago ?? null,
    data_pagamento: data_pagamento ?? null, obs: obs ?? null
  });

  // Recalculate contract totals
  const totals = req.db.prepare(`
    SELECT COALESCE(SUM(valor_pago), 0) as total_pago,
           COALESCE(SUM(CASE WHEN valor_pago = 0 OR valor_pago IS NULL THEN valor_liquido ELSE 0 END), 0) as total_aberto
    FROM parcelas WHERE contrato_num = ?
  `).get(parcela.contrato_num);

  req.db.prepare('UPDATE contratos SET total_pago = ?, total_aberto = ?, updated_at = datetime(\'now\') WHERE numContrato = ?')
    .run(totals.total_pago, totals.total_aberto, parcela.contrato_num);

  res.json({ ok: true, totals });
});

// ─── NOTAS FISCAIS ───────────────────────────────────────────────
router.get('/nfs', (req, res) => {
  const { cidade, tomador, from, to, page = 1, limit = 100 } = req.query;
  let where = '1=1';
  const params = {};
  if (cidade) { where += ' AND cidade = @cidade'; params.cidade = cidade; }
  if (tomador) { where += ' AND tomador = @tomador'; params.tomador = tomador; }
  if (from) { where += ' AND data_emissao >= @from'; params.from = from; }
  if (to)   { where += ' AND data_emissao <= @to';   params.to = to; }
  const offset = (parseInt(page) - 1) * parseInt(limit);
  params.limit = parseInt(limit); params.offset = offset;

  const total = req.db.prepare(`SELECT COUNT(*) as cnt FROM notas_fiscais WHERE ${where}`).get(params).cnt;
  const rows = req.db.prepare(`SELECT * FROM notas_fiscais WHERE ${where} ORDER BY id DESC LIMIT @limit OFFSET @offset`).all(params);
  res.json({ total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)), data: rows });
});

router.delete('/nfs/:id', (req, res) => {
  try {
    const nf = req.db.prepare('SELECT numero FROM notas_fiscais WHERE id = ?').get(req.params.id);
    req.db.prepare('DELETE FROM notas_fiscais WHERE id = ?').run(req.params.id);
    audit(req, 'DELETE', 'notas_fiscais', req.params.id, `NF ${nf?.numero || ''}`);
    dashCacheInvalidate(req.companyKey);
    res.json({ ok: true });
  } catch(e) { errRes(res, e); }
});

// ─── NFs SEM DATA — listagem e correção em lote ──────────────────
router.get('/nfs/sem-data', (req, res) => {
  try {
    const rows = req.db.prepare(`
      SELECT id, numero, contrato_ref, competencia, valor_bruto, valor_liquido,
             retencao, data_emissao, created_at
      FROM notas_fiscais
      WHERE data_emissao IS NULL OR data_emissao = ''
      ORDER BY CAST(numero AS INTEGER)
    `).all();

    // Detecta prováveis duplicatas: mesmo contrato_ref e valor_bruto
    const grupos = {};
    rows.forEach(n => {
      const key = (n.contrato_ref || '') + '_' + n.valor_bruto;
      if (!grupos[key]) grupos[key] = [];
      grupos[key].push(n.id);
    });

    const data = rows.map(n => {
      const key = (n.contrato_ref || '') + '_' + n.valor_bruto;
      const dup = grupos[key].length > 1 ? grupos[key] : null;
      return { ...n, provavel_duplicata: dup };
    });

    res.json({ total: rows.length, data });
  } catch(e) { errRes(res, e); }
});

router.patch('/nfs/:id/corrigir', (req, res) => {
  try {
    const { data_emissao, competencia, contrato_ref } = req.body;
    const id = req.params.id;
    const nf = req.db.prepare('SELECT id, numero FROM notas_fiscais WHERE id = ?').get(id);
    if (!nf) return res.status(404).json({ error: 'NF não encontrada' });

    req.db.prepare(`
      UPDATE notas_fiscais SET
        data_emissao  = COALESCE(@data_emissao, data_emissao),
        competencia   = COALESCE(@competencia, competencia),
        contrato_ref  = COALESCE(@contrato_ref, contrato_ref)
      WHERE id = @id
    `).run({ data_emissao: data_emissao || null, competencia: competencia || null, contrato_ref: contrato_ref || null, id });

    audit(req, 'UPDATE', 'notas_fiscais', id, `Correção data NF ${nf.numero}: ${data_emissao}`);
    dashCacheInvalidate(req.companyKey);
    res.json({ ok: true });
  } catch(e) { errRes(res, e); }
});

router.post('/nfs/corrigir-lote', (req, res) => {
  try {
    const { itens } = req.body; // [{id, data_emissao, competencia, contrato_ref}]
    if (!Array.isArray(itens) || !itens.length) return res.status(400).json({ error: 'Nenhum item enviado' });

    const upd = req.db.prepare(`
      UPDATE notas_fiscais SET
        data_emissao = COALESCE(@data_emissao, data_emissao),
        competencia  = COALESCE(@competencia, competencia),
        contrato_ref = COALESCE(@contrato_ref, contrato_ref)
      WHERE id = @id
    `);

    const tx = req.db.transaction((lista) => {
      let ok = 0;
      lista.forEach(item => {
        if (!item.id) return;
        upd.run({
          id: item.id,
          data_emissao: item.data_emissao || null,
          competencia:  item.competencia  || null,
          contrato_ref: item.contrato_ref || null,
        });
        ok++;
      });
      return ok;
    });

    const total = tx(itens);
    audit(req, 'UPDATE_LOTE', 'notas_fiscais', '', `Correção em lote: ${total} NFs`);
    dashCacheInvalidate(req.companyKey);
    res.json({ ok: true, atualizadas: total });
  } catch(e) { errRes(res, e); }
});

// ─── LIQUIDAÇÕES ─────────────────────────────────────────────────
router.get('/liquidacoes', (req, res) => {
  const { gestao, from, to, page = 1, limit = 100 } = req.query;
  let where = '1=1';
  const params = {};
  if (gestao) { where += ' AND gestao = @gestao'; params.gestao = gestao; }
  if (from) { where += ' AND data_liquidacao_iso >= @from'; params.from = from; }
  if (to) { where += ' AND data_liquidacao_iso <= @to'; params.to = to; }
  const offset = (parseInt(page) - 1) * parseInt(limit);
  params.limit = parseInt(limit); params.offset = offset;

  const total = req.db.prepare(`SELECT COUNT(*) as cnt FROM liquidacoes WHERE ${where}`).get(params).cnt;
  const rows = req.db.prepare(`SELECT * FROM liquidacoes WHERE ${where} ORDER BY data_liquidacao_iso DESC LIMIT @limit OFFSET @offset`).all(params);
  res.json({ total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)), data: rows });
});

// ─── PAGAMENTOS ──────────────────────────────────────────────────
router.get('/pagamentos', (req, res) => {
  const { gestao, from, to, page = 1, limit = 100 } = req.query;
  let where = '1=1';
  const params = {};
  if (gestao) { where += ' AND gestao = @gestao'; params.gestao = gestao; }
  if (from) { where += ' AND data_pagamento_iso >= @from'; params.from = from; }
  if (to) { where += ' AND data_pagamento_iso <= @to'; params.to = to; }
  const offset = (parseInt(page) - 1) * parseInt(limit);
  params.limit = parseInt(limit); params.offset = offset;

  const total = req.db.prepare(`SELECT COUNT(*) as cnt FROM pagamentos WHERE ${where}`).get(params).cnt;
  const rows = req.db.prepare(`SELECT * FROM pagamentos WHERE ${where} ORDER BY data_pagamento_iso DESC LIMIT @limit OFFSET @offset`).all(params);
  res.json({ total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)), data: rows });
});

// ─── VINCULAÇÕES (CRUD) ─────────────────────────────────────────
router.get('/vinculacoes', (req, res) => {
  const rows = req.db.prepare(`
    SELECT v.*, e.data, e.historico, e.credito, e.debito, e.status as status_extrato
    FROM vinculacoes v
    LEFT JOIN extratos e ON e.id = v.extrato_id
    ORDER BY v.data_vinculacao DESC
  `).all();
  res.json({ data: rows });
});

router.post('/vinculacoes', (req, res) => {
  const { extrato_id, contrato_num, tipo, valor } = req.body;
  if (!extrato_id || !contrato_num) return res.status(400).json({ error: 'extrato_id e contrato_num obrigatórios' });

  const stmt = req.db.prepare(`
    INSERT OR REPLACE INTO vinculacoes (extrato_id, contrato_num, tipo, valor)
    VALUES (@extrato_id, @contrato_num, @tipo, @valor)
  `);
  stmt.run({ extrato_id, contrato_num, tipo: tipo || '', valor: valor || 0 });

  // Update extrato status
  req.db.prepare(`UPDATE extratos SET contrato_vinculado = @contrato_num, status_conciliacao = 'CONCILIADO', updated_at = datetime('now') WHERE id = @id`)
    .run({ contrato_num, id: extrato_id });

  res.json({ ok: true, message: `Extrato #${extrato_id} vinculado ao contrato ${contrato_num}` });
});

router.post('/vinculacoes/batch', (req, res) => {
  const { vinculacoes } = req.body;
  if (!Array.isArray(vinculacoes)) return res.status(400).json({ error: 'Array de vinculações esperado' });

  const insertVinc = req.db.prepare(`INSERT OR REPLACE INTO vinculacoes (extrato_id, contrato_num, tipo, valor) VALUES (@extrato_id, @contrato_num, @tipo, @valor)`);
  const updateExt = req.db.prepare(`UPDATE extratos SET contrato_vinculado = @contrato_num, status_conciliacao = 'CONCILIADO', updated_at = datetime('now') WHERE id = @id`);

  const batch = req.db.transaction((items) => {
    let count = 0;
    for (const v of items) {
      insertVinc.run({ extrato_id: v.extrato_id, contrato_num: v.contrato_num, tipo: v.tipo || '', valor: v.valor || 0 });
      updateExt.run({ contrato_num: v.contrato_num, id: v.extrato_id });
      count++;
    }
    return count;
  });

  const count = batch(vinculacoes);
  dashCacheInvalidate(req.companyKey);
  res.json({ ok: true, message: `${count} vinculações salvas` });
});

router.delete('/vinculacoes/:extrato_id', (req, res) => {
  const { extrato_id } = req.params;
  req.db.prepare(`DELETE FROM vinculacoes WHERE extrato_id = ?`).run(extrato_id);
  req.db.prepare(`UPDATE extratos SET contrato_vinculado = '', status_conciliacao = 'PENDENTE', updated_at = datetime('now') WHERE id = ?`).run(extrato_id);
  audit(req, 'DELETE', 'vinculacoes', extrato_id, `desvinculação extrato ${extrato_id}`);
  res.json({ ok: true });
});

// ─── IMPORTAÇÃO DE CSVs ──────────────────────────────────────────
router.post('/import/extratos', (req, res, next) => getUpload(req).single('file')(req, res, next), (req, res) => {
  try {
    const extErr = validarExtensao(req.file.originalname, ['csv', 'txt']);
    if (extErr) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: extErr }); }

    const content = fs.readFileSync(req.file.path, 'utf-8');
    // ── GUARDA: verifica contaminação cruzada ──
    const { bloqueio, empresaDetectada } = analisarArquivo(content, req.file.originalname, req.company);
    if (bloqueio) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: bloqueio, empresaDetectada });
    }
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 2) return res.status(400).json({ error: 'CSV vazio' });

    const header = lines[0].split(';').map(h => h.trim().replace(/"/g, ''));
    const insert = req.db.prepare(`
      INSERT OR IGNORE INTO extratos (id, mes, data, data_iso, tipo, historico, debito, credito, posto, competencia, valor_liquido, valor_bruto, retencao, status, obs, status_conciliacao)
      VALUES (@id, @mes, @data, @data_iso, @tipo, @historico, @debito, @credito, @posto, @competencia, @valor_liquido, @valor_bruto, @retencao, @status, @obs, 'PENDENTE')
    `);

    let imported = 0, skipped = 0;
    const batch = req.db.transaction(() => {
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(';').map(c => c.trim().replace(/"/g, ''));
        if (cols.length < 5) continue;
        // Flexible column mapping
        const row = {};
        header.forEach((h, idx) => { row[h.toLowerCase()] = cols[idx] || ''; });

        const r = insert.run({
          id: parseInt(row.id || row.ID || i),
          mes: row.mes || row.MES || '',
          data: row.data || row.DATA || '',
          data_iso: parseDateBR(row.data || row.DATA || ''),
          tipo: row.tipo || '',
          historico: row.historico || row.hist || row.HISTORICO || '',
          debito: parseDecimalBR(row.debito || row.deb || row.DEBITO),
          credito: parseDecimalBR(row.credito || row.cred || row.CREDITO),
          posto: row.posto || '',
          competencia: row.comp || row.competencia || '',
          valor_liquido: parseDecimalBR(row.vliq || row.valor_liquido),
          valor_bruto: parseDecimalBR(row.vbrt || row.valor_bruto),
          retencao: parseDecimalBR(row.ret || row.retencao),
          status: row.st || row.status || '',
          obs: row.obs || ''
        });
        if (r.changes > 0) imported++; else skipped++;
      }
    });
    batch();
    dashCacheInvalidate(req.companyKey);

    // Log import
    req.db.prepare(`INSERT INTO importacoes (tipo, arquivo, registros) VALUES ('extratos', @arquivo, @registros)`)
      .run({ arquivo: req.file.originalname, registros: imported });

    fs.unlinkSync(req.file.path);
    audit(req, 'IMPORT', 'extratos', '', `${req.file.originalname} — ${imported} importados, ${skipped} ignorados`);
    const msg = `${imported} extratos importados` + (skipped > 0 ? ` (${skipped} duplicados ignorados)` : '');
    res.json({ ok: true, imported, skipped, message: msg });
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

router.post('/import/pagamentos', (req, res, next) => getUpload(req).single('file')(req, res, next), (req, res) => {
  try {
    const extErr = validarExtensao(req.file.originalname, ['csv', 'txt']);
    if (extErr) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: extErr }); }
    const content = fs.readFileSync(req.file.path, 'utf-8');
    // ── GUARDA: verifica contaminação cruzada ──
    const { bloqueio, empresaDetectada } = analisarArquivo(content, req.file.originalname, req.company);
    if (bloqueio) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: bloqueio, empresaDetectada });
    }
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 2) return res.status(400).json({ error: 'CSV vazio' });

    const header = lines[0].split(';').map(h => h.trim().replace(/"/g, ''));
    const insert = req.db.prepare(`
      INSERT INTO pagamentos (ob, gestao, fonte, empenho, processo, favorecido, data_pagamento, data_pagamento_iso, valor_pago)
      VALUES (@ob, @gestao, @fonte, @empenho, @processo, @favorecido, @data_pagamento, @data_pagamento_iso, @valor_pago)
    `);

    let imported = 0;
    const batch = req.db.transaction(() => {
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(';').map(c => c.trim().replace(/"/g, ''));
        if (cols.length < 4) continue;
        const row = {};
        header.forEach((h, idx) => { row[h.toLowerCase().trim()] = cols[idx] || ''; });

        insert.run({
          ob: row['documento de pagamento'] || row.ob || '',
          gestao: row['unidade gestora'] || row.gestao || '',
          fonte: row['fonte de recurso'] || row.fonte || '',
          empenho: row['empenho'] || '',
          processo: row['processo'] || '',
          favorecido: row['favorecido'] || '',
          data_pagamento: row['data pagamento'] || row.data_pagamento || '',
          data_pagamento_iso: parseDateBR(row['data pagamento'] || row.data_pagamento || ''),
          valor_pago: parseDecimalBR(row['valor pago (r$)'] || row['valor pago'] || row.valor_pago || '0')
        });
        imported++;
      }
    });
    batch();

    req.db.prepare(`INSERT INTO importacoes (tipo, arquivo, registros) VALUES ('pagamentos', @arquivo, @registros)`)
      .run({ arquivo: req.file.originalname, registros: imported });
    dashCacheInvalidate(req.companyKey);
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, imported, message: `${imported} pagamentos importados` });
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

router.post('/import/liquidacoes', (req, res, next) => getUpload(req).single('file')(req, res, next), (req, res) => {
  try {
    const extErr = validarExtensao(req.file.originalname, ['csv', 'txt']);
    if (extErr) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: extErr }); }
    const content = fs.readFileSync(req.file.path, 'utf-8');
    // ── GUARDA: verifica contaminação cruzada ──
    const { bloqueio, empresaDetectada } = analisarArquivo(content, req.file.originalname, req.company);
    if (bloqueio) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: bloqueio, empresaDetectada });
    }
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 2) return res.status(400).json({ error: 'CSV vazio' });

    const header = lines[0].split(';').map(h => h.trim().replace(/"/g, ''));
    const insert = req.db.prepare(`
      INSERT INTO liquidacoes (empenho, gestao, favorecido, processo, data_liquidacao, data_liquidacao_iso, valor, status)
      VALUES (@empenho, @gestao, @favorecido, @processo, @data_liquidacao, @data_liquidacao_iso, @valor, @status)
    `);

    let imported = 0;
    const batch = req.db.transaction(() => {
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(';').map(c => c.trim().replace(/"/g, ''));
        if (cols.length < 3) continue;
        const row = {};
        header.forEach((h, idx) => { row[h.toLowerCase().trim()] = cols[idx] || ''; });

        insert.run({
          empenho: row.empenho || '',
          gestao: row['unidade gestora'] || row.gestao || '',
          favorecido: row.favorecido || '',
          processo: row.processo || '',
          data_liquidacao: row['data liquidação'] || row.data_liquidacao || '',
          data_liquidacao_iso: parseDateBR(row['data liquidação'] || row.data_liquidacao || ''),
          valor: parseDecimalBR(row['valor liquidado'] || row.valor || '0'),
          status: row.status || 'PENDENTE'
        });
        imported++;
      }
    });
    batch();

    req.db.prepare(`INSERT INTO importacoes (tipo, arquivo, registros) VALUES ('liquidacoes', @arquivo, @registros)`)
      .run({ arquivo: req.file.originalname, registros: imported });
    dashCacheInvalidate(req.companyKey);
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, imported, message: `${imported} liquidações importadas` });
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

// ─── RELATÓRIOS ──────────────────────────────────────────────────
router.get('/relatorios/conciliacao', (req, res) => {
  const { from, to, format = 'json' } = req.query;
  let dateFilter = '';
  const params = {};
  if (from) { dateFilter += ' AND e.data_iso >= @from'; params.from = from; }
  if (to) { dateFilter += ' AND e.data_iso <= @to'; params.to = to; }

  const rows = req.db.prepare(`
    SELECT e.id, e.data, e.mes, e.historico, e.debito, e.credito, e.posto, e.status,
           e.contrato_vinculado, e.status_conciliacao,
           v.contrato_num, v.data_vinculacao
    FROM extratos e
    LEFT JOIN vinculacoes v ON v.extrato_id = e.id
    WHERE 1=1 ${dateFilter}
    ORDER BY e.data_iso DESC
  `).all(params);

  if (format === 'csv') {
    const header = 'ID;Data;Mês;Histórico;Débito;Crédito;Posto;Status;Contrato;Conciliação;Data Vinculação\n';
    const csvRows = rows.map(r =>
      `${r.id};${r.data};${r.mes};"${(r.historico||'').replace(/"/g,"'")}";${r.debito||''};${r.credito||''};${r.posto||''};${r.status||''};${r.contrato_vinculado||''};${r.status_conciliacao||''};${r.data_vinculacao||''}`
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=conciliacao_${from||'all'}_${to||'all'}.csv`);
    return res.send('\uFEFF' + header + csvRows);
  }

  res.json({ total: rows.length, data: rows });
});

router.get('/relatorios/por-contrato', (req, res) => {
  const rows = req.db.prepare(`
    SELECT c.numContrato, c.contrato, c.status, c.valor_mensal_liquido,
      COALESCE(SUM(CASE WHEN e.credito > 0 THEN e.credito END), 0) as total_creditos,
      COALESCE(SUM(CASE WHEN e.debito > 0 THEN e.debito END), 0) as total_debitos,
      COUNT(v.id) as vinculacoes
    FROM contratos c
    LEFT JOIN vinculacoes v ON v.contrato_num = c.numContrato
    LEFT JOIN extratos e ON e.id = v.extrato_id
    GROUP BY c.numContrato
    ORDER BY c.contrato
  `).all();
  res.json({ data: rows });
});

// ─── Relatório de Lucro por Contrato ─────────────────────────────
router.get('/relatorios/lucro-por-contrato', (req, res) => {
  const { from, to } = req.query;
  const params = {};
  let nfFilter = '1=1', despFilter = '1=1', recFilter = '1=1';
  if (from) { nfFilter += ' AND n.data_emissao >= @from'; despFilter += ' AND d.data_iso >= @from'; recFilter += ' AND e.data_iso >= @from'; params.from = from; }
  if (to)   { nfFilter += ' AND n.data_emissao <= @to';   despFilter += ' AND d.data_iso <= @to';   recFilter += ' AND e.data_iso <= @to';   params.to   = to;   }

  const contratos = req.db.prepare(`
    SELECT numContrato, contrato, orgao, status, total_pago, valor_mensal_bruto, valor_mensal_liquido,
           vigencia_inicio, vigencia_fim, obs
    FROM contratos ORDER BY contrato
  `).all();

  // Receita real: NFs vinculadas ao contrato no período
  const nfsPorContrato = req.db.prepare(`
    SELECT n.contrato_ref as contrato_num,
           COUNT(*) as qtd_nfs,
           COALESCE(SUM(n.valor_bruto),0) as receita_bruta,
           COALESCE(SUM(n.valor_liquido),0) as receita_liquida,
           COALESCE(SUM(n.retencao),0) as total_retencao
    FROM notas_fiscais n WHERE ${nfFilter} AND n.contrato_ref != ''
    GROUP BY n.contrato_ref
  `).all(params);
  const nfMap = {};
  nfsPorContrato.forEach(n => { nfMap[n.contrato_num] = n; });

  // Receita bancária: créditos conciliados no período
  const recBanc = req.db.prepare(`
    SELECT v.contrato_num, COALESCE(SUM(e.credito),0) as creditos_bancarios, COUNT(*) as qtd_creditos
    FROM vinculacoes v JOIN extratos e ON e.id = v.extrato_id
    WHERE e.credito > 0 AND ${recFilter}
    GROUP BY v.contrato_num
  `).all(params);
  const recBancMap = {};
  recBanc.forEach(r => { recBancMap[r.contrato_num] = r; });

  // Despesas alocadas ao contrato no período
  const despesas = req.db.prepare(`
    SELECT d.contrato_ref,
           COALESCE(SUM(d.valor_bruto),0) as total_despesas,
           COALESCE(SUM(CASE WHEN UPPER(d.categoria) LIKE 'FOLHA%' THEN d.valor_bruto ELSE 0 END),0) as desp_folha,
           COALESCE(SUM(CASE WHEN UPPER(d.categoria) IN ('FORNECEDOR','BOLETOS','PIX_ENVIADO') THEN d.valor_bruto ELSE 0 END),0) as desp_fornecedor,
           COALESCE(SUM(CASE WHEN UPPER(d.categoria) NOT LIKE 'FOLHA%' AND UPPER(d.categoria) NOT IN ('FORNECEDOR','BOLETOS','PIX_ENVIADO') THEN d.valor_bruto ELSE 0 END),0) as desp_outras,
           COUNT(*) as qtd_despesas
    FROM despesas d WHERE ${despFilter} AND d.contrato_ref != ''
    GROUP BY d.contrato_ref
  `).all(params);
  const despMap = {};
  despesas.forEach(d => { despMap[d.contrato_ref] = d; });

  // Evolução mensal por contrato (últimos 6 meses)
  const evolMensal = req.db.prepare(`
    SELECT n.contrato_ref, substr(n.data_emissao,1,7) as mes,
           COALESCE(SUM(n.valor_bruto),0) as receita,
           0 as despesa
    FROM notas_fiscais n WHERE n.data_emissao >= date('now','-6 months') AND n.contrato_ref != ''
    GROUP BY n.contrato_ref, substr(n.data_emissao,1,7)
    ORDER BY mes
  `).all();
  const despMensal = req.db.prepare(`
    SELECT d.contrato_ref, substr(d.data_iso,1,7) as mes,
           COALESCE(SUM(d.valor_bruto),0) as despesa
    FROM despesas d WHERE d.data_iso >= date('now','-6 months') AND d.contrato_ref != ''
    GROUP BY d.contrato_ref, substr(d.data_iso,1,7)
  `).all();

  // Monta mapa de evolução
  const evolMap = {};
  evolMensal.forEach(r => {
    if (!evolMap[r.contrato_ref]) evolMap[r.contrato_ref] = {};
    if (!evolMap[r.contrato_ref][r.mes]) evolMap[r.contrato_ref][r.mes] = { receita: 0, despesa: 0 };
    evolMap[r.contrato_ref][r.mes].receita += r.receita;
  });
  despMensal.forEach(r => {
    if (!evolMap[r.contrato_ref]) evolMap[r.contrato_ref] = {};
    if (!evolMap[r.contrato_ref][r.mes]) evolMap[r.contrato_ref][r.mes] = { receita: 0, despesa: 0 };
    evolMap[r.contrato_ref][r.mes].despesa += r.despesa;
  });

  let totalReceita = 0, totalDespesa = 0, totalRetencao = 0;
  const data = contratos.map(c => {
    const nf    = nfMap[c.numContrato]    || { qtd_nfs: 0, receita_bruta: 0, receita_liquida: 0, total_retencao: 0 };
    const banc  = recBancMap[c.numContrato] || { creditos_bancarios: 0, qtd_creditos: 0 };
    const desp  = despMap[c.numContrato]  || { total_despesas: 0, desp_folha: 0, desp_fornecedor: 0, desp_outras: 0, qtd_despesas: 0 };
    const evolContrato = evolMap[c.numContrato] || {};
    const evolArray = Object.entries(evolContrato).sort(([a],[b]) => a.localeCompare(b))
      .map(([mes, v]) => ({ mes, receita: +v.receita.toFixed(2), despesa: +v.despesa.toFixed(2),
        margem: v.receita > 0 ? +((v.receita - v.despesa) / v.receita * 100).toFixed(1) : 0 }));

    // Receita de referência: NFs do período; fallback total_pago
    const receita = nf.receita_bruta || banc.creditos_bancarios || c.total_pago || 0;
    const lucro   = +(receita - desp.total_despesas).toFixed(2);
    const margem  = receita > 0 ? +((lucro / receita) * 100).toFixed(1) : 0;
    totalReceita  += receita;
    totalDespesa  += desp.total_despesas;
    totalRetencao += nf.total_retencao;

    return {
      numContrato: c.numContrato, contrato: c.contrato, orgao: c.orgao,
      status: c.status, valor_mensal_bruto: c.valor_mensal_bruto,
      vigencia_inicio: c.vigencia_inicio, vigencia_fim: c.vigencia_fim,
      receita_bruta: +receita.toFixed(2),
      receita_liquida: +nf.receita_liquida.toFixed(2),
      total_retencao: +nf.total_retencao.toFixed(2),
      creditos_bancarios: +banc.creditos_bancarios.toFixed(2),
      qtd_nfs: nf.qtd_nfs,
      despesas: +desp.total_despesas.toFixed(2),
      desp_folha: +desp.desp_folha.toFixed(2),
      desp_fornecedor: +desp.desp_fornecedor.toFixed(2),
      desp_outras: +desp.desp_outras.toFixed(2),
      qtd_despesas: desp.qtd_despesas,
      lucro_bruto: lucro, margem_pct: margem,
      evolucao: evolArray,
    };
  }).sort((a, b) => b.lucro_bruto - a.lucro_bruto);

  const totalLucro = +(totalReceita - totalDespesa).toFixed(2);
  res.json({
    data,
    resumo: {
      total_receita:    +totalReceita.toFixed(2),
      total_despesas:   +totalDespesa.toFixed(2),
      total_retencao:   +totalRetencao.toFixed(2),
      lucro_bruto:      totalLucro,
      margem_pct: totalReceita > 0 ? +((totalLucro / totalReceita) * 100).toFixed(1) : 0,
      total_contratos:  data.length,
      contratos_lucro:  data.filter(c => c.margem_pct >= 10).length,
      contratos_alerta: data.filter(c => c.margem_pct >= 0 && c.margem_pct < 10).length,
      contratos_prejuizo: data.filter(c => c.margem_pct < 0).length,
    }
  });
});

router.get('/relatorios/a-receber-por-contrato', (req, res) => {
  const contratos = req.db.prepare(`
    SELECT
      c.numContrato, c.contrato, c.orgao, c.status, c.valor_mensal_liquido,
      COALESCE(SUM(CASE WHEN p.valor_pago > 0 THEN p.valor_pago ELSE 0 END), 0) as total_pago,
      COALESCE(SUM(CASE WHEN (p.valor_pago IS NULL OR p.valor_pago = 0)
        AND p.status NOT IN ('✅ PAGO','🧾 PARCIAL','🧾 RETENÇÃO','⏳ FUTURO')
        THEN p.valor_liquido ELSE 0 END), 0) as a_receber,
      COALESCE(SUM(CASE WHEN p.status LIKE '%EM ATRASO%' OR p.status LIKE '%EM ABERTO%' OR p.status LIKE '%TÉRMINO%'
        THEN p.valor_liquido ELSE 0 END), 0) as em_atraso,
      COALESCE(SUM(CASE WHEN p.status LIKE '%EMITIR NF%'
        THEN p.valor_liquido ELSE 0 END), 0) as emitir_nf,
      GROUP_CONCAT(DISTINCT p.status) as status_parcelas,
      COUNT(DISTINCT CASE WHEN (p.valor_pago IS NULL OR p.valor_pago = 0)
        AND p.status NOT IN ('✅ PAGO','🧾 PARCIAL','🧾 RETENÇÃO','⏳ FUTURO')
        THEN p.id END) as qtd_pendentes,
      p2.competencia as ultima_competencia, p2.data_pagamento as ultimo_pgto
    FROM contratos c
    LEFT JOIN parcelas p ON p.contrato_num = c.numContrato
    LEFT JOIN (
      SELECT contrato_num, competencia, data_pagamento
      FROM parcelas WHERE valor_pago > 0
      ORDER BY id DESC LIMIT 1
    ) p2 ON p2.contrato_num = c.numContrato
    GROUP BY c.numContrato
    ORDER BY a_receber DESC, em_atraso DESC
  `).all();

  const totalAReceber = contratos.reduce((s, c) => s + c.a_receber, 0);
  const totalEmAtraso = contratos.reduce((s, c) => s + c.em_atraso, 0);
  const totalEmitirNF = contratos.reduce((s, c) => s + c.emitir_nf, 0);
  const totalPago = contratos.reduce((s, c) => s + c.total_pago, 0);

  res.json({
    data: contratos,
    resumo: {
      total_a_receber: +totalAReceber.toFixed(2),
      total_em_atraso: +totalEmAtraso.toFixed(2),
      total_emitir_nf: +totalEmitirNF.toFixed(2),
      total_pago: +totalPago.toFixed(2),
      qtd_contratos: contratos.length,
      qtd_com_pendencia: contratos.filter(c => c.a_receber > 0).length
    }
  });
});

router.get('/relatorios/fluxo-caixa', (req, res) => {
  const rows = req.db.prepare(`
    SELECT
      substr(data_iso, 1, 7) as mes_ano,
      COALESCE(SUM(credito), 0) as entradas,
      COALESCE(SUM(debito), 0) as saidas,
      COALESCE(SUM(credito), 0) - COALESCE(SUM(debito), 0) as saldo
    FROM extratos
    WHERE data_iso != ''
    GROUP BY substr(data_iso, 1, 7)
    ORDER BY mes_ano
  `).all();

  let acumulado = 0;
  const data = rows.map(r => {
    acumulado += r.saldo;
    return { ...r, acumulado };
  });

  res.json({ data });
});

// ─── EXPORT EXCEL ────────────────────────────────────────────────
const BRL_FMT = '#,##0.00';
const BORDER_THIN = { top:{style:'thin',color:{argb:'FFE2E8F0'}}, bottom:{style:'thin',color:{argb:'FFE2E8F0'}}, left:{style:'thin',color:{argb:'FFE2E8F0'}}, right:{style:'thin',color:{argb:'FFE2E8F0'}} };
const ZEBRA_LIGHT = { type:'pattern', pattern:'solid', fgColor:{argb:'FFF8FAFC'} };

function formatSheet(ws, headerColor, moneyKeys, title) {
  const headerRow = title ? 3 : 1;
  const dataStart = headerRow + 1;
  if (title) {
    ws.mergeCells(1, 1, 1, ws.columns.length);
    const titleCell = ws.getCell('A1');
    titleCell.value = title;
    titleCell.font = { bold: true, size: 14, color: { argb: 'FF0F172A' } };
    titleCell.alignment = { horizontal: 'left', vertical: 'middle' };
    ws.getRow(1).height = 28;
    ws.mergeCells(2, 1, 2, ws.columns.length);
    const dateCell = ws.getCell('A2');
    dateCell.value = 'Gerado em: ' + new Date().toLocaleDateString('pt-BR') + ' às ' + new Date().toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'});
    dateCell.font = { size: 9, color: { argb: 'FF94A3B8' } };
    ws.getRow(2).height = 16;
    ws.getRow(headerRow).font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    ws.getRow(headerRow).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headerColor } };
    ws.getRow(headerRow).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    ws.getRow(headerRow).height = 22;
    ws.getRow(headerRow).eachCell(c => { c.border = BORDER_THIN; });
  } else {
    ws.getRow(1).font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headerColor } };
    ws.getRow(1).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    ws.getRow(1).height = 22;
    ws.getRow(1).eachCell(c => { c.border = BORDER_THIN; });
  }
  for (let i = dataStart; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    row.alignment = { vertical: 'middle' };
    if ((i - dataStart) % 2 === 1) row.eachCell({ includeEmpty: true }, c => { c.fill = ZEBRA_LIGHT; });
    row.eachCell(c => { c.border = BORDER_THIN; c.font = { size: 10 }; });
    if (moneyKeys.length) {
      ws.columns.forEach((col, idx) => {
        if (moneyKeys.includes(col.key)) {
          const cell = row.getCell(idx + 1);
          if (typeof cell.value === 'number') cell.numFmt = BRL_FMT;
        }
      });
    }
  }
  ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: ws.columns.length } };
  ws.views = [{ state: 'frozen', ySplit: headerRow }];
}

router.get('/relatorios/excel', async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const { from, to, tipo = 'conciliacao' } = req.query;
    const periodo = from && to ? `${from} a ${to}` : from ? `A partir de ${from}` : to ? `Até ${to}` : 'Todos os períodos';

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Montana Segurança Conciliação';
    wb.created = new Date();

    if (tipo === 'conciliacao' || tipo === 'completo') {
      const ws = wb.addWorksheet('Conciliação');
      let dateFilter = '';
      const params = {};
      if (from) { dateFilter += ' AND e.data_iso >= ?'; params.from = from; }
      if (to) { dateFilter += ' AND e.data_iso <= ?'; params.to = to; }

      const rows = req.db.prepare(`
        SELECT e.*, v.contrato_num, v.data_vinculacao
        FROM extratos e LEFT JOIN vinculacoes v ON v.extrato_id = e.id
        WHERE 1=1 ${dateFilter.replace(/@\w+/g, '?')}
        ORDER BY e.data_iso DESC
      `).all(...Object.values(params));

      ws.columns = [
        { header: 'ID', key: 'id', width: 8 },
        { header: 'Data', key: 'data', width: 12 },
        { header: 'Mês', key: 'mes', width: 8 },
        { header: 'Histórico', key: 'historico', width: 40 },
        { header: 'Débito', key: 'debito', width: 15 },
        { header: 'Crédito', key: 'credito', width: 15 },
        { header: 'Posto', key: 'posto', width: 25 },
        { header: 'Status', key: 'status', width: 20 },
        { header: 'Contrato', key: 'contrato_vinculado', width: 20 },
        { header: 'Conciliação', key: 'status_conciliacao', width: 15 },
      ];

      rows.forEach(r => ws.addRow(r));
      formatSheet(ws, 'FF1D4ED8', ['debito','credito'], 'Conciliação Bancária — ' + periodo);
    }

    if (tipo === 'pagamentos' || tipo === 'completo') {
      const ws2 = wb.addWorksheet('Pagamentos');
      let pgFilter = '';
      const pgParams = {};
      if (from) { pgFilter += ' AND data_pagamento_iso >= ?'; pgParams.from = from; }
      if (to) { pgFilter += ' AND data_pagamento_iso <= ?'; pgParams.to = to; }
      const pgs = req.db.prepare(`SELECT * FROM pagamentos WHERE 1=1 ${pgFilter} ORDER BY data_pagamento_iso DESC`).all(...Object.values(pgParams));
      ws2.columns = [
        { header: 'OB', key: 'ob', width: 20 },
        { header: 'Gestão', key: 'gestao', width: 30 },
        { header: 'Empenho', key: 'empenho', width: 15 },
        { header: 'Favorecido', key: 'favorecido', width: 35 },
        { header: 'Data Pgto', key: 'data_pagamento', width: 12 },
        { header: 'Valor Pago', key: 'valor_pago', width: 15 },
      ];
      pgs.forEach(r => ws2.addRow(r));
      formatSheet(ws2, 'FF15803D', ['valor_pago'], 'Pagamentos Recebidos — ' + periodo);
    }

    if (tipo === 'contratos' || tipo === 'completo') {
      const ws3 = wb.addWorksheet('Contratos');
      const conts = req.db.prepare(`SELECT * FROM contratos ORDER BY contrato`).all();
      ws3.columns = [
        { header: 'Contrato', key: 'numContrato', width: 25 },
        { header: 'Órgão', key: 'contrato', width: 45 },
        { header: 'Vigência Início', key: 'vigencia_inicio', width: 15 },
        { header: 'Vigência Fim', key: 'vigencia_fim', width: 15 },
        { header: 'Valor Mensal Líq.', key: 'valor_mensal_liquido', width: 18 },
        { header: 'Valor Mensal Bruto', key: 'valor_mensal_bruto', width: 18 },
        { header: 'Total Pago', key: 'total_pago', width: 18 },
        { header: 'Total Aberto', key: 'total_aberto', width: 18 },
        { header: 'Status', key: 'status', width: 20 },
        { header: 'Obs', key: 'obs', width: 40 },
      ];
      conts.forEach(r => ws3.addRow(r));
      formatSheet(ws3, 'FF7C3AED', ['valor_mensal_liquido','valor_mensal_bruto','total_pago','total_aberto'], 'Contratos Ativos');

      // Parcelas sheet
      const ws3b = wb.addWorksheet('Parcelas');
      const parcs = req.db.prepare(`SELECT * FROM parcelas ORDER BY contrato_num, id`).all();
      ws3b.columns = [
        { header: 'Contrato', key: 'contrato_num', width: 25 },
        { header: 'Competência', key: 'competencia', width: 25 },
        { header: 'Valor Líquido', key: 'valor_liquido', width: 15 },
        { header: 'Valor Bruto', key: 'valor_bruto', width: 15 },
        { header: 'Valor Pago', key: 'valor_pago', width: 15 },
        { header: 'Data Pgto', key: 'data_pagamento', width: 15 },
        { header: 'Status', key: 'status', width: 20 },
        { header: 'Obs', key: 'obs', width: 35 },
      ];
      parcs.forEach(r => ws3b.addRow(r));
      formatSheet(ws3b, 'FF7C3AED', ['valor_liquido','valor_bruto','valor_pago'], 'Parcelas por Contrato');
    }

    if (tipo === 'despesas' || tipo === 'completo') {
      const ws4 = wb.addWorksheet('Despesas');
      let dFilter = '';
      const dParams = {};
      if (from) { dFilter += ' AND data_iso >= ?'; dParams.from = from; }
      if (to) { dFilter += ' AND data_iso <= ?'; dParams.to = to; }
      const desps = req.db.prepare(`SELECT * FROM despesas WHERE 1=1 ${dFilter} ORDER BY data_iso DESC`).all(...Object.values(dParams));
      ws4.columns = [
        { header: 'Data', key: 'data_despesa', width: 12 },
        { header: 'Categoria', key: 'categoria', width: 15 },
        { header: 'Fornecedor', key: 'fornecedor', width: 30 },
        { header: 'CNPJ', key: 'cnpj_fornecedor', width: 20 },
        { header: 'NF', key: 'nf_numero', width: 12 },
        { header: 'Descrição', key: 'descricao', width: 35 },
        { header: 'Competência', key: 'competencia', width: 12 },
        { header: 'Valor Bruto', key: 'valor_bruto', width: 15 },
        { header: 'IRRF', key: 'irrf', width: 12 },
        { header: 'CSLL', key: 'csll', width: 12 },
        { header: 'PIS', key: 'pis_retido', width: 12 },
        { header: 'COFINS', key: 'cofins_retido', width: 12 },
        { header: 'INSS', key: 'inss_retido', width: 12 },
        { header: 'Total Retenção', key: 'total_retencao', width: 15 },
        { header: 'Valor Líquido', key: 'valor_liquido', width: 15 },
        { header: 'Status', key: 'status', width: 12 },
      ];
      desps.forEach(r => ws4.addRow(r));
      formatSheet(ws4, 'FFDC2626', ['valor_bruto','irrf','csll','pis_retido','cofins_retido','inss_retido','total_retencao','valor_liquido'], 'Despesas e Retenções — ' + periodo);
    }

    if (tipo === 'nfs' || tipo === 'completo') {
      const ws5 = wb.addWorksheet('Notas Fiscais');
      const nfs = req.db.prepare(`SELECT * FROM notas_fiscais ORDER BY id DESC`).all();
      ws5.columns = [
        { header: 'Número', key: 'numero', width: 12 },
        { header: 'Competência', key: 'competencia', width: 12 },
        { header: 'Cidade', key: 'cidade', width: 20 },
        { header: 'Tomador', key: 'tomador', width: 35 },
        { header: 'Valor Bruto', key: 'valor_bruto', width: 15 },
        { header: 'Valor Líquido', key: 'valor_liquido', width: 15 },
        { header: 'INSS', key: 'inss', width: 12 },
        { header: 'IR', key: 'ir', width: 12 },
        { header: 'ISS', key: 'iss', width: 12 },
        { header: 'CSLL', key: 'csll', width: 12 },
        { header: 'PIS', key: 'pis', width: 12 },
        { header: 'COFINS', key: 'cofins', width: 12 },
        { header: 'Retenção', key: 'retencao', width: 15 },
      ];
      nfs.forEach(r => ws5.addRow(r));
      formatSheet(ws5, 'FFD97706', ['valor_bruto','valor_liquido','inss','ir','iss','csll','pis','cofins','retencao'], 'Notas Fiscais Emitidas');
    }

    if (tipo === 'apuracao' || tipo === 'completo') {
      const wsAp = wb.addWorksheet('Apuração PIS-COFINS');

      // Base: NFs EMITIDAS no período (competência) — NFs de anos anteriores já foram
      // apuradas/pagas em seus respectivos anos e não geram novo tributo em 2026
      let apNFFilter = '1=1';
      const apParams = {};
      if (from) { apNFFilter += ' AND data_emissao >= @from'; apParams.from = from; }
      if (to)   { apNFFilter += ' AND data_emissao <= @to';   apParams.to = to; }

      const apReceita = req.db.prepare(`
        SELECT COALESCE(SUM(valor_bruto),0) as total, COALESCE(SUM(valor_liquido),0) as liquido
        FROM notas_fiscais WHERE ${apNFFilter}
      `).get(apParams);

      const apRetNFs = req.db.prepare(`
        SELECT COALESCE(SUM(pis),0) as pis, COALESCE(SUM(cofins),0) as cofins,
               COALESCE(SUM(inss),0) as inss, COALESCE(SUM(ir),0) as irrf,
               COALESCE(SUM(retencao),0) as total_ret
        FROM notas_fiscais WHERE ${apNFFilter}
      `).get(apParams);

      const apPorMes = req.db.prepare(`
        SELECT substr(data_emissao,1,7) as mes_iso,
               CASE substr(data_emissao,6,2)
                 WHEN '01' THEN 'JAN' WHEN '02' THEN 'FEV' WHEN '03' THEN 'MAR'
                 WHEN '04' THEN 'ABR' WHEN '05' THEN 'MAI' WHEN '06' THEN 'JUN'
                 WHEN '07' THEN 'JUL' WHEN '08' THEN 'AGO' WHEN '09' THEN 'SET'
                 WHEN '10' THEN 'OUT' WHEN '11' THEN 'NOV' WHEN '12' THEN 'DEZ'
               END as mes,
               CAST(substr(data_emissao,1,4) AS INTEGER) as ano,
               COALESCE(SUM(valor_bruto),0) as recebido,
               COUNT(*) as qtd,
               COALESCE(SUM(pis),0) as pis_ret,
               COALESCE(SUM(cofins),0) as cofins_ret
        FROM notas_fiscais WHERE ${apNFFilter} AND data_emissao != ''
        GROUP BY substr(data_emissao,1,7)
        ORDER BY substr(data_emissao,1,7)
      `).all(apParams);

      const totalRec = apPorMes.reduce((s,m) => s + m.recebido, 0);

      wsAp.columns = [
        { header: 'Descrição', key: 'desc', width: 35 },
        { header: 'PIS (1,65%)', key: 'pis', width: 18 },
        { header: 'COFINS (7,6%)', key: 'cofins', width: 18 },
      ];
      wsAp.getRow(1).font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
      wsAp.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
      wsAp.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };
      wsAp.getRow(1).height = 22;
      wsAp.getRow(1).eachCell(c => { c.border = BORDER_THIN; });

      const apBase = apReceita.total; // NFs emitidas no período
      wsAp.addRow({ desc: 'REGIME: LUCRO REAL — NÃO CUMULATIVO — ' + periodo, pis: '', cofins: '' });
      wsAp.addRow({ desc: 'Base: NFs emitidas no período (competência) — NFs de anos anteriores já apuradas', pis: '', cofins: '' });
      wsAp.addRow({ desc: '', pis: '', cofins: '' });
      wsAp.addRow({ desc: 'Receita Bruta (NFs emitidas)', pis: apBase, cofins: apBase });
      wsAp.addRow({ desc: 'Imposto Bruto', pis: +(apBase * 0.0165).toFixed(2), cofins: +(apBase * 0.076).toFixed(2) });
      wsAp.addRow({ desc: '(-) Retenções na Fonte (NFs do período)', pis: -apRetNFs.pis, cofins: -apRetNFs.cofins });
      wsAp.addRow({ desc: '= IMPOSTO A PAGAR', pis: Math.max(+(apBase * 0.0165 - apRetNFs.pis).toFixed(2), 0), cofins: Math.max(+(apBase * 0.076 - apRetNFs.cofins).toFixed(2), 0) });
      const totalRow = wsAp.getRow(wsAp.rowCount);
      totalRow.font = { bold: true, size: 11 };
      totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0F2FE' } };
      for (let i = 2; i <= wsAp.rowCount; i++) {
        [2,3].forEach(col => { const c = wsAp.getRow(i).getCell(col); if (typeof c.value === 'number') c.numFmt = BRL_FMT; c.border = BORDER_THIN; });
        wsAp.getRow(i).getCell(1).border = BORDER_THIN;
      }

      // Detalhamento por mês
      const wsMes = wb.addWorksheet('Apuração por Mês');
      wsMes.columns = [
        { header: 'Competência', key: 'mes', width: 15 },
        { header: 'Recebido', key: 'recebido', width: 18 },
        { header: 'Créditos', key: 'qtd', width: 10 },
        { header: 'PIS Bruto', key: 'pis_bruto', width: 15 },
        { header: 'PIS Crédito', key: 'pis_cred', width: 15 },
        { header: 'PIS Líquido', key: 'pis_liq', width: 15 },
        { header: 'COFINS Bruto', key: 'cofins_bruto', width: 15 },
        { header: 'COFINS Crédito', key: 'cofins_cred', width: 15 },
        { header: 'COFINS Líquido', key: 'cofins_liq', width: 15 },
        { header: 'Vencimento', key: 'venc', width: 12 },
        { header: 'Status', key: 'status', width: 12 },
      ];
      const hoje = new Date().toISOString().split('T')[0];
      apPorMes.forEach(m => {
        const ano = m.ano || 2026;
        const pisBruto = +(m.recebido * 0.0165).toFixed(2);
        const cofinsBruto = +(m.recebido * 0.076).toFixed(2);
        const pisCred = +m.pis_ret.toFixed(2);   // retenção real da NF do mês
        const cofinsCred = +m.cofins_ret.toFixed(2);
        const mesIdx = MES_NUM[m.mes] || 1;
        let vM = mesIdx + 1, vA = ano;
        if(vM > 12) { vM = 1; vA++; }
        const venc = `25/${String(vM).padStart(2,'0')}/${vA}`;
        const vencIso = `${vA}-${String(vM).padStart(2,'0')}-25`;
        const isPago = ano < 2026;
        const status = isPago ? 'PAGO' : vencIso < hoje ? 'VENCIDO' : 'A PAGAR';
        wsMes.addRow({
          mes: m.mes + '/' + ano, recebido: m.recebido, qtd: m.qtd,
          pis_bruto: pisBruto, pis_cred: pisCred, pis_liq: Math.max(pisBruto - pisCred, 0),
          cofins_bruto: cofinsBruto, cofins_cred: cofinsCred, cofins_liq: Math.max(cofinsBruto - cofinsCred, 0),
          venc, status
        });
      });
      formatSheet(wsMes, 'FF1D4ED8', ['recebido','pis_bruto','pis_cred','pis_liq','cofins_bruto','cofins_cred','cofins_liq'], 'Apuração PIS/COFINS por Mês — Regime de Caixa');
    }

    if (tipo === 'a-receber' || tipo === 'completo') {
      const wsAR = wb.addWorksheet('A Receber');
      const contratosAR = req.db.prepare(`
        SELECT
          c.numContrato, c.contrato, c.status as status_contrato, c.valor_mensal_liquido,
          COALESCE(SUM(CASE WHEN p.valor_pago > 0 THEN p.valor_pago ELSE 0 END), 0) as total_pago,
          COALESCE(SUM(CASE WHEN (p.valor_pago IS NULL OR p.valor_pago = 0)
            AND p.status NOT IN ('✅ PAGO','🧾 PARCIAL','🧾 RETENÇÃO','⏳ FUTURO')
            THEN p.valor_liquido ELSE 0 END), 0) as a_receber,
          COALESCE(SUM(CASE WHEN p.status LIKE '%EM ATRASO%' OR p.status LIKE '%EM ABERTO%' OR p.status LIKE '%TÉRMINO%'
            THEN p.valor_liquido ELSE 0 END), 0) as em_atraso,
          COALESCE(SUM(CASE WHEN p.status LIKE '%EMITIR NF%' THEN p.valor_liquido ELSE 0 END), 0) as emitir_nf,
          COUNT(DISTINCT CASE WHEN (p.valor_pago IS NULL OR p.valor_pago = 0)
            AND p.status NOT IN ('✅ PAGO','🧾 PARCIAL','🧾 RETENÇÃO','⏳ FUTURO') THEN p.id END) as qtd_pendentes
        FROM contratos c LEFT JOIN parcelas p ON p.contrato_num = c.numContrato
        GROUP BY c.numContrato ORDER BY a_receber DESC
      `).all();

      wsAR.columns = [
        { header: 'Contrato', key: 'numContrato', width: 30 },
        { header: 'Órgão', key: 'contrato', width: 50 },
        { header: 'Status Contrato', key: 'status_contrato', width: 20 },
        { header: 'Mensal Líq.', key: 'valor_mensal_liquido', width: 18 },
        { header: 'Total Pago', key: 'total_pago', width: 18 },
        { header: 'A RECEBER', key: 'a_receber', width: 18 },
        { header: 'Em Atraso', key: 'em_atraso', width: 18 },
        { header: 'Emitir NF', key: 'emitir_nf', width: 18 },
        { header: 'Parc. Pend.', key: 'qtd_pendentes', width: 12 },
      ];
      contratosAR.forEach(r => {
        const row = wsAR.addRow(r);
        if (r.em_atraso > 0) row.getCell('em_atraso').font = { color: { argb: 'FFDC2626' }, bold: true };
        if (r.emitir_nf > 0) row.getCell('emitir_nf').font = { color: { argb: 'FFD97706' }, bold: true };
        if (r.a_receber > 0) row.getCell('a_receber').font = { color: { argb: 'FF15803D' }, bold: true };
      });

      // Linha de total
      const totalRow = wsAR.addRow({
        numContrato: 'TOTAL GERAL', contrato: '', status_contrato: '',
        valor_mensal_liquido: contratosAR.reduce((s,c) => s+c.valor_mensal_liquido, 0),
        total_pago: contratosAR.reduce((s,c) => s+c.total_pago, 0),
        a_receber: contratosAR.reduce((s,c) => s+c.a_receber, 0),
        em_atraso: contratosAR.reduce((s,c) => s+c.em_atraso, 0),
        emitir_nf: contratosAR.reduce((s,c) => s+c.emitir_nf, 0),
        qtd_pendentes: contratosAR.reduce((s,c) => s+c.qtd_pendentes, 0),
      });
      totalRow.font = { bold: true, size: 11 };
      totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0F2FE' } };

      formatSheet(wsAR, 'FF0F172A', ['valor_mensal_liquido','total_pago','a_receber','em_atraso','emitir_nf'], 'A Receber por Contrato — ' + new Date().toLocaleDateString('pt-BR'));
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=relatorio_montana_${tipo}.xlsx`);
    await wb.xlsx.write(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DESPESAS (CRUD) ────────────────────────────────────────────
const RETENCAO_SERVICO = { irrf: 0.015, csll: 0.01, pis: 0.0065, cofins: 0.03, inss: 0.11 };
const LIMITE_RETENCAO = 215.05;

function calcRetencoes(categoria, valor_bruto) {
  const ret = { irrf: 0, csll: 0, pis_retido: 0, cofins_retido: 0, inss_retido: 0, iss_retido: 0 };
  if (categoria === 'SERVICO' && valor_bruto > LIMITE_RETENCAO) {
    ret.irrf = +(valor_bruto * RETENCAO_SERVICO.irrf).toFixed(2);
    ret.csll = +(valor_bruto * RETENCAO_SERVICO.csll).toFixed(2);
    ret.pis_retido = +(valor_bruto * RETENCAO_SERVICO.pis).toFixed(2);
    ret.cofins_retido = +(valor_bruto * RETENCAO_SERVICO.cofins).toFixed(2);
    ret.inss_retido = +(valor_bruto * RETENCAO_SERVICO.inss).toFixed(2);
  }
  ret.total_retencao = +(ret.irrf + ret.csll + ret.pis_retido + ret.cofins_retido + ret.inss_retido + ret.iss_retido).toFixed(2);
  ret.valor_liquido = +(valor_bruto - ret.total_retencao).toFixed(2);
  return ret;
}

router.get('/despesas', (req, res) => {
  const { categoria, fornecedor, status, from, to, contrato_ref, page = 1, limit = 100 } = req.query;
  let where = '1=1';
  const params = {};
  if (categoria) { where += ' AND categoria = @categoria'; params.categoria = categoria; }
  if (fornecedor) { where += ' AND fornecedor = @fornecedor'; params.fornecedor = fornecedor; }
  if (status) { where += ' AND status = @status'; params.status = status; }
  if (from) { where += ' AND data_iso >= @from'; params.from = from; }
  if (to) { where += ' AND data_iso <= @to'; params.to = to; }
  if (contrato_ref) { where += ' AND contrato_ref = @contrato_ref'; params.contrato_ref = contrato_ref; }
  const offset = (parseInt(page) - 1) * parseInt(limit);
  params.limit = parseInt(limit); params.offset = offset;

  const total = req.db.prepare(`SELECT COUNT(*) as cnt FROM despesas WHERE ${where}`).get(params).cnt;
  const rows = req.db.prepare(`SELECT * FROM despesas WHERE ${where} ORDER BY data_iso DESC, id DESC LIMIT @limit OFFSET @offset`).all(params);
  res.json({ total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)), data: rows });
});

router.get('/despesas/resumo', (req, res) => {
  const { from, to } = req.query;
  let dateFilter = '';
  const params = {};
  if (from) { dateFilter += ' AND data_iso >= @from'; params.from = from; }
  if (to) { dateFilter += ' AND data_iso <= @to'; params.to = to; }

  const totais = req.db.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(valor_bruto), 0) as total_bruto,
      COALESCE(SUM(valor_liquido), 0) as total_liquido,
      COALESCE(SUM(total_retencao), 0) as total_retencoes,
      COALESCE(SUM(irrf), 0) as total_irrf,
      COALESCE(SUM(csll), 0) as total_csll,
      COALESCE(SUM(pis_retido), 0) as total_pis,
      COALESCE(SUM(cofins_retido), 0) as total_cofins,
      COALESCE(SUM(inss_retido), 0) as total_inss,
      COUNT(CASE WHEN status = 'PAGO' THEN 1 END) as pagos,
      COUNT(CASE WHEN status = 'PENDENTE' THEN 1 END) as pendentes
    FROM despesas WHERE 1=1 ${dateFilter}
  `).get(params);

  const porCategoria = req.db.prepare(`
    SELECT categoria, COUNT(*) as qtd, COALESCE(SUM(valor_bruto), 0) as total
    FROM despesas WHERE 1=1 ${dateFilter}
    GROUP BY categoria ORDER BY total DESC
  `).all(params);

  res.json({ totais, porCategoria });
});

router.get('/despesas/compensacao', (req, res) => {
  const { competencia } = req.query;
  let nfFilter = '', despFilter = '';
  const nfParams = {}, despParams = {};
  if (competencia) {
    nfFilter = ' AND competencia = @comp'; nfParams.comp = competencia;
    despFilter = ' AND competencia = @comp'; despParams.comp = competencia;
  }

  // PIS/COFINS devidos sobre receita (não-cumulativo — Lucro Real)
  const receita = req.db.prepare(`
    SELECT COALESCE(SUM(valor_bruto), 0) as receita_bruta,
           COALESCE(SUM(pis), 0) as pis_retido_clientes,
           COALESCE(SUM(cofins), 0) as cofins_retido_clientes
    FROM notas_fiscais WHERE 1=1 ${nfFilter}
  `).get(nfParams);

  const pis_devido = +(receita.receita_bruta * 0.0165).toFixed(2);
  const cofins_devido = +(receita.receita_bruta * 0.076).toFixed(2);
  const pis_a_pagar = +(pis_devido - receita.pis_retido_clientes).toFixed(2);
  const cofins_a_pagar = +(cofins_devido - receita.cofins_retido_clientes).toFixed(2);

  // Retenções feitas sobre despesas (informativo)
  const retDesp = req.db.prepare(`
    SELECT COALESCE(SUM(pis_retido), 0) as pis_feito,
           COALESCE(SUM(cofins_retido), 0) as cofins_feito,
           COALESCE(SUM(irrf), 0) as irrf_feito,
           COALESCE(SUM(csll), 0) as csll_feito,
           COALESCE(SUM(inss_retido), 0) as inss_feito,
           COALESCE(SUM(total_retencao), 0) as total_retido
    FROM despesas WHERE 1=1 ${despFilter}
  `).get(despParams);

  res.json({
    receita_bruta: receita.receita_bruta,
    pis_devido, cofins_devido,
    pis_retido_clientes: receita.pis_retido_clientes,
    cofins_retido_clientes: receita.cofins_retido_clientes,
    pis_a_pagar: Math.max(pis_a_pagar, 0),
    cofins_a_pagar: Math.max(cofins_a_pagar, 0),
    pis_credito: pis_a_pagar < 0 ? Math.abs(pis_a_pagar) : 0,
    cofins_credito: cofins_a_pagar < 0 ? Math.abs(cofins_a_pagar) : 0,
    retencoes_despesas: retDesp
  });
});

// ─── APURAÇÃO PIS/COFINS REGIME DE CAIXA ─────────────────────────
const MES_NUM = {JAN:1,FEV:2,MAR:3,ABR:4,MAI:5,JUN:6,JUL:7,AGO:8,SET:9,OUT:10,NOV:11,DEZ:12};

function calcVencimento(mes, ano) {
  // Vencimento: dia 25 do mês seguinte ao recebimento
  const m = MES_NUM[mes] || 1;
  let vencMes = m + 1;
  let vencAno = ano;
  if (vencMes > 12) { vencMes = 1; vencAno++; }
  return `${vencAno}-${String(vencMes).padStart(2,'0')}-25`;
}

router.get('/apuracao-caixa', (req, res) => {
  const { from, to } = req.query;
  let dateFilter = '';
  const params = {};
  if (from) { dateFilter += ' AND data_iso >= @from'; params.from = from; }
  if (to) { dateFilter += ' AND data_iso <= @to'; params.to = to; }

  // Filtro base: apenas receitas reais de contratos (exclui transferências internas, boletos devolvidos)
  // E apenas competências de 2026+ (2025 já apurado no regime anterior)
  const receitaFilter = `
    AND credito > 0
    AND status NOT LIKE '%TRANSFER_NCIA INTERNA%'
    AND status NOT LIKE '%TRANSFERÊNCIA INTERNA%'
    AND status NOT LIKE '%BOLETO DEVOLVIDO%'
    AND (competencia LIKE '%/26%' OR competencia LIKE '%/2026%' OR competencia LIKE '%/27%' OR competencia LIKE '%/2027%')
  `;

  // 1. Receita efetivamente recebida (apenas receita de contratos, comp. 2026+)
  const receita = req.db.prepare(`
    SELECT COALESCE(SUM(credito), 0) as total_recebido,
           COUNT(*) as qtd_creditos
    FROM extratos WHERE 1=1 ${dateFilter} ${receitaFilter}
  `).get(params);

  // Receita excluída (transferências internas + comp. 2025)
  const excluida = req.db.prepare(`
    SELECT COALESCE(SUM(credito), 0) as total_excluido,
           COUNT(*) as qtd_excluidos
    FROM extratos WHERE credito > 0 ${dateFilter}
    AND (status LIKE '%TRANSFER_NCIA INTERNA%' OR status LIKE '%TRANSFERÊNCIA INTERNA%'
         OR status LIKE '%BOLETO DEVOLVIDO%'
         OR (competencia NOT LIKE '%/26%' AND competencia NOT LIKE '%/2026%'
             AND competencia NOT LIKE '%/27%' AND competencia NOT LIKE '%/2027%'))
  `).get(params);

  // 2. Retenções sofridas na fonte em NFs de competência 2026+ — são CRÉDITOS a deduzir
  const retencoes = req.db.prepare(`
    SELECT COALESCE(SUM(pis), 0) as pis_retido,
           COALESCE(SUM(cofins), 0) as cofins_retido,
           COALESCE(SUM(retencao), 0) as total_retencao
    FROM notas_fiscais
    WHERE competencia LIKE '%/26%' OR competencia LIKE '%jan/26%' OR competencia LIKE '%fev/26%' OR competencia LIKE '%mar/26%'
  `).get();

  // 3. Apuração PIS/COFINS pelo regime de caixa — Lucro Real não-cumulativo
  const receita_base = receita.total_recebido;
  const pis_devido = +(receita_base * 0.0165).toFixed(2);
  const cofins_devido = +(receita_base * 0.076).toFixed(2);
  const pis_a_pagar = +(pis_devido - retencoes.pis_retido).toFixed(2);
  const cofins_a_pagar = +(cofins_devido - retencoes.cofins_retido).toFixed(2);

  // 4. Detalhamento por mês com data de vencimento e status
  const porMes = req.db.prepare(`
    SELECT mes,
           COALESCE(SUM(credito), 0) as recebido,
           COUNT(*) as qtd,
           MIN(SUBSTR(data_iso, 1, 4)) as ano
    FROM extratos WHERE 1=1 ${dateFilter} ${receitaFilter}
    GROUP BY mes ORDER BY CASE mes WHEN 'JAN' THEN 1 WHEN 'FEV' THEN 2 WHEN 'MAR' THEN 3
      WHEN 'ABR' THEN 4 WHEN 'MAI' THEN 5 WHEN 'JUN' THEN 6
      WHEN 'JUL' THEN 7 WHEN 'AGO' THEN 8 WHEN 'SET' THEN 9
      WHEN 'OUT' THEN 10 WHEN 'NOV' THEN 11 WHEN 'DEZ' THEN 12 END
  `).all(params);

  const hoje = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // Distribuir créditos das NFs proporcionalmente por mês
  const totalRecebido = porMes.reduce((s, m) => s + m.recebido, 0);

  res.json({
    receita_recebida: receita_base,
    qtd_creditos: receita.qtd_creditos,
    excluido_total: excluida.total_excluido,
    excluido_qtd: excluida.qtd_excluidos,
    pis_devido,
    cofins_devido,
    pis_retido: retencoes.pis_retido,
    cofins_retido: retencoes.cofins_retido,
    pis_a_pagar: Math.max(pis_a_pagar, 0),
    cofins_a_pagar: Math.max(cofins_a_pagar, 0),
    pis_credito: pis_a_pagar < 0 ? Math.abs(pis_a_pagar) : 0,
    cofins_credito: cofins_a_pagar < 0 ? Math.abs(cofins_a_pagar) : 0,
    por_mes: porMes.map(m => {
      const ano = parseInt(m.ano) || 2026;
      const vencimento = calcVencimento(m.mes, ano);
      const pis_mes = +(m.recebido * 0.0165).toFixed(2);
      const cofins_mes = +(m.recebido * 0.076).toFixed(2);
      // Créditos de retenção proporcionais ao recebido no mês
      const proporcao = totalRecebido > 0 ? m.recebido / totalRecebido : 0;
      const pis_credito_mes = +(retencoes.pis_retido * proporcao).toFixed(2);
      const cofins_credito_mes = +(retencoes.cofins_retido * proporcao).toFixed(2);
      const pis_liquido = +(pis_mes - pis_credito_mes).toFixed(2);
      const cofins_liquido = +(cofins_mes - cofins_credito_mes).toFixed(2);
      // Competências de 2025 já estão pagas
      const isPago = ano <= 2025;
      const isVencido = !isPago && vencimento < hoje;
      const status = isPago ? 'PAGO' : isVencido ? 'VENCIDO' : 'A PAGAR';

      return {
        mes: m.mes,
        ano,
        recebido: m.recebido,
        qtd: m.qtd,
        pis_bruto: pis_mes,
        cofins_bruto: cofins_mes,
        pis_credito: pis_credito_mes,
        cofins_credito: cofins_credito_mes,
        pis: Math.max(pis_liquido, 0),
        cofins: Math.max(cofins_liquido, 0),
        vencimento,
        status
      };
    })
  });
});

router.post('/despesas', (req, res) => {
  const { categoria, descricao, fornecedor, cnpj_fornecedor, nf_numero, data_despesa, competencia, valor_bruto, obs, contrato_ref } = req.body;
  if (!valor_bruto) return res.status(400).json({ error: 'valor_bruto obrigatório' });

  const auto = calcRetencoes(categoria || 'FORNECEDOR', valor_bruto);
  const ret = {
    irrf: req.body.irrf ?? auto.irrf,
    csll: req.body.csll ?? auto.csll,
    pis_retido: req.body.pis_retido ?? auto.pis_retido,
    cofins_retido: req.body.cofins_retido ?? auto.cofins_retido,
    inss_retido: req.body.inss_retido ?? auto.inss_retido,
    iss_retido: req.body.iss_retido ?? 0,
  };
  ret.total_retencao = +(ret.irrf + ret.csll + ret.pis_retido + ret.cofins_retido + ret.inss_retido + ret.iss_retido).toFixed(2);
  ret.valor_liquido = +(valor_bruto - ret.total_retencao).toFixed(2);

  const r = req.db.prepare(`
    INSERT INTO despesas (categoria, descricao, fornecedor, cnpj_fornecedor, nf_numero, data_despesa, data_iso, competencia,
      valor_bruto, irrf, csll, pis_retido, cofins_retido, inss_retido, iss_retido, total_retencao, valor_liquido, status, obs, contrato_ref)
    VALUES (@categoria, @descricao, @fornecedor, @cnpj, @nf, @data, @data_iso, @comp,
      @vbruto, @irrf, @csll, @pis, @cofins, @inss, @iss, @total_ret, @vliq, @status, @obs, @contrato_ref)
  `).run({
    categoria: categoria || 'FORNECEDOR', descricao: descricao || '', fornecedor: fornecedor || '',
    cnpj: cnpj_fornecedor || '', nf: nf_numero || '', data: data_despesa || '',
    data_iso: parseDateBR(data_despesa || ''), comp: competencia || '',
    vbruto: valor_bruto, ...ret, irrf: ret.irrf, csll: ret.csll, pis: ret.pis_retido,
    cofins: ret.cofins_retido, inss: ret.inss_retido, iss: ret.iss_retido,
    total_ret: ret.total_retencao, vliq: ret.valor_liquido,
    status: req.body.status || 'PENDENTE', obs: obs || '', contrato_ref: contrato_ref || ''
  });

  res.json({ ok: true, id: r.lastInsertRowid, retencoes: ret });
});

router.patch('/despesas/:id', (req, res) => {
  const { id } = req.params;
  const desp = req.db.prepare('SELECT * FROM despesas WHERE id = ?').get(id);
  if (!desp) return res.status(404).json({ error: 'Despesa não encontrada' });

  const fields = ['categoria','descricao','fornecedor','cnpj_fornecedor','nf_numero','data_despesa','competencia',
    'valor_bruto','irrf','csll','pis_retido','cofins_retido','inss_retido','iss_retido','status','obs','contrato_ref'];
  const updates = [];
  const params = { id: parseInt(id) };
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = @${f}`); params[f] = req.body[f]; }
  }
  if (req.body.data_despesa !== undefined) {
    updates.push('data_iso = @data_iso');
    params.data_iso = parseDateBR(req.body.data_despesa);
  }
  if (!updates.length) return res.status(400).json({ error: 'Nada para atualizar' });

  // Recalculate totals
  updates.push('updated_at = datetime(\'now\')');
  req.db.prepare(`UPDATE despesas SET ${updates.join(', ')} WHERE id = @id`).run(params);

  // Recalculate retencao and liquido after field updates
  const updated = req.db.prepare('SELECT * FROM despesas WHERE id = ?').get(id);
  const totalRet = +(updated.irrf + updated.csll + updated.pis_retido + updated.cofins_retido + updated.inss_retido + updated.iss_retido).toFixed(2);
  const vliq = +(updated.valor_bruto - totalRet).toFixed(2);
  req.db.prepare('UPDATE despesas SET total_retencao = ?, valor_liquido = ? WHERE id = ?').run(totalRet, vliq, id);

  res.json({ ok: true });
});

router.delete('/despesas/:id', (req, res) => {
  const desp = req.db.prepare('SELECT descricao, valor_bruto FROM despesas WHERE id = ?').get(req.params.id);
  req.db.prepare('DELETE FROM despesas WHERE id = ?').run(req.params.id);
  audit(req, 'DELETE', 'despesas', req.params.id, `${desp?.descricao || ''} R$${desp?.valor_bruto || 0}`);
  res.json({ ok: true });
});

router.post('/import/despesas', (req, res, next) => getUpload(req).single('file')(req, res, next), (req, res) => {
  try {
    const extErr = validarExtensao(req.file.originalname, ['csv', 'txt']);
    if (extErr) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: extErr }); }
    const content = fs.readFileSync(req.file.path, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 2) return res.status(400).json({ error: 'CSV vazio' });

    const header = lines[0].split(';').map(h => h.trim().replace(/"/g, ''));
    const insert = req.db.prepare(`
      INSERT INTO despesas (categoria, descricao, fornecedor, cnpj_fornecedor, nf_numero, data_despesa, data_iso, competencia,
        valor_bruto, irrf, csll, pis_retido, cofins_retido, inss_retido, iss_retido, total_retencao, valor_liquido, status, obs, contrato_ref)
      VALUES (@categoria, @descricao, @fornecedor, @cnpj, @nf, @data, @data_iso, @comp,
        @vbruto, @irrf, @csll, @pis, @cofins, @inss, @iss, @total_ret, @vliq, @status, @obs, @contrato_ref)
    `);

    let imported = 0;
    const batch = req.db.transaction(() => {
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(';').map(c => c.trim().replace(/"/g, ''));
        if (cols.length < 4) continue;
        const row = {};
        header.forEach((h, idx) => { row[h.toLowerCase().trim()] = cols[idx] || ''; });

        const cat = (row.categoria || row.tipo || 'FORNECEDOR').toUpperCase();
        const vbruto = parseDecimalBR(row['valor bruto'] || row.valor_bruto || row.valor || '0');
        const auto = calcRetencoes(cat, vbruto);

        insert.run({
          categoria: cat,
          descricao: row.descricao || row['descrição'] || '',
          fornecedor: row.fornecedor || '',
          cnpj: row.cnpj || row.cnpj_fornecedor || '',
          nf: row.nf || row.nf_numero || row['nota fiscal'] || '',
          data: row.data || row.data_despesa || '',
          data_iso: parseDateBR(row.data || row.data_despesa || ''),
          comp: row.competencia || row.comp || '',
          vbruto, ...auto,
          irrf: parseDecimalBR(row.irrf) || auto.irrf,
          csll: parseDecimalBR(row.csll) || auto.csll,
          pis: parseDecimalBR(row.pis_retido || row.pis) || auto.pis_retido,
          cofins: parseDecimalBR(row.cofins_retido || row.cofins) || auto.cofins_retido,
          inss: parseDecimalBR(row.inss_retido || row.inss) || auto.inss_retido,
          iss: parseDecimalBR(row.iss_retido || row.iss) || 0,
          total_ret: auto.total_retencao,
          vliq: auto.valor_liquido,
          status: row.status || 'PENDENTE',
          obs: row.obs || '',
          contrato_ref: row.contrato || row.contrato_ref || ''
        });
        imported++;
      }
    });
    batch();

    req.db.prepare(`INSERT INTO importacoes (tipo, arquivo, registros) VALUES ('despesas', @arquivo, @registros)`)
      .run({ arquivo: req.file.originalname, registros: imported });
    dashCacheInvalidate(req.companyKey);
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, imported, message: `${imported} despesas importadas` });
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

// ─── HISTÓRICO DE IMPORTAÇÕES ────────────────────────────────────
router.get('/importacoes', (req, res) => {
  const rows = req.db.prepare(`SELECT * FROM importacoes ORDER BY data_importacao DESC LIMIT 50`).all();
  res.json({ data: rows });
});

// ─── IMPORTAÇÃO OFX BANCÁRIO ─────────────────────────────────────
function parseOFX(text) {
  const transactions = [];
  // Tenta XML (OFX 2.x) depois SGML (OFX 1.x)
  const xmlRe  = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  const sgmlRe = /<STMTTRN>([\s\S]*?)(?=<STMTTRN>|<\/BANKTRANLIST>|$)/gi;
  let matches = [...text.matchAll(xmlRe)];
  if (!matches.length) matches = [...text.matchAll(sgmlRe)];

  function field(block, name) {
    const m = block.match(new RegExp('<' + name + '>([^<\\n]+)', 'i'));
    return m ? m[1].trim() : '';
  }
  function ofxDate(d) {
    const s = (d || '').replace(/[^0-9]/g, '').slice(0, 8);
    return s.length >= 8 ? s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8) : '';
  }

  for (const m of matches) {
    const blk = m[1] || m[0];
    const dt  = ofxDate(field(blk, 'DTPOSTED'));
    const amt = parseFloat((field(blk, 'TRNAMT') || '0').replace(',', '.')) || 0;
    const id  = field(blk, 'FITID');
    const memo= field(blk, 'MEMO') || field(blk, 'NAME') || '';
    if (!dt || amt === 0) continue;
    transactions.push({
      fitid: id, data_iso: dt, valor: Math.abs(amt),
      debito:  amt < 0 ? Math.abs(amt) : null,
      credito: amt > 0 ? amt : null,
      tipo: amt >= 0 ? 'C' : 'D',
      historico: memo.slice(0, 200)
    });
  }
  return transactions;
}

router.post('/import/ofx', (req, res, next) => getUpload(req).single('file')(req, res, next), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Arquivo OFX não enviado' });
    // Validação de extensão (P-6)
    const extErr = validarExtensao(req.file.originalname, ['ofx']);
    if (extErr) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: extErr }); }
    const raw = fs.readFileSync(req.file.path, 'utf8');
    // Validação de conteúdo mínimo (P-6)
    if (!/OFXHEADER|<OFX/i.test(raw)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Conteúdo inválido: o arquivo não contém marcadores OFX. Verifique se o arquivo é um extrato bancário em formato OFX.' });
    }
    const { bloqueio } = analisarArquivo(raw, req.file.originalname, req.company);
    if (bloqueio) { fs.unlinkSync(req.file.path); return res.status(403).json({ error: bloqueio }); }
    const txs = parseOFX(raw);
    if (!txs.length) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'Nenhuma transação encontrada no OFX' }); }
    const MESES = ['','JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];
    const ins = req.db.prepare(
      "INSERT OR IGNORE INTO extratos (id, mes, data, data_iso, tipo, historico, debito, credito, status_conciliacao) " +
      "VALUES (@id, @mes, @data, @data_iso, @tipo, @historico, @debito, @credito, 'PENDENTE')"
    );
    let imported = 0, skipped = 0;
    req.db.transaction(() => {
      for (const t of txs) {
        const [y, m, d] = t.data_iso.split('-').map(Number);
        const r = ins.run({
          id: /^\d+$/.test(t.fitid) ? parseInt(t.fitid) : null,
          mes: MESES[m] || String(m),
          data: [String(d).padStart(2,'0'), String(m).padStart(2,'0'), y].join('/'),
          data_iso: t.data_iso,
          tipo: t.tipo,
          historico: t.historico,
          debito: t.debito,
          credito: t.credito
        });
        if (r.changes > 0) imported++; else skipped++;
      }
    })();
    dashCacheInvalidate(req.companyKey);
    req.db.prepare("INSERT INTO importacoes (tipo, arquivo, registros) VALUES ('ofx', @arquivo, @registros)")
      .run({ arquivo: req.file.originalname, registros: imported });
    audit(req, 'IMPORT', 'extratos', '', `OFX ${req.file.originalname} — ${imported} importados, ${skipped} ignorados`);
    fs.unlinkSync(req.file.path);
    const msg = imported + ' transações importadas do OFX' + (skipped > 0 ? ` (${skipped} duplicados ignorados)` : '');
    res.json({ ok: true, imported, skipped, total: txs.length, message: msg });
  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

// ─── IMPORTAÇÃO EXTRATO PDF (BB / BRB / IA fallback) ─────────────────────────
//
// Estratégias em ordem:
//  1. Parser Banco do Brasil (app mobile — DD/MM/AAAA HISTORICO VALOR)
//  2. Parser BRB (tabela com colunas Débito / Crédito)
//  3. Fallback IA: envia texto extraído para Claude Haiku e pede JSON
//
router.post('/import/pdf-extrato', (req, res, next) => getUpload(req).single('file')(req, res, next), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Arquivo PDF não enviado' });
    const extErr = validarExtensao(req.file.originalname, ['pdf']);
    if (extErr) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: extErr }); }

    const pdfParse = require('pdf-parse');
    const buffer   = fs.readFileSync(req.file.path);
    const pdfData  = await pdfParse(buffer);
    const texto    = pdfData.text || '';
    fs.unlinkSync(req.file.path);

    if (!texto.trim()) return res.status(400).json({ error: 'Não foi possível extrair texto do PDF. Tente um PDF gerado pelo app (não escaneado).' });

    // ── Helpers ──────────────────────────────────────────────────
    const MESES = ['','JAN','FEV','MAR','ABR','MAI','JUN','JUL','AGO','SET','OUT','NOV','DEZ'];
    function parseDatePDF(str) {
      // DD/MM/AAAA  ou  DD/MM/AA
      const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      if (!m) return null;
      let [, d, mo, y] = m;
      if (y.length === 2) y = '20' + y;
      return { iso: `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`, mes: MESES[parseInt(mo)] || mo };
    }
    function parseValBR(str) {
      if (!str) return 0;
      return parseFloat(str.replace(/\./g,'').replace(',','.')) || 0;
    }

    // ── Parser BB (Banco do Brasil) ───────────────────────────────
    // Linha típica BB app: "04/04/2026  PIX RECEBIDO - FULANO  1.500,00" ou "-1.500,00"
    // BB internet banking: "04/04/2026  PIX RECEBIDO    +1.500,00"
    function parseBB(txt) {
      const txs = [];
      const linhas = txt.split('\n');
      const re = /^(\d{2}\/\d{2}\/\d{2,4})\s+(.+?)\s+([-+]?\d{1,3}(?:\.\d{3})*,\d{2})\s*$/;
      for (const linha of linhas) {
        const m = linha.trim().match(re);
        if (!m) continue;
        const dt = parseDatePDF(m[1]);
        if (!dt) continue;
        const historico = m[2].trim();
        const raw = m[3].replace('+','');
        const valor = parseValBR(raw);
        if (!valor) continue;
        // ignora linhas de saldo
        if (/saldo/i.test(historico)) continue;
        const negativo = raw.startsWith('-') || /pagamento|debito|transferência enviada|pix enviado|tarifa|compra|saida/i.test(historico);
        txs.push({ data: dt, historico, debito: negativo ? Math.abs(valor) : 0, credito: negativo ? 0 : Math.abs(valor) });
      }
      return txs;
    }

    // ── Parser BRB ────────────────────────────────────────────────
    // BRB tem colunas separadas: Data | Histórico | Débito | Crédito | Saldo
    // Linha típica: "04/04/2026  PIX RECEBIDO NOME          234,56       1.000,00"
    // ou          : "04/04/2026  PIX RECEBIDO NOME                  500,00  1.500,00"
    function parseBRB(txt) {
      const txs = [];
      const linhas = txt.split('\n');
      // Linha BRB: DATA  HIST  [DEBITO]  [CREDITO]  SALDO
      const re = /^(\d{2}\/\d{2}\/\d{2,4})\s+(.+?)\s{2,}([\d.,]+|-)\s+([\d.,]+|-)\s+[\d.,]+\s*$/;
      for (const linha of linhas) {
        const m = linha.trim().match(re);
        if (!m) continue;
        const dt = parseDatePDF(m[1]);
        if (!dt) continue;
        const historico = m[2].trim();
        if (/saldo/i.test(historico)) continue;
        const deb = m[3] === '-' ? 0 : parseValBR(m[3]);
        const cred = m[4] === '-' ? 0 : parseValBR(m[4]);
        if (!deb && !cred) continue;
        txs.push({ data: dt, historico, debito: deb, credito: cred });
      }
      return txs;
    }

    // ── Tentar parsers ────────────────────────────────────────────
    let txs = [];
    let banco = 'desconhecido';

    // Detecta banco pelo cabeçalho do PDF
    const isBB  = /banco do brasil|extrato bb|bb\.com\.br/i.test(texto.substring(0, 500));
    const isBRB = /brb|banco de bras.lia/i.test(texto.substring(0, 500));

    if (isBB || (!isBRB)) { txs = parseBB(texto); if (txs.length) banco = 'BB'; }
    if (!txs.length)       { txs = parseBRB(texto); if (txs.length) banco = 'BRB'; }

    // ── Fallback IA (Claude Haiku) ────────────────────────────────
    if (!txs.length && process.env.ANTHROPIC_API_KEY) {
      banco = 'IA';
      try {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
        // Envia apenas os primeiros 6000 chars para economizar tokens
        const amostra = texto.substring(0, 6000);
        const msg = await client.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 2048,
          messages: [{
            role: 'user',
            content: `Você é um parser de extratos bancários brasileiros. Extraia TODAS as transações do texto abaixo e retorne APENAS um JSON array, sem explicações:
[{"data":"DD/MM/AAAA","historico":"descrição","debito":0.00,"credito":0.00}]

Regras:
- data: formato DD/MM/AAAA obrigatório
- debito: valor numérico (saída de dinheiro), 0 se não houver
- credito: valor numérico (entrada de dinheiro), 0 se não houver
- Ignore linhas de saldo, cabeçalhos, totais
- Use ponto como separador decimal

Texto do extrato:
${amostra}`,
          }],
        });
        const resposta = msg.content[0]?.text || '[]';
        const match    = resposta.match(/\[[\s\S]*\]/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          txs = parsed.map(t => {
            const dt = parseDatePDF(t.data);
            return dt ? { data: dt, historico: t.historico || '', debito: parseFloat(t.debito)||0, credito: parseFloat(t.credito)||0 } : null;
          }).filter(Boolean);
        }
      } catch (iaErr) {
        console.error('[PDF] Fallback IA falhou:', iaErr.message);
      }
    }

    if (!txs.length) {
      return res.status(400).json({
        error: 'Não foi possível identificar transações no PDF. Formatos suportados: BB app, BRB. Alternativa: exporte como OFX pelo internet banking.'
      });
    }

    // ── Inserir no banco ──────────────────────────────────────────
    const ins = req.db.prepare(`
      INSERT OR IGNORE INTO extratos (mes, data, data_iso, tipo, historico, debito, credito, status_conciliacao)
      VALUES (@mes, @data, @data_iso, @tipo, @historico, @debito, @credito, 'PENDENTE')
    `);
    let imported = 0, skipped = 0;
    req.db.transaction(() => {
      for (const t of txs) {
        const r = ins.run({
          mes:      t.data.mes,
          data:     t.data.iso.split('-').reverse().join('/'), // DD/MM/AAAA
          data_iso: t.data.iso,
          tipo:     t.credito > 0 ? 'C' : 'D',
          historico: t.historico,
          debito:    t.debito,
          credito:   t.credito,
        });
        if (r.changes > 0) imported++; else skipped++;
      }
    })();

    dashCacheInvalidate(req.companyKey);
    req.db.prepare("INSERT INTO importacoes (tipo, arquivo, registros) VALUES ('pdf-extrato', @arquivo, @registros)")
      .run({ arquivo: req.file?.originalname || 'extrato.pdf', registros: imported });
    audit(req, 'IMPORT', 'extratos', '', `PDF ${banco} — ${imported} importados, ${skipped} ignorados`);

    res.json({ ok: true, imported, skipped, total: txs.length, banco, message: `${imported} lançamentos importados do PDF (${banco})` + (skipped > 0 ? ` · ${skipped} duplicados ignorados` : '') });

  } catch (err) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    console.error('[PDF extrato] erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ─── PREFEITURA DE PALMAS ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════

// Dashboard KPIs
router.get('/prefeitura/dashboard', (req, res) => {
  try {
    const totais = req.db.prepare(`
      SELECT COUNT(*) as total_pgtos,
        COALESCE(SUM(valor_pago),0) as total_bruto,
        COALESCE(SUM(valor_liquido_ob),0) as total_liquido,
        COALESCE(SUM(retencao),0) as total_retencao,
        COUNT(CASE WHEN status_conciliacao='RECEBIDO' THEN 1 END) as recebidos,
        COUNT(CASE WHEN status_conciliacao='PENDENTE' THEN 1 END) as pendentes
      FROM pref_pagamentos
    `).get();

    const gestoes = req.db.prepare(`SELECT COUNT(*) as total FROM pref_contratos`).get();
    const nfs = req.db.prepare(`SELECT COUNT(*) as total FROM pref_nfs`).get();

    const por_ano = req.db.prepare(`
      SELECT ano_empenho as ano, COUNT(*) as qtd, SUM(valor_pago) as total
      FROM pref_pagamentos WHERE ano_empenho > 0 GROUP BY ano_empenho ORDER BY ano_empenho
    `).all();

    const por_status = req.db.prepare(`
      SELECT status_conciliacao as status, COUNT(*) as qtd, SUM(valor_pago) as total
      FROM pref_pagamentos GROUP BY status_conciliacao
    `).all();

    res.json({ totais, gestoes: gestoes.total, nfs: nfs.total, por_ano, por_status });
  } catch(e) { errRes(res, e); }
});

// Gestões (contratos)
router.get('/prefeitura/gestoes', (req, res) => {
  try {
    const rows = req.db.prepare(`SELECT * FROM pref_contratos ORDER BY total_pago DESC`).all();
    res.json({ data: rows });
  } catch(e) { errRes(res, e); }
});

// Pagamentos with filters
router.get('/prefeitura/pagamentos', (req, res) => {
  try {
    const { gestao, ano, status, from, to, limit: lim, offset: off } = req.query;
    let where = '1=1';
    const params = {};
    if (gestao) { where += ' AND gestao_codigo = @gestao'; params.gestao = gestao; }
    if (ano) { where += ' AND ano_empenho = @ano'; params.ano = parseInt(ano); }
    if (status) { where += ' AND status_conciliacao = @status'; params.status = status; }
    if (from) { where += ' AND data_pagamento_iso >= @from'; params.from = from; }
    if (to) { where += ' AND data_pagamento_iso <= @to'; params.to = to; }

    const total = req.db.prepare(`SELECT COUNT(*) as cnt FROM pref_pagamentos WHERE ${where}`).get(params);
    const sumario = req.db.prepare(`SELECT COALESCE(SUM(valor_pago),0) as bruto, COALESCE(SUM(valor_liquido_ob),0) as liquido, COALESCE(SUM(retencao),0) as ret FROM pref_pagamentos WHERE ${where}`).get(params);

    params.limit = parseInt(lim) || 100;
    params.offset = parseInt(off) || 0;
    const rows = req.db.prepare(`SELECT * FROM pref_pagamentos WHERE ${where} ORDER BY data_pagamento_iso DESC, valor_pago DESC LIMIT @limit OFFSET @offset`).all(params);

    res.json({ data: rows, total: total.cnt, sumario });
  } catch(e) { errRes(res, e); }
});

// NFs
router.get('/prefeitura/nfs', (req, res) => {
  try {
    const { cidade, status } = req.query;
    let where = '1=1';
    const params = {};
    if (cidade) { where += " AND cidade LIKE @cidade"; params.cidade = `%${cidade}%`; }
    if (status) { where += ' AND status = @status'; params.status = status; }

    const rows = req.db.prepare(`SELECT * FROM pref_nfs WHERE ${where} ORDER BY CAST(numero AS INTEGER) DESC`).all(params);
    res.json({ data: rows });
  } catch(e) { errRes(res, e); }
});

// Resumo por gestão + mês
router.get('/prefeitura/resumo-mensal', (req, res) => {
  try {
    const rows = req.db.prepare(`
      SELECT gestao, gestao_codigo,
        SUBSTR(data_pagamento_iso,1,7) as mes,
        COUNT(*) as qtd, SUM(valor_pago) as bruto,
        SUM(valor_liquido_ob) as liquido, SUM(retencao) as retencao,
        COUNT(CASE WHEN status_conciliacao='RECEBIDO' THEN 1 END) as recebidos
      FROM pref_pagamentos
      WHERE data_pagamento_iso != ''
      GROUP BY gestao, SUBSTR(data_pagamento_iso,1,7)
      ORDER BY SUBSTR(data_pagamento_iso,1,7) DESC, SUM(valor_pago) DESC
    `).all();
    res.json({ data: rows });
  } catch(e) { errRes(res, e); }
});

// Conciliação: pagamentos x NFs x extrato
router.get('/prefeitura/conciliacao', (req, res) => {
  try {
    const { mes } = req.query;
    let dateFilter = '';
    const params = {};
    if (mes) { dateFilter = " AND SUBSTR(p.data_pagamento_iso,1,7) = @mes"; params.mes = mes; }

    const pagamentos = req.db.prepare(`
      SELECT p.*,
        (SELECT GROUP_CONCAT(n.numero) FROM pref_nfs n WHERE n.pagamento_id = p.id) as nfs_vinculadas
      FROM pref_pagamentos p
      WHERE 1=1 ${dateFilter}
      ORDER BY p.data_pagamento_iso DESC, p.valor_pago DESC
    `).all(params);

    const nfs_livres = req.db.prepare(`SELECT * FROM pref_nfs WHERE pagamento_id IS NULL ORDER BY CAST(numero AS INTEGER) DESC`).all();

    res.json({ pagamentos, nfs_livres });
  } catch(e) { errRes(res, e); }
});

// Vincular NF a pagamento
router.post('/prefeitura/vincular-nf', (req, res) => {
  try {
    const { pagamento_id, nf_id } = req.body;
    req.db.prepare('UPDATE pref_nfs SET pagamento_id = ?, status = ? WHERE id = ?').run(pagamento_id, 'VINCULADA', nf_id);
    const nf = req.db.prepare('SELECT numero FROM pref_nfs WHERE id = ?').get(nf_id);
    if (nf) {
      req.db.prepare('UPDATE pref_pagamentos SET nf_vinculada = ? WHERE id = ?').run(nf.numero, pagamento_id);
    }
    res.json({ ok: true });
  } catch(e) { errRes(res, e); }
});

// Desvincular NF
router.delete('/prefeitura/vincular-nf/:nf_id', (req, res) => {
  try {
    const nf = req.db.prepare('SELECT pagamento_id FROM pref_nfs WHERE id = ?').get(req.params.nf_id);
    if (nf && nf.pagamento_id) {
      req.db.prepare("UPDATE pref_pagamentos SET nf_vinculada = '' WHERE id = ?").run(nf.pagamento_id);
    }
    req.db.prepare("UPDATE pref_nfs SET pagamento_id = NULL, status = 'EMITIDA' WHERE id = ?").run(req.params.nf_id);
    res.json({ ok: true });
  } catch(e) { errRes(res, e); }
});


// ─── FLUXO DE CAIXA PROJETADO ────────────────────────────────────
router.get('/fluxo-projetado', (req, res) => {
  try {
    const meses = Math.min(Math.max(parseInt(req.query.meses) || 6, 1), 24);

    const contratos = req.db.prepare(
      "SELECT valor_mensal_liquido FROM contratos " +
      "WHERE status NOT LIKE '%ENCERRADO%' AND status NOT LIKE '%RESCINDIDO%' " +
      "AND (vigencia_fim = '' OR vigencia_fim >= date('now'))"
    ).all();
    const receitaMensal = contratos.reduce((s, c) => s + (c.valor_mensal_liquido || 0), 0);
    const totalContratos = contratos.length;

    const despMedia = req.db.prepare(
      "SELECT COALESCE(AVG(mensal),0) as media FROM (" +
        "SELECT strftime('%Y-%m', data_iso) as mes, SUM(valor_bruto) as mensal " +
        "FROM despesas WHERE data_iso >= date('now', '-3 months') AND data_iso != '' " +
        "GROUP BY strftime('%Y-%m', data_iso) ORDER BY mes DESC LIMIT 3)"
    ).get().media || 0;

    const extR = req.db.prepare(
      "SELECT COUNT(CASE WHEN credito > 0 AND status_conciliacao IN ('PENDENTE','A_IDENTIFICAR','') THEN 1 END) as pendentes, " +
      "COUNT(CASE WHEN credito > 0 THEN 1 END) as total FROM extratos WHERE data_iso >= date('now', '-3 months')"
    ).get();
    const pctInadimplencia = extR.total > 0 ? +((extR.pendentes / extR.total) * 100).toFixed(1) : 0;

    const MESES_PT = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const projecao = [];
    const hoje = new Date();
    let acOt = 0, acRe = 0, acPe = 0;

    for (let i = 0; i < meses; i++) {
      const d = new Date(hoje.getFullYear(), hoje.getMonth() + i, 1);
      const mesNum = String(d.getMonth() + 1).padStart(2, '0');
      const mesLabel = MESES_PT[d.getMonth()] + '/' + String(d.getFullYear()).slice(2);
      const recOt = +(receitaMensal * 1.10).toFixed(2);
      const recRe = +receitaMensal.toFixed(2);
      const recPe = +(receitaMensal * (1 - pctInadimplencia / 100) * 0.95).toFixed(2);
      const dOt = +(despMedia * Math.pow(1.02, i)).toFixed(2);
      const dRe = +despMedia.toFixed(2);
      const dPe = +(despMedia * Math.pow(1.05, i)).toFixed(2);
      const sOt = +(recOt - dOt).toFixed(2);
      const sRe = +(recRe - dRe).toFixed(2);
      const sPe = +(recPe - dPe).toFixed(2);
      acOt = +(acOt + sOt).toFixed(2);
      acRe = +(acRe + sRe).toFixed(2);
      acPe = +(acPe + sPe).toFixed(2);
      projecao.push({
        mes: d.getFullYear() + '-' + mesNum, mesLabel,
        receita: { otimista: recOt, realista: recRe, pessimista: recPe },
        despesa: { otimista: dOt,   realista: dRe,   pessimista: dPe   },
        saldo:   { otimista: sOt,   realista: sRe,   pessimista: sPe   },
        saldoAcumulado: { otimista: acOt, realista: acRe, pessimista: acPe }
      });
    }

    res.json({ receitaMensal: +receitaMensal.toFixed(2), despesaMedia: +despMedia.toFixed(2), pctInadimplencia, totalContratos, projecao });
  } catch (e) { errRes(res, e); }
});

// ─── FLUXO REAL POR PARCELAS (próximos 3 meses) ──────────────────
router.get('/fluxo-parcelas', (req, res) => {
  try {
    const hoje = new Date();
    const meses = [];
    for (let i = 0; i < 3; i++) {
      const d = new Date(hoje.getFullYear(), hoje.getMonth() + i, 1);
      meses.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    }

    // Parcelas por mês — exclui apenas as já pagas integralmente
    const parcelas = req.db.prepare(`
      SELECT p.id, p.contrato_num, p.competencia, p.valor_liquido, p.valor_bruto,
             p.valor_pago, p.status, p.obs,
             c.contrato as orgao
      FROM parcelas p
      LEFT JOIN contratos c ON c.numContrato = p.contrato_num
      WHERE p.competencia >= ? AND p.competencia <= ?
        AND p.status NOT IN ('✅ PAGO')
      ORDER BY p.competencia, p.contrato_num
    `).all(meses[0], meses[2]);

    // Despesa média mensal (últimos 3 meses)
    const despMedia = req.db.prepare(`
      SELECT COALESCE(AVG(mensal), 0) as media FROM (
        SELECT SUM(valor_bruto) as mensal FROM despesas
        WHERE data_iso >= date('now','-3 months') AND data_iso != ''
        GROUP BY strftime('%Y-%m', data_iso) ORDER BY 1 DESC LIMIT 3
      )
    `).get().media || 0;

    // Agrupa por mês
    const MESES_PT = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
    const porMes = meses.map(mes => {
      const rows = parcelas.filter(p => p.competencia === mes);
      const [ano, m] = mes.split('-');
      const contratos = {};
      rows.forEach(p => {
        if (!contratos[p.contrato_num]) contratos[p.contrato_num] = { contrato_num: p.contrato_num, orgao: p.orgao || p.contrato_num, qtd: 0, valor_previsto: 0, valor_pago: 0 };
        contratos[p.contrato_num].qtd++;
        contratos[p.contrato_num].valor_previsto += p.valor_liquido || 0;
        contratos[p.contrato_num].valor_pago += p.valor_pago || 0;
      });
      const listaContratos = Object.values(contratos).sort((a, b) => b.valor_previsto - a.valor_previsto);
      const totalPrevisto = listaContratos.reduce((s, c) => s + c.valor_previsto, 0);
      const totalPago     = listaContratos.reduce((s, c) => s + c.valor_pago, 0);
      return {
        mes, mesLabel: MESES_PT[parseInt(m, 10) - 1] + '/' + ano.slice(2),
        qtd_parcelas: rows.length,
        total_previsto: +totalPrevisto.toFixed(2),
        total_pago:     +totalPago.toFixed(2),
        a_receber:      +(totalPrevisto - totalPago).toFixed(2),
        despesa_media:  +despMedia.toFixed(2),
        saldo_estimado: +(totalPrevisto - totalPago - despMedia).toFixed(2),
        contratos: listaContratos.map(c => ({
          ...c,
          valor_previsto: +c.valor_previsto.toFixed(2),
          valor_pago:     +c.valor_pago.toFixed(2),
          a_receber:      +(c.valor_previsto - c.valor_pago).toFixed(2),
        }))
      };
    });

    res.json({ data: porMes, despesa_media: +despMedia.toFixed(2) });
  } catch (e) { errRes(res, e); }
});

// ─── CONTA VINCULADA — ESTIMATIVA (IN 05/2017, Anexo XII-A) ─────
// Provisões trabalhistas retidas em conta vinculada nos contratos federais (UFT/UFNT)
// Base legal: IN SEGES/MP 05/2017 art. 65, Anexo XII-A; IN SEGES/ME 98/2022 art. 89
// Percentuais aplicados sobre Módulo 1 (Remuneração) da Planilha de Custos

const CONTA_VINCULADA_PROVISOES = {
  '13_salario':       { label: '13º Salário',                          pct: 8.33, base: 'IN 05/2017, Anexo XII-A, item 1' },
  'ferias':           { label: 'Férias',                                pct: 8.33, base: 'IN 05/2017, Anexo XII-A, item 2' },
  'terco_ferias':     { label: '1/3 Constitucional de Férias',          pct: 2.78, base: 'CF/88, art. 7º, XVII' },
  'multa_fgts':       { label: 'Multa do FGTS (rescisão s/ justa causa)', pct: 3.20, base: 'CLT art. 477 + Lei 8.036/90' },
  'contrib_social':   { label: 'Contribuição Social sobre FGTS',       pct: 0.80, base: 'LC 110/2001' },
  'subtotal':         { label: 'Subtotal Provisões',                    pct: 23.44, computed: true },
  'incid_encargos':   { label: 'Incidência Submódulo 4.1 sobre Provisões', pct: 7.60, base: 'IN 05/2017, Submódulo 4.1 × 23.44%' },
  'total':            { label: 'TOTAL CONTA VINCULADA',                 pct: 31.04, computed: true }
};

// Fator estimado: % do faturamento mensal que é Módulo 1 (Remuneração)
// Em contratos de cessão de mão de obra, remuneração ≈ 33-42% do preço mensal
const FATOR_REMUNERACAO_PADRAO = 0.38; // 38% — média para contratos de assessoria/vigilância

router.get('/conta-vinculada/estimativa', (req, res) => {
  try {
    const db = req.db;

    // Buscar contratos federais com conta vinculada (UFT, UFNT, ou que tenham "CV" no obs)
    const contratos = db.prepare(`
      SELECT * FROM contratos
      WHERE numContrato LIKE '%UFT%'
         OR numContrato LIKE '%UFNT%'
         OR obs LIKE '%conta vinculada%'
         OR obs LIKE '%CV %'
    `).all();

    if (!contratos.length) {
      return res.json({ contratos: [], mensagem: 'Nenhum contrato federal com conta vinculada encontrado' });
    }

    const resultado = contratos.map(contrato => {
      // NFs do contrato (buscar por tomador UFT/UFNT)
      let nfsQuery;
      if (contrato.numContrato.includes('UFT')) {
        nfsQuery = `SELECT DISTINCT numero, competencia, cidade, valor_bruto, valor_liquido, retencao, inss, ir, iss,
                     data_emissao, tomador FROM notas_fiscais
                     WHERE (tomador LIKE '%UFT%' OR tomador LIKE '%UNIVERSIDADE FEDERAL%' OR tomador LIKE '%UFNT%')
                     AND competencia != '' AND competencia IS NOT NULL
                     ORDER BY competencia, cidade`;
      } else {
        nfsQuery = `SELECT DISTINCT numero, competencia, cidade, valor_bruto, valor_liquido, retencao, inss, ir, iss,
                     data_emissao, tomador FROM notas_fiscais
                     WHERE contrato_ref = ?
                     AND competencia != '' AND competencia IS NOT NULL
                     ORDER BY competencia, cidade`;
      }
      const nfs = contrato.numContrato.includes('UFT')
        ? db.prepare(nfsQuery).all()
        : db.prepare(nfsQuery).all(contrato.numContrato);

      // Valor mensal bruto do contrato
      const valorMensalBruto = contrato.valor_mensal_bruto || 0;

      // Calcular Módulo 1 estimado (remuneração)
      const modulo1Estimado = +(valorMensalBruto * FATOR_REMUNERACAO_PADRAO).toFixed(2);

      // Provisões mensais estimadas
      const provisoesMensais = {};
      let totalProvisaoMensal = 0;
      for (const [key, prov] of Object.entries(CONTA_VINCULADA_PROVISOES)) {
        if (prov.computed) continue;
        const valor = +(modulo1Estimado * prov.pct / 100).toFixed(2);
        provisoesMensais[key] = { ...prov, valor };
        totalProvisaoMensal += valor;
      }
      totalProvisaoMensal = +totalProvisaoMensal.toFixed(2);

      // Percentual efetivo sobre o faturamento
      const pctSobreFaturamento = +(totalProvisaoMensal / valorMensalBruto * 100).toFixed(2);

      // Agrupar NFs por competência para projeção mensal
      const porCompetencia = {};
      nfs.forEach(nf => {
        const comp = nf.competencia || 'sem_data';
        if (!porCompetencia[comp]) {
          porCompetencia[comp] = { competencia: comp, nfs: [], totalBruto: 0, totalLiquido: 0, totalRetencao: 0 };
        }
        porCompetencia[comp].nfs.push(nf);
        porCompetencia[comp].totalBruto += nf.valor_bruto || 0;
        porCompetencia[comp].totalLiquido += nf.valor_liquido || 0;
        porCompetencia[comp].totalRetencao += nf.retencao || 0;
      });

      // Calcular CV estimada por competência
      let saldoAcumulado = 0;
      const projecaoMensal = Object.values(porCompetencia).map(mes => {
        const cvEstimada = +(mes.totalBruto * FATOR_REMUNERACAO_PADRAO * CONTA_VINCULADA_PROVISOES.total.pct / 100).toFixed(2);
        saldoAcumulado = +(saldoAcumulado + cvEstimada).toFixed(2);

        // Breakdown por provisão
        const breakdown = {};
        for (const [key, prov] of Object.entries(CONTA_VINCULADA_PROVISOES)) {
          if (prov.computed) continue;
          breakdown[key] = +(mes.totalBruto * FATOR_REMUNERACAO_PADRAO * prov.pct / 100).toFixed(2);
        }

        return {
          competencia: mes.competencia,
          qtdNFs: mes.nfs.length,
          faturamentoBruto: +mes.totalBruto.toFixed(2),
          retencaoTributaria: +mes.totalRetencao.toFixed(2),
          liquidoAposTributos: +mes.totalLiquido.toFixed(2),
          cvEstimada,
          liquidoAposCV: +(mes.totalLiquido - cvEstimada).toFixed(2),
          saldoCVAcumulado: saldoAcumulado,
          breakdown
        };
      });

      // Projeção futura (próximos 12 meses)
      const mesesFuturos = [];
      const hoje = new Date();
      const ultimaCompStr = projecaoMensal.length > 0 ? projecaoMensal[projecaoMensal.length - 1].competencia : '';
      const vigFim = contrato.vigencia_fim ? parseDataBR(contrato.vigencia_fim) : null;

      for (let i = 1; i <= 12; i++) {
        const d = new Date(hoje.getFullYear(), hoje.getMonth() + i, 1);
        if (vigFim && d > vigFim) break;

        const mesLabel = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][d.getMonth()];
        const comp = mesLabel + '/' + String(d.getFullYear()).slice(2);

        // Pular meses que já têm NF
        if (porCompetencia[comp]) continue;

        const cvMes = +(valorMensalBruto * FATOR_REMUNERACAO_PADRAO * CONTA_VINCULADA_PROVISOES.total.pct / 100).toFixed(2);
        saldoAcumulado = +(saldoAcumulado + cvMes).toFixed(2);

        mesesFuturos.push({
          competencia: comp,
          projetado: true,
          faturamentoBruto: valorMensalBruto,
          cvEstimada: cvMes,
          saldoCVAcumulado: saldoAcumulado
        });
      }

      // Eventos de liberação previstos
      const eventosLiberacao = [
        { evento: '13º Salário (1ª parcela)', mes: 'nov', pctLiberacao: 50, base: '13_salario', fundamentacao: 'Lei 4.749/65 — até 30/nov' },
        { evento: '13º Salário (2ª parcela)', mes: 'dez', pctLiberacao: 50, base: '13_salario', fundamentacao: 'Lei 4.749/65 — até 20/dez' },
        { evento: 'Férias (sob demanda)',      mes: 'variável', pctLiberacao: 100, base: 'ferias', fundamentacao: 'CLT art. 134 — conforme escala' },
        { evento: '1/3 Férias (sob demanda)',  mes: 'variável', pctLiberacao: 100, base: 'terco_ferias', fundamentacao: 'CF/88 art. 7º, XVII' },
        { evento: 'Rescisões (sob demanda)',   mes: 'variável', pctLiberacao: 100, base: 'multa_fgts', fundamentacao: 'CLT art. 477 + Lei 8.036/90' }
      ];

      // Resumo anual estimado (12 meses)
      const cvAnual = +(valorMensalBruto * 12 * FATOR_REMUNERACAO_PADRAO * CONTA_VINCULADA_PROVISOES.total.pct / 100).toFixed(2);

      return {
        contrato: {
          id: contrato.id,
          numContrato: contrato.numContrato,
          nome: contrato.contrato,
          orgao: contrato.orgao,
          vigencia_inicio: contrato.vigencia_inicio,
          vigencia_fim: contrato.vigencia_fim,
          valorMensalBruto: contrato.valor_mensal_bruto,
          valorMensalLiquido: contrato.valor_mensal_liquido,
          totalPago: contrato.total_pago,
          totalAberto: contrato.total_aberto,
          obs: contrato.obs,
          status: contrato.status
        },
        parametros: {
          fatorRemuneracao: FATOR_REMUNERACAO_PADRAO,
          modulo1Estimado,
          provisoes: CONTA_VINCULADA_PROVISOES,
          pctSobreFaturamento
        },
        provisoesMensais,
        totalProvisaoMensal,
        projecaoMensal,
        mesesFuturos,
        saldoCVAcumulado: saldoAcumulado,
        cvAnualEstimada: cvAnual,
        eventosLiberacao,
        baseLegal: [
          'IN SEGES/MP nº 05/2017, art. 65 e Anexo XII-A',
          'IN SEGES/ME nº 98/2022, art. 89 (Lei 14.133/21)',
          'Caderno de Logística — Conta Vinculada (MPOG)',
          'CLT arts. 129-153 (Férias), art. 477 (Rescisão)',
          'CF/88 art. 7º, VIII (FGTS) e XVII (1/3 Férias)',
          'Lei 8.036/90 (FGTS), LC 110/2001 (Contribuição Social)'
        ]
      };
    });

    res.json({ contratos: resultado, fatorRemuneracao: FATOR_REMUNERACAO_PADRAO });
  } catch (e) {
    errRes(res, e);
  }
});

function parseDataBR(str) {
  if (!str) return null;
  const p = str.split('/');
  if (p.length === 3) return new Date(+p[2], +p[1] - 1, +p[0]);
  return null;
}

// ─── EXPORTAÇÃO EXCEL ────────────────────────────────────────────
router.get('/export/extratos', async (req, res) => {
  try {
    const { from, to } = req.query;
    let where = '1=1'; const p = {};
    if (from) { where += ' AND data_iso >= @from'; p.from = from; }
    if (to)   { where += ' AND data_iso <= @to';   p.to   = to; }
    const rows = req.db.prepare(`SELECT * FROM extratos WHERE ${where} ORDER BY data_iso DESC LIMIT 20000`).all(p);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Montana';
    const ws = wb.addWorksheet('Extratos');
    ws.columns = [
      { header: 'ID',          key: 'id',                  width: 10 },
      { header: 'Data',        key: 'data',                width: 12 },
      { header: 'Mês',         key: 'mes',                 width: 8  },
      { header: 'Tipo',        key: 'tipo',                width: 6  },
      { header: 'Histórico',   key: 'historico',           width: 55 },
      { header: 'Débito',      key: 'debito',              width: 14 },
      { header: 'Crédito',     key: 'credito',             width: 14 },
      { header: 'Posto',       key: 'posto',               width: 20 },
      { header: 'Contrato',    key: 'contrato_vinculado',  width: 20 },
      { header: 'Status',      key: 'status_conciliacao',  width: 16 },
      { header: 'Banco',       key: 'banco',               width: 12 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
    rows.forEach(r => ws.addRow(r));
    ws.getColumn('debito').numFmt  = 'R$ #,##0.00';
    ws.getColumn('credito').numFmt = 'R$ #,##0.00';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Extratos_${from||'all'}_${to||'all'}.xlsx`);
    await wb.xlsx.write(res);
  } catch(e) { errRes(res, e); }
});

router.get('/export/nfs', async (req, res) => {
  try {
    const { from, to } = req.query;
    let where = '1=1'; const p = {};
    if (from) { where += ' AND data_emissao >= @from'; p.from = from; }
    if (to)   { where += ' AND data_emissao <= @to';   p.to   = to; }
    const rows = req.db.prepare(`SELECT * FROM notas_fiscais WHERE ${where} ORDER BY data_emissao DESC LIMIT 10000`).all(p);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); wb.creator = 'Montana';
    const ws = wb.addWorksheet('Notas Fiscais');
    ws.columns = [
      { header: 'NF Número',    key: 'numero',        width: 12 },
      { header: 'Competência',  key: 'competencia',   width: 14 },
      { header: 'Data Emissão', key: 'data_emissao',  width: 14 },
      { header: 'Cidade',       key: 'cidade',        width: 20 },
      { header: 'Tomador',      key: 'tomador',       width: 45 },
      { header: 'Contrato',     key: 'contrato_ref',  width: 18 },
      { header: 'V. Bruto',     key: 'valor_bruto',   width: 14 },
      { header: 'V. Líquido',   key: 'valor_liquido', width: 14 },
      { header: 'Retenção',     key: 'retencao',      width: 14 },
      { header: 'INSS',         key: 'inss',          width: 12 },
      { header: 'IR',           key: 'ir',            width: 12 },
      { header: 'ISS',          key: 'iss',           width: 12 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7C3AED' } };
    rows.forEach(r => ws.addRow(r));
    ['valor_bruto','valor_liquido','retencao','inss','ir','iss'].forEach(k => ws.getColumn(k).numFmt = 'R$ #,##0.00');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=NotasFiscais_${from||'all'}_${to||'all'}.xlsx`);
    await wb.xlsx.write(res);
  } catch(e) { errRes(res, e); }
});

router.get('/export/pagamentos', async (req, res) => {
  try {
    const { from, to } = req.query;
    let where = '1=1'; const p = {};
    if (from) { where += ' AND data_pagamento_iso >= @from'; p.from = from; }
    if (to)   { where += ' AND data_pagamento_iso <= @to';   p.to   = to; }
    const rows = req.db.prepare(`SELECT * FROM pagamentos WHERE ${where} ORDER BY data_pagamento_iso DESC LIMIT 10000`).all(p);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); wb.creator = 'Montana';
    const ws = wb.addWorksheet('Pagamentos');
    ws.columns = [
      { header: 'OB',            key: 'ob',                  width: 18 },
      { header: 'Gestão',        key: 'gestao',              width: 45 },
      { header: 'Fonte',         key: 'fonte',               width: 30 },
      { header: 'Empenho',       key: 'empenho',             width: 20 },
      { header: 'Processo',      key: 'processo',            width: 20 },
      { header: 'Favorecido',    key: 'favorecido',          width: 40 },
      { header: 'Data Pgto',     key: 'data_pagamento',      width: 12 },
      { header: 'Valor Pago',    key: 'valor_pago',          width: 14 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF15803D' } };
    rows.forEach(r => ws.addRow(r));
    ws.getColumn('valor_pago').numFmt = 'R$ #,##0.00';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Pagamentos_${from||'all'}_${to||'all'}.xlsx`);
    await wb.xlsx.write(res);
  } catch(e) { errRes(res, e); }
});

router.get('/export/despesas', async (req, res) => {
  try {
    const { from, to } = req.query;
    let where = '1=1'; const p = {};
    if (from) { where += ' AND data_iso >= @from'; p.from = from; }
    if (to)   { where += ' AND data_iso <= @to';   p.to   = to; }
    const rows = req.db.prepare(`SELECT * FROM despesas WHERE ${where} ORDER BY data_iso DESC LIMIT 10000`).all(p);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); wb.creator = 'Montana';
    const ws = wb.addWorksheet('Despesas');
    ws.columns = [
      { header: 'ID',           key: 'id',              width: 8  },
      { header: 'Categoria',    key: 'categoria',       width: 14 },
      { header: 'Descrição',    key: 'descricao',       width: 40 },
      { header: 'Fornecedor',   key: 'fornecedor',      width: 35 },
      { header: 'CNPJ',         key: 'cnpj_fornecedor', width: 18 },
      { header: 'NF',           key: 'nf_numero',       width: 12 },
      { header: 'Data',         key: 'data_despesa',    width: 12 },
      { header: 'Competência',  key: 'competencia',     width: 12 },
      { header: 'V. Bruto',     key: 'valor_bruto',     width: 14 },
      { header: 'V. Líquido',   key: 'valor_liquido',   width: 14 },
      { header: 'IRRF',         key: 'irrf',            width: 10 },
      { header: 'CSLL',         key: 'csll',            width: 10 },
      { header: 'PIS',          key: 'pis_retido',      width: 10 },
      { header: 'COFINS',       key: 'cofins_retido',   width: 10 },
      { header: 'INSS',         key: 'inss_retido',     width: 10 },
      { header: 'Status',       key: 'status',          width: 10 },
      { header: 'Contrato',     key: 'contrato_ref',    width: 18 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0891B2' } };
    rows.forEach(r => ws.addRow(r));
    ['valor_bruto','valor_liquido','irrf','csll','pis_retido','cofins_retido','inss_retido'].forEach(k => ws.getColumn(k).numFmt = 'R$ #,##0.00');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Despesas_${from||'all'}_${to||'all'}.xlsx`);
    await wb.xlsx.write(res);
  } catch(e) { errRes(res, e); }
});

router.get('/export/contratos', async (req, res) => {
  try {
    const rows = req.db.prepare(`SELECT * FROM contratos ORDER BY status ASC`).all();
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); wb.creator = 'Montana';
    const ws = wb.addWorksheet('Contratos');
    ws.columns = [
      { header: 'Contrato',        key: 'contrato',             width: 45 },
      { header: 'Número',          key: 'numContrato',          width: 22 },
      { header: 'Órgão',           key: 'orgao',                width: 28 },
      { header: 'Vig. Início',     key: 'vigencia_inicio',      width: 14 },
      { header: 'Vig. Fim',        key: 'vigencia_fim',         width: 14 },
      { header: 'Mensal Bruto',    key: 'valor_mensal_bruto',   width: 18 },
      { header: 'Mensal Líquido',  key: 'valor_mensal_liquido', width: 18 },
      { header: 'Total Pago',      key: 'total_pago',           width: 18 },
      { header: 'Total Aberto',    key: 'total_aberto',         width: 18 },
      { header: 'Status',          key: 'status',               width: 22 },
      { header: 'Observações',     key: 'obs',                  width: 35 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
    rows.forEach(r => ws.addRow(r));
    ['valor_mensal_bruto','valor_mensal_liquido','total_pago','total_aberto'].forEach(k => ws.getColumn(k).numFmt = 'R$ #,##0.00');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Contratos.xlsx`);
    await wb.xlsx.write(res);
  } catch(e) { errRes(res, e); }
});

// ─── EXPORT MARGEM POR CONTRATO ──────────────────────────────────
router.get('/export/margem', async (req, res) => {
  try {
    const { from, to } = req.query;
    const params = {};
    let nfFilter = '1=1', despFilter = '1=1';
    if (from) { nfFilter += ' AND n.data_emissao >= @from'; despFilter += ' AND d.data_iso >= @from'; params.from = from; }
    if (to)   { nfFilter += ' AND n.data_emissao <= @to';   despFilter += ' AND d.data_iso <= @to';   params.to   = to; }

    const contratos = req.db.prepare(`SELECT numContrato, contrato, orgao, status, valor_mensal_bruto, vigencia_inicio, vigencia_fim, total_pago FROM contratos ORDER BY contrato`).all();
    const nfMap  = {};
    req.db.prepare(`SELECT n.contrato_ref, SUM(n.valor_bruto) as receita_bruta, SUM(n.valor_liquido) as receita_liquida, SUM(n.retencao) as total_retencao, COUNT(*) as qtd_nfs FROM notas_fiscais n WHERE ${nfFilter} GROUP BY n.contrato_ref`).all(params).forEach(r => { nfMap[r.contrato_ref] = r; });
    const despMap = {};
    req.db.prepare(`SELECT d.contrato_ref, SUM(d.valor_bruto) as total_despesas, SUM(CASE WHEN d.categoria='FOLHA' THEN d.valor_bruto ELSE 0 END) as desp_folha, SUM(CASE WHEN d.categoria='FORNECEDOR' THEN d.valor_bruto ELSE 0 END) as desp_fornecedor, SUM(CASE WHEN d.categoria NOT IN ('FOLHA','FORNECEDOR') THEN d.valor_bruto ELSE 0 END) as desp_outras FROM despesas d WHERE ${despFilter} GROUP BY d.contrato_ref`).all(params).forEach(r => { despMap[r.contrato_ref] = r; });

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); wb.creator = 'Montana';
    const ws = wb.addWorksheet('Margem por Contrato');
    ws.columns = [
      { header: '#',             key: 'seq',              width: 5  },
      { header: 'Contrato',      key: 'numContrato',      width: 28 },
      { header: 'Órgão',         key: 'contrato',         width: 40 },
      { header: 'Status',        key: 'status',           width: 18 },
      { header: 'Vigência Fim',  key: 'vigencia_fim',     width: 14 },
      { header: 'Mensal Bruto',  key: 'valor_mensal_bruto', width: 16 },
      { header: 'Rec. Bruta',    key: 'receita_bruta',    width: 16 },
      { header: 'Rec. Líquida',  key: 'receita_liquida',  width: 16 },
      { header: 'Retenções',     key: 'total_retencao',   width: 14 },
      { header: 'Desp. Folha',   key: 'desp_folha',       width: 14 },
      { header: 'Desp. Fornec.', key: 'desp_fornecedor',  width: 14 },
      { header: 'Desp. Outras',  key: 'desp_outras',      width: 14 },
      { header: 'Total Desp.',   key: 'despesas',         width: 14 },
      { header: 'Lucro Bruto',   key: 'lucro_bruto',      width: 16 },
      { header: 'Margem %',      key: 'margem_pct',       width: 12 },
      { header: 'Qtd NFs',       key: 'qtd_nfs',          width: 10 },
    ];
    const hdr = ws.getRow(1);
    hdr.font  = { bold: true, color: { argb: 'FFFFFFFF' } };
    hdr.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    hdr.alignment = { horizontal: 'center' };

    const moeda = '"R$" #,##0.00';
    ['valor_mensal_bruto','receita_bruta','receita_liquida','total_retencao','desp_folha','desp_fornecedor','desp_outras','despesas','lucro_bruto'].forEach(k => ws.getColumn(k).numFmt = moeda);
    ws.getColumn('margem_pct').numFmt = '0.0"%"';

    let seq = 0;
    contratos.forEach(c => {
      const nf   = nfMap[c.numContrato]  || { receita_bruta: 0, receita_liquida: 0, total_retencao: 0, qtd_nfs: 0 };
      const desp = despMap[c.numContrato] || { total_despesas: 0, desp_folha: 0, desp_fornecedor: 0, desp_outras: 0 };
      const receita = nf.receita_bruta || c.total_pago || 0;
      const lucro   = +(receita - desp.total_despesas).toFixed(2);
      const margem  = receita > 0 ? +((lucro / receita) * 100).toFixed(1) : 0;
      seq++;
      const row = ws.addRow({
        seq, numContrato: c.numContrato, contrato: c.contrato, status: c.status,
        vigencia_fim: c.vigencia_fim, valor_mensal_bruto: c.valor_mensal_bruto,
        receita_bruta: +receita.toFixed(2), receita_liquida: +nf.receita_liquida.toFixed(2),
        total_retencao: +nf.total_retencao.toFixed(2),
        desp_folha: +desp.desp_folha.toFixed(2), desp_fornecedor: +desp.desp_fornecedor.toFixed(2),
        desp_outras: +desp.desp_outras.toFixed(2), despesas: +desp.total_despesas.toFixed(2),
        lucro_bruto: lucro, margem_pct: margem, qtd_nfs: nf.qtd_nfs,
      });
      if (margem < 0)       row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
      else if (margem < 10) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
    });

    // Linha de totais
    const totalReceita = contratos.reduce((s, c) => { const nf = nfMap[c.numContrato]; return s + (nf?.receita_bruta || c.total_pago || 0); }, 0);
    const totalDesp    = contratos.reduce((s, c) => { const d = despMap[c.numContrato]; return s + (d?.total_despesas || 0); }, 0);
    const totalLucro   = totalReceita - totalDesp;
    const totRow = ws.addRow({ seq: '', numContrato: 'TOTAL', contrato: '', status: '', vigencia_fim: '',
      valor_mensal_bruto: 0, receita_bruta: +totalReceita.toFixed(2), receita_liquida: 0,
      total_retencao: 0, desp_folha: 0, desp_fornecedor: 0, desp_outras: 0,
      despesas: +totalDesp.toFixed(2), lucro_bruto: +totalLucro.toFixed(2),
      margem_pct: totalReceita > 0 ? +((totalLucro/totalReceita)*100).toFixed(1) : 0, qtd_nfs: '' });
    totRow.font = { bold: true };
    totRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Margem_por_Contrato.xlsx`);
    await wb.xlsx.write(res);
  } catch(e) { errRes(res, e); }
});

// ─── BUSCA GLOBAL ─────────────────────────────────────────────────
router.get('/busca', (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json({ data: [] });
    const termo = '%' + q.trim() + '%';

    const nfs = req.db.prepare(`
      SELECT 'nf' as tipo, id, numero as codigo, tomador as descricao,
             valor_bruto as valor, data_emissao as data, contrato_ref as extra
      FROM notas_fiscais
      WHERE numero LIKE ? OR tomador LIKE ? OR contrato_ref LIKE ? OR competencia LIKE ?
      LIMIT 8
    `).all(termo, termo, termo, termo);

    const extratos = req.db.prepare(`
      SELECT 'extrato' as tipo, id, historico as codigo, historico as descricao,
             credito as valor, data_iso as data, status as extra
      FROM extratos
      WHERE historico LIKE ? OR descricao LIKE ? OR data_iso LIKE ?
      LIMIT 8
    `).all(termo, termo, termo);

    const contratos = req.db.prepare(`
      SELECT 'contrato' as tipo, id, numContrato as codigo, contrato as descricao,
             valor_mensal_bruto as valor, vigencia_fim as data, status as extra
      FROM contratos
      WHERE numContrato LIKE ? OR contrato LIKE ? OR orgao LIKE ?
      LIMIT 6
    `).all(termo, termo, termo);

    const despesas = req.db.prepare(`
      SELECT 'despesa' as tipo, id, categoria as codigo, descricao,
             valor_bruto as valor, data_iso as data, contrato_ref as extra
      FROM despesas
      WHERE descricao LIKE ? OR fornecedor LIKE ? OR contrato_ref LIKE ?
      LIMIT 6
    `).all(termo, termo, termo);

    res.json({ data: [...contratos, ...nfs, ...extratos, ...despesas] });
  } catch(e) { errRes(res, e); }
});

router.get('/export/certidoes', async (req, res) => {
  try {
    const rows = req.db.prepare(`SELECT * FROM certidoes ORDER BY data_validade ASC`).all();
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); wb.creator = 'Montana';
    const ws = wb.addWorksheet('Certidões');
    ws.columns = [
      { header: 'Tipo',        key: 'tipo',          width: 30 },
      { header: 'Número',      key: 'numero',        width: 20 },
      { header: 'Emissão',     key: 'data_emissao',  width: 14 },
      { header: 'Validade',    key: 'data_validade', width: 14 },
      { header: 'Status',      key: 'status',        width: 28 },
      { header: 'Observações', key: 'observacoes',   width: 45 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF15803D' } };
    rows.forEach(r => ws.addRow(r));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Certidoes.xlsx`);
    await wb.xlsx.write(res);
  } catch(e) { errRes(res, e); }
});

router.get('/export/licitacoes', async (req, res) => {
  try {
    const rows = req.db.prepare(`SELECT * FROM licitacoes ORDER BY data_abertura DESC`).all();
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); wb.creator = 'Montana';
    const ws = wb.addWorksheet('Licitações');
    ws.columns = [
      { header: 'Órgão',        key: 'orgao',             width: 28 },
      { header: 'Edital',       key: 'numero_edital',     width: 22 },
      { header: 'Modalidade',   key: 'modalidade',        width: 14 },
      { header: 'Objeto',       key: 'objeto',            width: 45 },
      { header: 'Abertura',     key: 'data_abertura',     width: 14 },
      { header: 'Encerramento', key: 'data_encerramento', width: 14 },
      { header: 'V. Estimado',  key: 'valor_estimado',    width: 18 },
      { header: 'V. Proposta',  key: 'valor_proposta',    width: 18 },
      { header: 'Status',       key: 'status',            width: 16 },
      { header: 'Resultado',    key: 'resultado',         width: 22 },
      { header: 'Observações',  key: 'observacoes',       width: 35 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0369A1' } };
    rows.forEach(r => ws.addRow(r));
    ['valor_estimado','valor_proposta'].forEach(k => ws.getColumn(k).numFmt = 'R$ #,##0.00');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Licitacoes.xlsx`);
    await wb.xlsx.write(res);
  } catch(e) { errRes(res, e); }
});

// ─── EXPORT AUDITORIA ────────────────────────────────────────────
router.get('/export/audit', async (req, res) => {
  try {
    const { tabela, usuario, from, to } = req.query;
    let where = '1=1';
    const params = [];
    if (tabela)  { where += ' AND tabela = ?';          params.push(tabela); }
    if (usuario) { where += ' AND usuario = ?';         params.push(usuario); }
    if (from)    { where += ' AND created_at >= ?';     params.push(from); }
    if (to)      { where += ' AND created_at <= ?';     params.push(to + ' 23:59:59'); }
    const rows = req.db.prepare(
      `SELECT id, tabela, acao, registro_id, usuario, detalhe, ip, created_at
       FROM audit_log WHERE ${where} ORDER BY created_at DESC LIMIT 5000`
    ).all(...params);

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); wb.creator = 'Montana';
    const ws = wb.addWorksheet('Log de Auditoria');
    ws.columns = [
      { header: 'ID',        key: 'id',          width: 8  },
      { header: 'Tabela',    key: 'tabela',       width: 18 },
      { header: 'Ação',      key: 'acao',         width: 12 },
      { header: 'Registro',  key: 'registro_id',  width: 10 },
      { header: 'Usuário',   key: 'usuario',      width: 16 },
      { header: 'Detalhe',   key: 'detalhe',      width: 60 },
      { header: 'IP',        key: 'ip',           width: 16 },
      { header: 'Data/Hora', key: 'created_at',   width: 20 },
    ];
    // Header style
    ws.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cell.alignment = { horizontal: 'center' };
    });
    // Data rows with action color coding
    const actionColors = { INSERT: 'FFD1FAE5', UPDATE: 'FFFEF9C3', DELETE: 'FFFEE2E2', LOGIN: 'FFE0F2FE' };
    rows.forEach(r => {
      const row = ws.addRow(r);
      const bg = actionColors[r.acao] || 'FFFAFAFA';
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      });
    });
    ws.autoFilter = { from: 'A1', to: 'H1' };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=AuditLog.xlsx`);
    await wb.xlsx.write(res);
  } catch(e) { errRes(res, e); }
});

// ─── CONCILIAÇÃO 3 VIAS ──────────────────────────────────────────
// Cruza: Notas Fiscais emitidas ↔ Extratos bancários recebidos ↔ Pagamentos do governo
router.get('/conciliacao/tres-vias', (req, res) => {
  try {
    const { from, to, contrato } = req.query;

    // 1. NFs por período (opcionalmente filtradas por contrato)
    let nfWhere = '1=1'; const nfP = {};
    if (from)     { nfWhere += ' AND data_emissao >= @from';   nfP.from     = from; }
    if (to)       { nfWhere += ' AND data_emissao <= @to';     nfP.to       = to; }
    if (contrato) { nfWhere += ' AND contrato_ref = @contrato'; nfP.contrato = contrato; }
    const nfs = req.db.prepare(
      `SELECT contrato_ref, numero, data_emissao, valor_bruto, valor_liquido, retencao FROM notas_fiscais WHERE ${nfWhere} ORDER BY data_emissao DESC`
    ).all(nfP);

    // 2. Extratos bancários (créditos vinculados) no período
    let extWhere = 'credito > 0 AND status_conciliacao = \'CONCILIADO\''; const extP = {};
    if (from)     { extWhere += ' AND data_iso >= @from';            extP.from     = from; }
    if (to)       { extWhere += ' AND data_iso <= @to';              extP.to       = to; }
    if (contrato) { extWhere += ' AND contrato_vinculado = @contrato'; extP.contrato = contrato; }
    const extratos = req.db.prepare(
      `SELECT contrato_vinculado, id, data, historico, credito FROM extratos WHERE ${extWhere} ORDER BY data_iso DESC`
    ).all(extP);

    // 3. Pagamentos do governo no período
    let pgWhere = '1=1'; const pgP = {};
    if (from) { pgWhere += ' AND data_pagamento_iso >= @from'; pgP.from = from; }
    if (to)   { pgWhere += ' AND data_pagamento_iso <= @to';   pgP.to   = to; }
    const pagamentos = req.db.prepare(
      `SELECT ob, gestao, favorecido, data_pagamento, valor_pago FROM pagamentos WHERE ${pgWhere} ORDER BY data_pagamento_iso DESC LIMIT 500`
    ).all(pgP);

    // 4. Resumo por contrato: agrupa pelas chaves usadas nas próprias NFs/extratos
    // (NFs e extratos usam identificadores históricos que podem diferir do numContrato atual)
    const mapaChaves = {};
    nfs.forEach(n => {
      const k = n.contrato_ref || '(sem contrato)';
      if (!mapaChaves[k]) mapaChaves[k] = { contrato: k, numContrato: k, qtdNFs: 0, totalNFs: 0, qtdExtratos: 0, totalExtrato: 0 };
      mapaChaves[k].qtdNFs++;
      mapaChaves[k].totalNFs += n.valor_bruto || 0;
    });
    extratos.forEach(e => {
      const k = e.contrato_vinculado || '(sem contrato)';
      if (!mapaChaves[k]) mapaChaves[k] = { contrato: k, numContrato: k, qtdNFs: 0, totalNFs: 0, qtdExtratos: 0, totalExtrato: 0 };
      mapaChaves[k].qtdExtratos++;
      mapaChaves[k].totalExtrato += e.credito || 0;
    });
    const resumo = Object.values(mapaChaves).map(r => {
      const diferenca = +(r.totalExtrato - r.totalNFs).toFixed(2);
      const status    = Math.abs(diferenca) < 1 ? 'OK' : diferenca > 0 ? 'EXTRATO_MAIOR' : 'NF_MAIOR';
      return { ...r, totalNFs: +r.totalNFs.toFixed(2), totalExtrato: +r.totalExtrato.toFixed(2), diferenca, status };
    }).filter(r => r.qtdNFs > 0 || r.qtdExtratos > 0)
      .sort((a, b) => Math.abs(b.diferenca) - Math.abs(a.diferenca));

    res.json({
      nfs, extratos, pagamentos, resumo,
      totais: {
        totalNFs:       nfs.reduce((s, n) => s + (n.valor_bruto || 0), 0),
        totalExtrato:   extratos.reduce((s, e) => s + (e.credito || 0), 0),
        totalPagamentos: pagamentos.reduce((s, p) => s + (p.valor_pago || 0), 0),
        qtdOK:          resumo.filter(r => r.status === 'OK').length,
        qtdDivergente:  resumo.filter(r => r.status !== 'OK').length,
      }
    });
  } catch(e) { errRes(res, e); }
});

// ─── DETALHE DO CONTRATO (Dashboard por contrato) ────────────────
router.get('/contratos/:num/detalhe', (req, res) => {
  try {
    const num = decodeURIComponent(req.params.num);
    const c = req.db.prepare(`SELECT * FROM contratos WHERE numContrato = ?`).get(num);
    if (!c) return res.status(404).json({ error: 'Contrato não encontrado' });

    // Prefixo da org para busca fuzzy (NFs e extratos podem usar numerações históricas
    // que diferem do numContrato atual, ex: "DETRAN 02/2024" vs "DETRAN 41/2023 + 2°TA")
    const orgKey = num.split(' ')[0];
    const orgLike = '%' + orgKey + '%';

    const parcelas  = req.db.prepare(`SELECT * FROM parcelas WHERE contrato_num = ? ORDER BY competencia DESC`).all(num);
    // NFs: tenta match exato em contrato_ref; fallback por prefixo da org
    const nfs       = req.db.prepare(`
      SELECT id, numero, competencia, data_emissao, valor_bruto, valor_liquido, retencao, contrato_ref
      FROM notas_fiscais
      WHERE contrato_ref = ? OR (contrato_ref LIKE ? AND contrato_ref != '')
      ORDER BY COALESCE(NULLIF(data_emissao,''),'0000-00-00') DESC
    `).all(num, orgLike);
    // Extratos: match exato em contrato_vinculado; fallback por prefixo da org
    const extratos  = req.db.prepare(`
      SELECT id, data, historico, credito, debito, status_conciliacao, contrato_vinculado
      FROM extratos
      WHERE contrato_vinculado = ? OR (contrato_vinculado LIKE ? AND contrato_vinculado != '')
      ORDER BY data_iso DESC LIMIT 200
    `).all(num, orgLike);
    // Despesas: sempre usam numContrato atual (correto por design)
    const despesas  = req.db.prepare(`SELECT id, categoria, descricao, data_despesa, valor_bruto, valor_liquido, status FROM despesas WHERE contrato_ref = ? ORDER BY data_iso DESC LIMIT 200`).all(num);

    const totalRecebido = extratos.reduce((s, e) => s + (e.credito || 0), 0);
    const totalNFs      = nfs.reduce((s, n) => s + (n.valor_bruto || 0), 0);
    const totalDespesas = despesas.reduce((s, d) => s + (d.valor_bruto || 0), 0);
    // Margem sobre o que foi efetivamente recebido (ou total_pago se extratos sem dados)
    const baseCalculo   = totalRecebido > 0 ? totalRecebido : (c.total_pago || 0);
    const margem        = baseCalculo > 0 ? +((baseCalculo - totalDespesas) / baseCalculo * 100).toFixed(1) : 0;

    const fluxoMensal = req.db.prepare(`
      SELECT substr(data_iso,1,7) as mes, SUM(credito) as recebido, COUNT(*) as qtd
      FROM extratos
      WHERE (contrato_vinculado = ? OR contrato_vinculado LIKE ?) AND data_iso != ''
      GROUP BY substr(data_iso,1,7) ORDER BY mes DESC LIMIT 12
    `).all(num, orgLike).reverse();

    res.json({ contrato: c, parcelas, nfs, extratos, despesas, fluxoMensal,
      resumo: { totalRecebido: +totalRecebido.toFixed(2), totalNFs: +totalNFs.toFixed(2),
        totalDespesas: +totalDespesas.toFixed(2), margem,
        qtdNFs: nfs.length, qtdExtratos: extratos.length, qtdDespesas: despesas.length } });
  } catch(e) { errRes(res, e); }
});

// ─── CLASSIFICAR CRÉDITOS INTERNO / INVESTIMENTO ─────────────────
// Marca extratos de crédito que são transferências internas ou resgates de aplicação
// (não são receita operacional → excluídos do DRE de faturamento)
router.post('/extratos/classificar-interno', (req, res) => {
  try {
    const PALAVRAS_INTERNO = [
      'MONTANA SEG', 'MONTANA ASSESSORIA', 'MONTANA VIGILANCIA',
      'MONTANA S LTDA', 'MONTANA SERVICOS', 'MONTANA SERV',
      '19200109000109', '14092519000151',
      'TRANSFERENCIA ENTRE CONTAS', 'ENTRE CONTAS PROPRIAS', 'TED ENTRE CONTAS',
      'TRANSFERENCIA INTERNA', 'TRANSFER INTERNA',
    ];
    const PALAVRAS_INVESTIMENTO = [
      'BB RENDE FACIL', 'RENDE FACIL', 'RENDE F',   // cobre "Rende Fácil" com acento
      'RESGATE CDB', 'RESGATE LCI', 'RESGATE LCA', 'RESGATE BB CDB', 'RESGATE DEP',
      'CDB DI BB', 'CDB DI',
      'APLIC.AUTOM.', 'APLIC AUTOM', 'APLIC.BB', 'APLIC BB',
      'RESG.AUTOM.', 'RESG AUTOM',
    ];

    const buildWhere = (palavras) =>
      palavras.map(() => `UPPER(historico) LIKE ?`).join(' OR ');
    const buildParams = (palavras) =>
      palavras.map(p => `%${p}%`);

    const db = req.db;

    // Só marca créditos ainda como PENDENTE para não sobrescrever CONCILIADO
    const stmtInt = db.prepare(
      `UPDATE extratos SET status_conciliacao = 'INTERNO'
       WHERE credito > 0 AND status_conciliacao = 'PENDENTE'
         AND (${buildWhere(PALAVRAS_INTERNO)})`
    );
    const stmtInv = db.prepare(
      `UPDATE extratos SET status_conciliacao = 'INVESTIMENTO'
       WHERE credito > 0 AND status_conciliacao = 'PENDENTE'
         AND (${buildWhere(PALAVRAS_INVESTIMENTO)})`
    );

    const resInt = stmtInt.run(...buildParams(PALAVRAS_INTERNO));
    const resInv = stmtInv.run(...buildParams(PALAVRAS_INVESTIMENTO));

    // Contagem de cada tipo após classificação
    const contagens = db.prepare(`
      SELECT status_conciliacao, COUNT(*) as qtd, COALESCE(SUM(credito),0) as total
      FROM extratos WHERE credito > 0
      GROUP BY status_conciliacao ORDER BY total DESC
    `).all();

    res.json({
      ok: true,
      marcados_interno: resInt.changes,
      marcados_investimento: resInv.changes,
      contagens,
    });
  } catch(e) { errRes(res, e); }
});

// ─── CONCILIAÇÃO DE CRÉDITOS PENDENTES ───────────────────────────
// Identifica créditos PENDENTE, classifica por categoria (contrato/INTERNO/INVESTIMENTO/DESCONHECIDO)
// e retorna resumo + detalhes para análise do financeiro.
router.get('/conciliacao/creditos', (req, res) => {
  try {
    const db = req.db;
    const { from, to } = req.query;

    // Regras de classificação em ordem de prioridade
    // Cada regra: { categoria, contrato_num (opcional), patterns: [LIKE strings para UPPER(historico)] }
    const REGRAS = [
      // INTERNO — transferências entre contas Montana
      { categoria: 'INTERNO', patterns: ['%14092519000151%','%MONTANA ASSESSORIA%','%MONTANA ASSESS%'] },
      { categoria: 'INTERNO', patterns: ['%19200109000109%','%MONTANA SEG%','%MONTANA VIGILANCIA%'] },
      { categoria: 'INTERNO', patterns: ['%MONTANA S LTDA%','%MONTANA SERVICOS%','%MONTANA SERV%'] },
      { categoria: 'INTERNO', patterns: ['%TRANSFERENCIA ENTRE CONTAS%','%ENTRE CONTAS PROP%','%TED ENTRE CONTAS%'] },
      { categoria: 'INTERNO', patterns: ['%TRANSFERENCIA INTERNA%','%TRANSFER INTERNA%'] },
      { categoria: 'INTERNO', patterns: ['%PORTO V S PRIVADA%','%PORTO DO VAU%','%PORTO VAU%'] },
      // PIX/TED retornados/rejeitados
      { categoria: 'DEVOLVIDO', patterns: ['%PIX - REJEITADO%','%PIX REJEITADO%','%TED DEVOLVIDA%','%CONTA DEST%','%AG OU CNT%'] },
      // INVESTIMENTO — resgates e aplicações
      { categoria: 'INVESTIMENTO', patterns: ['%BB RENDE FACIL%','%RENDE FACIL%','%RENDE F%'] }, // RENDE F cobre "Rende Fácil" (acento)
      { categoria: 'INVESTIMENTO', patterns: ['%RESGATE BB CDB%','%RESGATE CDB%','%CDB DI BB%','%CDB DI%'] },
      { categoria: 'INVESTIMENTO', patterns: ['%RESGATE DEPOSITO GARANTIA%','%RESGATE DEP%','%DEPOSITO GARANTIA%'] },
      { categoria: 'INVESTIMENTO', patterns: ['%APLIC.AUTOM%','%APLIC BB%','%RESG.AUTOM%'] },
      // DEP DISPONÍVEL — depósitos em espécie ou estado
      { categoria: 'ESTADO_TO', patterns: ['%DEP DISPONIV%','%DEP. DISPONIV%'] },
      // FUNDO ESPECIAL
      { categoria: 'ESTADO_TO', patterns: ['%FUNDO ESP%','%FUNDO ESPECIAL%'] },
      // Contratos por CNPJ ou nome no histórico
      { categoria: 'CONTRATO', contrato: 'UFT 16/2025',             patterns: ['%051497260001-04%','%05149726000104%','%FUNDACAO UNIVERSIDADE FEDERAL%','%FUNDACAO UFT%','%FUNDACAO UNIVERSIDAD%','%SEC TES NAC 051497260001%'] },
      { categoria: 'CONTRATO', contrato: 'UFNT 30/2022',            patterns: ['%UFNT%','%UNIVERSIDADE FEDERAL DO NORTE%','%UNIVERSIDADE FED NORTE%','%381788250001-73%','%38178825000173%'] },
      { categoria: 'CONTRATO', contrato: 'UNITINS 003/2023 + 3°TA', patterns: ['%UNITINS%','%UNIVERSIDADE ESTADUAL DO TOCANTINS%'] },
      { categoria: 'CONTRATO', contrato: 'DETRAN 41/2023 + 2°TA',   patterns: ['%DETRAN%'] },
      { categoria: 'CONTRATO', contrato: 'SESAU 178/2022',           patterns: ['%SESAU%','%SAUDE DO TOCANTINS%'] },
      { categoria: 'CONTRATO', contrato: 'SEDUC Limpeza/Copeiragem', patterns: ['%SEDUC%'] },
      { categoria: 'CONTRATO', contrato: 'TCE 117/2024',             patterns: ['%TCE%','%TRIBUNAL DE CONTAS%'] },
      { categoria: 'CONTRATO', contrato: 'PREVI PALMAS — em vigor',  patterns: ['%PREVIPALMAS%','%PREVI PALMAS%'] },
      { categoria: 'CONTRATO', contrato: 'SEMUS 192/2025',           patterns: ['%MUNICIPIO DE PALMAS%','%SEMUS%'] },
      { categoria: 'CONTRATO', contrato: 'SEMARH 32/2024',           patterns: ['%SEMARH%','%MEIO AMBIENTE%'] },
      { categoria: 'CONTRATO', contrato: 'CBMTO 011/2023 + 5°TA',   patterns: ['%CBMTO%','%BOMBEIROS%'] },
      // Nevada e Mustang e Porto do Vau (inter-empresas do grupo)
      { categoria: 'NEVADA',   patterns: ['%NEVADA M LIMPEZA%','%NEVADA MONTANHASEC%','%NEVADA MONTANA%'] },
      { categoria: 'INTERNO',  patterns: ['%MUSTANG G E EIRELI%','%MUSTANG - G E%','%MUSTANG G E%'] },
      { categoria: 'INTERNO',  patterns: ['%PORTO V S PR%','%PORTO VAU%','%PORTO DO VAU%'] },
      // Estado do Tocantins (pagamentos genéricos — Ordem Bancária ou TED)
      { categoria: 'ESTADO_TO', patterns: ['%ESTADO DO TOCANTINS%','%017860290001-03%','%01786029000103%','%GOVERNO DO EST%','%03173154000173%'] },
    ];

    let dateWhere = '';
    const dateParams = {};
    if (from) { dateWhere += ' AND data_iso >= @from'; dateParams.from = from; }
    if (to)   { dateWhere += ' AND data_iso <= @to';   dateParams.to   = to; }

    // Busca todos créditos pendentes
    const pendentes = db.prepare(`
      SELECT id, data, data_iso, historico, credito
      FROM extratos
      WHERE credito > 0
        AND (status_conciliacao IS NULL OR status_conciliacao IN ('PENDENTE',''))
        ${dateWhere}
      ORDER BY data_iso DESC, credito DESC
    `).all(dateParams);

    // Classifica cada crédito
    const resumo = {};
    const naoIdentificados = [];

    for (const e of pendentes) {
      const hist = (e.historico || '').toUpperCase();
      let matched = false;

      for (const regra of REGRAS) {
        if (regra.patterns.some(p => {
          // Converte LIKE pattern para JS: % → .*
          const re = new RegExp(p.replace(/%/g,'.*').replace(/_/g,'.'), 'i');
          return re.test(hist);
        })) {
          const key = regra.contrato || regra.categoria;
          if (!resumo[key]) resumo[key] = { categoria: regra.categoria, contrato: regra.contrato||null, qtd:0, total:0 };
          resumo[key].qtd++;
          resumo[key].total += e.credito;
          matched = true;
          break;
        }
      }

      if (!matched) naoIdentificados.push(e);
    }

    // Ordena por total desc
    const categorizado = Object.entries(resumo)
      .map(([k,v]) => ({ chave: k, ...v, total: +v.total.toFixed(2) }))
      .sort((a,b) => b.total - a.total);

    const totalPendente  = pendentes.reduce((s,e)=>s+e.credito,0);
    const totalIdentificado = categorizado.reduce((s,c)=>s+c.total,0);
    const totalNaoIdent   = naoIdentificados.reduce((s,e)=>s+e.credito,0);

    // Top 20 não identificados para análise
    const topNaoIdent = naoIdentificados
      .sort((a,b)=>b.credito-a.credito)
      .slice(0,20)
      .map(e=>({ id:e.id, data:e.data, historico:(e.historico||'').slice(0,70), credito:e.credito }));

    res.json({
      ok: true,
      sumario: {
        total_pendente:       +totalPendente.toFixed(2),
        total_identificado:   +totalIdentificado.toFixed(2),
        total_nao_identificado: +totalNaoIdent.toFixed(2),
        pct_identificado: totalPendente > 0 ? +(totalIdentificado/totalPendente*100).toFixed(1) : 0,
        qtd_pendente:     pendentes.length,
        qtd_identificado: pendentes.length - naoIdentificados.length,
        qtd_nao_identificado: naoIdentificados.length,
      },
      categorizado,
      nao_identificados_top20: topNaoIdent,
    });
  } catch(e) { errRes(res, e); }
});

// ─── CLASSIFICAR TODOS OS CRÉDITOS (aplica REGRAS completas no banco) ────────
// Diferente de /classificar-interno (que só atualiza INTERNO/INVESTIMENTO),
// este endpoint aplica TODAS as REGRAS e grava status + contrato_vinculado no banco.
// Só toca lançamentos com status PENDENTE ou NULL — nunca sobrescreve CONCILIADO.
router.post('/extratos/classificar-todos', (req, res) => {
  try {
    const db = req.db;
    const { from, to, banco, conta } = req.body || {};

    // Mesmas REGRAS usadas em GET /conciliacao/creditos
    const REGRAS = [
      { categoria: 'INTERNO',     contrato: null, patterns: ['%14092519000151%','%MONTANA ASSESSORIA%','%MONTANA ASSESS%'] },
      { categoria: 'INTERNO',     contrato: null, patterns: ['%19200109000109%','%MONTANA SEG%','%MONTANA VIGILANCIA%'] },
      { categoria: 'INTERNO',     contrato: null, patterns: ['%MONTANA S LTDA%','%MONTANA SERVICOS%','%MONTANA SERV%'] },
      { categoria: 'INTERNO',     contrato: null, patterns: ['%TRANSFERENCIA ENTRE CONTAS%','%ENTRE CONTAS PROP%','%TED ENTRE CONTAS%'] },
      { categoria: 'INTERNO',     contrato: null, patterns: ['%TRANSFERENCIA INTERNA%','%TRANSFER INTERNA%'] },
      { categoria: 'INTERNO',     contrato: null, patterns: ['%PORTO V S PR%','%PORTO VAU%','%PORTO DO VAU%'] },
      { categoria: 'DEVOLVIDO',   contrato: null, patterns: ['%PIX - REJEITADO%','%PIX REJEITADO%','%TED DEVOLVIDA%','%CONTA DEST%','%AG OU CNT%'] },
      { categoria: 'INVESTIMENTO',contrato: null, patterns: ['%BB RENDE FACIL%','%RENDE FACIL%','%RENDE F%'] },
      { categoria: 'INVESTIMENTO',contrato: null, patterns: ['%RESGATE BB CDB%','%RESGATE CDB%','%CDB DI BB%','%CDB DI%'] },
      { categoria: 'INVESTIMENTO',contrato: null, patterns: ['%RESGATE DEPOSITO GARANTIA%','%RESGATE DEP%','%DEPOSITO GARANTIA%'] },
      { categoria: 'INVESTIMENTO',contrato: null, patterns: ['%APLIC.AUTOM%','%APLIC BB%','%RESG.AUTOM%'] },
      { categoria: 'ESTADO_TO',   contrato: null, patterns: ['%DEP DISPONIV%','%DEP. DISPONIV%'] },
      { categoria: 'ESTADO_TO',   contrato: null, patterns: ['%FUNDO ESP%','%FUNDO ESPECIAL%'] },
      { categoria: 'CONTRATO',    contrato: 'UFT 16/2025',             patterns: ['%051497260001-04%','%05149726000104%','%FUNDACAO UNIVERSIDADE FEDERAL%','%FUNDACAO UFT%','%FUNDACAO UNIVERSIDAD%','%SEC TES NAC 051497260001%'] },
      { categoria: 'CONTRATO',    contrato: 'UFNT 30/2022',            patterns: ['%UFNT%','%UNIVERSIDADE FEDERAL DO NORTE%','%UNIVERSIDADE FED NORTE%','%381788250001-73%','%38178825000173%'] },
      { categoria: 'CONTRATO',    contrato: 'UNITINS 003/2023 + 3°TA', patterns: ['%UNITINS%','%UNIVERSIDADE ESTADUAL DO TOCANTINS%'] },
      { categoria: 'CONTRATO',    contrato: 'DETRAN 41/2023 + 2°TA',   patterns: ['%DETRAN%'] },
      { categoria: 'CONTRATO',    contrato: 'SESAU 178/2022',           patterns: ['%SESAU%','%SAUDE DO TOCANTINS%'] },
      { categoria: 'CONTRATO',    contrato: 'SEDUC Limpeza/Copeiragem', patterns: ['%SEDUC%'] },
      { categoria: 'CONTRATO',    contrato: 'TCE 117/2024',             patterns: ['%TCE%','%TRIBUNAL DE CONTAS%'] },
      { categoria: 'CONTRATO',    contrato: 'PREVI PALMAS — em vigor',  patterns: ['%PREVIPALMAS%','%PREVI PALMAS%'] },
      { categoria: 'CONTRATO',    contrato: 'SEMUS 192/2025',           patterns: ['%MUNICIPIO DE PALMAS%','%SEMUS%'] },
      { categoria: 'CONTRATO',    contrato: 'SEMARH 32/2024',           patterns: ['%SEMARH%','%MEIO AMBIENTE%'] },
      { categoria: 'CONTRATO',    contrato: 'CBMTO 011/2023 + 5°TA',   patterns: ['%CBMTO%','%BOMBEIROS%'] },
      { categoria: 'NEVADA',      contrato: null, patterns: ['%NEVADA M LIMPEZA%','%NEVADA MONTANHASEC%','%NEVADA MONTANA%'] },
      { categoria: 'INTERNO',     contrato: null, patterns: ['%MUSTANG G E EIRELI%','%MUSTANG - G E%','%MUSTANG G E%'] },
      { categoria: 'ESTADO_TO',   contrato: null, patterns: ['%ESTADO DO TOCANTINS%','%017860290001-03%','%01786029000103%','%GOVERNO DO EST%','%03173154000173%'] },
    ];

    let extraWhere = '';
    const extraParams = {};
    if (from) { extraWhere += ' AND data_iso >= @from'; extraParams.from = from; }
    if (to)   { extraWhere += ' AND data_iso <= @to';   extraParams.to   = to; }
    if (banco){ extraWhere += ' AND banco = @banco';    extraParams.banco = banco; }
    if (conta){ extraWhere += ' AND conta = @conta';    extraParams.conta = conta; }

    // Busca todos créditos PENDENTE (nunca sobrescreve CONCILIADO)
    const pendentes = db.prepare(`
      SELECT id, historico FROM extratos
      WHERE credito > 0
        AND (status_conciliacao IS NULL OR status_conciliacao IN ('PENDENTE',''))
        ${extraWhere}
    `).all(extraParams);

    const stmtUpdate = db.prepare(`
      UPDATE extratos
      SET status_conciliacao = @status,
          contrato_vinculado  = CASE WHEN @contrato IS NOT NULL THEN @contrato ELSE contrato_vinculado END,
          updated_at = datetime('now')
      WHERE id = @id
    `);

    let totalAtualizados = 0;
    const porCategoria = {};

    const updateMany = db.transaction(() => {
      for (const e of pendentes) {
        const hist = (e.historico || '').toUpperCase();
        for (const regra of REGRAS) {
          const matched = regra.patterns.some(p => {
            const re = new RegExp(p.replace(/%/g,'.*').replace(/_/g,'.'), 'i');
            return re.test(hist);
          });
          if (matched) {
            const status = regra.categoria;
            stmtUpdate.run({ id: e.id, status, contrato: regra.contrato || null });
            totalAtualizados++;
            const key = regra.contrato || regra.categoria;
            porCategoria[key] = (porCategoria[key] || 0) + 1;
            break;
          }
        }
      }
    });

    updateMany();

    // Resumo pós-classificação
    const contagens = db.prepare(`
      SELECT status_conciliacao, COUNT(*) as qtd, COALESCE(SUM(credito),0) as total
      FROM extratos WHERE credito > 0
      GROUP BY status_conciliacao ORDER BY total DESC
    `).all();

    res.json({
      ok: true,
      analisados: pendentes.length,
      atualizados: totalAtualizados,
      por_categoria: porCategoria,
      contagens_gerais: contagens,
    });
  } catch(e) { errRes(res, e); }
});

// ─── MATCH POR VALOR: liga créditos sem histórico a NFs/contratos ──────────
// Para lançamentos com histórico vazio, tenta encontrar uma NF ou mês de contrato
// cujo valor_liquido bate exatamente (ou dentro de tolerância) com o crédito.
// Retorna sugestões — não grava automaticamente, o usuário confirma cada uma.
router.get('/conciliacao/match-por-valor', (req, res) => {
  try {
    const db = req.db;
    const { from, to, banco, tolerancia = 0.02 } = req.query;
    const tol = parseFloat(tolerancia); // % de tolerância (ex: 0.02 = 2%)

    let dateWhere = '';
    const dateParams = {};
    if (from) { dateWhere += ' AND data_iso >= @from'; dateParams.from = from; }
    if (to)   { dateWhere += ' AND data_iso <= @to';   dateParams.to   = to; }
    if (banco){ dateWhere += ' AND banco = @banco';    dateParams.banco = banco; }

    // Créditos sem histórico (ou histórico muito curto) ainda PENDENTE
    const semHistorico = db.prepare(`
      SELECT id, data, data_iso, credito, historico, banco, conta
      FROM extratos
      WHERE credito > 0
        AND (status_conciliacao IS NULL OR status_conciliacao IN ('PENDENTE',''))
        AND (historico IS NULL OR TRIM(historico) = '' OR LENGTH(TRIM(historico)) < 5)
        ${dateWhere}
      ORDER BY data_iso DESC, credito DESC
    `).all(dateParams);

    // NFs com status diferente de CONCILIADO
    const nfs = db.prepare(`
      SELECT id, numero, data_emissao, tomador, valor_liquido, valor_bruto, contrato_ref, status_conciliacao
      FROM notas_fiscais
      WHERE (status_conciliacao IS NULL OR status_conciliacao != 'CONCILIADO')
      ORDER BY data_emissao DESC
    `).all();

    // Contratos ativos com valor mensal
    const contratos = db.prepare(`
      SELECT id, numContrato, contrato, orgao, valor_mensal_liquido, valor_mensal_bruto
      FROM contratos
      WHERE status = 'ATIVO' AND valor_mensal_liquido > 0
    `).all();

    const sugestoes = [];

    for (const e of semHistorico) {
      const candidatos = [];
      const val = e.credito;

      // Tenta match com NFs individuais
      for (const nf of nfs) {
        const diff = Math.abs(nf.valor_liquido - val) / val;
        if (diff <= tol) {
          candidatos.push({
            tipo: 'NF',
            id_ref: nf.id,
            numero_nf: nf.numero,
            tomador: nf.tomador,
            contrato_ref: nf.contrato_ref,
            valor_ref: nf.valor_liquido,
            diferenca: +(nf.valor_liquido - val).toFixed(2),
            pct_diferenca: +(diff * 100).toFixed(2),
            confianca: diff === 0 ? 'EXATO' : diff < 0.005 ? 'ALTA' : 'MEDIA',
          });
        }
      }

      // Tenta match com valor mensal de contrato
      for (const c of contratos) {
        const diff = Math.abs(c.valor_mensal_liquido - val) / val;
        if (diff <= tol) {
          candidatos.push({
            tipo: 'CONTRATO_MENSAL',
            id_ref: c.id,
            contrato_ref: c.numContrato,
            tomador: c.orgao,
            valor_ref: c.valor_mensal_liquido,
            diferenca: +(c.valor_mensal_liquido - val).toFixed(2),
            pct_diferenca: +(diff * 100).toFixed(2),
            confianca: diff === 0 ? 'EXATO' : diff < 0.005 ? 'ALTA' : 'MEDIA',
          });
        }
      }

      // Tenta match com soma de NFs do mesmo mês e contrato
      if (e.data_iso) {
        const mes = e.data_iso.slice(0, 7);
        const somaPorContrato = {};
        for (const nf of nfs) {
          if (nf.data_emissao && nf.data_emissao.startsWith(mes) && nf.contrato_ref) {
            somaPorContrato[nf.contrato_ref] = (somaPorContrato[nf.contrato_ref] || 0) + nf.valor_liquido;
          }
        }
        for (const [contrato_ref, soma] of Object.entries(somaPorContrato)) {
          const diff = Math.abs(soma - val) / val;
          if (diff <= tol && !candidatos.find(c => c.contrato_ref === contrato_ref)) {
            candidatos.push({
              tipo: 'SOMA_NFS_MES',
              contrato_ref,
              tomador: contratos.find(c => c.numContrato === contrato_ref)?.orgao || contrato_ref,
              valor_ref: +soma.toFixed(2),
              diferenca: +(soma - val).toFixed(2),
              pct_diferenca: +(diff * 100).toFixed(2),
              confianca: diff === 0 ? 'EXATO' : diff < 0.005 ? 'ALTA' : 'MEDIA',
            });
          }
        }
      }

      if (candidatos.length > 0) {
        // Ordena por confiança: EXATO > ALTA > MEDIA
        const ordemConfianca = { EXATO: 0, ALTA: 1, MEDIA: 2 };
        candidatos.sort((a, b) => ordemConfianca[a.confianca] - ordemConfianca[b.confianca]);
        sugestoes.push({
          extrato: { id: e.id, data: e.data, data_iso: e.data_iso, credito: e.credito, banco: e.banco, conta: e.conta },
          candidatos,
        });
      }
    }

    res.json({
      ok: true,
      sem_historico_total: semHistorico.length,
      com_sugestao: sugestoes.length,
      sem_sugestao: semHistorico.length - sugestoes.length,
      sugestoes,
    });
  } catch(e) { errRes(res, e); }
});

// ─── APLICAR MATCH: confirma uma sugestão de match-por-valor ─────────────────
router.post('/conciliacao/aplicar-match', (req, res) => {
  try {
    const db = req.db;
    const { extrato_id, contrato_ref, status, obs } = req.body;
    if (!extrato_id || !contrato_ref || !status) {
      return res.status(400).json({ error: 'extrato_id, contrato_ref e status são obrigatórios' });
    }
    const statusValidos = ['CONCILIADO', 'CONTRATO', 'ESTADO_TO', 'INTERNO', 'INVESTIMENTO'];
    if (!statusValidos.includes(status)) {
      return res.status(400).json({ error: `status inválido. Use: ${statusValidos.join(', ')}` });
    }
    db.prepare(`
      UPDATE extratos
      SET status_conciliacao = @status,
          contrato_vinculado  = @contrato_ref,
          obs = CASE WHEN @obs IS NOT NULL THEN @obs ELSE obs END,
          updated_at = datetime('now')
      WHERE id = @extrato_id
    `).run({ extrato_id, contrato_ref, status, obs: obs || null });
    res.json({ ok: true });
  } catch(e) { errRes(res, e); }
});

// ─── DASHBOARD DE CONCILIAÇÃO ─────────────────────────────────────────────────
// Retorna progresso de conciliação por mês e por contrato para painel gerencial.
router.get('/conciliacao/dashboard', (req, res) => {
  try {
    const db = req.db;
    const { ano } = req.query;
    const anoFiltro = ano || new Date().getFullYear().toString();

    // Progresso por mês (créditos)
    const porMes = db.prepare(`
      SELECT
        substr(data_iso,1,7) as mes,
        COUNT(*) as total_lancamentos,
        SUM(credito) as total_credito,
        SUM(CASE WHEN status_conciliacao NOT IN ('PENDENTE','') AND status_conciliacao IS NOT NULL THEN 1 ELSE 0 END) as lancamentos_conciliados,
        SUM(CASE WHEN status_conciliacao NOT IN ('PENDENTE','') AND status_conciliacao IS NOT NULL THEN credito ELSE 0 END) as valor_conciliado,
        SUM(CASE WHEN status_conciliacao IN ('PENDENTE','') OR status_conciliacao IS NULL THEN credito ELSE 0 END) as valor_pendente
      FROM extratos
      WHERE credito > 0 AND data_iso LIKE @ano || '%'
      GROUP BY substr(data_iso,1,7)
      ORDER BY mes
    `).all({ ano: anoFiltro });

    // Progresso por contrato (somente extratos vinculados)
    const porContrato = db.prepare(`
      SELECT
        contrato_vinculado,
        COUNT(*) as qtd_lancamentos,
        SUM(credito) as total_recebido,
        SUM(CASE WHEN status_conciliacao = 'CONCILIADO' THEN credito ELSE 0 END) as valor_conciliado,
        MIN(data_iso) as primeiro_lancamento,
        MAX(data_iso) as ultimo_lancamento
      FROM extratos
      WHERE credito > 0
        AND contrato_vinculado IS NOT NULL AND contrato_vinculado != ''
        AND data_iso LIKE @ano || '%'
      GROUP BY contrato_vinculado
      ORDER BY total_recebido DESC
    `).all({ ano: anoFiltro });

    // Totais gerais do ano
    const totais = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(credito) as total_credito,
        SUM(CASE WHEN status_conciliacao NOT IN ('PENDENTE','') AND status_conciliacao IS NOT NULL THEN 1 ELSE 0 END) as conciliados,
        SUM(CASE WHEN status_conciliacao NOT IN ('PENDENTE','') AND status_conciliacao IS NOT NULL THEN credito ELSE 0 END) as credito_conciliado
      FROM extratos
      WHERE credito > 0 AND data_iso LIKE @ano || '%'
    `).get({ ano: anoFiltro });

    // Créditos sem histórico ainda pendentes (problema de conciliação manual)
    const semHistorico = db.prepare(`
      SELECT COUNT(*) as qtd, COALESCE(SUM(credito),0) as total
      FROM extratos
      WHERE credito > 0
        AND (status_conciliacao IS NULL OR status_conciliacao IN ('PENDENTE',''))
        AND (historico IS NULL OR TRIM(historico) = '' OR LENGTH(TRIM(historico)) < 5)
        AND data_iso LIKE @ano || '%'
    `).get({ ano: anoFiltro });

    // Resumo por categoria (todo o banco)
    const porCategoria = db.prepare(`
      SELECT
        COALESCE(status_conciliacao,'PENDENTE') as categoria,
        COUNT(*) as qtd,
        SUM(credito) as total
      FROM extratos
      WHERE credito > 0 AND data_iso LIKE @ano || '%'
      GROUP BY COALESCE(status_conciliacao,'PENDENTE')
      ORDER BY total DESC
    `).all({ ano: anoFiltro });

    const pctConciliado = totais.total_credito > 0
      ? +((totais.credito_conciliado / totais.total_credito) * 100).toFixed(1)
      : 0;

    res.json({
      ok: true,
      ano: anoFiltro,
      resumo: {
        total_lancamentos: totais.total,
        total_credito: +totais.total_credito.toFixed(2),
        conciliados: totais.conciliados,
        credito_conciliado: +totais.credito_conciliado.toFixed(2),
        pct_conciliado: pctConciliado,
        sem_historico_pendente: semHistorico.qtd,
        valor_sem_historico_pendente: +semHistorico.total.toFixed(2),
      },
      por_mes: porMes.map(m => ({
        ...m,
        total_credito: +m.total_credito.toFixed(2),
        valor_conciliado: +m.valor_conciliado.toFixed(2),
        valor_pendente: +m.valor_pendente.toFixed(2),
        pct_conciliado: m.total_credito > 0
          ? +((m.valor_conciliado / m.total_credito) * 100).toFixed(1) : 0,
      })),
      por_contrato: porContrato.map(c => ({
        ...c,
        total_recebido: +c.total_recebido.toFixed(2),
        valor_conciliado: +c.valor_conciliado.toFixed(2),
        pct_conciliado: c.total_recebido > 0
          ? +((c.valor_conciliado / c.total_recebido) * 100).toFixed(1) : 0,
      })),
      por_categoria: porCategoria.map(c => ({
        ...c,
        total: +c.total.toFixed(2),
      })),
    });
  } catch(e) { errRes(res, e); }
});

// ─── DUPLICATAS: detecta lançamentos suspeitos de duplicidade ──────────────
// Busca créditos com mesmo valor e data próxima em bancos diferentes (possível duplicata
// entre BB e BRB, situação já detectada no 03/10/2025).
router.get('/conciliacao/duplicatas', (req, res) => {
  try {
    const db = req.db;
    const { from, to, janela_dias = 3, tolerancia_valor = 0.01 } = req.query;
    const janela = parseInt(janela_dias);

    let dateWhere = '';
    const dateParams = {};
    if (from) { dateWhere += ' AND a.data_iso >= @from'; dateParams.from = from; }
    if (to)   { dateWhere += ' AND a.data_iso <= @to';   dateParams.to   = to; }

    // Busca pares de créditos em bancos diferentes com valor idêntico e datas próximas
    const pares = db.prepare(`
      SELECT
        a.id as id_a, a.data as data_a, a.banco as banco_a, a.conta as conta_a,
        a.credito as credito_a, a.historico as historico_a, a.status_conciliacao as status_a,
        b.id as id_b, b.data as data_b, b.banco as banco_b, b.conta as conta_b,
        b.credito as credito_b, b.historico as historico_b, b.status_conciliacao as status_b,
        ABS(a.credito - b.credito) as diferenca_valor,
        ABS(julianday(a.data_iso) - julianday(b.data_iso)) as diferenca_dias
      FROM extratos a
      JOIN extratos b ON (
        a.id < b.id
        AND (a.banco != b.banco OR a.conta != b.conta)
        AND ABS(a.credito - b.credito) / a.credito <= @tol
        AND ABS(julianday(a.data_iso) - julianday(b.data_iso)) <= @janela
        AND a.credito > 0 AND b.credito > 0
      )
      WHERE 1=1 ${dateWhere}
      ORDER BY a.data_iso DESC, a.credito DESC
      LIMIT 100
    `).all({ ...dateParams, tol: parseFloat(tolerancia_valor), janela });

    res.json({
      ok: true,
      total_pares: pares.length,
      pares: pares.map(p => ({
        extrato_a: { id: p.id_a, data: p.data_a, banco: p.banco_a, conta: p.conta_a, credito: p.credito_a, historico: (p.historico_a||'').slice(0,60), status: p.status_a },
        extrato_b: { id: p.id_b, data: p.data_b, banco: p.banco_b, conta: p.conta_b, credito: p.credito_b, historico: (p.historico_b||'').slice(0,60), status: p.status_b },
        diferenca_valor: +p.diferenca_valor.toFixed(2),
        diferenca_dias: +p.diferenca_dias.toFixed(0),
        alerta: p.diferenca_valor === 0 && p.diferenca_dias === 0 ? 'CRITICO' : p.diferenca_dias <= 1 ? 'ALTO' : 'MEDIO',
      })),
    });
  } catch(e) { errRes(res, e); }
});

// ─── KEYWORDS DE AUTO-VINCULAÇÃO ─────────────────────────────────
router.get('/configuracoes/keywords', (req, res) => {
  try {
    const row = req.db.prepare(`SELECT valor FROM configuracoes WHERE chave = 'autovinc_keywords'`).get();
    if (row && row.valor) {
      try { return res.json({ keywords: JSON.parse(row.valor) }); } catch(_e) {}
    }
    // Padrão inicial (será salvo na primeira edição)
    const defaults = [
      { palavra: 'uft',         contrato: '' },
      { palavra: 'unitins',     contrato: '' },
      { palavra: 'seduc',       contrato: '' },
      { palavra: 'detran',      contrato: '' },
      { palavra: 'tce',         contrato: '' },
      { palavra: 'cbm',         contrato: '' },
      { palavra: 'semus',       contrato: '' },
      { palavra: 'prefeitura',  contrato: '' },
      { palavra: 'pgj',         contrato: '' },
      { palavra: 'mp',          contrato: '' },
      { palavra: 'previ',       contrato: '' },
      { palavra: 'seccidades',  contrato: '' },
    ];
    res.json({ keywords: defaults });
  } catch(e) { errRes(res, e); }
});

router.put('/configuracoes/keywords', (req, res) => {
  try {
    const { keywords } = req.body;
    if (!Array.isArray(keywords)) return res.status(400).json({ error: 'keywords deve ser um array' });
    req.db.prepare(`INSERT OR REPLACE INTO configuracoes (chave, valor, updated_at) VALUES ('autovinc_keywords', @valor, datetime('now'))`)
      .run({ valor: JSON.stringify(keywords) });
    res.json({ ok: true });
  } catch(e) { errRes(res, e); }
});

// ── Audit log: listagem ───────────────────────────────────────
router.get('/audit', (req, res) => {
  try {
    const { limit = 100, offset = 0, tabela, usuario, from, to } = req.query;
    let where = '1=1';
    const params = {};
    if (tabela)  { where += ' AND tabela = @tabela';           params.tabela  = tabela; }
    if (usuario) { where += ' AND usuario = @usuario';         params.usuario = usuario; }
    if (from)    { where += ' AND created_at >= @from';        params.from    = from; }
    if (to)      { where += ' AND created_at <= @to';          params.to      = to + ' 23:59:59'; }
    params.limit  = parseInt(limit);
    params.offset = parseInt(offset);
    const rows = req.db.prepare(
      `SELECT * FROM audit_log WHERE ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`
    ).all(params);
    const total = req.db.prepare(`SELECT COUNT(*) as cnt FROM audit_log WHERE ${where}`).get(params).cnt;
    res.json({ ok: true, total, data: rows });
  } catch(e) { errRes(res, e); }
});

// ── Config SMTP: GET (lê do banco) e POST (salva + testa) ─────
router.get('/config/smtp', (req, res) => {
  try {
    const rows = req.db.prepare(`SELECT chave, valor FROM configuracoes WHERE chave LIKE 'smtp_%'`).all();
    const smtp = {};
    rows.forEach(r => { smtp[r.chave.replace('smtp_', '')] = r.valor; });
    // nunca retorna a senha
    delete smtp.pass;
    res.json({ ok: true, smtp });
  } catch(e) { errRes(res, e); }
});

router.post('/config/smtp', (req, res) => {
  try {
    const fields = ['host','port','user','pass','from','to'];
    const stmt = req.db.prepare(`INSERT OR REPLACE INTO configuracoes (chave, valor, updated_at) VALUES (?, ?, datetime('now'))`);
    const save = req.db.transaction(() => {
      fields.forEach(f => {
        if (req.body[f] !== undefined && req.body[f] !== '')
          stmt.run('smtp_' + f, String(req.body[f]));
      });
    });
    save();
    res.json({ ok: true });
  } catch(e) { errRes(res, e); }
});

router.post('/config/smtp-test', async (req, res) => {
  try {
    const nodemailer = require('nodemailer');
    const { host, port, user, pass, dest } = req.body;
    if (!host || !user || !pass) return res.json({ ok: false, error: 'Preencha host, usuário e senha' });
    const transporter = nodemailer.createTransport({
      host, port: parseInt(port) || 587,
      secure: parseInt(port) === 465,
      auth: { user, pass }
    });
    await transporter.verify();
    if (dest) {
      await transporter.sendMail({
        from: user, to: dest,
        subject: '✅ Montana Sistema — Teste SMTP',
        html: '<p>Conexão SMTP configurada com sucesso!</p>'
      });
    }
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// CONCILIAÇÃO AUTOMÁTICA POR VALOR + DATA (±3 dias)
// ═══════════════════════════════════════════════════════════════
router.post('/conciliar-auto-valor', (req, res) => {
  try {
    const { dias_tolerancia = 3, contrato_num } = req.body;
    const tol = Math.min(parseInt(dias_tolerancia) || 3, 10); // máximo 10 dias

    // Busca extratos PENDENTES com crédito > 0
    let sqlExt = `SELECT * FROM extratos WHERE status_conciliacao='PENDENTE' AND credito > 0`;
    const extParams = [];
    if (contrato_num) { /* sem filtro por contrato no extrato — o contrato está na NF */ }
    const extratos = req.db.prepare(sqlExt).all(...extParams);

    // Busca NFs ativas com valor_liquido > 0 e não já vinculadas
    const nfsSql = `
      SELECT n.*, c.numContrato
      FROM notas_fiscais n
      LEFT JOIN contratos c ON c.contrato = n.tomador OR c.numContrato = n.contrato_ref
      WHERE n.valor_liquido > 0
        AND n.status_conciliacao != 'CONCILIADO'
    `;
    const nfs = req.db.prepare(nfsSql).all();

    const insVinc = req.db.prepare(`
      INSERT OR IGNORE INTO vinculacoes (extrato_id, contrato_num, tipo, valor, usuario)
      VALUES (@extrato_id, @contrato_num, 'AUTO-VALOR', @valor, @usuario)
    `);
    const updExt = req.db.prepare(`
      UPDATE extratos SET contrato_vinculado=@cv, status_conciliacao='CONCILIADO', updated_at=datetime('now') WHERE id=@id
    `);
    const updNf = req.db.prepare(`
      UPDATE notas_fiscais SET status_conciliacao='CONCILIADO' WHERE id=@id
    `);

    let vinculados = 0;
    const usuario = req.user?.login || 'auto';

    const processar = req.db.transaction(() => {
      for (const ext of extratos) {
        if (!ext.data_iso) continue;
        const extDate = new Date(ext.data_iso).getTime();

        for (const nf of nfs) {
          if (!nf.data_emissao) continue;
          // Tolerância de valor: ±0.05 (diferença de centavos)
          const diff = Math.abs(ext.credito - nf.valor_liquido);
          if (diff > 0.05) continue;

          // Tolerância de data
          const nfDate = new Date(nf.data_emissao).getTime();
          const diffDias = Math.abs(extDate - nfDate) / 86400000;
          if (diffDias > tol) continue;

          // Match encontrado — vincula
          const cNum = nf.contrato_ref || nf.numContrato || '';
          if (!cNum) continue;

          try {
            insVinc.run({ extrato_id: ext.id, contrato_num: cNum, valor: ext.credito, usuario });
            updExt.run({ cv: cNum, id: ext.id });
            updNf.run({ id: nf.id });
            vinculados++;
          } catch(_) { /* duplicado — ignora */ }
          break; // cada extrato vincula com apenas uma NF
        }
      }
    });
    processar();
    dashCacheInvalidate(req.companyKey);
    audit(req, 'AUTO-CONCILIAR-VALOR', 'vinculacoes', '', `${vinculados} vinculações criadas (tol. ${tol} dias)`);
    res.json({ ok: true, vinculados, message: `${vinculados} extrato(s) vinculado(s) automaticamente por valor+data` });
  } catch(e) { errRes(res, e); }
});

// ═══════════════════════════════════════════════════════════════
// RELATÓRIO DE DIFERENÇA DE RETENÇÃO (NF vs extrato)
// ═══════════════════════════════════════════════════════════════
router.get('/relatorio/retencao', (req, res) => {
  try {
    const { from, to } = req.query;
    const p = {};
    let whereNf = '1=1', whereExt = '1=1';
    if (from) { whereNf += ' AND n.data_emissao >= @from'; whereExt += ' AND e.data_iso >= @from'; p.from = from; }
    if (to)   { whereNf += ' AND n.data_emissao <= @to';   whereExt += ' AND e.data_iso <= @to';   p.to   = to;   }

    // Retenções das NFs emitidas
    const nfs = req.db.prepare(`
      SELECT n.numero, n.data_emissao, n.tomador, n.valor_bruto, n.valor_liquido,
             n.inss, n.ir as irrf, n.iss, n.csll, n.pis, n.cofins, n.retencao as total_ret,
             n.contrato_ref
      FROM notas_fiscais n WHERE ${whereNf}
      ORDER BY n.data_emissao DESC
    `).all(p);

    // Total retido nos extratos (débitos com histórico contendo retenção) — por contrato_vinculado
    const extRetencoes = req.db.prepare(`
      SELECT e.contrato_vinculado, SUM(COALESCE(e.retencao,0)) as ret_extrato,
             COUNT(*) as qtd_pagamentos
      FROM extratos e
      WHERE ${whereExt} AND e.status_conciliacao='CONCILIADO' AND e.contrato_vinculado != ''
      GROUP BY e.contrato_vinculado
    `).all(p);

    const retMap = {};
    extRetencoes.forEach(r => { retMap[r.contrato_vinculado] = r; });

    // Calcula diferença por NF
    const linhas = nfs.map(nf => {
      const extRet = retMap[nf.contrato_ref || ''];
      const ret_nf      = nf.total_ret || 0;
      const ret_extrato = extRet ? (extRet.ret_extrato / (extRet.qtd_pagamentos || 1)) : null;
      const diferenca   = ret_extrato !== null ? ret_nf - ret_extrato : null;
      return { ...nf, ret_extrato, diferenca };
    });

    const totalNf  = linhas.reduce((s,l) => s + (l.total_ret||0), 0);
    const totalExt = extRetencoes.reduce((s,r) => s + (r.ret_extrato||0), 0);

    res.json({
      ok: true,
      linhas,
      totais: {
        total_retencao_nf:      +totalNf.toFixed(2),
        total_retencao_extrato: +totalExt.toFixed(2),
        diferenca:              +(totalNf - totalExt).toFixed(2)
      }
    });
  } catch(e) { errRes(res, e); }
});

// GET /relatorios/fluxo-projetado?meses=6
router.get('/relatorios/fluxo-projetado', (req, res) => {
  const db = req.db;
  const meses = parseInt(req.query.meses) || 6;

  // Contratos ativos com valor
  const contratos = db.prepare(`
    SELECT id, numContrato, orgao, contrato, valor_mensal_liquido, valor_mensal_bruto,
           vigencia_fim, status
    FROM contratos
    WHERE (status IS NULL OR status != 'encerrado')
      AND (valor_mensal_liquido > 0 OR valor_mensal_bruto > 0)
    ORDER BY valor_mensal_liquido DESC
  `).all();

  // Calcular atraso médio por contrato (últimos 6 meses)
  const hoje = new Date();
  const ha180 = new Date(hoje - 180 * 86400000).toISOString().split('T')[0];

  const contratosComAtraso = contratos.map(c => {
    let atraso_medio = 15; // padrão
    try {
      const pagamentos = db.prepare(`
        SELECT data_iso, competencia FROM extratos
        WHERE contrato_vinculado = ? AND data_iso >= ? AND credito > 0
        ORDER BY data_iso DESC LIMIT 12
      `).all(c.numContrato, ha180);

      if (pagamentos.length >= 2) {
        const atrasos = pagamentos.map(p => {
          if (!p.competencia) return 15;
          const [ano, mes] = p.competencia.split('-');
          const esperado = new Date(parseInt(ano), parseInt(mes) - 1, 10);
          const real = new Date(p.data_iso);
          return Math.max(0, Math.round((real - esperado) / 86400000));
        });
        atraso_medio = Math.round(atrasos.reduce((a,b) => a+b, 0) / atrasos.length);
      }
    } catch(e) {}

    return {
      ...c,
      valor: c.valor_mensal_liquido || c.valor_mensal_bruto,
      atraso_medio_dias: atraso_medio
    };
  });

  // Projetar próximos N meses
  const projecao = [];
  for (let i = 1; i <= meses; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() + i, 1);
    const mesAno = d.toISOString().slice(0, 7);
    const receitaPrevista = contratosComAtraso.reduce((s, c) => s + (c.valor || 0), 0);
    const atrasoMedio = contratosComAtraso.length
      ? Math.round(contratosComAtraso.reduce((s,c) => s + c.atraso_medio_dias, 0) / contratosComAtraso.length)
      : 15;
    const dataRecebimento = new Date(d.getTime() + atrasoMedio * 86400000).toISOString().split('T')[0];

    projecao.push({
      mes: mesAno,
      receita_prevista: receitaPrevista,
      data_recebimento_prevista: dataRecebimento,
      atraso_medio_dias: atrasoMedio,
      contratos: contratosComAtraso.map(c => ({
        numContrato: c.numContrato,
        orgao: c.orgao,
        valor: c.valor,
        atraso_medio_dias: c.atraso_medio_dias
      }))
    });
  }

  const total_mensal = contratosComAtraso.reduce((s,c) => s + (c.valor||0), 0);
  const media_atraso = contratosComAtraso.length
    ? Math.round(contratosComAtraso.reduce((s,c) => s + c.atraso_medio_dias, 0) / contratosComAtraso.length)
    : 15;

  res.json({ projecao, total_mensal_previsto: total_mensal, media_atraso_geral: media_atraso, contratos_ativos: contratosComAtraso.length });
});

// GET /contratos/:id/timeline
router.get('/contratos/:id/timeline', (req, res) => {
  const db = req.db;
  const id = req.params.id;

  const contrato = db.prepare('SELECT * FROM contratos WHERE id=?').get(id);
  if (!contrato) return res.status(404).json({ error: 'Contrato não encontrado' });

  // Pagamentos recebidos (últimos 12)
  const pagamentos = db.prepare(`
    SELECT data_iso, credito, historico, competencia FROM extratos
    WHERE contrato_vinculado = ? AND credito > 0
    ORDER BY data_iso DESC LIMIT 12
  `).all(contrato.numContrato);

  // NFs emitidas
  const nfs = db.prepare(`
    SELECT numero, data_emissao, valor_bruto, valor_liquido, status_conciliacao FROM notas_fiscais
    WHERE contrato_ref = ? ORDER BY data_emissao DESC LIMIT 12
  `).all(contrato.numContrato);

  // Boletins
  let boletins = [];
  try {
    boletins = db.prepare(`
      SELECT b.competencia, b.valor_total, b.status FROM bol_boletins b
      JOIN bol_contratos bc ON b.contrato_id = bc.id
      WHERE bc.contrato_ref = ? ORDER BY b.competencia DESC LIMIT 6
    `).all(contrato.numContrato);
  } catch(e) {}

  // Calcular % executado
  const hoje = new Date();
  const inicio = contrato.vigencia_inicio ? new Date(contrato.vigencia_inicio) : null;
  const fim = contrato.vigencia_fim ? new Date(contrato.vigencia_fim) : null;
  const meses_vigencia = inicio && fim ? Math.max(1, Math.round((fim - inicio) / (30 * 86400000))) : 12;
  const valor_total_estimado = (contrato.valor_mensal_bruto || 0) * meses_vigencia;
  const pct_executado = valor_total_estimado > 0 ? Math.min(100, Math.round((contrato.total_pago || 0) / valor_total_estimado * 100)) : 0;
  const dias_para_vencer = fim ? Math.round((fim - hoje) / 86400000) : null;

  // Aditivos (do campo obs_reajuste ou obs)
  const aditivos = [];
  if (contrato.obs_reajuste) aditivos.push({ tipo: 'Reajuste', descricao: contrato.obs_reajuste, data: contrato.data_ultimo_reajuste });
  if (contrato.obs) {
    const matches = contrato.obs.match(/\d+[°ºo]\s*[Tt][Aa]/g);
    if (matches) matches.forEach((m, i) => aditivos.push({ tipo: 'Aditivo', descricao: m, data: null }));
  }

  res.json({
    contrato,
    pagamentos,
    nfs,
    boletins,
    aditivos,
    total_pago: contrato.total_pago || 0,
    total_nfs: nfs.reduce((s, n) => s + (n.valor_bruto || 0), 0),
    percentual_executado: pct_executado,
    valor_total_estimado,
    dias_para_vencer,
    meses_vigencia
  });
});

// GET /relatorios/margem-por-posto
router.get('/relatorios/margem-por-posto', (req, res) => {
  const db = req.db;
  const { from, to, contrato } = req.query;
  const dateFrom = from || new Date().getFullYear() + '-01-01';
  const dateTo   = to   || new Date().getFullYear() + '-12-31';

  // Verificar se tabelas de boletins existem
  const tblExiste = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bol_postos'").get();
  if (!tblExiste) return res.json({ postos: [], total_receita: 0, message: 'Tabela bol_postos não encontrada' });

  try {
    let query = `
      SELECT
        p.id, p.descricao, p.tipo_posto, p.qtd_funcionarios,
        bc.contrato_ref, bc.orgao,
        COALESCE(SUM(bb.valor_total), 0) as receita_total,
        COUNT(DISTINCT bb.id) as qtd_boletins
      FROM bol_postos p
      JOIN bol_contratos bc ON p.contrato_id = bc.id
      LEFT JOIN bol_boletins bb ON bb.contrato_id = bc.id
        AND substr(bb.competencia,1,7) BETWEEN substr(@from,1,7) AND substr(@to,1,7)
      WHERE 1=1
    `;
    const params = { from: dateFrom, to: dateTo };
    if (contrato) { query += ' AND bc.contrato_ref = @contrato'; params.contrato = contrato; }
    query += ' GROUP BY p.id ORDER BY receita_total DESC';

    const postos = db.prepare(query).all(params);

    // Calcular custo estimado por posto (proporcional à receita do contrato)
    // Buscar folha do contrato no período
    const folhaPorContrato = {};
    const folhas = db.prepare(`
      SELECT contrato_ref, SUM(valor_bruto) total
      FROM despesas
      WHERE UPPER(TRIM(categoria)) LIKE 'FOLHA%'
        AND data_iso BETWEEN @from AND @to
        AND contrato_ref IS NOT NULL AND contrato_ref != ''
      GROUP BY contrato_ref
    `).all({ from: dateFrom, to: dateTo });
    folhas.forEach(f => { folhaPorContrato[f.contrato_ref] = f.total; });

    // Postos por contrato para dividir proporcionalmente
    const postosPorContrato = {};
    postos.forEach(p => {
      if (!postosPorContrato[p.contrato_ref]) postosPorContrato[p.contrato_ref] = 0;
      postosPorContrato[p.contrato_ref]++;
    });

    const resultado = postos.map(p => {
      const folhaContrato = folhaPorContrato[p.contrato_ref] || 0;
      const nPostos = postosPorContrato[p.contrato_ref] || 1;
      const custo_estimado = folhaContrato / nPostos;
      const margem_valor = p.receita_total - custo_estimado;
      const margem_pct = p.receita_total > 0 ? (margem_valor / p.receita_total * 100) : 0;
      return { ...p, custo_estimado, margem_valor, margem_pct: Math.round(margem_pct * 10) / 10 };
    }).sort((a, b) => a.margem_pct - b.margem_pct);

    const total_receita = resultado.reduce((s, p) => s + p.receita_total, 0);
    const melhor = resultado.reduce((m, p) => p.margem_pct > (m?.margem_pct||0) ? p : m, null);
    const pior   = resultado.find(p => p.receita_total > 0) || null;

    res.json({ postos: resultado, total_receita, melhor_posto: melhor, pior_posto: pior });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── APURAÇÃO MENSAL ─────────────────────────────────────────────
router.get('/relatorios/apuracao-mensal', (req, res) => {
  const db = req.db;
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS apuracao_mensal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      competencia TEXT UNIQUE,
      receita_bruta REAL DEFAULT 0,
      retencoes REAL DEFAULT 0,
      receita_liquida REAL DEFAULT 0,
      despesas_total REAL DEFAULT 0,
      resultado REAL DEFAULT 0,
      qtd_nfs INTEGER DEFAULT 0,
      gerado_em TEXT DEFAULT (datetime('now','localtime')),
      obs TEXT
    )`).run();
  } catch(e) {}

  const meses = parseInt(req.query.meses) || 12;
  const rows = db.prepare(`SELECT * FROM apuracao_mensal ORDER BY competencia DESC LIMIT ?`).all(meses);

  if (rows.length === 0) {
    const resultado = [];
    for (let i = 1; i <= 3; i++) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      const ano = d.getFullYear();
      const mes = String(d.getMonth() + 1).padStart(2, '0');
      const from = `${ano}-${mes}-01`;
      const to   = `${ano}-${mes}-31`;
      const comp = `${ano}-${mes}`;
      try {
        const receita  = db.prepare(`SELECT COALESCE(SUM(valor_bruto),0) total, COUNT(*) qtd FROM notas_fiscais WHERE data_emissao BETWEEN ? AND ?`).get(from, to);
        const despesas = db.prepare(`SELECT COALESCE(SUM(valor_bruto),0) total FROM despesas WHERE data_iso BETWEEN ? AND ?`).get(from, to);
        const ret      = db.prepare(`SELECT COALESCE(SUM(retencao),0) total FROM notas_fiscais WHERE data_emissao BETWEEN ? AND ?`).get(from, to);
        resultado.push({
          competencia: comp,
          receita_bruta: receita.total || 0,
          retencoes: ret.total || 0,
          receita_liquida: (receita.total||0) - (ret.total||0),
          despesas_total: despesas.total || 0,
          resultado: ((receita.total||0) - (ret.total||0)) - (despesas.total||0),
          qtd_nfs: receita.qtd || 0,
          gerado_em: new Date().toISOString()
        });
      } catch(e) {}
    }
    return res.json({ data: resultado, fonte: 'calculado', total: resultado.length });
  }

  res.json({ data: rows, fonte: 'cron', total: rows.length });
});

// ─── SUBCONTRATADOS / FORNECEDORES ───────────────────────────────
router.get('/relatorios/subcontratados', (req, res) => {
  const db = req.db;
  const { from, to } = req.query;
  const ano = new Date().getFullYear();
  const dateFrom = from || `${ano}-01-01`;
  const dateTo   = to   || `${ano}-12-31`;

  const subcontratados = db.prepare(`
    SELECT
      fornecedor,
      cnpj_fornecedor,
      COUNT(*) qtd_pagamentos,
      COALESCE(SUM(valor_bruto),0) total_pago,
      MIN(data_iso) primeiro_pgto,
      MAX(data_iso) ultimo_pgto,
      COUNT(DISTINCT substr(data_iso,1,7)) meses_ativos
    FROM despesas
    WHERE data_iso BETWEEN ? AND ?
      AND UPPER(TRIM(categoria)) IN ('FORNECEDOR','SERVIÇO','SERVICO','SUBCONTRATADO','TERCEIROS')
      AND fornecedor IS NOT NULL AND fornecedor != ''
    GROUP BY fornecedor, cnpj_fornecedor
    ORDER BY total_pago DESC
    LIMIT 50
  `).all(dateFrom, dateTo);

  const resultado = subcontratados.map(s => {
    let nfs_recebidas = 0;
    let total_nfs = 0;
    try {
      const tbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='nfe_entrada'").get();
      if (tbl) {
        const nfs = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(valor_total),0) t FROM nfe_entrada WHERE cnpj_emitente=? AND data_emissao BETWEEN ? AND ?`).get(s.cnpj_fornecedor||'', dateFrom, dateTo);
        nfs_recebidas = nfs.c || 0;
        total_nfs = nfs.t || 0;
      }
    } catch(e) {}
    return {
      ...s,
      nfs_recebidas,
      total_nfs,
      cobertura_nf: total_nfs > 0 ? Math.min(100, Math.round(total_nfs / s.total_pago * 100)) : 0
    };
  });

  const total_geral = resultado.reduce((s,r) => s + r.total_pago, 0);
  res.json({ data: resultado, total_geral, periodo: { from: dateFrom, to: dateTo } });
});

// ─── CONSOLIDADO MULTI-EMPRESA ────────────────────────────────────
router.get('/consolidado/resumo', (req, res) => {
  const { from, to } = req.query;
  const ano = new Date().getFullYear();
  const dateFrom = from || `${ano}-01-01`;
  const dateTo   = to   || `${ano}-12-31`;

  const resultado = [];

  for (const [key, company] of Object.entries(COMPANIES)) {
    try {
      const db = getDb(key);
      const receita   = db.prepare(`SELECT COALESCE(SUM(valor_bruto),0) t, COUNT(*) q FROM notas_fiscais WHERE data_emissao BETWEEN ? AND ?`).get(dateFrom, dateTo);
      const despesas  = db.prepare(`SELECT COALESCE(SUM(valor_bruto),0) t FROM despesas WHERE data_iso BETWEEN ? AND ?`).get(dateFrom, dateTo);
      const retencoes = db.prepare(`SELECT COALESCE(SUM(retencao),0) t FROM notas_fiscais WHERE data_emissao BETWEEN ? AND ?`).get(dateFrom, dateTo);
      const extratos  = db.prepare(`SELECT COALESCE(SUM(credito),0) entradas, COALESCE(SUM(debito),0) saidas FROM extratos WHERE data_iso BETWEEN ? AND ?`).get(dateFrom, dateTo);
      const contratos = db.prepare(`SELECT COUNT(*) c FROM contratos WHERE status IS NULL OR status != 'encerrado'`).get();
      const nfsPend   = db.prepare(`SELECT COUNT(*) c FROM notas_fiscais WHERE status_conciliacao='PENDENTE'`).get();

      const receita_bruta = receita.t || 0;
      const ret  = retencoes.t || 0;
      const desp = despesas.t || 0;
      const receita_liq = receita_bruta - ret;

      resultado.push({
        empresa: key,
        nome: company.nome || key,
        cnpj: company.cnpj || '',
        receita_bruta,
        retencoes: ret,
        receita_liquida: receita_liq,
        despesas: desp,
        resultado: receita_liq - desp,
        margem_pct: receita_liq > 0 ? Math.round((receita_liq - desp) / receita_liq * 100 * 10) / 10 : 0,
        entradas_banco: extratos.entradas || 0,
        saidas_banco: extratos.saidas || 0,
        qtd_nfs: receita.q || 0,
        contratos_ativos: contratos.c || 0,
        nfs_pendentes: nfsPend.c || 0
      });
    } catch(e) {
      resultado.push({ empresa: key, nome: company.nome || key, erro: e.message });
    }
  }

  const totais = resultado.reduce((acc, r) => ({
    receita_bruta:    (acc.receita_bruta||0)    + (r.receita_bruta||0),
    receita_liquida:  (acc.receita_liquida||0)  + (r.receita_liquida||0),
    despesas:         (acc.despesas||0)         + (r.despesas||0),
    resultado:        (acc.resultado||0)        + (r.resultado||0),
    qtd_nfs:          (acc.qtd_nfs||0)          + (r.qtd_nfs||0),
    contratos_ativos: (acc.contratos_ativos||0) + (r.contratos_ativos||0),
  }), {});

  res.json({ empresas: resultado, totais, periodo: { from: dateFrom, to: dateTo } });
});

// ─── Cobertura de Postos ──────────────────────────────────────────────────────
router.get('/relatorios/cobertura-postos', (req, res) => {
  const db = req.db;
  const { from, to } = req.query;
  const ano = new Date().getFullYear();
  const mes = String(new Date().getMonth() + 1).padStart(2,'0');
  const dateFrom = from || `${ano}-${mes}-01`;
  const dateTo   = to   || `${ano}-${mes}-31`;
  const comp     = dateFrom.substring(0,7);

  // Verificar se tabelas de boletins e ponto existem
  const tblBol = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bol_postos'").get();
  if (!tblBol) return res.json({ postos: [], message: 'Sem dados de postos' });

  try {
    // Postos contratados
    const postos = db.prepare(`
      SELECT p.id, p.descricao, p.tipo_posto, p.qtd_funcionarios,
             bc.contrato_ref, bc.orgao,
             COALESCE(bb.valor_total, 0) valor_boletim,
             bb.status as status_boletim,
             bb.id as boletim_id
      FROM bol_postos p
      JOIN bol_contratos bc ON p.contrato_id = bc.id
      LEFT JOIN bol_boletins bb ON bb.contrato_id = bc.id
        AND substr(bb.competencia,1,7) = ?
      ORDER BY bc.orgao, p.descricao
    `).all(comp);

    // Para cada posto, verificar registros de ponto (se existirem)
    const tblPonto = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ponto_registros'").get();

    const resultado = postos.map(p => {
      let dias_cobertos = 0;
      let funcionarios_escalados = 0;

      if (tblPonto) {
        try {
          // Funcionários com lotação no posto
          const funcs = db.prepare(`
            SELECT COUNT(DISTINCT func_id) c FROM ponto_registros
            WHERE data_iso BETWEEN ? AND ? AND lotacao LIKE ?
          `).get(dateFrom, dateTo, `%${p.descricao?.substring(0,10)||''}%`);
          funcionarios_escalados = funcs?.c || 0;
        } catch(e) {}
      }

      const qtd_esperada = p.qtd_funcionarios || 1;
      const cobertura_pct = qtd_esperada > 0
        ? Math.min(100, Math.round(funcionarios_escalados / qtd_esperada * 100))
        : 0;

      return {
        ...p,
        funcionarios_escalados,
        qtd_esperada,
        cobertura_pct,
        status_cobertura: cobertura_pct >= 90 ? 'OK' : cobertura_pct >= 60 ? 'PARCIAL' : 'CRÍTICO'
      };
    });

    const total_postos = resultado.length;
    const postos_ok = resultado.filter(p => p.status_cobertura === 'OK').length;
    const postos_criticos = resultado.filter(p => p.status_cobertura === 'CRÍTICO').length;

    res.json({
      postos: resultado,
      competencia: comp,
      resumo: { total_postos, postos_ok, postos_criticos, postos_parciais: total_postos - postos_ok - postos_criticos }
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── EPI / Uniformes ─────────────────────────────────────────────────────────

// Middleware: garante que tabelas EPI existem
router.use('/epi', (req, res, next) => {
  try {
    req.db.prepare(`CREATE TABLE IF NOT EXISTS epi_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      funcionario_id INTEGER,
      nome_item TEXT NOT NULL,
      tipo TEXT DEFAULT 'EPI',
      data_entrega TEXT,
      data_devolucao TEXT,
      valor REAL DEFAULT 0,
      tamanho TEXT,
      quantidade INTEGER DEFAULT 1,
      status TEXT DEFAULT 'ATIVO',
      obs TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )`).run();
    req.db.prepare(`CREATE TABLE IF NOT EXISTS epi_estoque (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome_item TEXT NOT NULL,
      tipo TEXT DEFAULT 'EPI',
      quantidade_total INTEGER DEFAULT 0,
      quantidade_disponivel INTEGER DEFAULT 0,
      valor_unitario REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`).run();
  } catch(e) {}
  next();
});

// GET /epi/funcionario/:id — EPIs entregues ao funcionário
router.get('/epi/funcionario/:id', (req, res) => {
  const itens = req.db.prepare(`
    SELECT e.*, f.nome as func_nome FROM epi_itens e
    LEFT JOIN rh_funcionarios f ON e.funcionario_id = f.id
    WHERE e.funcionario_id=? ORDER BY e.data_entrega DESC
  `).all(req.params.id);
  const total_valor = itens.reduce((s,i) => s + (i.valor||0) * (i.quantidade||1), 0);
  res.json({ data: itens, total_valor });
});

// GET /epi/estoque — estoque atual
router.get('/epi/estoque', (req, res) => {
  const itens = req.db.prepare('SELECT * FROM epi_estoque ORDER BY tipo, nome_item').all();
  res.json({ data: itens });
});

// POST /epi/entregar — registrar entrega de EPI
router.post('/epi/entregar', (req, res) => {
  const { funcionario_id, nome_item, tipo, valor, quantidade, tamanho, obs } = req.body;
  if (!funcionario_id || !nome_item) return res.status(400).json({ error: 'funcionario_id e nome_item obrigatórios' });
  const info = req.db.prepare(`INSERT INTO epi_itens
    (funcionario_id, nome_item, tipo, data_entrega, valor, quantidade, tamanho, status, obs)
    VALUES (?, ?, ?, date('now','localtime'), ?, ?, ?, 'ATIVO', ?)`)
    .run(funcionario_id, nome_item, tipo||'EPI', valor||0, quantidade||1, tamanho||'', obs||'');
  res.json({ ok: true, id: info.lastInsertRowid });
});

// PATCH /epi/:id/devolver
router.patch('/epi/:id/devolver', (req, res) => {
  req.db.prepare(`UPDATE epi_itens SET status='DEVOLVIDO', data_devolucao=date('now','localtime'), updated_at=datetime('now') WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// GET /epi/relatorio — relatório geral de EPIs
router.get('/epi/relatorio', (req, res) => {
  const db = req.db;
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS epi_itens (id INTEGER PRIMARY KEY AUTOINCREMENT, funcionario_id INTEGER, nome_item TEXT NOT NULL, tipo TEXT DEFAULT 'EPI', data_entrega TEXT, data_devolucao TEXT, valor REAL DEFAULT 0, tamanho TEXT, quantidade INTEGER DEFAULT 1, status TEXT DEFAULT 'ATIVO', obs TEXT, created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`).run();
  } catch(e) {}

  const por_item = db.prepare(`
    SELECT nome_item, tipo,
           COUNT(*) total_entregas,
           SUM(CASE WHEN status='ATIVO' THEN 1 ELSE 0 END) em_uso,
           SUM(CASE WHEN status='DEVOLVIDO' THEN 1 ELSE 0 END) devolvidos,
           COALESCE(SUM(valor * quantidade),0) custo_total
    FROM epi_itens GROUP BY nome_item, tipo ORDER BY custo_total DESC
  `).all();

  const por_funcionario = db.prepare(`
    SELECT f.nome, f.lotacao, COUNT(e.id) qtd_itens,
           COALESCE(SUM(e.valor * e.quantidade),0) custo_total
    FROM epi_itens e
    JOIN rh_funcionarios f ON e.funcionario_id = f.id
    WHERE e.status='ATIVO'
    GROUP BY e.funcionario_id ORDER BY custo_total DESC LIMIT 20
  `).all();

  const total_custo = por_item.reduce((s,i) => s + i.custo_total, 0);
  res.json({ por_item, por_funcionario, total_custo });
});

module.exports = router;
