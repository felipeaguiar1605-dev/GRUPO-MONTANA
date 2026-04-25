/**
 * Relatório de Cobrança — NFs Pendentes 2026
 * Montana Assessoria Empresarial Ltda
 * Gerado automaticamente em: 2026-04-24
 */
const Database = require('better-sqlite3');
const xlsx    = require('xlsx');
const path    = require('path');

const db = new Database('data/assessoria/montana.db', { readonly: true });
const hoje = new Date().toLocaleDateString('pt-BR');
const mes_ref = '2026';

// ─── Busca NFs PENDENTE 2026 ──────────────────────────────────────────────────
const nfs = db.prepare(`
  SELECT
    numero, tomador, data_emissao, data_pagamento,
    valor_bruto, valor_liquido,
    (JULIANDAY('now') - JULIANDAY(data_emissao)) AS dias_vencido,
    status_conciliacao
  FROM notas_fiscais
  WHERE status_conciliacao = 'PENDENTE'
    AND data_emissao >= '2026-01-01'
  ORDER BY tomador, data_emissao
`).all();

db.close();

// ─── Mapa de nomes curtos por tomador ────────────────────────────────────────
function nomeContrato(tomador) {
  if (!tomador) return 'Desconhecido';
  const t = tomador.toUpperCase();
  if (t.includes('DETRAN'))                             return 'DETRAN 41/2023';
  if (t.includes('NORTE DO TOCANTINS') || t.includes('UFNT')) return 'UFNT 30/2022';
  if (t.includes('FUNDACAO UNIVERSIDADE') || t.includes('UFT')) return 'UFT 16/2025';
  if (t.includes('UNITINS') || t.includes('ESTADUAL DO TOCANTINS')) return 'UNITINS 022/2022';
  if (t.includes('SAUDE') || t.includes('SESAU'))       return 'SESAU 178/2022';
  if (t.includes('SEMARH') || t.includes('MEIO AMBIENTE')) return 'SEMARH 32/2024';
  if (t.includes('EDUCACAO') || t.includes('SEDUC'))    return 'SEDUC 016/2023';
  if (t.includes('PREVIDENCIA') || t.includes('PREVI')) return 'PREVI PALMAS 03/2024';
  return tomador.slice(0, 40);
}

function prioridade(dias) {
  if (dias > 60) return '🔴 CRÍTICO';
  if (dias > 30) return '🟠 ATRASADO';
  if (dias > 0)  return '🟡 VENCIDO';
  return '🟢 NO PRAZO';
}

// ─── Aba 1: Resumo por contrato ───────────────────────────────────────────────
const resumo = {};
nfs.forEach(n => {
  const key = nomeContrato(n.tomador);
  if (!resumo[key]) resumo[key] = { contrato: key, n: 0, bruto: 0, liquido: 0, mais_antigo: n.data_emissao };
  resumo[key].n++;
  resumo[key].bruto   += n.valor_bruto   || 0;
  resumo[key].liquido += n.valor_liquido || 0;
  if (n.data_emissao < resumo[key].mais_antigo) resumo[key].mais_antigo = n.data_emissao;
});

const resumoRows = Object.values(resumo)
  .sort((a, b) => b.liquido - a.liquido)
  .map(r => {
    const dias = Math.floor((Date.now() - new Date(r.mais_antigo)) / 86400000);
    return {
      'Contrato':          r.contrato,
      'Qtd NFs':           r.n,
      'NF mais antiga':    r.mais_antigo,
      'Dias em aberto':    dias,
      'Prioridade':        prioridade(dias),
      'Valor Bruto (R$)':  +r.bruto.toFixed(2),
      'Valor Líquido (R$)':+r.liquido.toFixed(2),
    };
  });

// Linha de totais
const totB = resumoRows.reduce((s, r) => s + r['Valor Bruto (R$)'], 0);
const totL = resumoRows.reduce((s, r) => s + r['Valor Líquido (R$)'], 0);
resumoRows.push({
  'Contrato': '⚑ TOTAL GERAL',
  'Qtd NFs':  resumoRows.reduce((s, r) => s + r['Qtd NFs'], 0),
  'NF mais antiga': '',
  'Dias em aberto': '',
  'Prioridade': '',
  'Valor Bruto (R$)':  +totB.toFixed(2),
  'Valor Líquido (R$)':+totL.toFixed(2),
});

// ─── Aba 2: Detalhamento NF a NF ─────────────────────────────────────────────
const detalheRows = nfs.map(n => ({
  'Contrato':           nomeContrato(n.tomador),
  'Tomador':            n.tomador,
  'NF':                 n.numero,
  'Emissão':            n.data_emissao,
  'Dias em aberto':     Math.floor(n.dias_vencido || 0),
  'Prioridade':         prioridade(Math.floor(n.dias_vencido || 0)),
  'Valor Bruto (R$)':   +(n.valor_bruto  || 0).toFixed(2),
  'Valor Líquido (R$)': +(n.valor_liquido|| 0).toFixed(2),
  'Status':             n.status_conciliacao,
}));

// ─── Aba 3: Extratos recebidos sem NF vinculada ───────────────────────────────
const db2 = new Database('data/assessoria/montana.db', { readonly: true });
const extPend = db2.prepare(`
  SELECT data_iso, credito, historico, banco
  FROM extratos
  WHERE banco IN ('BB','BRB') AND data_iso >= '2026-01-01'
    AND status_conciliacao = 'PENDENTE' AND credito IS NOT NULL AND credito > 500
  ORDER BY data_iso
`).all();
db2.close();

const extRows = extPend.map(e => ({
  'Banco':       e.banco,
  'Data':        e.data_iso,
  'Valor (R$)':  +e.credito.toFixed(2),
  'Histórico':   e.historico,
  'Ação':        'Vincular à NF correspondente',
}));
extRows.push({
  'Banco': '⚑ TOTAL',
  'Data': '',
  'Valor (R$)': +extPend.reduce((s,e)=>s+e.credito,0).toFixed(2),
  'Histórico': '',
  'Ação': '',
});

// ─── Montar workbook ──────────────────────────────────────────────────────────
const wb = xlsx.utils.book_new();

function addSheet(name, rows, colWidths) {
  const ws = xlsx.utils.json_to_sheet(rows);
  // Largura das colunas
  ws['!cols'] = colWidths.map(w => ({ wch: w }));
  xlsx.utils.book_append_sheet(wb, ws, name);
}

addSheet('Resumo por Contrato', resumoRows,
  [28, 10, 14, 14, 14, 20, 20]);

addSheet('Detalhamento NFs', detalheRows,
  [22, 40, 24, 12, 14, 14, 18, 18, 14]);

addSheet('Extratos sem NF', extRows,
  [8, 12, 16, 60, 32]);

// ─── Salvar ───────────────────────────────────────────────────────────────────
const outPath = path.join(
  'C:', 'Users', 'Avell', 'Downloads',
  `Relatorio_Cobranca_NFs_Pendentes_${mes_ref}_${new Date().toISOString().slice(0,10)}.xlsx`
);
xlsx.writeFile(wb, outPath);

console.log('✅ Relatório gerado:', outPath);
console.log('\n📊 Resumo:');
resumoRows.slice(0,-1).forEach(r =>
  console.log(
    ' ',(r['Contrato']||'').padEnd(22),
    String(r['Qtd NFs']).padStart(4)+'NFs',
    ('R$'+r['Valor Líquido (R$)'].toLocaleString('pt-BR',{minimumFractionDigits:2})).padStart(17),
    r['Prioridade']
  )
);
console.log('  '+'-'.repeat(65));
console.log('  TOTAL'.padEnd(28), resumoRows.at(-1)['Qtd NFs']+'NFs'.padStart(5),
  ('R$'+totL.toLocaleString('pt-BR',{minimumFractionDigits:2})).padStart(17));
