#!/usr/bin/env python3
"""
Montana — Limpeza de NFs duplicadas na Assessoria
Executa no servidor: python3 scripts/fix_nfs_duplicadas_assessoria.py

Remove duplicatas identificadas no teste de abril:
  NF 202600000000301 (SEDUC)  id=716 mantém / id=717 remove
  NF 202600000000347 (DETRAN) id=767 mantém / id=8638 remove
"""

import sqlite3
import os
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH  = os.path.join(BASE_DIR, 'data', 'assessoria', 'montana.db')

DUPLICATAS = [
    # (numero_nf, id_manter, id_remover, descricao)
    ('202600000000301', 716, 717,  'SEDUC R$209.815,61'),
    ('202600000000347', 767, 8638, 'DETRAN R$5.039,00'),
]

def main():
    print(f"Montana — Fix NFs Duplicadas Assessoria [{datetime.now():%Y-%m-%d %H:%M:%S}]")
    print(f"DB: {DB_PATH}\n")

    if not os.path.exists(DB_PATH):
        print(f"ERRO: DB não encontrado: {DB_PATH}")
        return

    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=8000")
    conn.row_factory = sqlite3.Row

    for numero, id_manter, id_remover, desc in DUPLICATAS:
        print(f"── NF {numero} ({desc})")

        # Confirma situação atual
        rows = conn.execute(
            "SELECT id, status_conciliacao, valor_bruto FROM notas_fiscais WHERE numero=? ORDER BY id",
            (numero,)
        ).fetchall()

        if not rows:
            print(f"  ⚠️  NF não encontrada — pulando")
            continue

        ids_encontrados = [r['id'] for r in rows]
        print(f"  IDs encontrados: {ids_encontrados}")

        if len(rows) == 1:
            print(f"  ✅ Já existe apenas 1 registro — nada a fazer")
            continue

        if id_remover not in ids_encontrados:
            print(f"  ⚠️  ID {id_remover} não encontrado — pode já ter sido removido")
            continue

        # Confirma que o registro a manter está presente
        if id_manter not in ids_encontrados:
            print(f"  ⚠️  ID para manter ({id_manter}) não encontrado — abortando por segurança")
            continue

        # Remove a duplicata
        conn.execute("DELETE FROM notas_fiscais WHERE id=?", (id_remover,))
        conn.commit()
        print(f"  ✅ Removido id={id_remover} | Mantido id={id_manter}")

    print("\nVerificação pós-limpeza:")
    for numero, id_manter, id_remover, desc in DUPLICATAS:
        rows = conn.execute(
            "SELECT id, status_conciliacao FROM notas_fiscais WHERE numero=?",
            (numero,)
        ).fetchall()
        status = "✅ OK (1 registro)" if len(rows) == 1 else f"⚠️ {len(rows)} registros"
        print(f"  NF {numero}: {status}")

    conn.close()
    print("\nConcluído.")

if __name__ == '__main__':
    main()
