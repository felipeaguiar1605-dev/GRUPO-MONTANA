'use strict';
/**
 * Importa CPFs a partir do PDF "Relação de Trabalhadores" (DEMONSTRATIVO DE
 * TRABALHADORES.pdf) emitido pela Caixa junto da guia FGTS.
 *
 * Origem: Montana_Docs/RH/<Mes>/Folhas/<Empresa_XXX>/DEMONSTRATIVO DE TRABALHADORES.pdf
 *
 * Estrutura de linha (separada por tabs no extract de pdf-parse):
 *   Mensal {base} {fgts} 0,00 0,00 {fgts} \t {dt_venc} \t {matricula} {cpf} 0,00 \t {comp} {NOME} {categoria}
 *
 * O script:
 *   1) Parseia todas linhas → lista {matricula, cpf, nome, base_remuneracao}
 *   2) Match por nome com rh_funcionarios (ignorando acentos/espaços)
 *   3) Atualiza rh_funcionarios.cpf quando casado
 *   4) Relatório: casados, não-casados, múltiplos matches
 *
 * Uso:
 *   node scripts/importar_cpfs_demonstrativo_fgts.js --pdf="caminho.pdf" --empresa=assessoria
 *   node scripts/importar_cpfs_demonstrativo_fgts.js --pdf="..." --empresa=assessoria --apply
 */
const path = require('path');
const fs = require('fs');
const { PDFParse } = require('pdf-parse');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const ARG = process.argv.slice(2);
const APPLY = ARG.includes('--apply');
const arg = (k, def = '') => (ARG.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || def;
const PDF = arg('pdf', '');
const EMPRESA = arg('empresa', 'assessoria');

if (!PDF) { console.error('❌ uso: --pdf="caminho.pdf" --empresa=assessoria [--apply]'); process.exit(1); }
if (!fs.existsSync(PDF)) { console.error('❌ PDF não encontrado:', PDF); process.exit(1); }

function normalizeName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function limparCpf(s) { return String(s || '').replace(/\D/g, ''); }

async function parsePdf(file) {
  const buf = fs.readFileSync(file);
  const parser = new PDFParse({ data: buf });
  const d = await parser.getText();
  const text = d.text;

  const trabalhadores = [];
  // Linha do trabalhador (tenta captura direta)
  // ex: Mensal 2.648,36 211,85 0,00 0,00 211,85	20/03/2026	00108023014 952.007.972-68 0,00	02/2026 ADRIANA ALMEIDA DA SILVA 101
  const re = /Mensal\s+([\d.,]+)\s+([\d.,]+)\s+[\d.,]+\s+[\d.,]+\s+[\d.,]+\s+\d{2}\/\d{2}\/\d{4}\s+(\S+)\s+(\d{3}\.\d{3}\.\d{3}-\d{2})\s+[\d.,]+\s+\d{2}\/\d{4}\s+(.+?)\s+\d{2,3}\s*$/gm;

  let m;
  while ((m = re.exec(text)) !== null) {
    const [, base, fgts, matricula, cpf, nome] = m;
    trabalhadores.push({
      matricula,
      cpf: limparCpf(cpf),
      cpf_fmt: cpf,
      nome: nome.trim(),
      nome_norm: normalizeName(nome),
      base_remuneracao: parseFloat(base.replace(/\./g, '').replace(',', '.')) || 0,
      valor_fgts: parseFloat(fgts.replace(/\./g, '').replace(',', '.')) || 0,
    });
  }
  return trabalhadores;
}

(async () => {
  console.log(`\n👥 Importando CPFs — ${APPLY ? '🔥 APPLY' : '💡 DRY-RUN'}`);
  console.log(`  Empresa: ${EMPRESA}`);
  console.log(`  PDF: ${PDF}\n`);

  const trabalhadores = await parsePdf(PDF);
  console.log(`  → ${trabalhadores.length} trabalhadores extraídos do PDF`);
  if (trabalhadores.length === 0) {
    console.log('  ⚠️  nenhum trabalhador reconhecido — regex pode precisar ajuste');
    return;
  }
  // amostra
  console.log('\n  Amostra (primeiros 3):');
  trabalhadores.slice(0, 3).forEach(t => console.log(`    ${t.cpf_fmt}  ${t.nome}  (base R$ ${t.base_remuneracao})`));

  const db = getDb(EMPRESA);
  const funcs = db.prepare(`SELECT id, nome, cpf FROM rh_funcionarios`).all();
  const byNorm = new Map();
  for (const f of funcs) {
    const key = normalizeName(f.nome);
    if (!byNorm.has(key)) byNorm.set(key, []);
    byNorm.get(key).push(f);
  }

  console.log(`\n  Funcionários no DB [${EMPRESA}]: ${funcs.length}  (${funcs.filter(f => f.cpf).length} já com CPF)`);

  let matchUnico = 0, matchMultiplo = 0, noMatch = 0, jaTinhaCpf = 0, jaMesmoCpf = 0;
  const atualizacoes = [];
  const semMatch = [];

  for (const t of trabalhadores) {
    const cand = byNorm.get(t.nome_norm) || [];
    if (cand.length === 0) { noMatch++; semMatch.push(t); continue; }
    if (cand.length > 1) { matchMultiplo++; continue; }
    const f = cand[0];
    if (f.cpf === t.cpf) { jaMesmoCpf++; continue; }
    if (f.cpf && f.cpf !== t.cpf) { jaTinhaCpf++; continue; }
    matchUnico++;
    atualizacoes.push({ id: f.id, cpf: t.cpf, nome: f.nome });
  }

  console.log(`\n  ═══ Resultado matching por nome ═══`);
  console.log(`    Match único (atualizar):  ${matchUnico}`);
  console.log(`    Match múltiplo (skip):    ${matchMultiplo}`);
  console.log(`    Já tinha mesmo CPF:       ${jaMesmoCpf}`);
  console.log(`    Já tinha CPF diferente:   ${jaTinhaCpf}`);
  console.log(`    Sem match no DB:          ${noMatch}`);

  if (semMatch.length && semMatch.length <= 20) {
    console.log('\n  ⚠️  Sem match (talvez nome não cadastrado ainda):');
    semMatch.slice(0, 20).forEach(t => console.log(`    ${t.cpf_fmt}  ${t.nome}`));
  } else if (semMatch.length > 20) {
    console.log(`\n  ⚠️  ${semMatch.length} sem match — primeiros 10:`);
    semMatch.slice(0, 10).forEach(t => console.log(`    ${t.cpf_fmt}  ${t.nome}`));
  }

  if (APPLY && atualizacoes.length) {
    const upd = db.prepare(`UPDATE rh_funcionarios SET cpf = ?, updated_at = datetime('now') WHERE id = ? AND (cpf IS NULL OR cpf = '')`);
    const trx = db.transaction(list => { for (const a of list) upd.run(a.cpf, a.id); });
    trx(atualizacoes);
    console.log(`\n  ✅ ${atualizacoes.length} CPFs gravados em rh_funcionarios`);
  } else if (!APPLY) {
    console.log('\n  💡 dry-run — use --apply para atualizar rh_funcionarios.cpf');
  }
})().catch(e => { console.error('❌', e); process.exit(1); });
