'use strict';
/**
 * Importação em lote de comprovantes de pagamento (PDFs) para a tabela
 * comprovantes_pagamento.
 *
 * Uso:
 *   node scripts/importar_comprovantes_batch.js --empresa=seguranca --pasta="C:\Users\Avell\Downloads\Extratos_Comprovantes\MARÇO MONTANA SEGURANÇA"
 *   node scripts/importar_comprovantes_batch.js --empresa=seguranca --pasta="..." --dry-run
 *
 * Lógica de deduplicação: SHA-256 do arquivo. Se já existe no banco, pula.
 * Nomenclatura BB esperada:
 *   OBT1DDMMAAAA[...].pdf  → tipo=OB,   direcao=ENTRADA  (Ordem Bancária recebida)
 *   TFI1DDMMAAAA[...].pdf  → tipo=TED,  direcao=SAIDA    (Transferência enviada)
 *   009DDMMAAAA[...].pdf   → tipo=OB,   direcao=ENTRADA  (Ordem Bancária recebida)
 *   outros                 → tipo=OUTRO,direcao=ENTRADA
 */
const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const ARG    = process.argv.slice(2);
const arg    = (k, def = '') => (ARG.find(a => a.startsWith(`--${k}=`)) || `--${k}=${def}`).split('=').slice(1).join('=');
const empresa  = arg('empresa', 'seguranca');
const DRY_RUN  = ARG.includes('--dry-run');
const PASTA    = arg('pasta', '');

if (!PASTA) {
  console.error('❌ Informe --pasta="caminho/da/pasta"');
  process.exit(1);
}
if (!fs.existsSync(PASTA)) {
  console.error('❌ Pasta não encontrada:', PASTA);
  process.exit(1);
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

/** Extrai tipo e direcao a partir do nome do arquivo */
function inferirTipoDirecao(nome) {
  const u = nome.toUpperCase();
  if (u.startsWith('OBT')) return { tipo: 'OB',    direcao: 'ENTRADA' };
  if (u.startsWith('TFI')) return { tipo: 'TED',   direcao: 'SAIDA'   };
  if (u.startsWith('009')) return { tipo: 'OB',    direcao: 'ENTRADA' };
  if (u.startsWith('PIX')) return { tipo: 'PIX',   direcao: 'ENTRADA' };
  if (u.startsWith('TED')) return { tipo: 'TED',   direcao: 'ENTRADA' };
  return { tipo: 'OUTRO', direcao: 'ENTRADA' };
}

/** Tenta extrair data DDMMAAAA do nome de arquivo BB */
function extrairDataNome(nome) {
  // padrão: OBT1DDMMAAAA ou 009DDMMAAAA  (8 dígitos após prefixo)
  const m = nome.match(/[A-Z]+\d?(\d{2})(\d{2})(\d{4})/);
  if (!m) return null;
  const [, dd, mm, aaaa] = m;
  // Valida
  const d = parseInt(dd), mo = parseInt(mm), a = parseInt(aaaa);
  if (d < 1 || d > 31 || mo < 1 || mo > 12 || a < 2020) return null;
  return `${aaaa}-${mm}-${dd}`;
}

async function main() {
  console.log(`\n📦 Importar Comprovantes Batch — empresa=${empresa}${DRY_RUN ? ' [DRY-RUN]' : ''}`);
  console.log(`   Pasta: ${PASTA}\n`);

  const db = getDb(empresa);

  // Garante coluna historico se não existir (migração segura)
  const cols = db.prepare('PRAGMA table_info(comprovantes_pagamento)').all().map(c => c.name);
  if (!cols.includes('competencia')) {
    // não cria coluna extra — usa observacao para competência
  }

  // Destino de upload
  const uploadDir = path.join(__dirname, '..', 'data', empresa, 'uploads', 'comprovantes');
  if (!DRY_RUN && !fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log('  📁 Criado diretório:', uploadDir);
  }

  // Lista PDFs
  const arquivos = fs.readdirSync(PASTA)
    .filter(f => /\.pdf$/i.test(f))
    .sort();

  console.log(`  Arquivos PDF encontrados: ${arquivos.length}\n`);

  // Statements
  const stmtDupHash  = db.prepare('SELECT id FROM comprovantes_pagamento WHERE arquivo_hash = ?');
  const stmtInsert   = db.prepare(`
    INSERT INTO comprovantes_pagamento
      (tipo, direcao, data_pagamento, valor, observacao,
       arquivo_path, arquivo_hash, arquivo_mimetype, arquivo_tamanho, status)
    VALUES (?, ?, ?, 0, ?, ?, ?, 'application/pdf', ?, 'PENDENTE')
  `);

  let inseridos = 0, duplicados = 0, erros = 0;
  const relatorio = [];

  for (const nome of arquivos) {
    const srcPath = path.join(PASTA, nome);
    let hash;
    try {
      hash = sha256File(srcPath);
    } catch (e) {
      console.error(`  ❌ Erro lendo ${nome}:`, e.message);
      erros++;
      relatorio.push({ nome, status: 'ERRO', detalhe: e.message });
      continue;
    }

    // Dedup por hash
    const dup = stmtDupHash.get(hash);
    if (dup) {
      duplicados++;
      relatorio.push({ nome, status: 'DUP', detalhe: `já existe id=${dup.id}` });
      continue;
    }

    const { tipo, direcao } = inferirTipoDirecao(nome);
    const dataNome = extrairDataNome(nome.replace(/\s*\(\d+\)/, '')); // remove sufixo " (N)"
    // Nota: dataNome é a data do PDF — mas pode ser data de download, não de pagamento
    // Deixamos como referência; o usuário pode corrigir pela UI

    const tamanho = fs.statSync(srcPath).size;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = nome.replace(/[^\w.\-()]/g, '_');
    const destName = `${ts}_${safeName}`;
    const destPath = path.join(uploadDir, destName);
    const relPath  = path.relative(path.join(__dirname, '..'), destPath).replace(/\\/g, '/');
    const obs      = `Importado batch MARÇO/2026 | arquivo: ${nome}`;
    // data_pagamento: se não extraída do nome, usa placeholder = último dia de março
    // (pode ser corrigido via UI ao vincular ao extrato real)
    const dataPag  = dataNome || '2026-03-31';

    if (!DRY_RUN) {
      fs.copyFileSync(srcPath, destPath);
      stmtInsert.run(tipo, direcao, dataPag, obs, relPath, hash, tamanho);
      inseridos++;
    } else {
      inseridos++;
    }
    relatorio.push({ nome, status: 'OK', tipo, direcao, data: dataNome });
  }

  // Sumário
  console.log(`  ✅ Inseridos : ${inseridos}`);
  console.log(`  ⏭️  Duplicados: ${duplicados}`);
  console.log(`  ❌ Erros     : ${erros}`);

  // Breakdown por tipo
  const porTipo = {};
  relatorio.filter(r => r.status === 'OK').forEach(r => {
    const k = `${r.tipo}/${r.direcao}`;
    porTipo[k] = (porTipo[k] || 0) + 1;
  });
  console.log('\n  Por tipo/direção:');
  Object.entries(porTipo).forEach(([k, v]) => console.log(`    ${k}: ${v}`));

  if (DRY_RUN) {
    console.log('\n  ⚠️  Modo DRY-RUN — nada foi gravado. Remova --dry-run para aplicar.');
    console.log('\n  Prévia (primeiros 10):');
    relatorio.slice(0, 10).forEach(r => console.log(`    [${r.status}] ${r.nome} → ${r.tipo||''}/${r.direcao||''} data=${r.data||'?'}`));
  }

  // Mostra duplicados (se houver)
  if (duplicados > 0) {
    console.log('\n  Duplicados encontrados (já estavam no banco):');
    relatorio.filter(r => r.status === 'DUP').forEach(r => console.log(`    ⏭️  ${r.nome} (${r.detalhe})`));
  }

  if (!DRY_RUN && inseridos > 0) {
    const total = db.prepare('SELECT COUNT(*) c FROM comprovantes_pagamento').get().c;
    console.log(`\n  Total comprovantes no banco (${empresa}): ${total}`);
  }

  console.log('\n✔️  Concluído.');
}

main().catch(e => { console.error('❌', e); process.exit(1); });
