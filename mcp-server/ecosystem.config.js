// PM2 Config — Montana MCP Server
// Uso: pm2 start ecosystem.config.js
module.exports = {
  apps: [{
    name        : 'montana-mcp',
    script      : 'mcp_server.py',
    interpreter : '/usr/bin/python3',
    cwd         : '/opt/montana/mcp-server',
    instances   : 1,
    exec_mode   : 'fork',
    watch       : false,
    max_memory_restart: '256M',

    // Logs
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs  : true,

    // Restart
    restart_delay      : 3000,
    max_restarts       : 10,
    min_uptime         : '10s',
    kill_timeout       : 5000,
  }]
};
