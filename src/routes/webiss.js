/**
 * Montana — Integração WebISS (NFS-e Palmas-TO)
 * Protocolo: SOAP 1.1 — ABRASF v2.2
 * Endpoint:  https://palmasto.webiss.com.br/ws/nfse.asmx
 *
 * Operações implementadas:
 *   GET  /webiss/status          — testa conectividade com o WebISS
 *   GET  /webiss/consultar       — consulta NFS-e emitidas (sem assinatura)
 *   POST /webiss/importar        — importa NFS-e consultadas para o banco local
 *   POST /webiss/emitir          — emite NFS-e via GerarNfse (requer certificado A1)
 *
 * PRODUÇÃO — Certificados A1:
 *   Os arquivos .pfx precisam estar em /opt/montana/app_unificado/certificados/
 *   na VM GCP (104.196.22.170) com os nomes:
 *     assessoria.pfx  (CNPJ 14.092.519/0001-51 — Insc. Municipal 237319)
 *     seguranca.pfx   (CNPJ 19.200.109/0001-09 — Insc. Municipal 515161)
 *   Copiar via SCP:
 *     scp -i ~/.ssh/id_montana certificados/assessoria.pfx diretoria@104.196.22.170:/opt/montana/app_unificado/certificados/
 *     scp -i ~/.ssh/id_montana certificados/seguranca.pfx  diretoria@104.196.22.170:/opt/montana/app_unificado/certificados/
 *   As senhas e inscrições municipais devem estar no .env do servidor:
 *     WEBISS_CERT_SENHA_ASSESSORIA=14092519
 *     WEBISS_CERT_SENHA_SEGURANCA=19200109
 *     WEBISS_INSC_ASSESSORIA=237319
 *     WEBISS_INSC_SEGURANCA=515161
 */

require('dotenv').config();
const express = require('express');
const https   = require('https');
const http    = require('http');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const forge = require('node-forge');
const { SignedXml } = require('xml-crypto'); // usado por signRpsXml (emissão NFS-e)
const companyMw = require('../companyMiddleware');

const CERT_DIR = path.join(__dirname, '..', '..', 'certificados');
if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });

const router = express.Router();
router.use(companyMw);

// ─── Config ───────────────────────────────────────────────────────────────────

const WEBISS_URL = process.env.WEBISS_URL || 'https://palmasto.webiss.com.br/ws/nfse.asmx';
const ABRASF_NS  = 'http://www.abrasf.org.br/nfse.xsd';
const IBGE_PALMAS = '1721000';

// Header XML idêntico para todas as operações ABRASF v2.02
const CABEC_XML = `<cabecalho versao="2.02" xmlns="${ABRASF_NS}"><versaoDados>2.02</versaoDados></cabecalho>`;

// ─── Helpers SOAP ─────────────────────────────────────────────────────────────

function buildSoapEnvelope(operation, dadosXml) {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${operation}Request xmlns="http://nfse.abrasf.org.br"><nfseCabecMsg xmlns=""><![CDATA[${CABEC_XML}]]></nfseCabecMsg><nfseDadosMsg xmlns=""><![CDATA[${dadosXml}]]></nfseDadosMsg></${operation}Request></soap:Body></soap:Envelope>`;
}

/**
 * Carrega cert+key PEM do PFX da empresa (para mTLS).
 * Retorna null se cert ou senha não configurados.
 */
function loadClientCert(companyKey) {
  const certPath = path.join(CERT_DIR, `${companyKey}.pfx`);
  const certPwd  = process.env[`WEBISS_CERT_SENHA_${companyKey.toUpperCase()}`];
  if (!certPwd || !fs.existsSync(certPath)) return null;
  try {
    const { certPem, privateKeyPem } = loadCertificate(certPath, certPwd);
    return { cert: certPem, key: privateKeyPem };
  } catch (_) { return null; }
}

async function soapCall(operation, dadosXml, companyKey) {
  const body = buildSoapEnvelope(operation, dadosXml);
  const url  = new URL(WEBISS_URL);
  const tls  = companyKey ? loadClientCert(companyKey) : null;

  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const opts = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        'Content-Type':   'text/xml; charset=utf-8',
        'SOAPAction':     `"http://nfse.abrasf.org.br/${operation}"`,
        'Content-Length': Buffer.byteLength(body),
      },
      // mTLS — autenticação via certificado A1 da empresa no nível TLS
      ...(tls ? { cert: tls.cert, key: tls.key } : {}),
      timeout: 30000,
    };
    const req = mod.request(opts, res => {
      let text = '';
      res.on('data', d => { text += d; });
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

/** Extrai o conteúdo do elemento <outputXML> e faz unescape de entidades HTML */
function extractOutput(soapResponse) {
  const m = soapResponse.match(/<outputXML[^>]*>([\s\S]*?)<\/outputXML>/);
  if (!m) return soapResponse;
  return m[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
}

/** Lê o valor de uma tag XML (primeira ocorrência no bloco fornecido) */
function getTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : '';
}

/** Extrai lista de erros ABRASF do XML de resposta */
function extractErrors(xml) {
  const erros = [];
  const re = /<MensagemRetorno>([\s\S]*?)<\/MensagemRetorno>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    erros.push({
      codigo:   getTag(m[1], 'Codigo'),
      mensagem: getTag(m[1], 'Mensagem'),
      correcao: getTag(m[1], 'Correcao'),
    });
  }
  return erros;
}

// ─── Parser de NFS-e ──────────────────────────────────────────────────────────

function parseNfseList(xml) {
  const nfses = [];
  const re = /<CompNfse>([\s\S]*?)<\/CompNfse>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const g  = tag => getTag(b, tag);

    // Tomador pode estar em bloco aninhado
    const tomBlock = b.match(/<Tomador>([\s\S]*?)<\/Tomador>/)?.[1] || '';
    const gt = tag => getTag(tomBlock, tag);

    const cancelBlock = b.match(/<NfseCancelamento>([\s\S]*?)<\/NfseCancelamento>/)?.[1] || '';

    nfses.push({
      numero:             g('Numero'),
      competencia:        g('Competencia')?.substring(0, 7) || '',
      dataEmissao:        g('DataEmissao')?.substring(0, 10) || '',
      valorServicos:      parseFloat(g('ValorServicos'))  || 0,
      valorDeducoes:      parseFloat(g('ValorDeducoes'))  || 0,
      valorIss:           parseFloat(g('ValorIss'))       || 0,
      valorIr:            parseFloat(g('ValorIr'))        || 0,
      valorCsll:          parseFloat(g('ValorCsll'))      || 0,
      valorPis:           parseFloat(g('ValorPis'))       || 0,
      valorCofins:        parseFloat(g('ValorCofins'))    || 0,
      valorInss:          parseFloat(g('ValorInss'))      || 0,
      valorLiquido:       parseFloat(g('ValorLiquidoNfse')) || 0,
      issRetido:          g('IssRetido') === '1',
      discriminacao:      g('Discriminacao'),
      tomadorRazaoSocial: gt('RazaoSocial') || gt('NomeFantasia') || '',
      tomadorCnpj:        gt('Cnpj') || gt('Cpf') || '',
      cancelada:          cancelBlock.length > 0,
      codigoCancelamento: cancelBlock ? getTag(cancelBlock, 'CodigoCancelamento') : null,
      status:             cancelBlock ? 'CANCELADA' : 'ATIVA',
    });
  }
  return nfses;
}

// ─── Certificado A1 (PFX/P12) ─────────────────────────────────────────────────

function loadCertificate(pfxPath, password) {
  if (!fs.existsSync(pfxPath)) {
    throw new Error(`Certificado não encontrado: ${pfxPath}`);
  }
  const pfxDer = fs.readFileSync(pfxPath).toString('binary');
  const asn1   = forge.asn1.fromDer(pfxDer);
  const pfx    = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);

  const certBags = pfx.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
  const keyBags  = pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag];

  if (!certBags?.length) throw new Error('Certificado A1 inválido: sem certBag');
  if (!keyBags?.length)  throw new Error('Certificado A1 inválido: sem privateKey');

  return {
    certPem:       forge.pki.certificateToPem(certBags[0].cert),
    privateKeyPem: forge.pki.privateKeyToPem(keyBags[0].key),
  };
}

// ─── Assinatura XML (ABRASF RSA-SHA1 envelopada) ──────────────────────────────

function signRpsXml(rpsXml, privateKeyPem, certPem, refId) {
  // Extrai apenas o DER base64 do certificado (sem cabeçalho PEM)
  const certB64 = certPem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');

  // ABRASF v2.02 exige C14N inclusivo (não exclusivo)
  const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';

  const sig = new SignedXml({
    privateKey:              privateKeyPem,
    signatureAlgorithm:      'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
    canonicalizationAlgorithm: C14N,
  });

  sig.addReference({
    xpath: `//*[@Id="${refId}"]`,
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      C14N,
    ],
    digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
  });

  // Injeta X509Certificate no KeyInfo (API xml-crypto v6+)
  sig.getKeyInfoContent = () => `<X509Data><X509Certificate>${certB64}</X509Certificate></X509Data>`;

  // Signature fica em <Rps> após </InfDeclaracaoPrestacaoServico> (enveloped no doc root)
  sig.computeSignature(rpsXml);
  return sig.getSignedXml();
}

// ─── Garante colunas extras na tabela notas_fiscais ───────────────────────────

function ensureExtraColumns(db) {
  const extras = [
    ['webiss_numero_nfse', 'TEXT'],
    ['discriminacao',      'TEXT'],
  ];
  for (const [col, type] of extras) {
    try { db.prepare(`ALTER TABLE notas_fiscais ADD COLUMN ${col} ${type}`).run(); } catch (_) {}
  }
}

// ─── Rotas ────────────────────────────────────────────────────────────────────

/**
 * GET /api/webiss/status
 * Verifica se o endpoint WebISS está acessível.
 */
router.get('/status', async (req, res) => {
  try {
    const r = await fetch(`${WEBISS_URL}?WSDL`, {
      method: 'GET',
      signal: AbortSignal.timeout(8000),
    });
    const wsdl = await r.text();
    const temWsdl = wsdl.includes('wsdl:definitions') || wsdl.includes('ConsultarNfse');
    res.json({ ok: r.ok && temWsdl, httpStatus: r.status, url: WEBISS_URL, empresa: req.companyKey, wsdlOk: temWsdl });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message, url: WEBISS_URL });
  }
});

/**
 * Monta o XML de consulta ConsultarNfseServicoPrestado.
 * Autenticação feita via mTLS no nível TLS — sem assinatura XML.
 */
function buildConsultaXml(cnpj, insc, dataInicial, dataFinal, pagina) {
  // Autenticação feita via mTLS no nível TLS (soapCall) — sem assinatura XML
  return `<ConsultarNfseServicoPrestadoEnvio xmlns="${ABRASF_NS}">
  <Prestador>
    <CpfCnpj><Cnpj>${cnpj}</Cnpj></CpfCnpj>
    ${insc ? `<InscricaoMunicipal>${insc}</InscricaoMunicipal>` : ''}
  </Prestador>
  <PeriodoEmissao>
    <DataInicial>${dataInicial}</DataInicial>
    <DataFinal>${dataFinal}</DataFinal>
  </PeriodoEmissao>
  <Pagina>${pagina}</Pagina>
</ConsultarNfseServicoPrestadoEnvio>`;
}

/**
 * GET /api/webiss/consultar?dataInicial=YYYY-MM-DD&dataFinal=YYYY-MM-DD[&pagina=1]
 * Consulta NFS-e emitidas no WebISS (ConsultarNfseServicoPrestado).
 * Assina o XML com o certificado A1 da empresa (requerido pelo WebISS Palmas-TO).
 */
router.get('/consultar', async (req, res) => {
  const { dataInicial, dataFinal, pagina = 1 } = req.query;
  if (!dataInicial || !dataFinal) {
    return res.status(400).json({ error: 'dataInicial e dataFinal obrigatórios (YYYY-MM-DD)' });
  }

  const cnpj = req.company.cnpjRaw;
  const insc = process.env[`WEBISS_INSC_${req.companyKey.toUpperCase()}`] || '';

  const dados = buildConsultaXml(cnpj, insc, dataInicial, dataFinal, pagina);

  try {
    const soap   = await soapCall('ConsultarNfseServicoPrestado', dados, req.companyKey);
    const xml    = extractOutput(soap);
    const nfses  = parseNfseList(xml);
    const erros  = extractErrors(xml);
    res.json({ ok: erros.length === 0, nfses, total: nfses.length, erros, pagina: Number(pagina) });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/webiss/importar  { dataInicial, dataFinal }
 * Consulta NFS-e no WebISS e insere as não-existentes no banco local.
 * Usa INSERT OR IGNORE pelo numero da NF.
 */
router.post('/importar', async (req, res) => {
  const { dataInicial, dataFinal } = req.body;
  if (!dataInicial || !dataFinal) {
    return res.status(400).json({ error: 'dataInicial e dataFinal obrigatórios' });
  }

  const cnpj = req.company.cnpjRaw;
  const insc = process.env[`WEBISS_INSC_${req.companyKey.toUpperCase()}`] || '';
  const db   = req.db;

  try {
    // Busca todas as páginas até obter uma vazia ou repetida
    const allNfses = [];
    const seenNums = new Set();
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let pagina = 1; pagina <= 50; pagina++) {
      if (pagina > 1) await sleep(2500); // WebISS: máx 1 req/2s
      const dados = buildConsultaXml(cnpj, insc, dataInicial, dataFinal, pagina);
      const soap  = await soapCall('ConsultarNfseServicoPrestado', dados, req.companyKey);
      const xml   = extractOutput(soap);
      const erros = extractErrors(xml);

      if (erros.length > 0) return res.status(422).json({ ok: false, erros });

      const page = parseNfseList(xml);
      if (page.length === 0) break;

      // WebISS repete a última NFS-e quando não há mais páginas
      const isRepeat = page.every(n => seenNums.has(n.numero));
      if (isRepeat) break;

      for (const n of page) seenNums.add(n.numero);
      allNfses.push(...page);
    }

    ensureExtraColumns(db);

    const ins = db.prepare(`
      INSERT OR IGNORE INTO notas_fiscais
        (numero, competencia, cidade, tomador, cnpj_tomador,
         valor_bruto, valor_liquido,
         inss, ir, iss, csll, pis, cofins, retencao,
         data_emissao, status_conciliacao,
         webiss_numero_nfse, discriminacao)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    let imported = 0, skipped = 0;

    db.transaction(rows => {
      for (const nf of rows) {
        const retencao = nf.valorInss + nf.valorIr + nf.valorIss +
                         nf.valorCsll + nf.valorPis + nf.valorCofins;
        const r = ins.run(
          nf.numero,
          nf.competencia,
          'Palmas/TO',
          nf.tomadorRazaoSocial,
          nf.tomadorCnpj,
          nf.valorServicos,
          nf.valorLiquido,
          nf.valorInss,
          nf.valorIr,
          nf.valorIss,
          nf.valorCsll,
          nf.valorPis,
          nf.valorCofins,
          retencao,
          nf.dataEmissao,
          nf.status === 'CANCELADA' ? 'CANCELADA' : 'PENDENTE',
          nf.numero,       // webiss_numero_nfse
          nf.discriminacao,
        );
        if (r.changes > 0) imported++; else skipped++;
      }
    })(allNfses);

    res.json({ ok: true, total: allNfses.length, imported, skipped });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/webiss/emitir
 * Emite uma NFS-e via GerarNfse (requer certificado A1 configurado).
 *
 * Body JSON — campos obrigatórios:
 * {
 *   rps: {
 *     numero: "1",
 *     serie: "A",
 *     tipo: 1,
 *     dataEmissao: "2026-04-01",    // opcional, default hoje
 *     competencia: "2026-04-01",
 *     servico: {
 *       valorServicos: 50000.00,
 *       valorDeducoes: 0,
 *       valorPis: 325.00,
 *       valorCofins: 1500.00,
 *       valorInss: 0,
 *       valorIr: 750.00,
 *       valorCsll: 500.00,
 *       issRetido: true,
 *       valorIss: 0,
 *       aliquota: 0,
 *       itemLista: "0101",
 *       codTributacao: "0101",
 *       discriminacao: "Serviços conforme Contrato UFT 29/2022...",
 *       exigibilidadeIss: 1
 *     },
 *     tomador: {
 *       cnpj: "24599982000142",     // ou cpf: "..."
 *       razaoSocial: "FUNDACAO UNIVERSIDADE FEDERAL DO TOCANTINS",
 *       email: ""                   // opcional
 *     }
 *   }
 * }
 *
 * Pré-requisito: WEBISS_CERT_SENHA_<EMPRESA> no .env
 */
router.post('/emitir', async (req, res) => {
  const { rps } = req.body;
  if (!rps) return res.status(400).json({ error: 'Campo rps obrigatório' });

  const certEnvKey = `WEBISS_CERT_SENHA_${req.companyKey.toUpperCase()}`;
  const certPwd    = process.env[certEnvKey];
  if (!certPwd) {
    return res.status(501).json({
      ok: false,
      error: `Senha do certificado não configurada. Adicione ${certEnvKey}=<senha> no arquivo .env`,
    });
  }

  const cnpj   = req.company.cnpjRaw;
  const insc   = process.env[`WEBISS_INSC_${req.companyKey.toUpperCase()}`] || '';
  const cnae   = process.env[`WEBISS_CNAE_${req.companyKey.toUpperCase()}`] || rps.servico.codigoCnae || '';
  const certPath = req.company.certificadoPfx;
  const rpsId  = `rps_${rps.numero}_${(rps.serie || 'A').replace(/\W/g, '')}`;

  const today = new Date().toISOString().substring(0, 10);

  // Monta o CpfCnpj do tomador
  const tomadorDocTag = rps.tomador.cnpj
    ? `<Cnpj>${rps.tomador.cnpj.replace(/\D/g, '')}</Cnpj>`
    : `<Cpf>${(rps.tomador.cpf || '').replace(/\D/g, '')}</Cpf>`;

  // XML do RPS (elemento que será assinado)
  const rpsXml = `<Rps xmlns="${ABRASF_NS}"><InfDeclaracaoPrestacaoServico Id="${rpsId}">
  <Rps>
    <IdentificacaoRps>
      <Numero>${rps.numero}</Numero>
      <Serie>${rps.serie || 'A'}</Serie>
      <Tipo>${rps.tipo || 1}</Tipo>
    </IdentificacaoRps>
    <DataEmissao>${rps.dataEmissao || today}</DataEmissao>
    <Status>1</Status>
  </Rps>
  <Competencia>${rps.competencia}</Competencia>
  <Servico>
    <Valores>
      <ValorServicos>${(+rps.servico.valorServicos).toFixed(2)}</ValorServicos>
      <ValorDeducoes>${(+(rps.servico.valorDeducoes || 0)).toFixed(2)}</ValorDeducoes>
      <ValorPis>${(+(rps.servico.valorPis || 0)).toFixed(2)}</ValorPis>
      <ValorCofins>${(+(rps.servico.valorCofins || 0)).toFixed(2)}</ValorCofins>
      <ValorInss>${(+(rps.servico.valorInss || 0)).toFixed(2)}</ValorInss>
      <ValorIr>${(+(rps.servico.valorIr || 0)).toFixed(2)}</ValorIr>
      <ValorCsll>${(+(rps.servico.valorCsll || 0)).toFixed(2)}</ValorCsll>
      <ValorIss>${(+(rps.servico.valorIss || 0)).toFixed(2)}</ValorIss>
      ${rps.servico.issRetido ? `<Aliquota>${(+(rps.servico.aliquota || 0)).toFixed(4)}</Aliquota>` : ''}
    </Valores>
    <IssRetido>${rps.servico.issRetido ? 1 : 2}</IssRetido>
    <ItemListaServico>${rps.servico.itemLista || '07.10'}</ItemListaServico>
    <CodigoTributacaoMunicipio>${rps.servico.codTributacao || rps.servico.itemLista || '07.10'}</CodigoTributacaoMunicipio>
    <Discriminacao>${rps.servico.discriminacao}</Discriminacao>
    <CodigoMunicipio>${IBGE_PALMAS}</CodigoMunicipio>
    <ExigibilidadeISS>${rps.servico.exigibilidadeIss || 1}</ExigibilidadeISS>
    <MunicipioIncidencia>${IBGE_PALMAS}</MunicipioIncidencia>
  </Servico>
  <Prestador>
    <CpfCnpj><Cnpj>${cnpj}</Cnpj></CpfCnpj>
    ${insc ? `<InscricaoMunicipal>${insc}</InscricaoMunicipal>` : ''}
  </Prestador>
  <Tomador>
    <IdentificacaoTomador>
      <CpfCnpj>${tomadorDocTag}</CpfCnpj>
    </IdentificacaoTomador>
    <RazaoSocial>${rps.tomador.razaoSocial}</RazaoSocial>
    ${rps.tomador.email ? `<Contato><Email>${rps.tomador.email}</Email></Contato>` : ''}
  </Tomador>
  <OptanteSimplesNacional>2</OptanteSimplesNacional>
  <IncentivoFiscal>2</IncentivoFiscal>
</InfDeclaracaoPrestacaoServico></Rps>`;

  try {
    const { certPem, privateKeyPem } = loadCertificate(certPath, certPwd);
    const rpsAssinado = signRpsXml(rpsXml, privateKeyPem, certPem, rpsId);
    const envio       = `<GerarNfseEnvio xmlns="${ABRASF_NS}">${rpsAssinado}</GerarNfseEnvio>`;

    const soap  = await soapCall('GerarNfse', envio, req.companyKey);
    const xml   = extractOutput(soap);
    const erros = extractErrors(xml);

    if (erros.length > 0) {
      return res.status(422).json({ ok: false, erros });
    }

    const nfses = parseNfseList(xml);
    res.json({ ok: true, nfse: nfses[0] || null });
  } catch (e) {
    // Erros de certificado — retorna 501 Not Implemented
    if (/certificado|pfx|password|pkcs12/i.test(e.message)) {
      return res.status(501).json({ ok: false, error: e.message });
    }
    res.status(502).json({ ok: false, error: e.message, detail: e.response || null });
  }
});

// ─── CONFIGURAÇÃO DO CERTIFICADO A1 ──────────────────────────────────────────

/**
 * GET /webiss/config — retorna estado atual da configuração WebISS para a empresa
 */
router.get('/config', (req, res) => {
  const key = req.companyKey.toUpperCase();
  const certPath = req.company.certificadoPfx;
  const certExists = fs.existsSync(certPath);
  const hasSenha   = !!process.env[`WEBISS_CERT_SENHA_${key}`];
  const hasLogin   = !!process.env[`WEBISS_LOGIN_${key}`];
  const hasSenhaLogin = !!process.env[`WEBISS_SENHA_${key}`];

  let certInfo = null;
  if (certExists && hasSenha) {
    try {
      const pfx = fs.readFileSync(certPath);
      const p12 = forge.pkcs12.pkcs12FromAsn1(
        forge.asn1.fromDer(pfx.toString('binary')),
        process.env[`WEBISS_CERT_SENHA_${key}`]
      );
      const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
      const cert = Object.values(certBags)[0]?.[0]?.cert;
      if (cert) {
        const cn = cert.subject.getField('CN')?.value || '';
        const validTo = cert.validity.notAfter;
        const diasRestantes = Math.floor((validTo - new Date()) / 86400000);
        certInfo = { cn, validTo: validTo.toISOString().slice(0, 10), diasRestantes };
      }
    } catch (e) {
      certInfo = { erro: e.message };
    }
  }

  res.json({
    ok: true,
    empresa: req.companyKey,
    certPath,
    certExists,
    hasSenha,
    hasLogin,
    hasSenhaLogin,
    certInfo,
    pronto: certExists && hasSenha && hasLogin && hasSenhaLogin,
  });
});

/**
 * POST /webiss/upload-cert — faz upload do arquivo .pfx para a empresa atual
 */
const certStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, CERT_DIR),
  filename: (req, file, cb) => cb(null, req.companyKey + '.pfx'),
});
const certUpload = multer({
  storage: certStorage,
  fileFilter: (req, file, cb) => {
    const ok = file.originalname.toLowerCase().endsWith('.pfx') || file.mimetype === 'application/x-pkcs12';
    cb(ok ? null : new Error('Somente arquivos .pfx são aceitos'), ok);
  },
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB máx
});

router.post('/upload-cert', certUpload.single('cert'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Nenhum arquivo enviado' });

  // Valida que o .pfx pode ser lido com a senha fornecida (se informada)
  const senha = req.body.senha;
  if (senha) {
    try {
      const pfx = fs.readFileSync(req.file.path);
      forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(pfx.toString('binary')), senha);
    } catch (e) {
      fs.unlinkSync(req.file.path);
      return res.status(422).json({ ok: false, error: 'Senha incorreta ou arquivo corrompido: ' + e.message });
    }
    // Salva senha no .env
    _updateEnv(`WEBISS_CERT_SENHA_${req.companyKey.toUpperCase()}`, senha);
  }

  res.json({ ok: true, certPath: req.file.path, size: req.file.size });
});

/**
 * POST /webiss/config-senha — salva login/senha WebISS e senha do certificado no .env
 */
router.post('/config-senha', (req, res) => {
  const { login, senha_login, senha_cert } = req.body;
  const key = req.companyKey.toUpperCase();
  if (login)       _updateEnv(`WEBISS_LOGIN_${key}`, login);
  if (senha_login) _updateEnv(`WEBISS_SENHA_${key}`, senha_login);
  if (senha_cert)  _updateEnv(`WEBISS_CERT_SENHA_${key}`, senha_cert);
  res.json({ ok: true });
});

/** Atualiza (ou adiciona) uma variável no arquivo .env da raiz do projeto */
function _updateEnv(key, value) {
  const envPath = path.join(__dirname, '..', '..', '.env');
  let content = '';
  if (fs.existsSync(envPath)) content = fs.readFileSync(envPath, 'utf8');
  const re = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (re.test(content)) {
    content = content.replace(re, line);
  } else {
    content = content.trimEnd() + '\n' + line + '\n';
  }
  fs.writeFileSync(envPath, content, 'utf8');
  process.env[key] = value; // aplica imediatamente sem restart
}

module.exports = router;
