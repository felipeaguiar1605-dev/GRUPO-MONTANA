/**
 * Montana Assessoria — INSS Retido / S-1300
 * Apuração do INSS retido em NFs pelo tomador (art. 31 Lei 8.212/91)
 * Persiste valor DCTFWeb declarado em configuracoes.
 */
const express   = require('express');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

const MESES_ABREV = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];

function parseBothFormats(comp) {
  comp = (comp || '').trim().toLowerCase();

  if (/^\d{4}-\d{2}$/.test(comp)) {
    const [ano, mes] = comp.split('-').map(Number);
    const abrev = MESES_ABREV[mes - 1];
    if (!abrev) throw new Error(`Mês inválido: ${mes}`);
    const ano2d = String(ano).slice(2);
    return { novo: comp, antigo: `${abrev}/${ano2d}`, ano, mes, label: `${abrev}/${ano2d}` };
  }

  const m = comp.match(/^([a-z]{3})\/(\d{2})$/);
  if (m) {
    const mesIdx = MESES_ABREV.indexOf(m[1]);
    if (mesIdx === -1) throw new Error(`Mês inválido: ${m[1]}`);
    const mes = mesIdx + 1;
    const ano = 2000 + parseInt(m[2]);
    return {
      novo: `${ano}-${String(mes).padStart(2,'0')}`,
      antigo: comp,
      ano, mes,
      label: comp,
    };
  }

  throw new Error(`Formato de competência inválido: "${comp}". Use AAAA-MM ou mar/26`);
}

async function calcNFs(db, p) {
  const nfs = await db.prepare(`
    SELECT id, numero, data_emissao, competencia, tomador, cnpj_tomador,
           valor_bruto, inss, ir, iss, retencao, valor_liquido, status_conciliacao
    FROM notas_fiscais
    WHERE competencia = ? OR competencia = ?
    ORDER BY tomador, data_emissao, numero
  `).all(p.novo, p.antigo);

  let total_bruto = 0, total_inss = 0, total_esperado = 0;
  const tomadoresMap = {};

  const nfsProcessadas = nfs.map(nf => {
    const bruto    = +Number(nf.valor_bruto || 0).toFixed(2);
    const inss     = +Number(nf.inss         || 0).toFixed(2);
    const esperado = +Number(bruto * 0.11).toFixed(2);
    const pct      = bruto > 0 ? +Number(inss / bruto * 100).toFixed(2) : 0;

    let status = 'ok';
    if (inss === 0)                  status = 'sem_inss';
    else if (pct < 8)                status = 'baixo';
    else if (Math.abs(pct - 11) > 1) status = 'divergente';

    total_bruto    += bruto;
    total_inss     += inss;
    total_esperado += esperado;

    const tom = (nf.tomador || '').trim() || 'Sem tomador';
    if (!tomadoresMap[tom]) tomadoresMap[tom] = { tomador: tom, nfs: 0, bruto: 0, inss: 0 };
    tomadoresMap[tom].nfs++;
    tomadoresMap[tom].bruto += bruto;
    tomadoresMap[tom].inss  += inss;

    return {
      numero:               nf.numero,
      data_emissao:         nf.data_emissao,
      tomador:              nf.tomador,
      valor_bruto:          bruto,
      inss,
      inss_esperado_11pct:  esperado,
      pct,
      status,
    };
  });

  const rr = v => +Number(v).toFixed(2);

  const por_tomador = Object.values(tomadoresMap).map(t => ({
    tomador: t.tomador,
    nfs:     t.nfs,
    bruto:   rr(t.bruto),
    inss:    rr(t.inss),
    pct:     t.bruto > 0 ? +Number(t.inss / t.bruto * 100).toFixed(2) : 0,
  })).sort((a, b) => b.inss - a.inss);

  return {
    nfs:          nfsProcessadas,
    por_tomador,
    total_bruto:   rr(total_bruto),
    total_inss:    rr(total_inss),
    total_esperado: rr(total_esperado),
  };
}

// ── GET /api/inss-retido/competencias ────────────────────────────
router.get('/competencias', async (req, res) => {
  try {
    const db   = req.db;
    const rows = await db.prepare(`
      SELECT DISTINCT competencia, COUNT(*) cnt
      FROM notas_fiscais
      WHERE competencia IS NOT NULL AND competencia != ''
      GROUP BY competencia
    `).all();

    const seen   = new Set();
    const result = [];
    for (const r of rows) {
      try {
        const p = parseBothFormats(r.competencia);
        if (seen.has(p.novo)) continue;
        seen.add(p.novo);
        result.push({ value: p.novo, label: p.label, cnt: r.cnt });
      } catch (_) { /* pula formatos inválidos */ }
    }
    result.sort((a, b) => b.value.localeCompare(a.value));
    res.json({ ok: true, competencias: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/inss-retido/apuracao?competencia=2026-03 ────────────
router.get('/apuracao', async (req, res) => {
  try {
    const { competencia } = req.query;
    if (!competencia) return res.status(400).json({ error: 'Parâmetro competencia obrigatório' });

    const db = req.db;
    const p  = parseBothFormats(competencia);

    const cfgKey            = `inss_dctfweb_${p.novo}`;
    const cfgRow            = await db.prepare(`SELECT valor FROM configuracoes WHERE chave = ?`).get(cfgKey);
    const dctfweb_declarado = cfgRow ? parseFloat(cfgRow.valor) || 0 : 0;

    const { nfs, por_tomador, total_bruto, total_inss, total_esperado } = calcNFs(db, p);

    const gap = +Number(total_inss - dctfweb_declarado).toFixed(2);

    res.json({
      ok: true,
      competencia:     p.label,
      competencia_iso: p.novo,
      nfs,
      resumo: {
        total_nfs:                nfs.length,
        total_bruto,
        total_inss_declarado:     total_inss,
        total_inss_esperado_11pct: total_esperado,
        dctfweb_declarado,
        gap,
      },
      por_tomador,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/inss-retido/dctfweb ────────────────────────────────
// Body: { competencia: '2026-03', valor: 26377.75 }
router.post('/dctfweb', async (req, res) => {
  try {
    const { competencia, valor } = req.body;
    if (!competencia) return res.status(400).json({ error: 'competencia obrigatória' });

    const db = req.db;
    const p  = parseBothFormats(competencia);
    const v  = parseFloat(valor) || 0;

    await db.prepare(`
      INSERT INTO configuracoes (chave, valor, updated_at)
      VALUES (?, ?, datetime('now','localtime'))
    `).run(`inss_dctfweb_${p.novo}`, String(v));

    res.json({ ok: true, competencia: p.novo, valor: v });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/inss-retido/relatorio?competencia=2026-03 ───────────
router.get('/relatorio', async (req, res) => {
  try {
    const { competencia } = req.query;
    if (!competencia) return res.status(400).json({ error: 'competencia obrigatória' });

    const db = req.db;
    const p  = parseBothFormats(competencia);

    const cfgRow            = await db.prepare(`SELECT valor FROM configuracoes WHERE chave = ?`).get(`inss_dctfweb_${p.novo}`);
    const dctfweb_declarado = cfgRow ? parseFloat(cfgRow.valor) || 0 : 0;

    const { nfs, por_tomador, total_bruto, total_inss } = calcNFs(db, p);
    const rr = v => +Number(v).toFixed(2);

    res.json({
      ok:                true,
      gerado_em:         new Date().toLocaleString('pt-BR'),
      empresa:           'Montana Assessoria Empresarial Ltda',
      cnpj:              '14.092.519/0001-51',
      regime:            'Lucro Real',
      competencia:       p.label,
      competencia_iso:   p.novo,
      total_nfs:         nfs.length,
      total_bruto,
      total_inss,
      dctfweb_declarado,
      gap:               rr(total_inss - dctfweb_declarado),
      por_tomador,
      nfs,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
