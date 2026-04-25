/**
 * Montana — Importação de funcionários via Alterdata Folha de Pagamento
 * POST /api/alterdata/importar-funcionarios
 * GET  /api/alterdata/template
 */
const express = require('express');
const multer  = require('multer');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

// ── Multer: memória (arquivos TXT/CSV pequenos) ───────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const ok = /\.(txt|csv)$/i.test(file.originalname) ||
               file.mimetype === 'text/plain' ||
               file.mimetype === 'text/csv' ||
               file.mimetype === 'application/octet-stream';
    cb(ok ? null : new Error('Apenas arquivos .txt ou .csv são aceitos'), ok);
  }
});

// ── Colunas esperadas (layout padrão Alterdata) ───────────────────
const COLUNAS_PADRAO = [
  'MATRICULA', 'NOME', 'CPF', 'PIS',
  'DATA_ADMISSAO', 'DATA_DEMISSAO', 'CARGO',
  'SALARIO_BASE', 'LOTACAO', 'SITUACAO'
];

// ── Normaliza data DD/MM/YYYY ou YYYY-MM-DD → YYYY-MM-DD ──────────
function normalizarData(valor) {
  if (!valor || valor.trim() === '' || valor === '00/00/0000' || valor === '0000-00-00') return '';
  const s = valor.trim();
  // DD/MM/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [d, m, a] = s.split('/');
    return `${a}-${m}-${d}`;
  }
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DDMMYYYY (sem separador)
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(4)}-${s.slice(2, 4)}-${s.slice(0, 2)}`;
  }
  return s;
}

// ── Normaliza salário "R$ 2.500,00" → 2500.00 ────────────────────
function normalizarSalario(valor) {
  if (!valor) return 0;
  const s = String(valor)
    .replace(/R\$\s*/gi, '')
    .replace(/\./g, '')      // remove separador de milhar
    .replace(',', '.')       // vírgula decimal → ponto
    .trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// ── Normaliza status A/ATIVO/1 → ATIVO | D/DEMITIDO/I → INATIVO ──
function normalizarStatus(valor) {
  if (!valor) return 'ATIVO';
  const s = String(valor).trim().toUpperCase();
  if (['A', 'ATIVO', '1', 'ATIVA'].includes(s)) return 'ATIVO';
  if (['D', 'DEMITIDO', 'DEMITIDA', 'I', 'INATIVO', 'INATIVA', '0'].includes(s)) return 'INATIVO';
  return 'ATIVO'; // padrão seguro
}

// ── Detecta separador (';' ou '|') ────────────────────────────────
function detectarSeparador(primeiraLinha) {
  const contagemPV = (primeiraLinha.match(/;/g) || []).length;
  const contagemPipe = (primeiraLinha.match(/\|/g) || []).length;
  return contagemPipe > contagemPV ? '|' : ';';
}

// ── Mapeia cabeçalho para índices das colunas ─────────────────────
function mapearCabecalho(colunas, sep) {
  const mapa = {};
  colunas.forEach((col, i) => {
    mapa[col.trim().toUpperCase()] = i;
  });
  return mapa;
}

function getValor(linha, mapa, chave) {
  const idx = mapa[chave];
  if (idx === undefined || idx >= linha.length) return '';
  return (linha[idx] || '').trim();
}

// ── POST /api/alterdata/importar-funcionarios ─────────────────────
router.post('/importar-funcionarios', (req, res) => {
  upload.single('arquivo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado. Use o campo "arquivo".' });

    try {
      // Tenta UTF-8, fallback latin1
      let texto;
      try {
        texto = req.file.buffer.toString('utf8');
        // Verifica se há caracteres de substituição (indica encoding errado)
        if (texto.includes('\uFFFD')) throw new Error('BOM/encoding issue');
      } catch (_) {
        texto = req.file.buffer.toString('latin1');
      }

      // Remove BOM se presente
      texto = texto.replace(/^\uFEFF/, '');

      const linhas = texto.split(/\r?\n/).filter(l => l.trim() !== '');
      if (linhas.length < 2) {
        return res.status(422).json({ error: 'Arquivo vazio ou sem dados. Deve ter ao menos cabeçalho + 1 linha.' });
      }

      const sep = detectarSeparador(linhas[0]);
      const cabecalhoRaw = linhas[0].split(sep);
      const mapa = mapearCabecalho(cabecalhoRaw, sep);

      // Valida colunas mínimas obrigatórias
      if (mapa['NOME'] === undefined && mapa['FUNCIONARIO'] === undefined) {
        return res.status(422).json({
          error: 'Cabeçalho inválido. A coluna NOME é obrigatória.',
          colunas_encontradas: cabecalhoRaw.map(c => c.trim()),
          layout_esperado: COLUNAS_PADRAO
        });
      }

      const db = req.db;

      // Tenta adicionar coluna cargo (texto) se ainda não existir — Alterdata não usa cargo_id
      try { db.exec(`ALTER TABLE rh_funcionarios ADD COLUMN cargo TEXT DEFAULT ''`); } catch (_) {}

      // Statements reutilizáveis (preparados fora da transaction para melhor performance)
      const stmtBusca   = db.prepare(`SELECT id FROM rh_funcionarios WHERE cpf=? AND cpf!='' LIMIT 1`);
      const stmtInsert  = db.prepare(`
        INSERT INTO rh_funcionarios
          (matricula, nome, cpf, pis, data_admissao, data_demissao,
           cargo, lotacao, salario_base, status, created_at, updated_at)
        VALUES
          (@matricula, @nome, @cpf, @pis, @data_admissao, @data_demissao,
           @cargo, @lotacao, @salario_base, @status, datetime('now'), datetime('now'))
      `);
      const stmtUpdate  = db.prepare(`
        UPDATE rh_funcionarios SET
          matricula     = @matricula,
          nome          = @nome,
          pis           = @pis,
          data_admissao = @data_admissao,
          data_demissao = @data_demissao,
          cargo         = @cargo,
          lotacao       = @lotacao,
          salario_base  = @salario_base,
          status        = @status,
          updated_at    = datetime('now')
        WHERE cpf = @cpf AND cpf != ''
      `);

      let importados = 0;
      let atualizados = 0;
      const erros = [];

      const processar = db.transaction(() => {
        for (let i = 1; i < linhas.length; i++) {
          const cols = linhas[i].split(sep);
          // Linha vazia ou com apenas separadores
          if (cols.every(c => c.trim() === '')) continue;

          try {
            // Suporta variante com coluna FUNCIONARIO no lugar de NOME
            const nome = getValor(cols, mapa, 'NOME') || getValor(cols, mapa, 'FUNCIONARIO');
            if (!nome) { erros.push({ linha: i + 1, erro: 'NOME vazio' }); continue; }

            const cpf       = getValor(cols, mapa, 'CPF').replace(/\D/g, ''); // só dígitos
            const pis       = getValor(cols, mapa, 'PIS').replace(/\D/g, '');
            const matricula = getValor(cols, mapa, 'MATRICULA');
            const cargo     = getValor(cols, mapa, 'CARGO') || getValor(cols, mapa, 'FUNCAO') || '';
            const lotacao   = getValor(cols, mapa, 'LOTACAO') || getValor(cols, mapa, 'POSTO') || '';
            const dataAdm   = normalizarData(getValor(cols, mapa, 'DATA_ADMISSAO') || getValor(cols, mapa, 'ADMISSAO'));
            const dataDem   = normalizarData(getValor(cols, mapa, 'DATA_DEMISSAO') || getValor(cols, mapa, 'DEMISSAO'));
            const salario   = normalizarSalario(getValor(cols, mapa, 'SALARIO_BASE') || getValor(cols, mapa, 'SALARIO'));
            const status    = normalizarStatus(getValor(cols, mapa, 'SITUACAO') || getValor(cols, mapa, 'STATUS'));

            const params = { matricula, nome, cpf, pis, data_admissao: dataAdm,
              data_demissao: dataDem, cargo, lotacao, salario_base: salario, status };

            if (cpf) {
              const jaExiste = stmtBusca.get(cpf);
              if (jaExiste) {
                stmtUpdate.run(params);
                atualizados++;
              } else {
                stmtInsert.run(params);
                importados++;
              }
            } else {
              // Sem CPF: sempre insere (não há chave de dedup)
              stmtInsert.run(params);
              importados++;
            }
          } catch (e) {
            erros.push({ linha: i + 1, erro: e.message, dados: linhas[i].slice(0, 80) });
          }
        }
      });

      processar();

      // Registra importação
      try {
        db.prepare(`INSERT INTO importacoes (tipo, arquivo, registros, status) VALUES ('ALTERDATA', @arquivo, @registros, 'OK')`).run({
          arquivo: req.file.originalname,
          registros: importados + atualizados
        });
      } catch (_e) {}

      res.json({
        ok: true,
        importados,
        atualizados,
        erros: erros.slice(0, 20), // limita erros retornados
        total_erros: erros.length,
        total: linhas.length - 1
      });

    } catch (e) {
      res.status(500).json({ error: 'Erro ao processar arquivo: ' + e.message });
    }
  });
});

// ── GET /api/alterdata/template — CSV de exemplo para a contabilidade ─
router.get('/template', (req, res) => {
  const cabecalho = COLUNAS_PADRAO.join(';');
  const exemplo1  = '001;JOÃO DA SILVA SANTOS;123.456.789-09;123.45678.90-1;01/03/2024;;VIGILANTE;1.500,00;UFT - BLOCO A;A';
  const exemplo2  = '002;MARIA APARECIDA SOUSA;987.654.321-00;987.65432.10-0;15/06/2023;31/01/2026;SUPERVISORA;2.200,00;DETRAN - SEDE;D';
  const exemplo3  = '003;PEDRO OLIVEIRA COSTA;111.222.333-44;111.22333.44-5;01/01/2025;;RECEPCIONISTA;1.412,00;SESAU - PALMAS;A';

  const conteudo = [cabecalho, exemplo1, exemplo2, exemplo3].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="template_alterdata_funcionarios.csv"');
  res.send('\uFEFF' + conteudo); // BOM para abrir corretamente no Excel
});

// ── GET /api/alterdata/info ────────────────────────────────────────
router.get('/info', (_req, res) => {
  res.json({
    endpoint_importacao: 'POST /api/alterdata/importar-funcionarios',
    endpoint_template: 'GET /api/alterdata/template',
    campo_upload: 'arquivo',
    formatos: ['.txt', '.csv'],
    separadores: [';', '|'],
    colunas: COLUNAS_PADRAO,
    observacoes: [
      'CPF é usado como chave de deduplicação. Registros sem CPF são sempre inseridos.',
      'SITUACAO: A/ATIVO → ATIVO; D/DEMITIDO/I/INATIVO → INATIVO',
      'DATA_ADMISSAO e DATA_DEMISSAO: DD/MM/YYYY ou YYYY-MM-DD',
      'SALARIO_BASE: aceita formato "R$ 1.500,00" ou "1500.00"'
    ]
  });
});

module.exports = router;
