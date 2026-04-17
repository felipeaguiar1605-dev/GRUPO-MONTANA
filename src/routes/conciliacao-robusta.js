'use strict';
/**
 * Módulo Conciliação Robusta — backend (Sprint 3).
 *
 * Endpoints:
 *   GET  /api/conciliacao-robusta/status
 *   GET  /api/conciliacao-robusta/extratos-sem-nf?mes=YYYY-MM
 *   GET  /api/conciliacao-robusta/sugestoes?extrato_id=N
 *   POST /api/conciliacao-robusta/vincular   { extrato_id, nf_ids[] }
 *   POST /api/conciliacao-robusta/marcar-status { extrato_id, status, obs? }
 *   GET  /api/conciliacao-robusta/pagador-aliases
 *   POST /api/conciliacao-robusta/pagador-alias
 *   PUT  /api/conciliacao-robusta/pagador-alias/:id
 *   DELETE /api/conciliacao-robusta/pagador-alias/:id
 *   POST /api/conciliacao-robusta/reidentificar
 *   POST /api/conciliacao-robusta/reconciliar
 */
const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const path = require('path');
const { getDb } = require('../db');

// Helper que resolve empresa a partir do header X-Company
function getEmpresa(req, res) {
  const emp = req.headers['x-company'];
  if (!emp) { res.status(400).json({ error: 'X-Company header ausente' }); return null; }
  try { return { key: emp, db: getDb(emp) }; }
  catch (e) { res.status(400).json({ error: e.message }); return null; }
}

const semAcento = s => (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
const diffDias = (iso1, iso2) => {
  if (!iso1 || !iso2) return 9999;
  return Math.abs((new Date(iso1) - new Date(iso2)) / 86400000);
};

// ── GET /status ────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const e = getEmpresa(req, res); if (!e) return;
  try {
    const aliases = e.db.prepare('SELECT COUNT(*) c FROM pagador_alias WHERE ativo=1').get().c;
    const extIdent = e.db.prepare(`SELECT COUNT(*) c FROM extratos WHERE pagador_identificado<>''`).get().c;
    const extPend  = e.db.prepare(`SELECT COUNT(*) c FROM extratos WHERE credito>0 AND COALESCE(status_conciliacao,'PENDENTE')='PENDENTE'`).get().c;
    const extPendTot = e.db.prepare(`SELECT COALESCE(SUM(credito),0) t FROM extratos WHERE credito>0 AND COALESCE(status_conciliacao,'PENDENTE')='PENDENTE'`).get().t;
    const nfsPend  = e.db.prepare(`SELECT COUNT(*) c FROM notas_fiscais WHERE valor_liquido>0 AND COALESCE(status_conciliacao,'PENDENTE')='PENDENTE'`).get().c;
    res.json({
      ok: true,
      aliases_ativos: aliases,
      extratos_com_pagador: extIdent,
      extratos_pendentes: extPend,
      extratos_pendentes_valor: +extPendTot.toFixed(2),
      nfs_pendentes: nfsPend,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /extratos-sem-nf ───────────────────────────────────────
// Lista extratos PENDENTE agrupados por pagador. Filtros opcionais: mes, valor_min
router.get('/extratos-sem-nf', (req, res) => {
  const e = getEmpresa(req, res); if (!e) return;
  try {
    const mes       = req.query.mes || '';                  // 'YYYY-MM' ou ''
    const valorMin  = parseFloat(req.query.valor_min || 0);
    const pagador   = req.query.pagador || '';              // filtro por nome canônico

    const filtros = [`credito > 0`, `COALESCE(status_conciliacao,'PENDENTE') = 'PENDENTE'`];
    const params = [];
    if (valorMin > 0) filtros.push(`credito >= ${valorMin}`);
    if (mes)          { filtros.push(`substr(data_iso,1,7) = ?`); params.push(mes); }
    if (pagador)      { filtros.push(`pagador_identificado = ?`); params.push(pagador); }

    const sql = `
      SELECT id, data_iso, historico, credito,
             COALESCE(pagador_identificado,'') pagador,
             COALESCE(pagador_cnpj,'') cnpj,
             COALESCE(pagador_metodo,'') metodo
      FROM extratos
      WHERE ${filtros.join(' AND ')}
      ORDER BY data_iso DESC, credito DESC
      LIMIT 500
    `;
    const rows = e.db.prepare(sql).all(...params);

    // Agrupa por pagador (incluindo "(não identificado)")
    const grupos = {};
    for (const r of rows) {
      const k = r.pagador || '(não identificado)';
      if (!grupos[k]) grupos[k] = { pagador: k, extratos: [], total: 0 };
      grupos[k].extratos.push(r);
      grupos[k].total += r.credito;
    }
    const gruposArr = Object.values(grupos).sort((a,b) => b.total - a.total);
    gruposArr.forEach(g => g.total = +g.total.toFixed(2));

    res.json({ ok: true, total_linhas: rows.length, grupos: gruposArr });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /sugestoes?extrato_id=N ────────────────────────────────
// Sugere NFs candidatas para um extrato específico
router.get('/sugestoes', (req, res) => {
  const e = getEmpresa(req, res); if (!e) return;
  const extId = parseInt(req.query.extrato_id);
  if (!extId) return res.status(400).json({ error: 'extrato_id obrigatório' });

  try {
    const ext = e.db.prepare(`
      SELECT id, data_iso, historico, credito, pagador_identificado, pagador_cnpj
      FROM extratos WHERE id = ?
    `).get(extId);
    if (!ext) return res.status(404).json({ error: 'Extrato não encontrado' });

    // Alias correspondente (se identificado)
    let alias = null;
    if (ext.pagador_identificado) {
      alias = e.db.prepare('SELECT * FROM pagador_alias WHERE nome_canonico = ? AND ativo=1').get(ext.pagador_identificado);
    }
    const jan = (alias && alias.janela_dias) || 120;
    const tol = (alias && alias.tolerancia_pct) || 0.10;

    // NFs pendentes dentro da janela
    const dtMin = new Date(ext.data_iso); dtMin.setDate(dtMin.getDate() - jan);
    const isoMin = dtMin.toISOString().substring(0, 10);

    const nfs = e.db.prepare(`
      SELECT id, numero, tomador, valor_liquido, data_emissao, competencia, contrato_ref
      FROM notas_fiscais
      WHERE COALESCE(status_conciliacao,'PENDENTE') = 'PENDENTE'
        AND valor_liquido > 0
        AND data_emissao >= ? AND data_emissao <= ?
      ORDER BY data_emissao DESC
      LIMIT 2000
    `).all(isoMin, ext.data_iso);

    // Scoring
    const sugs = [];
    for (const nf of nfs) {
      let score = 0;
      const razoes = [];
      // 1) Match por tomador canônico
      if (alias) {
        const t = semAcento(nf.tomador);
        const n = semAcento(alias.nome_canonico);
        if (t.includes(n) || n.split(/\s+/).filter(w=>w.length>=4).some(w=>t.includes(w))) {
          score += 50; razoes.push('tomador-canônico');
        }
      }
      // 2) Match de valor
      const diffAbs = Math.abs(ext.credito - nf.valor_liquido);
      const diffPct = diffAbs / nf.valor_liquido;
      if (diffPct <= 0.005) { score += 40; razoes.push('valor-exato'); }
      else if (diffPct <= tol) { score += 25; razoes.push(`valor-aprox(${(diffPct*100).toFixed(1)}%)`); }
      // 3) Match como fração (soma parcial do lote)
      else if (nf.valor_liquido <= ext.credito * 1.02) { score += 5; razoes.push('candidato-lote'); }
      // 4) Proximidade temporal (pouco atraso)
      const dias = diffDias(nf.data_emissao, ext.data_iso);
      if (dias <= 30)      { score += 10; razoes.push('≤30d'); }
      else if (dias <= 60) { score += 5; }
      // 5) Tem discriminação
      if (nf.discriminacao && nf.discriminacao.length > 10) { score += 3; }

      if (score >= 30) {
        sugs.push({ ...nf, score, razoes, dias_atraso: Math.round(dias), diff_pct: +(diffPct*100).toFixed(2) });
      }
    }
    sugs.sort((a, b) => b.score - a.score);

    res.json({
      ok: true,
      extrato: ext,
      alias,
      janela_dias: jan,
      tolerancia_pct: tol,
      sugestoes_individuais: sugs.slice(0, 20),
      total_candidatos: sugs.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /vincular  { extrato_id, nf_ids[] } ───────────────────
router.post('/vincular', (req, res) => {
  const e = getEmpresa(req, res); if (!e) return;
  const { extrato_id, nf_ids } = req.body || {};
  if (!extrato_id || !Array.isArray(nf_ids) || nf_ids.length === 0) {
    return res.status(400).json({ error: 'extrato_id e nf_ids[] obrigatórios' });
  }
  try {
    const ext = e.db.prepare('SELECT id, data_iso, credito FROM extratos WHERE id = ?').get(extrato_id);
    if (!ext) return res.status(404).json({ error: 'Extrato não encontrado' });

    const updNf = e.db.prepare(`
      UPDATE notas_fiscais SET
        status_conciliacao='CONCILIADO',
        data_pagamento=?,
        extrato_id=?
      WHERE id = ?
    `);
    const updExt = e.db.prepare(`
      UPDATE extratos SET
        status_conciliacao='CONCILIADO',
        obs = CASE WHEN obs='' THEN ? ELSE obs || ' | ' || ? END,
        updated_at = datetime('now')
      WHERE id = ?
    `);

    const trx = e.db.transaction(() => {
      for (const nfId of nf_ids) updNf.run(ext.data_iso, ext.id, nfId);
      const tag = `manual NFs:${nf_ids.join(',')}`;
      updExt.run(tag, tag, ext.id);
    });
    trx();
    res.json({ ok: true, vinculadas: nf_ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /desvincular { extrato_id } ───────────────────────────
router.post('/desvincular', (req, res) => {
  const e = getEmpresa(req, res); if (!e) return;
  const { extrato_id } = req.body || {};
  if (!extrato_id) return res.status(400).json({ error: 'extrato_id obrigatório' });
  try {
    const trx = e.db.transaction(() => {
      e.db.prepare(`UPDATE notas_fiscais SET status_conciliacao='PENDENTE', data_pagamento='', extrato_id=NULL WHERE extrato_id = ?`).run(extrato_id);
      e.db.prepare(`UPDATE extratos SET status_conciliacao='PENDENTE', obs='' WHERE id = ?`).run(extrato_id);
    });
    trx();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /marcar-status { extrato_id, status, obs? } ───────────
const STATUS_OK = ['INTERNO','INVESTIMENTO','DEVOLVIDO','TRANSFERENCIA','IGNORAR','ASSESSORIA','SEGURANCA','PENDENTE'];
router.post('/marcar-status', (req, res) => {
  const e = getEmpresa(req, res); if (!e) return;
  const { extrato_id, status, obs } = req.body || {};
  if (!extrato_id || !status) return res.status(400).json({ error: 'extrato_id e status obrigatórios' });
  if (!STATUS_OK.includes(status)) return res.status(400).json({ error: `status deve ser um de: ${STATUS_OK.join(', ')}` });
  try {
    e.db.prepare(`UPDATE extratos SET status_conciliacao=?, obs=COALESCE(?, obs), updated_at=datetime('now') WHERE id=?`).run(status, obs || null, extrato_id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── CRUD pagador_alias ─────────────────────────────────────────
router.get('/pagador-aliases', (req, res) => {
  const e = getEmpresa(req, res); if (!e) return;
  try {
    const rows = e.db.prepare(`SELECT * FROM pagador_alias ORDER BY prioridade ASC, nome_canonico ASC`).all();
    res.json({ ok: true, aliases: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/pagador-alias', (req, res) => {
  const e = getEmpresa(req, res); if (!e) return;
  const b = req.body || {};
  if (!b.nome_canonico) return res.status(400).json({ error: 'nome_canonico obrigatório' });
  try {
    const r = e.db.prepare(`
      INSERT INTO pagador_alias
        (cnpj, cnpj_raiz, padrao_historico, nome_canonico, tomador_match,
         contrato_default, empresa_dono, janela_dias, tolerancia_pct, prioridade, obs, ativo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      b.cnpj || '', b.cnpj_raiz || '', b.padrao_historico || '',
      b.nome_canonico, b.tomador_match || '',
      b.contrato_default || '', b.empresa_dono || '',
      b.janela_dias || 90, b.tolerancia_pct || 0.05,
      b.prioridade || 100, b.obs || ''
    );
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/pagador-alias/:id', (req, res) => {
  const e = getEmpresa(req, res); if (!e) return;
  const id = parseInt(req.params.id);
  const b = req.body || {};
  try {
    const campos = ['cnpj','cnpj_raiz','padrao_historico','nome_canonico','tomador_match',
                    'contrato_default','empresa_dono','janela_dias','tolerancia_pct',
                    'prioridade','obs','ativo'];
    const sets = [], vals = [];
    for (const c of campos) {
      if (c in b) { sets.push(`${c} = ?`); vals.push(b[c]); }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    sets.push(`updated_at = datetime('now')`);
    vals.push(id);
    e.db.prepare(`UPDATE pagador_alias SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/pagador-alias/:id', (req, res) => {
  const e = getEmpresa(req, res); if (!e) return;
  const id = parseInt(req.params.id);
  try {
    e.db.prepare(`UPDATE pagador_alias SET ativo = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
    res.json({ ok: true, soft_delete: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Rodar scripts externos ─────────────────────────────────────
function rodarScript(scriptName, args, callback) {
  const script = path.join(__dirname, '..', '..', 'scripts', scriptName);
  const child = spawn(process.execPath, [script, ...args], {
    cwd: path.join(__dirname, '..', '..'),
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => stdout += d.toString());
  child.stderr.on('data', d => stderr += d.toString());
  child.on('close', code => callback(code, stdout, stderr));
}

router.post('/reidentificar', (req, res) => {
  const e = getEmpresa(req, res); if (!e) return;
  const args = ['--apply', `--empresa=${e.key}`];
  if (req.body && req.body.reprocessar) args.push('--reprocessar');
  rodarScript('identificar_pagador_extratos.js', args, (code, out, err) => {
    res.json({ ok: code === 0, code, stdout: out, stderr: err });
  });
});

router.post('/reconciliar', (req, res) => {
  const e = getEmpresa(req, res); if (!e) return;
  rodarScript('conciliacao_robusta.js', ['--apply', `--empresa=${e.key}`], (code, out, err) => {
    res.json({ ok: code === 0, code, stdout: out, stderr: err });
  });
});

router.post('/reseed-aliases', (req, res) => {
  const e = getEmpresa(req, res); if (!e) return;
  rodarScript('seed_pagador_alias.js', ['--apply', `--empresa=${e.key}`], (code, out, err) => {
    res.json({ ok: code === 0, code, stdout: out, stderr: err });
  });
});

module.exports = router;
