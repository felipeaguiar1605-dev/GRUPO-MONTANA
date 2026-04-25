/**
 * Montana — Comprovantes de Pagamento
 *
 * Endpoints para upload de comprovantes bancários (OB, TED, PIX, DOC, boletos, etc.)
 * e vinculação — TOTAL ou PARCIAL — a:
 *   - Notas Fiscais (ENTRADA: tomador pagando Montana)
 *   - Despesas (SAIDA: Montana pagando fornecedor)
 *   - Créditos contratuais (ordem bancária em contrato de tomador)
 *
 * Segurança multi-empresa:
 *   - Todo comprovante pertence a UMA empresa (via X-Company)
 *   - Upload valida CNPJ do pagador contra `companies[empresa].cnpjRaw`
 *   - Sugestões de matches NÃO cruzam empresas (outra DB, outra tabela)
 *   - Se CNPJ_pagador bate com padroesBloqueados de outra empresa → rejeita
 */
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const companyMw = require('../companyMiddleware');
const { COMPANIES } = require('../db');
const { recalcularNF } = require('../status-nf');

const router = express.Router();
router.use(companyMw);

// ── Upload dir por empresa ────────────────────────────────────────
function uploadDir(companyKey) {
  const base = path.join(__dirname, '..', '..', 'data', companyKey, 'uploads', 'comprovantes');
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  return base;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir(req.companyKey)),
  filename: (req, file, cb) => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = (file.originalname || 'comprovante').replace(/[^\w.\-]/g, '_');
    cb(null, `${ts}_${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const ok = /\.(pdf|png|jpe?g|gif|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('Extensão não permitida (aceita PDF/PNG/JPG/GIF/WEBP)'), ok);
  },
});

// ── Helpers ───────────────────────────────────────────────────────
function digitsOnly(s) { return String(s || '').replace(/\D/g, ''); }

function sha256File(abs) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(abs));
  return h.digest('hex');
}

// Retorna erro se CNPJ pagador parece ser DE OUTRA EMPRESA do grupo
function validarCnpjPagador(cnpj, companyKey) {
  const d = digitsOnly(cnpj);
  if (!d) return null; // opcional
  // Verifica se bate com empresa ativa
  const own = COMPANIES[companyKey];
  if (own.cnpjRaw === d) return null;
  // Verifica se bate com OUTRA empresa do grupo
  for (const [k, c] of Object.entries(COMPANIES)) {
    if (k !== companyKey && c.cnpjRaw === d) {
      return `CNPJ pagador ${cnpj} pertence a "${c.nome}". Mude para a empresa correta via seletor.`;
    }
  }
  // CNPJ externo (ex: prestador) — OK, só avisa
  return null;
}

// Atualiza valor_vinculado e status do comprovante
function recomputarStatus(db, comprovanteId) {
  const cp = db.prepare('SELECT valor FROM comprovantes_pagamento WHERE id = ?').get(comprovanteId);
  if (!cp) return;
  const { soma } = db.prepare('SELECT COALESCE(SUM(valor_vinculado),0) soma FROM comprovante_vinculos WHERE comprovante_id = ?').get(comprovanteId);
  let status = 'PENDENTE';
  if (soma >= cp.valor - 0.01) status = 'TOTAL';
  else if (soma > 0) status = 'PARCIAL';
  db.prepare(`UPDATE comprovantes_pagamento SET valor_vinculado = ?, status = ?, updated_at = datetime('now') WHERE id = ?`).run(soma, status, comprovanteId);
}

// ── ROUTES ────────────────────────────────────────────────────────

// LIST
router.get('/', (req, res) => {
  const { status, direcao, q, limit = 100, offset = 0 } = req.query;
  let sql = `SELECT * FROM comprovantes_pagamento WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (direcao) { sql += ' AND direcao = ?'; params.push(direcao); }
  if (q) {
    sql += ' AND (nome_destinatario LIKE ? OR cnpj_destinatario LIKE ? OR numero_documento LIKE ? OR observacao LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  sql += ' ORDER BY data_pagamento DESC, id DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));
  try {
    const rows = req.db.prepare(sql).all(...params);
    const total = req.db.prepare('SELECT COUNT(*) c FROM comprovantes_pagamento').get().c;
    res.json({ rows, total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DETAIL + vínculos
router.get('/:id', (req, res) => {
  try {
    const cp = req.db.prepare('SELECT * FROM comprovantes_pagamento WHERE id = ?').get(req.params.id);
    if (!cp) return res.status(404).json({ error: 'Comprovante não encontrado' });
    const vinculos = req.db.prepare('SELECT * FROM comprovante_vinculos WHERE comprovante_id = ? ORDER BY id').all(req.params.id);
    res.json({ ...cp, vinculos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// UPLOAD (multipart) — cria comprovante
router.post('/upload', upload.single('arquivo'), (req, res) => {
  try {
    const body = req.body || {};
    const {
      tipo = 'OUTRO', direcao = 'SAIDA', data_pagamento, valor,
      banco_pagador = '', conta_pagador = '', cnpj_pagador = '',
      cnpj_destinatario = '', nome_destinatario = '',
      numero_documento = '', observacao = '',
    } = body;

    if (!data_pagamento) return res.status(400).json({ error: 'data_pagamento obrigatório (YYYY-MM-DD)' });
    const vnum = parseFloat(valor);
    if (!Number.isFinite(vnum) || vnum <= 0) return res.status(400).json({ error: 'valor obrigatório e > 0' });

    // Validação multi-empresa
    const erro = validarCnpjPagador(cnpj_pagador, req.companyKey);
    if (erro) {
      if (req.file) fs.unlinkSync(req.file.path); // apaga upload se rejeitar
      return res.status(400).json({ error: erro });
    }

    // Hash do arquivo (se enviado)
    let arquivo_path = null, arquivo_hash = null, arquivo_mimetype = null, arquivo_tamanho = null;
    if (req.file) {
      arquivo_path = path.relative(path.join(__dirname, '..', '..'), req.file.path).replace(/\\/g, '/');
      arquivo_hash = sha256File(req.file.path);
      arquivo_mimetype = req.file.mimetype;
      arquivo_tamanho = req.file.size;
      // Dedup — se já existir hash igual, avisa (não bloqueia)
      const dup = req.db.prepare('SELECT id FROM comprovantes_pagamento WHERE arquivo_hash = ?').get(arquivo_hash);
      if (dup) return res.status(409).json({ error: 'Comprovante duplicado (mesmo arquivo já cadastrado)', duplicado_id: dup.id });
    }

    const info = req.db.prepare(`
      INSERT INTO comprovantes_pagamento
        (tipo, direcao, data_pagamento, valor, banco_pagador, conta_pagador,
         cnpj_pagador, cnpj_destinatario, nome_destinatario, numero_documento,
         arquivo_path, arquivo_hash, arquivo_mimetype, arquivo_tamanho, observacao)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tipo, direcao, data_pagamento, vnum, banco_pagador, conta_pagador,
      digitsOnly(cnpj_pagador), digitsOnly(cnpj_destinatario), nome_destinatario, numero_documento,
      arquivo_path, arquivo_hash, arquivo_mimetype, arquivo_tamanho, observacao
    );

    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: e.message });
  }
});

// DOWNLOAD arquivo
router.get('/:id/arquivo', (req, res) => {
  try {
    const cp = req.db.prepare('SELECT arquivo_path, arquivo_mimetype FROM comprovantes_pagamento WHERE id = ?').get(req.params.id);
    if (!cp || !cp.arquivo_path) return res.status(404).json({ error: 'Arquivo não encontrado' });
    const abs = path.join(__dirname, '..', '..', cp.arquivo_path);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Arquivo físico ausente' });
    res.setHeader('Content-Type', cp.arquivo_mimetype || 'application/octet-stream');
    res.sendFile(abs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// VINCULAR — cria novo vínculo a NF/DESPESA/CONTRATO_CREDITO
router.post('/:id/vincular', (req, res) => {
  const db = req.db;
  try {
    const { tipo_destino, destino_id, valor_vinculado, observacao = '' } = req.body || {};
    if (!['NF', 'DESPESA', 'CONTRATO_CREDITO', 'EXTRATO'].includes(tipo_destino))
      return res.status(400).json({ error: 'tipo_destino inválido (NF/DESPESA/CONTRATO_CREDITO/EXTRATO)' });
    if (destino_id === undefined || destino_id === null) return res.status(400).json({ error: 'destino_id obrigatório' });
    const v = parseFloat(valor_vinculado);
    if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: 'valor_vinculado obrigatório e > 0' });

    const cp = db.prepare('SELECT * FROM comprovantes_pagamento WHERE id = ?').get(req.params.id);
    if (!cp) return res.status(404).json({ error: 'Comprovante não encontrado' });

    // Valida saldo livre
    const { soma } = db.prepare('SELECT COALESCE(SUM(valor_vinculado),0) soma FROM comprovante_vinculos WHERE comprovante_id = ?').get(cp.id);
    if (soma + v > cp.valor + 0.01) {
      return res.status(400).json({ error: `Excede saldo livre do comprovante: livre=${(cp.valor - soma).toFixed(2)}, tentando=${v}` });
    }

    // Busca destino + validação de CNPJ (se aplicável)
    let label = null;
    if (tipo_destino === 'NF') {
      const nf = db.prepare('SELECT numero, valor_bruto, tomador, cnpj_tomador FROM notas_fiscais WHERE id = ?').get(destino_id);
      if (!nf) return res.status(404).json({ error: 'NF não encontrada nesta empresa' });
      if (cp.direcao === 'ENTRADA' && cp.cnpj_destinatario && digitsOnly(nf.cnpj_tomador) && digitsOnly(nf.cnpj_tomador) !== cp.cnpj_destinatario) {
        // Aviso (não bloqueia pois às vezes agrupam pagamentos)
      }
      label = `NF ${nf.numero} — ${nf.tomador} — R$ ${Number(nf.valor_bruto).toFixed(2)}`;
    } else if (tipo_destino === 'DESPESA') {
      const dp = db.prepare('SELECT id, descricao, valor_bruto, cnpj_fornecedor, fornecedor FROM despesas WHERE id = ?').get(destino_id);
      if (!dp) return res.status(404).json({ error: 'Despesa não encontrada nesta empresa' });
      label = `Despesa #${dp.id} — ${dp.fornecedor || dp.descricao} — R$ ${Number(dp.valor_bruto).toFixed(2)}`;
    } else if (tipo_destino === 'CONTRATO_CREDITO') {
      const ct = db.prepare('SELECT numContrato, orgao, valor_mensal_bruto FROM contratos WHERE numContrato = ?').get(destino_id);
      if (!ct) return res.status(404).json({ error: 'Contrato não encontrado nesta empresa' });
      label = `Crédito em contrato ${ct.numContrato} — ${ct.orgao}`;
    } else if (tipo_destino === 'EXTRATO') {
      const ex = db.prepare('SELECT id, data_iso, credito, debito, descricao FROM extratos WHERE id = ?').get(destino_id);
      if (!ex) return res.status(404).json({ error: 'Extrato não encontrado nesta empresa' });
      label = `Extrato ${ex.data_iso} — ${ex.credito > 0 ? '+' : '-'}R$ ${Math.max(ex.credito, ex.debito).toFixed(2)}`;
    }

    const info = db.prepare(`
      INSERT INTO comprovante_vinculos (comprovante_id, tipo_destino, destino_id, destino_label, valor_vinculado, observacao)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(cp.id, tipo_destino, String(destino_id), label, v, observacao);

    recomputarStatus(db, cp.id);

    // Fase C: se vínculo for em NF, recalcula status + retencao_efetiva da NF
    let nfStatus = null;
    if (tipo_destino === 'NF') {
      try { nfStatus = recalcularNF(db, destino_id); } catch (_) {}
    }

    res.json({ ok: true, vinculo_id: info.lastInsertRowid, label, nf_status: nfStatus });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DESVINCULAR
router.delete('/vinculos/:vid', (req, res) => {
  try {
    const v = req.db.prepare('SELECT comprovante_id, tipo_destino, destino_id FROM comprovante_vinculos WHERE id = ?').get(req.params.vid);
    if (!v) return res.status(404).json({ error: 'Vínculo não encontrado' });
    req.db.prepare('DELETE FROM comprovante_vinculos WHERE id = ?').run(req.params.vid);
    recomputarStatus(req.db, v.comprovante_id);
    // Fase C: se era NF, recalcula status derivado
    if (v.tipo_destino === 'NF') {
      try { recalcularNF(req.db, v.destino_id); } catch (_) {}
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SUGERIR MATCHES — busca NFs/despesas/extratos candidatos por CNPJ + valor
router.get('/:id/sugerir-matches', (req, res) => {
  try {
    const cp = req.db.prepare('SELECT * FROM comprovantes_pagamento WHERE id = ?').get(req.params.id);
    if (!cp) return res.status(404).json({ error: 'Comprovante não encontrado' });

    const cnpjDest = digitsOnly(cp.cnpj_destinatario);
    const tol = Math.max(cp.valor * 0.05, 1.00); // 5% ou R$1
    const vmin = cp.valor - tol;
    const vmax = cp.valor + tol;
    const janelaDias = 60;

    const sugestoes = { nfs: [], despesas: [], extratos: [], contratos: [] };

    // ENTRADA: tomador pagou Montana → sugere NFs (cujo CNPJ_tomador == cnpj_destinatario do comprovante)
    if (cp.direcao === 'ENTRADA') {
      let sql = `SELECT id, numero, data_emissao, valor_bruto, valor_liquido, tomador, cnpj_tomador, contrato_ref, status_conciliacao
                 FROM notas_fiscais
                 WHERE (valor_bruto BETWEEN ? AND ? OR valor_liquido BETWEEN ? AND ?)
                   AND (status_conciliacao IS NULL OR status_conciliacao NOT IN ('CONCILIADO'))
                 `;
      const params = [vmin, vmax, vmin, vmax];
      if (cnpjDest) {
        sql += ` AND REPLACE(REPLACE(REPLACE(cnpj_tomador,'.',''),'/',''),'-','') = ?`;
        params.push(cnpjDest);
      }
      sql += ' ORDER BY ABS(julianday(data_emissao) - julianday(?)) LIMIT 20';
      params.push(cp.data_pagamento);
      sugestoes.nfs = req.db.prepare(sql).all(...params);

      // Extratos de crédito na janela
      try {
        sugestoes.extratos = req.db.prepare(`
          SELECT id, data_iso, credito, descricao FROM extratos
          WHERE credito BETWEEN ? AND ?
            AND ABS(julianday(data_iso) - julianday(?)) <= ?
          ORDER BY ABS(julianday(data_iso) - julianday(?)) LIMIT 10
        `).all(vmin, vmax, cp.data_pagamento, janelaDias, cp.data_pagamento);
      } catch {}
    }

    // SAIDA: Montana pagou fornecedor → sugere despesas
    if (cp.direcao === 'SAIDA') {
      try {
        let sql = `SELECT id, data_vencimento, valor_bruto, fornecedor, cnpj_fornecedor, descricao, categoria
                   FROM despesas
                   WHERE valor_bruto BETWEEN ? AND ?
                     AND (status IS NULL OR status NOT IN ('PAGO','PAGA'))`;
        const params = [vmin, vmax];
        if (cnpjDest) {
          sql += ` AND REPLACE(REPLACE(REPLACE(cnpj_fornecedor,'.',''),'/',''),'-','') = ?`;
          params.push(cnpjDest);
        }
        sql += ' ORDER BY ABS(julianday(data_vencimento) - julianday(?)) LIMIT 20';
        params.push(cp.data_pagamento);
        sugestoes.despesas = req.db.prepare(sql).all(...params);
      } catch (e) { /* despesas schema varia — falha silenciosa */ }

      // Extratos de débito
      try {
        sugestoes.extratos = req.db.prepare(`
          SELECT id, data_iso, debito, descricao FROM extratos
          WHERE debito BETWEEN ? AND ?
            AND ABS(julianday(data_iso) - julianday(?)) <= ?
          ORDER BY ABS(julianday(data_iso) - julianday(?)) LIMIT 10
        `).all(vmin, vmax, cp.data_pagamento, janelaDias, cp.data_pagamento);
      } catch {}
    }

    res.json(sugestoes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE comprovante inteiro (e vínculos em cascade)
router.delete('/:id', (req, res) => {
  try {
    const cp = req.db.prepare('SELECT arquivo_path FROM comprovantes_pagamento WHERE id = ?').get(req.params.id);
    if (!cp) return res.status(404).json({ error: 'Não encontrado' });
    // Captura NFs vinculadas antes do CASCADE, para recalcular depois
    const nfDest = req.db.prepare(`SELECT DISTINCT destino_id FROM comprovante_vinculos WHERE comprovante_id = ? AND tipo_destino = 'NF'`).all(req.params.id);
    req.db.prepare('DELETE FROM comprovantes_pagamento WHERE id = ?').run(req.params.id);
    for (const r of nfDest) {
      try { recalcularNF(req.db, r.destino_id); } catch (_) {}
    }
    if (cp.arquivo_path) {
      const abs = path.join(__dirname, '..', '..', cp.arquivo_path);
      try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch {}
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
