# SECURITY.md — Política de Segurança & LGPD

Documento operacional para acesso aos MCPs Montana e tratamento de dados sensíveis. Revisar trimestralmente.

## Classificação de dados

| Categoria | Exemplos | Pode ir para LLM cloud? |
|---|---|---|
| **Sigiloso (S)** | CNPJ de cliente, valores fiscais, NFe assinadas, certidões, dumps SQL | ❌ Não |
| **Restrito (R)** | Nomes de funcionários, salários, contratos, lotações | ⚠️ Só com ZDR confirmado |
| **Interno (I)** | Estrutura de tabelas, SQL queries não executadas, código sem dados | ✅ Sim |
| **Público (P)** | Documentação técnica, arquitetura, este README | ✅ Sim |

## Tokens de auth dos MCPs

### Provisionamento

Tokens são **por agente / por usuário**, não compartilhados. Formato no servidor:

```bash
export MONTANA_TOKENS_JSON='{
  "tok_<random32>": "claude-code-felipe",
  "tok_<random32>": "antigravity-shared",
  "tok_<random32>": "automation-cron"
}'
```

Gerar token:

```bash
python3 -c "import secrets; print('tok_' + secrets.token_urlsafe(32))"
```

### Rotação

- **Trimestral** para tokens de equipe
- **Imediata** se: dev sair da equipe, suspeita de vazamento, log de auditoria mostrar uso anômalo
- Procedimento: editar `MONTANA_TOKENS_JSON`, `pm2 restart montana-mcp montana-intelligence`, comunicar novo token via canal seguro (não Slack público / não e-mail simples)

### Revogação

Remover entry do `MONTANA_TOKENS_JSON` e restart. Acesso é cortado imediatamente para o token revogado, sem afetar os outros.

## Auditoria

`mcp-server/mcp_server.py` grava cada requisição em `/opt/montana/logs/mcp_audit.jsonl`:

```json
{"ts":"2026-05-07T12:34:56Z","label":"claude-code-felipe","event":"request","path":"/sse","status":200,"latency_ms":42.1}
```

- **Append-only**: aplicar `chattr +a /opt/montana/logs/mcp_audit.jsonl` no servidor.
- **Rotação semanal**: `logrotate` config para `*.jsonl` em `/opt/montana/logs/`.
- **Retenção**: 1 ano. Backups criptografados antes de descarte.

## Hardening do `sql_query`

A tool `sql_query` (Montana Cloud) usa `sqlglot` para parser real:

- ✅ Permite: 1 statement, tipo `SELECT`/`UNION`/`WITH`/`Subquery`
- ❌ Bloqueia: `INSERT`/`UPDATE`/`DELETE`/`DROP`/`ALTER`/`CREATE`/`TRUNCATE`/`MERGE`
- ❌ Bloqueia: múltiplos statements (ex: `SELECT 1; DROP TABLE x`)
- ✅ Limita: 200 linhas por padrão

Toda chamada a `sql_query` é audit-required (campo `event:"sql_query"` no log + hash da query).

## Política para ferramentas de IA externas

### Anthropic / Claude Code

- Workspace/Team plans suportam **Zero Data Retention** (ZDR) via API enterprise — confirmar antes de processar dados R/S.
- Modelos via Claude Code CLI: dados são processados pela Anthropic conforme [termos atuais](https://www.anthropic.com/legal/commercial-terms). Verificar opt-out de treinamento.

### Google Antigravity

- Em **preview** (final 2025). Termos de uso de dados podem mudar — **revisar trimestralmente** antes de cada renovação contratual.
- Não enviar dados S/R até confirmar política de retenção/treinamento.
- Usar contas corporativas com Workspace, não pessoais.

### Regra geral

Antes de colar/enviar qualquer texto a um agente cloud, classificar mentalmente:

- Tem CNPJ, valor fiscal, nome de cliente? → **S/R**, parar.
- É só código, schema, log sem dados? → **I**, OK.

## Dados que NUNCA vão para repo

Já cobertos por `.gitignore`:

- `.env`, `.env.local`, `.env.production`
- `data/` (bancos SQLite por empresa)
- `montana_intelligence/.env`, `montana_intelligence/knowledge_base.db`
- `certificados/*.pfx`, `*.p12`, `*.key`
- `dump_*.sql` ❌ **(verificar — atualmente parecem rastreados!)**
- `contratos/`, `fontes/`, `conferencia/`

## Infraestrutura

### Bind interfaces (não público)

Os MCPs escutam apenas `127.0.0.1` (default). Acesso externo só via Caddy/Nginx com TLS:

```
Caddyfile:
mcp.<host> {
    reverse_proxy 127.0.0.1:3010
}
intel.<host> {
    reverse_proxy 127.0.0.1:8001
}
```

GCP firewall: liberar apenas `22/tcp` (SSH), `80/tcp` (LE renew), `443/tcp` (HTTPS público). Bloquear `3010` e `8001` ao público.

### TLS

Caddy emite certificados Let's Encrypt automaticamente. Renovação automática.

## Resposta a incidentes

| Incidente | Ação imediata |
|---|---|
| Token vazado | Remover do `MONTANA_TOKENS_JSON`, `pm2 restart`, audit log para impacto |
| Audit log com query suspeita | Revogar token responsável, exportar log do dia, abrir RCA |
| `sqlglot` bloqueou query legítima | NÃO enfraquecer parser — ajustar tool ou criar tool específica |
| Dump SQL em commit público | `git filter-repo`, force push, rotacionar segredos do dump |
| Cert TLS expirado | `caddy reload` (LE renova sozinho); checar logs `journalctl -u caddy` |

## Contatos

- **Responsável técnico**: Felipe Aguiar (`felipeaguiar1605-dev`)
- **DPO Grupo Montana SEC**: <a definir>
- **Reportar vulnerabilidade**: <canal a definir, não public issue>

## Histórico

| Data | Mudança |
|---|---|
| 2026-05-07 | Versão inicial. Bearer auth implementado, sqlglot adicionado, IPs antigos (`104.196.22.170`, `35.247.236.181`) descontinuados. Nova VM: `35.235.241.162`. |
