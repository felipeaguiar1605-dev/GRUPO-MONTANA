/**
 * Montana Multi-Empresa — Módulo de Boletins de Medição
 * CRUD de contratos, postos, itens + geração de PDFs
 *
 * P2 (2026-04-30): + endpoints de template, aditivos, prévia/aprovação/emissão
 */
const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const companyMw = require('../companyMiddleware');
const tplEngine = require('../lib/templateRenderer');

const router = express.Router();
router.use(companyMw);

// ─── INIT: Adicionar colunas extras nas tabelas de boletins ────

router.use(async (req, res, next) => {
  const db = req.db;
  if (!db) return next();

  // Colunas NFS-e na tabela bol_boletins
  const bolCols = [
    ['valor_base',        'REAL DEFAULT 0'],
    ['valor_total',       'REAL DEFAULT 0'],   // FIX 2026-04: faltava em alguns schemas
    ['total_geral',       'REAL DEFAULT 0'],   // legado (algumas instalações usam só esse)
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

  // NOTA (2026-05): N boletins por (contrato, competência) é caso de uso
  // legítimo (NFs complementares, aditivos, glosa retroativa). Anteriormente
  // havia CREATE UNIQUE INDEX aqui — removido. _duplicatas e _dedup
  // continuam disponíveis como ferramenta manual quando o usuário sabe
  // que algum grupo é duplicata real.

  // Cenário 1: vínculo NF↔boletim. Garante coluna boletim_id em notas_fiscais
  // e índice. Idempotente. (também é garantido em /emitir-nfse e webiss.js)
  try { await db.prepare(`ALTER TABLE notas_fiscais ADD COLUMN boletim_id BIGINT`).run(); } catch (_) {}
  try { await db.prepare(`CREATE INDEX IF NOT EXISTS idx_nf_boletim ON notas_fiscais(boletim_id)`).run(); } catch (_) {}

  // Colunas adicionais na tabela bol_contratos (necessárias para vinculação contrato financeiro + NFS-e)
  const contrCols = [
    ['contrato_ref',    "TEXT DEFAULT ''"],  // numContrato da tabela contratos
    ['orgao',           "TEXT DEFAULT ''"],  // razão social do tomador para NFS-e
    ['insc_municipal',  "TEXT DEFAULT ''"],  // CNPJ do tomador (campo nomenclatura WebISS)
  ];
  for (const [col, def] of contrCols) {
    try { await db.prepare(`ALTER TABLE bol_contratos ADD COLUMN ${col} ${def}`).run(); } catch (_) {}
  }

  // ─── Feature: colaboradores opt-in por posto + glosas detalhadas ───
  // Flag por posto: TRUE (default) → posto exibe lista de colaboradores no boletim/NF
  //                 FALSE → posto NÃO nomina (segurança/sigilo, ex: vigilância armada)
  try { await db.prepare(`ALTER TABLE bol_postos ADD COLUMN mostrar_colaboradores BOOLEAN DEFAULT TRUE`).run(); } catch (_) {}

  // Lista de colaboradores que compuseram o posto naquele boletim (nominal)
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS bol_boletim_colaboradores (
      id BIGSERIAL PRIMARY KEY,
      boletim_id BIGINT NOT NULL REFERENCES bol_boletins(id) ON DELETE CASCADE,
      posto_id BIGINT REFERENCES bol_postos(id) ON DELETE SET NULL,
      nome_colaborador TEXT NOT NULL,
      cpf TEXT,
      funcao TEXT,
      data_inicio DATE,
      data_fim DATE,
      observacao TEXT,
      ordem INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_bbc_boletim ON bol_boletim_colaboradores(boletim_id)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_bbc_posto ON bol_boletim_colaboradores(posto_id)`).run();
  } catch (_) {}

  // Glosas detalhadas (substitui o uso isolado do campo agregado bol_boletins.glosas)
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS bol_boletim_glosas (
      id BIGSERIAL PRIMARY KEY,
      boletim_id BIGINT NOT NULL REFERENCES bol_boletins(id) ON DELETE CASCADE,
      posto_id BIGINT REFERENCES bol_postos(id) ON DELETE SET NULL,
      motivo TEXT NOT NULL,
      valor NUMERIC(14,2) NOT NULL CHECK (valor >= 0),
      data_referencia DATE,
      created_at TIMESTAMP DEFAULT NOW()
    )`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_bbg_boletim ON bol_boletim_glosas(boletim_id)`).run();
  } catch (_) {}

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
  // P2 (2026-04-30): + template_discriminacao
  await req.db.prepare(`
    UPDATE bol_contratos SET nome=?, contratante=?, numero_contrato=?, processo=?, pregao=?,
      descricao_servico=?, escala=?, empresa_razao=?, empresa_cnpj=?, empresa_endereco=?,
      empresa_email=?, empresa_telefone=?,
      contrato_ref=?, orgao=?, insc_municipal=?,
      template_discriminacao=?,
      updated_at=NOW()
    WHERE id=?
  `).run(
    b.nome, b.contratante, b.numero_contrato, b.processo||'', b.pregao||'',
    b.descricao_servico||'', b.escala||'12x36', b.empresa_razao||'',
    b.empresa_cnpj||'', b.empresa_endereco||'', b.empresa_email||'', b.empresa_telefone||'',
    b.contrato_ref||'', b.orgao||'', b.insc_municipal||'',
    b.template_discriminacao||null,
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

// ─── SEED: Importar template de contrato (idempotente) ────────
// Recebe { contrato: {...}, postos: [{...campos, itens: [...]}], gerar_boletim_competencia?: 'YYYY-MM',
//          reset_postos?: bool, reset_boletim?: bool }
// e cria/atualiza tudo. Se já existir, NÃO duplica — só completa o que faltar.
// Flags reset_postos / reset_boletim deletam o existente antes de recriar
// (útil quando contrato foi cadastrado antes com estrutura diferente e está
// duplicando valores no boletim).
router.post('/seed-template', async (req, res) => {
  try {
    const { contrato, postos = [], gerar_boletim_competencia,
            reset_postos = false, reset_boletim = false,
            force_update_contrato = false } = req.body;
    if (!contrato || !contrato.numero_contrato || !contrato.nome) {
      return res.status(400).json({ error: 'contrato.numero_contrato e contrato.nome obrigatórios' });
    }
    const db = req.db;

    // 1) Contrato
    let bc = await db.prepare(`SELECT * FROM bol_contratos WHERE numero_contrato = ?`).get(contrato.numero_contrato);
    let contratoId;
    let contratoAtualizado = false;
    if (!bc) {
      const r = await db.prepare(`
        INSERT INTO bol_contratos (nome, contratante, numero_contrato, processo, pregao,
          descricao_servico, escala, empresa_razao, empresa_cnpj, empresa_endereco,
          empresa_email, empresa_telefone, contrato_ref, orgao, insc_municipal)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        contrato.nome, contrato.contratante || '', contrato.numero_contrato,
        contrato.processo || '', contrato.pregao || '',
        contrato.descricao_servico || '', contrato.escala || 'Mensal',
        contrato.empresa_razao || '', contrato.empresa_cnpj || '',
        contrato.empresa_endereco || '', contrato.empresa_email || '', contrato.empresa_telefone || '',
        contrato.contrato_ref || '', contrato.orgao || '', contrato.insc_municipal || ''
      );
      contratoId = r.lastInsertRowid;
    } else {
      contratoId = bc.id;
      // FLAG: força UPDATE dos campos do contrato com os valores do template
      if (force_update_contrato) {
        await db.prepare(`
          UPDATE bol_contratos SET
            nome = ?, contratante = ?, processo = ?, pregao = ?,
            descricao_servico = ?, escala = ?, empresa_razao = ?, empresa_cnpj = ?,
            empresa_endereco = ?, empresa_email = ?, empresa_telefone = ?,
            contrato_ref = ?, orgao = ?, insc_municipal = ?,
            updated_at = NOW()
          WHERE id = ?
        `).run(
          contrato.nome, contrato.contratante || '', contrato.processo || '', contrato.pregao || '',
          contrato.descricao_servico || '', contrato.escala || 'Mensal',
          contrato.empresa_razao || '', contrato.empresa_cnpj || '',
          contrato.empresa_endereco || '', contrato.empresa_email || '', contrato.empresa_telefone || '',
          contrato.contrato_ref || '', contrato.orgao || '', contrato.insc_municipal || '',
          contratoId
        );
        contratoAtualizado = true;
      }
    }

    // ── RESET (opt-in): limpa postos+items+boletim antes de recriar ──
    let resetSummary = { postos_deletados: 0, itens_deletados: 0, boletim_deletado: false };
    if (reset_postos) {
      const itensRes = await db.prepare(`
        DELETE FROM bol_itens WHERE posto_id IN (SELECT id FROM bol_postos WHERE contrato_id = ?)
      `).run(contratoId);
      const postosRes = await db.prepare(`DELETE FROM bol_postos WHERE contrato_id = ?`).run(contratoId);
      resetSummary.postos_deletados = postosRes.changes || 0;
      resetSummary.itens_deletados = itensRes.changes || 0;
    }
    if (reset_boletim && gerar_boletim_competencia) {
      // Não deleta boletim com NFS-e EMITIDA (proteção)
      const bolExistente = await db.prepare(`
        SELECT id, nfse_status FROM bol_boletins WHERE contrato_id = ? AND competencia = ?
      `).get(contratoId, gerar_boletim_competencia);
      if (bolExistente && bolExistente.nfse_status !== 'EMITIDA') {
        await db.prepare(`DELETE FROM bol_boletins WHERE id = ?`).run(bolExistente.id);
        resetSummary.boletim_deletado = true;
      }
    }

    // 2) Postos + Items
    let postosCriados = 0, itensCriados = 0;
    for (let i = 0; i < postos.length; i++) {
      const p = postos[i];
      const campusKey = p.campus_key || p.key || `POSTO_${i+1}`;
      let posto = await db.prepare(`SELECT * FROM bol_postos WHERE contrato_id = ? AND campus_key = ?`).get(contratoId, campusKey);
      let postoId;
      if (!posto) {
        const pr = await db.prepare(`
          INSERT INTO bol_postos (contrato_id, campus_key, campus_nome, municipio, descricao_posto, label_resumo, ordem)
          VALUES (?,?,?,?,?,?,?)
        `).run(contratoId, campusKey, p.campus_nome || campusKey, p.municipio || '',
               p.descricao_posto || '', p.label_resumo || p.campus_nome || campusKey, p.ordem || (i+1));
        postoId = pr.lastInsertRowid;
        postosCriados++;
      } else {
        postoId = posto.id;
      }

      // Items: se já tem algum item nesse posto, não duplica (idempotência por posto)
      const existItens = await db.prepare(`SELECT COUNT(*)::int AS n FROM bol_itens WHERE posto_id = ?`).get(postoId);
      if (!existItens || existItens.n === 0) {
        for (let j = 0; j < (p.itens || []).length; j++) {
          const it = p.itens[j];
          await db.prepare(`
            INSERT INTO bol_itens (posto_id, descricao, quantidade, valor_unitario, ordem)
            VALUES (?,?,?,?,?)
          `).run(postoId, it.descricao || it.desc || '', it.quantidade || it.qtd || 1,
                 it.valor_unitario || it.valor || 0, j+1);
          itensCriados++;
        }
      }
    }

    // 3) Gera boletim de competência (se solicitado e ainda não existe)
    let boletimId = null;
    let boletimStatus = 'nao_solicitado';
    if (gerar_boletim_competencia && /^\d{4}-\d{2}$/.test(gerar_boletim_competencia)) {
      const existeBol = await db.prepare(`SELECT id FROM bol_boletins WHERE contrato_id=? AND competencia=?`).get(contratoId, gerar_boletim_competencia);
      if (existeBol) {
        boletimId = existeBol.id;
        boletimStatus = 'ja_existia';
      } else {
        // Soma dos itens × quantidade
        const totRow = await db.prepare(`
          SELECT COALESCE(SUM(bi.quantidade * bi.valor_unitario), 0) AS tot
          FROM bol_itens bi
          JOIN bol_postos bp ON bp.id = bi.posto_id
          WHERE bp.contrato_id = ?
        `).get(contratoId);
        const valorBase = +(totRow?.tot || 0);

        const [ano, mes] = gerar_boletim_competencia.split('-');
        const MESES_NOME = {'01':'JANEIRO','02':'FEVEREIRO','03':'MARÇO','04':'ABRIL','05':'MAIO','06':'JUNHO','07':'JULHO','08':'AGOSTO','09':'SETEMBRO','10':'OUTUBRO','11':'NOVEMBRO','12':'DEZEMBRO'};
        const mesNome = MESES_NOME[mes] || mes;
        const numCt = (bc?.contrato_ref || contrato.numero_contrato || '').toUpperCase();
        const tipoServ = (contrato.descricao_servico || 'SERVIÇOS').toUpperCase();
        const discriminacao = `PRESTAÇÃO DE SERVIÇOS DE ${tipoServ.slice(0, 200)} CONFORME CONTRATO Nº ${numCt}, COMPETÊNCIA ${mesNome}/${ano}.`;

        const br = await db.prepare(`
          INSERT INTO bol_boletins
            (contrato_id, competencia, data_emissao, valor_base, valor_total, glosas, acrescimos,
             discriminacao, status, nfse_status)
          VALUES (?, ?, CURRENT_DATE, ?, ?, 0, 0, ?, 'rascunho', 'PENDENTE')
        `).run(contratoId, gerar_boletim_competencia, valorBase, valorBase, discriminacao);
        boletimId = br.lastInsertRowid;
        boletimStatus = 'criado';
      }
    }

    res.json({
      ok: true,
      contrato_id: contratoId,
      contrato_existia_antes: !!bc,
      contrato_atualizado: contratoAtualizado,
      reset: resetSummary,
      postos_criados: postosCriados,
      itens_criados: itensCriados,
      boletim: { id: boletimId, status: boletimStatus, competencia: gerar_boletim_competencia || null },
    });
  } catch (e) {
    console.error('[seed-template]', e);
    res.status(500).json({ error: e.message });
  }
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

    // Cenário 3: este endpoint é LEGADO — gera 1 boletim com N entries em
    // bol_boletins_nfs (uma por posto). Modelo novo (Painel) usa
    // /gerar-boletim que mantém 1:1. Aviso ao cliente via header.
    res.set('Deprecation', 'true');
    res.set('Link', '</api/boletins/gerar-boletim>; rel="successor-version"');
    if (!global._warnedGerarLegado) {
      console.warn('[boletins] /gerar (legado) ainda em uso — preferir /gerar-boletim + /emitir-nfse via Painel');
      global._warnedGerarLegado = true;
    }

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

    // Por padrão retorna o existente (evita duplicação acidental).
    // Para criar deliberadamente um segundo boletim no mesmo (contrato, competência),
    // passe { force_new: true } no body — caso de NF complementar, aditivo, etc.
    const forceNew = req.body?.force_new === true;
    if (!forceNew) {
      const existente = await db.prepare('SELECT * FROM bol_boletins WHERE contrato_id=? AND competencia=? ORDER BY id DESC LIMIT 1').get(contrato_id, competencia);
      if (existente) return res.json({ data: existente, novo: false });
    }

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
    const info = await stmt.run(contrato_id, competencia, valor_base, valor_base, discriminacao);
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

// ─── PREVIEW NFS-e ────────────────────────────────────────────
// GET /api/boletins/:id/preview-nfse
// Retorna o payload que SERIA enviado ao WebISS (sem emitir nada)
// + diagnóstico de campos faltantes
router.get('/:id/preview-nfse', async (req, res) => {
  const db = req.db;
  const companyKey = req.companyKey;

  try {
    const bol = await db.prepare(`
      SELECT b.*,
             COALESCE(b.valor_total, b.total_geral, 0) AS valor_efetivo,
             bc.contrato_ref, bc.contratante as bc_contratante,
             bc.orgao as bc_orgao, bc.descricao_servico as bc_descricao,
             bc.insc_municipal as insc_contratante,
             bc.numero_contrato,
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

    const today = new Date().toISOString().substring(0, 10);
    const competenciaData = bol.competencia.length === 7
      ? `${bol.competencia}-01`
      : bol.competencia;

    const aliqISS = 0.02;
    const valorISS = Math.round(bol.valor_efetivo * aliqISS * 100) / 100;

    const tomadorCnpj  = (bol.insc_contratante || bol.cnpj_tomador_contrato || '').replace(/\D/g, '');
    const tomadorRazao = bol.bc_contratante || bol.bc_orgao || 'TOMADOR NÃO CONFIGURADO';

    const rpsNum = bol.rps_numero || String(bol.id).padStart(10, '0');

    // Configurações da prestadora
    const inscPrestadora = process.env[`WEBISS_INSC_${companyKey.toUpperCase()}`] || '';
    const certPath = path.join(__dirname, '..', '..', 'certificados', `${companyKey}.pfx`);
    const certExiste = fs.existsSync(certPath);
    const certSenha = process.env[`WEBISS_CERT_SENHA_${companyKey.toUpperCase()}`];

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
          cnpj:        tomadorCnpj || null,
          razaoSocial: tomadorRazao,
          email:       '',
        },
      },
    };

    // Validações / pendências
    const pendencias = [];
    if (bol.nfse_status === 'EMITIDA') pendencias.push(`NFS-e ${bol.nfse_numero} já foi emitida`);
    if (bol.status !== 'aprovado')     pendencias.push(`Status do boletim deve ser "aprovado" (atual: "${bol.status}")`);
    if (!bol.valor_efetivo || bol.valor_efetivo <= 0) pendencias.push('Valor do boletim é zero ou negativo');
    if (!tomadorCnpj)                  pendencias.push('CNPJ do tomador NÃO configurado (insc_municipal ou contrato_ref)');
    if (!inscPrestadora)               pendencias.push(`WEBISS_INSC_${companyKey.toUpperCase()} não configurado no .env`);
    if (!certExiste)                   pendencias.push(`Certificado A1 não encontrado: ${certPath}`);
    if (!certSenha)                    pendencias.push(`WEBISS_CERT_SENHA_${companyKey.toUpperCase()} não configurado no .env`);

    res.json({
      ok: pendencias.length === 0,
      pendencias,
      boletim: {
        id: bol.id,
        contrato_id: bol.contrato_id,
        posto_id: bol.posto_id,
        competencia: bol.competencia,
        status: bol.status,
        nfse_status: bol.nfse_status,
        nfse_numero: bol.nfse_numero,
        valor_total: bol.valor_efetivo,
      },
      contrato: {
        nome: bol.bc_contratante,
        contrato_ref: bol.contrato_ref,
        numero_contrato: bol.numero_contrato,
        num_contrato_encontrado: bol.num_contrato_encontrado,
        cnpj_tomador_resolvido: tomadorCnpj,
        razao_tomador_resolvida: tomadorRazao,
      },
      prestadora: {
        empresa: companyKey,
        inscricao_municipal: inscPrestadora || '(NÃO CONFIGURADA)',
        certificado_path: certPath,
        certificado_existe: certExiste,
        senha_certificado: certSenha ? '(configurada)' : '(NÃO CONFIGURADA)',
      },
      tributario: {
        item_lista_servicos: '07.17',
        codigo_tributacao_municipio: '070700',
        aliquota_iss: aliqISS,
        valor_iss: valorISS,
        iss_retido: false,
        exigibilidade_iss: 1,
      },
      payload_webiss: rpsBody,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

          // Garante colunas webiss_numero_nfse, discriminacao e boletim_id
          try { await db.prepare(`ALTER TABLE notas_fiscais ADD COLUMN webiss_numero_nfse TEXT`).run(); } catch (_) {}
          try { await db.prepare(`ALTER TABLE notas_fiscais ADD COLUMN discriminacao TEXT`).run(); } catch (_) {}
          try { await db.prepare(`ALTER TABLE notas_fiscais ADD COLUMN boletim_id BIGINT`).run(); } catch (_) {}
          try { await db.prepare(`CREATE INDEX IF NOT EXISTS idx_nf_boletim ON notas_fiscais(boletim_id)`).run(); } catch (_) {}

          await db.prepare(`INSERT INTO notas_fiscais
            (numero, competencia, cidade, tomador, cnpj_tomador,
             valor_bruto, valor_liquido,
             inss, ir, iss, csll, pis, cofins, retencao,
             data_emissao, status_conciliacao,
             webiss_numero_nfse, discriminacao, boletim_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
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
              bol.id,
          );
          console.log(`[boletins] Auto-sync NF ${nfseNum} → notas_fiscais (boletim_id=${bol.id})`);
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

// ─── DIAGNÓSTICO: lista boletins existentes (debug) ────────────
// GET /api/boletins/_diag
router.get('/_diag', async (req, res) => {
  try {
    const boletins = await req.db.prepare(`
      SELECT b.id, b.contrato_id, b.competencia, b.status, b.nfse_status,
             b.valor_base, b.valor_total,
             bc.nome AS contrato_nome
      FROM bol_boletins b
      LEFT JOIN bol_contratos bc ON bc.id = b.contrato_id
      ORDER BY b.id DESC
      LIMIT 50
    `).all();
    res.json({
      ok: true,
      total: boletins.length,
      boletins,
      empresa: req.companyKey || req.company?.key || 'desconhecida',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PREVIEW PDF do boletim (gera em memória e devolve inline) ──
// GET /api/boletins/:id/preview-pdf
// Útil pra visualizar o layout sem precisar acionar /gerar e salvar em disco.
router.get('/:id/preview-pdf', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'ID inválido' });

    // Queries separadas (evita conflito de colunas duplicadas com SELECT b.*, bc.*)
    let boletim = await req.db.prepare(`SELECT * FROM bol_boletins WHERE id = ?`).get(id);

    // FALLBACK: se id stale (frontend com cache), usar contrato_id+competencia
    // como localizadores alternativos via query string.
    if (!boletim && req.query.contrato_id && req.query.competencia) {
      boletim = await req.db.prepare(`
        SELECT * FROM bol_boletins WHERE contrato_id = ? AND competencia = ?
      `).get(parseInt(req.query.contrato_id, 10), req.query.competencia);
    }

    if (!boletim) {
      // Diagnóstico: lista IDs existentes pra debug
      const ids = await req.db.prepare(`SELECT id, contrato_id, competencia, valor_total FROM bol_boletins ORDER BY id DESC LIMIT 10`).all();
      return res.status(404).json({
        error: 'Boletim não encontrado (id=' + id + ')',
        ids_disponiveis: ids,
        dica: 'Use ?contrato_id=X&competencia=YYYY-MM como alternativa',
      });
    }

    const contrato = await req.db.prepare(`SELECT * FROM bol_contratos WHERE id = ?`).get(boletim.contrato_id);
    if (!contrato) return res.status(404).json({ error: 'Contrato do boletim não encontrado' });

    // Se o boletim tem posto_id (modelo multi-boletim: 1 posto por boletim),
    // carrega APENAS esse posto. Caso contrário, agrega todos os postos do
    // contrato (modelo legado: 1 boletim = todos os postos).
    let postos;
    if (boletim.posto_id) {
      postos = await req.db.prepare(`SELECT * FROM bol_postos WHERE id = ?`).all(boletim.posto_id);
    } else {
      postos = await req.db.prepare(`SELECT * FROM bol_postos WHERE contrato_id = ? ORDER BY ordem`).all(boletim.contrato_id);
    }
    for (const p of postos) {
      p.itens = await req.db.prepare(`SELECT * FROM bol_itens WHERE posto_id = ? ORDER BY ordem`).all(p.id);
    }
    if (!postos.length) return res.status(400).json({ error: 'Boletim sem posto cadastrado' });

    // Posto consolidado (1 posto direto OU agregado dos N postos do contrato)
    const postoAggregado = {
      campus_nome: postos.map(p => p.campus_nome || p.label_resumo).join(' · '),
      municipio: postos[0]?.municipio || '',
      descricao_posto: postos.map(p => p.descricao_posto).filter(Boolean).join(' · ') || '—',
      itens: postos.flatMap(p => p.itens || []),
    };

    // Período humano (ex.: "Abril/2026")
    const MESES = ['','Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
    const [ano, mesNum] = (boletim.competencia || '').split('-');
    const periodo = `${MESES[parseInt(mesNum, 10)] || mesNum}/${ano}`;
    const dataEmissao = boletim.data_emissao
      ? new Date(boletim.data_emissao).toLocaleDateString('pt-BR')
      : new Date().toLocaleDateString('pt-BR');
    const nfNumero = boletim.nfse_numero || '— a emitir —';

    // Gera em buffer e devolve inline. Passa contrato como base + boletim
    // (alguns campos como `data_emissao` vêm do boletim, outros do contrato).
    const dadosPDF = { ...contrato, ...boletim, contrato_id: boletim.contrato_id };
    const buf = await pdfToBuffer(doc => {
      gerarBoletimPDF_inline(doc, dadosPDF, postoAggregado, nfNumero, dataEmissao, periodo);
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="preview_boletim_${boletim.contrato_id}_${boletim.competencia}.pdf"`);
    res.send(buf);
  } catch (err) {
    console.error('Erro preview-pdf:', err);
    res.status(500).json({ error: err.message });
  }
});

// Wrapper que reusa o desenho do gerarBoletimPDF, mas escrevendo no doc
// fornecido em vez de criar um stream novo. Replica o layout 1:1.
function gerarBoletimPDF_inline(doc, contrato, posto, nfNumero, dataEmissao, periodo) {
  const pageW = doc.page.width;
  const margin = 30;
  const contentW = pageW - 2 * margin;

  doc.rect(margin, 30, contentW, 85).fill(AZUL_ESCURO);
  doc.fill('#FFFFFF').fontSize(18).font('Helvetica-Bold')
     .text('BOLETIM DE MEDIÇÃO', margin, 42, { width: contentW, align: 'center' });
  doc.moveTo(margin + 40, 65).lineTo(margin + contentW - 40, 65)
     .strokeColor('#FFFFFF').lineWidth(0.5).stroke();
  const textoEmpresa = `${contrato.empresa_razao || ''}    CNPJ: ${contrato.empresa_cnpj || ''}`;
  doc.fontSize(9).font('Helvetica-Bold').text(textoEmpresa, margin, 72, { width: contentW, align: 'center' });
  doc.fontSize(7.5).font('Helvetica').text(contrato.empresa_endereco || '', margin, 85, { width: contentW, align: 'center' });
  doc.text(`E-mail: ${contrato.empresa_email || ''}  /  Telefone: ${contrato.empresa_telefone || ''}`,
           margin, 96, { width: contentW, align: 'center' });

  const blocoY = 130, blocoH = 130;
  doc.rect(margin, blocoY, contentW, blocoH).strokeColor(CINZA_BORDA).lineWidth(0.5).stroke();
  let y = blocoY + 15;
  const lx = margin + 8;
  function field(label, value) {
    doc.fill('#000000').font('Helvetica-Bold').fontSize(9).text(label + ':', lx, y, { continued: true });
    doc.font('Helvetica').text(' ' + (value || '—'));
    y += 16;
  }
  function fieldSmall(label, value) {
    doc.fill('#000000').font('Helvetica').fontSize(8.5).text(label + ': ' + (value || '—'), lx, y);
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

  const nfY = blocoY + blocoH + 15;
  doc.rect(margin, nfY, contentW, 22).fill(CINZA_CLARO);
  doc.fill('#000000').font('Helvetica-Bold').fontSize(10)
     .text(`NOTA FISCAL: ${nfNumero}`, margin + 10, nfY + 5)
     .text(`DATA DE EMISSÃO: ${dataEmissao}`, pageW / 2 + 30, nfY + 5);

  const tableY = nfY + 35;
  const colWidths = [contentW * 0.42, contentW * 0.12, contentW * 0.23, contentW * 0.23];
  const headers = ['ITEM', 'QTD.', 'VALOR UNITÁRIO', 'VALOR TOTAL'];

  let tx = margin;
  doc.rect(margin, tableY, contentW, 20).fill(AZUL_ESCURO);
  doc.fill('#FFFFFF').font('Helvetica-Bold').fontSize(8);
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i], tx + 4, tableY + 5, { width: colWidths[i] - 8, align: 'center' });
    tx += colWidths[i];
  }

  let rowY = tableY + 20;
  let totalPosto = 0;
  for (let idx = 0; idx < posto.itens.length; idx++) {
    const item = posto.itens[idx];
    const vt = (item.quantidade || 0) * (item.valor_unitario || 0);
    totalPosto += vt;
    if (idx % 2 === 1) doc.rect(margin, rowY, contentW, 28).fill(CINZA_CLARO);
    tx = margin;
    doc.fill('#000000').font('Helvetica').fontSize(8);
    const descH = doc.heightOfString(item.descricao || '', { width: colWidths[0] - 12 });
    const rowH = Math.max(descH + 10, 28);
    doc.text(item.descricao || '', tx + 6, rowY + 5, { width: colWidths[0] - 12 });
    tx += colWidths[0];
    doc.text(String(item.quantidade || 0), tx + 4, rowY + 8, { width: colWidths[1] - 8, align: 'center' });
    tx += colWidths[1];
    doc.text(formatMoeda(item.valor_unitario || 0), tx + 4, rowY + 8, { width: colWidths[2] - 8, align: 'right' });
    tx += colWidths[2];
    doc.text(formatMoeda(vt), tx + 4, rowY + 8, { width: colWidths[3] - 8, align: 'right' });
    doc.rect(margin, rowY, contentW, rowH).strokeColor(CINZA_BORDA).lineWidth(0.3).stroke();
    rowY += rowH;
  }

  rowY += 4;
  doc.font('Helvetica-Bold').fontSize(9).fill('#000000');
  const totalX = margin + colWidths[0] + colWidths[1];
  doc.text('TOTAL:', totalX + 4, rowY, { width: colWidths[2] - 8, align: 'right' });
  doc.text(formatMoeda(totalPosto), totalX + colWidths[2] + 4, rowY, { width: colWidths[3] - 8, align: 'right' });

  rowY += 25;
  doc.font('Helvetica-Bold').fontSize(9).text('DESCRIÇÃO DO SERVIÇO:', margin + 5, rowY);
  rowY += 5;
  doc.font('Helvetica').fontSize(8).text(contrato.descricao_servico || '', margin + 5, rowY + 8, { width: contentW - 10 });
  rowY = doc.y + 10;
  doc.font('Helvetica-Bold').fontSize(9).text('DESCRIÇÃO DO POSTO: ', margin + 5, rowY, { continued: true });
  doc.font('Helvetica').text(posto.descricao_posto || '');
  rowY = doc.y + 5;
  doc.font('Helvetica-Bold').fontSize(9).text('ESCALA: ', margin + 5, rowY, { continued: true });
  doc.font('Helvetica').text((contrato.escala || '') + '.');

  const sigY = doc.page.height - 100;
  const sigW = (contentW - 20) / 3;
  const labels = ['FORNECEDOR', 'FISCALIZAÇÃO', 'APROVADO'];
  for (let i = 0; i < labels.length; i++) {
    const x = margin + i * (sigW + 10);
    doc.rect(x, sigY, sigW, 60).strokeColor(CINZA_BORDA).lineWidth(0.5).stroke();
    doc.moveTo(x + 15, sigY + 40).lineTo(x + sigW - 15, sigY + 40).stroke();
    doc.fill('#000000').font('Helvetica').fontSize(8).text(labels[i], x, sigY + 45, { width: sigW, align: 'center' });
  }
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
    // FIX3 (2026-04): faltava `await` na .all() (era síncrono em SQLite, virou
    // Promise em PG → frontend recebia Promise em vez de array → "contratos.map
    // is not a function"). Corrigido também `bc.ativo = 1` → `bc.ativo = TRUE`
    // pra schemas em que `ativo` é boolean (compatibilidade com integer 1 mantida
    // via COALESCE — assume ativo se a coluna for NULL).
    const _contratosRaw = await db.prepare(`
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
      WHERE COALESCE(bc.ativo::text, 'true') NOT IN ('0','false','f')
      ORDER BY bc.nome
    `).all();
    const contratos = Array.isArray(_contratosRaw) ? _contratosRaw : [];

    const resultado = await Promise.all(contratos.map(async bc => {
      // FIX1: COALESCE(valor_total, total_geral)
      // FIX5 (2026-05): se há duplicatas (mesmo contrato/competência), retorna o
      // mais "vivo" primeiro: NFS-e EMITIDA > status='aprovado' > maior valor.
      // Sem essa ordenação, .get() retorna não-determinístico — usuário podia
      // ver "R$ 0,00" porque caía no rascunho órfão. Ver POST /_dedup para limpar.
      const boletim = await db.prepare(`
        SELECT *, COALESCE(valor_total, total_geral, 0) AS valor_efetivo
        FROM bol_boletins
        WHERE contrato_id = ? AND competencia = ?
        ORDER BY
          CASE WHEN nfse_status = 'EMITIDA' THEN 4
               WHEN status      = 'aprovado' THEN 3
               WHEN COALESCE(valor_total, total_geral, 0) > 0 THEN 2
               ELSE 1 END DESC,
          COALESCE(valor_total, total_geral, 0) DESC,
          created_at DESC
        LIMIT 1
      `).get(bc.id, mes);

      // Conta dups deste par (contrato/competência) — pra frontend avisar se >1
      const dupRow = await db.prepare(
        'SELECT COUNT(*)::int AS n FROM bol_boletins WHERE contrato_id = ? AND competencia = ?'
      ).get(bc.id, mes);
      const dup_count = dupRow ? (dupRow.n - 1) : 0;

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
        dup_count,
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
      duplicatas:  resultado.reduce((s, r) => s + (r.dup_count || 0), 0),
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

    // FIX 2026-04: bc.ativo = 1 falhava em PG quando ativo é boolean.
    // Tolera ambos: integer 1 e boolean TRUE (e NULL = ativo por default).
    const _contratosRaw = await db.prepare(`
      SELECT bc.*, c.valor_mensal_bruto
      FROM bol_contratos bc
      LEFT JOIN contratos c ON bc.contrato_ref = c.numContrato
      WHERE COALESCE(bc.ativo::text, 'true') NOT IN ('0','false','f')
    `).all();
    const contratos = Array.isArray(_contratosRaw) ? _contratosRaw : [];

    const [ano, mesNum] = mes.split('-');
    const mesNome = MESES_NOME_COMPLETO[parseInt(mesNum)] || mes;

    let criados = 0, existentes = 0;

    // Sem transaction wrapper — em PG cada INSERT é atômico e não precisamos
    // de ROLLBACK se o batch falhar no meio (mais simples + sem confusão de
    // async/sync no transaction adapter).
    for (const bc of contratos) {
      const existe = await db.prepare('SELECT id FROM bol_boletins WHERE contrato_id=? AND competencia=?').get(bc.id, mes);
      if (existe) { existentes++; continue; }

      const valor_base = Math.round((bc.valor_mensal_bruto || 0) * 100) / 100;
      const tipoServico = bc.descricao_servico || 'SERVIÇOS';
      const numContrato  = bc.contrato_ref || bc.numero_contrato || '';
      const discriminacao = `PRESTAÇÃO DE SERVIÇOS DE ${tipoServico.toUpperCase()} CONFORME CONTRATO Nº ${numContrato}, COMPETÊNCIA ${mesNome.toUpperCase()}/${ano}. VALOR MENSAL CONFORME BOLETIM DE MEDIÇÃO APROVADO.`;

      // FIX: faltava await em ins.run em PG (Promise não esperada → criados++
      // contabilizava antes do INSERT terminar)
      await db.prepare(`INSERT INTO bol_boletins
        (contrato_id, competencia, data_emissao, valor_base, valor_total, glosas, acrescimos, discriminacao, status, nfse_status)
        VALUES (?, ?, CURRENT_DATE, ?, ?, 0, 0, ?, 'rascunho', 'PENDENTE')
      `).run(bc.id, mes, valor_base, valor_base, discriminacao);
      criados++;
    }

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

// ─── APROVAR LOTE ──────────────────────────────────────────────
// POST /api/boletins/aprovar-lote  { mes: "YYYY-MM" }
// Aprova automaticamente boletins em rascunho que tenham valor > 0
// e pelo menos insc_municipal OU cnpj_tomador_contrato preenchidos.
router.post('/aprovar-lote', async (req, res) => {
  try {
    const { mes } = req.body;
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) {
      return res.status(400).json({ error: 'Campo mes obrigatório (YYYY-MM)' });
    }
    const db = req.db;

    // Busca rascunhos do mês com dados necessários para qualificar aprovação
    const rascunhos = await db.prepare(`
      SELECT b.id,
             COALESCE(b.valor_total, b.total_geral, 0) AS valor_efetivo,
             bc.insc_municipal,
             COALESCE(
               (SELECT c1.orgao FROM contratos c1 WHERE bc.contrato_ref != '' AND c1.numContrato = bc.contrato_ref LIMIT 1),
               (SELECT c2.orgao FROM contratos c2 WHERE c2.numContrato LIKE '%' || bc.numero_contrato LIMIT 1),
               ''
             ) AS cnpj_tomador_contrato
      FROM bol_boletins b
      JOIN bol_contratos bc ON b.contrato_id = bc.id
      WHERE b.status = 'rascunho'
        AND b.competencia = ?
    `).all(mes);

    let aprovados = 0;
    const pulados = [];

    for (const bol of rascunhos) {
      // Critério 1: valor_total > 0
      if (!bol.valor_efetivo || bol.valor_efetivo <= 0) {
        pulados.push({ id: bol.id, motivo: 'valor_total zerado ou nulo' });
        continue;
      }
      // Critério 2: pelo menos um CNPJ de tomador resolvido
      const temCnpj = (bol.insc_municipal && bol.insc_municipal.trim()) ||
                      (bol.cnpj_tomador_contrato && bol.cnpj_tomador_contrato.trim());
      if (!temCnpj) {
        pulados.push({ id: bol.id, motivo: 'insc_municipal e cnpj_tomador_contrato ambos vazios' });
        continue;
      }

      await db.prepare(`UPDATE bol_boletins SET status='aprovado', updated_at=NOW() WHERE id=?`).run(bol.id);
      aprovados++;
    }

    res.json({ ok: true, mes, total_rascunhos: rascunhos.length, aprovados, pulados });
  } catch (err) {
    console.error('Erro aprovar-lote:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── EMITIR NFS-e EM LOTE ─────────────────────────────────────
// POST /api/boletins/emitir-lote  { mes: "YYYY-MM" }
// Emite NFS-e para todos os boletins aprovados com nfse_status PENDENTE ou ERRO
// Limite de 30 por execução para não sobrecarregar o WebISS.
router.post('/emitir-lote', async (req, res) => {
  try {
    const { mes } = req.body;
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) {
      return res.status(400).json({ error: 'Campo mes obrigatório (YYYY-MM)' });
    }
    const db = req.db;
    const companyKey = req.companyKey;
    const LIMITE = 30;

    // Busca candidatos à emissão
    const candidatos = await db.prepare(`
      SELECT b.id
      FROM bol_boletins b
      WHERE b.status = 'aprovado'
        AND b.nfse_status IN ('PENDENTE', 'ERRO')
        AND b.competencia = ?
      ORDER BY b.id
      LIMIT ?
    `).all(mes, LIMITE);

    if (candidatos.length === 0) {
      return res.json({ ok: true, mes, total: 0, emitidos: 0, erros: [] });
    }

    const port  = process.env.PORT || 3002;
    const token = req.headers.authorization || '';

    let emitidos = 0;
    const erros = [];

    for (const { id } of candidatos) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/boletins/${id}/emitir-nfse`, {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': token,
            'X-Company':     companyKey,
          },
          signal: AbortSignal.timeout(90000),
        });
        const result = await response.json();
        if (result.ok) {
          emitidos++;
        } else {
          erros.push({ id, erro: result.error || 'Erro desconhecido' });
        }
      } catch (eItem) {
        erros.push({ id, erro: eItem.message });
      }
    }

    res.json({ ok: true, mes, total: candidatos.length, emitidos, erros });
  } catch (err) {
    console.error('Erro emitir-lote:', err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════
//  COLABORADORES POR BOLETIM (opt-in via bol_postos.mostrar_colaboradores)
// ════════════════════════════════════════════════════════════════════

// PATCH /api/boletins/postos/:id/mostrar-colaboradores  body: { mostrar: true|false }
router.patch('/postos/:id/mostrar-colaboradores', async (req, res) => {
  try {
    const { mostrar } = req.body;
    const flag = mostrar === false ? false : true;
    await req.db.prepare('UPDATE bol_postos SET mostrar_colaboradores = ? WHERE id = ?')
      .run(flag, req.params.id);
    res.json({ ok: true, posto_id: req.params.id, mostrar_colaboradores: flag });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/boletins/:boletim_id/colaboradores
router.get('/:boletim_id/colaboradores', async (req, res) => {
  try {
    const rowsRaw = await req.db.prepare(`
      SELECT bbc.*, bp.descricao_posto, bp.campus_nome, bp.mostrar_colaboradores
      FROM bol_boletim_colaboradores bbc
      LEFT JOIN bol_postos bp ON bp.id = bbc.posto_id
      WHERE bbc.boletim_id = ?
      ORDER BY bbc.posto_id, bbc.ordem, bbc.nome_colaborador
    `).all(req.params.boletim_id);
    const rows = Array.isArray(rowsRaw) ? rowsRaw : [];
    // Filtra: se posto tem mostrar_colaboradores=false, oculta a lista para esse posto
    const visiveis = rows.filter(r => r.mostrar_colaboradores !== false);
    const ocultos = rows.length - visiveis.length;
    res.json({ ok: true, colaboradores: visiveis, total: rows.length, ocultos_por_flag: ocultos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/boletins/:boletim_id/colaboradores  body: { colaboradores: [{ posto_id, nome, cpf?, funcao?, ... }] }
router.post('/:boletim_id/colaboradores', async (req, res) => {
  try {
    const boletim_id = parseInt(req.params.boletim_id);
    const lista = Array.isArray(req.body?.colaboradores) ? req.body.colaboradores : [];
    if (!lista.length) return res.status(400).json({ error: 'Array colaboradores vazio' });
    const inseridos = [];
    for (const c of lista) {
      if (!c.nome_colaborador && !c.nome) continue;
      const r = await req.db.prepare(`
        INSERT INTO bol_boletim_colaboradores
          (boletim_id, posto_id, nome_colaborador, cpf, funcao, data_inicio, data_fim, observacao, ordem)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        boletim_id, c.posto_id || null,
        c.nome_colaborador || c.nome,
        c.cpf || null, c.funcao || null,
        c.data_inicio || null, c.data_fim || null,
        c.observacao || null, c.ordem || 0
      );
      inseridos.push(r.lastInsertRowid);
    }
    res.json({ ok: true, inseridos: inseridos.length, ids: inseridos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/boletins/colaboradores/:id  body: { nome_colaborador, cpf, funcao, ... }
router.put('/colaboradores/:id', async (req, res) => {
  try {
    const c = req.body || {};
    await req.db.prepare(`
      UPDATE bol_boletim_colaboradores SET
        nome_colaborador = COALESCE(?, nome_colaborador),
        cpf              = COALESCE(?, cpf),
        funcao           = COALESCE(?, funcao),
        data_inicio      = COALESCE(?, data_inicio),
        data_fim         = COALESCE(?, data_fim),
        observacao       = COALESCE(?, observacao),
        ordem            = COALESCE(?, ordem),
        updated_at       = NOW()
      WHERE id = ?
    `).run(
      c.nome_colaborador || c.nome || null,
      c.cpf || null, c.funcao || null,
      c.data_inicio || null, c.data_fim || null,
      c.observacao || null, c.ordem || null,
      req.params.id
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/boletins/colaboradores/:id
router.delete('/colaboradores/:id', async (req, res) => {
  try {
    await req.db.prepare('DELETE FROM bol_boletim_colaboradores WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/boletins/:boletim_id/colaboradores/copiar-mes-anterior
// Copia a lista de colaboradores do boletim do mesmo contrato/competência anterior
router.post('/:boletim_id/colaboradores/copiar-mes-anterior', async (req, res) => {
  try {
    const boletim_id = parseInt(req.params.boletim_id);
    const bol = await req.db.prepare('SELECT contrato_id, competencia FROM bol_boletins WHERE id = ?').get(boletim_id);
    if (!bol) return res.status(404).json({ error: 'Boletim não encontrado' });

    // Acha boletim anterior do mesmo contrato (qualquer competencia anterior, mais recente primeiro)
    const anterior = await req.db.prepare(`
      SELECT id FROM bol_boletins
      WHERE contrato_id = ? AND id < ?
      ORDER BY id DESC LIMIT 1
    `).get(bol.contrato_id, boletim_id);
    if (!anterior) return res.status(404).json({ error: 'Nenhum boletim anterior encontrado para este contrato' });

    const colabsRaw = await req.db.prepare(`
      SELECT posto_id, nome_colaborador, cpf, funcao, ordem
      FROM bol_boletim_colaboradores WHERE boletim_id = ?
    `).all(anterior.id);
    const colabs = Array.isArray(colabsRaw) ? colabsRaw : [];
    if (!colabs.length) return res.json({ ok: true, copiados: 0, fonte_boletim_id: anterior.id });

    // Limpa colaboradores atuais (substitui ao copiar)
    await req.db.prepare('DELETE FROM bol_boletim_colaboradores WHERE boletim_id = ?').run(boletim_id);

    let copiados = 0;
    for (const c of colabs) {
      await req.db.prepare(`
        INSERT INTO bol_boletim_colaboradores
          (boletim_id, posto_id, nome_colaborador, cpf, funcao, ordem)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(boletim_id, c.posto_id, c.nome_colaborador, c.cpf, c.funcao, c.ordem);
      copiados++;
    }
    res.json({ ok: true, copiados, fonte_boletim_id: anterior.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════
//  GLOSAS DETALHADAS POR BOLETIM
//  (recalcula bol_boletins.glosas e valor_total ao mudar a lista)
// ════════════════════════════════════════════════════════════════════

async function recalcularGlosaTotal(db, boletim_id) {
  const sumRow = await db.prepare(`
    SELECT COALESCE(SUM(valor), 0) as total
    FROM bol_boletim_glosas WHERE boletim_id = ?
  `).get(boletim_id);
  const totalGlosa = sumRow ? Number(sumRow.total || 0) : 0;
  const bol = await db.prepare('SELECT valor_base, acrescimos FROM bol_boletins WHERE id = ?').get(boletim_id);
  if (!bol) return { totalGlosa, valor_total: 0 };
  const valor_total = +Number((bol.valor_base || 0) + (bol.acrescimos || 0) - totalGlosa).toFixed(2);
  await db.prepare(`
    UPDATE bol_boletins SET glosas = ?, valor_total = ?, updated_at = NOW()
    WHERE id = ?
  `).run(totalGlosa, valor_total, boletim_id);
  return { totalGlosa, valor_total };
}

// GET /api/boletins/:boletim_id/glosas
router.get('/:boletim_id/glosas', async (req, res) => {
  try {
    const rowsRaw = await req.db.prepare(`
      SELECT bbg.*, bp.descricao_posto
      FROM bol_boletim_glosas bbg
      LEFT JOIN bol_postos bp ON bp.id = bbg.posto_id
      WHERE bbg.boletim_id = ?
      ORDER BY bbg.created_at ASC
    `).all(req.params.boletim_id);
    const rows = Array.isArray(rowsRaw) ? rowsRaw : [];
    const total = rows.reduce((s, r) => s + Number(r.valor || 0), 0);
    res.json({ ok: true, glosas: rows, total: +total.toFixed(2) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/boletins/:boletim_id/glosas  body: { posto_id?, motivo, valor, data_referencia? }
router.post('/:boletim_id/glosas', async (req, res) => {
  try {
    const boletim_id = parseInt(req.params.boletim_id);
    const { posto_id, motivo, valor, data_referencia } = req.body || {};
    if (!motivo) return res.status(400).json({ error: 'motivo obrigatório' });
    const v = Math.max(0, parseFloat(valor) || 0);
    if (v <= 0) return res.status(400).json({ error: 'valor deve ser > 0' });
    const r = await req.db.prepare(`
      INSERT INTO bol_boletim_glosas (boletim_id, posto_id, motivo, valor, data_referencia)
      VALUES (?, ?, ?, ?, ?)
    `).run(boletim_id, posto_id || null, motivo, v, data_referencia || null);
    const recalc = await recalcularGlosaTotal(req.db, boletim_id);
    res.json({ ok: true, id: r.lastInsertRowid, ...recalc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/boletins/glosas/:id  body: { motivo, valor, data_referencia, posto_id }
router.put('/glosas/:id', async (req, res) => {
  try {
    const g = req.body || {};
    const cur = await req.db.prepare('SELECT boletim_id FROM bol_boletim_glosas WHERE id = ?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Glosa não encontrada' });
    await req.db.prepare(`
      UPDATE bol_boletim_glosas SET
        motivo          = COALESCE(?, motivo),
        valor           = COALESCE(?, valor),
        data_referencia = COALESCE(?, data_referencia),
        posto_id        = COALESCE(?, posto_id)
      WHERE id = ?
    `).run(
      g.motivo || null,
      g.valor != null ? Math.max(0, parseFloat(g.valor) || 0) : null,
      g.data_referencia || null,
      g.posto_id || null,
      req.params.id
    );
    const recalc = await recalcularGlosaTotal(req.db, cur.boletim_id);
    res.json({ ok: true, ...recalc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/boletins/glosas/:id
router.delete('/glosas/:id', async (req, res) => {
  try {
    const cur = await req.db.prepare('SELECT boletim_id FROM bol_boletim_glosas WHERE id = ?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Glosa não encontrada' });
    await req.db.prepare('DELETE FROM bol_boletim_glosas WHERE id = ?').run(req.params.id);
    const recalc = await recalcularGlosaTotal(req.db, cur.boletim_id);
    res.json({ ok: true, ...recalc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
//   P2 (2026-04-30) — FLUXO PRÉVIA → APROVAÇÃO → EMISSÃO → BOLETIM FINAL
// ═════════════════════════════════════════════════════════════════════════════

// ─── TEMPLATE: preview de discriminação ───────────────────────────
// GET /boletins/contratos/:id/template-preview?competencia=YYYY-MM&posto_id=N
// Renderiza o template_discriminacao do contrato com contexto montado.
router.get('/contratos/:id/template-preview', async (req, res) => {
  try {
    const contrato = await req.db.prepare('SELECT * FROM bol_contratos WHERE id = ?').get(req.params.id);
    if (!contrato) return res.status(404).json({ error: 'Contrato não encontrado' });

    const { competencia, posto_id, valor_total } = req.query;
    if (!competencia) return res.status(400).json({ error: 'competencia (YYYY-MM) obrigatória' });

    let posto = null;
    if (posto_id) {
      posto = await req.db.prepare('SELECT * FROM bol_postos WHERE id = ? AND contrato_id = ?')
        .get(Number(posto_id), Number(req.params.id));
    }

    const template = contrato.template_discriminacao || tplEngine.sugerirTemplateDefault(contrato);
    const ctx = tplEngine.buildContext({
      contrato, posto, competencia,
      valor_total: Number(valor_total || 0),
    });
    const renderizado = tplEngine.render(template, ctx);
    const inspect = tplEngine.inspect(template);

    res.json({
      ok: true,
      template,
      template_default_sugerido: contrato.template_discriminacao ? null : tplEngine.sugerirTemplateDefault(contrato),
      renderizado,
      contexto: ctx,
      variaveis_usadas: inspect.vars,
      variaveis_desconhecidas: inspect.desconhecidas,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /boletins/templates/variaveis — lista todas variáveis disponíveis (helper UI)
router.get('/templates/variaveis', async (req, res) => {
  res.json({
    variaveis: [
      { var: '{COMPETENCIA}',       desc: 'YYYY-MM', exemplo: '2026-04' },
      { var: '{MES_NOME}',          desc: 'Nome do mês em maiúsculo', exemplo: 'ABRIL' },
      { var: '{ANO}',               desc: 'Ano com 4 dígitos', exemplo: '2026' },
      { var: '{PERIODO_INICIO}',    desc: 'Primeiro dia do mês (ISO)', exemplo: '2026-04-01' },
      { var: '{PERIODO_FIM}',       desc: 'Último dia do mês (ISO)', exemplo: '2026-04-30' },
      { var: '{PERIODO_INICIO_BR}', desc: 'Primeiro dia (DD/MM/YYYY)', exemplo: '01/04/2026' },
      { var: '{PERIODO_FIM_BR}',    desc: 'Último dia (DD/MM/YYYY)',    exemplo: '30/04/2026' },
      { var: '{POSTO_NOME}',        desc: 'Nome do campus/posto',       exemplo: 'CAMPUS PALMAS' },
      { var: '{POSTO_MUNICIPIO}',   desc: 'Município do posto',         exemplo: 'PALMAS/TO' },
      { var: '{POSTO_DESCRICAO}',   desc: 'Descrição do serviço no posto', exemplo: 'Vigilância 12x36' },
      { var: '{CONTRATO_NUMERO}',   desc: 'Número do contrato',         exemplo: '02/2024' },
      { var: '{CONTRATO_NOME}',     desc: 'Nome do contrato no sistema', exemplo: 'DETRAN-TO Limpeza' },
      { var: '{CONTRATANTE}',       desc: 'Razão social do tomador',    exemplo: 'DEPARTAMENTO ESTADUAL DE TRANSITO' },
      { var: '{PROCESSO}',          desc: 'Número do processo',         exemplo: '23101.004080/2022-53' },
      { var: '{PREGAO}',            desc: 'Número do pregão',           exemplo: '10/2022' },
      { var: '{VALOR_TOTAL}',       desc: 'Valor total (formato 1234.56)', exemplo: '5039.00' },
      { var: '{VALOR_TOTAL_BR}',    desc: 'Valor formatado BR (1.234,56)', exemplo: '5.039,00' },
      { var: '{EMPRESA_RAZAO}',     desc: 'Razão social da emissora',   exemplo: 'MONTANA SEGURANÇA PRIVADA LTDA' },
      { var: '{EMPRESA_CNPJ}',      desc: 'CNPJ da emissora',           exemplo: '19.200.109/0001-09' },
    ],
    sintaxe_fallback: '{VAR|fallback}',
    sintaxe_fallback_exemplo: '{POSTO_DESCRICAO|VIGILÂNCIA}'
  });
});

// ─── ADITIVOS — CRUD ──────────────────────────────────────────────

// GET /boletins/aditivos?contrato_id=N
router.get('/aditivos', async (req, res) => {
  try {
    const where = req.query.contrato_id ? 'WHERE contrato_id = ?' : '';
    const params = req.query.contrato_id ? [Number(req.query.contrato_id)] : [];
    const rows = await req.db.prepare(`
      SELECT a.*, c.nome AS contrato_nome, c.numero_contrato
      FROM bol_aditivos a
      JOIN bol_contratos c ON c.id = a.contrato_id
      ${where}
      ORDER BY a.contrato_id, a.vigencia_de DESC
    `).all(...params);
    res.json({ ok: true, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /boletins/aditivos/:id
router.get('/aditivos/:id', async (req, res) => {
  try {
    const r = await req.db.prepare('SELECT * FROM bol_aditivos WHERE id = ?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Aditivo não encontrado' });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /boletins/aditivos
// Body: { contrato_id, tipo, data_assinatura, vigencia_de, vigencia_ate, fator, base_legal, observacao }
router.post('/aditivos', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.contrato_id) return res.status(400).json({ error: 'contrato_id obrigatório' });
    if (!b.tipo)         return res.status(400).json({ error: 'tipo obrigatório (reajuste|prorrogacao|apostilamento|reequilibrio)' });
    if (!b.vigencia_de)  return res.status(400).json({ error: 'vigencia_de obrigatória' });

    const tipos = ['reajuste','prorrogacao','apostilamento','reequilibrio'];
    if (!tipos.includes(b.tipo)) {
      return res.status(400).json({ error: `tipo inválido. Use: ${tipos.join(', ')}` });
    }

    const fator = Number(b.fator || 1.0);
    if (b.tipo === 'reajuste' && (fator <= 0 || fator > 5)) {
      return res.status(400).json({ error: 'fator de reajuste suspeito (precisa estar entre 0 e 5, ex: 1.0825 para +8.25%)' });
    }

    const r = await req.db.prepare(`
      INSERT INTO bol_aditivos
        (contrato_id, tipo, data_assinatura, vigencia_de, vigencia_ate,
         fator, base_legal, observacao, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rascunho')
    `).run(
      Number(b.contrato_id), b.tipo,
      b.data_assinatura || null,
      b.vigencia_de, b.vigencia_ate || null,
      fator,
      b.base_legal || '', b.observacao || ''
    );
    res.json({ ok: true, id: r.lastInsertRowid, status: 'rascunho' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /boletins/aditivos/:id
router.patch('/aditivos/:id', async (req, res) => {
  try {
    const cur = await req.db.prepare('SELECT * FROM bol_aditivos WHERE id = ?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Aditivo não encontrado' });
    if (cur.status === 'aplicado') {
      return res.status(409).json({ error: 'Aditivo já aplicado — não pode editar. Cadastre um aditivo de reequilíbrio para corrigir.' });
    }

    const b = req.body || {};
    await req.db.prepare(`
      UPDATE bol_aditivos SET
        tipo            = COALESCE(?, tipo),
        data_assinatura = COALESCE(?, data_assinatura),
        vigencia_de     = COALESCE(?, vigencia_de),
        vigencia_ate    = COALESCE(?, vigencia_ate),
        fator           = COALESCE(?, fator),
        base_legal      = COALESCE(?, base_legal),
        observacao      = COALESCE(?, observacao),
        updated_at      = NOW()
      WHERE id = ?
    `).run(
      b.tipo || null, b.data_assinatura || null, b.vigencia_de || null,
      b.vigencia_ate || null, b.fator !== undefined ? Number(b.fator) : null,
      b.base_legal || null, b.observacao || null,
      req.params.id
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /boletins/aditivos/:id/validar — humano confere e valida (Q3 semi-automático)
router.patch('/aditivos/:id/validar', async (req, res) => {
  try {
    const cur = await req.db.prepare('SELECT * FROM bol_aditivos WHERE id = ?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Aditivo não encontrado' });
    if (cur.status !== 'rascunho') {
      return res.status(409).json({ error: `aditivo já está ${cur.status}` });
    }

    const usuario = req.user?.usuario || 'sistema';
    await req.db.prepare(`
      UPDATE bol_aditivos
      SET status = 'validado', validado_por = ?, validado_em = NOW(), updated_at = NOW()
      WHERE id = ?
    `).run(usuario, req.params.id);

    res.json({ ok: true, status: 'validado' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /boletins/aditivos/:id/cancelar
// Body: { motivo: 'descrição do motivo' } — P0-7 fix: obrigatório pra audit
router.patch('/aditivos/:id/cancelar', async (req, res) => {
  try {
    const motivo = (req.body?.motivo || '').trim();
    if (!motivo || motivo.length < 5) {
      return res.status(400).json({ error: 'Motivo obrigatório (mínimo 5 caracteres) para audit.' });
    }
    const cur = await req.db.prepare('SELECT * FROM bol_aditivos WHERE id = ?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Aditivo não encontrado' });
    const usuario = req.user?.usuario || 'sistema';
    const carimbo = `[${new Date().toISOString().slice(0,16)} ${usuario}] CANCELADO: ${motivo}`;
    await req.db.prepare(`
      UPDATE bol_aditivos SET
        status = 'cancelado',
        observacao = CASE WHEN observacao IS NULL OR observacao = '' THEN ? ELSE observacao || E'\\n' || ? END,
        updated_at = NOW()
      WHERE id = ?
    `).run(carimbo, carimbo, req.params.id);
    res.json({ ok: true, status: 'cancelado', motivo_registrado: motivo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /boletins/aditivos/:id (apenas rascunho)
router.delete('/aditivos/:id', async (req, res) => {
  try {
    const cur = await req.db.prepare('SELECT status FROM bol_aditivos WHERE id = ?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Aditivo não encontrado' });
    if (cur.status !== 'rascunho') {
      return res.status(409).json({ error: 'Só é permitido excluir aditivos em rascunho. Use cancelar para os outros estados.' });
    }
    await req.db.prepare('DELETE FROM bol_aditivos WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /boletins/aditivos/:id/preview-impacto?competencia=YYYY-MM
// Mostra qual seria o impacto do aditivo na próxima prévia
router.get('/aditivos/:id/preview-impacto', async (req, res) => {
  try {
    const adit = await req.db.prepare(`
      SELECT a.*, c.nome AS contrato_nome, c.numero_contrato
      FROM bol_aditivos a
      JOIN bol_contratos c ON c.id = a.contrato_id
      WHERE a.id = ?
    `).get(req.params.id);
    if (!adit) return res.status(404).json({ error: 'Aditivo não encontrado' });

    const comp = req.query.competencia || new Date().toISOString().slice(0,7);

    // Pega último boletim do contrato pra projetar valor
    const refBoletim = await req.db.prepare(`
      SELECT competencia, total_geral FROM bol_boletins
      WHERE contrato_id = ? ORDER BY competencia DESC LIMIT 1
    `).get(adit.contrato_id);

    const fator = Number(adit.fator || 1.0);
    const valorBase = Number(refBoletim?.total_geral || 0);
    const valorAjustado = adit.tipo === 'reajuste' ? valorBase * fator : valorBase;

    res.json({
      ok: true,
      aditivo: adit,
      preview: {
        competencia: comp,
        valor_base_referencia: valorBase,
        ref_boletim_competencia: refBoletim?.competencia,
        fator_aplicado: fator,
        valor_apos_aditivo: valorAjustado,
        diferenca: valorAjustado - valorBase,
        diferenca_pct: valorBase > 0 ? +((valorAjustado - valorBase) / valorBase * 100).toFixed(2) : 0,
      },
      observacao: adit.tipo === 'reajuste'
        ? `Reajuste de ${((fator - 1) * 100).toFixed(2)}% será aplicado à próxima prévia em ${comp}`
        : `Aditivo do tipo ${adit.tipo} não altera valor diretamente (verifique itens)`
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PRÉVIA — gera/atualiza boletim em estado 'previa' ─────────────
// POST /boletins/previa
// Body: { competencia: 'YYYY-MM', empresa?: 'seguranca' (opcional, usa req.companyKey),
//         contrato_id?: N (filtra um contrato), apply: false (default dry-run) }
//
// Lógica:
//   1. Para cada bol_contrato ATIVO (ou só o filtrado):
//      a. Para cada bol_posto do contrato (ou linha única se sem posto):
//         - Calcula valor base via SUM(bol_itens) ou fallback SUM(NFs)
//         - Aplica aditivos validados/aplicados (fator multiplicativo)
//         - Renderiza template_discriminacao (ou default sugerido)
//      b. UPSERT em bol_boletins (contrato_id, posto_id, competencia)
//         status='previa', expira_em=+7 d.u.
//      c. Cria/atualiza linhas em bol_boletins_nfs_planejadas
//
// Retorna: { previas: [...], total_geral, total_nfs_planejadas }
router.post('/previa', async (req, res) => {
  try {
    const { competencia, contrato_id, apply = false } = req.body || {};
    if (!competencia || !/^\d{4}-\d{2}$/.test(competencia)) {
      return res.status(400).json({ error: 'competencia (YYYY-MM) obrigatória' });
    }

    const db = req.db;
    const usuario = req.user?.usuario || 'sistema';

    // Calcular expiração: hoje + 7 dias úteis (pula sáb/dom)
    function add7Du() {
      const d = new Date();
      let added = 0;
      while (added < 7) {
        d.setDate(d.getDate() + 1);
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) added++;
      }
      return d.toISOString().slice(0, 10);
    }
    const expiraEm = add7Du();

    // Período ISO
    const { inicio: periodoInicio, fim: periodoFim } = tplEngine.periodoDoMes(competencia);

    // Buscar contratos ativos
    let contratos;
    if (contrato_id) {
      contratos = await db.prepare('SELECT * FROM bol_contratos WHERE id = ? AND ativo = 1').all(Number(contrato_id));
    } else {
      contratos = await db.prepare('SELECT * FROM bol_contratos WHERE ativo = 1 ORDER BY id').all();
    }

    const previas = [];
    let totalNfsPlanejadas = 0;

    for (const c of contratos) {
      // Pega postos do contrato
      const postos = await db.prepare('SELECT * FROM bol_postos WHERE contrato_id = ? ORDER BY ordem, id').all(c.id);
      // Se não tem posto cadastrado, gera 1 boletim consolidado (posto_id=NULL)
      const linhas = postos.length > 0 ? postos : [null];

      for (const posto of linhas) {
        // Calcular valor base
        let valorBase = 0;
        let origemValor = 'sem_ref';
        let qtdNfs = 0;

        if (posto) {
          // Soma dos itens do posto (quando há cadastro estruturado)
          const sumItens = await db.prepare(`
            SELECT COALESCE(SUM(quantidade * valor_unitario), 0) AS total, COUNT(*) AS qtd
            FROM bol_itens WHERE posto_id = ?
          `).get(posto.id);
          if (sumItens && Number(sumItens.total) > 0) {
            valorBase = Number(sumItens.total);
            origemValor = `sum_itens(${sumItens.qtd})`;
          }
        }

        // Fallback: SUM das NFs do mês alvo via numero_contrato
        if (!valorBase && c.numero_contrato && c.numero_contrato !== 'undefined') {
          const sumNfs = await db.prepare(`
            SELECT COALESCE(SUM(valor_bruto), 0) AS total, COUNT(*) AS qtd
            FROM notas_fiscais
            WHERE contrato_ref ILIKE @pat AND data_emissao LIKE @ym
              AND COALESCE(status_conciliacao, '') NOT IN ('CANCELADA')
          `).get({ pat: `%${c.numero_contrato}%`, ym: `${competencia}-%` });
          if (sumNfs && Number(sumNfs.total) > 0) {
            valorBase = Number(sumNfs.total);
            origemValor = `sum_nfs(${sumNfs.qtd})`;
            qtdNfs = sumNfs.qtd;
          }
        }

        // Aplica aditivos
        const aditResult = await aplicarAditivos(db, c.id, competencia, valorBase);
        const valorFinal = aditResult.valor_final;

        // Renderiza template
        const template = c.template_discriminacao || tplEngine.sugerirTemplateDefault(c);
        const ctx = tplEngine.buildContext({
          contrato: c, posto, competencia, valor_total: valorFinal,
        });
        const discriminacaoRender = tplEngine.render(template, ctx);

        previas.push({
          contrato_id: c.id,
          contrato_numero: c.numero_contrato,
          contrato_nome: c.nome,
          posto_id: posto?.id || null,
          posto_nome: posto?.campus_nome || null,
          posto_municipio: posto?.municipio || null,
          competencia,
          periodo_inicio: periodoInicio,
          periodo_fim: periodoFim,
          valor_base: valorBase,
          origem_valor: origemValor,
          qtd_nfs_referencia: qtdNfs,
          aditivos_aplicados: aditResult.aditivos_aplicados,
          valor_final: valorFinal,
          template_renderizado: discriminacaoRender,
          template_origem: c.template_discriminacao ? 'cadastrado' : 'default_sugerido',
          expira_em: expiraEm,
        });
      }
    }

    if (!apply) {
      return res.json({
        ok: true,
        modo: 'dry-run',
        competencia,
        total_previas: previas.length,
        previas,
      });
    }

    // APPLY: UPSERT em bol_boletins + NFs planejadas
    let criados = 0, atualizados = 0;
    const trans = db.transaction(async (tx) => {
      const upsertBoletim = tx.prepare(`
        INSERT INTO bol_boletins
          (contrato_id, posto_id, competencia, data_emissao, periodo_inicio, periodo_fim,
           status, total_geral, valor_base, glosas, acrescimos, nfse_status,
           expira_em, template_renderizado)
        VALUES
          (@cid, @pid, @comp, @demit, @ini, @fim, 'previa', @tot, 0, 0, 0, 'PENDENTE',
           @exp, @tpl)
        ON CONFLICT (contrato_id, COALESCE(posto_id, 0), competencia) DO UPDATE SET
          total_geral          = EXCLUDED.total_geral,
          template_renderizado = EXCLUDED.template_renderizado,
          expira_em            = EXCLUDED.expira_em,
          status               = CASE WHEN bol_boletins.status IN ('previa', 'gerado', 'sem_nf') THEN 'previa' ELSE bol_boletins.status END,
          updated_at           = NOW()
        RETURNING id, (xmax = 0) AS inserted
      `);
      const insertNfPlanejada = tx.prepare(`
        INSERT INTO bol_boletins_nfs_planejadas
          (boletim_id, ordem, posto_id, descricao_template, valor, status)
        VALUES (?, 1, ?, ?, ?, 'pendente')
        ON CONFLICT DO NOTHING
      `);
      for (const p of previas) {
        const r = await upsertBoletim.run({
          cid: p.contrato_id, pid: p.posto_id, comp: p.competencia,
          demit: p.periodo_fim, ini: p.periodo_inicio, fim: p.periodo_fim,
          tot: p.valor_final, exp: p.expira_em, tpl: p.template_renderizado,
        });
        const boletimId = r.lastInsertRowid;
        if (boletimId) {
          // Garante 1 NF planejada por boletim (modelo 1:1 boletim:NF para DETRAN/UFT)
          // Se já existia e tem nfse_numero, não toca (preserva)
          const existing = await tx.prepare(`
            SELECT id, nfse_numero FROM bol_boletins_nfs_planejadas
            WHERE boletim_id = ? ORDER BY ordem LIMIT 1
          `).get(boletimId);
          if (!existing) {
            await insertNfPlanejada.run(boletimId, p.posto_id, p.template_renderizado, p.valor_final);
            totalNfsPlanejadas++;
          } else if (!existing.nfse_numero) {
            // Atualiza valor + descrição se ainda não emitiu
            await tx.prepare(`
              UPDATE bol_boletins_nfs_planejadas
              SET valor = ?, descricao_template = ?, updated_at = NOW()
              WHERE id = ?
            `).run(p.valor_final, p.template_renderizado, existing.id);
          }
          if (r.changes > 0) criados++; else atualizados++;
        }
      }
    });
    await trans();

    res.json({
      ok: true,
      modo: 'apply',
      competencia,
      criados,
      atualizados,
      total_previas: previas.length,
      total_nfs_planejadas: totalNfsPlanejadas,
      expira_em: expiraEm,
    });
  } catch (e) {
    console.error('[POST /boletins/previa] erro:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── PRÉVIAS — listar / aprovar / cancelar ─────────────────────────

// GET /boletins/previas?competencia=YYYY-MM&status=previa,aprovado
// Lista boletins com NFs planejadas, filtrável por status (suporta CSV)
router.get('/previas', async (req, res) => {
  try {
    const { competencia, status, contrato_id } = req.query;
    const where = ['1=1'];
    const params = [];
    if (competencia) { where.push('bb.competencia = ?'); params.push(competencia); }
    if (status) {
      const list = String(status).split(',').map(s => s.trim()).filter(Boolean);
      where.push(`bb.status IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
    if (contrato_id) { where.push('bb.contrato_id = ?'); params.push(Number(contrato_id)); }

    const rows = await req.db.prepare(`
      SELECT bb.*, bc.nome AS contrato_nome, bc.numero_contrato,
             bp.campus_nome AS posto_nome, bp.municipio AS posto_municipio
      FROM bol_boletins bb
      JOIN bol_contratos bc ON bc.id = bb.contrato_id
      LEFT JOIN bol_postos bp ON bp.id = bb.posto_id
      WHERE ${where.join(' AND ')}
      ORDER BY bb.competencia DESC, bc.nome, bp.ordem NULLS FIRST
    `).all(...params);

    // Anexa NFs planejadas
    for (const r of rows) {
      r.nfs_planejadas = await req.db.prepare(`
        SELECT * FROM bol_boletins_nfs_planejadas WHERE boletim_id = ? ORDER BY ordem, id
      `).all(r.id);
    }

    res.json({ ok: true, total: rows.length, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /boletins/:id/aprovar — financeiro aprova prévia para emissão
// Body opcional: { observacao }
router.patch('/:id([0-9]+)/aprovar', async (req, res) => {
  try {
    const cur = await req.db.prepare(`
      SELECT bb.*, bc.nome AS contrato_nome FROM bol_boletins bb
      JOIN bol_contratos bc ON bc.id = bb.contrato_id
      WHERE bb.id = ?
    `).get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Boletim não encontrado' });

    if (cur.status !== 'previa') {
      return res.status(409).json({
        error: `Boletim está com status '${cur.status}'. Só prévias podem ser aprovadas.`
      });
    }
    if (cur.expira_em && new Date(cur.expira_em) < new Date()) {
      return res.status(409).json({
        error: `Prévia expirada em ${cur.expira_em}. Gere uma nova prévia.`
      });
    }
    if (Number(cur.total_geral || 0) <= 0) {
      return res.status(409).json({
        error: 'Não é possível aprovar prévia com valor zero. Verifique itens, NFs ou aditivos.'
      });
    }

    // Permissão: role 'financeiro' ou 'admin'
    const role = req.user?.role;
    if (role && !['financeiro', 'admin'].includes(role)) {
      return res.status(403).json({ error: 'Apenas usuários financeiro ou admin podem aprovar prévias.' });
    }
    const usuario = req.user?.usuario || 'sistema';

    await req.db.prepare(`
      UPDATE bol_boletins
      SET status = 'aprovado_para_emissao',
          aprovado_por = ?,
          aprovado_em = NOW(),
          updated_at = NOW()
      WHERE id = ?
    `).run(usuario, req.params.id);

    // Marca aditivos do contrato como 'aplicado' (Q3 fluxo semi-automático)
    await req.db.prepare(`
      UPDATE bol_aditivos SET status = 'aplicado', updated_at = NOW()
      WHERE contrato_id = ? AND status = 'validado'
        AND vigencia_de <= ? AND (vigencia_ate IS NULL OR vigencia_ate >= ?)
    `).run(Number(cur.contrato_id), cur.periodo_inicio, cur.periodo_inicio);

    res.json({
      ok: true,
      id: Number(req.params.id),
      novo_status: 'aprovado_para_emissao',
      aprovado_por: usuario,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /boletins/aprovar-em-lote
// Body: { ids: [1,2,3...], motivo?: '' }
// Aprova múltiplos boletins em prévia em uma única transação.
// P0-1 fix UX: bulk action — antes era 1 clique por boletim (134 cliques pra 67 boletins).
router.post('/aprovar-em-lote', async (req, res) => {
  try {
    const { ids, motivo } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids (array) obrigatório' });
    }
    const role = req.user?.role;
    if (role && !['financeiro', 'admin'].includes(role)) {
      return res.status(403).json({ error: 'Apenas financeiro ou admin podem aprovar prévias.' });
    }
    const usuario = req.user?.usuario || 'sistema';

    const resultados = { aprovados: 0, ignorados: 0, erros: [] };
    const trans = req.db.transaction(async (tx) => {
      for (const id of ids) {
        const cur = await tx.prepare('SELECT * FROM bol_boletins WHERE id = ?').get(Number(id));
        if (!cur) {
          resultados.erros.push({ id, motivo: 'não encontrado' });
          continue;
        }
        if (cur.status !== 'previa') {
          resultados.ignorados++;
          continue;
        }
        if (cur.expira_em && new Date(cur.expira_em) < new Date()) {
          resultados.erros.push({ id, motivo: `expirada em ${cur.expira_em}` });
          continue;
        }
        if (Number(cur.total_geral || 0) <= 0) {
          resultados.erros.push({ id, motivo: 'valor zero' });
          continue;
        }
        await tx.prepare(`
          UPDATE bol_boletins
          SET status = 'aprovado_para_emissao',
              aprovado_por = ?, aprovado_em = NOW(),
              obs = COALESCE(NULLIF(?, ''), obs),
              updated_at = NOW()
          WHERE id = ?
        `).run(usuario, motivo || '', Number(id));
        // Marca aditivos validados como aplicados
        await tx.prepare(`
          UPDATE bol_aditivos SET status = 'aplicado', updated_at = NOW()
          WHERE contrato_id = ? AND status = 'validado'
            AND vigencia_de <= ? AND (vigencia_ate IS NULL OR vigencia_ate >= ?)
        `).run(Number(cur.contrato_id), cur.periodo_inicio, cur.periodo_inicio);
        resultados.aprovados++;
      }
    });
    await trans();

    res.json({ ok: true, ...resultados, total_processados: ids.length });
  } catch (e) {
    console.error('[POST /boletins/aprovar-em-lote] erro:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /boletins/emitir-lote
// Body: { ids: [1,2,3...] }
// Dispara emissão de múltiplos boletins em sequência (não paralelo, pra
// não sobrecarregar WebISS). Cada job individual é registrado em _emissaoJobs.
// Retorna { jobs: [{id, total_nfs}], sse_url_geral: '...' }
router.post('/emitir-lote', async (req, res) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids (array) obrigatório' });
    }
    const role = req.user?.role;
    if (role && !['financeiro', 'admin'].includes(role)) {
      return res.status(403).json({ error: 'Apenas financeiro ou admin podem emitir.' });
    }
    const usuario = req.user?.usuario || 'sistema';

    // Valida cada um
    const aceitos = [];
    const recusados = [];
    for (const id of ids) {
      const cur = await req.db.prepare('SELECT id, status FROM bol_boletins WHERE id = ?').get(Number(id));
      if (!cur) { recusados.push({ id, motivo: 'não encontrado' }); continue; }
      if (cur.status !== 'aprovado_para_emissao') { recusados.push({ id, motivo: `status ${cur.status}` }); continue; }
      if (_emissaoJobs.has(Number(id))) { recusados.push({ id, motivo: 'emissão já em andamento' }); continue; }
      aceitos.push(Number(id));
    }

    if (aceitos.length === 0) {
      return res.status(409).json({ error: 'Nenhum boletim apto pra emissão', recusados });
    }

    // Pra cada aceito, dispara processarEmissao em sequência (sem paralelismo,
    // pra não sobrecarregar WebISS). O usuário acompanha por boletim individual.
    const dbRef = req.db;
    const companyKey = req.companyKey;

    // Marca todos como 'emitindo' e enfileira
    for (const id of aceitos) {
      const nfs = await dbRef.prepare(`
        SELECT * FROM bol_boletins_nfs_planejadas
        WHERE boletim_id = ? AND status = 'pendente'
        ORDER BY ordem, id
      `).all(id);
      if (nfs.length === 0) continue;
      _emissaoJobs.set(id, {
        listeners: new Set(), started_at: new Date(), by: usuario,
        total: nfs.length, processed: 0, sucesso: 0, erros: 0,
      });
      await dbRef.prepare(`UPDATE bol_boletins SET status = 'emitindo', updated_at = NOW() WHERE id = ?`).run(id);

      // Dispara em background (cada boletim independente — o WebISS não suporta paralelismo
      // efetivo por causa de mTLS + fila interna deles)
      setImmediate(() => processarEmissao(dbRef, companyKey, id, nfs, usuario)
        .catch(err => {
          console.error(`[boletins/emitir-lote job=${id}] erro fatal:`, err.message);
          _emissaoEmit(id, { type: 'fatal', erro: err.message });
        }));
    }

    res.json({
      ok: true,
      total_aceitos: aceitos.length,
      total_recusados: recusados.length,
      aceitos,
      recusados,
      sse_urls: aceitos.map(id => `/api/boletins/${id}/emissao-status`),
    });
  } catch (e) {
    console.error('[POST /boletins/emitir-lote] erro:', e);
    res.status(500).json({ error: e.message });
  }
});

// PATCH /boletins/:id/cancelar-previa — desfaz prévia (volta a 'cancelado')
// Body: { motivo: 'descrição do motivo' } — P0-7 fix: obrigatório pra audit fiscal
router.patch('/:id([0-9]+)/cancelar-previa', async (req, res) => {
  try {
    const motivo = (req.body?.motivo || '').trim();
    if (!motivo || motivo.length < 5) {
      return res.status(400).json({ error: 'Motivo obrigatório (mínimo 5 caracteres) para audit fiscal.' });
    }

    const cur = await req.db.prepare('SELECT * FROM bol_boletins WHERE id = ?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Boletim não encontrado' });
    if (!['previa', 'aprovado_para_emissao'].includes(cur.status)) {
      return res.status(409).json({ error: `Não pode cancelar prévia em status '${cur.status}'` });
    }
    // Se já tem NF emitida em algum item planejado, bloqueia
    const temEmitida = await req.db.prepare(`
      SELECT COUNT(*) AS n FROM bol_boletins_nfs_planejadas
      WHERE boletim_id = ? AND status = 'emitida'
    `).get(req.params.id);
    if (temEmitida.n > 0) {
      return res.status(409).json({
        error: `Boletim tem ${temEmitida.n} NF(s) já emitidas. Cancele as NFs no WebISS antes.`
      });
    }

    const usuario = req.user?.usuario || 'sistema';
    const carimbo = `[${new Date().toISOString().slice(0,16)} ${usuario}] ${motivo}`;

    await req.db.prepare(`
      UPDATE bol_boletins SET
        status = 'cancelado',
        obs = CASE WHEN obs IS NULL OR obs = '' THEN ? ELSE obs || E'\\n' || ? END,
        updated_at = NOW()
      WHERE id = ?
    `).run(carimbo, carimbo, req.params.id);
    res.json({ ok: true, novo_status: 'cancelado', motivo_registrado: motivo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /boletins/nfs-planejadas/:id — edita override Q7 antes da emissão
// Body: { descricao_override?, valor? }
router.patch('/nfs-planejadas/:id([0-9]+)', async (req, res) => {
  try {
    const cur = await req.db.prepare(`
      SELECT np.*, bb.status AS boletim_status FROM bol_boletins_nfs_planejadas np
      JOIN bol_boletins bb ON bb.id = np.boletim_id
      WHERE np.id = ?
    `).get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'NF planejada não encontrada' });

    if (cur.status === 'emitida') {
      return res.status(409).json({ error: 'NF já emitida, não pode mais ser editada' });
    }
    if (!['previa', 'aprovado_para_emissao'].includes(cur.boletim_status)) {
      return res.status(409).json({ error: `Boletim está '${cur.boletim_status}', não permite edição` });
    }

    const b = req.body || {};
    await req.db.prepare(`
      UPDATE bol_boletins_nfs_planejadas SET
        descricao_override = COALESCE(?, descricao_override),
        valor              = COALESCE(?, valor),
        updated_at         = NOW()
      WHERE id = ?
    `).run(
      b.descricao_override !== undefined ? b.descricao_override : null,
      b.valor !== undefined ? Number(b.valor) : null,
      req.params.id
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /boletins/nfs-planejadas/:id — exclui uma NF da prévia (antes de aprovar)
router.delete('/nfs-planejadas/:id([0-9]+)', async (req, res) => {
  try {
    const cur = await req.db.prepare(`
      SELECT np.status, bb.status AS boletim_status
      FROM bol_boletins_nfs_planejadas np
      JOIN bol_boletins bb ON bb.id = np.boletim_id
      WHERE np.id = ?
    `).get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'NF planejada não encontrada' });
    if (cur.status === 'emitida') return res.status(409).json({ error: 'NF já emitida, não pode ser removida' });
    if (cur.boletim_status === 'aprovado_para_emissao') {
      return res.status(409).json({ error: 'Boletim já aprovado, não permite remover NFs. Cancele a prévia primeiro.' });
    }
    await req.db.prepare('DELETE FROM bol_boletins_nfs_planejadas WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── EMISSÃO ASSÍNCRONA NFS-e (Fase 5) ─────────────────────────────
// Modelo: cliente faz POST → resposta imediata com job_id, depois
//         conecta em GET /:id/emissao-status (SSE) para acompanhar.

// Estado in-memory dos jobs de emissão (vive por execução do node).
// Se pm2 reiniciar, jobs ativos perdem state — clientes reconectam e
// veem status final lido do banco (bol_boletins_nfs_planejadas.status).
const _emissaoJobs = new Map(); // boletim_id → { listeners: Set<res>, started_at, by }

function _emissaoEmit(boletimId, evt) {
  const job = _emissaoJobs.get(boletimId);
  if (!job) return;
  const payload = `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of job.listeners) {
    try { res.write(payload); } catch (_) {}
  }
}

// POST /boletins/:id/emitir-nfs — dispara emissão em background
// Body opcional: { force_retry: false } (re-tenta NFs com status 'erro')
router.post('/:id([0-9]+)/emitir-nfs', async (req, res) => {
  try {
    const boletimId = Number(req.params.id);
    const cur = await req.db.prepare(`
      SELECT bb.*, bc.nome AS contrato_nome, bc.numero_contrato
      FROM bol_boletins bb
      JOIN bol_contratos bc ON bc.id = bb.contrato_id
      WHERE bb.id = ?
    `).get(boletimId);
    if (!cur) return res.status(404).json({ error: 'Boletim não encontrado' });

    if (cur.status !== 'aprovado_para_emissao') {
      return res.status(409).json({
        error: `Boletim está '${cur.status}'. Apenas 'aprovado_para_emissao' pode emitir.`
      });
    }

    if (_emissaoJobs.has(boletimId)) {
      return res.status(409).json({ error: 'Emissão já em andamento para este boletim. Use o endpoint de status.' });
    }

    const forceRetry = !!(req.body && req.body.force_retry);
    const where = forceRetry ? `status IN ('pendente', 'erro')` : `status = 'pendente'`;
    const nfsParaEmitir = await req.db.prepare(`
      SELECT * FROM bol_boletins_nfs_planejadas
      WHERE boletim_id = ? AND ${where}
      ORDER BY ordem, id
    `).all(boletimId);

    if (nfsParaEmitir.length === 0) {
      return res.status(409).json({ error: 'Nenhuma NF pendente para emitir neste boletim.' });
    }

    const usuario = req.user?.usuario || 'sistema';
    _emissaoJobs.set(boletimId, {
      listeners: new Set(),
      started_at: new Date(),
      by: usuario,
      total: nfsParaEmitir.length,
      processed: 0,
      sucesso: 0,
      erros: 0,
    });

    // Marca status do boletim
    await req.db.prepare(`UPDATE bol_boletins SET status = 'emitindo', updated_at = NOW() WHERE id = ?`).run(boletimId);

    // Resposta imediata
    res.json({
      ok: true,
      job_id: boletimId,
      total_nfs: nfsParaEmitir.length,
      sse_url: `/api/boletins/${boletimId}/emissao-status`,
    });

    // Processa em background (não bloqueia resposta)
    setImmediate(() => processarEmissao(req.db, req.companyKey, boletimId, nfsParaEmitir, usuario)
      .catch(err => {
        console.error(`[boletins/emitir-nfs job=${boletimId}] erro fatal:`, err.message);
        _emissaoEmit(boletimId, { type: 'fatal', erro: err.message });
      }));
  } catch (e) {
    console.error('[POST /boletins/:id/emitir-nfs] erro:', e);
    res.status(500).json({ error: e.message });
  }
});

// Processa emissão NF-a-NF, emitindo eventos SSE
async function processarEmissao(db, companyKey, boletimId, nfsParaEmitir, usuario) {
  // Carrega WebISS dinamicamente (evita ciclo de dependência)
  // Em produção, /webiss/emitir está em src/routes/webiss.js — chamamos via HTTP local.
  // Aqui usamos a rota interna via fetch local pra reaproveitar a lógica de assinatura A1.
  const http = require('http');
  const PORT = process.env.PORT || 3002;

  for (const nfp of nfsParaEmitir) {
    _emissaoEmit(boletimId, { type: 'progress', status: 'emitindo', nf_planejada_id: nfp.id, ordem: nfp.ordem });

    await db.prepare(`
      UPDATE bol_boletins_nfs_planejadas
      SET status = 'emitindo', tentativas = tentativas + 1, updated_at = NOW()
      WHERE id = ?
    `).run(nfp.id);

    try {
      // Carrega contexto: contrato + posto + tomador
      const boletim = await db.prepare(`
        SELECT bb.*, bc.nome AS contrato_nome, bc.numero_contrato, bc.contratante,
               bc.empresa_razao, bc.empresa_cnpj, bc.processo, bc.pregao, bc.orgao
        FROM bol_boletins bb JOIN bol_contratos bc ON bc.id = bb.contrato_id
        WHERE bb.id = ?
      `).get(boletimId);

      // RPS sequencial — usa nfp.id para ter idempotência se WebISS retornar timeout
      const rpsNumero = nfp.rps_numero || `${boletimId}-${nfp.id}`;
      const descricao = nfp.descricao_override || nfp.descricao_template || '';
      const valor = Number(nfp.valor || 0);

      // Body para /webiss/emitir
      const body = {
        rps: {
          numero: rpsNumero,
          serie: nfp.rps_serie || 'NFSE',
          tipo: 1,
          dataEmissao: new Date().toISOString().slice(0, 10),
          competencia: boletim.competencia + '-01',
          servico: {
            valorServicos: valor,
            valorDeducoes: 0,
            issRetido: true,                 // padrão Montana: ISS retido pelo tomador
            valorIss: +(valor * 0.05).toFixed(2),
            aliquota: 5.0,
            itemLista: '07.10',              // Limpeza/Vigilância — códigos ABRASF
            codTributacao: '07.10',
            discriminacao: descricao,
            exigibilidadeIss: 1,
          },
          tomador: {
            cnpj: boletim.orgao || '',
            razaoSocial: boletim.contratante || '',
          },
        },
      };

      // Chama /webiss/emitir via HTTP local
      const resp = await new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const reqLocal = http.request({
          hostname: '127.0.0.1', port: PORT, path: '/api/webiss/emitir',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            'X-Empresa': companyKey,
            'X-Internal-Bypass-Auth': 'montana-internal-' + (process.env.JWT_SECRET || 'montana'),
          },
        }, r => {
          let buf = '';
          r.on('data', c => buf += c);
          r.on('end', () => {
            try { resolve({ status: r.statusCode, json: JSON.parse(buf) }); }
            catch { resolve({ status: r.statusCode, json: { erro: buf } }); }
          });
        });
        reqLocal.on('error', reject);
        reqLocal.write(data);
        reqLocal.end();
      });

      if (resp.status >= 200 && resp.status < 300 && resp.json?.ok && resp.json?.nfse?.numero) {
        const nfse = resp.json.nfse;
        await db.prepare(`
          UPDATE bol_boletins_nfs_planejadas SET
            status = 'emitida',
            nfse_numero = ?,
            nfse_data_emissao = NOW(),
            rps_numero = ?,
            emitida_em = NOW(),
            emitida_por = ?,
            erro_mensagem = NULL,
            updated_at = NOW()
          WHERE id = ?
        `).run(nfse.numero, rpsNumero, usuario, nfp.id);

        const job = _emissaoJobs.get(boletimId);
        if (job) job.sucesso++;
        _emissaoEmit(boletimId, {
          type: 'progress', status: 'emitida',
          nf_planejada_id: nfp.id, nfse_numero: nfse.numero, valor,
        });
      } else {
        const erroMsg = resp.json?.error || resp.json?.erro || JSON.stringify(resp.json?.erros || resp.json).slice(0, 500);
        await db.prepare(`
          UPDATE bol_boletins_nfs_planejadas SET
            status = 'erro', erro_mensagem = ?, updated_at = NOW()
          WHERE id = ?
        `).run(erroMsg, nfp.id);
        const job = _emissaoJobs.get(boletimId);
        if (job) job.erros++;
        _emissaoEmit(boletimId, { type: 'progress', status: 'erro', nf_planejada_id: nfp.id, erro: erroMsg });
      }
    } catch (e) {
      await db.prepare(`
        UPDATE bol_boletins_nfs_planejadas SET status = 'erro', erro_mensagem = ?, updated_at = NOW()
        WHERE id = ?
      `).run(e.message, nfp.id);
      const job = _emissaoJobs.get(boletimId);
      if (job) job.erros++;
      _emissaoEmit(boletimId, { type: 'progress', status: 'erro', nf_planejada_id: nfp.id, erro: e.message });
    }

    const job = _emissaoJobs.get(boletimId);
    if (job) job.processed++;
  }

  // Conclusão: atualiza status do boletim
  const stats = await db.prepare(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'emitida')   AS emitidas,
      COUNT(*) FILTER (WHERE status = 'erro')      AS erros,
      COUNT(*) FILTER (WHERE status = 'pendente')  AS pendentes
    FROM bol_boletins_nfs_planejadas WHERE boletim_id = ?
  `).get(boletimId);

  let novoStatus = 'emitido';
  if (stats.erros > 0 && stats.emitidas === 0) novoStatus = 'erro_emissao';
  else if (stats.erros > 0) novoStatus = 'emitido';   // parcial = considera emitido (com erros)
  else if (stats.pendentes > 0) novoStatus = 'aprovado_para_emissao'; // ainda tem pendente

  await db.prepare(`UPDATE bol_boletins SET status = ?, updated_at = NOW() WHERE id = ?`).run(novoStatus, boletimId);

  _emissaoEmit(boletimId, { type: 'done', status_boletim: novoStatus, ...stats });

  // Cleanup do job (mantém por 60s pra clientes lentos terem tempo de receber)
  setTimeout(() => {
    const job = _emissaoJobs.get(boletimId);
    if (job) {
      for (const r of job.listeners) try { r.end(); } catch (_) {}
      _emissaoJobs.delete(boletimId);
    }
  }, 60000);
}

// GET /boletins/:id/emissao-status — SSE stream do progresso
router.get('/:id([0-9]+)/emissao-status', async (req, res) => {
  const boletimId = Number(req.params.id);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',  // Nginx: desabilita buffer
  });
  res.flushHeaders?.();

  // Estado inicial
  const boletim = await req.db.prepare('SELECT status FROM bol_boletins WHERE id = ?').get(boletimId);
  const stats = await req.db.prepare(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'emitida')  AS emitidas,
      COUNT(*) FILTER (WHERE status = 'erro')     AS erros,
      COUNT(*) FILTER (WHERE status = 'pendente') AS pendentes,
      COUNT(*) FILTER (WHERE status = 'emitindo') AS emitindo
    FROM bol_boletins_nfs_planejadas WHERE boletim_id = ?
  `).get(boletimId);
  res.write(`event: snapshot\ndata: ${JSON.stringify({ status_boletim: boletim?.status, ...stats })}\n\n`);

  // Se já tá tudo concluído, encerra
  if (!_emissaoJobs.has(boletimId)) {
    res.write(`event: done\ndata: ${JSON.stringify({ reason: 'no-active-job', ...stats })}\n\n`);
    return res.end();
  }

  // Adiciona listener
  const job = _emissaoJobs.get(boletimId);
  job.listeners.add(res);

  // Cleanup ao desconectar
  req.on('close', () => {
    job.listeners.delete(res);
  });
});

// ─── HELPER: aplica aditivos sobre um valor base ──────────────────
// Exportado pra usar em /boletins/previa (Fase 3)
async function aplicarAditivos(db, contratoId, competencia, valorBase) {
  // Pega aditivos VALIDADOS ou APLICADOS cuja vigência cobre a competência
  const compInicio = `${competencia}-01`;
  const aditivos = await db.prepare(`
    SELECT * FROM bol_aditivos
    WHERE contrato_id = ?
      AND status IN ('validado', 'aplicado')
      AND vigencia_de <= ?
      AND (vigencia_ate IS NULL OR vigencia_ate >= ?)
    ORDER BY vigencia_de
  `).all(Number(contratoId), compInicio, compInicio);

  let valor = Number(valorBase || 0);
  const aplicados = [];
  for (const a of aditivos) {
    if (a.tipo === 'reajuste') {
      const novo = valor * Number(a.fator || 1.0);
      aplicados.push({
        aditivo_id: a.id, tipo: a.tipo, fator: Number(a.fator),
        antes: valor, depois: novo, base_legal: a.base_legal,
      });
      valor = novo;
    } else {
      aplicados.push({
        aditivo_id: a.id, tipo: a.tipo, fator: 1.0,
        antes: valor, depois: valor, base_legal: a.base_legal,
        observacao: 'Tipo não-multiplicativo, valor preservado',
      });
    }
  }
  return { valor_final: valor, aditivos_aplicados: aplicados };
}

// Expor pro módulo (Fase 3 vai usar)
router.aplicarAditivos = aplicarAditivos;

// ─── AUTO-CRIAÇÃO REVERSA (cenário 4) ──────────────────────────
// Quando uma NF foi importada (via WebISS batch, XML manual, etc.) mas não
// existe boletim correspondente, cria um boletim "fantasma" com status
// aprovado + nfse_status=EMITIDA, vinculado à NF. Útil pra dar visibilidade
// no Painel de Faturamento de receitas reais sem boletim formal.
//
// Resolução de contrato:
//   1) Match por CNPJ tomador: bol_contratos.insc_municipal == nf.cnpj_tomador
//   2) Fallback por razão social: bol_contratos.contratante LIKE '%' || nf.tomador
//   Se nada bater, a NF fica sem boletim — usuário tem que criar/editar contrato.

async function autoCriarBoletinsFantasmas(db) {
  const orfas = await db.prepare(`
    SELECT id, numero, competencia, tomador, cnpj_tomador, valor_bruto,
           valor_liquido, data_emissao, discriminacao
    FROM notas_fiscais
    WHERE boletim_id IS NULL
      AND COALESCE(numero,'') <> ''
      AND COALESCE(status_conciliacao,'') <> 'CANCELADA'
    LIMIT 500
  `).all();

  let criados = 0, semContrato = 0, jaExistem = 0, linkados = 0;

  for (const nf of (orfas || [])) {
    let comp = (nf.competencia || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(comp) && nf.data_emissao) {
      comp = String(nf.data_emissao).slice(0, 7);
    }
    if (!/^\d{4}-\d{2}$/.test(comp)) continue;

    const cnpjLimpo = String(nf.cnpj_tomador || '').replace(/\D/g, '');
    let contrato = null;
    if (cnpjLimpo) {
      contrato = await db.prepare(`
        SELECT id FROM bol_contratos
        WHERE REGEXP_REPLACE(COALESCE(insc_municipal,''), '[^0-9]', '', 'g') = ?
        LIMIT 1
      `).get(cnpjLimpo);
    }
    if (!contrato && nf.tomador) {
      contrato = await db.prepare(`
        SELECT id FROM bol_contratos
        WHERE UPPER(contratante) LIKE '%' || UPPER(?) || '%'
           OR UPPER(?) LIKE '%' || UPPER(contratante) || '%'
        LIMIT 1
      `).get(nf.tomador, nf.tomador);
    }

    if (!contrato) { semContrato++; continue; }

    const existente = await db.prepare(
      'SELECT id, nfse_numero FROM bol_boletins WHERE contrato_id = ? AND competencia = ?'
    ).get(contrato.id, comp);

    if (existente) {
      jaExistem++;
      try {
        await db.prepare('UPDATE notas_fiscais SET boletim_id = ? WHERE id = ?')
                .run(existente.id, nf.id);
        linkados++;
      } catch (_) {}
      continue;
    }

    try {
      const ins = await db.prepare(`
        INSERT INTO bol_boletins
          (contrato_id, competencia, data_emissao, valor_base, valor_total,
           glosas, acrescimos, discriminacao, status, nfse_status, nfse_numero,
           nfse_data_emissao)
        VALUES (?, ?, ?, ?, ?, 0, 0, ?, 'aprovado', 'EMITIDA', ?, ?)
        RETURNING id
      `).get(
        contrato.id, comp,
        nf.data_emissao || (comp + '-01'),
        +(nf.valor_bruto || 0),
        +(nf.valor_bruto || 0),
        '[AUTO] ' + (nf.discriminacao || 'Boletim criado automaticamente a partir de NF importada'),
        nf.numero,
        nf.data_emissao || (comp + '-01'),
      );
      const boletimId = ins?.id;
      if (boletimId) {
        await db.prepare('UPDATE notas_fiscais SET boletim_id = ? WHERE id = ?')
                .run(boletimId, nf.id);
        criados++;
      }
    } catch (e) {
      console.warn('[boletins] auto-create fantasma falhou pra NF', nf.numero, ':', e.message);
    }
  }

  return { criados, sem_contrato: semContrato, ja_existem: jaExistem, linkados_existentes: linkados };
}

router.post('/_criar-fantasmas', async (req, res) => {
  try {
    const stats = await autoCriarBoletinsFantasmas(req.db);
    res.json({ ok: true, ...stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router._autoCriarBoletinsFantasmas = autoCriarBoletinsFantasmas;

// ─── DIAGNÓSTICO + MIGRAÇÃO LEGADO → PAINEL (cenário 3) ─────────
// O fluxo /gerar (legado) cria 1 boletim com N rows em bol_boletins_nfs
// (uma por posto). O fluxo /gerar-boletim (Painel) usa só
// bol_boletins.nfse_numero (1:1). Coexistem — esses endpoints permitem
// auditar e sincronizar boletins legados ao formato novo sem perda.

// GET /api/boletins/_modelo-stats — quantos boletins em cada modelo
router.get('/_modelo-stats', async (req, res) => {
  try {
    const tem = await req.db.prepare(`
      SELECT COUNT(*)::int n FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'bol_boletins_nfs'
    `).get();
    if (!tem || tem.n === 0) {
      return res.json({ ok: true, total: 0, painel: 0, legado: 0, hibrido: 0, sem_nf: 0 });
    }

    const r = await req.db.prepare(`
      SELECT
        COUNT(*)::int                                                    AS total,
        COUNT(*) FILTER (WHERE COALESCE(b.nfse_numero,'') <> ''
                              AND NOT EXISTS (SELECT 1 FROM bol_boletins_nfs WHERE boletim_id=b.id))::int AS painel,
        COUNT(*) FILTER (WHERE COALESCE(b.nfse_numero,'') = ''
                              AND EXISTS    (SELECT 1 FROM bol_boletins_nfs WHERE boletim_id=b.id))::int AS legado,
        COUNT(*) FILTER (WHERE COALESCE(b.nfse_numero,'') <> ''
                              AND EXISTS    (SELECT 1 FROM bol_boletins_nfs WHERE boletim_id=b.id))::int AS hibrido,
        COUNT(*) FILTER (WHERE COALESCE(b.nfse_numero,'') = ''
                              AND NOT EXISTS (SELECT 1 FROM bol_boletins_nfs WHERE boletim_id=b.id))::int AS sem_nf
      FROM bol_boletins b
    `).get();
    res.json({ ok: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/boletins/_sync-legado — copia o 1º nf_numero de bol_boletins_nfs
// para bol_boletins.nfse_numero quando este último estiver vazio. Idempotente.
// Não apaga bol_boletins_nfs (preserva histórico de PDFs por posto).
router.post('/_sync-legado', async (req, res) => {
  try {
    const tem = await req.db.prepare(`
      SELECT COUNT(*)::int n FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'bol_boletins_nfs'
    `).get();
    if (!tem || tem.n === 0) {
      return res.json({ ok: true, sincronizados: 0, motivo: 'tabela bol_boletins_nfs não existe nesta empresa' });
    }

    const r = await req.db.prepare(`
      UPDATE bol_boletins b
      SET nfse_numero = sub.primeira_nf,
          updated_at  = NOW()
      FROM (
        SELECT boletim_id, MIN(nf_numero) AS primeira_nf
        FROM bol_boletins_nfs
        WHERE COALESCE(nf_numero,'') <> ''
        GROUP BY boletim_id
      ) sub
      WHERE b.id = sub.boletim_id
        AND COALESCE(b.nfse_numero,'') = ''
    `).run();
    res.json({ ok: true, sincronizados: r?.changes || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── VÍNCULO NF ↔ BOLETIM (cenário 1) ───────────────────────────
// Backfill: linka NFs em notas_fiscais com seu boletim correspondente em
// bol_boletins via match exato de número (notas_fiscais.numero =
// bol_boletins.nfse_numero). Idempotente — só toca rows com boletim_id NULL.
router.post('/_link-nfs', async (req, res) => {
  try {
    const r = await req.db.prepare(`
      UPDATE notas_fiscais nf
      SET boletim_id = b.id
      FROM bol_boletins b
      WHERE nf.boletim_id IS NULL
        AND COALESCE(NULLIF(b.nfse_numero,''), '') <> ''
        AND nf.numero = b.nfse_numero
    `).run();
    const linked = r?.changes || 0;

    const orfaos = await req.db.prepare(`
      SELECT COUNT(*)::int n FROM notas_fiscais
      WHERE boletim_id IS NULL
    `).get();
    const boletinsEmitidosSemNf = await req.db.prepare(`
      SELECT COUNT(*)::int n FROM bol_boletins b
      WHERE b.nfse_status = 'EMITIDA'
        AND NOT EXISTS (SELECT 1 FROM notas_fiscais nf WHERE nf.numero = b.nfse_numero)
    `).get();

    res.json({
      ok: true,
      linked,
      nfs_sem_boletim:        orfaos?.n || 0,
      boletins_emitidos_sem_nf: boletinsEmitidosSemNf?.n || 0,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/boletins/:id/nf — devolve a NF de notas_fiscais ligada a este
// boletim (via boletim_id ou fallback por nfse_numero match).
router.get('/:id/nf', async (req, res) => {
  try {
    const bol = await req.db.prepare('SELECT * FROM bol_boletins WHERE id = ?').get(req.params.id);
    if (!bol) return res.status(404).json({ error: 'Boletim não encontrado' });

    let nf = await req.db.prepare(
      'SELECT * FROM notas_fiscais WHERE boletim_id = ? LIMIT 1'
    ).get(bol.id);

    if (!nf && bol.nfse_numero) {
      nf = await req.db.prepare(
        'SELECT * FROM notas_fiscais WHERE numero = ? LIMIT 1'
      ).get(bol.nfse_numero);
      if (nf && !nf.boletim_id) {
        try {
          await req.db.prepare('UPDATE notas_fiscais SET boletim_id = ? WHERE id = ?').run(bol.id, nf.id);
          nf.boletim_id = bol.id;
        } catch (_) {}
      }
    }

    res.json({ ok: true, boletim_id: bol.id, nfse_numero: bol.nfse_numero || null, nf: nf || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DEDUPLICAÇÃO DE BOLETINS ───────────────────────────────────
// Diagnóstico e cleanup de duplicatas (mesmo contrato_id + competencia).
// O middleware no topo tenta aplicar UNIQUE INDEX automaticamente; se há
// dups pré-existentes, esses 2 endpoints permitem listar e mergear.

// GET /api/boletins/_duplicatas — lista grupos com mais de 1 boletim
router.get('/_duplicatas', async (req, res) => {
  try {
    const grupos = await req.db.prepare(`
      SELECT contrato_id, competencia, COUNT(*) AS qtd,
             ARRAY_AGG(id ORDER BY id) AS ids
      FROM bol_boletins
      GROUP BY contrato_id, competencia
      HAVING COUNT(*) > 1
      ORDER BY contrato_id, competencia
    `).all();
    if (!Array.isArray(grupos) || grupos.length === 0) {
      return res.json({ ok: true, total: 0, grupos: [] });
    }
    for (const g of grupos) {
      const c = await req.db.prepare('SELECT nome, contratante FROM bol_contratos WHERE id=?').get(g.contrato_id);
      g.contrato_nome = c?.nome || '';
      g.contratante   = c?.contratante || '';
      g.boletins = await req.db.prepare(`
        SELECT id, status, nfse_status, nfse_numero, valor_total, total_geral,
               created_at, updated_at
        FROM bol_boletins WHERE contrato_id=? AND competencia=?
        ORDER BY id
      `).all(g.contrato_id, g.competencia);
    }
    res.json({ ok: true, total: grupos.length, grupos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/boletins/_dedup — mergea duplicatas seguindo a regra:
// "vencedor" do grupo = NFS-e EMITIDA > status='aprovado' > maior valor_total
// > created_at mais recente. Os perdedores são apagados (FK CASCADE remove
// dependências em bol_boletim_colaboradores e bol_boletim_glosas; manter os
// vínculos em bol_boletins_nfs do vencedor — outros são removidos). Sem
// dry_run=true, executa de fato.
router.post('/_dedup', async (req, res) => {
  try {
    const dryRun = req.query.dry_run === 'true' || req.body?.dry_run === true;
    const grupos = await req.db.prepare(`
      SELECT contrato_id, competencia, ARRAY_AGG(id ORDER BY id) AS ids
      FROM bol_boletins
      GROUP BY contrato_id, competencia
      HAVING COUNT(*) > 1
    `).all();

    if (!Array.isArray(grupos) || grupos.length === 0) {
      return res.json({ ok: true, dry_run: dryRun, grupos_analisados: 0, removidos: 0, plano: [] });
    }

    const plano = [];
    let removidos = 0;
    for (const g of grupos) {
      const bols = await req.db.prepare(`
        SELECT id, status, nfse_status, COALESCE(valor_total, total_geral, 0) AS valor,
               created_at
        FROM bol_boletins WHERE contrato_id=? AND competencia=?
        ORDER BY id
      `).all(g.contrato_id, g.competencia);

      const score = (b) => {
        if (b.nfse_status === 'EMITIDA') return 4;
        if (b.status === 'aprovado')      return 3;
        if ((b.valor || 0) > 0)           return 2;
        return 1;
      };
      bols.sort((a, b) => {
        const ds = score(b) - score(a);
        if (ds !== 0) return ds;
        const dv = (b.valor || 0) - (a.valor || 0);
        if (dv !== 0) return dv;
        return new Date(b.created_at) - new Date(a.created_at);
      });
      const vencedor = bols[0];
      const perdedores = bols.slice(1);

      plano.push({
        contrato_id: g.contrato_id,
        competencia: g.competencia,
        manter:  { id: vencedor.id, status: vencedor.status, nfse_status: vencedor.nfse_status, valor: vencedor.valor },
        remover: perdedores.map(p => ({ id: p.id, status: p.status, nfse_status: p.nfse_status, valor: p.valor })),
      });

      if (!dryRun) {
        for (const p of perdedores) {
          try {
            await req.db.prepare(
              `UPDATE bol_boletins_nfs SET boletim_id = ? WHERE boletim_id = ?`
            ).run(vencedor.id, p.id);
          } catch (_) {}
          await req.db.prepare(`DELETE FROM bol_boletins WHERE id = ?`).run(p.id);
          removidos++;
        }
      }
    }

    // UNIQUE INDEX removido: cenário multi-boletim por (contrato, competência) é suportado.

    res.json({
      ok: true,
      dry_run: dryRun,
      grupos_analisados: grupos.length,
      removidos,
      plano,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CLONAR COMPETÊNCIA ───────────────────────────────────────
// POST /api/boletins/_clonar-competencia
// body: { competencia_origem: "2026-03", competencia_destino: "2026-04",
//         modo_destino_existente: "apagar"|"ignorar"|"duplicar",  // default "apagar"
//         dry_run: false,
//         contratos: [ids] (opcional - filtra só esses contratos da origem) }
router.post('/_clonar-competencia', async (req, res) => {
  const db = req.db;
  const {
    competencia_origem,
    competencia_destino,
    modo_destino_existente = 'apagar',
    dry_run = false,
    contratos = null,
  } = req.body || {};

  if (!competencia_origem || !competencia_destino) {
    return res.status(400).json({ error: 'competencia_origem e competencia_destino são obrigatórios' });
  }
  if (competencia_origem === competencia_destino) {
    return res.status(400).json({ error: 'origem e destino não podem ser iguais' });
  }
  if (!['apagar', 'ignorar', 'duplicar'].includes(modo_destino_existente)) {
    return res.status(400).json({ error: 'modo_destino_existente inválido' });
  }

  const [anoOrig, mesOrig] = competencia_origem.split('-');
  const [anoDest, mesDest] = competencia_destino.split('-');
  const mesNomeOrigem = MESES_NOME_COMPLETO[parseInt(mesOrig)] || mesOrig;
  const mesNomeDestino = MESES_NOME_COMPLETO[parseInt(mesDest)] || mesDest;

  try {
    // 1. Origens
    let origensQuery = 'SELECT * FROM bol_boletins WHERE competencia = ?';
    const origensParams = [competencia_origem];
    if (Array.isArray(contratos) && contratos.length) {
      const ph = contratos.map(() => '?').join(',');
      origensQuery += ` AND contrato_id IN (${ph})`;
      origensParams.push(...contratos);
    }
    origensQuery += ' ORDER BY contrato_id, id';
    const origens = await db.prepare(origensQuery).all(...origensParams);

    if (origens.length === 0) {
      return res.json({ ok: true, dry_run, plano: { motivo: 'sem boletins na origem' }, criados: 0 });
    }

    // 2. Destinos existentes (mesmos contratos da origem)
    const contratoIds = [...new Set(origens.map(o => o.contrato_id))];
    const phC = contratoIds.map(() => '?').join(',');
    const destinosExistentes = await db.prepare(
      `SELECT * FROM bol_boletins WHERE competencia = ? AND contrato_id IN (${phC})`
    ).all(competencia_destino, ...contratoIds);

    const plano = {
      origens: origens.map(o => ({ id: o.id, contrato_id: o.contrato_id, valor_total: o.valor_total, status: o.status })),
      destinos_pre_existentes: destinosExistentes.map(d => ({ id: d.id, contrato_id: d.contrato_id, valor_total: d.valor_total, status: d.status })),
      modo_destino_existente,
      sera_apagado: modo_destino_existente === 'apagar' ? destinosExistentes.length : 0,
      sera_criado: origens.length,
    };

    if (dry_run) {
      return res.json({ ok: true, dry_run: true, plano });
    }

    // 3. Aplicar (transação manual)
    await db.prepare('BEGIN').run();
    try {
      let apagados = 0;
      if (modo_destino_existente === 'apagar' && destinosExistentes.length) {
        const idsDel = destinosExistentes.map(d => d.id);
        const phD = idsDel.map(() => '?').join(',');
        await db.prepare(`DELETE FROM bol_boletins WHERE id IN (${phD})`).run(...idsDel);
        apagados = idsDel.length;
      }

      const criados = [];
      for (const o of origens) {
        // Se modo "ignorar" e já existe destino para este contrato, pula
        if (modo_destino_existente === 'ignorar' &&
            destinosExistentes.some(d => d.contrato_id === o.contrato_id)) {
          continue;
        }

        // Discriminação: substitui mês/ano antigo pelo novo
        let novaDiscr = o.discriminacao || '';
        if (novaDiscr) {
          const reMes = new RegExp(mesNomeOrigem, 'gi');
          novaDiscr = novaDiscr.replace(reMes, mesNomeDestino.toUpperCase());
          if (anoOrig !== anoDest) {
            novaDiscr = novaDiscr.replace(new RegExp(`/${anoOrig}\\b`, 'g'), `/${anoDest}`);
          }
        }

        const ins = await db.prepare(`INSERT INTO bol_boletins
          (contrato_id, competencia, data_emissao, valor_base, valor_total,
           glosas, acrescimos, discriminacao, obs, status, nfse_status)
          VALUES (?, ?, CURRENT_DATE, ?, ?, ?, ?, ?, ?, 'rascunho', 'PENDENTE')`).run(
          o.contrato_id,
          competencia_destino,
          o.valor_base ?? 0,
          o.valor_total ?? 0,
          o.glosas ?? 0,
          o.acrescimos ?? 0,
          novaDiscr,
          o.obs ?? null
        );
        const novoId = ins.lastInsertRowid;

        // Filhas: bol_boletim_colaboradores
        try {
          await db.prepare(`INSERT INTO bol_boletim_colaboradores
            (boletim_id, posto_id, nome_colaborador, cpf, funcao, data_inicio, data_fim, observacao, ordem)
            SELECT ?, posto_id, nome_colaborador, cpf, funcao, data_inicio, data_fim, observacao, ordem
            FROM bol_boletim_colaboradores WHERE boletim_id = ?`).run(novoId, o.id);
        } catch (_) {}

        // Filhas: bol_boletim_glosas
        try {
          await db.prepare(`INSERT INTO bol_boletim_glosas
            (boletim_id, posto_id, motivo, valor, data_referencia)
            SELECT ?, posto_id, motivo, valor, data_referencia
            FROM bol_boletim_glosas WHERE boletim_id = ?`).run(novoId, o.id);
        } catch (_) {}

        criados.push({ origem_id: o.id, novo_id: novoId, contrato_id: o.contrato_id });
      }

      await db.prepare('COMMIT').run();
      res.json({ ok: true, dry_run: false, apagados, criados, total_criados: criados.length, plano });
    } catch (innerErr) {
      try { await db.prepare('ROLLBACK').run(); } catch (_) {}
      throw innerErr;
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GERAR BOLETINS POR POSTO ─────────────────────────────────
// POST /api/boletins/_gerar-por-postos
// body: { contrato_id, competencia, modo_destino_existente: 'apagar'|'ignorar', dry_run: false }
// Cria 1 boletim por posto do contrato, com valor_total = SUM(itens.qtd * valor_unitario)
router.post('/_gerar-por-postos', async (req, res) => {
  const db = req.db;
  const {
    contrato_id,
    competencia,
    modo_destino_existente = 'apagar',
    dry_run = false,
  } = req.body || {};

  if (!contrato_id || !competencia) {
    return res.status(400).json({ error: 'contrato_id e competencia são obrigatórios' });
  }
  if (!['apagar', 'ignorar'].includes(modo_destino_existente)) {
    return res.status(400).json({ error: 'modo_destino_existente inválido' });
  }

  try {
    // 1. Postos do contrato com valor agregado dos itens
    const postos = await db.prepare(`
      SELECT p.id, p.campus_nome, p.municipio, p.descricao_posto,
             COALESCE(SUM(i.quantidade * i.valor_unitario), 0) AS valor_total
      FROM bol_postos p
      LEFT JOIN bol_itens i ON i.posto_id = p.id
      WHERE p.contrato_id = ?
      GROUP BY p.id, p.campus_nome, p.municipio, p.descricao_posto, p.ordem
      ORDER BY p.ordem, p.id
    `).all(contrato_id);

    if (!postos.length) {
      return res.status(404).json({ error: 'Contrato sem postos cadastrados' });
    }

    // 2. Boletins já existentes nessa competência
    const existentes = await db.prepare(
      `SELECT id, posto_id FROM bol_boletins WHERE contrato_id=? AND competencia=?`
    ).all(contrato_id, competencia);

    // 3. Contrato info para discriminação
    const bc = await db.prepare('SELECT * FROM bol_contratos WHERE id=?').get(contrato_id);
    const ct = bc ? await db.prepare('SELECT * FROM contratos WHERE numContrato=?').get(bc.contrato_ref) : null;

    const [ano, mes] = competencia.split('-');
    const mesNome = MESES_NOME_COMPLETO[parseInt(mes)] || mes;
    const tipoServico = bc?.descricao_servico || ct?.contrato || 'SERVIÇOS';
    const numContrato = bc?.contrato_ref || bc?.numero_contrato || '';

    const valorTotalContrato = postos.reduce((s, p) => s + Number(p.valor_total || 0), 0);

    const plano = {
      contrato_id,
      competencia,
      total_postos: postos.length,
      boletins_existentes: existentes.length,
      sera_apagado: modo_destino_existente === 'apagar' ? existentes.length : 0,
      sera_criado: modo_destino_existente === 'apagar'
        ? postos.length
        : postos.filter(p => !existentes.some(e => e.posto_id === p.id)).length,
      valor_total_contrato: valorTotalContrato,
    };

    if (dry_run) {
      return res.json({ ok: true, dry_run: true, plano, postos });
    }

    // 4. Aplicar em transação
    await db.prepare('BEGIN').run();
    try {
      let apagados = 0;
      if (modo_destino_existente === 'apagar' && existentes.length) {
        for (const e of existentes) {
          await db.prepare('DELETE FROM bol_boletins WHERE id = ?').run(e.id);
          apagados++;
        }
      }

      const criados = [];
      for (const p of postos) {
        if (modo_destino_existente === 'ignorar' &&
            existentes.some(e => e.posto_id === p.id)) {
          continue;
        }

        const valor = Number(p.valor_total) || 0;
        const labelPosto = p.descricao_posto || p.campus_nome || '';
        const discriminacao = `PRESTAÇÃO DE SERVIÇOS DE ${tipoServico.toUpperCase()} CONFORME CONTRATO Nº ${numContrato}, COMPETÊNCIA ${mesNome.toUpperCase()}/${ano}. POSTO: ${labelPosto.toUpperCase()}.`;

        const ins = await db.prepare(`INSERT INTO bol_boletins
          (contrato_id, posto_id, competencia, data_emissao,
           valor_base, valor_total, glosas, acrescimos,
           discriminacao, status, nfse_status)
          VALUES (?, ?, ?, CURRENT_DATE, ?, ?, 0, 0, ?, 'rascunho', 'PENDENTE')`).run(
          contrato_id, p.id, competencia, valor, valor, discriminacao
        );

        criados.push({
          boletim_id: ins.lastInsertRowid,
          posto_id: p.id,
          posto: p.campus_nome,
          municipio: p.municipio,
          valor,
        });
      }

      await db.prepare('COMMIT').run();
      res.json({
        ok: true,
        dry_run: false,
        apagados,
        criados,
        total_criados: criados.length,
        valor_total_contrato: valorTotalContrato,
        plano,
      });
    } catch (innerErr) {
      try { await db.prepare('ROLLBACK').run(); } catch (_) {}
      throw innerErr;
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
