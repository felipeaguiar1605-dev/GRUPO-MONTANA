/**
 * Montana Multi-Empresa — Módulo de Boletins de Medição
 * CRUD de contratos, postos, itens + geração de PDFs
 */
const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

// ─── INIT: Adicionar colunas extras nas tabelas de boletins ────

router.use((req, res, next) => {
  const db = req.db;
  if (!db) return next();

  // Colunas NFS-e na tabela bol_boletins
  const bolCols = [
    ['valor_base',        'REAL DEFAULT 0'],
    ['glosas',            'REAL DEFAULT 0'],
    ['acrescimos',        'REAL DEFAULT 0'],
    ['discriminacao',     'TEXT'],
    ['nfse_numero',       'TEXT'],
    ['nfse_data_emissao', 'TEXT'],
    ['nfse_status',       "TEXT DEFAULT 'PENDENTE'"],
    ['nfse_xml',          'TEXT'],
    ['nfse_erro',         'TEXT'],
    ['obs',               'TEXT'],
    ['updated_at',        "TEXT DEFAULT (datetime('now'))"],
  ];
  for (const [col, def] of bolCols) {
    try { db.prepare(`ALTER TABLE bol_boletins ADD COLUMN ${col} ${def}`).run(); } catch (_) {}
  }

  // Colunas adicionais na tabela bol_contratos (necessárias para vinculação contrato financeiro + NFS-e)
  const contrCols = [
    ['contrato_ref',    "TEXT DEFAULT ''"],  // numContrato da tabela contratos
    ['orgao',           "TEXT DEFAULT ''"],  // razão social do tomador para NFS-e
    ['insc_municipal',  "TEXT DEFAULT ''"],  // CNPJ do tomador (campo nomenclatura WebISS)
  ];
  for (const [col, def] of contrCols) {
    try { db.prepare(`ALTER TABLE bol_contratos ADD COLUMN ${col} ${def}`).run(); } catch (_) {}
  }

  next();
});

// ─── HELPERS ──────────────────────────────────────────────────

function formatMoeda(v) {
  return 'R$ ' + Number(v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

const MESES = {
  'janeiro':1,'fevereiro':2,'março':3,'abril':4,'maio':5,'junho':6,
  'julho':7,'agosto':8,'setembro':9,'outubro':10,'novembro':11,'dezembro':12
};
const MESES_NOME = Object.fromEntries(Object.entries(MESES).map(([k,v])=>[v,k]));

function calcularPeriodo(competencia) {
  const parts = competencia.toLowerCase().trim().split(/\s+/);
  const mesNome = parts[0];
  const ano = parseInt(parts[1]);
  const mesNum = MESES[mesNome];
  if (!mesNum) return competencia;
  let mesAnt = mesNum - 1, anoAnt = ano;
  if (mesAnt === 0) { mesAnt = 12; anoAnt = ano - 1; }
  return `21 de ${MESES_NOME[mesAnt]} de ${anoAnt} a 20 de ${MESES_NOME[mesNum]} de ${ano}.`;
}

// ─── CONTRATOS — CRUD ─────────────────────────────────────────

router.get('/contratos', (req, res) => {
  const rows = req.db.prepare('SELECT * FROM bol_contratos ORDER BY ativo DESC, nome ASC').all();
  res.json(rows);
});

router.get('/contratos/:id', (req, res) => {
  const c = req.db.prepare('SELECT * FROM bol_contratos WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Contrato não encontrado' });
  // Incluir postos e itens
  const postos = req.db.prepare('SELECT * FROM bol_postos WHERE contrato_id = ? ORDER BY ordem').all(c.id);
  for (const p of postos) {
    p.itens = req.db.prepare('SELECT * FROM bol_itens WHERE posto_id = ? ORDER BY ordem').all(p.id);
  }
  c.postos = postos;
  res.json(c);
});

router.post('/contratos', (req, res) => {
  const b = req.body;
  const r = req.db.prepare(`
    INSERT INTO bol_contratos (nome, contratante, numero_contrato, processo, pregao,
      descricao_servico, escala, empresa_razao, empresa_cnpj, empresa_endereco,
      empresa_email, empresa_telefone)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    b.nome, b.contratante, b.numero_contrato, b.processo||'', b.pregao||'',
    b.descricao_servico||'', b.escala||'12x36', b.empresa_razao||'',
    b.empresa_cnpj||'', b.empresa_endereco||'', b.empresa_email||'', b.empresa_telefone||''
  );
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.put('/contratos/:id', (req, res) => {
  const b = req.body;
  req.db.prepare(`
    UPDATE bol_contratos SET nome=?, contratante=?, numero_contrato=?, processo=?, pregao=?,
      descricao_servico=?, escala=?, empresa_razao=?, empresa_cnpj=?, empresa_endereco=?,
      empresa_email=?, empresa_telefone=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    b.nome, b.contratante, b.numero_contrato, b.processo||'', b.pregao||'',
    b.descricao_servico||'', b.escala||'12x36', b.empresa_razao||'',
    b.empresa_cnpj||'', b.empresa_endereco||'', b.empresa_email||'', b.empresa_telefone||'',
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/contratos/:id', (req, res) => {
  req.db.prepare('DELETE FROM bol_contratos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── POSTOS — CRUD ────────────────────────────────────────────

router.get('/contratos/:id/postos', (req, res) => {
  const postos = req.db.prepare('SELECT * FROM bol_postos WHERE contrato_id = ? ORDER BY ordem').all(req.params.id);
  for (const p of postos) {
    p.itens = req.db.prepare('SELECT * FROM bol_itens WHERE posto_id = ? ORDER BY ordem').all(p.id);
  }
  res.json(postos);
});

router.post('/contratos/:id/postos', (req, res) => {
  const b = req.body;
  const maxOrdem = req.db.prepare('SELECT COALESCE(MAX(ordem),0) as m FROM bol_postos WHERE contrato_id=?').get(req.params.id);
  const r = req.db.prepare(`
    INSERT INTO bol_postos (contrato_id, campus_key, campus_nome, municipio, descricao_posto, label_resumo, ordem)
    VALUES (?,?,?,?,?,?,?)
  `).run(req.params.id, b.campus_key, b.campus_nome, b.municipio||'', b.descricao_posto||'', b.label_resumo||b.campus_nome, (maxOrdem?.m||0)+1);
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.put('/postos/:id', (req, res) => {
  const b = req.body;
  req.db.prepare(`
    UPDATE bol_postos SET campus_key=?, campus_nome=?, municipio=?, descricao_posto=?, label_resumo=?, ordem=?
    WHERE id=?
  `).run(b.campus_key, b.campus_nome, b.municipio||'', b.descricao_posto||'', b.label_resumo||'', b.ordem||0, req.params.id);
  res.json({ ok: true });
});

router.delete('/postos/:id', (req, res) => {
  req.db.prepare('DELETE FROM bol_postos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── ITENS — CRUD ─────────────────────────────────────────────

router.post('/postos/:id/itens', (req, res) => {
  const b = req.body;
  const maxOrdem = req.db.prepare('SELECT COALESCE(MAX(ordem),0) as m FROM bol_itens WHERE posto_id=?').get(req.params.id);
  const r = req.db.prepare(`
    INSERT INTO bol_itens (posto_id, descricao, quantidade, valor_unitario, ordem)
    VALUES (?,?,?,?,?)
  `).run(req.params.id, b.descricao, b.quantidade||1, b.valor_unitario||0, (maxOrdem?.m||0)+1);
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.put('/itens/:id', (req, res) => {
  const b = req.body;
  req.db.prepare('UPDATE bol_itens SET descricao=?, quantidade=?, valor_unitario=?, ordem=? WHERE id=?')
    .run(b.descricao, b.quantidade||1, b.valor_unitario||0, b.ordem||0, req.params.id);
  res.json({ ok: true });
});

router.delete('/itens/:id', (req, res) => {
  req.db.prepare('DELETE FROM bol_itens WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── BOLETINS — HISTÓRICO ─────────────────────────────────────

router.get('/historico', (req, res) => {
  const rows = req.db.prepare(`
    SELECT b.*, c.nome as contrato_nome, c.contratante
    FROM bol_boletins b
    JOIN bol_contratos c ON c.id = b.contrato_id
    ORDER BY b.created_at DESC
  `).all();
  for (const r of rows) {
    r.nfs = req.db.prepare(`
      SELECT bn.*, bp.campus_nome, bp.municipio
      FROM bol_boletins_nfs bn
      LEFT JOIN bol_postos bp ON bp.id = bn.posto_id
      WHERE bn.boletim_id = ?
    `).all(r.id);
  }
  res.json(rows);
});

// ─── GERAR BOLETINS (PDF) ─────────────────────────────────────

router.post('/gerar', (req, res) => {
  try {
    const { contrato_id, competencia, data_emissao, notas_fiscais } = req.body;
    // notas_fiscais = [{ posto_id: X, nf_numero: "440" }, ...]

    const contrato = req.db.prepare('SELECT * FROM bol_contratos WHERE id = ?').get(contrato_id);
    if (!contrato) return res.status(404).json({ error: 'Contrato não encontrado' });

    const postos = req.db.prepare('SELECT * FROM bol_postos WHERE contrato_id = ? ORDER BY ordem').all(contrato_id);
    for (const p of postos) {
      p.itens = req.db.prepare('SELECT * FROM bol_itens WHERE posto_id = ? ORDER BY ordem').all(p.id);
    }

    const periodo = calcularPeriodo(competencia);
    const ano = competencia.trim().split(/\s+/).pop();

    // Criar diretório de saída
    const outputDir = path.join(__dirname, '..', '..', 'data', req.companyKey, 'boletins',
      competencia.toLowerCase().replace(/\s+/g, '_'));
    fs.mkdirSync(outputDir, { recursive: true });

    // Registrar boletim no banco
    const bolResult = req.db.prepare(`
      INSERT INTO bol_boletins (contrato_id, competencia, data_emissao, periodo_inicio, periodo_fim)
      VALUES (?,?,?,?,?)
    `).run(contrato_id, competencia, data_emissao, '', '');
    const boletimId = bolResult.lastInsertRowid;

    const nfMap = {};
    for (const nf of notas_fiscais) {
      nfMap[nf.posto_id] = nf.nf_numero;
    }

    let totalGeral = 0;
    const dadosResumo = [];

    // Gerar PDF de cada posto
    for (const posto of postos) {
      const nfNumero = nfMap[posto.id];
      if (!nfNumero) continue;

      const cidadeArq = posto.municipio.split('/')[0].trim();
      const filename = `Boletim NF ${nfNumero} - ${cidadeArq}.pdf`;
      const filepath = path.join(outputDir, filename);

      const totalPosto = gerarBoletimPDF(contrato, posto, nfNumero, data_emissao, periodo, filepath);
      totalGeral += totalPosto;

      // Registrar NF no banco
      req.db.prepare(`
        INSERT INTO bol_boletins_nfs (boletim_id, posto_id, nf_numero, valor_total, arquivo_pdf)
        VALUES (?,?,?,?,?)
      `).run(boletimId, posto.id, nfNumero, totalPosto, filepath);

      dadosResumo.push({ label: posto.label_resumo || posto.campus_nome, valor: totalPosto });
    }

    // Gerar resumo
    const parts = competencia.trim().split(/\s+/);
    const mesCapitalizado = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    const resumoFilename = `Resumo Faturamento ${contrato.nome} ${mesCapitalizado} ${ano}.pdf`;
    const resumoPath = path.join(outputDir, resumoFilename);
    gerarResumoPDF(dadosResumo, contrato, ano, resumoPath);

    // Atualizar total
    req.db.prepare('UPDATE bol_boletins SET total_geral = ? WHERE id = ?').run(totalGeral, boletimId);

    res.json({
      ok: true,
      boletim_id: boletimId,
      total_geral: totalGeral,
      pdfs_gerados: postos.filter(p => nfMap[p.id]).length + 1,
      diretorio: outputDir
    });
  } catch (err) {
    console.error('Erro ao gerar boletins:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GERAR BOLETIM (Novo endpoint — cria registro no banco) ───

const MESES_NOME_COMPLETO = ['','Janeiro','Fevereiro','Março','Abril','Maio','Junho',
  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

router.post('/gerar-boletim', (req, res) => {
  try {
    const { contrato_id, competencia } = req.body; // competencia = "2026-03"
    if (!contrato_id || !competencia) {
      return res.status(400).json({ error: 'contrato_id e competencia são obrigatórios' });
    }
    const db = req.db;

    // Verificar se já existe
    const existente = db.prepare('SELECT * FROM bol_boletins WHERE contrato_id=? AND competencia=?').get(contrato_id, competencia);
    if (existente) return res.json({ data: existente, novo: false });

    // Buscar contrato de boletim para calcular valor base
    const bc = db.prepare('SELECT * FROM bol_contratos WHERE id=?').get(contrato_id);
    const ct = bc ? db.prepare('SELECT * FROM contratos WHERE numContrato=?').get(bc.contrato_ref) : null;
    const valor_mensal = ct?.valor_mensal_bruto || 0;
    const valor_base = Math.round(valor_mensal * 100) / 100;

    // Gerar discriminação automática
    const [ano, mes] = competencia.split('-');
    const mesNome = MESES_NOME_COMPLETO[parseInt(mes)] || mes;
    const tipoServico = bc?.descricao_servico || ct?.contrato || 'SERVIÇOS';
    const numContrato = bc?.contrato_ref || bc?.numero_contrato || '';
    const discriminacao = `PRESTAÇÃO DE SERVIÇOS DE ${tipoServico.toUpperCase()} CONFORME CONTRATO Nº ${numContrato}, COMPETÊNCIA ${mesNome.toUpperCase()}/${ano}. VALOR MENSAL CONFORME BOLETIM DE MEDIÇÃO APROVADO.`;

    const stmt = db.prepare(`INSERT INTO bol_boletins
      (contrato_id, competencia, data_emissao, valor_base, valor_total, glosas, acrescimos, discriminacao, status, nfse_status)
      VALUES (?, ?, date('now'), ?, ?, 0, 0, ?, 'rascunho', 'PENDENTE')`);
    const info = stmt.run(contrato_id, competencia, valor_base, valor_base, discriminacao);
    const novo = db.prepare('SELECT * FROM bol_boletins WHERE id=?').get(info.lastInsertRowid);
    res.json({ data: novo, novo: true });
  } catch (err) {
    console.error('Erro ao gerar boletim:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── AJUSTAR BOLETIM (glosas, acréscimos, discriminação) ───────

router.patch('/:id/ajustar', (req, res) => {
  try {
    const db = req.db;
    const { glosas, acrescimos, discriminacao, obs } = req.body;
    const bol = db.prepare('SELECT * FROM bol_boletins WHERE id=?').get(req.params.id);
    if (!bol) return res.status(404).json({ error: 'Boletim não encontrado' });

    const g = parseFloat(glosas ?? bol.glosas ?? 0);
    const a = parseFloat(acrescimos ?? bol.acrescimos ?? 0);
    const base = bol.valor_base || bol.valor_total || 0;
    const novo_total = Math.round((base - g + a) * 100) / 100;

    db.prepare(`UPDATE bol_boletins SET
      glosas=?, acrescimos=?, valor_total=?,
      discriminacao=COALESCE(?,discriminacao), obs=COALESCE(?,obs),
      updated_at=datetime('now')
      WHERE id=?`).run(g, a, novo_total, discriminacao || null, obs || null, req.params.id);

    res.json({ data: db.prepare('SELECT * FROM bol_boletins WHERE id=?').get(req.params.id) });
  } catch (err) {
    console.error('Erro ao ajustar boletim:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── EMITIR NFS-e VIA WEBISS ───────────────────────────────────

router.post('/:id/emitir-nfse', async (req, res) => {
  const db = req.db;
  const company = req.company;
  const companyKey = req.companyKey;

  try {
    const bol = db.prepare(`
      SELECT b.*, bc.contrato_ref, bc.orgao, bc.descricao_servico as bc_descricao,
             bc.insc_municipal as insc_contratante,
             c.numContrato, c.orgao as orgao_contrato
      FROM bol_boletins b
      JOIN bol_contratos bc ON b.contrato_id = bc.id
      LEFT JOIN contratos c ON bc.contrato_ref = c.numContrato
      WHERE b.id=?`).get(req.params.id);

    if (!bol) return res.status(404).json({ error: 'Boletim não encontrado' });
    if (bol.nfse_status === 'EMITIDA') {
      return res.status(400).json({ error: `NFS-e ${bol.nfse_numero} já emitida para este boletim` });
    }
    if (!bol.valor_total || bol.valor_total <= 0) {
      return res.status(400).json({ error: 'Valor do boletim inválido (zero ou negativo)' });
    }

    // Verificar certificado
    const certPath = path.join(__dirname, '..', '..', 'certificados', `${companyKey}.pfx`);
    const certSenha = process.env[`WEBISS_CERT_SENHA_${companyKey.toUpperCase()}`];
    if (!fs.existsSync(certPath)) {
      return res.status(400).json({ error: `Certificado A1 não encontrado para ${companyKey}. Faça upload em Configurações → WebISS.` });
    }
    if (!certSenha) {
      return res.status(400).json({ error: `Senha do certificado não configurada (WEBISS_CERT_SENHA_${companyKey.toUpperCase()} no .env)` });
    }

    // Inscrição municipal da prestadora
    const inscPrestadora = process.env[`WEBISS_INSC_${companyKey.toUpperCase()}`] || '';
    if (!inscPrestadora) {
      return res.status(400).json({ error: `Inscrição Municipal não configurada (WEBISS_INSC_${companyKey.toUpperCase()} no .env)` });
    }

    // Número do RPS único baseado no id do boletim
    const rpsNum = String(bol.id).padStart(10, '0');
    const today  = new Date().toISOString().substring(0, 10);

    // Competência no formato YYYY-MM-DD (primeiro dia do mês)
    const competenciaData = bol.competencia.length === 7
      ? `${bol.competencia}-01`
      : bol.competencia;

    // Alíquota ISS — 2% padrão (contratos federais isentos/suspensos; municipais 3%)
    // O campo IssRetido=2 indica ISS NÃO retido pelo tomador
    const aliqISS = 0.02;
    const valorISS = Math.round(bol.valor_total * aliqISS * 100) / 100;

    // Tomador: usar CNPJ do insc_contratante ou razão social do órgão
    const tomadorCnpj = (bol.insc_contratante || '').replace(/\D/g, '');
    const tomadorRazao = bol.orgao || bol.orgao_contrato || 'TOMADOR';

    // Registrar tentativa
    db.prepare(`UPDATE bol_boletins SET nfse_status='ENVIANDO', nfse_erro=NULL, updated_at=datetime('now') WHERE id=?`)
      .run(bol.id);

    // Fazer chamada interna ao /api/webiss/emitir
    const port = process.env.PORT || 3002;
    const token = req.headers.authorization || '';

    const rpsBody = {
      rps: {
        numero:       rpsNum,
        serie:        'A',
        tipo:         1,
        dataEmissao:  today,
        competencia:  competenciaData,
        servico: {
          valorServicos:     bol.valor_total,
          valorDeducoes:     0,
          valorPis:          0,
          valorCofins:       0,
          valorInss:         0,
          valorIr:           0,
          valorCsll:         0,
          issRetido:         false,
          valorIss:          valorISS,
          aliquota:          aliqISS,
          itemLista:         '07.17',
          codTributacao:     '070700',
          discriminacao:     (bol.discriminacao || 'PRESTAÇÃO DE SERVIÇOS').substring(0, 2000),
          exigibilidadeIss:  1,
        },
        tomador: {
          cnpj:        tomadorCnpj || undefined,
          razaoSocial: tomadorRazao,
          email:       '',
        },
      },
    };

    const response = await fetch(`http://127.0.0.1:${port}/api/webiss/emitir`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': token,
        'X-Company':     companyKey,
      },
      body: JSON.stringify(rpsBody),
      signal: AbortSignal.timeout(60000),
    });

    const result = await response.json();

    if (result.ok && result.nfse?.numero) {
      const nfseNum = result.nfse.numero;
      db.prepare(`UPDATE bol_boletins SET
        nfse_status='EMITIDA', nfse_numero=?, nfse_data_emissao=datetime('now'),
        nfse_xml=?, nfse_erro=NULL, status='aprovado', updated_at=datetime('now')
        WHERE id=?`).run(nfseNum, JSON.stringify(result.nfse), bol.id);
      return res.json({
        ok: true,
        numero_nfse: nfseNum,
        message: `NFS-e ${nfseNum} emitida com sucesso!`,
        nfse: result.nfse,
      });
    }

    // Tratar erros retornados pelo WebISS
    let erroMsg = 'Erro desconhecido ao emitir NFS-e';
    if (result.erros?.length) {
      erroMsg = result.erros.map(e => `[${e.codigo}] ${e.mensagem}${e.correcao ? ' — ' + e.correcao : ''}`).join(' | ');
    } else if (result.error) {
      erroMsg = result.error;
    }

    db.prepare(`UPDATE bol_boletins SET nfse_status='ERRO', nfse_erro=?, updated_at=datetime('now') WHERE id=?`)
      .run(erroMsg, bol.id);
    return res.status(422).json({ error: erroMsg, detalhes: result });

  } catch (e) {
    console.error('Erro ao emitir NFS-e:', e);
    const erroMsg = e.message || String(e);
    try {
      db.prepare(`UPDATE bol_boletins SET nfse_status='ERRO', nfse_erro=?, updated_at=datetime('now') WHERE id=?`)
        .run(erroMsg, req.params.id);
    } catch (_) {}
    res.status(500).json({ error: 'Falha na emissão: ' + erroMsg });
  }
});

// ─── DOWNLOAD PDF ──────────────────────────────────────────────

router.get('/download/:boletimNfId', (req, res) => {
  const nf = req.db.prepare('SELECT * FROM bol_boletins_nfs WHERE id = ?').get(req.params.boletimNfId);
  if (!nf || !nf.arquivo_pdf) return res.status(404).json({ error: 'PDF não encontrado' });
  if (!fs.existsSync(nf.arquivo_pdf)) return res.status(404).json({ error: 'Arquivo não existe no disco' });
  res.download(nf.arquivo_pdf);
});

// ═══════════════════════════════════════════════════════════════
// GERAÇÃO DE PDFs COM PDFKIT
// ═══════════════════════════════════════════════════════════════

const AZUL_ESCURO = '#2C3E6B';
const CINZA_CLARO = '#F5F5F5';
const CINZA_BORDA = '#CCCCCC';

function gerarBoletimPDF(contrato, posto, nfNumero, dataEmissao, periodo, outputPath) {
  const doc = new PDFDocument({ size: 'A4', margin: 30 });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  const pageW = doc.page.width;
  const margin = 30;
  const contentW = pageW - 2 * margin;

  // ─── CABEÇALHO AZUL ───
  doc.rect(margin, 30, contentW, 85).fill(AZUL_ESCURO);

  doc.fill('#FFFFFF').fontSize(18).font('Helvetica-Bold')
     .text('BOLETIM MENSAL', margin, 42, { width: contentW, align: 'center' });

  // Linha separadora
  doc.moveTo(margin + 40, 65).lineTo(margin + contentW - 40, 65)
     .strokeColor('#FFFFFF').lineWidth(0.5).stroke();

  const textoEmpresa = `${contrato.empresa_razao}    CNPJ: ${contrato.empresa_cnpj}`;
  doc.fontSize(9).font('Helvetica-Bold')
     .text(textoEmpresa, margin, 72, { width: contentW, align: 'center' });

  doc.fontSize(7.5).font('Helvetica')
     .text(contrato.empresa_endereco, margin, 85, { width: contentW, align: 'center' });

  doc.text(`E-mail: ${contrato.empresa_email}  /  Telefone: ${contrato.empresa_telefone}`,
           margin, 96, { width: contentW, align: 'center' });

  // ─── BLOCO DE DADOS DO CONTRATO ───
  const blocoY = 130;
  const blocoH = 130;
  doc.rect(margin, blocoY, contentW, blocoH).strokeColor(CINZA_BORDA).lineWidth(0.5).stroke();

  let y = blocoY + 15;
  const lx = margin + 8;

  function field(label, value) {
    doc.fill('#000000').font('Helvetica-Bold').fontSize(9).text(label + ':', lx, y, { continued: true });
    doc.font('Helvetica').text(' ' + value);
    y += 16;
  }
  function fieldSmall(label, value) {
    doc.fill('#000000').font('Helvetica').fontSize(8.5).text(label + ': ' + value, lx, y);
    y += 14;
  }

  field('CONTRATANTE', contrato.contratante);
  field('CONTRATO', contrato.numero_contrato);
  fieldSmall('PROCESSO', contrato.processo);
  fieldSmall('PREGÃO ELETRÔNICO', contrato.pregao);
  fieldSmall('POSTO', posto.campus_nome);
  y += 2;
  field('PERÍODO', periodo);
  field('MUNICÍPIO', posto.municipio);

  // ─── NOTA FISCAL ───
  const nfY = blocoY + blocoH + 15;
  doc.rect(margin, nfY, contentW, 22).fill(CINZA_CLARO);
  doc.fill('#000000').font('Helvetica-Bold').fontSize(10)
     .text(`NOTA FISCAL: ${nfNumero}`, margin + 10, nfY + 5)
     .text(`DATA DE EMISSÃO: ${dataEmissao}`, pageW / 2 + 30, nfY + 5);

  // ─── TABELA DE ITENS ───
  const tableY = nfY + 35;
  const colWidths = [contentW * 0.42, contentW * 0.12, contentW * 0.23, contentW * 0.23];
  const headers = ['ITEM', 'QTD.', 'VALOR UNITÁRIO', 'VALOR TOTAL'];

  // Header da tabela
  let tx = margin;
  doc.rect(margin, tableY, contentW, 20).fill(AZUL_ESCURO);
  doc.fill('#FFFFFF').font('Helvetica-Bold').fontSize(8);
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i], tx + 4, tableY + 5, { width: colWidths[i] - 8, align: 'center' });
    tx += colWidths[i];
  }

  // Linhas de dados
  let rowY = tableY + 20;
  let totalPosto = 0;

  for (let idx = 0; idx < posto.itens.length; idx++) {
    const item = posto.itens[idx];
    const vt = item.quantidade * item.valor_unitario;
    totalPosto += vt;

    // Zebra stripes
    if (idx % 2 === 1) {
      doc.rect(margin, rowY, contentW, 28).fill(CINZA_CLARO);
    }

    tx = margin;
    doc.fill('#000000').font('Helvetica').fontSize(8);

    // Descrição (com wrap)
    const descH = doc.heightOfString(item.descricao, { width: colWidths[0] - 12 });
    const rowH = Math.max(descH + 10, 28);

    doc.text(item.descricao, tx + 6, rowY + 5, { width: colWidths[0] - 12 });
    tx += colWidths[0];

    doc.text(String(item.quantidade), tx + 4, rowY + 8, { width: colWidths[1] - 8, align: 'center' });
    tx += colWidths[1];

    doc.text(formatMoeda(item.valor_unitario), tx + 4, rowY + 8, { width: colWidths[2] - 8, align: 'right' });
    tx += colWidths[2];

    doc.text(formatMoeda(vt), tx + 4, rowY + 8, { width: colWidths[3] - 8, align: 'right' });

    // Bordas da linha
    doc.rect(margin, rowY, contentW, rowH).strokeColor(CINZA_BORDA).lineWidth(0.3).stroke();
    rowY += rowH;
  }

  // Linha TOTAL
  rowY += 4;
  doc.font('Helvetica-Bold').fontSize(9).fill('#000000');
  const totalX = margin + colWidths[0] + colWidths[1];
  doc.text('TOTAL:', totalX + 4, rowY, { width: colWidths[2] - 8, align: 'right' });
  doc.text(formatMoeda(totalPosto), totalX + colWidths[2] + 4, rowY, { width: colWidths[3] - 8, align: 'right' });

  // ─── DESCRIÇÃO DO SERVIÇO ───
  rowY += 25;
  doc.font('Helvetica-Bold').fontSize(9).text('DESCRIÇÃO DO SERVIÇO:', margin + 5, rowY);
  rowY += 5;
  doc.font('Helvetica').fontSize(8).text(contrato.descricao_servico, margin + 5, rowY + 8, { width: contentW - 10 });
  rowY = doc.y + 10;

  doc.font('Helvetica-Bold').fontSize(9)
     .text('DESCRIÇÃO DO POSTO: ', margin + 5, rowY, { continued: true });
  doc.font('Helvetica').text(posto.descricao_posto);
  rowY = doc.y + 5;

  doc.font('Helvetica-Bold').fontSize(9)
     .text('ESCALA: ', margin + 5, rowY, { continued: true });
  doc.font('Helvetica').text(contrato.escala + '.');

  // ─── CAMPOS DE ASSINATURA ───
  const sigY = doc.page.height - 100;
  const sigW = (contentW - 20) / 3;
  const labels = ['FORNECEDOR', 'FISCALIZAÇÃO', 'APROVADO'];

  for (let i = 0; i < labels.length; i++) {
    const x = margin + i * (sigW + 10);
    doc.rect(x, sigY, sigW, 60).strokeColor(CINZA_BORDA).lineWidth(0.5).stroke();
    // Linha de assinatura
    doc.moveTo(x + 15, sigY + 40).lineTo(x + sigW - 15, sigY + 40).stroke();
    // Label
    doc.fill('#000000').font('Helvetica').fontSize(8)
       .text(labels[i], x, sigY + 45, { width: sigW, align: 'center' });
  }

  doc.end();
  return totalPosto;
}

function gerarResumoPDF(dadosResumo, contrato, ano, outputPath) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  const pageW = doc.page.width;
  const margin = 40;
  const contentW = pageW - 2 * margin;

  // Título
  const titulo = `RESUMO DO FATURAMENTO - ${contrato.contratante} - ${ano}.`;
  doc.font('Helvetica-Bold').fontSize(11)
     .text(titulo, margin, 60, { width: contentW, align: 'center' });

  // Tabela
  const tableY = 100;
  const colWidths = [50, 180, 130, 180];
  const headers = ['QTD.', 'POSTOS', 'TOTAL MENSAL', 'LOCAL DO POSTO'];

  // Header
  let tx = margin;
  doc.rect(margin, tableY, contentW, 22).fill(CINZA_CLARO);
  doc.fill('#000000').font('Helvetica-Bold').fontSize(9);
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i], tx + 4, tableY + 5, { width: colWidths[i] - 8, align: 'center' });
    tx += colWidths[i];
  }

  let rowY = tableY + 22;
  let totalMensal = 0;

  for (let idx = 0; idx < dadosResumo.length; idx++) {
    const item = dadosResumo[idx];
    totalMensal += item.valor;
    tx = margin;

    doc.fill('#000000').font('Helvetica').fontSize(9);
    doc.text(String(idx + 1), tx + 4, rowY + 6, { width: colWidths[0] - 8, align: 'center' });
    tx += colWidths[0];
    doc.text(item.label, tx + 4, rowY + 6, { width: colWidths[1] - 8 });
    tx += colWidths[1];
    doc.text(formatMoeda(item.valor), tx + 4, rowY + 6, { width: colWidths[2] - 8, align: 'center' });
    tx += colWidths[2];
    doc.text(item.label, tx + 4, rowY + 6, { width: colWidths[3] - 8, align: 'center' });

    doc.rect(margin, rowY, contentW, 24).strokeColor('#000000').lineWidth(0.3).stroke();
    rowY += 24;
  }

  // Total
  rowY += 2;
  doc.rect(margin, rowY, contentW, 24).strokeColor('#000000').lineWidth(0.5).stroke();
  tx = margin + colWidths[0];
  doc.font('Helvetica-Bold').fontSize(9);
  doc.text('Total Mensal', tx + 4, rowY + 6, { width: colWidths[1] - 8, align: 'right' });
  tx += colWidths[1];
  doc.text(formatMoeda(totalMensal), tx + 4, rowY + 6, { width: colWidths[2] - 8, align: 'center' });

  doc.end();
  return totalMensal;
}

module.exports = router;
