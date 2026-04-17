'use strict';
/**
 * Conciliação Robusta (Sprint 2) — NF → Extrato via pagador_identificado.
 *
 * Diferente de conciliacao_seguranca.js / conciliacao_2025_2026.js:
 *   • Usa extratos.pagador_identificado (preenchido por identificar_pagador_extratos.js)
 *   • Janela dinâmica: cada pagador_alias tem janela_dias/tolerancia_pct próprios
 *   • 3 passes:
 *       P1 — Match 1:1 NF↔extrato (mesmo pagador, dentro da janela, |valor|≤tol)
 *       P2 — Match LOTE: soma de N NFs (mesmo pagador, mesmo mês/±1) ≈ 1 extrato
 *       P3 — Match LOTE reverso: 1 NF ≈ soma de N extratos (parcelas)
 *
 * Preserva status_conciliacao já populado ('ASSESSORIA', 'INTERNO', 'MANUAL').
 *
 * Uso:
 *   node scripts/conciliacao_robusta.js                       # dry-run ambas
 *   node scripts/conciliacao_robusta.js --apply
 *   node scripts/conciliacao_robusta.js --apply --empresa=seguranca
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const ARG = process.argv.slice(2);
const APLICAR = ARG.includes('--apply');
const empresaArg = (ARG.find(a => a.startsWith('--empresa=')) || '').split('=')[1];
const EMPRESAS = empresaArg ? [empresaArg] : ['assessoria', 'seguranca'];

const semAcento = s => (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();

function diffDias(iso1, iso2) {
  if (!iso1 || !iso2) return 9999;
  return Math.abs((new Date(iso1) - new Date(iso2)) / 86400000);
}

function processar(empresa) {
  console.log(`\n━━━━━━━━━ ${empresa.toUpperCase()} ━━━━━━━━━`);
  const db = getDb(empresa);

  // Pré-condição: tabela pagador_alias deve existir e estar populada
  const totAlias = db.prepare('SELECT COUNT(*) c FROM pagador_alias WHERE ativo=1').get().c;
  if (totAlias === 0) {
    console.log('  ⚠️  pagador_alias vazio — rode seed_pagador_alias.js --apply primeiro.');
    return;
  }

  // Carrega aliases indexados por nome_canonico
  const aliases = db.prepare('SELECT * FROM pagador_alias WHERE ativo=1').all();
  const aliasPorNome = new Map(aliases.map(a => [a.nome_canonico, a]));

  // Garante que identificar_pagador_extratos tenha sido rodado
  const extId = db.prepare(`
    SELECT COUNT(*) c FROM extratos
    WHERE pagador_identificado <> ''
  `).get().c;
  console.log(`  Extratos com pagador identificado: ${extId}`);
  if (extId === 0) {
    console.log('  ⚠️  Nenhum extrato identificado — rode identificar_pagador_extratos.js --apply primeiro.');
    return;
  }

  // ═══ P1 — Match 1:1 NF ↔ Extrato ═══
  console.log('\n  P1) Match 1:1 (NF ↔ extrato, mesmo pagador, janela/tolerância do alias)');

  // NFs pendentes (não CONCILIADO, não ASSESSORIA, não CANCELADA, com valor_liquido>0)
  const nfsPend = db.prepare(`
    SELECT id, numero, tomador, valor_liquido, data_emissao, competencia, contrato_ref, status_conciliacao
    FROM notas_fiscais
    WHERE COALESCE(status_conciliacao,'PENDENTE') IN ('PENDENTE','')
      AND valor_liquido > 0
      AND data_emissao <> ''
  `).all();

  // Extratos pendentes (credito>0, não conciliados ainda, com pagador identificado)
  const extPend = db.prepare(`
    SELECT id, data_iso, historico, credito, pagador_identificado, pagador_cnpj, status_conciliacao
    FROM extratos
    WHERE credito > 0
      AND COALESCE(status_conciliacao,'PENDENTE') IN ('PENDENTE','')
      AND pagador_identificado <> ''
  `).all();

  console.log(`     NFs pendentes: ${nfsPend.length} | Extratos pendentes com pagador: ${extPend.length}`);

  // Agrupa extratos por pagador para busca eficiente
  const extPorPagador = new Map();
  for (const e of extPend) {
    const k = e.pagador_identificado;
    if (!extPorPagador.has(k)) extPorPagador.set(k, []);
    extPorPagador.get(k).push(e);
  }

  const extUsados = new Set();
  const p1Matches = []; // {nf_id, ext_id}

  // Função: verifica se NF tomador "pertence" ao pagador_canonico
  // (heurística — o tomador da NF contém palavras do nome canônico ou vice-versa)
  function nfCasaComPagador(nf, alias) {
    const t = semAcento(nf.tomador);
    const n = semAcento(alias.nome_canonico);
    if (!t || !n) return false;
    // Extrai palavras significativas (≥4 chars, exceto stopwords)
    const STOP = new Set(['DO','DA','DE','DOS','DAS','DE','DO','E','UMA','PARA']);
    const palavras = n.split(/\s+/).filter(w => w.length >= 4 && !STOP.has(w));
    if (palavras.length === 0) return t.includes(n);
    // Pelo menos 1 palavra significativa do canônico presente no tomador
    return palavras.some(w => t.includes(w));
  }

  for (const nf of nfsPend) {
    // Descobre aliases cujo tomador casa com esta NF
    const candidatos = aliases.filter(a => nfCasaComPagador(nf, a));
    if (candidatos.length === 0) continue;

    // Para cada alias candidato, tenta achar extrato
    let achou = false;
    for (const alias of candidatos) {
      const lista = extPorPagador.get(alias.nome_canonico) || [];
      const tol = alias.tolerancia_pct || 0.05;
      const jan = alias.janela_dias || 90;

      for (const e of lista) {
        if (extUsados.has(e.id)) continue;
        const dias = diffDias(nf.data_emissao, e.data_iso);
        if (dias > jan) continue;
        // Extrato deve ser posterior (ou mesmo dia) à emissão
        if (new Date(e.data_iso) < new Date(nf.data_emissao)) continue;
        const diff = Math.abs(e.credito - nf.valor_liquido) / nf.valor_liquido;
        if (diff <= tol) {
          p1Matches.push({ nf_id: nf.id, ext_id: e.id, alias: alias.nome_canonico, diff_pct: diff });
          extUsados.add(e.id);
          achou = true;
          break;
        }
      }
      if (achou) break;
    }
  }
  console.log(`     → ${p1Matches.length} matches 1:1`);

  // ═══ P2 — Match LOTE (N NFs → 1 extrato) ═══
  console.log('\n  P2) Match LOTE (soma de N NFs do mesmo pagador no mês ≈ 1 extrato)');

  const nfUsadas = new Set(p1Matches.map(m => m.nf_id));
  const p2Matches = []; // {ext_id, nf_ids[], diff_pct}

  // Agrupa NFs restantes por (pagador_canonico, mês-emissão)
  const MES = d => d ? d.substring(0, 7) : null; // YYYY-MM
  const nfsPorGrupo = new Map();
  for (const nf of nfsPend) {
    if (nfUsadas.has(nf.id)) continue;
    const cands = aliases.filter(a => nfCasaComPagador(nf, a));
    if (cands.length === 0) continue;
    // Escolhe primeiro candidato (prioridade já ordenada)
    const alias = cands.sort((a,b)=>a.prioridade-b.prioridade)[0];
    const key = `${alias.nome_canonico}|${MES(nf.data_emissao)}`;
    if (!nfsPorGrupo.has(key)) nfsPorGrupo.set(key, { alias, nfs: [] });
    nfsPorGrupo.get(key).nfs.push(nf);
  }

  // Para cada extrato ainda não usado, tenta combinar NFs do mesmo grupo
  for (const e of extPend) {
    if (extUsados.has(e.id)) continue;
    const alias = aliasPorNome.get(e.pagador_identificado);
    if (!alias) continue;
    const tol = (alias.tolerancia_pct || 0.05) * 2; // lote um pouco mais tolerante
    const jan = alias.janela_dias || 90;
    const mesExt = MES(e.data_iso);

    // Tenta mês atual e dois anteriores
    const candidatosMes = [mesExt];
    const dm = new Date(mesExt + '-15');
    for (let i = 1; i <= 3; i++) {
      const d2 = new Date(dm); d2.setMonth(d2.getMonth() - i);
      candidatosMes.push(d2.toISOString().substring(0,7));
    }

    for (const m of candidatosMes) {
      const grupo = nfsPorGrupo.get(`${e.pagador_identificado}|${m}`);
      if (!grupo) continue;
      const disponiveis = grupo.nfs.filter(n => !nfUsadas.has(n.id) &&
        diffDias(n.data_emissao, e.data_iso) <= jan &&
        new Date(e.data_iso) >= new Date(n.data_emissao));
      if (disponiveis.length < 2) continue; // lote exige ≥2 NFs

      // Busca combinação gulosa: ordena por valor decrescente e soma até caber
      const ord = [...disponiveis].sort((a,b) => b.valor_liquido - a.valor_liquido);
      const usadas = [];
      let soma = 0;
      for (const nf of ord) {
        if (soma + nf.valor_liquido > e.credito * (1 + tol)) continue;
        usadas.push(nf);
        soma += nf.valor_liquido;
        if (Math.abs(e.credito - soma) / e.credito <= tol) break;
      }
      if (usadas.length >= 2 && Math.abs(e.credito - soma) / e.credito <= tol) {
        p2Matches.push({
          ext_id: e.id,
          nf_ids: usadas.map(n => n.id),
          diff_pct: Math.abs(e.credito - soma) / e.credito,
          soma, credito: e.credito, pagador: e.pagador_identificado
        });
        extUsados.add(e.id);
        usadas.forEach(n => nfUsadas.add(n.id));
        break;
      }
    }
  }
  console.log(`     → ${p2Matches.length} matches em lote (${p2Matches.reduce((s,m)=>s+m.nf_ids.length,0)} NFs agrupadas)`);

  // ═══ Estatísticas ═══
  const totalNfsConc = p1Matches.length + p2Matches.reduce((s,m)=>s+m.nf_ids.length,0);
  const totalExtConc = p1Matches.length + p2Matches.length;
  console.log(`\n  RESUMO:`);
  console.log(`     NFs conciliadas: ${totalNfsConc} / ${nfsPend.length} (${(100*totalNfsConc/nfsPend.length).toFixed(1)}%)`);
  console.log(`     Extratos conciliados: ${totalExtConc} / ${extPend.length} (${(100*totalExtConc/extPend.length).toFixed(1)}%)`);

  if (!APLICAR) {
    console.log(`\n  (dry-run) use --apply para gravar`);
    return;
  }

  // ═══ Aplicar ═══
  const updNf = db.prepare(`
    UPDATE notas_fiscais SET
      status_conciliacao = 'CONCILIADO',
      data_pagamento     = COALESCE((SELECT data_iso FROM extratos WHERE id = ?), data_pagamento),
      extrato_id         = ?
    WHERE id = ?
  `);
  const updExt = db.prepare(`
    UPDATE extratos SET status_conciliacao='CONCILIADO',
      obs = CASE WHEN obs='' THEN ? ELSE obs || ' | ' || ? END,
      updated_at = datetime('now')
    WHERE id = ?
  `);

  const trx = db.transaction(() => {
    for (const m of p1Matches) {
      updNf.run(m.ext_id, m.ext_id, m.nf_id);
      const tag = `robusto-1:1 NF:${m.nf_id}`;
      updExt.run(tag, tag, m.ext_id);
    }
    for (const m of p2Matches) {
      for (const nfId of m.nf_ids) updNf.run(m.ext_id, m.ext_id, nfId);
      const tag = `robusto-lote ${m.nf_ids.length} NFs:${m.nf_ids.join(',')}`;
      updExt.run(tag, tag, m.ext_id);
    }
  });
  trx();
  console.log(`  ✓ Aplicado: ${totalNfsConc} NFs + ${totalExtConc} extratos`);
}

console.log(`🧮 Conciliação Robusta — ${APLICAR ? 'APLICAR' : 'DRY-RUN'}`);
EMPRESAS.forEach(processar);
console.log('\n✔️  Concluído.');
