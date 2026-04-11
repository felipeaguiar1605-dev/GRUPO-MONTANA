/**
 * Montana — DRE (Demonstração do Resultado do Exercício)
 * Geração automática a partir dos dados de extratos, NFs e despesas.
 */
const express = require('express');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

// ─── Helpers ─────────────────────────────────────────────────────
function resolvePeriodo(query) {
  const { ano, mes, from, to } = query;
  if (from && to)   return { dateFrom: from, dateTo: to, periodo: `${from} a ${to}` };
  if (ano && mes)   return { dateFrom: `${ano}-${mes.padStart(2,'0')}-01`, dateTo: `${ano}-${mes.padStart(2,'0')}-31`, periodo: `${mes}/${ano}` };
  if (ano)          return { dateFrom: `${ano}-01-01`, dateTo: `${ano}-12-31`, periodo: String(ano) };
  const now = new Date();
  return { dateFrom: `${now.getFullYear()}-01-01`, dateTo: `${now.getFullYear()}-12-31`, periodo: String(now.getFullYear()) };
}

function buscarDRE(db, dateFrom, dateTo) {
  const p = { from: dateFrom, to: dateTo };

  // 1. Receita bruta = valor bruto das NFs emitidas no período (base competência)
  //    Exclui NFs canceladas. Fonte limpa: não contamina com transf. internas nem resgates.
  const receita = db.prepare(`
    SELECT COALESCE(SUM(valor_bruto),0) bruta,
           COUNT(*) qtd_nfs
    FROM notas_fiscais
    WHERE data_emissao>=@from AND data_emissao<=@to
  `).get(p);

  // 2. Retenções nas mesmas NFs (já filtradas pelo mesmo período)
  const ret = db.prepare(`
    SELECT COALESCE(SUM(inss),0) inss, COALESCE(SUM(ir),0) irrf,
           COALESCE(SUM(iss),0) iss,  COALESCE(SUM(csll),0) csll,
           COALESCE(SUM(pis),0) pis,  COALESCE(SUM(cofins),0) cofins,
           COALESCE(SUM(retencao),0) total_ret
    FROM notas_fiscais
    WHERE data_emissao>=@from AND data_emissao<=@to
  `).get(p);

  // 3. Despesas por categoria no período (UPPER para normalizar nomes)
  const desps = db.prepare(`
    SELECT UPPER(TRIM(categoria)) as categoria, COALESCE(SUM(valor_bruto),0) total
    FROM despesas WHERE data_iso>=@from AND data_iso<=@to GROUP BY UPPER(TRIM(categoria))
  `).all(p);

  const despMap = {};
  desps.forEach(d => { despMap[d.categoria] = d.total; });

  // Custo Direto dos Serviços (mão de obra + encargos + insumos operacionais)
  const despFolha    = (despMap['FOLHA'] || 0) + (despMap['FOLHA PGTO'] || 0) + (despMap['FOLHA DE PAGAMENTO'] || 0);
  const despFGTS     = (despMap['FGTS'] || 0);
  const despINSS     = (despMap['INSS'] || 0);
  const despMateriais= (despMap['MATERIAL LIMPEZA'] || 0) + (despMap['MAT. LIMPEZA'] || 0) + (despMap['MAT LIMPEZA'] || 0) + (despMap['MATERIAIS_LIMPEZA'] || 0);
  const despEPI      = (despMap['EPI/FERRAMENTAS'] || 0) + (despMap['EPI_FERRAMENTAS'] || 0) + (despMap['EPI'] || 0);
  const despServico  = (despMap['SERVICO'] || 0) + (despMap['SERVIÇO'] || 0);
  const custosCSP    = despFolha + despFGTS + despINSS + despMateriais + despEPI + despServico;
  const despTotal    = desps.reduce((s,d) => s+d.total, 0);
  const despOpOther  = despTotal - custosCSP;

  // 4. Comparativo mensal — NFs por mês de emissão
  const porMes = db.prepare(`
    SELECT substr(data_emissao,1,7) mes_ano,
           COALESCE(SUM(valor_bruto),0) receita,
           0 saidas
    FROM notas_fiscais
    WHERE data_emissao>=@from AND data_emissao<=@to
      AND data_emissao != ''
    GROUP BY substr(data_emissao,1,7) ORDER BY mes_ano
  `).all(p);

  // Adicionar saídas (despesas) ao comparativo mensal
  const despMes = db.prepare(`
    SELECT substr(data_iso,1,7) mes_ano, COALESCE(SUM(valor_bruto),0) saidas
    FROM despesas WHERE data_iso>=@from AND data_iso<=@to AND data_iso!=''
    GROUP BY substr(data_iso,1,7)
  `).all(p);
  const despMesMap = {};
  despMes.forEach(m => { despMesMap[m.mes_ano] = m.saidas; });
  porMes.forEach(m => { m.saidas = despMesMap[m.mes_ano] || 0; });

  const r = v => +v.toFixed(2);

  const recBruta    = receita.bruta;
  const totalRet    = ret.total_ret;
  const recLiq      = recBruta - totalRet;
  const lucroBruto  = recLiq - custosCSP;
  const resOperac   = lucroBruto - despOpOther;

  // PIS/COFINS próprios — Lucro Real não-cumulativo (regime de caixa)
  // Base: valor das NFs (competência) como aproximação; apuração exata na aba "Despesas → Apuração Caixa"
  // Crédito: retenções na fonte já sofridas nas mesmas NFs
  const pisProprioBruto    = r(recBruta * 0.0165);
  const cofinsPropriaBruta = r(recBruta * 0.076);
  const pisAPagar          = r(Math.max(pisProprioBruto - ret.pis, 0));
  const cofinsAPagar       = r(Math.max(cofinsPropriaBruta - ret.cofins, 0));
  const totalTributosProprios = r(pisAPagar + cofinsAPagar);
  const resultadoFinal     = r(resOperac - totalTributosProprios);

  return {
    dre: {
      receita_bruta:          r(recBruta),
      qtd_nfs:                receita.qtd_nfs,
      deducoes: {
        inss: r(ret.inss), irrf: r(ret.irrf), iss: r(ret.iss),
        csll: r(ret.csll), pis: r(ret.pis), cofins: r(ret.cofins),
        total: r(totalRet)
      },
      receita_liquida:         r(recLiq),
      custos: { folha: r(despFolha), fgts: r(despFGTS), inss: r(despINSS), materiais: r(despMateriais), epi: r(despEPI), servicos: r(despServico), total: r(custosCSP) },
      lucro_bruto:             r(lucroBruto),
      margem_bruta_pct: recLiq > 0 ? r((lucroBruto/recLiq)*100) : 0,
      despesas_operacionais:   r(despOpOther),
      resultado_operacional:   r(resOperac),
      tributos_proprios: {
        pis_bruto:    pisProprioBruto,
        cofins_bruta: cofinsPropriaBruta,
        pis_credito_fonte:    r(ret.pis),
        cofins_credito_fonte: r(ret.cofins),
        pis_a_pagar:   pisAPagar,
        cofins_a_pagar: cofinsAPagar,
        total:         totalTributosProprios,
        nota: 'Lucro Real não-cumulativo — PIS 1,65% + COFINS 7,6% sobre receita de caixa, deduzindo retenções na fonte já sofridas.'
      },
      resultado_liquido:      resultadoFinal,
      margem_liquida_pct: recBruta > 0 ? r((resultadoFinal/recBruta)*100) : 0
    },
    porMes,
    despesas_detalhe: desps
  };
}

// GET /api/dre
router.get('/', (req, res) => {
  const { dateFrom, dateTo, periodo } = resolvePeriodo(req.query);
  const dados = buscarDRE(req.db, dateFrom, dateTo);
  res.json({ periodo, ...dados });
});

// GET /api/dre/excel
router.get('/excel', async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const { dateFrom, dateTo, periodo } = resolvePeriodo(req.query);
    const { dre, despesas_detalhe } = buscarDRE(req.db, dateFrom, dateTo);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Montana';
    const ws = wb.addWorksheet('DRE');
    ws.getColumn(1).width = 48;
    ws.getColumn(2).width = 22;
    ws.getColumn(3).width = 12;

    const THIN = { style: 'thin', color: { argb: 'FFE2E8F0' } };
    const FMT  = 'R$ #,##0.00';

    function addDre(desc, valor, bold = false, bgColor = null, pct = null, negativo = false) {
      const v = negativo ? -Math.abs(valor) : valor;
      const r = ws.addRow([desc, v, pct !== null ? pct + '%' : '']);
      r.getCell(1).font = { bold, size: 10 };
      r.getCell(2).font = { bold, size: 10 };
      r.getCell(2).numFmt = FMT;
      r.getCell(2).alignment = { horizontal: 'right' };
      r.getCell(3).font = { size: 9, color: { argb: 'FF64748B' } };
      [1,2,3].forEach(i => { r.getCell(i).border = { bottom: THIN }; });
      if (bgColor) [1,2,3].forEach(i => { r.getCell(i).fill = { type:'pattern', pattern:'solid', fgColor:{ argb: bgColor } }; });
      return r;
    }

    // Título
    ws.addRow(['DRE — DEMONSTRAÇÃO DO RESULTADO DO EXERCÍCIO', '', ''])
      .getCell(1).font = { bold: true, size: 14 };
    ws.mergeCells(1,1,1,3);
    ws.addRow([req.company.nome + '  |  Período: ' + periodo, '', ''])
      .getCell(1).font = { size: 9, color: { argb: 'FF64748B' } };
    ws.mergeCells(2,1,2,3);
    ws.addRow([]);

    const rb = dre.receita_bruta;

    addDre('(+) RECEITA OPERACIONAL BRUTA',     rb,  true, 'FFDBEAFE', 100);
    addDre('  (-) INSS Retido',                 dre.deducoes.inss,   false, null, null, true);
    addDre('  (-) IRRF Retido',                 dre.deducoes.irrf,   false, null, null, true);
    addDre('  (-) ISS Retido',                  dre.deducoes.iss,    false, null, null, true);
    addDre('  (-) CSLL Retida',                 dre.deducoes.csll,   false, null, null, true);
    addDre('  (-) PIS Retido',                  dre.deducoes.pis,    false, null, null, true);
    addDre('  (-) COFINS Retida',               dre.deducoes.cofins, false, null, null, true);
    addDre('(=) RECEITA OPERACIONAL LÍQUIDA',   dre.receita_liquida, true, 'FFE0F2FE', rb>0?+((dre.receita_liquida/rb)*100).toFixed(1):0);
    ws.addRow([]);
    addDre('(-) CUSTO DOS SERVIÇOS PRESTADOS',  dre.custos.total,    true, 'FFFEF3C7', null, true);
    addDre('    Folha de Pagamento',             dre.custos.folha,    false, null, null, true);
    addDre('    Serviços Terceirizados',         dre.custos.servicos, false, null, null, true);
    addDre('(=) LUCRO BRUTO',                   dre.lucro_bruto,     true, 'FFD1FAE5', dre.margem_bruta_pct);
    ws.addRow([]);
    addDre('(-) DESPESAS OPERACIONAIS',         dre.despesas_operacionais, true, 'FFFEE2E2', null, true);
    ws.addRow([]);
    addDre('(=) RESULTADO OPERACIONAL',         dre.resultado_operacional, true, 'FFE2E8F0', null, false);
    ws.addRow([]);
    if (dre.tributos_proprios) {
      addDre('(-) PIS próprio (1,65%)',          dre.tributos_proprios.pis_a_pagar,    false, 'FFFEF9C3', null, true);
      addDre('(-) COFINS própria (7,6%)',         dre.tributos_proprios.cofins_a_pagar, false, 'FFFEF9C3', null, true);
      ws.addRow([]);
    }
    const resColor = dre.resultado_liquido >= 0 ? 'FF86EFAC' : 'FFFCA5A5';
    addDre('(=) RESULTADO LÍQUIDO', dre.resultado_liquido, true, resColor, dre.margem_liquida_pct);

    // 2ª aba: despesas por categoria
    const ws2 = wb.addWorksheet('Despesas por Categoria');
    ws2.columns = [{ header: 'Categoria', key: 'categoria', width: 25 }, { header: 'Total', key: 'total', width: 20 }];
    ws2.getRow(1).font = { bold: true }; ws2.getRow(1).fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1E293B' } };
    ws2.getRow(1).font = { bold: true, color:{ argb:'FFFFFFFF' } };
    despesas_detalhe.forEach(d => ws2.addRow(d));
    ws2.getColumn('total').numFmt = FMT;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=DRE_${periodo.replace(/[/\s]/g,'_')}.xlsx`);
    await wb.xlsx.write(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dre/pdf
router.get('/pdf', (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const { dateFrom, dateTo, periodo } = resolvePeriodo(req.query);
    const { dre } = buscarDRE(req.db, dateFrom, dateTo);
    const empresa = req.company;

    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=DRE_${periodo.replace(/[/\s]/g,'_')}.pdf`);
    doc.pipe(res);

    const brl = v => `R$ ${(+v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
    const W = 515;

    // Cabeçalho
    doc.rect(40, 40, W, 56).fill('#1e293b');
    doc.fillColor('#ffffff').fontSize(14).font('Helvetica-Bold')
       .text('DRE — DEMONSTRAÇÃO DO RESULTADO DO EXERCÍCIO', 50, 48, { width: W-20 });
    doc.fontSize(9).font('Helvetica')
       .text(`${empresa.nome}  |  CNPJ: ${empresa.cnpj}  |  Período: ${periodo}`, 50, 66);
    doc.fillColor('#000000');

    let y = 110;
    const linha = (desc, valor, bold=false, bg=null, pct=null, negativo=false) => {
      if (bg) doc.rect(40, y, W, 16).fill(bg);
      const v = negativo ? -Math.abs(valor||0) : (valor||0);
      doc.fillColor(bold ? '#0f172a' : '#334155').fontSize(bold ? 10 : 9)
         .font(bold ? 'Helvetica-Bold' : 'Helvetica')
         .text(desc, 44, y + 3);
      doc.text(brl(v), 44, y + 3, { align:'right', width: W - 8 });
      if (pct !== null) {
        doc.fillColor('#64748b').fontSize(8).font('Helvetica')
           .text(`${pct}%`, 44 + W - 55, y + 3);
      }
      doc.fillColor('#000000');
      y += 16;
    };
    const sep = () => { doc.rect(40, y, W, 1).fill('#e2e8f0'); y += 4; };

    linha('(+) RECEITA OPERACIONAL BRUTA',   dre.receita_bruta, true, '#dbeafe', 100);
    sep();
    linha('  (-) INSS Retido',               dre.deducoes.inss,   false, null, null, true);
    linha('  (-) IRRF Retido',               dre.deducoes.irrf,   false, null, null, true);
    linha('  (-) ISS Retido',                dre.deducoes.iss,    false, null, null, true);
    linha('  (-) CSLL Retida',               dre.deducoes.csll,   false, null, null, true);
    linha('  (-) PIS Retido',                dre.deducoes.pis,    false, null, null, true);
    linha('  (-) COFINS Retida',             dre.deducoes.cofins, false, null, null, true);
    sep();
    linha('(=) RECEITA OPERACIONAL LÍQUIDA', dre.receita_liquida, true, '#e0f2fe',
          dre.receita_bruta > 0 ? +((dre.receita_liquida/dre.receita_bruta)*100).toFixed(1) : 0);
    y += 6; sep();
    linha('(-) CUSTO DOS SERVIÇOS PRESTADOS',dre.custos.total,    true, '#fef3c7', null, true);
    linha('    Folha de Pagamento',          dre.custos.folha,    false, null, null, true);
    linha('    Serviços Terceirizados',      dre.custos.servicos, false, null, null, true);
    sep();
    linha('(=) LUCRO BRUTO',                dre.lucro_bruto,     true, '#d1fae5', dre.margem_bruta_pct);
    y += 6; sep();
    linha('(-) DESPESAS OPERACIONAIS',       dre.despesas_operacionais, true, '#fee2e2', null, true);
    sep();
    linha('(=) RESULTADO OPERACIONAL',       dre.resultado_operacional, true, '#f1f5f9');
    y += 6; sep();
    if (dre.tributos_proprios) {
      linha('(-) PIS próprio (1,65%)',        dre.tributos_proprios.pis_a_pagar,    false, '#fef9c3', null, true);
      linha('(-) COFINS própria (7,6%)',       dre.tributos_proprios.cofins_a_pagar, false, '#fef9c3', null, true);
      sep();
    }
    const resBg = dre.resultado_liquido >= 0 ? '#bbf7d0' : '#fecaca';
    linha('(=) RESULTADO LÍQUIDO',           dre.resultado_liquido, true, resBg, dre.margem_liquida_pct);

    // Rodapé
    doc.rect(40, 770, W, 1).fill('#e2e8f0');
    doc.fillColor('#94a3b8').fontSize(7)
       .text(`Gerado em ${new Date().toLocaleDateString('pt-BR')} pelo Montana Sistema`, 44, 774);

    doc.end();
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
