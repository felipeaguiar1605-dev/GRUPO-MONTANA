#!/usr/bin/env python3
"""
Montana Intelligence — MCP Server (FastAPI, porta 8001)
Analytics e inteligencia cruzada para o sistema Montana multi-empresa.

Uso:
    python3 server.py --port 8001
    pm2 start server.py --interpreter python3 --name montana-intelligence -- --port 8001
"""
import argparse
import os
import sqlite3
from datetime import date, datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

# ── Paths ──────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"

EMPRESAS = {
    "assessoria": {
        "nome": "Montana Assessoria Empresarial LTDA",
        "cnpj": "14.092.519/0001-51",
    },
    "seguranca": {
        "nome": "Montana Seguranca Privada LTDA",
        "cnpj": "19.200.109/0001-09",
    },
    "portodovau": {
        "nome": "Porto do Vau Seguranca Privada LTDA",
        "cnpj": "41.034.574/0001-68",
    },
    "mustang": {
        "nome": "Mustang Gestao Empresarial LTDA",
        "cnpj": "26.600.137/0001-70",
    },
}

START_TIME = datetime.now()

# ── FastAPI app ────────────────────────────────────────────────────
app = FastAPI(
    title="Montana Intelligence",
    description="Analytics e inteligencia cruzada — Grupo Montana",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3002",
        "http://127.0.0.1:3002",
        "http://104.196.22.170:3002",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Helpers ────────────────────────────────────────────────────────
def get_db(empresa: str) -> sqlite3.Connection:
    """Retorna conexao SQLite para a empresa."""
    if empresa not in EMPRESAS:
        raise HTTPException(status_code=400, detail=f"Empresa invalida: {empresa}")
    db_path = DATA_DIR / empresa / "montana.db"
    if not db_path.exists():
        raise HTTPException(status_code=404, detail=f"Banco nao encontrado: {empresa}")
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def rows_to_dicts(rows) -> list[dict]:
    return [dict(r) for r in rows]


def safe_query(conn, sql, params=()) -> list[dict]:
    """Executa query e retorna lista de dicts. Retorna [] se a tabela nao existir."""
    try:
        return rows_to_dicts(conn.execute(sql, params).fetchall())
    except sqlite3.OperationalError:
        return []


def current_year() -> int:
    return date.today().year


# ── Modelos Pydantic ───────────────────────────────────────────────
class SaudeResponse(BaseModel):
    ok: bool
    versao: str
    uptime_s: float
    empresas: int
    bancos_disponiveis: list[str]


class ResumoEmpresa(BaseModel):
    empresa: str
    nome: str
    cnpj: str
    contratos: int
    faturamento_bruto: float
    despesas_total: float
    resultado: float
    funcionarios_ativos: int
    pendentes_conciliacao: int
    certidoes_vencidas: int


# ── Rotas ──────────────────────────────────────────────────────────


@app.get("/saude", response_model=SaudeResponse)
def health_check():
    """Health check — usado por deploy.bat e monitoramento."""
    bancos = []
    for key in EMPRESAS:
        db_path = DATA_DIR / key / "montana.db"
        if db_path.exists():
            bancos.append(key)
    uptime = (datetime.now() - START_TIME).total_seconds()
    return SaudeResponse(
        ok=True,
        versao="1.0.0",
        uptime_s=round(uptime, 1),
        empresas=len(EMPRESAS),
        bancos_disponiveis=bancos,
    )


@app.get("/api/consolidado")
def consolidado_geral(ano: int = Query(default=None)):
    """Visao consolidada de todas as empresas (receita, despesa, resultado, headcount)."""
    ano = ano or current_year()
    from_date = f"{ano}-01-01"
    to_date = f"{ano}-12-31"
    resultado = {}

    for key, info in EMPRESAS.items():
        db_path = DATA_DIR / key / "montana.db"
        if not db_path.exists():
            resultado[key] = {"nome": info["nome"], "erro": "banco nao encontrado"}
            continue
        try:
            conn = get_db(key)
            ext = dict(conn.execute(
                "SELECT COUNT(*) cnt, COALESCE(SUM(credito),0) entradas, "
                "COALESCE(SUM(debito),0) saidas "
                "FROM extratos WHERE data_iso>=? AND data_iso<=?",
                (from_date, to_date),
            ).fetchone())
            nfs = dict(conn.execute(
                "SELECT COUNT(*) cnt, COALESCE(SUM(valor_bruto),0) bruto, "
                "COALESCE(SUM(valor_liquido),0) liquido, COALESCE(SUM(retencao),0) ret "
                "FROM notas_fiscais WHERE data_emissao>=? AND data_emissao<=?",
                (from_date, to_date),
            ).fetchone())
            desp = dict(conn.execute(
                "SELECT COALESCE(SUM(valor_bruto),0) total "
                "FROM despesas WHERE data_iso>=? AND data_iso<=?",
                (from_date, to_date),
            ).fetchone())
            pend = dict(conn.execute(
                "SELECT COUNT(*) cnt FROM extratos WHERE status_conciliacao='PENDENTE'"
            ).fetchone())
            funcs = dict(conn.execute(
                "SELECT COUNT(*) cnt FROM rh_funcionarios WHERE status='ATIVO'"
            ).fetchone())
            certs = safe_query(conn,
                "SELECT COUNT(*) cnt FROM certidoes WHERE status='vencida'")
            certs_venc = certs[0]["cnt"] if certs else 0
            contratos_row = dict(conn.execute(
                "SELECT COUNT(*) cnt FROM contratos").fetchone())

            resultado[key] = {
                "nome": info["nome"],
                "cnpj": info["cnpj"],
                "contratos": contratos_row["cnt"],
                "extratos_total": ext["cnt"],
                "entradas": round(ext["entradas"], 2),
                "saidas": round(ext["saidas"], 2),
                "nfs_total": nfs["cnt"],
                "faturamento_bruto": round(nfs["bruto"], 2),
                "faturamento_liquido": round(nfs["liquido"], 2),
                "retencoes": round(nfs["ret"], 2),
                "despesas_total": round(desp["total"], 2),
                "resultado": round(nfs["bruto"] - desp["total"], 2),
                "funcionarios_ativos": funcs["cnt"],
                "pendentes_conciliacao": pend["cnt"],
                "certidoes_vencidas": certs_venc,
            }
            conn.close()
        except Exception as e:
            resultado[key] = {"nome": info["nome"], "erro": str(e)}

    totais = {
        "faturamento_bruto": 0, "despesas_total": 0, "resultado": 0,
        "funcionarios_ativos": 0, "pendentes_conciliacao": 0,
    }
    for v in resultado.values():
        if "erro" not in v:
            for campo in totais:
                totais[campo] += v.get(campo, 0)
    totais["faturamento_bruto"] = round(totais["faturamento_bruto"], 2)
    totais["despesas_total"] = round(totais["despesas_total"], 2)
    totais["resultado"] = round(totais["resultado"], 2)

    return {"ok": True, "ano": ano, "empresas": resultado, "totais": totais}


@app.get("/api/fluxo-caixa/{empresa}")
def fluxo_caixa(empresa: str, meses: int = Query(default=12, ge=1, le=36)):
    """Fluxo de caixa mensal (entradas x saidas) — ultimos N meses."""
    conn = get_db(empresa)
    rows = safe_query(conn,
        "SELECT substr(data_iso,1,7) AS mes, "
        "SUM(credito) AS entradas, SUM(debito) AS saidas, "
        "SUM(credito)-SUM(debito) AS saldo "
        "FROM extratos WHERE data_iso != '' "
        "GROUP BY substr(data_iso,1,7) "
        "ORDER BY mes DESC LIMIT ?", (meses,))
    conn.close()
    rows.reverse()
    return {"ok": True, "empresa": empresa, "fluxo": rows}


@app.get("/api/receita-por-contrato/{empresa}")
def receita_por_contrato(empresa: str, ano: int = Query(default=None)):
    """Receita (NFs) agrupada por contrato no ano."""
    ano = ano or current_year()
    conn = get_db(empresa)
    rows = safe_query(conn,
        "SELECT contrato_ref, COUNT(*) AS qtd_nfs, "
        "SUM(valor_bruto) AS bruto, SUM(valor_liquido) AS liquido, "
        "SUM(retencao) AS retencoes "
        "FROM notas_fiscais "
        "WHERE data_emissao BETWEEN ? AND ? "
        "GROUP BY contrato_ref ORDER BY bruto DESC",
        (f"{ano}-01-01", f"{ano}-12-31"))
    conn.close()
    return {"ok": True, "empresa": empresa, "ano": ano, "contratos": rows}


@app.get("/api/despesas-por-categoria/{empresa}")
def despesas_por_categoria(empresa: str, ano: int = Query(default=None)):
    """Despesas agrupadas por categoria no ano."""
    ano = ano or current_year()
    conn = get_db(empresa)
    rows = safe_query(conn,
        "SELECT categoria, centro_custo, COUNT(*) AS qtd, "
        "SUM(valor_bruto) AS total_bruto, SUM(valor_liquido) AS total_liquido "
        "FROM despesas WHERE data_iso BETWEEN ? AND ? "
        "GROUP BY categoria, centro_custo ORDER BY total_bruto DESC",
        (f"{ano}-01-01", f"{ano}-12-31"))
    conn.close()
    return {"ok": True, "empresa": empresa, "ano": ano, "categorias": rows}


@app.get("/api/lucro-por-contrato/{empresa}")
def lucro_por_contrato(empresa: str, ano: int = Query(default=None)):
    """Margem de lucro por contrato: receita - despesas diretas - rateio overhead."""
    ano = ano or current_year()
    from_date, to_date = f"{ano}-01-01", f"{ano}-12-31"
    conn = get_db(empresa)

    # Receita por contrato
    receitas = safe_query(conn,
        "SELECT contrato_ref, SUM(valor_bruto) AS receita_bruta, "
        "SUM(valor_liquido) AS receita_liquida "
        "FROM notas_fiscais WHERE data_emissao BETWEEN ? AND ? "
        "GROUP BY contrato_ref", (from_date, to_date))

    # Despesas diretas por contrato
    desp_diretas = safe_query(conn,
        "SELECT contrato_ref, SUM(valor_bruto) AS despesa "
        "FROM despesas WHERE data_iso BETWEEN ? AND ? "
        "AND contrato_ref != '' AND centro_custo NOT IN ('ESCRITORIO','DIVIDENDOS') "
        "GROUP BY contrato_ref", (from_date, to_date))

    # Overhead (escritorio) para rateio
    overhead = safe_query(conn,
        "SELECT COALESCE(SUM(valor_bruto),0) AS total "
        "FROM despesas WHERE data_iso BETWEEN ? AND ? "
        "AND centro_custo='ESCRITORIO'", (from_date, to_date))
    overhead_total = overhead[0]["total"] if overhead else 0

    conn.close()

    # Monta resultado
    desp_map = {d["contrato_ref"]: d["despesa"] for d in desp_diretas}
    receita_total = sum(r["receita_bruta"] for r in receitas) or 1

    resultado = []
    for r in receitas:
        ref = r["contrato_ref"]
        rec = r["receita_bruta"] or 0
        desp = desp_map.get(ref, 0)
        peso = rec / receita_total
        rateio = round(overhead_total * peso, 2)
        lucro = round(rec - desp - rateio, 2)
        margem = round((lucro / rec * 100) if rec else 0, 1)
        resultado.append({
            "contrato": ref,
            "receita_bruta": round(rec, 2),
            "despesa_direta": round(desp, 2),
            "rateio_overhead": rateio,
            "lucro": lucro,
            "margem_pct": margem,
        })
    resultado.sort(key=lambda x: x["lucro"], reverse=True)
    return {"ok": True, "empresa": empresa, "ano": ano, "contratos": resultado}


@app.get("/api/headcount/{empresa}")
def headcount(empresa: str):
    """Headcount ativo: funcionarios por contrato/cargo com custo salarial."""
    conn = get_db(empresa)
    rows = safe_query(conn,
        "SELECT f.contrato_ref, c.nome AS cargo, COUNT(*) AS qtd, "
        "SUM(f.salario_base) AS custo_mensal "
        "FROM rh_funcionarios f "
        "LEFT JOIN rh_cargos c ON c.id = f.cargo_id "
        "WHERE f.status='ATIVO' "
        "GROUP BY f.contrato_ref, c.nome ORDER BY qtd DESC")
    total = safe_query(conn,
        "SELECT COUNT(*) AS total, SUM(salario_base) AS custo "
        "FROM rh_funcionarios WHERE status='ATIVO'")
    conn.close()
    return {
        "ok": True, "empresa": empresa, "detalhes": rows,
        "total_ativos": total[0]["total"] if total else 0,
        "custo_mensal": round(total[0]["custo"] or 0, 2) if total else 0,
    }


@app.get("/api/alertas/{empresa}")
def alertas(empresa: str):
    """Alertas ativos: certidoes vencidas, contratos vencendo, pendencias."""
    conn = get_db(empresa)
    hoje = date.today().isoformat()
    em_30d = date.today().replace(day=28)  # simplificado

    items = []

    # Certidoes vencidas ou vencendo
    certs = safe_query(conn,
        "SELECT tipo, data_validade, status FROM certidoes "
        "WHERE status='vencida' OR data_validade<=? ORDER BY data_validade",
        (hoje,))
    for c in certs:
        items.append({
            "tipo": "certidao_vencida",
            "gravidade": "alta",
            "mensagem": f"Certidao {c['tipo']} vencida em {c['data_validade']}",
        })

    # Contratos vencendo em 60 dias
    contratos_venc = safe_query(conn,
        "SELECT numContrato, contrato, vigencia_fim FROM contratos "
        "WHERE vigencia_fim != '' AND vigencia_fim BETWEEN ? AND date(?,'+60 days')",
        (hoje, hoje))
    for ct in contratos_venc:
        items.append({
            "tipo": "contrato_vencendo",
            "gravidade": "media",
            "mensagem": f"Contrato {ct['numContrato']} vence em {ct['vigencia_fim']}",
        })

    # Pendencias de conciliacao (mais de 50)
    pend = safe_query(conn,
        "SELECT COUNT(*) cnt FROM extratos WHERE status_conciliacao='PENDENTE'")
    pend_cnt = pend[0]["cnt"] if pend else 0
    if pend_cnt > 50:
        items.append({
            "tipo": "conciliacao_pendente",
            "gravidade": "media",
            "mensagem": f"{pend_cnt} lancamentos bancarios pendentes de conciliacao",
        })

    conn.close()
    return {"ok": True, "empresa": empresa, "alertas": items, "total": len(items)}


@app.get("/api/evolucao-mensal/{empresa}")
def evolucao_mensal(empresa: str, meses: int = Query(default=6, ge=1, le=24)):
    """Evolucao mensal: receita, despesa e resultado nos ultimos N meses."""
    conn = get_db(empresa)

    receitas = safe_query(conn,
        "SELECT substr(data_emissao,1,7) AS mes, "
        "SUM(valor_bruto) AS receita, SUM(retencao) AS retencoes "
        "FROM notas_fiscais WHERE data_emissao!='' "
        "GROUP BY mes ORDER BY mes DESC LIMIT ?", (meses,))

    despesas = safe_query(conn,
        "SELECT substr(data_iso,1,7) AS mes, SUM(valor_bruto) AS despesa "
        "FROM despesas WHERE data_iso!='' "
        "GROUP BY mes ORDER BY mes DESC LIMIT ?", (meses,))

    conn.close()

    desp_map = {d["mes"]: d["despesa"] for d in despesas}
    evolucao = []
    for r in reversed(receitas):
        mes = r["mes"]
        rec = r["receita"] or 0
        desp = desp_map.get(mes, 0) or 0
        evolucao.append({
            "mes": mes,
            "receita": round(rec, 2),
            "retencoes": round(r["retencoes"] or 0, 2),
            "despesa": round(desp, 2),
            "resultado": round(rec - desp, 2),
        })

    return {"ok": True, "empresa": empresa, "evolucao": evolucao}


@app.get("/api/conciliacao-resumo/{empresa}")
def conciliacao_resumo(empresa: str):
    """Resumo do status de conciliacao bancaria."""
    conn = get_db(empresa)
    rows = safe_query(conn,
        "SELECT status_conciliacao, COUNT(*) AS qtd, "
        "COALESCE(SUM(credito),0) AS creditos, COALESCE(SUM(debito),0) AS debitos "
        "FROM extratos GROUP BY status_conciliacao")
    conn.close()
    return {"ok": True, "empresa": empresa, "resumo": rows}


@app.get("/api/retencoes/{empresa}")
def retencoes(empresa: str, ano: int = Query(default=None)):
    """Retencoes tributarias por tipo no ano."""
    ano = ano or current_year()
    conn = get_db(empresa)
    rows = safe_query(conn,
        "SELECT "
        "SUM(inss) AS inss, SUM(ir) AS ir, SUM(iss) AS iss, "
        "SUM(csll) AS csll, SUM(pis) AS pis, SUM(cofins) AS cofins, "
        "SUM(retencao) AS total_retencao, COUNT(*) AS qtd_nfs "
        "FROM notas_fiscais WHERE data_emissao BETWEEN ? AND ?",
        (f"{ano}-01-01", f"{ano}-12-31"))
    conn.close()
    dados = rows[0] if rows else {}
    return {"ok": True, "empresa": empresa, "ano": ano, "retencoes": dados}


# ── Main ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Montana Intelligence — MCP Server")
    parser.add_argument("--port", type=int, default=8001, help="Porta (default: 8001)")
    parser.add_argument("--host", default="0.0.0.0", help="Host (default: 0.0.0.0)")
    args = parser.parse_args()

    print(f"\n  Montana Intelligence rodando em http://{args.host}:{args.port}")
    print(f"  Health: http://{args.host}:{args.port}/saude\n")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
