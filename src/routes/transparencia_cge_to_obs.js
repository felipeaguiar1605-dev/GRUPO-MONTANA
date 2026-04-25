/**
 * Montana - Rota /api/transparencia/cge-to/*
 * Baixa Ordens Bancárias em PDF do Portal TranspGTO.
 * Armazena em /var/lib/montana/obs_pdf/<company>/
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const companyMw = require('../companyMiddleware');
const { baixarOBs } = require('../adapters/cge_to_ordens_bancarias');

const BASE_DIR = process.env.OBS_PDF_DIR || '/var/lib/montana/obs_pdf';

const router = express.Router();
router.use(companyMw);

function companyDir(req) {
  const company = req.companyKey || 'default';
  const dir = path.join(BASE_DIR, String(company));
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error('[cge-to/obs] mkdir failed:', e.message);
  }
  return dir;
}

// POST /baixar — dispara download
// body: { ug, categoria, fonte, ano, mes?, limit? }
router.post('/baixar', async (req, res) => {
  const { ug, categoria, fonte, ano, mes = 'Todos', limit = 0 } = req.body || {};
  if (!ug || !categoria || !fonte || !ano) {
    return res.status(400).json({ erro: 'Campos obrigatórios: ug, categoria, fonte, ano' });
  }

  const outDir = path.join(companyDir(req), `${ano}_${String(ug).replace(/[^\w]/g, '_')}`);
  try {
    const progress = [];
    const result = await baixarOBs({
      ug, categoria, fonte, ano, mes, outDir,
      limit: parseInt(limit, 10) || 0,
      onProgress: (i, total, info) => {
        progress.push({ i, total, size: info.size, status: info.status, isPdf: info.isPdf, file: path.basename(info.file) });
      },
    });
    res.json({
      ok: true,
      encontradas: result.total,
      baixadas: result.baixados.length,
      pdfs: result.baixados.filter(x => x.isPdf).length,
      outDir,
      arquivos: result.baixados.map(b => ({
        file: path.basename(b.file),
        size: b.size,
        isPdf: b.isPdf,
        status: b.status,
      })),
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// GET /listar — lista PDFs baixados
router.get('/listar', async (req, res) => {
  const dir = companyDir(req);
  const all = [];
  function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.pdf')) {
        const st = fs.statSync(p);
        all.push({
          nome: e.name,
          path: p.replace(dir + path.sep, ''),
          tamanho: st.size,
          baixado_em: st.mtime,
        });
      }
    }
  }
  walk(dir);
  res.json({ total: all.length, arquivos: all.sort((a, b) => b.baixado_em - a.baixado_em) });
});

// GET /arquivo/:subdir/:nome — serve PDF
router.get('/arquivo/:subdir/:nome', async (req, res) => {
  const dir = companyDir(req);
  const file = path.join(dir, req.params.subdir, req.params.nome);
  if (!file.startsWith(dir)) return res.status(403).end();
  if (!fs.existsSync(file)) return res.status(404).json({ erro: 'Não encontrado' });
  res.sendFile(file);
});

module.exports = router;
