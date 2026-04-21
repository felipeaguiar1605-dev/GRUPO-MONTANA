/**
 * Montana Multi-Empresa — Servidor Unificado (porta 3002)
 */
// Carrega .env da raiz do projeto (funciona independente do cwd do processo)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

// ── Log de erros em arquivo ───────────────────────────────────
const LOG_DIR  = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'erros.log');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const { getDb, COMPANIES } = require('./db');
const apiRouter = require('./api');
const { authMiddleware, loginHandler } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3002;

// ── Compressão gzip/brotli em todas as respostas ──────────────
app.use(compression());

// ── Rate limit nas rotas de importação (máx 10 uploads/min) ──
const importLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Muitas importações em pouco tempo. Aguarde 1 minuto.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/import', importLimiter);

// Pre-carrega todos os bancos no startup
for (const key of Object.keys(COMPANIES)) {
  try { getDb(key); } catch (e) { console.error(`  ⚠ DB [${key}]:`, e.message); }
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// CORS — restrito a localhost (app local, sem acesso externo)
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (!origin || /^https?:\/\/localhost(:\d+)?$/.test(origin) || /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin) || /^https?:\/\/104\.196\.22\.170(:\d+)?$/.test(origin)) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,X-Company,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Auth: login endpoint (antes do middleware)
app.post('/api/auth/login', loginHandler);

// Auth middleware protege POST/PUT/PATCH/DELETE
app.use('/api', authMiddleware);

// ─── Middleware de auditoria (registra POST/PUT/PATCH/DELETE) ────
const auditLog = require('./middleware/auditLog');
app.use('/api', auditLog);

// ─── Consolidado multi-empresa (ANTES do apiRouter que exige X-Company) ────
app.use('/api', require('./routes/consolidado'));

// ─── Roadmap de Substituição do Omie (global, sem empresa) ────
app.use('/api/roadmap', require('./routes/roadmap'));

app.use('/api', apiRouter);

// ─── Importação OFX (extratos bancários BB/BRB/CEF) ─────────────
app.use('/api/ofx',          require('./routes/ofx'));

// ─── Importação Alterdata (funcionários/folha) ───────────────────
app.use('/api/alterdata',    require('./routes/alterdata'));

// ─── Módulos extras (melhorias 1-6) ──────────────────────────────
app.use('/api/certidoes',    require('./routes/certidoes'));
app.use('/api/licitacoes',   require('./routes/licitacoes'));
app.use('/api/calculadora',  require('./routes/calculadora'));
app.use('/api/dre',          require('./routes/dre'));
app.use('/api/notificacoes', require('./routes/notificacoes'));

// ─── Módulo Boletins de Medição ─────────────────────────────────
app.use('/api/boletins',     require('./routes/boletins'));

// ─── Módulo RH / Departamento Pessoal ───────────────────────────
app.use('/api/rh',           require('./routes/rh'));

// ─── Módulo Ponto Eletrônico ─────────────────────────────────────
app.use('/api/ponto',        require('./routes/ponto'));


// ─── Módulo WebISS (NFS-e Palmas-TO) ────────────────────────────
app.use('/api/webiss',       require('./routes/webiss'));

// ─── Módulo Transparência Palmas (conciliação com portal) ────────
app.use('/api/transparencia', require('./routes/transparencia'));

// ─── Módulo Conciliação Robusta (pagador_alias + sugestões) ─────
app.use('/api/conciliacao-robusta', require('./routes/conciliacao-robusta'));

// ─── Alertas Operacionais (faturamento / cobranças / folha) ─────
app.use('/api/alertas-operacionais', require('./routes/alertas-operacionais'));

// ─── Fluxo de Caixa Projetado (30/60/90d) ──────────────────────
app.use('/api/fluxo-caixa', require('./routes/fluxo-caixa-projetado'));

// ─── Comprovantes de Pagamento (upload + vinculação multi-empresa) ─
app.use('/api/comprovantes', require('./routes/comprovantes'));

// ─── Módulo Assistente IA (Claude) ──────────────────────────────
app.use('/api/ia',           require('./routes/ia'));

// ─── Módulo Google Drive + IA ────────────────────────────────────
app.use('/api/drive',        require('./routes/drive'));

// ─── Módulo Estoque (equipamentos, EPIs, consumíveis) ───────────
app.use('/api/estoque',      require('./routes/estoque'));

// ─── Módulo Sync Banco do Brasil ────────────────────────────────
app.use('/api/bb',           require('./routes/bb-sync'));

// ─── Módulo Volus (Vale Alimentação / Benefícios) ────────────
app.use('/api/volus',        require('./routes/volus'));

// ─── Módulo Jurídico ─────────────────────────────────────────
app.use('/api/juridico',     require('./routes/juridico'));

// ─── Apuração PIS/COFINS Segurança ───────────────────────────
app.use('/api/piscofins-seguranca', require('./routes/piscofins-seguranca'));

// ─── INSS Retido / S-1300 (Assessoria) ───────────────────────
app.use('/api/inss-retido', require('./routes/inss-retido'));

// ─── Painel de Pagamentos por Contrato ───────────────────────
app.use('/api/pagamentos-contrato', require('./routes/pagamentos-contrato'));

// ─── Diagnóstico Noturno ──────────────────────────────────────
app.get('/api/diagnostico/ultimo', (req, res) => {
  const diagFile = path.join(__dirname, '..', 'data', 'diagnostico_noturno.json');
  if (!fs.existsSync(diagFile)) return res.json({ ok: false, msg: 'Nenhum diagnóstico executado ainda' });
  try {
    res.json({ ok: true, ...JSON.parse(fs.readFileSync(diagFile, 'utf8')) });
  } catch(e) { res.json({ ok: false, msg: 'Erro: ' + e.message }); }
});

// ─── Módulo Usuários (gestão de acesso) ─────────────────────────
app.use('/api/usuarios',     require('./routes/usuarios').router);

// ─── Módulo Alertas WhatsApp ─────────────────────────────────────
try {
  app.use('/api/whatsapp', require('./routes/whatsapp'));
} catch(e) {
  console.warn('  ⚠ WhatsApp module indisponível (permissão/arquivo):', e.message);
}

// (A rota /api/consolidado foi movida para src/routes/consolidado.js)

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// Health check — usado por Docker, Railway, Render
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), env: process.env.NODE_ENV || 'development' });
});

// ── Log viewer — apenas admin (últimas N linhas) ─────────────
app.get('/api/logs', (req, res) => {
  // Verifica JWT manualmente (authMiddleware ignora GET)
  const { JWT_SECRET } = require('./auth');
  const jwt = require('jsonwebtoken');
  try {
    const header = req.headers['authorization'] || '';
    if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Token necessário' });
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Acesso negado' });
  } catch (_) { return res.status(401).json({ error: 'Token inválido' }); }

  try {
    const n = Math.min(parseInt(req.query.n) || 100, 500);
    if (!fs.existsSync(LOG_FILE)) return res.json({ linhas: [], total: 0 });
    const conteudo = fs.readFileSync(LOG_FILE, 'utf8');
    const linhas   = conteudo.trim().split('\n').filter(Boolean);
    const ultimas  = linhas.slice(-n).reverse(); // mais recentes primeiro
    res.json({ linhas: ultimas, total: linhas.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Error handler global — não expõe detalhes internos
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const ts    = new Date().toISOString();
  const linha = `[${ts}] [SERVER] ${req.method} ${req.originalUrl} — ${err.message}\n`;
  console.error('[ERROR]', linha.trim());
  try { fs.appendFileSync(LOG_FILE, linha); } catch (_) {}
  res.status(err.status || 500).json({ error: 'Erro interno do servidor' });
});

// ─── CRON: Alertas automáticos diários às 08:00 ──────────────────
try {
  const cron = require('node-cron');
  const { enviarAlertasEmpresa, verificarDuplicatas, enviarAlertaDedup } = require('./routes/notificacoes');

  const alertasOp = require('./alertas-operacionais');

  async function dispararAlertasDiarios() {
    for (const key of Object.keys(COMPANIES)) {
      try {
        const db = getDb(key);
        const resultado = await enviarAlertasEmpresa(db, COMPANIES[key]);
        if (resultado.enviado) {
          console.log(`  📧 Alertas enviados [${key}] (${resultado.total} alertas)`);
        }

        // ── Alertas Operacionais (#1 faturamento, #2 cobranças, #3 folha) ──
        try {
          const relOp = alertasOp.rodarTodos(db, COMPANIES[key]);
          if (relOp.total_geral > 0) {
            const smtpRows = db.prepare(`SELECT chave, valor FROM configuracoes WHERE chave LIKE 'smtp_%'`).all();
            const smtp = {};
            smtpRows.forEach(r => { smtp[r.chave.replace('smtp_', '')] = r.valor; });
            if (smtp.host && smtp.user && smtp.to) {
              const nodemailer = require('nodemailer');
              const transporter = nodemailer.createTransport({
                host: smtp.host, port: parseInt(smtp.port) || 587,
                secure: parseInt(smtp.port) === 465,
                auth: { user: smtp.user, pass: smtp.pass },
              });
              const html = alertasOp.formatarHTML(relOp);
              const assunto = `⚠ ${relOp.total_geral} Alerta(s) Operacional(is) — ${COMPANIES[key].nomeAbrev || COMPANIES[key].nome} — ${new Date().toLocaleDateString('pt-BR')}`;
              await transporter.sendMail({ from: smtp.from || smtp.user, to: smtp.to, subject: assunto, html });
              console.log(`  ⚠ Alertas operacionais enviados [${key}]: ${relOp.faturamento.total} fat, ${relOp.cobrancas.total} cob, ${relOp.folha.total} folha`);
              try {
                db.prepare(`INSERT INTO notificacoes_log (tipo,destinatario,assunto,corpo,status)
                            VALUES ('email',?,?,?,'enviado')`).run(smtp.to, assunto, html);
              } catch(_) {}
            } else {
              console.log(`  ⚠ Alertas operacionais [${key}]: ${relOp.total_geral} pendentes (SMTP não configurado)`);
            }
          } else {
            console.log(`  ✅ Alertas operacionais [${key}]: nenhuma pendência`);
          }
        } catch (eOp) {
          console.warn(`  ⚠ Alertas operacionais [${key}]:`, eOp.message);
        }
        // Tentar enviar WhatsApp também
        try {
          const wppCfg = db.prepare("SELECT chave,valor FROM configuracoes WHERE chave LIKE 'whatsapp_%'").all();
          if (wppCfg.length > 0 && globalThis.fetch) {
            globalThis.fetch(`http://127.0.0.1:${PORT}/api/whatsapp/enviar-alertas`, {
              method: 'POST',
              headers: { 'X-Company': key, 'Authorization': 'Bearer ' + (process.env.JWT_SECRET || 'montana') }
            }).then(r => r.json()).then(r => {
              if (r.enviado) console.log(`  💬 WhatsApp alertas enviados [${key}]`);
            }).catch(e2 => console.error(`  ⚠ WhatsApp cron [${key}]:`, e2.message));
          }
        } catch(e3) {}
      } catch (e) {
        console.error(`  ⚠ Cron alerta [${key}]:`, e.message);
      }
    }
  }

  // Executa todo dia às 08:00
  cron.schedule('0 8 * * *', dispararAlertasDiarios, { timezone: 'America/Araguaina' });
  console.log('  ⏰ Cron de alertas configurado: todo dia 08:00 (America/Araguaina)');

  // ── Sync automático BB — todo dia às 06:00 ───────────────────
  cron.schedule('0 6 * * *', async () => {
    const http  = require('http');
    const jwt   = require('jsonwebtoken');
    const hoje  = new Date().toISOString().split('T')[0];
    const ontem = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    for (const key of Object.keys(COMPANIES)) {
      try {
        // Verifica se a empresa tem BB configurado antes de chamar
        const db  = getDb(key);
        const cfg = db.prepare(`SELECT chave, valor FROM configuracoes WHERE chave LIKE 'bb_%'`).all()
          .reduce((acc, r) => { acc[r.chave.replace('bb_', '')] = r.valor; return acc; }, {});
        if (!cfg.client_id || !cfg.client_secret || !cfg.app_key || !cfg.agencia || !cfg.conta) continue;

        const body  = JSON.stringify({ dataInicio: ontem, dataFim: hoje });
        const token = jwt.sign({ id: 0, username: 'cron', role: 'admin' },
          process.env.JWT_SECRET || 'montana_seg_secret_2026_!xK9#', { expiresIn: '5m' });

        await new Promise((resolve) => {
          const req = http.request({
            hostname: '127.0.0.1', port: PORT, path: '/api/bb/sync',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
              'X-Company': key,
              'Authorization': 'Bearer ' + token,
            },
          }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
              try {
                const r = JSON.parse(data);
                if (r.ok) console.log(`  🏦 BB sync [${key}] ${ontem}: +${r.imported} importados`);
                else      console.warn(`  ⚠ BB sync [${key}]:`, r.error);
              } catch (_) {}
              resolve();
            });
          });
          req.on('error', (e) => { console.warn(`  ⚠ BB sync cron [${key}]:`, e.message); resolve(); });
          req.write(body);
          req.end();
        });
      } catch (e) {
        console.warn(`  ⚠ BB sync cron [${key}]:`, e.message);
      }
    }
  }, { timezone: 'America/Araguaina' });
  console.log('  ⏰ Cron BB sync configurado: todo dia 06:00 (America/Araguaina)');

  // ── Apuração mensal automática — dia 1° às 06:00 ───────────
  cron.schedule('0 6 1 * *', async () => {
    console.log('[CRON] Iniciando apuração mensal automática...');
    const mesAnterior = new Date();
    mesAnterior.setDate(0); // último dia do mês anterior
    const ano  = mesAnterior.getFullYear();
    const mes  = String(mesAnterior.getMonth() + 1).padStart(2, '0');
    const from = `${ano}-${mes}-01`;
    const to   = `${ano}-${mes}-31`;
    const comp = `${ano}-${mes}`;

    for (const [key] of Object.entries(COMPANIES)) {
      try {
        const db = getDb(key);

        db.prepare(`CREATE TABLE IF NOT EXISTS apuracao_mensal (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          competencia TEXT UNIQUE,
          receita_bruta REAL DEFAULT 0,
          retencoes REAL DEFAULT 0,
          receita_liquida REAL DEFAULT 0,
          despesas_total REAL DEFAULT 0,
          resultado REAL DEFAULT 0,
          qtd_nfs
          qtd_nfs INTEGER DEFAULT 0,
          pis_a_pagar REAL DEFAULT 0,
          cofins_a_pagar REAL DEFAULT 0,
          irpj_estimado REAL DEFAULT 0,
          csll_estimado REAL DEFAULT 0,
          gerado_em TEXT DEFAULT (datetime('now','localtime')),
          obs TEXT
        )`).run();

        const receita  = db.prepare(`SELECT COALESCE(SUM(valor_bruto),0) total, COALESCE(SUM(retencao),0) ret, COUNT(*) qtd, COALESCE(SUM(pis),0) pis, COALESCE(SUM(cofins),0) cofins FROM notas_fiscais WHERE data_emissao BETWEEN ? AND ?`).get(from, to);
        const despesas = db.prepare(`SELECT COALESCE(SUM(valor_bruto),0) total FROM despesas WHERE data_iso BETWEEN ? AND ?`).get(from, to);

        const recBruta  = receita.total || 0;
        const retencoes = receita.ret || 0;
        const recLiq    = recBruta - retencoes;
        const resultado = recLiq - (despesas.total || 0);
        const pisAPagar = Math.max(+(recBruta * 0.0165 - (receita.pis || 0)).toFixed(2), 0);
        const cofinsAPagar = Math.max(+(recBruta * 0.076 - (receita.cofins || 0)).toFixed(2), 0);
        // IRPJ estimado: 15% sobre lucro presumido (8% da receita bruta de serviços)
        const lucroPresumido = recBruta * 0.32; // 32% para serviços de vigilância/prestação
        const irpjEstimado = Math.max(+(lucroPresumido * 0.15).toFixed(2), 0);
        const csllEstimado = Math.max(+(recBruta * 0.32 * 0.09).toFixed(2), 0);

        db.prepare(`INSERT OR REPLACE INTO apuracao_mensal
          (competencia, receita_bruta, retencoes, receita_liquida, despesas_total,
           resultado, qtd_nfs, pis_a_pagar, cofins_a_pagar, irpj_estimado, csll_estimado)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(comp, recBruta, retencoes, recLiq, despesas.total || 0,
               resultado, receita.qtd || 0, pisAPagar, cofinsAPagar, irpjEstimado, csllEstimado);

        console.log(`  ✅ Apuração [${key}] ${comp}: receita=${recBruta.toFixed(2)} resultado=${resultado.toFixed(2)}`);

        // ── Alerta de reajuste por email ─────────────────────────
        try {
          const { enviarAlertasEmpresa } = require('./routes/notificacoes');
          await enviarAlertasEmpresa(db, COMPANIES[key], { incluirReajustes: true });
        } catch(eAlerta) {
          console.warn(`  ⚠ Alerta reajuste [${key}]:`, eAlerta.message);
        }
      } catch (e) {
        console.error(`  ⚠ Apuração mensal [${key}]:`, e.message);
      }
    }
  });
  console.log('  ⏰ Cron apuração mensal configurado: dia 1 às 06:00 (America/Araguaina)');

  // ── Verificação de Duplicatas (Fase 3) — todo dia às 02:00 ───
  cron.schedule('0 2 * * *', async () => {
    console.log('[CRON] Iniciando verificação anti-duplicatas (Fase 3)...');
    for (const key of Object.keys(COMPANIES)) {
      try {
        const db = getDb(key);
        const relatorio = verificarDuplicatas(db, COMPANIES[key]);
        if (!relatorio.temDuplicatas) {
          console.log(`  ✅ Anti-dedup [${key}]: nenhuma duplicata`);
          continue;
        }
        const tot = relatorio.extratos.length + relatorio.notas.length + relatorio.despesas.length;
        console.warn(`  ⚠ Anti-dedup [${key}]: ${tot} tipo(s) de duplicata detectados`);
        const envio = await enviarAlertaDedup(db, COMPANIES[key], relatorio);
        if (envio.enviado) {
          console.log(`  📧 Alerta dedup enviado [${key}]`);
        } else {
          console.warn(`  ⚠ Alerta dedup [${key}] não enviado: ${envio.motivo || 'SMTP não configurado'}`);
        }
      } catch(e) {
        console.error(`  ⚠ Anti-dedup [${key}]:`, e.message);
      }
    }
  }, { timezone: 'America/Araguaina' });
  console.log('  ⏰ Cron anti-dedup configurado: todo dia 02:00 (America/Araguaina)');

} catch (e) {
  console.warn('  ⚠ node-cron não disponível:', e.message);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🚀 Montana Unificado rodando em http://0.0.0.0:${PORT}`);
  console.log(`  Empresas: ${Object.keys(COMPANIES).join(', ')}`);
  console.log(`  Ambiente: ${process.env.NODE_ENV || 'development'}\n`);
});
