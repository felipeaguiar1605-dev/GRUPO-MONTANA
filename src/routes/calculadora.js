/**
 * Montana — Calculadora de Preço de Posto para Licitações
 * Calcula preço mensal/anual por tipo de posto de vigilância.
 */
const express = require('express');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

// ─── Cálculo central ─────────────────────────────────────────────
function calcularPosto(dados) {
  const sb  = parseFloat(dados.salario_base)             || 0;
  const ap  = parseFloat(dados.adicional_periculosidade) ?? sb * 0.30;
  const sal = sb + ap;

  // Encargos sobre salário total
  const feriasP  = parseFloat(dados.ferias)          || 11.11;
  const dec13P   = parseFloat(dados.decimo_terceiro) || 8.33;
  const fgtsP    = parseFloat(dados.fgts)            || 8.00;
  const inssP    = parseFloat(dados.inss_patronal)   || 28.80;

  const encFerias = sal * feriasP  / 100;
  const enc13     = sal * dec13P   / 100;
  const encFgts   = sal * fgtsP    / 100;
  const encInss   = sal * inssP    / 100;
  const totalEnc  = encFerias + enc13 + encFgts + encInss;

  // Insumos mensais por posto
  const insVT     = parseFloat(dados.vale_transporte)  || 0;
  const insVA     = parseFloat(dados.vale_alimentacao) || 0;
  const insSaude  = parseFloat(dados.plano_saude)      || 0;
  const insUnif   = parseFloat(dados.uniforme)         || 0;
  const insEquip  = parseFloat(dados.equipamento)      || 0;
  const insSeg    = parseFloat(dados.seguro)           || 0;
  const totalIns  = insVT + insVA + insSaude + insUnif + insEquip + insSeg;

  const custoDireto  = sal + totalEnc + totalIns;

  // Custos indiretos (BDI parcial)
  const ciPct       = parseFloat(dados.custos_indiretos_pct) || 10;
  const totalCI     = custoDireto * ciPct / 100;
  const subtotal    = custoDireto + totalCI;

  // Tributos + lucro sobre o preço final (BDI total)
  const tribPct     = parseFloat(dados.tributos_pct) || 8.65;
  const lucPct      = parseFloat(dados.lucro_pct)    || 8.00;
  const divisor     = 1 - (tribPct + lucPct) / 100;
  const precoMensal = divisor > 0.01 ? subtotal / divisor : subtotal * (1 + (tribPct + lucPct) / 100);
  const precoAnual  = precoMensal * 12;

  const totalTrib   = precoMensal * tribPct / 100;
  const totalLuc    = precoMensal * lucPct  / 100;

  const r = v => +v.toFixed(2);

  return {
    resumo: {
      salario_base: r(sb), adicional_periculosidade: r(ap), salario_total: r(sal),
      total_encargos: r(totalEnc), total_insumos: r(totalIns),
      custo_direto: r(custoDireto), custos_indiretos: r(totalCI),
      subtotal: r(subtotal), total_tributos: r(totalTrib), total_lucro: r(totalLuc),
      preco_mensal: r(precoMensal), preco_anual: r(precoAnual)
    },
    detalhamento: {
      encargos: {
        ferias: r(encFerias), decimo_terceiro: r(enc13), fgts: r(encFgts), inss_patronal: r(encInss),
        percentuais: { ferias: feriasP, decimo_terceiro: dec13P, fgts: fgtsP, inss_patronal: inssP }
      },
      insumos: {
        vale_transporte: insVT, vale_alimentacao: insVA, plano_saude: insSaude,
        uniforme: insUnif, equipamento: insEquip, seguro: insSeg
      },
      custos_indiretos: { percentual: ciPct, valor: r(totalCI) },
      tributos:         { percentual: tribPct, valor: r(totalTrib) },
      lucro:            { percentual: lucPct, valor: r(totalLuc) }
    }
  };
}

// POST /api/calculadora/calcular
router.post('/calcular', async (req, res) => {
  const resultado = calcularPosto(req.body);

  if (req.body.salvar && req.body.nome) {
    const r = await req.db.prepare(`
      INSERT INTO orcamentos_posto (nome,tipo_posto,salario_base,dados_json,preco_mensal,preco_anual)
      VALUES (@nome,@tipo_posto,@salario_base,@dados_json,@preco_mensal,@preco_anual)
    `).run({
      nome: req.body.nome, tipo_posto: req.body.tipo_posto || '',
      salario_base: parseFloat(req.body.salario_base) || 0,
      dados_json: JSON.stringify(req.body),
      preco_mensal: resultado.resumo.preco_mensal,
      preco_anual:  resultado.resumo.preco_anual
    });
    resultado.id_salvo = r.lastInsertRowid;
  }

  res.json(resultado);
});

// GET /api/calculadora/orcamentos
router.get('/orcamentos', async (req, res) => {
  const rows = await req.db.prepare(`
    SELECT id,nome,tipo_posto,salario_base,preco_mensal,preco_anual,created_at
    FROM orcamentos_posto ORDER BY created_at DESC
  `).all();
  res.json({ data: rows });
});

// GET /api/calculadora/orcamentos/:id
router.get('/orcamentos/:id', async (req, res) => {
  const row = await req.db.prepare(`SELECT * FROM orcamentos_posto WHERE id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Não encontrado' });
  try { row.dados = JSON.parse(row.dados_json); } catch(e) { row.dados = {}; }
  res.json(row);
});

// DELETE /api/calculadora/orcamentos/:id
router.delete('/orcamentos/:id', async (req, res) => {
  await req.db.prepare(`DELETE FROM orcamentos_posto WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// GET /api/calculadora/exportar/:id — Exportar Excel da planilha de custos
router.get('/exportar/:id', async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const row = await req.db.prepare(`SELECT * FROM orcamentos_posto WHERE id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Não encontrado' });

    let dados = {};
    try { dados = JSON.parse(row.dados_json); } catch(e) {}
    const d = calcularPosto(dados);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Montana Segurança';
    const ws = wb.addWorksheet('Planilha de Custos');
    ws.getColumn(1).width = 42;
    ws.getColumn(2).width = 22;

    const THIN = { style: 'thin', color: { argb: 'FFE2E8F0' } };
    const FMT  = 'R$ #,##0.00';

    function addLinha(label, valor, bold = false, bgColor = null) {
      const r = ws.addRow([label, valor]);
      r.getCell(1).font = { bold, size: 10 };
      r.getCell(2).font = { bold, size: 10 };
      if (typeof valor === 'number') { r.getCell(2).numFmt = FMT; }
      r.getCell(2).alignment = { horizontal: 'right' };
      [1, 2].forEach(i => { r.getCell(i).border = { bottom: THIN }; });
      if (bgColor) { [1, 2].forEach(i => { r.getCell(i).fill = { type:'pattern', pattern:'solid', fgColor:{ argb: bgColor } }; }); }
      return r;
    }
    function addSec(label, color) {
      const r = ws.addRow([label, '']);
      r.getCell(1).font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
      r.getCell(1).fill = { type:'pattern', pattern:'solid', fgColor:{ argb: color } };
      ws.mergeCells(r.number, 1, r.number, 2);
    }

    // Cabeçalho
    const titulo = ws.addRow(['PLANILHA DE CUSTO DE POSTO — ' + row.nome, '']);
    titulo.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF0F172A' } };
    ws.mergeCells(1, 1, 1, 2);
    const sub = ws.addRow(['Tipo: ' + (row.tipo_posto || '—') + '  |  Gerado em: ' + new Date().toLocaleDateString('pt-BR'), '']);
    sub.getCell(1).font = { size: 9, color: { argb: 'FF64748B' } };
    ws.mergeCells(2, 1, 2, 2);
    ws.addRow([]);

    addSec('SALÁRIO', 'FF1E40AF');
    addLinha('Salário Base (CCT)', d.resumo.salario_base);
    addLinha('Adicional de Periculosidade (30%)', d.resumo.adicional_periculosidade);
    addLinha('Salário Total', d.resumo.salario_total, true, 'FFE0F2FE');
    ws.addRow([]);

    addSec('ENCARGOS SOCIAIS', 'FF059669');
    addLinha(`Férias + 1/3 (${d.detalhamento.encargos.percentuais.ferias}%)`,   d.detalhamento.encargos.ferias);
    addLinha(`13° Salário (${d.detalhamento.encargos.percentuais.decimo_terceiro}%)`, d.detalhamento.encargos.decimo_terceiro);
    addLinha(`FGTS (${d.detalhamento.encargos.percentuais.fgts}%)`,              d.detalhamento.encargos.fgts);
    addLinha(`INSS Patronal (${d.detalhamento.encargos.percentuais.inss_patronal}%)`, d.detalhamento.encargos.inss_patronal);
    addLinha('Total Encargos', d.resumo.total_encargos, true, 'FFD1FAE5');
    ws.addRow([]);

    addSec('INSUMOS (por posto/mês)', 'FFD97706');
    addLinha('Vale Transporte',    d.detalhamento.insumos.vale_transporte);
    addLinha('Vale Alimentação',   d.detalhamento.insumos.vale_alimentacao);
    addLinha('Plano de Saúde',     d.detalhamento.insumos.plano_saude);
    addLinha('Uniforme',           d.detalhamento.insumos.uniforme);
    addLinha('Equipamento/EPI',    d.detalhamento.insumos.equipamento);
    addLinha('Seguro de Vida',     d.detalhamento.insumos.seguro);
    addLinha('Total Insumos',      d.resumo.total_insumos, true, 'FFFEF3C7');
    ws.addRow([]);

    addLinha('CUSTO DIRETO TOTAL', d.resumo.custo_direto, true, 'FFDBEAFE');
    addLinha(`Custos Indiretos (${d.detalhamento.custos_indiretos.percentual}%)`, d.resumo.custos_indiretos);
    addLinha(`Tributos (${d.detalhamento.tributos.percentual}%)`,                 d.resumo.total_tributos);
    addLinha(`Lucro Empresarial (${d.detalhamento.lucro.percentual}%)`,           d.resumo.total_lucro);
    ws.addRow([]);

    addLinha('PREÇO MENSAL DO POSTO (R$)',   d.resumo.preco_mensal, true, 'FF86EFAC');
    addLinha('PREÇO ANUAL DO POSTO (12 meses)', d.resumo.preco_anual, true, 'FF6EE7B7');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=planilha_posto_${row.id}.xlsx`);
    await wb.xlsx.write(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
