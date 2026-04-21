@echo off
:: ═══════════════════════════════════════════════════════════════════
::  Montana App + Montana Intelligence — Deploy para Google Cloud
::  Execute no Windows para enviar atualizações ao servidor GCP
::
::  Pré-requisito: OpenSSH instalado (Windows 10/11 já tem)
:: ═══════════════════════════════════════════════════════════════════

:: ── CONFIGURAÇÕES ──────────────────────────────────────────────────
set GCP_IP=35.247.236.181
set GCP_USER=diretoria
set GCP_PATH=/opt/montana/app_unificado
set GCP_MCP_PATH=/opt/montana/mcp-server
set LOCAL_PATH=%~dp0..
set SSH_KEY=%USERPROFILE%\.ssh\id_montana
:: ──────────────────────────────────────────────────────────────────

echo.
echo  ===============================================
echo   Montana App + Intelligence — Deploy GCP
echo   Servidor: %GCP_USER%@%GCP_IP%
echo  ===============================================
echo.

:: Confirma antes de enviar
set /p CONFIRMA="Enviar atualizações para o servidor? (S/N): "
if /i "%CONFIRMA%" NEQ "S" (
    echo Cancelado.
    exit /b 0
)

echo.
echo  [1/4] Enviando codigo do App Montana...
echo.
scp -i "%SSH_KEY%" -r "%LOCAL_PATH%\src"      %GCP_USER%@%GCP_IP%:%GCP_PATH%/
scp -i "%SSH_KEY%" -r "%LOCAL_PATH%\public"   %GCP_USER%@%GCP_IP%:%GCP_PATH%/
scp -i "%SSH_KEY%" -r "%LOCAL_PATH%\scripts"  %GCP_USER%@%GCP_IP%:%GCP_PATH%/
scp -i "%SSH_KEY%"    "%LOCAL_PATH%\package.json"         %GCP_USER%@%GCP_IP%:%GCP_PATH%/
scp -i "%SSH_KEY%"    "%LOCAL_PATH%\ecosystem.config.js"  %GCP_USER%@%GCP_IP%:%GCP_PATH%/

echo.
echo  [2/5] Enviando Montana Intelligence (FastAPI)...
echo.
scp -i "%SSH_KEY%" -r "%LOCAL_PATH%\montana_intelligence" %GCP_USER%@%GCP_IP%:%GCP_PATH%/

echo.
echo  [3/5] Enviando Montana MCP Server (Claude SSE)...
echo.
ssh -i "%SSH_KEY%" %GCP_USER%@%GCP_IP% "mkdir -p %GCP_MCP_PATH%"
scp -i "%SSH_KEY%" "%LOCAL_PATH%\mcp-server\mcp_server.py"         %GCP_USER%@%GCP_IP%:%GCP_MCP_PATH%/
scp -i "%SSH_KEY%" "%LOCAL_PATH%\mcp-server\ecosystem.config.js"   %GCP_USER%@%GCP_IP%:%GCP_MCP_PATH%/

echo.
echo  [4/5] Instalando dependencias e reiniciando App...
ssh -i "%SSH_KEY%" %GCP_USER%@%GCP_IP% "cd %GCP_PATH% && npm install --production 2>&1 | tail -3"
ssh -i "%SSH_KEY%" %GCP_USER%@%GCP_IP% "pm2 restart montana-app && echo App reiniciado."

echo.
echo  [5/5] Reiniciando Montana MCP Server (porta 3010)...
ssh -i "%SSH_KEY%" %GCP_USER%@%GCP_IP% "cd %GCP_PATH% && pip3 install fastapi uvicorn pydantic mcp --break-system-packages -q 2>&1 | tail -2"
ssh -i "%SSH_KEY%" %GCP_USER%@%GCP_IP% "pm2 restart montana-mcp 2>/dev/null && echo MCP reiniciado. || (cd %GCP_MCP_PATH% && pm2 start ecosystem.config.js && pm2 save && echo MCP iniciado pela primeira vez.)"

echo.
echo  ===============================================
echo   Deploy concluido!
echo.
echo   App Montana:        https://sistema.grupomontanasec.com
echo   Intelligence API:   http://%GCP_IP%:8001/saude
echo   Claude MCP (SSE):   http://%GCP_IP%:3010/sse
echo  ===============================================
echo.
pause
