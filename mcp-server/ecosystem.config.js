module.exports = {
  apps: [{
    name: 'montana-mcp',
    script: 'mcp_server.py',
    interpreter: '/usr/bin/python3',
    cwd: '/opt/montana/mcp-server',
    env: {
      MONTANA_APP_DIR: '/opt/montana/app_unificado',
      MCP_PORT: '3010',
      PATH: '/home/diretoria/.local/bin:/usr/local/bin:/usr/bin:/bin'
    },
    max_restarts: 10,
    restart_delay: 5000,
    watch: false
  }]
};
