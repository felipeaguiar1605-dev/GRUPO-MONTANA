'use strict';
/**
 * Importador Portal Transparência TCE/TO (Sprint 4).
 *
 * Portal: https://transparencia.tceto.tc.br/execucaoOrcamentaria/pagamentosOrdemCronologicaApartirJulho2023
 *
 * Estratégia: POST form à página principal, extrai tabela HTML.
 *
 * ⚠️  LIMITAÇÃO DESCOBERTA: o parâmetro `pagina` é um OFFSET linha dentro de um universo
 *     de 15 registros retornados pelo endpoint HTML — NÃO é um page number tradicional.
 *     O "total de 726" exibido refere-se ao grand total, mas a listagem HTML só mostra
 *     os primeiros 15 em ordem cronológica. Para coletar o conjunto completo:
 *        a) Usar filtros (unidadeGestora, categoriaContrato) para fatiar em subconjuntos ≤15.
 *        b) Endpoint /DownloadCsv — requer `dadosfilter` base64+PHP-serialized
 *           (to-do: capturar via DevTools ao clicar "Baixar CSV" e reverter o formato).
 *
 * Para Montana Assessoria (CNPJ raiz 14092519), os pagamentos do TCE 117/2024 não aparecem
 * no top-15 — será necessário filtrar por unidadeGestora específica (030100 = TCE/TO).
 *
 * Estrutura da tabela (TAB 1, 16 colunas):
 *   0  Nº de Sequencia
 *   1  Unidade Gestora
 *   2  Referência (MM/AAAA)
 *   3  Natureza Despesa / Sub-item
 *   4  Processo
 *   5  Credor  (formato "CNPJ - NOME")
 *   6  Documento Fiscal  (número da NF)
 *   7  Fonte de Recursos
 *   8  Data do Empenho  (DD/MM/AAAA)
 *   9  Data da Liquidação
 *  10  Data do Pagamento
 *  11  Valor Efetivamente Pago  (BRL "580,00")
 *  12  Data de Exigibilidade
 *  13  Justif. (Não houve Pagamento no prazo)
 *  14  Justif. (Pagamento fora da Ordem Cronológica)
 *  15  Justif. (Manifestação do Controle interno)
 *
 * Uso:
 *   node scripts/importar_transparencia_tceto.js --ano=2026              # dry-run, todas as páginas
 *   node scripts/importar_transparencia_tceto.js --ano=2026 --cnpj=14092519 --apply
 *   node scripts/importar_transparencia_tceto.js --ano=2025 --maxpag=5   # limita páginas (debug)
 */
const path = require('path');
const https = require('https');
const querystring = require('querystring');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const ARG = process.argv.slice(2);
const APLICAR = ARG.includes('--apply');
const arg = (k, def = '') => (ARG.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || def;
const empresa = arg('empresa', 'assessoria');
const ano     = arg('ano', String(new Date().getFullYear()));
const cnpjArg = (arg('cnpj') || '').replace(/\D/g, '');
const maxpag  = parseInt(arg('maxpag', '0')) || 0;   // 0 = sem limite

const URL_PATH = '/execucaoOrcamentaria/pagamentosOrdemCronologicaApartirJulho2023';
const HOST = 'transparencia.tceto.tc.br';

function post(fields) {
  return new Promise((resolve, reject) => {
    const body = querystring.stringify(fields);
    const req = https.request({
      hostname: HOST, port: 443, path: URL_PATH, method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 MontanaERP',
        'Accept': 'text/html,*/*',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function stripTags(s) {
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
    .replace(/\s+/g, ' ').trim();
}

function parseTabelaPagamentos(html) {
  // Encontra a tabela com 16 colunas que tem "Credor" e "Valor Efetivamente Pago"
  const tabs = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)];
  let tabela = null;
  for (const t of tabs) {
    const headers = [...t[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map(x => stripTags(x[1]));
    const H = headers.join('|').toUpperCase();
    if (H.includes('CREDOR') && H.includes('VALOR EFETIVAMENTE PAGO')) {
      const rows = [];
      const reRow = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let mr;
      while ((mr = reRow.exec(t[1])) !== null) {
        const cells = [...mr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(x => stripTags(x[1]));
        if (cells.length >= 12) rows.push(cells);   // pula linhas de header
      }
      tabela = { headers, rows };
      break;
    }
  }
  return tabela;
}

function parseTotal(html) {
  const m = html.match(/total\s+de\s+(\d+)/i);
  return m ? parseInt(m[1]) : null;
}

function brDataToIso(s) {
  if (!s) return '';
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}
function brValorToFloat(s) {
  if (!s) return 0;
  const t = String(s).replace(/[R$\s\u00A0]/g, '');
  if (t.includes(',')) {
    const n = parseFloat(t.replace(/\./g, '').replace(',', '.'));
    return isFinite(n) ? n : 0;
  }
  const n = parseFloat(t);
  return isFinite(n) ? n : 0;
}

function parseCredor(s) {
  // "52813850000102 - Noman Centro Automotivo Ltda" ou "05.917.540/0001-58 - ..."
  const t = String(s || '').trim();
  // tenta CNPJ formatado ou puro
  const m = t.match(/^([\d.\/-]{11,20})\s*[-–—]\s*(.+)$/);
  if (m) return { cnpj: m[1].replace(/\D/g, ''), nome: m[2].trim() };
  // tenta só 14 dígitos no começo
  const m2 = t.match(/^(\d{11,14})\s+(.+)$/);
  if (m2) return { cnpj: m2[1], nome: m2[2].trim() };
  return { cnpj: '', nome: t };
}

async function buscarPagina(anoN, pagina) {
  const fields = {
    Ano: anoN, Mes: '',
    anoExigibilidade: '', mesExigibilidade: '',
    anoPagamento: anoN, mesPagamento: '',
    categoriaContrato: '', idrecurso: '', unidadeGestora: '',
    abaAtiva: '0', ordem: '',
    pagina: String(pagina),
    total: '9999',
  };
  const r = await post(fields);
  if (r.status !== 200) return { rows: [], total: null, status: r.status };

  const total = parseTotal(r.body);
  const tab = parseTabelaPagamentos(r.body);
  if (!tab) return { rows: [], total, status: 200 };

  const rows = tab.rows.map(c => {
    const credor = parseCredor(c[5]);
    return {
      seq:       c[0] || '',
      gestao:    c[1] || '',
      referencia:c[2] || '',
      natureza:  c[3] || '',
      processo:  c[4] || '',
      cnpj:      credor.cnpj,
      fornecedor:credor.nome,
      docFiscal: c[6] || '',
      fonte:     c[7] || '',
      dtEmp:     brDataToIso(c[8] || ''),
      dtLiq:     brDataToIso(c[9] || ''),
      dtPg:      brDataToIso(c[10] || ''),
      valor:     brValorToFloat(c[11] || '0'),
      dtExig:    brDataToIso(c[12] || ''),
      raw:       c,
    };
  });
  return { rows, total, status: 200 };
}

async function main() {
  console.log(`\n🏛️  Import TCE/TO — empresa=${empresa} ano=${ano}${cnpjArg?' cnpj='+cnpjArg:''}`);
  console.log(`  Modo: ${APLICAR ? 'APLICAR' : 'DRY-RUN'}\n`);

  const db = getDb(empresa);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO pagamentos_portal
      (portal, gestao, fornecedor, cnpj, cnpj_raiz, empenho,
       data_empenho_iso, data_liquidacao_iso, data_pagamento_iso,
       valor_pago, elemento_desp, fonte, hash_unico, raw_json)
    VALUES ('tceto', @gestao, @fornecedor, @cnpj, @cnpj_raiz, @empenho,
            @dtEmp, @dtLiq, @dtPg, @valor, @elemento, @fonte, @hash, @raw)
  `);

  // 1) Busca primeira página para descobrir total
  const p1 = await buscarPagina(ano, 1);
  if (p1.status !== 200) {
    console.log(`  HTTP ${p1.status} ao buscar página 1`);
    return;
  }
  const total = p1.total;
  const porPag = p1.rows.length || 15;
  const totalPaginas = total ? Math.ceil(total / porPag) : 1;
  const limite = maxpag ? Math.min(maxpag, totalPaginas) : totalPaginas;
  console.log(`  Total ${total} registros em ~${totalPaginas} páginas (${porPag}/pág). Lendo ${limite} páginas.`);

  let todas = [...p1.rows];
  for (let pg = 2; pg <= limite; pg++) {
    process.stdout.write(`\r  Lendo página ${pg}/${limite}...`);
    const { rows, status } = await buscarPagina(ano, pg);
    if (status !== 200) { console.log(`\n  ⚠️ HTTP ${status} na página ${pg}, parando.`); break; }
    if (rows.length === 0) break;
    todas = todas.concat(rows);
    await new Promise(r => setTimeout(r, 250));   // cortesia: não martelar o servidor
  }
  console.log(`\n  Coletados: ${todas.length} registros.`);

  // 2) Filtro local por CNPJ (raiz 8 dígitos)
  const filtrados = cnpjArg
    ? todas.filter(r => (r.cnpj || '').substring(0, cnpjArg.length) === cnpjArg)
    : todas;
  if (cnpjArg) {
    console.log(`  Filtrando CNPJ raiz=${cnpjArg}: ${filtrados.length} registros.`);
  }

  // 3) Sumário por fornecedor
  const porFornecedor = {};
  for (const r of filtrados) {
    const k = r.cnpj || r.fornecedor;
    if (!porFornecedor[k]) porFornecedor[k] = { nome: r.fornecedor, cnpj: r.cnpj, qtd: 0, total: 0 };
    porFornecedor[k].qtd++;
    porFornecedor[k].total += r.valor;
  }
  const top = Object.values(porFornecedor).sort((a, b) => b.total - a.total).slice(0, 10);
  console.log('\n  Top 10 fornecedores:');
  top.forEach(f => {
    console.log(`    ${f.cnpj.padEnd(14)} ${String(f.qtd).padStart(4)}x  R$ ${f.total.toLocaleString('pt-BR',{minimumFractionDigits:2})}  ${f.nome.substring(0,50)}`);
  });

  // 4) Insert em pagamentos_portal
  if (APLICAR && filtrados.length > 0) {
    let inseridos = 0;
    const trx = db.transaction(lista => {
      for (const row of lista) {
        const hash = crypto.createHash('md5')
          .update(`tceto|${row.gestao}|${row.docFiscal}|${row.dtPg}|${row.valor}|${row.cnpj}`).digest('hex');
        const r = stmt.run({
          gestao: row.gestao, fornecedor: row.fornecedor,
          cnpj: row.cnpj, cnpj_raiz: (row.cnpj || '').substring(0, 8),
          empenho: row.docFiscal,
          dtEmp: row.dtEmp, dtLiq: row.dtLiq, dtPg: row.dtPg,
          valor: row.valor,
          elemento: row.natureza, fonte: row.fonte,
          hash, raw: JSON.stringify(row.raw),
        });
        if (r.changes > 0) inseridos++;
      }
    });
    trx(filtrados);
    console.log(`\n  ✅ Inseridos em pagamentos_portal: ${inseridos} (ignorados dup: ${filtrados.length - inseridos})`);
  } else if (!APLICAR) {
    console.log(`\n  (dry-run — use --apply para gravar em pagamentos_portal)`);
  }

  console.log('\n✔️  Concluído.');
}

main().catch(e => { console.error('❌', e); process.exit(1); });
