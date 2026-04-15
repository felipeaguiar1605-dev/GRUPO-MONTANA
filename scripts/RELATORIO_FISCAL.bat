@echo off
chcp 65001 >nul
title Montana — Relatório Fiscal Receita Federal

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║   Montana ERP — Relatório Receita Federal            ║
echo  ║   Geração por empresa, mês a mês                     ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

:: Mês e ano — Enter = mês anterior automático
set /p MES="  Mês (01-12) [Enter = mês anterior]: "
set /p ANO="  Ano (ex: 2026) [Enter = automático]: "
echo.

set ARGS=
if not "%MES%"=="" set ARGS=%ARGS% --mes=%MES%
if not "%ANO%"=="" set ARGS=%ARGS% --ano=%ANO%

echo  [1/3] Enviando script atualizado para o servidor...
scp -i "%USERPROFILE%\.ssh\id_montana" "%~dp0gerar_relatorio_receita_federal.js" diretoria@104.196.22.170:/opt/montana/app_unificado/scripts/
if errorlevel 1 ( echo  ERRO: falha no SCP & pause & exit /b 1 )

echo  [2/3] Gerando relatórios no servidor...
ssh -i "%USERPROFILE%\.ssh\id_montana" diretoria@104.196.22.170 "cd /opt/montana/app_unificado && node scripts/gerar_relatorio_receita_federal.js --empresa=todas%ARGS% 2>&1"
if errorlevel 1 ( echo  ERRO: falha ao gerar relatório & pause & exit /b 1 )

echo.
echo  [3/3] Baixando arquivos...
:: Detecta qual mês/ano foi gerado (lê do servidor)
for /f "tokens=*" %%F in ('ssh -i "%USERPROFILE%\.ssh\id_montana" diretoria@104.196.22.170 "ls /opt/montana/app_unificado/relatorios/receita_federal_*_*.xlsx 2>/dev/null"') do (
    for %%G in (%%F) do (
        set FNAME=%%~nxG
        scp -i "%USERPROFILE%\.ssh\id_montana" "diretoria@104.196.22.170:%%F" "%~dp0..\relatorios\!FNAME!"
    )
)
:: Fallback: baixa todos os receita_federal recentes
scp -i "%USERPROFILE%\.ssh\id_montana" "diretoria@104.196.22.170:/opt/montana/app_unificado/relatorios/receita_federal_assessoria_*.xlsx" "%~dp0..\relatorios\" >nul 2>&1
scp -i "%USERPROFILE%\.ssh\id_montana" "diretoria@104.196.22.170:/opt/montana/app_unificado/relatorios/receita_federal_seguranca_*.xlsx" "%~dp0..\relatorios\" >nul 2>&1

echo.
echo  ✅ Concluído! Arquivos salvos em:
echo     %~dp0..\relatorios\
echo.
explorer "%~dp0..\relatorios"
pause
