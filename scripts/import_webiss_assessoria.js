/**
 * Importação NFS-e Montana Assessoria via WebISS (SOAP direto)
 * Consulta de 2023-01-01 até hoje, em janelas trimestrais.
 * Uso: node scripts/import_webiss_assessoria.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const forge  = require('node-forge');
const { getDb } = require('../src/db');

// ── Config ────────────────────────────────────────────────────────────────────

const WEBISS_URL  = process.env.WEBISS_URL || 'https://palmasto.webiss.com.br/ws/nfse.asmx';
const CNPJ        = '14092519000151'; // Assessoria — CNPJ da empresa
const INSC        = process.env.WEBISS_INSC_ASSESSORIA || '237319';
const CERT_PATH   = path.join(__dirname, '..', 'certificados', 'assessoria.pfx');
const CERT_SENHA  = process.env.WEBISS_CERT_SENHA_ASSESSORIA || '14092519';
const ABRASF_NS   = 'http://www.abrasf.org.br/nfse.xsd';
const DELAY_MS      = 5000;  // entre páginas
const DELAY_WINDOW  = 8000;  // entre trimestres
const DELAY_RETRY   = 90000; // espera após L999

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadClientCert() {
  const pfxDer = fs.readFileSync(CERT_PATH).toString('binary');
  const asn1   = forge.asn1.fromDer(pfxDer);
  const pfx    = forge.pkcs12.pkcs12FromAsn1(asn1, false, CERT_SENHA);
  const certBags = pfx.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
  const keyBags  = pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag];
  return {
    cert: forge.pki.certificateToPem(certBags[0].cert),
    key:  forge.pki.privateKeyToPem(keyBags[0].key),
  };
}

const CABEC = `<cabecalho versao="2.02" xmlns="${ABRASF_NS}"><versaoDados>2.02</versaoDados></cabecalho>`;

function buildEnvelope(dadosXml) {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ConsultarNfseServicoPrestadoRequest xmlns="http://nfse.abrasf.org.br"><nfseCabecMsg xmlns=""><![CDATA[${CABEC}]]></nfseCabecMsg><nfseDadosMsg xmlns=""><![CDATA[${dadosXml}]]></nfseDadosMsg></ConsultarNfseServicoPrestadoRequest></soap:Body></soap:Envelope>`;
}

function buildConsultaXml(dataInicial, dataFinal, pagina) {
  return `<ConsultarNfseServicoPrestadoEnvio xmlns="${ABRASF_NS}">
  <Prestador>
    <CpfCnpj><Cnpj>${CNPJ}</Cnpj></CpfCnpj>
    <InscricaoMunicipal>${INSC}</InscricaoMunicipal>
  </Prestador>
  <PeriodoEmissao>
    <DataInicial>${dataInicial}</DataInicial>
    <DataFinal>${dataFinal}</DataFinal>
  </PeriodoEmissao>
  <Pagina>${pagina}</Pagina>
</ConsultarNfseServicoPrestadoEnvio>`;
}

async function soapCall(dadosXml, tls) {
  const body = buildEnvelope(dadosXml);
  const url  = new URL(WEBISS_URL);
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"http://nfse.abrasf.org.br/ConsultarNfseServicoPrestado"',
        'Content-Length': Buffer.byteLength(body),
      },
      cert: tls.cert, key: tls.key,
      timeout: 30000,
    };
    const req = https.request(opts, res => {
      let text = '';
      res.on('data', d => text += d);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const err = new Error(`WebISS HTTP ${res.statusCode}`);
          err.response = text;
          return reject(err);
        }
        resolve(text);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('WebISS timeout')); });
    req.write(body);
    req.end();
  });
}

function extractOutput(soap) {
  const m = soap.match(/<outputXML[^>]*>([\s\S]*?)<\/outputXML>/);
  if (!m) return soap;
  return m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"');
}

function getTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : '';
}

function parseNfseList(xml) {
  const nfses = [];
  const re = /<CompNfse>([\s\S]*?)<\/CompNfse>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const g = tag => getTag(b, tag);
    const tomBlock = b.match(/<Tomador>([\s\S]*?)<\/Tomador>/)?.[1] || '';
    const gt = tag => getTag(tomBlock, tag);
    const cancelBlock = b.match(/<NfseCancelamento>([\s\S]*?)<\/NfseCancelamento>/)?.[1] || '';
    nfses.push({
      numero:             g('Numero'),
      competencia:        g('Competencia')?.substring(0,7) || '',
      dataEmissao:        g('DataEmissao')?.substring(0,10) || '',
      valorServicos:      parseFloat(g('ValorServicos'))  || 0,
      valorIss:           parseFloat(g('ValorIss'))       || 0,
      valorIr:            parseFloat(g('ValorIr'))        || 0,
      valorCsll:          parseFloat(g('ValorCsll'))      || 0,
      valorPis:           parseFloat(g('ValorPis'))       || 0,
      valorCofins:        parseFloat(g('ValorCofins'))    || 0,
      valorInss:          parseFloat(g('ValorInss'))      || 0,
      valorLiquido:       parseFloat(g('ValorLiquidoNfse')) || 0,
      tomadorRazaoSocial: gt('RazaoSocial') || gt('NomeFantasia') || '',
      tomadorCnpj:        gt('Cnpj') || gt('Cpf') || '',
      discriminacao:      g('Discriminacao'),
      cancelada:          cancelBlock.length > 0,
    });
  }
  return nfses;
}

function extractErrors(xml) {
  const re = /<MensagemRetorno>([\s\S]*?)<\/MensagemRetorno>/g;
  const erros = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    erros.push({ codigo: getTag(m[1],'Codigo'), mensagem: getTag(m[1],'Mensagem') });
  }
  return erros;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Gera janelas trimestrais ──────────────────────────────────────────────────

function getTrimesters(startYear, endDate) {
  const windows = [];
  const end = new Date(endDate);
  for (let year = startYear; year <= end.getFullYear(); year++) {
    for (let q = 0; q < 4; q++) {
      const from = new Date(year, q * 3, 1);
      const to   = new Date(year, q * 3 + 3, 0); // último dia do trimestre
      if (from > end) break;
      if (to > end) to.setTime(end.getTime());
      const fmt = d => d.toISOString().slice(0,10);
      windows.push({ label: `${year}-Q${q+1}`, from: fmt(from), to: fmt(to) });
    }
  }
  return windows;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🔧 Carregando certificado Assessoria...');
  const tls = loadClientCert();
  console.log('✅ Certificado carregado\n');

  const db = getDb('assessoria');

  // Garante colunas extras
  for (const [col, type] of [['webiss_numero_nfse','TEXT'],['discriminacao','TEXT']]) {
    try { db.prepare(`ALTER TABLE notas_fiscais ADD COLUMN ${col} ${type}`).run(); } catch(_) {}
  }

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO notas_fiscais
      (numero, competencia, cidade, tomador, cnpj_tomador,
       valor_bruto, valor_liquido,
       inss, ir, iss, csll, pis, cofins, retencao,
       data_emissao, status_conciliacao,
       webiss_numero_nfse, discriminacao)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const importarLote = db.transaction(nfses => {
    let ok = 0, skip = 0;
    for (const nf of nfses) {
      const retencao = nf.valorInss + nf.valorIr + nf.valorIss + nf.valorCsll + nf.valorPis + nf.valorCofins;
      const r = stmt.run(
        nf.numero, nf.competencia, 'Palmas/TO',
        nf.tomadorRazaoSocial, nf.tomadorCnpj,
        nf.valorServicos, nf.valorLiquido,
        nf.valorInss, nf.valorIr, nf.valorIss,
        nf.valorCsll, nf.valorPis, nf.valorCofins, retencao,
        nf.dataEmissao,
        nf.cancelada ? 'CANCELADA' : 'PENDENTE',
        nf.numero,
        nf.discriminacao,
      );
      if (r.changes > 0) ok++; else skip++;
    }
    return { ok, skip };
  });

  const today = new Date().toISOString().slice(0,10);
  const windows = getTrimesters(2023, today);

  let totalImported = 0, totalSkipped = 0, totalFound = 0;
  const porAno = {};

  console.log(`📅 Janelas de consulta: ${windows.length} trimestres (${windows[0].from} → ${windows[windows.length-1].to})\n`);

  for (let wi = 0; wi < windows.length; wi++) {
    const win = windows[wi];
    if (wi > 0) await sleep(DELAY_WINDOW);
    process.stdout.write(`  🔍 ${win.label} (${win.from} → ${win.to}): `);
    const allNfses = [];
    const seenNums = new Set();
    let errorOcurred = false;

    for (let pagina = 1; pagina <= 100; pagina++) {
      if (pagina > 1) await sleep(DELAY_MS);
      let retries = 0;
      let xml, erros;
      while (retries <= 3) {
        try {
          const dados = buildConsultaXml(win.from, win.to, pagina);
          const soap  = await soapCall(dados, tls);
          xml   = extractOutput(soap);
          erros = extractErrors(xml);

          // L999 = rate limit — aguarda e tenta de novo
          if (erros.some(e => e.codigo === 'L999')) {
            retries++;
            process.stdout.write(`\n    ⏳ Rate limit L999 — aguardando ${DELAY_RETRY/1000}s (tentativa ${retries}/3)...`);
            await sleep(DELAY_RETRY);
            continue;
          }
          break; // sucesso ou erro não-L999
        } catch(e) {
          console.log(`\n  ❌ Erro na página ${pagina}: ${e.message}`);
          errorOcurred = true;
          break;
        }
      }

      if (!xml) { errorOcurred = true; break; }

      if (erros.length > 0) {
        const msg = erros.map(e => `${e.codigo}: ${e.mensagem}`).join('; ');
        if (erros.some(e => e.codigo === 'E4' || e.mensagem?.includes('não encontrada') || e.mensagem?.includes('nenhuma'))) {
          break;
        }
        console.log(`⚠️  Erro WebISS: ${msg}`);
        errorOcurred = true;
        break;
      }

      const page = parseNfseList(xml);
      if (page.length === 0) break;

      const isRepeat = page.every(n => seenNums.has(n.numero));
      if (isRepeat) break;

      for (const n of page) seenNums.add(n.numero);
      allNfses.push(...page);

      if (page.length < 10) break;
      process.stdout.write('.');
    }

    if (allNfses.length === 0) {
      console.log(errorOcurred ? '(erro)' : '0 NFs');
      continue;
    }

    const { ok, skip } = importarLote(allNfses);
    totalImported += ok;
    totalSkipped  += skip;
    totalFound    += allNfses.length;
    for (const nf of allNfses) {
      const ano = nf.dataEmissao?.substring(0,4) || 'sem data';
      porAno[ano] = (porAno[ano]||0) + 1;
    }
    console.log(` ${allNfses.length} NFs → ${ok} novas, ${skip} já existiam`);
  }

  // Recalcula por ano direto do banco (mais preciso)
  const byYearFinal = db.prepare("SELECT strftime('%Y',data_emissao) ano, COUNT(*) n FROM notas_fiscais GROUP BY 1 ORDER BY 1").all();
  const totalFinal  = db.prepare('SELECT COUNT(*) n FROM notas_fiscais').get();

  console.log('\n══════════════════════════════════════════');
  console.log('✅ IMPORTAÇÃO CONCLUÍDA — Montana Assessoria');
  console.log('══════════════════════════════════════════');
  console.log(`  NFs encontradas no WebISS: ${totalFound}`);
  console.log(`  Novas importadas:          ${totalImported}`);
  console.log(`  Já existiam (ignoradas):   ${totalSkipped}`);
  console.log(`\n  Total no banco agora: ${totalFinal.n}`);
  console.log('\n  Distribuição por ano:');
  for (const r of byYearFinal) {
    console.log(`    ${r.ano || 'sem data'}: ${r.n} NFs`);
  }
}

main().catch(e => { console.error('\n❌ ERRO FATAL:', e.message); process.exit(1); });
