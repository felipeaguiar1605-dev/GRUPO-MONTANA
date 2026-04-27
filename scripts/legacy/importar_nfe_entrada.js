/**
 * Importação de NF-e / NFC-e de entrada — fornecedores NEVADA e MONTREAL
 *
 * Fonte: ZIPs na pasta Downloads
 * Destino: tabela despesas (DB assessoria)
 * Também cria tabela despesas_itens para os produtos de cada NF
 *
 * Uso: node scripts/importar_nfe_entrada.js
 */

const path = require('path');
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');
const { DOMParser } = require('@xmldom/xmldom');

// ─── Configuração ──────────────────────────────────────────────
const DB_PATH = path.join(__dirname, '../data/assessoria/montana.db');

const ZIPS = [
  // NEVADA
  {
    file: 'C:\\Users\\Avell\\Downloads\\NEVADA PARA MONTANA ASSESSORIA\\XML_NF_01012023_A_08042026.ZIP',
    tipo: 'NFe', fornecedor: 'NEVADA EMBALAGENS E PRODUTOS DE LIMPEZA EIRELI -ME',
    cnpj: '32062391000165', categoria: 'Material Limpeza',
  },
  {
    file: 'C:\\Users\\Avell\\Downloads\\NEVADA PARA MONTANA ASSESSORIA\\XML_NFC_08012023_A_08042026.ZIP',
    tipo: 'NFCe', fornecedor: 'NEVADA EMBALAGENS E PRODUTOS DE LIMPEZA EIRELI -ME',
    cnpj: '32062391000165', categoria: 'Material Limpeza',
  },
  // MONTREAL
  {
    file: 'C:\\Users\\Avell\\Downloads\\MONTREAL PARA MONTANA ASSESSORIA\\XML_NF_01012023_A_08042026.ZIP',
    tipo: 'NFe', fornecedor: 'MONTREAL MAQUINAS E FERRAMENTAS LTDA',
    cnpj: '39775237000180', categoria: 'EPI/Ferramentas',
  },
  {
    file: 'C:\\Users\\Avell\\Downloads\\MONTREAL PARA MONTANA ASSESSORIA\\XML_NFC_01012023_A_08042026.ZIP',
    tipo: 'NFCe', fornecedor: 'MONTREAL MAQUINAS E FERRAMENTAS LTDA',
    cnpj: '39775237000180', categoria: 'EPI/Ferramentas',
  },
];

// ─── Helpers XML ───────────────────────────────────────────────
const NS = 'http://www.portalfiscal.inf.br/nfe';

function tv(node, tag) {
  if (!node) return null;
  const els = node.getElementsByTagNameNS(NS, tag);
  if (!els || els.length === 0) {
    // fallback sem namespace
    const els2 = node.getElementsByTagName(tag);
    if (!els2 || els2.length === 0) return null;
    const c = els2[0].childNodes;
    return c && c.length ? c[0].nodeValue : null;
  }
  const c = els[0].childNodes;
  return c && c.length ? c[0].nodeValue : null;
}

function tvFirst(node, ...tags) {
  for (const tag of tags) {
    const v = tv(node, tag);
    if (v) return v;
  }
  return null;
}

function parseXml(xmlStr) {
  const parser = new DOMParser();
  return parser.parseFromString(xmlStr, 'application/xml');
}

// ─── Parsear uma NF ────────────────────────────────────────────
function parseNF(xmlStr, zipInfo) {
  const doc = parseXml(xmlStr);
  const root = doc.documentElement;

  // Data de emissão
  const dhEmi = tvFirst(root, 'dhEmi', 'dEmi') || '';
  const dataIso = dhEmi.slice(0, 10); // YYYY-MM-DD
  const competencia = dataIso.slice(0, 7); // YYYY-MM

  // Formatar para DD/MM/YYYY
  const [y, m, d] = dataIso.split('-');
  const dataDespesa = `${d}/${m}/${y}`;

  // Número da NF
  const nNF = tv(root, 'nNF') || '';
  const serie = tv(root, 'serie') || '';
  const nfNumero = serie ? `${serie}/${nNF}` : nNF;

  // Valores
  const vNF = parseFloat(tv(root, 'vNF') || '0');
  const vProd = parseFloat(tv(root, 'vProd') || '0');

  // Natureza da operação
  const natOp = tv(root, 'natOp') || '';

  // Nome real do emitente (confere com o ZIP mas usa o XML como fonte verdadeira)
  const xNomeEmit = tv(root, 'xNome') || zipInfo.fornecedor;

  // Itens
  const itens = [];
  const dets = root.getElementsByTagNameNS(NS, 'det');
  const dets2 = dets.length ? dets : root.getElementsByTagName('det');
  for (let i = 0; i < dets2.length; i++) {
    const det = dets2[i];
    const xProd = tv(det, 'xProd') || '';
    const cProd = tv(det, 'cProd') || '';
    const uCom = tv(det, 'uCom') || 'UN';
    const qCom = parseFloat(tv(det, 'qCom') || '0');
    const vUnCom = parseFloat(tv(det, 'vUnCom') || '0');
    const vProdItem = parseFloat(tv(det, 'vProd') || '0');
    const ncm = tv(det, 'NCM') || '';
    itens.push({ cProd, xProd, uCom, qCom, vUnCom, vProdItem, ncm });
  }

  return {
    dataIso,
    dataDespesa,
    competencia,
    nfNumero,
    nNF,
    serie,
    vNF,
    vProd,
    natOp,
    xNomeEmit,
    tipoDoc: zipInfo.tipo,
    itens,
  };
}

// ─── Main ──────────────────────────────────────────────────────
function main() {
  // Verificar se adm-zip e xmldom estão disponíveis
  const db = new Database(DB_PATH);

  // ── Criar tabela despesas_itens se não existir ────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS despesas_itens (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      despesa_id  INTEGER NOT NULL REFERENCES despesas(id),
      cod_produto TEXT DEFAULT '',
      descricao   TEXT NOT NULL,
      unidade     TEXT DEFAULT 'UN',
      quantidade  REAL DEFAULT 0,
      valor_unit  REAL DEFAULT 0,
      valor_total REAL DEFAULT 0,
      ncm         TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_desp_itens_despesa ON despesas_itens(despesa_id);
  `);

  // ── Preparar statements ───────────────────────────────────────
  const insertDesp = db.prepare(`
    INSERT INTO despesas (
      categoria, descricao, fornecedor, cnpj_fornecedor,
      nf_numero, data_despesa, data_iso, competencia,
      valor_bruto, valor_liquido, status, obs, created_at, updated_at
    ) VALUES (
      @categoria, @descricao, @fornecedor, @cnpj_fornecedor,
      @nf_numero, @data_despesa, @data_iso, @competencia,
      @valor_bruto, @valor_liquido, 'PENDENTE', @obs, datetime('now'), datetime('now')
    )
  `);

  const insertItem = db.prepare(`
    INSERT INTO despesas_itens (despesa_id, cod_produto, descricao, unidade, quantidade, valor_unit, valor_total, ncm)
    VALUES (@despesa_id, @cod_produto, @descricao, @unidade, @quantidade, @valor_unit, @valor_total, @ncm)
  `);

  // ── Checar duplicatas (nf_numero + cnpj_fornecedor) ───────────
  const checkDup = db.prepare(`
    SELECT id FROM despesas WHERE nf_numero = ? AND cnpj_fornecedor = ? LIMIT 1
  `);

  // ── Processar cada ZIP ────────────────────────────────────────
  let totalImported = 0;
  let totalSkipped = 0;
  let totalErros = 0;

  const importZip = db.transaction((zipInfo) => {
    let zipImported = 0, zipSkipped = 0, zipErros = 0;
    console.log(`\n📦 Abrindo: ${path.basename(zipInfo.file)}`);

    let zip;
    try {
      zip = new AdmZip(zipInfo.file);
    } catch(e) {
      console.error(`  ❌ Erro ao abrir ZIP: ${e.message}`);
      return { imported: 0, skipped: 0, erros: 1 };
    }

    const entries = zip.getEntries();
    console.log(`  📄 ${entries.length} arquivos XML`);

    for (const entry of entries) {
      if (!entry.entryName.endsWith('.xml')) continue;

      try {
        const xmlStr = entry.getData().toString('utf8');
        const nf = parseNF(xmlStr, zipInfo);

        // Verificar número válido
        if (!nf.nNF) { zipErros++; continue; }

        // Checar duplicata — usa nNF+serie como chave (sem prefixo "serie/")
        const chaveNf = nf.nfNumero;
        const dup = checkDup.get(chaveNf, zipInfo.cnpj);
        if (dup) { zipSkipped++; continue; }

        // Inserir despesa
        const result = insertDesp.run({
          categoria: zipInfo.categoria,
          descricao: nf.natOp || `${zipInfo.tipo} Nº ${nf.nNF}`,
          fornecedor: nf.xNomeEmit || zipInfo.fornecedor,
          cnpj_fornecedor: zipInfo.cnpj,
          nf_numero: chaveNf,
          data_despesa: nf.dataDespesa,
          data_iso: nf.dataIso,
          competencia: nf.competencia,
          valor_bruto: nf.vNF,
          valor_liquido: nf.vNF,
          obs: `${zipInfo.tipo} importada automaticamente`,
        });

        const despesaId = result.lastInsertRowid;

        // Inserir itens
        for (const it of nf.itens) {
          insertItem.run({
            despesa_id: despesaId,
            cod_produto: it.cProd || '',
            descricao: it.xProd || '',
            unidade: it.uCom || 'UN',
            quantidade: it.qCom || 0,
            valor_unit: it.vUnCom || 0,
            valor_total: it.vProdItem || 0,
            ncm: it.ncm || '',
          });
        }

        zipImported++;
      } catch (e) {
        zipErros++;
        if (zipErros <= 3) console.error(`  ⚠️  Erro em ${entry.entryName}: ${e.message}`);
      }
    }

    console.log(`  ✅ Importadas: ${zipImported} | Duplicatas: ${zipSkipped} | Erros: ${zipErros}`);
    return { imported: zipImported, skipped: zipSkipped, erros: zipErros };
  });

  // Executar
  for (const zipInfo of ZIPS) {
    const r = importZip(zipInfo);
    totalImported += r.imported;
    totalSkipped += r.skipped;
    totalErros += r.erros;
  }

  // ── Resumo final ──────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════');
  console.log(`✅ TOTAL IMPORTADO  : ${totalImported} NFs`);
  console.log(`⏭️  Duplicatas       : ${totalSkipped} (ignoradas)`);
  console.log(`❌ Erros            : ${totalErros}`);

  // Totais por fornecedor
  const totais = db.prepare(`
    SELECT fornecedor, COUNT(*) as qtd, SUM(valor_bruto) as total,
           MIN(data_iso) as data_ini, MAX(data_iso) as data_fim
    FROM despesas
    WHERE cnpj_fornecedor IN ('32062391000165','39775237000180')
    GROUP BY fornecedor
  `).all();

  console.log('\n── Por Fornecedor ──────────────────────────');
  totais.forEach(t => {
    console.log(`${t.fornecedor}`);
    console.log(`  ${t.qtd} NFs | R$ ${t.total.toLocaleString('pt-BR',{minimumFractionDigits:2})} | ${t.data_ini} → ${t.data_fim}`);
  });

  // Totais por ano
  const porAno = db.prepare(`
    SELECT substr(data_iso,1,4) as ano, COUNT(*) as qtd, SUM(valor_bruto) as total
    FROM despesas
    WHERE cnpj_fornecedor IN ('32062391000165','39775237000180')
    GROUP BY ano ORDER BY ano
  `).all();

  console.log('\n── Por Ano ─────────────────────────────────');
  porAno.forEach(r => {
    console.log(`  ${r.ano}: ${r.qtd} NFs | R$ ${r.total.toLocaleString('pt-BR',{minimumFractionDigits:2})}`);
  });

  // Total de itens importados
  const itensCount = db.prepare('SELECT COUNT(*) as n FROM despesas_itens').get();
  console.log(`\n── Itens de produto armazenados: ${itensCount.n}`);
  console.log('═══════════════════════════════════════════\n');

  db.close();
}

main();
