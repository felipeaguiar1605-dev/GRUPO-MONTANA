/**
 * Montana Segurança — Apuração PIS/COFINS Mensal
 * Regime: Lucro Real Anual — Cumulativo (PIS 0,65% + COFINS 3,00%)
 * Base: Caixa a partir de jan/2026.
 * Regra de transição: NFs emitidas antes de 2026 já foram tributadas
 *   por competência — excluídas da base de cálculo.
 */
const express    = require('express');
const companyMw  = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

const ALIQ_PIS    = 0.0065;
const ALIQ_COFINS = 0.030;
const DARF_PIS    = '8109';
const DARF_COFINS = '2172';
const INICIO_CAIXA = '2026-01-01';

const NAO_TRIBUTA_KW = [
  'rende facil', 'rende fácil', 'rende-facil',
  'ted proprio', 'ted próprio',
  'transf interna', 'transferencia interna', 'transferência interna',
  'aplicação', 'aplicacao',
  'resgate',
  'brb invest',
  'poupança', 'poupanca',
  'montana assessoria', 'montana serviços', 'montana servicos',
  'estorno ted', 'dev ted',
];

function isNaoTributa(historico) {
  const h = (historico || '').toLowerCase();
  return NAO_TRIBUTA_KW.some(k => h.includes(k));
}

function calcVencimento(ano, mes) {
  const mesS = (mes % 12) + 1;
  const anoS = ano + (mes === 12 ? 1 : 0);
  const d    = new Date(anoS, mesS - 1, 25);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('pt-BR');
}

function apurar(db, anoMes) {
  const [ano, mes] = anoMes.split('-').map(Number);
  const dateFrom   = `${ano}-${String(mes).padStart(2,'0')}-01`;
  const dateTo     = `${ano}-${String(mes).padStart(2,'0')}-31`;

  const rows = db.prepare(`
    SELECT
      e.id, e.data_iso, e.historico, e.credito,
      e.pagador_identificado, e.pagador_cnpj,
      e.status_conciliacao, e.contrato_vinculado,
      nf.id            AS nf_id,
      nf.numero        AS nf_numero,
      nf.data_emissao,
      nf.competencia   AS nf_competencia,
      nf.tomador,
      nf.valor_bruto   AS nf_valor_bruto,
      nf.valor_liquido AS nf_valor_liquido
    FROM extratos e
    LEFT JOIN notas_fiscais nf ON nf.extrato_id = e.id
    WHERE e.data_iso >= ? AND e.data_iso <= ?
      AND e.credito > 0
    ORDER BY e.data_iso
  `).all(dateFrom, dateTo);

  const tributaveis = [], excluidos = [], naoTributa = [], pendentes = [];

  for (const r of rows) {
    // Período da NF: data_emissao (AAAA-MM-DD) ou competencia (AAAA-MM)
    const nfPeriodo = (r.data_emissao || r.nf_competencia || '').trim();

    if (r.nf_id) {
      if (nfPeriodo >= INICIO_CAIXA) tributaveis.push(r);
      else                           excluidos.push(r);
    } else if (isNaoTributa(r.historico)) {
      naoTributa.push(r);
    } else {
      pendentes.push(r);
    }
  }

  const rr    = v => +Number(v || 0).toFixed(2);
  const base  = rr(tributaveis.reduce((s, x) => s + (x.credito || 0), 0));
  const pis   = rr(base * ALIQ_PIS);
  const cof   = rr(base * ALIQ_COFINS);
  const total = rr(pis + cof);

  return {
    ano_mes: anoMes, ano, mes,
    date_from: dateFrom, date_to: dateTo,
    base_tributavel: base,
    pis, cofins: cof, total_darf: total,
    darf_pis: DARF_PIS, darf_cofins: DARF_COFINS,
    vencimento: calcVencimento(ano, mes),
    tributaveis, excluidos,
    nao_tributa: naoTributa, pendentes,
    resumo: {
      qtd_tributaveis: tributaveis.length,
      qtd_excluidos:   excluidos.length,
      qtd_nao_tributa: naoTributa.length,
      qtd_pendentes:   pendentes.length,
      tem_pendentes:   pendentes.length > 0,
    },
  };
}

// ── GET /api/piscofins-seguranca/:anomes ─────────────────────────
router.get('/:anomes', (req, res) => {
  try {
    const { anomes } = req.params;
    if (!/^\d{4}-\d{2}$/.test(anomes)) {
      return res.status(400).json({ error: 'Use AAAA-MM (ex: 2026-03)' });
    }
    const dados = apurar(req.db, anomes);
    res.json({ ok: true, dados });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/piscofins-seguranca/:anomes/excel ───────────────────
router.get('/:anomes/excel', async (req, res) => {
  try {
    const ExcelJS  = require('exceljs');
    const { anomes } = req.params;
    if (!/^\d{4}-\d{2}$/.test(anomes)) {
      return res.status(400).json({ error: 'Use AAAA-MM (ex: 2026-03)' });
    }
    const d  = apurar(req.db, anomes);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Montana';

    const HDR_FILL = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1E293B' } };
    const GRN_FILL = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFD1FAE5' } };
    const YEL_FILL = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFEF9C3' } };
    const RED_FILL = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFEE2E2' } };
    const GRY_FILL = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF1F5F9' } };
    const BLU_FILL = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFDBEAFE' } };

    const FMT     = 'R$ #,##0.00';
    const BRL     = v => `R$ ${(+(v||0)).toLocaleString('pt-BR',{minimumFractionDigits:2})}`;
    const THIN    = { style:'thin', color:{ argb:'FFCBD5E1' } };
    const BORDER  = { bottom: THIN };

    const meses = ['','janeiro','fevereiro','março','abril','maio','junho',
                   'julho','agosto','setembro','outubro','novembro','dezembro'];
    const mesNome = `${meses[d.mes]}/${d.ano}`;

    // ── Aba 1: Resumo Executivo ────────────────────────────────
    const ws1 = wb.addWorksheet('Resumo Executivo');
    ws1.getColumn(1).width = 44;
    ws1.getColumn(2).width = 26;

    const t1 = ws1.addRow(['APURAÇÃO PIS/COFINS — MONTANA SEGURANÇA PRIVADA LTDA', '']);
    t1.getCell(1).font = { bold:true, size:13 };
    ws1.mergeCells(1,1,1,2);

    const t2 = ws1.addRow([`Competência: ${mesNome.toUpperCase()}  |  Regime: Lucro Real Anual — Cumulativo`, '']);
    t2.getCell(1).font = { size:9, color:{ argb:'FF64748B' } };
    ws1.mergeCells(2,1,2,2);

    const t3 = ws1.addRow([`Base: Regime de Caixa — créditos recebidos em ${mesNome}`, '']);
    t3.getCell(1).font = { size:9, color:{ argb:'FF64748B' } };
    ws1.mergeCells(3,1,3,2);

    ws1.addRow([]);

    function addR(label, value, bold=false, fill=null) {
      const r = ws1.addRow([label, value]);
      [1,2].forEach(i => {
        r.getCell(i).font   = { bold, size:10 };
        r.getCell(i).border = BORDER;
        if (fill) r.getCell(i).fill = fill;
      });
    }

    addR('BASE DE CÁLCULO (créditos tributáveis no mês)', BRL(d.base_tributavel), true, BLU_FILL);
    addR(`PIS — 0,65%  (DARF ${DARF_PIS})`,              BRL(d.pis),             false, GRN_FILL);
    addR(`COFINS — 3,00%  (DARF ${DARF_COFINS})`,        BRL(d.cofins),          false, GRN_FILL);
    addR('TOTAL A RECOLHER (PIS + COFINS)',               BRL(d.total_darf),      true,  GRN_FILL);
    addR('VENCIMENTO DARF',                               d.vencimento,           true);
    ws1.addRow([]);
    addR('Qtd. créditos tributáveis',                    String(d.resumo.qtd_tributaveis));
    addR('Qtd. excluídos (NFs emitidas 2024/2025)',      String(d.resumo.qtd_excluidos));
    addR('Qtd. não tributáveis (internos/invest.)',       String(d.resumo.qtd_nao_tributa));
    addR('Qtd. PENDENTES (classificar no Portal)',        String(d.resumo.qtd_pendentes),
         false, d.resumo.tem_pendentes ? YEL_FILL : null);
    ws1.addRow([]);

    if (d.resumo.tem_pendentes) {
      const alert = ws1.addRow(['⚠ Há créditos sem NF vinculada. Veja a aba "Pendentes de Classificação".', '']);
      alert.getCell(1).font = { bold:true, color:{ argb:'FF92400E' }, size:10 };
      [1,2].forEach(i => alert.getCell(i).fill = YEL_FILL);
      ws1.mergeCells(alert.number, 1, alert.number, 2);
      ws1.addRow([]);
    }

    addR('Gerado em', new Date().toLocaleDateString('pt-BR'), false, GRY_FILL);

    // ── helper: aba de detalhe ─────────────────────────────────
    const MONEY_KEYS = new Set(['credito','nf_valor_bruto','nf_valor_liquido']);

    function addDetailSheet(name, rows, rowFill, cols) {
      const ws = wb.addWorksheet(name);
      cols.forEach(([, title, width], i) => {
        ws.getColumn(i+1).width = width;
        const c = ws.getCell(1, i+1);
        c.value     = title;
        c.font      = { bold:true, color:{ argb:'FFFFFFFF' }, size:10 };
        c.fill      = HDR_FILL;
        c.alignment = { horizontal:'center', vertical:'middle', wrapText:true };
      });
      ws.getRow(1).height = 28;
      ws.views = [{ state:'frozen', ySplit:1 }];

      rows.forEach(r => {
        const row = ws.addRow(cols.map(([k]) => {
          const v = r[k];
          return (v === null || v === undefined) ? '' : v;
        }));
        cols.forEach(([k], i) => {
          const cell = row.getCell(i+1);
          cell.fill   = rowFill;
          cell.border = BORDER;
          if (MONEY_KEYS.has(k)) {
            cell.value  = +(r[k] || 0);
            cell.numFmt = FMT;
          }
        });
      });
    }

    const DET_COLS = [
      ['data_iso',             'Data',            12],
      ['historico',            'Histórico',        40],
      ['pagador_identificado', 'Pagador',          26],
      ['credito',              'Valor Crédito',    15],
      ['nf_numero',            'NF Nº',            10],
      ['data_emissao',         'Data Emissão NF',  16],
      ['nf_competencia',       'Competência NF',   13],
      ['tomador',              'Tomador',          22],
      ['status_conciliacao',   'Status',           12],
    ];

    addDetailSheet('Créditos Tributáveis',        d.tributaveis,  GRN_FILL, DET_COLS);
    addDetailSheet('Excluídos (Exerc. Anterior)',  d.excluidos,    RED_FILL, DET_COLS);
    addDetailSheet('Não Tributa', d.nao_tributa, GRY_FILL, [
      ['data_iso',  'Data',          12],
      ['historico', 'Histórico',     52],
      ['credito',   'Valor Crédito', 15],
    ]);
    addDetailSheet('Pendentes de Classificação', d.pendentes, YEL_FILL, [
      ['data_iso',             'Data',          12],
      ['historico',            'Histórico',     42],
      ['pagador_identificado', 'Pagador',        26],
      ['credito',              'Valor Crédito', 15],
      ['status_conciliacao',   'Status',        12],
    ]);

    const filename = `Apuracao_PISCOFINS_Seguranca_${anomes.replace('-','')}.xlsx`;
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
