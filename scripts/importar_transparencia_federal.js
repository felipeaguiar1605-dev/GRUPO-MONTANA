'use strict';
/**
 * Importador Portal Transparência Federal (Sprint 5).
 *
 * API: https://api.portaldatransparencia.gov.br/api-de-dados/
 * Cadastro da chave (grátis): https://portaldatransparencia.gov.br/api-de-dados/cadastrar-email
 * Doc (Swagger): https://api.portaldatransparencia.gov.br/swagger-ui/index.html
 *
 * Autenticação: header `chave-api-dados: <SUA_CHAVE>`
 * Rate limit: ~30 req/min (fora do horário comercial é mais permissivo).
 *
 * Endpoints utilizados para Montana Assessoria (CNPJ 14.092.519/0001-51):
 *   1. /contratos?cpfCnpjContratada={cnpj}&pagina=N        → contratos federais
 *   2. /notas-fiscais?cnpjEmitente={cnpj}&pagina=N          → NFs emitidas para o governo federal
 *   3. /despesas/por-favorecido?cpfCnpj={cnpj}&ano=&pagina= → pagamentos totalizados
 *   4. /despesas/documentos?codigoPessoaJuridica=&ano=&pagina= → empenho/liquidação/pagamento
 *
 * Uso:
 *   node scripts/importar_transparencia_federal.js --setup   # imprime instruções de chave
 *   node scripts/importar_transparencia_federal.js --ano=2025
 *   node scripts/importar_transparencia_federal.js --ano=2025 --apply
 *   node scripts/importar_transparencia_federal.js --ano=2025 --cnpj=14092519000151 --apply
 */
const path = require('path');
const https = require('https');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const ARG = process.argv.slice(2);
const APLICAR = ARG.includes('--apply');
const SETUP   = ARG.includes('--setup');
const arg = (k, def = '') => (ARG.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || def;
const empresa  = arg('empresa', 'assessoria');
const anoArg   = arg('ano', String(new Date().getFullYear()));
const cnpjArg  = (arg('cnpj') || '14092519000151').replace(/\D/g, '');   // default: Montana Assessoria
const only     = arg('only', '');   // contratos|notas|despesas|documentos

const API_KEY = process.env.PORTAL_FEDERAL_API_KEY || '';
const HOST = 'api.portaldatransparencia.gov.br';

// ─── Setup (sem chave) ────────────────────────────────────────────────────────

function imprimirSetup() {
  console.log(`
┌─────────────────────────────────────────────────────────────────┐
│ Setup Portal Transparência Federal                              │
└─────────────────────────────────────────────────────────────────┘

1. Cadastre seu e-mail:
     https://portaldatransparencia.gov.br/api-de-dados/cadastrar-email

2. Receba a chave por e-mail (≈1 min).

3. Adicione ao ${path.join(__dirname, '..', '.env')}:

     PORTAL_FEDERAL_API_KEY=sua_chave_aqui

4. Re-rode:
     node scripts/importar_transparencia_federal.js --ano=2025

Endpoints disponíveis depois:
  --only=contratos   (contratos federais vigentes)
  --only=notas       (NFs emitidas)
  --only=despesas    (pagamentos por favorecido)
  --only=documentos  (empenho/liquidação/pagamento)

Documentação Swagger: https://api.portaldatransparencia.gov.br/swagger-ui/index.html
`);
}

// ─── Cliente HTTP ─────────────────────────────────────────────────────────────

function get(pathUrl) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST, port: 443, path: pathUrl, method: 'GET',
      headers: {
        'Accept': 'application/json',
        'chave-api-dados': API_KEY,
        'User-Agent': 'MontanaERP/1.0',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: txt, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getJson(pathUrl) {
  const r = await get(pathUrl);
  if (r.status === 429) {
    // rate-limit: espera e tenta de novo
    const wait = parseInt(r.headers['retry-after'] || '10') * 1000;
    console.log(`  ⏳ Rate-limit (429). Aguardando ${wait/1000}s...`);
    await new Promise(res => setTimeout(res, wait));
    return getJson(pathUrl);
  }
  if (r.status !== 200) {
    return { err: `HTTP ${r.status}: ${r.body.substring(0, 200)}`, data: null };
  }
  try {
    return { err: null, data: JSON.parse(r.body) };
  } catch (e) {
    return { err: `JSON inválido: ${e.message}`, data: null };
  }
}

async function paginar(buildPath, maxPaginas = 50) {
  const todos = [];
  for (let pg = 1; pg <= maxPaginas; pg++) {
    process.stdout.write(`\r    Página ${pg}...`);
    const { err, data } = await getJson(buildPath(pg));
    if (err) { console.log(`\n    ⚠️ ${err}`); break; }
    if (!Array.isArray(data) || data.length === 0) break;
    todos.push(...data);
    if (data.length < 15) break;   // página incompleta = última
    await new Promise(r => setTimeout(r, 2100));   // respeita rate-limit (~28 req/min)
  }
  process.stdout.write(`\r                          \r`);
  return todos;
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

async function buscarContratos(cnpj) {
  console.log('  📑 Contratos federais:');
  // endpoint correto: /contratos/cpf-cnpj?cpfCnpj=...&pagina=N
  const regs = await paginar(pg => `/api-de-dados/contratos/cpf-cnpj?cpfCnpj=${cnpj}&pagina=${pg}`);
  console.log(`    ${regs.length} contratos encontrados.`);
  return regs;
}

async function buscarNotas(cnpj, ano) {
  console.log(`  🧾 Notas Fiscais ${ano}:`);
  const regs = await paginar(pg => `/api-de-dados/notas-fiscais?cnpjEmitente=${cnpj}&ano=${ano}&pagina=${pg}`);
  console.log(`    ${regs.length} NFs encontradas.`);
  return regs;
}

async function buscarDespesas(cnpj, ano) {
  console.log(`  💰 Despesas por favorecido ${ano}:`);
  // 403 em alguns endpoints — tenta alternativas
  const regs = await paginar(pg => `/api-de-dados/despesas/por-favorecido?cpfCnpj=${cnpj}&ano=${ano}&pagina=${pg}`);
  console.log(`    ${regs.length} despesas totalizadas.`);
  return regs;
}

async function buscarDocumentos(cnpj, ano) {
  console.log(`  📄 Documentos de despesa ${ano} (empenho/liq/pgto):`);
  // /despesas/documentos exige `dataEmissao` — itera mês a mês
  const todos = [];
  for (let m = 1; m <= 12; m++) {
    const dtIni = `01/${String(m).padStart(2,'0')}/${ano}`;
    const lastDay = new Date(parseInt(ano), m, 0).getDate();
    const dtFim = `${lastDay}/${String(m).padStart(2,'0')}/${ano}`;
    const path = `/api-de-dados/despesas/documentos?codigoPessoaJuridica=${cnpj}&dataEmissaoInicio=${dtIni}&dataEmissaoFim=${dtFim}&pagina=1`;
    const { err, data } = await getJson(path);
    if (err) { console.log(`    ⚠️ ${m}/${ano}: ${err}`); continue; }
    if (Array.isArray(data) && data.length) {
      todos.push(...data);
      console.log(`    ${String(m).padStart(2,'0')}/${ano}: ${data.length} docs`);
    }
    await new Promise(r => setTimeout(r, 2100));
  }
  console.log(`    Total: ${todos.length} documentos.`);
  return todos;
}

// ─── Persistência ─────────────────────────────────────────────────────────────

function persistirContratos(db, contratos) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contratos_federais (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero_contrato TEXT,
      cnpj_contratada TEXT,
      nome_contratada TEXT,
      orgao_codigo TEXT,
      orgao_nome TEXT,
      unidade_gestora TEXT,
      objeto TEXT,
      valor_inicial REAL DEFAULT 0,
      valor_atualizado REAL DEFAULT 0,
      data_inicio TEXT,
      data_fim TEXT,
      modalidade TEXT,
      situacao TEXT,
      raw_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(numero_contrato, orgao_codigo)
    );
    CREATE INDEX IF NOT EXISTS idx_ctr_fed_cnpj ON contratos_federais(cnpj_contratada);
  `);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO contratos_federais
      (numero_contrato, cnpj_contratada, nome_contratada, orgao_codigo, orgao_nome,
       unidade_gestora, objeto, valor_inicial, valor_atualizado,
       data_inicio, data_fim, modalidade, situacao, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inseridos = 0;
  db.transaction(() => {
    for (const c of contratos) {
      const numero = c.numero || c.numeroContrato || c.idContrato || '';
      const cnpj = (c.fornecedor?.cnpjFormatado || c.cpfFormatado || '').replace(/\D/g, '');
      const nomeContratada = c.fornecedor?.nome || c.nomeRazaoSocial || '';
      const orgao = c.unidadeGestora?.orgaoVinculado || c.orgao || {};
      stmt.run(
        numero, cnpj, nomeContratada,
        String(orgao.codigoSIAFI || orgao.codigo || ''),
        orgao.nome || '',
        c.unidadeGestora?.nome || '',
        c.objeto || '',
        Number(c.valorInicialCompra || c.valorInicial || 0),
        Number(c.valorFinalCompra || c.valorAtualizado || 0),
        c.dataInicioVigencia || c.dataAssinatura || '',
        c.dataFimVigencia || c.dataFim || '',
        c.modalidadeCompra || c.modalidade || '',
        c.situacao || 'ATIVO',
        JSON.stringify(c)
      );
      inseridos++;
    }
  })();
  return inseridos;
}

function persistirDocumentos(db, documentos) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO pagamentos_portal
      (portal, gestao, fornecedor, cnpj, cnpj_raiz, empenho,
       data_empenho_iso, data_liquidacao_iso, data_pagamento_iso,
       valor_pago, elemento_desp, fonte, hash_unico, raw_json)
    VALUES ('federal', @gestao, @fornecedor, @cnpj, @cnpj_raiz, @empenho,
            @dtEmp, @dtLiq, @dtPg, @valor, @elemento, @fonte, @hash, @raw)
  `);
  let inseridos = 0;
  db.transaction(() => {
    for (const d of documentos) {
      const cnpj = (d.favorecido?.cnpjFormatado || d.favorecido?.codigo || '').replace(/\D/g, '');
      const valorPago = Number(d.valor || d.valorPago || 0);
      const hash = crypto.createHash('md5')
        .update(`federal|${d.documentoResumido || d.numero || ''}|${d.data || ''}|${valorPago}|${cnpj}`)
        .digest('hex');
      const r = stmt.run({
        gestao: d.unidadeGestora?.nome || d.orgao?.nome || '',
        fornecedor: d.favorecido?.nome || '',
        cnpj, cnpj_raiz: cnpj.substring(0, 8),
        empenho: d.documentoResumido || d.numero || '',
        dtEmp: d.dataEmissao || '',
        dtLiq: d.dataLiquidacao || '',
        dtPg:  d.data || d.dataPagamento || '',
        valor: valorPago,
        elemento: d.elementoDespesa?.descricao || d.elementoDespesa?.codigo || '',
        fonte:    d.fonteDeRecursos?.descricao || d.fonteDeRecursos?.codigo || '',
        hash, raw: JSON.stringify(d),
      });
      if (r.changes > 0) inseridos++;
    }
  })();
  return inseridos;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (SETUP) return imprimirSetup();
  if (!API_KEY) {
    console.log('❌ PORTAL_FEDERAL_API_KEY não configurada.');
    imprimirSetup();
    return;
  }

  console.log(`\n🇧🇷 Portal Transparência Federal — empresa=${empresa} ano=${anoArg} cnpj=${cnpjArg}`);
  console.log(`   Modo: ${APLICAR ? 'APLICAR' : 'DRY-RUN'}\n`);

  const db = getDb(empresa);

  const coletar = only ? [only] : ['contratos', 'documentos', 'despesas', 'notas'];

  const resultados = {};
  for (const secao of coletar) {
    try {
      if (secao === 'contratos')  resultados.contratos  = await buscarContratos(cnpjArg);
      if (secao === 'notas')      resultados.notas      = await buscarNotas(cnpjArg, anoArg);
      if (secao === 'despesas')   resultados.despesas   = await buscarDespesas(cnpjArg, anoArg);
      if (secao === 'documentos') resultados.documentos = await buscarDocumentos(cnpjArg, anoArg);
    } catch (e) {
      console.log(`  ❌ Erro em ${secao}: ${e.message}`);
    }
  }

  // Resumo
  console.log('\n  ═══ Resumo ═══');
  for (const [k, arr] of Object.entries(resultados)) {
    if (Array.isArray(arr)) console.log(`    ${k.padEnd(12)} ${arr.length} registros`);
  }

  // Amostra do primeiro registro de cada seção (para debug de shape)
  for (const [k, arr] of Object.entries(resultados)) {
    if (Array.isArray(arr) && arr.length > 0) {
      console.log(`\n  📌 Amostra ${k}[0]:`);
      const sample = arr[0];
      const keys = Object.keys(sample).slice(0, 12);
      keys.forEach(ky => {
        const v = sample[ky];
        const vs = typeof v === 'object' ? JSON.stringify(v).substring(0, 80) : String(v).substring(0, 80);
        console.log(`    ${ky.padEnd(28)} = ${vs}`);
      });
    }
  }

  // Apply
  if (APLICAR) {
    let totInseridos = 0;
    if (resultados.contratos?.length) {
      const n = persistirContratos(db, resultados.contratos);
      console.log(`\n  ✅ Contratos upserted: ${n}`);
    }
    if (resultados.documentos?.length) {
      const n = persistirDocumentos(db, resultados.documentos);
      console.log(`  ✅ Documentos → pagamentos_portal: ${n} novos (ignorados dup: ${resultados.documentos.length - n})`);
      totInseridos += n;
    }
    console.log(`\n  Total novos em pagamentos_portal: ${totInseridos}`);
  } else {
    console.log('\n  (dry-run — use --apply para gravar no banco)');
  }

  console.log('\n✔️  Concluído.');
}

main().catch(e => { console.error('❌', e); process.exit(1); });
