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
    }
  ]
};
