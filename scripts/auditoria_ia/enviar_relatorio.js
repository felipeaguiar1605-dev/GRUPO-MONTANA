#!/usr/bin/env node
'use strict';
/**
 * Montana — Envia o relatorio de auditoria IA por e-mail.
 *
 * Por padrao envia o relatorio mais recente em output/auditoria_ia_*.md.
 * Agendamento sugerido: segunda 08h00 (depois da execucao de sabado 04h).
 *
 * Uso:
 *   node scripts/auditoria_ia/enviar_relatorio.js
 *   node scripts/auditoria_ia/enviar_relatorio.js --data=2026-04-20
 *   node scripts/auditoria_ia/enviar_relatorio.js --para=outra@empresa.com
 *
 * Requer no .env (padrao do ERP):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_TO
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function localizarRelatorio(outDir, dataAlvo) {
  if (dataAlvo) {
    const exato = path.join(outDir, `auditoria_ia_${dataAlvo}.md`);
    if (fs.existsSync(exato)) return exato;
    throw new Error(`Relatorio nao encontrado para a data ${dataAlvo}: ${exato}`);
  }
  const candidatos = fs.readdirSync(outDir)
    .filter(f => /^auditoria_ia_\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse();
  if (!candidatos.length) {
    throw new Error(`Nenhum relatorio auditoria_ia_*.md em ${outDir}`);
  }
  return path.join(outDir, candidatos[0]);
}

// Markdown → HTML bem simples (suficiente pra relatorio; sem dependencia extra)
function mdParaHtml(md) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linhas = md.split('\n');
  const out = [];
  let emCodigo = false;
  let emTabela = false;

  for (const linha of linhas) {
    if (linha.startsWith('```')) {
      if (emCodigo) { out.push('</pre>'); emCodigo = false; }
      else { out.push('<pre style="background:#f4f4f4;padding:10px;overflow:auto;">'); emCodigo = true; }
      continue;
    }
    if (emCodigo) { out.push(esc(linha)); continue; }

    if (linha.startsWith('# '))       out.push(`<h1>${esc(linha.slice(2))}</h1>`);
    else if (linha.startsWith('## ')) out.push(`<h2>${esc(linha.slice(3))}</h2>`);
    else if (linha.startsWith('### '))out.push(`<h3>${esc(linha.slice(4))}</h3>`);
    else if (linha.startsWith('- '))  out.push(`<li>${formatarInline(linha.slice(2))}</li>`);
    else if (linha.trim() === '---')  out.push('<hr/>');
    else if (linha.startsWith('|')) {
      if (!emTabela) { out.push('<table border="1" cellpadding="4" style="border-collapse:collapse;">'); emTabela = true; }
      if (/^\|[\s\-:|]+\|$/.test(linha)) continue; // separador
      const cells = linha.split('|').slice(1, -1).map(c => `<td>${formatarInline(c.trim())}</td>`).join('');
      out.push(`<tr>${cells}</tr>`);
    }
    else {
      if (emTabela) { out.push('</table>'); emTabela = false; }
      if (linha.trim()) out.push(`<p>${formatarInline(linha)}</p>`);
    }
  }
  if (emTabela) out.push('</table>');

  function formatarInline(s) {
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  return `<html><body style="font-family:-apple-system,Segoe UI,sans-serif;max-width:860px;">
${out.join('\n')}
</body></html>`;
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = path.join(__dirname, '..', '..', 'output');
  const arquivoRel = localizarRelatorio(outDir, args.data || null);
  const md = fs.readFileSync(arquivoRel, 'utf8');
  const html = mdParaHtml(md);

  const smtp = {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to:   args.para || process.env.SMTP_TO,
  };

  const faltando = ['host','user','pass','to'].filter(k => !smtp[k]);
  if (faltando.length) {
    console.error(`ERRO: variaveis SMTP faltando no .env: ${faltando.map(k => 'SMTP_'+k.toUpperCase()).join(', ')}`);
    process.exit(1);
  }

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: smtp.host, port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass },
  });

  const nomeArq = path.basename(arquivoRel);
  const dataRel = (nomeArq.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || '';
  const assunto = `[Montana] Auditoria IA Semanal — ${dataRel}`;

  await transporter.sendMail({
    from: smtp.from,
    to: smtp.to,
    subject: assunto,
    html,
    attachments: [{ filename: nomeArq, path: arquivoRel, contentType: 'text/markdown' }],
  });

  console.log(`  ✅ E-mail enviado para ${smtp.to}`);
  console.log(`     Assunto : ${assunto}`);
  console.log(`     Anexo   : ${nomeArq}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('ERRO FATAL:', err.message);
    process.exit(1);
  });
}
