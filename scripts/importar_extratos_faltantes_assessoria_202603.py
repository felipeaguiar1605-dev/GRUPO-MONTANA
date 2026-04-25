#!/usr/bin/env python3
"""
Montana — Importação de Extratos Faltantes — Assessoria — Março 2026
Executa no servidor: python3 scripts/importar_extratos_faltantes_assessoria_202603.py

Origem: Planilha PIS_COFINS_CAIXA_assessoria_202603_v11.xlsx
Insere 51 lançamentos identificados na planilha mas ausentes no ERP.
Usa INSERT OR IGNORE — seguro rodar múltiplas vezes.
"""

import sqlite3, os
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH  = os.path.join(BASE_DIR, 'data', 'assessoria', 'montana.db')

MESES = ['','Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez']

def mes_str(data_iso):
    p = data_iso.split('-')
    return f"{MESES[int(p[1])]}/{p[0]}" if len(p) == 3 else ''

def data_br(data_iso):
    p = data_iso.split('-')
    return f"{p[2]}/{p[1]}/{p[0]}" if len(p) == 3 else data_iso

# 51 lançamentos extraídos da planilha v11 - status e classe conforme classificação original
LANCAMENTOS = [
    # data_iso, credito, historico, status_conciliacao, obs
    ('2026-03-06',   8395.00, 'Pix - Recebido — 06/03 17:39 05149726000104 FUNDACAO UN',              'PENDENTE',    'Planilha PIS/COFINS v11 - TRIBUTÁVEL'),
    ('2026-03-13',    230.00, 'Transferência recebida — 13/03 10:02 KLEBER DE MORAIS',                 'PENDENTE',    'Planilha PIS/COFINS v11 - NÃO TRIBUTA'),
    ('2026-03-13',    115.00, 'Transferência recebida — 13/03 14:07 JOAQUIM SANTANA COELHO J',         'PENDENTE',    'Planilha PIS/COFINS v11 - NÃO TRIBUTA'),
    ('2026-03-16',  24556.90, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-16',   6139.23, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-16',   6139.22, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-16',  12859.84, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-16',   8185.64, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-16',   8185.63, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-16',  18008.39, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-16',   4502.10, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-16',   4502.11, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-16',   6002.80, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-16',   6548.50, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-16',   2182.84, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-16',   3274.25, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-16',   1637.13, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'INTERNO',     'Planilha PIS/COFINS v11 - OB Palmas NÃO TRIBUTA'),
    ('2026-03-16',   2182.83, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-16',  19645.52, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-16',   3429.28, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-16',   9563.24, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-16',  35862.16, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-16',  13097.01, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-17',  36016.79, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-17',  49113.80, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-17',  49113.81, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-17',   1637.13, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-18',  19038.27, 'Ordem Bancária - ORDENS BANCARIAS',                                    'CONCILIADO',  'Planilha PIS/COFINS v11 - TRIBUTÁVEL'),
    ('2026-03-18',  10580.00, 'Pix - Recebido — 18/03 17:36 05149726000104 FUNDACAO UN',              'CONCILIADO',  'Planilha PIS/COFINS v11 - TRIBUTÁVEL'),
    ('2026-03-18',  16143.55, 'Ordem Bancária — ORDENS BANCARIAS',                                    'CONCILIADO',  'Planilha PIS/COFINS v11 - TRIBUTÁVEL'),
    ('2026-03-18',   4000.00, 'Transferência recebida — 18/03 15:44 MONTANA SERVICOS',                'INTERNO',     'Planilha PIS/COFINS v11 - NÃO TRIBUTA INTERNO'),
    ('2026-03-19',  73670.71, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-19',  35862.16, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-19', 147341.41, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-19', 122784.51, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-19',  24556.90, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-19',  26194.03, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-19',  99390.38, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-26',   9667.72, 'Ordem Bancária - MUNICIPIO DE PALMAS',                                 'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-26',  24556.90, 'Ordem Bancária - ORDENS BANCARIAS',                                    'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-26',  12859.84, 'Ordem Bancária - ORDENS BANCARIAS',                                    'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-26',  11697.07, 'Ordem Bancária - ORDENS BANCARIAS',                                    'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-26',  49113.81, 'Ordem Bancária - ORDENS BANCARIAS',                                    'CONCILIADO',  'Planilha PIS/COFINS v11 - OB Palmas TRIBUTÁVEL'),
    ('2026-03-30',    460.00, 'Transferido da poupança — 30/03 12:33 ISMAEL ANTONIO AIRES',           'PENDENTE',    'Planilha PIS/COFINS v11 - NÃO TRIBUTA'),
    ('2026-03-31', 176331.50, 'Resgate Depósito Garantia',                                            'CONCILIADO',  'Planilha PIS/COFINS v11 - Resgate TRIBUTÁVEL'),
    ('2026-03-31', 114315.14, 'Resgate Depósito Garantia',                                            'INVESTIMENTO','Planilha PIS/COFINS v11 - Resgate NÃO TRIBUTA'),
    ('2026-03-31',  56917.47, 'Resgate Depósito Garantia',                                            'INVESTIMENTO','Planilha PIS/COFINS v11 - Resgate NÃO TRIBUTA'),
    ('2026-03-31',  16736.34, 'Resgate Depósito Garantia',                                            'CONCILIADO',  'Planilha PIS/COFINS v11 - Resgate TRIBUTÁVEL'),
    ('2026-03-31', 102556.43, 'Resgate Depósito Garantia',                                            'CONCILIADO',  'Planilha PIS/COFINS v11 - Resgate TRIBUTÁVEL'),
    ('2026-03-31', 196994.31, 'Resgate Depósito Garantia',                                            'INVESTIMENTO','Planilha PIS/COFINS v11 - Resgate NÃO TRIBUTA'),
    ('2026-03-31', 430496.43, 'TED-Crédito em Conta — 070 0380 01786029000103 GOVERNO DO EST',       'CONCILIADO',  'DETRAN-TO — Pagamento referente Fev/2026 — TRIBUTÁVEL'),
]

def main():
    print(f"Montana — Importar Extratos Faltantes Assessoria Mar/26 [{datetime.now():%Y-%m-%d %H:%M:%S}]")
    print(f"DB: {DB_PATH}\n")

    if not os.path.exists(DB_PATH):
        print(f"ERRO: banco não encontrado: {DB_PATH}")
        return

    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=8000")

    # Garante coluna obs em extratos (pode não existir)
    try:
        conn.execute("ALTER TABLE extratos ADD COLUMN obs TEXT DEFAULT ''")
        conn.commit()
    except: pass

    sql = """
        INSERT OR IGNORE INTO extratos
          (mes, data, data_iso, tipo, historico, credito, debito,
           status_conciliacao, obs, created_at, updated_at)
        VALUES (?, ?, ?, 'C', ?, ?, NULL, ?, ?, datetime('now'), datetime('now'))
    """

    importados = 0
    ignorados  = 0
    total_val  = 0.0

    conn.execute("BEGIN")
    for data_iso, credito, historico, status, obs in LANCAMENTOS:
        partes = data_iso.split('-')
        data_br_val = f"{partes[2]}/{partes[1]}/{partes[0]}"
        mes_val = mes_str(data_iso)
        r = conn.execute(sql, (mes_val, data_br_val, data_iso, historico, credito, status, obs))
        if r.rowcount:
            importados += 1
            total_val  += credito
            print(f"  ✅ {data_iso} | R${credito:>12,.2f} | {status:<12} | {historico[:55]}")
        else:
            ignorados += 1
            print(f"  ⏭️  {data_iso} | R${credito:>12,.2f} | já existe")
    conn.commit()

    print(f"\n{'='*60}")
    print(f"  Importados: {importados} | Já existiam: {ignorados}")
    print(f"  Total importado: R${total_val:,.2f}")

    # Resumo pós-importação
    row = conn.execute("""
        SELECT COUNT(*) cnt, COALESCE(SUM(credito),0) total
        FROM extratos WHERE data_iso LIKE '2026-03%' AND credito > 0
    """).fetchone()
    print(f"  Extratos crédito mar/26 agora: {row[0]} | R${row[1]:,.2f}")
    print(f"  (Planilha: 133 | R$9.713.526,90 | R$430.496,43 = DETRAN Fev/2026 TRIBUTÁVEL)")
    conn.close()
    print("\nConcluído.")

if __name__ == '__main__':
    main()
