/**
 * Montana Multi-Empresa — Módulo de Boletins de Medição
 * CRUD de contratos, postos, itens + geração de PDFs
 */
const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

// ─── INIT: Adicionar colunas extras nas tabelas de boletins ────

router.use(async (req, res, next) => {
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
    ['updated_at',        "TIMESTAMP DEFAULT NOW()"],
  ];
  for (const [col, def] of bolCols) {
    try { await db.prepare(`ALTER TABLE bol_boletins ADD COLUMN ${col} ${def}`).run(); } catch (_) {}
  }

  // Colunas adicionais na tabela bol_contratos (necessárias para vinculação contrato financeiro + NFS-e)
  const contrCols = [
    ['contrato_ref',    "TEXT DEFAULT ''"],  // numContrato da tabela contratos
    ['orgao',           "TEXT DEFAULT ''"],  // razão social do tomador para NFS-e
    ['insc_municipal',  "TEXT DEFAULT ''"],  // CNPJ do tomador (campo nomenclatura WebISS)
  ];
  for (const [col, def] of contrCols) {
    try { await db.prepare(`ALTER TABLE bol_contratos ADD COLUMN ${col} ${def}`).run(); } catch (_) {}
  }

  next();
});

// ─── HELPERS ──────────────────────────────────────────────────

function formatCnpj(raw) {
  const c = (raw || '').replace(/\D/g, '');
  if (c.length !== 14) return raw || '';
  return `${c.slice(0,2)}.${c.slice(2,5)}.${c.slice(5,8)}/${c.slice(8,12)}-${c.slice(12)}`;
}

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

router.get('/contratos', async (req, res) => {
  const rows = await req.db.prepare('SELECT * FROM bol_contratos ORDER BY ativo DESC, nome ASC').all();
  res.json(rows);
});

router.get('/contratos/:id', async (req, res) => {
  const c = await req.db.prepare('SELECT * FROM bol_contratos WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Contrato não encontrado' });
  // Incluir postos e itens
  const postos = await req.db.prepare('SELECT * FROM bol_postos WHERE contrato_id = ? ORDER BY ordem').all(c.id);
  for (const p of postos) {
    p.itens = await req.db.prepare('SELECT * FROM bol_itens WHERE posto_id = ? ORDER BY ordem').all(p.id);
  }
  c.postos = postos;
  res.json(c);
});

router.post('/contratos', async (req, res) => {
  const b = req.body;
  const r = await req.db.prepare(`
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

router.put('/contratos/:id', async (req, res) => {
  const b = req.body;
  // FIX2: inclui contrato_ref, orgao (CNPJ tomador), insc_municipal
  await req.db.prepare(`
    UPDATE bol_contratos SET nome=?, contratante=?, numero_contrato=?, processo=?, pregao=?,
      descricao_servico=?, escala=?, empresa_razao=?, empresa_cnpj=?, empresa_endereco=?,
      empresa_email=?, empresa_telefone=?,
      contrato_ref=?, orgao=?, insc_municipal=?,
      updated_at=NOW()
    WHERE id=?
  `).run(
    b.nome, b.contratante, b.numero_contrato, b.processo||'', b.pregao||'',
    b.descricao_servico||'', b.escala||'12x36', b.empresa_razao||'',
    b.empresa_cnpj||'', b.empresa_endereco||'', b.empresa_email||'', b.empresa_telefone||'',
    b.contrato_ref||'', b.orgao||'', b.insc_municipal||'',
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/contratos/:id', async (req, res) => {
  await req.db.prepare('DELETE FROM bol_contratos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── POSTOS — CRUD ────────────────────────────────────────────

router.get('/contratos/:id/postos', async (req, res) => {
  const postos = await req.db.prepare('SELECT * FROM bol_postos WHERE contrato_id = ? ORDER BY ordem').all(req.params.id);
  for (const p of postos) {
    p.itens = await req.db.prepare('SELECT * FROM bol_itens WHERE posto_id = ? ORDER BY ordem').all(p.id);
  }
  res.json(postos);
});

router.post('/contratos/:id/postos', async (req, res) => {
  const b = req.body;
  const maxOrdem = await req.db.prepare('SELECT COALESCE(MAX(ordem),0) as m FROM bol_postos WHERE contrato_id=?').get(req.params.id);
  const r = await req.db.prepare(`
    INSERT INTO bol_postos (contrato_id, campus_key, campus_nome, municipio, descricao_posto, label_resumo, ordem)
    VALUES (?,?,?,?,?,?,?)
  `).run(req.params.id, b.campus_key, b.campus_nome, b.municipio||'', b.descricao_posto||'', b.label_resumo||b.campus_nome, (maxOrdem?.m||0)+1);
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.put('/postos/:id', async (req, res) => {
  const b = req.body;
  await req.db.prepare(`
    UPDATE bol_postos SET campus_key=?, campus_nome=?, municipio=?, descricao_posto=?, label_resumo=?, ordem=?
    WHERE id=?
  `).run(b.campus_key, b.campus_nome, b.municipio||'', b.descricao_posto||'', b.label_resumo||'', b.ordem||0, req.params.id);
  res.json({ ok: true });
});

router.delete('/postos/:id', async (req, res) => {
  await req.db.prepare('DELETE FROM bol_postos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── ITENS — CRUD ─────────────────────────────────────────────

router.post('/postos/:id/itens', async (req, res) => {
  const b = req.body;
  const maxOrdem = await req.db.prepare('SELECT COALESCE(MAX(ordem),0) as m FROM bol_itens WHERE posto_id=?').get(req.params.id);
  const r = await req.db.prepare(`
    INSERT INTO bol_itens (posto_id, descricao, quantidade, valor_unitario, ordem)
    VALUES (?,?,?,?,?)
  `).run(req.params.id, b.descricao, b.quantidade||1, b.valor_unitario||0, (maxOrdem?.m||0)+1);
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.put('/itens/:id', async (req, res) => {
  const b = req.body;
  req.db.prepare('UPDATE bol_itens SET descricao=?, quantidade=?, valor_unitario=?, ordem=? WHERE id=?')
    .run(b.descricao, b.quantidade||1, b.valor_unitario||0, b.ordem||0, req.params.id);
  res.json({ ok: true });
});

router.delete('/itens/:id', async (req, res) => {
  await req.db.prepare('DELETE FROM bol_itens WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── BOLETINS — HISTÓRICO ─────────────────────────────────────

router.get('/historico', async (req, res) => {
  const rows = await req.db.prepare(`
    SELECT b.*, c.nome as contrato_nome, c.contratante
    FROM bol_boletins b
    JOIN bol_contratos c ON c.id = b.contrato_id
    ORDER BY b.created_at DESC
  `).all();
  for (const r of rows) {
    r.nfs = await req.db.prepare(`
      SELECT bn.*, bp.campus_nome, bp.municipio
      FROM bol_boletins_nfs bn
      LEFT JOIN bol_postos bp ON bp.id = bn.posto_id
      WHERE bn.boletim_id = ?
    `).all(r.id);
  }
  res.json(rows);
});

// ─── GERAR BOLETINS (PDF) ─────────────────────────────────────

router.post('/gerar', async (req, res) => {
  try {
    const { contrato_id, competencia, data_emissao, notas_fiscais } = req.body;
    // notas_fiscais = [{ posto_id: X, nf_numero: "440" }, ...]

    const contrato = await req.db.prepare('SELECT * FROM bol_contratos WHERE id = ?').get(contrato_id);
    if (!contrato) return res.status(404).json({ error: 'Contrato não encontrado' });

    const postos = await req.db.prepare('SELECT * FROM bol_postos WHERE contrato_id = ? ORDER BY ordem').all(contrato_id);
    for (const p of postos) {
      p.itens = await req.db.prepare('SELECT * FROM bol_itens WHERE posto_id = ? ORDER BY ordem').all(p.id);
    }

    const periodo = calcularPeriodo(competencia);
    const ano = competencia.trim().split(/\s+/).pop();

    // Criar diretório de saída
    const outputDir = path.join(__dirname, '..', '..', 'data', req.companyKey, 'boletins',
      competencia.toLowerCase().replace(/\s+/g, '_'));
    fs.mkdirSync(outputDir, { recursive: true });

    // Registrar boletim no banco
    const bolResult = await req.db.prepare(`
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
      await req.db.prepare(`
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
    await req.db.prepare('UPDATE bol_boletins SET total_geral = ? WHERE id = ?').run(totalGeral, boletimId);

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

router.post('/gerar-boletim', async (req, res) => {
  try {
    const { contrato_id, competencia } = req.body; // competencia = "2026-03"
    if (!contrato_id || !competencia) {
      return res.status(400).json({ error: 'contrato_id e competencia são obrigatórios' });
    }
    const db = req.db;

    // Verificar se já existe
    const existente = await db.prepare('SELECT * FROM bol_boletins WHERE contrato_id=? AND competencia=?').get(contrato_id, competencia);
    if (existente) return res.json({ data: existente, novo: false });

    // Buscar contrato de boletim para calcular valor base
    const bc = await db.prepare('SELECT * FROM bol_contratos WHERE id=?').get(contrato_id);
    const ct = bc ? await db.prepare('SELECT * FROM contratos WHERE numContrato=?').get(bc.contrato_ref) : null;
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
      VALUES (?, ?, CURRENT_DATE, ?, ?, 0, 0, ?, 'rascunho', 'PENDENTE')`);
    const info = stmt.run(contrato_id, competencia, valor_base, valor_base, discriminacao);
    const novo = await db.prepare('SELECT * FROM bol_boletins WHERE id=?').get(info.lastInsertRowid);
    res.json({ data: novo, novo: true });
  } catch (err) {
    console.error('Erro ao gerar boletim:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── AJUSTAR BOLETIM (glosas, acréscimos, discriminação) ───────

router.patch('/:id/ajustar', async (req, res) => {
  try {
    const db = req.db;
    const { glosas, acrescimos, discriminacao, obs } = req.body;
    const bol = await db.prepare('SELECT * FROM bol_boletins WHERE id=?').get(req.params.id);
    if (!bol) return res.status(404).json({ error: 'Boletim não encontrado' });

    const g = parseFloat(glosas ?? bol.glosas ?? 0);
    const a = parseFloat(acrescimos ?? bol.acrescimos ?? 0);
    const base = bol.valor_base || bol.valor_total || 0;
    const novo_total = Math.round((base - g + a) * 100) / 100;

    await db.prepare(`UPDATE bol_boletins SET
      glosas=?, acrescimos=?, valor_total=?,
      discriminacao=COALESCE(?,discriminacao), obs=COALESCE(?,obs),
      updated_at=NOW()
      WHERE id=?`).run(g, a, novo_total, discriminacao || null, obs || null, req.params.id);

    res.json({ data: await db.prepare('SELECT * FROM bol_boletins WHERE id=?').get(req.params.id) });
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
    // FIX1: COALESCE(valor_total, total_geral) — suporta boletins importados do legado
    // FIX2: JOIN duplo — tenta contrato_ref exato primeiro, fallback LIKE numero_contrato
    // FIX3: c.orgao = CNPJ do tomador; bc.contratante = razão social
    const bol = db.prepare(`
      SELECT b.*,
             COALESCE(b.valor_total, b.total_geral, 0) AS valor_efetivo,
             bc.contrato_ref, bc.contratante as bc_contratante,
             bc.orgao as bc_orgao, bc.descricao_servico as bc_descricao,
             bc.insc_municipal as insc_contratante,
             COALESCE(
               (SELECT c1.orgao FROM contratos c1 WHERE bc.contrato_ref != '' AND c1.numContrato = bc.contrato_ref LIMIT 1),
               (SELECT c2.orgao FROM contratos c2 WHERE c2.numContrato LIKE '%' || bc.numero_contrato LIMIT 1)
             ) AS cnpj_tomador_contrato,
             COALESCE(
               (SELECT c1.numContrato FROM contratos c1 WHERE bc.contrato_ref != '' AND c1.numContrato = bc.contrato_ref LIMIT 1),
               (SELECT c2.numContrato FROM contratos c2 WHERE c2.numContrato LIKE '%' || bc.numero_contrato LIMIT 1)
             ) AS num_contrato_encontrado
      FROM bol_boletins b
      JOIN bol_contratos bc ON b.contrato_id = bc.id
      WHERE b.id=?`).get(req.params.id);

    if (!bol) return res.status(404).json({ error: 'Boletim não encontrado' });
    if (bol.nfse_status === 'EMITIDA') {
      return res.status(400).json({ error: `NFS-e ${bol.nfse_numero} já emitida para este boletim` });
    }
    // FIX4: exige status 'aprovado' no backend (não só no frontend)
    if (bol.status !== 'aprovado') {
      return res.status(400).json({ error: `Boletim deve estar com status "aprovado" para emitir NFS-e (atual: ${bol.status})` });
    }
    if (!bol.valor_efetivo || bol.valor_efetivo <= 0) {
      return res.status(400).json({ error: 'Valor do boletim inválido (zero ou negativo) — ajuste o valor antes de emitir' });
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

    // FIX4: RPS idempotente — reutiliza rps_numero gravado se for retentativa
    // Garante coluna rps_numero
    try { await db.prepare(`ALTER TABLE bol_boletins ADD COLUMN rps_numero TEXT`).run(); } catch (_) {}
    const rpsNum = bol.rps_numero || String(bol.id).padStart(10, '0');
    // Persiste rps_numero imediatamente para garantir idempotência em retentativas
    if (!bol.rps_numero) {
      await db.prepare(`UPDATE bol_boletins SET rps_numero=? WHERE id=?`).run(rpsNum, bol.id);
    }

    const today  = new Date().toISOString().substring(0, 10);

    // Competência no formato YYYY-MM-DD (primeiro dia do mês)
    const competenciaData = bol.competencia.length === 7
      ? `${bol.competencia}-01`
      : bol.competencia;

    // Alíquota ISS — 2% padrão (contratos federais isentos/suspensos; municipais 3%)
    const aliqISS = 0.02;
    const valorISS = Math.round(bol.valor_efetivo * aliqISS * 100) / 100;

    // FIX3: CNPJ = c.orgao (contratos.orgao armazena CNPJ do tomador neste sistema)
    // Prioridade: insc_municipal (manual) > cnpj_tomador_contrato (join) > vazio
    const tomadorCnpj = (bol.insc_contratante || bol.cnpj_tomador_contrato || '').replace(/\D/g, '');
    // Razão social: bc_contratante (sempre preenchido) > bc_orgao > fallback
    const tomadorRazao = bol.bc_contratante || bol.bc_orgao || 'TOMADOR NÃO CONFIGURADO';

    if (!tomadorCnpj) {
      console.warn(`[boletins] Boletim #${bol.id}: tomadorCnpj vazio — WebISS pode rejeitar. Configure insc_municipal ou contrato_ref.`);
    }

    // Registrar tentativa
    await db.prepare(`UPDATE bol_boletins SET nfse_status='ENVIANDO', nfse_erro=NULL, updated_at=NOW() WHERE id=?`)
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
          valorServicos:     bol.valor_efetivo,
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
      const today   = new Date().toISOString().slice(0, 10);

      await db.prepare(`UPDATE bol_boletins SET
        nfse_status='EMITIDA', nfse_numero=?, nfse_data_emissao=NOW(),
        nfse_xml=?, nfse_erro=NULL, status='emitido', updated_at=NOW()
        WHERE id=?`).run(nfseNum, JSON.stringify(result.nfse), bol.id);

      // ── Auto-sync: cria NF em notas_fiscais se ainda não existe ──
      try {
        const jaExiste = await db.prepare(`SELECT id FROM notas_fiscais WHERE numero=? OR webiss_numero_nfse=?`).get(nfseNum, nfseNum);
        if (!jaExiste) {
          const nfse = result.nfse;
          // FIX1: usa valor_efetivo (COALESCE já aplicado) como fallback
          const valorBruto   = nfse.valorServicos  || bol.valor_efetivo || 0;
          // FIX: valorLiquido = bruto - TODAS as retenções (não só ISS)
          const totalRetencoes = (nfse.valorInss||0)+(nfse.valorIr||0)+(nfse.valorIss||0)+
                                 (nfse.valorCsll||0)+(nfse.valorPis||0)+(nfse.valorCofins||0);
          const valorLiquido = nfse.valorLiquido || nfse.valorLiquidoNfse
                                 || (valorBruto - totalRetencoes);
          const competencia  = bol.competencia;
          // FIX3: usa bc_contratante e cnpj_tomador_contrato resolvidos pelo JOIN
          const tomador      = bol.bc_contratante || tomadorRazao;
          const cnpjTomador  = tomadorCnpj ? formatCnpj(tomadorCnpj) : '';

          // Garante colunas webiss_numero_nfse e discriminacao
          try { await db.prepare(`ALTER TABLE notas_fiscais ADD COLUMN webiss_numero_nfse TEXT`).run(); } catch (_) {}
          try { await db.prepare(`ALTER TABLE notas_fiscais ADD COLUMN discriminacao TEXT`).run(); } catch (_) {}

          await db.prepare(`INSERT INTO notas_fiscais
            (numero, competencia, cidade, tomador, cnpj_tomador,
             valor_bruto, valor_liquido,
             inss, ir, iss, csll, pis, cofins, retencao,
             data_emissao, status_conciliacao,
             webiss_numero_nfse, discriminacao)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
              nfseNum,
              competencia,
              'Palmas/TO',
              tomador,
              cnpjTomador,
              +(valorBruto).toFixed(2),
              +(valorLiquido).toFixed(2),
              +(nfse.valorInss   || 0).toFixed(2),
              +(nfse.valorIr     || 0).toFixed(2),
              +(nfse.valorIss    || 0).toFixed(2),
              +(nfse.valorCsll   || 0).toFixed(2),
              +(nfse.valorPis    || 0).toFixed(2),
              +(nfse.valorCofins || 0).toFixed(2),
              +((nfse.valorInss||0)+(nfse.valorIr||0)+(nfse.valorIss||0)+(nfse.valorCsll||0)+(nfse.valorPis||0)+(nfse.valorCofins||0)).toFixed(2),
              today,
              'PENDENTE',
              nfseNum,
              bol.discriminacao || '',
          );
          console.log(`[boletins] Auto-sync NF ${nfseNum} → notas_fiscais`);
        }
      } catch (syncErr) {
        console.error('[boletins] Aviso: falha no auto-sync NF:', syncErr.message);
        // Não falha a resposta — NFS-e já foi emitida
      }

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

    await db.prepare(`UPDATE bol_boletins SET nfse_status='ERRO', nfse_erro=?, updated_at=NOW() WHERE id=?`)
      .run(erroMsg, bol.id);
    return res.status(422).json({ error: erroMsg, detalhes: result });

  } catch (e) {
    console.error('Erro ao emitir NFS-e:', e);
    const erroMsg = e.message || String(e);
    try {
      await db.prepare(`UPDATE bol_boletins SET nfse_status='ERRO', nfse_erro=?, updated_at=NOW() WHERE id=?`)
        .run(erroMsg, req.params.id);
    } catch (_) {}
    res.status(500).json({ error: 'Falha na emissão: ' + erroMsg });
  }
});

// ─── DOWNLOAD PDF ──────────────────────────────────────────────

router.get('/download/:boletimNfId', async (req, res) => {
  const nf = await req.db.prepare('SELECT * FROM bol_boletins_nfs WHERE id = ?').get(req.params.boletimNfId);
  if (!nf || !nf.arquivo_pdf) return res.status(404).json({ error: 'PDF não encontrado' });
  if (!fs.existsSync(nf.arquivo_pdf)) return res.status(404).json({ error: 'Arquivo não existe no disco' });
  res.download(nf.arquivo_pdf);
});

// ─── PACOTE FISCAL (ZIP: boletim PDF + NFS-e espelho + XML + ofício) ──
// Agrupa todos os artefatos do boletim para envio ao gestor/fiscal do contrato
router.get('/:id/pacote-fiscal.zip', async (req, res) => {
  try {
    const db = req.db;
    const bol = await db.prepare(`
      SELECT b.*, bc.nome AS contrato_nome, bc.contratante, bc.numero_contrato,
             bc.processo, bc.pregao, bc.orgao, bc.insc_municipal AS tomador_cnpj,
             bc.empresa_razao, bc.empresa_cnpj, bc.empresa_endereco,
             bc.empresa_email, bc.empresa_telefone
      FROM bol_boletins b
      JOIN bol_contratos bc ON b.contrato_id = bc.id
      WHERE b.id = ?
    `).get(req.params.id);

    if (!bol) return res.status(404).json({ error: 'Boletim não encontrado' });

    const nfs = await db.prepare(`
      SELECT bn.*, bp.campus_nome, bp.municipio
      FROM bol_boletins_nfs bn
      LEFT JOIN bol_postos bp ON bp.id = bn.posto_id
      WHERE bn.boletim_id = ?
      ORDER BY bp.ordem, bn.id
    `).all(bol.id);

    // Parse nfse_xml (armazenado como JSON stringified da resposta WebISS)
    let nfseObj = null;
    try { nfseObj = bol.nfse_xml ? JSON.parse(bol.nfse_xml) : null; } catch (_) { nfseObj = null; }

    const orgaoSlug = String(bol.contratante || bol.orgao || 'CONTRATANTE')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase().substring(0, 40);
    const compSlug = String(bol.competencia || 'SEM_COMP').replace(/\s+/g, '_');
    const nfseNum = bol.nfse_numero || 'SEM_NFSE';
    const zipName = `Pacote_Fiscal_${orgaoSlug}_${compSlug}_NFSe${nfseNum}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const zip = archiver('zip', { zlib: { level: 9 } });
    zip.on('error', err => {
      console.error('Erro no archiver:', err);
      try { res.status(500).end(); } catch (_) {}
    });
    zip.pipe(res);

    // 1. Boletins de medição (PDFs gerados por /gerar)
    let qtdBoletins = 0;
    for (const n of nfs) {
      if (n.arquivo_pdf && fs.existsSync(n.arquivo_pdf)) {
        const fileName = `1_Boletins_Medicao/${path.basename(n.arquivo_pdf)}`;
        zip.file(n.arquivo_pdf, { name: fileName });
        qtdBoletins++;
      }
    }

    // Resumo de faturamento (mesma pasta dos boletins)
    if (nfs.length && nfs[0].arquivo_pdf) {
      const dir = path.dirname(nfs[0].arquivo_pdf);
      if (fs.existsSync(dir)) {
        try {
          const files = fs.readdirSync(dir);
          for (const f of files) {
            if (/^Resumo Faturamento/i.test(f)) {
              zip.file(path.join(dir, f), { name: `1_Boletins_Medicao/${f}` });
            }
          }
        } catch (_) {}
      }
    }

    // 2. XML da NFS-e (resposta WebISS)
    if (nfseObj) {
      zip.append(JSON.stringify(nfseObj, null, 2), { name: `2_NFSe/nfse_${nfseNum}_response.json` });
      // Se tem campo xml específico
      if (nfseObj.xml) {
        zip.append(nfseObj.xml, { name: `2_NFSe/nfse_${nfseNum}.xml` });
      }
      if (nfseObj.xmlAssinado) {
        zip.append(nfseObj.xmlAssinado, { name: `2_NFSe/nfse_${nfseNum}_assinado.xml` });
      }
    }

    // 3. Espelho/DANFSE PDF gerado a partir dos dados
    const espelhoBuf = gerarEspelhoNFSePDFBuffer(bol, nfseObj, nfs);
    espelhoBuf.then(buf => {
      zip.append(buf, { name: `2_NFSe/Espelho_NFSe_${nfseNum}.pdf` });

      // 4. Ofício de encaminhamento
      const oficioBuf = gerarOficioEncaminhamentoBuffer(bol, nfseNum, nfs);
      oficioBuf.then(b2 => {
        zip.append(b2, { name: `3_Oficio/Oficio_Encaminhamento.pdf` });

        // 5. Resumo texto (README)
        const totalBol = Number(bol.valor_total || bol.total_geral || 0);
        const readme = [
          `PACOTE FISCAL — ${bol.contrato_nome}`,
          `Competência: ${bol.competencia}`,
          `Contratante: ${bol.contratante}`,
          `Contrato Nº: ${bol.numero_contrato || '-'}`,
          `NFS-e Nº: ${nfseNum}`,
          `Data Emissão: ${bol.nfse_data_emissao || '-'}`,
          `Valor total: R$ ${totalBol.toLocaleString('pt-BR',{minimumFractionDigits:2})}`,
          `Boletins incluídos: ${qtdBoletins}`,
          ``,
          `Conteúdo:`,
          `  1_Boletins_Medicao/  — boletins de medição em PDF`,
          `  2_NFSe/              — XML + espelho da NFS-e`,
          `  3_Oficio/            — ofício de encaminhamento`,
          ``,
          `Empresa emitente: ${bol.empresa_razao || '-'}`,
          `CNPJ: ${bol.empresa_cnpj || '-'}`,
          `Contato: ${bol.empresa_email || '-'} / ${bol.empresa_telefone || '-'}`,
          ``,
          `Gerado automaticamente pelo Sistema Montana em ${new Date().toLocaleString('pt-BR')}.`,
        ].join('\n');
        zip.append(readme, { name: 'LEIA-ME.txt' });

        zip.finalize();
      }).catch(e => {
        console.error('Erro ao gerar ofício:', e);
        zip.finalize();
      });
    }).catch(e => {
      console.error('Erro ao gerar espelho NFS-e:', e);
      zip.finalize();
    });
  } catch (err) {
    console.error('Erro ao gerar pacote fiscal:', err);
    try { res.status(500).json({ error: err.message }); } catch (_) {}
  }
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

// ─── PDF helpers: Espelho NFS-e e Ofício (usam buffer em memória) ──

function pdfToBuffer(builder) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      builder(doc);
      doc.end();
    } catch (e) { reject(e); }
  });
}

function gerarEspelhoNFSePDFBuffer(bol, nfseObj, nfs) {
  return pdfToBuffer(doc => {
    const margin = 40;
    const contentW = doc.page.width - 2 * margin;

    // Cabeçalho
    doc.rect(margin, margin, contentW, 60).fill(AZUL_ESCURO);
    doc.fill('#FFFFFF').font('Helvetica-Bold').fontSize(14)
       .text('ESPELHO DE NFS-e', margin, margin + 12, { width: contentW, align: 'center' });
    doc.fontSize(9).font('Helvetica')
       .text('Documento auxiliar — consulte a NFS-e oficial no portal da Prefeitura', margin, margin + 34, { width: contentW, align: 'center' });

    let y = margin + 80;
    doc.fill('#000000').font('Helvetica-Bold').fontSize(10);

    function linha(label, valor) {
      doc.font('Helvetica-Bold').fontSize(9).text(label + ':', margin, y, { continued: true });
      doc.font('Helvetica').text(' ' + (valor || '—'));
      y = doc.y + 4;
    }

    linha('Número da NFS-e', bol.nfse_numero);
    linha('Data de Emissão', bol.nfse_data_emissao);
    linha('Código de Verificação', nfseObj?.codigoVerificacao || nfseObj?.codVerificacao || '—');

    y += 8;
    doc.rect(margin, y, contentW, 20).fill(CINZA_CLARO);
    doc.fill('#000000').font('Helvetica-Bold').fontSize(10).text('PRESTADOR DE SERVIÇOS', margin + 6, y + 5);
    y += 26;
    linha('Razão Social', bol.empresa_razao);
    linha('CNPJ', bol.empresa_cnpj);
    linha('Endereço', bol.empresa_endereco);
    linha('E-mail / Telefone', `${bol.empresa_email || '-'} / ${bol.empresa_telefone || '-'}`);

    y += 6;
    doc.rect(margin, y, contentW, 20).fill(CINZA_CLARO);
    doc.fill('#000000').font('Helvetica-Bold').fontSize(10).text('TOMADOR DE SERVIÇOS', margin + 6, y + 5);
    y += 26;
    linha('Razão Social', bol.orgao || bol.contratante);
    linha('CNPJ', bol.tomador_cnpj);
    linha('Contrato', `${bol.numero_contrato || '-'}  (Processo ${bol.processo || '-'})`);

    y += 6;
    doc.rect(margin, y, contentW, 20).fill(CINZA_CLARO);
    doc.fill('#000000').font('Helvetica-Bold').fontSize(10).text('DISCRIMINAÇÃO DO SERVIÇO', margin + 6, y + 5);
    y += 26;
    doc.font('Helvetica').fontSize(9)
       .text(bol.discriminacao || 'PRESTAÇÃO DE SERVIÇOS', margin, y, { width: contentW, align: 'justify' });
    y = doc.y + 10;

    y += 4;
    doc.rect(margin, y, contentW, 20).fill(CINZA_CLARO);
    doc.fill('#000000').font('Helvetica-Bold').fontSize(10).text('VALORES', margin + 6, y + 5);
    y += 26;
    const vtot = Number(bol.valor_total || bol.total_geral || 0);
    const vbase = Number(bol.valor_base || vtot);
    const glosas = Number(bol.glosas || 0);
    const acresc = Number(bol.acrescimos || 0);
    const aliq = 0.02;
    const iss = +(vtot * aliq).toFixed(2);

    linha('Valor base do contrato', 'R$ ' + vbase.toFixed(2).replace('.',','));
    if (glosas) linha('Glosas', '- R$ ' + glosas.toFixed(2).replace('.',','));
    if (acresc) linha('Acréscimos', '+ R$ ' + acresc.toFixed(2).replace('.',','));
    linha('Valor total dos serviços', 'R$ ' + vtot.toFixed(2).replace('.',','));
    linha('Alíquota ISS', (aliq * 100).toFixed(2) + '%');
    linha('Valor do ISS', 'R$ ' + iss.toFixed(2).replace('.',','));

    if (Array.isArray(nfs) && nfs.length) {
      y = doc.y + 10;
      doc.rect(margin, y, contentW, 20).fill(CINZA_CLARO);
      doc.fill('#000000').font('Helvetica-Bold').fontSize(10).text('BOLETINS DE MEDIÇÃO VINCULADOS', margin + 6, y + 5);
      y += 26;
      doc.font('Helvetica').fontSize(9);
      for (const n of nfs) {
        const lin = `NF ${n.nf_numero || '-'}  —  ${n.campus_nome || '-'} (${n.municipio || '-'})  —  R$ ${Number(n.valor_total||0).toFixed(2).replace('.',',')}`;
        doc.text(lin, margin + 6, y, { width: contentW - 12 });
        y = doc.y + 3;
      }
    }

    // Rodapé
    doc.font('Helvetica').fontSize(8).fill('#64748b')
       .text('Gerado automaticamente pelo Sistema Montana — ' + new Date().toLocaleString('pt-BR'),
             margin, doc.page.height - 50, { width: contentW, align: 'center' });
  });
}

function gerarOficioEncaminhamentoBuffer(bol, nfseNum, nfs) {
  return pdfToBuffer(doc => {
    const margin = 50;
    const contentW = doc.page.width - 2 * margin;
    const hoje = new Date().toLocaleDateString('pt-BR');
    const vtot = Number(bol.valor_total || bol.total_geral || 0);

    doc.font('Helvetica').fontSize(11).text(bol.empresa_razao || '', margin, margin, { width: contentW, align: 'right' });
    doc.fontSize(9).fill('#64748b').text(`CNPJ: ${bol.empresa_cnpj || '-'}`, { width: contentW, align: 'right' });
    doc.text(bol.empresa_endereco || '', { width: contentW, align: 'right' });
    doc.moveDown(2);

    doc.fill('#000000').font('Helvetica-Bold').fontSize(13)
       .text(`OFÍCIO DE ENCAMINHAMENTO — ${bol.competencia || ''}`, { width: contentW, align: 'center' });
    doc.moveDown(1);

    doc.font('Helvetica').fontSize(10);
    doc.text(`Palmas-TO, ${hoje}.`, { width: contentW, align: 'right' });
    doc.moveDown(1.5);

    doc.font('Helvetica-Bold').text('Ao(À) Gestor(a) / Fiscal do Contrato');
    doc.font('Helvetica').text(bol.contratante || '');
    doc.text(`Contrato nº ${bol.numero_contrato || '-'}`);
    doc.text(`Processo: ${bol.processo || '-'}`);
    doc.moveDown(1);

    doc.font('Helvetica-Bold').text('Assunto: ', { continued: true });
    doc.font('Helvetica').text(`Encaminhamento de Nota Fiscal de Serviço e Boletim de Medição — competência ${bol.competencia || ''}.`);
    doc.moveDown(1);

    doc.text('Prezado(a) Gestor(a),', { width: contentW });
    doc.moveDown(0.8);
    doc.text(
      `Encaminhamos em anexo, para fins de conferência e ateste, a documentação referente à execução contratual do ` +
      `período em epígrafe, contendo:`,
      { width: contentW, align: 'justify' }
    );
    doc.moveDown(0.6);
    doc.text(`   •  Boletins de Medição aprovados (${(nfs||[]).length} documento(s));`, { width: contentW });
    doc.text(`   •  Nota Fiscal de Serviço Eletrônica — NFS-e nº ${nfseNum};`, { width: contentW });
    doc.text(`   •  XML oficial da NFS-e emitida no portal da Prefeitura Municipal.`, { width: contentW });
    doc.moveDown(0.8);

    doc.text(
      `O valor total da medição é de R$ ${vtot.toFixed(2).replace('.',',').replace(/\B(?=(\d{3})+(?!\d))/g,'.')}, ` +
      `conforme detalhado nos documentos anexos. Solicitamos a verificação e o devido encaminhamento para pagamento, ` +
      `de acordo com os prazos e condições pactuados em contrato.`,
      { width: contentW, align: 'justify' }
    );
    doc.moveDown(0.8);

    doc.text(
      `Colocamo-nos à disposição para eventuais esclarecimentos pelos canais de contato ` +
      `${bol.empresa_email || ''} / ${bol.empresa_telefone || ''}.`,
      { width: contentW, align: 'justify' }
    );
    doc.moveDown(0.8);
    doc.text('Atenciosamente,', { width: contentW });
    doc.moveDown(3);

    doc.moveTo(margin + 80, doc.y).lineTo(margin + 80 + 280, doc.y).stroke();
    doc.moveDown(0.2);
    doc.font('Helvetica-Bold').text(bol.empresa_razao || '', margin + 80, doc.y, { width: 280, align: 'center' });
    doc.font('Helvetica').fontSize(9).text(`CNPJ ${bol.empresa_cnpj || '-'}`, { width: 280, align: 'center' });
  });
}

// ─── PAINEL DE FATURAMENTO MENSAL ──────────────────────────────
// GET /api/boletins/painel-faturamento?mes=YYYY-MM
// Retorna todos os contratos ativos com status do boletim no mês
router.get('/painel-faturamento', async (req, res) => {
  try {
    const { mes } = req.query; // "2026-04"
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) {
      return res.status(400).json({ error: 'Parâmetro mes obrigatório (YYYY-MM)' });
    }
    const db = req.db;

    // FIX2: JOIN duplo — contrato_ref exato OU LIKE numero_contrato
    const contratos = db.prepare(`
      SELECT bc.*,
        COALESCE(
          (SELECT c1.valor_mensal_bruto FROM contratos c1 WHERE bc.contrato_ref != '' AND c1.numContrato = bc.contrato_ref LIMIT 1),
          (SELECT c2.valor_mensal_bruto FROM contratos c2 WHERE c2.numContrato LIKE '%' || bc.numero_contrato LIMIT 1),
          0
        ) AS valor_mensal_bruto,
        COALESCE(
          (SELECT c1.orgao FROM contratos c1 WHERE bc.contrato_ref != '' AND c1.numContrato = bc.contrato_ref LIMIT 1),
          (SELECT c2.orgao FROM contratos c2 WHERE c2.numContrato LIKE '%' || bc.numero_contrato LIMIT 1),
          ''
        ) AS cnpj_tomador_contrato
      FROM bol_contratos bc
      WHERE bc.ativo = 1
      ORDER BY bc.nome
    `).all();

    const resultado = await Promise.all(contratos.map(async bc => {
      // FIX1: COALESCE(valor_total, total_geral)
      const boletim = await db.prepare(`
        SELECT *, COALESCE(valor_total, total_geral, 0) AS valor_efetivo
        FROM bol_boletins
        WHERE contrato_id = ? AND competencia = ?
      `).get(bc.id, mes);

      const [ano, mesNum] = mes.split('-');
      const mesNome = MESES_NOME_COMPLETO[parseInt(mesNum)] || mes;

      return {
        contrato_id:       bc.id,
        nome:              bc.nome,
        contratante:       bc.contratante,
        contrato_ref:      bc.contrato_ref,
        valor_mensal_bruto: bc.valor_mensal_bruto || 0,
        // FIX3: expõe cnpj_tomador_contrato para diagnóstico e para o emitir
        orgao:             bc.orgao || bc.contratante,
        insc_municipal:    bc.insc_municipal || '',
        cnpj_tomador_contrato: bc.cnpj_tomador_contrato || '',
        mes_nome:          `${mesNome}/${ano}`,
        boletim: boletim ? {
          id:          boletim.id,
          status:      boletim.status,
          nfse_status: boletim.nfse_status,
          nfse_numero: boletim.nfse_numero,
          // FIX1: usa valor_efetivo (COALESCE já aplicado na query)
          valor_base:  boletim.valor_base  || boletim.total_geral || 0,
          valor_total: boletim.valor_efetivo || 0,
          glosas:      boletim.glosas      || 0,
          acrescimos:  boletim.acrescimos  || 0,
          discriminacao: boletim.discriminacao || '',
          nfse_erro:   boletim.nfse_erro   || null,
        } : null,
      };
    }));

    // FIX: aviso se algum contrato tem CNPJ não resolvido
    const semCnpj = resultado.filter(r => !r.insc_municipal && !r.cnpj_tomador_contrato);
    if (semCnpj.length) {
      console.warn(`[painel-faturamento] ${semCnpj.length} contrato(s) sem CNPJ tomador: ${semCnpj.map(r=>r.nome).join(', ')}`);
    }

    const stats = {
      total:    resultado.length,
      sem_boletim: resultado.filter(r => !r.boletim).length,
      rascunho:    resultado.filter(r => r.boletim?.status === 'rascunho').length,
      aprovado:    resultado.filter(r => r.boletim?.status === 'aprovado').length,
      emitido:     resultado.filter(r => r.boletim?.nfse_status === 'EMITIDA').length,
      // FIX1: usa valor_efetivo
      valor_total: resultado.reduce((s, r) => s + (r.boletim?.valor_total || 0), 0),
      sem_cnpj:    semCnpj.length,
    };

    res.json({ mes, contratos: resultado, stats });
  } catch (err) {
    console.error('Erro painel-faturamento:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GERAR MÊS (batch) ─────────────────────────────────────────
// POST /api/boletins/gerar-mes  { mes: "YYYY-MM" }
// Cria boletins em rascunho para TODOS os contratos ativos sem boletim no mês
router.post('/gerar-mes', async (req, res) => {
  try {
    const { mes } = req.body;
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) {
      return res.status(400).json({ error: 'Campo mes obrigatório (YYYY-MM)' });
    }
    const db = req.db;

    const contratos = await db.prepare(`
      SELECT bc.*, c.valor_mensal_bruto
      FROM bol_contratos bc
      LEFT JOIN contratos c ON bc.contrato_ref = c.numContrato
      WHERE bc.ativo = 1
    `).all();

    const [ano, mesNum] = mes.split('-');
    const mesNome = MESES_NOME_COMPLETO[parseInt(mesNum)] || mes;

    const ins = db.prepare(`INSERT INTO bol_boletins
      (contrato_id, competencia, data_emissao, valor_base, valor_total, glosas, acrescimos, discriminacao, status, nfse_status)
      VALUES (?, ?, CURRENT_DATE, ?, ?, 0, 0, ?, 'rascunho', 'PENDENTE')`);

    let criados = 0, existentes = 0;

    const criar = db.transaction(async () => {
      for (const bc of contratos) {
        const existe = await db.prepare('SELECT id FROM bol_boletins WHERE contrato_id=? AND competencia=?').get(bc.id, mes);
        if (existe) { existentes++; continue; }

        const valor_base = Math.round((bc.valor_mensal_bruto || 0) * 100) / 100;
        const tipoServico = bc.descricao_servico || 'SERVIÇOS';
        const numContrato  = bc.contrato_ref || bc.numero_contrato || '';
        const discriminacao = `PRESTAÇÃO DE SERVIÇOS DE ${tipoServico.toUpperCase()} CONFORME CONTRATO Nº ${numContrato}, COMPETÊNCIA ${mesNome.toUpperCase()}/${ano}. VALOR MENSAL CONFORME BOLETIM DE MEDIÇÃO APROVADO.`;

        ins.run(bc.id, mes, valor_base, valor_base, discriminacao);
        criados++;
      }
    });
    criar();

    res.json({ ok: true, mes, criados, existentes, total: contratos.length });
  } catch (err) {
    console.error('Erro gerar-mes:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── APROVAR BOLETIM ───────────────────────────────────────────
// POST /api/boletins/:id/aprovar
router.post('/:id/aprovar', async (req, res) => {
  try {
    const db = req.db;
    const bol = await db.prepare('SELECT * FROM bol_boletins WHERE id=?').get(req.params.id);
    if (!bol) return res.status(404).json({ error: 'Boletim não encontrado' });
    if (bol.nfse_status === 'EMITIDA') {
      return res.status(400).json({ error: 'NFS-e já emitida — não é possível alterar status' });
    }
    await db.prepare(`UPDATE bol_boletins SET status='aprovado', updated_at=NOW() WHERE id=?`).run(req.params.id);
    res.json({ ok: true, data: await db.prepare('SELECT * FROM bol_boletins WHERE id=?').get(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REABRIR BOLETIM ──────────────────────────────────────────
// POST /api/boletins/:id/reabrir
router.post('/:id/reabrir', async (req, res) => {
  try {
    const db = req.db;
    const bol = await db.prepare('SELECT * FROM bol_boletins WHERE id=?').get(req.params.id);
    if (!bol) return res.status(404).json({ error: 'Boletim não encontrado' });
    if (bol.nfse_status === 'EMITIDA') {
      return res.status(400).json({ error: 'NFS-e já emitida — não é possível reabrir' });
    }
    await db.prepare(`UPDATE bol_boletins SET status='rascunho', updated_at=NOW() WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── HISTÓRICO simplificado por mês ───────────────────────────
// GET /api/boletins/historico-mes?mes=YYYY-MM
router.get('/historico-mes', async (req, res) => {
  const { mes } = req.query;
  if (!mes) return res.status(400).json({ error: 'mes obrigatório' });
  try {
    const rows = await req.db.prepare(`
      SELECT b.*, bc.nome as contrato_nome, bc.contratante
      FROM bol_boletins b
      JOIN bol_contratos bc ON bc.id = b.contrato_id
      WHERE b.competencia = ?
      ORDER BY bc.nome
    `).all(mes);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
