@echo off
:: ═══════════════════════════════════════════════════════════════════
::  Montana App + Montana Intelligence — Deploy para Google Cloud
::  Execute no Windows para enviar atualizações ao servidor GCP
::
::  Pré-requisito: OpenSSH instalado (Windows 10/11 já tem)
:: ═══════════════════════════════════════════════════════════════════

:: ── CONFIGURAÇÕES ──────────────────────────────────────────────────
set GCP_IP=104.196.22.170
set GCP_USER=diretoria
set GCP_PATH=/opt/montana/app_unificado
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
echo  [2/4] Enviando Montana Intelligence (MCP server)...
echo.
scp -i "%SSH_KEY%" -r "%LOCAL_PATH%\montana_intelligence" %GCP_USER%@%GCP_IP%:%GCP_PATH%/

echo.
echo  [3/4] Instalando dependencias e reiniciando App...
ssh -i "%SSH_KEY%" %GCP_USER%@%GCP_IP% "cd %GCP_PATH% && npm install --production 2>&1 | tail -3"
ssh -i "%SSH_KEY%" %GCP_USER%@%GCP_IP% "pm2 restart montana-app && echo App reiniciado."

echo.
echo  [4/4] Verificando Montana Intelligence...
ssh -i "%SSH_KEY%" %GCP_USER%@%GCP_IP% "cd %GCP_PATH% && pip3 install fastapi uvicorn pydantic --break-system-packages -q 2>&1 | tail -2"

:: Verifica se o servidor MCP ja esta rodando
ssh -i "%SSH_KEY%" %GCP_USER%@%GCP_IP% "pm2 show montana-intelligence > nul 2>&1 && echo Servidor MCP ja rodando. || (cd /opt/montana/app_unificado && python3 montana_intelligence/etl.py && pm2 start montana_intelligence/server.py --interpreter python3 --name montana-intelligence -- --port 8001 && pm2 save && echo Servidor MCP iniciado pela primeira vez!)"

echo.
echo  ===============================================
echo   Deploy concluido!
echo.
echo   App Montana:    https://sistema.grupomontanasec.com
echo   MCP Server:     http://%GCP_IP%:8001/saude
echo  ===============================================
echo.
pause
