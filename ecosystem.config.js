module.exports = {
  apps: [
    {
      name        : 'montana-app',
      script      : 'src/server.js',
      cwd         : '/opt/montana/app_unificado',
      instances   : 1,
      exec_mode   : 'fork',
      watch       : false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV : 'production',
        PORT     : 3002,
      },
      out_file    : '/opt/montana/logs/app-out.log',
      error_file  : '/opt/montana/logs/app-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs  : true,
      restart_delay      : 3000,
      max_restarts       : 10,
      min_uptime         : '10s',
      kill_timeout       : 5000,
      listen_timeout     : 8000,
    },
    {
      name         : 'montana-cron-boletins',
      script       : 'scripts/gerar_boletins_mensal.js',
      args         : '--apply',
      cwd          : '/opt/montana/app_unificado',
      autorestart  : false,
      cron_restart : '0 8 5 * *',
      out_file     : '/opt/montana/logs/cron-boletins-out.log',
      error_file   : '/opt/montana/logs/cron-boletins-err.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs   : true,
    }
  ]
};
