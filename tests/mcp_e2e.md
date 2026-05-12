# Matriz E2E — MCPs Montana

Testes manuais executados antes de cada release dos servidores MCP (Cloud + Intelligence). Complementa `tests/test_mcp_smoke.py` (que cobre unit + integration HTTP).

## Pré-requisitos

- Servidores em staging rodando (não tocar produção em testes destrutivos)
- Token válido `MCP_TEST_TOKEN` provisionado especificamente para testes (revogar após)
- `MCP_TEST_URL=https://mcp-staging.grupomontanasec.com` (ou similar)

## Matriz

| # | Teste | Comando / Procedimento | Esperado | Status |
|---|---|---|---|---|
| 1 | Sem header Authorization | `curl -i $MCP_TEST_URL/sse` | `401`, body `{"error":"missing_bearer"}` | ☐ |
| 2 | Token inválido | `curl -i -H "Authorization: Bearer xxx" $MCP_TEST_URL/sse` | `401`, body `{"error":"invalid_token"}` | ☐ |
| 3 | Token válido + tools/list (cloud) | `claude mcp list` após `claude mcp add ...` | 13 tools listadas | ☐ |
| 4 | Token válido + tools/list (intel) | Mesmo, no servidor intel | 8 tools listadas | ☐ |
| 5 | sql_query com INSERT em comentário | Tool call com `/* hi */ INSERT INTO x VALUES (1)` | Bloqueado, `forbidden_statement_type` | ☐ |
| 6 | sql_query com 2 statements | Tool call com `SELECT 1; DROP TABLE x` | Bloqueado, `only_one_statement_allowed` | ☐ |
| 7 | sql_query SELECT válido | `SELECT * FROM extratos LIMIT 5` | Retorna ≤ 5 linhas formatadas | ☐ |
| 8 | Claude Code real | `claude` no repo, depois `/mcp` | Ambos servers `connected` | ☐ |
| 9 | Antigravity real | Abrir Antigravity no repo, executar `pendentes_cloud` | Resposta JSON válida | ☐ |
| 10 | Revogar token | Remover do `MONTANA_TOKENS_JSON`, `pm2 restart`, retry teste 3 | `401` para token revogado, demais OK | ☐ |
| 11 | Audit log grava | Após teste 7, `tail /opt/montana/logs/mcp_audit.jsonl` | Última linha tem `"label"`, `"event"`, `"path"` | ☐ |
| 12 | Bind fechado público | `nmap -p 3010 35.235.241.162` (de fora) | `closed` ou `filtered` (firewall GCP) | ☐ |
| 13 | TLS válido | `curl -v https://mcp.grupomontanasec.com/sse 2>&1 \| grep "subject:"` | Cert Let's Encrypt válido | ☐ |
| 14 | ETL noturno | Verificar `/opt/montana/logs/etl.log` no dia seguinte | Sem erros, `knowledge_base.db` modificado | ☐ |
| 15 | PM2 restart sob carga | 10 req/s `status` por 30s, depois `pm2 restart montana-mcp` | 0 falhas, reconexão SSE em < 5s | ☐ |

## Evidências

Salvar em `tests/evidence/<data>/`:

- Screenshot do `/mcp` no Claude Code (teste 8)
- Screenshot do Antigravity executando tool (teste 9)
- Trecho do audit log (teste 11)
- Output do `curl -v` do TLS (teste 13)

## Critério de "pronto"

Todos os 15 testes ☑ e evidências dos testes 8, 9, 11, 13 anexadas. Falha em qualquer item destrutivo (1, 2, 5, 6, 10, 12) é blocker.
