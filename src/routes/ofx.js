/**
 * Montana — Importação de extratos no formato OFX
 * Suporta BB (FID 1), BRB (FID 70) e CEF (FID 104)
 * POST /api/ofx/importar
 */
const express = require('express');
const multer  = require('multer');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

// ── Multer: armazenamento em memória (sem gravar no disco) ────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const ok = /\.ofx$/i.test(file.originalname) ||
               file.mimetype === 'application/ofx' ||
               file.mimetype === 'text/plain';
    cb(ok ? null : new Error('Apenas arquivos .ofx são aceitos'), ok);
  }
});

// ── Garante coluna ofx_fitid na tabela extratos ───────────────────
function ensureFitidColumn(db) {
  try {
    db.exec(`ALTER TABLE extratos ADD COLUMN ofx_fitid TEXT DEFAULT ''`);
  } catch (_e) { /* coluna já existe */ }
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_extratos_fitid ON extratos(ofx_fitid) WHERE ofx_fitid IS NOT NULL AND ofx_fitid != ''`);
  } catch (_e) {}
}

// ── Detecta banco pelo FID/ORG ─────────────────────────────────────
function detectarBanco(texto) {
  const fid = texto.match(/<FID>\s*(\d+)/i);
  const org = texto.match(/<ORG>\s*([^\r\n<]+)/i);
  if (fid) {
    const n = parseInt(fid[1]);
    if (n === 1)   return 'BB';
    if (n === 70)  return 'BRB';
    if (n === 104) return 'CEF';
  }
  if (org) {
    const o = org[1].trim().toLowerCase();
    if (o.includes('brasil') || o.includes('bb'))  return 'BB';
    if (o.includes('brb'))                         return 'BRB';
    if (o.includes('caixa') || o.includes('cef'))  return 'CEF';
  }
  return 'BB'; // padrão
}

// ── Converte YYYYMMDD[HH:MM:SS[.sss][-/+TZ]] → YYYY-MM-DD ─────────
function parseDataOFX(dtposted) {
  const s = String(dtposted).trim();
  const ano = s.slice(0, 4);
  const mes = s.slice(4, 6);
  const dia = s.slice(6, 8);
  return `${ano}-${mes}-${dia}`;
}

// ── Deriva MM/AAAA a partir de data ISO ───────────────────────────
function derivarMes(dataIso) {
  // dataIso = YYYY-MM-DD
  const parts = dataIso.split('-');
  if (parts.length < 2) return '';
  const meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const idx = parseInt(parts[1], 10) - 1;
  return `${meses[idx] || parts[1]}/${parts[0]}`;
}

// ── Parser OFX/SGML: extrai blocos <STMTTRN>...</STMTTRN> ─────────
function parsearOFX(texto) {
  const transacoes = [];

  // Normaliza quebras de linha e remove espaços extras ao redor de tags
  const conteudo = texto.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Captura todos os blocos STMTTRN (SGML e XML)
  const blocoRe = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let bloco;

  while ((bloco = blocoRe.exec(conteudo)) !== null) {
    const b = bloco[1];

    const fitid    = (b.match(/<FITID>\s*([^\r\n<]+)/i)    || [])[1];
    const dtposted = (b.match(/<DTPOSTED>\s*([^\r\n<]+)/i) || [])[1];
    const trnamt   = (b.match(/<TRNAMT>\s*([^\r\n<]+)/i)   || [])[1];
    const memo     = (b.match(/<MEMO>\s*([^\r\n<]+)/i)     || [])[1];
    const name     = (b.match(/<NAME>\s*([^\r\n<]+)/i)     || [])[1];

    if (!fitid || !dtposted || trnamt === undefined) continue;

    const valorNum = parseFloat(String(trnamt).replace(',', '.'));
    if (isNaN(valorNum)) continue;

    const dataIso   = parseDataOFX(dtposted);
    const historico = (memo || name || '').trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const credito   = valorNum > 0 ? valorNum : null;
    const debito    = valorNum < 0 ? Math.abs(valorNum) : null;

    transacoes.push({ fitid: fitid.trim(), dataIso, historico, credito, debito });
  }

  return transacoes;
}

// ── POST /api/ofx/importar ────────────────────────────────────────
router.post('/importar', async (req, res) => {
  upload.single('arquivo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado. Use o campo "arquivo".' });

    try {
      const db = req.db;
      ensureFitidColumn(db);

      // Detectar encoding: OFX do BB costuma usar ISO-8859-1
      let texto;
      const header = req.file.buffer.slice(0, 200).toString('ascii');
      const charsetMatch = header.match(/CHARSET:\s*(\d+)/i);
      if (charsetMatch && charsetMatch[1] === '1252') {
        texto = req.file.buffer.toString('latin1');
      } else {
        // Tenta UTF-8 primeiro; se tiver bytes inválidos usa latin1
        try {
          texto = req.file.buffer.toString('utf8');
        } catch (_) {
          texto = req.file.buffer.toString('latin1');
        }
      }

      const banco = detectarBanco(texto);

      // Extrai número da conta (opcional, para registro)
      const contaMatch = texto.match(/<ACCTID>\s*([^\r\n<]+)/i);
      const conta = contaMatch ? contaMatch[1].trim() : '';

      const transacoes = parsearOFX(texto);
      if (transacoes.length === 0) {
        return res.status(422).json({ error: 'Nenhuma transação encontrada no arquivo OFX. Verifique o formato.' });
      }

      const stmtInsert = db.prepare(`
        INSERT INTO extratos
          (mes, data, data_iso, tipo, historico, debito, credito,
           status_conciliacao, banco, conta, ofx_fitid,
           created_at, updated_at)
        VALUES
          (@mes, @data, @data_iso, @tipo, @historico, @debito, @credito,
           'PENDENTE', @banco, @conta, @ofx_fitid,
           NOW(), NOW())
      `);

      // Verifica quantas já existem (para contar duplicatas)
      const checkFitid = db.prepare(`SELECT 1 FROM extratos WHERE ofx_fitid=? AND ofx_fitid!='' LIMIT 1`);

      let importados = 0;
      let duplicatas = 0;

      const importarTudo = db.transaction(async () => {
        for (const t of transacoes) {
          // Verifica duplicata via fitid
          const existe = checkFitid.get(t.fitid);
          if (existe) { duplicatas++; continue; }

          const mes  = derivarMes(t.dataIso);
          // data no formato DD/MM/YYYY para compatibilidade com os extratos existentes
          const partes = t.dataIso.split('-');
          const data   = partes.length === 3 ? `${partes[2]}/${partes[1]}/${partes[0]}` : t.dataIso;
          const tipo   = t.credito ? 'C' : 'D';

          const r = stmtInsert.run({
            mes,
            data,
            data_iso: t.dataIso,
            tipo,
            historico: t.historico,
            debito:    t.debito   ?? null,
            credito:   t.credito  ?? null,
            banco,
            conta,
            ofx_fitid: t.fitid
          });

          if (r.changes > 0) importados++;
          else duplicatas++;
        }
      });

      await importarTudo();

      // Registra importação
      try {
        await db.prepare(`INSERT INTO importacoes (tipo, arquivo, registros, status) VALUES ('OFX', @arquivo, @registros, 'OK')`).run({
          arquivo: req.file.originalname,
          registros: importados
        });
      } catch (_e) {}

      res.json({
        ok: true,
        importados,
        duplicatas,
        total: transacoes.length,
        banco,
        conta: conta || undefined
      });

    } catch (e) {
      res.status(500).json({ error: 'Erro ao processar OFX: ' + e.message });
    }
  });
});

// ── GET /api/ofx/info — retorna informações do arquivo sem importar ─
router.get('/info', async (req, res) => {
  res.json({
    endpoint: 'POST /api/ofx/importar',
    campo: 'arquivo',
    formatos: ['.ofx'],
    bancos_suportados: ['BB (FID 1)', 'BRB (FID 70)', 'CEF (FID 104)'],
    descricao: 'Importe extratos bancários em formato OFX. Duplicatas são ignoradas automaticamente via FITID.'
  });
});

module.exports = router;
