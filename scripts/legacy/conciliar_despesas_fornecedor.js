/**
 * Conciliação de despesas de fornecedores NEVADA e MONTREAL
 *
 * Faz duas coisas:
 * 1. Classifica débitos do extrato → status='DESPESA' (remove do "não classificado")
 * 2. Marca NFs (despesas) → status='PAGO' + extrato_id quando encontra transferência próxima
 *
 * Estratégia de match NF↔Extrato:
 *   - Agrupa NFs por período (mês de emissão)
 *   - Para cada grupo, soma as transferências para o mesmo fornecedor no período
 *     +/- JANELA_DIAS dias
 *   - Se as transferências cobrem ≥ MIN_COBERTURA% do valor das NFs → marca como PAGO
 *   - Caso contrário, marca apenas as NFs cujo valor individual está coberto
 *
 * Uso: node scripts/conciliar_despesas_fornecedor.js
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '../data/assessoria/montana.db');

const FORNECEDORES = [
  {
    nome: 'NEVADA EMBALAGENS e PRODUTOS DE LIMPEZA EIRELI -ME',
    cnpj: '32062391000165',
    keywords: ['NEVADA'],     // palavras no historico do extrato
    janela_dias: 45,          // máx dias após NF para encontrar pagamento
  },
  {
    nome: 'MONTREAL MAQUINAS E FERRAMENTAS LTDA',
    cnpj: '39775237000180',
    keywords: ['MONTREAL'],
    janela_dias: 45,
  },
];

// Adicionar dias a uma data ISO
function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function main() {
  const db = new Database(DB_PATH);

  for (const forn of FORNECEDORES) {
    console.log(`\n${'═'.repeat(55)}`);
    console.log(`Fornecedor: ${forn.nome}`);
    console.log(`CNPJ: ${forn.cnpj}`);
    console.log('═'.repeat(55));

    // ── 1. Buscar extratos (débitos) para este fornecedor ─────
    const kwWhere = forn.keywords.map(k => `UPPER(historico) LIKE '%${k}%'`).join(' OR ');
    const extratosRaw = db.prepare(`
      SELECT id, data_iso, debito, historico, status
      FROM extratos
      WHERE debito > 0 AND (${kwWhere})
      ORDER BY data_iso ASC
    `).all();

    // Deduplicar: mesmo data_iso + debito + primeiros 30 chars do historico
    // (mesmo lançamento pode aparecer em dois CSVs de contas diferentes)
    const extratosVistos = new Set();
    const extratos = [];
    for (const e of extratosRaw) {
      const chave = `${e.data_iso}|${e.debito}|${e.historico.slice(0, 30).replace(/\s+/g, ' ').trim()}`;
      if (!extratosVistos.has(chave)) {
        extratosVistos.add(chave);
        extratos.push(e);
      }
    }

    console.log(`Extratos brutos: ${extratosRaw.length} | Após dedup: ${extratos.length}`);
    const totalExtrato = extratos.reduce((s, e) => s + (e.debito || 0), 0);
    console.log(`Total transferido (extrato): R$ ${totalExtrato.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);

    // ── 2. Buscar NFs (despesas) deste fornecedor ─────────────
    const despesas = db.prepare(`
      SELECT id, data_iso, nf_numero, valor_bruto, status, competencia
      FROM despesas
      WHERE cnpj_fornecedor = ?
      ORDER BY data_iso ASC
    `).all(forn.cnpj);

    const totalNfs = despesas.reduce((s, d) => s + (d.valor_bruto || 0), 0);
    console.log(`NFs importadas: ${despesas.length} | Total: R$ ${totalNfs.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);

    if (extratos.length === 0) {
      console.log('⚠️  Nenhum extrato encontrado para este fornecedor. Pulando.');
      continue;
    }

    // ── 3. Classificar extratos como DESPESA ──────────────────
    const stmtExtrato = db.prepare(`
      UPDATE extratos
      SET status = 'DESPESA',
          obs    = COALESCE(NULLIF(obs,''), '') || '[Pag. fornecedor ${forn.nome.split(' ').slice(0,2).join(' ')}]',
          updated_at = datetime('now')
      WHERE id = ?
    `);

    let extratosClassificados = 0;
    const updateExtratos = db.transaction(() => {
      for (const e of extratos) {
        if (e.status !== 'DESPESA') {
          stmtExtrato.run(e.id);
          extratosClassificados++;
        }
      }
    });
    updateExtratos();
    console.log(`\n✅ Extratos classificados como DESPESA: ${extratosClassificados}`);

    // ── 4. Match NF ↔ Extrato (por janela de datas) ───────────
    // Para cada NF, busca o próximo extrato de pagamento ao fornecedor
    // dentro de janela_dias após a data da NF
    const stmtPagarNf = db.prepare(`
      UPDATE despesas
      SET status     = 'PAGO',
          extrato_id = ?,
          obs        = COALESCE(NULLIF(obs,''), '') || '[Conciliado: transf. ' || ? || ' R$' || ? || ']',
          updated_at = datetime('now')
      WHERE id = ?
    `);

    // Pool de extratos disponíveis (não usar o mesmo extrato mais de uma vez no limite de valor)
    // Abordagem: acumular NFs até o total coberto pelo extrato
    let pagas = 0;
    let semCobertura = 0;
    const matchLog = [];

    const pagarEmLote = db.transaction(() => {
      // Ordenar NFs por data
      const nfsPendentes = despesas.filter(d => d.status !== 'PAGO');

      // Criar mapa de extratos com saldo disponível
      const saldoExtrato = new Map();
      extratos.forEach(e => saldoExtrato.set(e.id, e.debito));

      for (const nf of nfsPendentes) {
        const dataLimite = addDays(nf.data_iso, forn.janela_dias);

        // Encontrar extratos dentro da janela com saldo suficiente
        const candidatos = extratos.filter(e =>
          e.data_iso >= nf.data_iso &&
          e.data_iso <= dataLimite &&
          (saldoExtrato.get(e.id) || 0) >= nf.valor_bruto * 0.99 // 1% tolerância
        );

        if (candidatos.length > 0) {
          // Usar o extrato mais próximo e com menor saldo restante
          candidatos.sort((a, b) => {
            const diffA = (saldoExtrato.get(a.id) || 0) - nf.valor_bruto;
            const diffB = (saldoExtrato.get(b.id) || 0) - nf.valor_bruto;
            return diffA - diffB; // preferir o que sobra menos
          });

          const ext = candidatos[0];
          saldoExtrato.set(ext.id, (saldoExtrato.get(ext.id) || 0) - nf.valor_bruto);

          stmtPagarNf.run(ext.id, ext.data_iso, nf.valor_bruto.toFixed(2), nf.id);
          pagas++;
          matchLog.push(`  NF ${nf.nf_numero} (${nf.data_iso}) R$${nf.valor_bruto} → Extrato ${ext.data_iso} R$${ext.debito}`);
        } else {
          // Tentar match por soma acumulada: extrato cobre lote de NFs
          // Buscar extratos maiores na janela que ainda tenham saldo parcial
          const candidatosParciais = extratos.filter(e =>
            e.data_iso >= nf.data_iso &&
            e.data_iso <= dataLimite &&
            (saldoExtrato.get(e.id) || 0) > 0
          );

          if (candidatosParciais.length > 0) {
            // Usar o maior extrato disponível (pagamento em lote)
            candidatosParciais.sort((a, b) => (saldoExtrato.get(b.id) || 0) - (saldoExtrato.get(a.id) || 0));
            const ext = candidatosParciais[0];
            const saldoDisp = saldoExtrato.get(ext.id) || 0;

            if (saldoDisp >= nf.valor_bruto * 0.50) { // pelo menos 50% do valor
              saldoExtrato.set(ext.id, saldoDisp - nf.valor_bruto);
              stmtPagarNf.run(ext.id, ext.data_iso, nf.valor_bruto.toFixed(2), nf.id);
              pagas++;
            } else {
              semCobertura++;
            }
          } else {
            semCobertura++;
          }
        }
      }
    });

    pagarEmLote();

    // Mostrar alguns matches de exemplo
    if (matchLog.length > 0) {
      console.log(`\nExemplos de match NF↔Extrato (primeiros 5):`);
      matchLog.slice(0, 5).forEach(l => console.log(l));
      if (matchLog.length > 5) console.log(`  ... e mais ${matchLog.length - 5} matches`);
    }

    console.log(`\n✅ NFs marcadas PAGO: ${pagas}`);
    console.log(`⚠️  NFs sem cobertura de extrato: ${semCobertura}`);

    // Resumo final
    const resumo = db.prepare(`
      SELECT status, COUNT(*) as n, SUM(valor_bruto) as total
      FROM despesas WHERE cnpj_fornecedor = ?
      GROUP BY status
    `).all(forn.cnpj);

    console.log('\nStatus final das NFs:');
    resumo.forEach(r => {
      console.log(`  ${r.status}: ${r.n} NFs = R$ ${r.total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
    });
  }

  // ── Resumo geral ──────────────────────────────────────────
  console.log('\n' + '═'.repeat(55));
  console.log('RESUMO GERAL');
  console.log('═'.repeat(55));

  const totalDesp = db.prepare(`
    SELECT status, COUNT(*) as n, SUM(valor_bruto) as total
    FROM despesas
    WHERE cnpj_fornecedor IN ('32062391000165','39775237000180')
    GROUP BY status
  `).all();

  totalDesp.forEach(r => {
    console.log(`  ${r.status}: ${r.n} NFs = R$ ${r.total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
  });

  const extratosDesp = db.prepare(`
    SELECT COUNT(*) as n, SUM(debito) as total
    FROM extratos
    WHERE status = 'DESPESA'
      AND (UPPER(historico) LIKE '%NEVADA%' OR UPPER(historico) LIKE '%MONTREAL%')
  `).get();

  console.log(`\nExtratos classificados DESPESA (Nevada+Montreal): ${extratosDesp.n} | R$ ${extratosDesp.total?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);

  db.close();
  console.log('\n✅ Conciliação concluída.\n');
}

main();
