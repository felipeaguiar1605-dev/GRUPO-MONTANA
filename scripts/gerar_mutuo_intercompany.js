#!/usr/bin/env node
/**
 * Montana — Gerador de Minuta de Contrato de Mútuo Intercompany
 *
 * Gera minuta formatada em HTML+DOC e MD a partir dos dados de exposição intragrupo.
 * Entrada: credor, devedor, valor, prazo (opcional), taxa (opcional)
 *
 * Uso:
 *   node scripts/gerar_mutuo_intercompany.js --credor=nevada --devedor=assessoria --valor=1039794.73
 *   node scripts/gerar_mutuo_intercompany.js --credor=assessoria --devedor=seguranca --valor=700000 --prazo=12 --taxa=1.0
 *
 * Saída: ./contratos/mutuo_<DEV>_<CRED>_<DATA>.doc  e  .md
 */
'use strict';
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { COMPANIES } = require('../src/db');

// Parties extras que não estão em COMPANIES (fornecedores intragrupo não-CNPJ do sistema)
const PARTES_EXTRAS = {
  nevada: {
    key: 'nevada',
    nome: 'Nevada M Limpeza e Conservação LTDA',
    cnpj: '—',
    regime: 'Simples Nacional',
    endereco: 'Palmas/TO',
  },
  montreal: {
    key: 'montreal',
    nome: 'Montreal Máquinas e Ferramentas LTDA',
    cnpj: '—',
    regime: 'a confirmar',
    endereco: 'Palmas/TO',
  },
};

function parte(key) {
  const k = (key || '').toLowerCase();
  if (COMPANIES[k]) {
    const c = COMPANIES[k];
    return {
      key: k,
      nome: c.nome,
      cnpj: c.cnpj,
      regime: k === 'assessoria' ? 'Lucro Real (não-cumulativo)'
            : k === 'seguranca' ? 'Lucro Real Anual (cumulativo)'
            : 'Simples Nacional',
      endereco: 'Palmas/TO',
    };
  }
  if (PARTES_EXTRAS[k]) return PARTES_EXTRAS[k];
  return null;
}

const args = process.argv.slice(2);
const getArg = (k, d) => (args.find(a => a.startsWith('--' + k + '=')) || '').split('=')[1] || d;

const credorKey = (getArg('credor') || '').toLowerCase();
const devedorKey = (getArg('devedor') || '').toLowerCase();
const valor = parseFloat(getArg('valor', '0'));
const prazo = parseInt(getArg('prazo', '24'), 10); // meses
const taxa  = parseFloat(getArg('taxa', '1.0'));   // %/mês (default 1% ao mês)

if (!credorKey || !devedorKey || !valor) {
  console.error('Uso: node scripts/gerar_mutuo_intercompany.js --credor=<key> --devedor=<key> --valor=NNN [--prazo=24] [--taxa=1.0]');
  console.error('Keys: assessoria, seguranca, portodovau, mustang, nevada, montreal');
  process.exit(1);
}

const credor = parte(credorKey);
const devedor = parte(devedorKey);
if (!credor || !devedor) {
  console.error('Parte não reconhecida:', !credor ? credorKey : devedorKey);
  process.exit(1);
}

const hoje = new Date();
const data = hoje.toISOString().slice(0, 10);
const dataExt = hoje.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
const valorStr = valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function porExtenso(v) {
  // Aproximação — só reais inteiros
  const inteiro = Math.floor(v);
  return `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} (valor total, em reais)`;
}

const CLAUSULAS = `
<h2>CONTRATO DE MÚTUO INTERCOMPANHIAS</h2>

<p><strong>CREDOR:</strong> ${credor.nome}, pessoa jurídica de direito privado, inscrita no CNPJ sob o nº <strong>${credor.cnpj}</strong>, com sede em ${credor.endereco}, doravante denominada simplesmente <strong>MUTUANTE</strong>.</p>

<p><strong>DEVEDOR:</strong> ${devedor.nome}, pessoa jurídica de direito privado, inscrita no CNPJ sob o nº <strong>${devedor.cnpj}</strong>, com sede em ${devedor.endereco}, doravante denominada simplesmente <strong>MUTUÁRIA</strong>.</p>

<p>As partes acima identificadas têm, entre si, justo e acertado o presente <strong>Contrato de Mútuo Intercompanhias</strong>, que se regerá pelas cláusulas seguintes e pelas condições descritas abaixo.</p>

<h3>CLÁUSULA PRIMEIRA — DO OBJETO</h3>
<p>1.1. O presente contrato tem por objeto a concessão de mútuo, pela MUTUANTE à MUTUÁRIA, do valor de <strong>${porExtenso(valor)}</strong>, a ser utilizado exclusivamente para <strong>quitação de obrigações operacionais (notas fiscais de fornecimento de bens e serviços)</strong> entre as partes.</p>

<p>1.2. O valor do mútuo corresponde ao saldo de exposição intragrupo apurado em ${dataExt}, referente a operações comerciais entre as partes ainda não liquidadas.</p>

<h3>CLÁUSULA SEGUNDA — DA FORMA DE LIBERAÇÃO</h3>
<p>2.1. O valor do mútuo é considerado <strong>liberado mediante compensação contábil</strong> das notas fiscais em aberto entre as partes, dispensando-se nova movimentação financeira na data da assinatura.</p>

<h3>CLÁUSULA TERCEIRA — DA REMUNERAÇÃO</h3>
<p>3.1. O mútuo será remunerado à taxa de <strong>${taxa.toFixed(2)}% ao mês</strong>, equivalente a ${((Math.pow(1 + taxa / 100, 12) - 1) * 100).toFixed(2)}% ao ano, calculados sobre o saldo devedor pró-rata die.</p>
<p>3.2. A taxa acordada está em conformidade com a taxa de mercado (SELIC vigente), atendendo ao princípio da plena concorrência (<em>arm's length</em>) previsto na Lei nº 14.596/2023, evitando caracterização de distribuição disfarçada de lucros.</p>

<h3>CLÁUSULA QUARTA — DO PRAZO E PAGAMENTO</h3>
<p>4.1. O prazo de vencimento do presente mútuo é de <strong>${prazo} (${numExt(prazo)}) meses</strong>, a contar da data de assinatura.</p>
<p>4.2. O pagamento poderá ser efetuado: (a) em parcela única no vencimento; (b) em parcelas mensais de principal + juros; ou (c) mediante compensação com créditos futuros da MUTUÁRIA junto à MUTUANTE — sempre a critério das partes e mediante aditivo contratual.</p>

<h3>CLÁUSULA QUINTA — DO IOF</h3>
<p>5.1. Sobre o valor mutuado incide Imposto sobre Operações Financeiras (IOF) à alíquota de 0,38% + 0,0041%/dia (máximo 1,88% ao ano), nos termos do art. 13 da Lei nº 9.779/1999 e do Decreto nº 6.306/2007.</p>
<p>5.2. O recolhimento do IOF é de responsabilidade da MUTUÁRIA, conforme art. 4º do Decreto nº 6.306/2007.</p>

<h3>CLÁUSULA SEXTA — DAS OBRIGAÇÕES TRIBUTÁRIAS ACESSÓRIAS</h3>
<p>6.1. Ambas as partes se obrigam a registrar a operação na contabilidade, no ECD (Escrituração Contábil Digital) e na ECF (Escrituração Contábil Fiscal), nas contas específicas de:</p>
<ul>
  <li>MUTUANTE: "Mútuo ativo — partes relacionadas" (subgrupo de crédito)</li>
  <li>MUTUÁRIA: "Mútuo passivo — partes relacionadas" (subgrupo de dívida)</li>
</ul>
<p>6.2. A operação será declarada na DCTF, DIRPJ e nos demais instrumentos exigidos pela Receita Federal.</p>

<h3>CLÁUSULA SÉTIMA — DO REGIME TRIBUTÁRIO DAS PARTES</h3>
<p>7.1. Para fins de transparência: MUTUANTE é optante pelo regime de <strong>${credor.regime}</strong> e MUTUÁRIA pelo regime de <strong>${devedor.regime}</strong>. Os efeitos fiscais (crédito/débito de PIS-COFINS, IRPJ/CSLL sobre juros) serão apropriados conforme a legislação aplicável a cada regime.</p>

<h3>CLÁUSULA OITAVA — DAS DISPOSIÇÕES GERAIS</h3>
<p>8.1. Este contrato obriga as partes, seus herdeiros e sucessores a qualquer título.</p>
<p>8.2. Qualquer alteração deverá ser formalizada por aditivo contratual assinado pelas partes.</p>
<p>8.3. Fica eleito o foro da comarca de Palmas/TO para dirimir quaisquer controvérsias decorrentes do presente instrumento.</p>

<p>E, por estarem assim, justas e contratadas, assinam o presente em duas vias de igual teor e forma.</p>

<p>Palmas/TO, ${dataExt}.</p>

<br>
<hr>
<br>

<p>_________________________________________<br>
<strong>${credor.nome}</strong><br>
CNPJ: ${credor.cnpj}<br>
MUTUANTE</p>

<br>

<p>_________________________________________<br>
<strong>${devedor.nome}</strong><br>
CNPJ: ${devedor.cnpj}<br>
MUTUÁRIA</p>

<br>

<p>_________________________________________<br>
<strong>Testemunha 1</strong><br>
Nome:<br>
CPF:</p>

<br>

<p>_________________________________________<br>
<strong>Testemunha 2</strong><br>
Nome:<br>
CPF:</p>
`;

function numExt(n) {
  const map = { 1: 'um', 2: 'dois', 3: 'três', 6: 'seis', 12: 'doze', 18: 'dezoito', 24: 'vinte e quatro', 36: 'trinta e seis', 48: 'quarenta e oito', 60: 'sessenta' };
  return map[n] || String(n);
}

// Monta HTML-DOC (MSO aceita HTML com extensão .doc nativamente)
const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="UTF-8">
<title>Contrato de Mútuo Intercompany — ${devedor.nome}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
  @page { size: A4; margin: 2.5cm; }
  body { font-family: 'Times New Roman', serif; font-size: 12pt; line-height: 1.5; color: #000; }
  h2 { text-align: center; font-size: 14pt; margin: 0 0 24pt 0; }
  h3 { font-size: 12pt; margin: 18pt 0 6pt 0; font-weight: bold; }
  p { text-align: justify; margin: 0 0 6pt 0; }
  ul { margin: 0 0 6pt 20pt; }
  hr { border: 0; border-top: 1px solid #333; margin: 12pt 0; }
</style>
</head>
<body>
${CLAUSULAS}
</body>
</html>`;

// MD simples
const md = `# CONTRATO DE MÚTUO INTERCOMPANHIAS

**CREDOR (MUTUANTE):** ${credor.nome}  — CNPJ ${credor.cnpj}
**DEVEDOR (MUTUÁRIA):** ${devedor.nome}  — CNPJ ${devedor.cnpj}

**Valor:** R$ ${valorStr}
**Prazo:** ${prazo} meses  |  **Taxa:** ${taxa.toFixed(2)}% a.m.  (~${((Math.pow(1 + taxa / 100, 12) - 1) * 100).toFixed(2)}% a.a.)
**Data:** ${dataExt}

---

${CLAUSULAS.replace(/<[^>]+>/g, '').replace(/\n\n+/g, '\n\n')}
`;

const outDir = path.join(__dirname, '..', 'contratos');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const base = `mutuo_${devedorKey}_${credorKey}_${data}`;
const docPath = path.join(outDir, base + '.doc');
const mdPath  = path.join(outDir, base + '.md');

fs.writeFileSync(docPath, html, 'utf8');
fs.writeFileSync(mdPath, md, 'utf8');

console.log('\n✅ Minuta gerada:');
console.log('   📄 ' + docPath + '  (Word — abrir com MS Word / LibreOffice)');
console.log('   📝 ' + mdPath);
console.log('\nResumo:');
console.log(`   Credor (Mutuante): ${credor.nome} [${credor.cnpj}]`);
console.log(`   Devedor (Mutuária): ${devedor.nome} [${devedor.cnpj}]`);
console.log(`   Valor: R$ ${valorStr}`);
console.log(`   Prazo: ${prazo} meses | Taxa: ${taxa.toFixed(2)}% a.m.`);
console.log('');
