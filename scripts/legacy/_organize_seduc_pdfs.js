/**
 * Classifica e copia os 53 PDFs da pasta COMUNICAÇÃO COM A SEDUC para staging local
 * organizados por contrato (seduc-011-2023, seduc-016-2023, seduc-070-2023, _geral).
 */
const fs = require('fs');
const path = require('path');

const SRC = 'D:/ARQUIVO FINANCEIRO/DOCUMENTOS PARA OS POSTOS/SEDUC/COMUNICAÇÃO COM A SEDUC/';
const STAGING = 'contratos-staging/';

const map = {
  'seduc-011-2023': [
    '1º TERMO ADITIVO CONTR. 011.2023 - PROC 2024.27000.004671 - PRAZO DE VIGÊNCIA  - MONTANA SEGURANÇA.pdf',
    'TERMO DE CONTRATO NY 011_13_04_105402.pdf',
    'CONTRATO 11-2023 SEDUC ASSINADO .pdf',
    'PEDIDO DE REPACTUAÇÃO SEDUC 011-2023 1pedido.pdf',
    'PEDIDO DE REPACTUAÇÃO SEDUC 011-2023 2pedido.pdf',
    'ATA DE REGISTRO DE PREÇOS N° 01_2023 - PE_19_2020 - SEGURANÇA P. ARMADA E PUBLICAÇÃO.pdf',
    'Atestado de Cap. Tecnica - Seduc 5515.pdf',
    'ERRATA DO PEDIDO DE REPCTUAÇÃO SEDUC SEGURANÇA.pdf',
  ],
  'seduc-070-2023': [
    'TERMO DE CONTRATO NY 070_10_10_124227.pdf',
    'TERMO DE CONTRATO Nº 070.2023 -PROC. 2023.27000.019225 - MONTANA ASSESSORIA EMPRESARIAL-1.pdf',
    'TERMO DE CONTRATO Nº 070.2023 -PROC. 2023.27000.019225 - MONTANA ASSESSORIA EMPRESARIAL.pdf',
    'PEDIDO DE REPACTUAÇÃO SEDUC 070-2023 2pedido.pdf',
    '2° REPACTAÇÃO segurança contrato 070 2024 -.pdf',
    'Reposta-contrato 070 termo aditivo temporal 2025.pdf',
    'Oficio  - Contrato 070.pdf',
    '3° REPACTAÇÃO segurança contrato 070 2024 -  seduc - .pdf',
    '2° REPACTAÇÃO segurança contrato 070 2024 -  seduc.pdf',
    '3° REPACTAÇÃO segurança contrato 070 2024 -  seduc - envio 02 05 2025.pdf',
    '2 REPACTAÇÃO segurança contrato 070 2024 -  seduc.pdf',
    'PEDIDO DE REPACTUAÇÃO SEDUC 070- 1pedido.pdf',
  ],
  'seduc-016-2023': [
    'TERMO DE CONTRATO Nº 016.2023 - PROC. 2023 27000 000120 - MONTANA ASSESSORIA EMPRESARIAL.doc',
    'Copeiragem Ata de Registro.pdf',
    'Copeiragem Termo de Contrato.pdf',
    '[SEDUC 2024] Pedido de Repactuação Limpeza 03.04.2024.pdf',
    'Repactuação - Copeiragem - Seduc.pdf',
    'SEDUC 2024 Repact Limp SUMULA TST 03.04.2024.pdf',
    '[Seduc 2024] Adequação 1Pedido Repact 27.05.2024.pdf',
    'SEDUC Repactuação SUMULA448 27.05.2024.pdf',
    'LIMPEZA.pdf',
    'Ordem bancaria - Copeiragem - Seduc.pdf',
    'Jan fev e marco - Copeiragem SEDUC.pdf',
    'REPACTUACAO COPEIRAGM CCT 0000242025.pdf',
    '002_2025- CERTIDÃO DEMONSTRATIVO DE PISO SALARIAL - MONTANA ASSESSORIA.docx.pdf',
    'CONVENÇÃO COLETIVA DE TRABALHO 2025-2026 LIMPEZA A_250318_102438.pdf',
    'SEDUC 2025 Repact Limp 2025.pdf',
    '2023  - 120 , copeiragem - precluso.pdf',
    'Repactuação.pdf',
    'Copeiragem.pdf',
    'Copeiragem - junho - Montana.pdf',
    'Atestado i.pdf',
    'Atestado ii.pdf',
    'ATESTADO DE CAPACIDADE TÉCNICA.pdf',
    'ATESTADO.pdf',
  ],
  '_geral': [
    'ACOMPANHAMENTO DE PAGAMENTOS MONTANA.pdf',
    '23995533.pdf',
    'RELATORIO_TCE.pdf',
    'Contabilidade.pdf',
    'Empenho 31 de marco a 31 de dezembro.pdf',
    'Empenho 1 de janeiro março de 2025.pdf',
    'SEI_0732899_Parecer_Juridico_213.pdf',
    'Acórdão 2354 de 2018 Plenário.pdf',
    'Acórdão 1827 de 2008 Plenário.pdf',
    'ACORDAO TCE 1026.21PLENO.pdf',
  ],
};

// Função para sanitizar filename (remove espaços duplos, char ilegais no Unix)
function sanitize(name) {
  return name
    .replace(/[°º]/g, 'o')
    .replace(/[ÁÀÂÃÄáàâãä]/g, 'a')
    .replace(/[ÉÈÊËéèêë]/g, 'e')
    .replace(/[ÍÌÎÏíìîï]/g, 'i')
    .replace(/[ÓÒÔÕÖóòôõö]/g, 'o')
    .replace(/[ÚÙÛÜúùûü]/g, 'u')
    .replace(/[Çç]/g, 'c')
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s.\-\[\]()_]/g, '')
    .trim();
}

// Lookup index — read real filenames from disk and match via NFC-normalized form
const diskFiles = fs.readdirSync(SRC);
const byNFC = {};
for (const f of diskFiles) byNFC[f.normalize('NFC')] = f;

function findOnDisk(target) {
  const nfc = target.normalize('NFC');
  if (byNFC[nfc]) return byNFC[nfc];
  // fallback: try lowercase compare
  const lc = nfc.toLowerCase();
  for (const k of Object.keys(byNFC)) {
    if (k.toLowerCase() === lc) return byNFC[k];
  }
  return null;
}

let total = 0, missing = 0;
for (const [slug, files] of Object.entries(map)) {
  const dest = path.join(STAGING, slug === '_geral' ? '_geral_seduc' : slug);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of files) {
    const realName = findOnDisk(f);
    if (!realName) { console.log('  ! MISSING:', f); missing++; continue; }
    const srcPath = path.join(SRC, realName);
    const destName = sanitize(realName);
    const destPath = path.join(dest, destName);
    fs.copyFileSync(srcPath, destPath);
    total++;
  }
  console.log(`${slug}: ${files.length} declarados / copiados: ${files.length - missing}`);
}
console.log(`\nTotal copiado: ${total} | Missing: ${missing}`);
