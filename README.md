# Sistema Montana ERP — Grupo Montana SEC

Sistema unificado de **conciliação financeira, boletins de medição e apuração fiscal** multi-empresa.

```
┌─────────────────────────────────────────────────────────────┐
│  Devs (Claude Code / Antigravity)        Equipe (browser)   │
└────────────┬─────────────────────────────────────┬──────────┘
             │ MCP/SSE + Bearer                    │ HTTPS
             ▼                                     ▼
   ┌──────────────────────┐              ┌──────────────────┐
   │  Caddy (TLS + LE)    │              │  Caddy           │
   │  mcp.<host>          │              │  sistema.<host>  │
   │  intel.<host>        │              └────────┬─────────┘
   └──────┬──────┬────────┘                       │
          │      │                                ▼
          ▼      ▼                       ┌──────────────────┐
   ┌─────────┐ ┌──────────────┐          │  Node.js / 3002  │
   │ Cloud   │ │ Intelligence │          │  src/server.js   │
   │ MCP     │ │ MCP+API      │          │  (Express)       │
   │ :3010   │ │ :8001        │          └────────┬─────────┘
   └────┬────┘ └──────┬───────┘                   │
        │             │                           │
        └─────┬───────┴───────────────────────────┘
              ▼
   ┌──────────────────────────────────────┐
   │  /opt/montana/data/<empresa>/        │
   │     montana.db (SQLite)              │
   │  /opt/montana/.../knowledge_base.db  │
   └──────────────────────────────────────┘
```

## Quickstart (dev)

```bash
git clone <repo> && cd GRUPO-MONTANA
cp .env.example .env                          # preencher
npm install
npm run dev                                    # API node, porta 3002
```

Para os MCPs (em outro terminal cada):

```bash
pip install -r mcp-server/requirements.txt
pip install -r montana_intelligence/requirements.txt

MONTANA_TOKENS_JSON='{"dev-local":"laptop"}' \
  python3 mcp-server/mcp_server.py            # porta 3010

MONTANA_TOKENS_JSON='{"dev-local":"laptop"}' \
  python3 montana_intelligence/server.py --port 8001
```

## Para agentes de IA

- **Claude Code** lê `CLAUDE.md` e `.mcp.json` automaticamente.
- **Google Antigravity** lê `AGENTS.md` (snippet de config MCP incluído).
- **Política de uso, segurança e LGPD**: `SECURITY.md`.

## Documentação por tema

| Documento | Tema |
|---|---|
| [`CLAUDE.md`](./CLAUDE.md) | Guia para agentes Claude Code |
| [`AGENTS.md`](./AGENTS.md) | Guia para Antigravity e outros agentes |
| [`SECURITY.md`](./SECURITY.md) | Tokens, auditoria, LGPD, retenção de dados |
| [`DEPLOY.md`](./DEPLOY.md) | Opções de deploy (Railway, Render, VPS) |
| [`GUIA-DNS.md`](./GUIA-DNS.md) | Configuração DNS do domínio |
| [`PROPOSTA_MIGRACAO_POSTGRES.md`](./PROPOSTA_MIGRACAO_POSTGRES.md) | Plano SQLite → Postgres |
| [`ARQUITETURA_MONTANA_INTELLIGENCE.md`](./ARQUITETURA_MONTANA_INTELLIGENCE.md) | Arquitetura do MCP Intelligence |

## Testes

```bash
npm test                                      # smoke do app Node
pytest tests/test_mcp_smoke.py -v             # MCPs (auth, sqlglot, etc.)
```

Matriz E2E completa: [`tests/mcp_e2e.md`](./tests/mcp_e2e.md).

## Licença / Confidencialidade

Código proprietário do **Grupo Montana SEC**. Dados manipulados são fiscais e sigilosos (LGPD). Não distribuir, não treinar modelos com este conteúdo. Ver `SECURITY.md`.
