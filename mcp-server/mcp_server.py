#!/usr/bin/env python3
"""
Montana Pipeline — MCP Server (Remote/Cloud)
Versao para deploy no GCP VM. Roda como SSE server na porta 3010.
Conecta ao SQLite do ERP cloud em /opt/montana/app_unificado/data/.

Uso no servidor:
  MCP_API_KEY=chave-secreta python3 mcp_server.py

Equipe conecta via Claude Code:
  claude mcp add montana-cloud --transport sse --url http://104.196.22.170:3010/sse
"""
import json
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

from mcp.server.fastmcp import FastMCP

# ── Config ────────────────────────────────────────────────────────────
# No cloud, o DB fica dentro do app_unificado
APP_DIR = Path(os.environ.get("MONTANA_APP_DIR", "/opt/montana/app_unificado"))
CLOUD_URL = os.environ.get("MONTANA_CLOUD_URL", "http://localhost:3002")
MCP_PORT = int(os.environ.get("MCP_PORT", "3010"))

# Detecta automaticamente qual DB usar
def _find_db():
    """Procura o banco de dados SQLite mais relevante."""
    data_dir = APP_DIR / "data"
    sandbox = Path(__file__).parent / "data" / "sandbox.db"

    dbs = {}
    for emp in ["seguranca", "assessoria", "mustang", "portodovau"]:
        db_path = data_dir / emp / "montana.db"
        if db_path.exists():
            dbs[emp] = str(db_path)

    if sandbox.exists():
        dbs["sandbox"] = str(sandbox)

    return dbs

# ── MCP Server ────────────────────────────────────────────────────────
mcp = FastMCP(
    "Montana Cloud",
    instructions=(
        "Pipeline de conciliacao financeira do Grupo Montana (servidor cloud). "
        "Consulta dados das empresas seguranca e assessoria diretamente "
        "dos bancos de dados do ERP em producao."
    ),
    host="0.0.0.0",
    port=MCP_PORT,
)


# ── Helpers ───────────────────────────────────────────────────────────
def _get_conn(empresa: str):
    """Conecta ao banco da empresa no ERP cloud."""
    db_path = APP_DIR / "data" / empresa / "montana.db"
    if not db_path.exists():
        raise FileNotFoundError(f"DB nao encontrado: {db_path}")
    conn = sqlite3.connect(str(db_path), timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=15000")
    conn.row_factory = sqlite3.Row
    return conn


def _get_sandbox():
    """Conecta ao sandbox local (se existir)."""
    sandbox = Path(__file__).parent / "data" / "sandbox.db"
    if not sandbox.exists():
        return None
    conn = sqlite3.connect(str(sandbox), timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=15000")
    conn.row_factory = sqlite3.Row
    return conn


# ══════════════════════════════════════════════════════════════════════
# TOOLS — Consulta (read-only, seguro para equipe)
# ══════════════════════════════════════════════════════════════════════

@mcp.tool()
def status(empresa: str = "todas") -> str:
    """
    Status da conciliacao: totais, percentuais, pendentes por empresa.
    Empresas: seguranca, assessoria, todas.
    """
    empresas = ["seguranca", "assessoria"] if empresa == "todas" else [empresa]
    resultado = []

    for emp in empresas:
        try:
            conn = _get_conn(emp)
        except FileNotFoundError as e:
            resultado.append(f"{emp}: {e}")
            continue

        cur = conn.cursor()

        cur.execute(
            """SELECT status_conciliacao, count(*) FROM extratos
            WHERE substr(data_iso,1,4) >= '2024'
            GROUP BY status_conciliacao"""
        )
        statuses = dict(cur.fetchall())
        total = sum(statuses.values())
        conc = sum(v for k, v in statuses.items() if k not in (None, "", "PENDENTE"))
        pendentes = statuses.get("PENDENTE", 0) + statuses.get(None, 0) + statuses.get("", 0)
        pct = conc / total * 100 if total else 0

        cur.execute(
            """SELECT
                sum(CASE WHEN credito > 0 THEN credito ELSE 0 END) as total_creditos,
                sum(CASE WHEN debito > 0 THEN debito ELSE 0 END) as total_debitos,
                count(CASE WHEN credito > 0 AND status_conciliacao='CONCILIADO' THEN 1 END) as creditos_ok,
                count(CASE WHEN credito > 0 AND (status_conciliacao='PENDENTE' OR status_conciliacao IS NULL) THEN 1 END) as creditos_pend
            FROM extratos WHERE substr(data_iso,1,4) >= '2024'"""
        )
        fin = cur.fetchone()

        # Vinculacoes
        try:
            cur.execute(
                """SELECT count(*) FROM vinculacoes"""
            )
            vinc_total = cur.fetchone()[0]
        except sqlite3.OperationalError:
            vinc_total = 0

        resultado.append(
            f"{'='*50}\n"
            f"  {emp.upper()} (cloud)\n"
            f"{'='*50}\n"
            f"  Conciliacao: {pct:.1f}% ({conc}/{total})\n"
            f"  Pendentes: {pendentes}\n"
            f"  Creditos: R$ {fin[0] or 0:,.2f} ({fin[2] or 0} ok, {fin[3] or 0} pend)\n"
            f"  Debitos: R$ {fin[1] or 0:,.2f}\n"
            f"  Vinculacoes: {vinc_total}\n"
            f"  Status: {json.dumps(statuses, ensure_ascii=False)}"
        )
        conn.close()

    return "\n\n".join(resultado)


@mcp.tool()
def consultar_extratos(
    empresa: str = "assessoria",
    ano: str = "2026",
    status_filtro: str = "",
    limite: int = 50,
) -> str:
    """
    Consulta extratos bancarios do ERP cloud.
    Parametros:
      empresa: seguranca ou assessoria
      ano: ex: 2024, 2025, 2026
      status_filtro: CONCILIADO, PENDENTE, DESPESA, etc.
      limite: max registros (default 50)
    """
    conn = _get_conn(empresa)
    cur = conn.cursor()

    query = """SELECT data_iso, historico, credito, debito,
                status_conciliacao, contrato_vinculado, obs
            FROM extratos
            WHERE substr(data_iso,1,4)=?"""
    params: list = [ano]

    if status_filtro:
        query += " AND status_conciliacao=?"
        params.append(status_filtro)

    query += " ORDER BY data_iso DESC LIMIT ?"
    params.append(limite)

    cur.execute(query, params)
    rows = cur.fetchall()

    lines = [f"{empresa.upper()} — {len(rows)} registros (ano {ano}):"]
    for r in rows:
        tipo = "C" if (r[2] or 0) > 0 else "D"
        valor = r[2] if tipo == "C" else r[3]
        lines.append(
            f"  {r[0]} | {tipo} R$ {valor:>12,.2f} | {r[4] or 'PEND':12s} | "
            f"{(r[5] or '')[:30]:30s} | {(r[1] or '')[:50]}"
        )

    conn.close()
    return "\n".join(lines)


@mcp.tool()
def pendentes_cloud(empresa: str = "assessoria", tipo: str = "credito", limite: int = 30) -> str:
    """
    Lista creditos ou debitos PENDENTES no cloud.
    Parametros:
      empresa: seguranca ou assessoria
      tipo: credito ou debito
      limite: max registros
    """
    conn = _get_conn(empresa)
    cur = conn.cursor()

    col = "credito" if tipo == "credito" else "debito"
    cur.execute(
        f"""SELECT data_iso, historico, {col}, obs FROM extratos
        WHERE {col} > 0
        AND (status_conciliacao='PENDENTE' OR status_conciliacao IS NULL OR status_conciliacao='')
        AND substr(data_iso,1,4) >= '2024'
        ORDER BY {col} DESC LIMIT ?""",
        (limite,),
    )
    rows = cur.fetchall()

    lines = [f"{empresa.upper()} — {len(rows)} {tipo}s pendentes (cloud):"]
    for r in rows:
        lines.append(f"  {r[0]} | R$ {r[2]:>12,.2f} | {(r[1] or '')[:60]}")

    conn.close()
    return "\n".join(lines)


@mcp.tool()
def resumo_financeiro(empresa: str = "todas", ano: str = "2026") -> str:
    """
    Resumo financeiro mensal do cloud: creditos, debitos, saldo.
    Exclui INTERNO e INVESTIMENTO.
    """
    empresas = ["seguranca", "assessoria"] if empresa == "todas" else [empresa]
    resultado = []

    for emp in empresas:
        try:
            conn = _get_conn(emp)
        except FileNotFoundError as e:
            resultado.append(f"{emp}: {e}")
            continue

        cur = conn.cursor()
        cur.execute(
            """SELECT substr(data_iso,1,7) as mes,
                sum(CASE WHEN credito > 0 THEN credito ELSE 0 END) as cred,
                sum(CASE WHEN debito > 0 THEN debito ELSE 0 END) as deb,
                count(*) as mov
            FROM extratos
            WHERE substr(data_iso,1,4)=?
            AND (contrato_vinculado IS NULL OR contrato_vinculado NOT IN ('INVESTIMENTO', 'INTERNO'))
            GROUP BY mes ORDER BY mes""",
            (ano,),
        )
        rows = cur.fetchall()

        lines = [f"\n{'='*60}", f"  {emp.upper()} — Resumo {ano} (cloud)", f"{'='*60}"]
        total_cred = total_deb = 0
        for r in rows:
            cred = r[1] or 0
            deb = r[2] or 0
            total_cred += cred
            total_deb += deb
            lines.append(
                f"  {r[0]} | {r[3]:3d} mov | "
                f"cred R$ {cred:>12,.2f} | deb R$ {deb:>12,.2f} | "
                f"saldo R$ {cred - deb:>12,.2f}"
            )
        lines.append(f"  {'─'*56}")
        lines.append(
            f"  TOTAL  | cred R$ {total_cred:>12,.2f} | deb R$ {total_deb:>12,.2f} | "
            f"saldo R$ {total_cred - total_deb:>12,.2f}"
        )
        resultado.append("\n".join(lines))
        conn.close()

    return "\n".join(resultado)


@mcp.tool()
def consultar_conta_vinculada(conta: str = "", limite: int = 50) -> str:
    """
    Consulta conta vinculada no cloud (assessoria).
    Parametros:
      conta: numero da conta (vazio = todas)
      limite: max registros
    """
    conn = _get_conn("assessoria")
    cur = conn.cursor()

    query = "SELECT * FROM conta_vinculada"
    params: list = []

    if conta:
        query += " WHERE conta=?"
        params.append(conta)

    query += " ORDER BY data_iso DESC LIMIT ?"
    params.append(limite)

    try:
        cur.execute(query, params)
        rows = cur.fetchall()
    except sqlite3.OperationalError:
        conn.close()
        return "Tabela conta_vinculada nao existe ainda no cloud."

    cols = [d[0] for d in cur.description]
    lines = [f"CONTA VINCULADA — {len(rows)} registros (cloud):"]
    for r in rows:
        rd = dict(zip(cols, r))
        tipo = "C" if (rd.get("credito") or 0) > 0 else "D"
        valor = rd.get("credito") or rd.get("debito") or 0
        lines.append(
            f"  {rd.get('data_iso','')} | {rd.get('orgao','?'):6s} | "
            f"{rd.get('conta',''):16s} | {tipo} R$ {valor:>12,.2f} | "
            f"{(rd.get('historico','') or '')[:40]}"
        )

    conn.close()
    return "\n".join(lines)


@mcp.tool()
def sql_query(empresa: str, query: str) -> str:
    """
    Query SQL SELECT no banco cloud (somente leitura).
    Parametros:
      empresa: seguranca ou assessoria
      query: SQL SELECT
    """
    q = query.strip().upper()
    if not q.startswith("SELECT"):
        return "ERRO: Apenas queries SELECT."
    if any(kw in q for kw in ["DROP", "DELETE", "UPDATE", "INSERT", "ALTER", "CREATE"]):
        return "ERRO: Apenas SELECT permitido."

    conn = _get_conn(empresa)
    try:
        cur = conn.execute(query)
        cols = [d[0] for d in cur.description] if cur.description else []
        rows = cur.fetchmany(200)

        if not rows:
            conn.close()
            return "Nenhum resultado."

        lines = [" | ".join(cols)]
        lines.append("-" * len(lines[0]))
        for r in rows:
            lines.append(" | ".join(str(v) if v is not None else "" for v in r))
        if len(rows) == 200:
            lines.append("... (limitado a 200 linhas)")

        conn.close()
        return "\n".join(lines)
    except Exception as e:
        conn.close()
        return f"ERRO SQL: {e}"


@mcp.tool()
def info_servidor() -> str:
    """Informacoes do servidor: DBs disponiveis, espaco, uptime."""
    import shutil

    dbs = _find_db()
    lines = ["SERVIDOR MONTANA CLOUD", "=" * 40]

    # DBs
    lines.append(f"\nBancos encontrados: {len(dbs)}")
    for name, path in dbs.items():
        size = os.path.getsize(path) / 1024 / 1024
        lines.append(f"  {name}: {path} ({size:.1f} MB)")

    # Disk
    usage = shutil.disk_usage("/")
    lines.append(f"\nDisco: {usage.used/1e9:.1f} GB usado / {usage.total/1e9:.1f} GB total "
                 f"({usage.free/1e9:.1f} GB livre)")

    # Time
    lines.append(f"Hora servidor: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    return "\n".join(lines)


@mcp.tool()
def verificar_duplicata(
    empresa: str,
    valor: float,
    data_iso: str = "",
    tipo: str = "credito",
) -> str:
    """
    Verifica se um valor ja existe no banco (anti-duplicacao).
    Use antes de importar dados manualmente.
    Parametros:
      empresa: seguranca ou assessoria
      valor: valor a verificar (ex: 15000.50)
      data_iso: data no formato YYYY-MM-DD (opcional, filtra por data)
      tipo: credito ou debito
    """
    conn = _get_conn(empresa)
    cur = conn.cursor()
    col = "credito" if tipo == "credito" else "debito"

    query = f"""SELECT id, data_iso, historico, {col}, status_conciliacao, contrato_vinculado
        FROM extratos WHERE abs({col} - ?) < 0.01"""
    params: list = [valor]

    if data_iso:
        query += " AND data_iso = ?"
        params.append(data_iso)

    query += " ORDER BY data_iso DESC LIMIT 10"
    cur.execute(query, params)
    rows = cur.fetchall()

    # Conta vinculada tambem
    cv_rows = []
    if empresa == "assessoria":
        try:
            cv_q = f"SELECT data_iso, conta, historico, {col} FROM conta_vinculada WHERE abs({col} - ?) < 0.01"
            cv_p: list = [valor]
            if data_iso:
                cv_q += " AND data_iso = ?"
                cv_p.append(data_iso)
            cv_q += " LIMIT 5"
            cur.execute(cv_q, cv_p)
            cv_rows = cur.fetchall()
        except:
            pass

    conn.close()

    lines = [f"VERIFICACAO DE DUPLICATA — R$ {valor:,.2f} ({tipo}, {empresa})"]
    lines.append("=" * 50)

    if rows:
        lines.append(f"\n⚠️  ENCONTRADO em extratos ({len(rows)} registros):")
        for r in rows:
            lines.append(
                f"  #{r[0]} | {r[1]} | R$ {r[3]:,.2f} | {r[4] or 'PEND'} | "
                f"{(r[5] or '')[:25]} | {(r[2] or '')[:40]}"
            )
    else:
        lines.append(f"\n✅ NAO encontrado em extratos")

    if cv_rows:
        lines.append(f"\n⚠️  ENCONTRADO em conta_vinculada ({len(cv_rows)}):")
        for r in cv_rows:
            lines.append(f"  {r[0]} | conta {r[1]} | R$ {r[3]:,.2f} | {(r[2] or '')[:40]}")
    elif empresa == "assessoria":
        lines.append(f"✅ NAO encontrado em conta_vinculada")

    if not rows and not cv_rows:
        lines.append("\n→ SEGURO importar este valor.")
    else:
        lines.append("\n→ CUIDADO: valor ja existe. Verifique se nao e duplicata antes de importar.")

    return "\n".join(lines)


# ══════════════════════════════════════════════════════════════════════
# ENTRY POINT
# ══════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    print(f"Montana Cloud MCP Server starting on port {MCP_PORT}...")
    print(f"App dir: {APP_DIR}")
    print(f"DBs: {_find_db()}")
    print(f"Connect via: claude mcp add montana-cloud --transport sse --url http://104.196.22.170:{MCP_PORT}/sse")
    mcp.run(transport="sse")
