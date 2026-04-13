@echo off
set GCP_IP=104.196.22.170
set GCP_USER=diretoria
set SSH_KEY=%USERPROFILE%\.ssh\id_montana

echo.
echo === ULTIMAS 30 LINHAS DO LOG DE ERRO ===
ssh -i "%SSH_KEY%" %GCP_USER%@%GCP_IP% "tail -30 /opt/montana/logs/app-err.log"
echo.
echo === ULTIMAS 20 LINHAS DO LOG NORMAL ===
ssh -i "%SSH_KEY%" %GCP_USER%@%GCP_IP% "tail -20 /opt/montana/logs/app-out.log"
echo.
echo === STATUS PM2 ===
ssh -i "%SSH_KEY%" %GCP_USER%@%GCP_IP% "pm2 status"
pause
