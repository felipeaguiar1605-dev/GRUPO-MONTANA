/**
 * Montana — Módulo RH / Departamento Pessoal
 * Rotas: /api/rh/*
 */
const express = require('express');
const router = express.Router();
const companyMw = require('../companyMiddleware');

router.use(companyMw);

// ─── Tabelas INSS e IRRF 2026 ────────────────────────────────────────────────

const INSS_2026 = [
  { ate: 1518.00,  aliq: 0.075 },
  { ate: 2793.88,  aliq: 0.09  },
  { ate: 4190.83,  aliq: 0.12  },
  { ate: 8157.41,  aliq: 0.14  },
];

const IRRF_2026 = [
  { ate: 2259.20,  aliq: 0,     deducao: 0      },
  { ate: 2826.65,  aliq: 0.075, deducao: 169.44 },
  { ate: 3751.05,  aliq: 0.15,  deducao: 381.44 },
  { ate: 4664.68,  aliq: 0.225, deducao: 662.77 },
  { ate: Infinity, aliq: 0.275, deducao: 896.00 },
];

function calcINSS(salarioBruto) {
  // Cálculo progressivo (tabela 2026)
  const teto = 8157.41;
  const base = Math.min(salarioBruto, teto);
  let inss = 0;
  let anterior = 0;
  for (const faixa of INSS_2026) {
    if (base <= anterior) break;
    const limite = Math.min(base, faixa.ate);
    inss += (limite - anterior) * faixa.aliq;
    anterior = faixa.ate;
  }
  return Math.round(inss * 100) / 100;
}

function calcIRRF(salarioBruto, inss, numDependentes = 0) {
  const deducaoDependente = 189.59; // 2026
  const baseCalculo = salarioBruto - inss - (numDependentes * deducaoDependente);
  if (baseCalculo <= 0) return 0;
  for (const faixa of IRRF_2026) {
    if (baseCalculo <= faixa.ate) {
      const irrf = (baseCalculo * faixa.aliq) - faixa.deducao;
      return Math.max(0, Math.round(irrf * 100) / 100);
    }
  }
  return 0;
}

function calcFolhaItem(func, diasTrabalhados = 30, horasExtras = 0, numDependentes = 0) {
  const salarioProporcional = (func.salario_base / 30) * diasTrabalhados;
  const valorHE = horasExtras > 0 ? (func.salario_base / 220) * 1.5 * horasExtras : 0;
  const totalBruto = Math.round((salarioProporcional + valorHE) * 100) / 100;
  const inss = calcINSS(totalBruto);
  const irrf = calcIRRF(totalBruto, inss, numDependentes);
  const totalDescontos = Math.round((inss + irrf) * 100) / 100;
  const totalLiquido = Math.round((totalBruto - totalDescontos) * 100) / 100;
  return { totalBruto, valorHE, inss, irrf, totalDescontos, totalLiquido };
}

// ─── CARGOS ──────────────────────────────────────────────────────────────────

router.get('/cargos', (req, res) => {
  const rows = req.db.prepare('SELECT * FROM rh_cargos ORDER BY nome').all();
  res.json(rows);
});

router.post('/cargos', (req, res) => {
  const { nome, cbo, salario_base } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
  const r = req.db.prepare(
    'INSERT INTO rh_cargos (nome, cbo, salario_base) VALUES (?, ?, ?)'
  ).run(nome, cbo || '', salario_base || 0);
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.patch('/cargos/:id', (req, res) => {
  const { nome, cbo, salario_base } = req.body;
  req.db.prepare(
    'UPDATE rh_cargos SET nome=?, cbo=?, salario_base=? WHERE id=?'
  ).run(nome, cbo || '', salario_base || 0, req.params.id);
  res.json({ ok: true });
});

router.delete('/cargos/:id', (req, res) => {
  req.db.prepare('DELETE FROM rh_cargos WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── FUNCIONÁRIOS ────────────────────────────────────────────────────────────

router.get('/funcionarios', (req, res) => {
  const { status, contrato_ref } = req.query;
  let sql = `
    SELECT f.*, c.nome as cargo_nome, c.cbo
    FROM rh_funcionarios f
    LEFT JOIN rh_cargos c ON c.id = f.cargo_id
  `;
  const params = [];
  const where = [];
  if (status) { where.push('f.status = ?'); params.push(status); }
  if (contrato_ref) { where.push('f.contrato_ref = ?'); params.push(contrato_ref); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY f.nome';
  res.json(req.db.prepare(sql).all(...params));
});

router.get('/funcionarios/:id', (req, res) => {
  const f = req.db.prepare(`
    SELECT f.*, c.nome as cargo_nome FROM rh_funcionarios f
    LEFT JOIN rh_cargos c ON c.id = f.cargo_id WHERE f.id = ?
  `).get(req.params.id);
  if (!f) return res.status(404).json({ erro: 'Não encontrado' });
  res.json(f);
});

router.post('/funcionarios', (req, res) => {
  const {
    nome, cpf, rg, data_nascimento, data_admissao, cargo_id, contrato_ref,
    lotacao, salario_base, pis, ctps_numero, ctps_serie,
    banco, agencia, conta_banco, tipo_conta, email, telefone, obs
  } = req.body;
  if (!nome || !data_admissao || !salario_base) {
    return res.status(400).json({ erro: 'Nome, data_admissao e salario_base são obrigatórios' });
  }
  const r = req.db.prepare(`
    INSERT INTO rh_funcionarios
      (nome,cpf,rg,data_nascimento,data_admissao,cargo_id,contrato_ref,lotacao,
       salario_base,pis,ctps_numero,ctps_serie,banco,agencia,conta_banco,tipo_conta,email,telefone,obs)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(nome,cpf||'',rg||'',data_nascimento||'',data_admissao,cargo_id||null,contrato_ref||'',
         lotacao||'',salario_base,pis||'',ctps_numero||'',ctps_serie||'',
         banco||'',agencia||'',conta_banco||'',tipo_conta||'',email||'',telefone||'',obs||'');
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.patch('/funcionarios/:id', (req, res) => {
  const {
    nome, cpf, rg, data_nascimento, data_admissao, data_demissao, cargo_id,
    contrato_ref, lotacao, salario_base, status, pis, ctps_numero, ctps_serie,
    banco, agencia, conta_banco, tipo_conta, email, telefone, obs
  } = req.body;
  req.db.prepare(`
    UPDATE rh_funcionarios SET
      nome=?,cpf=?,rg=?,data_nascimento=?,data_admissao=?,data_demissao=?,cargo_id=?,
      contrato_ref=?,lotacao=?,salario_base=?,status=?,pis=?,ctps_numero=?,ctps_serie=?,
      banco=?,agencia=?,conta_banco=?,tipo_conta=?,email=?,telefone=?,obs=?,
      updated_at=datetime('now')
    WHERE id=?
  `).run(nome,cpf||'',rg||'',data_nascimento||'',data_admissao,data_demissao||'',cargo_id||null,
         contrato_ref||'',lotacao||'',salario_base,status||'ATIVO',pis||'',ctps_numero||'',ctps_serie||'',
         banco||'',agencia||'',conta_banco||'',tipo_conta||'',email||'',telefone||'',obs||'',req.params.id);
  res.json({ ok: true });
});

router.delete('/funcionarios/:id', (req, res) => {
  // Soft delete — registra demissão
  req.db.prepare(`
    UPDATE rh_funcionarios SET status='DEMITIDO', data_demissao=date('now'), updated_at=datetime('now')
    WHERE id=?
  `).run(req.params.id);
  res.json({ ok: true });
});

// ─── FOLHA DE PAGAMENTO ──────────────────────────────────────────────────────

router.get('/folha', (req, res) => {
  const rows = req.db.prepare(`
    SELECT f.*,
      COUNT(i.id)               as qtd_funcionarios,
      COALESCE(SUM(i.inss),0)  as total_inss,
      COALESCE(SUM(i.irrf),0)  as total_irrf
    FROM rh_folha f
    LEFT JOIN rh_folha_itens i ON i.folha_id = f.id
    GROUP BY f.id
    ORDER BY f.competencia DESC
  `).all();
  res.json(rows);
});

router.post('/folha', (req, res) => {
  const { competencia, data_pagamento, obs } = req.body;
  if (!competencia) return res.status(400).json({ erro: 'Competência obrigatória' });
  const existe = req.db.prepare('SELECT id FROM rh_folha WHERE competencia=?').get(competencia);
  if (existe) return res.status(400).json({ erro: 'Folha para esta competência já existe' });
  const r = req.db.prepare(
    'INSERT INTO rh_folha (competencia, data_pagamento, obs) VALUES (?,?,?)'
  ).run(competencia, data_pagamento || '', obs || '');
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.post('/folha/:id/calcular', (req, res) => {
  const folha = req.db.prepare('SELECT * FROM rh_folha WHERE id=?').get(req.params.id);
  if (!folha) return res.status(404).json({ erro: 'Folha não encontrada' });

  const funcionarios = req.db.prepare(
    "SELECT * FROM rh_funcionarios WHERE status='ATIVO'"
  ).all();

  const calcItem = req.db.prepare(`
    INSERT OR REPLACE INTO rh_folha_itens
      (folha_id,funcionario_id,salario_base,dias_trabalhados,horas_extras,valor_he,
       inss,irrf,total_bruto,total_descontos,total_liquido)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);

  let totalBruto = 0, totalDescontos = 0, totalLiquido = 0;

  const processar = req.db.transaction(() => {
    req.db.prepare('DELETE FROM rh_folha_itens WHERE folha_id=?').run(folha.id);
    for (const f of funcionarios) {
      const calc = calcFolhaItem(f);
      calcItem.run(folha.id, f.id, f.salario_base, 30, 0, 0,
                   calc.inss, calc.irrf, calc.totalBruto, calc.totalDescontos, calc.totalLiquido);
      totalBruto    += calc.totalBruto;
      totalDescontos += calc.totalDescontos;
      totalLiquido  += calc.totalLiquido;
    }
    req.db.prepare(`
      UPDATE rh_folha SET total_bruto=?,total_descontos=?,total_liquido=?,status='PROCESSADO'
      WHERE id=?
    `).run(
      Math.round(totalBruto*100)/100,
      Math.round(totalDescontos*100)/100,
      Math.round(totalLiquido*100)/100,
      folha.id
    );
  });

  processar();
  res.json({ ok: true, funcionarios: funcionarios.length, totalBruto, totalDescontos, totalLiquido });
});

router.get('/folha/:id/itens', (req, res) => {
  const itens = req.db.prepare(`
    SELECT i.*, f.nome as funcionario_nome, f.cargo_id, c.nome as cargo_nome
    FROM rh_folha_itens i
    JOIN rh_funcionarios f ON f.id = i.funcionario_id
    LEFT JOIN rh_cargos c ON c.id = f.cargo_id
    WHERE i.folha_id = ?
    ORDER BY f.nome
  `).all(req.params.id);
  res.json(itens);
});

router.patch('/folha/:id', (req, res) => {
  const { status, data_pagamento, obs } = req.body;
  req.db.prepare('UPDATE rh_folha SET status=?,data_pagamento=?,obs=? WHERE id=?')
    .run(status || 'RASCUNHO', data_pagamento || '', obs || '', req.params.id);
  res.json({ ok: true });
});

router.patch('/folha/itens/:id', (req, res) => {
  const {
    dias_trabalhados, horas_extras, adicional_noturno,
    vale_transporte, vale_alimentacao, outros_proventos,
    inss, irrf, faltas, outros_descontos
  } = req.body;

  const item = req.db.prepare('SELECT * FROM rh_folha_itens WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ erro: 'Item não encontrado' });

  const func = req.db.prepare('SELECT * FROM rh_funcionarios WHERE id=?').get(item.funcionario_id);
  const calc = calcFolhaItem(func, dias_trabalhados || 30, horas_extras || 0);

  const inssF = inss !== undefined ? inss : calc.inss;
  const irrfF = irrf !== undefined ? irrf : calc.irrf;
  const totalBruto = Math.round((calc.totalBruto + (adicional_noturno||0) + (outros_proventos||0)) * 100) / 100;
  const totalDescontos = Math.round((inssF + irrfF + (faltas||0) + (outros_descontos||0)) * 100) / 100;
  const totalLiquido = Math.round((totalBruto - totalDescontos - (vale_transporte||0)) * 100) / 100;

  req.db.prepare(`
    UPDATE rh_folha_itens SET
      dias_trabalhados=?,horas_extras=?,valor_he=?,adicional_noturno=?,
      vale_transporte=?,vale_alimentacao=?,outros_proventos=?,
      inss=?,irrf=?,faltas=?,outros_descontos=?,
      total_bruto=?,total_descontos=?,total_liquido=?
    WHERE id=?
  `).run(dias_trabalhados||30, horas_extras||0, calc.valorHE, adicional_noturno||0,
         vale_transporte||0, vale_alimentacao||0, outros_proventos||0,
         inssF, irrfF, faltas||0, outros_descontos||0,
         totalBruto, totalDescontos, totalLiquido, req.params.id);
  res.json({ ok: true });
});

// ─── FÉRIAS ──────────────────────────────────────────────────────────────────

router.get('/ferias', (req, res) => {
  const { funcionario_id } = req.query;
  let sql = `
    SELECT fe.*, f.nome as funcionario_nome
    FROM rh_ferias fe JOIN rh_funcionarios f ON f.id = fe.funcionario_id
  `;
  const params = [];
  if (funcionario_id) { sql += ' WHERE fe.funcionario_id=?'; params.push(funcionario_id); }
  sql += ' ORDER BY fe.data_inicio DESC';
  res.json(req.db.prepare(sql).all(...params));
});

router.post('/ferias', (req, res) => {
  const { funcionario_id, periodo_aquisitivo_inicio, periodo_aquisitivo_fim, data_inicio, data_fim, dias, valor, obs } = req.body;
  if (!funcionario_id || !data_inicio) return res.status(400).json({ erro: 'funcionario_id e data_inicio obrigatórios' });
  const r = req.db.prepare(`
    INSERT INTO rh_ferias (funcionario_id,periodo_aquisitivo_inicio,periodo_aquisitivo_fim,data_inicio,data_fim,dias,valor,obs)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(funcionario_id, periodo_aquisitivo_inicio||'', periodo_aquisitivo_fim||'',
         data_inicio, data_fim||'', dias||30, valor||0, obs||'');
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.patch('/ferias/:id', (req, res) => {
  const { status, data_inicio, data_fim, dias, valor, obs } = req.body;
  req.db.prepare('UPDATE rh_ferias SET status=?,data_inicio=?,data_fim=?,dias=?,valor=?,obs=? WHERE id=?')
    .run(status||'AGENDADA', data_inicio||'', data_fim||'', dias||30, valor||0, obs||'', req.params.id);
  res.json({ ok: true });
});

// ─── AFASTAMENTOS ────────────────────────────────────────────────────────────

router.get('/afastamentos', (req, res) => {
  const { funcionario_id } = req.query;
  let sql = `
    SELECT a.*, f.nome as funcionario_nome
    FROM rh_afastamentos a JOIN rh_funcionarios f ON f.id = a.funcionario_id
  `;
  const params = [];
  if (funcionario_id) { sql += ' WHERE a.funcionario_id=?'; params.push(funcionario_id); }
  sql += ' ORDER BY a.data_inicio DESC';
  res.json(req.db.prepare(sql).all(...params));
});

router.post('/afastamentos', (req, res) => {
  const { funcionario_id, tipo, data_inicio, data_fim, dias, motivo, obs } = req.body;
  if (!funcionario_id || !data_inicio) return res.status(400).json({ erro: 'funcionario_id e data_inicio obrigatórios' });
  const r = req.db.prepare(`
    INSERT INTO rh_afastamentos (funcionario_id,tipo,data_inicio,data_fim,dias,motivo,obs)
    VALUES (?,?,?,?,?,?,?)
  `).run(funcionario_id, tipo||'', data_inicio, data_fim||'', dias||0, motivo||'', obs||'');
  res.json({ ok: true, id: r.lastInsertRowid });
});

router.patch('/afastamentos/:id', (req, res) => {
  const { tipo, data_inicio, data_fim, dias, motivo, obs } = req.body;
  req.db.prepare('UPDATE rh_afastamentos SET tipo=?,data_inicio=?,data_fim=?,dias=?,motivo=?,obs=? WHERE id=?')
    .run(tipo||'', data_inicio||'', data_fim||'', dias||0, motivo||'', obs||'', req.params.id);
  res.json({ ok: true });
});

// ─── RELATÓRIOS ──────────────────────────────────────────────────────────────

router.get('/relatorios/quadro', (req, res) => {
  const quadro = req.db.prepare(`
    SELECT f.id, f.nome, f.salario_base, f.data_admissao, f.contrato_ref, f.lotacao,
           c.nome as cargo, f.status
    FROM rh_funcionarios f
    LEFT JOIN rh_cargos c ON c.id = f.cargo_id
    WHERE f.status = 'ATIVO'
    ORDER BY f.nome
  `).all();
  const total = quadro.reduce((s,f) => s + (f.salario_base||0), 0);
  res.json({ quadro, total_funcionarios: quadro.length, total_folha: Math.round(total*100)/100 });
});

router.get('/relatorios/fgts', (req, res) => {
  const { competencia } = req.query;
  if (!competencia) return res.status(400).json({ erro: 'competencia obrigatória' });
  const folha = req.db.prepare('SELECT * FROM rh_folha WHERE competencia=?').get(competencia);
  if (!folha) return res.json({ itens: [], total_fgts: 0 });
  const itens = req.db.prepare(`
    SELECT i.total_bruto, f.nome, f.pis, f.data_admissao,
           ROUND(i.total_bruto * 0.08, 2) as fgts
    FROM rh_folha_itens i
    JOIN rh_funcionarios f ON f.id = i.funcionario_id
    WHERE i.folha_id = ?
    ORDER BY f.nome
  `).all(folha.id);
  const total_fgts = itens.reduce((s,i) => s + (i.fgts||0), 0);
  res.json({ competencia, itens, total_fgts: Math.round(total_fgts*100)/100 });
});

// ─── CALC TRIBUTOS (endpoint público p/ frontend) ─────────────
router.get('/calcular-tributos', (req, res) => {
  const salario = parseFloat(req.query.salario) || 0;
  const dependentes = parseInt(req.query.dependentes) || 0;
  const inss = calcINSS(salario);
  const irrf = calcIRRF(salario, inss, dependentes);
  res.json({
    salario_bruto: salario,
    inss: +inss.toFixed(2),
    irrf: +irrf.toFixed(2),
    total_descontos: +(inss + irrf).toFixed(2),
    liquido: +(salario - inss - irrf).toFixed(2),
  });
});

// ─── HOLERITE PDF ──────────────────────────────────────────────
router.get('/folha/:id/holerite/:func_id', (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const folha = req.db.prepare('SELECT * FROM rh_folha WHERE id=?').get(req.params.id);
    if (!folha) return res.status(404).json({ erro: 'Folha não encontrada' });

    const item = req.db.prepare(`
      SELECT i.*, f.nome, f.cpf, f.pis, f.ctps_numero, f.cargo_id, f.lotacao, f.banco, f.agencia, f.conta_banco,
             c.nome as cargo_nome, c.cbo
      FROM rh_folha_itens i
      JOIN rh_funcionarios f ON f.id = i.funcionario_id
      LEFT JOIN rh_cargos c ON c.id = f.cargo_id
      WHERE i.folha_id=? AND i.funcionario_id=?
    `).get(req.params.id, req.params.func_id);
    if (!item) return res.status(404).json({ erro: 'Item de folha não encontrado' });

    const empresa = req.company;
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=holerite_${item.nome.replace(/\s/g,'_')}_${folha.competencia}.pdf`);
    doc.pipe(res);

    const brl = v => `R$ ${(+v||0).toLocaleString('pt-BR',{minimumFractionDigits:2})}`;
    const W = 515;

    // ── Cabeçalho empresa ──
    doc.rect(40, 40, W, 50).fill('#1e293b');
    doc.fillColor('#ffffff').fontSize(13).font('Helvetica-Bold')
       .text(empresa.nome, 50, 50, { width: W - 20 });
    doc.fontSize(8).font('Helvetica')
       .text(`CNPJ: ${empresa.cnpj}  |  HOLERITE DE PAGAMENTO  |  Competência: ${folha.competencia}`, 50, 66);
    doc.fillColor('#000000');

    // ── Dados do funcionário ──
    doc.rect(40, 100, W, 14).fill('#f1f5f9');
    doc.fillColor('#334155').fontSize(8).font('Helvetica-Bold')
       .text('DADOS DO FUNCIONÁRIO', 44, 103);
    doc.fillColor('#000000').fontSize(9).font('Helvetica');
    const y0 = 120;
    doc.text(`Nome: ${item.nome}`, 44, y0);
    doc.text(`CPF: ${item.cpf || '—'}`, 44, y0 + 14);
    doc.text(`Cargo: ${item.cargo_nome || '—'}`, 44, y0 + 28);
    doc.text(`Lotação: ${item.lotacao || '—'}`, 300, y0);
    doc.text(`PIS/PASEP: ${item.pis || '—'}`, 300, y0 + 14);
    doc.text(`CTPS: ${item.ctps_numero || '—'}`, 300, y0 + 28);

    // ── Tabela de proventos e descontos ──
    const yT = 178;
    doc.rect(40, yT, W/2 - 2, 14).fill('#0f172a');
    doc.rect(40 + W/2 + 2, yT, W/2 - 2, 14).fill('#0f172a');
    doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold')
       .text('PROVENTOS', 44, yT + 3)
       .text('DESCONTOS', 44 + W/2 + 6, yT + 3);
    doc.fillColor('#000000').font('Helvetica').fontSize(9);

    const linhaProv = (desc, val, y) => {
      doc.text(desc, 44, y);
      doc.text(brl(val), 44 + W/2 - 70, y, { align: 'right', width: 60 });
    };
    const linhaDesc = (desc, val, y) => {
      doc.text(desc, 44 + W/2 + 6, y);
      doc.text(brl(val), 44 + W - 70, y, { align: 'right', width: 60 });
    };

    let yR = yT + 18;
    linhaProv('Salário Base', item.salario_base, yR);
    if (item.valor_he > 0)          { yR += 14; linhaProv('Horas Extras', item.valor_he, yR); }
    if (item.adicional_noturno > 0) { yR += 14; linhaProv('Adicional Noturno', item.adicional_noturno, yR); }
    if (item.vale_alimentacao > 0)  { yR += 14; linhaProv('Vale Alimentação', item.vale_alimentacao, yR); }
    if (item.outros_proventos > 0)  { yR += 14; linhaProv('Outros Proventos', item.outros_proventos, yR); }

    let yD = yT + 18;
    if (item.inss > 0)             linhaDesc('INSS', item.inss, yD);
    if (item.irrf > 0)             { yD += 14; linhaDesc('IRRF', item.irrf, yD); }
    if (item.vale_transporte > 0)  { yD += 14; linhaDesc('Vale Transporte', item.vale_transporte, yD); }
    if (item.faltas > 0)           { yD += 14; linhaDesc('Faltas/Atrasos', item.faltas, yD); }
    if (item.outros_descontos > 0) { yD += 14; linhaDesc('Outros Descontos', item.outros_descontos, yD); }

    const yTot = Math.max(yR, yD) + 18;
    doc.rect(40, yTot, W/2 - 2, 18).fill('#dcfce7');
    doc.rect(40 + W/2 + 2, yTot, W/2 - 2, 18).fill('#fee2e2');
    doc.fillColor('#15803d').font('Helvetica-Bold').fontSize(9)
       .text('TOTAL PROVENTOS', 44, yTot + 4)
       .text(brl(item.total_bruto), 44 + W/2 - 70, yTot + 4, { align:'right', width: 60 });
    doc.fillColor('#dc2626')
       .text('TOTAL DESCONTOS', 44 + W/2 + 6, yTot + 4)
       .text(brl(item.total_descontos), 44 + W - 70, yTot + 4, { align:'right', width: 60 });

    // ── Líquido ──
    const yLiq = yTot + 30;
    doc.rect(40, yLiq, W, 26).fill('#1e293b');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(12)
       .text('VALOR LÍQUIDO A RECEBER:', 44, yLiq + 6)
       .text(brl(item.total_liquido), 44, yLiq + 6, { align:'right', width: W - 8 });

    // ── Dados bancários ──
    if (item.banco) {
      doc.fillColor('#000000').font('Helvetica').fontSize(8)
         .text(`Banco: ${item.banco}  |  Agência: ${item.agencia || '—'}  |  Conta: ${item.conta_banco || '—'}`,
               44, yLiq + 40);
    }

    // ── Rodapé ──
    doc.rect(40, 770, W, 1).fill('#e2e8f0');
    doc.fillColor('#94a3b8').fontSize(7)
       .text(`Gerado em ${new Date().toLocaleDateString('pt-BR')} pelo Montana Sistema`, 44, 774);

    doc.end();
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// ─── IMPORTAR FOLHA VIA EXCEL ─────────────────────────────────
router.post('/folha/:id/importar-excel', (req, res, next) => {
  const multer = require('multer');
  const upload = multer({ dest: 'uploads/tmp/' }).single('file');
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ erro: err.message });
    try {
      if (!req.file) return res.status(400).json({ erro: 'Arquivo não enviado' });
      const ExcelJS = require('exceljs');
      const fs = require('fs');
      const folha = req.db.prepare('SELECT * FROM rh_folha WHERE id=?').get(req.params.id);
      if (!folha) { fs.unlinkSync(req.file.path); return res.status(404).json({ erro: 'Folha não encontrada' }); }

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(req.file.path);
      fs.unlinkSync(req.file.path);

      const ws = wb.worksheets[0];
      if (!ws) return res.status(400).json({ erro: 'Planilha vazia' });

      // Espera colunas: nome | salario_base | dias_trabalhados | horas_extras | adicional_noturno | vale_transporte | vale_alimentacao | outros_proventos | outros_descontos
      const headers = [];
      ws.getRow(1).eachCell(cell => headers.push(String(cell.value || '').toLowerCase().trim().replace(/\s/g,'_')));

      const idx = k => headers.indexOf(k);
      const get = (row, k) => {
        const i = idx(k);
        return i >= 0 ? (parseFloat(row.getCell(i+1).value) || 0) : 0;
      };
      const getStr = (row, k) => {
        const i = idx(k);
        return i >= 0 ? String(row.getCell(i+1).value || '').trim() : '';
      };

      let importados = 0, erros = [];
      const upd = req.db.prepare(`
        UPDATE rh_folha_itens SET
          dias_trabalhados=?,horas_extras=?,valor_he=?,adicional_noturno=?,
          vale_transporte=?,vale_alimentacao=?,outros_proventos=?,outros_descontos=?,
          inss=?,irrf=?,total_bruto=?,total_descontos=?,total_liquido=?
        WHERE folha_id=? AND funcionario_id=?
      `);

      const processar = req.db.transaction(() => {
        ws.eachRow((row, rowNum) => {
          if (rowNum === 1) return; // header
          const nome = getStr(row, 'nome');
          if (!nome) return;
          const func = req.db.prepare(`SELECT * FROM rh_funcionarios WHERE LOWER(nome) LIKE LOWER(?)`).get(`%${nome}%`);
          if (!func) { erros.push(`Linha ${rowNum}: funcionário "${nome}" não encontrado`); return; }

          const dias = get(row, 'dias_trabalhados') || 30;
          const he   = get(row, 'horas_extras');
          const calc = calcFolhaItem(func, dias, he);
          const totalBruto = calc.totalBruto + get(row,'adicional_noturno') + get(row,'vale_alimentacao') + get(row,'outros_proventos');
          const totalDesc  = calc.inss + calc.irrf + get(row,'outros_descontos');
          const totalLiq   = totalBruto - totalDesc - get(row,'vale_transporte');
          const r = upd.run(dias, he, calc.valorHE, get(row,'adicional_noturno'),
                    get(row,'vale_transporte'), get(row,'vale_alimentacao'), get(row,'outros_proventos'), get(row,'outros_descontos'),
                    calc.inss, calc.irrf,
                    +totalBruto.toFixed(2), +totalDesc.toFixed(2), +totalLiq.toFixed(2),
                    folha.id, func.id);
          if (r.changes > 0) importados++;
        });
      });
      processar();
      res.json({ ok: true, importados, erros, message: `${importados} funcionário(s) atualizados na folha` });
    } catch(e) {
      res.status(500).json({ erro: e.message });
    }
  });
});

module.exports = router;
