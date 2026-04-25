/**
 * Apuração PIS/COFINS Mensal — Multi-empresa
 *
 *   Montana Segurança  → Lucro Real Anual Cumulativo     (PIS 0,65% + COFINS 3,00%)  DARFs 8109/2172
 *   Montana Assessoria → Lucro Real Não-Cumulativo       (PIS 1,65% + COFINS 7,60%)  DARFs 6912/5856
 *   Demais (Simples)   → não aplicável (aba só mostra aviso)
 *
 * Base: Caixa a partir de jan/2026.
 * Regra de transição: NFs emitidas antes de 2026 já foram tributadas
 *   por competência — excluídas da base de cálculo.
 */
const express    = require('express');
const companyMw  = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

// ── Config por empresa ────────────────────────────────────────────
const REGIMES = {
  seguranca: {
    nome:       'Montana Segurança Privada Ltda',
    nome_curto: 'Montana Segurança',
    regime:     'Lucro Real Anual — Cumulativo',
    aliq_pis:    0.0065,
    aliq_cofins: 0.030,
    darf_pis:    '8109',
    darf_cofins: '2172',
    aplicavel:   true,
  },
  assessoria: {
    nome:       'Montana Assessoria Empresarial Ltda',
    nome_curto: 'Montana Assessoria',
    regime:     'Lucro Real — Não-Cumulativo',
    aliq_pis:    0.0165,
    aliq_cofins: 0.0760,
    darf_pis:    '6912',
    darf_cofins: '5856',
    aplicavel:   true,
  },
  portodovau: {
    nome: 'Porto do Vau Serviços Privados', nome_curto: 'Porto do Vau',
    regime: 'Simples Nacional', aliq_pis: 0, aliq_cofins: 0, darf_pis: '', darf_cofins: '',
    aplicavel: false,
  },
  mustang: {
    nome: 'Mustang G E Eireli', nome_curto: 'Mustang',
    regime: 'Simples Nacional', aliq_pis: 0, aliq_cofins: 0, darf_pis: '', darf_cofins: '',
    aplicavel: false,
  },
};
function regimeFor(companyKey) {
  return REGIMES[companyKey] || {
    nome: 'Empresa desconhecida', nome_curto: companyKey || '?',
    regime: 'Desconhecido', aliq_pis: 0, aliq_cofins: 0, darf_pis: '', darf_cofins: '',
    aplicavel: false,
  };
}

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

async function apurar(db, anoMes, companyKey) {
  const cfg = regimeFor(companyKey);
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
  const pis   = rr(base * cfg.aliq_pis);
  const cof   = rr(base * cfg.aliq_cofins);
  const total = rr(pis + cof);

  return {
    empresa: companyKey,
    empresa_nome: cfg.nome,
    empresa_nome_curto: cfg.nome_curto,
    regime: cfg.regime,
    aliq_pis: cfg.aliq_pis,
    aliq_cofins: cfg.aliq_cofins,
    aplicavel: cfg.aplicavel,
    ano_mes: anoMes, ano, mes,
    date_from: dateFrom, date_to: dateTo,
    base_tributavel: base,
    pis, cofins: cof, total_darf: total,
    darf_pis: cfg.darf_pis, darf_cofins: cfg.darf_cofins,
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
router.get('/:anomes', async (req, res) => {
  try {
    const { anomes } = req.params;
    if (!/^\d{4}-\d{2}$/.test(anomes)) {
      return res.status(400).json({ error: 'Use AAAA-MM (ex: 2026-03)' });
    }
    const cfg = regimeFor(req.companyKey);
    if (!cfg.aplicavel) {
      return res.json({
        ok: true,
        dados: {
          empresa: req.companyKey,
          empresa_nome: cfg.nome,
          empresa_nome_curto: cfg.nome_curto,
          regime: cfg.regime,
          aplicavel: false,
          aviso: `${cfg.nome_curto} é ${cfg.regime} — PIS/COFINS recolhidos no DAS unificado. Apuração separada não se aplica.`,
          ano_mes: anomes,
          base_tributavel: 0, pis: 0, cofins: 0, total_darf: 0,
          darf_pis: '', darf_cofins: '',
          aliq_pis: 0, aliq_cofins: 0,
          vencimento: '—',
          tributaveis: [], excluidos: [], nao_tributa: [], pendentes: [],
          resumo: { qtd_tributaveis:0, qtd_excluidos:0, qtd_nao_tributa:0, qtd_pendentes:0, tem_pendentes:false },
        }
      });
    }
    const dados = apurar(req.db, anomes, req.companyKey);
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
    const cfg = regimeFor(req.companyKey);
    if (!cfg.aplicavel) {
      return res.status(400).json({ error: `${cfg.nome_curto} é ${cfg.regime} — apuração separada não se aplica.` });
    }
    const d  = apurar(req.db, anomes, req.companyKey);
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

    const t1 = ws1.addRow([`APURAÇÃO PIS/COFINS — ${cfg.nome.toUpperCase()}`, '']);
    t1.getCell(1).font = { bold:true, size:13 };
    ws1.mergeCells(1,1,1,2);

    const t2 = ws1.addRow([`Competência: ${mesNome.toUpperCase()}  |  Regime: ${cfg.regime}`, '']);
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

    const pctPis = (cfg.aliq_pis*100).toLocaleString('pt-BR',{minimumFractionDigits:2});
    const pctCof = (cfg.aliq_cofins*100).toLocaleString('pt-BR',{minimumFractionDigits:2});
    addR('BASE DE CÁLCULO (créditos tributáveis no mês)', BRL(d.base_tributavel), true, BLU_FILL);
    addR(`PIS — ${pctPis}%  (DARF ${cfg.darf_pis})`,     BRL(d.pis),             false, GRN_FILL);
    addR(`COFINS — ${pctCof}%  (DARF ${cfg.darf_cofins})`, BRL(d.cofins),        false, GRN_FILL);
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

    const empSafe = (cfg.nome_curto || req.companyKey || 'empresa').replace(/[^A-Za-z0-9]+/g,'_');
    const filename = `Apuracao_PISCOFINS_${empSafe}_${anomes.replace('-','')}.xlsx`;
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
