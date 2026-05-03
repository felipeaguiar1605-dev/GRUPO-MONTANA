#!/usr/bin/env python3
"""
Montana ERP — Migração Anti-Duplicação Fase 1
Executa direto no servidor: python3 scripts/migrate_dedup_fase1.py

Aplica índices UNIQUE e colunas de hash em todos os bancos Montana.
Seguro para rodar com o servidor ativo (usa WAL mode compatível).
"""

import sqlite3
import os
import sys
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EMPRESAS = {
    'seguranca':  os.path.join(BASE_DIR, 'data', 'seguranca',  'montana.db'),
    'assessoria': os.path.join(BASE_DIR, 'data', 'assessoria', 'montana.db'),
    'portodovau': os.path.join(BASE_DIR, 'data', 'portodovau', 'montana.db'),
    'mustang':    os.path.join(BASE_DIR, 'data', 'mustang',    'montana.db'),
}

MIGRATIONS = [
    # ── notas_fiscais ──────────────────────────────────────────────────────────
    ("notas_fiscais: índice UNIQUE numero",
     """CREATE UNIQUE INDEX IF NOT EXISTS idx_nfs_numero_unique
        ON notas_fiscais(numero)
        WHERE numero != '' AND numero != '0'"""),

    ("notas_fiscais: índice cnpj+data",
     "CREATE INDEX IF NOT EXISTS idx_nfs_cnpj_data ON notas_fiscais(cnpj_tomador, data_emissao)"),

    # ── extratos ───────────────────────────────────────────────────────────────
    ("extratos: coluna bb_hash",
     "ALTER TABLE extratos ADD COLUMN bb_hash TEXT DEFAULT ''"),

    ("extratos: coluna ofx_fitid",
     "ALTER TABLE extratos ADD COLUMN ofx_fitid TEXT DEFAULT ''"),

    ("extratos: índice UNIQUE bb_hash",
     """CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_bb_hash_unique
        ON extratos(bb_hash)
        WHERE bb_hash != '' AND bb_hash NOT LIKE '%_dup%'"""),

    ("extratos: índice UNIQUE ofx_fitid",
     """CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_ofx_fitid_unique
        ON extratos(ofx_fitid)
        WHERE ofx_fitid != ''"""),

    # ── rh_folha ───────────────────────────────────────────────────────────────
    ("rh_folha: índice UNIQUE competencia",
     "CREATE UNIQUE INDEX IF NOT EXISTS idx_rh_folha_competencia_unique ON rh_folha(competencia)"),

    ("rh_folha_itens: índice UNIQUE folha+funcionario",
     "CREATE UNIQUE INDEX IF NOT EXISTS idx_rh_folha_itens_uk ON rh_folha_itens(folha_id, funcionario_id)"),

    # ── despesas ───────────────────────────────────────────────────────────────
    ("despesas: coluna dedup_hash",
     "ALTER TABLE despesas ADD COLUMN dedup_hash TEXT DEFAULT ''"),

    ("despesas: índice UNIQUE dedup_hash",
     """CREATE UNIQUE INDEX IF NOT EXISTS idx_despesas_dedup_hash
        ON despesas(dedup_hash)
        WHERE dedup_hash != '' AND dedup_hash NOT LIKE '%_dup%'"""),

    # ── pagamentos ─────────────────────────────────────────────────────────────
    ("pagamentos: coluna hash_unico",
     "ALTER TABLE pagamentos ADD COLUMN hash_unico TEXT DEFAULT ''"),

    ("pagamentos: índice UNIQUE hash_unico",
     """CREATE UNIQUE INDEX IF NOT EXISTS idx_pagamentos_hash_unique
        ON pagamentos(hash_unico)
        WHERE hash_unico != '' AND hash_unico NOT LIKE '%_dup%'"""),

    # ── liquidacoes ────────────────────────────────────────────────────────────
    ("liquidacoes: coluna hash_unico",
     "ALTER TABLE liquidacoes ADD COLUMN hash_unico TEXT DEFAULT ''"),

    ("liquidacoes: índice UNIQUE hash_unico",
     """CREATE UNIQUE INDEX IF NOT EXISTS idx_liquidacoes_hash_unique
        ON liquidacoes(hash_unico)
        WHERE hash_unico != '' AND hash_unico NOT LIKE '%_dup%'"""),
]


def migrate_db(empresa, db_path):
    print(f"\n{'='*55}")
    print(f"  EMPRESA: {empresa.upper()}")
    print(f"  DB: {db_path}")
    print(f"{'='*55}")

    if not os.path.exists(db_path):
        print(f"  ⚠️  DB não encontrado — pulando")
        return False

    try:
        conn = sqlite3.connect(db_path, timeout=10)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=8000")
    except Exception as e:
        print(f"  ❌ Não conseguiu abrir: {e}")
        return False

    ok = 0
    skip = 0
    errors = []

    for desc, sql in MIGRATIONS:
        try:
            conn.execute(sql)
            conn.commit()
            print(f"  ✅ {desc}")
            ok += 1
        except sqlite3.OperationalError as e:
            msg = str(e)
            if any(x in msg for x in ('already exists', 'duplicate column')):
                print(f"  ⏭️  {desc} (já existe)")
                skip += 1
            else:
                print(f"  ❌ {desc}: {msg}")
                errors.append((desc, msg))

    conn.close()
    print(f"\n  Resultado: {ok} aplicadas | {skip} já existiam | {len(errors)} erros")

    if errors:
        for d, m in errors:
            print(f"    ⚠️  {d}: {m}")
        return False

    return True


def main():
    filtro = sys.argv[1].lower() if len(sys.argv) > 1 else 'todas'

    print(f"Montana ERP — Migração Fase 1 [{datetime.now():%Y-%m-%d %H:%M:%S}]")
    print(f"Anti-Duplicação: índices UNIQUE + colunas hash")
    if filtro != 'todas':
        print(f"Filtrando empresa: {filtro}")

    resultados = {}
    for empresa, db_path in EMPRESAS.items():
        if filtro not in ('todas', empresa):
            continue
        resultados[empresa] = migrate_db(empresa, db_path)

    print(f"\n{'='*55}")
    print("RESUMO FINAL")
    print(f"{'='*55}")
    for empresa, ok in resultados.items():
        status = "✅ OK" if ok else "❌ FALHOU"
        print(f"  {empresa:<15} {status}")

    todos_ok = all(resultados.values())
    if todos_ok:
        print("\n✅ Fase 1 concluída! Reinicie o servidor para ativar as proteções:")
        print("   pm2 restart montana")
    else:
        print("\n⚠️  Alguns bancos com erro. Verifique acima.")


if __name__ == '__main__':
    main()
