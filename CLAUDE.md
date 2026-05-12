# CLAUDE.md — Sistema Montana ERP

Guia para agentes de IA (Claude Code, Antigravity e outros via MCP) trabalhando neste repositório.

## Visão geral

Sistema multi-empresa de **conciliação financeira + boletins de medição + apuração fiscal** do Grupo Montana SEC. Empresas suportadas: `assessoria`, `seguranca`, `mustang`, `portodovau`. Stack:

- **Backend**: Node.js (Express) — `src/server.js`, porta `3002`
- **Frontend**: React/Vite (repo separado, dev em `5173`)
- **Banco**: SQLite por empresa em `data/<empresa>/montana.db` (migração para Postgres em planejamento — ver `PROPOSTA_MIGRACAO_POSTGRES.md`)
- **MCPs (Python)**: dois servidores expondo dados aos agentes — ver seção MCP abaixo
- **Deploy**: GCP VM `35.235.241.162` (atual), `/opt/montana/`, PM2 + Caddy/Nginx

## MCP Servers

Dois servidores complementares; agentes devem escolher conforme a tarefa:

| Server | Path | Porta | Tools | Use quando |
|---|---|---|---|---|
| **montana-cloud** | `mcp-server/mcp_server.py` | 3010 | 13 read-only + `sql_query` (parser sqlglot) | Queries em tempo real diretas no SQLite por empresa |
| **montana-intel** | `montana_intelligence/server.py` | 8001 | 8 (knowledge base) | Agregações pré-calculadas via ETL noturno |

Ambos atrás de Caddy com TLS. Config compartilhada em `.mcp.json` (Claude Code descobre automaticamente). Lista exata de tools: ver docstrings dos `@mcp.tool()` em `mcp-server/mcp_server.py` e dict `TOOLS` em `montana_intelligence/server.py:609`.

**Auth**: Bearer token. Ver `SECURITY.md` para política de tokens e `.env.example` para variáveis.

## Comandos comuns

```bash
# Dev local (app principal)
npm install
npm run dev                          # node --watch src/server.js

# MCPs (locais, para testes)
MONTANA_TOKENS_JSON='{"dev":"local"}' python3 mcp-server/mcp_server.py
MONTANA_TOKENS_JSON='{"dev":"local"}' python3 montana_intelligence/server.py --port 8001

# ETL Intelligence (regenera knowledge_base.db)
python3 montana_intelligence/etl.py

# Em produção (GCP VM)
pm2 list                              # ver montana-app, montana-mcp, montana-intelligence
pm2 logs montana-mcp --lines 100
pm2 restart montana-mcp

# Testes smoke dos MCPs
pytest tests/test_mcp_smoke.py -v
```

## Convenções

- **Nunca commitar** `.env`, `*.pfx`, `data/`, `*.db`, `certificados/*.key` (já no `.gitignore`)
- **Branch padrão de IA**: `claude/<descrição>` para Claude Code, `antigravity/<descrição>` para Antigravity
- **Commits**: 1-2 frases, foco no porquê, não no quê
- **PR sempre como draft** ao final do trabalho de agente
- **IPs e hosts**: nunca hardcoded — usar variáveis de ambiente ou config

## Política de uso (matriz de responsabilidade)

| Tipo de tarefa | Agente preferido | Razão |
|---|---|---|
| Apuração PIS/COFINS, código fiscal | Claude Code | Review humano obrigatório, dados sensíveis |
| Refatorações longas (ex: SQLite → Postgres) | Antigravity | Bom em tarefas longas autônomas |
| Code review, security review | Claude Code | Skills `/review`, `/security-review` |
| Deploy, hooks, ops | Claude Code | Reversibilidade |
| Geração de testes em massa | Antigravity | Volume |

## Aviso LGPD / Dados sensíveis

Este sistema lida com **dados fiscais sigilosos** (CNPJ, NFe assinadas, certidões, valores de contrato). Antes de plugar qualquer ferramenta cloud:

1. Validar política de retenção/treinamento do fornecedor (Anthropic ZDR, Google Antigravity TOS atual)
2. **Nunca** colar conteúdo de `data/*.db`, `*.pfx`, `dump_*.sql` em prompts ou chats externos
3. Tokens de auth dos MCPs são por-agente; revogação documentada em `SECURITY.md`

Detalhe completo em `SECURITY.md`.

## Arquivos críticos para contexto

- `ARQUITETURA_MONTANA_INTELLIGENCE.md` — visão de produto do MCP Intelligence
- `PROPOSTA_MIGRACAO_POSTGRES.md` — plano da migração SQLite → Postgres
- `PLANO_MIGRACAO_CLOUD.md` — histórico do deploy
- `.claude/commands/apuracao-mensal.md` — workflow de apuração mensal automatizado
- `DEPLOY.md` — opções de deploy (Railway, Render, VPS)
