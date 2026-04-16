#!/usr/bin/env python3
"""
Montana Intelligence — ETL
Verifica e prepara os bancos SQLite para o servidor de analytics.
Cria views materializadas e indices otimizados para consultas cruzadas.
"""
import os
import sys
import sqlite3
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"

EMPRESAS = {
    "assessoria": "Montana Assessoria Empresarial LTDA",
    "seguranca":  "Montana Seguranca Privada LTDA",
    "portodovau": "Porto do Vau Seguranca Privada LTDA",
    "mustang":    "Mustang Gestao Empresarial LTDA",
}

# Views otimizadas para analytics
ANALYTICS_VIEWS = [
    # Resumo mensal de receitas por contrato
    """
    CREATE VIEW IF NOT EXISTS vw_receita_mensal AS
    SELECT
        contrato_ref,
        substr(data_emissao, 1, 7) AS mes,
        COUNT(*)                   AS qtd_nfs,
        SUM(valor_bruto)           AS receita_bruta,
        SUM(valor_liquido)         AS receita_liquida,
        SUM(retencao)              AS retencoes
    FROM notas_fiscais
    WHERE data_emissao != ''
    GROUP BY contrato_ref, substr(data_emissao, 1, 7)
    """,
    # Resumo mensal de despesas por categoria
    """
    CREATE VIEW IF NOT EXISTS vw_despesa_mensal AS
    SELECT
        categoria,
        centro_custo,
        contrato_ref,
        substr(data_iso, 1, 7)     AS mes,
        COUNT(*)                   AS qtd,
        SUM(valor_bruto)           AS total_bruto,
        SUM(total_retencao)        AS retencoes,
        SUM(valor_liquido)         AS total_liquido
    FROM despesas
    WHERE data_iso != ''
    GROUP BY categoria, centro_custo, contrato_ref, substr(data_iso, 1, 7)
    """,
    # Fluxo de caixa mensal (entradas vs saidas)
    """
    CREATE VIEW IF NOT EXISTS vw_fluxo_caixa AS
    SELECT
        substr(data_iso, 1, 7)     AS mes,
        SUM(credito)               AS entradas,
        SUM(debito)                AS saidas,
        SUM(credito) - SUM(debito) AS saldo_mes,
        COUNT(*)                   AS movimentacoes
    FROM extratos
    WHERE data_iso != ''
    GROUP BY substr(data_iso, 1, 7)
    """,
    # Headcount ativo por contrato
    """
    CREATE VIEW IF NOT EXISTS vw_headcount AS
    SELECT
        contrato_ref,
        c.nome AS cargo,
        COUNT(*)              AS qtd,
        SUM(f.salario_base)   AS custo_salarios
    FROM rh_funcionarios f
    LEFT JOIN rh_cargos c ON c.id = f.cargo_id
    WHERE f.status = 'ATIVO'
    GROUP BY contrato_ref, c.nome
    """,
]

# Indices extras para performance de analytics
ANALYTICS_INDICES = [
    "CREATE INDEX IF NOT EXISTS idx_nfs_mes     ON notas_fiscais(substr(data_emissao,1,7))",
    "CREATE INDEX IF NOT EXISTS idx_desp_mes    ON despesas(substr(data_iso,1,7))",
    "CREATE INDEX IF NOT EXISTS idx_ext_mes     ON extratos(substr(data_iso,1,7))",
]


def processar_empresa(key: str, nome: str) -> dict:
    """Processa ETL para uma empresa."""
    db_path = DATA_DIR / key / "montana.db"
    if not db_path.exists():
        return {"empresa": key, "status": "skip", "motivo": "banco nao encontrado"}

    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")

    criadas = 0
    erros = []

    for sql in ANALYTICS_VIEWS:
        try:
            conn.execute(sql)
            criadas += 1
        except sqlite3.Error as e:
            erros.append(str(e))

    for sql in ANALYTICS_INDICES:
        try:
            conn.execute(sql)
        except sqlite3.Error as e:
            erros.append(str(e))

    conn.commit()

    # Coleta estatisticas
    stats = {}
    for tabela in ["contratos", "extratos", "notas_fiscais", "despesas",
                    "rh_funcionarios", "certidoes", "licitacoes"]:
        try:
            row = conn.execute(f"SELECT COUNT(*) FROM {tabela}").fetchone()
            stats[tabela] = row[0]
        except sqlite3.Error:
            stats[tabela] = -1

    conn.close()
    return {
        "empresa": key,
        "nome": nome,
        "status": "ok",
        "views_criadas": criadas,
        "erros": erros,
        "stats": stats,
    }


def main():
    print("=" * 60)
    print("  Montana Intelligence — ETL")
    print("=" * 60)
    print(f"  Data dir: {DATA_DIR}")
    print()

    resultados = []
    for key, nome in EMPRESAS.items():
        print(f"  Processando [{key}]...", end=" ")
        r = processar_empresa(key, nome)
        resultados.append(r)
        if r["status"] == "ok":
            total = sum(v for v in r["stats"].values() if v >= 0)
            print(f"OK ({total} registros, {r['views_criadas']} views)")
        else:
            print(f"SKIP — {r['motivo']}")

    ok_count = sum(1 for r in resultados if r["status"] == "ok")
    print()
    print(f"  Concluido: {ok_count}/{len(EMPRESAS)} empresas processadas")
    print("=" * 60)
    return resultados


if __name__ == "__main__":
    main()
