/**
 * Montana Multi-Empresa — Módulo Controle de Ponto e Frequência v2
 * Endpoints montados em /api/ponto
 *
 * Melhorias v2:
 *  - Feriados nacionais fixos + Páscoa/Carnaval/Corpus Christi calculados
 *  - Helper _calcDia() compartilhado (elimina duplicação entre relatorio e export)
 *  - PATCH /:id — edita registro de ponto existente
 *  - POST /importar — importação em lote via Excel (.xlsx)
 *  - GET /espelho-pdf — espelho mensal em PDF (pdfkit)
 *  - DELETE /jornadas/:id — remove jornada personalizada
 *  - PATCH /jornadas/:id — atualiza jornada personalizada
 */
const express = require('express');
const router  = express.Router();
const { getDb } = require('../db');

// ─── Jornada padrão CLT (44h semanais, 8h/dia) ──────────────────────────────
const JORNADA_PADRAO = {
  entrada:             '08:00',
  saida:               '17:00',
  intervalo_minutos:   60,
  horas_dia:           8,
  horas_semana:        44,
  tolerancia_minutos:  10
};

// ─── Feriados Nacionais Fixos (MM-DD) ────────────────────────────────────────
const FERIADOS_FIXOS = new Set([
  '01-01', // Ano Novo
  '04-21', // Tiradentes
  '05-01', // Dia do Trabalhador
  '09-07', // Independência
  '10-12', // N.Sra. Aparecida
  '11-02', // Finados
  '11-15', // Proclamação da República
  '11-20', // Consciência Negra (Lei 14.759/2023)
  '12-25', // Natal
]);

// Algoritmo de Gauss para calcular a Páscoa de um determinado ano
function calcPascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(ano, mes - 1, dia);
}

// Retorna Set com datas ISO (YYYY-MM-DD) de feriados móveis do ano
function feriadosMoveis(ano) {
  const pascoa = calcPascoa(ano);
  const add = (d, dias) => {
    const r = new Date(d);
    r.setDate(r.getDate() + dias);
    return r.toISOString().substring(0, 10);
  };
  return new Set([
    add(pascoa, -48), // Segunda de Carnaval
    add(pascoa, -47), // Terça de Carnaval
    add(pascoa, -2),  // Sexta-feira Santa
    add(pascoa, 0),   // Páscoa (domingo, mas conta p/ extras)
    add(pascoa, 60),  // Corpus Christi
  ]);
}

// Cache simples dos feriados móveis por ano
const _cacheMoveis = {};
function isFeriado(diaStr) {
  const ano = parseInt(diaStr.substring(0, 4));
  if (!_cacheMoveis[ano]) _cacheMoveis[ano] = feriadosMoveis(ano);
  const mmdd = diaStr.substring(5); // MM-DD
  return FERIADOS_FIXOS.has(mmdd) || _cacheMoveis[ano].has(diaStr);
}

// ─── Helper: obtém DB da empresa ativa ──────────────────────────────────────
function db(req) {
  const company = req.headers['x-company'] || 'assessoria';
  return getDb(company);
}

// ─── Helpers de tempo ────────────────────────────────────────────────────────
function minutosParaHora(min) {
  const sinal  = min < 0 ? '-' : '';
  const absMin = Math.abs(Math.round(min));
  const h = Math.floor(absMin / 60);
  const m = absMin % 60;
  return `${sinal}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function horaParaMinutos(str) {
  if (!str || str === '00:00') return 0;
  const sinal = str.startsWith('-') ? -1 : 1;
  const partes = str.replace('-', '').split(':').map(Number);
  return sinal * (partes[0] * 60 + (partes[1] || 0));
}

// Calcula minutos trabalhados em um dia a partir dos registros
function calcMinutosDia(regsdia, jornadaMin) {
  const entrada = regsdia.find(r => r.tipo === 'entrada');
  const saida   = regsdia.find(r => r.tipo === 'saida');
  if (!entrada || !saida) return { minutos: 0, entrada: null, saida: null, intInicio: null, intFim: null };

  const hEntrada   = entrada.data_hora.substring(11, 16);
  const hSaida     = saida.data_hora.substring(11, 16);
  const [he, me]   = hEntrada.split(':').map(Number);
  const [hs, ms]   = hSaida.split(':').map(Number);
  let minutos      = (hs * 60 + ms) - (he * 60 + me);

  const intInicio  = regsdia.find(r => r.tipo === 'intervalo_inicio');
  const intFim     = regsdia.find(r => r.tipo === 'intervalo_fim');
  const hIntInicio = intInicio ? intInicio.data_hora.substring(11, 16) : null;
  const hIntFim    = intFim    ? intFim.data_hora.substring(11, 16)   : null;

  if (hIntInicio && hIntFim) {
    const [hi, mi]   = hIntInicio.split(':').map(Number);
    const [hif, mif] = hIntFim.split(':').map(Number);
    minutos -= ((hif * 60 + mif) - (hi * 60 + mi));
  } else if (minutos > jornadaMin) {
    minutos -= JORNADA_PADRAO.intervalo_minutos;
  }

  return { minutos: Math.max(0, minutos), entrada: hEntrada, saida: hSaida, intInicio: hIntInicio, intFim: hIntFim };
}

/**
 * _calcDia — helper central compartilhado por espelho, relatorio e export
 * Retorna todos os dados calculados de um dia: extras, faltas, atraso, feriado, etc.
 */
function _calcDia(porDia, ocorrencias, diaStr, jornadaMin, jornadaConf, hoje) {
  const dSemana   = new Date(`${diaStr}T12:00:00`).getDay(); // 0=Dom, 6=Sáb
  const fimSemana = (dSemana === 0 || dSemana === 6);
  const feriado   = isFeriado(diaStr);
  const diaUtil   = !fimSemana && !feriado;
  const regsdia   = porDia[diaStr] || [];
  const ocDia     = ocorrencias.find(o =>
    o.date_inicio <= diaStr && (o.date_fim >= diaStr || !o.date_fim)
  ) || null;

  const { minutos, entrada, saida, intInicio, intFim } = calcMinutosDia(regsdia, jornadaMin);
  const temRegistro = !!(regsdia.find(r => r.tipo === 'entrada') && regsdia.find(r => r.tipo === 'saida'));

  // Extras e faltas são mutuamente exclusivos por dia
  const horasExtrasMin   = temRegistro && minutos > jornadaMin ? minutos - jornadaMin : 0;
  const horasFaltMin     = diaUtil && !ocDia && temRegistro && minutos < jornadaMin ? jornadaMin - minutos : 0;
  const contaFalta       = diaUtil && !ocDia && !temRegistro && diaStr <= hoje;

  // Atraso: apenas em dias úteis com entrada registrada
  let temAtraso = false;
  const entReg = regsdia.find(r => r.tipo === 'entrada');
  if (entReg && diaUtil) {
    const [hj, mj] = (jornadaConf.entrada || JORNADA_PADRAO.entrada).split(':').map(Number);
    const [he2, me2] = entReg.data_hora.substring(11, 16).split(':').map(Number);
    temAtraso = (he2 * 60 + me2) - (hj * 60 + mj) > (jornadaConf.tolerancia_minutos || JORNADA_PADRAO.tolerancia_minutos);
  }

  // Multiplicador HE: 100% em domingo/feriado, 50% dias úteis
  const multiplicadorHE = (dSemana === 0 || feriado) ? 2.0 : 1.5;

  return {
    dia_semana:        dSemana,
    fim_semana:        fimSemana,
    feriado,
    dia_util:          diaUtil,
    entrada, saida, intInicio, intFim,
    minutos,
    tem_registro:      temRegistro,
    horas_extras_min:  horasExtrasMin,
    horas_falt_min:    contaFalta ? jornadaMin : horasFaltMin,
    conta_falta:       contaFalta,
    tem_atraso:        temAtraso,
    multiplicador_he:  multiplicadorHE,
    ocorrencia:        ocDia,
    qtd_registros:     regsdia.length,
  };
}

// ─── POST /api/ponto/registrar ───────────────────────────────────────────────
router.post('/registrar', (req, res) => {
  try {
    const { funcionario_id, tipo, data_hora, observacao } = req.body;
    if (!funcionario_id || !tipo || !data_hora)
      return res.status(400).json({ error: 'Campos obrigatórios: funcionario_id, tipo, data_hora' });
    const tiposValidos = ['entrada', 'saida', 'intervalo_inicio', 'intervalo_fim'];
    if (!tiposValidos.includes(tipo))
      return res.status(400).json({ error: `Tipo inválido. Use: ${tiposValidos.join(', ')}` });
    const d = db(req);
    const result = d.prepare(`
      INSERT INTO ponto_registros (funcionario_id, tipo, data_hora, observacao)
      VALUES (?, ?, ?, ?)
    `).run(Number(funcionario_id), tipo, data_hora, observacao || '');
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PATCH /api/ponto/:id — Edita registro de ponto ─────────────────────────
router.patch('/:id([0-9]+)', (req, res) => {
  try {
    const { tipo, data_hora, observacao } = req.body;
    const d = db(req);
    const reg = d.prepare('SELECT * FROM ponto_registros WHERE id = ?').get(Number(req.params.id));
    if (!reg) return res.status(404).json({ error: 'Registro não encontrado' });
    const campos = [];
    const vals   = [];
    if (tipo)      { campos.push('tipo = ?');      vals.push(tipo); }
    if (data_hora) { campos.push('data_hora = ?'); vals.push(data_hora); }
    if (observacao !== undefined) { campos.push('observacao = ?'); vals.push(observacao); }
    if (campos.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    vals.push(Number(req.params.id));
    d.prepare(`UPDATE ponto_registros SET ${campos.join(', ')} WHERE id = ?`).run(...vals);
    // Auditoria
    const usuario = req.user?.login || 'anon';
    const ip = req.ip || '';
    try {
      d.prepare(`INSERT INTO audit_log (usuario,acao,tabela,registro_id,detalhe,ip) VALUES (?,?,?,?,?,?)`)
       .run(usuario, 'EDITAR', 'ponto_registros', String(req.params.id),
            `Anterior: tipo=${reg.tipo} data_hora=${reg.data_hora}`, ip);
    } catch(_) {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/ponto ──────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const { funcionario_id, from, to, data } = req.query;
    const d = db(req);
    let sql = `
      SELECT r.*, f.nome AS funcionario_nome, f.lotacao, f.contrato_ref,
             c.nome AS cargo_nome
      FROM ponto_registros r
      LEFT JOIN rh_funcionarios f ON f.id = r.funcionario_id
      LEFT JOIN rh_cargos c ON c.id = f.cargo_id
      WHERE 1=1
    `;
    const params = [];
    if (funcionario_id) { sql += ' AND r.funcionario_id = ?'; params.push(Number(funcionario_id)); }
    if (data)  { sql += ' AND date(r.data_hora) = ?'; params.push(data); }
    if (from)  { sql += ' AND date(r.data_hora) >= ?'; params.push(from); }
    if (to)    { sql += ' AND date(r.data_hora) <= ?'; params.push(to); }
    sql += ' ORDER BY r.data_hora DESC LIMIT 2000';
    res.json({ ok: true, data: d.prepare(sql).all(...params) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/ponto/espelho ──────────────────────────────────────────────────
router.get('/espelho', (req, res) => {
  try {
    const { funcionario_id, mes } = req.query;
    if (!funcionario_id || !mes)
      return res.status(400).json({ error: 'Parâmetros obrigatórios: funcionario_id, mes (YYYY-MM)' });

    const d = db(req);
    const [anoStr, mesStr] = mes.split('-');
    const ano      = parseInt(anoStr);
    const mesNum   = parseInt(mesStr);
    const from     = `${mes}-01`;
    const lastDay  = new Date(ano, mesNum, 0).getDate();
    const to       = `${mes}-${String(lastDay).padStart(2, '0')}`;
    const hoje     = new Date().toISOString().substring(0, 10);

    const jornada    = d.prepare(`SELECT * FROM ponto_jornadas WHERE funcionario_id = ? LIMIT 1`).get(Number(funcionario_id)) || JORNADA_PADRAO;
    const jornadaMin = (jornada.horas_dia || 8) * 60;

    const func = d.prepare(`
      SELECT f.*, c.nome AS cargo_nome FROM rh_funcionarios f
      LEFT JOIN rh_cargos c ON c.id = f.cargo_id WHERE f.id = ?
    `).get(Number(funcionario_id));

    const registros = d.prepare(`
      SELECT * FROM ponto_registros
      WHERE funcionario_id = ? AND date(data_hora) >= ? AND date(data_hora) <= ?
      ORDER BY data_hora ASC
    `).all(Number(funcionario_id), from, to);

    const ocorrencias = d.prepare(`
      SELECT * FROM ponto_ocorrencias
      WHERE funcionario_id = ? AND date_inicio <= ? AND (date_fim >= ? OR date_fim = '' OR date_fim IS NULL)
    `).all(Number(funcionario_id), to, from);

    const porDia = {};
    for (const r of registros) {
      const dia = r.data_hora.substring(0, 10);
      if (!porDia[dia]) porDia[dia] = [];
      porDia[dia].push(r);
    }

    const NOMES_DIA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const diasResultado = [];

    for (let d2 = 1; d2 <= lastDay; d2++) {
      const diaStr = `${mes}-${String(d2).padStart(2, '0')}`;
      const c = _calcDia(porDia, ocorrencias, diaStr, jornadaMin, jornada, hoje);
      diasResultado.push({
        data:                diaStr,
        dia_semana:          NOMES_DIA[c.dia_semana],
        fim_semana:          c.fim_semana,
        feriado:             c.feriado,
        entrada:             c.entrada,
        saida:               c.saida,
        intervalo_inicio:    c.intInicio,
        intervalo_fim:       c.intFim,
        minutos_trabalhados: c.minutos,
        horas_trabalhadas:   minutosParaHora(c.minutos),
        horas_extras:        minutosParaHora(c.horas_extras_min),
        horas_faltantes:     minutosParaHora(c.horas_falt_min),
        multiplicador_he:    c.multiplicador_he,
        tem_atraso:          c.tem_atraso,
        ocorrencia:          c.ocorrencia ? { tipo: c.ocorrencia.tipo, observacao: c.ocorrencia.observacao } : null,
        qtd_registros:       c.qtd_registros,
      });
    }

    const totMinTrab  = diasResultado.reduce((s, d) => s + d.minutos_trabalhados, 0);
    const totMinExtra = diasResultado.reduce((s, d) => s + horaParaMinutos(d.horas_extras), 0);
    const totMinFalt  = diasResultado.reduce((s, d) => s + horaParaMinutos(d.horas_faltantes), 0);
    const diasTrab    = diasResultado.filter(d => d.minutos_trabalhados > 0).length;
    const diasFalta   = diasResultado.filter(d => !d.fim_semana && !d.feriado && !d.ocorrencia && d.minutos_trabalhados === 0 && d.data <= hoje).length;
    const atrasos     = diasResultado.filter(d => d.tem_atraso).length;

    res.json({
      ok: true, funcionario: func, jornada, mes,
      dias: diasResultado,
      resumo: {
        dias_trabalhados:      diasTrab,
        dias_falta:            diasFalta,
        atrasos,
        total_trabalhado:      minutosParaHora(totMinTrab),
        total_horas_extras:    minutosParaHora(totMinExtra),
        total_horas_faltantes: minutosParaHora(totMinFalt),
        banco_horas:           minutosParaHora(totMinExtra - totMinFalt),
        ocorrencias:           ocorrencias.length,
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/ponto/espelho-pdf ──────────────────────────────────────────────
router.get('/espelho-pdf', async (req, res) => {
  try {
    const { funcionario_id, mes } = req.query;
    if (!funcionario_id || !mes)
      return res.status(400).json({ error: 'Parâmetros obrigatórios: funcionario_id, mes' });

    const d = db(req);
    const [anoStr, mesStr] = mes.split('-');
    const ano     = parseInt(anoStr);
    const mesNum  = parseInt(mesStr);
    const from    = `${mes}-01`;
    const lastDay = new Date(ano, mesNum, 0).getDate();
    const to      = `${mes}-${String(lastDay).padStart(2, '0')}`;
    const hoje    = new Date().toISOString().substring(0, 10);

    const jornada    = d.prepare(`SELECT * FROM ponto_jornadas WHERE funcionario_id = ? LIMIT 1`).get(Number(funcionario_id)) || JORNADA_PADRAO;
    const jornadaMin = (jornada.horas_dia || 8) * 60;

    const func = d.prepare(`
      SELECT f.*, c.nome AS cargo_nome FROM rh_funcionarios f
      LEFT JOIN rh_cargos c ON c.id = f.cargo_id WHERE f.id = ?
    `).get(Number(funcionario_id));
    if (!func) return res.status(404).json({ error: 'Funcionário não encontrado' });

    const registros = d.prepare(`
      SELECT * FROM ponto_registros
      WHERE funcionario_id = ? AND date(data_hora) >= ? AND date(data_hora) <= ?
      ORDER BY data_hora ASC
    `).all(Number(funcionario_id), from, to);

    const ocorrencias = d.prepare(`
      SELECT * FROM ponto_ocorrencias
      WHERE funcionario_id = ? AND date_inicio <= ? AND (date_fim >= ? OR date_fim = '' OR date_fim IS NULL)
    `).all(Number(funcionario_id), to, from);

    const porDia = {};
    for (const r of registros) {
      const dia = r.data_hora.substring(0, 10);
      if (!porDia[dia]) porDia[dia] = [];
      porDia[dia].push(r);
    }

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: 'A4', margin: 36, info: { Title: `Espelho Ponto ${func.nome} ${mes}` } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="espelho_${func.nome.replace(/\s+/g, '_')}_${mes}.pdf"`);
    doc.pipe(res);

    // Cabeçalho
    doc.rect(36, 36, 523, 52).fill('#1e293b');
    doc.fillColor('#ffffff').fontSize(14).font('Helvetica-Bold')
       .text('ESPELHO DE PONTO', 46, 46);
    doc.fontSize(10).font('Helvetica')
       .text(`${func.nome}  |  ${func.cargo_nome || ''}  |  ${mes}`, 46, 64);
    doc.fillColor('#000000').moveDown(3.2);

    // Info funcionário
    doc.fontSize(9).font('Helvetica')
       .text(`Lotação: ${func.lotacao || '—'}   |   Jornada: ${jornada.entrada || '08:00'}–${jornada.saida || '17:00'} (${jornada.horas_dia || 8}h/dia)`, { continued: false });
    doc.moveDown(0.5);

    // Tabela
    const COL = [36, 62, 90, 130, 170, 210, 250, 296, 342, 390];
    const HEADERS = ['Data', 'Dia', 'Entrada', 'Int.In', 'Int.Fim', 'Saída', 'Trabalhado', 'Extras', 'Faltas', 'Ocorrência'];
    const NOMES_DIA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

    // Cabeçalho da tabela
    let y = doc.y;
    doc.rect(36, y, 523, 14).fill('#334155');
    doc.fillColor('#ffffff').fontSize(7).font('Helvetica-Bold');
    HEADERS.forEach((h, i) => doc.text(h, COL[i], y + 3, { width: (COL[i + 1] || 559) - COL[i] - 2 }));
    y += 14;

    doc.fillColor('#000000').font('Helvetica').fontSize(7);
    let totExtraMin = 0, totFaltMin = 0, totTrabMin = 0, diasTrab = 0, diasFalta = 0;

    for (let d2 = 1; d2 <= lastDay; d2++) {
      const diaStr = `${mes}-${String(d2).padStart(2, '0')}`;
      const c      = _calcDia(porDia, ocorrencias, diaStr, jornadaMin, jornada, hoje);
      const [, , dd] = diaStr.split('-');

      totTrabMin  += c.minutos;
      totExtraMin += c.horas_extras_min;
      totFaltMin  += c.horas_falt_min;
      if (c.tem_registro) diasTrab++;
      if (c.conta_falta)  diasFalta++;

      const bg = c.fim_semana || c.feriado ? '#f8fafc' : (c.ocorrencia ? '#fef3c7' : (d2 % 2 === 0 ? '#f1f5f9' : '#ffffff'));
      doc.rect(36, y, 523, 12).fill(bg);
      const cor = c.fim_semana || c.feriado ? '#94a3b8' : '#000000';
      doc.fillColor(cor);
      const hora = v => v || '—';
      const vals = [
        `${dd}/${mesStr}`, NOMES_DIA[c.dia_semana],
        hora(c.entrada), hora(c.intInicio), hora(c.intFim), hora(c.saida),
        c.minutos > 0 ? minutosParaHora(c.minutos) : '—',
        c.horas_extras_min > 0 ? minutosParaHora(c.horas_extras_min) : '—',
        c.horas_falt_min > 0   ? minutosParaHora(c.horas_falt_min)   : '—',
        c.ocorrencia ? c.ocorrencia.tipo.replace('_', ' ') : (c.feriado ? 'Feriado' : ''),
      ];
      vals.forEach((v, i) => doc.text(v, COL[i], y + 2, { width: (COL[i + 1] || 559) - COL[i] - 2 }));
      y += 12;

      // Nova página se necessário
      if (y > 760) {
        doc.addPage();
        y = 36;
      }
    }

    // Totais
    y += 4;
    doc.rect(36, y, 523, 14).fill('#1e293b');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
    const sumVals = [
      `${diasTrab} trabalhados`, `${diasFalta} faltas`, '', '', '', '',
      minutosParaHora(totTrabMin), minutosParaHora(totExtraMin), minutosParaHora(totFaltMin),
      `Banco: ${minutosParaHora(totExtraMin - totFaltMin)}`
    ];
    sumVals.forEach((v, i) => { if (v) doc.text(v, COL[i], y + 3, { width: (COL[i + 1] || 559) - COL[i] - 2 }); });
    y += 18;

    // Assinatura
    doc.fillColor('#000000').font('Helvetica').fontSize(9);
    doc.moveDown(2);
    doc.text('Declaro que os registros acima correspondem aos horários efetivamente cumpridos.', { align: 'center' });
    doc.moveDown(2);
    doc.text('_______________________________________', { align: 'center' });
    doc.text(func.nome, { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(8).text(`Gerado em: ${new Date().toLocaleString('pt-BR')}`, { align: 'right' });

    doc.end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/ponto/ocorrencias ──────────────────────────────────────────────
router.get('/ocorrencias', (req, res) => {
  try {
    const { funcionario_id, from, to } = req.query;
    const d = db(req);
    let sql = `
      SELECT o.*, f.nome AS funcionario_nome
      FROM ponto_ocorrencias o
      LEFT JOIN rh_funcionarios f ON f.id = o.funcionario_id WHERE 1=1
    `;
    const params = [];
    if (funcionario_id) { sql += ' AND o.funcionario_id = ?'; params.push(Number(funcionario_id)); }
    if (from) { sql += ' AND o.date_inicio >= ?'; params.push(from); }
    if (to)   { sql += ' AND o.date_inicio <= ?'; params.push(to); }
    sql += ' ORDER BY o.date_inicio DESC';
    res.json({ ok: true, data: d.prepare(sql).all(...params) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/ponto/ocorrencias ─────────────────────────────────────────────
router.post('/ocorrencias', (req, res) => {
  try {
    const { funcionario_id, tipo, date_inicio, date_fim, observacao } = req.body;
    if (!funcionario_id || !tipo || !date_inicio)
      return res.status(400).json({ error: 'Campos obrigatórios: funcionario_id, tipo, date_inicio' });
    const d = db(req);
    const result = d.prepare(`
      INSERT INTO ponto_ocorrencias (funcionario_id, tipo, date_inicio, date_fim, observacao)
      VALUES (?, ?, ?, ?, ?)
    `).run(Number(funcionario_id), tipo, date_inicio, date_fim || '', observacao || '');
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PATCH /api/ponto/ocorrencias/:id/aprovar — Aprova/reprova ocorrência ────
router.patch('/ocorrencias/:id/aprovar', (req, res) => {
  try {
    const d = db(req);
    const oc = d.prepare('SELECT id, aprovado FROM ponto_ocorrencias WHERE id = ?').get(Number(req.params.id));
    if (!oc) return res.status(404).json({ error: 'Ocorrência não encontrada' });
    const novoStatus = oc.aprovado ? 0 : 1;
    d.prepare('UPDATE ponto_ocorrencias SET aprovado = ? WHERE id = ?').run(novoStatus, Number(req.params.id));
    res.json({ ok: true, aprovado: novoStatus });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /api/ponto/ocorrencias/:id ───────────────────────────────────────
router.delete('/ocorrencias/:id', (req, res) => {
  try {
    db(req).prepare('DELETE FROM ponto_ocorrencias WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/ponto/relatorio-frequencia ─────────────────────────────────────
router.get('/relatorio-frequencia', (req, res) => {
  try {
    const { mes } = req.query;
    const d = db(req);
    const mesAtual  = mes || new Date().toISOString().substring(0, 7);
    const [anoStr, mesStr] = mesAtual.split('-');
    const ano       = parseInt(anoStr);
    const mesNum    = parseInt(mesStr);
    const from      = `${mesAtual}-01`;
    const lastDay   = new Date(ano, mesNum, 0).getDate();
    const to        = `${mesAtual}-${String(lastDay).padStart(2, '0')}`;
    const hoje      = new Date().toISOString().substring(0, 10);
    const jornadaMin = JORNADA_PADRAO.horas_dia * 60;

    const funcionarios = d.prepare(`
      SELECT f.id, f.nome, f.cargo_id, f.contrato_ref, f.lotacao, f.status,
             c.nome AS cargo_nome
      FROM rh_funcionarios f LEFT JOIN rh_cargos c ON c.id = f.cargo_id
      WHERE f.status = 'ATIVO' ORDER BY f.nome
    `).all();

    const resultado = funcionarios.map(func => {
      const jornada = d.prepare(`SELECT * FROM ponto_jornadas WHERE funcionario_id = ? LIMIT 1`).get(func.id) || JORNADA_PADRAO;
      const jornadaMinFunc = (jornada.horas_dia || 8) * 60;

      const registros = d.prepare(`
        SELECT date(data_hora) AS dia, tipo, data_hora
        FROM ponto_registros
        WHERE funcionario_id = ? AND date(data_hora) >= ? AND date(data_hora) <= ?
        ORDER BY data_hora ASC
      `).all(func.id, from, to);

      const ocorrencias = d.prepare(`
        SELECT tipo, date_inicio, date_fim FROM ponto_ocorrencias
        WHERE funcionario_id = ? AND date_inicio <= ? AND (date_fim >= ? OR date_fim = '' OR date_fim IS NULL)
      `).all(func.id, to, from);

      const porDia = {};
      for (const r of registros) {
        if (!porDia[r.dia]) porDia[r.dia] = [];
        porDia[r.dia].push(r);
      }

      let diasUteis = 0, diasTrab = 0, diasFalta = 0;
      let mExtra = 0, mFalt = 0, atrasos = 0;

      for (let d2 = 1; d2 <= lastDay; d2++) {
        const diaStr = `${mesAtual}-${String(d2).padStart(2, '0')}`;
        const c = _calcDia(porDia, ocorrencias, diaStr, jornadaMinFunc, jornada, hoje);
        if (!c.dia_util) continue;
        diasUteis++;
        if (c.tem_registro) { diasTrab++; mExtra += c.horas_extras_min; mFalt += c.horas_falt_min; }
        else if (c.conta_falta) { diasFalta++; mFalt += jornadaMinFunc; }
        if (c.tem_atraso) atrasos++;
      }

      return {
        funcionario_id:   func.id,
        nome:             func.nome,
        cargo:            func.cargo_nome || '',
        contrato_ref:     func.contrato_ref || '',
        lotacao:          func.lotacao || '',
        dias_uteis:       diasUteis,
        dias_trabalhados: diasTrab,
        dias_falta:       diasFalta,
        atrasos,
        horas_extras:     minutosParaHora(mExtra),
        horas_faltantes:  minutosParaHora(mFalt),
        banco_horas:      minutosParaHora(mExtra - mFalt),
        ocorrencias:      ocorrencias.length,
      };
    });

    res.json({ ok: true, mes: mesAtual, data: resultado });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/ponto/importar — Importação em lote via Excel ─────────────────
router.post('/importar', async (req, res) => {
  try {
    const multer  = require('multer');
    const ExcelJS = require('exceljs');
    const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

    // Middleware multer inline
    await new Promise((resolve, reject) => {
      upload.single('file')(req, res, err => err ? reject(err) : resolve());
    });

    if (!req.file) return res.status(400).json({ error: 'Arquivo .xlsx não enviado' });

    const d = db(req);
    const funcionarios = d.prepare(`SELECT id, nome FROM rh_funcionarios WHERE status='ATIVO'`).all();
    const funcMap = {};
    funcionarios.forEach(f => { funcMap[f.nome.toLowerCase().trim()] = f.id; funcMap[String(f.id)] = f.id; });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const ws = workbook.worksheets[0];

    // Auto-detecta cabeçalho
    const colMap = {};
    const headerRow = ws.getRow(1);
    headerRow.eachCell((cell, col) => {
      const v = String(cell.value || '').toLowerCase().trim();
      if (v.includes('funcionario') || v.includes('funcionário') || v.includes('nome')) colMap.func = col;
      if (v === 'data') colMap.data = col;
      if (v.includes('entrada')) colMap.entrada = col;
      if (v.includes('saida') || v.includes('saída')) colMap.saida = col;
      if (v.includes('int') && v.includes('inic')) colMap.intInicio = col;
      if (v.includes('int') && (v.includes('fim') || v.includes('ret'))) colMap.intFim = col;
      if (v.includes('obs')) colMap.obs = col;
    });

    if (!colMap.func || !colMap.data || !colMap.entrada)
      return res.status(400).json({ error: 'Planilha deve ter colunas: Funcionário, Data, Entrada. Saída é opcional.' });

    let inseridos = 0, duplicados = 0, erros = [];
    const inserir = d.prepare(`INSERT OR IGNORE INTO ponto_registros (funcionario_id, tipo, data_hora, observacao) VALUES (?,?,?,?)`);
    const insert = d.transaction(rows => {
      rows.forEach(r => {
        const result = inserir.run(r.fid, r.tipo, r.dh, r.obs);
        if (result.changes > 0) inseridos++;
        else duplicados++;
      });
    });
    const lote = [];

    ws.eachRow((row, rn) => {
      if (rn === 1) return; // pula cabeçalho
      const funcVal  = String(row.getCell(colMap.func).value || '').trim();
      const dataVal  = row.getCell(colMap.data).value;
      const entVal   = String(row.getCell(colMap.entrada).value || '').trim();
      const saiVal   = colMap.saida   ? String(row.getCell(colMap.saida).value   || '').trim() : '';
      const intIVal  = colMap.intInicio ? String(row.getCell(colMap.intInicio).value || '').trim() : '';
      const intFVal  = colMap.intFim  ? String(row.getCell(colMap.intFim).value  || '').trim() : '';
      const obsVal   = colMap.obs     ? String(row.getCell(colMap.obs).value     || '').trim() : '';

      // Resolve funcionario_id
      const fid = funcMap[funcVal.toLowerCase()] || funcMap[funcVal];
      if (!fid) { erros.push(`Linha ${rn}: funcionário "${funcVal}" não encontrado`); return; }

      // Normaliza data
      let dataStr = '';
      if (dataVal instanceof Date) {
        dataStr = dataVal.toISOString().substring(0, 10);
      } else if (typeof dataVal === 'string') {
        // aceita DD/MM/YYYY ou YYYY-MM-DD
        if (/^\d{2}\/\d{2}\/\d{4}$/.test(dataVal)) {
          const [dd, mm, yyyy] = dataVal.split('/');
          dataStr = `${yyyy}-${mm}-${dd}`;
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(dataVal)) {
          dataStr = dataVal;
        }
      }
      if (!dataStr) { erros.push(`Linha ${rn}: data inválida "${dataVal}"`); return; }

      // Normaliza hora HH:MM
      const normH = h => {
        if (!h) return '';
        const m = h.match(/(\d{1,2})[:\h](\d{2})/);
        return m ? `${m[1].padStart(2,'0')}:${m[2]}` : '';
      };

      if (normH(entVal))  lote.push({ fid, tipo: 'entrada',          dh: `${dataStr}T${normH(entVal)}`,  obs: obsVal });
      if (normH(saiVal))  lote.push({ fid, tipo: 'saida',            dh: `${dataStr}T${normH(saiVal)}`,  obs: obsVal });
      if (normH(intIVal)) lote.push({ fid, tipo: 'intervalo_inicio', dh: `${dataStr}T${normH(intIVal)}`, obs: '' });
      if (normH(intFVal)) lote.push({ fid, tipo: 'intervalo_fim',    dh: `${dataStr}T${normH(intFVal)}`, obs: '' });
    });

    if (lote.length > 0) insert(lote);
    res.json({ ok: true, inseridos, duplicados, erros });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/ponto/export — Excel ───────────────────────────────────────────
router.get('/export', async (req, res) => {
  try {
    const { mes } = req.query;
    const d = db(req);
    const mesAtual  = mes || new Date().toISOString().substring(0, 7);
    const [anoStr, mesStr] = mesAtual.split('-');
    const ano       = parseInt(anoStr);
    const mesNum    = parseInt(mesStr);
    const from      = `${mesAtual}-01`;
    const lastDay   = new Date(ano, mesNum, 0).getDate();
    const to        = `${mesAtual}-${String(lastDay).padStart(2, '0')}`;
    const hoje      = new Date().toISOString().substring(0, 10);

    const ExcelJS  = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Montana Sistema';
    workbook.created = new Date();

    // ── Aba 1: Resumo ──────────────────────────────────────────────────────────
    const wsR = workbook.addWorksheet('Resumo Mensal');
    wsR.columns = [
      { header: 'Funcionário',      key: 'nome',             width: 30 },
      { header: 'Cargo',            key: 'cargo',            width: 20 },
      { header: 'Lotação',          key: 'lotacao',          width: 25 },
      { header: 'Dias Úteis',       key: 'dias_uteis',       width: 12 },
      { header: 'Trabalhados',      key: 'dias_trabalhados', width: 14 },
      { header: 'Faltas',           key: 'dias_falta',       width: 10 },
      { header: 'Atrasos',          key: 'atrasos',          width: 10 },
      { header: 'H. Extras',        key: 'horas_extras',     width: 12 },
      { header: 'H. Faltantes',     key: 'horas_faltantes',  width: 14 },
      { header: 'Banco de Horas',   key: 'banco_horas',      width: 14 },
      { header: 'Ocorrências',      key: 'ocorrencias',      width: 12 },
    ];
    const h1 = wsR.getRow(1);
    h1.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    h1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };

    const funcionarios = d.prepare(`
      SELECT f.id, f.nome, f.contrato_ref, f.lotacao, c.nome AS cargo_nome
      FROM rh_funcionarios f LEFT JOIN rh_cargos c ON c.id = f.cargo_id
      WHERE f.status='ATIVO' ORDER BY f.nome
    `).all();

    for (const func of funcionarios) {
      const jornada = d.prepare(`SELECT * FROM ponto_jornadas WHERE funcionario_id = ? LIMIT 1`).get(func.id) || JORNADA_PADRAO;
      const jornadaMinFunc = (jornada.horas_dia || 8) * 60;
      const registros   = d.prepare(`SELECT date(data_hora) AS dia,tipo,data_hora FROM ponto_registros WHERE funcionario_id=? AND date(data_hora)>=? AND date(data_hora)<=? ORDER BY data_hora ASC`).all(func.id, from, to);
      const ocorrencias = d.prepare(`SELECT tipo,date_inicio,date_fim FROM ponto_ocorrencias WHERE funcionario_id=? AND date_inicio<=? AND (date_fim>=? OR date_fim='' OR date_fim IS NULL)`).all(func.id, to, from);
      const porDia = {};
      for (const r of registros) { if (!porDia[r.dia]) porDia[r.dia]=[]; porDia[r.dia].push(r); }
      let diasUteis=0,diasTrab=0,diasFalta=0,mExtra=0,mFalt=0,atrasos=0;
      for (let d2=1; d2<=lastDay; d2++) {
        const diaStr = `${mesAtual}-${String(d2).padStart(2,'0')}`;
        const c = _calcDia(porDia, ocorrencias, diaStr, jornadaMinFunc, jornada, hoje);
        if (!c.dia_util) continue;
        diasUteis++;
        if (c.tem_registro) { diasTrab++; mExtra+=c.horas_extras_min; mFalt+=c.horas_falt_min; }
        else if (c.conta_falta) { diasFalta++; mFalt+=jornadaMinFunc; }
        if (c.tem_atraso) atrasos++;
      }
      wsR.addRow({ nome: func.nome, cargo: func.cargo_nome||'', lotacao: func.lotacao||'', dias_uteis: diasUteis, dias_trabalhados: diasTrab, dias_falta: diasFalta, atrasos, horas_extras: minutosParaHora(mExtra), horas_faltantes: minutosParaHora(mFalt), banco_horas: minutosParaHora(mExtra-mFalt), ocorrencias: ocorrencias.length });
    }

    // ── Aba 2: Registros ───────────────────────────────────────────────────────
    const NOMES_DIA = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
    const wsReg = workbook.addWorksheet('Registros Detalhados');
    wsReg.columns = [
      {header:'Funcionário',key:'nome',width:30},{header:'Data',key:'data',width:13},
      {header:'Dia Semana',key:'dsem',width:12},{header:'Feriado',key:'fer',width:10},
      {header:'Tipo',key:'tipo',width:18},{header:'Hora',key:'hora',width:10},{header:'Observação',key:'obs',width:30},
    ];
    const h2 = wsReg.getRow(1);
    h2.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    h2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    const todosReg = d.prepare(`SELECT r.*,f.nome AS func_nome FROM ponto_registros r LEFT JOIN rh_funcionarios f ON f.id=r.funcionario_id WHERE date(r.data_hora)>=? AND date(r.data_hora)<=? ORDER BY r.data_hora ASC`).all(from,to);
    for (const r of todosReg) {
      const ds = r.data_hora.substring(0,10);
      wsReg.addRow({ nome:r.func_nome||'', data:ds, dsem:NOMES_DIA[new Date(`${ds}T12:00:00`).getDay()], fer:isFeriado(ds)?'Sim':'', tipo:r.tipo, hora:r.data_hora.substring(11,16), obs:r.observacao||'' });
    }

    // ── Aba 3: Ocorrências ─────────────────────────────────────────────────────
    const wsOc = workbook.addWorksheet('Ocorrências');
    wsOc.columns = [
      {header:'Funcionário',key:'nome',width:30},{header:'Tipo',key:'tipo',width:20},
      {header:'Data Início',key:'inicio',width:13},{header:'Data Fim',key:'fim',width:13},
      {header:'Observação',key:'obs',width:40},{header:'Aprovado',key:'aprov',width:10},
    ];
    const h3 = wsOc.getRow(1);
    h3.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    h3.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    const todasOc = d.prepare(`SELECT o.*,f.nome AS func_nome FROM ponto_ocorrencias o LEFT JOIN rh_funcionarios f ON f.id=o.funcionario_id WHERE o.date_inicio>=? AND o.date_inicio<=? ORDER BY o.date_inicio ASC`).all(from,to);
    for (const o of todasOc) wsOc.addRow({ nome:o.func_nome||'', tipo:o.tipo, inicio:o.date_inicio, fim:o.date_fim||'', obs:o.observacao||'', aprov:o.aprovado?'Sim':'Não' });

    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="frequencia_${mesAtual}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/ponto/jornadas ─────────────────────────────────────────────────
router.get('/jornadas', (req, res) => {
  try {
    const rows = db(req).prepare(`
      SELECT j.*, f.nome AS funcionario_nome, c.nome AS cargo_nome
      FROM ponto_jornadas j
      LEFT JOIN rh_funcionarios f ON f.id = j.funcionario_id
      LEFT JOIN rh_cargos c ON c.id = j.cargo_id
    `).all();
    res.json({ ok: true, data: rows, padrao: JORNADA_PADRAO });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/ponto/jornadas ────────────────────────────────────────────────
router.post('/jornadas', (req, res) => {
  try {
    const { funcionario_id, cargo_id, entrada, saida, intervalo_minutos, dias_semana, horas_dia, horas_semana } = req.body;
    const result = db(req).prepare(`
      INSERT INTO ponto_jornadas (funcionario_id,cargo_id,entrada,saida,intervalo_minutos,dias_semana,horas_dia,horas_semana)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(funcionario_id||null, cargo_id||null, entrada||'08:00', saida||'17:00', intervalo_minutos||60, dias_semana||'seg,ter,qua,qui,sex', horas_dia||8, horas_semana||44);
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PATCH /api/ponto/jornadas/:id ───────────────────────────────────────────
router.patch('/jornadas/:id', (req, res) => {
  try {
    const { entrada, saida, intervalo_minutos, dias_semana, horas_dia, horas_semana } = req.body;
    db(req).prepare(`
      UPDATE ponto_jornadas SET entrada=?,saida=?,intervalo_minutos=?,dias_semana=?,horas_dia=?,horas_semana=? WHERE id=?
    `).run(entrada||'08:00', saida||'17:00', intervalo_minutos||60, dias_semana||'seg,ter,qua,qui,sex', horas_dia||8, horas_semana||44, Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /api/ponto/jornadas/:id ──────────────────────────────────────────
router.delete('/jornadas/:id', (req, res) => {
  try {
    db(req).prepare('DELETE FROM ponto_jornadas WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /api/ponto/:id ───────────────────────────────────────────────────
router.delete('/:id([0-9]+)', (req, res) => {
  try {
    const d = db(req);
    const reg = d.prepare('SELECT * FROM ponto_registros WHERE id = ?').get(Number(req.params.id));
    if (reg) {
      d.prepare('DELETE FROM ponto_registros WHERE id = ?').run(Number(req.params.id));
      // Auditoria
      const usuario = req.user?.login || 'anon';
      const ip = req.ip || '';
      try {
        d.prepare(`INSERT INTO audit_log (usuario,acao,tabela,registro_id,detalhe,ip) VALUES (?,?,?,?,?,?)`)
         .run(usuario, 'EXCLUIR', 'ponto_registros', String(req.params.id),
              `tipo=${reg.tipo} data_hora=${reg.data_hora} func_id=${reg.funcionario_id}`, ip);
      } catch(_) {}
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/ponto/export-folha — Exportação para Alterdata / Domínio ────────
// ?mes=YYYY-MM  &formato=alterdata|dominio|excel
router.get('/export-folha', async (req, res) => {
  try {
    const { mes, formato = 'alterdata' } = req.query;
    const d = db(req);
    const mesAtual  = mes || new Date().toISOString().substring(0, 7);
    const [anoStr, mesStr] = mesAtual.split('-');
    const ano    = parseInt(anoStr);
    const mesNum = parseInt(mesStr);
    const from   = `${mesAtual}-01`;
    const lastDay = new Date(ano, mesNum, 0).getDate();
    const to     = `${mesAtual}-${String(lastDay).padStart(2, '0')}`;
    const hoje   = new Date().toISOString().substring(0, 10);

    const funcionarios = d.prepare(`
      SELECT f.id, f.nome, f.matricula, f.cpf, f.salario_base, f.lotacao, c.nome AS cargo_nome
      FROM rh_funcionarios f LEFT JOIN rh_cargos c ON c.id = f.cargo_id
      WHERE f.status = 'ATIVO' ORDER BY f.nome
    `).all();

    // Calcula métricas do ponto para cada funcionário
    const dados = funcionarios.map(func => {
      const mat = func.matricula || String(func.id).padStart(6, '0');
      const jornada = d.prepare(`SELECT * FROM ponto_jornadas WHERE funcionario_id = ? LIMIT 1`).get(func.id) || JORNADA_PADRAO;
      const jornadaMin = (jornada.horas_dia || 8) * 60;
      const registros = d.prepare(`
        SELECT date(data_hora) AS dia, tipo, data_hora FROM ponto_registros
        WHERE funcionario_id = ? AND date(data_hora) >= ? AND date(data_hora) <= ?
        ORDER BY data_hora ASC
      `).all(func.id, from, to);
      const ocorrencias = d.prepare(`
        SELECT tipo, date_inicio, date_fim FROM ponto_ocorrencias
        WHERE funcionario_id = ? AND date_inicio <= ? AND (date_fim >= ? OR date_fim = '' OR date_fim IS NULL)
      `).all(func.id, to, from);
      const porDia = {};
      for (const r of registros) { if (!porDia[r.dia]) porDia[r.dia]=[]; porDia[r.dia].push(r); }

      let diasUteis=0, diasTrab=0, diasFalta=0, mExtra50=0, mExtra100=0, mFalt=0, mAtraso=0;
      for (let d2=1; d2<=lastDay; d2++) {
        const diaStr = `${mesAtual}-${String(d2).padStart(2,'0')}`;
        const c = _calcDia(porDia, ocorrencias, diaStr, jornadaMin, jornada, hoje);
        if (!c.dia_util) continue;
        diasUteis++;
        const dow = new Date(`${diaStr}T12:00:00`).getDay();
        const feriado = isFeriado(diaStr);
        if (c.tem_registro) {
          diasTrab++;
          const he = c.horas_extras_min;
          // Domingo/feriado = 100%, outros = 50%
          if (dow === 0 || feriado) mExtra100 += he;
          else mExtra50 += he;
          mFalt += c.horas_falt_min;
          if (c.tem_atraso) mAtraso += (c.minutos_trabalhados > 0 ? Math.max(jornadaMin - c.minutos_trabalhados, 0) : 0);
        } else if (c.conta_falta) {
          diasFalta++;
          mFalt += jornadaMin;
        }
      }
      return {
        matricula: mat,
        nome: func.nome,
        cpf: func.cpf || '',
        cargo: func.cargo_nome || '',
        lotacao: func.lotacao || '',
        salario_base: func.salario_base || 0,
        dias_uteis: diasUteis,
        dias_trabalhados: diasTrab,
        dias_falta: diasFalta,
        horas_extras_50:  minutosParaHora(mExtra50),
        horas_extras_100: minutosParaHora(mExtra100),
        horas_faltantes:  minutosParaHora(mFalt),
        atrasos_min: mAtraso,
        // minutos brutos para cálculos
        _extra50_min:  mExtra50,
        _extra100_min: mExtra100,
        _falt_min: mFalt,
      };
    });

    if (formato === 'alterdata') {
      // Layout Alterdata: CSV com separador ;
      // Matrícula;Nome;CPF;Cargo;Lotação;Salário Base;Dias Úteis;Dias Trab.;Faltas;HE 50%;HE 100%;H.Faltantes;Atrasos(min)
      const linhas = [
        'Matricula;Nome;CPF;Cargo;Lotacao;Salario_Base;Dias_Uteis;Dias_Trabalhados;Dias_Falta;HE_50pct;HE_100pct;Horas_Faltantes;Atrasos_Min',
        ...dados.map(r =>
          `${r.matricula};${r.nome};${r.cpf};${r.cargo};${r.lotacao};${r.salario_base.toFixed(2).replace('.',',')};${r.dias_uteis};${r.dias_trabalhados};${r.dias_falta};${r.horas_extras_50};${r.horas_extras_100};${r.horas_faltantes};${r.atrasos_min}`
        )
      ];
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="alterdata_ponto_${mesAtual}.txt"`);
      return res.send('\uFEFF' + linhas.join('\r\n'));
    }

    if (formato === 'dominio') {
      // Layout Domínio Sistemas — Importação de Eventos por Funcionário
      // CodEmpresa;Matricula;CodEvento;Referencia
      // Eventos: 001=Dias trabalhados, 002=HE 50%, 003=HE 100%, 005=Horas faltantes, 007=Dias falta, 010=Atrasos(min)
      const COD_EMP = '001';
      const linhas = ['CodEmpresa;Matricula;CodEvento;Referencia;Descricao'];
      for (const r of dados) {
        linhas.push(`${COD_EMP};${r.matricula};001;${r.dias_trabalhados};Dias Trabalhados`);
        if (r._extra50_min  > 0) linhas.push(`${COD_EMP};${r.matricula};002;${r.horas_extras_50};Horas Extras 50%`);
        if (r._extra100_min > 0) linhas.push(`${COD_EMP};${r.matricula};003;${r.horas_extras_100};Horas Extras 100%`);
        if (r._falt_min     > 0) linhas.push(`${COD_EMP};${r.matricula};005;${r.horas_faltantes};Horas Faltantes`);
        if (r.dias_falta    > 0) linhas.push(`${COD_EMP};${r.matricula};007;${r.dias_falta};Dias de Falta`);
        if (r.atrasos_min   > 0) linhas.push(`${COD_EMP};${r.matricula};010;${r.atrasos_min};Atrasos em Minutos`);
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="dominio_ponto_${mesAtual}.txt"`);
      return res.send('\uFEFF' + linhas.join('\r\n'));
    }

    // formato=excel — planilha Excel
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Montana Sistema';
    const ws = wb.addWorksheet(`Ponto ${mesAtual}`);
    ws.columns = [
      {header:'Matrícula',key:'matricula',width:12},{header:'Nome',key:'nome',width:30},
      {header:'CPF',key:'cpf',width:16},{header:'Cargo',key:'cargo',width:22},
      {header:'Lotação',key:'lotacao',width:22},{header:'Sal. Base',key:'salario_base',width:14},
      {header:'Dias Úteis',key:'dias_uteis',width:12},{header:'Dias Trab.',key:'dias_trabalhados',width:13},
      {header:'Dias Falta',key:'dias_falta',width:12},{header:'HE 50%',key:'horas_extras_50',width:12},
      {header:'HE 100%',key:'horas_extras_100',width:12},{header:'H. Faltantes',key:'horas_faltantes',width:14},
      {header:'Atrasos (min)',key:'atrasos_min',width:14},
    ];
    const h = ws.getRow(1);
    h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    h.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF1E293B' } };
    dados.forEach(r => ws.addRow(r));
    // Destaque vermelho para quem tem faltas
    ws.eachRow((row, rn) => {
      if (rn === 1) return;
      if (row.getCell('dias_falta').value > 0) row.getCell('dias_falta').font = { color:{argb:'FFDC2626'}, bold:true };
      if (parseFloat(row.getCell('horas_extras_50').value)  > 0) row.getCell('horas_extras_50').font  = { color:{argb:'FF15803D'}, bold:true };
      if (parseFloat(row.getCell('horas_extras_100').value) > 0) row.getCell('horas_extras_100').font = { color:{argb:'FF7C3AED'}, bold:true };
    });
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="folha_ponto_${mesAtual}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/ponto/integrar-folha — Cria itens de folha a partir do ponto ──
// Body: { mes: 'YYYY-MM' }
router.post('/integrar-folha', (req, res) => {
  try {
    const { mes } = req.body;
    if (!mes) return res.status(400).json({ error: 'Parâmetro obrigatório: mes (YYYY-MM)' });
    const d = db(req);
    const [anoStr, mesStr] = mes.split('-');
    const ano    = parseInt(anoStr);
    const mesNum = parseInt(mesStr);
    const from   = `${mes}-01`;
    const lastDay = new Date(ano, mesNum, 0).getDate();
    const to     = `${mes}-${String(lastDay).padStart(2, '0')}`;
    const hoje   = new Date().toISOString().substring(0, 10);

    // Busca ou cria folha do mês
    let folha = d.prepare(`SELECT id FROM rh_folha WHERE competencia = ?`).get(mes);
    if (!folha) {
      const r = d.prepare(`INSERT INTO rh_folha (competencia, status) VALUES (?, 'RASCUNHO')`).run(mes);
      folha = { id: r.lastInsertRowid };
    }

    const funcionarios = d.prepare(`
      SELECT f.id, f.nome, f.salario_base FROM rh_funcionarios f
      WHERE f.status = 'ATIVO' ORDER BY f.nome
    `).all();

    const INSS_ALIQ = 0.14; // 14% simplificado
    const IRRF_ISENTO = 2824.00; // faixa isenta 2025
    let totalBruto = 0, totalDesc = 0, totalLiq = 0;
    let atualizados = 0;

    const upsertItem = d.transaction(() => {
      for (const func of funcionarios) {
        const jornada    = d.prepare(`SELECT * FROM ponto_jornadas WHERE funcionario_id = ? LIMIT 1`).get(func.id) || JORNADA_PADRAO;
        const jornadaMin = (jornada.horas_dia || 8) * 60;
        const registros  = d.prepare(`
          SELECT date(data_hora) AS dia, tipo, data_hora FROM ponto_registros
          WHERE funcionario_id = ? AND date(data_hora) >= ? AND date(data_hora) <= ?
          ORDER BY data_hora ASC
        `).all(func.id, from, to);
        const ocorrencias = d.prepare(`
          SELECT tipo, date_inicio, date_fim FROM ponto_ocorrencias
          WHERE funcionario_id = ? AND date_inicio <= ? AND (date_fim >= ? OR date_fim = '' OR date_fim IS NULL)
        `).all(func.id, to, from);
        const porDia = {};
        for (const r of registros) { if (!porDia[r.dia]) porDia[r.dia]=[]; porDia[r.dia].push(r); }

        let diasTrab=0, diasFalta=0, mExtra50=0, mExtra100=0, mFalt=0;
        for (let d2=1; d2<=lastDay; d2++) {
          const diaStr = `${mes}-${String(d2).padStart(2,'0')}`;
          const c = _calcDia(porDia, ocorrencias, diaStr, jornadaMin, jornada, hoje);
          if (!c.dia_util) continue;
          const dow = new Date(`${diaStr}T12:00:00`).getDay();
          const feriado = isFeriado(diaStr);
          if (c.tem_registro) {
            diasTrab++;
            const he = c.horas_extras_min;
            if (dow === 0 || feriado) mExtra100 += he; else mExtra50 += he;
            mFalt += c.horas_falt_min;
          } else if (c.conta_falta) {
            diasFalta++;
            mFalt += jornadaMin;
          }
        }

        const salDia   = (func.salario_base || 0) / 30;
        const salHora  = (func.salario_base || 0) / 220;
        const valorHe50  = (mExtra50 / 60) * salHora * 1.5;
        const valorHe100 = (mExtra100 / 60) * salHora * 2.0;
        const descFaltas = diasFalta * salDia + (mFalt / 60) * salHora;
        const bruto = (func.salario_base || 0) + valorHe50 + valorHe100;
        const inss  = bruto * INSS_ALIQ;
        const irrf  = bruto > IRRF_ISENTO ? (bruto - inss) * 0.075 : 0; // alíquota simplificada
        const descontos = inss + irrf + descFaltas;
        const liquido = bruto - descontos;

        totalBruto += bruto;
        totalDesc  += descontos;
        totalLiq   += liquido;

        // Upsert item de folha
        const existing = d.prepare(`SELECT id FROM rh_folha_itens WHERE folha_id = ? AND funcionario_id = ?`).get(folha.id, func.id);
        if (existing) {
          d.prepare(`
            UPDATE rh_folha_itens SET salario_base=?,dias_trabalhados=?,horas_extras=?,valor_he=?,
            faltas=?,inss=?,irrf=?,outros_descontos=?,total_bruto=?,total_descontos=?,total_liquido=?
            WHERE id=?
          `).run(func.salario_base||0, diasTrab, (mExtra50+mExtra100)/60, valorHe50+valorHe100,
                 descFaltas, inss, irrf, 0, bruto, descontos, liquido, existing.id);
        } else {
          d.prepare(`
            INSERT INTO rh_folha_itens (folha_id,funcionario_id,salario_base,dias_trabalhados,horas_extras,
            valor_he,faltas,inss,irrf,outros_descontos,total_bruto,total_descontos,total_liquido)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(folha.id, func.id, func.salario_base||0, diasTrab, (mExtra50+mExtra100)/60,
                 valorHe50+valorHe100, descFaltas, inss, irrf, 0, bruto, descontos, liquido);
        }
        atualizados++;
      }
      // Atualiza totais da folha
      d.prepare(`UPDATE rh_folha SET total_bruto=?,total_descontos=?,total_liquido=?,status='RASCUNHO' WHERE id=?`)
       .run(totalBruto, totalDesc, totalLiq, folha.id);
    });
    upsertItem();
    res.json({ ok: true, folha_id: folha.id, competencia: mes, funcionarios: atualizados,
               total_bruto: totalBruto, total_liquido: totalLiq });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
