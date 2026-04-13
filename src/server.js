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

// ── Segurança: headers HTTP ───────────────────────────────────────
app.use((req, res, next) => {
  // CSP: bloqueia scripts inline injetados (mitigação XSS)
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// CORS — restrito a origens permitidas
const CORS_EXTRA = process.env.CORS_ORIGIN || '';
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowed = /^https?:\/\/localhost(:\d+)?$/.test(origin)
    || /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)
    || (CORS_EXTRA && origin === CORS_EXTRA);
  if (!origin || allowed) {
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

// ─── Módulo Usuários (gestão de acesso) ─────────────────────────
app.use('/api/usuarios',     require('./routes/usuarios').router);

// ─── Módulo Alertas WhatsApp ─────────────────────────────────────
try {
  app.use('/api/whatsapp', require('./routes/whatsapp'));
} catch(e) {
  console.warn('  ⚠ WhatsApp module indisponível (permissão/arquivo):', e.message);
}

// ─── Consolidado multi-empresa (visão geral das 4 empresas) ────
app.get('/api/consolidado', require('./auth').authMiddleware, (req, res) => {
  try {
    const resultado = {};
    const ano = new Date().getFullYear();
    for (const [key, company] of Object.entries(COMPANIES)) {
      try {
        const db = getDb(key);
        const from = `${ano}-01-01`, to = `${ano}-12-31`;
        const extratos = db.prepare(`SELECT COUNT(*) cnt, COALESCE(SUM(credito),0) entradas, COALESCE(SUM(debito),0) saidas FROM extratos WHERE data_iso>=? AND data_iso<=?`).get(from, to);
        const nfs      = db.prepare(`SELECT COUNT(*) cnt, COALESCE(SUM(valor_bruto),0) bruto FROM notas_fiscais WHERE (data_emissao>=? AND data_emissao<=?) OR (data_emissao='' AND created_at>=? AND created_at<=?)`).get(from, to, from, to);
        const desp     = db.prepare(`SELECT COALESCE(SUM(valor_bruto),0) total FROM despesas WHERE data_iso>=? AND data_iso<=?`).get(from, to);
        const pend     = db.prepare(`SELECT COUNT(*) cnt FROM extratos WHERE status_conciliacao='PENDENTE'`).get();
        const funcs    = db.prepare(`SELECT COUNT(*) cnt FROM rh_funcionarios WHERE status='ATIVO'`).get();
        resultado[key] = {
          nome: company.nome, nomeAbrev: company.nomeAbrev, cnpj: company.cnpj,
          cor: company.cor, icone: company.icone,
          extratos_total: extratos.cnt,
          entradas: +extratos.entradas.toFixed(2),
          saidas: +extratos.saidas.toFixed(2),
          nfs_total: nfs.cnt, faturamento: +nfs.bruto.toFixed(2),
          despesas: +desp.total.toFixed(2),
          pendentes: pend.cnt,
          funcionarios: funcs.cnt,
        };
      } catch(e) {
        resultado[key] = { nome: company.nome, erro: e.message };
      }
    }
    res.json({ ok: true, ano, empresas: resultado });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

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
  const { enviarAlertasEmpresa } = require('./routes/notificacoes');

  async function dispararAlertasDiarios() {
    for (const key of Object.keys(COMPANIES)) {
      try {
        const db = getDb(key);
        const resultado = await enviarAlertasEmpresa(db, COMPANIES[key]);
        if (resultado.enviado) {
          console.log(`  📧 Alertas enviados [${key}] (${resultado.total} alertas)`);
        }
        // Tentar enviar WhatsApp também
        try {
          const wppCfg = db.prepare("SELECT chave,valor FROM configuracoes WHERE chave LIKE 'whatsapp_%'").all();
          if (wppCfg.length > 0 && globalThis.fetch) {
            globalThis.fetch(`http://127.0.0.1:${PORT}/api/whatsapp/enviar-alertas`, {
              method: 'POST',
              headers: { 'X-Company': key, 'Authorization': 'Bearer ' + require('jsonwebtoken').sign({ usuario: 'cron', role: 'admin' }, require('./auth').JWT_SECRET, { expiresIn: '5m' }) }
            }).then(r => r.json()).then(r => {
              if (r.enviado) console.log(`  💬 WhatsApp alertas enviados [${key}]`);
            }).catch(e2 => console.error(`  ⚠ WhatsApp cron [${key}]:`, e2.message));
          }
        } catch(e3) { console.error(`  ⚠ WhatsApp cron [${key}]:`, e3.message); }
      } catch (e) {
        console.error(`  ⚠ Cron alerta [${key}]:`, e.message);
      }
    }
  }

  // Executa todo dia às 08:00
  cron.schedule('0 8 * * *', dispararAlertasDiarios, { timezone: 'America/Araguaina' });
  console.log('  ⏰ Cron de alertas configurado: todo dia 08:00 (America/Araguaina)');

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
          qtd_nfs INTEGER DEFAULT 0,
          gerado_em TEXT DEFAULT (datetime('now','localtime')),
          obs TEXT
        )`).run();

        const receita  = db.prepare(`SELECT COALESCE(SUM(valor_bruto),0) total, COUNT(*) qtd FROM notas_fiscais WHERE data_emissao BETWEEN ? AND ?`).get(from, to);
        const despesas = db.prepare(`SELECT COALESCE(SUM(valor_bruto),0) total FROM despesas WHERE data_iso BETWEEN ? AND ?`).get(from, to);
        const retencoes = db.prepare(`SELECT COALESCE(SUM(retencao),0) total FROM notas_fiscais WHERE data_emissao BETWEEN ? AND ?`).get(from, to);

        const receita_bruta = receita.total || 0;
        const ret  = retencoes.total || 0;
        const desp = despesas.total || 0;

        db.prepare(`INSERT OR REPLACE INTO apuracao_mensal
          (competencia, receita_bruta, retencoes, receita_liquida, despesas_total, resultado, qtd_nfs)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(comp, receita_bruta, ret, receita_bruta - ret, desp, (receita_bruta - ret) - desp, receita.qtd);

        console.log(`[APURAÇÃO] ${key} ${comp}: Receita R$${receita_bruta.toFixed(2)} | Despesas R$${desp.toFixed(2)} | Resultado R$${((receita_bruta - ret) - desp).toFixed(2)}`);
      } catch(e) {
        console.error(`[APURAÇÃO] Erro ${key}:`, e.message);
      }
    }
  }, { timezone: 'America/Araguaina' });
  console.log('  📊 Cron de apuração mensal configurado: dia 1° às 06:00 (America/Araguaina)');

  // ── Conciliação automática mensal — dia 5 às 05:00 ────────
  cron.schedule('0 5 5 * *', async () => {
    console.log('[CRON] Iniciando conciliação automática mensal...');
    const { getDb, COMPANIES } = require('./db');

    for (const [key] of Object.entries(COMPANIES)) {
      try {
        const db = getDb(key);

        // 1. Sync BB (se configurado)
        try {
          const bbCfg = db.prepare(`SELECT chave,valor FROM configuracoes WHERE chave LIKE 'bb_%'`).all();
          const hasBB = bbCfg.some(r => r.chave === 'bb_client_id' && r.valor);
          if (hasBB) {
            const hoje  = new Date();
            const fim   = hoje.toISOString().split('T')[0];
            const ini   = new Date(hoje.setDate(hoje.getDate() - 45)).toISOString().split('T')[0];
            await fetch(`http://127.0.0.1:${PORT}/api/bb/sync`, {
              method: 'POST',
              headers: { 'Content-Type':'application/json', 'X-Company': key,
                         'Authorization': 'Bearer ' + require('jsonwebtoken').sign({ usuario: 'cron', role: 'admin' }, require('./auth').JWT_SECRET, { expiresIn: '5m' }) },
              body: JSON.stringify({ dataInicio: ini, dataFim: fim }),
            }).then(r => r.json()).then(r => {
              console.log(`  [BB-SYNC] ${key}: ${r.imported || 0} importados`);
            }).catch(eFetch => console.error(`  [BB-SYNC] fetch ${key}:`, eFetch.message));
          }
        } catch(eBB) { console.error(`  [BB-SYNC] ${key}:`, eBB.message); }

        // 2. Matching NF × extrato (algoritmo simplificado inline)
        let matched = 0;
        const ha90 = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
        const creditos = db.prepare(`
          SELECT id, credito FROM extratos
          WHERE credito > 0 AND status_conciliacao='PENDENTE'
            AND data_iso >= ? AND historico NOT LIKE '%Saldo%'
        `).all(ha90);

        const matchStmt = db.prepare(`
          SELECT id FROM notas_fiscais
          WHERE status_conciliacao='PENDENTE'
            AND valor_liquido BETWEEN ? AND ?
            AND data_emissao >= ?
          ORDER BY ABS(valor_liquido - ?) LIMIT 1
        `);
        const updExt = db.prepare(`UPDATE extratos SET status_conciliacao='CONCILIADO', obs=? WHERE id=?`);
        const updNf  = db.prepare(`UPDATE notas_fiscais SET status_conciliacao='CONCILIADO' WHERE id=?`);

        db.transaction(() => {
          for (const cr of creditos) {
            const low = cr.credito * 0.94, high = cr.credito * 1.06;
            const nf  = matchStmt.get(low, high, ha90, cr.credito);
            if (nf) { updExt.run('auto-conciliado', cr.id); updNf.run(nf.id); matched++; }
          }
        })();

        // 3. Relatório de pendências por email
        const pendentes = db.prepare(`SELECT COUNT(*) cnt FROM extratos WHERE status_conciliacao='PENDENTE' AND credito>0`).get();
        const nfsPend   = db.prepare(`SELECT COUNT(*) cnt, COALESCE(SUM(valor_liquido),0) total FROM notas_fiscais WHERE status_conciliacao='PENDENTE' AND data_emissao>='2024-01-01'`).get();
        console.log(`  [CONCIL] ${key}: ${matched} novos matches | ${pendentes.cnt} extratos pendentes | ${nfsPend.cnt} NFs pendentes (R$${nfsPend.total.toFixed(2)})`);

        // Envia email com resultado se SMTP configurado
        try {
          const { enviarAlertasEmpresa } = require('./routes/notificacoes');
          await enviarAlertasEmpresa(db, COMPANIES[key]);
        } catch(_) {}

      } catch(e) { console.error(`  [CONCIL] Erro ${key}:`, e.message); }
    }
  }, { timezone: 'America/Araguaina' });
  console.log('  🤖 Cron de conciliação automática: dia 5 de cada mês às 05:00 (America/Araguaina)');

  // ── Backup automático diário às 02:00 ──────────────────────
  const fs = require('fs');
  const backupDir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  function fazerBackup() {
    const data = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    let total = 0;
    for (const [key, company] of Object.entries(COMPANIES)) {
      try {
        const src = path.join(__dirname, '..', company.dbPath);
        if (!fs.existsSync(src)) continue;
        const dest = path.join(backupDir, `${key}_${data}.db`);
        fs.copyFileSync(src, dest);
        total++;
        // Remove backups com mais de 30 dias
        const prefix = `${key}_`;
        fs.readdirSync(backupDir)
          .filter(f => f.startsWith(prefix) && f.endsWith('.db') && f !== path.basename(dest))
          .forEach(f => {
            const age = (Date.now() - fs.statSync(path.join(backupDir, f)).mtimeMs) / 86400000;
            if (age > 30) fs.unlinkSync(path.join(backupDir, f));
          });
      } catch(e) {
        console.error(`  ⚠ Backup [${key}]:`, e.message);
      }
    }
    console.log(`  💾 Backup concluído: ${total} banco(s) → backups/${data}`);
  }

  cron.schedule('0 2 * * *', fazerBackup, { timezone: 'America/Araguaina' });
  console.log('  💾 Cron de backup configurado: todo dia 02:00 (America/Araguaina)');
} catch(e) {
  console.warn('  ⚠ node-cron não disponível:', e.message);
}

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════════════════╗
  ║  Montana Multi-Empresa — Sistema Unificado               ║
  ║  Conciliação Financeira + Boletins de Medição            ║
  ║  Servidor: http://localhost:${PORT}                         ║
  ║                                                          ║
  ║  🏢 Assessoria  (14.092.519) → data/assessoria/          ║
  ║  🔒 Segurança   (19.200.109) → data/seguranca/           ║
  ║  🛡️  Porto do Vau (41.034.574) → data/portodovau/        ║
  ║  🐎 Mustang     (26.600.137) → data/mustang/             ║
  ║  🔐 Auth JWT ativo                                       ║
  ╚══════════════════════════════════════════════════════════╝
  `);
});
