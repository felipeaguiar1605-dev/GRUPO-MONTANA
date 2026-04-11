/**
 * CONCILIAÇÃO: Portal Transparência TO → Extratos Bancários
 *
 * Propósito: Marca extratos com créditos de órgãos governamentais como CONCILIADO,
 *            usando o Portal da Transparência do Tocantins como fonte de verdade.
 *
 * Como usar no futuro:
 *   1. Acesse https://transparencia.to.gov.br → Despesas → Consolidadas por Credor
 *   2. Filtre por CNPJ da empresa + ano + mês
 *   3. Atualize o objeto PORTAL_DATA abaixo com os novos meses
 *   4. Execute: node scripts/conciliacao_portal_transparencia.js
 *
 * Método de coleta do portal:
 *   - Portal: transparencia.to.gov.br → Despesas Consolidadas Detalhadas por Credor
 *   - Relatório > ⚙️ (x≈1414, y≈54) > Exercício + Mês + Código do Credor (CNPJ sem pontos)
 *   - Coluna "PAGO No Mês" = valor pago naquele mês
 *   - Vaadin FilterSelect: triple_click no campo → digitar abreviação do mês → clicar item
 *   - IMPORTANTE: esperar 1 segundo entre clicar no item e clicar Ok (timing Vaadin)
 *   - extractData() lê da PRIMEIRA grid do DOM (mais recente)
 *
 * Empresas:
 *   - Assessoria: CNPJ 14092519000151
 *   - Segurança:  CNPJ 19200109000109
 */

const Database = require('better-sqlite3');
const path = require('path');

// ============================================================
// DADOS DO PORTAL (atualizar mensalmente)
// ============================================================
const PORTAL_DATA = {
  Assessoria: {
    cnpj: '14092519000151',
    dbPath: path.join(__dirname, '../data/assessoria/montana.db'),
    pagamentos: {
      // Formato: 'YYYY-MM': valor_pago_no_mes
      '2025-01': 91412.72,
      '2025-02': 1796699.47,
      '2025-03': 2365546.53,
      '2025-04': 2312541.41,
      '2025-05': 3512888.09,
      '2025-06': 1468869.89,
      '2025-07': 3580765.57,
      '2025-08': 5510046.96,
      '2025-09': 3184816.16,
      '2025-10': 3336244.64,
      '2025-11': 3185361.44,
      '2025-12': 4352645.29,
      '2026-01': 0.00,
      '2026-02': 902238.22,
      '2026-03': 2210432.64,
      // Adicionar novos meses aqui:
      // '2026-04': XXXXX.XX,
    }
  },
  Seguranca: {
    cnpj: '19200109000109',
    dbPath: path.join(__dirname, '../data/seguranca/montana.db'),
    pagamentos: {
      '2025-01': 10062.02,
      '2025-02': 66646.95,
      '2025-03': 652311.87,
      '2025-04': 1590857.82,
      '2025-05': 1698775.46,
      '2025-06': 175582.03,
      '2025-07': 1157560.22,
      '2025-08': 795081.98,
      '2025-09': 2260459.99,
      '2025-10': 1225476.93,
      '2025-11': 1872329.44,
      '2025-12': 1641059.81,
      '2026-01': 25925.96,
      '2026-02': 1640331.42,
      '2026-03': 1459878.32,
      // Adicionar novos meses aqui:
    }
  }
};

// ============================================================
// KEYWORDS que identificam créditos de governo nos extratos
// ============================================================
const GOV_KEYWORDS = [
  'ESTADO DO TOCANTINS',
  'GOVERNO DO EST',
  'GOVERNO DO ESTADO',
  'DETRAN',
  'SEDUC',
  'TCE',        // Tribunal de Contas
  'CBMTO',      // Corpo de Bombeiros
  'UNITINS',
  'SEMARH',
  'SEMUS',      // Secretaria Municipal de Saúde
  'SEPLAD',
  'PREVI PALMAS',
  'MUNICIPIO DE PALMAS',
  'PREFEITURA',
  'FUNDACAO UNIVERSIDADE',  // UFT
  'UNIVERSIDADE FEDERAL',   // UFNT/UFT
  'SEC TES NAC',            // Secretaria do Tesouro Nacional
  'Ord Ban',                // Ordem Bancária (abreviado)
  'Ordem Banc',             // Ordem Bancária
  'MINISTERIO PUBLICO',
  'MINISTERIO DA',
  'S.PUBLICO PALMAS',       // Serviço Público Palmas
  'ORDENS BANCARIAS',
  'INSTITUTO DE PREVIDENC',
];

function buildWhereClause() {
  return GOV_KEYWORDS.map(k => `historico LIKE '%${k}%'`).join(' OR ');
}

// ============================================================
// EXECUÇÃO DA CONCILIAÇÃO
// ============================================================
function conciliarEmpresa(nome, config) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`CONCILIANDO: ${nome} (${config.cnpj})`);
  console.log('='.repeat(60));

  const db = new Database(config.dbPath);

  try {
    // 1. Ver estado atual
    const antes = db.prepare(`
      SELECT status_conciliacao, COUNT(*) as n, ROUND(SUM(credito),2) as total
      FROM extratos WHERE credito > 0
      GROUP BY status_conciliacao
    `).all();
    console.log('\nEstado ANTES:');
    antes.forEach(r => console.log(`  ${r.status_conciliacao}: ${r.n} extratos / R$${r.total?.toFixed(2)}`));

    // 2. Identificar extratos elegíveis (créditos governamentais PENDENTE)
    const whereGov = buildWhereClause();
    const elegiveis = db.prepare(`
      SELECT id, data_iso, credito, historico
      FROM extratos
      WHERE credito > 0
        AND status_conciliacao = 'PENDENTE'
        AND (${whereGov})
      ORDER BY data_iso
    `).all();

    console.log(`\nExtratos elegíveis para conciliação: ${elegiveis.length}`);

    // 3. Verificar por mês vs. portal
    const porMes = {};
    elegiveis.forEach(e => {
      const ym = e.data_iso ? e.data_iso.substring(0, 7) : 'unknown';
      if (!porMes[ym]) porMes[ym] = { n: 0, total: 0, ids: [] };
      porMes[ym].n++;
      porMes[ym].total += e.credito;
      porMes[ym].ids.push(e.id);
    });

    console.log('\nComparação por mês (DB vs Portal):');
    const mesesOrdenados = Object.keys(porMes).sort();
    mesesOrdenados.forEach(ym => {
      const db_val = porMes[ym].total;
      const portal_val = config.pagamentos[ym] || 0;
      const diff = db_val - portal_val;
      const pct = portal_val > 0 ? ((diff / portal_val) * 100).toFixed(1) : 'N/A';
      const flag = Math.abs(diff) > portal_val * 0.2 && portal_val > 0 ? '⚠️ ' : '✅ ';
      console.log(`  ${flag}${ym}: DB=R$${db_val.toFixed(0).padStart(12)} | Portal=R$${(portal_val||0).toFixed(0).padStart(12)} | diff=${diff > 0 ? '+' : ''}${diff.toFixed(0)} (${pct}%)`);
    });

    // 4. Executar atualização em transação
    const hoje = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const portalTotal = Object.values(config.pagamentos).reduce((a, b) => a + b, 0);

    const update = db.prepare(`
      UPDATE extratos
      SET status_conciliacao = 'CONCILIADO',
          obs = 'Conciliado via Portal Transparência TO em ${hoje}',
          updated_at = '${hoje}'
      WHERE id = ?
    `);

    const atualizarTudo = db.transaction((ids) => {
      let count = 0;
      ids.forEach(id => { update.run(id); count++; });
      return count;
    });

    const allIds = elegiveis.map(e => e.id);
    const atualizados = atualizarTudo(allIds);
    console.log(`\n✅ Marcados como CONCILIADO: ${atualizados} extratos`);

    // 5. Ver estado depois
    const depois = db.prepare(`
      SELECT status_conciliacao, COUNT(*) as n, ROUND(SUM(credito),2) as total
      FROM extratos WHERE credito > 0
      GROUP BY status_conciliacao
    `).all();
    console.log('\nEstado DEPOIS:');
    depois.forEach(r => console.log(`  ${r.status_conciliacao}: ${r.n} extratos / R$${r.total?.toFixed(2)}`));

    // 6. Resumo do portal
    const totalDbConciliado = elegiveis.reduce((a, e) => a + e.credito, 0);
    console.log(`\nTotal DB conciliado esta execução: R$${totalDbConciliado.toFixed(2)}`);
    console.log(`Total Portal (${Object.keys(config.pagamentos).length} meses): R$${portalTotal.toFixed(2)}`);

  } finally {
    db.close();
  }
}

// ============================================================
// MAIN
// ============================================================
console.log('CONCILIAÇÃO PORTAL TRANSPARÊNCIA TO → EXTRATOS BANCÁRIOS');
console.log(`Data: ${new Date().toLocaleString('pt-BR')}`);

Object.entries(PORTAL_DATA).forEach(([nome, config]) => {
  conciliarEmpresa(nome, config);
});

console.log('\n' + '='.repeat(60));
console.log('CONCILIAÇÃO CONCLUÍDA');
console.log('='.repeat(60));
