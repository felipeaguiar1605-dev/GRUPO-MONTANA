/**
 * Montana — db.js agora é um proxy para db_pg.js (PostgreSQL).
 * Todos os require('./db') existentes continuam funcionando sem alteração.
 * Migração concluída em 2026-04-25.
 */
module.exports = require('./db_pg');
