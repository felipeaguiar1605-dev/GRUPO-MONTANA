/**
 * Montana — Módulo de Certidões
 * CRUD completo + upload de PDF + alertas de vencimento.
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

// ─── Upload de PDF ────────────────────────────────────────────────
function getUpload(req) {
  const dest = path.join(__dirname, '..', '..', req.company.uploadsPath, 'certidoes');
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  return multer({
    dest,
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ok = file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf');
      cb(ok ? null : new Error('Apenas arquivos PDF são permitidos'), ok);
    }
  });
}

// ─── Status automático por validade ──────────────────────────────
function calcStatus(data_validade) {
  if (!data_validade) return 'válida';
  const hoje = new Date().toISOString().split('T')[0];
  const diffMs = new Date(data_validade) - new Date(hoje);
  const diffDias = Math.floor(diffMs / 86400000);
  if (diffDias < 0)  return 'vencida';
  if (diffDias <= 30) return 'próxima do vencimento';
  return 'válida';
}

async function await atualizarStatus(db, rows) {
  const upd = db.prepare(`UPDATE certidoes SET status=@status, updated_at=NOW() WHERE id=@id`);
  const trans = db.transaction(async () => {
    for (const r of rows) {
      const novo = calcStatus(r.data_validade);
      if (novo !== r.status) { upd.run({ status: novo, id: r.id }); r.status = novo; }
    }
  });
  await trans();
}

// GET /api/certidoes
router.get('/', async (req, res) => {
  const { status, tipo } = req.query;
  let where = '1=1';
  const p = {};
  if (status) { where += ' AND status=@status'; p.status = status; }
  if (tipo)   { where += ' AND tipo=@tipo';     p.tipo   = tipo; }

  const rows = await req.db.prepare(`SELECT * FROM certidoes WHERE ${where} ORDER BY data_validade ASC`).all(p);
  await atualizarStatus(req.db, rows);
  res.json({ data: rows, total: rows.length });
});

// GET /api/certidoes/alertas
router.get('/alertas', async (req, res) => {
  const hoje  = new Date().toISOString().split('T')[0];
  const em15  = new Date(Date.now() + 15 * 86400000).toISOString().split('T')[0];
  const em30  = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];

  const vencidas = await req.db.prepare(`SELECT * FROM certidoes WHERE data_validade < @hoje ORDER BY data_validade`).all({ hoje });
  const em15d    = await req.db.prepare(`SELECT * FROM certidoes WHERE data_validade >= @hoje AND data_validade <= @em15 ORDER BY data_validade`).all({ hoje, em15 });
  const em30d    = await req.db.prepare(`SELECT * FROM certidoes WHERE data_validade > @em15 AND data_validade <= @em30 ORDER BY data_validade`).all({ em15, em30 });

  res.json({ vencidas, proximas_15: em15d, proximas_30: em30d, total_alertas: vencidas.length + em15d.length });
});

// POST /api/certidoes
router.post('/', async (req, res) => {
  const upload = getUpload(req);
  upload.single('arquivo_pdf')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    const { tipo, numero, data_emissao, data_validade, observacoes } = req.body;
    if (!tipo) return res.status(400).json({ error: 'Tipo é obrigatório' });
    const arquivo_pdf = req.file ? req.file.filename : '';
    const status = calcStatus(data_validade);
    const r = await req.db.prepare(`
      INSERT INTO certidoes (tipo,numero,data_emissao,data_validade,arquivo_pdf,status,observacoes)
      VALUES (@tipo,@numero,@data_emissao,@data_validade,@arquivo_pdf,@status,@observacoes)
    `).run({ tipo, numero:numero||'', data_emissao:data_emissao||'', data_validade:data_validade||'', arquivo_pdf, status, observacoes:observacoes||'' });
    res.json({ ok: true, id: r.lastInsertRowid });
  });
});

// PUT /api/certidoes/:id
router.put('/:id', async (req, res) => {
  const upload = getUpload(req);
  upload.single('arquivo_pdf')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    const { tipo, numero, data_emissao, data_validade, observacoes } = req.body;
    const status = calcStatus(data_validade);
    let sql = `UPDATE certidoes SET tipo=@tipo,numero=@numero,data_emissao=@data_emissao,data_validade=@data_validade,status=@status,observacoes=@observacoes,updated_at=NOW()`;
    const p = { tipo:tipo||'', numero:numero||'', data_emissao:data_emissao||'', data_validade:data_validade||'', status, observacoes:observacoes||'', id:req.params.id };
    if (req.file) { sql += ',arquivo_pdf=@arquivo_pdf'; p.arquivo_pdf = req.file.filename; }
    sql += ' WHERE id=@id';
    await req.db.prepare(sql).run(p);
    res.json({ ok: true });
  });
});

// DELETE /api/certidoes/:id
router.delete('/:id', async (req, res) => {
  await req.db.prepare('DELETE FROM certidoes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/certidoes/arquivo/:filename — serve PDF
router.get('/arquivo/:filename', async (req, res) => {
  const filePath = path.join(__dirname, '..', '..', req.company.uploadsPath, 'certidoes', req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Arquivo não encontrado' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${req.params.filename}"`);
  fs.createReadStream(filePath).pipe(res);
});

module.exports = router;
