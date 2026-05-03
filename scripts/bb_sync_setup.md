# Setup BB Sync — PortoVau e Mustang

Diagnóstico atual:

| Empresa | bb_configs | Status |
|---------|-----------:|--------|
| Assessoria | 11 | ✅ Configurado |
| Segurança | 10 | ✅ Configurado |
| **Porto do Vau** | **6** | ⚠ Parcial (faltam ~5) |
| **Mustang** | **0** | ❌ Vazio |

## O que precisa estar configurado

A integração BB Sync (cron 02:30 diário) precisa de **11 chaves** na tabela `configuracoes`:

| Chave | Descrição | Onde pegar |
|-------|-----------|-----------|
| `bb_client_id` | Client ID OAuth2 | developers.bb.com.br → app cadastrado |
| `bb_client_secret` | Client Secret OAuth2 | idem |
| `bb_app_key` | Developer Application Key | idem |
| `bb_agencia` | Número da agência (4 dígitos) | seu cartão/contrato |
| `bb_conta` | Número da conta (sem dígito verificador) | seu cartão/contrato |
| `bb_dac` | Dígito verificador da conta | seu cartão |
| `bb_basic` | Token Basic gerado (base64 client_id:client_secret) | gerado automaticamente |
| `bb_developer_app_key` | Mesma chave que app_key (alguns endpoints exigem ambos) | idem |
| `bb_token_url` | URL OAuth2 (sandbox vs produção) | https://oauth.bb.com.br/oauth/token |
| `bb_api_url` | URL base da API | https://api.bb.com.br |
| `bb_environment` | `sandbox` ou `production` | seu uso |

## Passo a passo pra completar PortoVau

### 1. Ver o que já está configurado:

```bash
PGPASSWORD='montana2026' psql -h 35.247.208.7 -U montana -d montana_erp -c "
SELECT chave, LEFT(COALESCE(valor,''), 40) AS valor
FROM portodovau.configuracoes
WHERE chave LIKE 'bb_%'
ORDER BY chave;
"
```

### 2. Ver o que falta (compare com Assessoria que está ok):

```bash
PGPASSWORD='montana2026' psql -h 35.247.208.7 -U montana -d montana_erp -c "
SELECT a.chave AS chave_assessoria, p.chave AS chave_portodovau
FROM (SELECT chave FROM assessoria.configuracoes WHERE chave LIKE 'bb_%') a
FULL OUTER JOIN (SELECT chave FROM portodovau.configuracoes WHERE chave LIKE 'bb_%') p
  ON a.chave = p.chave
ORDER BY 1;
"
```

### 3. Inserir as faltantes (UI ou SQL):

**Via UI**: Configurações → BB API → preencher campos (se houver tela)

**Via SQL** (substitua valores):
```sql
INSERT INTO portodovau.configuracoes (chave, valor) VALUES
  ('bb_client_id', 'seu_client_id_aqui'),
  ('bb_client_secret', 'seu_secret_aqui'),
  ('bb_app_key', 'sua_app_key_aqui'),
  ('bb_agencia', '0001'),
  ('bb_conta', '12345'),
  ('bb_dac', '6')
ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor;
```

### 4. Testar sync manual antes do cron:

```bash
# Pegar token JWT (use sua senha de admin do ERP)
TOKEN=$(curl -s -X POST http://localhost:3002/api/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Company: portodovau" \
  -d '{"usuario":"admin","senha":"<sua senha>"}' | jq -r '.token')

# Testar sync de 1 dia
curl -X POST http://localhost:3002/api/bb/sync \
  -H "Content-Type: application/json" \
  -H "X-Company: portodovau" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"dataInicio":"2026-04-01","dataFim":"2026-04-02"}'
```

Se retornar `{"ok":true,"imported":N}` — está funcionando.

## Mustang — começar do zero

1. Cadastrar empresa na PJE BB (developers.bb.com.br)
2. Criar app dedicado pra Mustang
3. Pegar credenciais (client_id, secret, app_key)
4. Inserir as 11 chaves via SQL ou UI
5. Testar sync manual

## Alternativa: importar OFX manual

Se não quiser configurar BB API agora:

1. Acessar conta Mustang/PortoVau no internet banking BB
2. Baixar OFX do mês (formato compatível)
3. Subir via UI: **Importar > OFX > Selecionar arquivo**
4. Sistema valida + importa automaticamente

Pra Mustang sem dados nenhum, **importar OFX dos últimos 6 meses** já dá histórico suficiente pra o sistema funcionar.

## Tempo estimado

| Tarefa | Tempo |
|--------|------:|
| Completar config PortoVau (faltam ~5 campos) | 15 min |
| Configurar Mustang do zero | 30-45 min |
| Importar OFX manual (alternativa) | 5 min/empresa |
