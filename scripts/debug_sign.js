/**
 * Debug: gera um RPS assinado e verifica a estrutura do XML
 * node scripts/debug_sign.js
 */
require('dotenv').config();
const forge      = require('node-forge');
const { SignedXml } = require('xml-crypto');
const fs         = require('fs');
const path       = require('path');

const ABRASF_NS = 'http://www.abrasf.org.br/nfse.xsd';
const C14N_INC  = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const C14N_EXC  = 'http://www.w3.org/2001/10/xml-exc-c14n#';

// ─── Carrega certificado ───────────────────────────────────────────────────────
const pfxPath = path.join(__dirname, '../certificados/assessoria.pfx');
const pwd     = process.env.WEBISS_CERT_SENHA_ASSESSORIA;

if (!pwd) { console.error('WEBISS_CERT_SENHA_ASSESSORIA não definida no .env'); process.exit(1); }

const pfxDer   = fs.readFileSync(pfxPath).toString('binary');
const asn1     = forge.asn1.fromDer(pfxDer);
const pfxObj   = forge.pkcs12.pkcs12FromAsn1(asn1, false, pwd);
const certBags = pfxObj.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
const keyBags  = pfxObj.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag];
const certPem  = forge.pki.certificateToPem(certBags[0].cert);
const privPem  = forge.pki.privateKeyToPem(keyBags[0].key);
const certB64  = certPem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');

const cert = certBags[0].cert;
console.log('Certificado CN   :', cert.subject.getField('CN')?.value);
console.log('Válido até        :', cert.validity.notAfter.toISOString().substring(0,10));
console.log('Chave privada OK  :', privPem.includes('BEGIN') ? 'SIM' : 'NAO');

// ─── XML do RPS ───────────────────────────────────────────────────────────────
const refId  = 'rps_debug_1';
const rpsXml = `<Rps xmlns="${ABRASF_NS}"><InfDeclaracaoPrestacaoServico Id="${refId}"><Rps><IdentificacaoRps><Numero>99</Numero><Serie>A</Serie><Tipo>1</Tipo></IdentificacaoRps><DataEmissao>2026-04-14</DataEmissao><Status>1</Status></Rps><Competencia>2026-04-01</Competencia><Servico><Valores><ValorServicos>10.00</ValorServicos><ValorDeducoes>0.00</ValorDeducoes><ValorIss>0.00</ValorIss><Aliquota>2.0000</Aliquota></Valores><IssRetido>2</IssRetido><ItemListaServico>07.10</ItemListaServico><CodigoTributacaoMunicipio>07.10</CodigoTributacaoMunicipio><Discriminacao>Debug</Discriminacao><CodigoMunicipio>1721000</CodigoMunicipio><ExigibilidadeISS>1</ExigibilidadeISS><MunicipioIncidencia>1721000</MunicipioIncidencia></Servico><Prestador><CpfCnpj><Cnpj>14092519000151</Cnpj></CpfCnpj></Prestador><Tomador><IdentificacaoTomador><CpfCnpj><Cnpj>19200109000109</Cnpj></CpfCnpj></IdentificacaoTomador><RazaoSocial>MONTANA SEGURANCA</RazaoSocial></Tomador><OptanteSimplesNacional>2</OptanteSimplesNacional><IncentivoFiscal>2</IncentivoFiscal></InfDeclaracaoPrestacaoServico></Rps>`;

// ─── Testa com C14N inclusivo ─────────────────────────────────────────────────
function assinar(c14n, label) {
  const sig = new SignedXml({
    privateKey:               privPem,
    signatureAlgorithm:       'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    canonicalizationAlgorithm: c14n,
  });
  sig.addReference({
    xpath: `//*[@Id="${refId}"]`,
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', c14n],
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
  });
  // xml-crypto v6+: usa getKeyInfoContent em vez de keyInfoProvider
  sig.getKeyInfoContent = () => `<X509Data><X509Certificate>${certB64}</X509Certificate></X509Data>`;
  sig.computeSignature(rpsXml);
  const xml = sig.getSignedXml();
  const out = `debug_signed_${label}.xml`;
  fs.writeFileSync(out, xml);
  console.log(`\n─── ${label} ─────────────────────────────────`);
  console.log('Arquivo salvo    :', out);
  console.log('<Signature>      :', xml.includes('<Signature') ? 'PRESENTE' : 'AUSENTE');
  console.log('X509Certificate  :', xml.includes('X509Certificate') ? 'PRESENTE' : 'AUSENTE');
  console.log('Reference URI    :', (xml.match(/URI="([^"]+)"/) || ['',''])[1]);
  console.log('C14N Method      :', (xml.match(/CanonicalizationMethod Algorithm="([^"]+)"/) || ['',''])[1]);
  console.log('Digest Algorithm :', (xml.match(/DigestMethod Algorithm="([^"]+)"/) || ['',''])[1]);
  console.log('Sig local na Rps :', xml.includes('</InfDeclaracaoPrestacaoServico><Signature') || xml.includes('</InfDeclaracaoPrestacaoServico>\n<Signature') ? 'APÓS InfDecl (CORRETO)' : 'OUTRO lugar');
}

assinar(C14N_INC,  'inclusivo');
assinar(C14N_EXC,  'exclusivo');

console.log('\nDone. Verifique os arquivos debug_signed_*.xml');
