/**
 * Montana Multi-Empresa — Database Factory para PostgreSQL (Cloud SQL)
 * Drop-in replacement para o db.js (better-sqlite3), mas com API async.
 *
 * Diferenças em relação ao better-sqlite3:
 *  - .prepare(sql).get/all/run() retornam Promises → use await
 *  - .transaction(asyncFn) retorna async function → use await trans()
 *  - SQL: @name params → convertidos automaticamente para $N
 *  - SQL: datetime('now') → NOW(), strftime → to_char, INSERT OR IGNORE → ON CONFLICT DO NOTHING
 */
'use strict';

const { Pool } = require('pg');
const COMPANIES = require('./companies');

// ── Pool por empresa ────────────────────────────────────────────
const _pools = new Map();

const PG_CONF = {
  host:     process.env.PG_HOST     || '35.247.208.7',
  port:     parseInt(process.env.PG_PORT || '5432'),
  user:     process.env.PG_USER     || 'montana',
  password: process.env.PG_PASSWORD || 'montana2026',
  database: process.env.PG_DB       || 'montana_erp',
  max:      10,
  idleTimeoutMillis:    30000,
  connectionTimeoutMillis: 5000,
};

// ── Conversão SQL: SQLite → PostgreSQL ──────────────────────────
function convertSql(sql) {
  return sql
    // datetime('now') e datetime("now") → NOW()
    .replace(/datetime\(['"']now['"']\)/gi, 'NOW()')
    // strftime('%Y-%m', campo) → to_char(campo, 'YYYY-MM')
    .replace(/strftime\s*\(\s*'%Y-%m'\s*,\s*/gi, "to_char(")
    .replace(/strftime\s*\(\s*'%Y'\s*,\s*/gi,    "to_char(")
    .replace(/strftime\s*\(\s*'%m'\s*,\s*/gi,    "to_char(")
    .replace(/strftime\s*\(\s*'%d'\s*,\s*/gi,    "to_char(")
    // Corrige o segundo argumento do to_char (não tem o formato ainda)
    // INSERT OR IGNORE INTO → INSERT INTO ... ON CONFLICT DO NOTHING
    .replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO')
    .replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, 'INSERT INTO')
    // AUTOINCREMENT → (PG usa SERIAL/BIGSERIAL no schema, ignorar em queries)
    .replace(/AUTOINCREMENT/gi, '')
    // Tipo INTEGER PRIMARY KEY → já tratado no schema
    // PRAGMA → ignorar (não deve aparecer em queries runtime)
    .replace(/PRAGMA\s+\w+\s*=\s*\w+;?/gi, '')
    // Trim extra spaces
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Converte strftime com formato completo ──────────────────────
// strftime('%Y-%m', campo) → to_char(campo::date, 'YYYY-MM')
function fixStrftime(sql) {
  return sql.replace(
    /strftime\s*\(\s*'([^']+)'\s*,\s*([^)]+)\)/gi,
    (_, fmt, col) => {
      const pgFmt = fmt
        .replace('%Y', 'YYYY').replace('%m', 'MM').replace('%d', 'DD')
        .replace('%H', 'HH24').replace('%M', 'MI').replace('%S', 'SS');
      return `to_char((${col.trim()})::date, '${pgFmt}')`;
    }
  );
}

function convertSqlFull(sql) {
  return fixStrftime(convertSql(sql));
}

// ── Converte parâmetros: @nome → $N ou ? → $N ─────────────────
function buildQuery(rawSql, params) {
  const sql = convertSqlFull(rawSql);

  if (params === undefined || params === null) {
    return { sql, values: [] };
  }

  // Parâmetros nomeados: @nome (estilo better-sqlite3)
  if (typeof params === 'object' && !Array.isArray(params)) {
    const names = [];
    const pgSql = sql.replace(/@(\w+)/g, (_, name) => {
      // Evita duplicar o mesmo nome → mesmo índice
      const idx = names.indexOf(name);
      if (idx !== -1) return `$${idx + 1}`;
      names.push(name);
      return `$${names.length}`;
    });
    const values = names.map(n => {
      const v = params[n];
      return v === undefined ? null : v;
    });
    return { sql: pgSql, values };
  }

  // Array de parâmetros posicionais
  if (Array.isArray(params)) {
    let i = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++i}`);
    return { sql: pgSql, values: params };
  }

  // Parâmetro único escalar
  const pgSql = sql.replace(/\?/, '$1');
  return { sql: pgSql, values: [params] };
}

// ── Adiciona ON CONFLICT DO NOTHING se foi INSERT OR IGNORE ─────
function finalizeInsert(sql, rawSql) {
  const wasIgnore = /INSERT\s+OR\s+IGNORE/i.test(rawSql);
  const wasReplace = /INSERT\s+OR\s+REPLACE/i.test(rawSql);
  if ((wasIgnore || wasReplace) && !/ON CONFLICT/i.test(sql)) {
    return sql + ' ON CONFLICT DO NOTHING';
  }
  return sql;
}

// ── Classe principal ────────────────────────────────────────────
class PgDb {
  constructor(companyKey, pool) {
    this.companyKey = companyKey;
    this._pool = pool;
    this._client = null; // preenchido durante transaction
  }

  get _exec() {
    return this._client || this._pool;
  }

  /** Drop-in para db.prepare(sql).get/all/run() — tudo async */
  prepare(rawSql) {
    const exec = this._exec;
    const self = this;

    return {
      /** SELECT que retorna 1 linha (ou null) */
      async get(params) {
        const { sql, values } = buildQuery(rawSql, params);
        try {
          const res = await exec.query(sql, values);
          return res.rows[0] || null;
        } catch (e) {
          _logQueryError(e, sql, values);
          throw e;
        }
      },

      /** SELECT que retorna todas as linhas */
      async all(params) {
        const { sql, values } = buildQuery(rawSql, params);
        try {
          const res = await exec.query(sql, values);
          return res.rows;
        } catch (e) {
          _logQueryError(e, sql, values);
          throw e;
        }
      },

      /** INSERT / UPDATE / DELETE */
      async run(params) {
        let { sql, values } = buildQuery(rawSql, params);
        sql = finalizeInsert(sql, rawSql);

        // Para INSERT, adiciona RETURNING id se não houver
        let isInsert = /^\s*INSERT/i.test(sql);
        let finalSql = sql;
        if (isInsert && !/RETURNING/i.test(sql)) {
          finalSql = sql + ' RETURNING id';
        }

        try {
          const res = await exec.query(finalSql, values);
          return {
            lastInsertRowid: res.rows[0]?.id ?? null,
            changes: res.rowCount || 0,
          };
        } catch (e) {
          _logQueryError(e, finalSql, values);
          throw e;
        }
      },
    };
  }

  /**
   * Transação — envolve a fn em BEGIN/COMMIT.
   * Uso:
   *   const trans = db.transaction(async (txDb) => { await txDb.prepare(...).run(...); });
   *   await trans();
   *
   * Compatibilidade: se a fn não recebe argumento, usa req.db (this) dentro da fn.
   * Para compatibilidade máxima com código que usa db capturado no closure,
   * remapeia this._client durante a transação.
   */
  transaction(fn) {
    const pool = this._pool;
    const companyKey = this.companyKey;
    const self = this;

    return async function txWrapper() {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Cria instância temporária que usa este client
        const txDb = new PgDb(companyKey, pool);
        txDb._client = client;
        // Injeta o client no db original para que closures usem o mesmo client
        const prevClient = self._client;
        self._client = client;
        try {
          await fn(txDb);
        } finally {
          self._client = prevClient;
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    };
  }

  /** Executa SQL direto (sem parâmetros) */
  async exec(sql) {
    try {
      await this._exec.query(convertSqlFull(sql));
    } catch (e) {
      _logQueryError(e, sql, []);
      throw e;
    }
  }

  /** No-op: PRAGMA não existe no PostgreSQL */
  pragma(_str) { /* ignorado */ }
}

function _logQueryError(e, sql, values) {
  // Suprime erros de migração (ALTER TABLE ADD COLUMN já existente)
  if (e.code === "42701" || (e.message && e.message.includes("already exists"))) return;
  console.error('[db_pg] Erro na query:', e.message);
  console.error('  SQL:', sql.substring(0, 200));
  if (values?.length) console.error('  Params:', values);
}

// ── Factory: retorna PgDb por empresa ───────────────────────────
function getDb(companyKey) {
  if (!COMPANIES[companyKey]) throw new Error('Empresa desconhecida: ' + companyKey);
  if (_pools.has(companyKey)) return _pools.get(companyKey);

  const pool = new Pool({
    ...PG_CONF,
    // search_path faz SET automático no connect → todas as queries usam o schema certo
    options: `-c search_path=${companyKey},public`,
  });

  pool.on('error', (err) => {
    console.error(`[db_pg][${companyKey}] Pool error:`, err.message);
  });

  pool.on('connect', () => {
    // já configurado via options no connect string
  });

  const db = new PgDb(companyKey, pool);
  _pools.set(companyKey, db);
  console.log(`  ✅ PG [${companyKey}] pool criado → ${PG_CONF.host}:${PG_CONF.port}/${PG_CONF.database}`);
  return db;
}

// Fecha todos os pools (graceful shutdown)
async function closeAll() {
  for (const [key, db] of _pools) {
    try { await db._pool.end(); console.log(`  PG [${key}] pool fechado`); }
    catch (_) {}
  }
  _pools.clear();
}

module.exports = { getDb, COMPANIES, closeAll };
