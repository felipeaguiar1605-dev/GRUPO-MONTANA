"""
Smoke tests dos MCP servers Montana.

Roda em duas camadas:
  1. Unit (offline) — sqlglot guard, token loader. Não precisa servidor rodando.
  2. Integration — bate em servidor real via env MCP_TEST_URL e MCP_TEST_TOKEN.
     Pula se as envs não estiverem definidas.

Uso:
    pytest tests/test_mcp_smoke.py -v                          # unit only
    MCP_TEST_URL=https://mcp.grupomontanasec.com \
    MCP_TEST_TOKEN=tok_xxx pytest tests/test_mcp_smoke.py -v   # full
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "mcp-server"))

import mcp_server  # noqa: E402


# ─── Unit: sqlglot guard ──────────────────────────────────────────────

@pytest.mark.parametrize("query", [
    "SELECT 1",
    "SELECT * FROM extratos WHERE data_iso > '2026-01-01' LIMIT 10",
    "WITH t AS (SELECT 1 AS x) SELECT * FROM t",
    "SELECT COUNT(*) FROM notas_fiscais",
])
def test_sql_query_allows_select(query):
    ok, reason = mcp_server._validate_select_only(query)
    assert ok, f"Expected ok, got: {reason}"


# Reasons que indicam bloqueio legítimo (qualquer um destes serve).
BLOCK_REASONS = (
    "only_select_allowed",
    "forbidden_statement_type",
    "only_one_statement_allowed",
    "parse_error",
)


@pytest.mark.parametrize("query", [
    "INSERT INTO t VALUES (1)",
    "UPDATE extratos SET credito=0",
    "DELETE FROM extratos",
    "DROP TABLE extratos",
    "ALTER TABLE extratos ADD COLUMN foo INT",
    "CREATE TABLE foo (id INT)",
    "TRUNCATE TABLE extratos",
    # Multi-statement attack
    "SELECT 1; DROP TABLE extratos",
    # Comment-based bypass attempt
    "/* SELECT */ INSERT INTO t VALUES (1)",
    # SELECT seguido de DML
    "SELECT 1; INSERT INTO x VALUES (2)",
])
def test_sql_query_blocks_dml_ddl(query):
    ok, reason = mcp_server._validate_select_only(query)
    assert not ok, f"Should have blocked: {query!r}"
    assert any(r in reason for r in BLOCK_REASONS), \
        f"Reason '{reason}' didn't match any block category"


def test_sql_query_blocks_garbage():
    ok, reason = mcp_server._validate_select_only("not sql at all !!!")
    assert not ok


# ─── Unit: token loader ───────────────────────────────────────────────

def test_load_tokens_requires_env(monkeypatch):
    monkeypatch.delenv("MONTANA_TOKENS_JSON", raising=False)
    with pytest.raises(SystemExit):
        mcp_server._load_tokens()


def test_load_tokens_rejects_invalid_json(monkeypatch):
    monkeypatch.setenv("MONTANA_TOKENS_JSON", "not json")
    with pytest.raises(SystemExit):
        mcp_server._load_tokens()


def test_load_tokens_rejects_empty(monkeypatch):
    monkeypatch.setenv("MONTANA_TOKENS_JSON", "{}")
    with pytest.raises(SystemExit):
        mcp_server._load_tokens()


def test_load_tokens_rejects_array(monkeypatch):
    monkeypatch.setenv("MONTANA_TOKENS_JSON", '["tok_a"]')
    with pytest.raises(SystemExit):
        mcp_server._load_tokens()


def test_load_tokens_accepts_dict(monkeypatch):
    monkeypatch.setenv("MONTANA_TOKENS_JSON", '{"tok_a":"alice","tok_b":"bob"}')
    tokens = mcp_server._load_tokens()
    assert tokens == {"tok_a": "alice", "tok_b": "bob"}


# ─── Integration (skipped if no live server) ──────────────────────────

LIVE_URL = os.environ.get("MCP_TEST_URL")
LIVE_TOKEN = os.environ.get("MCP_TEST_TOKEN")

needs_live = pytest.mark.skipif(
    not (LIVE_URL and LIVE_TOKEN),
    reason="Set MCP_TEST_URL and MCP_TEST_TOKEN to run integration tests",
)


@needs_live
def test_no_token_returns_401():
    import httpx
    r = httpx.get(f"{LIVE_URL}/sse", timeout=5)
    assert r.status_code == 401


@needs_live
def test_invalid_token_returns_401():
    import httpx
    r = httpx.get(f"{LIVE_URL}/sse",
                  headers={"Authorization": "Bearer not_a_real_token"},
                  timeout=5)
    assert r.status_code == 401


@needs_live
def test_valid_token_connects():
    import httpx
    # SSE endpoint streams; 200 + content-type text/event-stream is enough.
    with httpx.stream("GET", f"{LIVE_URL}/sse",
                      headers={"Authorization": f"Bearer {LIVE_TOKEN}"},
                      timeout=5) as r:
        assert r.status_code == 200
        assert "event-stream" in r.headers.get("content-type", "")
