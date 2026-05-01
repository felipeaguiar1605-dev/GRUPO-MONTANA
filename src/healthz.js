/**
 * Montana ERP — Health check robusto
 *
 * Endpoint /healthz
 * Checa:
 *   - Conexão PostgreSQL (cada schema)
 *   - Memória (RSS heap)
 *   - Disco (espaço livre em BACKUP_DIR e logs)
 *   - Uptime
 *
 * Retorna 200 quando todos os componentes estão "ok".
 * Retorna 503 quando algum componente está "down" (uso por load balancer).
 *
 * Uso: app.use('/healthz', require('./healthz'));
 *
 * Probes recomendadas:
 *   - GET /healthz/live   → liveness (responde sempre 200 enquanto processo vivo)
 *   - GET /healthz/ready  → readiness (200 só se DBs ok)
 *   - GET /healthz        → status completo (JSON detalhado)
 */
const express = require('express');
const fs = require('fs');
const os = require('os');
const router = express.Router();

const { getDb, COMPANIES } = require('./db');

// Limites configuráveis via env
const MEM_RSS_MAX_MB   = parseInt(process.env.HEALTHZ_MEM_MAX_MB   || '1024', 10); // 1 GB
const DISK_FREE_MIN_GB = parseFloat(process.env.HEALTHZ_DISK_MIN_GB || '2');       // 2 GB livres mínimo

function checkMemory() {
  const m = process.memoryUsage();
  const rssMb  = +(m.rss / 1024 / 1024).toFixed(1);
  const heapMb = +(m.heapUsed / 1024 / 1024).toFixed(1);
  const ok = rssMb < MEM_RSS_MAX_MB;
  return { ok, rss_mb: rssMb, heap_used_mb: heapMb, rss_max_mb: MEM_RSS_MAX_MB };
}

function checkDisk(path) {
  try {
    const stat = fs.statfsSync ? fs.statfsSync(path) : null;
    if (!stat) return { ok: true, note: 'statfs não suportado nesta versão de Node' };
    const freeGb  = +(stat.bavail * stat.bsize / 1024 / 1024 / 1024).toFixed(2);
    const totalGb = +(stat.blocks * stat.bsize / 1024 / 1024 / 1024).toFixed(2);
    const usedPct = +((1 - stat.bavail / stat.blocks) * 100).toFixed(1);
    return {
      ok: freeGb >= DISK_FREE_MIN_GB,
      path,
      free_gb: freeGb,
      total_gb: totalGb,
      used_pct: usedPct,
      free_min_gb: DISK_FREE_MIN_GB
    };
  } catch (e) {
    return { ok: false, path, error: e.message };
  }
}

async function checkDb(key) {
  try {
    const db = getDb(key);
    const start = Date.now();
    const r = await db.prepare('SELECT 1 AS ok').get();
    return {
      ok: r && r.ok === 1,
      latency_ms: Date.now() - start
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── /healthz/live — liveness (sempre 200 enquanto processo de pé) ────
router.get('/live', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), uptime_s: Math.round(process.uptime()) });
});

// ── /healthz/ready — readiness (200 só se DBs respondem) ────────────
router.get('/ready', async (req, res) => {
  const dbs = {};
  for (const k of Object.keys(COMPANIES)) dbs[k] = await checkDb(k);
  const ok = Object.values(dbs).every(d => d.ok);
  res.status(ok ? 200 : 503).json({ ok, dbs });
});

// ── /healthz — relatório completo ───────────────────────────────────
router.get('/', async (req, res) => {
  const memory = checkMemory();
  const backupDir = process.env.BACKUP_DIR || '/opt/montana/backups';
  const logsDir   = require('path').join(__dirname, '..', 'logs');
  const disk = {
    backup: checkDisk(fs.existsSync(backupDir) ? backupDir : os.tmpdir()),
    logs:   checkDisk(fs.existsSync(logsDir)   ? logsDir   : os.tmpdir())
  };

  const dbs = {};
  for (const k of Object.keys(COMPANIES)) dbs[k] = await checkDb(k);

  const allOk = memory.ok
    && disk.backup.ok
    && disk.logs.ok
    && Object.values(dbs).every(d => d.ok);

  const body = {
    ok: allOk,
    ts: new Date().toISOString(),
    uptime_s: Math.round(process.uptime()),
    version: process.env.APP_VERSION || require('../package.json').version || 'unknown',
    node: process.version,
    env: process.env.NODE_ENV || 'development',
    memory,
    disk,
    dbs
  };

  res.status(allOk ? 200 : 503).json(body);
});

module.exports = router;
