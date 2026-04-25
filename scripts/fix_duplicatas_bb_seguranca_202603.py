#!/usr/bin/env python3
"""
Montana Segurança — Fix Duplicatas BB Março/2026
Executa no servidor: python3 scripts/fix_duplicatas_bb_seguranca_202603.py

Problema identificado: 93 créditos CONCILIADO = 49 únicos duplicados.
Cada lançamento aparece 2x (importação manual + importação OFX).
O registro com ID menor (importação original) é mantido; o mais novo removido.
"""

import sqlite3, os
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH  = os.path.join(BASE_DIR, 'data', 'seguranca', 'montana.db')

def main():
    print(f"Montana Segurança — Fix Duplicatas BB Mar/26 [{datetime.now():%Y-%m-%d %H:%M:%S}]")
    print(f"DB: {DB_PATH}\n")

    if not os.path.exists(DB_PATH):
        print(f"ERRO: banco não encontrado: {DB_PATH}")
        return

    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=8000")
    conn.row_factory = sqlite3.Row

    # Identificar grupos duplicados (mesmo data_iso + credito)
    grupos = conn.execute("""
        SELECT data_iso, credito,
               COUNT(*) as cnt,
               MIN(id) as id_manter,
               MAX(id) as id_remover
        FROM extratos
        WHERE data_iso LIKE '2026-03%'
          AND credito > 0
          AND status_conciliacao IN ('CONCILIADO','PENDENTE','INTERNO','INVESTIMENTO')
          AND (banco IS NULL OR banco = 'BB')
        GROUP BY data_iso, credito
        HAVING cnt > 1
    """).fetchall()

    print(f"Grupos duplicados encontrados: {len(grupos)}\n")

    removidos = 0
    conn.execute("BEGIN")
    for g in grupos:
        # Verificar que ambos existem e são realmente duplicatas
        registros = conn.execute(
            "SELECT id, historico, status_conciliacao FROM extratos WHERE data_iso=? AND credito=? AND (banco IS NULL OR banco='BB') ORDER BY id",
            (g['data_iso'], g['credito'])
        ).fetchall()

        if len(registros) < 2:
            continue

        # Manter o primeiro (menor ID), remover os demais
        id_manter = registros[0]['id']
        for reg in registros[1:]:
            conn.execute("DELETE FROM extratos WHERE id=?", (reg['id'],))
            removidos += 1
            print(f"  ✅ Removido id={reg['id']} | {g['data_iso']} | R${g['credito']:>10,.2f} | Mantido id={id_manter}")

    conn.commit()

    print(f"\n{'='*60}")
    print(f"  Total removidos: {removidos}")

    # Verificação pós-limpeza
    r = conn.execute("""
        SELECT COUNT(*), COALESCE(SUM(credito),0)
        FROM extratos
        WHERE data_iso LIKE '2026-03%' AND credito > 0
          AND status_conciliacao = 'CONCILIADO'
          AND (banco IS NULL OR banco = 'BB')
    """).fetchone()
    print(f"  Créditos CONCILIADO BB mar/26 após limpeza: {r[0]} | R${r[1]:,.2f}")

    conn.close()
    print("\nConcluído.")

if __name__ == '__main__':
    main()
