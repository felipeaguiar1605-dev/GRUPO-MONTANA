/**
 * Conciliação Financeira Montana Assessoria — 2025/2026
 * 0. Remove NFs duplicadas (NF XXX vs 202600000000XXX)
 * 1. Normaliza tomadores duplicados
 * 2. Remove NFs erradas (Mustang/Segurança 2025-2026)
 * 3. Vincula boletins 2025-2026 → NFs (bol_boletins_nfs)
 * 4. Concilia NFs → extratos bancários (status_conciliacao)
 *
 * Uso: node scripts/conciliacao_2025_2026.js [--dry-run]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('../src/db');

const DRY_RUN = process.argv.includes('--dry-run');
const db = getDb('assessoria');

// ── Normaliza competência para formato "YYYY-MM" ──────────────────────────
const MESES_BR = {
  jan:'01',fev:'02',mar:'03',abr:'04',mai:'05',jun:'06',
  jul:'07',ago:'08',set:'09',out:'10',nov:'11',dez:'12'
};
function normComp(comp) {
  if (!comp) return null;
  const s = comp.trim().toLowerCase();
  // "fev/26" ou "jan/25"
  const m1 = s.match(/^([a-z]{3})\/(\d{2})$/);
  if (m1 && MESES_BR[m1[1]]) {
    const ano = parseInt(m1[2]) < 50 ? '20' + m1[2] : '19' + m1[2];
    return `${ano}-${MESES_BR[m1[1]]}`;
  }
  // "jan/2025" ou "fev/2026"
  const m2 = s.match(/^([a-z]{3})\/(\d{4})$/);
  if (m2 && MESES_BR[m2[1]]) return `${m2[2]}-${MESES_BR[m2[1]]}`;
  // "2025-01" ISO
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  // "01/2025"
  const m3 = s.match(/^(\d{2})\/(\d{4})$/);
  if (m3) return `${m3[2]}-${m3[1]}`;
  return null;
}

// ── 0. LIMPAR NFs DUPLICADAS (NF XXX vs webiss completo) ─────────────────
console.log('\n══════════════════════════════════════════════════');
console.log('0. LIMPEZA DE NFs DUPLICADAS');
console.log('══════════════════════════════════════════════════');

const nfsDup = db.prepare(`
  SELECT a.id, a.numero, a.valor_bruto, a.data_emissao, a.tomador
  FROM notas_fiscais a
  WHERE (a.numero LIKE 'NF %' OR (a.numero GLOB '[0-9][0-9][0-9]' OR a.numero GLOB '[0-9][0-9][0-9][0-9]'))
    AND a.data_emissao >= '2025-01-01'
    AND EXISTS (
      SELECT 1 FROM notas_fiscais b
      WHERE (b.numero LIKE '202500%' OR b.numero LIKE '202600%')
        AND b.valor_bruto = a.valor_bruto
        AND b.data_emissao = a.data_emissao
        AND b.tomador = a.tomador
    )
`).all();

console.log(`  Duplicadas encontradas: ${nfsDup.length}`);
nfsDup.slice(0, 5).forEach(r =>
  console.log(`  🗑️  id:${r.id} | ${r.numero} | R$${Number(r.valor_bruto).toLocaleString('pt-BR',{minimumFractionDigits:2})} | ${r.data_emissao}`)
);
if (nfsDup.length > 5) console.log(`  ... e mais ${nfsDup.length - 5}`);

if (!DRY_RUN) {
  for (const r of nfsDup) {
    db.prepare('DELETE FROM notas_fiscais WHERE id=?').run(r.id);
  }
  console.log(`  ✅ ${nfsDup.length} duplicadas removidas`);
}

// ── 1. NORMALIZAÇÃO DE TOMADORES ─────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════');
console.log('1. NORMALIZAÇÃO DE TOMADORES (2025-2026)');
console.log('══════════════════════════════════════════════════');

const normalizacoes = [
  // DETRAN — 3 variações → 1
  { de: 'DEPARTAMENTO ESTADUAL DE TRANSITO - DETRAN - TO',
    para: 'DEPARTAMENTO ESTADUAL DE TRANSITO - DETRAN/TO' },
  { de: 'DEPARTAMENTO ESTADUAL DE TRANSITO - DETRAN',
    para: 'DEPARTAMENTO ESTADUAL DE TRANSITO - DETRAN/TO' },
  { de: 'DEPARTAMENTO ESTADUAL DE TRANSITO',
    para: 'DEPARTAMENTO ESTADUAL DE TRANSITO - DETRAN/TO' },
  // UNITINS — remove ponto final
  { de: 'UNIVERSIDADE ESTADUAL DO TOCANTINS - UNITINS.',
    para: 'UNIVERSIDADE ESTADUAL DO TOCANTINS - UNITINS' },
  // PREVIPALMAS — 2 variações → 1
  { de: 'INSTITUTO DE PREVIDENCIA SOCIAL DO MUNICIPIO DE PALMAS - PRE',
    para: 'PREVIDENCIA SOCIAL DO MUNICIPIO DE PALMAS - PREVIPALMAS' },
  { de: 'INSTITUTO DE PREVIDENCIA SOCIAL DO MUNICIPIO DE PALMAS - PREVIPALMAS',
    para: 'PREVIDENCIA SOCIAL DO MUNICIPIO DE PALMAS - PREVIPALMAS' },
  // TJ — FUNJURIS normalizado
  { de: 'FUNDO ESPECIAL DE MODERNIZACAO E APRIMORAMENTO DO PODER JUDICIARIO - FUNJURIS-TO',
    para: 'FUNDO ESPECIAL DE MODERNIZACAO E APRIMORAMENTO DO PODER JUDICIARIO' },
  // SESAU — unificar nomes
  { de: 'TOCANTINS SECRETARIA DE ESTADO DE SAUDE',
    para: 'SECRETARIA DE ESTADO DA SAUDE DO TOCANTINS - SESAU' },
  { de: 'SECRETARIA DA SAUDE',
    para: 'SECRETARIA DE ESTADO DA SAUDE DO TOCANTINS - SESAU' },
];

for (const n of normalizacoes) {
  const cnt = db.prepare('SELECT COUNT(*) c FROM notas_fiscais WHERE tomador=? AND data_emissao>=?').get(n.de, '2025-01-01');
  if (cnt.c === 0) { console.log(`  ⏭️  Sem ocorrências: ${n.de.substring(0,60)}`); continue; }
  if (!DRY_RUN) {
    db.prepare('UPDATE notas_fiscais SET tomador=? WHERE tomador=? AND data_emissao>=?')
      .run(n.para, n.de, '2025-01-01');
  }
  console.log(`  ✅ ${cnt.c}x "${n.de.substring(0,50)}" → "${n.para.substring(0,50)}"`);
}

// ── 2. REMOVE NFs ERRADAS (Mustang/Segurança 2025-2026) ──────────────────
console.log('\n══════════════════════════════════════════════════');
console.log('2. REMOÇÃO DE NFs ERRADAS (2025-2026)');
console.log('══════════════════════════════════════════════════');

const erradas = db.prepare(`
  SELECT id, numero, tomador, valor_bruto, data_emissao
  FROM notas_fiscais
  WHERE data_emissao >= '2025-01-01'
    AND (tomador LIKE '%MUSTANG%' OR tomador LIKE '%SEGURANCA%' OR tomador LIKE '%SEGURANÇA%'
         OR tomador LIKE '%OHIO MED%')
`).all();

for (const nf of erradas) {
  console.log(`  🗑️  id:${nf.id} | nº:${nf.numero} | R$${nf.valor_bruto} | ${nf.data_emissao} | ${nf.tomador}`);
  if (!DRY_RUN) db.prepare('DELETE FROM notas_fiscais WHERE id=?').run(nf.id);
}
console.log(`  Total removidas: ${erradas.length}`);

// ── 3. MAPEAMENTO bol_contrato → tomadores ───────────────────────────────
const MAPA_CONTRATO_TOMADOR = {
  1:  { nomes: ['FUNDACAO UNIVERSIDADE FEDERAL DO TOCANTINS'],
        excluirDiscriminacao: ['motorista','motociclista','encarregado','tratorista'] },  // UFT limpeza
  2:  { nomes: ['DEPARTAMENTO ESTADUAL DE TRANSITO - DETRAN/TO'] },                       // DETRAN
  3:  { nomes: ['SECRETARIA DO MEIO AMBIENTE E RECURSOS HIDRICOS'] },                    // SEMARH
  4:  { nomes: ['PREVIDENCIA SOCIAL DO MUNICIPIO DE PALMAS - PREVIPALMAS'] },             // PREVI
  5:  { nomes: ['SECRETARIA DA EDUCACAO'] },                                               // SEDUC
  7:  { nomes: ['SECRETARIA DE ESTADO DA SAUDE DO TOCANTINS - SESAU'] },                  // SESAU
  8:  { nomes: ['UNIVERSIDADE FEDERAL DO NORTE DO TOCANTINS - UFNT'] },                   // UFNT
  9:  { nomes: ['FUNDACAO UNIVERSIDADE FEDERAL DO TOCANTINS'],
        incluirDiscriminacao: ['motorista','motociclista','encarregado','tratorista'] },    // UFT motorista
  10: { nomes: ['UNIVERSIDADE ESTADUAL DO TOCANTINS - UNITINS'] },                        // UNITINS
  6:  { nomes: ['TRIBUNAL DE CONTAS DO ESTADO DO TOCANTINS'] },                           // TCE
};

// ── 4. VINCULAÇÃO BOLETINS 2025-2026 → NFs ───────────────────────────────
console.log('\n══════════════════════════════════════════════════');
console.log('3. VINCULAÇÃO BOLETINS 2025-2026 → NFs');
console.log('══════════════════════════════════════════════════');

const boletins2526 = db.prepare(`
  SELECT b.*, bc.nome as contrato_nome
  FROM bol_boletins b
  JOIN bol_contratos bc ON bc.id = b.contrato_id
  WHERE b.competencia >= '2025-01'
  ORDER BY b.competencia, b.contrato_id
`).all();

// Limpa vínculos existentes de 2025-2026 para recalcular
if (!DRY_RUN) {
  db.prepare(`
    DELETE FROM bol_boletins_nfs
    WHERE boletim_id IN (
      SELECT id FROM bol_boletins WHERE competencia >= '2025-01'
    )
  `).run();
}

const insVinculo = db.prepare(`
  INSERT OR IGNORE INTO bol_boletins_nfs (boletim_id, posto_id, nf_numero, valor_total, arquivo_pdf)
  VALUES (?,?,?,?,?)
`);

const updBolStatus = db.prepare(`
  UPDATE bol_boletins SET status=? WHERE id=?
`);

// Carrega TODAS as NFs 2025+ em memória para matching por competência normalizada
const todasNfs2526 = db.prepare(`
  SELECT id, numero, webiss_numero_nfse, valor_bruto, valor_liquido,
         competencia, data_emissao, discriminacao, tomador, status_conciliacao
  FROM notas_fiscais
  WHERE data_emissao >= '2024-12-01'
    AND (status_conciliacao IS NULL OR status_conciliacao NOT IN ('CANCELADA'))
`).all();

// Indexa NFs por (tomador_normalizado + competencia_normalizada)
const nfsIndex = {};
for (const nf of todasNfs2526) {
  const comp = normComp(nf.competencia) || (nf.data_emissao ? nf.data_emissao.substring(0,7) : null);
  if (!comp) continue;
  const key = `${nf.tomador}|${comp}`;
  if (!nfsIndex[key]) nfsIndex[key] = [];
  nfsIndex[key].push({ ...nf, _comp_norm: comp });
}

let bolVinculados = 0, bolSemNF = 0;
const resumoBol = [];

for (const bol of boletins2526) {
  const mapa = MAPA_CONTRATO_TOMADOR[bol.contrato_id];
  if (!mapa) { bolSemNF++; continue; }

  const bolComp = bol.competencia; // "2025-01" format

  // Coleta NFs por todos os tomadores mapeados para este contrato
  let candidatas = [];
  for (const tomador of mapa.nomes) {
    const key = `${tomador}|${bolComp}`;
    if (nfsIndex[key]) candidatas.push(...nfsIndex[key]);
  }

  // Filtro por discriminação (UFT limpeza vs motorista)
  if (mapa.incluirDiscriminacao) {
    candidatas = candidatas.filter(nf =>
      nf.discriminacao &&
      mapa.incluirDiscriminacao.some(d => nf.discriminacao.toLowerCase().includes(d))
    );
  }
  if (mapa.excluirDiscriminacao) {
    candidatas = candidatas.filter(nf =>
      !nf.discriminacao ||
      mapa.excluirDiscriminacao.every(d => !nf.discriminacao.toLowerCase().includes(d))
    );
  }

  // Fallback: se não encontrou por competência, tenta por data_emissao no mês (para NFs sem competencia)
  if (candidatas.length === 0) {
    const [ano, mes] = bolComp.split('-');
    const mesStr = mes;
    for (const tomador of mapa.nomes) {
      for (const nf of todasNfs2526) {
        if (nf.tomador !== tomador) continue;
        const em = nf.data_emissao || '';
        if (!em.startsWith(`${ano}-${mesStr}`)) continue;
        // Aplica filtro discriminacao mesmo no fallback
        if (mapa.incluirDiscriminacao) {
          if (!nf.discriminacao || !mapa.incluirDiscriminacao.some(d => nf.discriminacao.toLowerCase().includes(d))) continue;
        }
        if (mapa.excluirDiscriminacao) {
          if (nf.discriminacao && !mapa.excluirDiscriminacao.every(d => !nf.discriminacao.toLowerCase().includes(d))) continue;
        }
        candidatas.push(nf);
      }
    }
    if (candidatas.length > 0) {
      // marca que veio do fallback
    }
  }

  if (candidatas.length === 0) {
    bolSemNF++;
    resumoBol.push({ bol: `${bol.competencia} ${bol.contrato_nome}`, status: '❌ Sem NF', soma: 0, esperado: bol.total_geral, nfs: 0 });
    if (!DRY_RUN) updBolStatus.run('sem_nf', bol.id);
    continue;
  }

  const somaValores = candidatas.reduce((s, nf) => s + (nf.valor_bruto || 0), 0);
  const esperado = bol.total_geral || 0;
  const diff = Math.abs(somaValores - esperado);
  const pct = esperado > 0 ? (diff / esperado) * 100 : 100;
  const match = pct < 5; // até 5% de tolerância

  if (!DRY_RUN) {
    for (const nf of candidatas) {
      insVinculo.run(bol.id, null, nf.numero || nf.webiss_numero_nfse, nf.valor_bruto, null);
    }
    updBolStatus.run(match ? 'conciliado_nf' : 'divergencia_nf', bol.id);
  }

  bolVinculados++;
  resumoBol.push({
    bol: `${bol.competencia} ${bol.contrato_nome.substring(0, 25)}`,
    status: match ? '✅ OK' : `⚠️  Diff ${pct.toFixed(1)}%`,
    nfs: candidatas.length,
    soma: somaValores,
    esperado
  });
}

for (const r of resumoBol) {
  const soma = r.soma ? 'R$' + Number(r.soma).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '—';
  const esp  = r.esperado ? 'R$' + Number(r.esperado).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '—';
  const nfsStr = String(r.nfs || 0).padStart(3);
  console.log(`  ${r.status.padEnd(15)} ${r.bol.padEnd(32)} NFs:${nfsStr} | ${soma.padStart(20)} (esperado ${esp})`);
}
console.log(`\n  Boletins vinculados: ${bolVinculados} | Sem NF: ${bolSemNF}`);

// ── 5. CONCILIAÇÃO NF → EXTRATO ───────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════');
console.log('4. CONCILIAÇÃO NFs 2025-2026 → EXTRATOS');
console.log('══════════════════════════════════════════════════');

// NFs de 2025-2026 ainda não conciliadas
const nfsPendentes = db.prepare(`
  SELECT id, numero, tomador, valor_bruto, valor_liquido, data_emissao, competencia
  FROM notas_fiscais
  WHERE data_emissao >= '2025-01-01'
    AND (status_conciliacao = 'PENDENTE' OR status_conciliacao IS NULL)
    AND valor_bruto > 100
  ORDER BY data_emissao
`).all();

const updNfStatus = db.prepare(`UPDATE notas_fiscais SET status_conciliacao='CONCILIADO' WHERE id=?`);
const updExtStatus = db.prepare(`UPDATE extratos SET status_conciliacao='CONCILIADO' WHERE id=?`);

// Carrega extratos créditos 2025+ em memória para matching eficiente
const extratosCred = db.prepare(`
  SELECT id, data_iso, credito, historico, banco, conta
  FROM extratos
  WHERE credito > 100
    AND data_iso >= '2025-01-01'
    AND (status_conciliacao IS NULL OR status_conciliacao = 'PENDENTE')
  ORDER BY data_iso
`).all();

// Set de extratos já usados (para não reusar)
const extratosUsados = new Set();

function buscarExtrato(nf) {
  const valor = nf.valor_liquido || nf.valor_bruto;
  const tol = Math.max(valor * 0.01, 10); // 1% ou mín R$10
  const dataBase = nf.data_emissao;
  if (!dataBase) return null;

  const dataBaseMs = new Date(dataBase).getTime();
  const janela60 = 60 * 24 * 60 * 60 * 1000;

  let melhor = null;
  let menorDiff = Infinity;

  for (const ext of extratosCred) {
    if (extratosUsados.has(ext.id)) continue;
    if (!ext.data_iso) continue;

    const extMs = new Date(ext.data_iso).getTime();
    if (extMs < dataBaseMs) continue; // crédito deve ser após emissão
    if (extMs > dataBaseMs + janela60) break; // ordenado por data, pode parar

    const diff = Math.abs(ext.credito - valor);
    if (diff <= tol && diff < menorDiff) {
      melhor = ext;
      menorDiff = diff;
    }
  }
  return melhor;
}

let conciliados = 0, semExtrato = 0;
const logConcil = [];

for (const nf of nfsPendentes) {
  const ext = buscarExtrato(nf);
  if (ext) {
    extratosUsados.add(ext.id);
    if (!DRY_RUN) {
      updNfStatus.run(nf.id);
      updExtStatus.run(ext.id);
    }
    conciliados++;
    if (logConcil.length < 30) {
      logConcil.push(`  ✅ NF ${nf.numero} R$${Number(nf.valor_liquido||nf.valor_bruto).toLocaleString('pt-BR',{minimumFractionDigits:2})} ↔ ${ext.data_iso} R$${Number(ext.credito).toLocaleString('pt-BR',{minimumFractionDigits:2})} [${ext.banco}]`);
    }
  } else {
    semExtrato++;
  }
}

logConcil.forEach(l => console.log(l));
if (conciliados > logConcil.length) {
  console.log(`  ... (mostrando ${logConcil.length} de ${conciliados} conciliados)`);
}
console.log(`\n  NFs conciliadas: ${conciliados} | Sem extrato correspondente: ${semExtrato}`);

// ── 6. RESUMO FINAL ────────────────────────────────────────────────────────
if (!DRY_RUN) {
  const totNfConc   = db.prepare("SELECT COUNT(*) n FROM notas_fiscais WHERE status_conciliacao='CONCILIADO' AND data_emissao>='2025-01-01'").get().n;
  const totNfPend   = db.prepare("SELECT COUNT(*) n FROM notas_fiscais WHERE status_conciliacao='PENDENTE'   AND data_emissao>='2025-01-01'").get().n;
  const totExtConc  = db.prepare("SELECT COUNT(*) n, SUM(credito) s FROM extratos WHERE status_conciliacao='CONCILIADO' AND data_iso>='2025-01-01'").get();
  const totBolConc  = db.prepare("SELECT COUNT(*) n FROM bol_boletins WHERE status='conciliado_nf' AND competencia>='2025-01'").get().n;
  const totBolDiv   = db.prepare("SELECT COUNT(*) n FROM bol_boletins WHERE status='divergencia_nf' AND competencia>='2025-01'").get().n;
  const totBolVinc  = db.prepare("SELECT COUNT(*) n FROM bol_boletins_nfs").get().n;

  console.log('\n══════════════════════════════════════════════════');
  console.log('✅ CONCILIAÇÃO CONCLUÍDA — RESUMO 2025-2026');
  console.log('══════════════════════════════════════════════════');
  console.log(`  NFs conciliadas:    ${totNfConc}  |  Pendentes: ${totNfPend}`);
  console.log(`  Extratos concil.:   ${totExtConc.n}  |  Total: R$${Number(totExtConc.s||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}`);
  console.log(`  Boletins c/ NF:     ${totBolConc} (OK) + ${totBolDiv} (divergência)`);
  console.log(`  Vínculos bol→NF:    ${totBolVinc}`);

  // Resumo por contrato
  console.log('\nResumo boletins 2025-2026 por contrato:');
  const bolRes = db.prepare(`
    SELECT bc.nome, b.status, COUNT(*) n
    FROM bol_boletins b
    JOIN bol_contratos bc ON bc.id = b.contrato_id
    WHERE b.competencia >= '2025-01'
    GROUP BY bc.nome, b.status
    ORDER BY bc.nome, b.status
  `).all();
  let lastNome = '';
  for (const r of bolRes) {
    if (r.nome !== lastNome) { console.log(`\n  ${r.nome}`); lastNome = r.nome; }
    console.log(`    ${r.status?.padEnd(20)} : ${r.n} boletins`);
  }
} else {
  console.log('\n⚠️  DRY RUN — banco não alterado');
}
