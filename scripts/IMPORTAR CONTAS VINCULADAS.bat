@echo off
title Montana ERP — Importar Contas Vinculadas
cd /d "%~dp0"
echo.
echo  Verificando dependencias...
python -c "import pdfplumber" 2>nul || pip install pdfplumber -q
echo.
python importar_contas_vinculadas.py
