/**
 * Montana Multi-Empresa — Modelos de NF (templates pré-cadastrados)
 *
 * Resolve o caso de NFs avulsas (não-boletim) que repetem mês a mês:
 * o usuário cadastra UM modelo (tomador, valor, descrição com {{competencia}},
 * alíquotas), depois mês a mês só clica "Emitir" → escolhe competência →
 * a NF nova é criada na tabela notas_fiscais.
 *
 * Endpoints:
 *   GET    /api/nf-modelos                  — lista
 *   POST   /api/nf-modelos                  — cria
 *   GET    /api/nf-modelos/:id              — detalhe
 *   PUT    /api/nf-modelos/:id              — edita
 *   DELETE /api/nf-modelos/:id              — soft-delete (ativo=false)
 *   POST   /api/nf-modelos/:id/emitir       — instancia em notas_fiscais
 */

const express = require('express');
const companyMw = require('../companyMiddleware');

const router = express.Router();
router.use(companyMw);

// ─── INIT: cria tabela nf_modelos ────────────────────────────────
router.use(async (req, res, next) => {
  const db = req.db;
  if (!db) return next();

  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS nf_modelos (
      id BIGSERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      tomador TEXT,
      cnpj_tomador TEXT,
      contrato_ref TEXT,
      descricao_template TEXT,
      valor_bruto NUMERIC(14,2) DEFAULT 0,
      pis_pct NUMERIC(7,4) DEFAULT 0,
      cofins_pct NUMERIC(7,4) DEFAULT 0,
      iss_pct NUMERIC(7,4) DEFAULT 0,
      inss_pct NUMERIC(7,4) DEFAULT 0,
      ir_pct NUMERIC(7,4) DEFAULT 0,
      csll_pct NUMERIC(7,4) DEFAULT 0,
      cnae TEXT,
      item_lista_servico TEXT,
      natureza_operacao TEXT,
      mostrar_colaboradores BOOLEAN DEFAULT FALSE,
      cidade TEXT,
      obs TEXT,
      ativo BOOLEAN DEFAULT TRUE,
      ultima_emissao DATE,
      qtd_emissoes INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_nfm_ativo ON nf_modelos(ativo)`).run();
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_nfm_tomador ON nf_modelos(tomador)`).run();
  } catch (_) {}

  next();
});

// ─── HELPERS ─────────────────────────────────────────────────────

function mesPorExtenso(competencia) {
  // competencia: 'YYYY-MM' (ex: '2026-04')
  if (!competencia || !/^\d{4}-\d{2}$/.test(competencia)) return competencia || '';
  const meses = ['', 'janeiro','fevereiro','março','abril','maio','junho',
                 'julho','agosto','setembro','outubro','novembro','dezembro'];
  const [ano, mes] = competencia.split('-');
  return `${meses[parseInt(mes)]} de ${ano}`;
}

function aplicarPlaceholders(template, ctx) {
  if (!template) return '';
  return String(template)
    .replace(/\{\{\s*competencia\s*\}\}/gi, ctx.competencia || '')
    .replace(/\{\{\s*competencia_extenso\s*\}\}/gi, mesPorExtenso(ctx.competencia))
    .replace(/\{\{\s*ano\s*\}\}/gi, (ctx.competencia || '').slice(0, 4))
    .replace(/\{\{\s*mes\s*\}\}/gi, (ctx.competencia || '').slice(5, 7))
    .replace(/\{\{\s*colaboradores\s*\}\}/gi, ctx.colaboradoresStr || '')
    .replace(/\{\{\s*tomador\s*\}\}/gi, ctx.tomador || '')
    .replace(/\{\{\s*valor\s*\}\}/gi, ctx.valorStr || '');
}

function fmtMoeda(v) {
  return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// ─── CRUD MODELOS ────────────────────────────────────────────────

// GET /api/nf-modelos[?ativo=1|todos]
router.get('/', async (req, res) => {
  try {
    const incluirInativos = req.query.ativo === 'todos';
    const sql = incluirInativos
      ? `SELECT * FROM nf_modelos ORDER BY ativo DESC, nome ASC`
      : `SELECT * FROM nf_modelos WHERE ativo = TRUE ORDER BY nome ASC`;
    const rowsRaw = await req.db.prepare(sql).all();
    res.json({ ok: true, modelos: Array.isArray(rowsRaw) ? rowsRaw : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/nf-modelos/:id
router.get('/:id', async (req, res) => {
  try {
    const m = await req.db.prepare('SELECT * FROM nf_modelos WHERE id = ?').get(req.params.id);
    if (!m) return res.status(404).json({ error: 'Modelo não encontrado' });
    res.json({ ok: true, modelo: m });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/nf-modelos  body: { nome, tomador, cnpj_tomador, descricao_template, valor_bruto, alíquotas... }
router.post('/', async (req, res) => {
  try {
    const m = req.body || {};
    if (!m.nome) return res.status(400).json({ error: 'nome obrigatório' });
    const r = await req.db.prepare(`
      INSERT INTO nf_modelos
        (nome, tomador, cnpj_tomador, contrato_ref, descricao_template, valor_bruto,
         pis_pct, cofins_pct, iss_pct, inss_pct, ir_pct, csll_pct,
         cnae, item_lista_servico, natureza_operacao, mostrar_colaboradores, cidade, obs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      m.nome, m.tomador || '', m.cnpj_tomador || '',
      m.contrato_ref || '', m.descricao_template || '',
      parseFloat(m.valor_bruto) || 0,
      parseFloat(m.pis_pct) || 0, parseFloat(m.cofins_pct) || 0,
      parseFloat(m.iss_pct) || 0, parseFloat(m.inss_pct) || 0,
      parseFloat(m.ir_pct) || 0, parseFloat(m.csll_pct) || 0,
      m.cnae || '', m.item_lista_servico || '',
      m.natureza_operacao || '',
      m.mostrar_colaboradores === true,
      m.cidade || '', m.obs || ''
    );
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/nf-modelos/:id
router.put('/:id', async (req, res) => {
  try {
    const m = req.body || {};
    await req.db.prepare(`
      UPDATE nf_modelos SET
        nome                  = COALESCE(?, nome),
        tomador               = COALESCE(?, tomador),
        cnpj_tomador          = COALESCE(?, cnpj_tomador),
        contrato_ref          = COALESCE(?, contrato_ref),
        descricao_template    = COALESCE(?, descricao_template),
        valor_bruto           = COALESCE(?, valor_bruto),
        pis_pct               = COALESCE(?, pis_pct),
        cofins_pct            = COALESCE(?, cofins_pct),
        iss_pct               = COALESCE(?, iss_pct),
        inss_pct              = COALESCE(?, inss_pct),
        ir_pct                = COALESCE(?, ir_pct),
        csll_pct              = COALESCE(?, csll_pct),
        cnae                  = COALESCE(?, cnae),
        item_lista_servico    = COALESCE(?, item_lista_servico),
        natureza_operacao     = COALESCE(?, natureza_operacao),
        mostrar_colaboradores = COALESCE(?, mostrar_colaboradores),
        cidade                = COALESCE(?, cidade),
        obs                   = COALESCE(?, obs),
        ativo                 = COALESCE(?, ativo),
        updated_at            = NOW()
      WHERE id = ?
    `).run(
      m.nome || null, m.tomador || null, m.cnpj_tomador || null,
      m.contrato_ref || null, m.descricao_template || null,
      m.valor_bruto != null ? parseFloat(m.valor_bruto) : null,
      m.pis_pct != null ? parseFloat(m.pis_pct) : null,
      m.cofins_pct != null ? parseFloat(m.cofins_pct) : null,
      m.iss_pct != null ? parseFloat(m.iss_pct) : null,
      m.inss_pct != null ? parseFloat(m.inss_pct) : null,
      m.ir_pct != null ? parseFloat(m.ir_pct) : null,
      m.csll_pct != null ? parseFloat(m.csll_pct) : null,
      m.cnae || null, m.item_lista_servico || null,
      m.natureza_operacao || null,
      m.mostrar_colaboradores != null ? !!m.mostrar_colaboradores : null,
      m.cidade || null, m.obs || null,
      m.ativo != null ? !!m.ativo : null,
      req.params.id
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/nf-modelos/:id  (soft delete)
router.delete('/:id', async (req, res) => {
  try {
    await req.db.prepare('UPDATE nf_modelos SET ativo = FALSE, updated_at = NOW() WHERE id = ?')
      .run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── EMITIR (instancia o modelo numa NF concreta em notas_fiscais) ─

// POST /api/nf-modelos/:id/emitir
//   body: { competencia: 'YYYY-MM', data_emissao?: 'YYYY-MM-DD',
//           valor_bruto_override?, descricao_extra?, colaboradores?: [{nome, cpf?, funcao?}],
//           glosas?: [{motivo, valor}], dry_run?: true }
router.post('/:id/emitir', async (req, res) => {
  try {
    const modelo = await req.db.prepare('SELECT * FROM nf_modelos WHERE id = ? AND ativo = TRUE')
      .get(req.params.id);
    if (!modelo) return res.status(404).json({ error: 'Modelo não encontrado ou inativo' });

    const { competencia, data_emissao, valor_bruto_override, descricao_extra,
            colaboradores, glosas, dry_run } = req.body || {};
    if (!competencia || !/^\d{4}-\d{2}$/.test(competencia)) {
      return res.status(400).json({ error: 'competencia obrigatória no formato YYYY-MM' });
    }

    // Valor final: override > template
    let valorBruto = valor_bruto_override != null
      ? parseFloat(valor_bruto_override)
      : Number(modelo.valor_bruto || 0);
    if (!Number.isFinite(valorBruto) || valorBruto <= 0) {
      return res.status(400).json({ error: 'valor_bruto inválido' });
    }

    // Aplica glosas (descontos do mês)
    const glosaList = Array.isArray(glosas) ? glosas : [];
    const totalGlosas = glosaList.reduce((s, g) => s + Math.max(0, parseFloat(g.valor) || 0), 0);
    const valorComGlosas = +(valorBruto - totalGlosas).toFixed(2);

    // Calcula retenções com base no valor APÓS glosas
    const pis    = +(valorComGlosas * (Number(modelo.pis_pct)    || 0) / 100).toFixed(2);
    const cofins = +(valorComGlosas * (Number(modelo.cofins_pct) || 0) / 100).toFixed(2);
    const iss    = +(valorComGlosas * (Number(modelo.iss_pct)    || 0) / 100).toFixed(2);
    const inss   = +(valorComGlosas * (Number(modelo.inss_pct)   || 0) / 100).toFixed(2);
    const ir     = +(valorComGlosas * (Number(modelo.ir_pct)     || 0) / 100).toFixed(2);
    const csll   = +(valorComGlosas * (Number(modelo.csll_pct)   || 0) / 100).toFixed(2);
    const retencao = +(pis + cofins + iss + inss + ir + csll).toFixed(2);
    const valorLiquido = +(valorComGlosas - retencao).toFixed(2);

    // Monta descrição com placeholders + colaboradores + glosas
    const colabList = Array.isArray(colaboradores) ? colaboradores.filter(c => c && (c.nome || c.nome_colaborador)) : [];
    const colaboradoresStr = (modelo.mostrar_colaboradores && colabList.length)
      ? '\nColaboradores: ' + colabList.map(c =>
          (c.nome || c.nome_colaborador) + (c.cpf ? ` (CPF ${c.cpf})` : '') + (c.funcao ? ` — ${c.funcao}` : '')
        ).join('; ')
      : '';
    const glosasStr = glosaList.length
      ? '\nGlosas: ' + glosaList.map(g => `${g.motivo} (${fmtMoeda(g.valor)})`).join('; ') +
        ` — Total: ${fmtMoeda(totalGlosas)}`
      : '';

    const descricao = aplicarPlaceholders(modelo.descricao_template, {
      competencia, tomador: modelo.tomador,
      colaboradoresStr, valorStr: fmtMoeda(valorComGlosas),
    }) + colaboradoresStr + glosasStr + (descricao_extra ? '\n' + descricao_extra : '');

    if (dry_run) {
      return res.json({
        ok: true, dry_run: true,
        preview: {
          tomador: modelo.tomador, cnpj_tomador: modelo.cnpj_tomador,
          competencia, data_emissao: data_emissao || new Date().toISOString().slice(0, 10),
          valor_bruto: valorBruto,
          glosas: totalGlosas, valor_com_glosas: valorComGlosas,
          pis, cofins, iss, inss, ir, csll,
          retencao, valor_liquido: valorLiquido,
          descricao,
        },
      });
    }

    // Insere na tabela notas_fiscais
    const dataEmiss = data_emissao || new Date().toISOString().slice(0, 10);
    const r = await req.db.prepare(`
      INSERT INTO notas_fiscais
        (numero, data_emissao, competencia, tomador, cnpj_tomador, contrato_ref,
         valor_bruto, valor_liquido, retencao,
         pis, cofins, iss, inss, ir, csll,
         descricao, cidade, status_conciliacao, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?, ?, ?, ?,
         ?, ?, 'PENDENTE', NOW(), NOW())
    `).run(
      `MOD-${modelo.id}-${competencia}`, // placeholder; usuário preenche número real depois
      dataEmiss, competencia,
      modelo.tomador || '', modelo.cnpj_tomador || '', modelo.contrato_ref || '',
      valorComGlosas, valorLiquido, retencao,
      pis, cofins, iss, inss, ir, csll,
      descricao, modelo.cidade || ''
    );

    // Atualiza estatísticas do modelo
    await req.db.prepare(`
      UPDATE nf_modelos SET
        ultima_emissao = ?,
        qtd_emissoes   = qtd_emissoes + 1,
        updated_at     = NOW()
      WHERE id = ?
    `).run(dataEmiss, req.params.id);

    res.json({
      ok: true,
      nf_id: r.lastInsertRowid,
      modelo_id: modelo.id,
      competencia,
      valor_bruto: valorComGlosas,
      valor_liquido: valorLiquido,
      retencao,
    });
  } catch (e) {
    console.error('[nf-modelos] erro emitir:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
