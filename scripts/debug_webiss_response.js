/**
 * Diagnóstico WebISS — Mostra resposta bruta para identificar problemas
 * Uso: node scripts/debug_webiss_response.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const forge = require('node-forge');

const WEBISS_URL = process.env.WEBISS_URL || 'https://palmasto.webiss.com.br/ws/nfse.asmx';
const CNPJ       = '14092519000151';
const INSC       = process.env.WEBISS_INSC_ASSESSORIA || '237319';
const CERT_PATH  = path.join(__dirname, '..', 'certificados', 'assessoria.pfx');
const CERT_SENHA = process.env.WEBISS_CERT_SENHA_ASSESSORIA || '14092519';
const ABRASF_NS  = 'http://www.abrasf.org.br/nfse.xsd';

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

async function soapCall(dadosXml, tls) {
  const CABEC = `<cabecalho versao="2.02" xmlns="${ABRASF_NS}"><versaoDados>2.02</versaoDados></cabecalho>`;
  const body = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><ConsultarNfseServicoPrestadoRequest xmlns="http://nfse.abrasf.org.br"><nfseCabecMsg xmlns=""><![CDATA[${CABEC}]]></nfseCabecMsg><nfseDadosMsg xmlns=""><![CDATA[${dadosXml}]]></nfseDadosMsg></ConsultarNfseServicoPrestadoRequest></soap:Body></soap:Envelope>`;
  const url = new URL(WEBISS_URL);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname, method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': '"http://nfse.abrasf.org.br/ConsultarNfseServicoPrestado"',
        'Content-Length': Buffer.byteLength(body),
      },
      cert: tls.cert, key: tls.key, timeout: 30000,
    }, res => {
      let text = '';
      res.on('data', d => text += d);
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function extractOutput(soap) {
  const m = soap.match(/<outputXML[^>]*>([\s\S]*?)<\/outputXML>/);
  if (!m) return soap;
  return m[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&quot;/g,'"');
}

async function main() {
  console.log('🔧 Carregando certificado...');
  const tls = loadClientCert();
  console.log('✅ OK\n');

  // Consulta último mês (deve ter centenas de notas)
  const hoje = new Date();
  const mesPassado = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
  const fimMes = new Date(hoje.getFullYear(), hoje.getMonth(), 0);
  const dataIni = mesPassado.toISOString().slice(0, 10);
  const dataFim = fimMes.toISOString().slice(0, 10);

  console.log(`📅 Consultando: ${dataIni} → ${dataFim} (página 1)\n`);

  const dados = `<ConsultarNfseServicoPrestadoEnvio xmlns="${ABRASF_NS}">
  <Prestador>
    <CpfCnpj><Cnpj>${CNPJ}</Cnpj></CpfCnpj>
    <InscricaoMunicipal>${INSC}</InscricaoMunicipal>
  </Prestador>
  <PeriodoEmissao>
    <DataInicial>${dataIni}</DataInicial>
    <DataFinal>${dataFim}</DataFinal>
  </PeriodoEmissao>
  <Pagina>1</Pagina>
</ConsultarNfseServicoPrestadoEnvio>`;

  const res = await soapCall(dados, tls);
  console.log(`HTTP Status: ${res.status}`);
  console.log(`Tamanho resposta: ${res.body.length} bytes\n`);

  const xml = extractOutput(res.body);
  console.log(`Tamanho XML extraído: ${xml.length} bytes\n`);

  // Contar CompNfse no XML
  const matches = xml.match(/<CompNfse>/g);
  console.log(`<CompNfse> encontrados: ${matches ? matches.length : 0}\n`);

  // Contar erros
  const erros = xml.match(/<MensagemRetorno>/g);
  if (erros) {
    console.log(`Erros encontrados: ${erros.length}`);
    const errRe = /<MensagemRetorno>([\s\S]*?)<\/MensagemRetorno>/g;
    let m;
    while ((m = errRe.exec(xml)) !== null) {
      const cod = m[1].match(/<Codigo>(.*?)<\/Codigo>/)?.[1] || '?';
      const msg = m[1].match(/<Mensagem>(.*?)<\/Mensagem>/)?.[1] || '?';
      console.log(`  → ${cod}: ${msg}`);
    }
  }

  // Salvar XML bruto para análise
  const debugFile = path.join(__dirname, '..', 'data', 'debug_webiss_response.xml');
  fs.writeFileSync(debugFile, xml);
  console.log(`\n💾 XML salvo em: ${debugFile}`);
  console.log('\n── Primeiros 2000 caracteres do XML ──');
  console.log(xml.substring(0, 2000));
  console.log('\n── Últimos 500 caracteres ──');
  console.log(xml.substring(xml.length - 500));
}

main().catch(e => { console.error('❌ ERRO:', e.message); process.exit(1); });
