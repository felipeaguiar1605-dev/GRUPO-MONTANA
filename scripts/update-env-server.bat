@echo off
:: ═══════════════════════════════════════════════════════════════════
::  Montana App — Atualiza variáveis de ambiente no servidor GCP
::  Execute após adicionar/alterar credenciais no .env local
:: ═══════════════════════════════════════════════════════════════════

set GCP_IP=104.196.22.170
set GCP_USER=diretoria
set GCP_PATH=/opt/montana/app_unificado
set SSH_KEY=%USERPROFILE%\.ssh\id_montana

echo.
echo  ===============================================
echo   Montana — Atualizar .env no Servidor GCP
echo  ===============================================
echo.

set /p CONFIRMA="Enviar .env para o servidor? (S/N): "
if /i "%CONFIRMA%" NEQ "S" (
    echo Cancelado.
    exit /b 0
)

echo.
echo  Enviando .env para o servidor...
scp -i "%SSH_KEY%" "%~dp0..\.env" %GCP_USER%@%GCP_IP%:%GCP_PATH%/.env

echo.
echo  Reiniciando servidor para carregar novas variaveis...
ssh -i "%SSH_KEY%" %GCP_USER%@%GCP_IP% "pm2 restart montana-app && pm2 status"

echo.
echo  ===============================================
echo   .env atualizado com sucesso!
echo   App: https://sistema.grupomontanasec.com
echo  ===============================================
echo.
pause
