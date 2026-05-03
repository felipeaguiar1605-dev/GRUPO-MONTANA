#!/usr/bin/env python3
"""
Montana Segurança — Importar Extratos BRB Março/2026
Executa no servidor: python3 scripts/importar_brb_seguranca_202603.py

Origem: 5 PDFs BRB (extrato_2..6) + extrato.pdf
Conta BRB: Agência 031 — Conta 031.015.474-0
Todos os créditos são INVESTIMENTO (CDB/RDB/FI BRB) — NÃO TRIBUTÁVEIS.
Usa INSERT OR IGNORE — seguro rodar múltiplas vezes.
"""

import sqlite3, os
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH  = os.path.join(BASE_DIR, 'data', 'seguranca', 'montana.db')

MESES = ['','Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez']

def mes_str(data_iso):
    p = data_iso.split('-')
    return f"{MESES[int(p[1])]}/{p[0]}" if len(p) == 3 else ''

# Créditos BRB Março/2026 — extraídos do extrato_6.pdf
# Todos classificados como INVESTIMENTO (resgates CDB/RDB/FI BRB)
LANCAMENTOS_CREDITO = [
    # data_iso, credito, historico, status_conciliacao
    ('2026-03-02',  47500.00, 'RESGATE CDB/RDB – DOC: 000000 — BRB 031.015.474-0',           'INVESTIMENTO'),
    ('2026-03-03',  50000.00, 'RESGATE CDB/RDB – DOC: 000000 — BRB 031.015.474-0',           'INVESTIMENTO'),
    ('2026-03-03',  47500.00, 'RESGATE CDB/RDB – DOC: 000000 — BRB 031.015.474-0',           'INVESTIMENTO'),
    ('2026-03-05', 120000.00, 'RESG FI BRB FEDERAL INVEST – DOC: 160512 — BRB 031.015.474-0', 'INVESTIMENTO'),
    ('2026-03-06',      6.12, 'CRED JUROS LIQUIDO CDB AUTOMAT – BRB 031.015.474-0',           'INVESTIMENTO'),
    ('2026-03-06', 320000.00, 'RESGATE CDB/RDB – DOC: 000000 — BRB 031.015.474-0',           'INVESTIMENTO'),
    ('2026-03-09',     19.21, 'CRED JUROS LIQUIDO CDB AUTOMAT – BRB 031.015.474-0',           'INVESTIMENTO'),
    ('2026-03-09',  20000.00, 'RESG FI BRB FEDERAL INVEST – DOC: 160508 — BRB 031.015.474-0', 'INVESTIMENTO'),
    ('2026-03-23', 523785.55, 'RESGATE CDB/RDB – DOC: 000000 — BRB 031.015.474-0',           'INVESTIMENTO'),
    ('2026-03-24',  50000.01, 'RESGATE CDB/RDB – DOC: 000000 — BRB 031.015.474-0',           'INVESTIMENTO'),
    ('2026-03-26', 300000.00, 'RESGATE CDB/RDB – DOC: 000000 — BRB 031.015.474-0',           'INVESTIMENTO'),
]

def main():
    print(f"Montana Segurança — Importar BRB Mar/26 [{datetime.now():%Y-%m-%d %H:%M:%S}]")
    print(f"DB: {DB_PATH}\n")

    if not os.path.exists(DB_PATH):
        print(f"ERRO: banco não encontrado: {DB_PATH}")
        return

    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=8000")

    try:
        conn.execute("ALTER TABLE extratos ADD COLUMN obs TEXT DEFAULT ''")
        conn.commit()
    except: pass

    sql = """
        INSERT OR IGNORE INTO extratos
          (mes, data, data_iso, tipo, historico, credito, debito, banco,
           status_conciliacao, obs, created_at, updated_at)
        VALUES (?, ?, ?, 'C', ?, ?, NULL, 'BRB', ?, ?, datetime('now'), datetime('now'))
    """

    importados = 0
    ignorados  = 0
    total_val  = 0.0

    conn.execute("BEGIN")
    for data_iso, credito, historico, status in LANCAMENTOS_CREDITO:
        partes = data_iso.split('-')
        data_br_val = f"{partes[2]}/{partes[1]}/{partes[0]}"
        mes_val = mes_str(data_iso)
        obs = f"BRB extrato_6.pdf — {historico[:40]}"
        r = conn.execute(sql, (mes_val, data_br_val, data_iso, historico, credito, status, obs))
        if r.rowcount:
            importados += 1
            total_val  += credito
            print(f"  ✅ {data_iso} | R${credito:>12,.2f} | {status:<12} | {historico[:50]}")
        else:
            ignorados += 1
            print(f"  ⏭️  {data_iso} | R${credito:>12,.2f} | já existe")
    conn.commit()

    print(f"\n{'='*65}")
    print(f"  Importados: {importados} | Já existiam: {ignorados}")
    print(f"  Total BRB importado: R${total_val:,.2f}")
    print(f"  Classificação: todos INVESTIMENTO (NÃO TRIBUTA para PIS/COFINS)")

    row = conn.execute("""
        SELECT COUNT(*) cnt, COALESCE(SUM(credito),0) total
        FROM extratos WHERE data_iso LIKE '2026-03%' AND banco = 'BRB' AND credito > 0
    """).fetchone()
    print(f"  BRB créditos mar/26 agora: {row[0]} | R${row[1]:,.2f}")
    conn.close()
    print("\nConcluído.")

if __name__ == '__main__':
    main()
