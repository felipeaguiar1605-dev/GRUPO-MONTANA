@echo off
cd /d "%~dp0"
echo Iniciando Montana Multi-Empresa (porta 3002)...
start /min node src/server.js
timeout /t 2 /nobreak >nul
start chrome http://localhost:3002
