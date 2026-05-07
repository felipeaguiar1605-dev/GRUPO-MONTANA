# AGENTS.md

Este arquivo é o ponto de entrada para agentes de IA que **não sejam Claude Code** (ex.: Google Antigravity, Cursor, Aider). Para esses agentes, o conteúdo de referência é o mesmo do `CLAUDE.md` — leia-o agora como sua base de contexto.

→ **Leia primeiro**: [`CLAUDE.md`](./CLAUDE.md)

## Configuração específica para Antigravity

Antigravity (Google) suporta MCP via `settings.json` no workspace. Snippet equivalente ao `.mcp.json` deste repo:

```json
{
  "mcp.servers": {
    "montana-cloud": {
      "type": "sse",
      "url": "https://mcp.<host>/sse",
      "headers": { "Authorization": "Bearer ${env:MONTANA_TOKEN}" }
    },
    "montana-intel": {
      "type": "sse",
      "url": "https://intel.<host>/sse",
      "headers": { "Authorization": "Bearer ${env:MONTANA_TOKEN}" }
    }
  }
}
```

Defina `MONTANA_TOKEN` no shell antes de abrir o Antigravity. O token é fornecido individualmente — ver `SECURITY.md` para o procedimento de provisionamento.

## Política de uso (espelhando CLAUDE.md)

Antigravity é preferido para:

- Refatorações longas e migrações de larga escala (ex.: SQLite → Postgres descrito em `PROPOSTA_MIGRACAO_POSTGRES.md`)
- Geração de testes em massa
- Conversões mecânicas (ver `convert_routes.js`, `fix_async.py`, `fix_sqlite_residuos.py` no histórico)
- Documentação automática de código legado

Antigravity **não deve** ser usado para:

- Apuração fiscal direta (PIS/COFINS, IRRF) — exige Claude Code com review humano
- Mexer em `certificados/`, `*.pfx`, `dump_*.sql`
- Deploy ou alteração de infra

Detalhe completo, comandos comuns, convenções de branch e avisos LGPD: ver `CLAUDE.md` e `SECURITY.md`.
