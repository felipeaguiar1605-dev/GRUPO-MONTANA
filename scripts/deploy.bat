@echo off
:: ═══════════════════════════════════════════════════════════════════
::  Montana App — Deploy para Google Cloud
::  Execute no Windows para enviar atualizações ao servidor GCP
::
::  Pré-requisito: OpenSSH instalado (Windows 10/11 já tem)
::  Configure o IP e usuário abaixo antes de usar
:: ═══════════════════════════════════════════════════════════════════

:: ── CONFIGURAÇÕES ── Ajuste conforme seu servidor ─────────────────
:: IMPORTANTE: Defina GCP_IP como variável de ambiente ou altere aqui
if "%GCP_IP%"=="" set GCP_IP=SEU_IP_AQUI
set GCP_USER=diretoria
set GCP_PATH=/opt/montana/app_unificado
set LOCAL_PATH=%~dp0..
if "%SSH_KEY%"=="" set SSH_KEY=%USERPROFILE%\.ssh\id_montana
:: ──────────────────────────────────────────────────────────────────

echo.
echo  ===============================================
echo   Montana App — Deploy para GCP
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
echo  [1/3] Enviando arquivos para o servidor...
echo        (excluindo: node_modules, data, .env, logs)
echo.

:: rsync via SSH — sincroniza apenas o código, não os dados
scp -i "%SSH_KEY%" -r "%LOCAL_PATH%\src"      %GCP_USER%@%GCP_IP%:%GCP_PATH%/
scp -i "%SSH_KEY%" -r "%LOCAL_PATH%\public"   %GCP_USER%@%GCP_IP%:%GCP_PATH%/
scp -i "%SSH_KEY%" -r "%LOCAL_PATH%\scripts"  %GCP_USER%@%GCP_IP%:%GCP_PATH%/
scp -i "%SSH_KEY%"    "%LOCAL_PATH%\package.json"         %GCP_USER%@%GCP_IP%:%GCP_PATH%/
scp -i "%SSH_KEY%"    "%LOCAL_PATH%\ecosystem.config.js"  %GCP_USER%@%GCP_IP%:%GCP_PATH%/

echo.
echo  [2/3] Instalando dependências (se necessário)...
ssh -i "%SSH_KEY%" %GCP_USER%@%GCP_IP% "cd %GCP_PATH% && npm install --production 2>&1 | tail -3"

echo.
echo  [3/3] Reiniciando servidor...
ssh -i "%SSH_KEY%" %GCP_USER%@%GCP_IP% "pm2 restart montana-app && pm2 status"

echo.
echo  ===============================================
echo   Deploy concluído!
echo   App: https://sistema.grupomontanasec.com
echo  ===============================================
echo.
pause
