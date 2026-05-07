/**
 * Montana ERP — Quality Checks
 *
 * Roda diariamente às 07:00 (após auto-classify das 04h).
 * Detecta anomalias e envia relatório por email/whatsapp pra você ler de manhã.
 *
 * O que checa em cada empresa:
 *   1. Divergência Margem Op vs Saldo de Caixa (gap > 5% = alerta)
 *   2. Lançamentos com SINAL INVERTIDO ainda pendentes (deveria ser 0)
 *   3. Duplicatas literais não-marcadas (mesmo dia + valor + histórico)
 *   4. Histórico vazio em conta NÃO-vinculada
 *   5. Retiradas de sócio acumuladas no mês > teto (default R$ 100k)
 *   6. PENDENTE muito antigo (>60 dias sem classificação)
 *   7. Top 5 maiores PENDENTE não-categorizado (pra você revisar)
 *
 * Uso:
 *   node src/jobs/quality-checks.js                # imprime relatório
 *   node src/jobs/quality-checks.js --email        # envia por email (SMTP no DB)
 *   node src/jobs/quality-checks.js --json         # output JSON pra parse
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { getDb, COMPANIES } = require('../db');

const RETIRADA_TETO_MES = parseFloat(process.env.QC_RETIRADA_TETO_MES || '100000');
const GAP_PCT_ALERTA    = parseFloat(process.env.QC_GAP_PCT_ALERTA || '0.05');
const DIAS_PENDENTE_VELHO = parseInt(process.env.QC_DIAS_PENDENTE_VELHO || '60', 10);

const STATUS_NAO_OP = ['INTERNO','INVESTIMENTO','TRANSFERENCIA','DEVOLVIDO','CONTA_VINCULADA','SALDO','DUPLICATA','FINANCEIRA','RETIRADA_SOCIO'];

async function checksEmpresa(key) {
  const db = getDb(key);
  const hoje = new Date();
  const primeiroMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().slice(0,10);
  const corteVelho = new Date(Date.now() - DIAS_PENDENTE_VELHO * 86400000).toISOString().slice(0,10);
  const alertas = [];
  const naoOp = STATUS_NAO_OP.map(s => `'${s}'`).join(',');

  // 1. Divergência Margem Op vs Saldo (mês corrente)
  const totaisMes = await db.prepare(`
    SELECT
      SUM(CASE WHEN credito > 0 THEN credito END) AS bruto_cred,
      SUM(CASE WHEN debito  > 0 THEN debito  END) AS bruto_deb,
      SUM(CASE WHEN credito > 0 AND (status_conciliacao IS NULL OR status_conciliacao NOT IN (${naoOp})) THEN credito END) AS receita_op,
      SUM(CASE WHEN debito  > 0 AND (status_conciliacao IS NULL OR status_conciliacao NOT IN (${naoOp})) THEN debito  END) AS saida_op
    FROM extratos
    WHERE data_iso >= ?
  `).get(primeiroMes);
  const saldoReal = (parseFloat(totaisMes.bruto_cred) || 0) - (parseFloat(totaisMes.bruto_deb) || 0);
  const margemOp = (parseFloat(totaisMes.receita_op) || 0) - (parseFloat(totaisMes.saida_op) || 0);
  const gap = Math.abs(saldoReal - margemOp);
  const gapPct = Math.abs(saldoReal) > 1 ? gap / Math.abs(saldoReal) : 0;
  if (gapPct > GAP_PCT_ALERTA && gap > 50000) {
    alertas.push({
      severity: 'P1',
      check: 'Gap Margem vs Saldo',
      msg: `Margem Op (R$ ${margemOp.toLocaleString('pt-BR')}) vs Saldo Caixa (R$ ${saldoReal.toLocaleString('pt-BR')}) — gap R$ ${gap.toLocaleString('pt-BR')} (${(gapPct*100).toFixed(1)}%)`,
      hint: 'Provavelmente classificação não-operacional desbalanceada (entrada vs saída)'
    });
  }

  // 2. Sinal invertido pendente
  const sinal = await db.prepare(`
    SELECT COUNT(*) as n, COALESCE(SUM(debito), 0) as v
    FROM extratos
    WHERE debito > 0 AND (credito IS NULL OR credito = 0)
      AND (UPPER(historico) LIKE '%RECEBIDO%'
        OR UPPER(historico) LIKE '%CRÉDITO EM CONTA%'
        OR UPPER(historico) LIKE '%CREDITO EM CONTA%'
        OR UPPER(historico) LIKE '%ORDEM BANC%'
        OR UPPER(historico) LIKE '%TRANSFER%RECEBID%')
  `).get();
  if (sinal.n > 0) {
    alertas.push({
      severity: 'P0',
      check: 'Sinal invertido',
      msg: `${sinal.n} lançamentos de RECEBIMENTO classificados como débito (R$ ${parseFloat(sinal.v).toLocaleString('pt-BR')})`,
      hint: 'Auto-classify não pegou — verificar regras LIKE'
    });
  }

  // 3. Duplicatas literais
  const dups = await db.prepare(`
    SELECT COUNT(*) as n FROM (
      SELECT data_iso, conta, historico, COALESCE(debito,0) AS d, COALESCE(credito,0) AS c
      FROM extratos
      WHERE COALESCE(debito,0) + COALESCE(credito,0) > 100
      GROUP BY 1,2,3,4,5
      HAVING COUNT(*) > 1
    ) sub
  `).get();
  if (dups.n > 0) {
    alertas.push({
      severity: 'P1',
      check: 'Duplicatas literais',
      msg: `${dups.n} grupos de lançamentos duplicados literalmente (mesma data + conta + histórico + valor)`,
      hint: 'Provavelmente importação OFX rodada 2x do mesmo período'
    });
  }

  // 4. Histórico vazio (excluindo conta vinculada conhecida)
  const semHist = await db.prepare(`
    SELECT COUNT(*) as n, COALESCE(SUM(debito + credito), 0) as v
    FROM extratos
    WHERE (historico IS NULL OR TRIM(historico) = '')
      AND (status_conciliacao IS NULL OR status_conciliacao NOT IN ('SALDO','CONCILIADO','INVESTIMENTO','INTERNO'))
      AND COALESCE(debito,0) + COALESCE(credito,0) > 100
  `).get();
  if (semHist.n > 0) {
    alertas.push({
      severity: 'P2',
      check: 'Histórico vazio',
      msg: `${semHist.n} lançamentos sem descrição (R$ ${parseFloat(semHist.v).toLocaleString('pt-BR')}) sem classificação`,
      hint: 'Provavelmente OFX BRB ou outro banco que não envia descrição'
    });
  }

  // 5. Retirada sócio do mês
  const retMes = await db.prepare(`
    SELECT COUNT(*) as n, COALESCE(SUM(debito), 0) as v
    FROM extratos
    WHERE status_conciliacao = 'RETIRADA_SOCIO'
      AND data_iso >= ?
  `).get(primeiroMes);
  if (parseFloat(retMes.v) > RETIRADA_TETO_MES) {
    alertas.push({
      severity: 'P0',
      check: 'Retirada sócio',
      msg: `${retMes.n} retiradas no mês totalizando R$ ${parseFloat(retMes.v).toLocaleString('pt-BR')} (teto: R$ ${RETIRADA_TETO_MES.toLocaleString('pt-BR')})`,
      hint: 'Validar se está documentado como dividendo (ata + ECD + DIRPF)'
    });
  }

  // 6. PENDENTE antigo
  const pendVelho = await db.prepare(`
    SELECT COUNT(*) as n, COALESCE(SUM(debito + credito), 0) as v
    FROM extratos
    WHERE status_conciliacao = 'PENDENTE'
      AND data_iso < ?
      AND COALESCE(debito,0) + COALESCE(credito,0) > 1000
  `).get(corteVelho);
  if (pendVelho.n > 100) {
    alertas.push({
      severity: 'P2',
      check: 'PENDENTE antigo',
      msg: `${pendVelho.n} lançamentos PENDENTES > ${DIAS_PENDENTE_VELHO}d sem classificação (R$ ${parseFloat(pendVelho.v).toLocaleString('pt-BR')})`,
      hint: 'Maioria deve virar DESPESA ou conciliar com NF emitida'
    });
  }

  // 7. Top 5 maiores PENDENTE pra revisão manual
  const top = await db.prepare(`
    SELECT data_iso, LEFT(COALESCE(historico,''), 60) as hist, debito, credito
    FROM extratos
    WHERE status_conciliacao = 'PENDENTE'
      AND COALESCE(debito,0) + COALESCE(credito,0) > 50000
    ORDER BY (COALESCE(debito,0) + COALESCE(credito,0)) DESC
    LIMIT 5
  `).all();

  return {
    empresa: key,
    saldo_caixa_mes: saldoReal,
    margem_op_mes: margemOp,
    alertas,
    top_pendentes: Array.isArray(top) ? top : []
  };
}

function formatHTML(reports) {
  const data = new Date().toLocaleDateString('pt-BR');
  let html = `<html><body style="font-family:sans-serif;max-width:800px">`;
  html += `<h2>📊 Montana — Quality Checks ${data}</h2>`;
  let totalAlertas = 0;
  reports.forEach(r => {
    const cor = r.alertas.length === 0 ? 'green' : r.alertas.some(a => a.severity === 'P0') ? 'red' : 'orange';
    html += `<h3 style="color:${cor}">${r.empresa.toUpperCase()} — ${r.alertas.length} alerta${r.alertas.length !== 1 ? 's' : ''}</h3>`;
    html += `<p>Saldo de caixa do mês: <b>R$ ${r.saldo_caixa_mes.toLocaleString('pt-BR')}</b> · Margem Op do mês: <b>R$ ${r.margem_op_mes.toLocaleString('pt-BR')}</b></p>`;
    if (r.alertas.length > 0) {
      html += `<table border="1" cellpadding="6" style="border-collapse:collapse;width:100%"><tr><th>Sev</th><th>Check</th><th>Mensagem</th></tr>`;
      r.alertas.forEach(a => {
        html += `<tr><td><b>${a.severity}</b></td><td>${a.check}</td><td>${a.msg}<br><small style="color:#888">${a.hint}</small></td></tr>`;
      });
      html += `</table>`;
      totalAlertas += r.alertas.length;
    }
    if (r.top_pendentes.length > 0) {
      html += `<details><summary>Top 5 PENDENTES > R$ 50k pra revisar</summary><ul>`;
      r.top_pendentes.forEach(t => {
        const v = parseFloat(t.debito) || parseFloat(t.credito);
        const tipo = parseFloat(t.debito) > 0 ? '↓' : '↑';
        html += `<li>${t.data_iso} ${tipo} R$ ${v.toLocaleString('pt-BR')} — ${t.hist}</li>`;
      });
      html += `</ul></details>`;
    }
  });
  html += `<hr><p><small>Total: ${totalAlertas} alerta${totalAlertas !== 1 ? 's' : ''}. Gerado por src/jobs/quality-checks.js</small></p>`;
  html += `</body></html>`;
  return html;
}

async function enviarEmail(reports, db) {
  try {
    const cfg = await db.prepare(`SELECT chave, valor FROM configuracoes WHERE chave LIKE 'smtp_%'`).all();
    const smtp = {};
    (Array.isArray(cfg) ? cfg : []).forEach(r => { smtp[r.chave.replace('smtp_','')] = r.valor; });
    if (!smtp.host || !smtp.user || !smtp.to) {
      console.warn('  ⚠ SMTP não configurado — relatório não enviado');
      return false;
    }
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: smtp.host, port: parseInt(smtp.port) || 587,
      secure: parseInt(smtp.port) === 465,
      auth: { user: smtp.user, pass: smtp.pass }
    });
    const totalAlertas = reports.reduce((s, r) => s + r.alertas.length, 0);
    const subj = totalAlertas > 0
      ? `⚠ ${totalAlertas} alertas de qualidade — Montana ${new Date().toLocaleDateString('pt-BR')}`
      : `✅ Montana — sem alertas — ${new Date().toLocaleDateString('pt-BR')}`;
    await transporter.sendMail({
      from: smtp.from || smtp.user,
      to: smtp.to,
      subject: subj,
      html: formatHTML(reports)
    });
    console.log(`  ✓ Email enviado pra ${smtp.to}`);
    return true;
  } catch (e) {
    console.error('  ✗ Email falhou:', e.message);
    return false;
  }
}

async function main() {
  const wantEmail = process.argv.includes('--email');
  const wantJson  = process.argv.includes('--json');

  const reports = [];
  for (const key of Object.keys(COMPANIES)) {
    try {
      reports.push(await checksEmpresa(key));
    } catch (e) {
      console.error(`  ✗ Falhou em ${key}:`, e.message);
    }
  }

  if (wantJson) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    reports.forEach(r => {
      console.log(`\n═══ ${r.empresa.toUpperCase()} ═══`);
      console.log(`Saldo mês: R$ ${r.saldo_caixa_mes.toLocaleString('pt-BR')}`);
      console.log(`Margem Op: R$ ${r.margem_op_mes.toLocaleString('pt-BR')}`);
      if (r.alertas.length === 0) console.log('  ✅ Sem alertas');
      r.alertas.forEach(a => {
        console.log(`  [${a.severity}] ${a.check}: ${a.msg}`);
        console.log(`         💡 ${a.hint}`);
      });
    });
  }

  if (wantEmail) {
    const db = getDb('assessoria'); // usa SMTP da Assessoria como referência
    await enviarEmail(reports, db);
  }
  process.exit(0);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { checksEmpresa, formatHTML };
