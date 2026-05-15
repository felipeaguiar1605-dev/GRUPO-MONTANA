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
    // Override de itens por boletim individual (Multi-contrato 2026-05-14).
    // Quando preenchido, sobrescreve os itens vindos de bol_itens (do posto)
    // tanto na geração do PDF quanto no cálculo do RPS. Formato:
    //   [{ descricao, quantidade, valor_unitario }, ...]
    ['itens_override',    'JSONB'],
  ];
  for (const [col, def] of bolCols) {
    try { await db.prepare(`ALTER TABLE bol_boletins ADD COLUMN ${col} ${def}`).run(); } catch (_) {}
  }

  // Garantia de unicidade — versão PARCIAL (só consolidado, posto_id IS NULL).
  // O índice global sem filter foi quebrado pela Opção A (N boletins/competência
  // quando há postos). DROP do legado + recria parcial.
  try { await db.prepare(`DROP INDEX IF EXISTS idx_bol_uniq_contrato_comp`).run(); } catch (_) {}
  try {
    await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bol_uniq_contrato_comp_null
                      ON bol_boletins(contrato_id, competencia)
                      WHERE posto_id IS NULL`).run();
  } catch (e) {
    if (!global._warnedBolDup) {
      console.warn('[boletins] UNIQUE(contrato_id, competencia) parcial não pôde ser aplicado:', e.message);
      global._warnedBolDup = true;
    }
  }

  // Cenário 1: vínculo NF↔boletim. Garante coluna boletim_id em notas_fiscais
  // e índice. Idempotente. (também é garantido em /emitir-nfse e webiss.js)
  try { await db.prepare(`ALTER TABLE notas_fiscais ADD COLUMN boletim_id BIGINT`).run(); } catch (_) {}
  try { await db.prepare(`CREATE INDEX IF NOT EXISTS idx_nf_boletim ON notas_fiscais(boletim_id)`).run(); } catch (_) {}

  // Colunas adicionais na tabela bol_contratos (necessárias para vinculação contrato financeiro + NFS-e)
  const contrCols = [
    ['contrato_ref',    "TEXT DEFAULT ''"],  // numContrato da tabela contratos
    ['orgao',           "TEXT DEFAULT ''"],  // razão social do tomador para NFS-e
    ['insc_municipal',  "TEXT DEFAULT ''"],  // CNPJ do tomador (campo nomenclatura WebISS)
    ['retencoes_padrao', 'TEXT'],            // JSON com retenções default (PIS,COFINS,INSS,IR,CSLL,issRetido,aliquotaIss) — usado como pré-preenchimento no preview de emissão
    // Multi-contrato (2026-05-14): configuração fiscal específica por contrato.
    // Antes ficava hardcoded em _montarRpsPayload (07.17, 2% ISS, etc.) — agora vem daqui.
    ['processo',                 'TEXT'],          // ex: '2022/20321/000361'
    ['pregao',                   'TEXT'],          // ex: '009/2022'
    ['item_lista_servico',       'TEXT'],          // ex: '0710' (limpeza) | '1705' (locação MdO) | '07.17' (vigilância)
    ['codigo_tributacao_municipal', 'TEXT'],       // geralmente igual ao item_lista_servico
    ['codigo_cnae',              'TEXT'],          // ex: '8111700'
    ['codigo_nbs',               'TEXT'],          // ex: '118031000'
    ['aliquota_iss_padrao',      'NUMERIC(7,4)'],  // ex: 0.05 (5%) — pode ser sobrescrito por posto
    ['iss_retido_padrao',        'BOOLEAN'],       // tomador retém ISS? (DETRAN NÃO; UNITINS/UFT SIM)
    ['optante_simples_nacional', 'SMALLINT'],      // 1=sim, 2=não (default 2 pra Assessoria EPP)
    ['incentivo_fiscal',         'SMALLINT'],      // 1=sim, 2=não
    ['ciclo_dia_inicio',         'SMALLINT'],      // NULL=mês calendário; 14=ciclo 14→13 (UNITINS); 5=ciclo 5→4 (UFT)
    ['dados_bancarios',          'TEXT'],          // texto multilinhas pra entrar na discriminação
    ['template_discriminacao',   'TEXT'],          // template introdutório (sem dados bancários — esses entram via dados_bancarios)
    ['inss_aliquota',            'NUMERIC(7,4)'],  // alíquota INSS (ex: 0.11 = 11%)
    ['inss_base_reduzida',       'BOOLEAN'],       // true = aplica sobre base com deduções (UFT); false = sobre bruto (UNITINS)
    ['irrf_aliquota',            'NUMERIC(7,4)'],  // ex: 0.012 (1,2%)
    ['pis_aliquota',             'NUMERIC(7,4)'],  // ex: 0.0065
    ['cofins_aliquota',          'NUMERIC(7,4)'],  // ex: 0.03
    ['csll_aliquota',            'NUMERIC(7,4)'],  // ex: 0.01
  ];
  for (const [col, def] of contrCols) {
    try { await db.prepare(`ALTER TABLE bol_contratos ADD COLUMN ${col} ${def}`).run(); } catch (_) {}
  }

  // Multi-contrato: codigo IBGE + alíquota local por posto (override do contrato)
  try { await db.prepare(`ALTER TABLE bol_postos ADD COLUMN codigo_municipio_ibge TEXT`).run(); } catch (_) {}
  try { await db.prepare(`ALTER TABLE bol_postos ADD COLUMN aliquota_iss_local NUMERIC(7,4)`).run(); } catch (_) {}
  // Deduções de base INSS por posto (UFT subtrai vale-alimentação e materiais)
  try { await db.prepare(`ALTER TABLE bol_postos ADD COLUMN deducao_vale_alimentacao NUMERIC(14,2) DEFAULT 0`).run(); } catch (_) {}
  try { await db.prepare(`ALTER TABLE bol_postos ADD COLUMN deducao_materiais NUMERIC(14,2) DEFAULT 0`).run(); } catch (_) {}

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

  // ─── Padronização Opção A (2026-05): 1 boletim = 1 NF (estilo UFT) ───
  // Coluna posto_id já existe (legado). Garantir 2 índices UNIQUE parciais:
  //   • idx_bol_boletins_contrato_comp_null    → 1 consolidado por contrato/competência (posto_id IS NULL)
  //   • idx_bol_boletins_contrato_posto_comp   → 1 por posto/contrato/competência (posto_id IS NOT NULL)
  // O índice legado idx_bol_boletins_contrato_comp (sem filtro) impedia N
  // boletins por posto na mesma competência; é convertido em parcial aqui.
  try { await db.prepare(`ALTER TABLE bol_boletins ADD COLUMN posto_id BIGINT`).run(); } catch (_) {}
  try {
    await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bol_boletins_contrato_posto_comp
      ON bol_boletins (contrato_id, posto_id, competencia)
      WHERE posto_id IS NOT NULL`).run();
  } catch (_) {}
  // Substitui o índice legado por versão parcial (posto_id IS NULL).
  // Idempotente: se o legado já foi renomeado, o DROP só remove o que existe.
  try {
    await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bol_boletins_contrato_comp_null
      ON bol_boletins (contrato_id, competencia)
      WHERE posto_id IS NULL`).run();
  } catch (_) {}
  try { await db.prepare(`DROP INDEX IF EXISTS idx_bol_boletins_contrato_comp`).run(); } catch (_) {}

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

// LEGADO: usado pela rota POST /gerar (fluxo manual antigo).
// Aceita "AAAA-MM" ou "Mês YYYY". Quando recebe cicloDiaInicio, calcula o período
// cíclico (ex: 14→13 UNITINS, 5→4 UFT); senão fallback "21 a 20" do contrato Laíse.
function calcularPeriodo(competencia, cicloDiaInicio) {
  // Formato YYYY-MM: delega pro helper canônico
  if (typeof competencia === 'string' && /^\d{4}-\d{2}$/.test(competencia.trim())) {
    const per = _calcPeriodoCiclico(competencia.trim(), cicloDiaInicio);
    return `${String(per.dia_inicio).padStart(2,'0')} de ${per.mes_inicio_txt.toLowerCase()} de ${per.ano_inicio} a ${String(per.dia_fim).padStart(2,'0')} de ${per.mes_fim_txt.toLowerCase()} de ${per.ano_fim}.`;
  }
  // Formato "Mês YYYY" (legado)
  const parts = competencia.toLowerCase().trim().split(/\s+/);
  const mesNome = parts[0];
  const ano = parseInt(parts[1]);
  const mesNum = MESES[mesNome];
  if (!mesNum) return competencia;
  // Se ciclo configurado, usa-o
  if (cicloDiaInicio && cicloDiaInicio >= 2 && cicloDiaInicio <= 28) {
    const yyyy = String(ano).padStart(4, '0');
    const mm = String(mesNum).padStart(2, '0');
    const per = _calcPeriodoCiclico(`${yyyy}-${mm}`, cicloDiaInicio);
    return `${String(per.dia_inicio).padStart(2,'0')} de ${per.mes_inicio_txt.toLowerCase()} de ${per.ano_inicio} a ${String(per.dia_fim).padStart(2,'0')} de ${per.mes_fim_txt.toLowerCase()} de ${per.ano_fim}.`;
  }
  // Fallback Laíse "21 a 20"
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
  // Mesmos campos aceitos pelo PUT — permite que o form único Novo/Editar grave
  // contrato_ref/orgao/insc_municipal já na criação (em vez de criar mínimo e editar).
  const r = await req.db.prepare(`
    INSERT INTO bol_contratos (nome, contratante, numero_contrato, processo, pregao,
      descricao_servico, escala, empresa_razao, empresa_cnpj, empresa_endereco,
      empresa_email, empresa_telefone, contrato_ref, orgao, insc_municipal)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    b.nome, b.contratante, b.numero_contrato, b.processo||'', b.pregao||'',
    b.descricao_servico||'', b.escala||'12x36', b.empresa_razao||'',
    b.empresa_cnpj||'', b.empresa_endereco||'', b.empresa_email||'', b.empresa_telefone||'',
    b.contrato_ref||'', b.orgao||'', b.insc_municipal||''
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

    // Anti-duplicação: 1 boletim por (contrato, competência). Mantém paridade
    // com /gerar-boletim que já fazia esse check. Antes esse endpoint criava
    // boletins novos sem verificar — gerando duplicatas no DB.
    const dupExist = await req.db.prepare(
      'SELECT id FROM bol_boletins WHERE contrato_id = ? AND competencia = ?'
    ).get(contrato_id, competencia);
    if (dupExist) {
      return res.status(409).json({
        error: `Já existe boletim para esse contrato/competência (id=${dupExist.id}). Reabra/edite o existente em vez de gerar outro.`,
        boletim_id: dupExist.id,
      });
    }

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

      const totalPosto = await gerarBoletimPDF(contrato, posto, nfNumero, data_emissao, periodo, filepath);
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

    // FIX (2026-05): INSERT idempotente via ON CONFLICT. Substitui o
    // SELECT+INSERT que tinha race condition (TOCTOU). Se já existe boletim
    // pra (contrato_id, competencia), CONFLICT é silencioso e retornamos o
    // existente. Depende do UNIQUE INDEX idx_bol_boletins_contrato_comp.
    const info = await db.prepare(`INSERT INTO bol_boletins
      (contrato_id, competencia, data_emissao, valor_base, valor_total, glosas, acrescimos, discriminacao, status, nfse_status)
      VALUES (?, ?, CURRENT_DATE, ?, ?, 0, 0, ?, 'rascunho', 'PENDENTE')
      ON CONFLICT (contrato_id, competencia) DO NOTHING
      RETURNING id`).run(contrato_id, competencia, valor_base, valor_base, discriminacao);
    const novoFlag = info.changes && info.changes > 0;
    const boletim = novoFlag
      ? await db.prepare('SELECT * FROM bol_boletins WHERE id=?').get(info.lastInsertRowid)
      : await db.prepare('SELECT * FROM bol_boletins WHERE contrato_id=? AND competencia=?').get(contrato_id, competencia);
    res.json({ data: boletim, novo: novoFlag });
  } catch (err) {
    console.error('Erro ao gerar boletim:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── AJUSTAR BOLETIM (glosas, acréscimos, discriminação) ───────

router.patch('/:id/ajustar', async (req, res) => {
  try {
    const db = req.db;
    const { glosas, acrescimos, discriminacao, obs, valor_base, itens } = req.body;
    const bol = await db.prepare('SELECT * FROM bol_boletins WHERE id=?').get(req.params.id);
    if (!bol) return res.status(404).json({ error: 'Boletim não encontrado' });

    const g = parseFloat(glosas ?? bol.glosas ?? 0);
    const a = parseFloat(acrescimos ?? bol.acrescimos ?? 0);

    // Itens override: se vier array, sobrescreve. Se vier null/undefined, mantém.
    // Recalcula valor_base a partir dos itens se override foi enviado.
    let itensJson = null;
    let baseAtual = bol.valor_base || bol.valor_total || 0;
    if (Array.isArray(itens) && itens.length > 0) {
      const norm = itens
        .map(it => ({
          descricao: String(it.descricao || '').trim(),
          quantidade: Number(it.quantidade) || 0,
          valor_unitario: Number(it.valor_unitario) || 0,
        }))
        .filter(it => it.descricao || it.quantidade || it.valor_unitario);
      itensJson = JSON.stringify(norm);
      baseAtual = Math.round(norm.reduce((s, it) => s + it.quantidade * it.valor_unitario, 0) * 100) / 100;
    }

    const base = (valor_base !== undefined && valor_base !== null && valor_base !== '')
      ? Math.round(parseFloat(valor_base) * 100) / 100
      : baseAtual;
    const novo_total = Math.round((base - g + a) * 100) / 100;

    await db.prepare(`UPDATE bol_boletins SET
      glosas=?, acrescimos=?, valor_base=?, valor_total=?,
      discriminacao=COALESCE(?,discriminacao), obs=COALESCE(?,obs),
      itens_override=COALESCE(?::jsonb, itens_override),
      updated_at=NOW()
      WHERE id=?`).run(g, a, base, novo_total, discriminacao || null, obs || null, itensJson, req.params.id);

    res.json({ data: await db.prepare('SELECT * FROM bol_boletins WHERE id=?').get(req.params.id) });
  } catch (err) {
    console.error('Erro ao ajustar boletim:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /:id/edit-data — retorna boletim + posto + itens (com override se houver).
// Usado pelo modal de edição inline no drill-down do Painel de Faturamento.
router.get('/:id/edit-data', async (req, res) => {
  try {
    const db = req.db;
    const bol = await db.prepare(`
      SELECT b.id, b.contrato_id, b.posto_id, b.competencia, b.valor_base, b.valor_total,
             b.glosas, b.acrescimos, b.discriminacao, b.status, b.nfse_status,
             b.itens_override,
             bc.nome AS contrato_nome, bc.contrato_ref, bc.numero_contrato, bc.template_discriminacao,
             p.campus_nome, p.municipio, p.label_resumo
      FROM bol_boletins b
      JOIN bol_contratos bc ON bc.id = b.contrato_id
      LEFT JOIN bol_postos p ON p.id = b.posto_id
      WHERE b.id=?`).get(req.params.id);
    if (!bol) return res.status(404).json({ error: 'Boletim não encontrado' });

    // Itens: prioriza override; senão, lê de bol_itens via posto.
    let itens = [];
    if (bol.itens_override) {
      try {
        const parsed = typeof bol.itens_override === 'string' ? JSON.parse(bol.itens_override) : bol.itens_override;
        if (Array.isArray(parsed)) itens = parsed;
      } catch (_) {}
    }
    if (!itens.length && bol.posto_id) {
      itens = await db.prepare(
        'SELECT id, descricao, quantidade, valor_unitario FROM bol_itens WHERE posto_id=? ORDER BY ordem'
      ).all(bol.posto_id);
    }
    res.json({
      boletim: {
        id: bol.id,
        contrato_id: bol.contrato_id,
        posto_id: bol.posto_id,
        competencia: bol.competencia,
        valor_base: Number(bol.valor_base || 0),
        valor_total: Number(bol.valor_total || 0),
        glosas: Number(bol.glosas || 0),
        acrescimos: Number(bol.acrescimos || 0),
        discriminacao: bol.discriminacao || '',
        status: bol.status,
        nfse_status: bol.nfse_status,
        tem_override: !!bol.itens_override,
      },
      contrato: { nome: bol.contrato_nome, ref: bol.contrato_ref, numero: bol.numero_contrato, template_discriminacao: bol.template_discriminacao || '' },
      posto: bol.posto_id ? { id: bol.posto_id, campus_nome: bol.campus_nome, municipio: bol.municipio, label_resumo: bol.label_resumo } : null,
      itens: itens.map(it => ({
        descricao: String(it.descricao || ''),
        quantidade: Number(it.quantidade || 0),
        valor_unitario: Number(it.valor_unitario || 0),
      })),
    });
  } catch (err) {
    console.error('Erro edit-data:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── EMITIR NFS-e VIA WEBISS ───────────────────────────────────

// Multi-contrato 2026-05-14: helpers de período cíclico + discriminação dinâmica.
//
// Período cíclico: contratos como UNITINS faturam dia 14/M-1 → 13/M, UFT 5/M-1 → 4/M.
// Quando ciclo_dia_inicio=null, retorna o mês calendário inteiro.
function _calcPeriodoCiclico(competenciaYYYYMM, cicloDiaInicio) {
  const [ano, mes] = competenciaYYYYMM.split('-').map(Number);
  const meses = ['', 'JANEIRO', 'FEVEREIRO', 'MARCO', 'ABRIL', 'MAIO', 'JUNHO',
                 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
  if (!cicloDiaInicio || cicloDiaInicio < 2 || cicloDiaInicio > 28) {
    // Mês calendário: 01/MES a último dia do mês
    const fim = new Date(ano, mes, 0).getDate();
    return {
      dia_inicio: 1, mes_inicio: mes, mes_inicio_txt: meses[mes], ano_inicio: ano,
      dia_fim: fim, mes_fim: mes, mes_fim_txt: meses[mes], ano_fim: ano,
    };
  }
  // Ciclo X→(X-1): NF de competência M cobre {X}/M-1 a {X-1}/M
  const diaFim = cicloDiaInicio - 1;
  const mesInicio = mes === 1 ? 12 : mes - 1;
  const anoInicio = mes === 1 ? ano - 1 : ano;
  return {
    dia_inicio: cicloDiaInicio, mes_inicio: mesInicio, mes_inicio_txt: meses[mesInicio], ano_inicio: anoInicio,
    dia_fim: diaFim, mes_fim: mes, mes_fim_txt: meses[mes], ano_fim: ano,
  };
}

// Gera discriminação dinâmica usando template + dados banc. + bloco retenções.
// Substitui placeholders {DIA_INI}, {MES_INI}, {ANO_INI}, etc.
function _gerarDiscriminacao(bc, posto, valorBruto, valores, periodo) {
  const fmtBR = (v) => Number(v || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  let texto = (bc.template_discriminacao || '').trim();
  if (!texto) {
    // Fallback genérico
    texto = `PRESTACAO DE SERVICOS CONFORME CONTRATO Nº ${bc.contrato_ref || bc.numero_contrato || ''}.`;
  }

  // Placeholders
  const map = {
    '{DIA_INI}': String(periodo.dia_inicio).padStart(2, '0'),
    '{MES_INI}': periodo.mes_inicio_txt,
    '{ANO_INI}': periodo.ano_inicio,
    '{DIA_FIM}': String(periodo.dia_fim).padStart(2, '0'),
    '{MES_FIM}': periodo.mes_fim_txt,
    '{ANO_FIM}': periodo.ano_fim,
    '{CONTRATO}': bc.contrato_ref || bc.numero_contrato || '',
    '{PROCESSO}': bc.processo || '',
    '{PREGAO}': bc.pregao || '',
    '{CIDADE}': posto?.municipio || '',
    '{POSTO}': posto?.campus_nome || '',
  };
  for (const [k, v] of Object.entries(map)) {
    texto = texto.split(k).join(String(v));
  }

  // Dados bancários (se cadastrados)
  if (bc.dados_bancarios) {
    texto += '\n\n' + bc.dados_bancarios.trim();
  }

  // Bloco de retenções (só inclui as ≠ 0)
  const blocos = [];
  if (valores.valorInss > 0) {
    const pct = valores.aliqInssEfetiva ? (valores.aliqInssEfetiva * 100).toFixed(3).replace(/\.?0+$/, '') + '%' : '11%';
    blocos.push(`Retencao para a Previdencia Social (${pct}): R$ ${fmtBR(valores.valorInss)}`);
  }
  if (valores.valorIr > 0) {
    blocos.push(`Retencao IRRF (1,2%): R$ ${fmtBR(valores.valorIr)}`);
  }
  const pcc = (valores.valorPis || 0) + (valores.valorCofins || 0) + (valores.valorCsll || 0);
  if (pcc > 0) {
    blocos.push(`Retencao PIS/COFINS/CSLL (4,65%): R$ ${fmtBR(pcc)}`);
  }
  if (blocos.length > 0) {
    texto += '\n\n' + blocos.join('\n');
  }
  texto += `\n\nValor Liquido R$ ${fmtBR(valores.valorLiquido)}`;

  // Limite WebISS: 2000 chars / 20 linhas
  if (texto.length > 2000) texto = texto.substring(0, 2000);
  const linhas = texto.split('\n');
  if (linhas.length > 20) texto = linhas.slice(0, 20).join('\n');
  return texto;
}

// Helper: monta o RPS pronto pra enviar (ou só preview). Carrega o boletim,
// resolve tomador e retenções (override do body > padrão do contrato > zerado).
// requireCert=true valida certificado/.env (modo emissão); false só monta payload.
async function _montarRpsPayload(req, opts = { requireCert: true }) {
  const db = req.db;
  const companyKey = req.companyKey;
  const retOverride = req.body?.retencoes || null;

  const bol = await db.prepare(`
    SELECT b.*,
           COALESCE(b.valor_total, b.total_geral, 0) AS valor_efetivo,
           bc.contrato_ref, bc.contratante as bc_contratante,
           bc.orgao as bc_orgao, bc.descricao_servico as bc_descricao,
           bc.insc_municipal as insc_contratante,
           bc.retencoes_padrao as retencoes_padrao_contrato,
           bc.id as bol_contrato_id,
           bc.numero_contrato as bc_numero_contrato,
           bc.processo            as bc_processo,
           bc.pregao              as bc_pregao,
           bc.item_lista_servico  as bc_item_lista,
           bc.codigo_tributacao_municipal as bc_cod_trib,
           bc.codigo_cnae         as bc_cnae,
           bc.codigo_nbs          as bc_nbs,
           bc.aliquota_iss_padrao as bc_aliq_iss,
           bc.iss_retido_padrao   as bc_iss_retido,
           bc.optante_simples_nacional as bc_optante_sn,
           bc.incentivo_fiscal    as bc_incentivo,
           bc.ciclo_dia_inicio    as bc_ciclo_dia,
           bc.dados_bancarios     as bc_banco,
           bc.template_discriminacao as bc_template,
           bc.inss_aliquota       as bc_aliq_inss,
           bc.inss_base_reduzida  as bc_inss_base_reduzida,
           bc.irrf_aliquota       as bc_aliq_irrf,
           bc.pis_aliquota        as bc_aliq_pis,
           bc.cofins_aliquota     as bc_aliq_cofins,
           bc.csll_aliquota       as bc_aliq_csll,
           p.campus_nome as posto_nome,
           p.municipio as posto_municipio,
           p.codigo_municipio_ibge as posto_ibge,
           p.aliquota_iss_local as posto_aliq_iss,
           p.deducao_vale_alimentacao as posto_ded_vale,
           p.deducao_materiais as posto_ded_mat,
           COALESCE(
             (SELECT c1.orgao FROM contratos c1 WHERE bc.contrato_ref != '' AND c1.numContrato = bc.contrato_ref LIMIT 1),
             (SELECT c1.orgao FROM contratos c1 WHERE bc.contrato_ref != '' AND c1.numContrato LIKE '%' || bc.contrato_ref || '%' LIMIT 1),
             (SELECT c2.orgao FROM contratos c2 WHERE c2.numContrato LIKE '%' || bc.numero_contrato LIMIT 1)
           ) AS cnpj_tomador_contrato,
           COALESCE(
             (SELECT c1.numContrato FROM contratos c1 WHERE bc.contrato_ref != '' AND c1.numContrato = bc.contrato_ref LIMIT 1),
             (SELECT c1.numContrato FROM contratos c1 WHERE bc.contrato_ref != '' AND c1.numContrato LIKE '%' || bc.contrato_ref || '%' LIMIT 1),
             (SELECT c2.numContrato FROM contratos c2 WHERE c2.numContrato LIKE '%' || bc.numero_contrato LIMIT 1)
           ) AS num_contrato_encontrado
    FROM bol_boletins b
    JOIN bol_contratos bc ON b.contrato_id = bc.id
    LEFT JOIN bol_postos p ON b.posto_id = p.id
    WHERE b.id=?`).get(req.params.id);

  if (!bol) return { ok:false, status:404, error:'Boletim não encontrado' };
  if (bol.nfse_status === 'EMITIDA') {
    return { ok:false, status:400, error:`NFS-e ${bol.nfse_numero} já emitida para este boletim` };
  }
  if (opts.requireCert && bol.status !== 'aprovado') {
    return { ok:false, status:400, error:`Boletim deve estar com status "aprovado" para emitir NFS-e (atual: ${bol.status})` };
  }
  if (!bol.valor_efetivo || bol.valor_efetivo <= 0) {
    return { ok:false, status:400, error:'Valor do boletim inválido (zero ou negativo) — ajuste o valor antes de emitir' };
  }

  if (opts.requireCert) {
    const certPath = path.join(__dirname, '..', '..', 'certificados', `${companyKey}.pfx`);
    const certSenha = process.env[`WEBISS_CERT_SENHA_${companyKey.toUpperCase()}`];
    if (!fs.existsSync(certPath)) {
      return { ok:false, status:400, error:`Certificado A1 não encontrado para ${companyKey}. Faça upload em Configurações → WebISS.` };
    }
    if (!certSenha) {
      return { ok:false, status:400, error:`Senha do certificado não configurada (WEBISS_CERT_SENHA_${companyKey.toUpperCase()} no .env)` };
    }
    const inscPrestadora = process.env[`WEBISS_INSC_${companyKey.toUpperCase()}`] || '';
    if (!inscPrestadora) {
      return { ok:false, status:400, error:`Inscrição Municipal não configurada (WEBISS_INSC_${companyKey.toUpperCase()} no .env)` };
    }
  }

  // RPS idempotente — reutiliza rps_numero gravado se for retentativa
  try { await db.prepare(`ALTER TABLE bol_boletins ADD COLUMN rps_numero TEXT`).run(); } catch (_) {}
  const rpsNum = bol.rps_numero || String(bol.id).padStart(10, '0');
  if (opts.requireCert && !bol.rps_numero) {
    await db.prepare(`UPDATE bol_boletins SET rps_numero=? WHERE id=?`).run(rpsNum, bol.id);
  }

  const today = new Date().toISOString().substring(0, 10);
  const competenciaData = bol.competencia.length === 7 ? `${bol.competencia}-01` : bol.competencia;

  // Multi-contrato 2026-05-14: retenções calculadas em camadas
  //   1) Padrão hardcoded (2% ISS, demais zero) — fallback
  //   2) Configuração do contrato (bc.aliquota_iss_padrao, bc.inss_aliquota, etc.)
  //   3) JSON salvo em bc.retencoes_padrao (config sticky da última emissão manual)
  //   4) Override do body (req.body.retencoes) — operador ajustando na hora
  //
  // INSS pode ser sobre base reduzida (UFT): bruto - vale_alimentacao - materiais

  // Base INSS: se contrato marca inss_base_reduzida e posto tem deduções, aplica
  const dedVale = Number(bol.posto_ded_vale || 0);
  const dedMat = Number(bol.posto_ded_mat || 0);
  const useBaseReduzida = !!bol.bc_inss_base_reduzida && (dedVale + dedMat > 0);
  const baseInss = useBaseReduzida
    ? Math.max(0, Number(bol.valor_efetivo) - dedVale - dedMat)
    : Number(bol.valor_efetivo);

  // Alíquota ISS: posto.aliquota_iss_local > contrato.aliquota_iss_padrao > 2% default
  const aliqIssDoContrato = Number(bol.posto_aliq_iss || bol.bc_aliq_iss || 0.02);

  // Calcula retenções automáticas do contrato (se alíquotas configuradas)
  const auto = {
    valorInss:   bol.bc_aliq_inss   ? Math.round(baseInss * Number(bol.bc_aliq_inss) * 100) / 100 : 0,
    valorIr:     bol.bc_aliq_irrf   ? Math.round(Number(bol.valor_efetivo) * Number(bol.bc_aliq_irrf) * 100) / 100 : 0,
    valorPis:    bol.bc_aliq_pis    ? Math.round(Number(bol.valor_efetivo) * Number(bol.bc_aliq_pis) * 100) / 100 : 0,
    valorCofins: bol.bc_aliq_cofins ? Math.round(Number(bol.valor_efetivo) * Number(bol.bc_aliq_cofins) * 100) / 100 : 0,
    valorCsll:   bol.bc_aliq_csll   ? Math.round(Number(bol.valor_efetivo) * Number(bol.bc_aliq_csll) * 100) / 100 : 0,
  };

  // Padrão sticky do contrato (JSON salvo na última emissão manual)
  let padraoContrato = {};
  if (bol.retencoes_padrao_contrato) {
    try { padraoContrato = JSON.parse(bol.retencoes_padrao_contrato) || {}; } catch (_) { padraoContrato = {}; }
  }

  const retencoes = {
    valorDeducoes: 0,
    valorPis:      0,
    valorCofins:   0,
    valorInss:     0,
    valorIr:       0,
    valorCsll:     0,
    issRetido:     false,
    aliquotaIss:   0.02,
    itemLista:     '07.17',
    codTributacao: '070700',
    // Camada 1: configuração estrutural do contrato (alíquotas)
    ...auto,
    issRetido:     bol.bc_iss_retido != null ? !!bol.bc_iss_retido : false,
    aliquotaIss:   aliqIssDoContrato,
    itemLista:     bol.bc_item_lista || '07.17',
    codTributacao: bol.bc_cod_trib || bol.bc_item_lista || '070700',
    // Camada 2: sticky JSON (sobrescreve auto)
    ...padraoContrato,
    // Camada 3: override do operador (sobrescreve tudo)
    ...(retOverride || {}),
  };
  // Sanitiza tipos
  for (const k of ['valorDeducoes','valorPis','valorCofins','valorInss','valorIr','valorCsll','aliquotaIss']) {
    retencoes[k] = Number(retencoes[k] || 0);
  }
  retencoes.issRetido = !!retencoes.issRetido;

  const valorISS = Math.round(bol.valor_efetivo * retencoes.aliquotaIss * 100) / 100;

  const tomadorCnpj = (bol.insc_contratante || bol.cnpj_tomador_contrato || '').replace(/\D/g, '');
  const tomadorRazao = bol.bc_contratante || bol.bc_orgao || 'TOMADOR NÃO CONFIGURADO';

  // Líquido = valor serviços - todas retenções (- ISS só se retido)
  const totalRetidas =
    retencoes.valorPis + retencoes.valorCofins + retencoes.valorInss +
    retencoes.valorIr + retencoes.valorCsll + (retencoes.issRetido ? valorISS : 0);
  const valorLiquido = Math.round((bol.valor_efetivo - totalRetidas) * 100) / 100;

  // Discriminação dinâmica (se contrato tem template)
  let discriminacaoFinal = bol.discriminacao || '';
  if (bol.bc_template) {
    const periodo = _calcPeriodoCiclico(bol.competencia, bol.bc_ciclo_dia);
    const posto = {
      campus_nome: bol.posto_nome,
      municipio: bol.posto_municipio,
    };
    const valoresPraDiscr = {
      valorInss: retencoes.valorInss,
      valorIr: retencoes.valorIr,
      valorPis: retencoes.valorPis,
      valorCofins: retencoes.valorCofins,
      valorCsll: retencoes.valorCsll,
      aliqInssEfetiva: bol.valor_efetivo > 0 ? retencoes.valorInss / bol.valor_efetivo : 0,
      valorLiquido,
    };
    discriminacaoFinal = _gerarDiscriminacao(
      {
        contrato_ref: bol.contrato_ref,
        numero_contrato: bol.bc_numero_contrato,
        processo: bol.bc_processo,
        pregao: bol.bc_pregao,
        dados_bancarios: bol.bc_banco,
        template_discriminacao: bol.bc_template,
      },
      posto,
      bol.valor_efetivo,
      valoresPraDiscr,
      periodo
    );
  }

  const rpsBody = {
    rps: {
      numero:       rpsNum,
      serie:        'A',
      tipo:         1,
      dataEmissao:  today,
      competencia:  competenciaData,
      servico: {
        valorServicos:     bol.valor_efetivo,
        valorDeducoes:     retencoes.valorDeducoes,
        valorPis:          retencoes.valorPis,
        valorCofins:       retencoes.valorCofins,
        valorInss:         retencoes.valorInss,
        valorIr:           retencoes.valorIr,
        valorCsll:         retencoes.valorCsll,
        issRetido:         retencoes.issRetido,
        valorIss:          valorISS,
        aliquota:          retencoes.aliquotaIss,
        itemLista:         retencoes.itemLista,
        codTributacao:     retencoes.codTributacao,
        codigoCnae:        bol.bc_cnae || undefined,
        codigoNbs:         bol.bc_nbs || undefined,
        discriminacao:     (discriminacaoFinal || 'PRESTAÇÃO DE SERVIÇOS').substring(0, 2000),
        exigibilidadeIss:  1,
        codigoMunicipio:   bol.posto_ibge || undefined,
        municipioIncidencia: bol.posto_ibge || undefined,
        optanteSimplesNacional: bol.bc_optante_sn != null ? Number(bol.bc_optante_sn) : 2,
        incentivoFiscal:   bol.bc_incentivo != null ? Number(bol.bc_incentivo) : 2,
      },
      tomador: {
        cnpj:        tomadorCnpj || undefined,
        razaoSocial: tomadorRazao,
        email:       '',
      },
    },
  };

  return {
    ok: true,
    rpsBody,
    bol,
    rpsNum,
    retencoes,
    valorISS,
    valorLiquido,
    tomadorCnpj,
    tomadorRazao,
    fonteRetencoes: retOverride ? 'override' : (Object.keys(padraoContrato).length ? 'padrao_contrato' : 'zerado'),
  };
}

// GET /api/boletins/:id/preview-nfse → monta o RPS e retorna JSON SEM enviar.
// Inclui padrão de retenções do contrato (se já houver) para pré-preenchimento.
router.get('/:id/preview-nfse', async (req, res) => {
  try {
    const out = await _montarRpsPayload(req, { requireCert: false });
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    res.json({
      ok: true,
      rps: out.rpsBody.rps,
      retencoes: out.retencoes,
      valor_iss: out.valorISS,
      valor_liquido: out.valorLiquido,
      tomador_cnpj: out.tomadorCnpj,
      tomador_razao: out.tomadorRazao,
      fonte_retencoes: out.fonteRetencoes,
      boletim: {
        id: out.bol.id, status: out.bol.status, nfse_status: out.bol.nfse_status,
        valor_efetivo: out.bol.valor_efetivo, competencia: out.bol.competencia,
        discriminacao: out.bol.discriminacao,
      },
    });
  } catch (err) {
    console.error('Erro preview-nfse:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/emitir-nfse', async (req, res) => {
  const db = req.db;
  const companyKey = req.companyKey;

  try {
    const out = await _montarRpsPayload(req, { requireCert: true });
    if (!out.ok) return res.status(out.status).json({ error: out.error });

    const { rpsBody, bol, retencoes, tomadorCnpj, tomadorRazao } = out;
    if (!tomadorCnpj) {
      console.warn(`[boletins] Boletim #${bol.id}: tomadorCnpj vazio — WebISS pode rejeitar. Configure insc_municipal ou contrato_ref.`);
    }

    // Registrar tentativa
    await db.prepare(`UPDATE bol_boletins SET nfse_status='ENVIANDO', nfse_erro=NULL, updated_at=NOW() WHERE id=?`)
      .run(bol.id);

    const port = process.env.PORT || 3002;
    const token = req.headers.authorization || '';

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
              bol.id, // FIX: vincula a NF ao boletim que a originou (cenário 1)
          );
          console.log(`[boletins] Auto-sync NF ${nfseNum} → notas_fiscais (boletim_id=${bol.id})`);
        }
      } catch (syncErr) {
        console.error('[boletins] Aviso: falha no auto-sync NF:', syncErr.message);
        // Não falha a resposta — NFS-e já foi emitida
      }

      // Persistir retenções como padrão do contrato (somente se vieram do body
      // — primeira vez que o user escolheu valores; preserva entre boletins
      // do mesmo contrato/mês seguinte sem reconfigurar tudo).
      if (req.body?.retencoes && bol.bol_contrato_id) {
        try {
          const padraoJson = JSON.stringify({
            valorPis: retencoes.valorPis,
            valorCofins: retencoes.valorCofins,
            valorInss: retencoes.valorInss,
            valorIr: retencoes.valorIr,
            valorCsll: retencoes.valorCsll,
            valorDeducoes: retencoes.valorDeducoes,
            issRetido: retencoes.issRetido,
            aliquotaIss: retencoes.aliquotaIss,
            itemLista: retencoes.itemLista,
            codTributacao: retencoes.codTributacao,
          });
          await db.prepare(`UPDATE bol_contratos SET retencoes_padrao=? WHERE id=?`)
            .run(padraoJson, bol.bol_contrato_id);
        } catch (e) { console.warn('[boletins] não persistiu retencoes_padrao:', e.message); }
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

// Retorna Promise<number> (totalPosto) que só resolve quando o stream do PDF
// termina de escrever. Callers DEVEM usar `await` antes de ler o arquivo.
function gerarBoletimPDF(contrato, posto, nfNumero, dataEmissao, periodo, outputPath, nfseInfo) {
  // nfseInfo (opcional): { numero, data_emissao, codigo_verificacao, link }
  //   undefined/null → modo PRÉVIO (nfNumero será exibido como "PRÉVIO" se vazio)
  //   objeto         → modo DEFINITIVO (adiciona bloco "NFS-e EMITIDA")
  const doc = new PDFDocument({ size: 'A4', margin: 30 });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);
  const donePromise = new Promise((resolve, reject) => {
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });

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
  const eDefinitivo = !!(nfseInfo && nfseInfo.numero);
  const nfLabel = eDefinitivo
    ? `NFS-e Nº ${nfseInfo.numero}`
    : (nfNumero ? `NOTA FISCAL: ${nfNumero}` : 'NOTA FISCAL: PRÉVIO (aguardando emissão)');
  const dataLabel = eDefinitivo && nfseInfo.data_emissao
    ? `DATA DE EMISSÃO: ${nfseInfo.data_emissao}`
    : `DATA: ${dataEmissao}`;
  doc.rect(margin, nfY, contentW, 22).fill(eDefinitivo ? '#E8F5E9' : CINZA_CLARO);
  doc.fill('#000000').font('Helvetica-Bold').fontSize(10)
     .text(nfLabel, margin + 10, nfY + 5)
     .text(dataLabel, pageW / 2 + 30, nfY + 5);

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
  // FIX (2026-05): page break automático pra contratos com muitos postos/itens.
  // Antes, o loop só somava rowY e rascunhava off-page → 153 páginas pra DETRAN-TO.
  const pageBottomLimit = doc.page.height - 130;
  const drawTableHeader = (y) => {
    doc.rect(margin, y, contentW, 20).fill(AZUL_ESCURO);
    doc.fill('#FFFFFF').font('Helvetica-Bold').fontSize(8);
    let hx = margin;
    for (let i = 0; i < headers.length; i++) {
      doc.text(headers[i], hx + 4, y + 5, { width: colWidths[i] - 8, align: 'center' });
      hx += colWidths[i];
    }
  };

  for (let idx = 0; idx < posto.itens.length; idx++) {
    const item = posto.itens[idx];
    const vt = item.quantidade * item.valor_unitario;
    totalPosto += vt;

    doc.fill('#000000').font('Helvetica').fontSize(8);
    const descH = doc.heightOfString(item.descricao, { width: colWidths[0] - 12 });
    const rowH = Math.max(descH + 10, 28);

    // Page break antes de desenhar a linha se ela estourar a página
    if (rowY + rowH > pageBottomLimit) {
      doc.addPage();
      rowY = margin;
      drawTableHeader(rowY);
      rowY += 20;
    }

    // Zebra stripes (já com altura correta da linha)
    if (idx % 2 === 1) {
      doc.rect(margin, rowY, contentW, rowH).fill(CINZA_CLARO);
    }

    tx = margin;
    doc.fill('#000000').font('Helvetica').fontSize(8);
    doc.text(item.descricao, tx + 6, rowY + 5, { width: colWidths[0] - 12 });
    tx += colWidths[0];
    doc.text(String(item.quantidade), tx + 4, rowY + 8, { width: colWidths[1] - 8, align: 'center' });
    tx += colWidths[1];
    doc.text(formatMoeda(item.valor_unitario), tx + 4, rowY + 8, { width: colWidths[2] - 8, align: 'right' });
    tx += colWidths[2];
    doc.text(formatMoeda(vt), tx + 4, rowY + 8, { width: colWidths[3] - 8, align: 'right' });
    doc.rect(margin, rowY, contentW, rowH).strokeColor(CINZA_BORDA).lineWidth(0.3).stroke();
    rowY += rowH;
  }

  // Bloco final (TOTAL + descrições) tb pode estourar — vira página se preciso
  if (rowY + 130 > pageBottomLimit) {
    doc.addPage();
    rowY = margin;
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

  // ─── BLOCO NFS-e (somente PDF DEFINITIVO) ───
  if (eDefinitivo) {
    rowY = doc.y + 12;
    if (rowY + 50 > pageBottomLimit) { doc.addPage(); rowY = margin; }
    doc.rect(margin, rowY, contentW, 42).fill('#E8F5E9');
    doc.fill('#1B5E20').font('Helvetica-Bold').fontSize(10)
       .text('NFS-e EMITIDA', margin + 8, rowY + 5);
    doc.font('Helvetica').fontSize(8.5).fill('#000000');
    let ny = rowY + 19;
    doc.text(`Número: ${nfseInfo.numero}`, margin + 8, ny);
    if (nfseInfo.data_emissao) doc.text(`Emitida em: ${nfseInfo.data_emissao}`, margin + 180, ny);
    if (nfseInfo.codigo_verificacao) doc.text(`Cód. verificação: ${nfseInfo.codigo_verificacao}`, margin + 8, ny + 12);
    if (nfseInfo.link) doc.text(`Link: ${nfseInfo.link}`, margin + 8, ny + 24, { width: contentW - 20 });
  }

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
  // Aguarda o stream terminar antes de devolver o controle ao caller — assim
  // quem precisar ler o arquivo logo em seguida pega o PDF completo.
  return donePromise.then(() => totalPosto);
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

// ─── DEBUG: escaneia bol_contratos e identifica candidatos LEGADOS ────
// GET /api/boletins/_legados-scan
// Heurística (mais robusta):
//   - Para cada bol_contrato A cujo `contrato_ref` NÃO bate exato em contratos.numContrato,
//     procura um bol_contrato B cujo `contrato_ref` BATE exato E que CONTENHA o ref de A
//     como substring (ou vice-versa) → A é legado, B é correto.
//   - Inclui contagens de boletins (total e EMITIDOS) pra avaliação de risco.
router.get('/_legados-scan', async (req, res) => {
  try {
    const db = req.db;
    const bolc = await db.prepare(
      `SELECT id, nome, contratante, numero_contrato, contrato_ref, ativo
       FROM bol_contratos ORDER BY id`).all();
    const contratos = await db.prepare('SELECT numContrato FROM contratos').all();
    const numSet = new Set(contratos.map(c => c.numContrato));
    const counts = await db.prepare(
      `SELECT contrato_id,
              COUNT(*) AS total,
              SUM(CASE WHEN nfse_status='EMITIDA' THEN 1 ELSE 0 END) AS emitidos
       FROM bol_boletins GROUP BY contrato_id`).all();
    const cntMap = {};
    for (const c of counts) cntMap[c.contrato_id] = { total: Number(c.total), emitidos: Number(c.emitidos) };

    // Marca cada bol_contrato: bate_exato e contagens
    const enriched = bolc.map(bc => ({
      ...bc,
      bate_exato: !!(bc.contrato_ref && numSet.has(bc.contrato_ref)),
      boletins: cntMap[bc.id] || { total: 0, emitidos: 0 },
    }));
    const corretos  = enriched.filter(e => e.bate_exato);
    const naoBatem  = enriched.filter(e => !e.bate_exato);

    // Para cada não-bate, tenta achar um CORRETO cujo ref contém o ref do não-bate
    // (ou vice-versa, se o legado for o mais longo, raro mas possível).
    const candidatos = [];
    for (const legado of naoBatem) {
      const refL = (legado.contrato_ref || legado.numero_contrato || '').trim();
      if (!refL) continue;
      const correspondente = corretos.find(c => {
        const refC = (c.contrato_ref || '').trim();
        if (!refC) return false;
        return refC.includes(refL) || refL.includes(refC);
      });
      if (correspondente) {
        candidatos.push({
          contratante: legado.contratante,
          legado: { id: legado.id, nome: legado.nome, contrato_ref: legado.contrato_ref,
                    ativo: legado.ativo, boletins: legado.boletins },
          correto: { id: correspondente.id, nome: correspondente.nome,
                    contrato_ref: correspondente.contrato_ref,
                    boletins: correspondente.boletins },
        });
      }
    }
    res.json({ ok: true, total: candidatos.length, candidatos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ADMIN: cria UNIQUE INDEX em (contrato_id, competencia) se ainda não existir ──
// POST /api/boletins/_create-unique
router.post('/_create-unique', async (req, res) => {
  try {
    await req.db.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_bol_boletins_contrato_comp
       ON bol_boletins(contrato_id, competencia)`).run();
    // Verifica e retorna estado pós-criação (raw count + nome do índice)
    const found = await req.db.prepare(
      `SELECT indexname FROM pg_indexes
       WHERE tablename='bol_boletins' AND indexname='idx_bol_boletins_contrato_comp'`).all();
    res.json({ ok: true, criado: found.length > 0, indices: found });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ADMIN: ativa/desativa bol_contrato (soft-delete) ─────────────────
// PATCH /api/boletins/_set-ativo?id=N&ativo=0|1
// Schema legacy usa smallint (0/1) em alguns ambientes e boolean em outros;
// passamos como integer pra cobrir os dois casos.
router.patch('/_set-ativo', async (req, res) => {
  try {
    const id = parseInt(req.query.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id obrigatório' });
    const ativoInt = (req.query.ativo === '1' || req.query.ativo === 'true') ? 1 : 0;
    const r = await req.db.prepare('UPDATE bol_contratos SET ativo=? WHERE id=?').run(ativoInt, id);
    res.json({ ok: true, changes: r.changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ADMIN: apaga TODOS os boletins de um bol_contrato (com guard NFS-e) ──
// DELETE /api/boletins/_purge-contrato?id=N
router.delete('/_purge-contrato', async (req, res) => {
  try {
    const id = parseInt(req.query.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id obrigatório' });
    const db = req.db;
    // Guard: aborta se algum boletim já tem NFS-e EMITIDA
    const emitidos = await db.prepare(
      `SELECT id, nfse_numero FROM bol_boletins WHERE contrato_id=? AND nfse_status='EMITIDA'`).all(id);
    if (emitidos.length) {
      return res.status(400).json({
        error: 'Existem boletins com NFS-e EMITIDA — não posso apagar',
        emitidos,
      });
    }
    const r = await db.prepare('DELETE FROM bol_boletins WHERE contrato_id=?').run(id);
    res.json({ ok: true, apagados: r.changes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DEBUG: detalhe completo de bol_contrato (postos+itens) ─────────
// GET /api/boletins/_contrato-detalhe?id=2
router.get('/_contrato-detalhe', async (req, res) => {
  try {
    const id = parseInt(req.query.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id obrigatório' });
    const db = req.db;
    const bc = await db.prepare('SELECT * FROM bol_contratos WHERE id=?').get(id);
    if (!bc) return res.status(404).json({ error: 'Não encontrado' });
    const postos = await db.prepare('SELECT id, campus_nome, municipio, ordem FROM bol_postos WHERE contrato_id=? ORDER BY ordem').all(id);
    for (const p of postos) {
      p.itens = await db.prepare('SELECT id, descricao, quantidade, valor_unitario FROM bol_itens WHERE posto_id=? ORDER BY ordem').all(p.id);
    }
    const boletins = await db.prepare(`SELECT id, competencia, status, nfse_status, valor_total FROM bol_boletins WHERE contrato_id=? ORDER BY competencia DESC, id DESC`).all(id);
    res.json({ ok: true, bol_contrato: bc, postos, boletins });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DEBUG: lista bol_contratos com mesmo padrão de nome (para detectar duplicações de cadastro) ──
// GET /api/boletins/_dup-cadastro?q=DETRAN
router.get('/_dup-cadastro', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.status(400).json({ error: 'Parâmetro q obrigatório (substring do nome)' });
    const db = req.db;
    const bolc = await db.prepare(
      `SELECT id, nome, contratante, numero_contrato, contrato_ref, ativo
       FROM bol_contratos
       WHERE nome ILIKE '%' || ? || '%' OR contratante ILIKE '%' || ? || '%' OR numero_contrato ILIKE '%' || ? || '%'
       ORDER BY id`).all(q, q, q);
    const contratos = await db.prepare(
      `SELECT id, numContrato, contrato, orgao, valor_mensal_bruto, status
       FROM contratos
       WHERE contrato ILIKE '%' || ? || '%' OR orgao ILIKE '%' || ? || '%' OR numContrato ILIKE '%' || ? || '%'
       ORDER BY id`).all(q, q, q);
    res.json({ ok: true, bol_contratos: bolc, contratos_financeiros: contratos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DEDUP: limpa duplicatas (contrato_id, competencia) preservando o melhor ──
// POST /api/boletins/_dedup?dry=1   → preview do que seria apagado
// POST /api/boletins/_dedup         → executa
// Prioridade do que fica: NFS-e EMITIDA > APROVADO > rascunho mais recente
router.post('/_dedup', async (req, res) => {
  try {
    const db = req.db;
    const dryRun = req.query.dry === '1' || req.query.dry === 'true';

    // 1. Grupos duplicados + qual fica em cada grupo (DISTINCT ON + ORDER BY)
    const winners = await db.prepare(`
      SELECT DISTINCT ON (contrato_id, competencia)
        id, contrato_id, competencia, status, nfse_status, valor_total
      FROM bol_boletins
      WHERE (contrato_id, competencia) IN (
        SELECT contrato_id, competencia FROM bol_boletins
        GROUP BY contrato_id, competencia HAVING COUNT(*) > 1
      )
      ORDER BY contrato_id, competencia,
        CASE nfse_status WHEN 'EMITIDA' THEN 0 ELSE 1 END,
        CASE status WHEN 'aprovado' THEN 0 WHEN 'rascunho' THEN 2 ELSE 1 END,
        id DESC
    `).all();
    const keepIds = winners.map(w => Number(w.id));

    const losers = await db.prepare(`
      SELECT id, contrato_id, competencia, status, nfse_status, valor_total
      FROM bol_boletins
      WHERE (contrato_id, competencia) IN (
        SELECT contrato_id, competencia FROM bol_boletins
        GROUP BY contrato_id, competencia HAVING COUNT(*) > 1
      )
      ORDER BY contrato_id, competencia, id
    `).all();
    const deleteIds = losers.filter(l => !keepIds.includes(Number(l.id))).map(l => Number(l.id));

    if (dryRun) {
      return res.json({ ok: true, dry: true, preserva: winners, apagaria: deleteIds.length, ids_apagaria: deleteIds.slice(0, 100) });
    }

    // Block guard: se algum dos que vamos apagar tem NFS-e EMITIDA, aborta.
    const emitidos = losers.filter(l => l.nfse_status === 'EMITIDA').map(l => Number(l.id));
    if (emitidos.some(id => !keepIds.includes(id))) {
      return res.status(400).json({ error: 'Há duplicatas com NFS-e EMITIDA — investigação manual necessária', emitidos });
    }

    // Executa em lote
    let apagados = 0;
    for (const id of deleteIds) {
      const r = await db.prepare('DELETE FROM bol_boletins WHERE id=?').run(id);
      apagados += r.changes || 0;
    }
    res.json({ ok: true, apagados, preservou: keepIds.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── DIAGNÓSTICO: índices/constraints + duplicatas (debug 2026-05) ──
// GET /api/boletins/_diag-dup
router.get('/_diag-dup', async (req, res) => {
  try {
    const db = req.db;
    const indices = await db.prepare(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename='bol_boletins' AND schemaname='public'`).all();
    const constraints = await db.prepare(
      `SELECT conname, contype::text AS contype, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE conrelid='bol_boletins'::regclass`).all();
    const duplicatas = await db.prepare(
      `SELECT contrato_id, competencia, COUNT(*) AS n, MIN(id) AS min_id, MAX(id) AS max_id
       FROM bol_boletins
       GROUP BY contrato_id, competencia
       HAVING COUNT(*) > 1
       ORDER BY n DESC LIMIT 30`).all();
    res.json({ ok: true, indices, constraints, duplicatas });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

    const postos = await req.db.prepare(`SELECT * FROM bol_postos WHERE contrato_id = ? ORDER BY ordem`).all(boletim.contrato_id);
    for (const p of postos) {
      p.itens = await req.db.prepare(`SELECT * FROM bol_itens WHERE posto_id = ? ORDER BY ordem`).all(p.id);
    }
    if (!postos.length) return res.status(400).json({ error: 'Contrato sem postos cadastrados' });

    // Para preview, junta TODOS os items de TODOS os postos num "posto agregado"
    // (mesmo formato do PDF SEDUC original — 1 boletim por contrato com todas as funções).
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
  // Margem de segurança no fim da página pra não invadir o bloco de assinaturas
  const pageBottomLimit = doc.page.height - 130;

  // Função pra desenhar o cabeçalho da tabela (reusada quando vira página)
  const drawTableHeader = (y) => {
    doc.rect(margin, y, contentW, 20).fill(AZUL_ESCURO);
    doc.fill('#FFFFFF').font('Helvetica-Bold').fontSize(8);
    let hx = margin;
    for (let i = 0; i < headers.length; i++) {
      doc.text(headers[i], hx + 4, y + 5, { width: colWidths[i] - 8, align: 'center' });
      hx += colWidths[i];
    }
  };

  for (let idx = 0; idx < posto.itens.length; idx++) {
    const item = posto.itens[idx];
    const vt = (item.quantidade || 0) * (item.valor_unitario || 0);
    totalPosto += vt;

    doc.fill('#000000').font('Helvetica').fontSize(8);
    const descH = doc.heightOfString(item.descricao || '', { width: colWidths[0] - 12 });
    const rowH = Math.max(descH + 10, 28);

    // Page break: se a próxima linha estourar o limite, vira página e redesenha o header
    if (rowY + rowH > pageBottomLimit) {
      doc.addPage();
      rowY = margin;
      drawTableHeader(rowY);
      rowY += 20;
    }

    if (idx % 2 === 1) doc.rect(margin, rowY, contentW, rowH).fill(CINZA_CLARO);
    tx = margin;
    doc.fill('#000000').font('Helvetica').fontSize(8);
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

  // Se TOTAL e descrições não couberem na página atual, vira pra próxima
  const blocoFinalH = 130; // TOTAL + descrições + (signatures fixas no rodapé)
  if (rowY + blocoFinalH > pageBottomLimit) {
    doc.addPage();
    rowY = margin;
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
    // FIX (2026-05): excluir contratos ENCERRADO/RESCINDIDO. O status fica na
    // tabela `contratos` (financeira), não em bol_contratos — então resolvemos
    // via subquery na inner e filtramos na outer pra evitar duplicar COALESCE.
    const _contratosRaw = await db.prepare(`
      SELECT * FROM (
        SELECT bc.*,
          COALESCE(
            (SELECT c1.valor_mensal_bruto FROM contratos c1 WHERE bc.contrato_ref != '' AND c1.numContrato = bc.contrato_ref LIMIT 1),
            (SELECT c1.valor_mensal_bruto FROM contratos c1 WHERE bc.contrato_ref != '' AND c1.numContrato LIKE '%' || bc.contrato_ref || '%' LIMIT 1),
            (SELECT c2.valor_mensal_bruto FROM contratos c2 WHERE c2.numContrato LIKE '%' || bc.numero_contrato LIMIT 1),
            0
          ) AS valor_mensal_bruto,
          COALESCE(
            (SELECT c1.orgao FROM contratos c1 WHERE bc.contrato_ref != '' AND c1.numContrato = bc.contrato_ref LIMIT 1),
            (SELECT c1.orgao FROM contratos c1 WHERE bc.contrato_ref != '' AND c1.numContrato LIKE '%' || bc.contrato_ref || '%' LIMIT 1),
            (SELECT c2.orgao FROM contratos c2 WHERE c2.numContrato LIKE '%' || bc.numero_contrato LIMIT 1),
            ''
          ) AS cnpj_tomador_contrato,
          COALESCE(
            (SELECT c1.status FROM contratos c1 WHERE bc.contrato_ref != '' AND c1.numContrato = bc.contrato_ref LIMIT 1),
            (SELECT c1.status FROM contratos c1 WHERE bc.contrato_ref != '' AND c1.numContrato LIKE '%' || bc.contrato_ref || '%' LIMIT 1),
            (SELECT c2.status FROM contratos c2 WHERE c2.numContrato LIKE '%' || bc.numero_contrato LIMIT 1),
            ''
          ) AS contrato_status
        FROM bol_contratos bc
        WHERE COALESCE(bc.ativo::text, 'true') NOT IN ('0','false','f')
      ) sub
      WHERE LOWER(COALESCE(contrato_status, '')) NOT LIKE '%encerrad%'
        AND LOWER(COALESCE(contrato_status, '')) NOT LIKE '%rescindid%'
      ORDER BY nome
    `).all();
    const contratos = Array.isArray(_contratosRaw) ? _contratosRaw : [];

    const resultado = await Promise.all(contratos.map(async bc => {
      // FIX1: COALESCE(valor_total, total_geral)
      // OPÇÃO A: busca apenas boletim consolidado (posto_id IS NULL).
      // Boletins por-posto são contados separadamente abaixo.
      // FIX5 (2026-05): se há duplicatas legadas (mesmo contrato/competência),
      // retorna o mais "vivo" primeiro: NFS-e EMITIDA > status='aprovado' > maior
      // valor. Sem essa ordenação, .get() retorna não-determinístico — usuário
      // podia ver "R$ 0,00" porque caía no rascunho órfão. Ver POST /_dedup pra
      // limpar.
      const boletim = await db.prepare(`
        SELECT *, COALESCE(valor_total, total_geral, 0) AS valor_efetivo
        FROM bol_boletins
        WHERE contrato_id = ? AND competencia = ? AND posto_id IS NULL
        ORDER BY
          CASE WHEN nfse_status = 'EMITIDA' THEN 4
               WHEN status      = 'aprovado' THEN 3
               WHEN COALESCE(valor_total, total_geral, 0) > 0 THEN 2
               ELSE 1 END DESC,
          COALESCE(valor_total, total_geral, 0) DESC,
          created_at DESC
        LIMIT 1
      `).get(bc.id, mes);

      // OPÇÃO A: agregado de boletins-por-posto (estilo UFT — 1 NF por posto)
      const qtdPostos = await db.prepare(
        'SELECT COUNT(*)::int AS n FROM bol_postos WHERE contrato_id=?'
      ).get(bc.id);
      const aggPostos = await db.prepare(`
        SELECT
          COUNT(*)::int AS qtd,
          COUNT(*) FILTER (WHERE nfse_status='EMITIDA')::int AS emitidos,
          COUNT(*) FILTER (WHERE status='aprovado' AND nfse_status<>'EMITIDA')::int AS aprovados_pend,
          COUNT(*) FILTER (WHERE status='rascunho')::int AS rascunhos,
          COALESCE(SUM(COALESCE(valor_total, total_geral, 0)), 0) AS valor_total
        FROM bol_boletins
        WHERE contrato_id=? AND competencia=? AND posto_id IS NOT NULL
      `).get(bc.id, mes);

      // Conta dups deste par (contrato/competência) — pra frontend avisar se >1
      const dupRow = await db.prepare(
        'SELECT COUNT(*)::int AS n FROM bol_boletins WHERE contrato_id = ? AND competencia = ?'
      ).get(bc.id, mes);
      const dup_count = dupRow ? (dupRow.n - 1) : 0; // qtd duplicatas além do mostrado

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
        // Modo Opção A: agregado de postos
        qtd_postos:        qtdPostos?.n || 0,
        postos_resumo: {
          qtd:             aggPostos?.qtd || 0,
          emitidos:        aggPostos?.emitidos || 0,
          aprovados_pend:  aggPostos?.aprovados_pend || 0,
          rascunhos:       aggPostos?.rascunhos || 0,
          valor_total:     Number(aggPostos?.valor_total || 0),
        },
        dup_count, // qtd duplicatas além do exibido (frontend avisa se > 0)
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

// ─── PAINEL POSTOS (drill-down Opção A) ───────────────────────
// GET /api/boletins/painel-postos?contrato_id=X&mes=YYYY-MM
// Retorna lista detalhada dos boletins-por-posto de um contrato/mês,
// inclusive os postos que ainda não têm boletim (pra mostrar como "Sem boletim").
router.get('/painel-postos', async (req, res) => {
  try {
    const { contrato_id, mes } = req.query;
    if (!contrato_id || !mes || !/^\d{4}-\d{2}$/.test(mes)) {
      return res.status(400).json({ error: 'contrato_id e mes (YYYY-MM) são obrigatórios' });
    }
    const db = req.db;
    const postos = await db.prepare(
      'SELECT id, campus_nome, municipio, label_resumo FROM bol_postos WHERE contrato_id=? ORDER BY ordem, campus_nome'
    ).all(contrato_id);

    const linhas = await Promise.all(postos.map(async p => {
      const bol = await db.prepare(`
        SELECT id, status, nfse_status, nfse_numero, nfse_erro, valor_base,
               COALESCE(valor_total, total_geral, 0) AS valor_total,
               glosas, acrescimos
        FROM bol_boletins
        WHERE contrato_id=? AND posto_id=? AND competencia=?
      `).get(contrato_id, p.id, mes);
      return {
        posto_id: p.id,
        campus_nome: p.campus_nome,
        municipio: p.municipio,
        label_resumo: p.label_resumo,
        boletim: bol ? {
          id: bol.id,
          status: bol.status,
          nfse_status: bol.nfse_status,
          nfse_numero: bol.nfse_numero,
          nfse_erro: bol.nfse_erro,
          valor_base: Number(bol.valor_base || 0),
          valor_total: Number(bol.valor_total || 0),
          glosas: Number(bol.glosas || 0),
          acrescimos: Number(bol.acrescimos || 0),
        } : null
      };
    }));
    res.json({ mes, contrato_id: Number(contrato_id), postos: linhas });
  } catch (err) {
    console.error('Erro painel-postos:', err);
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

    // FIX (2026-05): substituído SELECT+INSERT pelo padrão idempotente
    // INSERT ... ON CONFLICT DO NOTHING RETURNING id. Elimina o race condition
    // (TOCTOU) que produzia duplicatas quando o cron e o usuário disparavam
    // simultaneamente. Depende de UNIQUE INDEX idx_bol_boletins_contrato_comp
    // (criado por POST /_create-unique).
    for (const bc of contratos) {
      const valor_base = Math.round((bc.valor_mensal_bruto || 0) * 100) / 100;
      const tipoServico = bc.descricao_servico || 'SERVIÇOS';
      const numContrato  = bc.contrato_ref || bc.numero_contrato || '';
      const discriminacao = `PRESTAÇÃO DE SERVIÇOS DE ${tipoServico.toUpperCase()} CONFORME CONTRATO Nº ${numContrato}, COMPETÊNCIA ${mesNome.toUpperCase()}/${ano}. VALOR MENSAL CONFORME BOLETIM DE MEDIÇÃO APROVADO.`;

      const r = await db.prepare(`INSERT INTO bol_boletins
        (contrato_id, competencia, data_emissao, valor_base, valor_total, glosas, acrescimos, discriminacao, status, nfse_status)
        VALUES (?, ?, CURRENT_DATE, ?, ?, 0, 0, ?, 'rascunho', 'PENDENTE')
        ON CONFLICT (contrato_id, competencia) DO NOTHING
        RETURNING id
      `).run(bc.id, mes, valor_base, valor_base, discriminacao);
      // r.changes = 1 quando inseriu; 0 quando já existia (CONFLICT)
      if (r.changes && r.changes > 0) criados++;
      else existentes++;
    }

    res.json({ ok: true, mes, criados, existentes, total: contratos.length });
  } catch (err) {
    console.error('Erro gerar-mes:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PADRÃO OPÇÃO A: gerar N boletins (1 por posto) ─────────────
// POST /api/boletins/gerar-boletim-postos { contrato_id, competencia }
// Cria 1 boletim por posto cadastrado no contrato. Cada boletim será emitido
// individualmente como NF própria (estilo UFT).
async function _gerarBoletinsPorPostos(db, contrato_id, competencia, mesNome, ano) {
  const postos = await db.prepare(
    'SELECT id, campus_nome, municipio FROM bol_postos WHERE contrato_id=? ORDER BY ordem'
  ).all(contrato_id);
  if (!postos || postos.length === 0) {
    return { criados: 0, existentes: 0, total_postos: 0, sem_postos: true };
  }

  const bc = await db.prepare('SELECT * FROM bol_contratos WHERE id=?').get(contrato_id);
  const tipoServico = (bc?.descricao_servico || 'SERVIÇOS').toUpperCase();
  const numContrato = bc?.contrato_ref || bc?.numero_contrato || '';

  let criados = 0, existentes = 0;
  for (const p of postos) {
    const itens = await db.prepare(
      'SELECT quantidade, valor_unitario FROM bol_itens WHERE posto_id=?'
    ).all(p.id);
    const valor_base = Math.round(
      itens.reduce((s, i) => s + (Number(i.quantidade) || 0) * (Number(i.valor_unitario) || 0), 0) * 100
    ) / 100;

    const descMunicipio = p.municipio ? ` — ${p.municipio}` : '';
    const discriminacao = `PRESTAÇÃO DE SERVIÇOS DE ${tipoServico} CONFORME CONTRATO Nº ${numContrato}${descMunicipio}. COMPETÊNCIA ${mesNome.toUpperCase()}/${ano}. VALOR CONFORME BOLETIM DE MEDIÇÃO APROVADO.`;

    const r = await db.prepare(`INSERT INTO bol_boletins
      (contrato_id, posto_id, competencia, data_emissao, valor_base, valor_total, glosas, acrescimos, discriminacao, status, nfse_status)
      VALUES (?, ?, ?, CURRENT_DATE, ?, ?, 0, 0, ?, 'rascunho', 'PENDENTE')
      ON CONFLICT (contrato_id, posto_id, competencia) WHERE posto_id IS NOT NULL DO NOTHING
      RETURNING id`).run(contrato_id, p.id, competencia, valor_base, valor_base, discriminacao);
    if (r.changes && r.changes > 0) criados++;
    else existentes++;
  }
  return { criados, existentes, total_postos: postos.length, sem_postos: false };
}

router.post('/gerar-boletim-postos', async (req, res) => {
  try {
    const { contrato_id, competencia } = req.body;
    if (!contrato_id || !competencia || !/^\d{4}-\d{2}$/.test(competencia)) {
      return res.status(400).json({ error: 'contrato_id e competencia (YYYY-MM) são obrigatórios' });
    }
    const [ano, mesNum] = competencia.split('-');
    const mesNome = MESES_NOME_COMPLETO[parseInt(mesNum)] || competencia;
    const out = await _gerarBoletinsPorPostos(req.db, contrato_id, competencia, mesNome, ano);
    res.json({ ok: true, competencia, ...out });
  } catch (err) {
    console.error('Erro gerar-boletim-postos:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/boletins/gerar-mes-postos { mes: "YYYY-MM" }
// Pra cada contrato ativo: cria N boletins (1 por posto).
router.post('/gerar-mes-postos', async (req, res) => {
  try {
    const { mes } = req.body;
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) {
      return res.status(400).json({ error: 'Campo mes obrigatório (YYYY-MM)' });
    }
    const db = req.db;
    const contratos = await db.prepare(`
      SELECT bc.id, bc.nome
      FROM bol_contratos bc
      WHERE COALESCE(bc.ativo::text, 'true') NOT IN ('0','false','f')
    `).all();
    const [ano, mesNum] = mes.split('-');
    const mesNome = MESES_NOME_COMPLETO[parseInt(mesNum)] || mes;

    const resumo = [];
    let totalCriados = 0, totalExistentes = 0, contratosSemPostos = 0;
    for (const c of contratos) {
      const r = await _gerarBoletinsPorPostos(db, c.id, mes, mesNome, ano);
      resumo.push({ contrato_id: c.id, nome: c.nome, ...r });
      totalCriados += r.criados;
      totalExistentes += r.existentes;
      if (r.sem_postos) contratosSemPostos++;
    }
    res.json({
      ok: true, mes,
      criados: totalCriados,
      existentes: totalExistentes,
      contratos_sem_postos: contratosSemPostos,
      detalhe: resumo
    });
  } catch (err) {
    console.error('Erro gerar-mes-postos:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── PDF PRÉVIO / DEFINITIVO (Opção A) ─────────────────────────
// GET /api/boletins/:id/pdf-previo
// GET /api/boletins/:id/pdf-definitivo
// Reusa gerarBoletimPDF(). Boletim deve ter posto_id setado (vinculado a 1 posto).
async function _renderBoletimPDF(req, res, modo /* 'previo'|'definitivo' */) {
  const db = req.db;
  const bol = await db.prepare(`
    SELECT b.*, bc.nome as bc_nome, bc.contratante, bc.numero_contrato, bc.processo, bc.pregao,
           bc.descricao_servico, bc.escala, bc.empresa_razao, bc.empresa_cnpj, bc.empresa_endereco,
           bc.empresa_email, bc.empresa_telefone,
           bc.ciclo_dia_inicio as bc_ciclo_dia
    FROM bol_boletins b
    JOIN bol_contratos bc ON b.contrato_id = bc.id
    WHERE b.id=?`).get(req.params.id);
  if (!bol) return res.status(404).json({ error: 'Boletim não encontrado' });
  if (!bol.posto_id) {
    return res.status(400).json({ error: 'Boletim sem posto vinculado — use o fluxo Opção A (gerar-boletim-postos)' });
  }
  if (modo === 'definitivo' && bol.nfse_status !== 'EMITIDA') {
    return res.status(400).json({ error: 'NFS-e ainda não emitida — use pdf-previo' });
  }

  const posto = await db.prepare('SELECT * FROM bol_postos WHERE id=?').get(bol.posto_id);
  if (!posto) return res.status(404).json({ error: 'Posto vinculado não encontrado' });
  // Itens: prioriza override do boletim individual (edição manual); senão, lê de bol_itens.
  let itensOverride = null;
  if (bol.itens_override) {
    try {
      const parsed = typeof bol.itens_override === 'string' ? JSON.parse(bol.itens_override) : bol.itens_override;
      if (Array.isArray(parsed) && parsed.length > 0) itensOverride = parsed;
    } catch (_) {}
  }
  posto.itens = itensOverride
    ? itensOverride.map((it, idx) => ({
        id: -idx,
        posto_id: posto.id,
        descricao: it.descricao || '',
        quantidade: Number(it.quantidade) || 0,
        valor_unitario: Number(it.valor_unitario) || 0,
        ordem: idx,
      }))
    : await db.prepare('SELECT * FROM bol_itens WHERE posto_id=? ORDER BY ordem').all(posto.id);

  // Monta contrato c/ shape esperado pelo PDF
  const contrato = {
    contratante: bol.contratante,
    numero_contrato: bol.numero_contrato,
    processo: bol.processo,
    pregao: bol.pregao,
    descricao_servico: bol.descricao_servico || '',
    escala: bol.escala || '',
    empresa_razao: bol.empresa_razao || '',
    empresa_cnpj: bol.empresa_cnpj || '',
    empresa_endereco: bol.empresa_endereco || '',
    empresa_email: bol.empresa_email || '',
    empresa_telefone: bol.empresa_telefone || '',
  };

  // Período usando o ciclo configurado no contrato (14→13 UNITINS, 5→4 UFT, etc.)
  // Substitui o calcularPeriodo() legado que era hardcoded "21 a 20".
  let periodo;
  if (bol.competencia && /^\d{4}-\d{2}$/.test(bol.competencia)) {
    const per = _calcPeriodoCiclico(bol.competencia, bol.bc_ciclo_dia);
    periodo = `${String(per.dia_inicio).padStart(2,'0')} de ${per.mes_inicio_txt} de ${per.ano_inicio} a ` +
              `${String(per.dia_fim).padStart(2,'0')} de ${per.mes_fim_txt} de ${per.ano_fim}.`;
  } else {
    periodo = bol.competencia || '';
  }

  const dataEmissao = bol.data_emissao
    ? new Date(bol.data_emissao).toLocaleDateString('pt-BR')
    : new Date().toLocaleDateString('pt-BR');

  const nfseInfo = modo === 'definitivo' ? {
    numero: bol.nfse_numero,
    data_emissao: bol.nfse_data_emissao
      ? new Date(bol.nfse_data_emissao).toLocaleDateString('pt-BR')
      : '',
    codigo_verificacao: bol.nfse_codigo_verificacao || '',
    link: bol.nfse_link || ''
  } : null;

  const os = require('os');
  const tmpFile = path.join(os.tmpdir(),
    `boletim-${modo}-${bol.id}-${Date.now()}.pdf`);

  // Aguarda o stream interno do PDF terminar antes de servir.
  await gerarBoletimPDF(contrato, posto, bol.nfse_numero || '', dataEmissao, periodo, tmpFile, nfseInfo);

  res.setHeader('Content-Type', 'application/pdf');
  const fname = `Boletim ${modo === 'previo' ? 'Previo' : 'Definitivo'} ${(posto.campus_nome||'').replace(/[^\w\-]/g,'_')} ${bol.competencia}.pdf`;
  res.setHeader('Content-Disposition', `inline; filename="${fname}"`);
  const stream = fs.createReadStream(tmpFile);
  stream.pipe(res);
  stream.on('close', () => { try { fs.unlinkSync(tmpFile); } catch (_) {} });
}

router.get('/:id/pdf-previo', async (req, res) => {
  try { await _renderBoletimPDF(req, res, 'previo'); }
  catch (err) { console.error('Erro pdf-previo:', err); res.status(500).json({ error: err.message }); }
});
router.get('/:id/pdf-definitivo', async (req, res) => {
  try { await _renderBoletimPDF(req, res, 'definitivo'); }
  catch (err) { console.error('Erro pdf-definitivo:', err); res.status(500).json({ error: err.message }); }
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

// ─── DESFAZER RASCUNHO ────────────────────────────────────────
// DELETE /api/boletins/:id
// Apaga um boletim que ainda é rascunho. Bloqueia exclusão se já foi aprovado
// ou se a NFS-e já foi emitida — proteção contra perda de dado fiscal.
router.delete('/:id', async (req, res) => {
  try {
    const db = req.db;
    const bol = await db.prepare('SELECT id, status, nfse_status FROM bol_boletins WHERE id=?').get(req.params.id);
    if (!bol) return res.status(404).json({ error: 'Boletim não encontrado' });
    if (bol.nfse_status === 'EMITIDA') {
      return res.status(400).json({ error: 'NFS-e já emitida — boletim não pode ser excluído' });
    }
    if (bol.status !== 'rascunho') {
      return res.status(400).json({ error: 'Apenas boletins em rascunho podem ser desfeitos (reabra antes se preciso)' });
    }
    await db.prepare(`DELETE FROM bol_boletins WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── LISTAGEM para Painel de Faturamento → Emissão de NFS-e ───
// GET /api/boletins/emissao?mes=YYYY-MM&nfse_status=PENDENTE
// Retorna boletins com dados do contrato pra alimentar a tela de emissão.
// Filtros opcionais: mes (YYYY-MM) e nfse_status (PENDENTE|ENVIANDO|EMITIDA|ERRO).
router.get('/emissao', async (req, res) => {
  const { mes, nfse_status } = req.query;
  const where = [];
  const params = [];
  if (mes && /^\d{4}-\d{2}$/.test(mes)) {
    where.push('b.competencia = ?');
    params.push(mes);
  }
  if (nfse_status) {
    where.push('b.nfse_status = ?');
    params.push(nfse_status);
  }
  // Filtro adicional: oculta boletins de contratos ENCERRADO/RESCINDIDO.
  // O status fica em contratos.status (financeira) e bate por contrato_ref ou numero_contrato.
  where.push(`NOT EXISTS (
    SELECT 1 FROM contratos c
    WHERE (LOWER(COALESCE(c.status,'')) LIKE '%encerrad%'
        OR LOWER(COALESCE(c.status,'')) LIKE '%rescindid%')
      AND (
        (bc.contrato_ref != '' AND c.numContrato = bc.contrato_ref)
        OR c.numContrato LIKE '%' || bc.numero_contrato
      )
  )`);
  const whereSql = 'WHERE ' + where.join(' AND ');
  try {
    const rows = await req.db.prepare(`
      SELECT b.id, b.contrato_id, b.competencia, b.status, b.nfse_status,
             b.valor_base, b.valor_total, b.glosas, b.acrescimos,
             b.nfse_numero, b.nfse_data_emissao, b.nfse_erro,
             bc.nome AS contrato_nome, bc.contratante
      FROM bol_boletins b
      LEFT JOIN bol_contratos bc ON bc.id = b.contrato_id
      ${whereSql}
      ORDER BY b.competencia DESC, bc.nome ASC
    `).all(...params);
    res.json({ ok: true, data: rows });
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
               (SELECT c1.orgao FROM contratos c1 WHERE bc.contrato_ref != '' AND c1.numContrato LIKE '%' || bc.contrato_ref || '%' LIMIT 1),
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

// Helper: cria boletins fantasma pras NFs órfãs com contrato resolvível.
// Retorna { criados, sem_contrato, ja_existem }.
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
    // Normaliza competência pra YYYY-MM (campo pode vir 'YYYY-MM-DD' ou 'YYYY-MM')
    let comp = (nf.competencia || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(comp) && nf.data_emissao) {
      comp = String(nf.data_emissao).slice(0, 7);
    }
    if (!/^\d{4}-\d{2}$/.test(comp)) continue; // sem competência confiável

    // Tenta resolver contrato por CNPJ primeiro
    const cnpjLimpo = String(nf.cnpj_tomador || '').replace(/\D/g, '');
    let contrato = null;
    if (cnpjLimpo) {
      contrato = await db.prepare(`
        SELECT id FROM bol_contratos
        WHERE REGEXP_REPLACE(COALESCE(insc_municipal,''), '[^0-9]', '', 'g') = ?
        LIMIT 1
      `).get(cnpjLimpo);
    }
    // Fallback por razão social
    if (!contrato && nf.tomador) {
      contrato = await db.prepare(`
        SELECT id FROM bol_contratos
        WHERE UPPER(contratante) LIKE '%' || UPPER(?) || '%'
           OR UPPER(?) LIKE '%' || UPPER(contratante) || '%'
        LIMIT 1
      `).get(nf.tomador, nf.tomador);
    }

    if (!contrato) { semContrato++; continue; }

    // Já existe boletim deste contrato/competência?
    const existente = await db.prepare(
      'SELECT id, nfse_numero FROM bol_boletins WHERE contrato_id = ? AND competencia = ?'
    ).get(contrato.id, comp);

    if (existente) {
      jaExistem++;
      // Linka esta NF ao boletim existente (mesmo se nfse_numero diferente —
      // pode ser uma NF complementar pro mesmo período).
      try {
        await db.prepare('UPDATE notas_fiscais SET boletim_id = ? WHERE id = ?')
                .run(existente.id, nf.id);
        linkados++;
      } catch (_) {}
      continue;
    }

    // Cria boletim fantasma — flag via discriminacao com prefixo
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
      // UNIQUE violado (race) ou outro erro — segue
      console.warn('[boletins] auto-create fantasma falhou pra NF', nf.numero, ':', e.message);
    }
  }

  return { criados, sem_contrato: semContrato, ja_existem: jaExistem, linkados_existentes: linkados };
}

// POST /api/boletins/_criar-fantasmas — cria boletins fantasma pras NFs órfãs
router.post('/_criar-fantasmas', async (req, res) => {
  try {
    const stats = await autoCriarBoletinsFantasmas(req.db);
    res.json({ ok: true, ...stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Expose helper para webiss.js + outros importadores chamarem
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

    // Diagnóstico: NFs ainda órfãs (sem boletim) e boletins emitidos sem NF
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
      // Auto-link oportunista se achou via fallback
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
// Diagnóstico e cleanup de duplicatas no caso CONSOLIDADO (posto_id IS NULL).
// Sob Opção A (1 NF = 1 boletim por posto), N boletins/competência com
// posto_id distintos são legítimos e não devem ser tocados aqui — o índice
// UNIQUE é parcial (idx_bol_uniq_contrato_comp_null) e aceita isso.

// GET /api/boletins/_duplicatas — lista grupos consolidados com mais de 1 boletim
router.get('/_duplicatas', async (req, res) => {
  try {
    const grupos = await req.db.prepare(`
      SELECT contrato_id, competencia, COUNT(*) AS qtd,
             ARRAY_AGG(id ORDER BY id) AS ids
      FROM bol_boletins
      WHERE posto_id IS NULL
      GROUP BY contrato_id, competencia
      HAVING COUNT(*) > 1
      ORDER BY contrato_id, competencia
    `).all();
    if (!Array.isArray(grupos) || grupos.length === 0) {
      return res.json({ ok: true, total: 0, grupos: [] });
    }
    // Enriquece com nome do contrato e detalhe de cada boletim
    for (const g of grupos) {
      const c = await req.db.prepare('SELECT nome, contratante FROM bol_contratos WHERE id=?').get(g.contrato_id);
      g.contrato_nome = c?.nome || '';
      g.contratante   = c?.contratante || '';
      g.boletins = await req.db.prepare(`
        SELECT id, status, nfse_status, nfse_numero, valor_total, total_geral,
               created_at, updated_at
        FROM bol_boletins WHERE id = ANY(?::int[])
        ORDER BY id
      `).all(g.ids);
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
      WHERE posto_id IS NULL
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
        FROM bol_boletins WHERE id = ANY(?::int[])
      `).all(g.ids);

      // Score: EMITIDA=4, aprovado=3, rascunho com valor>0=2, demais=1, +
      // tiebreak por created_at desc.
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
          // Reapontar bol_boletins_nfs do perdedor pro vencedor (caso tenha PDFs/NFs gravadas lá)
          try {
            await req.db.prepare(
              `UPDATE bol_boletins_nfs SET boletim_id = ? WHERE boletim_id = ?`
            ).run(vencedor.id, p.id);
          } catch (_) {}
          // Apaga o perdedor (cascade em colaboradores/glosas via FK)
          await req.db.prepare(`DELETE FROM bol_boletins WHERE id = ?`).run(p.id);
          removidos++;
        }
      }
    }

    // Índice UNIQUE é criado/garantido pelo boot do módulo (versão parcial,
    // WHERE posto_id IS NULL). Não recriar aqui — sob Opção A, a versão
    // global (sem filter) sempre vai falhar por boletins multi-posto válidos.

    res.json({
      ok: true,
      dry_run: dryRun,
      grupos_analisados: grupos.length,
      removidos,
      plano,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
