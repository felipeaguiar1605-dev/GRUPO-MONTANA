'use strict';
/**
 * Importa NFS-e de abril/2026 via WebISS (ConsultarNfseServicoPrestado).
 * Uso: node scripts/importar_nfs_abril.js [--empresa=assessoria|seguranca|todas]
 *      node scripts/importar_nfs_abril.js --empresa=assessoria --dataInicial=2026-04-01 --dataFinal=2026-04-30
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path  = require('path');
const fs    = require('fs');
const https = require('https');
const forge = require('node-forge');
const { getDb } = require('../src/db');

// ── Parâmetros ────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--'))
    .map(a => { const [k,v] = a.slice(2).split('='); return [k, v||true]; })
);
const EMPRESA_ARG = args.empresa || 'todas';
const DATA_INI    = args.dataInicial || '2026-04-01';
const DATA_FIM    = args.dataFinal   || '2026-04-30';

const EMPRESAS_CONFIG = {
  assessoria: {
    cnpj:  process.env.WEBISS_CNPJ_ASSESSORIA  || '14092519000151',
    insc:  process.env.WEBISS_INSC_ASSESSORIA  || '237319',
    senha: process.env.WEBISS_CERT_SENHA_ASSESSORIA || '14092519',
    pfx:   path.join(__dirname, '..', 'certificados', 'assessoria.pfx'),
  },
  seguranca: {
    cnpj:  process.env.WEBISS_CNPJ_SEGURANCA  || '19200109000109',
    insc:  process.env.WEBISS_INSC_SEGURANCA  || '515161',
    senha: process.env.WEBISS_CERT_SENHA_SEGURANCA || '19200109',
    pfx:   path.join(__dirname, '..', 'certificados', 'seguranca.pfx'),
  },
};

const WEBISS_URL  = process.env.WEBISS_URL || 'https://palmasto.webiss.com.br/ws/nfse.asmx';
const ABRASF_NS   = 'http://www.abrasf.org.br/nfse.xsd';
const CABEC_XML   = `<cabecalho versao="2.02" xmlns="${ABRASF_NS}"><versaoDados>2.02</versaoDados></cabecalho>`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Helpers SOAP ──────────────────────────────────────────────────────────────
function buildEnvelope(op, dados) {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${op}Request xmlns="http://nfse.abrasf.org.br"><nfseCabecMsg xmlns=""><![CDATA[${CABEC_XML}]]></nfseCabecMsg><nfseDadosMsg xmlns=""><![CDATA[${dados}]]></nfseDadosMsg></${op}Request></soap:Body></soap:Envelope>`;
}

function buildConsultaXml(cnpj, insc, dataIni, dataFim, pagina) {
  return `<ConsultarNfseServicoPrestadoEnvio xmlns="${ABRASF_NS}">
  <Prestador>
    <CpfCnpj><Cnpj>${cnpj}</Cnpj></CpfCnpj>
    ${insc ? `<InscricaoMunicipal>${insc}</InscricaoMunicipal>` : ''}
  </Prestador>
  <PeriodoEmissao>
    <DataInicial>${dataIni}</DataInicial>
    <DataFinal>${dataFim}</DataFinal>
  </PeriodoEmissao>
  <Pagina>${pagina}</Pagina>
</ConsultarNfseServicoPrestadoEnvio>`;
}

function loadCert(cfgEmpresa) {
  if (!fs.existsSync(cfgEmpresa.pfx)) return null;
  try {
    const pfxDer = fs.readFileSync(cfgEmpresa.pfx).toString('binary');
    const asn1   = forge.asn1.fromDer(pfxDer);
    const pfx    = forge.pkcs12.pkcs12FromAsn1(asn1, false, cfgEmpresa.senha);
    const certBags = pfx.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
    const keyBags  = pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag];
    return {
      cert: forge.pki.certificateToPem(certBags[0].cert),
      key:  forge.pki.privateKeyToPem(keyBags[0].key),
    };
  } catch (e) { console.warn('  ⚠️  Cert erro:', e.message); return null; }
}

async function soapCall(op, dados, tls) {
  const body = buildEnvelope(op, dados);
  const url  = new URL(WEBISS_URL);
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type':   'text/xml; charset=utf-8',
        'SOAPAction':     `"http://nfse.abrasf.org.br/${op}"`,
        'Content-Length': Buffer.byteLength(body),
      },
      ...(tls ? { cert: tls.cert, key: tls.key } : {}),
      timeout: 30000,
    };
    const req = https.request(opts, res => {
      let txt = '';
      res.on('data', d => { txt += d; });
      res.on('end', () => resolve(txt));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function getTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : '';
}

function parseNfses(xml) {
  const list = [];
  const re = /<CompNfse>([\s\S]*?)<\/CompNfse>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const g  = t => getTag(b, t);
    const tomBlock = b.match(/<Tomador>([\s\S]*?)<\/Tomador>/)?.[1] || '';
    const gt = t => getTag(tomBlock, t);
    const cancelBlock = b.match(/<NfseCancelamento>([\s\S]*?)<\/NfseCancelamento>/)?.[1] || '';
    list.push({
      numero:    g('Numero'),
      competencia: g('Competencia')?.substring(0, 7) || '',
      dataEmissao: g('DataEmissao')?.substring(0, 10) || '',
      valorBruto:  parseFloat(g('ValorServicos')) || 0,
      valorLiq:    parseFloat(g('ValorLiquidoNfse')) || 0,
      valorIss:    parseFloat(g('ValorIss'))     || 0,
      valorIr:     parseFloat(g('ValorIr'))      || 0,
      valorCsll:   parseFloat(g('ValorCsll'))    || 0,
      valorPis:    parseFloat(g('ValorPis'))      || 0,
      valorCofins: parseFloat(g('ValorCofins'))   || 0,
      valorInss:   parseFloat(g('ValorInss'))     || 0,
      tomador:     gt('RazaoSocial') || gt('NomeFantasia') || '',
      cnpjTomador: gt('Cnpj') || gt('Cpf') || '',
      discriminacao: g('Discriminacao'),
      status: cancelBlock ? 'CANCELADA' : 'ATIVA',
    });
  }
  return list;
}

function extractErrors(xml) {
  const re = /<MensagemRetorno>([\s\S]*?)<\/MensagemRetorno>/g;
  const errs = []; let m;
  while ((m = re.exec(xml)) !== null) {
    errs.push({ codigo: getTag(m[1], 'Codigo'), mensagem: getTag(m[1], 'Mensagem') });
  }
  return errs;
}

function extractOutput(soap) {
  const m = soap.match(/<outputXML[^>]*>([\s\S]*?)<\/outputXML>/);
  if (!m) return soap;
  return m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"');
}

// ── Importação ────────────────────────────────────────────────────────────────
async function importarEmpresa(nomeEmpresa) {
  const cfg = EMPRESAS_CONFIG[nomeEmpresa];
  if (!cfg) { console.log(`  ⚠️  Empresa desconhecida: ${nomeEmpresa}`); return; }

  const db  = getDb(nomeEmpresa);
  const tls = loadCert(cfg);
  console.log(`\n  🏢 ${nomeEmpresa.toUpperCase()} — cert: ${tls ? '✅' : '❌ sem cert (tentando sem mTLS)'}`);
  console.log(`     Período: ${DATA_INI} → ${DATA_FIM}`);

  const INSERT = db.prepare(`
    INSERT OR IGNORE INTO notas_fiscais
      (numero, competencia, cidade, tomador, cnpj_tomador,
       valor_bruto, valor_liquido, inss, ir, iss, csll, pis, cofins,
       retencao, data_emissao, status_conciliacao, discriminacao)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  let totalConsultadas = 0, totalInseridas = 0, totalCanceladas = 0;

  for (let pagina = 1; pagina <= 50; pagina++) {
    if (pagina > 1) await sleep(2500);

    const dados = buildConsultaXml(cfg.cnpj, cfg.insc, DATA_INI, DATA_FIM, pagina);
    let soap;
    try {
      soap = await soapCall('ConsultarNfseServicoPrestado', dados, tls);
    } catch (e) {
      console.log(`  ❌ Erro SOAP pág.${pagina}: ${e.message}`);
      break;
    }

    const xml  = extractOutput(soap);
    const errs = extractErrors(xml);

    if (errs.length) {
      // E006 = sem resultado = fim da paginação
      if (errs.some(e => e.codigo === 'E006')) {
        console.log(`  ℹ️  Pág.${pagina}: sem mais NFs (E006 — fim)`);
        break;
      }
      console.log(`  ⚠️  Erros pág.${pagina}:`, errs.map(e => `${e.codigo}: ${e.mensagem}`).join(' | '));
      break;
    }

    const nfses = parseNfses(xml);
    if (nfses.length === 0) { console.log(`  ℹ️  Pág.${pagina}: 0 NFs — fim`); break; }

    totalConsultadas += nfses.length;

    const inserirLote = db.transaction((lista) => {
      for (const nf of lista) {
        if (nf.status === 'CANCELADA') { totalCanceladas++; continue; }
        const retencao = nf.valorIr + nf.valorCsll + nf.valorPis + nf.valorCofins;
        const res = INSERT.run(
          nf.numero, nf.competencia, 'Palmas/TO',
          nf.tomador, nf.cnpjTomador,
          nf.valorBruto, nf.valorLiq,
          nf.valorInss, nf.valorIr, nf.valorIss, nf.valorCsll, nf.valorPis, nf.valorCofins,
          retencao, nf.dataEmissao, 'PENDENTE', nf.discriminacao
        );
        if (res.changes > 0) totalInseridas++;
      }
    });
    inserirLote(nfses);

    console.log(`  📄 Pág.${pagina}: ${nfses.length} NFs consultadas, ${nfses.filter(n=>n.status!=='CANCELADA').length} ativas`);
    if (nfses.length < 50) { break; } // última página
  }

  console.log(`\n  ✅ ${nomeEmpresa.toUpperCase()} — Total consultadas: ${totalConsultadas} | Canceladas: ${totalCanceladas} | Novas inseridas: ${totalInseridas}`);
  return { totalConsultadas, totalInseridas };
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n  📥 Importação WebISS — Abril/2026`);
  console.log(`  Período: ${DATA_INI} → ${DATA_FIM}`);

  const empresas = EMPRESA_ARG === 'todas'
    ? ['assessoria', 'seguranca']
    : [EMPRESA_ARG];

  for (const emp of empresas) {
    await importarEmpresa(emp);
  }

  console.log('\n  ✔️  Importação concluída.\n');
})();
