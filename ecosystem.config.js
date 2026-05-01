// PM2 Ecosystem Config — Montana App Unificado
// Uso: pm2 start ecosystem.config.js
//      pm2 save   (persiste após reinício do servidor)
//      pm2 startup (configura inicio automático no boot)

module.exports = {
  apps: [
    {
      name        : 'montana-app',
      script      : 'src/server.js',
      cwd         : '/opt/montana/app_unificado',
      instances   : 1,           // SQLite não suporta múltiplas instâncias
      exec_mode   : 'fork',
      watch       : false,       // desabilitar em produção
      max_memory_restart: '512M',

      env: {
        NODE_ENV : 'production',
        PORT     : 3002,
      },

      // Logs
      out_file    : '/opt/montana/logs/app-out.log',
      error_file  : '/opt/montana/logs/app-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs  : true,

      // Restart automático
      restart_delay      : 3000,    // aguarda 3s antes de reiniciar
      max_restarts       : 10,
      min_uptime         : '10s',

      // Graceful shutdown
      kill_timeout       : 5000,
      listen_timeout     : 8000,
    },

    // ─── Cron mensal: gera boletins do mês passado, dia 5 às 8h ─────────
    {
      name         : 'montana-cron-boletins',
      script       : 'scripts/gerar_boletins_mensal.js',
      args         : '--apply',
      cwd          : '/opt/montana/app_unificado',
      autorestart  : false,                // só roda no cron, não restart contínuo
      cron_restart : '0 8 5 * *',          // todo dia 5 às 8h (depois fechamento mês)
      out_file     : '/opt/montana/logs/cron-boletins-out.log',
      error_file   : '/opt/montana/logs/cron-boletins-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs   : true,
    },

    // ─── Cron diário: backup PostgreSQL → GCS, todo dia às 3h ───────────
    {
      name         : 'montana-cron-backup',
      script       : 'scripts/backup_postgres.sh',
      interpreter  : 'bash',
      cwd          : '/opt/montana/app_unificado',
      autorestart  : false,
      cron_restart : '0 3 * * *',          // diário 3h da manhã
      out_file     : '/opt/montana/logs/cron-backup-out.log',
      error_file   : '/opt/montana/logs/cron-backup-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs   : true,
      env: {
        PG_HOST     : '35.247.208.7',
        PG_PORT     : '5432',
        PG_USER     : 'montana',
        PG_DB       : 'montana_erp',
        GCS_BUCKET  : 'gs://montana-erp-backups',
        BACKUP_DIR  : '/opt/montana/backups',
        // PG_PASSWORD: definir via `pm2 set` ou .env (NÃO commitar)
      },
    }
  ]
};
