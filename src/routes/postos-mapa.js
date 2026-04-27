/**
 * Montana Multi-Empresa — Mapa de Postos Concomitantes
 *
 * Para a empresa atual (resolvida via X-Company), monta uma série mensal dos
 * últimos 60 meses contando quantos postos de serviço estavam ativos em cada
 * mês, agregando todos os contratos de boletim (bol_contratos / bol_postos).
 *
 * Período ativo de cada bol_contrato é derivado, em ordem de prioridade:
 *   1. Vigência cadastrada em `contratos` (joined por contrato_ref ou substring
 *      de numero_contrato).
 *   2. Mínimo / máximo de competência dos `bol_boletins` emitidos.
 *   3. Caso o contrato esteja marcado como ativo, considera o mês corrente.
 */
const express = require('express');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

const MESES_NUM = {
  janeiro: 1, fevereiro: 2, marco: 3, 'março': 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

function parseCompetencia(comp) {
  if (!comp) return null;
  const s = String(comp).trim().toLowerCase();
  let m = s.match(/^(\d{4})-(\d{1,2})/);
  if (m) {
    const ano = +m[1], mes = +m[2];
    if (ano >= 2000 && mes >= 1 && mes <= 12) return { ano, mes };
  }
  m = s.match(/^(\d{1,2})\/(\d{4})/);
  if (m) {
    const mes = +m[1], ano = +m[2];
    if (ano >= 2000 && mes >= 1 && mes <= 12) return { ano, mes };
  }
  const parts = s.split(/\s+/);
  if (parts.length >= 2) {
    const w = parts[0].normalize('NFD').replace(/[̀-ͯ]/g, '');
    const mes = MESES_NUM[w] || MESES_NUM[parts[0]];
    const ano = parseInt(parts[parts.length - 1], 10);
    if (mes && ano >= 2000) return { ano, mes };
  }
  return null;
}

function parseDateYM(d) {
  if (!d) return null;
  const s = String(d).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})/);
  if (m) {
    const ano = +m[1], mes = +m[2];
    if (ano >= 2000 && mes >= 1 && mes <= 12) return { ano, mes };
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const mes = +m[2], ano = +m[3];
    if (ano >= 2000 && mes >= 1 && mes <= 12) return { ano, mes };
  }
  return null;
}

const ymKey = (a, m) => `${a}-${String(m).padStart(2, '0')}`;
const ymLE  = (a, b) => a.ano < b.ano || (a.ano === b.ano && a.mes <= b.mes);

router.get('/', async (req, res) => {
  try {
    const db = req.db;

    const contratos = await db.prepare(`
      SELECT bc.id, bc.nome, bc.contratante, bc.numero_contrato,
             bc.contrato_ref, bc.empresa_razao, bc.empresa_cnpj, bc.ativo,
             (SELECT COUNT(*) FROM bol_postos p WHERE p.contrato_id = bc.id) AS qtd_postos
        FROM bol_contratos bc
       ORDER BY bc.nome
    `).all();

    let vigencias = [];
    try {
      vigencias = await db.prepare(`
        SELECT numContrato, vigencia_inicio, vigencia_fim
          FROM contratos
      `).all();
    } catch (_) { /* tabela contratos pode não existir nesta empresa */ }

    const vigByNum = new Map();
    for (const v of vigencias) {
      const key = String(v.numcontrato ?? v.numContrato ?? '').trim();
      if (key) vigByNum.set(key, v);
    }

    let boletins = [];
    try {
      boletins = await db.prepare(`
        SELECT contrato_id, competencia
          FROM bol_boletins
         WHERE competencia IS NOT NULL AND competencia <> ''
      `).all();
    } catch (_) {}

    const boletinsByContrato = new Map();
    for (const b of boletins) {
      const ym = parseCompetencia(b.competencia);
      if (!ym) continue;
      const arr = boletinsByContrato.get(b.contrato_id) || [];
      arr.push(ym);
      boletinsByContrato.set(b.contrato_id, arr);
    }

    const now = new Date();
    const endYM = { ano: now.getFullYear(), mes: now.getMonth() + 1 };
    let sa = endYM.ano, sm = endYM.mes - 59;
    while (sm <= 0) { sm += 12; sa -= 1; }
    const startYM = { ano: sa, mes: sm };

    const meses = [];
    {
      let a = startYM.ano, m = startYM.mes;
      while (a < endYM.ano || (a === endYM.ano && m <= endYM.mes)) {
        meses.push({ ano: a, mes: m, ym: ymKey(a, m), total: 0, contratos: [] });
        m += 1; if (m > 12) { m = 1; a += 1; }
      }
    }
    const mesesIdx = new Map(meses.map((x, i) => [x.ym, i]));

    const linhasContratos = [];
    for (const c of contratos) {
      const qtd = Number(c.qtd_postos) || 0;

      let vRow = vigByNum.get(String(c.contrato_ref || '').trim());
      if (!vRow) {
        const numDigits = String(c.numero_contrato || '').replace(/\D/g, '');
        if (numDigits.length >= 4) {
          for (const [k, v] of vigByNum) {
            if (String(k).replace(/\D/g, '').includes(numDigits)) { vRow = v; break; }
          }
        }
      }
      const vigIni = vRow ? parseDateYM(vRow.vigencia_inicio) : null;
      const vigFim = vRow ? parseDateYM(vRow.vigencia_fim)    : null;

      const bols = boletinsByContrato.get(c.id) || [];
      let bolMin = null, bolMax = null;
      for (const ym of bols) {
        if (!bolMin || ymLE(ym, bolMin)) bolMin = ym;
        if (!bolMax || ymLE(bolMax, ym)) bolMax = ym;
      }

      let actIni = vigIni && bolMin ? (ymLE(vigIni, bolMin) ? vigIni : bolMin) : (vigIni || bolMin);
      let actFim = vigFim && bolMax ? (ymLE(vigFim, bolMax) ? bolMax : vigFim) : (vigFim || bolMax);

      const ehAtivo = c.ativo === true || c.ativo === 't' || c.ativo === 1 || c.ativo === '1';
      if (!actIni && !actFim && ehAtivo) {
        actIni = endYM; actFim = endYM;
      }
      if (actIni && !actFim) actFim = ehAtivo ? endYM : actIni;
      if (!actIni && actFim) actIni = actFim;

      const linha = {
        id: c.id, nome: c.nome, contratante: c.contratante,
        numero_contrato: c.numero_contrato, qtd_postos: qtd,
        inicio: actIni ? ymKey(actIni.ano, actIni.mes) : null,
        fim:    actFim ? ymKey(actFim.ano, actFim.mes) : null,
        meses_ativos: 0, posto_meses: 0,
      };

      if (qtd > 0 && actIni && actFim) {
        let mIni = actIni, mFim = actFim;
        if (ymLE(mIni, startYM)) mIni = startYM;
        if (ymLE(endYM, mFim))   mFim = endYM;
        if (ymLE(mIni, mFim)) {
          let a = mIni.ano, m = mIni.mes;
          while (a < mFim.ano || (a === mFim.ano && m <= mFim.mes)) {
            const idx = mesesIdx.get(ymKey(a, m));
            if (idx != null) {
              meses[idx].total += qtd;
              meses[idx].contratos.push({ id: c.id, nome: c.nome, qtd_postos: qtd });
              linha.meses_ativos += 1;
            }
            m += 1; if (m > 12) { m = 1; a += 1; }
          }
          linha.posto_meses = linha.meses_ativos * qtd;
        }
      }

      linhasContratos.push(linha);
    }

    const totais = meses.map(m => m.total);
    const pico = totais.reduce((a, b) => Math.max(a, b), 0);
    const picoMes = meses.find(m => m.total === pico) || null;
    const mediaMensal = totais.length ? totais.reduce((a, b) => a + b, 0) / totais.length : 0;
    const ativosAgora = meses.length ? meses[meses.length - 1].total : 0;
    const ha60meses   = meses.length ? meses[0].total : 0;

    res.json({
      ok: true,
      empresa: {
        key: req.companyKey,
        nome: req.company?.nome || '',
        cnpj: req.company?.cnpj || '',
      },
      janela: {
        from: ymKey(startYM.ano, startYM.mes),
        to:   ymKey(endYM.ano,   endYM.mes),
      },
      meses,
      contratos: linhasContratos.sort((a, b) => b.posto_meses - a.posto_meses),
      kpis: {
        pico,
        pico_mes: picoMes ? picoMes.ym : null,
        media_mensal: Math.round(mediaMensal * 10) / 10,
        atual: ativosAgora,
        inicio_serie: ha60meses,
        contratos_no_periodo: linhasContratos.filter(l => l.meses_ativos > 0).length,
        contratos_cadastrados: linhasContratos.length,
      },
    });
  } catch (e) {
    console.error('[postos-mapa] erro:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
